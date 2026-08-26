/**
 * M2 canonical observations contract — v1 deterministic entity-text
 * normalizer (D-017 §5, refined by D-019).
 *
 * This is the SOLE authoritative implementation of the v1
 * normalization algorithm. Every writer of normalized text — the live
 * pipeline (analyze-probe-response.ts, not yet wired), the historical
 * reprocessing script (backfill-entity-observations.ts, not yet
 * created), and the brand-term computation feeding
 * entity_brand_snapshots.normalized_brand_terms — must import and
 * call this exact function. No parallel or duplicated implementation
 * of this algorithm is permitted anywhere else in the codebase.
 *
 * Per D-019: PostgreSQL cannot honestly reproduce this algorithm (no
 * Unicode-category-aware diacritic/punctuation removal via stock
 * functions, no true Unicode case-folding), so this module — never a
 * SQL port — is the single source of truth. The RPC that consumes
 * normalized_text (resolve_and_record_entity_observation, not yet
 * created) trusts values produced by this module because it is
 * reachable only by service_role, the backend's own trusted
 * credential (D-019's documented trust hypothesis) — never a value
 * supplied directly by a public endpoint.
 *
 * Deterministic, no LLM call, no fuzzy/similarity matching.
 *
 * Algorithm, in order:
 *   1. Unicode NFKC normalization (compatibility composition — folds
 *      visually-identical variants such as fullwidth Latin letters
 *      into their standard form; NFC alone would not).
 *   2. Strip diacritics: NFD-decompose and remove Unicode category Mn
 *      (nonspacing mark) codepoints.
 *   3. Lowercase via the ECMAScript default (locale-insensitive)
 *      simple case mapping. This is NOT full Unicode case-folding —
 *      there is no native primitive for that in JavaScript either.
 *      Known, accepted v1 limitation: a full case-fold would map
 *      German "ß" to "ss"; this simple lowercase does not, so
 *      "straße" and "STRASSE" do NOT normalize to the same value in
 *      v1 (see the fixtures file). This is documented behavior, not a
 *      bug to silently work around.
 *   4. Diacritics are stripped a SECOND time here, after lowercasing.
 *      This is necessary, not redundant: lowercasing some characters
 *      introduces a fresh combining mark that step 2 could not have
 *      removed yet — e.g. the Turkish dotted capital "İ" (U+0130) has
 *      no NFD decomposition of its own, so step 2 leaves it
 *      untouched, but its ECMAScript lowercase form is "i" followed by
 *      a combining dot above (U+0307, category Mn). Without this
 *      second pass, that stray combining mark would survive into
 *      normalized_text.
 *   5. Domain-shaped branch, decided here — deliberately BEFORE any
 *      punctuation removal, because punctuation removal would delete
 *      the "." this branch's own detection depends on. If the string
 *      matches a bare domain shape, strip only a leading "www." (no
 *      TLD stripping, no cross-matching against a plain company name)
 *      and return — the legal-suffix and punctuation/symbol removal
 *      steps below do not apply to domain-shaped input at all.
 *   6. Otherwise (plain-text branch): strip at most one trailing
 *      legal-entity suffix from a fixed, versioned list (longest
 *      match wins when more than one candidate matches at the same
 *      trailing position; never strip if doing so would leave nothing
 *      behind).
 *   7. Remove all Unicode punctuation (category P*) and symbol
 *      (category S*) characters entirely — not replaced with a space.
 *   8. Collapse whitespace to single ASCII spaces, trim.
 *
 * Changing any step, or the suffix list, is a new resolver_version —
 * never a silent in-place edit of this file's behavior for existing
 * data.
 */

const LEGAL_SUFFIXES: readonly string[] = [
  "inc",
  "inc.",
  "incorporated",
  "llc",
  "l.l.c.",
  "ltd",
  "ltd.",
  "limited",
  "corp",
  "corp.",
  "corporation",
  "co",
  "co.",
  "company",
  "plc",
  "gmbh",
  "ag",
  "sa",
  "s.a.",
  "sas",
  "sarl",
  "s.a.r.l.",
  "bv",
  "b.v.",
  "nv",
  "n.v.",
  "pty",
  "pty ltd",
  "oy",
  "ab",
  "spa",
  "s.p.a.",
];

const DOMAIN_SHAPE_PATTERN = /^[a-z0-9.-]+\.[a-z]{2,}$/;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripDiacritics(input: string): string {
  return input.normalize("NFD").replace(/\p{Mn}/gu, "");
}

/**
 * Strips at most one trailing legal-entity suffix from `s` (already
 * lowercased). The suffix must be preceded by whitespace or the start
 * of the string — never a bare substring match (so "Corporate
 * Traveler" is never truncated to "Corporate Travel" by a false
 * partial match against "er"-adjacent tokens, and "corp" never
 * matches inside "corporate"). When more than one suffix in the fixed
 * list matches at the same trailing position (e.g. both "ltd" and
 * "pty ltd" match the end of "acme pty ltd"), the longest match wins,
 * so a combined suffix is never partially stripped. Never strips if
 * doing so would leave an empty remainder.
 */
function stripTrailingLegalSuffix(s: string): string {
  let bestMatch: string | null = null;

  for (const suffix of LEGAL_SUFFIXES) {
    const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(suffix)}$`);
    if (pattern.test(s) && (bestMatch === null || suffix.length > bestMatch.length)) {
      bestMatch = suffix;
    }
  }

  if (bestMatch === null) return s;

  const withoutSuffix = s.slice(0, s.length - bestMatch.length).replace(/\s+$/, "");
  if (withoutSuffix.trim().length === 0) return s;
  return withoutSuffix;
}

/**
 * The v1 deterministic entity-text normalizer. See the module doc
 * comment for the full algorithm. Always returns a string (never
 * throws on a non-empty input); an input that normalizes to nothing
 * (e.g. pure punctuation) returns an empty string — callers treat an
 * empty result as "nothing to resolve," never as an alias to create.
 */
export function normalizeEntityTextV1(input: string): string {
  if (typeof input !== "string") return "";

  let s = input.normalize("NFKC");
  s = stripDiacritics(s);
  s = s.toLowerCase();
  s = stripDiacritics(s); // second pass — see step 4 in the doc comment
  s = s.trim();

  if (s.length === 0) return "";

  if (DOMAIN_SHAPE_PATTERN.test(s)) {
    const domain = s.startsWith("www.") ? s.slice(4) : s;
    return domain.replace(/\s+/g, " ").trim();
  }

  s = stripTrailingLegalSuffix(s);
  s = s.replace(/[\p{P}\p{S}]/gu, "");
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

export const NORMALIZER_V1_LEGAL_SUFFIXES = LEGAL_SUFFIXES;
