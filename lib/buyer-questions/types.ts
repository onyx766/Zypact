/**
 * Buyer Question Intelligence (D-039, docs/BUYER_QUESTION_INTELLIGENCE.md):
 * closed vocabularies and the input/output shapes of the Q1 offline rules.
 *
 * Everything in lib/buyer-questions/ is a pure function over in-memory
 * values. Nothing here reads or writes storage, calls a provider, or is
 * wired into any execution path; later steps (Q2 onwards) supply the
 * inputs and persist the outputs.
 *
 * Hard refusals and review signals are separate types and separate
 * fields everywhere. A refusal makes the input invalid. A signal is shown
 * to the curator and never refuses, accepts, confirms or changes a grade.
 */

export const EVIDENCE_GRADES = ["observed", "adapted", "hypothesis"] as const;
export type EvidenceGrade = (typeof EVIDENCE_GRADES)[number];

export const VERIFICATIONS = ["public_verifiable", "customer_provided"] as const;
export type Verification = (typeof VERIFICATIONS)[number];

/**
 * `site_copy` is the customer's own website, context only. Any other
 * seller-authored text (a competitor's site, a press release, vendor
 * documentation) is recorded as a public kind with `buyerAuthored: false`,
 * and is likewise usable only as context.
 */
export const SOURCE_KINDS = [
  "customer_material",
  "public_community",
  "public_review",
  "public_analyst",
  "site_copy",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const LINK_RELATIONS = ["verbatim", "paraphrase_basis", "context"] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];

export const QUESTION_KINDS = ["unbranded", "branded_accuracy"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/** Buyer stages v1 (provisional), used by the composition rule. */
export const BUYER_STAGES = ["problem", "solution", "vendor_evaluation", "purchase"] as const;
export type BuyerStage = (typeof BUYER_STAGES)[number];

export const ORIGINS = [
  "recommended_unchanged",
  "recommended_edited",
  "replaced_with_candidate",
  "customer_written",
] as const;
export type Origin = (typeof ORIGINS)[number];

export const WORDING_CLASSIFICATIONS = ["observed", "adapted", "hypothesis", "pending_review"] as const;
export type WordingClassification = (typeof WORDING_CLASSIFICATIONS)[number];

export const CLASSIFICATION_RULES = ["inherited_unchanged", "exact_source_match", "founder_review"] as const;
export type ClassificationRule = (typeof CLASSIFICATION_RULES)[number];

export const ALIAS_RESOLUTIONS = ["accept", "reject"] as const;
export type AliasResolution = (typeof ALIAS_RESOLUTIONS)[number];

export type QuestionProvenance = "founder_supplied" | "customer_supplied";

export function isEvidenceGrade(value: unknown): value is EvidenceGrade {
  return typeof value === "string" && (EVIDENCE_GRADES as readonly string[]).includes(value);
}

export function isWordingClassification(value: unknown): value is WordingClassification {
  return typeof value === "string" && (WORDING_CLASSIFICATIONS as readonly string[]).includes(value);
}

export function isOrigin(value: unknown): value is Origin {
  return typeof value === "string" && (ORIGINS as readonly string[]).includes(value);
}

/** Hard refusals: the input is invalid. */
export type RefusalCode =
  | "excerpt_empty"
  | "excerpt_too_long"
  | "excerpt_hash_mismatch"
  | "public_source_missing_url"
  | "public_source_missing_retrieved_at"
  | "customer_material_missing_reference"
  | "customer_material_missing_attestation"
  | "customer_material_missing_date_received"
  | "personal_data_confirmation_missing"
  | "site_copy_cannot_be_buyer_authored"
  | "unknown_source_kind"
  | "question_text_empty"
  | "unknown_grade"
  | "unknown_question_kind"
  | "unknown_buyer_stage"
  | "link_to_unknown_source"
  | "quoted_span_not_in_excerpt"
  | "seller_source_only_as_context"
  | "observed_requires_verbatim_buyer_source"
  | "observed_text_does_not_match_source"
  | "adapted_requires_paraphrase_basis"
  | "adapted_requires_note"
  | "unbranded_contains_brand"
  | "branded_missing_brand"
  | "rating_invalid"
  | "too_many_candidates"
  | "unknown_link_relation"
  | "linked_source_refused"
  | "curator_rank_invalid"
  | "duplicate_candidate_id"
  | "duplicate_source_id"
  | "link_to_unknown_candidate"
  | "unknown_origin"
  | "candidate_required"
  | "unchanged_text_differs"
  | "classification_not_allowed";

/** Review signals (provisional v1): shown to the curator only. */
export type SignalCode =
  | "length_unusual"
  | "not_phrased_as_question"
  | "contains_line_break"
  | "possible_personal_data"
  | "brand_match_ambiguous"
  | "brand_name_unusable"
  | "brand_alias_unresolved"
  | "unicode_normalization_differs"
  | "marketing_language";

export interface Refusal {
  code: RefusalCode;
  detail?: string;
}

export interface Signal {
  code: SignalCode;
  detail?: string;
  /** For brand signals: the name exactly as the curator entered it. */
  name?: string;
  /** For `brand_alias_unresolved`: the stripped alias that matched. */
  alias?: string;
}

/** A brand or product name as the curator entered it. */
export interface SiteName {
  name: string;
  /** Required for a stripped alias to count; absent means unresolved. */
  aliasResolution?: AliasResolution | null;
}

export interface SiteContext {
  brandNames: readonly SiteName[];
  productNames: readonly SiteName[];
  /** The crawled site copy, used only by the marketing-language signal. */
  siteCopy: string;
}

export interface QuestionSource {
  id: string;
  kind: SourceKind;
  buyerAuthored: boolean;
  url?: string | null;
  publisher?: string | null;
  title?: string | null;
  customerReference?: string | null;
  customerAttestedAt?: string | null;
  /** Retrieval date for a public source; date received for customer material. */
  retrievedAt?: string | null;
  excerpt: string;
  excerptSha256: string;
  /** The curator's mandatory confirmation. Never derived from any detector. */
  personalDataRemoved: boolean;
}

export interface Rating {
  value: number;
  reason: string;
}

export interface RelevanceRatings {
  buyerRelevance: Rating;
  icpFit: Rating;
  commercialIntent: Rating;
  productRelevance: Rating;
}

export interface MarketingFlagResolution {
  reason: string;
  /** A buyer-authored source linked to the candidate. */
  sourceId: string;
}

export interface Candidate {
  id: string;
  text: string;
  grade: EvidenceGrade;
  kind: QuestionKind;
  buyerStage: BuyerStage;
  adaptationNote?: string | null;
  ratings: RelevanceRatings;
  curatorRank: number;
  marketingFlagResolution?: MarketingFlagResolution | null;
}

export interface CandidateSourceLink {
  candidateId: string;
  sourceId: string;
  relation: LinkRelation;
  /** The exact words quoted from the excerpt; defaults to the whole excerpt. */
  quotedSpan?: string | null;
}

export interface ResearchSet {
  siteContext: SiteContext;
  sources: readonly QuestionSource[];
  candidates: readonly Candidate[];
  links: readonly CandidateSourceLink[];
}

export const MAX_CANDIDATES_PER_RESEARCH_SET = 6;
export const MAX_QUESTIONS_PER_APPROVAL_SET = 3;
export const EXCERPT_MAX_CODE_POINTS = 300;
export const NEAR_DUPLICATE_THRESHOLD = { numerator: 4, denominator: 5 } as const;
