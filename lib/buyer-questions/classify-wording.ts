/**
 * Classifying the exact approved wording (design section 4, "Classifying
 * the exact approved wording"; section 9).
 *
 * Rules, in order:
 *   1. inherited_unchanged: an unchanged recommended or replacement
 *      candidate inherits the candidate's grade and verification.
 *   2. exact_source_match: the text observed-matches a buyer-authored
 *      question in a source linked to the candidate (for a
 *      customer-written question, any buyer-authored source in the
 *      research set). Classified `observed` with that source's
 *      verification. The only evidence of a buyer-authored question is a
 *      `verbatim` link: the curator's explicit designation that the quoted
 *      words are a buyer's question as written. A `paraphrase_basis` link
 *      or a source's whole excerpt is buyer language, not a question, and
 *      never establishes observed wording.
 *   3. Anything else is `pending_review`, which is a classification
 *      status, not an evidence grade.
 *
 * Observed matching is exactly the Q0 rule (no Unicode normalisation); a
 * text that matches only after NFC raises `unicode_normalization_differs`
 * and stays `pending_review`.
 *
 * Only valid evidence can establish observed wording: a valid,
 * buyer-authored source, reached through a `verbatim` link of a candidate
 * that passed validation, quoting words present in the excerpt on word
 * boundaries. Paraphrase-basis and context links, whole excerpts, refused
 * candidates, invented spans, partial-word spans and empty wording never
 * count, and a research set with any set-level refusal (for example
 * colliding source ids) is refused outright. The verification of an
 * observed result is that of an explicitly identified primary source among
 * the matched ones; otherwise the wording stays `pending_review`.
 */


import { differsOnlyByUnicodeNormalization, isObservedMatch } from "./normalize";
import { linkedSpan, quotedSpanProblem, validateResearchSet, type ResearchSetValidation } from "./validate-candidate";
import { isSellerSource, sourceVerification } from "./validate-source";
import {
  ORIGINS,
  isEvidenceGrade,
  isOrigin,
  isWordingClassification,
  type Candidate,
  type ClassificationRule,
  type EvidenceGrade,
  type Origin,
  type QuestionProvenance,
  type QuestionSource,
  type Refusal,
  type ResearchSet,
  type Signal,
  type Verification,
  type WordingClassification,
} from "./types";

export interface ApprovedWordingInput {
  origin: Origin | string;
  approvedText: string;
  /** The candidate the approval started from; absent for customer-written text. */
  candidateId?: string | null;
  /**
   * The source identified as primary for an exact source match. For an
   * edited candidate it defaults to the candidate's own primary source.
   */
  primarySourceId?: string | null;
  researchSet: ResearchSet;
}

export interface MatchedSource {
  sourceId: string;
  verification: Verification;
}

export interface WordingClassificationResult {
  classification: WordingClassification | null;
  rule: ClassificationRule | null;
  /** The primary source's verification; null unless resolved. */
  verification: Verification | null;
  provenance: QuestionProvenance | null;
  /** Every valid source the exact text matched, each with its own status. */
  matchedSources: MatchedSource[];
  refusals: Refusal[];
  signals: Signal[];
}

function refused(refusals: Refusal[]): WordingClassificationResult {
  return { classification: null, rule: null, verification: null, provenance: null, matchedSources: [], refusals, signals: [] };
}

function isValidBuyerSource(source: QuestionSource, validation: ResearchSetValidation): boolean {
  return (validation.sources.get(source.id)?.refusals.length ?? 1) === 0 && !isSellerSource(source);
}

/**
 * The spans a text may match: valid `verbatim` links, of the given
 * candidate or, without one (customer-written), of any candidate in the
 * set. Links of refused candidates, paraphrase-basis and context links,
 * whole excerpts and unusable spans are never included.
 */
export function evidenceSpans(
  set: ResearchSet,
  validation: ResearchSetValidation,
  candidateId: string | null
): Array<[QuestionSource, string]> {
  const spans: Array<[QuestionSource, string]> = [];
  for (const link of set.links) {
    if (candidateId !== null && link.candidateId !== candidateId) continue;
    if (link.relation !== "verbatim") continue;
    if ((validation.candidates.get(link.candidateId)?.refusals.length ?? 1) !== 0) continue;
    const source = set.sources.find((s) => s.id === link.sourceId);
    if (source === undefined || !isValidBuyerSource(source, validation)) continue;
    if (quotedSpanProblem(link, source) !== null) continue;
    spans.push([source, linkedSpan(link, source)]);
  }
  return spans;
}

function pending(provenance: QuestionProvenance, signals: Signal[], matchedSources: MatchedSource[] = []): WordingClassificationResult {
  return { classification: "pending_review", rule: null, verification: null, provenance, matchedSources, refusals: [], signals };
}

export function classifyApprovedWording(input: ApprovedWordingInput): WordingClassificationResult {
  if (!isOrigin(input.origin)) return refused([{ code: "unknown_origin" }]);
  const origin = input.origin;
  const text = input.approvedText;
  if (typeof text !== "string" || text.trim().length === 0) return refused([{ code: "question_text_empty" }]);

  const set = input.researchSet;
  const validation = validateResearchSet(set);
  if (validation.refusals.length > 0) {
    return refused([{ code: "research_set_refused", detail: validation.refusals.map((r) => r.code).join(",") }]);
  }
  const provenance: QuestionProvenance = origin === "customer_written" ? "customer_supplied" : "founder_supplied";

  let candidate: Candidate | null = null;
  if (origin !== "customer_written") {
    candidate = set.candidates.find((c) => c.id === input.candidateId) ?? null;
    if (candidate === null) return refused([{ code: "candidate_required" }]);
  }

  // Rule 1: unchanged. Only a candidate that passed validation passes on
  // its grade, and an observed or adapted one only with a resolved primary.
  if (origin === "recommended_unchanged" || origin === "replaced_with_candidate") {
    const c = candidate as Candidate;
    if (text !== c.text) return refused([{ code: "unchanged_text_differs" }]);
    const v = validation.candidates.get(c.id);
    if (v !== undefined && v.refusals.length === 0) {
      if (v.primaryUnresolved) {
        return pending(provenance, [{ code: "primary_source_unresolved", detail: c.id }]);
      }
      return {
        classification: c.grade,
        rule: "inherited_unchanged",
        verification: v.verification,
        provenance,
        matchedSources: [],
        refusals: [],
        signals: [],
      };
    }
  }

  // Rule 2: exact match to valid buyer-authored evidence.
  const spans = evidenceSpans(set, validation, candidate === null ? null : candidate.id);
  const matchedIds = [...new Set(spans.filter(([, span]) => isObservedMatch(text, span)).map(([s]) => s.id))].sort();
  const matchedSources: MatchedSource[] = matchedIds.map((id) => ({
    sourceId: id,
    verification: sourceVerification(set.sources.find((s) => s.id === id) as QuestionSource),
  }));
  if (matchedSources.length > 0) {
    const primaryId = input.primarySourceId ?? candidate?.primarySourceId ?? null;
    const primary = matchedSources.find((m) => m.sourceId === primaryId);
    if (primary === undefined) {
      return pending(provenance, [{ code: "primary_source_unresolved", detail: matchedIds.join(",") }], matchedSources);
    }
    return {
      classification: "observed",
      rule: "exact_source_match",
      verification: primary.verification,
      provenance,
      matchedSources,
      refusals: [],
      signals: [],
    };
  }

  // Rule 3: pending review.
  const signals: Signal[] = [];
  const nfcOnly = [...new Set(spans.filter(([, span]) => differsOnlyByUnicodeNormalization(text, span)).map(([s]) => s.id))].sort();
  for (const id of nfcOnly) signals.push({ code: "unicode_normalization_differs", detail: id });
  return pending(provenance, signals);
}

/**
 * Classifications a founder review may record: `adapted` or `hypothesis`
 * only, as the design specifies for resolving `pending_review`. `observed`
 * is a known evidence grade but not a founder-review outcome: observed
 * wording is established only by a validated `verbatim` designation through
 * `classifyApprovedWording`. `pending_review` is not an outcome either.
 */
export const FOUNDER_REVIEW_CLASSIFICATIONS: readonly EvidenceGrade[] = ["adapted", "hypothesis"];

export interface FounderClassificationInput {
  classification: string;
  approvedText: string;
  /** Buyer-authored sources cited as the paraphrase basis of an `adapted` entry. */
  sourceIds: readonly string[];
  /** Required for `adapted`: the cited source whose status applies. */
  primarySourceId?: string | null;
  note?: string | null;
  researchSet: ResearchSet;
}

export interface FounderClassificationResult {
  accepted: boolean;
  classification: EvidenceGrade | null;
  verification: Verification | null;
  refusals: Refusal[];
}

/**
 * A founder review entry, recorded as a new classification that never
 * alters the first. It may record `adapted` (a buyer-authored basis, a note
 * and an explicit primary source among the cited bases) or `hypothesis`.
 * Any other known grade or status (`observed`, `pending_review`, an origin)
 * is refused as `classification_not_allowed`; anything else as
 * `unknown_grade`.
 */
export function validateFounderClassification(input: FounderClassificationInput): FounderClassificationResult {
  const refusals: Refusal[] = [];
  const grade = input.classification;
  if (!(FOUNDER_REVIEW_CLASSIFICATIONS as readonly string[]).includes(grade)) {
    const known = isEvidenceGrade(grade) || isWordingClassification(grade) || (ORIGINS as readonly string[]).includes(grade);
    refusals.push({ code: known ? "classification_not_allowed" : "unknown_grade", detail: grade });
    return { accepted: false, classification: null, verification: null, refusals };
  }

  const validation = validateResearchSet(input.researchSet);
  if (validation.refusals.length > 0) {
    refusals.push({ code: "research_set_refused", detail: validation.refusals.map((r) => r.code).join(",") });
    return { accepted: false, classification: null, verification: null, refusals };
  }
  const cited = input.sourceIds
    .map((id) => input.researchSet.sources.find((s) => s.id === id))
    .filter((s): s is QuestionSource => s !== undefined);
  if (cited.length !== input.sourceIds.length) refusals.push({ code: "link_to_unknown_source" });
  const buyerSources = cited.filter((s) => isValidBuyerSource(s, validation));
  if (buyerSources.length !== cited.length) refusals.push({ code: "seller_source_only_as_context" });

  let supporting: QuestionSource[] = [];
  if (grade === "adapted") {
    if (buyerSources.length === 0) refusals.push({ code: "adapted_requires_paraphrase_basis" });
    if (typeof input.note !== "string" || input.note.trim().length === 0) refusals.push({ code: "adapted_requires_note" });
    supporting = buyerSources;
  }

  let verification: Verification | null = null;
  if (supporting.length > 0) {
    const primary = supporting.find((s) => s.id === input.primarySourceId);
    if (primary === undefined) refusals.push({ code: "primary_source_required" });
    else verification = sourceVerification(primary);
  }

  const accepted = refusals.length === 0;
  return {
    accepted,
    classification: accepted ? (grade as EvidenceGrade) : null,
    verification: accepted ? verification : null,
    refusals,
  };
}
