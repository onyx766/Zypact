#!/usr/bin/env tsx
/**
 * Static contract for 0074 — retest phase integrity.
 *
 * The failure this guards against is the quiet kind. attempt_kind is
 * caller-supplied and validated only against a closed set, so a worker that
 * forgets to switch phases writes 'baseline' onto a retest protocol and every
 * layer accepts it: the attempts are real, the job succeeds, the report
 * renders. A later comparison that splits phases by attempt_kind then
 * compares a baseline against itself and produces an Outcome Card that is
 * confidently wrong, with no inconsistency left for anything to detect.
 *
 * So the checks below are mostly about the trigger existing, binding on the
 * table rather than inside an RPC, and refusing both directions.
 *
 * Text-only. No database, no network.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

let failures = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

let fetchCalls = 0;
globalThis.fetch = ((..._a: unknown[]) => {
  fetchCalls += 1;
  throw new Error("network access attempted in a static contract");
}) as unknown as typeof fetch;

const MIGRATIONS = path.join(process.cwd(), "supabase", "migrations");
const FILE = "0074_m7_retest_phase_integrity.sql";
const RAW = readFileSync(path.join(MIGRATIONS, FILE), "utf8");
const SQL = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");
const FLAT = SQL.replace(/\s+/g, " ").trim();

const GUARD =
  FLAT.match(/create or replace function public\._assert_attempt_kind_matches_phase[\s\S]*?\$\$;/i)?.[0] ?? "";
const PHASE =
  FLAT.match(/create or replace function public\.protocol_execution_phase[\s\S]*?\$\$;/i)?.[0] ?? "";

/* ═══════════════ 1. the phase guard exists and binds widely ═══════════════ */
{
  console.log("\n[1] attempt_kind cannot contradict its protocol");

  assert("a BEFORE INSERT trigger is installed on protocol_attempts",
    /create trigger protocol_attempts_phase_matches_protocol before insert on public\.protocol_attempts for each row execute function public\._assert_attempt_kind_matches_phase\(\)/i.test(FLAT));
  assert("the trigger is dropped first, so re-applying cannot stack it",
    /drop trigger if exists protocol_attempts_phase_matches_protocol on public\.protocol_attempts/i.test(FLAT));

  // On the table, not inside the RPCs — this is what makes it bind the M4 raw
  // RPCs that are still granted to service_role.
  assert("the rule lives on the table, not inside an admit RPC",
    !/create or replace function public\.admit_and_reserve_attempt/i.test(FLAT));

  assert("the phase is read from the protocol, not trusted from the caller",
    /select \(p\.baseline_protocol_id is not null\) into v_is_retest from public\.protocols p where p\.id = new\.protocol_id/i.test(GUARD));

  assert("a retest protocol refuses a non-retest attempt",
    /if v_is_retest and new\.attempt_kind <> 'retest' then/i.test(GUARD) &&
    /'attempt_kind_must_be_retest_on_a_retest_protocol'/.test(GUARD));
  assert("a baseline protocol refuses a retest attempt",
    /if \(not v_is_retest\) and new\.attempt_kind = 'retest' then/i.test(GUARD) &&
    /'attempt_kind_retest_requires_a_retest_protocol'/.test(GUARD));
  assert("both directions raise rather than silently correcting the row",
    (GUARD.match(/raise exception/gi) ?? []).length === 2 &&
    !/new\.attempt_kind\s*:=/.test(GUARD));

  assert("control and paraphrase stay legal on a baseline protocol",
    !/'control'/.test(GUARD) && !/'paraphrase'/.test(GUARD));

  assert("a missing protocol is left to the foreign key",
    /if not found then[\s\S]{0,120}return new;/i.test(GUARD));
}

/* ═══════════════ 2. it cannot fail on, or rewrite, history ═══════════════ */
{
  console.log("\n[2] Applying this migration is safe on existing data");

  assert("the trigger is INSERT-only, so historical rows are never revalidated",
    /before insert on public\.protocol_attempts/i.test(FLAT) &&
    !/before insert or update/i.test(FLAT) &&
    !/after update/i.test(FLAT));

  for (const [label, re] of [
    ["mutates no row", /\bupdate public\./i],
    ["deletes nothing", /delete from/i],
    ["inserts nothing", /insert into public\./i],
    ["adds no column", /add column/i],
    ["adds no constraint", /add constraint/i],
    ["creates no table", /create table/i],
    ["creates no index", /create (unique )?index/i],
  ] as const) {
    assert(label, !re.test(FLAT));
  }
}

/* ═══════════════ 3. no fenced routine was touched ═══════════════ */
{
  console.log("\n[3] The claim/lease/fencing path is untouched");

  for (const fn of [
    "claim_next_protocol_execution_job",
    "claim_protocol_execution_job_by_id",
    "enqueue_protocol_execution_job",
    "admit_and_reserve_attempt_for_job",
    "create_probe_run_and_start_attempt_for_job",
    "retry_full_attempt_for_job",
    "reconcile_attempt_for_job",
    "authorize_operator_retry",
    "record_provider_call_receipt_for_job",
  ]) {
    assert(`${fn} is not redefined`,
      !new RegExp(`(create|drop|alter)\\s+(or\\s+replace\\s+)?function[\\s\\S]{0,80}?public\\.${fn}\\s*\\(`, "i").test(FLAT));
  }

  assert("no new job table or claim primitive is introduced",
    !/protocol_execution_jobs \(/.test(FLAT) && !/claim_token/.test(FLAT) && !/lease_expires_at/.test(FLAT));
}

/* ═══════════════ 4. the worker has one source for the kind ═══════════════ */
{
  console.log("\n[4] protocol_execution_phase agrees with the trigger");

  assert("the helper exists and is read-only",
    PHASE !== "" && /\bstable\b/i.test(PHASE) &&
    !/\b(insert|update|delete)\b/i.test(PHASE.replace(/'[^']*'/g, "")));
  assert("it uses the same predicate the trigger enforces",
    /v\.baseline_protocol_id is not null/.test(PHASE));
  assert("it returns the attempt_kind to use, not just a label",
    /attempt_kind\s+text/i.test(PHASE) &&
    /'retest'::text, 'retest'::text/.test(PHASE) &&
    /'baseline'::text, 'baseline'::text/.test(PHASE));
  assert("it reports planned_runs from planned_baseline_runs for BOTH phases",
    (PHASE.match(/v\.planned_baseline_runs/g) ?? []).length === 2);
  assert("it never reads planned_retest_runs",
    !/planned_retest_runs/.test(PHASE),
    "the slot machinery reads planned_baseline_runs only");
  assert("it is tenant-scoped",
    /p\.project_id = p_project_id/.test(PHASE));
  assert("an unknown protocol yields no row rather than a guess",
    /if not found then return; end if;/i.test(PHASE));
}

/* ═══════════════ 5. privileges ═══════════════ */
{
  console.log("\n[5] ACL");

  assert("protocol_execution_phase revoked from untrusted roles",
    /revoke all on function public\.protocol_execution_phase\(uuid, uuid\) from public, anon, authenticated/i.test(FLAT));
  assert("protocol_execution_phase granted to service_role",
    /grant execute on function public\.protocol_execution_phase\(uuid, uuid\) to service_role/i.test(FLAT));
  assert("the trigger function is revoked and granted to nobody",
    /revoke all on function public\._assert_attempt_kind_matches_phase\(\) from public, anon, authenticated/i.test(FLAT) &&
    !/grant execute on function public\._assert_attempt_kind_matches_phase/i.test(FLAT));
  assert("both functions are security definer with a pinned search_path",
    (FLAT.match(/security definer/gi) ?? []).length === 2 &&
    (FLAT.match(/set search_path = public, pg_temp/gi) ?? []).length === 2);

  assert("no later migration redefines the phase rule",
    readdirSync(MIGRATIONS)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) > 74)
      .every((f) => !/_assert_attempt_kind_matches_phase|protocol_execution_phase/i
        .test(readFileSync(path.join(MIGRATIONS, f), "utf8"))));
}

/* ═══════════════ 6. every detector is proved to bite ═══════════════ */
{
  console.log("\n[6] Negative self-tests");

  const mutations: Array<[string, string, string, (s: string) => boolean]> = [
    [
      "removing the trigger",
      "create trigger protocol_attempts_phase_matches_protocol",
      "create trigger unrelated_thing",
      (s) => !/create trigger protocol_attempts_phase_matches_protocol before insert/i.test(s),
    ],
    [
      "checking only one direction",
      "if (not v_is_retest) and new.attempt_kind = 'retest' then",
      "if false then",
      (s) => !/if \(not v_is_retest\) and new\.attempt_kind = 'retest' then/i.test(s),
    ],
    [
      "silently correcting instead of refusing",
      "raise exception using errcode = 'P0001', message = 'attempt_kind_must_be_retest_on_a_retest_protocol';",
      "new.attempt_kind := 'retest';",
      (s) => /new\.attempt_kind :=/.test(s),
    ],
    [
      "trusting the caller for the phase",
      "select (p.baseline_protocol_id is not null) into v_is_retest from public.protocols p where p.id = new.protocol_id",
      "select (new.attempt_kind = 'retest') into v_is_retest",
      (s) => !/from public\.protocols p where p\.id = new\.protocol_id/i.test(s),
    ],
    [
      "helper reading the wrong run column",
      "v.planned_baseline_runs, v.baseline_protocol_id",
      "v.planned_retest_runs, v.baseline_protocol_id",
      (s) => /planned_retest_runs/.test(s.match(/create or replace function public\.protocol_execution_phase[\s\S]*?\$\$;/i)?.[0] ?? ""),
    ],
  ];

  for (const [label, needle, replacement, detects] of mutations) {
    const mutated = FLAT.replace(needle, replacement);
    assert(`the mutation "${label}" actually changes the SQL`, mutated !== FLAT);
    assert(`…and a detector refuses it`, detects(mutated));
  }
}

console.log("");
assert("no network access was attempted", fetchCalls === 0);

console.log(
  failures === 0
    ? "\nM7 0074 schema contract PASSED."
    : `\n${failures} check(s) failed. M7 0074 schema contract FAILED.`
);
process.exit(failures === 0 ? 0 : 1);
