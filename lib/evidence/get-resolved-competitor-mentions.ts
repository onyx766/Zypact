import type { DbAdapter } from "@/lib/db/types";

/**
 * M3 — Source unique et rapports.
 *
 * The single, shared read path from the M2 canonical entity-resolution
 * layer (entity_observations/entity_aliases/canonical_entities) for
 * every downstream consumer that used to read the legacy
 * `probe_results.competitorsMentioned` JSON array directly. Built after
 * the M2-T3 architecture audit confirmed that Competitor Discovery, Gap
 * Map, Fix Agent, the scorecard, exports, and QA all read that legacy
 * field independently, with no shared logic and no canonical identity.
 *
 * Deliberately narrow: returns exactly the shape needed to reproduce
 * what those consumers already do (group/tally by identity, preserve
 * prompt provenance, preserve raw text/context/ordinal for display),
 * nothing more.
 *
 * `platform`-typed observations are never returned here — the pipeline
 * (lib/pipeline/analyze-probe-response.ts) never produces one; AI
 * platform names are filtered out and diverted to the entirely
 * separate `probe_results.platformsReferenced` legacy field before
 * entity resolution ever runs (lib/probe-analysis/product-recommendation.ts,
 * via lib/ai-platforms/platform-registry.ts's isAiPlatformName). This
 * module does not touch, read, or reconcile with that field — it stays
 * separate, by design.
 */
export interface ResolvedCompetitorMention {
  canonicalEntityId: string;
  rawText: string;
  normalizedText: string;
  mentionOrdinal: number;
  context: string | null;
  generatedPromptId: string | null;
}

/**
 * Reads the currently-active competitor observations for one
 * `probe_result`, scoped to one project.
 *
 * "Active" is entirely delegated to `entity_observations_active`
 * (migration 0041), read through the existing sanctioned adapter
 * method `getEntityObservationsActiveByProbeResult` — never the base
 * `entity_observations` table directly. That view already filters to
 * the pass whose `resolver_version` is the max among that
 * `probe_result`'s `completed` passes, so a v1/v2 mix can never reach
 * this function: exactly one resolver_version's rows are visible for
 * any given `probe_result`, by construction of the view, not by any
 * filtering done here.
 *
 * Excludes `excluded_brand_self` (the client's own brand, caught by
 * D-018's unconditional override) and `ambiguous`/`unresolved` (no
 * `canonicalEntityId` to group by) — only `status: "resolved"` with
 * `entityType: "competitor"` is ever returned. `entityType: "platform"`
 * is excluded too, even though the discriminated union technically
 * allows it, because the live pipeline never produces it (see the
 * module doc comment) — a future pipeline change that starts producing
 * platform-typed observations would need this function revisited
 * deliberately, not silently included here.
 *
 * `projectId` is a defensive, belt-and-suspenders check on top of the
 * schema's own composite foreign keys (0041): every returned
 * observation's own `projectId` is verified to match the one passed
 * in, and anything that somehow didn't would be dropped rather than
 * returned — this should never actually filter anything out in
 * practice, since `probeResultId` alone already scopes the query to
 * one project's data.
 *
 * No caller of this function may fall back to
 * `probe_results.competitorsMentioned` when the result is empty — an
 * empty array is a fully valid, unremarkable outcome (a probe_result
 * with zero competitor mentions, or one whose entity-resolution pass
 * never completed) exactly like `getEntityObservationsActiveByProbeResult`
 * itself already treats it: no row found is not an error, and no new
 * persistent status is invented here to represent it.
 */
export async function getResolvedCompetitorMentions(
  db: DbAdapter,
  projectId: string,
  probeResultId: string
): Promise<ResolvedCompetitorMention[]> {
  const observations = await db.getEntityObservationsActiveByProbeResult(probeResultId);

  const mentions: ResolvedCompetitorMention[] = [];
  for (const observation of observations) {
    if (observation.projectId !== projectId) continue;
    if (observation.status !== "resolved" || observation.entityType !== "competitor") continue;

    mentions.push({
      canonicalEntityId: observation.canonicalEntityId,
      rawText: observation.rawText,
      normalizedText: observation.normalizedText,
      mentionOrdinal: observation.mentionOrdinal,
      context: observation.context,
      generatedPromptId: observation.generatedPromptId,
    });
  }

  return mentions.sort((a, b) => a.mentionOrdinal - b.mentionOrdinal);
}

/**
 * Groups already-resolved mentions by their canonical identity —
 * `canonicalEntityId`, never a normalized name string. This is the
 * single shared grouping logic every migrated consumer should use
 * instead of its own ad-hoc `Map<nameKey, ...>` tally, so that two
 * surface forms of the same competitor (e.g. "Widgetco" and "Widgetco
 * Inc.") — already resolved to the same canonical entity by the RPC —
 * are counted as one identity here too, not re-split by string
 * comparison.
 *
 * Order-preserving: each group's mentions stay in the order they were
 * given (already mention-ordinal-sorted by getResolvedCompetitorMentions
 * when built from a single probe_result; callers merging mentions
 * across multiple probe_results should sort beforehand if a specific
 * cross-probe_result order matters to them).
 */
export function groupResolvedCompetitorMentionsByCanonicalEntity(
  mentions: readonly ResolvedCompetitorMention[]
): Map<string, ResolvedCompetitorMention[]> {
  const groups = new Map<string, ResolvedCompetitorMention[]>();
  for (const mention of mentions) {
    const existing = groups.get(mention.canonicalEntityId);
    if (existing) {
      existing.push(mention);
    } else {
      groups.set(mention.canonicalEntityId, [mention]);
    }
  }
  return groups;
}
