/**
 * Competitor names in the pilot report: which spellings are one company, and
 * when a name that joins several brands ("A and B") is counted as each brand.
 *
 * The analysis model reads competitor names from each answer, so one company
 * can arrive under several spellings (OtterlyAI, Otterly AI, Otterly.ai). The
 * report groups spellings only by exact match against the fixed, reviewed list
 * below, after the report's own key (trim and lower case). Nothing is matched
 * by similarity: two spellings not on the list stay two rows.
 *
 * Changing the list changes what a customer reads, so it bumps
 * COMPETITOR_ALIAS_LIST_VERSION and is reviewed like any other methodology
 * rule (the same rule as lib/source-insights/source-types.ts). Every original
 * spelling stays in the payload beside the grouped name.
 *
 * Pure: no database, network, provider or model.
 */

export const COMPETITOR_ALIAS_LIST_VERSION = "competitor-aliases/1";

export interface CompetitorAliasEntry {
  /** The name the report shows. */
  name: string;
  /** Exact spellings of the same company, compared after trim and lower case. */
  aliases: readonly string[];
}

/**
 * The reviewed list.
 *
 * TODO(founder review): add the verified aliases from the practice pilot's
 * real competitor names. Add a company only when the spellings are verified
 * to be the same company (its own site or listing), never because two names
 * look alike, and bump COMPETITOR_ALIAS_LIST_VERSION with each change.
 */
export const COMPETITOR_ALIASES: readonly CompetitorAliasEntry[] = [
  { name: "Otterly.AI", aliases: ["OtterlyAI", "Otterly AI", "Otterly.ai"] },
];

/** The report's grouping key: the same name apart from surrounding spaces and capital letters. */
export function competitorKey(name: string): string {
  return name.trim().toLowerCase();
}

const ALIAS_INDEX: ReadonlyMap<string, CompetitorAliasEntry> = (() => {
  const index = new Map<string, CompetitorAliasEntry>();
  for (const entry of COMPETITOR_ALIASES) {
    for (const spelling of [entry.name, ...entry.aliases]) {
      const key = competitorKey(spelling);
      const existing = index.get(key);
      if (existing && existing !== entry) {
        throw new Error(`competitor-aliases: "${spelling}" is listed under two companies.`);
      }
      index.set(key, entry);
    }
  }
  return index;
})();

/** The listed company a spelling belongs to, or null when it is not on the list. */
export function listedCompany(name: string): CompetitorAliasEntry | null {
  return ALIAS_INDEX.get(competitorKey(name)) ?? null;
}

/**
 * The key a spelling is grouped under: the listed company's key when the
 * spelling is on the list, otherwise its own key.
 */
export function canonicalCompetitorKey(name: string): string {
  const listed = listedCompany(name);
  return listed ? `listed:${competitorKey(listed.name)}` : competitorKey(name);
}

/**
 * Separators that may join several brands in one name: " and ", " & " and
 * " / " with spaces around them, and a comma. "AT&T" or "A/B Testing Co" are
 * never split, because their separator has no spaces around it.
 */
const JOINED = /\s+(?:and|&|\/)\s+|\s*,\s*/i;

/**
 * The parts of a name that joins several brands, or null when it does not.
 * A name is split only when every part is a listed company or is named on
 * its own elsewhere (`standalone`, the grouped keys of names that join
 * nothing, for the same engine). Otherwise it is kept whole, so a company
 * whose own name contains "&" or "and" stays one row.
 */
export function splitJoinedName(name: string, standalone: ReadonlySet<string>): string[] | null {
  const trimmed = name.trim();
  if (!JOINED.test(trimmed)) return null;
  const parts = trimmed.split(JOINED).map((p) => p.trim());
  if (parts.length < 2 || parts.some((p) => p === "")) return null;
  const known = parts.every((p) => listedCompany(p) !== null || standalone.has(canonicalCompetitorKey(p)));
  return known ? parts : null;
}

/** Whether a name contains a separator that may join several brands. */
export function mayJoinSeveralNames(name: string): boolean {
  return JOINED.test(name.trim());
}
