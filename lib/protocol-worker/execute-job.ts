/**
 * M5-A — one fenced iteration over a claimed protocol execution job.
 *
 * Every database write goes through a job-scoped RPC carrying the claim
 * token. Nothing here re-implements admission, reservation, retry caps or
 * spend caps: those live in SQL and were validated by the 0050-0055
 * runtime contracts. This module's job is to sequence them honestly and
 * to propagate their outcomes without guessing.
 *
 * Two transport shapes, deliberately asymmetric:
 *
 *   Perplexity — one phase. `runPerplexityProbe` builds and sends the body
 *   itself, so `markExternalCallSentForJob` is placed *inside* the
 *   injected `fetchImpl`, immediately before the real network write. All
 *   of the probe's preparation is synchronous, so by the time fetchImpl
 *   runs nothing can still fail before the wire. If the mark is refused,
 *   we throw and no request ever leaves.
 *
 *   Analysis — two phases. `prepareCallModelRequest` yields the exact body
 *   and its hash *before* anything is sent, so the mark happens between
 *   prepare and execute and the evidence is known even if execution
 *   vanishes.
 *
 * Recovery is always by reading the context, never by remembering: the
 * `perplexity` and `analysis` external calls are classified separately,
 * and an `in_progress` call (requestSentAt set) without a receipt is an
 * ambiguity that stops the job rather than risking a second paid call.
 *
 * When a receipt *does* exist, D-026 makes the opposite guarantee: the
 * receipt carries the exact bytes, so a crash after the wire replays from
 * the ledger instead of paying again.
 */

import { PerplexityProbeFailure } from "@/lib/probes/perplexity";
import {
  buildProbeAnalysisM5Call,
  deriveProbeResultContent,
  parseProbeAnalysisM5Content,
  type ProbeAnalysisM5Input,
} from "@/lib/protocol-worker/analysis-m5";
import { analysisCallReceiptRequestFields } from "@/lib/llm/analysis-call-receipt-request";
import { sha256Hex } from "@/lib/evidence/hash";
import type {
  AnalysisCallReceipt,
  GetProtocolExecutionJobContextResult,
  ProtocolExternalCall,
  ProviderCallReceipt,
} from "@/lib/db/types";
import {
  WorkerAbort,
  type IterationResult,
  type PerplexityProbeRunner,
  type WorkerDeps,
} from "@/lib/protocol-worker/types";

interface Fenced {
  jobId: string;
  claimToken: string;
  projectId: string;
}

/** Splits the ledger the way recovery needs it: per call kind, per receipt. */
export interface ClassifiedCalls {
  perplexity: ProtocolExternalCall | null;
  analysis: ProtocolExternalCall | null;
  perplexityReceipt: ProviderCallReceipt | null;
  analysisReceipt: AnalysisCallReceipt | null;
  perplexityHasReceipt: boolean;
  analysisHasReceipt: boolean;
}

export function classifyCalls(ctx: GetProtocolExecutionJobContextResult): ClassifiedCalls {
  const attemptId = ctx.currentAttempt?.id ?? null;
  const own = ctx.externalCalls.filter((c) => c.protocolAttemptId === attemptId);
  const latest = (kind: "perplexity" | "analysis"): ProtocolExternalCall | null => {
    const list = own.filter((c) => c.callKind === kind);
    if (list.length === 0) return null;
    return list.reduce((a, b) => (b.generation > a.generation ? b : a));
  };
  const perplexity = latest("perplexity");
  const analysis = latest("analysis");
  const perplexityReceipt =
    perplexity === null
      ? null
      : (ctx.providerReceipts.find((r) => r.externalCallId === perplexity.id) ?? null);
  const analysisReceipt =
    analysis === null
      ? null
      : (ctx.analysisReceipts.find((r) => r.externalCallId === analysis.id) ?? null);
  return {
    perplexity,
    analysis,
    perplexityReceipt,
    analysisReceipt,
    perplexityHasReceipt: perplexityReceipt !== null,
    analysisHasReceipt: analysisReceipt !== null,
  };
}

/**
 * Runs the Perplexity call for the current attempt.
 *
 * `markExternalCallSentForJob` lives inside `fetchImpl` so that a refused
 * mark provably prevents the outbound request. `init.body` is never
 * logged, inspected or copied here.
 */
async function runProviderCall(
  deps: WorkerDeps,
  f: Fenced,
  call: ProtocolExternalCall,
  probeRunId: string,
  probeInput: { prompt: string; brandName: string; domain: string | null }
): Promise<{ done: IterationResult } | { probe: Awaited<ReturnType<PerplexityProbeRunner>> }> {
  let marked = false;
  const fetchImpl: typeof fetch = async (url, init) => {
    const m = await deps.db.markExternalCallSentForJob({
      jobId: f.jobId,
      claimToken: f.claimToken,
      projectId: f.projectId,
      externalCallId: call.id,
      probeRunId,
    });
    if (m.outcome !== "SENT") throw new WorkerAbort(m.outcome);
    marked = true;
    return deps.realFetch(url, init);
  };

  try {
    const res = await deps.runProbe({
      prompt: probeInput.prompt,
      brandName: probeInput.brandName,
      domain: probeInput.domain,
      fetchImpl,
    });
    const rec = await deps.db.recordProviderCallReceiptForJob({
      jobId: f.jobId,
      claimToken: f.claimToken,
      projectId: f.projectId,
      externalCallId: call.id,
      probeRunId,
      outcome: "success",
      httpStatus: res.httpStatus ?? null,
      providerRequestId: res.providerRequestId ?? null,
      rawResponseSha256: res.rawResponseBodySha256 ?? null,
      latencyMs: res.latencyMs ?? null,
      rawResponseBody: res.rawResponseBody ?? null,
    });
    if (rec.outcome !== "RECEIPTED" && rec.outcome !== "CONFLICT") {
      return { done: { outcome: "failed", jobId: f.jobId, detail: rec.outcome } };
    }
    return { probe: res };
  } catch (e) {
    if (e instanceof WorkerAbort) {
      // The mark was refused: nothing was sent, so no receipt is owed.
      return { done: { outcome: "lost_ownership", jobId: f.jobId, detail: e.rpcOutcome } };
    }
    if (e instanceof PerplexityProbeFailure && marked) {
      // The request did go out. A receipt is mandatory before any
      // reconciliation — a failed paid attempt is evidence too.
      const rec = await deps.db.recordProviderCallReceiptForJob({
        jobId: f.jobId,
        claimToken: f.claimToken,
        projectId: f.projectId,
        externalCallId: call.id,
        probeRunId,
        outcome: "provider_error",
        httpStatus: e.httpStatus,
        providerRequestId: e.providerRequestId,
        rawResponseSha256: e.errorBodySha256,
        latencyMs: e.latencyMs,
        rawResponseBody: e.errorBody,
      });
      return { done: { outcome: "failed", jobId: f.jobId, detail: rec.outcome } };
    }
    throw e;
  }
}

/** Runs the analysis call through the two-phase transport. */
async function runAnalysisCall(
  deps: WorkerDeps,
  f: Fenced,
  call: ProtocolExternalCall,
  probeRunId: string,
  agentInput: ProbeAnalysisM5Input
): Promise<IterationResult | null> {
  const built = buildProbeAnalysisM5Call(agentInput);
  const prepared = deps.analysis.prepare(built);

  const m = await deps.db.markExternalCallSentForJob({
    jobId: f.jobId,
    claimToken: f.claimToken,
    projectId: f.projectId,
    externalCallId: call.id,
    probeRunId,
  });
  if (m.outcome !== "SENT") {
    return { outcome: "lost_ownership", jobId: f.jobId, detail: m.outcome };
  }

  const out = await deps.analysis.execute(prepared);
  const fields = analysisCallReceiptRequestFields(prepared);

  const rec = await deps.db.recordAnalysisCallReceiptForJob({
    jobId: f.jobId,
    claimToken: f.claimToken,
    projectId: f.projectId,
    externalCallId: call.id,
    probeRunId,
    outcome: "success",
    provider: out.provider === "mock" ? null : out.provider,
    model: out.model,
    usedMock: fields.usedMock,
    requestSha256: fields.requestSha256,
    responseSha256: sha256Hex(out.content),
    rawContent: out.content,
    rawRequestBody: fields.rawRequestBody,
  });
  if (rec.outcome !== "RECEIPTED" && rec.outcome !== "CONFLICT") {
    return { outcome: "failed", jobId: f.jobId, detail: rec.outcome };
  }

  // The receipt exists before any parsing. Parsing is single-shot: a
  // failure is recorded, never silently retried.
  const parsed = parseProbeAnalysisM5Content(out.content);
  if (!parsed.ok) {
    const mk = await deps.db.markAnalysisParseFailedForJob({
      jobId: f.jobId,
      claimToken: f.claimToken,
      projectId: f.projectId,
      externalCallId: call.id,
      parseFailureCode: parsed.code,
    });
    return { outcome: "parse_failed", jobId: f.jobId, detail: mk.outcome };
  }

  // The nine persisted keys are derived, never asked of the model. A
  // derivation that fails its own schema is a normalization failure —
  // recorded as such, not smuggled past the RPC.
  const content = deriveProbeResultContent(parsed.data, agentInput.domain);
  if (content === null) {
    const mk = await deps.db.markAnalysisParseFailedForJob({
      jobId: f.jobId,
      claimToken: f.claimToken,
      projectId: f.projectId,
      externalCallId: call.id,
      parseFailureCode: "normalization_failed",
    });
    return { outcome: "parse_failed", jobId: f.jobId, detail: mk.outcome };
  }

  const persisted = await deps.db.persistProbeResultForJob({
    jobId: f.jobId,
    claimToken: f.claimToken,
    projectId: f.projectId,
    content,
  });
  if (persisted.outcome !== "PERSISTED" && persisted.outcome !== "ALREADY_PERSISTED") {
    return { outcome: "failed", jobId: f.jobId, detail: persisted.outcome };
  }
  return null;
}

export { runProviderCall, runAnalysisCall };
export type { Fenced };
