import { callModel } from "@/lib/llm/call-model";
import { parseJsonOrRetry } from "@/lib/llm/parse-json-or-retry";
import { COMPETITOR_DISCOVERY_SYSTEM_PROMPT } from "@/lib/agent-prompts/competitor-discovery.prompt";
import {
  CompetitorDiscoveryOutputSchema,
  type CompetitorDiscoveryOutput,
  type CompetitorItem,
} from "@/lib/schemas/competitor-discovery.schema";
import type { SiteReaderOutput } from "@/lib/schemas/site-reader.schema";
import type { ProbeResult } from "@/lib/db/types";
import { isAiPlatformName } from "@/lib/ai-platforms/platform-registry";
import type { ResolvedCompetitorMention } from "@/lib/evidence/get-resolved-competitor-mentions";

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
  /**
   * M3 — source unique: resolved competitor mentions per `probe_result.id`,
   * from the M2 canonical entity-resolution layer
   * (lib/evidence/get-resolved-competitor-mentions.ts), pre-fetched by the
   * DB-aware orchestrator (lib/pipeline/discover-competitors.ts). Used only
   * by the AI-answer ingestion step of `buildMockCompetitorDiscovery` —
   * never by the real-LLM prompt building below, which still serializes
   * `probeResults` verbatim as evidence text for the model to read.
   *
   * Mandatory, not optional: every caller must explicitly decide what
   * this map contains for every probe_result, even if that decision is
   * "empty array, nothing resolved yet" — there is no silent absence
   * path, and no fallback to `probeResults[].competitorsMentioned` is
   * ever performed. A probe_result missing from this map (or present
   * with an empty array) contributes zero ai_answer competitors, which
   * is the same safe, explicit "nothing reliable to report" outcome
   * either way — never a guess drawn from unresolved legacy data.
   */
  resolvedMentionsByProbeResult: ReadonlyMap<string, ResolvedCompetitorMention[]>;
}

export interface RunCompetitorDiscoveryResult {
  output: CompetitorDiscoveryOutput;
  usedMock: boolean;
  usedRetry: boolean;
  /** M1 evidence contract — provider that produced the final accepted output. */
  provider: "openai" | "anthropic" | "mock";
  /** M1 evidence contract — exact model string used for the final accepted output. */
  model: string;
  /** M1 evidence contract — wall-clock milliseconds across the call (plus repair retry, if any). */
  latencyMs: number;
  /** M1 evidence contract — exact request text sent to the model (system + user). */
  requestText: string;
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

  const startedAt = Date.now();
  const initial = await callModel(call);
  const parsed = await parseJsonOrRetry({
    schema: CompetitorDiscoveryOutputSchema,
    rawOutput: initial.content,
    originalCall: call,
  });
  const latencyMs = Date.now() - startedAt;

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
    provider: initial.provider,
    model: initial.model,
    latencyMs,
    requestText: `${call.system}\n\n${call.user}`,
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

function newAggregate(name: string): Aggregate {
  return {
    displayName: name.trim(),
    sources: new Set(),
    mentionCount: 0,
    promptIds: new Set(),
    wasTopRecInHighPriorityPrompt: false,
    website: null,
  };
}

/**
 * Ensures an entry in a normalizeKey()-keyed aggregate map. Used only
 * for the client-site (Mirror Profile) and user-declared sources,
 * neither of which carries a canonical identity of its own — this
 * remains the best available merge key for those two. Never used for
 * ai_answer entries, which are grouped by `canonicalEntityId` instead
 * (see `buildMockCompetitorDiscovery` below).
 */
function ensureByNameKey(agg: Map<string, Aggregate>, name: string): Aggregate {
  const key = normalizeKey(name);
  const existing = agg.get(key);
  if (existing) {
    existing.displayName = pickDisplayName([existing.displayName, name]);
    return existing;
  }
  const created = newAggregate(name);
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
  const priorityByPrompt = input.priorityByPromptId ?? {};

  // 1. Ingest AI-answer competitors from resolved (canonical) probe
  // mentions, grouped by canonicalEntityId — never by name string, so
  // two surface forms of the same competitor (e.g. "Widgetco" and
  // "Widgetco Inc.", already resolved to one canonical identity by the
  // M2 RPC) are one entry here too, not two. `resolvedMentionsByProbeResult`
  // is mandatory (see its own doc comment): a probe_result absent from
  // it, or present with an empty array, contributes zero ai_answer
  // competitors — never a fallback to `pr.competitorsMentioned`.
  const aiAgg = new Map<string, Aggregate>();
  for (const pr of input.probeResults) {
    const resolvedMentions = input.resolvedMentionsByProbeResult.get(pr.id) ?? [];
    for (const mention of resolvedMentions) {
      if (isAiPlatformName(mention.rawText)) continue;
      let a = aiAgg.get(mention.canonicalEntityId);
      if (a) {
        a.displayName = pickDisplayName([a.displayName, mention.rawText]);
      } else {
        a = newAggregate(mention.rawText);
        aiAgg.set(mention.canonicalEntityId, a);
      }
      a.sources.add("ai_answer");
      a.mentionCount += 1;
      if (pr.generatedPromptId) a.promptIds.add(pr.generatedPromptId);
      if (mention.mentionOrdinal === 1 && pr.generatedPromptId) {
        const pri = priorityByPrompt[pr.generatedPromptId] ?? 0;
        if (pri >= HIGH_PRIORITY_THRESHOLD) a.wasTopRecInHighPriorityPrompt = true;
      }
    }
  }

  // 2. Client-site competitors from the Mirror Profile — unchanged,
  // still read exactly as before. This is site-reader/mirror-scan
  // evidence, never AI-probe evidence, and carries no canonical
  // identity of its own — normalizeKey() remains its merge key.
  const otherAgg = new Map<string, Aggregate>();
  for (const c of input.mirrorProfile.competitorsMentioned ?? []) {
    if (typeof c !== "string" || c.trim().length === 0) continue;
    if (isAiPlatformName(c)) continue;
    ensureByNameKey(otherAgg, c).sources.add("client_site");
  }

  // 3. User-declared competitors — same non-canonical merge key.
  for (const c of input.userCompetitors ?? []) {
    if (typeof c !== "string" || c.trim().length === 0) continue;
    if (isAiPlatformName(c)) continue;
    ensureByNameKey(otherAgg, c).sources.add("user");
  }

  // Merge: an ai_answer entry absorbs a matching client-site/user entry
  // by normalizeKey() of its own display name — the one place a
  // name-string heuristic bridges canonical and non-canonical data,
  // unavoidable since client-site/user sources carry no canonical
  // identity to match on. This is never how ai_answer entries are
  // deduplicated against EACH OTHER — that used canonicalEntityId
  // above, and only that.
  const merged: Array<Aggregate & { identityKey: string }> = [];
  for (const [canonicalEntityId, a] of aiAgg) {
    const bridgeKey = normalizeKey(a.displayName);
    const other = otherAgg.get(bridgeKey);
    if (other) {
      for (const s of other.sources) a.sources.add(s);
      if (other.website) a.website = other.website;
      otherAgg.delete(bridgeKey);
    }
    merged.push({ ...a, identityKey: canonicalEntityId });
  }
  for (const [key, a] of otherAgg) {
    merged.push({ ...a, identityKey: key });
  }

  const total = input.probeResults.length;

  const competitors: CompetitorItem[] = merged.map((a) => {
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

  // Phantoms: user-declared names never seen in AI answers. Matching
  // against ai_answer entries is by normalizeKey(displayName) — the
  // same unavoidable bridge as above, since a user-typed name has no
  // canonical identity to compare against directly.
  const aiKeySet = new Set(
    merged.filter((a) => a.sources.has("ai_answer")).map((a) => normalizeKey(a.displayName))
  );
  const userNormalized = new Map<string, string>();
  for (const c of input.userCompetitors ?? []) {
    if (!c.trim()) continue;
    const key = normalizeKey(c);
    const match = merged.find((a) => normalizeKey(a.displayName) === key);
    userNormalized.set(key, match?.displayName ?? c.trim());
  }
  const phantomCompetitors = Array.from(userNormalized.entries())
    .filter(([k]) => !aiKeySet.has(k))
    .map(([, v]) => v);

  // Blind spots: AI-answer names not in user list AND not in mirror.competitorsMentioned.
  const mirrorSet = new Set(
    (input.mirrorProfile.competitorsMentioned ?? []).map((c) => normalizeKey(c))
  );
  const blindSpots = merged
    .filter((a) => {
      const key = normalizeKey(a.displayName);
      return a.sources.has("ai_answer") && !userNormalized.has(key) && !mirrorSet.has(key);
    })
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
