/**
 * The marketing-language review signal (design section 6; provisional
 * detectors v1, plan section 4.2).
 *
 * A flag is shown to the curator and keeps the candidate from being
 * preselected until the curator resolves it with a recorded reason and a
 * buyer-authored source. It never changes a grade, it is not proof of
 * seller authorship, and passing it is not proof of buyer authorship.
 */

import { wordTrigrams } from "./normalize";
import type { SiteContext } from "./types";

/** Lexicon v1: stock seller phrases, compared as whole words. */
export const MARKETING_LEXICON_V1: readonly string[] = [
  "best-in-class",
  "best-of-breed",
  "all-in-one",
  "seamless",
  "seamlessly",
  "industry-leading",
  "market-leading",
  "AI-powered",
  "streamline",
  "streamlines",
  "streamlined",
  "cutting-edge",
  "world-class",
  "next-generation",
  "game-changing",
  "one-stop shop",
  "turnkey",
  "supercharge",
];

/** A feature list needs at least this many list separators (three or more items). */
export const FEATURE_LIST_MIN_SEPARATORS_V1 = 2;
/** Each item after the first must be short to read as a list item. */
export const FEATURE_LIST_MAX_ITEM_WORDS_V1 = 4;
/** Share of the candidate's word trigrams also found in the site copy. */
export const SITE_COPY_OVERLAP_V1 = { numerator: 1, denominator: 2 } as const;

export type MarketingTrigger = "lexicon" | "feature_list" | "site_copy_overlap";

export interface MarketingSignalResult {
  flagged: boolean;
  triggers: MarketingTrigger[];
}

function phraseForm(text: string): string {
  return ` ${text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

const LEXICON_FORMS = MARKETING_LEXICON_V1.map(phraseForm);

function hasLexiconPhrase(text: string): boolean {
  const form = phraseForm(text);
  return LEXICON_FORMS.some((phrase) => form.includes(phrase));
}

/**
 * Three or more items separated by commas or "and", with at least one
 * comma, where every item after the first is short.
 */
function looksLikeFeatureList(text: string): boolean {
  const body = text.trim().replace(/[?.!]+$/, "");
  if (!body.includes(",")) return false;
  const items = body.split(/\s*,\s*(?:and\s+)?|\s+and\s+/i).map((item) => item.trim());
  if (items.length - 1 < FEATURE_LIST_MIN_SEPARATORS_V1) return false;
  return items
    .slice(1)
    .every((item) => item.length > 0 && item.split(/\s+/).length <= FEATURE_LIST_MAX_ITEM_WORDS_V1);
}

function overlapsSiteCopy(text: string, siteCopy: string): boolean {
  const candidate = wordTrigrams(text);
  if (candidate.length === 0) return false;
  const site = new Set(wordTrigrams(siteCopy));
  const shared = candidate.filter((trigram) => site.has(trigram)).length;
  return shared * SITE_COPY_OVERLAP_V1.denominator >= candidate.length * SITE_COPY_OVERLAP_V1.numerator;
}

export function marketingSignal(text: string, siteContext: SiteContext): MarketingSignalResult {
  const triggers: MarketingTrigger[] = [];
  if (hasLexiconPhrase(text)) triggers.push("lexicon");
  if (looksLikeFeatureList(text)) triggers.push("feature_list");
  if (overlapsSiteCopy(text, siteContext.siteCopy)) triggers.push("site_copy_overlap");
  return { flagged: triggers.length > 0, triggers };
}

/** Exported for tests of the overlap boundary. */
export function siteCopyTrigramShare(text: string, siteCopy: string): [number, number] {
  const candidate = wordTrigrams(text);
  const site = new Set(wordTrigrams(siteCopy));
  return [candidate.filter((t) => site.has(t)).length, candidate.length];
}
