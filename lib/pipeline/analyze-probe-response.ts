import { runProbeAnalysisAgent } from "@/lib/agents/probe-analysis";
import { getDb } from "@/lib/db";
import type { DatasetSourceType, ProbeMode, ProbeResult } from "@/lib/db/types";
import { sha256Hex } from "@/lib/evidence/hash";
import { locateClientMention } from "@/lib/evidence/locate-client-mention";
import { normalizeEntityTextV1 } from "@/lib/evidence/normalize-entity-text";
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
 * 2. Create a ProbeRun (status="pending") — or reuse `input.probeRunId` if
 *    the caller already created one (M1 fourth tranche; see that field's
 *    doc comment). Exactly one run either way, never both.
 * 3. Run Probe Analysis Agent on the pasted response.
 * 4. Persist a ProbeResult with the raw response.
 * 5. Mark the ProbeRun succeeded/failed.
 * 6. M2 canonical observations contract, third tranche (D-017, D-018,
 *    D-019) — resolve entity mentions (the client's own mention, if
 *    located, plus each competitor mention), only after steps 4-5 have
 *    already succeeded. Never blocks, delays, or rolls back the
 *    evidence write; any failure here is surfaced only as
 *    entityResolutionError on an otherwise-successful result.
 */

/**
 * M2 canonical observations contract, third tranche (D-017 §5) — the
 * deterministic v1 normalizer's version, pinned as the resolver
 * version every entity-resolution call in this file uses. Changing the
 * normalization algorithm (lib/evidence/normalize-entity-text.ts) is a
 * new resolver_version, never a silent edit of this constant's meaning.
 */
const ENTITY_RESOLVER_VERSION = 1;

export interface AnalyzeProbeResponseInput {
  projectId: string;
  generatedPromptId?: string | null;
  prompt: string;
  platform: Platform;
  /**
   * M1 evidence contract, fourth tranche — an already-created `probe_runs`
   * row to reuse (e.g. one created by the caller before a live Perplexity
   * call, so a failure prior to this function has something to attach
   * to). When omitted, behavior is unchanged from before this tranche:
   * this function creates its own run. Never creates a second run when
   * one is supplied.
   */
  probeRunId?: string;
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
  rawResponseBody?: string;
  rawResponseBodySha256?: string;
  rawProbeRequestSha256?: string;
  fullRequestBodySha256?: string;
  providerHttpStatus?: number;
  providerLatencyMs?: number;
  providerRequestId?: string | null;
  providerModel?: string;
  retryCount?: number;
  /**
   * M2 canonical observations contract, third tranche (runtime writer
   * hardening) — the dataset_batches row the caller must resolve or
   * create before calling this function. Mandatory: every production
   * writer of probe_runs/probe_results funnels through this function,
   * so this is the point where a missing dataset identity is closed
   * off structurally, not left to each individual caller's discipline.
   * Used both for saveProbeResult below and, when this function
   * creates its own probe_run (no probeRunId supplied), passed
   * directly into createProbeRun's INSERT — never via a later UPDATE.
   */
  datasetId: string;
  datasetSourceType: DatasetSourceType;
}

export type AnalyzeProbeResponseResult =
  | {
      ok: true;
      probeRunId: string;
      result: ProbeResult;
      output: ProbeAnalysisOutput;
      usedMock: boolean;
      usedRetry: boolean;
      /**
       * M2 canonical observations contract, third tranche (D-017/D-018
       * correction turn) — present (a non-null string) only when entity
       * resolution failed, or an explicit final check found the pass had
       * not reached a verified `completed` status. Its absence reflects
       * that explicit verification, never an inference from "nothing
       * threw." `ok: true` and `result` above are entirely unaffected by
       * this field either way — the evidence write already succeeded
       * before entity resolution ever begins.
       */
      entityResolutionError?: string;
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
  // M1 evidence contract, fourth tranche — reuse a run the caller already
  // created (typically before the live provider call) rather than
  // creating a second one for the same logical attempt. `getProbeRun`
  // is intentionally not called here to re-validate `input.probeRunId`:
  // the caller is trusted to pass an id it just created itself.
  const probeRun = input.probeRunId
    ? { id: input.probeRunId }
    : await db.createProbeRun(
        input.projectId,
        input.platform,
        probeMode,
        "pending",
        { datasetId: input.datasetId, datasetSourceType: input.datasetSourceType }
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
      rawResponseBody: input.rawResponseBody,
      rawResponseBodySha256: input.rawResponseBodySha256,
      rawProbeRequestSha256: input.rawProbeRequestSha256,
      fullRequestBodySha256: input.fullRequestBodySha256,
      providerHttpStatus: input.providerHttpStatus,
      providerLatencyMs: input.providerLatencyMs,
      providerRequestId: input.providerRequestId,
      providerModel: input.providerModel,
      retryCount: input.retryCount,
      datasetId: input.datasetId,
      datasetSourceType: input.datasetSourceType,
    });

    await db.updateProbeRunStatus(probeRun.id, "succeeded");

    // M2 canonical observations contract, third tranche (D-017, D-018,
    // D-019). Isolated in its own try/catch, deliberately separate from
    // the outer one below: the evidence write (saveProbeResult,
    // updateProbeRunStatus) has already fully succeeded above, and must
    // never be reinterpreted as a failure by anything that follows. Any
    // problem here is captured locally as entityResolutionError, never
    // by falling through to the outer catch (which would incorrectly
    // flip this already-succeeded run's status and return ok:false).
    let entityResolutionError: string | undefined;
    try {
      // Runs unconditionally, independent of agent.output.clientMentioned
      // — the LLM's own boolean judgment is not trusted as the gate for
      // whether to look; the raw text itself is the only source of
      // truth, exactly like the RPC's own unconditional brand-self
      // check for competitor mentions (D-018).
      const clientRawText = locateClientMention(input.rawResponse, brandTerms);
      const normalizedBrandTerms = brandTerms
        .map((term) => normalizeEntityTextV1(term))
        .filter((normalized) => normalized.length > 0);

      // directCompetitorsMentioned's own type leaves every field
      // optional; a mention with no usable name has nothing to resolve
      // as an entity, so it is excluded here — before
      // expectedMentionCount is computed — rather than counted and then
      // failing to produce a row.
      const competitorMentions = productSignals.directCompetitorsMentioned.filter(
        (c): c is { name: string; position?: number; context?: string } =>
          typeof c.name === "string" && c.name.trim().length > 0
      );
      const expectedMentionCount =
        (clientRawText !== null ? 1 : 0) + competitorMentions.length;

      if (normalizedBrandTerms.length === 0) {
        entityResolutionError =
          "no usable normalized brand terms were available; entity resolution was not attempted";
      } else {
        const pass = await db.startOrResumeEntityResolutionPass({
          projectId: input.projectId,
          probeResultId: result.id,
          resolverVersion: ENTITY_RESOLVER_VERSION,
          datasetId: input.datasetId,
          expectedMentionCount,
          companyName: clientName.name,
          domain: clientName.domain ?? project.domain,
          normalizedBrandTerms,
          mirrorAliases: clientName.aliases ?? [],
        });

        if (expectedMentionCount === 0) {
          // Nothing above needed to write anything; the pass completed
          // immediately at creation. Its own return value is a reliable
          // signal here, since no further mutation is possible for a
          // zero-mention pass.
          if (pass.passStatus !== "completed") {
            entityResolutionError = `entity resolution pass ${pass.resolutionPassId} did not reach completed status for a zero-mention probe_result`;
          }
        } else {
          let mentionOrdinal = 0;

          // mention_ordinal 0 is reserved for the client's own mention,
          // consumed only when locateClientMention actually found a
          // match — never a placeholder for a mention that was not found.
          if (clientRawText !== null) {
            // normalizeEntityTextV1 lowercases as one of its own steps,
            // and locateClientMention only ever matches a substring that
            // is case-insensitively identical to one of brandTerms — so
            // this normalized value is guaranteed, by construction, to
            // already be a member of normalizedBrandTerms.
            await db.resolveAndRecordEntityObservation({
              resolutionPassId: pass.resolutionPassId,
              mentionOrdinal: 0,
              rawText: clientRawText,
              normalizedText: normalizeEntityTextV1(clientRawText),
              status: "excluded_brand_self",
              proposedEntityType: "client",
            });
            mentionOrdinal = 1;
          } else {
            mentionOrdinal = 1;
          }

          // competitorsMentioned keeps its array order and is never
          // deduplicated — two distinct mentions of the same competitor
          // get two distinct ordinals, each its own observation row.
          for (const competitor of competitorMentions) {
            await db.resolveAndRecordEntityObservation({
              resolutionPassId: pass.resolutionPassId,
              mentionOrdinal,
              rawText: competitor.name,
              normalizedText: normalizeEntityTextV1(competitor.name),
              status: "resolved",
              proposedEntityType: "competitor",
              context: competitor.context ?? null,
            });
            mentionOrdinal += 1;
          }

          // Explicit final verification — never inferred from the mere
          // absence of a thrown exception. A miscounted
          // expectedMentionCount or a silently-skipped mention could
          // otherwise leave the pass incomplete with nothing above ever
          // throwing.
          const activeObservations = await db.getEntityObservationsActiveByProbeResult(
            result.id
          );
          if (activeObservations.length !== expectedMentionCount) {
            entityResolutionError = `entity resolution pass ${pass.resolutionPassId} produced ${activeObservations.length} active observation(s), expected ${expectedMentionCount}`;
          }
        }
      }
    } catch (entityErr) {
      entityResolutionError =
        entityErr instanceof Error ? entityErr.message : String(entityErr);
    }

    return {
      ok: true,
      probeRunId: probeRun.id,
      result,
      output: agent.output,
      usedMock: agent.usedMock,
      usedRetry: agent.usedRetry,
      ...(entityResolutionError ? { entityResolutionError } : {}),
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
