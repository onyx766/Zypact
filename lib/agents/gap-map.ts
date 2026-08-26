import { callModel } from "@/lib/llm/call-model";
import type { PromptCompetitorEvidence } from "@/lib/pipeline/scorecard-competitors";
import { parseJsonOrRetry } from "@/lib/llm/parse-json-or-retry";
import { GAP_MAP_SYSTEM_PROMPT } from "@/lib/agent-prompts/gap-map.prompt";
import {
  CLIENT_NODE_ID,
  GAP_DIMENSIONS,
  GapMapOutputSchema,
  type CompetitorDistance,
  type GapMapOutput,
  type GapScores,
  type GraphEdge,
  type GraphNode,
  type PrioritizedGap,
} from "@/lib/schemas/gap-map.schema";
import type { SiteReaderOutput } from "@/lib/schemas/site-reader.schema";
import type { Competitor, ProbeResult } from "@/lib/db/types";
import type {
  CompetitorMention,
  SourceCitation,
} from "@/lib/schemas/probe-analysis.schema";
import {
  computeGapScores,
  normalizeName,
  sumGapScores,
  type BaselineScores,
} from "@/lib/gap-map/compute-gap-scores";
import type { ResolvedCompetitorMention } from "@/lib/evidence/get-resolved-competitor-mentions";

/**
 * Gap Map Agent.
 *
 * Inputs are wrapped in three XML blocks:
 *   <mirror_profile>
 *   <probe_results>
 *   <competitors>
 *
 * Numeric truth is verified after Zod validation:
 *  - Each `recommendationDistance` is forced to equal the sum of the six
 *    sub-scores.
 *  - Missing / invalid competitor scores are backfilled from the
 *    deterministic baseline (`lib/gap-map/compute-gap-scores.ts`).
 */

export interface RunGapMapInput {
  mirrorProfile: SiteReaderOutput;
  probeResults: ProbeResult[];
  /**
   * Flat competitor list. Retained for LLM context and distance scoring only —
   * it carries no provenance, so it must not decide which competitor explains
   * which prompt.
   */
  competitors: Competitor[];
  /**
   * Prompt-scoped recommendation evidence. When supplied, deterministic gap
   * attribution derives from this instead of the flat list, so a gap can never
   * imply that a product recommended for one buyer question explains a loss on
   * another. Optional: callers that omit it keep the prior behaviour.
   */
  competitorEvidence?: PromptCompetitorEvidence[];
  /**
   * M3 — source unique, Option A: resolved competitor mentions per
   * `probe_result.id`, from the M2 canonical entity-resolution layer,
   * pre-fetched by the DB-aware orchestrator (generate-gap-map.ts).
   * Forwarded verbatim to computeGapScores() so its mention-identity
   * matching can use `canonicalEntityId` equality instead of a
   * name-normalization heuristic. Mandatory, not optional — every
   * caller must explicitly decide what this map contains, even if that
   * decision is "empty array, nothing resolved yet" for a given
   * probe_result.
   */
  resolvedMentionsByProbeResult: ReadonlyMap<string, ResolvedCompetitorMention[]>;
}

export interface RunGapMapResult {
  output: GapMapOutput;
  usedMock: boolean;
  usedRetry: boolean;
  /**
   * Set to true whenever the pipeline had to overwrite the model's
   * recommendationDistance to keep it consistent with the sub-scores.
   */
  normalizedDistances: boolean;
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
const MAX_COMPETITOR_CHARS = 8_000;

function slimProbeResult(r: ProbeResult): unknown {
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

function slimCompetitor(c: Competitor): unknown {
  return {
    name: c.name,
    website: c.website,
    discoverySource: c.discoverySource,
    mentionCount: c.mentionCount,
    threatLevel: c.threatLevel,
    isPhantom: c.isPhantom,
    isBlindSpot: c.isBlindSpot,
    promptIds: c.promptIds,
  };
}

function truncate(json: string, max: number): string {
  return json.length > max
    ? json.slice(0, max) + `\n... (${json.length - max} chars truncated)`
    : json;
}

export function buildGapMapUserMessageForTest(input: RunGapMapInput): string {
  const probeJson = truncate(
    JSON.stringify(input.probeResults.map(slimProbeResult), null, 2),
    MAX_PROBE_CHARS
  );
  const compJson = truncate(
    JSON.stringify(input.competitors.map(slimCompetitor), null, 2),
    MAX_COMPETITOR_CHARS
  );
  return [
    "<mirror_profile>",
    JSON.stringify(input.mirrorProfile, null, 2),
    "</mirror_profile>",
    "<probe_results>",
    probeJson,
    "</probe_results>",
    "<competitors>",
    compJson,
    "</competitors>",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/*  Agent entry point                                                         */
/* -------------------------------------------------------------------------- */

export async function runGapMapAgent(
  input: RunGapMapInput
): Promise<RunGapMapResult> {
  const baseline = computeGapScores(input);
  const userMessage = buildGapMapUserMessageForTest(input);
  const mock = buildMockGapMap(input, baseline);
  const mockResponse = JSON.stringify(mock);

  const call = {
    system: GAP_MAP_SYSTEM_PROMPT,
    user: userMessage,
    jsonMode: true,
    temperature: 0.15,
    maxTokens: 6000,
    mockResponse,
  };

  const startedAt = Date.now();
  const initial = await callModel(call);
  const parsed = await parseJsonOrRetry({
    schema: GapMapOutputSchema,
    rawOutput: initial.content,
    originalCall: call,
    preNormalize: preNormalizeGapMapArithmetic,
  });
  const latencyMs = Date.now() - startedAt;

  if (!parsed.ok) {
    throw new Error(
      `Gap Map Agent output failed validation: ${parsed.error}\n\nRaw output:\n${parsed.rawOutput.slice(
        0,
        2000
      )}`
    );
  }

  const { output, changed } = normalizeGapMapOutput(parsed.data, input, baseline);

  return {
    output,
    usedMock: initial.usedMock,
    usedRetry: parsed.usedRetry,
    normalizedDistances: changed,
    provider: initial.provider,
    model: initial.model,
    latencyMs,
    requestText: `${call.system}\n\n${call.user}`,
  };
}

/* -------------------------------------------------------------------------- */
/*  Pre-Zod arithmetic normalization                                          */
/* -------------------------------------------------------------------------- */

/**
 * Recompute `recommendationDistance = sum(gapScores)` on every
 * competitorDistances row before Zod runs. LLMs regularly get this
 * arithmetic identity wrong (they emit e.g. distance=25 with sub-scores
 * summing to 15) and one repair retry is not enough to fix a
 * mental-math error the model doesn't perceive as an error.
 *
 * Defensive: any row whose shape isn't as expected is left unchanged so
 * Zod can produce the real error. This does NOT weaken the schema —
 * Zod still enforces the identity after this runs.
 */
export function preNormalizeGapMapArithmetic(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;
  const list = obj.competitorDistances;
  if (!Array.isArray(list)) return raw;
  const rebuilt = list.map((row) => {
    if (!row || typeof row !== "object") return row;
    const r = row as Record<string, unknown>;
    const scores = r.gapScores;
    if (!scores || typeof scores !== "object") return row;
    const s = scores as Record<string, unknown>;
    const keys = [
      "prompt_loss",
      "citation",
      "review",
      "comparison_content",
      "proof",
      "entity_clarity",
    ] as const;
    let sum = 0;
    let allNumeric = true;
    for (const k of keys) {
      const v = s[k];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        allNumeric = false;
        break;
      }
      sum += v;
    }
    if (!allNumeric) return row;
    return { ...r, recommendationDistance: sum };
  });
  return { ...obj, competitorDistances: rebuilt };
}

/* -------------------------------------------------------------------------- */
/*  Post-parse normalization                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Normalize the validated model output using the deterministic baseline.
 *
 *  1. Ensure every high/medium-threat competitor has an entry in
 *     `competitorDistances`. If the model missed one, fill from baseline.
 *  2. Force `recommendationDistance = sum of six sub-scores` for every row.
 *
 * Zod already enforces score/distance ranges and the sum relationship
 * (it will reject a mismatched pair). The step below is defense-in-depth
 * for the "backfill missing competitor" case and to keep the code path
 * that fills sensible baseline scores in one place.
 */
export function normalizeGapMapOutput(
  data: GapMapOutput,
  input: RunGapMapInput,
  baseline: BaselineScores
): { output: GapMapOutput; changed: boolean } {
  let changed = false;

  const focusPrimary = input.competitors.filter(
    (c) => !isClientSelf(c.name, input.mirrorProfile) && (c.threatLevel === "high" || c.threatLevel === "medium")
  );
  const fallbackFocus = input.competitors.filter((c) => !isClientSelf(c.name, input.mirrorProfile));
  const focus = focusPrimary.length > 0 ? focusPrimary : (fallbackFocus.length > 0 ? fallbackFocus : input.competitors);

  const originalByKey = new Map<string, CompetitorDistance>();
  for (const d of data.competitorDistances) {
    originalByKey.set(normalizeName(d.competitor), d);
  }

  const rebuilt: CompetitorDistance[] = [];
  for (const c of focus) {
    const base = baseline[c.name];
    if (!base) continue;
    const scores: GapScores = {
      prompt_loss: base.prompt_loss,
      citation: base.citation,
      review: base.review,
      comparison_content: base.comparison_content,
      proof: base.proof,
      entity_clarity: base.entity_clarity,
    };
    const row: CompetitorDistance = {
      competitor: c.name,
      recommendationDistance: sumGapScores(scores),
      gapScores: scores,
      // Sprint 13A.2: topReasons are deterministic too. The LLM had been
      // inventing claims like "G2/Capterra presence" not present in live inputs.
      topReasons: buildBaselineTopReasons(c.name, scores),
      evidenceStrength: evidenceStrengthFromScores(scores),
    };
    const original = originalByKey.get(normalizeName(c.name));
    if (!original || JSON.stringify(original) !== JSON.stringify(row)) changed = true;
    rebuilt.push(row);
  }

  rebuilt.sort(
    (a, b) =>
      b.recommendationDistance - a.recommendationDistance ||
      a.competitor.localeCompare(b.competitor)
  );

  const prioritizedGaps = buildDeterministicPrioritizedGaps(input, rebuilt);
  if (JSON.stringify(prioritizedGaps) !== JSON.stringify(data.prioritizedGaps)) changed = true;

  const output: GapMapOutput = {
    ...data,
    competitorDistances: rebuilt,
    prioritizedGaps,
  };

  return { output, changed };
}

function isClientSelf(name: string, profile: SiteReaderOutput): boolean {
  const key = normalizeName(name);
  if (!key) return false;
  const company = normalizeName(profile.companyName ?? "");
  const website = normalizeName((profile.website ?? "").replace(/^https?:\/\//, "").split("/")[0] ?? "");
  return key === company || key === website;
}

/**
 * Single source of truth for turning dimension hits into prioritized gaps.
 *
 * Both the normalization path and the provider-free mock path build gaps; when
 * each owned its own copy, only one of them received prompt-scoped attribution
 * and the other silently kept describing a gap with the global union of
 * competitors. Extracting it means the two cannot drift again.
 *
 * Scoring is untouched: the >= 6 threshold, dimension set, and severity
 * function are exactly as before. Only attribution is centralised.
 */
export function buildPrioritizedGapsFromEvidence(params: {
  competitorDistances: CompetitorDistance[];
  competitorEvidence?: PromptCompetitorEvidence[];
  fallbackAffectedPrompts: Record<keyof GapScores, Set<string>>;
  explanationSuffix: string;
}): PrioritizedGap[] {
  const { competitorDistances, fallbackAffectedPrompts, explanationSuffix } = params;

  // Only lost/partial groups can justify a recovery gap. A won prompt is
  // positive evidence and must never be presented back to a client as a loss.
  const recoveryEvidence = (params.competitorEvidence ?? []).filter(
    (entry) => entry.outcome === "lost" || entry.outcome === "partial"
  );

  return GAP_DIMENSIONS.map((dim) => {
    const hits = competitorDistances.filter((d) => d.gapScores[dim] >= 6);
    return { dim, hits };
  })
    .filter((g) => g.hits.length > 0)
    .sort((a, b) => b.hits.length - a.hits.length)
    .slice(0, 5)
    .map((g) => {
      const hitKeys = new Set(
        g.hits.map((h) => h.competitor.trim().toLowerCase())
      );

      // Each entry keeps only the competitors that this prompt actually
      // recommended, intersected with the dimension's hits — so Prompt A can
      // never be explained by Prompt B's products.
      const promptEvidence = recoveryEvidence
        .map((entry) => ({
          prompt: entry.prompt,
          promptKey: entry.promptKey,
          verdict: entry.outcome as "lost" | "partial",
          competitors: entry.competitors
            .filter((c) => hitKeys.has(c.nameKey))
            .map((c) => c.name),
        }))
        .filter((entry) => entry.competitors.length > 0);

      const hasPromptEvidence = promptEvidence.length > 0;

      // Derived views — never computed independently from the global list.
      const competitorsHit = hasPromptEvidence
        ? Array.from(new Set(promptEvidence.flatMap((e) => e.competitors)))
        : g.hits.map((h) => h.competitor);
      const affectedPrompts = hasPromptEvidence
        ? Array.from(new Set(promptEvidence.map((e) => e.prompt)))
        : Array.from(fallbackAffectedPrompts[g.dim]);

      const compList = competitorsHit.join(", ");
      const count = competitorsHit.length;

      return {
        type: g.dim,
        severity: severityFromCount(g.hits.length),
        explanation: `${count} competitor${count === 1 ? "" : "s"} (${compList}) show${count === 1 ? "s" : ""} a material gap on "${HUMAN_TYPE[g.dim]}"${explanationSuffix}`,
        affectedPrompts,
        suggestedFixDirection: FIX_DIRECTION[g.dim],
        ...(hasPromptEvidence ? { promptEvidence } : {}),
      };
    });
}

/** Exported for tests: the real deterministic attribution path. */
export function buildDeterministicPrioritizedGaps(
  input: RunGapMapInput,
  competitorDistances: CompetitorDistance[],
): PrioritizedGap[] {
  const affectedPromptsByDim: Record<keyof GapScores, Set<string>> = {
    prompt_loss: new Set(),
    citation: new Set(),
    review: new Set(),
    comparison_content: new Set(),
    proof: new Set(),
    entity_clarity: new Set(),
  };

  for (const p of input.probeResults) {
    const promptId = p.generatedPromptId;
    if (!promptId) continue;
    const clientLostHere = !p.clientMentioned || p.verdict === "lost" || p.verdict === "partial";
    const sources = Array.isArray(p.sourcesCited) ? (p.sourcesCited as SourceCitation[]) : [];
    if (clientLostHere) affectedPromptsByDim.prompt_loss.add(promptId);
    if (sources.length > 0) affectedPromptsByDim.citation.add(promptId);
    if (sources.some((s) => s.type === "review_site")) affectedPromptsByDim.review.add(promptId);
    if (sources.some((s) => s.type === "vendor_site" || s.type === "blog")) {
      affectedPromptsByDim.comparison_content.add(promptId);
    }
  }

  return buildPrioritizedGapsFromEvidence({
    competitorDistances,
    competitorEvidence: input.competitorEvidence,
    fallbackAffectedPrompts: affectedPromptsByDim,
    explanationSuffix: " in the selected probe set.",
  });
}

/* -------------------------------------------------------------------------- */
/*  Deterministic mock                                                        */
/* -------------------------------------------------------------------------- */

const REASON_TEMPLATES: Record<keyof GapScores, string> = {
  prompt_loss:
    "This competitor keeps showing up in buyer questions where you are absent — AI is quietly handing them the intro instead of you.",
  citation:
    "External sources cite them by name, so AI treats those citations as evidence they exist and you might not.",
  review:
    "Review or evaluation sources appear in the selected probe evidence for this competitor; strengthen your own third-party proof before making review-based claims.",
  comparison_content:
    "There are comparison and alternatives-style pages that discuss this competitor, so AI has ready-made material to recommend them.",
  proof:
    "Their name is described with concrete proof — customers, ratings, funding — while your site's proof signals are thinner.",
  entity_clarity:
    "AI describes their category crisply, and your category confidence is weaker, which nudges the model toward them by default.",
};

function buildBaselineTopReasons(
  competitorName: string,
  scores: GapScores
): string[] {
  const ranked = [...GAP_DIMENSIONS]
    .map((d) => ({ d, s: scores[d] }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);
  if (ranked.length === 0) {
    return [
      `Evidence for ${competitorName} is thin so far; run more probes to sharpen the picture.`,
    ];
  }
  const reasons = ranked.map((x) => REASON_TEMPLATES[x.d]);
  return reasons.slice(0, 4);
}

function evidenceStrengthFromScores(scores: GapScores): "strong" | "moderate" | "thin" {
  const total = sumGapScores(scores);
  const nonZero = GAP_DIMENSIONS.filter((d) => scores[d] > 0).length;
  if (total >= 30 && nonZero >= 4) return "strong";
  if (total >= 12 && nonZero >= 2) return "moderate";
  return "thin";
}

function severityFromCount(count: number): "high" | "medium" | "low" {
  if (count >= 3) return "high";
  if (count >= 1) return "medium";
  return "low";
}

const FIX_DIRECTION: Record<keyof GapScores, string> = {
  prompt_loss:
    "Publish focused pages that answer the buyer questions where competitors keep appearing without you.",
  citation:
    "Get named in trustworthy external sources — analyst notes, podcasts, press — that AI is already citing.",
  review:
    "Build (and link to) a real presence on G2, Capterra, or similar review sites the AI relies on.",
  comparison_content:
    "Own the comparison and alternatives pages for your category — with honest, well-sourced comparisons.",
  proof:
    "Add concrete proof to key pages: customer names, ratings, case studies, and hard numbers.",
  entity_clarity:
    "Tighten the category framing on your homepage and About page so AI can describe you in one sentence.",
};

const HUMAN_TYPE: Record<keyof GapScores, string> = {
  prompt_loss: "Buyer prompts where you are missing",
  citation: "External citations",
  review: "Review-site presence",
  comparison_content: "Comparison content",
  proof: "Proof signals",
  entity_clarity: "Category clarity",
};

export function buildMockGapMap(
  input: RunGapMapInput,
  baseline: BaselineScores
): GapMapOutput {
  const clientLabel =
    input.mirrorProfile.companyName || input.mirrorProfile.website || "Client";

  const clientNode: GapMapOutput["clientNode"] = {
    id: CLIENT_NODE_ID,
    label: clientLabel,
    type: "brand",
  };

  const focusPrimary = input.competitors.filter(
    (c) => !isClientSelf(c.name, input.mirrorProfile) && (c.threatLevel === "high" || c.threatLevel === "medium")
  );
  // Schema requires competitorDistances.min(1). If no high/medium competitor
  // exists, fall back to all non-client competitors so the map still renders.
  const fallbackFocus = input.competitors.filter((c) => !isClientSelf(c.name, input.mirrorProfile));
  const focus = focusPrimary.length > 0 ? focusPrimary : (fallbackFocus.length > 0 ? fallbackFocus : input.competitors);

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seenNodeIds = new Set<string>();

  function addNode(node: GraphNode): void {
    if (seenNodeIds.has(node.id)) return;
    seenNodeIds.add(node.id);
    nodes.push(node);
  }

  function safeId(prefix: string, raw: string, i: number): string {
    const base =
      normalizeName(raw).slice(0, 40) || `${prefix}${i}`;
    let candidate = `${prefix}:${base}`;
    let n = 2;
    while (seenNodeIds.has(candidate) || candidate === CLIENT_NODE_ID) {
      candidate = `${prefix}:${base}-${n++}`;
    }
    return candidate;
  }

  const competitorIdByKey = new Map<string, string>();
  const competitorDistances: CompetitorDistance[] = [];

  focus.forEach((c, i) => {
    const key = normalizeName(c.name);
    const id = safeId("comp", c.name, i);
    competitorIdByKey.set(key, id);
    addNode({ id, label: c.name, type: "competitor" });
    edges.push({ from: id, to: clientNode.id, type: "competes_with", weight: 1 });

    const base = baseline[c.name];
    const scores: GapScores = {
      prompt_loss: base?.prompt_loss ?? 0,
      citation: base?.citation ?? 0,
      review: base?.review ?? 0,
      comparison_content: base?.comparison_content ?? 0,
      proof: base?.proof ?? 0,
      entity_clarity: base?.entity_clarity ?? 0,
    };
    competitorDistances.push({
      competitor: c.name,
      gapScores: scores,
      recommendationDistance: sumGapScores(scores),
      topReasons: buildBaselineTopReasons(c.name, scores),
      evidenceStrength: evidenceStrengthFromScores(scores),
    });
  });

  // Prompt nodes for probes where at least one focus competitor appears and
  // the client lost / partial / not mentioned.
  const affectedPromptsByDim: Record<keyof GapScores, Set<string>> = {
    prompt_loss: new Set(),
    citation: new Set(),
    review: new Set(),
    comparison_content: new Set(),
    proof: new Set(),
    entity_clarity: new Set(),
  };

  input.probeResults.forEach((p, i) => {
    const mentions = Array.isArray(p.competitorsMentioned)
      ? (p.competitorsMentioned as CompetitorMention[])
      : [];
    const relevantCompetitors = mentions.filter((m) =>
      competitorIdByKey.has(normalizeName(m.name))
    );
    if (relevantCompetitors.length === 0) return;

    const promptLabel = truncateLabel(p.prompt ?? `Prompt ${i + 1}`, 90);
    const promptId = safeId("prompt", p.id, i);
    addNode({ id: promptId, label: promptLabel, type: "prompt" });

    for (const m of relevantCompetitors) {
      const compId = competitorIdByKey.get(normalizeName(m.name))!;
      edges.push({
        from: compId,
        to: promptId,
        type: "recommended_in",
        weight: 1,
      });
    }

    const clientLostHere =
      !p.clientMentioned || p.verdict === "lost" || p.verdict === "partial";
    if (clientLostHere && p.generatedPromptId) {
      affectedPromptsByDim.prompt_loss.add(p.generatedPromptId);
    }

    const sources = Array.isArray(p.sourcesCited)
      ? (p.sourcesCited as SourceCitation[])
      : [];
    sources.forEach((s, si) => {
      if (!s?.source) return;
      const srcId = safeId("src", `${s.type}-${s.source}`, i * 100 + si);
      addNode({
        id: srcId,
        label: truncateLabel(s.source, 60),
        type: "external_source",
      });
      for (const m of relevantCompetitors) {
        const compId = competitorIdByKey.get(normalizeName(m.name))!;
        edges.push({
          from: srcId,
          to: compId,
          type: "cited_by",
          weight: 1,
        });
      }
      if (s.type === "review_site" && p.generatedPromptId) {
        affectedPromptsByDim.review.add(p.generatedPromptId);
      }
      if ((s.type === "vendor_site" || s.type === "blog") && p.generatedPromptId) {
        affectedPromptsByDim.comparison_content.add(p.generatedPromptId);
      }
      if (p.generatedPromptId) {
        affectedPromptsByDim.citation.add(p.generatedPromptId);
      }
    });
  });

  // Gap nodes: pick top 2 dimensions across focus competitors (sum of scores).
  const dimensionTotals = new Map<keyof GapScores, number>();
  for (const d of competitorDistances) {
    for (const dim of GAP_DIMENSIONS) {
      dimensionTotals.set(
        dim,
        (dimensionTotals.get(dim) ?? 0) + d.gapScores[dim]
      );
    }
  }
  const topDims = [...dimensionTotals.entries()]
    .filter(([, total]) => total > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([dim]) => dim);

  for (const dim of topDims) {
    const gapId = safeId("gap", dim, 0);
    addNode({ id: gapId, label: HUMAN_TYPE[dim], type: "gap" });
    for (const d of competitorDistances) {
      if (d.gapScores[dim] > 0) {
        const compId = competitorIdByKey.get(normalizeName(d.competitor));
        if (!compId) continue;
        edges.push({
          from: compId,
          to: gapId,
          type: "gap",
          weight: d.gapScores[dim],
        });
      }
    }
  }

  // Prioritized gaps: aggregate competitors with each dimension score >= 6.
  const prioritizedGaps: PrioritizedGap[] = buildPrioritizedGapsFromEvidence({
    competitorDistances,
    competitorEvidence: input.competitorEvidence,
    fallbackAffectedPrompts: affectedPromptsByDim,
    explanationSuffix: ".",
  });

  competitorDistances.sort(
    (a, b) =>
      b.recommendationDistance - a.recommendationDistance ||
      a.competitor.localeCompare(b.competitor)
  );

  return {
    clientNode,
    nodes,
    edges,
    competitorDistances,
    prioritizedGaps,
  };
}

function truncateLabel(s: string, max: number): string {
  const cleaned = s.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned || "(unlabelled)";
  return cleaned.slice(0, max - 1) + "…";
}
