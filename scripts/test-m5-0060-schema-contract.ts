#!/usr/bin/env tsx
/**
 * M5 — static contract for migration 0060 (D-031 post-claim verification).
 * No network, no Docker, no database: this file reads SQL text and nothing
 * else.
 *
 * The verifier's whole value rests on properties of the SQL *code*: that it
 * reads the job's entire history rather than its current attempt, that it
 * writes nothing, that it locks nothing, and that it returns one closed label
 * and no tenant state. Prose asserting any of that is worthless, so every
 * detector below runs on comment-stripped SQL.
 *
 * Each property is expressed once, as a named detector, and then re-run
 * against a synthetically mutated copy that breaks exactly that property. The
 * run fails unless the detector notices — which is what stops a detector from
 * degenerating into a string count that passes for the wrong reason.
 *
 * Three existing functions are fingerprinted against pinned digests:
 * `claim_protocol_execution_job` (0054), `claim_protocol_execution_job_by_id`
 * (0059) and `get_protocol_execution_job_context` (0052). 0060 adds a
 * verifier; it must change none of them.
 */

import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  allowlistDrift, allowlistWith, INVALID_MIGRATION_NAMES, ledgerRefuses, migrationLedger, TIMESTAMP_FIXTURE,
} from "./lib/migration-names";

/** Mechanical network guard: this contract must never reach anything. */
let realFetchCalls = 0;
globalThis.fetch = ((..._a: unknown[]) => {
  realFetchCalls += 1;
  throw new Error("network access attempted in a static contract");
}) as unknown as typeof fetch;

const ROOT = process.cwd();
const MIGRATIONS = path.join(ROOT, "supabase/migrations");

// QD-6: every migration file is parsed by the shared rules (exact four-digit
// allowlist, validated 14-digit timestamps), so each "no later migration"
// guard below also examines a timestamped migration.
const ledger = (extra: Record<string, string> = {}) => migrationLedger(MIGRATIONS, extra);
const MIGRATION = path.join(MIGRATIONS, "0060_m5_phase3d_post_claim_verification.sql");

/**
 * The pinned identity — signature and body — of each function 0060 must leave
 * exactly as it found it.
 */
interface Pinned {
  readonly name: string;
  readonly file: string;
  /** The migration number after which no file may touch this function. */
  readonly definedAt: number;
  readonly sha256: string;
}

const PINNED: Pinned[] = [
  {
    name: "claim_protocol_execution_job",
    file: "0054_m5_worker_probe_result_and_alert_outbox.sql",
    definedAt: 54,
    sha256: "83c2c915167d2786d07406ba3b35cdca64a731108601331129379dbf0a58ad35",
  },
  {
    name: "claim_protocol_execution_job_by_id",
    file: "0059_m5_phase3d_targeted_claim.sql",
    definedAt: 59,
    sha256: "cbf17b42286b3250bc9c607b1563453e113495b0bbd7faed6b4ea683d4ad74e5",
  },
  {
    name: "get_protocol_execution_job_context",
    file: "0052_m5_durable_call_payloads_and_probe_result_replay.sql",
    definedAt: 52,
    sha256: "eb1279202e01eb81fd85eb9a2c3cc4a69730472800b124f1a7d4933a44a1b70d",
  },
];

const RAW = readFileSync(MIGRATION, "utf8");

/**
 * Comments carry no behaviour. Removing them is what makes every detector
 * below a statement about the code rather than about the documentation —
 * 0060's header, for instance, names `get_protocol_execution_job_context` and
 * `current_attempt_id` at length while touching neither.
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

const FN = "verify_phase3d_canary_post_claim";
const ACL_SIG = `public.${FN}(text, uuid, uuid, uuid)`;

const SIGNATURE =
  `create or replace function public.${FN}( `
  + "p_worker_id text, p_job_id uuid, p_project_id uuid, p_claim_token uuid )";

const RETURNS = "returns table ( outcome text )";

const OUTCOMES = [
  "VERIFIED",
  "JOB_NOT_FOUND",
  "JOB_NOT_OWNED",
  "JOB_NOT_CLEAN",
  "PROTOCOL_NOT_ELIGIBLE",
] as const;

const OWNERSHIP = [
  "v_job.status <> 'claimed'",
  "v_job.worker_id is distinct from p_worker_id",
  "v_job.claim_token is distinct from p_claim_token",
  "v_job.lease_expires_at is null",
  "v_job.lease_expires_at <= now()",
] as const;

const CLEAN_STATE = [
  "v_job.attempt_count <> 1",
  "v_job.max_attempts <> 1",
  "v_job.current_attempt_id is not null",
  "v_job.next_baseline_ordinal <> 1",
  "v_job.needs_review_reason is not null",
  "v_job.failure_reason is not null",
] as const;

/** The six history sources, each with the key that ties it back to the job. */
const HISTORY_SOURCES = [
  "from public.protocol_attempts a where a.job_id = v_job.id",
  "from public.protocol_external_calls c "
    + "where c.protocol_attempt_id in (select id from attempts)",
  "from public.provider_call_receipts r "
    + "where r.external_call_id in (select id from calls)",
  "from public.analysis_call_receipts r "
    + "where r.external_call_id in (select id from calls)",
  "from public.probe_runs pr where pr.id in (select id from runs)",
  "from public.probe_results pres where pres.probe_run_id in (select id from runs)",
] as const;

/**
 * The function's PL/pgSQL body, and only that. Everything outside it — the
 * header, the ACL block, any later statement — is a different question, asked
 * by different detectors. Returns null when the body cannot be delimited,
 * which every body-scoped detector treats as a failure rather than as an
 * empty body that trivially satisfies them.
 */
function plpgsqlBody(sql: string): string | null {
  const open = sql.indexOf("as $$");
  if (open === -1) return null;
  const close = sql.indexOf("\n$$;", open);
  if (close === -1) return null;
  return sql.slice(open + "as $$".length, close);
}

/**
 * The syntactic keywords that may legitimately stand before a parenthesis in
 * this body. The list is closed and deliberately minimal: every entry is a
 * place a real call could hide, so it holds exactly the three words the body
 * actually uses and nothing kept "just in case".
 */
const SQL_SYNTAX_BEFORE_PAREN = new Set(["as", "in", "select"]);

/** Exactly the calls the body is allowed to make, with their exact counts. */
const ALLOWED_CALLS: ReadonlyArray<readonly [string, number]> = [
  ["btrim", 1],
  ["count", 6],
  ["now", 1],
];

/**
 * Every name that stands immediately before a parenthesis in the body,
 * tallied. The pattern spans newlines and accepts a qualified name, so
 * `foo\n(x)`, `other.foo(x)` and `pg_catalog.foo(x)` are all captured — a
 * detector that only recognised `public.foo(...)` would be a detector that
 * only refuses the one spelling nobody would use to smuggle a call in.
 */
function callTally(body: string): Map<string, number> {
  const tally = new Map<string, number>();
  for (const m of body.matchAll(
    /([A-Za-z_][A-Za-z0-9_$]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_$]*)*)\s*\(/g
  )) {
    const name = m[1].replace(/\s+/g, "");
    if (SQL_SYNTAX_BEFORE_PAREN.has(name)) continue;
    tally.set(name, (tally.get(name) ?? 0) + 1);
  }
  return tally;
}

/** Every create/drop/alter FUNCTION target in the file. */
function functionTargets(sql: string): string[] {
  return [
    ...flat(sql).matchAll(
      /(?:create or replace function|create function|drop function|alter function)(?: if exists)? public\.([a-z0-9_]+)/g
    ),
  ].map((m) => m[1]);
}

const DETECTORS: Detector[] = [
  {
    id: "signature",
    label: "the four-argument signature is exact",
    holds: (s) => flat(s).includes(SIGNATURE),
  },
  {
    id: "returns",
    label: "the single return column is exactly `outcome text`",
    holds: (s) => flat(s).includes(RETURNS),
  },
  {
    id: "outcome-not-status",
    label: "the return column is named `outcome`, never `status`",
    holds: (s) => !/returns\s+table\s*\(\s*status\b/i.test(s),
  },
  {
    id: "definer",
    label: "plpgsql, security definer, stable, and an explicit search_path",
    holds: (s) =>
      /^language plpgsql$/m.test(s)
      && /^security definer$/m.test(s)
      && /^stable$/m.test(s)
      && /^set search_path = public, pg_temp$/m.test(s),
  },
  {
    id: "not-volatile",
    label: "the function is never declared VOLATILE",
    // STABLE is not decoration: PostgreSQL refuses a data-modifying statement
    // inside a non-VOLATILE function, so this word is what makes the
    // read-only property engine-enforced rather than review-enforced.
    holds: (s) => !/^\s*volatile\s*$/im.test(s),
  },
  {
    id: "arg-guards",
    label: "all four arguments are guarded before anything is read",
    holds: (s) =>
      flat(s).includes(
        "if p_worker_id is null or btrim(p_worker_id) = '' "
        + "or p_job_id is null or p_project_id is null or p_claim_token is null then"
      ),
  },
  {
    id: "sqlstate",
    label: "the guard raises SQLSTATE 22023 with the canonical message",
    holds: (s) =>
      flat(s).includes(
        "raise exception using errcode = '22023', "
        + `message = 'invalid_${FN}_args';`
      ),
  },
  {
    id: "no-dml",
    label: "no INSERT, UPDATE, DELETE, MERGE, TRUNCATE or COPY anywhere",
    holds: (s) => !/^\s*(insert|update|delete|merge|truncate|copy)\s/im.test(s),
  },
  {
    id: "no-lock",
    label: "no row lock, table lock or advisory lock is taken",
    holds: (s) =>
      !/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i.test(s)
      && !/\block\s+table\b/i.test(s)
      && !/pg_advisory/i.test(s),
  },
  {
    id: "closed-call-list",
    label: "the body's calls are exactly btrim×1, count×6 and now×1 — no other name, "
      + "qualified or not, stands before a parenthesis",
    holds: (s) => {
      const body = plpgsqlBody(s);
      if (body === null) return false;
      const tally = callTally(body);
      if (tally.size !== ALLOWED_CALLS.length) return false;
      return ALLOWED_CALLS.every(([name, n]) => tally.get(name) === n);
    },
  },
  {
    id: "no-procedural-invocation",
    label: "the body contains no PERFORM, no CALL and no EXECUTE — the three ways to "
      + "invoke code with no call parenthesis for a scanner to find",
    holds: (s) => {
      const body = plpgsqlBody(s);
      if (body === null) return false;
      return !/\bperform\b/i.test(body)
        && !/\bcall\b/i.test(body)
        && !/\bexecute\b/i.test(body);
    },
  },
  {
    id: "outcomes-closed",
    label: "exactly the five closed outcomes appear, and nothing else",
    holds: (s) => {
      const found = [...s.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]);
      // JOB_NOT_CLEAN is returned twice by design: a dirty job row and a
      // non-empty job history are the same fact, reported the same way.
      if (found.length !== 6) return false;
      const uniq = [...new Set(found)].sort();
      return JSON.stringify(uniq) === JSON.stringify([...OUTCOMES].sort());
    },
  },
  {
    id: "return-literal-only",
    label: "every RETURN QUERY yields one label literal and no value",
    holds: (s) => {
      const stmts = flat(s).match(/return query[^;]*;/g) ?? [];
      return stmts.length === 6
        && stmts.every((q) => /^return query select '[A-Z_]+'::text;$/.test(q));
    },
  },
  {
    id: "no-value-echo",
    label: "no argument, identifier or counter is ever concatenated into a message",
    holds: (s) =>
      !s.includes("||")
      && !/\bformat\s*\(/i.test(s)
      && !/raise\s+(notice|warning|log|info)/i.test(s)
      && (s.match(/raise exception/gi) ?? []).length === 1,
  },
  {
    id: "addressing-pair",
    label: "the job is addressed by the exact job/project pair, and FOUND is captured at once",
    holds: (s) =>
      flat(s).includes(
        "from public.protocol_execution_jobs j "
        + "where j.id = p_job_id and j.project_id = p_project_id; v_found := found;"
      )
      && flat(s).includes("if not v_found then return query select 'JOB_NOT_FOUND'::text;"),
  },
  {
    id: "ownership",
    label: "the fencing triple and a live lease are all required",
    holds: (s) =>
      OWNERSHIP.every((c) => s.includes(c))
      && flat(s).includes("then return query select 'JOB_NOT_OWNED'::text; return; end if;"),
  },
  {
    id: "clean-state",
    label: "all six pristine-state conditions are required together",
    holds: (s) => CLEAN_STATE.every((c) => s.includes(c)),
  },
  {
    id: "history-by-job-id",
    label: "the history walk keys on job_id, never on current_attempt_id",
    holds: (s) =>
      flat(s).includes("from public.protocol_attempts a where a.job_id = v_job.id")
      // `current_attempt_id` may appear exactly once — as the state condition
      // that requires it to be null. Anywhere else it would mean the walk had
      // been narrowed back to the blind spot this function exists to close.
      && (s.match(/current_attempt_id/g) ?? []).length === 1,
  },
  {
    id: "history-sources",
    label: "all six history sources are counted, each keyed back to the job",
    holds: (s) => HISTORY_SOURCES.every((h) => flat(s).includes(h)),
  },
  {
    id: "history-zero",
    label: "any non-zero history yields JOB_NOT_CLEAN",
    holds: (s) =>
      flat(s).includes(
        "if v_history <> 0 then return query select 'JOB_NOT_CLEAN'::text; return; end if;"
      ),
  },
  {
    id: "protocol-admissibility",
    label: "the protocol must be the job's own, in its project, and admissible",
    holds: (s) =>
      flat(s).includes(
        "from public.protocols p where p.id = v_job.protocol_id "
        + "and p.project_id = v_job.project_id and p.status in ('approved', 'active');"
      )
      && flat(s).includes(
        "if not found then return query select 'PROTOCOL_NOT_ELIGIBLE'::text;"
      ),
  },
  {
    id: "no-schema-change",
    label: "no table, index, constraint, trigger or policy is created or altered",
    holds: (s) =>
      !/create\s+(table|index|unique\s+index|trigger|policy|view|materialized)/i.test(s)
      && !/alter\s+table/i.test(s)
      && !/add\s+constraint/i.test(s)
      && !/row level security/i.test(s),
  },
  {
    id: "functions-untouched",
    label: "the only function created, dropped or altered is the verifier itself",
    holds: (s) => {
      const targets = functionTargets(s);
      return targets.length === 1 && targets[0] === FN;
    },
  },
  {
    id: "acl",
    label: "execute is revoked from public/anon/authenticated and granted only to service_role",
    holds: (s) => {
      const f = flat(s);
      const revokes = ["public", "anon", "authenticated"].every((r) =>
        f.includes(`revoke all on function ${ACL_SIG} from ${r};`));
      const grants = s.match(/^grant\s/gim) ?? [];
      return revokes
        && f.includes(`grant execute on function ${ACL_SIG} to service_role;`)
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
  console.log("\n[1] Migration 0060 satisfies every D-031 verification property");
  for (const d of DETECTORS) {
    assert(d.label, d.holds(SQL), d.id);
  }
  assert("the file is the canonically named 0060 migration",
    MIGRATION.split(path.sep).join("/")
      .endsWith("/supabase/migrations/0060_m5_phase3d_post_claim_verification.sql"));
  assert("the migration defines exactly one function",
    (SQL.match(/create or replace function/gi) ?? []).length === 1);
  assert("the PL/pgSQL body is delimitable, so the body-scoped detectors read a real body",
    plpgsqlBody(SQL) !== null);
  assert("no allowed call is also listed as a syntactic keyword — the two lists cannot overlap",
    ALLOWED_CALLS.every(([name]) => !SQL_SYNTAX_BEFORE_PAREN.has(name)));
}

/* ═══════════════════ 2. the three existing functions are untouched ═══════ */
{
  console.log("\n[2] The functions 0060 must not change are byte-identical");

  for (const p of PINNED) {
    const src = readFileSync(path.join(MIGRATIONS, p.file), "utf8");
    const marker = `create or replace function\n  public.${p.name}(`;
    const i = src.indexOf(marker);
    assert(`${p.file} still defines ${p.name} exactly once`,
      i !== -1 && src.split(marker).length - 1 === 1);
    const j = src.indexOf("\n$$;\n", i);
    assert(`${p.name}'s body terminates as expected`, j !== -1);
    const digest = createHash("sha256").update(src.slice(i, j + 5)).digest("hex");
    assert(`${p.name}'s signature and body match the pinned digest`,
      digest === p.sha256, `${digest.slice(0, 16)}… vs ${p.sha256.slice(0, 16)}…`);
  }

  assert("0060 neither redefines nor drops any of them, and its body calls none of them",
    DETECTORS.find((d) => d.id === "functions-untouched")!.holds(SQL)
    && DETECTORS.find((d) => d.id === "closed-call-list")!.holds(SQL));
}

/* ═════════ 2b. no later migration redefines, drops or overloads them ═════ */
{
  console.log("\n[2b] No migration after each definition touches these functions");

  /**
   * 0060 alone is not the question. A later file could undo what this slice
   * promises while 0060 itself still reads perfectly, so every migration
   * numbered above each function's defining file has to be clean too.
   */
  function touches(sql: string, name: string): boolean {
    return new RegExp(
      `(create\\s+(or\\s+replace\\s+)?function|drop\\s+function|alter\\s+function)[\\s\\S]{0,120}?${name}\\s*\\(`,
      "i"
    ).test(sql);
  }

  const files = ledger();

  assert("0060 is present in the migration ledger",
    files.some((x) => x.f === "0060_m5_phase3d_post_claim_verification.sql"));
  // Deliberately not asserted: that 0060 is still the highest-numbered
  // migration. That was only ever a proxy for "nothing later undoes this
  // slice", and it fails on every subsequent migration regardless of whether
  // one is relevant — a test that cries wolf gets muted. The PINNED scan below
  // enforces the real property directly, against every later file.

  for (const p of PINNED) {
    const later = files.filter((x) => x.n > p.definedAt);
    assert(`there is at least one migration after ${p.file} to examine`,
      later.length > 0, String(later.length));
    for (const { f, sql } of later) {
      assert(`${f} leaves ${p.name} alone`, !touches(stripComments(sql), p.name), f);
    }
  }

  // QD-6: a timestamped migration is examined, never skipped.
  for (const { label, extra, allow } of INVALID_MIGRATION_NAMES) {
    assert(`the migration ledger refuses ${label}`, ledgerRefuses(MIGRATIONS, extra, allowlistWith(allow)));
  }
  const drift = allowlistDrift(readdirSync(MIGRATIONS));
  assert("the migrations directory matches the exact four-digit allowlist", drift.length === 0, drift.join("; "));
  for (const p of PINNED) {
    const withFixture = ledger({
      [TIMESTAMP_FIXTURE]: `create or replace function public.${p.name}(p_a uuid)\nreturns void language sql as $x$ select 1 $x$;`,
    }).filter((x) => x.n > p.definedAt);
    assert(`a timestamped migration redefining ${p.name} is ordered after ${p.file} and caught`,
      withFixture[withFixture.length - 1]?.f === TIMESTAMP_FIXTURE &&
        withFixture.some(({ sql }) => touches(stripComments(sql), p.name)));
  }

  // The scanner itself must be shown to bite, on each verb.
  for (const [verb, snippet] of [
    ["create or replace", `create or replace function\n  public.get_protocol_execution_job_context(p_a uuid)\nreturns void language sql as $x$ select 1 $x$;`],
    ["drop", "drop function if exists public.get_protocol_execution_job_context(uuid, uuid, uuid);"],
    ["alter", "alter function public.get_protocol_execution_job_context(uuid, uuid, uuid) owner to postgres;"],
    ["overload", `create function public.get_protocol_execution_job_context(p_a uuid, p_b uuid, p_c uuid, p_d uuid)\nreturns void language sql as $x$ select 1 $x$;`],
  ] as const) {
    assert(`the scanner catches a \`${verb}\` on a pinned function`,
      touches(stripComments(snippet), "get_protocol_execution_job_context"), verb);
  }
  assert("…and it does not fire on a mere prose mention",
    !touches(
      stripComments("-- see get_protocol_execution_job_context(uuid, uuid, uuid) in 0052\nselect 1;"),
      "get_protocol_execution_job_context"
    ));
  assert("…and the targeted claim's name does not match the global claim's scanner",
    !touches(
      "create or replace function public.claim_protocol_execution_job_by_id(a text)\nreturns void language sql as $x$ select 1 $x$;",
      "claim_protocol_execution_job"
    ));
}

/* ════════════════════════ 3. negative self-tests by mutation ═════════════ */
{
  console.log("\n[3] Every detector is proved to notice its own violation");

  interface Mutation {
    readonly label: string;
    readonly breaks: string;
    readonly mutate: (sql: string) => string;
  }

  const VERIFIED = "  return query select 'VERIFIED'::text;";

  const MUTATIONS: Mutation[] = [
    {
      label: "adding a fifth argument",
      breaks: "signature",
      mutate: (s) => s.replace("    p_claim_token uuid\n", "    p_claim_token uuid,\n    p_extra text default null\n"),
    },
    {
      label: "returning the job row alongside the label",
      breaks: "returns",
      mutate: (s) => s.replace("returns table (\n  outcome text\n)", "returns table (\n  outcome text,\n  job public.protocol_execution_jobs\n)"),
    },
    {
      label: "renaming the return column to `status`",
      breaks: "outcome-not-status",
      mutate: (s) => s.replace("returns table (\n  outcome text\n)", "returns table (\n  status text\n)"),
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
      label: "declaring the verifier VOLATILE",
      breaks: "not-volatile",
      mutate: (s) => s.replace(/^stable$/m, "volatile"),
    },
    {
      label: "widening the argument guard",
      breaks: "arg-guards",
      mutate: (s) => s.replace(
        "     or p_job_id is null or p_project_id is null or p_claim_token is null then",
        "     then"
      ),
    },
    {
      label: "changing the guard SQLSTATE",
      breaks: "sqlstate",
      mutate: (s) => s.replace("errcode = '22023'", "errcode = '22000'"),
    },
    {
      label: "touching the job row on the way out",
      breaks: "no-dml",
      mutate: (s) => s.replace(VERIFIED, `  update public.protocol_execution_jobs set updated_at = now() where id = v_job.id;\n${VERIFIED}`),
    },
    {
      label: "recording the verification as a row",
      breaks: "no-dml",
      mutate: (s) => s.replace(VERIFIED, `  insert into public.protocol_execution_job_alerts (project_id) values (p_project_id);\n${VERIFIED}`),
    },
    {
      label: "locking the addressed job row",
      breaks: "no-lock",
      mutate: (s) => s.replace(
        "     and j.project_id = p_project_id;\n  v_found := found;",
        "     and j.project_id = p_project_id\n   for update;\n  v_found := found;"
      ),
    },
    {
      label: "calling a schema-qualified public function from the body",
      breaks: "closed-call-list",
      mutate: (s) => s.replace(VERIFIED, `  v_history := public.some_helper(v_job.id);\n${VERIFIED}`),
    },
    {
      label: "calling an unqualified function from the body",
      breaks: "closed-call-list",
      mutate: (s) => s.replace(VERIFIED, `  v_history := some_helper(v_job.id);\n${VERIFIED}`),
    },
    {
      label: "calling a function qualified into another schema",
      breaks: "closed-call-list",
      mutate: (s) => s.replace(VERIFIED, `  v_history := pg_catalog.pg_backend_pid();\n${VERIFIED}`),
    },
    {
      label: "calling one more time a name that is already allowed",
      breaks: "closed-call-list",
      mutate: (s) => s.replace(VERIFIED, `  v_history := v_history + (select count(*) from attempts);\n${VERIFIED}`),
    },
    {
      label: "invoking a routine with PERFORM",
      breaks: "no-procedural-invocation",
      mutate: (s) => s.replace(VERIFIED, `  perform public.claim_protocol_execution_job('w', 1);\n${VERIFIED}`),
    },
    {
      label: "invoking a procedure with CALL",
      breaks: "no-procedural-invocation",
      mutate: (s) => s.replace(VERIFIED, `  call public.some_procedure();\n${VERIFIED}`),
    },
    {
      label: "invoking dynamic SQL with EXECUTE",
      breaks: "no-procedural-invocation",
      mutate: (s) => s.replace(
        VERIFIED,
        `  execute 'update public.protocol_execution_jobs set updated_at = now()';\n${VERIFIED}`
      ),
    },
    {
      label: "introducing a sixth outcome",
      breaks: "outcomes-closed",
      mutate: (s) => s.replace(VERIFIED, `  if false then return query select 'JOB_RETRY'::text; end if;\n${VERIFIED}`),
    },
    {
      label: "returning an identifier instead of a label",
      breaks: "return-literal-only",
      mutate: (s) => s.replace(VERIFIED, "  return query select v_job.id::text;"),
    },
    {
      label: "echoing an argument into the guard message",
      breaks: "no-value-echo",
      mutate: (s) => s.replace(
        `      message = 'invalid_${FN}_args';`,
        "      message = 'invalid args for job ' || p_job_id::text;"
      ),
    },
    {
      label: "dropping the project from the addressing predicate",
      breaks: "addressing-pair",
      mutate: (s) => s.replace(
        "   where j.id = p_job_id\n     and j.project_id = p_project_id;",
        "   where j.id = p_job_id;"
      ),
    },
    {
      label: "not requiring the claim token to match",
      breaks: "ownership",
      mutate: (s) => s.replace("     or v_job.claim_token is distinct from p_claim_token\n", ""),
    },
    {
      label: "dropping a pristine-state condition",
      breaks: "clean-state",
      mutate: (s) => s.replace("     or v_job.next_baseline_ordinal <> 1\n", ""),
    },
    {
      label: "narrowing the history walk back to the current attempt",
      breaks: "history-by-job-id",
      mutate: (s) => s.replace(
        "     where a.job_id = v_job.id",
        "     where a.id = v_job.current_attempt_id"
      ),
    },
    {
      label: "dropping the analysis receipts from the history",
      breaks: "history-sources",
      mutate: (s) => s.replace(
        "    + (select count(*) from public.analysis_call_receipts r\n"
        + "        where r.external_call_id in (select id from calls))\n",
        ""
      ),
    },
    {
      label: "tolerating a non-empty history",
      breaks: "history-zero",
      mutate: (s) => s.replace("  if v_history <> 0 then", "  if v_history < 0 then"),
    },
    {
      label: "accepting a protocol in any status",
      breaks: "protocol-admissibility",
      mutate: (s) => s.replace(
        "     and p.status in ('approved', 'active');",
        "     and p.status is not null;"
      ),
    },
    {
      label: "altering the target table",
      breaks: "no-schema-change",
      mutate: (s) => `${s}\nalter table public.protocol_execution_jobs add column canary boolean;\n`,
    },
    {
      label: "dropping the job-context function",
      breaks: "functions-untouched",
      mutate: (s) => `${s}\ndrop function if exists public.get_protocol_execution_job_context(uuid, uuid, uuid);\n`,
    },
    {
      label: "redefining the global claim function",
      breaks: "functions-untouched",
      mutate: (s) => `${s}\ncreate or replace function public.claim_protocol_execution_job(p_worker_id text, p_lease_seconds integer)\nreturns void language sql as $x$ select 1 $x$;\n`,
    },
    {
      label: "granting execute to authenticated",
      breaks: "acl",
      mutate: (s) => `${s}\ngrant execute on function\n  ${ACL_SIG} to authenticated;\n`,
    },
    {
      label: "granting a direct table privilege",
      breaks: "no-table-privilege",
      mutate: (s) => `${s}\ngrant select on table public.protocol_execution_jobs to anon;\n`,
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
    assert(`the mutation "${m.label}" actually changes the SQL`, mutated !== SQL, m.breaks);
    assert(`…and detector \`${m.breaks}\` refuses it`, !detector.holds(mutated), m.breaks);
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

console.log(`\n${passed}/${passed + failed} checks passed. M5 0060 schema contract ${failed === 0 ? "PASSED" : "FAILED"}.`);
process.exit(failed === 0 ? 0 : 1);
