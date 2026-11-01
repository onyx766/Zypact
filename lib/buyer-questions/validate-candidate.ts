/**
 * Hard candidate rules (D-039, design sections 4, 6 and 9) and the
 * provisional review signals of plan section 4.2.
 *
 * A grade and its verification status are set by the evidence links. No
 * signal refuses a candidate or changes its grade.
 */

import { brandPresence } from "./brand-match";
import { marketingSignal, type MarketingTrigger } from "./marketing-signal";
import { codePointLength, differsOnlyByUnicodeNormalization, isObservedMatch } from "./normalize";
import {
  isSellerSource,
  possiblePersonalDataSignal,
  sourceVerification,
  validateSource,
  type SourceValidation,
} from "./validate-source";
import {
  BUYER_STAGES,
  LINK_RELATIONS,
  MAX_CANDIDATES_PER_RESEARCH_SET,
  QUESTION_KINDS,
  isEvidenceGrade,
  type Candidate,
  type CandidateSourceLink,
  type QuestionSource,
  type Rating,
  type Refusal,
  type ResearchSet,
  type Signal,
  type SiteContext,
  type Verification,
} from "./types";

/** Question shape thresholds v1, in code points. */
export const QUESTION_LENGTH_MIN_V1 = 15;
export const QUESTION_LENGTH_MAX_V1 = 250;

const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/u;

export type BrandStatus = "absent" | "present" | "unresolved";

export interface CandidateValidation {
  candidateId: string;
  refusals: Refusal[];
  signals: Signal[];
  /**
   * The primary source's verification. Null for a hypothesis, for a
   * refused candidate, or while the primary source is unresolved.
   */
  verification: Verification | null;
  /** Each valid supporting source with its own status, never merged into one. */
  sourceVerifications: SourceEvidence[];
  primarySourceId: string | null;
  /** Observed or adapted evidence exists but no primary source is identified. */
  primaryUnresolved: boolean;
  /** Whether the brand (branded accuracy) or any brand or product name (unbranded) is present. */
  brandStatus: BrandStatus;
  marketing: { flagged: boolean; triggers: MarketingTrigger[]; resolved: boolean };
}

/** The span a link quotes: the given span, or the whole excerpt. */
export function linkedSpan(link: CandidateSourceLink, source: QuestionSource): string {
  return typeof link.quotedSpan === "string" ? link.quotedSpan : source.excerpt;
}

function ratingIsValid(rating: Rating | undefined): boolean {
  return (
    rating !== undefined &&
    rating !== null &&
    Number.isInteger(rating.value) &&
    rating.value >= 0 &&
    rating.value <= 3 &&
    typeof rating.reason === "string" &&
    rating.reason.trim().length > 0
  );
}

/** Provisional question-shape signals v1. Never refusals. */
export function questionShapeSignals(text: string): Signal[] {
  const signals: Signal[] = [];
  const length = codePointLength(text);
  if (length < QUESTION_LENGTH_MIN_V1 || length > QUESTION_LENGTH_MAX_V1) {
    signals.push({ code: "length_unusual", detail: `${length} code points` });
  }
  if (!text.trim().endsWith("?")) signals.push({ code: "not_phrased_as_question" });
  if (LINE_BREAK.test(text)) signals.push({ code: "contains_line_break" });
  const personal = possiblePersonalDataSignal(text);
  if (personal !== null) signals.push(personal);
  return signals;
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

/**
 * True when `span` occurs in `excerpt` at least once with no letter,
 * digit or combining mark directly before or after it, so a quote never
 * starts or ends inside a word.
 */
export function spanAtWordBoundary(excerpt: string, span: string): boolean {
  if (span.length === 0) return false;
  for (let at = excerpt.indexOf(span); at !== -1; at = excerpt.indexOf(span, at + 1)) {
    const before = [...excerpt.slice(0, at)].pop();
    const after = [...excerpt.slice(at + span.length)][0];
    if ((before === undefined || !WORD_CHAR.test(before)) && (after === undefined || !WORD_CHAR.test(after))) return true;
  }
  return false;
}

/** Null when the link's quoted span is usable; otherwise the refusal code. */
export function quotedSpanProblem(
  link: CandidateSourceLink,
  source: QuestionSource
): "quoted_span_not_in_excerpt" | "quoted_span_not_word_aligned" | null {
  if (typeof link.quotedSpan !== "string") return null;
  if (link.quotedSpan.length === 0 || !source.excerpt.includes(link.quotedSpan)) return "quoted_span_not_in_excerpt";
  return spanAtWordBoundary(source.excerpt, link.quotedSpan) ? null : "quoted_span_not_word_aligned";
}

export interface SourceEvidence {
  sourceId: string;
  relation: "verbatim" | "paraphrase_basis";
  verification: Verification;
}

/**
 * Validates one candidate against its own links. A linked source's
 * validation is taken from `sourceValidations` when it has an entry for
 * that source; otherwise the source is validated here. A missing or
 * incomplete map never makes a source count as valid (fail closed).
 */
export function validateCandidate(
  candidate: Candidate,
  links: readonly CandidateSourceLink[],
  sources: readonly QuestionSource[],
  siteContext: SiteContext,
  sourceValidations?: ReadonlyMap<string, SourceValidation>
): CandidateValidation {
  const refusals: Refusal[] = [];
  const signals: Signal[] = [];
  const text = typeof candidate.text === "string" ? candidate.text : "";
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const sourceIdCount = new Map<string, number>();
  for (const s of sources) sourceIdCount.set(s.id, (sourceIdCount.get(s.id) ?? 0) + 1);
  const ownLinks = links.filter((l) => l.candidateId === candidate.id);

  if (text.trim().length === 0) refusals.push({ code: "question_text_empty" });
  if (!isEvidenceGrade(candidate.grade)) refusals.push({ code: "unknown_grade" });
  if (!(QUESTION_KINDS as readonly string[]).includes(candidate.kind)) refusals.push({ code: "unknown_question_kind" });
  if (!(BUYER_STAGES as readonly string[]).includes(candidate.buyerStage)) refusals.push({ code: "unknown_buyer_stage" });
  if (!Number.isInteger(candidate.curatorRank)) refusals.push({ code: "curator_rank_invalid" });

  const ratings = candidate.ratings;
  for (const key of ["buyerRelevance", "icpFit", "commercialIntent", "productRelevance"] as const) {
    if (!ratingIsValid(ratings?.[key])) refusals.push({ code: "rating_invalid", detail: key });
  }

  // Links: every link must name a known source and quote that source exactly.
  const verbatimBuyer: Array<[CandidateSourceLink, QuestionSource]> = [];
  const basisBuyer: Array<[CandidateSourceLink, QuestionSource]> = [];
  for (const link of ownLinks) {
    if (!(LINK_RELATIONS as readonly string[]).includes(link.relation)) {
      refusals.push({ code: "unknown_link_relation", detail: link.sourceId });
      continue;
    }
    const source = sourceById.get(link.sourceId);
    if (source === undefined) {
      refusals.push({ code: "link_to_unknown_source", detail: link.sourceId });
      continue;
    }
    // A colliding id cannot say which source's content was meant.
    if ((sourceIdCount.get(link.sourceId) ?? 0) > 1) {
      refusals.push({ code: "duplicate_source_id", detail: link.sourceId });
      continue;
    }
    const spanProblem = quotedSpanProblem(link, source);
    if (spanProblem !== null) {
      refusals.push({ code: spanProblem, detail: link.sourceId });
      continue;
    }
    if (link.relation === "context") continue;
    if (isSellerSource(source)) {
      refusals.push({ code: "seller_source_only_as_context", detail: link.sourceId });
      continue;
    }
    const sourceCheck = sourceValidations?.get(source.id) ?? validateSource(source);
    if (sourceCheck.refusals.length > 0) {
      refusals.push({ code: "linked_source_refused", detail: link.sourceId });
      continue;
    }
    (link.relation === "verbatim" ? verbatimBuyer : basisBuyer).push([link, source]);
  }

  // The supporting sources: verbatim for observed, paraphrase basis for adapted.
  let supporting: Array<[CandidateSourceLink, QuestionSource]> = [];
  if (candidate.grade === "observed") {
    if (verbatimBuyer.length === 0) {
      refusals.push({ code: "observed_requires_verbatim_buyer_source" });
    } else {
      const mismatched = verbatimBuyer.filter(([link, source]) => !isObservedMatch(text, linkedSpan(link, source)));
      for (const [, source] of mismatched) {
        refusals.push({ code: "observed_text_does_not_match_source", detail: source.id });
      }
      if (mismatched.length === 0) supporting = verbatimBuyer;
    }
  } else if (candidate.grade === "adapted") {
    if (basisBuyer.length === 0) refusals.push({ code: "adapted_requires_paraphrase_basis" });
    if (typeof candidate.adaptationNote !== "string" || candidate.adaptationNote.trim().length === 0) {
      refusals.push({ code: "adapted_requires_note" });
    }
    supporting = basisBuyer;
  }

  // Each source keeps its own status. A candidate-level status comes only
  // from the explicitly identified primary source; the presence of a public
  // link never upgrades it.
  const sourceVerifications: SourceEvidence[] = [];
  for (const [link, source] of supporting) {
    if (!sourceVerifications.some((e) => e.sourceId === source.id)) {
      sourceVerifications.push({
        sourceId: source.id,
        relation: link.relation as SourceEvidence["relation"],
        verification: sourceVerification(source),
      });
    }
  }
  sourceVerifications.sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
  const primaryId = typeof candidate.primarySourceId === "string" ? candidate.primarySourceId : null;
  let verification: Verification | null = null;
  let primaryUnresolved = false;
  if (sourceVerifications.length > 0) {
    if (primaryId === null) {
      primaryUnresolved = true;
      signals.push({ code: "primary_source_unresolved", detail: sourceVerifications.map((e) => e.sourceId).join(",") });
    } else {
      const primary = sourceVerifications.find((e) => e.sourceId === primaryId);
      if (primary === undefined) refusals.push({ code: "primary_source_invalid", detail: primaryId });
      else verification = primary.verification;
    }
  } else if (primaryId !== null && candidate.grade !== "hypothesis") {
    refusals.push({ code: "primary_source_invalid", detail: primaryId });
  }

  // Diagnostic only, at any grade: the text equals a linked buyer-authored
  // span after NFC but not before. It never makes the text observed.
  const nfcOnly = new Set(
    [...verbatimBuyer, ...basisBuyer]
      .filter(([link, source]) => differsOnlyByUnicodeNormalization(text, linkedSpan(link, source)))
      .map(([, source]) => source.id)
  );
  for (const id of [...nfcOnly].sort()) signals.push({ code: "unicode_normalization_differs", detail: id });

  // Brand rules. Full-form, domain and accepted-alias matches decide;
  // an unresolved alias decides nothing and blocks preselection.
  const presence = brandPresence(text, siteContext);
  signals.push(...presence.signals);
  let brandStatus: BrandStatus;
  if (candidate.kind === "branded_accuracy") {
    brandStatus = presence.brandDefinitive ? "present" : presence.brandAliasUnresolved ? "unresolved" : "absent";
    if (brandStatus === "absent") refusals.push({ code: "branded_missing_brand" });
  } else {
    brandStatus = presence.anyNameDefinitive ? "present" : presence.anyNameAliasUnresolved ? "unresolved" : "absent";
    if (brandStatus === "present") refusals.push({ code: "unbranded_contains_brand" });
  }

  signals.push(...questionShapeSignals(text));

  const marketing = marketingSignal(text, siteContext);
  const resolution = candidate.marketingFlagResolution;
  const resolutionSource = resolution ? sourceById.get(resolution.sourceId) : undefined;
  const resolved =
    marketing.flagged &&
    resolution != null &&
    typeof resolution.reason === "string" &&
    resolution.reason.trim().length > 0 &&
    resolutionSource !== undefined &&
    !isSellerSource(resolutionSource) &&
    ownLinks.some((l) => l.sourceId === resolution.sourceId);
  if (marketing.flagged) {
    signals.push({ code: "marketing_language", detail: marketing.triggers.join(",") });
  }

  return {
    candidateId: candidate.id,
    refusals,
    signals,
    verification: refusals.length === 0 ? verification : null,
    sourceVerifications: refusals.length === 0 ? sourceVerifications : [],
    primarySourceId: refusals.length === 0 && verification !== null ? primaryId : null,
    primaryUnresolved: refusals.length === 0 && primaryUnresolved,
    brandStatus,
    marketing: { flagged: marketing.flagged, triggers: marketing.triggers, resolved },
  };
}

export interface ResearchSetValidation {
  refusals: Refusal[];
  sources: Map<string, SourceValidation>;
  candidates: Map<string, CandidateValidation>;
}

/** Set-level counts and identities, then every source and candidate. */
export function validateResearchSet(set: ResearchSet): ResearchSetValidation {
  const refusals: Refusal[] = [];
  if (set.candidates.length > MAX_CANDIDATES_PER_RESEARCH_SET) {
    refusals.push({ code: "too_many_candidates", detail: `${set.candidates.length}` });
  }
  const candidateIds = new Set<string>();
  for (const c of set.candidates) {
    if (candidateIds.has(c.id)) refusals.push({ code: "duplicate_candidate_id", detail: c.id });
    candidateIds.add(c.id);
  }
  const sourceIds = new Set<string>();
  for (const s of set.sources) {
    if (sourceIds.has(s.id)) refusals.push({ code: "duplicate_source_id", detail: s.id });
    sourceIds.add(s.id);
  }
  for (const l of set.links) {
    if (!candidateIds.has(l.candidateId)) refusals.push({ code: "link_to_unknown_candidate", detail: l.candidateId });
  }

  // Colliding ids never let one entry's result stand for another's: every
  // source sharing an id is refused together, with all their refusals and
  // signals, and so is every candidate sharing an id.
  const sources = new Map<string, SourceValidation>();
  for (const s of set.sources) {
    const v = validateSource(s);
    const prior = sources.get(s.id);
    sources.set(
      s.id,
      prior === undefined
        ? v
        : {
            sourceId: s.id,
            refusals: [...prior.refusals.filter((r) => r.code !== "duplicate_source_id"), ...v.refusals, { code: "duplicate_source_id" }],
            signals: [...prior.signals, ...v.signals],
          }
    );
  }
  const candidates = new Map<string, CandidateValidation>();
  for (const c of set.candidates) {
    const v = validateCandidate(c, set.links, set.sources, set.siteContext, sources);
    const prior = candidates.get(c.id);
    candidates.set(
      c.id,
      prior === undefined
        ? v
        : {
            ...v,
            refusals: [...prior.refusals.filter((r) => r.code !== "duplicate_candidate_id"), ...v.refusals, { code: "duplicate_candidate_id" }],
            signals: [...prior.signals, ...v.signals],
            verification: null,
            sourceVerifications: [],
            primarySourceId: null,
            primaryUnresolved: false,
          }
    );
  }
  return { refusals, sources, candidates };
}
