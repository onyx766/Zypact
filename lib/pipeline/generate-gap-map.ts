import { runGapMapAgent } from "@/lib/agents/gap-map";
import { getDb } from "@/lib/db";
import { buildProbeSetSummary } from "@/lib/probe-results/report-selection";
import type { Gap, GapInput, GapMapRow } from "@/lib/db/types";
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

  const competitors = await db.getCompetitorsByProject(input.projectId);
  if (competitors.length === 0) {
    return { ok: false, error: NO_COMPETITORS_MESSAGE };
  }

  try {
    const agent = await withPipelineStep(
      { projectId: input.projectId, agent: "gap-map" },
      () => runGapMapAgent({ mirrorProfile, probeResults, competitors })
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
