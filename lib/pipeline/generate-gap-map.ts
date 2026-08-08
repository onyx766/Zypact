import { runGapMapAgent } from "@/lib/agents/gap-map";
import {
  buildScorecardCompetitorEvidence,
  evidencedCompetitorKeys,
  isRecoveryEligible,
  normalizeCompetitorKey,
} from "@/lib/pipeline/scorecard-competitors";
import { getDb } from "@/lib/db";
import { buildProbeSetSummary } from "@/lib/probe-results/report-selection";
import type { Competitor, Gap, GapInput, GapMapRow } from "@/lib/db/types";
import {
  SiteReaderOutputSchema,
  type SiteReaderOutput,
} from "@/lib/schemas/site-reader.schema";
import type { GapMapOutput } from "@/lib/schemas/gap-map.schema";
import { withPipelineStep } from "./save-pipeline-step";

/**
 * Sprint 5 pipeline runner — Gap Map generation.
 *
 * Product rules:
 *  - Refuses to run without ProbeResults (409 upstream).
 *  - Refuses to run without Competitors (409 upstream).
 *  - Numeric truth of `recommendationDistance` is normalized in
 *    `runGapMapAgent` before the pipeline saves anything.
 */

export const NO_PROBE_RESULTS_MESSAGE =
  "Run at least one probe analysis before generating a gap map.";

export const NO_COMPETITORS_MESSAGE =
  "Run competitor discovery before generating a gap map.";

export interface GenerateGapMapInput {
  projectId: string;
}

export type GenerateGapMapResult =
  | {
      ok: true;
      projectId: string;
      gapMap: GapMapRow;
      output: GapMapOutput;
      gaps: Gap[];
      usedMock: boolean;
      usedRetry: boolean;
      normalizedDistances: boolean;
    }
  | { ok: false; error: string };

export async function generateGapMap(
  input: GenerateGapMapInput
): Promise<GenerateGapMapResult> {
  const db = getDb();
  const project = await db.getProject(input.projectId);
  if (!project) return { ok: false, error: "Project not found" };

  const mirrorRow = await db.getMirrorProfile(input.projectId);
  if (!mirrorRow) {
    return {
      ok: false,
      error:
        "No Mirror Profile found for this project. Run a Mirror Scan first.",
    };
  }
  const mirrorParse = SiteReaderOutputSchema.safeParse(mirrorRow.json);
  if (!mirrorParse.success) {
    return {
      ok: false,
      error: `Stored Mirror Profile failed schema validation: ${mirrorParse.error.message}`,
    };
  }
  const mirrorProfile: SiteReaderOutput = mirrorParse.data;

  const allProbeResults = await db.getProbeResultsByProject(input.projectId);
  const probeSummary = buildProbeSetSummary(allProbeResults, null, {
    brandTerms: [
      project.companyName ?? "",
      project.domain,
      mirrorProfile.companyName ?? "",
      mirrorProfile.website ?? "",
    ],
  });
  const probeResults = probeSummary.scorecardProbeResults;
  if (probeResults.length === 0) {
    return { ok: false, error: NO_PROBE_RESULTS_MESSAGE };
  }

  // Competitor evidence is grounded in the scored buyer probes rather than
  // the project-wide discovery table. That table mixes crawled vendors and
  // cited sources with genuine shortlist rivals and carries no prompt
  // provenance, which is how reporting vendors displaced the products AI
  // actually recommended against the client and left zero usable gaps.
  //
  // Only prompt groups that can support a *recovery* gap contribute: a won
  // prompt is positive evidence and must never be read as a loss.
  const competitorEvidence = buildScorecardCompetitorEvidence(
    probeSummary.scorecardPromptGroups
  ).filter((entry) => isRecoveryEligible(entry.outcome));

  const evidencedKeys = evidencedCompetitorKeys(competitorEvidence);
  const projectCompetitors = await db.getCompetitorsByProject(input.projectId);

  // Project rows may enrich a product the scored runs already evidenced
  // (website, ids, threat level). They may not introduce one: a name with no
  // recommendation evidence has not been shown to compete for this buyer.
  const enrichmentByKey = new Map(
    projectCompetitors.map((row) => [normalizeCompetitorKey(row.name), row])
  );

  const competitors: Competitor[] = Array.from(evidencedKeys).map((key) => {
    const evidenced = competitorEvidence
      .flatMap((entry) => entry.competitors)
      .filter((c) => c.nameKey === key);
    const strongest = evidenced.reduce((best, c) =>
      c.recommendationCount > best.recommendationCount ? c : best
    );
    const enrichment = enrichmentByKey.get(key);

    return {
      id: enrichment?.id ?? `scorecard:${key}`,
      projectId: input.projectId,
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

  if (competitors.length === 0) {
    return { ok: false, error: NO_COMPETITORS_MESSAGE };
  }

  try {
    const agent = await withPipelineStep(
      { projectId: input.projectId, agent: "gap-map" },
      () =>
        runGapMapAgent({
          mirrorProfile,
          probeResults,
          competitors,
          competitorEvidence,
        })
    );

    const gapMapRow = await db.saveGapMap(input.projectId, agent.output);

    const gapInputs: GapInput[] = agent.output.prioritizedGaps.map((g) => ({
      // A gap is a global insight; competitorName is nullable in the schema.
      // Sprint 5 keeps it null — a later sprint (Fix Agent) will attribute
      // gaps back to specific competitors when required.
      competitorName: null,
      type: g.type,
      severity: g.severity,
      explanation: g.explanation,
      affectedPrompts: [...g.affectedPrompts],
      suggestedFixDirection: g.suggestedFixDirection,
    }));

    const gaps = await db.replaceGapsForProject(input.projectId, gapInputs);

    return {
      ok: true,
      projectId: input.projectId,
      gapMap: gapMapRow,
      output: agent.output,
      gaps,
      usedMock: agent.usedMock,
      usedRetry: agent.usedRetry,
      normalizedDistances: agent.normalizedDistances,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
