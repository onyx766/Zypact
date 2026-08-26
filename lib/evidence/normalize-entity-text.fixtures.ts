/**
 * Regression fixtures for lib/evidence/normalize-entity-text.ts (v1).
 *
 * Every `expected` value here is the correct output of the algorithm
 * documented in normalize-entity-text.ts, traced by hand — not a
 * guess. Changing the algorithm in a way that changes any of these
 * outputs is a new resolver_version, never a silent edit.
 */

export interface NormalizerFixture {
  category:
    | "accents"
    | "unicode"
    | "casing"
    | "punctuation"
    | "suffixes"
    | "whitespace"
    | "domains"
    | "empty";
  description: string;
  input: string;
  expected: string;
}

export const NORMALIZER_V1_FIXTURES: readonly NormalizerFixture[] = [
  // ------------------------------------------------------------------
  // Accents / diacritics
  // ------------------------------------------------------------------
  {
    category: "accents",
    description: "lowercase accented word strips the acute accent",
    input: "café",
    expected: "cafe",
  },
  {
    category: "accents",
    description:
      "capitalized accented word strips the accent AND lowercases identically to the lowercase form above",
    input: "Café",
    expected: "cafe",
  },
  {
    category: "accents",
    description: "multiple accents in one word",
    input: "résumé",
    expected: "resume",
  },

  // ------------------------------------------------------------------
  // Unicode — NFKC compatibility folding, and the double diacritic-strip
  // ------------------------------------------------------------------
  {
    category: "unicode",
    description:
      "fullwidth Latin letters (common in East-Asian input) are folded to standard ASCII by NFKC, which plain NFC would not do",
    input: "Ａｃｍｅ", // fullwidth "Acme"
    expected: "acme",
  },
  {
    category: "unicode",
    description:
      "Turkish dotted capital I (U+0130) has no NFD decomposition of its own, so the first diacritic-strip pass leaves it untouched; its ECMAScript lowercase form introduces a fresh combining dot above (U+0307) that only the SECOND diacritic-strip pass removes — proves the double-strip is necessary, not redundant",
    input: "İstanbul",
    expected: "istanbul",
  },
  {
    category: "unicode",
    description:
      "German sharp s (ß) has no decomposition and is a letter, not touched by punctuation/symbol removal — it survives normalization as its own letter",
    input: "straße",
    expected: "straße",
  },
  {
    category: "casing",
    description:
      "KNOWN, ACCEPTED v1 LIMITATION — full Unicode case-folding would map ß to 'ss', making this equal to the ß fixture above; v1's simple lowercase does not, so the ASCII-spelled and ß-spelled forms of the same word do NOT normalize to the same value. This is documented behavior, not a bug.",
    input: "STRASSE",
    expected: "strasse",
  },

  // ------------------------------------------------------------------
  // Punctuation vs. symbol (both P* and S* categories removed)
  // ------------------------------------------------------------------
  {
    category: "punctuation",
    description: "trailing punctuation (! is category Po) is removed",
    input: "Yelp!",
    expected: "yelp",
  },
  {
    category: "punctuation",
    description: "ampersand (category Po) is deleted, never expanded to 'and'",
    input: "AT&T",
    expected: "att",
  },
  {
    category: "punctuation",
    description:
      "ampersand and apostrophe both removed; the space left behind by deleting '&' is collapsed by the whitespace step",
    input: "Ben & Jerry's",
    expected: "ben jerrys",
  },

  // ------------------------------------------------------------------
  // Legal suffixes — word-boundary, longest-match, no false positives
  // ------------------------------------------------------------------
  {
    category: "suffixes",
    description: "simple trailing suffix with a period",
    input: "Acme Inc.",
    expected: "acme",
  },
  {
    category: "suffixes",
    description: "simple trailing suffix without a period",
    input: "Acme LLC",
    expected: "acme",
  },
  {
    category: "suffixes",
    description: "German suffix",
    input: "Acme GmbH",
    expected: "acme",
  },
  {
    category: "suffixes",
    description:
      "two candidate suffixes match at the same trailing position ('ltd' and 'pty ltd'); the longer one must win so the combined suffix is not partially stripped",
    input: "Acme Pty Ltd",
    expected: "acme",
  },
  {
    category: "suffixes",
    description:
      "NEGATIVE CASE — 'corp' must never match as a bare substring of 'Corporate'; the last word is 'traveler', which matches no suffix, so nothing is stripped",
    input: "Corporate Traveler",
    expected: "corporate traveler",
  },
  {
    category: "suffixes",
    description:
      "a bare suffix with nothing in front of it, and no punctuation to otherwise remove, is left completely untouched — isolates the 'never strip to empty' rule from any other step",
    input: "Ltd",
    expected: "ltd",
  },
  {
    category: "suffixes",
    description:
      "a bare suffix with a trailing period is never stripped to an empty remainder by the suffix step itself — but the period is still removed afterward by the ordinary, uniform punctuation-removal step, which applies regardless of what came before",
    input: "Inc.",
    expected: "inc",
  },

  // ------------------------------------------------------------------
  // Whitespace — including non-ASCII Unicode whitespace
  // ------------------------------------------------------------------
  {
    category: "whitespace",
    description: "multiple internal ASCII spaces collapse to one",
    input: "Acme   Solutions",
    expected: "acme solutions",
  },
  {
    category: "whitespace",
    description:
      "a tab (not a literal ASCII space) still counts as a word boundary before a legal suffix",
    input: "Acme\tInc.",
    expected: "acme",
  },
  {
    category: "whitespace",
    description:
      "a non-breaking space (U+00A0) between words is recognized as whitespace and collapsed to a regular space",
    input: "Acme Solutions",
    expected: "acme solutions",
  },
  {
    category: "whitespace",
    description:
      "an ideographic space (U+3000) before a legal suffix still counts as a word boundary",
    input: "Acme　Ltd",
    expected: "acme",
  },

  // ------------------------------------------------------------------
  // Domain-shaped branch — evaluated before punctuation removal so the
  // dot the shape test depends on is never destroyed first
  // ------------------------------------------------------------------
  {
    category: "domains",
    description: "leading www. is stripped, no TLD stripping",
    input: "www.acme.com",
    expected: "acme.com",
  },
  {
    category: "domains",
    description: "no www. prefix — unchanged",
    input: "acme.com",
    expected: "acme.com",
  },
  {
    category: "domains",
    description: "mixed-case domain and prefix, lowercased before the domain-shape test runs",
    input: "WWW.Acme.COM",
    expected: "acme.com",
  },

  // ------------------------------------------------------------------
  // Collapses to empty
  // ------------------------------------------------------------------
  {
    category: "empty",
    description:
      "pure punctuation collapses to an empty string — callers treat this as nothing to resolve, never as an alias to create",
    input: "!!!",
    expected: "",
  },
];
