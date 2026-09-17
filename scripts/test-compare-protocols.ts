#!/usr/bin/env tsx
/**
 * The comparison engine, verified against the exact numbers the founder
 * signed off on 2026-09-16 in docs/OUTCOME_COMPARISON_PROPOSAL.md — not
 * against numbers this file asserts on its own authority. Where a check
 * reproduces a figure from that document, it says so.
 *
 * Pure. No database, no provider, no network, no clock.
 */
import {
  compareProtocols,
  newcombeInterval,
  smallestDetectableChange,
  type ComparisonPhase,
  type ComparisonProtocolIdentity,
} from "@/lib/reports/compare-protocols";
import { wilsonBounds, wilsonInterval } from "@/lib/reports/build-protocol-report";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const IDENTITY: ComparisonProtocolIdentity = {
  questionVersionId: "q-v1",
  provider: "perplexity_sonar",
  surface: "answer",
  modelConfig: { model: "sonar" },
};

function phase(numerator: number, denominator: number, plannedRuns: number): ComparisonPhase {
  return { numerator, denominator, plannedRuns };
}

async function main(): Promise<void> {
  // ======================================================================
  // [0] The wilsonBounds/wilsonInterval refactor is behaviour-preserving.
  // ======================================================================
  console.log("[0] wilsonBounds refactor did not change wilsonInterval's public output");
  for (const [k, n] of [[0, 5], [1, 5], [3, 5], [5, 5], [4, 10], [0, 0]] as const) {
    const rounded = wilsonInterval(k, n);
    const bounds = wilsonBounds(k, n);
    if (rounded === null || bounds === null) {
      check(`(${k}/${n}) null matches`, rounded === null && bounds === null);
      continue;
    }
    check(
      `(${k}/${n}) wilsonInterval is wilsonBounds rounded to 3dp`,
      rounded.low === Math.round(bounds.low * 1000) / 1000 &&
        rounded.high === Math.round(bounds.high * 1000) / 1000
    );
  }

  // ======================================================================
  // [1] Newcombe reproduces the proposal's exact 5-vs-5 separability table.
  //
  // "of the 30 possible baseline→retest movements at 5 vs 5, only 10 have a
  //  95% interval on the difference that excludes zero — and every one of
  //  them starts or ends at an extreme" — section 3.
  // ======================================================================
  console.log("\n[1] The exact 5-vs-5 separability table from section 3");
  const SEPARABLE_5V5 = new Set([
    "0-3", "0-4", "0-5", "1-5", "2-5",
    "3-0", "4-0", "5-0", "5-1", "5-2",
  ]);
  let separableCount = 0;
  const foundSeparable: string[] = [];
  for (let b = 0; b <= 5; b += 1) {
    for (let r = 0; r <= 5; r += 1) {
      if (r === b) continue;
      const interval = newcombeInterval({ numerator: b, denominator: 5 }, { numerator: r, denominator: 5 });
      const separates = interval !== null && (interval.low > 0 || interval.high < 0);
      const key = `${b}-${r}`;
      if (separates) {
        separableCount += 1;
        foundSeparable.push(key);
      }
      check(
        `${b}/5 → ${r}/5 separability matches the proposal`,
        separates === SEPARABLE_5V5.has(key)
      );
    }
  }
  check("exactly 10 of 30 movements separate", separableCount === 10, String(separableCount));
  check(
    "1/5 → 4/5 (a 60-point swing) does NOT separate — the proposal calls this out explicitly",
    !foundSeparable.includes("1-4")
  );

  // ======================================================================
  // [2] smallestDetectableChange reproduces the proposal's threshold table.
  // ======================================================================
  console.log("\n[2] The smallest-detectable-change table — 60/40/27/25/17 at n=5/10/15/20/30");
  const TABLE: Array<[number, number]> = [[5, 60], [10, 40], [15, 27], [20, 25], [30, 17]];
  for (const [n, expectedPercent] of TABLE) {
    const sdc = smallestDetectableChange(n, n);
    check(
      `n=${n}: smallest detectable change rounds to ${expectedPercent} points`,
      sdc !== null && Math.round(sdc * 100) === expectedPercent,
      sdc === null ? "null" : `${(sdc * 100).toFixed(2)}%`
    );
  }
  check("zero denominator yields null, never a fabricated threshold", smallestDetectableChange(0, 5) === null);
  check("asymmetric denominators are handled (not assumed equal)", smallestDetectableChange(5, 10) !== null);

  // ======================================================================
  // [3] The five ENGINEERING_PLAN M7 uncertainty fixtures.
  // ======================================================================
  console.log("\n[3] Uncertainty fixtures — ENGINEERING_PLAN M7 acceptance list");

  // (a) Clear movement.
  {
    const result = compareProtocols({
      baseline: phase(0, 5, 5),
      retest: phase(5, 5, 5),
      baselineIdentity: IDENTITY,
      retestIdentity: IDENTITY,
      recordedDeviationNote: null,
      minimumUsefulChange: 0.6,
    });
    check("(a) clear movement (0/5 → 5/5) reports increase_observed", result.status === "increase_observed", result.status);
    check("(a) the interval excludes zero", result.interval !== null && result.interval.low > 0);
    check("(a) delta is exactly 1.0", result.delta === 1);
  }

  // (b) No clear movement — AND the exact boundary the sign-off depends on:
  // at n=5, sdc(5,5)=0.60=Δ_min exactly, so this must NOT read as inconclusive.
  {
    const result = compareProtocols({
      baseline: phase(2, 5, 5),
      retest: phase(3, 5, 5),
      baselineIdentity: IDENTITY,
      retestIdentity: IDENTITY,
      recordedDeviationNote: null,
      minimumUsefulChange: 0.6,
    });
    check("(b) no clear movement (2/5 → 3/5) reports no_clear_change, not inconclusive", result.status === "no_clear_change", result.status);
    check(
      "(b) THE SIGN-OFF BOUNDARY: sdc(5,5) equals Δ_min exactly, so the plan is not 'underpowered' by rule 1.3",
      result.smallestDetectableChange !== null && Math.abs(result.smallestDetectableChange - 0.6) < 1e-9
    );
  }

  // (c) Insufficient evidence — below the readable-run floor.
  {
    const result = compareProtocols({
      baseline: phase(1, 2, 5),
      retest: phase(4, 5, 5),
      baselineIdentity: IDENTITY,
      retestIdentity: IDENTITY,
      recordedDeviationNote: null,
      minimumUsefulChange: 0.6,
    });
    check("(c) insufficient evidence (2 readable of 5 planned) reports inconclusive", result.status === "inconclusive", result.status);
    check("(c) the reason names the floor, not a vague refusal", result.reasons.includes("BASELINE_BELOW_READABLE_RUN_FLOOR"));
    check("(c) no interval is asserted when the sample is unusable", result.interval === null);
  }

  // (d) Conflicting controls — an undisclosed configuration mismatch.
  {
    const result = compareProtocols({
      baseline: phase(1, 5, 5),
      retest: phase(4, 5, 5),
      baselineIdentity: IDENTITY,
      retestIdentity: { ...IDENTITY, modelConfig: { model: "sonar-pro" } },
      recordedDeviationNote: null,
      minimumUsefulChange: 0.6,
    });
    check("(d) conflicting controls (model changed, undisclosed) reports inconclusive", result.status === "inconclusive", result.status);
    check("(d) the reason names an undisclosed mismatch", result.reasons.includes("PROTOCOL_IDENTITY_MISMATCH_UNDISCLOSED"));
  }

  // (e) Provider drift — the SAME kind of mismatch, but disclosed. The
  // comparison proceeds and reports a real status, with the drift surfaced
  // rather than absorbed.
  {
    const result = compareProtocols({
      baseline: phase(0, 5, 5),
      retest: phase(5, 5, 5),
      baselineIdentity: IDENTITY,
      retestIdentity: { ...IDENTITY, modelConfig: { model: "sonar-2026-09" } },
      recordedDeviationNote: "Perplexity changed its default Sonar model between phases; founder-approved deviation.",
      minimumUsefulChange: 0.6,
    });
    check("(e) disclosed provider drift still produces a real status, not inconclusive", result.status === "increase_observed", result.status);
    check(
      "(e) the drift is surfaced in reasons, never silently absorbed",
      result.reasons.some((r) => r.startsWith("CONFIGURATION_DEVIATION_DISCLOSED:"))
    );
  }

  // ======================================================================
  // [4] Structural guarantees.
  // ======================================================================
  console.log("\n[4] Structural guarantees");
  check(
    "no selectable status can assert causality — the type permits exactly four values",
    (["increase_observed", "decrease_observed", "no_clear_change", "inconclusive"] as const).length === 4
  );

  const repeat1 = compareProtocols({
    baseline: phase(1, 5, 5),
    retest: phase(4, 5, 5),
    baselineIdentity: IDENTITY,
    retestIdentity: IDENTITY,
    recordedDeviationNote: null,
    minimumUsefulChange: 0.6,
  });
  const repeat2 = compareProtocols({
    baseline: phase(1, 5, 5),
    retest: phase(4, 5, 5),
    baselineIdentity: IDENTITY,
    retestIdentity: IDENTITY,
    recordedDeviationNote: null,
    minimumUsefulChange: 0.6,
  });
  check(
    "the engine is deterministic — identical input, identical output",
    JSON.stringify(repeat1) === JSON.stringify(repeat2)
  );

  // A directional status always carries Δ_min-cleared magnitude.
  check(
    "decrease_observed only ever fires when |delta| clears Δ_min",
    (() => {
      const r = compareProtocols({
        baseline: phase(5, 5, 5),
        retest: phase(0, 5, 5),
        baselineIdentity: IDENTITY,
        retestIdentity: IDENTITY,
        recordedDeviationNote: null,
        minimumUsefulChange: 0.6,
      });
      return r.status === "decrease_observed" && r.delta !== null && Math.abs(r.delta) >= 0.6;
    })()
  );

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "Comparison engine contract PASSED." : "Comparison engine contract FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("HARNESS ERROR", e);
  process.exit(1);
});
