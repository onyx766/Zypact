import { runProbeAnalysisAgent } from "@/lib/agents/probe-analysis";
import { getDb } from "@/lib/db";
import type { ProbeMode, ProbeResult } from "@/lib/db/types";
import { sha256Hex } from "@/lib/evidence/hash";
import { mergeSourcesFromRawResponse } from "@/lib/probe-analysis/merge-sources";
import { classifyProductRecommendation } from "@/lib/probe-analysis/product-recommendation";
import {
  SiteReaderOutputSchema,
  type SiteReaderOutput,
} from "@/lib/schemas/site-reader.schema";
import type {
  ClientIdentity,
  Platform,
  ProbeAnalysisOutput,
} from "@/lib/schemas/probe-analysis.schema";
import { withPipelineStep } from "./save-pipeline-step";

/**
 * Sprint 3 pipeline runner.
 *
 * 1. Load the project + latest Mirror Profile (for client identity + competitors).
 * 2. Create a ProbeRun (status="pending").
 * 3. Run Probe Analysis Agent on the pasted response.
 * 4. Persist a ProbeResult with the raw response.
 * 5. Mark the ProbeRun succeeded/failed.
 */

export interface AnalyzeProbeResponseInput {
  projectId: string;
  generatedPromptId?: string | null;
  prompt: string;
  platform: Platform;
  rawResponse: string;
  /** Sprint 13C — exact buyer prompt sent to the live platform, if available. */
  rawProbeRequest?: string;
  /** Extra competitors on top of what the Mirror Profile stored. */
  knownCompetitors?: string[];
  /**
   * Defaults to `simulated` for pasted/manual answers. Sprint 13 sets
   * `live_perplexity` when the raw answer was fetched from Perplexity
   * Sonar before being analyzed by Zypact.
   */
  probeMode?: ProbeMode;
  /** M1 evidence contract — Perplexity evidence metadata, present only for live calls. */
  rawResponseSha256?: string;
  rawProbeRequestSha256?: string;
  fullRequestBodySha256?: string;
  providerHttpStatus?: number;
  providerLatencyMs?: number;
  providerRequestId?: string | null;
  providerModel?: string;
  retryCount?: number;
}

export type AnalyzeProbeResponseResult =
  | {
      ok: true;
      probeRunId: string;
      result: ProbeResult;
      output: ProbeAnalysisOutput;
      usedMock: boolean;
      usedRetry: boolean;
    }
  | { ok: false; error: string; probeRunId?: string };

function buildClientIdentity(
  project: { companyName: string | null; domain: string },
  mp: SiteReaderOutput | null
): ClientIdentity {
  const name =
    (project.companyName && project.companyName.trim()) ||
    (mp?.companyName && mp.companyName.trim()) ||
    project.domain.split(".")[0];
  const aliases = new Set<string>();
  if (mp?.companyName && mp.companyName !== name) aliases.add(mp.companyName);
  const stem = project.domain.split(".")[0];
  if (stem && stem !== name) aliases.add(stem);
  return {
    name,
    domain: project.domain,
    aliases: Array.from(aliases),
  };
}

function mergeCompetitors(
  fromRequest: string[] | undefined,
  fromMirror: string[]
): string[] {
  const set = new Set<string>();
  for (const c of fromMirror) if (c.trim()) set.add(c.trim());
  for (const c of fromRequest ?? []) if (c.trim()) set.add(c.trim());
  return Array.from(set);
}

export async function analyzeProbeResponse(
  input: AnalyzeProbeResponseInput
): Promise<AnalyzeProbeResponseResult> {
  const db = getDb();
  const project = await db.getProject(input.projectId);
  if (!project) return { ok: false, error: "Project not found" };

  const mirrorRow = await db.getMirrorProfile(input.projectId);
  const mirrorProfile: SiteReaderOutput | null = mirrorRow
    ? (() => {
        const parsed = SiteReaderOutputSchema.safeParse(mirrorRow.json);
        return parsed.success ? parsed.data : null;
      })()
    : null;

  const clientName = buildClientIdentity(project, mirrorProfile);
  const knownCompetitors = mergeCompetitors(
    input.knownCompetitors,
    mirrorProfile?.competitorsMentioned ?? []
  );

  const probeMode = input.probeMode ?? "simulated";
  const probeRun = await db.createProbeRun(
    input.projectId,
    input.platform,
    probeMode,
    "pending"
  );

  try {
    const agent = await withPipelineStep(
      { projectId: input.projectId, agent: "probe-analysis" },
      () =>
        runProbeAnalysisAgent({
          prompt: input.prompt,
          platform: input.platform,
          aiResponse: input.rawResponse,
          clientName,
          knownCompetitors,
        })
    );

    // Sprint 12, Task 3 — safety net for the `sourcesCited` wiring.
    // Live-LLM probe analysis frequently returns `sourcesCited: []` even
    // when the pasted response contains explicit URLs. That silently
    // starves the Gap Map's citation scoring. Merge URLs extracted
    // deterministically from `rawResponse` into whatever the LLM
    // returned, without editing the agent prompt. This is a wiring fix,
    // not a prompt change.
    const mergedSourcesCited = mergeSourcesFromRawResponse(
      input.rawResponse,
      agent.output.sourcesCited
    );

    const brandTerms = [
      clientName.name,
      clientName.domain ?? "",
      ...(clientName.aliases ?? []),
    ];
    const productSignals = classifyProductRecommendation({
      prompt: input.prompt,
      rawResponse: input.rawResponse,
      brandTerms,
      domain: project.domain,
      competitorsMentioned: agent.output.competitorsMentioned,
      sourcesCited: mergedSourcesCited as Array<{ source: string; type: any }>,
      clientPosition: agent.output.clientPosition,
    });

    // M1 evidence contract — internal-analysis traceability, kept in its
    // own append-only table, separate from the Perplexity probe evidence
    // saved below. Best-effort ordering: recorded after the agent call
    // succeeds so a failed/thrown agent call never produces a dangling
    // trace row with no corresponding probe result.
    await db.recordAnalysisLlmCall({
      projectId: input.projectId,
      stage: "probe-analysis",
      provider: agent.provider,
      model: agent.model,
      usedMock: agent.usedMock,
      usedRetry: agent.usedRetry,
      latencyMs: agent.latencyMs,
      requestSha256: sha256Hex(agent.requestText),
      responseSha256: sha256Hex(JSON.stringify(agent.output)),
    });

    const result = await db.saveProbeResult({
      probeRunId: probeRun.id,
      projectId: input.projectId,
      generatedPromptId: input.generatedPromptId ?? null,
      prompt: input.prompt,
      platform: input.platform,
      probeMode,
      rawResponse: input.rawResponse,
      rawProbeRequest: input.rawProbeRequest ?? input.prompt,
      productMentioned: productSignals.productMentioned,
      productPosition: productSignals.productPosition,
      productVerdict: productSignals.productVerdict,
      citedAsSource: productSignals.citedAsSource,
      clientSourceCount: productSignals.clientSourceCount,
      platformsReferenced: productSignals.platformReferences,
      clientMentioned: agent.output.clientMentioned,
      clientPosition: agent.output.clientPosition,
      competitorsMentioned: productSignals.directCompetitorsMentioned,
      sourcesCited: mergedSourcesCited,
      answerSummary: agent.output.answerSummary,
      verdict: productSignals.productVerdict,
      whyClientLost:
        productSignals.productPosition === "negative" && !agent.output.whyClientLost.trim()
          ? "The brand was mentioned negatively and was not recommended as a product/tool."
          : productSignals.productVerdict === "lost" && !agent.output.whyClientLost.trim()
            ? "The brand was cited as a source or omitted, but was not recommended as a product/tool."
            : agent.output.whyClientLost,
      rawResponseSha256: input.rawResponseSha256,
      rawProbeRequestSha256: input.rawProbeRequestSha256,
      fullRequestBodySha256: input.fullRequestBodySha256,
      providerHttpStatus: input.providerHttpStatus,
      providerLatencyMs: input.providerLatencyMs,
      providerRequestId: input.providerRequestId,
      providerModel: input.providerModel,
      retryCount: input.retryCount,
    });

    await db.updateProbeRunStatus(probeRun.id, "succeeded");

    return {
      ok: true,
      probeRunId: probeRun.id,
      result,
      output: agent.output,
      usedMock: agent.usedMock,
      usedRetry: agent.usedRetry,
    };
  } catch (err) {
    await db.updateProbeRunStatus(probeRun.id, "failed").catch(() => undefined);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      probeRunId: probeRun.id,
    };
  }
}
