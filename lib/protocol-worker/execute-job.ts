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
import { CallModelFailure } from "@/lib/llm/call-model";
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
import { answerFromRawResponseBody } from "@/lib/protocol-worker/worker";
import {
  WorkerAbort,
  type AnalysisTransport,
  type IterationOutcome,
  type IterationResult,
  type PerplexityProbeRunner,
  type WorkerDeps,
  type WorkerOptions,
} from "@/lib/protocol-worker/types";

interface Fenced {
  jobId: string;
  claimToken: string;
  projectId: string;
}

/**
 * Maps a refused receipt outcome onto the iteration label it deserves.
 *
 * `RECEIPT_EVIDENCE_CONFLICT` means a receipt exists whose evidence is not
 * the one offered — the RPC has already moved the job to needs_review with
 * an outbox row. `CONFLICT` means the call is no longer `in_progress`, or
 * its probe run does not match; either way the identity of what we hold
 * was never demonstrated, so nothing derived from it may be persisted.
 */
function conflictOutcome(outcome: string): IterationOutcome {
  return outcome === "RECEIPT_EVIDENCE_CONFLICT" ? "needs_review_receipt_evidence" : "failed";
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
/**
 * B2 — one deadline per provider leg.
 *
 * The timer is NOT started here: `arm()` is called immediately before the
 * wire, after `markExternalCallSentForJob` has answered SENT, so a refused
 * mark never starts a clock. The signal composes with the worker's global
 * shutdown signal — whichever fires first aborts the call — and covers the
 * whole exchange, body read included, because it is the signal handed to
 * `fetch` itself.
 *
 * A leg that expires surfaces as an ordinary abort, which both transports
 * already map to an UNKNOWN provider outcome: the durable receipt is written
 * with `provider_outcome_unknown`, never silently dropped, and nothing
 * retries the wire.
 */
interface LegDeadline {
  readonly signal: AbortSignal;
  arm(): void;
  dispose(): void;
}

function createLegDeadline(deps: WorkerDeps, timeoutMs: number): LegDeadline {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const outer = deps.abortSignal;
  const onOuter = (): void => ac.abort();
  if (outer) {
    if (outer.aborted) ac.abort();
    else outer.addEventListener("abort", onOuter, { once: true });
  }
  return {
    signal: ac.signal,
    arm(): void {
      // Exactly one timer per leg. A retried fetch inside a transport must
      // not silently reset the ceiling.
      if (timer !== null) return;
      timer = setTimeout(() => ac.abort(), timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
    },
    dispose(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      outer?.removeEventListener("abort", onOuter);
    },
  };
}

async function runProviderCall(
  deps: WorkerDeps,
  opts: WorkerOptions,
  f: Fenced,
  call: ProtocolExternalCall,
  probeRunId: string,
  probeInput: { prompt: string; brandName: string; domain: string | null }
): Promise<{ done: IterationResult } | { probe: Awaited<ReturnType<PerplexityProbeRunner>> }> {
  // `runPerplexityProbe` wraps EVERY throw from its fetcher into a
  // PerplexityProbeFailure, so a WorkerAbort raised here never survives as
  // itself. The decision therefore rests on this explicit state, recorded
  // before anything can throw — never on the exception's type.
  let markOutcome: string | null = null;
  const deadline = createLegDeadline(deps, opts.providerTimeoutMs);
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const m = await deps.db.markExternalCallSentForJob({
      jobId: f.jobId,
      claimToken: f.claimToken,
      projectId: f.projectId,
      externalCallId: call.id,
      probeRunId,
      callKind: "perplexity",
      // 0056 — the exact bytes, and only the bytes. `init.headers` carries
      // the API key and is deliberately never read here.
      requestBody: body,
      requestBodySha256: sha256Hex(body),
    });
    markOutcome = m.outcome;
    if (m.outcome !== "SENT") throw new WorkerAbort(m.outcome);
    // The clock starts here and nowhere earlier: the mark is accepted, the
    // request is about to leave.
    deadline.arm();
    return deps.realFetch(url, { ...init, signal: deadline.signal });
  };

  try {
    let res: Awaited<ReturnType<PerplexityProbeRunner>>;
    try {
      res = await deps.runProbe({
        prompt: probeInput.prompt,
        brandName: probeInput.brandName,
        domain: probeInput.domain,
        fetchImpl,
      });
    } finally {
      // B2 — the ceiling covers the wire and the body read, and stops there.
      // `runPerplexityProbe` has fully resolved or rejected by now, so the
      // timer is released BEFORE the receipt RPC and every durable write that
      // follows: a database round-trip must never sit under a provider clock.
      // In `finally`, so it runs on success, timeout, shutdown, http error,
      // empty answer and any transport throw alike.
      deadline.dispose();
    }
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
    // Only two outcomes let the run continue, and in BOTH the durable
    // receipt is the authority — never `res`, the response still in hand.
    // On a replay the two are identical by construction; if they ever
    // differ, the ledger wins and the response in hand is discarded.
    if (rec.outcome !== "RECEIPTED" && rec.outcome !== "ALREADY_RECEIPTED_IDENTICAL") {
      // CONFLICT and RECEIPT_EVIDENCE_CONFLICT stop here, with no parsing
      // and no persistence: an identity that was never demonstrated may
      // not become evidence.
      return { done: { outcome: conflictOutcome(rec.outcome), jobId: f.jobId, detail: rec.outcome } };
    }
    if (!rec.receipt) {
      // An accepted outcome with no receipt is a broken contract, not a
      // reason to fall back on the response in hand.
      return { done: { outcome: "failed", jobId: f.jobId, detail: `${rec.outcome}:NO_RECEIPT` } };
    }
    const durableAnswer = answerFromRawResponseBody(rec.receipt.rawResponseBody);
    if (durableAnswer === null) {
      return { done: { outcome: "failed", jobId: f.jobId, detail: `${rec.outcome}:EMPTY_DURABLE_ANSWER` } };
    }
    return {
      probe: {
        ...res,
        answer: durableAnswer,
        rawResponseBody: rec.receipt.rawResponseBody ?? undefined,
        rawResponseBodySha256: rec.receipt.rawResponseSha256 ?? undefined,
      },
    };
  } catch (e) {
    if (markOutcome !== "SENT") {
      // Nothing reached the wire, whatever the exception now claims to be.
      // ALREADY_SENT_SAME_EVIDENCE is not a failure: the call was sent
      // once already and the caller must replay from its receipt.
      const detail = markOutcome ?? (e instanceof WorkerAbort ? e.rpcOutcome : "MARK_NOT_ATTEMPTED");
      const outcome =
        markOutcome === "ALREADY_SENT_SAME_EVIDENCE"
          ? ("already_sent" as const)
          : markOutcome === "REQUEST_EVIDENCE_CONFLICT"
            ? ("needs_review_request_evidence" as const)
            : ("lost_ownership" as const);
      return { done: { outcome, jobId: f.jobId, detail } };
    }
    if (e instanceof PerplexityProbeFailure) {
      // The request did go out. A receipt is mandatory before any
      // reconciliation — a failed paid attempt is evidence too.
      //
      // The distinction that matters is whether the provider's outcome is
      // KNOWN. An http_error or an empty answer is a definite failure the
      // caller closes with T3. A network error is not: the request may
      // have been served and billed, and only the receipt RPC's own T1
      // may close that, atomically.
      const known = e.reason === "http_error" || e.reason === "empty_answer";
      const rec = await deps.db.recordProviderCallReceiptForJob({
        jobId: f.jobId,
        claimToken: f.claimToken,
        projectId: f.projectId,
        externalCallId: call.id,
        probeRunId,
        outcome: known ? "provider_error" : "provider_outcome_unknown",
        httpStatus: e.httpStatus,
        providerRequestId: e.providerRequestId,
        rawResponseSha256: known ? e.errorBodySha256 : null,
        latencyMs: e.latencyMs,
        rawResponseBody: known ? e.errorBody : null,
      });
      const detail = `${e.reason}:${rec.outcome}`;
      if (!known) {
        // T1 already cancelled the unsent legs, terminalised the attempt
        // and moved the job, inside that RPC's transaction.
        return {
          done: { outcome: "needs_review_perplexity_unknown", jobId: f.jobId, detail },
        };
      }
      return { done: { outcome: "provider_failed", jobId: f.jobId, detail } };
    }
    throw e;
  }
}

/**
 * Turns a failed analysis execution into a receipt.
 *
 * The request went out, so evidence is owed whatever happened next. The
 * distinction that matters is whether the provider's outcome is KNOWN:
 *
 *   http_error / malformed_response / empty_content  -> provider_error,
 *     a definite failure the caller closes with T3;
 *   network_error / aborted                          -> provider_outcome_unknown,
 *     which the RPC itself closes through T1 in the same transaction --
 *     receipt, cancelled legs, terminal attempt, needs_review, outbox.
 */
async function recordAnalysisFailure(
  deps: WorkerDeps,
  f: Fenced,
  call: ProtocolExternalCall,
  probeRunId: string,
  fields: ReturnType<typeof analysisCallReceiptRequestFields>,
  error: unknown
): Promise<IterationResult> {
  const failure = error instanceof CallModelFailure ? error : null;
  const known =
    failure !== null &&
    (failure.reason === "http_error" ||
      failure.reason === "malformed_response" ||
      failure.reason === "empty_content");

  const rec = await deps.db.recordAnalysisCallReceiptForJob({
    jobId: f.jobId,
    claimToken: f.claimToken,
    projectId: f.projectId,
    externalCallId: call.id,
    probeRunId,
    outcome: known ? "provider_error" : "provider_outcome_unknown",
    provider: null,
    model: null,
    usedMock: fields.usedMock,
    requestSha256: fields.requestSha256,
    responseSha256: null,
    latencyMs: failure?.latencyMs ?? null,
    // TK-R-2 / TK-R-3 — the transport already measured these; they were
    // simply never persisted. Null stays null: a network error that never
    // reached the provider has no request id and no HTTP status, and
    // nothing here fabricates one.
    providerRequestId: failure?.providerRequestId ?? null,
    httpStatus: failure?.httpStatus ?? null,
    // TK-R-1 — a failed call names no served model.
    modelReturned: null,
    rawContent: null,
    rawRequestBody: fields.rawRequestBody,
  });
  const detail = `${failure?.reason ?? "unknown_error"}:${rec.outcome}`;
  if (!known) {
    // T1 already closed the attempt and the job inside that RPC.
    return { outcome: "needs_review_analysis_unknown", jobId: f.jobId, detail };
  }
  // A KNOWN failure leaves the attempt open and — on a fresh run — no leg
  // reserved but none reconcilable either, because reconcile refuses while
  // anything is still open. T3 is the only thing that actually closes it.
  return { outcome: "provider_failed", jobId: f.jobId, detail };
}

/** Runs the analysis call through the two-phase transport. */
async function runAnalysisCall(
  deps: WorkerDeps,
  opts: WorkerOptions,
  f: Fenced,
  call: ProtocolExternalCall,
  probeRunId: string,
  agentInput: ProbeAnalysisM5Input
): Promise<IterationResult | null> {
  const built = buildProbeAnalysisM5Call(agentInput);
  const prepared = deps.analysis.prepare(built);

  const fields = analysisCallReceiptRequestFields(prepared);

  const m = await deps.db.markExternalCallSentForJob({
    jobId: f.jobId,
    claimToken: f.claimToken,
    projectId: f.projectId,
    externalCallId: call.id,
    probeRunId,
    callKind: "analysis",
    requestBody: prepared.rawRequestBody,
    requestBodySha256: prepared.requestSha256,
  });
  if (m.outcome === "ALREADY_SENT_SAME_EVIDENCE") {
    return { outcome: "already_sent", jobId: f.jobId, detail: m.outcome };
  }
  if (m.outcome === "REQUEST_EVIDENCE_CONFLICT") {
    return { outcome: "needs_review_request_evidence", jobId: f.jobId, detail: m.outcome };
  }
  if (m.outcome !== "SENT") {
    return { outcome: "lost_ownership", jobId: f.jobId, detail: m.outcome };
  }

  let out: Awaited<ReturnType<AnalysisTransport["execute"]>>;
  const deadline = createLegDeadline(deps, opts.providerTimeoutMs);
  try {
    // Armed after the mark was accepted, immediately before the transport.
    deadline.arm();
    out = await deps.analysis.execute(prepared, { signal: deadline.signal });
  } catch (e) {
    // The request went out. A receipt is owed whatever happened next, and
    // an unknown outcome must close the whole attempt in one transaction.
    return await recordAnalysisFailure(deps, f, call, probeRunId, fields, e);
  } finally {
    deadline.dispose();
  }

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
    // TK-R-4 — the success path measured a latency and then dropped it on
    // the floor, so every successful analysis receipt carried a null.
    latencyMs: out.latencyMs,
    // TK-R-2 / TK-R-3 — same values, same reason.
    providerRequestId: out.providerRequestId,
    httpStatus: out.httpStatus,
    // TK-R-1 — what the provider says it served, never overwriting `model`
    // above, which stays what we asked for.
    modelReturned: out.modelReturned,
    rawContent: out.content,
    rawRequestBody: fields.rawRequestBody,
  });
  if (rec.outcome !== "RECEIPTED" && rec.outcome !== "ALREADY_RECEIPTED_IDENTICAL") {
    return { outcome: conflictOutcome(rec.outcome), jobId: f.jobId, detail: rec.outcome };
  }
  if (!rec.receipt) {
    return { outcome: "failed", jobId: f.jobId, detail: `${rec.outcome}:NO_RECEIPT` };
  }
  if (rec.receipt.rawContent === null) {
    return { outcome: "failed", jobId: f.jobId, detail: `${rec.outcome}:NO_DURABLE_CONTENT` };
  }

  // The receipt exists before any parsing, and the receipt is what gets
  // parsed — never `out.content`. Parsing is single-shot: a failure is
  // recorded, never silently retried.
  const parsed = parseProbeAnalysisM5Content(rec.receipt.rawContent);
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
