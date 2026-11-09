/**
 * The canonical Outcome Card payload — V1_SCOPE.md 4.12/4.14, D-005/D-006/
 * D-007. Produced once from a baseline report, a retest report, and the
 * registered intervention, and read back verbatim by every renderer — no
 * re-derivation at render time, mirroring protocol-report-types.ts's own
 * "one canonical snapshot" discipline.
 *
 * Deliberately absent: any field that could carry a causal claim. The four
 * statuses in `OutcomeCardComparison` are the only vocabulary this payload
 * has for describing what happened, and `NON_CAUSALITY_FOOTER` is not a
 * payload field a caller supplies — it is a literal this module exports and
 * the builder stamps unconditionally, so nothing upstream can omit or
 * reword it. The renderer (render-outcome-card-markdown.ts) hard-codes the
 * same literal a second time rather than trusting the payload field alone —
 * belt and suspenders for the one sentence this product cannot ship without.
 */

import type {
  ProtocolReportInterval,
  ProtocolReportQuestion,
  ProtocolReportReconciliation,
  ProtocolReportSubject,
} from "@/lib/reports/protocol-report-types";
import type { OutcomeStatus } from "@/lib/reports/compare-protocols";
import type { OutcomeCardSourceComparison } from "@/lib/source-insights/build-source-insights";

export const OUTCOME_CARD_VERSION = 1 as const;

/**
 * D-006's exact wording. Permanent, unconditional, present on every Outcome
 * Card regardless of status — including `increase_observed`, where the
 * temptation to drop it is strongest.
 */
export const NON_CAUSALITY_FOOTER =
  "This Outcome Card documents an observed change under the recorded conditions. It does not establish that the intervention caused the change.";

export interface OutcomeCardIntervention {
  hypothesis: string;
  expectedMechanism: string;
  actionType: string;
  actionTarget: string;
  owner: string;
  approvedAt: string | null;
  implementedAt: string | null;
  /** interventions.protocol_deviations — confounders and deviations, surfaced verbatim, never summarized away. */
  protocolDeviations: string | null;
  /**
   * Non-null iff the retest ran before the observation window closed, under
   * a recorded 0072 deviation. Its presence alone is disclosure enough; the
   * card does not editorialize about whether the deviation was wise.
   */
  earlyRetestReason: string | null;
  observationWindowOpensAt: string | null;
  observationWindowClosesAt: string | null;
}

/** One phase's evidence summary — baseline or retest, same shape either way. */
export interface OutcomeCardPhase {
  protocolId: string;
  /** Readable runs where the audited brand was observed. */
  numerator: number;
  /** Readable runs. Failed/excluded attempts are not readable and are never counted as absence. */
  denominator: number;
  plannedRuns: number;
  rate: number | null;
  interval: ProtocolReportInterval | null;
  /**
   * Every attempt the phase reserved, readable or not. Optional only because
   * cards saved before this field existed do not carry it; the view then says
   * so rather than implying nothing failed.
   */
  reconciliation?: ProtocolReportReconciliation;
}

export interface OutcomeCardComparison {
  status: OutcomeStatus;
  delta: number | null;
  interval: { low: number; high: number } | null;
  intervalMethod: "newcombe_95";
  minimumUsefulChange: number;
  smallestDetectableChange: number | null;
  reasons: string[];
}

export interface OutcomeCardPayload {
  reportVersion: typeof OUTCOME_CARD_VERSION;
  generatedAt: string;
  projectId: string;

  subject: ProtocolReportSubject;
  /** The one question both phases share — 0073 guarantees the same version row, never a copy. */
  question: ProtocolReportQuestion;

  baseline: OutcomeCardPhase;
  retest: OutcomeCardPhase;
  intervention: OutcomeCardIntervention;
  comparison: OutcomeCardComparison;

  /**
   * The threshold disclosed at approval time (0075's
   * `protocols.detectable_change_at_plan`), before any evidence existed.
   * Purely informational — never an input to `comparison`, which is always
   * computed from the ACTUAL readable runs. Read from the RETEST protocol,
   * which 0073 approves through `approve_protocol` and so always carries it;
   * a baseline approved before 0075 existed holds null, because that
   * migration did not backfill. Still null if the retest itself predates it.
   */
  detectableChangeAtPlan: number | null;

  /**
   * Cited sources in each phase, descriptive only. Absent on cards saved
   * before it existed; null when either phase had no source section.
   */
  sourceComparison?: OutcomeCardSourceComparison | null;

  uncertainty: string[];
  limitations: string[];

  /** Always NON_CAUSALITY_FOOTER. Not settable by a builder caller. */
  nonCausalityFooter: typeof NON_CAUSALITY_FOOTER;
}

/**
 * Narrows a stored payload before it is rendered — mirrors
 * `isProtocolReportPayload`'s reasoning exactly: the column is jsonb, so an
 * older build's row or a hand-edited one can arrive here, and the page must
 * fall back rather than throw.
 */
export function isOutcomeCardPayload(
  value: unknown
): value is OutcomeCardPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  if (candidate.reportVersion !== OUTCOME_CARD_VERSION) return false;
  if (candidate.nonCausalityFooter !== NON_CAUSALITY_FOOTER) return false;

  for (const key of ["subject", "question", "baseline", "retest", "intervention", "comparison"]) {
    const nested = candidate[key];
    if (typeof nested !== "object" || nested === null) return false;
  }

  return (
    Array.isArray(candidate.uncertainty) &&
    Array.isArray(candidate.limitations)
  );
}
