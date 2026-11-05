/**
 * Excerpts W1 may keep, and the personal-data screen they pass first.
 *
 * An excerpt is an exact slice of the page's received bytes: its offsets are
 * UTF-8 byte offsets into those bytes and its hash is the page's body hash,
 * so anyone holding the page can verify it. It is at most 300 code points,
 * cut on a word boundary, and dropped entirely (never redacted) when the
 * screen sees anything that could be personal data. Excerpts are only built
 * from titles, H1s and meta descriptions, which rarely contain any.
 *
 * Pure module.
 */
import { EXCERPT_MAX_CODE_POINTS } from "@/lib/site-diagnostic/contract";
import type { SourceSpan } from "@/lib/site-diagnostic/html";
import type { FindingExcerpt } from "@/lib/site-diagnostic/types";

export const W1_PII_SCREEN_VERSION = "w1-pii-screen.1";

/**
 * Conservative patterns: any match drops the excerpt. Year ranges such as
 * "2019-2026" are removed before the phone test so a copyright line does not
 * trip it.
 */
const PII_PATTERNS: readonly RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // email address
  /&#0*64;|&commat;|%40/i, // an encoded "@"
  /(?:\+|00)\d[\d\s().-]{6,}\d/, // international phone number
  /\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/, // North American phone number
  /\b\d{3}-\d{2}-\d{4}\b/, // US SSN shape
  /\b(?:\d[ -]?){13,19}\b/, // card-number-length digit run
  /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/, // IBAN shape
];

const YEAR_RANGE = /\b(19|20)\d{2}\s*[-–—]\s*(19|20)\d{2}\b/g;

export function screenForPersonalData(text: string): boolean {
  const withoutYears = text.replace(YEAR_RANGE, " ");
  return PII_PATTERNS.some((pattern) => pattern.test(withoutYears));
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

/** First `max` code points, shortened to end on a word boundary. */
function cutAtWordBoundary(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  let end = max;
  while (end > 0 && WORD_CHAR.test(points[end]) && WORD_CHAR.test(points[end - 1])) end -= 1;
  if (end === 0) end = max;
  return points.slice(0, end).join("").trimEnd();
}

/**
 * An excerpt for `span`, or null when offsets are not exact, the text is
 * empty, or the screen flags it.
 */
export function buildExcerpt(span: SourceSpan | undefined, bodySha256: string | null): FindingExcerpt | null {
  if (!span || !bodySha256 || span.start < 0 || span.end <= span.start) return null;
  const text = cutAtWordBoundary(span.text, EXCERPT_MAX_CODE_POINTS);
  if (text.trim() === "" || screenForPersonalData(text)) return null;
  const end = span.start + Buffer.byteLength(text, "utf8");
  if (end <= span.start) return null;
  return { text, start: span.start, end, bodySha256, piiScreenVersion: W1_PII_SCREEN_VERSION };
}
