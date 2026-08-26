import type { Competitor, ProbeResult } from "@/lib/db/types";
import { buildPromptProbeAggregates } from "@/lib/probe-results/report-selection";
import type { SiteReaderOutput } from "@/lib/schemas/site-reader.schema";
import type {
  SourceCitation,
} from "@/lib/schemas/probe-analysis.schema";
import type { GapScores } from "@/lib/schemas/gap-map.schema";
import type { ResolvedCompetitorMention } from "@/lib/evidence/get-resolved-competitor-mentions";

/**
 * Deterministic gap scoring.
 *
 * Sprint 13A.2 rule: the numeric truth of prompt_loss and citation must be
 * computed from probe aggregates, not invented by the Gap Map LLM. The model
 * can help with wording, but scores and baseline reasons are grounded here.
 */

/* -------------------------------------------------------------------------- */
/*  Normalization                                                             */
/* -------------------------------------------------------------------------- */

export function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\.(com|io|ai|co|net|org)\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeUrlHost(value: string | null | undefined): string {
  if (!value) return "";
  try {
    const raw = value.startsWith("http") ? value : `https://${value}`;
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return value.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] ?? "";
  }
}

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface BaselineScoreRow extends GapScores {
  recommendationDistance: number;
}

export type BaselineScores = Record<string, BaselineScoreRow>;

export interface ComputeGapScoresInput {
  mirrorProfile: SiteReaderOutput;
  probeResults: ProbeResult[];
  competitors: Competitor[];
  /**
   * M3 — source unique, Option A: resolved competitor mentions per
   * `probe_result.id`, from the M2 canonical entity-resolution layer.
   * `collectCompetitorSignals` matches a probe's mentions to a competitor
   * by `canonicalEntityId` equality when the competitor has one — never
   * by name normalization. Mandatory, not optional: every caller must
   * explicitly decide what this map contains, even "empty, nothing
   * resolved yet" for a given probe_result.
   */
  resolvedMentionsByProbeResult: ReadonlyMap<string, ResolvedCompetitorMention[]>;
}

export interface CompetitorSignals {
  /** Number of prompt groups where this competitor appears at least once. */
  appearances: number;
  /** Number of prompt groups where the client lost/underperformed while this competitor appeared. */
  clientLostWhenAppears: number;
  citedSources: Set<string>;
  directlyNamedSources: Set<string>;
  reviewSources: number;
  vendorOrBlogSources: number;
  inComparisonPrompt: boolean;
  proofSignalCount: number;
  hasSummaryDescription: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Signals derived from Mirror Profile                                       */
/* -------------------------------------------------------------------------- */

const COMPARISON_MISSING_HINTS = /\b(compar|alternat|vs\b|review|g2|capterra)/i;
const PROOF_TERMS =
  /\b(customer|customers|reviews?|case stud|ratings?|g2|capterra|soc\s?2|iso\s?27001|funding|series [a-e]|enterprise|f500|fortune)/i;
const COMPARISON_PROMPT_RE = /\b(alternat|compar|vs\b|versus|comparison)/i;

function hasClientComparisonMissingSignal(profile: SiteReaderOutput): boolean {
  return profile.missingSignals.some(
    (m) =>
      COMPARISON_MISSING_HINTS.test(m.signal) ||
      COMPARISON_MISSING_HINTS.test(m.whyItMatters)
  );
}

function clientProofIsWeak(profile: SiteReaderOutput): boolean {
  return profile.proofSignals.length < 3;
}

/* -------------------------------------------------------------------------- */
/*  Per-competitor derived signals                                            */
/* -------------------------------------------------------------------------- */

function sourceDirectlyNamesCompetitor(
  src: SourceCitation,
  competitorName: string,
  competitorWebsite: string | null,
): boolean {
  const source = (src.source ?? "").toLowerCase();
  const key = normalizeName(competitorName);
  const websiteHost = normalizeUrlHost(competitorWebsite);
  const sourceHost = normalizeUrlHost(source);

  if (key && normalizeName(source).includes(key)) return true;
  if (websiteHost && sourceHost && (sourceHost === websiteHost || sourceHost.endsWith(`.${websiteHost}`))) {
    return true;
  }
  return false;
}

export function collectCompetitorSignals(
  competitor: Pick<Competitor, "name" | "website" | "canonicalEntityId">,
  probes: ProbeResult[],
  resolvedMentionsByProbeResult: ReadonlyMap<string, ResolvedCompetitorMention[]>
): CompetitorSignals {
  const s: CompetitorSignals = {
    appearances: 0,
    clientLostWhenAppears: 0,
    citedSources: new Set(),
    directlyNamedSources: new Set(),
    reviewSources: 0,
    vendorOrBlogSources: 0,
    inComparisonPrompt: false,
    proofSignalCount: 0,
    hasSummaryDescription: false,
  };

  // M3 — source unique, Option A: a competitor's mentions are the resolved,
  // canonical-entity mentions carrying its OWN canonicalEntityId — matched
  // by exact equality, never by name normalization. A competitor row with
  // no canonical_entity_id (declared by the user, discovered on the
  // client's own site, or an ai_answer name the discovery agent
  // paraphrased past an exact match) has no mentions here at all: every
  // mention-derived signal below stays at its zero default for it,
  // honestly, rather than falling back to a name guess.
  const canonicalEntityId = competitor.canonicalEntityId;
  function resolvedMentionsFor(p: ProbeResult): ResolvedCompetitorMention[] {
    if (!canonicalEntityId) return [];
    const mentions = resolvedMentionsByProbeResult.get(p.id) ?? [];
    return mentions.filter((m) => m.canonicalEntityId === canonicalEntityId);
  }

  // Sprint 13A.3: prompt_loss is a prompt-group truth, not a single-run truth.
  // One volatile Perplexity run should affect mentionRate, but it must not
  // let the Gap Map claim "Linear is absent" when the prompt group is won.
  const groups = buildPromptProbeAggregates(probes);
  for (const group of groups) {
    const rowsWhereCompetitorAppears = group.rows.filter(
      (p) => resolvedMentionsFor(p).length > 0
    );
    if (rowsWhereCompetitorAppears.length === 0) continue;

    s.appearances += 1;
    if (group.verdict === "lost" || group.verdict === "partial") {
      s.clientLostWhenAppears += 1;
    }

    for (const p of rowsWhereCompetitorAppears) {
      const sources = Array.isArray(p.sourcesCited)
        ? (p.sourcesCited as SourceCitation[])
        : [];
      for (const src of sources) {
        if (!src?.source) continue;
        const normalized = src.source.trim().toLowerCase();
        s.citedSources.add(normalized);
        if (sourceDirectlyNamesCompetitor(src, competitor.name, competitor.website)) {
          s.directlyNamedSources.add(normalized);
          if (src.type === "review_site") s.reviewSources += 1;
          if (src.type === "vendor_site" || src.type === "blog") {
            s.vendorOrBlogSources += 1;
          }
        }
      }

      if (COMPARISON_PROMPT_RE.test(p.prompt ?? "")) {
        s.inComparisonPrompt = true;
      }

      for (const m of resolvedMentionsFor(p)) {
        if (PROOF_TERMS.test(m.context ?? "")) s.proofSignalCount += 1;
      }

      const summary = p.answerSummary ?? "";
      if (summary.length > 0 && summary.toLowerCase().includes(competitor.name.toLowerCase())) {
        s.hasSummaryDescription = true;
      }
    }
  }

  return s;
}

/* -------------------------------------------------------------------------- */
/*  Scoring                                                                   */
/* -------------------------------------------------------------------------- */

function scorePromptLoss(s: CompetitorSignals, totalPromptGroups: number): number {
  if (s.appearances === 0 || totalPromptGroups === 0) return 0;
  const rate = s.clientLostWhenAppears / totalPromptGroups;
  if (rate >= 0.5) return 10;
  if (rate >= 0.2) return 6;
  if (rate > 0) return 3;
  return 0;
}

function scoreCitation(s: CompetitorSignals): number {
  const n = s.directlyNamedSources.size;
  if (n === 0) return 0;
  if (n === 1) return 4;
  if (n <= 3) return 7;
  return 10;
}

function scoreReview(s: CompetitorSignals): number {
  if (s.reviewSources === 0) return 0;
  if (s.reviewSources === 1) return 7;
  return 10;
}

function scoreComparisonContent(
  s: CompetitorSignals,
  clientHasComparisonMissing: boolean
): number {
  const implied = s.vendorOrBlogSources > 0 || s.inComparisonPrompt;
  if (!implied && !clientHasComparisonMissing) return 0;
  if (s.inComparisonPrompt && clientHasComparisonMissing && s.clientLostWhenAppears > 0) return 10;
  if (implied) return 5;
  return 0;
}

function scoreProof(s: CompetitorSignals, clientProofWeak: boolean): number {
  if (s.proofSignalCount === 0) return 0;
  if (s.proofSignalCount >= 2 && clientProofWeak) return 10;
  return 5;
}

function scoreEntityClarity(
  s: CompetitorSignals,
  categoryConfidence: SiteReaderOutput["categoryConfidence"]
): number {
  if (categoryConfidence === "high") return 0;
  if (categoryConfidence === "medium") return 5;
  if (s.hasSummaryDescription) return 10;
  return 8;
}

function toIntClamp(n: number, min: number, max: number): number {
  const v = Math.round(n);
  if (Number.isNaN(v)) return min;
  return Math.max(min, Math.min(max, v));
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

export function computeGapScores(input: ComputeGapScoresInput): BaselineScores {
  const totalPromptGroups = buildPromptProbeAggregates(input.probeResults).length;
  const comparisonMissing = hasClientComparisonMissingSignal(input.mirrorProfile);
  const proofWeak = clientProofIsWeak(input.mirrorProfile);
  const confidence = input.mirrorProfile.categoryConfidence;

  const out: BaselineScores = {};
  for (const c of input.competitors) {
    const signals = collectCompetitorSignals(c, input.probeResults, input.resolvedMentionsByProbeResult);
    const scores: GapScores = {
      prompt_loss: toIntClamp(scorePromptLoss(signals, totalPromptGroups), 0, 10),
      citation: toIntClamp(scoreCitation(signals), 0, 10),
      review: toIntClamp(scoreReview(signals), 0, 10),
      comparison_content: toIntClamp(scoreComparisonContent(signals, comparisonMissing), 0, 10),
      proof: toIntClamp(scoreProof(signals, proofWeak), 0, 10),
      entity_clarity: toIntClamp(scoreEntityClarity(signals, confidence), 0, 10),
    };
    const recommendationDistance = sumGapScores(scores);
    out[c.name] = { ...scores, recommendationDistance };
  }
  return out;
}

export function sumGapScores(scores: GapScores): number {
  return (
    scores.prompt_loss +
    scores.citation +
    scores.review +
    scores.comparison_content +
    scores.proof +
    scores.entity_clarity
  );
}
