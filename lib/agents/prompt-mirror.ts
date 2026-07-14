import { callModel } from "@/lib/llm/call-model";
import { parseJsonOrRetry } from "@/lib/llm/parse-json-or-retry";
import { PROMPT_MIRROR_SYSTEM_PROMPT } from "@/lib/agent-prompts/prompt-mirror.prompt";
import {
  PromptMirrorOutputSchema,
  type PromptMirrorOutput,
  type IntentType,
  type GeneratedPromptItem,
} from "@/lib/schemas/prompt-mirror.schema";
import type { SiteReaderOutput } from "@/lib/schemas/site-reader.schema";

/**
 * Agent 2 — Prompt Mirror.
 *
 * Input:
 *   - `mirrorProfile`: the Agent 1 output. Wrapped in <mirror_profile>...</mirror_profile>.
 *   - optional `userInputs`: overrides for category, competitors, audience.
 *     Wrapped in <user_inputs>...</user_inputs>.
 *
 * Output: PromptMirrorOutput (50 prompts + up to 20 recommended ids).
 *
 * When no LLM key is configured (mock mode) we synthesize a deterministic
 * set of 50 buyer prompts from the Mirror Profile so the rest of the
 * pipeline stays wired end to end.
 */

export interface RunPromptMirrorInput {
  mirrorProfile: SiteReaderOutput;
  userInputs?: {
    category?: string;
    competitors?: string[];
    audience?: string[];
  };
}

export interface RunPromptMirrorResult {
  output: PromptMirrorOutput;
  usedMock: boolean;
  usedRetry: boolean;
}

function buildUserMessage(input: RunPromptMirrorInput): string {
  const mp = JSON.stringify(input.mirrorProfile, null, 2);
  const ui = input.userInputs ? JSON.stringify(input.userInputs, null, 2) : "{}";
  return [
    "<mirror_profile>",
    mp,
    "</mirror_profile>",
    "<user_inputs>",
    ui,
    "</user_inputs>",
  ].join("\n");
}

export async function runPromptMirrorAgent(
  input: RunPromptMirrorInput
): Promise<RunPromptMirrorResult> {
  const userMessage = buildUserMessage(input);
  const mock = buildMockPromptMirrorOutput(input);
  const mockResponse = JSON.stringify(mock);

  const call = {
    system: PROMPT_MIRROR_SYSTEM_PROMPT,
    user: userMessage,
    jsonMode: true,
    temperature: 0.4,
    maxTokens: 6000,
    mockResponse,
  };

  const initial = await callModel(call);
  const parsed = await parseJsonOrRetry({
    schema: PromptMirrorOutputSchema,
    rawOutput: initial.content,
    originalCall: call,
  });

  if (!parsed.ok) {
    throw new Error(
      `Prompt Mirror Agent output failed validation: ${parsed.error}\n\nRaw output:\n${parsed.rawOutput.slice(
        0,
        2000
      )}`
    );
  }

  return {
    output: parsed.data,
    usedMock: initial.usedMock,
    usedRetry: parsed.usedRetry,
  };
}

/* -------------------------------------------------------------------------- */
/*  Mock generator                                                            */
/* -------------------------------------------------------------------------- */

/** Distribution sums to exactly 50 across all 9 intent types. */
const INTENT_DISTRIBUTION: Record<IntentType, number> = {
  best_tools: 8,
  alternatives: 6,
  comparison: 4,
  use_case: 8,
  problem_aware: 5,
  industry_specific: 6,
  pricing_value: 4,
  migration: 4,
  buyer_role: 5,
};

interface MockContext {
  category: string;
  audience: string[];
  useCases: string[];
  painPoints: string[];
  competitors: string[];
  industries: string[];
  buyerRoles: string[];
}

function buildMockContext(input: RunPromptMirrorInput): MockContext {
  const mp = input.mirrorProfile;
  const rawCategory =
    input.userInputs?.category?.trim() || mp.detectedCategory || "SaaS tool";
  const category = rawCategory
    .replace(/\s*\(mock[^)]*\)/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const audience = (
    input.userInputs?.audience?.length
      ? input.userInputs.audience
      : mp.targetAudience
  )
    .map((a) => a.trim())
    .filter(Boolean);
  const useCases = mp.useCases.map((u) => u.trim()).filter(Boolean);
  const painPoints = mp.painPointsAddressed.map((p) => p.trim()).filter(Boolean);
  const competitors = (
    input.userInputs?.competitors?.length
      ? input.userInputs.competitors
      : mp.competitorsMentioned
  )
    .map((c) => c.trim())
    .filter(Boolean);
  const industries = extractIndustries(audience);
  const buyerRoles = extractBuyerRoles(audience);
  return {
    category: category || "SaaS tool",
    audience: audience.length ? audience : ["B2B teams"],
    useCases: useCases.length ? useCases : ["improve team productivity"],
    painPoints: painPoints.length ? painPoints : ["operational bottlenecks"],
    competitors: competitors.length ? competitors : ["a leading incumbent"],
    industries: industries.length ? industries : ["B2B SaaS"],
    buyerRoles: buyerRoles.length ? buyerRoles : ["Head of Marketing", "founder"],
  };
}

function extractIndustries(audience: string[]): string[] {
  const KNOWN = [
    "fintech",
    "healthcare",
    "e-commerce",
    "SaaS",
    "b2b saas",
    "manufacturing",
    "retail",
    "media",
    "education",
    "legal",
    "real estate",
    "logistics",
    "cybersecurity",
    "insurance",
  ];
  const found: string[] = [];
  for (const a of audience) {
    const lower = a.toLowerCase();
    for (const k of KNOWN) {
      if (lower.includes(k) && !found.includes(k)) found.push(k);
    }
  }
  return found;
}

function extractBuyerRoles(audience: string[]): string[] {
  const KNOWN = [
    "CMO",
    "Head of Marketing",
    "VP of Marketing",
    "growth lead",
    "founder",
    "product manager",
    "engineering manager",
    "sales leader",
    "revenue operations",
    "content marketer",
    "SEO manager",
  ];
  const found: string[] = [];
  for (const a of audience) {
    const lower = a.toLowerCase();
    for (const k of KNOWN) {
      if (lower.includes(k.toLowerCase()) && !found.includes(k)) found.push(k);
    }
  }
  return found;
}

interface Template {
  intentType: IntentType;
  build: (ctx: MockContext, i: number) => string;
  commercialValue: number;
  winnability: number;
  rationale: (ctx: MockContext) => string;
}

function pick<T>(arr: T[], i: number, fallback: T): T {
  return arr.length ? arr[i % arr.length] : fallback;
}

function buildTemplates(): Template[] {
  const t: Template[] = [];

  // best_tools (8)
  const bestTools: Array<{
    build: Template["build"];
    cv: number;
    w: number;
  }> = [
    { build: (c) => `best ${c.category} in 2026`, cv: 5, w: 2 },
    {
      build: (c) => `best ${c.category} for ${pick(c.audience, 0, "B2B teams")}`,
      cv: 5,
      w: 3,
    },
    { build: (c) => `what are the top ${c.category} platforms right now`, cv: 4, w: 2 },
    {
      build: (c) => `best software for ${pick(c.useCases, 0, "team productivity")}`,
      cv: 5,
      w: 4,
    },
    {
      build: (c) =>
        `best ${c.category} for ${pick(c.useCases, 1, pick(c.useCases, 0, "growing teams"))}`,
      cv: 4,
      w: 4,
    },
    { build: (c) => `best ${c.category} for small teams`, cv: 4, w: 3 },
    { build: (c) => `best ${c.category} for scaling companies`, cv: 4, w: 3 },
    { build: (c) => `which ${c.category} do most companies actually use`, cv: 3, w: 2 },
  ];
  for (const b of bestTools) {
    t.push({
      intentType: "best_tools",
      build: b.build,
      commercialValue: b.cv,
      winnability: b.w,
      rationale: (c) => `Broad category prompt for ${c.category}; high commercial intent.`,
    });
  }

  // alternatives (6)
  const alts: Array<{ build: Template["build"]; cv: number; w: number }> = [
    { build: (c) => `alternatives to ${pick(c.competitors, 0, "the market leader")}`, cv: 5, w: 4 },
    {
      build: (c) =>
        `${pick(c.competitors, 0, "the market leader")} alternatives for ${pick(
          c.audience,
          0,
          "B2B teams"
        )}`,
      cv: 5,
      w: 4,
    },
    { build: (c) => `free alternatives to ${pick(c.competitors, 0, "the market leader")}`, cv: 3, w: 2 },
    {
      build: (c) => `best alternative to ${pick(c.competitors, 1, pick(c.competitors, 0, "incumbent"))}`,
      cv: 5,
      w: 3,
    },
    { build: (c) => `what's better than ${pick(c.competitors, 0, "the market leader")}`, cv: 4, w: 3 },
    { build: (c) => `open-source alternatives to ${pick(c.competitors, 0, "the market leader")}`, cv: 3, w: 2 },
  ];
  for (const a of alts) {
    t.push({
      intentType: "alternatives",
      build: a.build,
      commercialValue: a.cv,
      winnability: a.w,
      rationale: (c) =>
        `Buyer is category-aware and shopping; competitor named (${pick(c.competitors, 0, "market leader")}).`,
    });
  }

  // comparison (4) — mock deliberately avoids client brand name
  const cmps: Array<{ build: Template["build"]; cv: number; w: number }> = [
    {
      build: (c) =>
        `compare ${pick(c.competitors, 0, "vendor A")} vs ${pick(
          c.competitors,
          1,
          "vendor B"
        )} for ${pick(c.useCases, 0, "our use case")}`,
      cv: 5,
      w: 3,
    },
    {
      build: (c) =>
        `${pick(c.competitors, 0, "vendor A")} vs ${pick(
          c.competitors,
          1,
          "vendor B"
        )}: which is better`,
      cv: 5,
      w: 3,
    },
    { build: (c) => `compare top ${c.category} platforms`, cv: 4, w: 2 },
    {
      build: (c) =>
        `${pick(c.competitors, 0, "vendor A")} vs ${pick(
          c.competitors,
          1,
          "vendor B"
        )} for ${pick(c.audience, 0, "B2B teams")}`,
      cv: 5,
      w: 3,
    },
  ];
  for (const c of cmps) {
    t.push({
      intentType: "comparison",
      build: c.build,
      commercialValue: c.cv,
      winnability: c.w,
      rationale: () =>
        `Head-to-head comparison — high intent, moderate winnability without a strong comparison page.`,
    });
  }

  // use_case (8)
  const ucs: Array<{ build: Template["build"]; cv: number; w: number }> = [
    {
      build: (c) => `how do I solve ${pick(c.painPoints, 0, "workflow bottlenecks")}`,
      cv: 4,
      w: 4,
    },
    { build: (c) => `best tool to ${pick(c.useCases, 0, "improve productivity")}`, cv: 5, w: 4 },
    { build: (c) => `how to automate ${pick(c.useCases, 0, "manual reporting")}`, cv: 4, w: 4 },
    {
      build: (c) => `software for ${pick(c.useCases, 1, pick(c.useCases, 0, "team collaboration"))}`,
      cv: 4,
      w: 4,
    },
    {
      build: (c) => `best way to ${pick(c.useCases, 0, "coordinate across teams")} at scale`,
      cv: 4,
      w: 4,
    },
    {
      build: (c) =>
        `how can a team ${pick(c.useCases, 0, "keep projects on track")} without extra headcount`,
      cv: 4,
      w: 4,
    },
    {
      build: (c) =>
        `what tools help ${pick(c.audience, 0, "B2B teams")} ${pick(
          c.useCases,
          0,
          "move faster"
        )}`,
      cv: 4,
      w: 4,
    },
    { build: (c) => `how to ${pick(c.useCases, 1, pick(c.useCases, 0, "ship faster"))} faster`, cv: 4, w: 4 },
  ];
  for (const u of ucs) {
    t.push({
      intentType: "use_case",
      build: u.build,
      commercialValue: u.cv,
      winnability: u.w,
      rationale: (c) =>
        `Specific job-to-be-done grounded in Mirror Profile use case: "${pick(
          c.useCases,
          0,
          ""
        )}".`,
    });
  }

  // problem_aware (5)
  const probs: Array<{ build: Template["build"]; cv: number; w: number }> = [
    {
      build: (c) =>
        `my ${pick(c.audience, 0, "team")} keeps struggling with ${pick(
          c.painPoints,
          0,
          "manual work"
        )} — how do we fix it`,
      cv: 3,
      w: 4,
    },
    { build: (c) => `how to prevent ${pick(c.painPoints, 0, "manual work")}`, cv: 3, w: 4 },
    { build: (c) => `why is ${pick(c.painPoints, 0, "manual work")} slowing us down`, cv: 3, w: 4 },
    {
      build: (c) => `we keep dealing with ${pick(c.painPoints, 0, "manual work")} — any ideas`,
      cv: 3,
      w: 4,
    },
    {
      build: (c) => `how to reduce ${pick(c.painPoints, 1, pick(c.painPoints, 0, "operational overhead"))}`,
      cv: 3,
      w: 4,
    },
  ];
  for (const p of probs) {
    t.push({
      intentType: "problem_aware",
      build: p.build,
      commercialValue: p.cv,
      winnability: p.w,
      rationale: () => `Pre-category buyer describing pain, not asking for a tool by name.`,
    });
  }

  // industry_specific (6)
  const inds: Array<{ build: Template["build"]; cv: number; w: number }> = [
    { build: (c) => `${c.category} for ${pick(c.industries, 0, "B2B SaaS")}`, cv: 4, w: 4 },
    { build: (c) => `best ${c.category} for ${pick(c.industries, 1, "startups")}`, cv: 4, w: 4 },
    { build: (c) => `${c.category} for ${pick(c.industries, 0, "fintech")} companies`, cv: 4, w: 4 },
    { build: (c) => `which ${c.category} works best for ${pick(c.industries, 1, "healthcare")}`, cv: 4, w: 3 },
    { build: (c) => `${c.category} tailored for ${pick(c.audience, 0, "B2B teams")}`, cv: 4, w: 4 },
    { build: (c) => `best ${c.category} for ${pick(c.industries, 0, "enterprise")} security teams`, cv: 4, w: 3 },
  ];
  for (const i of inds) {
    t.push({
      intentType: "industry_specific",
      build: i.build,
      commercialValue: i.cv,
      winnability: i.w,
      rationale: (c) =>
        `Vertical-specific query — targets ${pick(c.industries, 0, "an industry")} buyers.`,
    });
  }

  // pricing_value (4)
  const prices: Array<{ build: Template["build"]; cv: number; w: number }> = [
    { build: (c) => `affordable ${c.category} for small teams`, cv: 3, w: 3 },
    { build: (c) => `cheapest ${c.category} that actually works`, cv: 3, w: 3 },
    { build: (c) => `best value ${c.category}`, cv: 3, w: 3 },
    { build: (c) => `free or low-cost ${c.category}`, cv: 3, w: 2 },
  ];
  for (const p of prices) {
    t.push({
      intentType: "pricing_value",
      build: p.build,
      commercialValue: p.cv,
      winnability: p.w,
      rationale: () => `Price-sensitive buyer framing.`,
    });
  }

  // migration (4)
  const migs: Array<{ build: Template["build"]; cv: number; w: number }> = [
    { build: (c) => `how to migrate from ${pick(c.competitors, 0, "our current tool")}`, cv: 5, w: 3 },
    {
      build: (c) =>
        `switching from ${pick(c.competitors, 0, "our current tool")} to another ${c.category}`,
      cv: 5,
      w: 3,
    },
    { build: (c) => `replacing ${pick(c.competitors, 0, "our current tool")}`, cv: 5, w: 3 },
    {
      build: (c) => `best ${c.category} to move to after ${pick(c.competitors, 0, "the incumbent")}`,
      cv: 5,
      w: 3,
    },
  ];
  for (const m of migs) {
    t.push({
      intentType: "migration",
      build: m.build,
      commercialValue: m.cv,
      winnability: m.w,
      rationale: (c) =>
        `Buyer is actively churning from ${pick(c.competitors, 0, "an incumbent")} — very late funnel.`,
    });
  }

  // buyer_role (5)
  const roles: Array<{ build: Template["build"]; cv: number; w: number }> = [
    {
      build: (c) =>
        `what should a ${pick(c.buyerRoles, 0, "Head of Marketing")} use for ${pick(
          c.useCases,
          0,
          "team collaboration"
        )}`,
      cv: 4,
      w: 3,
    },
    { build: (c) => `best ${c.category} for a ${pick(c.buyerRoles, 0, "Head of Marketing")}`, cv: 4, w: 3 },
    {
      build: (c) => `what tools should a ${pick(c.buyerRoles, 1, pick(c.buyerRoles, 0, "founder"))} evaluate`,
      cv: 4,
      w: 3,
    },
    { build: (c) => `recommended stack for a ${pick(c.buyerRoles, 0, "growth lead")}`, cv: 4, w: 3 },
    {
      build: (c) =>
        `what ${c.category} do most ${pick(c.buyerRoles, 0, "Heads of Marketing")}s pick`,
      cv: 4,
      w: 3,
    },
  ];
  for (const r of roles) {
    t.push({
      intentType: "buyer_role",
      build: r.build,
      commercialValue: r.cv,
      winnability: r.w,
      rationale: (c) =>
        `Role-scoped question grounded in Mirror Profile audience: ${pick(c.audience, 0, "buyer")}.`,
    });
  }

  return t;
}

function assertDistribution(templates: Template[]): void {
  const count: Record<string, number> = {};
  for (const tpl of templates) {
    count[tpl.intentType] = (count[tpl.intentType] ?? 0) + 1;
  }
  let total = 0;
  for (const [k, want] of Object.entries(INTENT_DISTRIBUTION)) {
    const got = count[k] ?? 0;
    if (got !== want) {
      throw new Error(
        `Prompt Mirror mock template count mismatch for ${k}: got ${got}, want ${want}`
      );
    }
    total += got;
  }
  if (total !== 50) {
    throw new Error(`Prompt Mirror mock total ${total} !== 50`);
  }
}

export function buildMockPromptMirrorOutput(
  input: RunPromptMirrorInput
): PromptMirrorOutput {
  const ctx = buildMockContext(input);
  const templates = buildTemplates();
  assertDistribution(templates);

  const prompts: GeneratedPromptItem[] = templates.map((tpl, idx) => {
    const commercialValue = clamp1to5(tpl.commercialValue);
    const winnability = clamp1to5(tpl.winnability);
    const priority = clampPriority(commercialValue * winnability);
    return {
      id: idx + 1,
      prompt: tpl.build(ctx, idx).trim(),
      intentType: tpl.intentType,
      commercialValue,
      winnability,
      priority,
      rationale: tpl.rationale(ctx),
    };
  });

  // recommendedForProbe = top 20 by (priority desc, id asc).
  const recommended = [...prompts]
    .sort((a, b) => b.priority - a.priority || a.id - b.id)
    .slice(0, 20)
    .map((p) => p.id);

  return { prompts, recommendedForProbe: recommended };
}

function clamp1to5(n: number): number {
  return Math.min(5, Math.max(1, Math.round(n)));
}
function clampPriority(n: number): number {
  return Math.min(25, Math.max(1, Math.round(n)));
}
