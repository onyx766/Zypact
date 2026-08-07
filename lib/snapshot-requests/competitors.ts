/**
 * Founder competitor frame — application-side parsing and normalization.
 *
 * One implementation shared by the founder UI, the approval route, and the
 * tests. Three hand-copied normalizers would drift, and drift here is not
 * cosmetic: the stored list drives which competitors a paid scan measures.
 *
 * This mirrors two existing contracts exactly, and must keep mirroring them:
 *
 *   - `parseCompetitors` in scripts/run-approved-snapshot.ts, so a stored
 *     list can never produce a run the manual CLI would have rejected;
 *   - `_normalize_snapshot_competitors` in migration 0034, which is the
 *     authoritative validator.
 *
 * Nothing here is a security boundary. The RPC re-normalizes and re-validates
 * everything it is given; these functions exist so the founder sees a precise
 * message instead of a generic failure, and so the Approve button can be
 * disabled before a pointless round trip.
 */

/** Minimum competitors a scan needs to frame a comparison. */
export const MIN_COMPETITORS = 2;

/** MVP ceiling. A founder decision, not a plan entitlement. */
export const MAX_COMPETITORS = 12;

/** Per-entry length cap, matching the migration's check. */
export const MAX_COMPETITOR_LENGTH = 200;

export type CompetitorValidationError =
  | "competitors_required"
  | "competitors_below_minimum"
  | "competitors_above_maximum"
  | "competitor_too_long"
  | "competitor_is_scanned_company";

export type CompetitorParseResult =
  | { ok: true; competitors: string[] }
  | { ok: false; error: CompetitorValidationError };

/**
 * Splits founder input on newlines and commas.
 *
 * Both are supported because the textarea says "one per line" but a founder
 * pasting from a doc or a spreadsheet cell routinely produces commas, and
 * silently treating `"Alpha, Beta"` as a single competitor would store a
 * value no scan can use.
 *
 * Normalization order matches the SQL helper: trim, drop blanks, deduplicate
 * case-insensitively, keep first-seen casing, keep first-seen order.
 */
export function normalizeCompetitorList(
  values: readonly string[]
): string[] {
  const seen = new Set<string>();
  const competitors: string[] = [];

  for (const item of values) {
    const value = item.trim();
    if (value === "") continue;

    const key = value.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    competitors.push(value);
  }

  return competitors;
}

/** Splits raw textarea text into candidate entries, then normalizes. */
export function normalizeCompetitorInput(raw: string): string[] {
  return normalizeCompetitorList(raw.split(/[\n,]/));
}

/**
 * Parses and validates founder input.
 *
 * `scannedCompany` and `scannedDomain` are optional: the route knows them,
 * the client component may not. Omitting them skips only the self-reference
 * check, which the RPC still enforces.
 */
export function parseCompetitorsInput(
  raw: unknown,
  scannedCompany?: string | null,
  scannedDomain?: string | null
): CompetitorParseResult {
  if (typeof raw !== "string") {
    return { ok: false, error: "competitors_required" };
  }

  const competitors = normalizeCompetitorInput(raw);

  if (competitors.length < MIN_COMPETITORS) {
    return { ok: false, error: "competitors_below_minimum" };
  }

  if (competitors.length > MAX_COMPETITORS) {
    return { ok: false, error: "competitors_above_maximum" };
  }

  if (
    competitors.some(
      (value) => value.length > MAX_COMPETITOR_LENGTH
    )
  ) {
    return { ok: false, error: "competitor_too_long" };
  }

  // Same rule `discover-competitors.ts` already applies to discovery output:
  // a brand cannot be its own competitor, and a scan framed against itself
  // measures nothing.
  const self = [scannedCompany, scannedDomain]
    .map((value) => (value ?? "").trim().toLowerCase())
    .filter((value) => value !== "");

  if (
    competitors.some((value) =>
      self.includes(value.toLowerCase())
    )
  ) {
    return { ok: false, error: "competitor_is_scanned_company" };
  }

  return { ok: true, competitors };
}

/** Founder-facing message for each validation error. */
export function competitorErrorMessage(
  error: CompetitorValidationError
): string {
  switch (error) {
    case "competitors_required":
      return "Enter the competitors to frame this scan.";
    case "competitors_below_minimum":
      return `Add at least ${MIN_COMPETITORS} competitors.`;
    case "competitors_above_maximum":
      return `Add no more than ${MAX_COMPETITORS} competitors.`;
    case "competitor_too_long":
      return `Each competitor must be ${MAX_COMPETITOR_LENGTH} characters or fewer.`;
    case "competitor_is_scanned_company":
      return "A company cannot be listed as its own competitor.";
  }
}

/** Renders a stored list back into textarea text, one per line. */
export function competitorsToText(
  competitors: readonly string[]
): string {
  return competitors.join("\n");
}
