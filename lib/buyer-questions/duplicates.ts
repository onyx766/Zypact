/**
 * Exact and near duplicates (design section 6; keys and stop words are
 * provisional v1, plan section 4.2).
 *
 * Exact duplicates share a duplicate key and are merged into one
 * candidate, keeping every source link. Near duplicates have content-token
 * Jaccard similarity of at least 0.8 (integer comparison). Near-duplicate
 * groups are the connected components of that relation, so "at most one
 * preselected per group" also means no near-duplicate pair is ever both
 * preselected.
 */

import { duplicateKey } from "./brand-match";
import { contentTokens, jaccardAtLeast } from "./normalize";
import { NEAR_DUPLICATE_THRESHOLD, type Candidate, type SiteContext } from "./types";

export interface DuplicateAnalysis {
  /** Candidate id to its duplicate key. */
  keys: Map<string, string>;
  /** Exact-duplicate groups of two or more ids, each sorted by id. */
  exactGroups: string[][];
  /** Near-duplicate groups of two or more ids, each sorted by id. */
  nearGroups: string[][];
  /** Candidate id to its near-duplicate group index, for grouped ids only. */
  nearGroupOf: Map<string, number>;
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `candidates` should be the ones still under consideration; the result
 * does not depend on their order.
 */
export function findDuplicates(candidates: readonly Candidate[], siteContext: SiteContext): DuplicateAnalysis {
  const ordered = [...candidates].sort((a, b) => byId(a.id, b.id));
  const keys = new Map(ordered.map((c) => [c.id, duplicateKey(c.text, siteContext)]));

  const exactByKey = new Map<string, string[]>();
  for (const c of ordered) {
    const key = keys.get(c.id) as string;
    exactByKey.set(key, [...(exactByKey.get(key) ?? []), c.id]);
  }
  const exactGroups = [...exactByKey.values()].filter((g) => g.length > 1);

  const parent = new Map(ordered.map((c) => [c.id, c.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    return root;
  };
  const tokens = new Map(ordered.map((c) => [c.id, contentTokens(keys.get(c.id) as string)]));
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
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
      }
    }
  }
  const components = new Map<string, string[]>();
  for (const c of ordered) {
    const root = find(c.id);
    components.set(root, [...(components.get(root) ?? []), c.id]);
  }
  const nearGroups = [...components.values()].filter((g) => g.length > 1).sort((a, b) => byId(a[0], b[0]));
  const nearGroupOf = new Map<string, number>();
  nearGroups.forEach((group, index) => group.forEach((id) => nearGroupOf.set(id, index)));

  return { keys, exactGroups, nearGroups, nearGroupOf };
}
