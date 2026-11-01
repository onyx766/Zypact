/**
 * Exact and near duplicates (design section 6; keys and stop words are
 * provisional v1, plan section 4.2).
 *
 * Exact duplicates share a duplicate key and are merged into one
 * candidate, keeping every source link. Near duplicates are pairs whose
 * content-token Jaccard similarity is at least 0.8 (integer comparison).
 * The relation is used pairwise and never closed transitively: two
 * candidates below 0.8 are never treated as near duplicates because a
 * third candidate is similar to both.
 */

import { duplicateKey } from "./brand-match";
import { contentTokens, jaccardAtLeast } from "./normalize";
import { NEAR_DUPLICATE_THRESHOLD, type Candidate, type SiteContext } from "./types";

export interface DuplicateAnalysis {
  /** Candidate id to its duplicate key. */
  keys: Map<string, string>;
  /** Exact-duplicate groups of two or more ids, each sorted by id. */
  exactGroups: string[][];
  /** Candidate id to the ids directly at or above the threshold, sorted. */
  nearOf: Map<string, string[]>;
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The result does not depend on the order of `candidates`. */
export function findDuplicates(candidates: readonly Candidate[], siteContext: SiteContext): DuplicateAnalysis {
  const ordered = [...candidates].sort((a, b) => byId(a.id, b.id));
  const keys = new Map(ordered.map((c) => [c.id, duplicateKey(c.text, siteContext)]));

  const exactByKey = new Map<string, string[]>();
  for (const c of ordered) {
    const key = keys.get(c.id) as string;
    exactByKey.set(key, [...(exactByKey.get(key) ?? []), c.id]);
  }
  const exactGroups = [...exactByKey.values()].filter((g) => g.length > 1);

  const tokens = new Map(ordered.map((c) => [c.id, contentTokens(keys.get(c.id) as string)]));
  const nearOf = new Map<string, string[]>(ordered.map((c) => [c.id, []]));
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const a = ordered[i].id;
      const b = ordered[j].id;
      const similar = jaccardAtLeast(
        tokens.get(a) as Set<string>,
        tokens.get(b) as Set<string>,
        NEAR_DUPLICATE_THRESHOLD.numerator,
        NEAR_DUPLICATE_THRESHOLD.denominator
      );
      if (similar) {
        (nearOf.get(a) as string[]).push(b);
        (nearOf.get(b) as string[]).push(a);
      }
    }
  }
  return { keys, exactGroups, nearOf };
}
