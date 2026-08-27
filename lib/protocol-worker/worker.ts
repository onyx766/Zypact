/**
 * M5-A — the worker loop.
 *
 * Claim one job, drive its remaining baseline slots, and let the SQL
 * completion gate decide when the job is done. Progress is never held in
 * memory across a slot: after every reconciliation the context is re-read
 * and the next decision is taken from the ledger alone, so a crash at any
 * point resumes exactly where the evidence says it stopped.
 *
 * Three replay rules, all of them "read, then decide":
 *
 *   1. An `in_progress` external call with no receipt is genuinely
 *      ambiguous — the request may or may not have reached the provider.
 *      The job goes to needs_review; it is never retried blind.
 *   2. A provider receipt that *does* exist carries the exact response
 *      body (D-026), so the analysis leg replays Perplexity's answer from
 *      the ledger instead of paying for a second call.
 *   3. An analysis receipt that exists carries the exact model output, so
 *      a crash before `persistProbeResultForJob` re-parses that text
 *      rather than re-invoking the model.
 */

import {
  classifyCalls,
  runAnalysisCall,
  runProviderCall,
  type ClassifiedCalls,
  type Fenced,
} from "@/lib/protocol-worker/execute-job";
import { startHeartbeat } from "@/lib/protocol-worker/heartbeat";
import { WorkerHealth } from "@/lib/protocol-worker/health";
import {
  deriveProbeResultContent,
  parseProbeAnalysisM5Content,
} from "@/lib/protocol-worker/analysis-m5";
import type {
  GetProtocolExecutionJobContextResult,
  Protocol,
  ProtocolAttempt,
} from "@/lib/db/types";
import type { IterationResult, WorkerDeps, WorkerOptions } from "@/lib/protocol-worker/types";

/**
 * D-026 replay — recovers Perplexity's answer from a stored raw response
 * body. Deliberately total: any shape that does not yield a non-empty
 * string returns null, and the caller then refuses to fabricate one.
 */
export function answerFromRawResponseBody(raw: string | null): string | null {
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const content = (choices[0] as { message?: { content?: unknown } })?.message?.content;
  if (typeof content !== "string") return null;
  const trimmed = content.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** One claim, one job, driven to a terminal or a hand-back. */
export async function runOneIteration(
  deps: WorkerDeps,
  opts: WorkerOptions,
  health: WorkerHealth
): Promise<IterationResult> {
  const claimed = await deps.db.claimProtocolExecutionJob({
    workerId: opts.workerId,
    leaseSeconds: opts.leaseSeconds,
  });
  if (claimed.outcome !== "CLAIMED" || !claimed.job || !claimed.claimToken) {
    return { outcome: "no_job", jobId: null, detail: claimed.outcome };
  }
  health.markClaim();
  health.markIteration();

  const f: Fenced = {
    jobId: claimed.job.id,
    claimToken: claimed.claimToken,
    projectId: claimed.job.projectId,
  };

  let lost = false;
  const hb = startHeartbeat({
    db: deps.db,
    health,
    jobId: f.jobId,
    claimToken: f.claimToken,
    projectId: f.projectId,
    leaseSeconds: opts.leaseSeconds,
    onLost: () => {
      lost = true;
    },
  });

  try {
    // Bounded by the plan: one pass per baseline slot, plus one for the
    // completion gate. A runaway loop is a bug, not a retry policy.
    for (let pass = 0; pass <= opts.maxSlotsPerClaim; pass += 1) {
      if (lost) return { outcome: "lost_ownership", jobId: f.jobId, detail: "HEARTBEAT_LOST" };

      const ctx = await deps.db.getProtocolExecutionJobContext(f);
      if (ctx.outcome !== "OK" || !ctx.job || !ctx.protocol) {
        return { outcome: "lost_ownership", jobId: f.jobId, detail: ctx.outcome };
      }

      // Rule 1 — the two ambiguity frontiers, checked separately.
      const cls = classifyCalls(ctx);
      const ambiguous =
        cls.perplexity?.status === "in_progress" && !cls.perplexityHasReceipt
          ? ("needs_review_perplexity_unknown" as const)
          : cls.analysis?.status === "in_progress" && !cls.analysisHasReceipt
            ? ("needs_review_analysis_unknown" as const)
            : null;
      if (ambiguous) {
        const r = await deps.db.markProtocolExecutionJobNeedsReviewForAmbiguity(f);
        return { outcome: ambiguous, jobId: f.jobId, detail: r.outcome };
      }

      const step = await runOneSlot(deps, opts, f, ctx);
      if (step) return step;
      // null ⇒ the gate said NEXT_BASELINE_REQUIRED: re-read and continue.
    }
    return { outcome: "failed", jobId: f.jobId, detail: "SLOT_BUDGET_EXHAUSTED" };
  } finally {
    hb.stop();
  }
}

/**
 * Drives one baseline slot to reconciliation, then asks the completion
 * gate what to do next. Returns null when — and only when — the gate
 * reports that another baseline slot is required.
 */
async function runOneSlot(
  deps: WorkerDeps,
  opts: WorkerOptions,
  f: Fenced,
  ctx: GetProtocolExecutionJobContextResult
): Promise<IterationResult | null> {
  const project = await deps.db.getProject(f.projectId);
  if (!project || !ctx.protocol) {
    return { outcome: "failed", jobId: f.jobId, detail: "MISSING_CONTEXT" };
  }

  // D-025 — the key must be exactly `${jobId}:baseline:${nextBaselineOrdinal}`
  // and the ordinal comes from the ledger, never from a local counter.
  const ordinal = ctx.job?.nextBaselineOrdinal ?? 0;
  if (ordinal < 1) {
    return { outcome: "failed", jobId: f.jobId, detail: "INVALID_BASELINE_ORDINAL" };
  }
  const admitted = await deps.db.admitAndReserveAttemptForJob({
    jobId: f.jobId,
    claimToken: f.claimToken,
    projectId: f.projectId,
    attemptKind: "baseline",
    idempotencyKey: `${f.jobId}:baseline:${ordinal}`,
    perplexityReservedCostUsd: opts.perplexityReservedCostUsd,
    analysisReservedCostUsd: opts.analysisReservedCostUsd,
  });
  if (admitted.outcome === "RUN_CAP_EXCEEDED" || admitted.outcome === "PROTOCOL_NOT_APPROVED") {
    return { outcome: "capped", jobId: f.jobId, detail: admitted.outcome };
  }
  if (
    admitted.outcome !== "RESERVED" &&
    admitted.outcome !== "ALREADY_RESERVED" &&
    admitted.outcome !== "RESUME_CURRENT_ATTEMPT"
  ) {
    return { outcome: "failed", jobId: f.jobId, detail: admitted.outcome };
  }

  const attempt: ProtocolAttempt | null = admitted.attempt ?? ctx.currentAttempt;
  if (!attempt) {
    return { outcome: "failed", jobId: f.jobId, detail: "NO_CURRENT_ATTEMPT" };
  }

  const started = await deps.db.createProbeRunAndStartAttemptForJob({
    jobId: f.jobId,
    claimToken: f.claimToken,
    projectId: f.projectId,
    attemptId: attempt.id,
    platform: "perplexity",
    probeMode: deps.probeMode,
  });
  if (started.outcome !== "STARTED" && started.outcome !== "ALREADY_STARTED") {
    return { outcome: "failed", jobId: f.jobId, detail: started.outcome };
  }

  // One authoritative re-read: the reserved calls and the probe run only
  // exist after admission and start, so nothing above could have seen them.
  const live = await deps.db.getProtocolExecutionJobContext(f);
  if (live.outcome !== "OK") {
    return { outcome: "lost_ownership", jobId: f.jobId, detail: live.outcome };
  }
  const now = classifyCalls(live);
  const probeRunId = live.probeRun?.id ?? started.probeRun?.id ?? null;
  if (!probeRunId || !now.perplexity) {
    return { outcome: "failed", jobId: f.jobId, detail: "NO_PROBE_RUN_OR_CALL" };
  }

  const prompt = promptForSlot(live.protocol, ordinal);
  if (prompt === null) {
    return { outcome: "failed", jobId: f.jobId, detail: "NO_PROMPT_IN_PLAN" };
  }

  // --- provider leg ---------------------------------------------------
  let answer: string | null;
  if (now.perplexityReceipt) {
    // Rule 2 — already paid for. Replay, never re-send.
    if (now.perplexityReceipt.outcome !== "success") {
      return await reconcileFailed(deps, f, attempt.id, "provider_error");
    }
    answer = answerFromRawResponseBody(now.perplexityReceipt.rawResponseBody);
  } else {
    const r = await runProviderCall(deps, f, now.perplexity, probeRunId, {
      prompt,
      brandName: project.companyName ?? project.domain,
      domain: project.domain,
    });
    if ("done" in r) return r.done;
    answer = r.probe.answer.trim().length === 0 ? null : r.probe.answer;
  }
  if (answer === null) {
    return await reconcileFailed(deps, f, attempt.id, "empty_provider_answer");
  }

  // --- analysis leg ---------------------------------------------------
  if (!live.probeResult) {
    const agentInput = {
      prompt,
      aiResponse: answer,
      clientName: project.companyName ?? project.domain,
      domain: project.domain,
    };
    if (now.analysisReceipt) {
      // Rule 3 — the model already answered and we were billed for it.
      const replayed = await replayAnalysisReceipt(deps, f, now, project.domain);
      if (replayed) return replayed;
    } else if (now.analysis) {
      const r = await runAnalysisCall(deps, f, now.analysis, probeRunId, agentInput);
      if (r) return r;
    } else {
      return { outcome: "failed", jobId: f.jobId, detail: "NO_ANALYSIS_CALL" };
    }
  }

  const rec = await deps.db.reconcileAttemptForJob({
    jobId: f.jobId,
    claimToken: f.claimToken,
    projectId: f.projectId,
    attemptId: attempt.id,
    status: "completed",
  });
  if (rec.outcome !== "RECONCILED" && rec.outcome !== "ALREADY_RECONCILED") {
    return { outcome: "failed", jobId: f.jobId, detail: rec.outcome };
  }

  // The gate — not the worker — decides whether the job is finished.
  const done = await deps.db.completeProtocolExecutionJob(f);
  if (done.outcome === "NEXT_BASELINE_REQUIRED") return null;
  if (done.outcome === "SUCCEEDED" || done.outcome === "ALREADY_SUCCEEDED") {
    return { outcome: "completed", jobId: f.jobId, detail: done.outcome };
  }
  return { outcome: "failed", jobId: f.jobId, detail: done.outcome };
}

/**
 * Re-parses a stored analysis output and persists the derived result.
 * No model call, no receipt write — the receipt is already immutable.
 */
async function replayAnalysisReceipt(
  deps: WorkerDeps,
  f: Fenced,
  now: ClassifiedCalls,
  domain: string
): Promise<IterationResult | null> {
  const receipt = now.analysisReceipt;
  const call = now.analysis;
  if (!receipt || !call) return { outcome: "failed", jobId: f.jobId, detail: "NO_ANALYSIS_RECEIPT" };
  if (receipt.outcome !== "success" || receipt.rawContent === null) {
    return { outcome: "failed", jobId: f.jobId, detail: "ANALYSIS_RECEIPT_NOT_REPLAYABLE" };
  }
  const parsed = parseProbeAnalysisM5Content(receipt.rawContent);
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
  const content = deriveProbeResultContent(parsed.data, domain);
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

async function reconcileFailed(
  deps: WorkerDeps,
  f: Fenced,
  attemptId: string,
  reason: string
): Promise<IterationResult> {
  const rec = await deps.db.reconcileAttemptForJob({
    jobId: f.jobId,
    claimToken: f.claimToken,
    projectId: f.projectId,
    attemptId,
    status: "failed",
    terminationReason: reason,
  });
  return { outcome: "failed", jobId: f.jobId, detail: `${reason}:${rec.outcome}` };
}

/** The paraphrase plan is the question identity; a slot never invents one. */
function promptForSlot(protocol: Protocol | null, ordinal: number): string | null {
  if (!protocol || protocol.paraphrasePlan.length === 0) return null;
  const idx = ordinal > 0 ? (ordinal - 1) % protocol.paraphrasePlan.length : 0;
  const text = protocol.paraphrasePlan[idx]?.text ?? "";
  return text.trim().length === 0 ? null : text;
}

/** The long-running loop. Exits cleanly once `signal.aborted` is set. */
export async function runWorkerLoop(
  deps: WorkerDeps,
  opts: WorkerOptions,
  signal: { aborted: boolean },
  sleep: (ms: number) => Promise<void>,
  onIteration?: (r: IterationResult) => void
): Promise<WorkerHealth> {
  const health = new WorkerHealth(deps.now);
  let backoff = opts.idleBackoffMs;
  while (!signal.aborted) {
    const r = await runOneIteration(deps, opts, health);
    onIteration?.(r);
    if (r.outcome === "no_job") {
      await sleep(backoff);
      backoff = Math.min(backoff * 2, opts.maxBackoffMs);
    } else {
      backoff = opts.idleBackoffMs;
    }
  }
  health.markShuttingDown();
  return health;
}
