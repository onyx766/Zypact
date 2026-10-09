/**
 * Phase 7 — processOutcomeCard's build half, which had no test.
 *
 * Runs the REAL pipeline — both evidence readers, buildProtocolReport,
 * buildOutcomeCard, the markdown renderer, both phases' integrity signals and
 * their combination — against a fake database holding a complete baseline
 * and retest. Only the database is faked; nothing in the pipeline is.
 *
 * What it pins:
 *   - the card compares against the intervention's LIVE retest, never an
 *     abandoned one on the same baseline (the lookup fixed alongside 0079);
 *   - both phases share one question, and the card says so;
 *   - the outcome is one of the four canonical statuses and nothing else,
 *     and moves the right way when the data does;
 *   - the non-causality footer is present in both payload and markdown;
 *   - weak evidence in the RETEST phase alone is enough to stop the card
 *     passing integrity — the combination genuinely reads both phases;
 *   - nothing is saved for an intervention that is not ready, and nothing is
 *     ever sent with auto-send off.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { processOutcomeCard } from "@/lib/reports/deliver-outcome-card";
import { NON_CAUSALITY_FOOTER } from "@/lib/reports/outcome-card-types";

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) { passed += 1; console.log(`  ok   ${label}`); }
  else { failed += 1; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

type Row = Record<string, unknown>;
interface Call { name: string; args: Record<string, unknown> }

/** PostgREST-faithful enough: maybeSingle() errors on more than one row. */
function fakeDb(tables: Record<string, Row[]>) {
  const calls: Call[] = [];
  function query(table: string) {
    let rows = [...(tables[table] ?? [])];
    const q = {
      select: () => q,
      order: () => q,
      limit: (n: number) => { rows = rows.slice(0, n); return q; },
      eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; },
      neq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] !== v); return q; },
      in: (c: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[c])); return q; },
      maybeSingle: async () =>
        rows.length > 1
          ? { data: null, error: { message: `multiple rows in ${table}` } }
          : { data: rows[0] ?? null, error: null },
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: rows, error: null }),
    };
    return q;
  }
  const client = {
    from: (t: string) => query(t),
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "save_outcome_card_artifact") {
        return { data: [{ id: "artifact-1", public_token: "tok", delivered_at: null }], error: null };
      }
      if (name === "outcome_card_artifact_revision") return { data: "f".repeat(64), error: null };
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const PROJECT = "11111111-1111-4111-8111-111111111111";
const IV = "44444444-4444-4444-8444-444444444444";
const BASE = "22222222-2222-4222-8222-222222222222";
const RETEST = "33333333-3333-4333-8333-333333333333";
const OLD_RETEST = "66666666-6666-4666-8666-666666666666";
const BQV = "99999999-9999-4999-8999-999999999999";
const HASH = "c".repeat(64);

function protocolRow(id: string, baselineId: string | null, status: string): Row {
  return {
    id, project_id: PROJECT, buyer_question_version_id: BQV, baseline_protocol_id: baselineId, status,
    provider: "perplexity_sonar", surface: "answer", model_config: { model: "sonar" },
    planned_baseline_runs: 5, planned_retest_runs: 0, unit_of_analysis: "buyer_question_version",
    primary_metric: "presence_rate", methodology_version: "1.1", analyzer_version: 1, entity_resolution_version: 2,
    approved_at: "2026-09-01T00:00:00Z", sample_planning_method: "fixed_operator_default_pending_pilot_calibration",
    paraphrase_plan: [{ text: "Which SOC 2 tool?", hash: HASH }],
    minimum_useful_change: { value: 0.6, comparison_method: "newcombe_95", source: "founder_sign_off_2026_09_16" },
    detectable_change_at_plan: 0.6,
  };
}

/** Five completed runs for one protocol; `present` of them mention the brand. */
function runs(protocolId: string, kind: "baseline" | "retest", present: number, opts: { dropHashOn?: number } = {}) {
  const attempts: Row[] = [];
  const results: Row[] = [];
  for (let i = 1; i <= 5; i += 1) {
    const pr = `${kind}-probe-${protocolId.slice(0, 4)}-${i}`;
    attempts.push({
      id: `${kind}-attempt-${protocolId.slice(0, 4)}-${i}`, protocol_id: protocolId, attempt_kind: kind,
      status: "completed", baseline_ordinal: i, probe_run_id: pr, retry_of_attempt_id: null,
      termination_reason: null, reserved_cost_usd: 0.01,
    });
    results.push({
      probe_run_id: pr, client_mentioned: i <= present, client_position: i <= present ? "#2" : null,
      competitors_mentioned: ["Vanta", "Drata"], sources_cited: [{ url: "https://x.example" }],
      answer_summary: `Run ${i} summary`,
      raw_response_sha256: opts.dropHashOn === i ? null : "d".repeat(64),
      raw_probe_request_sha256: "e".repeat(64), full_request_body_capture: "captured",
      provider_model: "sonar", provider_latency_ms: 900,
    });
  }
  return { attempts, results };
}

function world(opts: {
  ivStatus?: string;
  basePresent?: number;
  retestPresent?: number;
  retestDropHashOn?: number;
  withAbandonedRetest?: boolean;
  noLiveRetest?: boolean;
  retestWithoutMinimumUsefulChange?: boolean;
  oldBaselineWithoutPlanFields?: boolean;
  baselineWithDifferentPlanFields?: boolean;
} = {}) {
  const b = runs(BASE, "baseline", opts.basePresent ?? 1);
  const r = runs(RETEST, "retest", opts.retestPresent ?? 5, { dropHashOn: opts.retestDropHashOn });
  const baseline = protocolRow(BASE, null, "completed");
  // A baseline approved before these migrations carries neither column:
  // `minimum_useful_change` is stamped by 0073 onto the retest it creates,
  // and 0075 added `detectable_change_at_plan` without backfilling. This is
  // the shape of every audit older than M7, not an exotic case.
  if (opts.oldBaselineWithoutPlanFields) {
    baseline.minimum_useful_change = null;
    baseline.detectable_change_at_plan = null;
  }
  // Values that could only have come from the baseline row. The default
  // fixture gives both phases the same numbers, which is exactly why reading
  // the wrong row went unnoticed; these make the source observable.
  if (opts.baselineWithDifferentPlanFields) {
    baseline.minimum_useful_change = { value: 0.3, comparison_method: "newcombe_95", source: "baseline_row" };
    baseline.detectable_change_at_plan = 0.3;
  }
  const protocols: Row[] = [baseline];
  if (!opts.noLiveRetest) {
    const retest = protocolRow(RETEST, BASE, "completed");
    if (opts.retestWithoutMinimumUsefulChange) retest.minimum_useful_change = null;
    protocols.push(retest);
  }
  if (opts.withAbandonedRetest) protocols.push(protocolRow(OLD_RETEST, BASE, "abandoned"));
  return fakeDb({
    interventions: [{
      id: IV, project_id: PROJECT, status: opts.ivStatus ?? "implemented", protocol_id: BASE,
      hypothesis: "A comparison page gets us named", expected_mechanism: "Sonar cites comparison pages",
      action_type: "page_created", action_target: "https://x.example/compare", owner: "Marketing",
      approved_at: "2026-09-02T00:00:00Z", implemented_at: "2026-09-03T00:00:00Z", protocol_deviations: null,
      early_retest_reason: null, observation_window_opens_at: "2026-09-03T00:00:00Z",
      observation_window_closes_at: "2026-09-24T00:00:00Z",
    }],
    protocols,
    buyer_question_versions: [{
      id: BQV, prompt_text: "Which SOC 2 tool?", prompt_hash: HASH, version_number: 1, intent_type: "shortlist",
      provenance: "customer_supplied", approved_at: "2026-09-01T00:00:00Z",
    }],
    snapshot_requests: [{
      id: "req-1", company_name: "Fixture Co", website_url: "https://fixture.example",
      normalized_domain: "fixture.example", project_id: PROJECT, protocol_id: BASE, status: "report_ready",
      work_email: "buyer@fixture.example", created_at: "2026-09-01T00:00:00Z",
    }],
    protocol_attempts: [...b.attempts, ...r.attempts],
    probe_results: [...b.results, ...r.results],
  });
}

const CANONICAL = new Set(["increase_observed", "decrease_observed", "no_clear_change", "inconclusive"]);
const deps = (client: SupabaseClient) => ({
  client, autoSendEnabled: false, deliveryConfig: { apiKey: "", from: "", appBaseUrl: "" },
  now: () => new Date("2026-09-25T00:00:00Z"),
});

function saved(calls: Call[]) {
  return calls.find((c) => c.name === "save_outcome_card_artifact")?.args;
}

async function main(): Promise<void> {
  console.log("\nOutcome Card build (Phase 7)\n");

  /* ═══════════ 1. a complete, clean build ═══════════ */
  console.log("[1] A complete build");
  {
    const { client, calls } = world({ withAbandonedRetest: true });
    const r = await processOutcomeCard(IV, deps(client));
    const s = saved(calls);
    const payload = s?.p_payload as Record<string, any> | undefined;
    check("the card is built and saved", r.artifactId === "artifact-1" && s !== undefined, r.outcome);
    check("it compares against the LIVE retest, not the abandoned one on the same baseline",
      s?.p_retest_protocol_id === RETEST, String(s?.p_retest_protocol_id));
    check("the baseline it saves is the intervention's own", s?.p_baseline_protocol_id === BASE);
    check("both phases carry the same question", payload?.question?.text === "Which SOC 2 tool?");
    check("the outcome status is canonical",
      CANONICAL.has(String(payload?.comparison?.status)), String(payload?.comparison?.status));
    check("1/5 → 5/5 does not read as a decrease or as no change",
      payload?.comparison?.status !== "decrease_observed" && payload?.comparison?.status !== "no_clear_change",
      String(payload?.comparison?.status));
    check("the non-causality footer is in the payload", payload?.nonCausalityFooter === NON_CAUSALITY_FOOTER);
    check("and in the markdown, verbatim", String(s?.p_markdown ?? "").includes(NON_CAUSALITY_FOOTER));
    check("the saved integrity status is the one reported",
      s?.p_integrity_status === r.integrityStatus, `${String(s?.p_integrity_status)} vs ${r.integrityStatus}`);
    check("with auto-send off, nothing is claimed or sent",
      !calls.some((c) => c.name === "begin_outcome_card_delivery"));
    check("and the outcome says it was held, never delivered", r.outcome !== "delivered");
  }

  /* ═══════════ 2. the data moves the result ═══════════ */
  console.log("\n[2] The result follows the data");
  {
    const { client, calls } = world({ basePresent: 3, retestPresent: 3 });
    await processOutcomeCard(IV, deps(client));
    const status = String((saved(calls)?.p_payload as Record<string, any>)?.comparison?.status);
    check("equal rates are never an increase or a decrease",
      status === "no_clear_change" || status === "inconclusive", status);
  }
  {
    const { client, calls } = world({ basePresent: 5, retestPresent: 0 });
    await processOutcomeCard(IV, deps(client));
    const status = String((saved(calls)?.p_payload as Record<string, any>)?.comparison?.status);
    check("5/5 → 0/5 is never read as an increase", status !== "increase_observed", status);
  }

  /* ═══════════ 3. integrity reads BOTH phases ═══════════ */
  console.log("\n[3] Integrity reads both phases");
  {
    const clean = world();
    const cleanResult = await processOutcomeCard(IV, deps(clean.client));
    const weak = world({ retestDropHashOn: 3 });
    const weakResult = await processOutcomeCard(IV, deps(weak.client));
    check("a missing response hash in ONE retest run stops the card passing integrity",
      weakResult.integrityStatus !== "integrity_passed",
      `clean=${cleanResult.integrityStatus} weak=${weakResult.integrityStatus}`);
    check("and it says why", weakResult.integrityReasons.length > 0);
    check("the weak card is still saved for review, not discarded", saved(weak.calls) !== undefined);
  }

  /* ═══════════ 4. not ready: nothing saved ═══════════ */
  console.log("\n[4] Not ready means nothing saved");
  for (const [label, opts] of [
    ["an approved (not implemented) intervention", { ivStatus: "approved" }],
    ["an abandoned intervention", { ivStatus: "abandoned" }],
    ["a baseline with only an abandoned retest", { noLiveRetest: true, withAbandonedRetest: true }],
    ["a retest with no minimum useful change", { retestWithoutMinimumUsefulChange: true }],
  ] as const) {
    const { client, calls } = world(opts);
    const r = await processOutcomeCard(IV, deps(client));
    check(`${label}: not ready, blocked, nothing saved`,
      r.outcome === "intervention_not_ready" && r.integrityStatus === "blocked" && saved(calls) === undefined,
      r.outcome);
  }

  /* ═══════════ 5. the plan fields come from the RETEST protocol ═══════════ */
  console.log("\n[5] Delta_min and the planned threshold are read from the retest");
  {
    // The production shape that blocked intervention 79e21c3d: a baseline
    // predating 0073/0075 holds null in both columns while the retest it
    // spawned carries { value: 0.6 }. Reading the baseline blocked the card
    // for an audit whose evidence was complete and correct.
    const { client, calls } = world({ oldBaselineWithoutPlanFields: true });
    const r = await processOutcomeCard(IV, deps(client));
    const payload = saved(calls)?.p_payload as Record<string, any> | undefined;
    check("an older baseline with null plan fields no longer blocks the card",
      r.outcome !== "intervention_not_ready" && payload !== undefined, r.outcome);
    check("delta_min is the retest's 0.6, not the baseline's null",
      payload?.comparison?.minimumUsefulChange === 0.6, String(payload?.comparison?.minimumUsefulChange));
    check("the planned threshold is the retest's, not the baseline's null",
      payload?.detectableChangeAtPlan === 0.6, String(payload?.detectableChangeAtPlan));
  }
  {
    // Both rows populated but disagreeing. Only the retest's numbers may
    // appear; the default fixture gives the two phases identical values, so
    // without this the query could read either row and still pass.
    const { client, calls } = world({ baselineWithDifferentPlanFields: true });
    await processOutcomeCard(IV, deps(client));
    const payload = saved(calls)?.p_payload as Record<string, any> | undefined;
    check("with both rows set, delta_min is the retest's 0.6 and never the baseline's 0.3",
      payload?.comparison?.minimumUsefulChange === 0.6, String(payload?.comparison?.minimumUsefulChange));
    check("and the planned threshold is the retest's 0.6, never the baseline's 0.3",
      payload?.detectableChangeAtPlan === 0.6, String(payload?.detectableChangeAtPlan));
  }
  {
    // The card's visible power sentence is computed from the readable runs
    // (`smallestDetectableChange`), not from the stamped column — so it must
    // survive a baseline that carries nothing at all.
    const { client, calls } = world({ oldBaselineWithoutPlanFields: true });
    await processOutcomeCard(IV, deps(client));
    const markdown = String(saved(calls)?.p_markdown ?? "");
    check("the card still states the smallest change this sample could separate",
      /Smallest change this sample could have separated from zero: /.test(markdown));
    check("and still declares delta_min to the reader",
      /Minimum useful change \(\u0394_min\), declared before this retest ran: /.test(markdown));
  }

  console.log(`\n${passed}/${passed + failed} checks passed.${failed ? ` ${failed} FAILED.` : ""}\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
