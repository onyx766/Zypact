#!/usr/bin/env tsx
/**
 * M5 — static contract for migration 0059 (D-031 targeted claim). No network,
 * no Docker, no database: this file reads SQL text and nothing else.
 *
 * D-031 makes a specific set of properties load-bearing, and every one of them
 * is a property of the SQL *code*, not of its prose. So the contract strips
 * comments before it looks at anything: a migration that merely explains why
 * it does not step over a locked row must not be able to satisfy a detector
 * that is supposed to prove it never does.
 *
 * Each property is expressed once, as a named detector over the stripped SQL.
 * Every detector is then re-run against a synthetically mutated copy that
 * breaks exactly that property, and the run fails unless the detector
 * notices. That is what stops a detector from degenerating into a string
 * count that passes for the wrong reason.
 *
 * The global function `claim_protocol_execution_job(text, integer)` is
 * fingerprinted from 0054 and compared against a pinned digest, so this
 * contract fails the moment ordinary claim behaviour is touched — which is
 * the one thing D-031 forbids above all.
 */

import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

/** Mechanical network guard: this contract must never reach anything. */
let realFetchCalls = 0;
globalThis.fetch = ((..._a: unknown[]) => {
  realFetchCalls += 1;
  throw new Error("network access attempted in a static contract");
}) as unknown as typeof fetch;

const ROOT = process.cwd();
const MIGRATION = path.join(ROOT, "supabase/migrations/0059_m5_phase3d_targeted_claim.sql");
const GLOBAL_MIGRATION = path.join(
  ROOT, "supabase/migrations/0054_m5_worker_probe_result_and_alert_outbox.sql"
);

/**
 * The pinned identity of the canonical global claim function: its signature
 * and body exactly as 0054 defines them. If this digest moves, ordinary
 * claim behaviour moved with it.
 */
const GLOBAL_CLAIM_SHA256 =
  "83c2c915167d2786d07406ba3b35cdca64a731108601331129379dbf0a58ad35";

const RAW = readFileSync(MIGRATION, "utf8");

/**
 * Comments carry no behaviour. Removing them is what makes every detector
 * below a statement about the code rather than about the documentation.
 */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

const SQL = stripComments(RAW);
/** Whitespace-normalised, for order-sensitive and multi-line checks. */
const FLAT = SQL.replace(/\s+/g, " ").trim();

let passed = 0;
let failed = 0;

function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1;
    console.log(`✓ ${label}`);
  } else {
    failed += 1;
    console.log(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ════════════════════════════════════════════ the detectors ══════════════ */

interface Detector {
  readonly id: string;
  readonly label: string;
  /** Runs on comment-stripped SQL. True = the property holds. */
  readonly holds: (sql: string) => boolean;
}

function flat(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

const SIGNATURE =
  "create or replace function public.claim_protocol_execution_job_by_id( "
  + "p_worker_id text, p_lease_seconds integer, p_job_id uuid, p_project_id uuid )";

const RETURNS =
  "returns table ( outcome text, job public.protocol_execution_jobs, claim_token uuid )";

const OUTCOMES = ["CLAIMED", "JOB_NOT_FOUND", "JOB_NOT_ELIGIBLE", "JOB_LOCKED"] as const;

const NULL_PAYLOAD = "null::public.protocol_execution_jobs, null::uuid";

const ELIGIBILITY = [
  "v_job.status = 'queued'",
  "v_job.attempt_count = 0",
  "v_job.max_attempts = 1",
  "v_job.worker_id is null",
  "v_job.claim_token is null",
  "v_job.lease_expires_at is null",
] as const;

const MUTATION = [
  "status = 'claimed'",
  "worker_id = p_worker_id",
  "claim_token = v_token",
  "lease_expires_at = now() + make_interval(secs => p_lease_seconds)",
  "attempt_count = attempt_count + 1",
  "updated_at = now()",
] as const;

const DETECTORS: Detector[] = [
  {
    id: "signature",
    label: "the four-argument signature is exact",
    holds: (s) => flat(s).includes(SIGNATURE),
  },
  {
    id: "returns",
    label: "the return columns are exactly (outcome, job, claim_token)",
    holds: (s) => flat(s).includes(RETURNS),
  },
  {
    id: "outcome-not-status",
    label: "the first return column is named `outcome`, never `status`",
    holds: (s) => !/returns\s+table\s*\(\s*status\b/i.test(s),
  },
  {
    id: "definer",
    label: "security definer, volatile, and an explicit search_path",
    holds: (s) =>
      /^security definer$/m.test(s)
      && /^volatile$/m.test(s)
      && /^set search_path = public, pg_temp$/m.test(s)
      && /^language plpgsql$/m.test(s),
  },
  {
    id: "arg-guards",
    label: "the argument guards reproduce the canonical ones",
    holds: (s) =>
      flat(s).includes(
        "if p_worker_id is null or btrim(p_worker_id) = '' "
        + "or p_lease_seconds is null or p_lease_seconds <= 0 then"
      ),
  },
  {
    id: "sqlstate",
    label: "the guard raises SQLSTATE 22023 with the canonical message",
    holds: (s) =>
      flat(s).includes(
        "raise exception using errcode = '22023', "
        + "message = 'invalid_claim_protocol_execution_job_args';"
      ),
  },
  {
    id: "nowait",
    label: "the addressed row is locked with FOR UPDATE NOWAIT",
    holds: (s) => /for update nowait/i.test(s),
  },
  {
    id: "lock-before-eligibility",
    label: "the lock is taken BEFORE eligibility is evaluated",
    holds: (s) => {
      const lock = s.toLowerCase().indexOf("for update nowait");
      const elig = s.indexOf(ELIGIBILITY[0]);
      return lock !== -1 && elig !== -1 && lock < elig;
    },
  },
  {
    id: "lock-addresses-pair",
    label: "the locking select addresses the exact job/project pair",
    holds: (s) =>
      flat(s).includes("where j.id = p_job_id and j.project_id = p_project_id for update nowait"),
  },
  {
    id: "found-captured",
    label: "FOUND is captured immediately into a dedicated boolean",
    holds: (s) => {
      const f = flat(s);
      return /v_found boolean/.test(f)
        && f.includes("for update nowait; v_found := found;")
        && f.includes("if not v_found then");
    },
  },
  {
    id: "lock-exception",
    label: "only lock_not_available is intercepted, and it yields JOB_LOCKED",
    holds: (s) => {
      const f = flat(s);
      const whens = (s.match(/^\s*when\s+\w+/gm) ?? []).map((w) => w.trim());
      return whens.length === 1
        && /when\s+lock_not_available/.test(whens[0])
        && f.includes("when lock_not_available then return query select 'JOB_LOCKED'::text");
    },
  },
  {
    id: "outcomes-closed",
    label: "exactly the four closed outcomes appear, once each",
    holds: (s) => {
      const found = [...s.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]);
      // JOB_NOT_FOUND is returned twice by design: a null identifier and an
      // absent row are the same fact, reported the same way.
      if (found.length !== 5) return false;
      const uniq = [...new Set(found)].sort();
      return JSON.stringify(uniq) === JSON.stringify([...OUTCOMES].sort());
    },
  },
  {
    id: "null-payloads",
    label: "every failure outcome returns a null job and a null claim_token",
    holds: (s) => {
      const lines = s.split("\n").filter((l) => /'(JOB_NOT_FOUND|JOB_NOT_ELIGIBLE|JOB_LOCKED)'::text/.test(l));
      return lines.length === 4 && lines.every((l) => l.includes(NULL_PAYLOAD));
    },
  },
  {
    id: "eligibility",
    label: "all six eligibility conditions are required together",
    holds: (s) => ELIGIBILITY.every((c) => s.includes(c)) && /if not \(/.test(s),
  },
  {
    id: "mutation",
    label: "the successful mutation is the canonical one",
    holds: (s) => MUTATION.every((m) => flat(s).includes(m)),
  },
  {
    id: "single-increment",
    label: "attempt_count moves by exactly one, in exactly one statement",
    holds: (s) => (s.match(/attempt_count = attempt_count \+ 1/g) ?? []).length === 1,
  },
  {
    id: "one-update",
    label: "exactly one UPDATE, and it is bounded to the targeted row",
    holds: (s) => {
      const updates = s.match(/^\s*update\s+public\.\w+/gim) ?? [];
      return updates.length === 1
        && /update public\.protocol_execution_jobs/i.test(s)
        && flat(s).includes("where id = v_job.id returning * into v_job;");
    },
  },
  {
    id: "no-step-over",
    label: "the locking strategy never steps over a locked row",
    holds: (s) => !/skip\s+locked/i.test(s),
  },
  {
    id: "no-sweep",
    label: "no abandoned-job sweep and no alert or delivery write",
    holds: (s) =>
      !/abandoned_exhausted/i.test(s)
      && !/protocol_execution_job_alerts/i.test(s)
      && !/protocol_execution_job_alert_deliveries/i.test(s)
      && !/^\s*insert\s+into/im.test(s),
  },
  {
    id: "no-schema-change",
    label: "no table, index, constraint, trigger or policy is created or altered",
    holds: (s) =>
      !/create\s+(table|index|unique\s+index|trigger|policy)/i.test(s)
      && !/alter\s+table/i.test(s)
      && !/add\s+constraint/i.test(s)
      && !/row level security/i.test(s),
  },
  {
    id: "global-untouched",
    label: "the global claim function is neither redefined nor dropped here",
    holds: (s) =>
      !/(create\s+or\s+replace\s+function|drop\s+function)[\s\S]{0,80}claim_protocol_execution_job\s*\(/i.test(s),
  },
  {
    id: "acl",
    label: "execute is revoked from public/anon/authenticated and granted only to service_role",
    holds: (s) => {
      const f = flat(s);
      const sig = "public.claim_protocol_execution_job_by_id(text, integer, uuid, uuid)";
      const revokes = ["public", "anon", "authenticated"].every((r) =>
        f.includes(`revoke all on function ${sig} from ${r};`));
      const grants = s.match(/^grant\s+/gim) ?? [];
      return revokes
        && f.includes(`grant execute on function ${sig} to service_role;`)
        && grants.length === 1;
    },
  },
  {
    id: "no-table-privilege",
    label: "no direct table privilege is granted to anyone",
    holds: (s) => !/grant[^;]*\son\s+table\s/i.test(s),
  },
];

/* ════════════════════════════════════════════ 1. the real migration ══════ */
{
  console.log("\n[1] Migration 0059 satisfies every D-031 property");
  for (const d of DETECTORS) {
    assert(d.label, d.holds(SQL), d.id);
  }
  assert("the migration carries no literal step-over token, even in prose",
    !/skip\s+locked/i.test(RAW));
  assert("the file is the canonically named 0059 migration",
    MIGRATION.endsWith("/supabase/migrations/0059_m5_phase3d_targeted_claim.sql"));
}

/* ════════════════════════════ 2. the global function is untouched ════════ */
{
  console.log("\n[2] The canonical global claim function is byte-identical");

  const globalSrc = readFileSync(GLOBAL_MIGRATION, "utf8");
  const marker = "create or replace function\n  public.claim_protocol_execution_job(";
  const i = globalSrc.indexOf(marker);
  assert("0054 still defines the global claim function exactly once",
    i !== -1 && globalSrc.split(marker).length - 1 === 1);
  const j = globalSrc.indexOf("\n$$;\n", i);
  assert("its body terminates as expected", j !== -1);
  const block = globalSrc.slice(i, j + 5);
  const digest = createHash("sha256").update(block).digest("hex");
  assert("its signature and body match the pinned digest",
    digest === GLOBAL_CLAIM_SHA256, `${digest.slice(0, 16)}… vs ${GLOBAL_CLAIM_SHA256.slice(0, 16)}…`);
  assert("0059 does not mention the global function in any executable statement",
    DETECTORS.find((d) => d.id === "global-untouched")!.holds(SQL));
}

/* ═════════ 2b. no migration after 0054 touches the global function ═══════ */
{
  console.log("\n[2b] No migration after 0054 redefines, drops, alters or overloads it");

  /**
   * 0059 alone is not the question. 0054 is the last migration that may
   * legitimately define the global claim function, so *every* migration after
   * it has to be clean — otherwise a later file could undo what this slice
   * promises while 0059 itself still reads perfectly.
   */
  function touchesGlobalClaim(sql: string): boolean {
    return /(create\s+(or\s+replace\s+)?function|drop\s+function|alter\s+function)[\s\S]{0,120}?claim_protocol_execution_job\s*\(/i
      .test(sql);
  }

  const later = readdirSync(path.join(ROOT, "supabase/migrations"))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .map((f) => ({ f, n: Number(f.slice(0, 4)) }))
    .filter((x) => x.n > 54)
    .sort((a2, b2) => a2.n - b2.n);

  assert("there is at least one migration after 0054 to examine", later.length > 0,
    String(later.length));
  assert("0059 is among them", later.some((x) => x.f === "0059_m5_phase3d_targeted_claim.sql"));

  for (const { f } of later) {
    const body = stripComments(readFileSync(path.join(ROOT, "supabase/migrations", f), "utf8"));
    assert(`${f} leaves the global claim function alone`, !touchesGlobalClaim(body), f);
  }

  // The scanner itself must be shown to bite, on each of the four verbs.
  for (const [verb, snippet] of [
    ["create or replace", "create or replace function\n  public.claim_protocol_execution_job(p_worker_id text, p_lease_seconds integer)\nreturns void language sql as $x$ select 1 $x$;"],
    ["drop", "drop function if exists public.claim_protocol_execution_job(text, integer);"],
    ["alter", "alter function public.claim_protocol_execution_job(text, integer) owner to postgres;"],
    ["overload", "create function public.claim_protocol_execution_job(p_worker_id text, p_lease_seconds integer, p_extra uuid)\nreturns void language sql as $x$ select 1 $x$;"],
  ] as const) {
    assert(`the scanner catches a \`${verb}\` on the global function`,
      touchesGlobalClaim(stripComments(snippet)), verb);
  }
  assert("…and it does not fire on a mere prose mention",
    !touchesGlobalClaim(stripComments("-- see claim_protocol_execution_job(text, integer) in 0054\nselect 1;")));
}

/* ════════════════════════ 3. negative self-tests by mutation ═════════════ */
{
  console.log("\n[3] Every detector is proved to notice its own violation");

  interface Mutation {
    readonly label: string;
    readonly breaks: string;
    readonly mutate: (sql: string) => string;
  }

  const MUTATIONS: Mutation[] = [
    {
      label: "dropping NOWAIT from the lock",
      breaks: "nowait",
      mutate: (s) => s.replace(/for update nowait/i, "for update"),
    },
    {
      label: "replacing the lock with a step-over strategy",
      breaks: "no-step-over",
      mutate: (s) => s.replace(/for update nowait/i, "for update skip locked"),
    },
    {
      label: "evaluating eligibility before taking the lock",
      breaks: "lock-before-eligibility",
      mutate: (s) => `${ELIGIBILITY[0]}\n${s}`,
    },
    {
      label: "removing one eligibility condition",
      breaks: "eligibility",
      mutate: (s) => s.replace(`    and ${ELIGIBILITY[2]}\n`, ""),
    },
    {
      label: "returning a non-null job on a failure outcome",
      breaks: "null-payloads",
      mutate: (s) => s.replace(
        `'JOB_NOT_ELIGIBLE'::text, ${NULL_PAYLOAD}`,
        "'JOB_NOT_ELIGIBLE'::text, v_job, v_token"
      ),
    },
    {
      label: "adding an abandoned-job sweep",
      breaks: "no-sweep",
      mutate: (s) => s.replace(
        "  v_token := gen_random_uuid();",
        "  update public.protocol_execution_jobs set status = 'abandoned_exhausted' where lease_expires_at < now();\n  v_token := gen_random_uuid();"
      ),
    },
    {
      label: "writing an alert row",
      breaks: "no-sweep",
      mutate: (s) => s.replace(
        "  v_token := gen_random_uuid();",
        "  insert into public.protocol_execution_job_alerts (project_id) values (p_project_id);\n  v_token := gen_random_uuid();"
      ),
    },
    {
      label: "redefining the global claim function",
      breaks: "global-untouched",
      mutate: (s) => `${s}\ncreate or replace function\n  public.claim_protocol_execution_job(p_worker_id text, p_lease_seconds integer)\nreturns void language sql as $x$ select 1 $x$;\n`,
    },
    {
      label: "dropping the global claim function",
      breaks: "global-untouched",
      mutate: (s) => `${s}\ndrop function if exists public.claim_protocol_execution_job(text, integer);\n`,
    },
    {
      label: "granting execute to authenticated",
      breaks: "acl",
      mutate: (s) => `${s}\ngrant execute on function\n  public.claim_protocol_execution_job_by_id(text, integer, uuid, uuid) to authenticated;\n`,
    },
    {
      label: "granting a direct table privilege",
      breaks: "no-table-privilege",
      mutate: (s) => `${s}\ngrant select on table public.protocol_execution_jobs to anon;\n`,
    },
    {
      label: "incrementing attempt_count twice",
      breaks: "single-increment",
      mutate: (s) => s.replace(
        "         attempt_count = attempt_count + 1,",
        "         attempt_count = attempt_count + 1,\n         attempt_count = attempt_count + 1,"
      ),
    },
    {
      label: "mutating a second, untargeted row",
      breaks: "one-update",
      mutate: (s) => s.replace(
        "  return query select 'CLAIMED'::text, v_job, v_token;",
        "  update public.protocol_execution_jobs set updated_at = now() where id <> v_job.id;\n  return query select 'CLAIMED'::text, v_job, v_token;"
      ),
    },
    {
      label: "widening the argument guard",
      breaks: "arg-guards",
      mutate: (s) => s.replace("or p_lease_seconds is null or p_lease_seconds <= 0 then", "then"),
    },
    {
      label: "changing the guard SQLSTATE",
      breaks: "sqlstate",
      mutate: (s) => s.replace("errcode = '22023'", "errcode = '22000'"),
    },
    {
      label: "renaming the first return column to `status`",
      breaks: "outcome-not-status",
      mutate: (s) => s.replace("  outcome     text,", "  status      text,"),
    },
    {
      label: "dropping SECURITY DEFINER",
      breaks: "definer",
      mutate: (s) => s.replace(/^security definer$/m, "security invoker"),
    },
    {
      label: "changing the search_path",
      breaks: "definer",
      mutate: (s) => s.replace("set search_path = public, pg_temp", "set search_path = public"),
    },
    {
      label: "catching every exception rather than only lock_not_available",
      breaks: "lock-exception",
      mutate: (s) => s.replace("    when lock_not_available then", "    when others then"),
    },
    {
      label: "losing the immediate FOUND capture",
      breaks: "found-captured",
      mutate: (s) => s.replace("    v_found := found;\n", ""),
    },
    {
      label: "introducing a fifth outcome",
      breaks: "outcomes-closed",
      mutate: (s) => s.replace(
        "  v_token := gen_random_uuid();",
        "  if false then return query select 'JOB_RETRY'::text, null::public.protocol_execution_jobs, null::uuid; end if;\n  v_token := gen_random_uuid();"
      ),
    },
    {
      label: "altering the target table",
      breaks: "no-schema-change",
      mutate: (s) => `${s}\nalter table public.protocol_execution_jobs add column canary boolean;\n`,
    },
    {
      label: "changing the signature arity",
      breaks: "signature",
      mutate: (s) => s.replace("    p_project_id uuid\n", "    p_project_id uuid,\n    p_extra text default null\n"),
    },
    {
      label: "changing a return column type",
      breaks: "returns",
      mutate: (s) => s.replace("  claim_token uuid\n)", "  claim_token text\n)"),
    },
    {
      label: "narrowing the lock to the job id alone",
      breaks: "lock-addresses-pair",
      mutate: (s) => s.replace("       and j.project_id = p_project_id\n", ""),
    },
    {
      label: "dropping a canonical assignment",
      breaks: "mutation",
      mutate: (s) => s.replace("         updated_at = now()\n", ""),
    },
  ];

  const byId = new Map(DETECTORS.map((d) => [d.id, d]));

  for (const m of MUTATIONS) {
    const detector = byId.get(m.breaks);
    if (!detector) {
      assert(`mutation "${m.label}" names a known detector`, false, m.breaks);
      continue;
    }
    // Mutations run on the stripped SQL: applied to the raw text, a
    // case-insensitive pattern would hit the prose that explains the rule
    // before it ever reached the statement that implements it.
    const mutated = m.mutate(SQL);
    assert(`the mutation "${m.label}" actually changes the SQL`,
      mutated !== SQL, m.breaks);
    assert(`…and detector \`${m.breaks}\` refuses it`,
      !detector.holds(mutated), m.breaks);
  }

  // Every detector must be covered by at least one mutation: an unexercised
  // detector is an assertion nobody has ever seen fail.
  const covered = new Set(MUTATIONS.map((m) => m.breaks));
  for (const d of DETECTORS) {
    assert(`detector \`${d.id}\` is exercised by a mutation`, covered.has(d.id), d.id);
  }
}

console.log(`\n✓ no real network access was attempted — calls=${realFetchCalls}`);
assert("the contract itself made no network call", realFetchCalls === 0, String(realFetchCalls));

console.log(`\n${passed}/${passed + failed} checks passed. M5 0059 schema contract ${failed === 0 ? "PASSED" : "FAILED"}.`);
process.exit(failed === 0 ? 0 : 1);
