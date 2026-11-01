/**
 * Question-text normalisations for Buyer Question Intelligence (Q1).
 *
 * None of these is used for `prompt_hash`, which stays the SHA-256 of the
 * exact approved text. None uses the D-019 entity normaliser: buyer
 * questions are not entities.
 */

/** Length in Unicode code points, never UTF-16 units or bytes. */
export function codePointLength(text: string): number {
  return [...text].length;
}

/**
 * The observed-match form, exactly as Q0 defines observed wording:
 * trim, collapse internal whitespace runs (JavaScript `\s`) to one space,
 * and remove one trailing run made only of ASCII `?`, `.`, `!` and
 * whitespace. No Unicode normalisation is applied, so case, inner
 * punctuation, other trailing marks and differently encoded but
 * canonically equivalent characters all remain differences.
 */
export function observedForm(text: string): string {
  return text
    .replace(/^\s+|\s+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[?.!\s]+$/, "");
}

/**
 * Never true for an empty observed form: text made only of whitespace and
 * terminal punctuation ("???", "!!!") is not wording and matches nothing.
 */
export function isObservedMatch(candidateText: string, sourceText: string): boolean {
  const candidate = observedForm(candidateText);
  return candidate.length > 0 && candidate === observedForm(sourceText);
}

/**
 * True when two texts are not an observed match but would be after Unicode
 * NFC. Diagnostic only (`unicode_normalization_differs`); it never makes a
 * text observed.
 */
export function differsOnlyByUnicodeNormalization(a: string, b: string): boolean {
  if (isObservedMatch(a, b)) return false;
  return isObservedMatch(a.normalize("NFC"), b.normalize("NFC"));
}

const PUNCTUATION_OR_SYMBOL = /[\p{P}\p{S}]/gu;

/** Lowercased, NFC, punctuation and symbols removed (provisional v1). */
export function plainWord(word: string): string {
  return word.normalize("NFC").toLowerCase().replace(PUNCTUATION_OR_SYMBOL, "");
}

/** Stop-word list v1: English function words removed from near-duplicate token sets. */
export const STOP_WORDS_V1: readonly string[] = [
  "a", "an", "the", "and", "or", "but", "if", "then", "so", "of", "to", "in",
  "on", "at", "by", "for", "with", "about", "from", "into", "over", "under",
  "as", "is", "are", "was", "were", "be", "been", "being", "do", "does", "did",
  "have", "has", "had", "i", "me", "my", "we", "our", "you", "your", "it",
  "its", "they", "their", "this", "that", "these", "those", "what", "which",
  "who", "whom", "how", "can", "could", "should", "would", "will", "there",
];

const STOP_WORD_SET = new Set(STOP_WORDS_V1);

export function isStopWord(token: string): boolean {
  return STOP_WORD_SET.has(token);
}

/** Content tokens of a duplicate key, for near-duplicate similarity. */
export function contentTokens(duplicateKey: string): Set<string> {
  return new Set(duplicateKey.split(" ").filter((t) => t.length > 0 && !isStopWord(t)));
}

/**
 * Jaccard similarity compared against `numerator/denominator` with integer
 * arithmetic, so the 0.8 boundary is exact.
 */
export function jaccardAtLeast(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
  numerator: number,
  denominator: number
): boolean {
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  if (union === 0) return true;
  return intersection * denominator >= union * numerator;
}

/** Word trigrams of plain words, for the site-copy overlap signal. */
export function wordTrigrams(text: string): string[] {
  const words = text.split(/\s+/).map(plainWord).filter((w) => w.length > 0);
  const trigrams: string[] = [];
  for (let i = 0; i + 2 < words.length; i += 1) {
    trigrams.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  return trigrams;
}
