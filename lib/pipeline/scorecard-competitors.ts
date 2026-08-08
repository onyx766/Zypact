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
 */

import type { PromptProbeAggregate } from "@/lib/probe-results/report-selection";
import type { Competitor, ProbeResult } from "@/lib/db/types";

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
 * `ProbeResult.competitorsMentioned` is typed `unknown` in the row type and
 * narrowed by callers, so it is validated here rather than trusted. Rows
 * that do not carry a usable name are skipped rather than guessed at.
 */
function readMentions(
  value: unknown
): Array<{ name: string; position: number | null }> {
  if (!Array.isArray(value)) return [];

  const out: Array<{ name: string; position: number | null }> = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { name?: unknown; position?: unknown };
    if (typeof record.name !== "string") continue;
    const name = record.name.trim();
    if (name === "") continue;
    const position =
      typeof record.position === "number" && Number.isFinite(record.position)
        ? record.position
        : null;
    out.push({ name, position });
  }
  return out;
}

/**
 * Aggregates one prompt group's runs into competitor evidence.
 *
 * Only `competitorsMentioned` is read. `sourcesCited` is deliberately never
 * consulted: that is the defect this module exists to close, and reading it
 * here would silently reintroduce vendor domains as strategic competitors.
 */
export function buildPromptCompetitorEvidence(
  group: PromptProbeAggregate
): PromptCompetitorEvidence {
  const rows: ProbeResult[] = group.rows ?? [];
  const byKey = new Map<string, DiagnosticCompetitorEvidence>();

  for (const row of rows) {
    // A single run may name the same product twice; count it once per run
    // so frequency means "runs that recommended it", not "times printed".
    const seenThisRun = new Set<string>();

    for (const mention of readMentions(row.competitorsMentioned)) {
      const nameKey = normalizeCompetitorKey(mention.name);
      if (nameKey === "") continue;

      const existing = byKey.get(nameKey);
      const countsThisRun = !seenThisRun.has(nameKey);
      seenThisRun.add(nameKey);

      if (!existing) {
        byKey.set(nameKey, {
          name: mention.name,
          nameKey,
          prompt: group.prompt,
          promptKey: normalizePromptKey(group.prompt),
          promptOutcome: group.verdict,
          recommendationCount: countsThisRun ? 1 : 0,
          runs: group.runs,
          bestPosition: mention.position,
          source: "probe_recommended_product",
        });
        continue;
      }

      if (countsThisRun) existing.recommendationCount += 1;
      if (
        mention.position !== null &&
        (existing.bestPosition === null || mention.position < existing.bestPosition)
      ) {
        existing.bestPosition = mention.position;
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
  scorecardPromptGroups: PromptProbeAggregate[]
): PromptCompetitorEvidence[] {
  return scorecardPromptGroups
    .map((group) => buildPromptCompetitorEvidence(group))
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
      createdAt: enrichment?.createdAt ?? new Date(0).toISOString(),
      updatedAt: enrichment?.updatedAt ?? new Date(0).toISOString(),
    };
  });
}
