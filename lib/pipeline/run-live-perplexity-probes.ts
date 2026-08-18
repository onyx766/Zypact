import { getDb } from "@/lib/db";
import type { GeneratedPrompt, ProbeResult } from "@/lib/db/types";
import { chooseCommercialPromptRows } from "@/lib/prompts/commercial-selection";
import { PerplexityProbeFailure, runPerplexityProbe } from "@/lib/probes/perplexity";
import { analyzeProbeResponse } from "@/lib/pipeline/analyze-probe-response";
import { SiteReaderOutputSchema } from "@/lib/schemas/site-reader.schema";
import { probeRequestLeaksClientIdentity } from "@/lib/probe-analysis/product-recommendation";

export interface RunLivePerplexityProbesInput {
  projectId: string;
  count?: number;
  runsPerPrompt?: number;
  promptIds?: string[];
  requireClientMentionedSomewhere?: boolean;
}

export type RunLivePerplexityProbesResult =
  | {
      ok: true;
      projectId: string;
      probesRun: number;
      results: ProbeResult[];
      rawClientMentionedSomewhere: boolean;
      analyzedClientMentionedSomewhere: boolean;
      usedMock: boolean;
    }
  | { ok: false; error: string; projectId: string; probesRun: number };

function brandTerms(project: { companyName: string | null; domain: string }, mirrorJson: unknown): string[] {
  const terms = new Set<string>();
  if (project.companyName?.trim()) terms.add(project.companyName.trim());
  const parsed = SiteReaderOutputSchema.safeParse(mirrorJson);
  if (parsed.success && parsed.data.companyName.trim()) terms.add(parsed.data.companyName.trim());
  if (project.domain.trim()) {
    terms.add(project.domain.trim());
    const stem = project.domain.split(".")[0]?.trim();
    if (stem && stem.length >= 3) terms.add(stem);
  }
  return [...terms];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function includesAnyTerm(text: string, terms: string[]): boolean {
  return terms.some((term) => {
    const t = term.trim();
    if (!t) return false;
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(t)}([^a-z0-9]|$)`, "i");
    return re.test(text);
  });
}


function choosePrompts(prompts: GeneratedPrompt[], input: RunLivePerplexityProbesInput): GeneratedPrompt[] {
  const selectedIds = new Set(input.promptIds ?? []);
  if (selectedIds.size > 0) {
    return prompts.filter((p) => selectedIds.has(p.id));
  }
  const selected = prompts.filter((p) => p.selected);
  const candidates = selected.length > 0 ? selected : prompts;
  const count = Math.max(1, Math.min(input.count ?? 3, candidates.length));
  return chooseCommercialPromptRows(candidates, count);
}

export async function runLivePerplexityProbes(
  input: RunLivePerplexityProbesInput,
): Promise<RunLivePerplexityProbesResult> {
  const db = getDb();
  const project = await db.getProject(input.projectId);
  if (!project) return { ok: false, error: "Project not found", projectId: input.projectId, probesRun: 0 };

  const prompts = await db.getGeneratedPrompts(input.projectId);
  if (prompts.length === 0) {
    return { ok: false, error: "Generate buyer prompts before running live Perplexity probes.", projectId: input.projectId, probesRun: 0 };
  }
  const promptTargets = choosePrompts(prompts, input);
  if (promptTargets.length === 0) {
    return { ok: false, error: "No matching prompts found for live Perplexity probe run.", projectId: input.projectId, probesRun: 0 };
  }

  const mirror = await db.getMirrorProfile(input.projectId);
  const mirrorParsed = mirror ? SiteReaderOutputSchema.safeParse(mirror.json) : null;
  const brandName =
    project.companyName?.trim() ||
    (mirrorParsed?.success ? mirrorParsed.data.companyName.trim() : "") ||
    project.domain.split(".")[0] ||
    project.domain;
  const terms = brandTerms(project, mirror?.json ?? null);
  const dbCompetitors = await db.getCompetitorsByProject(input.projectId);
  const mirrorCompetitors = mirrorParsed?.success ? mirrorParsed.data.competitorsMentioned : [];
  const knownCompetitors = Array.from(
    new Set([...dbCompetitors.map((c) => c.name), ...mirrorCompetitors].filter(Boolean)),
  );

  const results: ProbeResult[] = [];
  let rawClientMentionedSomewhere = false;
  let analyzedClientMentionedSomewhere = false;
  let usedMock = false;

  const runsPerPrompt = Math.max(1, Math.min(input.runsPerPrompt ?? 3, 10));

  for (const prompt of promptTargets) {
    for (let runIndex = 0; runIndex < runsPerPrompt; runIndex += 1) {
      let live;
      try {
        live = await runPerplexityProbe({
          prompt: prompt.prompt,
          brandName,
          domain: project.domain,
        });
      } catch (err) {
        if (err instanceof PerplexityProbeFailure) {
          // M1 second tranche — persist the failed attempt as evidence
          // before it propagates. `probeRunId` is omitted: no
          // `probe_runs` row exists yet at this point (it is only
          // created once `analyzeProbeResponse` starts, which requires a
          // successful probe answer).
          await db.recordProbeFailure({
            projectId: input.projectId,
            platform: "perplexity",
            prompt: prompt.prompt,
            failureReason: err.reason,
            providerHttpStatus: err.httpStatus,
            providerErrorBody: err.errorBody,
            providerErrorBodySha256: err.errorBodySha256,
            providerLatencyMs: err.latencyMs,
            providerRequestId: err.providerRequestId,
            rawProbeRequestSha256: err.rawProbeRequestSha256,
            fullRequestBodySha256: err.fullRequestBodySha256,
            retryCount: 0,
          });
        }
        throw err;
      }
      usedMock = usedMock || live.usedMock;
      rawClientMentionedSomewhere = rawClientMentionedSomewhere || includesAnyTerm(live.rawResponse, terms);

      if (probeRequestLeaksClientIdentity({
        rawRequest: live.rawProbeRequest ?? prompt.prompt,
        originalPrompt: prompt.prompt,
        brandTerms: terms,
        domain: project.domain,
      })) {
        return {
          ok: false,
          error: `Probe request integrity failed: client identity leaked outside the buyer prompt for prompt ${prompt.id}.`,
          projectId: input.projectId,
          probesRun: results.length,
        };
      }

      const analyzed = await analyzeProbeResponse({
        projectId: input.projectId,
        generatedPromptId: prompt.id,
        prompt: prompt.prompt,
        platform: "perplexity",
        rawResponse: live.rawResponse,
        rawProbeRequest: live.rawProbeRequest,
        knownCompetitors,
        probeMode: "live_perplexity",
        rawResponseSha256: live.rawResponseSha256,
        rawResponseBody: live.rawResponseBody,
        rawResponseBodySha256: live.rawResponseBodySha256,
        rawProbeRequestSha256: live.rawProbeRequestSha256,
        fullRequestBodySha256: live.fullRequestBodySha256,
        providerHttpStatus: live.httpStatus,
        providerLatencyMs: live.latencyMs,
        providerRequestId: live.providerRequestId,
        providerModel: live.model,
        retryCount: 0,
      });
      if (!analyzed.ok) {
        return {
          ok: false,
          error: analyzed.error,
          projectId: input.projectId,
          probesRun: results.length,
        };
      }
      analyzedClientMentionedSomewhere = analyzedClientMentionedSomewhere || analyzed.result.clientMentioned;
      results.push(analyzed.result);
    }
  }

  if (input.requireClientMentionedSomewhere && !rawClientMentionedSomewhere && !analyzedClientMentionedSomewhere) {
    return {
      ok: false,
      error: `Live Perplexity sanity check failed: none of the ${results.length} response(s) mentioned ${brandName}.`,
      projectId: input.projectId,
      probesRun: results.length,
    };
  }

  return {
    ok: true,
    projectId: input.projectId,
    probesRun: results.length,
    results,
    rawClientMentionedSomewhere,
    analyzedClientMentionedSomewhere,
    usedMock,
  };
}

export const __livePerplexityTestUtils = {
  choosePrompts,
  includesAnyTerm,
};
