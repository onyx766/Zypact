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
 *      verification.
 *   3. Anything else is `pending_review`, which is a classification
 *      status, not an evidence grade.
 *
 * Observed matching is exactly the Q0 rule (no Unicode normalisation); a
 * text that matches only after NFC raises `unicode_normalization_differs`
 * and stays `pending_review`.
 */

import { differsOnlyByUnicodeNormalization, isObservedMatch } from "./normalize";
import { linkedSpan, validateResearchSet } from "./validate-candidate";
import { isPublicKind, isSellerSource } from "./validate-source";
import {
  ORIGINS,
  isOrigin,
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
  researchSet: ResearchSet;
}

export interface WordingClassificationResult {
  classification: WordingClassification | null;
  rule: ClassificationRule | null;
  verification: Verification | null;
  provenance: QuestionProvenance | null;
  /** The source whose question the text matched, for `exact_source_match`. */
  matchedSourceIds: string[];
  refusals: Refusal[];
  signals: Signal[];
}

function refused(refusals: Refusal[]): WordingClassificationResult {
  return { classification: null, rule: null, verification: null, provenance: null, matchedSourceIds: [], refusals, signals: [] };
}

/** Spans a text may match: linked quoted spans, or whole excerpts of valid buyer-authored sources. */
function candidateSpans(
  set: ResearchSet,
  candidate: Candidate | null,
  validSourceIds: ReadonlySet<string>
): Array<[QuestionSource, string]> {
  const buyerSources = set.sources.filter((s) => validSourceIds.has(s.id) && !isSellerSource(s));
  if (candidate === null) {
    const spans: Array<[QuestionSource, string]> = buyerSources.map((s) => [s, s.excerpt]);
    for (const link of set.links) {
      const source = buyerSources.find((s) => s.id === link.sourceId);
      if (source !== undefined && typeof link.quotedSpan === "string") spans.push([source, link.quotedSpan]);
    }
    return spans;
  }
  const spans: Array<[QuestionSource, string]> = [];
  for (const link of set.links) {
    if (link.candidateId !== candidate.id || link.relation === "context") continue;
    const source = buyerSources.find((s) => s.id === link.sourceId);
    if (source !== undefined) spans.push([source, linkedSpan(link, source)]);
  }
  return spans;
}

export function classifyApprovedWording(input: ApprovedWordingInput): WordingClassificationResult {
  if (!isOrigin(input.origin)) return refused([{ code: "unknown_origin" }]);
  const origin = input.origin;
  const text = input.approvedText;
  if (typeof text !== "string" || text.trim().length === 0) return refused([{ code: "question_text_empty" }]);

  const set = input.researchSet;
  const validation = validateResearchSet(set);
  const validSourceIds = new Set([...validation.sources].filter(([, v]) => v.refusals.length === 0).map(([id]) => id));
  const provenance: QuestionProvenance = origin === "customer_written" ? "customer_supplied" : "founder_supplied";

  let candidate: Candidate | null = null;
  if (origin !== "customer_written") {
    candidate = set.candidates.find((c) => c.id === input.candidateId) ?? null;
    if (candidate === null) return refused([{ code: "candidate_required" }]);
  }

  // Rule 1: unchanged.
  if (origin === "recommended_unchanged" || origin === "replaced_with_candidate") {
    const c = candidate as Candidate;
    if (text !== c.text) return refused([{ code: "unchanged_text_differs" }]);
    const v = validation.candidates.get(c.id);
    if (v !== undefined && v.refusals.length === 0) {
      return {
        classification: c.grade,
        rule: "inherited_unchanged",
        verification: v.verification,
        provenance,
        matchedSourceIds: [],
        refusals: [],
        signals: [],
      };
    }
  }

  // Rule 2: exact match to a buyer-authored source.
  const spans = candidateSpans(set, candidate, validSourceIds);
  const matched = spans.filter(([, span]) => isObservedMatch(text, span)).map(([s]) => s);
  if (matched.length > 0) {
    const ids = [...new Set(matched.map((s) => s.id))].sort();
    return {
      classification: "observed",
      rule: "exact_source_match",
      verification: matched.some((s) => isPublicKind(s.kind)) ? "public_verifiable" : "customer_provided",
      provenance,
      matchedSourceIds: ids,
      refusals: [],
      signals: [],
    };
  }

  // Rule 3: pending review.
  const signals: Signal[] = [];
  const nfcOnly = [...new Set(spans.filter(([, span]) => differsOnlyByUnicodeNormalization(text, span)).map(([s]) => s.id))].sort();
  for (const id of nfcOnly) signals.push({ code: "unicode_normalization_differs", detail: id });
  return {
    classification: "pending_review",
    rule: null,
    verification: null,
    provenance,
    matchedSourceIds: [],
    refusals: [],
    signals,
  };
}

/** Classifications a founder review may record. `pending_review` is not one. */
export const FOUNDER_REVIEW_CLASSIFICATIONS: readonly EvidenceGrade[] = ["observed", "adapted", "hypothesis"];

export interface FounderClassificationInput {
  classification: string;
  approvedText: string;
  /** Buyer-authored sources cited as the verbatim source or the paraphrase basis. */
  sourceIds: readonly string[];
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
 * alters the first. `adapted` needs a buyer-authored basis and a note;
 * `observed` needs a buyer-authored source the exact text matches.
 */
export function validateFounderClassification(input: FounderClassificationInput): FounderClassificationResult {
  const refusals: Refusal[] = [];
  const grade = input.classification;
  if (!(FOUNDER_REVIEW_CLASSIFICATIONS as readonly string[]).includes(grade)) {
    const known = (ORIGINS as readonly string[]).includes(grade) || grade === "pending_review";
    refusals.push({ code: known ? "classification_not_allowed" : "unknown_grade", detail: grade });
    return { accepted: false, classification: null, verification: null, refusals };
  }

  const validation = validateResearchSet(input.researchSet);
  const cited = input.sourceIds
    .map((id) => input.researchSet.sources.find((s) => s.id === id))
    .filter((s): s is QuestionSource => s !== undefined);
  if (cited.length !== input.sourceIds.length) refusals.push({ code: "link_to_unknown_source" });
  const buyerSources = cited.filter(
    (s) => !isSellerSource(s) && (validation.sources.get(s.id)?.refusals.length ?? 1) === 0
  );
  if (buyerSources.length !== cited.length) refusals.push({ code: "seller_source_only_as_context" });

  let verification: Verification | null = null;
  if (grade === "adapted") {
    if (buyerSources.length === 0) refusals.push({ code: "adapted_requires_paraphrase_basis" });
    if (typeof input.note !== "string" || input.note.trim().length === 0) refusals.push({ code: "adapted_requires_note" });
    if (buyerSources.length > 0) {
      verification = buyerSources.some((s) => isPublicKind(s.kind)) ? "public_verifiable" : "customer_provided";
    }
  } else if (grade === "observed") {
    const matched = buyerSources.filter((s) => isObservedMatch(input.approvedText, s.excerpt));
    if (buyerSources.length === 0) refusals.push({ code: "observed_requires_verbatim_buyer_source" });
    else if (matched.length === 0) refusals.push({ code: "observed_text_does_not_match_source" });
    if (matched.length > 0) {
      verification = matched.some((s) => isPublicKind(s.kind)) ? "public_verifiable" : "customer_provided";
    }
  }

  const accepted = refusals.length === 0;
  return {
    accepted,
    classification: accepted ? (grade as EvidenceGrade) : null,
    verification: accepted ? verification : null,
    refusals,
  };
}
