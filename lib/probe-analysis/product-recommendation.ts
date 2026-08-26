import type { ClientPosition, SourceCitation } from "@/lib/schemas/probe-analysis.schema";
import { isAiPlatformName } from "@/lib/ai-platforms/platform-registry";

export type ProductRecommendationPosition = "primary" | "listed" | "negative" | "absent";
export type ProductRecommendationVerdict = "won" | "partial" | "lost" | "not_relevant";

/**
 * M3 reliquat (D-014 §9) — the only sanctioned mapping from this
 * deterministic position signal to the canonical run-level vocabulary.
 * Deliberately total and deliberately narrow: every `ProductRecommendationPosition`
 * maps to exactly one of these three values, and the return type
 * structurally cannot include `ambiguous_in_run` or `analysis_failed` —
 * no branch here may ever produce them. Those two values have no
 * deterministic source in this pipeline today; inventing one is out of
 * scope for this fix (see METHODOLOGY.md §9 and the M3 closure notes).
 */
export type DeterministicRunPosition =
  | "primary_in_run"
  | "listed_in_run"
  | "not_observed_in_run";

export function mapProductPositionToRunPosition(
  position: ProductRecommendationPosition
): DeterministicRunPosition {
  switch (position) {
    case "primary":
      return "primary_in_run";
    case "listed":
      return "listed_in_run";
    case "negative":
      // D-014 v1.1: a negative mention is still `listed_in_run` — sentiment
      // is tracked separately via `negativeClaimDetected`, never as its own
      // position label.
      return "listed_in_run";
    case "absent":
      return "not_observed_in_run";
  }
}

export interface ProductRecommendationInput {
  prompt: string;
  rawResponse: string;
  brandTerms: string[];
  domain?: string | null;
  competitorsMentioned?: Array<{ name?: string; position?: number; context?: string }>;
  sourcesCited?: SourceCitation[];
  /**
   * Sprint 14A.1 — authoritative LLM classification. The LLM is allowed
   * to decide only the client's position in the answer; product
   * recommendation booleans and verdicts are derived deterministically.
   */
  clientPosition?: ClientPosition;
}

export interface ProductRecommendationSignals {
  productMentioned: boolean;
  productPosition: ProductRecommendationPosition;
  productVerdict: ProductRecommendationVerdict;
  citedAsSource: boolean;
  clientSourceCount: number;
  platformReferences: string[];
  directCompetitorsMentioned: Array<{ name?: string; position?: number; context?: string }>;
}

const RECOMMENDATION_HINTS = /\b(recommend|recommends|recommended|best|top|tool|tools|platform|platforms|software|solution|solutions|alternative|alternatives|shortlist|use|try|consider|pick|choice|option)\b/i;
const NEGATIVE_HINTS = /\b(not recommended|avoid|weak|inferior|poor fit|not a good fit|lacks|missing|without)\b/i;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(value: string): string {
  return value.replace(/[*_`~>#\[\]()]/g, " ").replace(/\s+/g, " ").trim();
}

function splitAnswerBody(rawResponse: string): string {
  const markers = [
    "\nPerplexity citations:",
    "\nPerplexity search results:",
    "\nSources:",
    "\nCitations:",
  ];
  let end = rawResponse.length;
  for (const marker of markers) {
    const idx = rawResponse.indexOf(marker);
    if (idx >= 0 && idx < end) end = idx;
  }
  return rawResponse.slice(0, end).trim();
}

function normalizeBrandTerms(terms: string[], domain?: string | null): string[] {
  const out = new Set<string>();
  for (const raw of [...terms, domain ?? ""]) {
    const term = raw.trim();
    if (!term || term.length < 3) continue;
    out.add(term);
    const host = term.replace(/^https?:\/\//, "").split("/")[0] ?? term;
    if (host && host.length >= 3) out.add(host);
    const stem = host.split(".")[0]?.trim();
    if (stem && stem.length >= 3) out.add(stem);
  }
  return [...out];
}

function firstTermIndex(text: string, terms: string[]): number {
  let first = -1;
  for (const term of terms) {
    const t = term.trim();
    if (!t) continue;
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(t)}([^a-z0-9]|$)`, "i");
    const m = re.exec(text);
    if (m && (first < 0 || m.index < first)) first = m.index;
  }
  return first;
}

function sourceMatchesDomain(source: string, domain?: string | null): boolean {
  const d = domain?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  if (!d) return false;
  const s = source.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
  return s === d || s.startsWith(`${d}/`) || s.includes(`.${d}/`);
}

function unique(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const clean = v.trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

export function classifyProductRecommendation(
  input: ProductRecommendationInput,
): ProductRecommendationSignals {
  const body = normalizeText(splitAnswerBody(input.rawResponse));
  const brandTerms = normalizeBrandTerms(input.brandTerms, input.domain);
  const clientFirstIdx = firstTermIndex(body, brandTerms);
  const authoritativePosition = input.clientPosition;
  const productMentioned = authoritativePosition
    ? authoritativePosition === "primary" || authoritativePosition === "listed"
    : clientFirstIdx >= 0;
  const allMentions = Array.isArray(input.competitorsMentioned)
    ? input.competitorsMentioned
    : [];
  const directCompetitorsMentioned = allMentions.filter((c) => {
    const name = typeof c.name === "string" ? c.name.trim() : "";
    return name.length > 0 && !isAiPlatformName(name);
  });
  const platformReferences = unique(
    allMentions
      .map((c) => (typeof c.name === "string" ? c.name.trim() : ""))
      .filter((name) => name && isAiPlatformName(name)),
  );

  const sources = Array.isArray(input.sourcesCited) ? input.sourcesCited : [];
  const clientSourceCount = sources.filter((s) => sourceMatchesDomain(s.source, input.domain)).length;
  const citedAsSource = clientSourceCount > 0;

  let productPosition: ProductRecommendationPosition = "absent";
  if (authoritativePosition) {
    productPosition = authoritativePosition;
  } else if (productMentioned) {
    const window = body.slice(Math.max(0, clientFirstIdx - 220), clientFirstIdx + 320);
    const competitorFirst = (() => {
      let first = -1;
      for (const c of directCompetitorsMentioned) {
        const name = typeof c.name === "string" ? c.name : "";
        if (!name) continue;
        const idx = firstTermIndex(body, [name]);
        if (idx >= 0 && (first < 0 || idx < first)) first = idx;
      }
      return first;
    })();
    if (NEGATIVE_HINTS.test(window)) productPosition = "negative";
    else if (RECOMMENDATION_HINTS.test(window) && (competitorFirst < 0 || clientFirstIdx <= competitorFirst)) productPosition = "primary";
    else productPosition = "listed";
  }

  let productVerdict: ProductRecommendationVerdict = "not_relevant";
  if (productPosition === "primary") productVerdict = "won";
  else if (productPosition === "listed") productVerdict = "partial";
  else if (productPosition === "negative") productVerdict = "lost";
  else if (directCompetitorsMentioned.length > 0) productVerdict = "lost";
  else if (RECOMMENDATION_HINTS.test(body)) productVerdict = "lost";

  return {
    productMentioned,
    productPosition,
    productVerdict,
    citedAsSource,
    clientSourceCount,
    platformReferences,
    directCompetitorsMentioned,
  };
}

export function probeRequestLeaksClientIdentity(args: {
  rawRequest: string;
  originalPrompt: string;
  brandTerms: string[];
  domain?: string | null;
}): boolean {
  const requestWithoutPrompt = args.rawRequest.replace(args.originalPrompt, "");
  const text = normalizeText(requestWithoutPrompt);
  const terms = normalizeBrandTerms(args.brandTerms, args.domain);
  return firstTermIndex(text, terms) >= 0;
}
