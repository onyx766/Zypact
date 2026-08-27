/**
 * M5-A — the analysis leg, D-028 compliant.
 *
 * This module exists because M5 may not reuse the legacy analysis agent.
 * `ProbeAnalysisOutputSchema` is built around `verdict`
 * (`won`/`partial`/`lost`), a vocabulary M5 never computes and that
 * CLAUDE.md's product boundary forbids outright. `persist_probe_result_
 * for_job` (0054) writes `product_verdict = 'not_evaluated'` for exactly
 * that reason.
 *
 * So the model here is asked for four keys and nothing else
 * (`ProbeAnalysisM5OutputSchema`), and the nine keys the RPC validates
 * are *derived*, never requested:
 *
 *   productPosition        ← clientPosition, identity
 *   productMentioned       ← productPosition !== "absent"        (0054 §invariant 1)
 *   negativeClaimDetected  ← productPosition === "negative"      (0054 §invariant 2)
 *   competitorsMentioned   ← model, minus AI-platform names      (Sprint 13C)
 *   sourcesCited           ← model, identity
 *   answerSummary          ← model, identity
 *   clientSourceCount      ← sourcesCited ∩ the project's domain
 *   citedAsSource          ← clientSourceCount > 0               (0054 §invariant 3)
 *   platformsReferenced    ← sourcesCited ONLY                   (0054 §invariant 4)
 *
 * `platformsReferenced` deserves the emphasis: it is derived from the
 * cited sources alone. Never from the competitor list, never from
 * `classifyProductRecommendation`, never from a model guess. 0054
 * requires every entry to be a substring of some cited source, so
 * deriving it from anything else can only produce rows the database
 * refuses — or, worse, a claim no evidence supports.
 */

import { AI_PLATFORM_NAMES, isAiPlatformName } from "@/lib/ai-platforms/platform-registry";
import {
  parseAnalysisContentOnce,
  type ParseAnalysisContentResult,
} from "@/lib/pipeline/parse-analysis-content";
import {
  PersistProbeResultForJobContentSchema,
  ProbeAnalysisM5OutputSchema,
  type PersistProbeResultForJobContent,
} from "@/lib/schemas/probe-analysis-m5.schema";
import type { z, ZodSchema } from "zod";

/**
 * The *parsed* M5 output — `z.output`, not `z.infer`.
 *
 * `SourceCitationSchema.type` is a `z.preprocess`, so its input side is
 * `unknown` (an LLM may emit "Review Site", "youtube", …) while its
 * output side is the strict six-value enum. Everything downstream works
 * on values that already went through the schema, so the output type is
 * the only correct one here.
 */
export type ProbeAnalysisM5Parsed = z.output<typeof ProbeAnalysisM5OutputSchema>;

/**
 * The system prompt. It names the four keys, defines `clientPosition`
 * without any win/loss framing, and never mentions a verdict — asking for
 * one would put the forbidden vocabulary into the evidence itself.
 */
export const PROBE_ANALYSIS_M5_SYSTEM_PROMPT = `You are an evidence extraction assistant.

You read one AI assistant answer and report what it literally contains. You do not judge outcomes, score performance, or rate anyone's success. You only describe what is present in the text.

Return ONLY a JSON object with EXACTLY these four keys:

{
  "clientPosition": "primary" | "listed" | "negative" | "absent",
  "competitorsMentioned": [{ "name": string, "position": integer >= 1, "context": string }],
  "sourcesCited": [{ "source": string, "type": "review_site" | "blog" | "forum" | "vendor_site" | "news" | "other" }],
  "answerSummary": string
}

clientPosition — how the client company appears in the answer:
  "primary"  the answer recommends or foregrounds the client above others
  "listed"   the client appears among other options, without being foregrounded
  "negative" the client appears and the answer states something unfavourable about it
  "absent"   the client does not appear at all

competitorsMentioned — other named companies or products, in the order they first appear ("position" is that 1-based rank). "context" is a short literal excerpt, 500 characters at most.

sourcesCited — every source the answer cites, as written. Classify each with one of the six listed types; use "other" when unsure.

answerSummary — a neutral factual summary of the answer, 4000 characters at most.

Rules:
  - Output raw JSON only. No prose, no markdown fence.
  - Exactly the four keys above. Any additional key is an error.
  - Report only what the answer contains. Never infer, never extrapolate.
  - At most 50 competitors and 50 sources.`;

export interface ProbeAnalysisM5Input {
  /** The buyer question exactly as sent to the provider. */
  prompt: string;
  /** The provider's answer text. */
  aiResponse: string;
  /** The client company as named on the project. */
  clientName: string;
  /** The client's domain, used only to count client-owned sources. */
  domain: string;
}

/** Pure: builds the call. No I/O, no clock, no randomness. */
export function buildProbeAnalysisM5Call(input: ProbeAnalysisM5Input): {
  system: string;
  user: string;
  jsonMode: true;
  temperature: number;
  maxTokens: number;
  mockResponse: string;
} {
  const user = [
    `CLIENT COMPANY: ${input.clientName}`,
    `CLIENT DOMAIN: ${input.domain}`,
    "",
    "BUYER QUESTION:",
    input.prompt,
    "",
    "AI ASSISTANT ANSWER:",
    input.aiResponse,
  ].join("\n");

  return {
    system: PROBE_ANALYSIS_M5_SYSTEM_PROMPT,
    user,
    jsonMode: true,
    temperature: 0,
    maxTokens: 2000,
    mockResponse: JSON.stringify(buildMockProbeAnalysisM5()),
  };
}

/**
 * The mock reply. Deliberately the emptiest valid shape: a simulated call
 * must never manufacture a mention, a competitor or a source that no
 * provider ever returned.
 */
export function buildMockProbeAnalysisM5(): ProbeAnalysisM5Parsed {
  return {
    clientPosition: "absent",
    competitorsMentioned: [],
    sourcesCited: [],
    answerSummary: "",
  };
}

/**
 * Pure: exactly one parse attempt. No retry, hidden or otherwise.
 *
 * The cast pins the schema's *output* side. `ZodSchema<T>` defaults its
 * input parameter to `T`, so inference would otherwise settle on the
 * loose input type (`type?: unknown`, before the preprocess normalizes
 * it). Narrowing to the output type is sound because
 * `parseAnalysisContentOnce` feeds the schema an `unknown` and returns
 * only what `.parse` produced — which is exactly `ProbeAnalysisM5Parsed`.
 */
export function parseProbeAnalysisM5Content(
  rawContent: string
): ParseAnalysisContentResult<ProbeAnalysisM5Parsed> {
  return parseAnalysisContentOnce<ProbeAnalysisM5Parsed>(
    rawContent,
    ProbeAnalysisM5OutputSchema as unknown as ZodSchema<ProbeAnalysisM5Parsed>,
    rejectKeysOutsideTheFour
  );
}

/** The four keys the model is allowed to return, and no others. */
const M5_OUTPUT_KEYS = Object.freeze([
  "clientPosition",
  "competitorsMentioned",
  "sourcesCited",
  "answerSummary",
]);

/**
 * `ProbeAnalysisM5OutputSchema` is a plain `z.object`, so Zod would
 * silently *strip* an unexpected key rather than refuse it. Stripping is
 * the wrong behaviour here: if the model returned a `verdict`, the
 * evidence must record that the contract was broken, not quietly discard
 * the field and persist the rest. Throwing turns it into
 * `normalization_failed`, a durable, closed parse-failure code.
 */
function rejectKeysOutsideTheFour(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const extra = Object.keys(parsed).filter((k) => !M5_OUTPUT_KEYS.includes(k));
  if (extra.length > 0) {
    // Key names only — never a value, which could carry answer text.
    throw new Error(`unexpected keys in M5 analysis output: ${extra.sort().join(",")}`);
  }
  return parsed;
}

/**
 * Mirrors `sourceMatchesDomain` in `lib/probe-analysis/product-
 * recommendation.ts`: same rule, reimplemented here so the M5 path never
 * has to import a module whose public surface carries the legacy
 * outcome vocabulary.
 */
export function sourceBelongsToDomain(source: string, domain: string): boolean {
  const d = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
  if (!d) return false;
  const s = source
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "");
  return s === d || s.startsWith(`${d}/`) || s.includes(`.${d}/`);
}

/**
 * Every AI platform actually visible in the cited sources.
 *
 * The registry is a closed constant list, and a name is kept only when a
 * cited source literally contains it — which is exactly 0054's
 * `lower(source) like '%' || lower(plat) || '%'` check, so the result
 * satisfies the invariant by construction rather than by hope.
 */
export function platformsReferencedFromSources(
  sources: ReadonlyArray<{ source: string }>
): string[] {
  const lowered = sources.map((s) => s.source.toLowerCase());
  const out: string[] = [];
  for (const name of AI_PLATFORM_NAMES) {
    const needle = name.toLowerCase();
    if (lowered.some((s) => s.includes(needle))) out.push(name);
  }
  return out;
}

/**
 * Derives the nine persisted keys from the four the model produced.
 *
 * Returns null when the derived object somehow fails its own schema —
 * the caller then treats that as a normalization failure rather than
 * sending the RPC a payload it would reject.
 */
export function deriveProbeResultContent(
  output: ProbeAnalysisM5Parsed,
  domain: string
): PersistProbeResultForJobContent | null {
  const productPosition = output.clientPosition;
  const sourcesCited = output.sourcesCited.map((s) => ({ source: s.source, type: s.type }));
  const clientSourceCount = sourcesCited.filter((s) =>
    sourceBelongsToDomain(s.source, domain)
  ).length;

  const candidate = {
    productMentioned: productPosition !== "absent",
    productPosition,
    // Sprint 13C — an answer engine is not a product competitor.
    competitorsMentioned: output.competitorsMentioned
      .filter((c) => !isAiPlatformName(c.name))
      .map((c) => ({ name: c.name, position: c.position, context: c.context })),
    sourcesCited,
    answerSummary: output.answerSummary,
    citedAsSource: clientSourceCount > 0,
    clientSourceCount,
    platformsReferenced: platformsReferencedFromSources(sourcesCited),
    negativeClaimDetected: productPosition === "negative",
  };

  const parsed = PersistProbeResultForJobContentSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
