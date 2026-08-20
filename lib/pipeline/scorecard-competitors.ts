/**
 * Diagnostic competitor evidence, grounded in scored buyer probes.
 *
 * The Gap Map used to receive `db.getCompetitorsByProject(projectId)` — a
 * flat, project-wide list assembled by competitor discovery from crawled
 * pages and cited vendors. For the first real commercial snapshot that
 * produced a Gap Map full of reporting vendors (Improvado, Whatagraph,
 * Supermetrics) while the products AI actually recommended against the
 * client in the scored runs — Clari, Gong, Dreamdata, Ruler Analytics —
 * never appeared at all, and zero prioritized gaps came out.
 *
 * Two facts made that possible:
 *
 *   1. `probe-analysis` already separates `competitorsMentioned` (products
 *      recommended in the answer) from `sourcesCited` (URLs the answer
 *      referenced), but that distinction was discarded before the Gap Map.
 *      A vendor cited as a source in a generic answer is not evidence that
 *      it competes for the buyer's shortlist.
 *   2. The competitor list reaching the Gap Map carried no prompt
 *      provenance, so evidence from one buyer question could be used to
 *      explain a loss in another.
 *
 * This module rebuilds that evidence from the scorecard prompt groups and
 * keeps both properties: recommendation-only, and prompt-scoped. It is
 * pure — no database, no network, no provider.
 *
 * M3 — source unique: competitor identity now comes from the M2
 * canonical entity-resolution layer (`canonicalEntityId`, resolved via
 * lib/evidence/get-resolved-competitor-mentions.ts) rather than a raw,
 * un-deduplicated name string. This module stays pure and synchronous:
 * the caller (lib/pipeline/generate-gap-map.ts) is the DB-aware
 * orchestrator responsible for pre-fetching resolved mentions per
 * `probe_result` and passing them in as a plain map — never a database
 * call from here. Prompt-scoping is untouched: `resolvedMentionsByProbeResult`
 * is looked up only for the `probe_result` rows already inside each
 * `group.rows`, so evidence from one prompt still can never explain
 * another's loss.
 */

import type { PromptProbeAggregate } from "@/lib/probe-results/report-selection";
import type { Competitor, ProbeResult } from "@/lib/db/types";
import type { ResolvedCompetitorMention } from "@/lib/evidence/get-resolved-competitor-mentions";

/** Where a piece of competitor evidence came from. */
export type CompetitorEvidenceSource = "probe_recommended_product";

/**
 * One competitor, as evidenced by one scored prompt group.
 *
 * Deliberately not flattened to a global name list: `promptKey` is what
 * stops Prompt B's competitors from explaining Prompt A's loss.
 */
export interface DiagnosticCompetitorEvidence {
  name: string;
  nameKey: string;
  /** M3 — the canonical identity this evidence groups by; see module doc comment. */
  canonicalEntityId: string;
  prompt: string;
  promptKey: string;
  promptOutcome: PromptProbeAggregate["verdict"];
  /** Runs within this prompt group that recommended this product. */
  recommendationCount: number;
  /** Total runs in the prompt group, for frequency context. */
  runs: number;
  /** Best (lowest) position observed, when the analyser recorded one. */
  bestPosition: number | null;
  source: CompetitorEvidenceSource;
}

/** Competitor evidence for a single prompt group, provenance intact. */
export interface PromptCompetitorEvidence {
  prompt: string;
  promptKey: string;
  outcome: PromptProbeAggregate["verdict"];
  runs: number;
  competitors: DiagnosticCompetitorEvidence[];
}

export function normalizeCompetitorKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizePromptKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Aggregates one prompt group's runs into competitor evidence.
 *
 * Only resolved competitor observations are read (via
 * `resolvedMentionsByProbeResult`, pre-fetched by the caller from the M2
 * canonical layer). `sourcesCited` is deliberately never consulted: that
 * is the defect this module exists to close, and reading it here would
 * silently reintroduce vendor domains as strategic competitors.
 */
export function buildPromptCompetitorEvidence(
  group: PromptProbeAggregate,
  resolvedMentionsByProbeResult: ReadonlyMap<string, ResolvedCompetitorMention[]>
): PromptCompetitorEvidence {
  const rows: ProbeResult[] = group.rows ?? [];
  const byKey = new Map<string, DiagnosticCompetitorEvidence>();

  for (const row of rows) {
    // A single run may name the same product twice; count it once per run
    // so frequency means "runs that recommended it", not "times printed".
    const seenThisRun = new Set<string>();
    // Looked up only for probe_results already inside this prompt
    // group's own rows — evidence from another prompt group can never
    // leak in through this map, however many other probe_results it
    // happens to also carry entries for.
    const resolvedMentions = resolvedMentionsByProbeResult.get(row.id) ?? [];

    for (const mention of resolvedMentions) {
      const key = mention.canonicalEntityId;

      const existing = byKey.get(key);
      const countsThisRun = !seenThisRun.has(key);
      seenThisRun.add(key);

      if (!existing) {
        byKey.set(key, {
          name: mention.rawText,
          nameKey: normalizeCompetitorKey(mention.rawText),
          canonicalEntityId: key,
          prompt: group.prompt,
          promptKey: normalizePromptKey(group.prompt),
          promptOutcome: group.verdict,
          recommendationCount: countsThisRun ? 1 : 0,
          runs: group.runs,
          bestPosition: mention.mentionOrdinal,
          source: "probe_recommended_product",
        });
        continue;
      }

      if (countsThisRun) existing.recommendationCount += 1;
      if (mention.mentionOrdinal < (existing.bestPosition ?? Number.MAX_SAFE_INTEGER)) {
        existing.bestPosition = mention.mentionOrdinal;
      }
    }
  }

  const competitors = Array.from(byKey.values()).sort(
    (a, b) =>
      b.recommendationCount - a.recommendationCount ||
      (a.bestPosition ?? Number.MAX_SAFE_INTEGER) -
        (b.bestPosition ?? Number.MAX_SAFE_INTEGER) ||
      a.name.localeCompare(b.name)
  );

  return {
    prompt: group.prompt,
    promptKey: normalizePromptKey(group.prompt),
    outcome: group.verdict,
    runs: group.runs,
    competitors,
  };
}

/**
 * Prompt groups whose evidence may support a *recovery* gap.
 *
 * A won prompt is positive evidence: the client already holds that buyer
 * frame. Other products appearing alongside it is normal and must not be
 * read as a loss — doing so was how a winning prompt could be presented
 * back to a client as a problem. `not_relevant` groups carry no signal.
 */
export function isRecoveryEligible(
  outcome: PromptProbeAggregate["verdict"]
): boolean {
  return outcome === "lost" || outcome === "partial";
}

/**
 * The canonical diagnostic competitor evidence for a scan, grouped by
 * prompt. Callers that need a flat list should flatten *after* selecting a
 * prompt, never before.
 */
export function buildScorecardCompetitorEvidence(
  scorecardPromptGroups: PromptProbeAggregate[],
  resolvedMentionsByProbeResult: ReadonlyMap<string, ResolvedCompetitorMention[]>
): PromptCompetitorEvidence[] {
  return scorecardPromptGroups
    .map((group) => buildPromptCompetitorEvidence(group, resolvedMentionsByProbeResult))
    .filter((entry) => entry.competitors.length > 0);
}

/**
 * Names evidenced anywhere in the scored runs, for callers that must
 * intersect against a project-level list. Membership only — it carries no
 * provenance and must not be used to build a gap explanation.
 */
export function evidencedCompetitorKeys(
  evidence: PromptCompetitorEvidence[]
): Set<string> {
  const keys = new Set<string>();
  for (const entry of evidence) {
    for (const competitor of entry.competitors) keys.add(competitor.nameKey);
  }
  return keys;
}

/**
 * The competitor set handed to the Gap Map.
 *
 * Built from scored recommendation evidence only. Project rows — the
 * discovery table that mixes crawled vendors and cited sources with genuine
 * rivals — may enrich a product the scored runs already evidenced, but can
 * never introduce one: the result is keyed by `evidencedCompetitorKeys`, so
 * a name absent from that set has no entry to attach to.
 *
 * Pure: no database, no provider. `projectId` is data for the returned rows.
 */
export function buildDiagnosticCompetitors(params: {
  projectId: string;
  competitorEvidence: PromptCompetitorEvidence[];
  projectCompetitors: Competitor[];
}): Competitor[] {
  const { projectId, competitorEvidence, projectCompetitors } = params;

  const evidencedKeys = evidencedCompetitorKeys(competitorEvidence);
  const enrichmentByKey = new Map(
    projectCompetitors.map((row) => [normalizeCompetitorKey(row.name), row])
  );

  return Array.from(evidencedKeys).map((key) => {
    const evidenced = competitorEvidence
      .flatMap((entry) => entry.competitors)
      .filter((c) => c.nameKey === key);
    const strongest = evidenced.reduce((best, c) =>
      c.recommendationCount > best.recommendationCount ? c : best
    );
    const enrichment = enrichmentByKey.get(key);

    return {
      id: enrichment?.id ?? `scorecard:${key}`,
      projectId,
      name: enrichment?.name ?? strongest.name,
      website: enrichment?.website ?? null,
      discoverySource: "ai_answer",
      mentionCount: evidenced.reduce((sum, c) => sum + c.recommendationCount, 0),
      promptIds: enrichment?.promptIds ?? [],
      threatLevel: enrichment?.threatLevel ?? "medium",
      confidence: enrichment?.confidence ?? "unverified",
      isPhantom: enrichment?.isPhantom ?? false,
      isBlindSpot: enrichment?.isBlindSpot ?? false,
      // M3 — source unique: this row IS grounded in AI-probe evidence (its
      // discoverySource is hardcoded "ai_answer" above), so its canonical
      // identity is simply the one `strongest` was already grouped under —
      // not a re-derived guess, the same id used to build `evidenced`.
      canonicalEntityId: strongest.canonicalEntityId,
      createdAt: enrichment?.createdAt ?? new Date(0).toISOString(),
      updatedAt: enrichment?.updatedAt ?? new Date(0).toISOString(),
    };
  });
}
