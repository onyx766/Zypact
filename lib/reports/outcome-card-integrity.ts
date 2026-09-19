/**
 * Combines two phases' integrity evaluations into ONE decision for an
 * Outcome Card.
 *
 * Deliberately does not invent a second integrity concept: each phase is
 * evaluated by the exact same `evaluateReportIntegrity` +
 * `ProtocolIntegritySignals` machinery `deliver-protocol-report.ts` already
 * uses for a single baseline report. This file's only job is combining two
 * of those results — "blocked always wins over needs_review" (the existing
 * precedent inside `evaluateReportIntegrity` itself, extended across
 * phases) — and adding the one check that has no single-phase equivalent:
 * the intervention behind the retest must itself be registered end to end.
 *
 * Pure. No database — the caller reads both phases' markdown and signals
 * exactly as `deliver-protocol-report.ts` already does per phase.
 */

import {
  evaluateReportIntegrity,
  type ReportIntegrityResult,
  type ReportIntegrityStatus,
} from "@/lib/export/report-integrity";
import type { ProtocolIntegritySignals } from "@/lib/reports/protocol-integrity-signals";

export interface EvaluateOutcomeCardIntegrityInput {
  baselineMarkdown: string;
  baselineSignals: ProtocolIntegritySignals;
  retestMarkdown: string;
  retestSignals: ProtocolIntegritySignals;
  /**
   * True iff the intervention this retest is registered against is itself
   * `approved` and `implemented`. Structurally guaranteed for any retest
   * protocol that could exist at all — 0072/0073 refuse to create one
   * otherwise — so this should never be false for a real caller. Checked
   * anyway rather than trusted: a caller bug here would present a card for
   * an intervention nobody actually registered, which is presenting false
   * context as true, the same class of failure `blocked` already exists
   * for.
   */
  interventionRegisteredAndImplemented: boolean;
}

/** blocked > needs_review > integrity_passed. */
const RANK: Record<ReportIntegrityStatus, number> = {
  blocked: 2,
  needs_review: 1,
  integrity_passed: 0,
};

function worseOf(a: ReportIntegrityStatus, b: ReportIntegrityStatus): ReportIntegrityStatus {
  return RANK[b] > RANK[a] ? b : a;
}

export function evaluateOutcomeCardIntegrity(
  input: EvaluateOutcomeCardIntegrityInput
): ReportIntegrityResult {
  const baseline = evaluateReportIntegrity({
    markdown: input.baselineMarkdown,
    ...input.baselineSignals,
  });
  const retest = evaluateReportIntegrity({
    markdown: input.retestMarkdown,
    ...input.retestSignals,
  });

  const reasons: string[] = [
    ...baseline.reasons.map((r) => `Baseline: ${r}`),
    ...retest.reasons.map((r) => `Retest: ${r}`),
  ];

  let status = worseOf(baseline.status, retest.status);

  if (!input.interventionRegisteredAndImplemented) {
    status = worseOf(status, "blocked");
    reasons.push(
      "Intervention: not confirmed approved and implemented. An Outcome Card must not be produced for an intervention that was never registered end to end."
    );
  }

  if (status === "integrity_passed") return { status, reasons: [] };
  return { status, reasons };
}
