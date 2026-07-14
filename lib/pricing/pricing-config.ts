/**
 * Zypact pricing configuration.
 *
 * This is a CONFIG FILE ONLY. No Stripe, no billing UI, no upgrade flow.
 * Do not add Stripe integration here — that is gated behind DESIGN_GATES.md.
 *
 * Enforce these limits in code that mutates data (crawl loop, prompt
 * generator, probe runner), not in the UI.
 */

export type PlanId = "free" | "growth" | "pro";

export interface PlanLimits {
  projects: number;
  pagesCrawledPerProject: number;
  buyerPromptsPerMonth: number;
  aiProbesPerMonth: number;
  fixBriefsPerMonth: number;
  generatedAssetsPerMonth: number;
  monitoringCadence: "none" | "monthly" | "weekly";
  exportAllowed: boolean;
}

export interface Plan {
  id: PlanId;
  name: string;
  monthlyPriceUsd: number;
  limits: PlanLimits;
}

export const PRICING: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    monthlyPriceUsd: 0,
    limits: {
      projects: 1,
      pagesCrawledPerProject: 5,
      buyerPromptsPerMonth: 10,
      aiProbesPerMonth: 3,
      fixBriefsPerMonth: 1, // "1 fix preview"
      generatedAssetsPerMonth: 0,
      monitoringCadence: "none",
      exportAllowed: false,
    },
  },
  growth: {
    id: "growth",
    name: "Growth",
    monthlyPriceUsd: 99,
    limits: {
      projects: 5,
      pagesCrawledPerProject: 15,
      buyerPromptsPerMonth: 55,
      aiProbesPerMonth: 25,
      fixBriefsPerMonth: 1,
      generatedAssetsPerMonth: 1,
      monitoringCadence: "monthly",
      exportAllowed: true,
    },
  },
  pro: {
    id: "pro",
    name: "Pro",
    monthlyPriceUsd: 199,
    limits: {
      projects: 20,
      pagesCrawledPerProject: 30,
      buyerPromptsPerMonth: 150,
      aiProbesPerMonth: 75,
      fixBriefsPerMonth: 4,
      generatedAssetsPerMonth: 4,
      monitoringCadence: "weekly",
      exportAllowed: true,
    },
  },
};

export const DEFAULT_PLAN: PlanId = "free";

export function getPlan(planId: PlanId = DEFAULT_PLAN): Plan {
  return PRICING[planId];
}

export function getPagesCrawlLimit(planId: PlanId = DEFAULT_PLAN): number {
  return PRICING[planId].limits.pagesCrawledPerProject;
}
