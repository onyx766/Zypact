#!/usr/bin/env tsx
/**
 * Static contract for 0070 — review resolution is scoped to its own job.
 *
 * The migration's whole value is that it changes ONE predicate and nothing
 * else. A contract that only checked "the new clause is present" would pass
 * just as happily if the rewrite had also dropped a guard, widened the ACL or
 * lost 0067's `prior_needs_review_reason` carry. So the central assertion
 * here is a differential one: normalise 0067's function and 0070's, undo the
 * intended change, and require the two to be byte-identical.
 *
 * Text-only. No database, no network.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  allowlistDrift, allowlistWith, INVALID_MIGRATION_NAMES, ledgerRefuses, migrationLedger, TIMESTAMP_FIXTURE,
} from "./lib/migration-names";

let failures = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Mechanical guard: a static contract must never reach anything. */
let fetchCalls = 0;
globalThis.fetch = ((..._a: unknown[]) => {
  fetchCalls += 1;
  throw new Error("network access attempted in a static contract");
}) as unknown as typeof fetch;

const MIGRATIONS = path.join(process.cwd(), "supabase", "migrations");

// QD-6: every migration file is parsed by the shared rules (exact four-digit
// allowlist, validated 14-digit timestamps), so each "no later migration"
// guard below also examines a timestamped migration.
const ledger = (extra: Record<string, string> = {}) => migrationLedger(MIGRATIONS, extra);
const FN = "resolve_protocol_job_review";

const NEW_FILE = "0070_scope_job_review_resolution_to_its_job.sql";
const OLD_FILE = "0067_preserve_prior_needs_review_reason.sql";

const rawNew = readFileSync(path.join(MIGRATIONS, NEW_FILE), "utf8");
const rawOld = readFileSync(path.join(MIGRATIONS, OLD_FILE), "utf8");

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");
}
function flat(sql: string): string {
  return stripComments(sql).replace(/\s+/g, " ").trim();
}

/** The function definition only, from `create or replace` to its `$$;`. */
function body(sql: string): string {
  const m = flat(sql).match(
    /create or replace function\s+public\.resolve_protocol_job_review[\s\S]*?\$\$;/i
  );
  return m ? m[0] : "";
}

const newBody = body(rawNew);
const oldBody = body(rawOld);

/* ═══════════════ 1. identity and placement ═══════════════ */
{
  console.log("\n[1] The migration is where and what it claims to be");

  assert("0070 exists and defines the function exactly once",
    newBody !== "" &&
    (flat(rawNew).match(/create or replace function public\.resolve_protocol_job_review/gi) ?? []).length === 1);

  assert("0067 is still readable as the prior definition", oldBody !== "");

  const files = ledger();

  assert("0070 is present in the ledger", files.some((x) => x.f === NEW_FILE));

  // Whoever defines this function last wins. That must be 0070.
  const definersIn = (list: typeof files) => list.filter((x) =>
    new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+public\\.${FN}\\s*\\(`, "i")
      .test(stripComments(x.sql))
  );
  const definers = definersIn(files);
  assert("0070 is the LAST migration to define the function",
    definers.length > 0 && definers[definers.length - 1].f === NEW_FILE,
    definers.map((d) => d.f).join(" -> "));

  const touchesFn = (sql: string) =>
    new RegExp(`(create|drop|alter)\\s+(or\\s+replace\\s+)?function[\\s\\S]{0,120}?${FN}\\s*\\(`, "i").test(sql);
  for (const { f, n, sql } of files.filter((x) => x.n > 70)) {
    assert(`${f} leaves ${FN} alone`, !touchesFn(stripComments(sql)), String(n));
  }

  // QD-6: a timestamped migration is examined, never skipped.
  for (const { label, extra, allow } of INVALID_MIGRATION_NAMES) {
    assert(`the migration ledger refuses ${label}`, ledgerRefuses(MIGRATIONS, extra, allowlistWith(allow)));
  }
  const drift = allowlistDrift(readdirSync(MIGRATIONS));
  assert("the migrations directory matches the exact four-digit allowlist", drift.length === 0, drift.join("; "));
  const withFixture = ledger({
    [TIMESTAMP_FIXTURE]: `create or replace function public.${FN}(p_a uuid)\nreturns void language sql as $x$ select 1 $x$;`,
  });
  const fixtureDefiners = definersIn(withFixture);
  assert("a timestamped redefinition becomes the last definer, so the LAST-definer check fails",
    fixtureDefiners[fixtureDefiners.length - 1]?.f === TIMESTAMP_FIXTURE);
  assert("the later-migration scan catches a timestamped redefinition",
    withFixture.filter((x) => x.n > 70).some(({ sql }) => touchesFn(stripComments(sql))));
}

/* ═══════════════ 2. the intended change, and only it ═══════════════ */
{
  console.log("\n[2] Exactly one predicate changed");

  const OLD_PREDICATE = "where protocol_id = v_job.protocol_id and status in ('reserved', 'in_progress');";
  const NEW_PREDICATE = "where protocol_id = v_job.protocol_id and (job_id = v_job.id or job_id is null) and status in ('reserved', 'in_progress');";

  assert("0067 carried the unscoped predicate", oldBody.includes(OLD_PREDICATE));
  assert("0070 carries the job-scoped predicate", newBody.includes(NEW_PREDICATE));
  assert("0070 no longer carries the unscoped predicate", !newBody.includes(OLD_PREDICATE));

  // The differential assertion. Undo the intended edit; nothing may remain.
  const reverted = newBody.replace(NEW_PREDICATE, OLD_PREDICATE);
  assert("reverting the predicate reproduces 0067 EXACTLY — no other change rode along",
    reverted === oldBody,
    reverted === oldBody ? "" : `lengths ${reverted.length} vs ${oldBody.length}`);

  assert("the null arm is present, for the still-granted M4 raw RPCs",
    /job_id is null/.test(newBody));
  assert("the scoping is on job_id, not on a claim token or lease",
    /job_id = v_job\.id/.test(newBody) &&
    !/claim_token\s*=\s*p_/.test(newBody.split("update public.protocol_attempts")[1] ?? ""));
}

/* ═══════════════ 3. nothing structural, nothing destructive ═══════════════ */
{
  console.log("\n[3] The migration is function-only and mutates no row");

  const sql = flat(rawNew);
  const afterFn = sql.replace(newBody, " ");

  for (const [label, re] of [
    ["creates no table", /create\s+table/i],
    ["adds no column", /add\s+column/i],
    ["drops no column", /drop\s+column/i],
    ["adds no constraint", /add\s+constraint/i],
    ["drops no constraint", /drop\s+constraint/i],
    ["creates no index", /create\s+(unique\s+)?index/i],
    ["drops no function", /drop\s+function/i],
    ["creates no trigger", /create\s+trigger/i],
  ] as const) {
    assert(label, !re.test(sql));
  }

  // DML outside the function body would be a data migration in disguise.
  for (const [label, re] of [
    ["no UPDATE outside the function", /\bupdate\s+public\./i],
    ["no DELETE anywhere", /\bdelete\s+from\b/i],
    ["no TRUNCATE anywhere", /\btruncate\b/i],
    ["no INSERT outside the function", /\binsert\s+into\s+public\./i],
  ] as const) {
    assert(label, !re.test(afterFn));
  }

  assert("no evidence table is written",
    !/(update|delete\s+from|insert\s+into)\s+public\.(protocol_external_calls|provider_call_receipts|analysis_call_receipts|probe_results)/i.test(sql));
}

/* ═══════════════ 4. hardening is re-asserted, not weakened ═══════════════ */
{
  console.log("\n[4] Definer, search_path and ACL");

  assert("security definer", /security definer/i.test(newBody));
  assert("search_path is pinned", /set search_path = public, pg_temp/i.test(newBody));
  assert("signature is unchanged, so grants survive create-or-replace",
    /resolve_protocol_job_review\( p_job_id uuid, p_project_id uuid, p_reviewed_by uuid, p_resolution text, p_note text \)/i
      .test(newBody.replace(/\s+/g, " ")));

  const sql = flat(rawNew);
  for (const role of ["public", "anon", "authenticated"]) {
    assert(`revoked from ${role}`,
      new RegExp(`revoke all on function public\\.${FN}\\(uuid, uuid, uuid, text, text\\) from ${role}`, "i")
        .test(sql));
  }
  assert("granted to service_role only",
    new RegExp(`grant execute on function public\\.${FN}\\(uuid, uuid, uuid, text, text\\) to service_role`, "i").test(sql));
  assert("granted to nobody else",
    (sql.match(/grant execute on function/gi) ?? []).length === 1);
}

/* ═══════════════ 5. the guards 0066/0067 established still stand ═══════════════ */
{
  console.log("\n[5] Inherited guards survived the rewrite");

  for (const [label, needle] of [
    ["tenant scoping on the job lookup", "job.project_id = p_project_id"],
    ["the job row is locked", "for update"],
    ["only needs_review can be resolved", "v_job.status <> 'needs_review'"],
    ["a review note is required", "a review note is required"],
    ["a reviewer identity is required", "p_reviewed_by is required"],
    ["resolution values are closed", "p_resolution not in ('excluded_and_completed', 'failed')"],
    ["attempts become excluded, never completed", "set status = 'excluded'"],
    ["0067's prior reason carry is intact", "prior_needs_review_reason = coalesce("],
    ["the pair constraint is respected", "needs_review_reason = null"],
    ["the lease is released", "lease_expires_at = null"],
  ] as const) {
    assert(label, newBody.includes(needle));
  }

  assert("no attempt is ever marked completed by a review",
    !/set status = 'completed'/i.test(newBody));
  assert("a terminal attempt is never re-terminalised",
    /status in \('reserved', 'in_progress'\)/.test(newBody));
}

/* ═══════════════ 6. every detector is proved to bite ═══════════════ */
{
  console.log("\n[6] Negative self-tests");

  const mutations: Array<[string, (s: string) => string, (s: string) => boolean]> = [
    [
      "dropping the job scope",
      (s) => s.replace(" and (job_id = v_job.id or job_id is null)", ""),
      (s) => !s.includes("(job_id = v_job.id or job_id is null)"),
    ],
    [
      "scoping to the wrong column",
      (s) => s.replace("job_id = v_job.id", "job_id = v_job.protocol_id"),
      (s) => !s.includes("job_id = v_job.id"),
    ],
    [
      "losing the prior-reason carry",
      (s) => s.replace("prior_needs_review_reason = coalesce(", "prior_needs_review_reason = (null and coalesce("),
      (s) => !s.includes("prior_needs_review_reason = coalesce("),
    ],
    [
      "dropping tenant scoping",
      (s) => s.replace("and job.project_id = p_project_id", ""),
      (s) => !s.includes("job.project_id = p_project_id"),
    ],
    [
      "marking attempts completed",
      (s) => s.replace("set status = 'excluded'", "set status = 'completed'"),
      (s) => /set status = 'completed'/i.test(s),
    ],
  ];

  for (const [label, mutate, detects] of mutations) {
    const mutated = mutate(newBody);
    assert(`the mutation "${label}" actually changes the SQL`, mutated !== newBody);
    assert(`…and a detector refuses it`, detects(mutated));
  }
}

console.log("");
assert("no network access was attempted", fetchCalls === 0);

console.log(
  failures === 0
    ? "\nM7 0070 schema contract PASSED."
    : `\n${failures} check(s) failed. M7 0070 schema contract FAILED.`
);
process.exit(failures === 0 ? 0 : 1);
