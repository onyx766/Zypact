/**
 * Synthetic Outcome Card payloads for the view contract test. No customer,
 * prospect or provider data: the company, question and hash are invented.
 */
import {
  NON_CAUSALITY_FOOTER,
  OUTCOME_CARD_VERSION,
  type OutcomeCardPayload,
} from "@/lib/reports/outcome-card-types";

export const FIXTURE_HASH =
  "8c3645b66754672142f1b0a9d3e7c5a13242b927918fc36d1f1b3064bcd13de7";

type Overrides = {
  baseline?: Partial<OutcomeCardPayload["baseline"]>;
  retest?: Partial<OutcomeCardPayload["retest"]>;
  intervention?: Partial<OutcomeCardPayload["intervention"]>;
  comparison?: Partial<OutcomeCardPayload["comparison"]>;
  detectableChangeAtPlan?: number | null;
  uncertainty?: string[];
  limitations?: string[];
};

export function outcomeCardFixture(overrides: Overrides = {}): OutcomeCardPayload {
  return {
    reportVersion: OUTCOME_CARD_VERSION,
    generatedAt: "2026-01-20T10:15:00.000Z",
    projectId: "00000000-0000-4000-8000-000000000001",
    subject: {
      companyName: "Example Co",
      websiteUrl: "https://www.example.com",
      normalizedDomain: "example.com",
    },
    question: {
      text: "Which tools help a B2B SaaS team compare onboarding analytics vendors?",
      hash: FIXTURE_HASH,
      versionNumber: 1,
      intentType: "shortlist",
      provenance: "customer_supplied",
      approvedAt: "2026-01-02T09:00:00.000Z",
    },
    baseline: {
      protocolId: "00000000-0000-4000-8000-00000000000b",
      numerator: 0,
      denominator: 5,
      plannedRuns: 5,
      rate: 0,
      interval: { low: 0, high: 0.434 },
      ...overrides.baseline,
    },
    retest: {
      protocolId: "00000000-0000-4000-8000-00000000000c",
      numerator: 0,
      denominator: 5,
      plannedRuns: 5,
      rate: 0,
      interval: { low: 0, high: 0.434 },
      ...overrides.retest,
    },
    intervention: {
      hypothesis:
        "If Example Co publishes a first-party comparison page, it may be named in answers to this buyer question.",
      expectedMechanism:
        "The new page gives the surface a directly relevant first-party source that matches the buyer intent.",
      actionType: "page_created",
      actionTarget: "https://www.example.com/compare-onboarding-analytics",
      owner: "A. Founder",
      approvedAt: "2026-01-03T16:21:00.000Z",
      implementedAt: "2026-01-03T20:46:00+00:00",
      protocolDeviations: null,
      earlyRetestReason: null,
      observationWindowOpensAt: "2026-01-03T20:46:00+00:00",
      observationWindowClosesAt: "2026-01-18T20:46:00+00:00",
      ...overrides.intervention,
    },
    comparison: {
      status: "no_clear_change",
      delta: 0,
      interval: { low: -0.434, high: 0.434 },
      intervalMethod: "newcombe_95",
      minimumUsefulChange: 0.6,
      smallestDetectableChange: 0.6,
      reasons: [],
      ...overrides.comparison,
    },
    detectableChangeAtPlan:
      overrides.detectableChangeAtPlan === undefined ? 0.6 : overrides.detectableChangeAtPlan,
    uncertainty: overrides.uncertainty ?? [
      "Baseline: 0 of 5 readable runs (5 planned). Retest: 0 of 5 readable runs (5 planned).",
      "At this sample size, a change smaller than 60% could not have been distinguished from noise either way.",
    ],
    limitations: overrides.limitations ?? [
      "Single surface: perplexity_sonar (answer), model sonar. Directional proxy for AI answer behavior, not a measure of all AI buyers.",
      "Prompt-scoped: describes this question only and does not generalize to other buyer questions.",
    ],
    nonCausalityFooter: NON_CAUSALITY_FOOTER,
  };
}

/** One payload per outcome status, plus the two shapes the layout must survive. */
export const OUTCOME_CARD_FIXTURES: Record<string, OutcomeCardPayload> = {
  no_clear_change: outcomeCardFixture(),
  increase_observed: outcomeCardFixture({
    retest: { numerator: 4, rate: 0.8, interval: { low: 0.376, high: 0.964 } },
    comparison: {
      status: "increase_observed",
      delta: 0.8,
      interval: { low: 0.193, high: 0.964 },
    },
  }),
  decrease_observed: outcomeCardFixture({
    baseline: { numerator: 5, rate: 1, interval: { low: 0.566, high: 1 } },
    retest: { numerator: 1, rate: 0.2, interval: { low: 0.036, high: 0.624 } },
    comparison: {
      status: "decrease_observed",
      delta: -0.8,
      interval: { low: -0.964, high: -0.193 },
    },
  }),
  inconclusive: outcomeCardFixture({
    retest: { numerator: 1, denominator: 4, rate: 0.25, interval: { low: 0.046, high: 0.699 } },
    intervention: {
      protocolDeviations:
        "The homepage was rebuilt twice inside the observation window, outside this intervention.",
      earlyRetestReason: "Customer requested the retest two days early.",
    },
    comparison: {
      status: "inconclusive",
      delta: 0.25,
      interval: { low: -0.23, high: 0.699 },
      smallestDetectableChange: 0.75,
      reasons: ["PLAN_UNDERPOWERED_FOR_MINIMUM_USEFUL_CHANGE"],
    },
  }),
  unmeasured: outcomeCardFixture({
    retest: { numerator: 0, denominator: 2, rate: 0, interval: { low: 0, high: 0.658 } },
    comparison: {
      status: "inconclusive",
      delta: null,
      interval: null,
      smallestDetectableChange: null,
      reasons: ["RETEST_BELOW_READABLE_RUN_FLOOR"],
    },
    detectableChangeAtPlan: null,
  }),
};
