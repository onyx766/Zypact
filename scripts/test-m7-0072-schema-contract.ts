#!/usr/bin/env tsx
/**
 * Static contract for 0072 — observation window and retest eligibility.
 *
 * The acceptance criterion is a negative one: a retest must not be able to
 * run early unless a deviation was recorded. Most of the checks below are
 * therefore about what the SQL makes IMPOSSIBLE, and in particular about the
 * bypass that a naive implementation leaves open — deriving eligibility from
 * a mutable `expected_observation_days` instead of freezing an absolute
 * instant at implementation.
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
const FILE = "0072_m7_observation_window_and_retest_eligibility.sql";
const RAW = readFileSync(path.join(MIGRATIONS, FILE), "utf8");
const SQL = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");
const FLAT = SQL.replace(/\s+/g, " ").trim();

function fn(name: string): string {
  const m = FLAT.match(
    new RegExp(`create or replace function public\\.${name}[\\s\\S]*?\\$\\$;`, "i")
  );
  return m ? m[0] : "";
}

const TRIGGER_FN = fn("_reject_registered_intervention_edit");
const CONFIRM = fn("confirm_intervention_implementation");
const AUTHORIZE = fn("authorize_early_retest");
const ELIGIBILITY = fn("retest_eligibility");

/* ═══════════════ 1. the window is an absolute, frozen instant ═══════════════ */
{
  console.log("\n[1] The window cannot be moved after it opens");

  assert("an absolute closing instant is stored",
    /add column if not exists observation_window_closes_at\s+timestamptz/i.test(SQL));
  assert("an opening instant is stored",
    /add column if not exists observation_window_opens_at\s+timestamptz/i.test(SQL));

  assert("the closing instant is computed at implementation, from implemented_at",
    /observation_window_closes_at = v_now \+ make_interval\(days => v_intervention\.expected_observation_days\)/i.test(CONFIRM));
  assert("the window opens at implementation, not at approval",
    /observation_window_opens_at = v_now/.test(CONFIRM) &&
    /status = 'implemented', implemented_at = v_now/.test(CONFIRM));

  assert("the trigger freezes the window once it exists",
    /old\.observation_window_closes_at is not null/.test(TRIGGER_FN) &&
    /'observation_window_is_immutable'/.test(TRIGGER_FN));
  assert("the freeze covers both ends of the window",
    /new\.observation_window_closes_at is distinct from old\.observation_window_closes_at/.test(TRIGGER_FN) &&
    /new\.observation_window_opens_at is distinct from old\.observation_window_opens_at/.test(TRIGGER_FN));

  // THE bypass: eligibility must never be recomputed from the mutable field.
  assert("eligibility never derives from expected_observation_days",
    !/expected_observation_days/.test(ELIGIBILITY),
    "a derived window can be shortened after the fact");
  assert("eligibility compares now() to the stored instant",
    /now\(\) < v\.observation_window_closes_at/.test(ELIGIBILITY));

  assert("the window freeze applies even before approval",
    TRIGGER_FN.indexOf("observation_window_is_immutable") <
      TRIGGER_FN.indexOf("if old.approved_at is null then"),
    "the window guard must sit above the approval early-return");
}

/* ═══════════════ 2. an implemented intervention always has a window ═══════════════ */
{
  console.log("\n[2] Implementation and window cannot come apart");

  assert("a constraint forbids implemented-without-window",
    /interventions_implemented_has_window_check/.test(FLAT) &&
    /status <> 'implemented' or observation_window_closes_at is not null/i.test(FLAT));
  assert("the two ends move together",
    /\(observation_window_opens_at is null\) = \(observation_window_closes_at is null\)/i.test(FLAT));
  assert("a window cannot close before it opens",
    /observation_window_closes_at > observation_window_opens_at/i.test(FLAT));

  assert("implementation is refused when no window length was declared",
    /v_intervention\.expected_observation_days is null/.test(CONFIRM) &&
    /'observation_window_not_declared'/.test(CONFIRM));
  assert("the engine never invents a window length",
    !/expected_observation_days\s*,\s*\d+\)/.test(CONFIRM) &&
    !/coalesce\(v_intervention\.expected_observation_days/.test(CONFIRM));

  assert("confirm keeps 0071's signature, so grants survive",
    /confirm_intervention_implementation\( p_intervention_id uuid, p_project_id uuid, p_confirmed_by uuid, p_evidence jsonb, p_artifact_sha256 text default null, p_deviations text default null \)/i
      .test(CONFIRM));
  assert("confirm still requires approval first",
    /if v_intervention\.status <> 'approved' then return; end if;/i.test(CONFIRM));
}

/* ═══════════════ 3. the only way past the gate is a recorded deviation ═══════════════ */
{
  console.log("\n[3] Early retest requires a recorded deviation");

  assert("an early authorisation needs an identity, an instant and a reason",
    /interventions_early_retest_pair_check/.test(FLAT) &&
    /early_retest_reason is not null and btrim\(early_retest_reason\) <> ''/i.test(FLAT));
  assert("a blank reason is refused by the RPC too",
    /p_reason is null or btrim\(p_reason\) = ''/.test(AUTHORIZE) &&
    /'early_retest_reason_required'/.test(AUTHORIZE));
  assert("an authorisation cannot be granted before implementation",
    /if v_intervention\.status <> 'implemented' then return; end if;/i.test(AUTHORIZE));
  assert("a second authorisation cannot overwrite the first",
    /if v_intervention\.early_retest_authorized_at is not null then return next v_intervention; return; end if;/i.test(AUTHORIZE));
  assert("the trigger makes a recorded deviation permanent",
    /'early_retest_authorization_is_immutable'/.test(TRIGGER_FN));

  assert("eligibility honours an authorised deviation explicitly",
    /'AUTHORIZED_DEVIATION'/.test(ELIGIBILITY));
  assert("eligibility reports WHY, not just yes or no",
    ["INTERVENTION_NOT_FOUND", "INTERVENTION_NOT_IMPLEMENTED", "OBSERVATION_WINDOW_OPEN", "WINDOW_ELAPSED"]
      .every((r) => new RegExp(`'${r}'`).test(ELIGIBILITY)));
  assert("an unimplemented intervention is never eligible",
    /v\.status <> 'implemented'/.test(ELIGIBILITY));
  assert("eligibility is read-only",
    /\bstable\b/i.test(ELIGIBILITY) &&
    !/\b(insert|update|delete)\b/i.test(ELIGIBILITY.replace(/'[^']*'/g, "")));
}

/* ═══════════════ 4. 0071's guarantees survived the trigger rewrite ═══════════════ */
{
  console.log("\n[4] The 0071 registration freeze is intact");

  for (const col of [
    "hypothesis", "expected_mechanism", "action_type", "action_target",
    "supporting_evidence", "decision_threshold_note", "protocol_id",
    "buyer_question_version_id", "project_id", "approved_at", "approved_by",
  ]) {
    assert(`still freezes ${col} after approval`,
      new RegExp(`new\\.${col} is distinct from old\\.${col}`).test(TRIGGER_FN));
  }
  assert("still raises the registration error",
    /'intervention_registration_is_immutable'/.test(TRIGGER_FN));
  assert("unapproved rows are still editable",
    /if old\.approved_at is null then return new; end if;/i.test(TRIGGER_FN));
  assert("the trigger keeps its signature, so the 0071 trigger binding still resolves",
    /create or replace function public\._reject_registered_intervention_edit\(\) returns trigger/i.test(FLAT));
}

/* ═══════════════ 5. scope and privileges ═══════════════ */
{
  console.log("\n[5] Scope discipline and ACL");

  for (const [label, re] of [
    ["creates no table", /create table/i],
    ["creates no retest protocol", /baseline_protocol_id/i],
    ["creates no execution job", /protocol_execution_jobs/i],
    ["emits no outcome status", /increase_observed|decrease_observed|no_clear_change|inconclusive/i],
    ["touches no evidence table", /(update|delete from|insert into) public\.(protocol_external_calls|provider_call_receipts|analysis_call_receipts|probe_results)/i],
    ["touches no attempt row", /(update|delete from|insert into) public\.protocol_attempts/i],
    ["drops no column", /drop column/i],
  ] as const) {
    assert(label, !re.test(FLAT));
  }

  for (const f of ["authorize_early_retest", "retest_eligibility", "confirm_intervention_implementation"]) {
    assert(`${f} revoked from untrusted roles`,
      new RegExp(`revoke all on function public\\.${f}\\([^)]*\\) from public, anon, authenticated`, "i").test(FLAT));
    assert(`${f} granted to service_role`,
      new RegExp(`grant execute on function public\\.${f}\\([^)]*\\) to service_role`, "i").test(FLAT));
  }
  assert("the trigger function is granted to nobody",
    /revoke all on function public\._reject_registered_intervention_edit\(\) from public, anon, authenticated/i.test(FLAT) &&
    !/grant execute on function public\._reject_registered_intervention_edit/i.test(FLAT));

  assert("every function is security definer",
    (FLAT.match(/security definer/gi) ?? []).length === 4);
  assert("every function pins search_path",
    (FLAT.match(/set search_path = public, pg_temp/gi) ?? []).length === 4);

  assert("no later migration redefines the eligibility authority",
    readdirSync(MIGRATIONS)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) > 72)
      .every((f) => !/function public\.retest_eligibility/i.test(readFileSync(path.join(MIGRATIONS, f), "utf8"))));
}

/* ═══════════════ 6. every detector is proved to bite ═══════════════ */
{
  console.log("\n[6] Negative self-tests");

  const mutations: Array<[string, string, string, (s: string) => boolean]> = [
    [
      "deriving eligibility from the mutable field",
      "now() < v.observation_window_closes_at",
      "now() < v.implemented_at + make_interval(days => v.expected_observation_days)",
      (s) => /expected_observation_days/.test(s.match(/create or replace function public\.retest_eligibility[\s\S]*?\$\$;/i)?.[0] ?? ""),
    ],
    [
      "unfreezing the window",
      "'observation_window_is_immutable'",
      "'oops'",
      (s) => !/'observation_window_is_immutable'/.test(s),
    ],
    [
      "letting an early authorisation be overwritten",
      "if v_intervention.early_retest_authorized_at is not null then return next v_intervention; return; end if;",
      "",
      (s) => !/if v_intervention\.early_retest_authorized_at is not null then return next/i.test(s),
    ],
    [
      "dropping the reason requirement",
      "'early_retest_reason_required'",
      "'ok'",
      (s) => !/'early_retest_reason_required'/.test(s),
    ],
    [
      "allowing implemented without a window",
      "status <> 'implemented' or observation_window_closes_at is not null",
      "true",
      (s) => !/status <> 'implemented' or observation_window_closes_at is not null/i.test(s),
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
    ? "\nM7 0072 schema contract PASSED."
    : `\n${failures} check(s) failed. M7 0072 schema contract FAILED.`
);
process.exit(failures === 0 ? 0 : 1);
