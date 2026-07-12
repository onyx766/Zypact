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
      "Free AI visibility snapshot",
      "3 buyer prompts tested multiple times",
      "Mirror Profile preview",
      "Lost Prompts preview",
      "Competitor recommendation preview",
      "Gap Map 2D preview",
      "One priority visibility gap",
      "Keep your snapshot in your account",
    ],
  },

  growth: {
    key: "growth",
    name: "Growth",
    priceMonthlyUsd: 99,
    billingLabel: "$99/mo",
    primaryCta: "Start Growth",
    positioning: "Turn lost AI recommendations into prioritized fixes.",
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
      "Monthly AI visibility diagnosis",
      "Priority buyer prompts tested multiple times",
      "Complete Lost Prompts analysis",
      "Competitor recommendation gaps",
      "Cited-source insights",
      "Gap Map 2D",
      "Evidence Bank",
      "3 founder-reviewed fixes per month",
      "Generated content assets",
      "JSON-LD and schema generation",
    ],
  },

  pro: {
    key: "pro",
    name: "Pro",
    priceMonthlyUsd: 199,
    billingLabel: "$199/mo",
    primaryCta: "Start Pro",
    positioning: "Track competitor movement and improve your AI visibility every week.",
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
      "Weekly AI visibility monitoring",
      "Everything in Growth",
      "Competitor movement tracking",
      "Lost Prompt changes over time",
      "Gap Map trends",
      "Historical reports",
      "Advanced visibility insights",
      "Priority founder review",
      "Fair-use founder-reviewed fixes",
      "Generated content assets",
      "JSON-LD and schema generation",
    ],
  },
};

export const PUBLIC_PLAN_ORDER: PlanKey[] = ["free", "growth", "pro"];
