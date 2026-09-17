/**
 * Builds the canonical Outcome Card from a baseline report, a retest
 * report, and the registered intervention behind them.
 *
 * Pure: no database, no provider, no clock except the injectable `now`.
 * Both `ProtocolReportPayload`s are built by the existing
 * `buildProtocolReport` — a retest protocol is just another `protocols` row
 * with its own attempts, so nothing about that builder needed to change for
 * this to work; see read-protocol-evidence.ts, which selects on
 * `attempt_kind` without ever filtering to `'baseline'`.
 *
 * Deliberately not built here: reading intervention/evidence rows from the
 * database (the caller's job, exactly as `deliver-protocol-report.ts` reads
 * integrity signals AFTER `buildProtocolReport` runs, not inside it), and
 * integrity evaluation for delivery gating — that is a delivery-layer
 * concern in this codebase (`evaluateReportIntegrity` +
 * `readIntegritySignals`, run per phase) and stays one, rather than this
 * file inventing a second integrity concept beside it.
 */

import {
  compareProtocols,
  type ComparisonProtocolIdentity,
} from "@/lib/reports/compare-protocols";
import type { ProtocolReportPayload } from "@/lib/reports/protocol-report-types";
import {
  NON_CAUSALITY_FOOTER,
  OUTCOME_CARD_VERSION,
  type OutcomeCardIntervention,
  type OutcomeCardPayload,
  type OutcomeCardPhase,
} from "@/lib/reports/outcome-card-types";

export interface BuildOutcomeCardInput {
  projectId: string;
  baseline: ProtocolReportPayload;
  retest: ProtocolReportPayload;
  intervention: OutcomeCardIntervention;
  /**
   * Δ_min. No default — D-002 makes this a protocol parameter, and 0073
   * stamps the founder-approved V1 value (0.60) onto the retest protocol's
   * own row at creation; the caller reads it from there.
   */
  minimumUsefulChange: number;
  /**
   * 0075's `protocols.detectable_change_at_plan` from the BASELINE row.
   * Informational only. Null for a baseline approved before 0075 existed.
   */
  detectableChangeAtPlan?: number | null;
  now?: Date;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function phaseOf(report: ProtocolReportPayload): OutcomeCardPhase {
  return {
    protocolId: report.protocol.id,
    numerator: report.observation.numerator,
    denominator: report.observation.denominator,
    plannedRuns: report.protocol.plannedBaselineRuns,
    rate: report.observation.rate,
    interval: report.observation.interval,
  };
}

/**
 * `compareProtocols` wants a full `modelConfig` object; the report payload
 * only carries the already-flattened `model` string (build-protocol-
 * report.ts never receives the raw jsonb column). Wrapping it as a
 * single-key object is enough to catch exactly the case the proposal
 * describes — "sonar" vs "sonar-pro" — without widening
 * `ProtocolReportProtocol` for a comparison this is the only caller of.
 */
function identityOf(report: ProtocolReportPayload): ComparisonProtocolIdentity {
  return {
    questionVersionId: report.question.hash,
    provider: report.protocol.provider,
    surface: report.protocol.surface,
    modelConfig: { model: report.protocol.model },
  };
}

function buildUncertainty(
  card: Pick<OutcomeCardPayload, "baseline" | "retest" | "comparison">
): string[] {
  const notes: string[] = [];
  const { comparison, baseline, retest } = card;

  notes.push(
    `Baseline: ${baseline.numerator} of ${baseline.denominator} readable runs (${baseline.plannedRuns} planned). ` +
      `Retest: ${retest.numerator} of ${retest.denominator} readable runs (${retest.plannedRuns} planned).`
  );

  if (comparison.smallestDetectableChange !== null) {
    notes.push(
      `At this sample size, a change smaller than ${formatPercent(
        comparison.smallestDetectableChange
      )} could not have been distinguished from noise either way.`
    );
  }

  switch (comparison.status) {
    case "increase_observed":
      notes.push(
        `An increase was observed: ${formatPercent(
          comparison.delta ?? 0
        )}, with a 95% interval that stays above zero. This describes what the surface answered under the recorded conditions — see the permanent note below.`
      );
      break;
    case "decrease_observed":
      notes.push(
        `A decrease was observed: ${formatPercent(
          comparison.delta ?? 0
        )}, with a 95% interval that stays below zero. This describes what the surface answered under the recorded conditions — see the permanent note below.`
      );
      break;
    case "no_clear_change":
      notes.push(
        `No change of at least ${formatPercent(
          comparison.minimumUsefulChange
        )} was distinguishable from noise. A change of that size would have been visible at this sample size; a smaller real change may still exist and would not be visible here.`
      );
      break;
    case "inconclusive":
      notes.push(
        "This retest cannot support any of the three other outcomes. " +
          (comparison.reasons.includes("PLAN_UNDERPOWERED_FOR_MINIMUM_USEFUL_CHANGE")
            ? "The plan could not have detected the declared minimum useful change even in the best case — this is a limit of the sample size, not evidence that nothing changed."
            : "See the reasons recorded with this comparison for why.")
      );
      break;
  }

  if (comparison.reasons.length > 0) {
    notes.push(`Recorded reasons: ${comparison.reasons.join("; ")}.`);
  }

  return notes;
}

function buildLimitations(
  baseline: ProtocolReportPayload,
  intervention: OutcomeCardIntervention
): string[] {
  const notes = [
    `Single surface: ${baseline.protocol.provider} (${baseline.protocol.surface}), model ${baseline.protocol.model}. Directional proxy for AI answer behavior, not a measure of all AI buyers.`,
    "Prompt-scoped: describes this question only and does not generalize to other buyer questions.",
    "Observational: this records what the surface answered before and after the intervention. It does not establish that any answer caused a sale to be won or lost.",
  ];

  if (intervention.protocolDeviations) {
    notes.push(`Recorded deviation: ${intervention.protocolDeviations}`);
  }
  if (intervention.earlyRetestReason) {
    notes.push(
      `The retest ran before the observation window closed, under a recorded authorised deviation: ${intervention.earlyRetestReason}`
    );
  }

  return notes;
}

export function buildOutcomeCard(input: BuildOutcomeCardInput): OutcomeCardPayload {
  const now = input.now ?? new Date();

  const baselinePhase = phaseOf(input.baseline);
  const retestPhase = phaseOf(input.retest);

  const comparison = compareProtocols({
    baseline: {
      numerator: baselinePhase.numerator,
      denominator: baselinePhase.denominator,
      plannedRuns: baselinePhase.plannedRuns,
    },
    retest: {
      numerator: retestPhase.numerator,
      denominator: retestPhase.denominator,
      plannedRuns: retestPhase.plannedRuns,
    },
    baselineIdentity: identityOf(input.baseline),
    retestIdentity: identityOf(input.retest),
    recordedDeviationNote: input.intervention.protocolDeviations,
    minimumUsefulChange: input.minimumUsefulChange,
  });

  const card: OutcomeCardPayload = {
    reportVersion: OUTCOME_CARD_VERSION,
    generatedAt: now.toISOString(),
    projectId: input.projectId,
    subject: input.baseline.subject,
    // The SAME question row on both phases is a 0073 guarantee, not an
    // assumption made here — compareProtocols's identity check would have
    // reported PROTOCOL_IDENTITY_MISMATCH_UNDISCLOSED already if it were not.
    question: input.baseline.question,
    baseline: baselinePhase,
    retest: retestPhase,
    intervention: input.intervention,
    comparison,
    detectableChangeAtPlan: input.detectableChangeAtPlan ?? null,
    uncertainty: [],
    limitations: [],
    nonCausalityFooter: NON_CAUSALITY_FOOTER,
  };

  card.uncertainty = buildUncertainty(card);
  card.limitations = buildLimitations(input.baseline, input.intervention);

  return card;
}
