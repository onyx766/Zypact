#!/usr/bin/env tsx
/**
 * Static contract for 0073 — retest protocol creation.
 *
 * Two properties carry the weight here.
 *
 * First, identity: the retest must reuse the baseline's
 * buyer_question_version_id ROW, not a copy and not a new version. Minting a
 * new version would have sidestepped 0047's index and looked like it worked,
 * while silently destroying the very comparison the product sells.
 *
 * Second, the gate: eligibility must be delegated to 0072's single authority,
 * never reimplemented here. Two copies of an eligibility rule drift, and the
 * drift is discovered by a customer.
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
const FILE = "0073_m7_retest_protocol_creation.sql";
const RAW = readFileSync(path.join(MIGRATIONS, FILE), "utf8");
const SQL = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");
const FLAT = SQL.replace(/\s+/g, " ").trim();

const FN =
  FLAT.match(/create or replace function public\.create_retest_protocol[\s\S]*?\$\$;/i)?.[0] ?? "";

/* ═══════════════ 1. the liveness rule is narrowed, never removed ═══════════════ */
{
  console.log("\n[1] 0047's index is replaced, not merely dropped");

  assert("a baseline-scoped liveness index is created",
    /create unique index if not exists protocols_one_live_baseline_per_version on public\.protocols \(buyer_question_version_id\) where status in \('approved', 'active'\) and baseline_protocol_id is null/i.test(FLAT));
  assert("a retest-scoped liveness index is created",
    /create unique index if not exists protocols_one_live_retest_per_baseline on public\.protocols \(baseline_protocol_id\) where status in \('approved', 'active'\) and baseline_protocol_id is not null/i.test(FLAT));
  assert("0047's index is dropped",
    /drop index if exists public\.protocols_one_active_per_version/i.test(FLAT));

  // Ordering matters: dropping first would leave a window with no rule.
  assert("the replacements are created BEFORE the old index is dropped",
    FLAT.indexOf("protocols_one_live_baseline_per_version") <
      FLAT.indexOf("drop index if exists public.protocols_one_active_per_version") &&
    FLAT.indexOf("protocols_one_live_retest_per_baseline") <
      FLAT.indexOf("drop index if exists public.protocols_one_active_per_version"));

  assert("the baseline lifecycle is NOT changed by this migration",
    !/update public\.protocols/i.test(FLAT) &&
    !/status = 'completed'/i.test(FLAT));
}

/* ═══════════════ 2. same-question identity ═══════════════ */
{
  console.log("\n[2] The retest is the SAME question, not a copy");

  assert("the baseline's question version row is reused verbatim",
    /v_baseline\.buyer_question_version_id/.test(FN));
  assert("no new buyer question is created",
    !/insert into public\.buyer_questions/i.test(FLAT));
  assert("no new question version is created",
    !/insert into public\.buyer_question_versions/i.test(FLAT));
  assert("no prompt text or hash is written",
    !/prompt_text|prompt_hash/i.test(FLAT));

  assert("the retest links to its baseline",
    /baseline_protocol_id/.test(FN) && /v_baseline\.id/.test(FN));

  for (const col of ["provider", "surface", "model_config", "paraphrase_plan",
                     "unit_of_analysis", "primary_metric", "analyzer_version",
                     "entity_resolution_version", "methodology_version"]) {
    assert(`${col} is carried over from the baseline`,
      new RegExp(`v_baseline\\.${col}\\b`).test(FN));
  }

  // The run count must land in planned_baseline_runs. 0051's enqueue refuses
  // planned_baseline_runs = 0 outright (NO_BASELINE_RUNS_PLANNED), so putting
  // the count in planned_retest_runs yields a protocol that can never execute
  // — a mistake that reads as tidier and is silently fatal.
  assert("the run count lands in planned_baseline_runs, which the slot machinery reads",
    /v_baseline\.planned_baseline_runs,\s*0,/.test(FN));
  assert("planned_baseline_runs is never set to 0",
    !/\b0,\s*v_baseline\.planned_baseline_runs/.test(FN));
  assert("phase sizes match, so the detection threshold does not move",
    /v_baseline\.planned_baseline_runs/.test(FN));
  assert("caps are inherited rather than invented",
    /v_baseline\.run_cap/.test(FN) && /v_baseline\.spend_cap_usd/.test(FN) &&
    /v_baseline\.retry_cap/.test(FN) && /v_baseline\.concurrency_limit/.test(FN));
}

/* ═══════════════ 3. the gate is delegated, not reimplemented ═══════════════ */
{
  console.log("\n[3] Eligibility comes from 0072's single authority");

  assert("retest_eligibility is called",
    /from public\.retest_eligibility\(p_intervention_id, p_project_id\)/i.test(FN));
  assert("an ineligible intervention produces no protocol",
    /if not v_eligible then return query select v_reason, null::uuid; return; end if;/i.test(FN));
  assert("the refusal reason is surfaced, not swallowed",
    /select v_reason, null::uuid/.test(FN));

  // The rule must not be duplicated here in any form.
  for (const [label, re] of [
    ["does not re-derive the window", /observation_window_closes_at/i],
    ["does not re-check implementation status", /status <> 'implemented'/i],
    ["does not read the early-authorisation flag directly", /early_retest_authorized/i],
    ["does not compare now() to anything itself", /now\(\) [<>]/i],
  ] as const) {
    assert(label, !re.test(FN));
  }
}

/* ═══════════════ 4. safety of the write path ═══════════════ */
{
  console.log("\n[4] Approval, replay and tenancy");

  assert("the intervention row is locked",
    /from public\.interventions i where i\.id = p_intervention_id and i\.project_id = p_project_id for update/i.test(FN));
  assert("the baseline row is locked",
    /from public\.protocols p where p\.id = v_intervention\.protocol_id and p\.project_id = p_project_id for update/i.test(FN));
  assert("every lookup is tenant-scoped",
    (FN.match(/project_id = p_project_id/g) ?? []).length >= 3);

  assert("a repeated call returns the existing retest instead of a second one",
    /'RETEST_ALREADY_EXISTS'/.test(FN));
  assert("replay is checked before the insert",
    FN.indexOf("RETEST_ALREADY_EXISTS") < FN.indexOf("insert into public.protocols"));

  assert("approval goes through approve_protocol",
    /from public\.approve_protocol\(v_new_id, p_project_id, p_approved_by\)/i.test(FN));

  // The insert must leave the row in 'draft' and let approve_protocol move
  // it, so the retest passes the same gate a baseline does. Checked against
  // the INSERT's column list alone: a looser scan trips over the 'APPROVED'
  // status code compared further down the function.
  const insertColumns =
    FN.match(/insert into public\.protocols \(([^)]*)\) values/i)?.[1] ?? "";
  assert("the insert names columns at all", insertColumns.length > 0);
  for (const col of ["status", "approved_by", "approved_at"]) {
    assert(`the insert does not set ${col} directly`,
      !new RegExp(`(^|,)\\s*${col}\\s*(,|$)`).test(insertColumns));
  }
  assert("an unexpected approval outcome aborts the whole creation",
    /if v_approval <> 'APPROVED' then raise exception/i.test(FN));

  assert("a baseline with no plan is refused",
    /'BASELINE_HAS_NO_PLAN'/.test(FN));
  assert("every outcome is a named status code",
    ["INTERVENTION_NOT_FOUND", "BASELINE_NOT_FOUND", "RETEST_ALREADY_EXISTS",
     "BASELINE_HAS_NO_PLAN", "CREATED"].every((c) => new RegExp(`'${c}'`).test(FN)));
}

/* ═══════════════ 5. the registered threshold is stored, not hard-coded ═══════════════ */
{
  console.log("\n[5] minimum_useful_change is recorded on the row");

  assert("the signed-off value is stamped on the protocol",
    /'value', 0\.60/.test(FN));
  assert("the comparison method is recorded beside it",
    /'comparison_method', 'newcombe_95'/.test(FN));
  assert("the value's provenance is recorded",
    /'source', 'founder_sign_off_2026_09_16'/.test(FN));
  assert("the metric it applies to is recorded",
    /'metric', v_baseline\.primary_metric/.test(FN));
}

/* ═══════════════ 6. scope and privileges ═══════════════ */
{
  console.log("\n[6] Scope discipline and ACL");

  for (const [label, re] of [
    ["creates no table", /create table/i],
    ["creates no execution job", /protocol_execution_jobs/i],
    ["reserves no attempt", /protocol_attempts/i],
    ["emits no outcome status", /increase_observed|decrease_observed|no_clear_change|inconclusive/i],
    ["touches no evidence table", /(update|delete from|insert into) public\.(protocol_external_calls|provider_call_receipts|analysis_call_receipts|probe_results)/i],
    ["deletes nothing", /delete from/i],
  ] as const) {
    assert(label, !re.test(FLAT));
  }

  assert("revoked from untrusted roles",
    /revoke all on function public\.create_retest_protocol\(uuid, uuid, uuid\) from public, anon, authenticated/i.test(FLAT));
  assert("granted to service_role",
    /grant execute on function public\.create_retest_protocol\(uuid, uuid, uuid\) to service_role/i.test(FLAT));
  assert("security definer with a pinned search_path",
    /security definer/i.test(FN) && /set search_path = public, pg_temp/i.test(FN));

  // Checked as an actual CREATE/DROP/ALTER statement, not a bare substring
  // over raw file text — a later migration's own header prose legitimately
  // cross-references this migration by name (0075's does, explaining why
  // approve_protocol's symmetric-n disclosure also covers a retest protocol
  // created here) without redefining anything. A comment mention is not a
  // redefinition.
  const definitionRe = (name: string) =>
    new RegExp(`(create|drop|alter)\\s+(or\\s+replace\\s+)?(function|index)[\\s\\S]{0,120}?\\b${name}\\b`, "i");
  // Reviewed exception (D-061, 2026-11-17): ChatGPT phase B replaces the
  // baseline index with one live baseline per version PER ENGINE, so a
  // pilot question can have a ChatGPT baseline on its one approved version
  // without minting a second version (the identity this file protects).
  // Only that migration may touch the baseline index, and only by creating
  // the per-engine index, with this index's predicate, BEFORE dropping this
  // one; scripts/test-chatgpt-phase-b-schema.ts and -db.ts prove two
  // Perplexity baselines on one version stay refused. The retest index and
  // create_retest_protocol have no exception.
  const BASELINE_INDEX_REPLACER = "20261109180000_chatgpt_measurement.sql";
  const replacesBaselineIndexAsReviewed = (f: string, stripped: string) => {
    const create = stripped.search(/create unique index protocols_one_live_baseline_per_engine\s+on public\.protocols \(\s*buyer_question_version_id,[^;]*?\)\s+where status in \('approved', 'active'\)\s+and baseline_protocol_id is null;/i);
    const drop = stripped.indexOf("drop index public.protocols_one_live_baseline_per_version;");
    // It drops the old index and never creates or alters it.
    return f === BASELINE_INDEX_REPLACER && create >= 0 && drop > create
      && !/(create|alter)\s+(or\s+replace\s+)?(function|index)[\s\S]{0,120}?\bprotocols_one_live_baseline_per_version\b/i.test(stripped);
  };
  const laterClean = (list: ReturnType<typeof ledger>) => list
    .filter((x) => x.n > 73)
    .every(({ f, sql }) => {
      const stripped = sql
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*--.*$/gm, "");
      return ["create_retest_protocol", "protocols_one_live_retest_per_baseline"]
        .every((name) => !definitionRe(name).test(stripped))
        && (!definitionRe("protocols_one_live_baseline_per_version").test(stripped) || replacesBaselineIndexAsReviewed(f, stripped));
    });
  assert("no later migration redefines it or the indexes", laterClean(ledger()));
  const baselineIndexTouchers = ledger().filter((x) => x.n > 73).filter(({ sql }) =>
    definitionRe("protocols_one_live_baseline_per_version").test(sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "")));
  assert("the baseline index is touched only by the reviewed per-engine replacement (D-061), created before the drop",
    baselineIndexTouchers.every(({ f, sql }) => replacesBaselineIndexAsReviewed(f, sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, ""))),
    baselineIndexTouchers.map((x) => x.f).join(", ") || "none");

  // QD-6: a timestamped migration is examined, never skipped.
  for (const { label, extra, allow } of INVALID_MIGRATION_NAMES) {
    assert(`the migration ledger refuses ${label}`, ledgerRefuses(MIGRATIONS, extra, allowlistWith(allow)));
  }
  const drift = allowlistDrift(readdirSync(MIGRATIONS));
  assert("the migrations directory matches the exact four-digit allowlist", drift.length === 0, drift.join("; "));
  for (const sql of [
    "create or replace function public.create_retest_protocol(p_a uuid)\nreturns void language sql as $x$ select 1 $x$;",
    "drop index if exists public.protocols_one_live_retest_per_baseline;",
    // Any other migration touching the baseline index is still caught, even
    // one copying the reviewed replacement.
    "drop index if exists public.protocols_one_live_baseline_per_version;",
    "create unique index protocols_one_live_baseline_per_engine\n  on public.protocols (buyer_question_version_id, provider)\n  where status in ('approved', 'active')\n    and baseline_protocol_id is null;\ndrop index public.protocols_one_live_baseline_per_version;",
  ]) {
    assert(`a timestamped migration is caught: ${sql.split("(")[0].split(";")[0]}`,
      !laterClean(ledger({ [TIMESTAMP_FIXTURE]: sql })));
  }
}

/* ═══════════════ 7. every detector is proved to bite ═══════════════ */
{
  console.log("\n[7] Negative self-tests");

  const mutations: Array<[string, string, string, (s: string) => boolean]> = [
    [
      "minting a new question version instead of reusing one",
      "v_baseline.buyer_question_version_id,",
      "(insert into public.buyer_question_versions default values returning id),",
      (s) => /insert into public\.buyer_question_versions/i.test(s),
    ],
    [
      "reimplementing the eligibility rule",
      "from public.retest_eligibility(p_intervention_id, p_project_id) e",
      "where now() > v_intervention.observation_window_closes_at",
      (s) => !/from public\.retest_eligibility\(/i.test(s),
    ],
    [
      "dropping the old index without a replacement",
      "create unique index if not exists protocols_one_live_baseline_per_version",
      "select 1; -- gone",
      (s) => !/protocols_one_live_baseline_per_version on public\.protocols/i.test(s),
    ],
    [
      "allowing a duplicate retest",
      "'RETEST_ALREADY_EXISTS'",
      "'IGNORED'",
      (s) => !/'RETEST_ALREADY_EXISTS'/.test(s),
    ],
    [
      "approving by direct status write",
      "from public.approve_protocol(v_new_id, p_project_id, p_approved_by) a",
      "where false",
      (s) => !/from public\.approve_protocol\(/i.test(s),
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
    ? "\nM7 0073 schema contract PASSED."
    : `\n${failures} check(s) failed. M7 0073 schema contract FAILED.`
);
process.exit(failures === 0 ? 0 : 1);
