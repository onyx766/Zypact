/**
 * The marketing-language review signal (design section 6; provisional
 * detectors v1, plan section 4.2).
 *
 * A flag is shown to the curator and keeps the candidate from being
 * preselected until the curator resolves it with a recorded reason and a
 * buyer-authored source. It never changes a grade, it is not proof of
 * seller authorship, and passing it is not proof of buyer authorship:
 * the detectors are heuristics that miss seller copy (other languages,
 * unlisted phrases, paraphrase), so the evidence rules, not this signal,
 * decide whether wording is buyer-authored.
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
/** Each item after the first must be at most this long to read as a noun phrase. */
export const FEATURE_LIST_MAX_ITEM_WORDS_V1 = 6;
/**
 * Separators v1: comma, semicolon, slash, ampersand, a line break (with an
 * optional bullet), or the words "and", "or", "plus"; a punctuation
 * separator may be followed by one of those words (", and").
 */
const FEATURE_LIST_SEPARATOR_V1 =
  /\s*(?:[,;/&]|\r?\n\s*(?:[-*\u2022]\s*)?)\s*(?:(?:and|or|plus)\s+)?|\s+(?:and|or|plus)\s+/iu;
/**
 * An item starting with one of these words reads as a clause (a question
 * or a statement), not a noun phrase, so it does not count as a list item.
 */
export const FEATURE_LIST_CLAUSE_STARTERS_V1: readonly string[] = [
  "how", "what", "when", "where", "which", "who", "whom", "whose", "why",
  "is", "are", "was", "were", "do", "does", "did", "can", "could", "should",
  "would", "will", "i", "we", "you", "my", "our", "if",
];
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
 * The plan's "three or more comma- or 'and'-separated noun phrases",
 * approximated without a parser: split on the v1 separators; the first
 * item holds the question stem ("Which tool offers invoicing") and is not
 * limited; it must be followed directly by at least two list items, each
 * non-empty, at most six words, and not starting with a clause word. A
 * trailing clause ("…, and how much is it?") ends the list.
 *
 * Known v1 limits: English only; no part-of-speech check, so a list of
 * verbs or of long phrases is judged by shape alone; a buyer's own list
 * ("A, B and C") is flagged like a seller's. A flag only asks the curator
 * to review; not being flagged is never evidence of buyer authorship.
 */
export function looksLikeFeatureList(text: string): boolean {
  const body = text.trim().replace(/[?.!\uFF1F]+$/u, "");
  const items = body.split(FEATURE_LIST_SEPARATOR_V1).map((item) => item.trim());
  const isListItem = (item: string): boolean => {
    const words = item.split(/\s+/).filter((w) => w.length > 0);
    return (
      words.length > 0 &&
      words.length <= FEATURE_LIST_MAX_ITEM_WORDS_V1 &&
      !FEATURE_LIST_CLAUSE_STARTERS_V1.includes(words[0].toLowerCase().replace(/[\p{P}\p{S}]/gu, ""))
    );
  };
  let run = 0;
  while (run + 1 < items.length && isListItem(items[run + 1])) run += 1;
  return run >= FEATURE_LIST_MIN_SEPARATORS_V1;
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
