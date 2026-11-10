/**
 * The Free and Starter plans (D-047 Part B item 3, D-048). Pure.
 *
 * The allowances here mirror the database's `_e1_allowance`,
 * `_e1_active_question_limit` and `_e1_engine_allowed`
 * (20261112120000_e1_plans_and_usage.sql), which are what is enforced.
 * scripts/test-e1-plans.ts fails if the two ever differ.
 *
 * Allowances count successful measurement runs. Retries, failed runs,
 * report generation and analysis calls are not counted against them, and
 * nothing is ever charged as an overage: an exhausted allowance stops
 * measurement until the next billing month.
 */
export const PLANS = ["free", "starter"] as const;
export type Plan = (typeof PLANS)[number];

export const MEASUREMENT_TYPES = ["free_trial", "monitoring", "deep_baseline", "retest"] as const;
export type MeasurementType = (typeof MEASUREMENT_TYPES)[number];

export const ENGINES = ["perplexity", "chatgpt"] as const;
export type Engine = (typeof ENGINES)[number];

export interface PlanDefinition {
  plan: Plan;
  name: string;
  /** Proposed in the approved direction; billing is not live (D-048). */
  priceMonthlyUsd: number;
  activeQuestions: number;
  engines: readonly Engine[];
  /** Successful runs. Free's are lifetime; Starter's are per billing month. */
  allowances: Readonly<Record<MeasurementType, number>>;
  lifetime: boolean;
}

export const PLAN_CATALOG: Readonly<Record<Plan, PlanDefinition>> = {
  free: {
    plan: "free",
    name: "Free",
    priceMonthlyUsd: 0,
    activeQuestions: 1,
    engines: ["perplexity"],
    allowances: { free_trial: 3, monitoring: 0, deep_baseline: 0, retest: 0 },
    lifetime: true,
  },
  starter: {
    plan: "starter",
    name: "Starter",
    priceMonthlyUsd: 49,
    activeQuestions: 20,
    engines: ["perplexity", "chatgpt"],
    allowances: { free_trial: 0, monitoring: 160, deep_baseline: 50, retest: 30 },
    lifetime: false,
  },
};

export const MEASUREMENT_TYPE_LABELS: Readonly<Record<MeasurementType, string>> = {
  free_trial: "Measurement runs",
  monitoring: "Monitoring observations",
  deep_baseline: "Deep baseline runs",
  retest: "Retest runs",
};

export const MEASUREMENT_TYPE_HINTS: Readonly<Record<MeasurementType, string>> = {
  free_trial: "One-time allowance. It does not reset.",
  monitoring: "One answer per active question and engine per monitoring round, up to four rounds a month. A single answer is exploratory, not an established change.",
  deep_baseline: "Several answers to one question and engine under a registered protocol, for a formal baseline.",
  retest: "A registered retest of a baselined question after a recorded change, compared with its baseline.",
};

export const ENGINE_LABELS: Readonly<Record<Engine, string>> = {
  perplexity: "Perplexity Sonar",
  chatgpt: "ChatGPT",
};

export const USAGE_NOTES: readonly string[] = [
  "Only successful runs count. A run that fails, times out or is excluded is released and does not use your allowance.",
  "There are no overage charges. When an allowance is used up, that kind of measurement pauses until the next billing month.",
  "Archiving or replacing a question does not give back runs it already used.",
  "The four monitoring rounds are a monthly allowance, not a promise of a new answer every calendar week.",
];

export const PAID_MEASUREMENT_OFF_NOTE =
  "Measurement of AI answers is not switched on yet. Your allowance is shown so you know what your plan includes; nothing has been used.";
