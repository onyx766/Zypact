export type PlanKey = "free" | "growth" | "pro";

export type FeatureAccess = "none" | "preview" | "full";

export type PlanLimits = {
  projects: number;
  aiAnalysesMonthly: number;
  visibilityGapsMonthly: number;
  fixesMonthly: number | "fair_use";
};

export type PlanFeatures = {
  mirrorProfile: FeatureAccess;
  buyerPrompts: FeatureAccess;
  lostPrompts: FeatureAccess;
  gapMap2d: FeatureAccess;
  evidenceBank: boolean;
  generatedAssets: boolean;
  jsonLdGeneration: boolean;
  reportExport: boolean;
  weeklyMonitoring: boolean;
  competitorMovementTracking: boolean;
  gapMapTrends: boolean;
};

export type PricingPlan = {
  key: PlanKey;
  name: string;
  priceMonthlyUsd: number;
  billingLabel: string;
  primaryCta: string;
  positioning: string;
  limits: PlanLimits;
  features: PlanFeatures;
  bullets: string[];
};

export const PRICING_PLANS: Record<PlanKey, PricingPlan> = {
  free: {
    key: "free",
    name: "Free",
    priceMonthlyUsd: 0,
    billingLabel: "$0",
    primaryCta: "Run free snapshot",
    positioning: "See the AI visibility problem before paying.",
    limits: {
      projects: 0,
      aiAnalysesMonthly: 9,
      visibilityGapsMonthly: 10,
      fixesMonthly: 0,
    },
    features: {
      mirrorProfile: "preview",
      buyerPrompts: "preview",
      lostPrompts: "preview",
      gapMap2d: "preview",
      evidenceBank: false,
      generatedAssets: false,
      jsonLdGeneration: false,
      reportExport: false,
      weeklyMonitoring: false,
      competitorMovementTracking: false,
      gapMapTrends: false,
    },
    bullets: [
      "No saved projects",
      "Free AI visibility snapshot",
      "3 buyer prompts tested multiple times",
      "Mirror Profile preview",
      "Lost Prompts preview",
      "Competitor recommendation preview",
      "Gap Map 2D preview",
      "One priority visibility gap",
    ],
  },

  growth: {
    key: "growth",
    name: "Growth",
    priceMonthlyUsd: 99,
    billingLabel: "$99/mo",
    primaryCta: "Start Growth",
    positioning: "Monthly AI visibility diagnostics and fixes for B2B SaaS teams.",
    limits: {
      projects: 3,
      aiAnalysesMonthly: 25,
      visibilityGapsMonthly: 55,
      fixesMonthly: 3,
    },
    features: {
      mirrorProfile: "full",
      buyerPrompts: "full",
      lostPrompts: "full",
      gapMap2d: "full",
      evidenceBank: true,
      generatedAssets: true,
      jsonLdGeneration: true,
      reportExport: true,
      weeklyMonitoring: false,
      competitorMovementTracking: false,
      gapMapTrends: false,
    },
    bullets: [
      "3 saved projects",
      "Monthly AI visibility diagnostic",
      "3 fixes / month",
      "Gap Map 2D",
      "Evidence Bank",
      "Generated Assets",
      "JSON-LD / schema generation",
    ],
  },

  pro: {
    key: "pro",
    name: "Pro",
    priceMonthlyUsd: 199,
    billingLabel: "$199/mo",
    primaryCta: "Start Pro",
    positioning: "Advanced AI visibility tracking, competitor movement, and weekly reports for growing teams.",
    limits: {
      projects: 5,
      aiAnalysesMonthly: 75,
      visibilityGapsMonthly: 150,
      fixesMonthly: "fair_use",
    },
    features: {
      mirrorProfile: "full",
      buyerPrompts: "full",
      lostPrompts: "full",
      gapMap2d: "full",
      evidenceBank: true,
      generatedAssets: true,
      jsonLdGeneration: true,
      reportExport: true,
      weeklyMonitoring: true,
      competitorMovementTracking: true,
      gapMapTrends: true,
    },
    bullets: [
      "5 saved projects",
      "Weekly monitoring",
      "Fair-use fixes",
      "Competitor movement tracking",
      "Gap Map trends",
      "Advanced reports",
      "JSON-LD / schema generation",
    ],
  },
};

export const PUBLIC_PLAN_ORDER: PlanKey[] = ["free", "growth", "pro"];
