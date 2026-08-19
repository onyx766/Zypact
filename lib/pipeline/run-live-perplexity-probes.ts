import { getDb } from "@/lib/db";
import type { DatasetSourceType, GeneratedPrompt, ProbeResult } from "@/lib/db/types";
import { chooseCommercialPromptRows } from "@/lib/prompts/commercial-selection";
import { PerplexityProbeFailure, runPerplexityProbe } from "@/lib/probes/perplexity";
import { analyzeProbeResponse } from "@/lib/pipeline/analyze-probe-response";
import { failProbeRunOrThrow } from "@/lib/pipeline/mark-probe-run-failed";
import { SiteReaderOutputSchema } from "@/lib/schemas/site-reader.schema";
import { probeRequestLeaksClientIdentity } from "@/lib/probe-analysis/product-recommendation";

export interface RunLivePerplexityProbesInput {
  projectId: string;
  count?: number;
  runsPerPrompt?: number;
  promptIds?: string[];
  requireClientMentionedSomewhere?: boolean;
  /**
   * M2 canonical observations contract, second tranche (D-014) — the
   * dataset_batches row the caller already resolved or created before
   * calling this function. This function never creates or infers a
   * dataset identity itself: it has no way to know whether it is
   * running under an approved snapshot request or a bare manual
   * invocation, so guessing here would risk misclassifying as
   * manual_scan. Missing either field fails the call explicitly (see
   * below) rather than silently writing a null dataset identity.
   */
  datasetId: string;
  datasetSourceType: DatasetSourceType;
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
  // M2 canonical observations contract, second tranche (D-014) — fail
  // explicitly rather than writing a null dataset identity. This
  // function is never the place that decides manual_scan vs.
  // snapshot_request; the caller must have resolved it already.
  if (!input.datasetId || !input.datasetSourceType) {
    return {
      ok: false,
      error: "runLivePerplexityProbes requires a pre-resolved datasetId and datasetSourceType; this function does not create or infer a dataset_batches row.",
      projectId: input.projectId,
      probesRun: 0,
    };
  }
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
      // M1 evidence contract, fourth tranche — the run is created before
      // the provider call so a failure at any point below (provider
      // failure or the identity-leak check) has a real probe_runs row to
      // attach to. `analyzeProbeResponse` reuses this id and never
      // creates a second row for the same attempt.
      const probeRun = await db.createProbeRun(
        input.projectId,
        "perplexity",
        "live_perplexity",
        "pending"
      );
      await db.updateProbeRunDatasetIdentity(probeRun.id, {
        datasetId: input.datasetId,
        datasetSourceType: input.datasetSourceType,
      });

      let live;
      try {
        live = await runPerplexityProbe({
          prompt: prompt.prompt,
          brandName,
          domain: project.domain,
        });
      } catch (err) {
        if (err instanceof PerplexityProbeFailure) {
          // M1 second tranche, extended in the fourth tranche — persist
          // the failed attempt as evidence before it propagates, now
          // attached to the run created above.
          await db.recordProbeFailure({
            probeRunId: probeRun.id,
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
        // M1 evidence contract, fourth-tranche correction — no longer
        // `.catch(() => undefined)`. If the status write itself fails,
        // failProbeRunOrThrow throws a compound error instead of
        // silently leaving this run stuck in "pending"; the original
        // `err` is folded into that error's message so nothing is lost.
        // If the status write succeeds, execution reaches `throw err`
        // below exactly as before.
        await failProbeRunOrThrow(
          db,
          probeRun.id,
          `Perplexity probe failed for prompt "${prompt.prompt}": ${
            err instanceof Error ? err.message : String(err)
          }`
        );
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
        // M1 evidence contract, fourth tranche — deliberately does NOT
        // call db.recordProbeFailure here. `failure_reason` is
        // constrained to network_error/http_error/empty_answer (0037);
        // an identity leak is none of those, and inventing a value would
        // misrepresent what actually happened. Only the run's status is
        // recorded — that is honest and sufficient: the run existing and
        // marked failed is itself the evidence that something went
        // wrong for this attempt.
        //
        // Fourth-tranche correction — no longer `.catch(() => undefined)`:
        // a status-write failure here now throws instead of this function
        // returning a normal-looking `ok:false` result while the run
        // silently sits in "pending".
        const integrityError = `Probe request integrity failed: client identity leaked outside the buyer prompt for prompt ${prompt.id}.`;
        await failProbeRunOrThrow(db, probeRun.id, integrityError);
        return {
          ok: false,
          error: integrityError,
          projectId: input.projectId,
          probesRun: results.length,
        };
      }

      const analyzed = await analyzeProbeResponse({
        projectId: input.projectId,
        generatedPromptId: prompt.id,
        prompt: prompt.prompt,
        platform: "perplexity",
        probeRunId: probeRun.id,
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
        datasetId: input.datasetId,
        datasetSourceType: input.datasetSourceType,
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
