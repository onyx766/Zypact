/**
 * M2 canonical observations contract, third tranche (D-017, clarified
 * across several correction rounds) — locates the client's own mention
 * inside a probe's raw response text, deterministically.
 *
 * This is deliberately NOT the same algorithm as
 * lib/evidence/normalize-entity-text.ts. That module answers "what
 * does this raw text normalize to"; this module answers a different,
 * narrower question — "where, if anywhere, does one of the client's
 * known brand terms literally appear in this raw response" — so that
 * an exact, unmodified substring of the original text (never a
 * normalized or rewritten form) can be captured as `raw_text` before
 * normalization ever runs. The two are always used in sequence by the
 * caller: locate first, then feed the located substring through
 * normalizeEntityTextV1 to get normalized_text. This file never
 * imports or calls that normalizer.
 *
 * Algorithm:
 *   1. Trim every candidate brand term; drop any that become empty.
 *   2. Drop any candidate whose lowercase form has a different length
 *      than the candidate itself (a length-expanding case fold, e.g.
 *      Turkish dotted capital I — U+0130 — becomes two UTF-16 code
 *      units when lowercased). Such a candidate is simply unsupported
 *      by this location step; it is never silently mishandled.
 *   3. For each surviving candidate, scan every position in the raw
 *      response and compare a same-length window's lowercase form to
 *      the candidate's own lowercase form. A match is only ever
 *      declared between two windows of the identical, known length —
 *      the full response string is never lowercased as a whole, so
 *      there is no offset-mapping step that could get misaligned.
 *   4. Among all matches found across all candidates, the one with the
 *      smallest starting position wins (the client is mentioned
 *      earliest in the answer). Ties at the same position are broken
 *      by longest candidate first (so "Acme Corp" wins over "Acme"
 *      when both match at the same offset), then by the candidate's
 *      position in the original brandTerms array.
 *   5. The winning match's span is sliced directly from the original
 *      (never lowercased) raw response — guaranteed to be an exact,
 *      unmodified substring whenever a match is reported.
 *
 * Returns the exact matched substring, or `null` if no candidate
 * matches anywhere in the text — never an invented or placeholder
 * string.
 */

interface Match {
  position: number;
  length: number;
  candidateIndex: number;
}

export function locateClientMention(
  rawResponse: string,
  brandTerms: readonly string[]
): string | null {
  if (typeof rawResponse !== "string" || rawResponse.length === 0) return null;

  const candidates: string[] = [];
  for (const term of brandTerms) {
    if (typeof term !== "string") continue;
    const trimmed = term.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length !== trimmed.toLowerCase().length) continue;
    candidates.push(trimmed);
  }

  let bestMatch: Match | null = null;

  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = candidates[candidateIndex]!;
    const candidateLower = candidate.toLowerCase();
    const candidateLength = candidate.length;

    for (let i = 0; i <= rawResponse.length - candidateLength; i += 1) {
      const window = rawResponse.slice(i, i + candidateLength);
      if (window.toLowerCase() === candidateLower) {
        const match: Match = { position: i, length: candidateLength, candidateIndex };
        if (
          bestMatch === null ||
          match.position < bestMatch.position ||
          (match.position === bestMatch.position && match.length > bestMatch.length) ||
          (match.position === bestMatch.position &&
            match.length === bestMatch.length &&
            match.candidateIndex < bestMatch.candidateIndex)
        ) {
          bestMatch = match;
        }
        break; // first occurrence only for this candidate
      }
    }
  }

  if (bestMatch === null) return null;
  return rawResponse.slice(bestMatch.position, bestMatch.position + bestMatch.length);
}
