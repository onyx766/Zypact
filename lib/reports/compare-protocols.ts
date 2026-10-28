/**
 * The baseline/retest comparison engine behind the Outcome Card.
 *
 * Implements docs/OUTCOME_COMPARISON_PROPOSAL.md as signed off by the founder
 * on 2026-09-16 — read that document for the reasoning; this file is the
 * arithmetic and the status rules, not the argument for them.
 *
 * Pure: no database, no provider, no clock. Every fact this needs — each
 * phase's numerator/denominator/plannedRuns, each phase's provider/surface/
 * model_config, and any recorded deviation note — is supplied by the caller,
 * who has the DB access this file deliberately does not.
 *
 * Two layers, per the proposal's section 2:
 *   1. Per phase: `wilsonBounds` (lib/reports/build-protocol-report.ts),
 *      unchanged and unrounded here to avoid compounding two roundings into
 *      a status decision.
 *   2. For the difference: Newcombe's hybrid-score interval (his method 10),
 *      built from the two Wilson bounds.
 */

import { wilsonBounds } from "@/lib/reports/build-protocol-report";

export type OutcomeStatus =
  | "increase_observed"
  | "decrease_observed"
  | "no_clear_change"
  | "inconclusive";

export interface ComparisonPhase {
  /** Readable runs in which the audited brand was observed. */
  numerator: number;
  /** Readable runs. The proposal's denominator — failed/excluded attempts are not readable and are never counted as absence. */
  denominator: number;
  /** The protocol's planned run count for this phase (planned_baseline_runs, per 0073 — the same column for both phases). */
  plannedRuns: number;
}

export interface ComparisonProtocolIdentity {
  questionVersionId: string;
  provider: string;
  surface: string;
  modelConfig: Record<string, unknown>;
}

export interface CompareProtocolsInput {
  baseline: ComparisonPhase;
  retest: ComparisonPhase;
  baselineIdentity: ComparisonProtocolIdentity;
  retestIdentity: ComparisonProtocolIdentity;
  /**
   * `interventions.protocol_deviations` for the intervention this retest is
   * registered against, if the caller has one. A non-empty note is what the
   * proposal calls a "recorded authorised deviation" — it does not make a
   * configuration mismatch disappear, it is the disclosure that makes
   * proceeding despite one honest rather than silent.
   */
  recordedDeviationNote: string | null;
  /**
   * Δ_min, the minimum useful change. No default: D-002 makes sampling (and
   * the threshold judged against it) a protocol parameter, never a magic
   * number baked into this engine. The founder-approved V1 value is 0.60 —
   * see OUTCOME_COMPARISON_PROPOSAL.md section 6.1 — and the caller supplies
   * it explicitly, read from wherever it was stamped on the retest protocol
   * (0073 stamps `minimum_useful_change.value` at creation).
   */
  minimumUsefulChange: number;
  /**
   * PR #3 — whether both phases were measured the same way, from the
   * execution evidence (lib/reports/measurement-fingerprint.ts). Anything
   * but `compatible` makes the result `inconclusive`, and a recorded
   * deviation does NOT override it: a disclosed change of protocol settings
   * is something a reader can weigh, but a different measuring instrument
   * makes the two numbers incomparable. Optional only so this pure engine
   * stays usable on its own; the Outcome Card always supplies it.
   */
  measurementCompatibility?: { status: "compatible" | "incompatible" | "unverifiable"; detail?: string };
}

export interface NewcombeInterval {
  low: number;
  high: number;
}

export interface CompareProtocolsResult {
  status: OutcomeStatus;
  /** retest.rate - baseline.rate. Null when a phase has zero readable runs. */
  delta: number | null;
  interval: NewcombeInterval | null;
  intervalMethod: "newcombe_95";
  minimumUsefulChange: number;
  /**
   * The smallest |delta| this plan could have separated from zero, given
   * each phase's ACTUAL denominator (not its plan) — computed even when the
   * status is not `inconclusive`, so a report can always state what the test
   * was capable of seeing.
   */
  smallestDetectableChange: number | null;
  /** Machine-readable reason codes. Never empty for `inconclusive`. */
  reasons: string[];
}

/** Readable-run floor — OUTCOME_COMPARISON_PROPOSAL.md section 6.2, founder-approved. */
const MIN_READABLE_RUNS = 3;
const MIN_READABLE_FRACTION_OF_PLAN = 0.6;

function phaseMeetsFloor(phase: ComparisonPhase): boolean {
  return (
    phase.denominator >= MIN_READABLE_RUNS &&
    phase.denominator >= MIN_READABLE_FRACTION_OF_PLAN * phase.plannedRuns
  );
}

/** Recursively sorts object keys so two structurally-equal configs compare equal regardless of insertion order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function identityMatches(
  a: ComparisonProtocolIdentity,
  b: ComparisonProtocolIdentity
): boolean {
  return (
    a.questionVersionId === b.questionVersionId &&
    a.provider === b.provider &&
    a.surface === b.surface &&
    canonicalJson(a.modelConfig) === canonicalJson(b.modelConfig)
  );
}

/**
 * Newcombe's hybrid-score 95% interval (his method 10) for `p2 - p1`, built
 * from the two phases' Wilson bounds. Returns null when either phase has
 * zero readable runs — there is no interval to build on nothing.
 */
export function newcombeInterval(
  phase1: { numerator: number; denominator: number },
  phase2: { numerator: number; denominator: number }
): NewcombeInterval | null {
  if (phase1.denominator <= 0 || phase2.denominator <= 0) return null;

  const w1 = wilsonBounds(phase1.numerator, phase1.denominator);
  const w2 = wilsonBounds(phase2.numerator, phase2.denominator);
  if (w1 === null || w2 === null) return null;

  const p1 = phase1.numerator / phase1.denominator;
  const p2 = phase2.numerator / phase2.denominator;
  const delta = p2 - p1;

  const low = delta - Math.sqrt((p2 - w2.low) ** 2 + (w1.high - p1) ** 2);
  const high = delta + Math.sqrt((w2.high - p2) ** 2 + (p1 - w1.low) ** 2);

  return {
    low: Math.max(-1, low),
    high: Math.min(1, high),
  };
}

/**
 * The smallest |delta| separable from zero at these two phases' ACTUAL
 * denominators — i.e. "what this specific retest, with the readable runs it
 * actually got, was capable of seeing." Exhaustively searches every
 * achievable (k1, k2) outcome pair, because there is no closed form for a
 * Newcombe interval's zero-crossing boundary.
 *
 * O(n1 * n2). V1 denominators are single-digit to low tens, so this is a
 * trivial search — never memoized, never approximated.
 */
export function smallestDetectableChange(
  denominator1: number,
  denominator2: number
): number | null {
  if (denominator1 <= 0 || denominator2 <= 0) return null;

  let best: number | null = null;
  for (let k1 = 0; k1 <= denominator1; k1 += 1) {
    for (let k2 = 0; k2 <= denominator2; k2 += 1) {
      const interval = newcombeInterval(
        { numerator: k1, denominator: denominator1 },
        { numerator: k2, denominator: denominator2 }
      );
      if (interval === null) continue;
      if (interval.low > 0 || interval.high < 0) {
        const magnitude = Math.abs(k2 / denominator2 - k1 / denominator1);
        if (best === null || magnitude < best) best = magnitude;
      }
    }
  }
  return best;
}

/**
 * Evaluates a baseline/retest pair into exactly one of the four approved
 * outcome statuses, per OUTCOME_COMPARISON_PROPOSAL.md section 4.
 *
 * Rule order matters and is deliberate: every inconclusive condition is
 * checked before either directional status is considered, because a status
 * that later turns out to rest on an incomparable or underpowered pair is
 * worse than no status at all.
 */
export function compareProtocols(input: CompareProtocolsInput): CompareProtocolsResult {
  const { baseline, retest, baselineIdentity, retestIdentity, recordedDeviationNote, minimumUsefulChange } = input;
  const reasons: string[] = [];

  const hasDeviation =
    recordedDeviationNote !== null && recordedDeviationNote.trim() !== "";
  if (!identityMatches(baselineIdentity, retestIdentity)) {
    if (!hasDeviation) {
      return {
        status: "inconclusive",
        delta: null,
        interval: null,
        intervalMethod: "newcombe_95",
        minimumUsefulChange,
        smallestDetectableChange: null,
        reasons: ["PROTOCOL_IDENTITY_MISMATCH_UNDISCLOSED"],
      };
    }
    // Disclosed, so the comparison proceeds — but the deviation is surfaced,
    // never silently absorbed into a clean-looking number.
    reasons.push(`CONFIGURATION_DEVIATION_DISCLOSED: ${recordedDeviationNote}`);
  }

  const measurement = input.measurementCompatibility;
  if (measurement && measurement.status !== "compatible") {
    return {
      status: "inconclusive",
      delta: null,
      interval: null,
      intervalMethod: "newcombe_95",
      minimumUsefulChange,
      smallestDetectableChange: null,
      reasons: [
        ...reasons,
        `MEASUREMENT_${measurement.status.toUpperCase()}${measurement.detail ? `: ${measurement.detail}` : ""}`,
      ],
    };
  }

  const baselineUnderpowered = !phaseMeetsFloor(baseline);
  const retestUnderpowered = !phaseMeetsFloor(retest);
  if (baselineUnderpowered || retestUnderpowered) {
    const floorReasons: string[] = [];
    if (baselineUnderpowered) floorReasons.push("BASELINE_BELOW_READABLE_RUN_FLOOR");
    if (retestUnderpowered) floorReasons.push("RETEST_BELOW_READABLE_RUN_FLOOR");
    return {
      status: "inconclusive",
      delta: null,
      interval: null,
      intervalMethod: "newcombe_95",
      minimumUsefulChange,
      smallestDetectableChange: null,
      reasons: [...reasons, ...floorReasons],
    };
  }

  const delta = retest.numerator / retest.denominator - baseline.numerator / baseline.denominator;
  const interval = newcombeInterval(baseline, retest);
  const sdc = smallestDetectableChange(baseline.denominator, retest.denominator);

  if (interval === null || sdc === null) {
    // Unreachable given the floor check above (both denominators are >= 3
    // there), kept because this function's return type promises an honest
    // state rather than a thrown error for any input shape.
    return {
      status: "inconclusive",
      delta,
      interval: null,
      intervalMethod: "newcombe_95",
      minimumUsefulChange,
      smallestDetectableChange: null,
      reasons: [...reasons, "INTERVAL_COULD_NOT_BE_COMPUTED"],
    };
  }

  // The clause that separates "no_clear_change" from "inconclusive": a plan
  // that could never have seen Δ_min either way has told the client nothing,
  // and must not be allowed to read as "no clear change" — see the
  // proposal's section 4 commentary on why this is the whole point of the
  // inconclusive status.
  if (sdc > minimumUsefulChange && interval.low <= 0 && interval.high >= 0) {
    return {
      status: "inconclusive",
      delta,
      interval,
      intervalMethod: "newcombe_95",
      minimumUsefulChange,
      smallestDetectableChange: sdc,
      reasons: [...reasons, "PLAN_UNDERPOWERED_FOR_MINIMUM_USEFUL_CHANGE"],
    };
  }

  if (interval.low > 0 && delta >= minimumUsefulChange) {
    return {
      status: "increase_observed",
      delta,
      interval,
      intervalMethod: "newcombe_95",
      minimumUsefulChange,
      smallestDetectableChange: sdc,
      reasons,
    };
  }

  if (interval.high < 0 && Math.abs(delta) >= minimumUsefulChange) {
    return {
      status: "decrease_observed",
      delta,
      interval,
      intervalMethod: "newcombe_95",
      minimumUsefulChange,
      smallestDetectableChange: sdc,
      reasons,
    };
  }

  return {
    status: "no_clear_change",
    delta,
    interval,
    intervalMethod: "newcombe_95",
    minimumUsefulChange,
    smallestDetectableChange: sdc,
    reasons,
  };
}
