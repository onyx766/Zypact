import { callModel } from "@/lib/llm/call-model";
import { parseJsonOrRetry } from "@/lib/llm/parse-json-or-retry";
import { COMPETITOR_DISCOVERY_SYSTEM_PROMPT } from "@/lib/agent-prompts/competitor-discovery.prompt";
import {
  CompetitorDiscoveryOutputSchema,
  type CompetitorDiscoveryOutput,
  type CompetitorItem,
} from "@/lib/schemas/competitor-discovery.schema";
import type { SiteReaderOutput } from "@/lib/schemas/site-reader.schema";
import type { CompetitorMention } from "@/lib/schemas/probe-analysis.schema";
import type { ProbeResult } from "@/lib/db/types";
import { isAiPlatformName } from "@/lib/ai-platforms/platform-registry";

/**
 * Competitor Discovery Agent.
 *
 * Inputs are wrapped in three XML blocks:
 *   <mirror_profile>...</mirror_profile>
 *   <user_competitors>...</user_competitors>
 *   <probe_results>...</probe_results>
 *
 * Product rule (Sprint 4): the pipeline runner refuses to call this agent
 * when there are no ProbeResults. The mock therefore assumes probe results
 * are present and never emits `model_knowledge` competitors.
 */

export interface RunCompetitorDiscoveryInput {
  mirrorProfile: SiteReaderOutput;
  userCompetitors?: string[];
  probeResults: ProbeResult[];
  /**
   * Optional map of generatedPromptId -> priority. Enables the mock (and any
   * future business logic) to promote a competitor to "high" threat when it
   * is the top recommendation in a high-priority prompt.
   */
  priorityByPromptId?: Record<string, number>;
}

export interface RunCompetitorDiscoveryResult {
  output: CompetitorDiscoveryOutput;
  usedMock: boolean;
  usedRetry: boolean;
}

const MAX_PROBE_CHARS = 20_000;

/**
 * OpenAI-side structured-output schema mirroring
 * `CompetitorDiscoveryOutputSchema`.
 *
 * Purpose: enforce the enums (`discoverySource`, `threatLevel`,
 * `confidence`) at OpenAI's inference layer so the model cannot return
 * compound values like "user|ai_answer" that the canonical prompt's
 * `|`-shorthand can accidentally suggest for multi-source entities.
 *
 * Zod remains the product contract and re-validates every field on our
 * side, including cross-field rules the OpenAI schema layer cannot
 * express (e.g. `ai_answer` requires `mentionCount >= 1`). We deliberately
 * keep this JSON schema loose on numeric bounds and required-min sizes;
 * Zod owns those constraints.
 */
const COMPETITOR_DISCOVERY_JSON_SCHEMA = {
  name: "competitor_discovery_output",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["competitors", "phantomCompetitors", "blindSpots", "summary"],
    properties: {
      competitors: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "name",
            "website",
            "discoverySource",
            "mentionCount",
            "promptIds",
            "threatLevel",
            "confidence",
          ],
          properties: {
            name: { type: "string" },
            website: { type: ["string", "null"] },
            discoverySource: {
              type: "string",
              enum: ["user", "client_site", "ai_answer", "model_knowledge"],
            },
            mentionCount: { type: "integer" },
            promptIds: { type: "array", items: { type: "string" } },
            threatLevel: { type: "string", enum: ["high", "medium", "low"] },
            confidence: {
              type: "string",
              enum: ["verified", "unverified"],
            },
          },
        },
      },
      phantomCompetitors: { type: "array", items: { type: "string" } },
      blindSpots: { type: "array", items: { type: "string" } },
      summary: { type: "string" },
    },
  } as Record<string, unknown>,
} as const;

function slimProbeResult(r: ProbeResult): unknown {
  // Include only the fields the model needs; keep raw_response short.
  return {
    id: r.id,
    generatedPromptId: r.generatedPromptId,
    prompt: r.prompt,
    platform: r.platform,
    probeMode: r.probeMode,
    verdict: r.verdict,
    clientMentioned: r.clientMentioned,
    clientPosition: r.clientPosition,
    competitorsMentioned: r.competitorsMentioned,
    sourcesCited: r.sourcesCited,
    answerSummary: r.answerSummary,
    whyClientLost: r.whyClientLost,
  };
}

function buildUserMessage(input: RunCompetitorDiscoveryInput): string {
  const probeJson = JSON.stringify(input.probeResults.map(slimProbeResult), null, 2);
  const truncated =
    probeJson.length > MAX_PROBE_CHARS
      ? probeJson.slice(0, MAX_PROBE_CHARS) +
        `\n... (${probeJson.length - MAX_PROBE_CHARS} chars truncated)`
      : probeJson;
  return [
    "<mirror_profile>",
    JSON.stringify(input.mirrorProfile, null, 2),
    "</mirror_profile>",
    "<user_competitors>",
    JSON.stringify(input.userCompetitors ?? []),
    "</user_competitors>",
    "<probe_results>",
    truncated,
    "</probe_results>",
  ].join("\n");
}

export async function runCompetitorDiscoveryAgent(
  input: RunCompetitorDiscoveryInput
): Promise<RunCompetitorDiscoveryResult> {
  const userMessage = buildUserMessage(input);
  const mock = buildMockCompetitorDiscovery(input);
  const mockResponse = JSON.stringify(mock);

  const call = {
    system: COMPETITOR_DISCOVERY_SYSTEM_PROMPT,
    user: userMessage,
    jsonMode: true,
    temperature: 0.1,
    maxTokens: 3500,
    mockResponse,
    jsonSchema: COMPETITOR_DISCOVERY_JSON_SCHEMA,
  };

  const initial = await callModel(call);
  const parsed = await parseJsonOrRetry({
    schema: CompetitorDiscoveryOutputSchema,
    rawOutput: initial.content,
    originalCall: call,
  });

  if (!parsed.ok) {
    throw new Error(
      `Competitor Discovery Agent output failed validation: ${parsed.error}\n\nRaw output:\n${parsed.rawOutput.slice(
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
/*  Deterministic mock                                                        */
/* -------------------------------------------------------------------------- */

function normalizeKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\.(com|io|ai|co|net|org)\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

interface Aggregate {
  displayName: string;
  key: string;
  sources: Set<DiscSource>;
  mentionCount: number;
  promptIds: Set<string>;
  wasTopRecInHighPriorityPrompt: boolean;
  website: string | null;
}

function pickDisplayName(candidates: string[]): string {
  // Prefer the longest non-empty candidate — captures "Monday.com" over "Monday".
  return candidates
    .filter((c) => c.trim().length > 0)
    .sort((a, b) => b.length - a.length)[0]
    ?.trim() ?? candidates[0]?.trim() ?? "";
}

function ensure(agg: Map<string, Aggregate>, name: string): Aggregate {
  const key = normalizeKey(name);
  const existing = agg.get(key);
  if (existing) {
    // Track alternative display names; take the "richer" one.
    existing.displayName = pickDisplayName([existing.displayName, name]);
    return existing;
  }
  const created: Aggregate = {
    displayName: name.trim(),
    key,
    sources: new Set(),
    mentionCount: 0,
    promptIds: new Set(),
    wasTopRecInHighPriorityPrompt: false,
    website: null,
  };
  agg.set(key, created);
  return created;
}

type DiscSource = "user" | "client_site" | "ai_answer" | "model_knowledge";

function primarySource(sources: Set<DiscSource>): CompetitorItem["discoverySource"] {
  // Precedence: ai_answer > client_site > user > model_knowledge.
  if (sources.has("ai_answer")) return "ai_answer";
  if (sources.has("client_site")) return "client_site";
  if (sources.has("user")) return "user";
  return "model_knowledge";
}

const HIGH_PRIORITY_THRESHOLD = 15;

export function buildMockCompetitorDiscovery(
  input: RunCompetitorDiscoveryInput
): CompetitorDiscoveryOutput {
  const agg = new Map<string, Aggregate>();
  const priorityByPrompt = input.priorityByPromptId ?? {};

  // 1. Ingest AI-answer competitors from probe results.
  for (const pr of input.probeResults) {
    const list = Array.isArray(pr.competitorsMentioned)
      ? (pr.competitorsMentioned as CompetitorMention[])
      : [];
    for (const c of list) {
      if (!c || typeof c.name !== "string" || c.name.trim().length === 0) continue;
      if (isAiPlatformName(c.name)) continue;
      const a = ensure(agg, c.name);
      a.sources.add("ai_answer");
      a.mentionCount += 1;
      if (pr.generatedPromptId) a.promptIds.add(pr.generatedPromptId);
      if (c.position === 1 && pr.generatedPromptId) {
        const pri = priorityByPrompt[pr.generatedPromptId] ?? 0;
        if (pri >= HIGH_PRIORITY_THRESHOLD) a.wasTopRecInHighPriorityPrompt = true;
      }
    }
  }

  // 2. Merge client-site competitors from the Mirror Profile.
  for (const c of input.mirrorProfile.competitorsMentioned ?? []) {
    if (typeof c !== "string" || c.trim().length === 0) continue;
    if (isAiPlatformName(c)) continue;
    const a = ensure(agg, c);
    a.sources.add("client_site");
  }

  // 3. Merge user-declared competitors.
  for (const c of input.userCompetitors ?? []) {
    if (typeof c !== "string" || c.trim().length === 0) continue;
    if (isAiPlatformName(c)) continue;
    const a = ensure(agg, c);
    a.sources.add("user");
  }

  const total = input.probeResults.length;

  const competitors: CompetitorItem[] = Array.from(agg.values()).map((a) => {
    const src = primarySource(a.sources);
    const rate = total > 0 ? a.mentionCount / total : 0;
    let threat: CompetitorItem["threatLevel"] = "low";
    if (rate >= 0.5 || a.wasTopRecInHighPriorityPrompt) threat = "high";
    else if (rate >= 0.2) threat = "medium";
    return {
      name: a.displayName,
      website: a.website,
      discoverySource: src,
      // Rule: ai_answer requires mentionCount >= 1. If we merged an ai_answer
      // source we already incremented mentionCount at least once — safe.
      mentionCount: a.mentionCount,
      promptIds: Array.from(a.promptIds),
      threatLevel: threat,
      confidence: src === "model_knowledge" ? "unverified" : "verified",
    };
  });

  competitors.sort(
    (a, b) =>
      threatRank(b.threatLevel) - threatRank(a.threatLevel) ||
      b.mentionCount - a.mentionCount ||
      a.name.localeCompare(b.name)
  );

  // Phantoms: user-declared names never seen in AI answers.
  const aiSet = new Set(
    Array.from(agg.values())
      .filter((a) => a.sources.has("ai_answer"))
      .map((a) => a.key)
  );
  const userNormalized = new Map<string, string>();
  for (const c of input.userCompetitors ?? []) {
    if (!c.trim()) continue;
    userNormalized.set(normalizeKey(c), agg.get(normalizeKey(c))?.displayName ?? c.trim());
  }
  const phantomCompetitors = Array.from(userNormalized.entries())
    .filter(([k]) => !aiSet.has(k))
    .map(([, v]) => v);

  // Blind spots: AI-answer names not in user list AND not in mirror.competitorsMentioned.
  const mirrorSet = new Set(
    (input.mirrorProfile.competitorsMentioned ?? []).map((c) => normalizeKey(c))
  );
  const blindSpots = Array.from(agg.values())
    .filter(
      (a) =>
        a.sources.has("ai_answer") &&
        !userNormalized.has(a.key) &&
        !mirrorSet.has(a.key)
    )
    .map((a) => a.displayName);

  const highCount = competitors.filter((c) => c.threatLevel === "high").length;
  const mediumCount = competitors.filter((c) => c.threatLevel === "medium").length;
  const summary =
    total === 0
      ? "No probe results available yet."
      : `Analyzed ${total} probe result${total === 1 ? "" : "s"}. Found ${competitors.length} competitors: ${highCount} high threat, ${mediumCount} medium threat. ${blindSpots.length} blind spot${blindSpots.length === 1 ? "" : "s"} not on the client's radar; ${phantomCompetitors.length} phantom competitor${phantomCompetitors.length === 1 ? "" : "s"} declared by the client but never recommended by AI.`;

  return {
    competitors,
    phantomCompetitors,
    blindSpots,
    summary,
  };
}

function threatRank(t: CompetitorItem["threatLevel"]): number {
  return t === "high" ? 3 : t === "medium" ? 2 : 1;
}
