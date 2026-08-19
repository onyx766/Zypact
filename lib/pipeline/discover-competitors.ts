import { runCompetitorDiscoveryAgent } from "@/lib/agents/competitor-discovery";
import { recordAnalysisTrace } from "@/lib/evidence/analysis-trace";
import { getDb } from "@/lib/db";
import { buildProbeSetSummary } from "@/lib/probe-results/report-selection";
import { isAiPlatformName } from "@/lib/ai-platforms/platform-registry";
import type { Competitor, CompetitorInput } from "@/lib/db/types";
import {
  SiteReaderOutputSchema,
  type SiteReaderOutput,
} from "@/lib/schemas/site-reader.schema";
import type { CompetitorDiscoveryOutput } from "@/lib/schemas/competitor-discovery.schema";
import { withPipelineStep } from "./save-pipeline-step";

/**
 * Sprint 4 pipeline runner — Competitor Discovery.
 *
 * Product rule: refuses to run when there are zero ProbeResults. We only
 * want competitors grounded in probe evidence for the MVP.
 */

export const NO_PROBE_RESULTS_MESSAGE =
  "Run at least one probe analysis before discovering competitors.";

export interface DiscoverCompetitorsInput {
  projectId: string;
  userCompetitors?: string[];
}

export type DiscoverCompetitorsResult =
  | {
      ok: true;
      projectId: string;
      stored: Competitor[];
      output: CompetitorDiscoveryOutput;
      usedMock: boolean;
      usedRetry: boolean;
    }
  | { ok: false; error: string };

function normalizeKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\.(com|io|ai|co|net|org)\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function isClientSelfName(name: string, mirrorProfile: SiteReaderOutput, project: { companyName: string | null; domain: string }): boolean {
  const key = normalizeKey(name);
  const company = normalizeKey(mirrorProfile.companyName || project.companyName || "");
  const domain = normalizeKey(project.domain);
  const website = normalizeKey((mirrorProfile.website || "").replace(/^https?:\/\//, "").split("/")[0] || "");
  return Boolean(key && (key === company || key === domain || key === website));
}

export async function discoverCompetitors(
  input: DiscoverCompetitorsInput
): Promise<DiscoverCompetitorsResult> {
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

  // Build a priorityByPromptId map so the mock (and any future business
  // logic) can flag "top rec in a high-priority prompt" as high threat.
  const prompts = await db.getGeneratedPrompts(input.projectId);
  const priorityByPromptId: Record<string, number> = {};
  for (const p of prompts) priorityByPromptId[p.id] = p.priority;

  try {
    const agent = await withPipelineStep(
      { projectId: input.projectId, agent: "competitor-discovery" },
      () =>
        runCompetitorDiscoveryAgent({
          mirrorProfile,
          userCompetitors: input.userCompetitors,
          probeResults,
          priorityByPromptId,
        })
    );

    // M1 evidence contract, third tranche.
    await recordAnalysisTrace({
      projectId: input.projectId,
      stage: "competitor-discovery",
      provider: agent.provider,
      model: agent.model,
      usedMock: agent.usedMock,
      usedRetry: agent.usedRetry,
      latencyMs: agent.latencyMs,
      requestText: agent.requestText,
      responseValue: agent.output,
    });

    const phantomSet = new Set(
      agent.output.phantomCompetitors.map(normalizeKey)
    );
    const blindSet = new Set(agent.output.blindSpots.map(normalizeKey));

    const rows: CompetitorInput[] = agent.output.competitors
      .filter((c) => !isClientSelfName(c.name, mirrorProfile, project))
      .filter((c) => !isAiPlatformName(c.name))
      .map((c) => ({
        name: c.name,
        website: c.website,
        discoverySource: c.discoverySource,
        mentionCount: c.mentionCount,
        promptIds: [...c.promptIds],
        threatLevel: c.threatLevel,
        confidence: c.confidence,
        isPhantom: phantomSet.has(normalizeKey(c.name)),
        isBlindSpot: blindSet.has(normalizeKey(c.name)),
      }));

    const stored = await db.replaceCompetitorsForProject(input.projectId, rows);

    return {
      ok: true,
      projectId: input.projectId,
      stored,
      output: agent.output,
      usedMock: agent.usedMock,
      usedRetry: agent.usedRetry,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
