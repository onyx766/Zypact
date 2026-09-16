#!/usr/bin/env tsx
/**
 * Static contract for 0071 — the registered intervention record.
 *
 * The property under test is not "a table exists". It is that the word
 * *registered* is structurally true: the claim cannot be edited after
 * approval, an implementation cannot be confirmed without proof, and two live
 * interventions cannot share one baseline. Each of those is a methodology
 * guarantee the customer is being sold, so each is asserted against the SQL
 * rather than against anyone's intention.
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
const FILE = "0071_m7_registered_interventions.sql";
const RAW = readFileSync(path.join(MIGRATIONS, FILE), "utf8");

const SQL = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");
const FLAT = SQL.replace(/\s+/g, " ").trim();

function section(from: RegExp, to: RegExp): string {
  const s = FLAT.search(from);
  if (s < 0) return "";
  const rest = FLAT.slice(s);
  const e = rest.slice(1).search(to);
  return e < 0 ? rest : rest.slice(0, e + 1);
}

const TABLE = section(/create table if not exists public\.interventions/i, /\);\s*create (unique )?index/i);
const TRIGGER_FN = section(/create or replace function public\._reject_registered_intervention_edit/i, /\$\$;/);

/* ═══════════════ 1. the record carries what the methodology requires ═══════════════ */
{
  console.log("\n[1] V1_SCOPE 4.11 / PILOT_RUNBOOK 12 field coverage");

  for (const col of [
    "hypothesis",
    "expected_mechanism",
    "action_type",
    "action_target",
    "owner",
    "supporting_evidence",
    "alternative_explanations",
    "confounders_to_monitor",
    "decision_threshold_note",
    "implementation_deadline",
    "expected_observation_days",
    "approved_by",
    "approved_at",
    "implemented_at",
    "implementation_evidence",
    "implementation_confirmed_by",
    "artifact_sha256",
    "protocol_deviations",
  ]) {
    assert(`records ${col}`, new RegExp(`\\b${col}\\b`).test(TABLE));
  }

  assert("traceable to its baseline protocol",
    /protocol_id uuid not null references public\.protocols \(id\) on delete restrict/i.test(TABLE));
  assert("traceable to the exact question version",
    /buyer_question_version_id uuid not null references public\.buyer_question_versions \(id\) on delete restrict/i.test(TABLE));
  assert("tenant-scoped to a project",
    /project_id uuid not null references public\.projects \(id\)/i.test(TABLE));

  assert("artifact hash is a real SHA-256 or honestly null",
    /artifact_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/.test(TABLE));
  assert("status vocabulary is closed",
    /status in \('proposed', 'approved', 'implemented', 'rejected', 'abandoned'\)/.test(TABLE));
  assert("action_type vocabulary is closed",
    /action_type in \(/.test(TABLE) && /'other'/.test(TABLE));
}

/* ═══════════════ 2. registered means immutable ═══════════════ */
{
  console.log("\n[2] The registered claim cannot move after approval");

  assert("a BEFORE UPDATE trigger guards the row",
    /create trigger interventions_registration_is_immutable before update on public\.interventions for each row/i.test(FLAT));
  assert("the guard is dropped first, so re-applying cannot stack triggers",
    /drop trigger if exists interventions_registration_is_immutable/i.test(FLAT));
  assert("unapproved rows stay editable",
    /if old\.approved_at is null then return new; end if;/i.test(TRIGGER_FN));

  // Every field that constitutes the registered claim must be watched.
  for (const col of [
    "hypothesis",
    "expected_mechanism",
    "action_type",
    "action_target",
    "supporting_evidence",
    "decision_threshold_note",
    "protocol_id",
    "buyer_question_version_id",
    "project_id",
    "approved_at",
    "approved_by",
  ]) {
    assert(`the trigger watches ${col}`,
      new RegExp(`new\\.${col} is distinct from old\\.${col}`).test(TRIGGER_FN));
  }

  assert("the trigger raises rather than silently ignoring an edit",
    /raise exception using errcode = 'P0001', message = 'intervention_registration_is_immutable'/i.test(TRIGGER_FN));

  // Implementation facts are recorded after approval and must stay writable.
  for (const col of ["implemented_at", "implementation_evidence", "protocol_deviations", "artifact_sha256"]) {
    assert(`the trigger does NOT freeze ${col}`,
      !new RegExp(`new\\.${col} is distinct from old\\.${col}`).test(TRIGGER_FN));
  }
}

/* ═══════════════ 3. structural methodology guarantees ═══════════════ */
{
  console.log("\n[3] Constraints the methodology depends on");

  assert("one live intervention per baseline protocol",
    /create unique index if not exists interventions_one_live_per_protocol on public\.interventions \(protocol_id\) where status in \('proposed', 'approved', 'implemented'\)/i.test(FLAT));

  assert("an implemented intervention must carry proof it happened",
    /interventions_implementation_pair_check/.test(TABLE) &&
    /implemented_at is not null and implementation_evidence is not null and implementation_confirmed_by is not null/i.test(TABLE));

  assert("approval fields move together with status",
    /interventions_approval_pair_check/.test(TABLE));

  assert("a rejection must state a reason",
    /interventions_rejection_pair_check/.test(TABLE));

  assert("supporting_evidence is always an array",
    /jsonb_typeof\(supporting_evidence\) = 'array'/.test(TABLE));

  assert("approval refuses an intervention with no supporting evidence (D-009)",
    /jsonb_array_length\(v_intervention\.supporting_evidence\) = 0/.test(FLAT) &&
    /'intervention_needs_evidence'/.test(FLAT));

  assert("implementation cannot be confirmed before approval",
    /if v_intervention\.status <> 'approved' then return; end if;/i.test(FLAT));

  assert("an intervention can only be registered against an executable protocol",
    /v_protocol\.status not in \('approved', 'active', 'completed'\)/.test(FLAT));
}

/* ═══════════════ 4. writes are RPC-only ═══════════════ */
{
  console.log("\n[4] Privileges follow 0047's protocols precedent");

  assert("row level security is enabled",
    /alter table public\.interventions enable row level security/i.test(FLAT));
  assert("every privilege is revoked from every role, service_role included",
    /revoke all on table public\.interventions from public, anon, authenticated, service_role/i.test(FLAT));
  assert("service_role gets SELECT back, and only SELECT",
    /grant select on table public\.interventions to service_role/i.test(FLAT));
  assert("no INSERT or UPDATE grant on the table exists",
    !/grant[^;]*\b(insert|update)\b[^;]*on table public\.interventions/i.test(FLAT));

  for (const fn of [
    "register_intervention",
    "approve_intervention",
    "confirm_intervention_implementation",
  ]) {
    assert(`${fn} is revoked from public/anon/authenticated`,
      new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`, "i").test(FLAT));
    assert(`${fn} is granted to service_role`,
      new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`, "i").test(FLAT));
  }

  assert("the trigger function is not executable by untrusted roles",
    /revoke all on function public\._reject_registered_intervention_edit\(\) from public, anon, authenticated/i.test(FLAT));
  assert("the trigger function is granted to nobody",
    !/grant execute on function public\._reject_registered_intervention_edit/i.test(FLAT));

  const definers = FLAT.match(/security definer/gi) ?? [];
  assert("every function is security definer", definers.length === 4, String(definers.length));
  const paths = FLAT.match(/set search_path = public, pg_temp/gi) ?? [];
  assert("every function pins search_path", paths.length === 4, String(paths.length));
}

/* ═══════════════ 5. scope discipline ═══════════════ */
{
  console.log("\n[5] The migration stays inside its slice");

  for (const [label, re] of [
    ["adds no observation window column", /observation_window|window_opens_at|window_closes_at/i],
    ["creates no retest protocol", /baseline_protocol_id/i],
    ["creates no execution job", /protocol_execution_jobs/i],
    ["emits no outcome status", /increase_observed|decrease_observed|no_clear_change|inconclusive/i],
    ["touches no evidence table", /(update|delete from|insert into) public\.(protocol_external_calls|provider_call_receipts|analysis_call_receipts|probe_results)/i],
    ["touches no attempt row", /(update|delete from|insert into) public\.protocol_attempts/i],
    ["drops nothing that already exists", /drop (table|column|constraint|index)/i],
  ] as const) {
    assert(label, !re.test(FLAT));
  }

  assert("the only table created is interventions",
    (FLAT.match(/create table/gi) ?? []).length === 1);
  assert("no migration numbered above 0071 redefines these functions",
    readdirSync(MIGRATIONS)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) > 71)
      .every((f) => !/register_intervention|approve_intervention|confirm_intervention_implementation/i
        .test(readFileSync(path.join(MIGRATIONS, f), "utf8"))));
}

/* ═══════════════ 6. every detector is proved to bite ═══════════════ */
{
  console.log("\n[6] Negative self-tests");

  const mutations: Array<[string, string, string]> = [
    ["losing the immutability trigger", "create trigger interventions_registration_is_immutable", "create trigger something_else"],
    ["freezing nothing after approval", "new.hypothesis is distinct from old.hypothesis", "false"],
    ["allowing two live interventions", "interventions_one_live_per_protocol", "interventions_some_other_index"],
    ["granting the table directly", "grant select on table public.interventions to service_role", "grant select, insert, update on table public.interventions to service_role"],
    ["dropping the evidence requirement", "jsonb_array_length(v_intervention.supporting_evidence) = 0", "false"],
  ];

  for (const [label, needle, replacement] of mutations) {
    const mutated = FLAT.replace(needle, replacement);
    assert(`the mutation "${label}" actually changes the SQL`, mutated !== FLAT);

    let detected = false;
    if (label === "losing the immutability trigger")
      detected = !/create trigger interventions_registration_is_immutable before update/i.test(mutated);
    if (label === "freezing nothing after approval")
      detected = !/new\.hypothesis is distinct from old\.hypothesis/.test(mutated);
    if (label === "allowing two live interventions")
      detected = !/interventions_one_live_per_protocol/.test(mutated);
    if (label === "granting the table directly")
      detected = /grant[^;]*\b(insert|update)\b[^;]*on table public\.interventions/i.test(mutated);
    if (label === "dropping the evidence requirement")
      detected = !/jsonb_array_length\(v_intervention\.supporting_evidence\) = 0/.test(mutated);

    assert(`…and a detector refuses it`, detected);
  }
}

console.log("");
assert("no network access was attempted", fetchCalls === 0);

console.log(
  failures === 0
    ? "\nM7 0071 schema contract PASSED."
    : `\n${failures} check(s) failed. M7 0071 schema contract FAILED.`
);
process.exit(failures === 0 ? 0 : 1);
