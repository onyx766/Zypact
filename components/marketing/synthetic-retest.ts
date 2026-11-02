import { wilsonBounds } from "@/lib/reports/build-protocol-report";
import {
  compareProtocols,
  type CompareProtocolsResult,
  type ComparisonProtocolIdentity,
  type OutcomeStatus,
} from "@/lib/reports/compare-protocols";
import type { ProtocolReportInterval } from "@/lib/reports/protocol-report-types";

/**
 * The one synthetic retest behind every illustrative number on the landing
 * page — the hero preview (evidence-dashboard.tsx) and the evidence panels
 * (answer-evidence.tsx).
 *
 * Only the counts are typed in. The intervals, the difference and the status
 * are computed by the same engine that builds real Outcome Cards, at the
 * founder-approved V1 minimum useful change, so the example cannot claim a
 * status the method would not return for these counts. It previously showed
 * 2 → 7 of 15 as `increase_observed`; the engine classifies that pair
 * `no_clear_change` (Δ 0.33 is below Δ_min 0.60), as it does the 32% → 56%
 * in the design mock. scripts/test-landing-page.ts re-checks this.
 *
 * Every value here is illustrative: not customer data, not a live probe.
 */

export const SYNTHETIC_QUESTION = "Which ERP fits a mid-market manufacturer?";

/** Preserved runs per phase. Equal phases, as the 0.27 figure below assumes. */
export const SYNTHETIC_RUNS = 15;
export const SYNTHETIC_BASELINE_NAMED = 2;
export const SYNTHETIC_RETEST_NAMED = 12;

/** Δ_min for every V1 protocol (OUTCOME_COMPARISON_PROPOSAL.md §6.1). */
export const V1_MINIMUM_USEFUL_CHANGE = 0.6;

/**
 * Smallest change detectable at 15 preserved runs per phase, from the
 * signed-off detectable-change table verified against the deployed
 * `_smallest_detectable_change` (CURRENT_STATUS.md §16).
 */
export const DETECTABLE_CHANGE_AT_15 = "0.27";

const SYNTHETIC_IDENTITY: ComparisonProtocolIdentity = {
  questionVersionId: "synthetic-example",
  provider: "perplexity",
  surface: "sonar",
  modelConfig: {},
};

export const syntheticComparison: CompareProtocolsResult = compareProtocols({
  baseline: {
    numerator: SYNTHETIC_BASELINE_NAMED,
    denominator: SYNTHETIC_RUNS,
    plannedRuns: SYNTHETIC_RUNS,
  },
  retest: {
    numerator: SYNTHETIC_RETEST_NAMED,
    denominator: SYNTHETIC_RUNS,
    plannedRuns: SYNTHETIC_RUNS,
  },
  baselineIdentity: SYNTHETIC_IDENTITY,
  retestIdentity: SYNTHETIC_IDENTITY,
  recordedDeviationNote: null,
  minimumUsefulChange: V1_MINIMUM_USEFUL_CHANGE,
  measurementCompatibility: { status: "compatible" },
});

const fallbackInterval: ProtocolReportInterval = { low: 0, high: 1 };

/** Per-phase 95% Wilson intervals, as the real report computes them. */
export const syntheticBaselineInterval: ProtocolReportInterval =
  wilsonBounds(SYNTHETIC_BASELINE_NAMED, SYNTHETIC_RUNS) ?? fallbackInterval;
export const syntheticRetestInterval: ProtocolReportInterval =
  wilsonBounds(SYNTHETIC_RETEST_NAMED, SYNTHETIC_RUNS) ?? fallbackInterval;

export const syntheticBaselineRate = SYNTHETIC_BASELINE_NAMED / SYNTHETIC_RUNS;
export const syntheticRetestRate = SYNTHETIC_RETEST_NAMED / SYNTHETIC_RUNS;

/** Attempt reconciliation for the synthetic retest phase. */
export const syntheticAttempts = [
  { label: "Preserved", value: SYNTHETIC_RUNS },
  { label: "Retried", value: 1 },
  { label: "Excluded", value: 1 },
] as const;

export const OUTCOME_STATUS_LABEL: Record<OutcomeStatus, string> = {
  increase_observed: "Increase observed",
  decrease_observed: "Decrease observed",
  no_clear_change: "No clear change",
  inconclusive: "Inconclusive",
};

/** 0.1333 → "13%". */
export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Wilson interval → "4%–38%". */
export function percentRange(interval: ProtocolReportInterval): string {
  return `${Math.round(interval.low * 100)}%–${Math.round(interval.high * 100)}%`;
}

/**
 * A signed difference in percentage points, 0.6667 → "+67"; callers add the
 * word "points".
 *
 * Points, never "+N%": a bare signed percentage reads as a lift badge, and the
 * landing guard rejects that pattern anywhere in the page.
 */
export function signedPoints(value: number): string {
  const points = Math.round(value * 100);
  return `${points > 0 ? "+" : points < 0 ? "−" : ""}${Math.abs(points)}`;
}
