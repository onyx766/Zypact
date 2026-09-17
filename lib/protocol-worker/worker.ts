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
  FailJobWithoutAttemptReason,
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

/**
 * D-023 §3 — the MEASURED cost of a Perplexity call, taken from the
 * provider's own accounting in `usage.cost.total_cost`.
 *
 * `measured` is the right basis precisely because nothing here computes a
 * price: Perplexity reports what it charged, and this reads that number.
 * No token count is multiplied by a rate, so there is no price table to
 * drift out of date and no way for this to disagree with the invoice.
 *
 * Deliberately total, and it never guesses. Absent body, unparseable JSON,
 * a missing `usage`/`cost`, a non-number, a non-finite value or a negative
 * one all return null, and the caller then omits BOTH the cost and the
 * basis so the ledger records an honest `unknown`. The reservation is
 * never substituted for a real cost — migration 0050 states that rule and
 * enforces the pairing with
 * `protocol_external_calls_cost_basis_pair_check`.
 *
 * Read from the same bytes the caller is about to persist as the receipt,
 * so the recorded cost and the stored evidence can never describe
 * different responses.
 */
export function measuredCostUsdFromRawResponseBody(
  raw: string | null | undefined
): number | null {
  if (raw === null || raw === undefined) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const usage = (json as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const cost = (usage as { cost?: unknown }).cost;
  if (!cost || typeof cost !== "object") return null;
  const total = (cost as { total_cost?: unknown }).total_cost;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
    return null;
  }
  return total;
}

/**
 * Exponential backoff with bounded jitter.
 *
 * Deterministic behaviour is a property of the ledger, not of the sleep:
 * without jitter, workers that started together stay in lockstep and
 * collide on every retry.
 */
export function backoffWithJitter(opts: WorkerOptions, attempt: number): number {
  const base = Math.min(opts.idleBackoffMs * 2 ** Math.max(0, attempt - 1), opts.maxBackoffMs);
  const spread = base * Math.max(0, opts.jitterRatio);
  return Math.min(opts.maxBackoffMs, Math.round(base + spread * Math.random()));
}

/** One claim, one job, driven to a terminal or a hand-back. */
export async function runOneIteration(
  deps: WorkerDeps,
  opts: WorkerOptions,
  health: WorkerHealth
): Promise<IterationResult> {
  let claimed;
  try {
    claimed = await deps.db.claimProtocolExecutionJob({
      workerId: opts.workerId,
      leaseSeconds: opts.leaseSeconds,
    });
  } catch (err) {
    // TK-R-0 — a claim that threw never answered, so it is not an idle
    // cycle: the streak breaks. The error still propagates exactly as it
    // did before; this block adds bookkeeping and changes no control flow.
    health.resetNoJobStreak();
    throw err;
  }
  // A claim that answered at all proves the database is reachable, even
  // when the answer is "nothing to do".
  health.markDbContact();
  if (claimed.outcome !== "CLAIMED" || !claimed.job || !claimed.claimToken) {
    // TK-R-0 — the one place an idle cycle is provable. Counted before the
    // return, so no idle claim can escape the record.
    health.markNoJob();
    return { outcome: "no_job", jobId: null, detail: claimed.outcome };
  }
  // TK-R-0 — a claimed job ends any idle streak. `markIteration` below is
  // untouched and still means exactly "a job was claimed".
  health.resetNoJobStreak();
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
    // B3 — two independent budgets, never one sum.
    //
    // The old bound was `pass <= maxSlotsPerClaim + maxThrottledRetries`,
    // which let an UNUSED retry become an extra slot: with a budget of one
    // slot and zero retries it still granted two passes, so a second
    // baseline slot — and a second pair of paid provider calls — could run.
    // `slotsUsed` counts only slots actually driven to a gate answer;
    // `throttled` counts only transient refusals, which consume no slot.
    let slotsUsed = 0;
    let throttled = 0;
    for (;;) {
      if (slotsUsed >= opts.maxSlotsPerClaim) break;
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
      if (step && step.outcome === "throttled") {
        // The claim and the heartbeat are HELD. Letting the lease lapse
        // would consume an attempt_count and could turn a transient cap
        // into abandoned_exhausted; expiry stays reserved for crashes and
        // genuine loss of ownership.
        throttled += 1;
        if (throttled > opts.maxThrottledRetries) {
          const closed = await deps.db.failJobWithoutAttemptForJob({
            jobId: f.jobId,
            claimToken: f.claimToken,
            projectId: f.projectId,
            reason: "throttled_retries_exhausted",
          });
          return {
            outcome: "needs_review_request_evidence",
            jobId: f.jobId,
            detail: `${step.detail}:${closed.outcome}`,
          };
        }
        await deps.sleep(backoffWithJitter(opts, throttled), deps.abortSignal);
        continue;
      }
      if (step) return step;
      // null ⇒ the gate said NEXT_BASELINE_REQUIRED. That slot WAS driven,
      // so it is charged here and only here — a throttled pass above never
      // reaches this line.
      slotsUsed += 1;
    }
    // A ledger that outruns the slot budget is an anomaly, not an ordinary
    // failure: it is surfaced for review rather than quietly failed.
    const closed = await deps.db.failJobWithoutAttemptForJob({
      jobId: f.jobId,
      claimToken: f.claimToken,
      projectId: f.projectId,
      reason: "slot_budget_exhausted",
    });
    return {
      outcome: "needs_review_request_evidence",
      jobId: f.jobId,
      detail: `SLOT_BUDGET_EXHAUSTED:${closed.outcome}`,
    };
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
  // and the ordinal comes from the ledger, never from a local counter. The
  // literal `baseline` in the key names the job's slot counter
  // (next_baseline_ordinal), not the phase — 0073 reuses that same counter
  // for a retest protocol's job, so the key format does not vary by phase.
  const ordinal = ctx.job?.nextBaselineOrdinal ?? 0;
  if (ordinal < 1) {
    return { outcome: "failed", jobId: f.jobId, detail: "INVALID_BASELINE_ORDINAL" };
  }
  // M7/0074 — a retest protocol (baselineProtocolId set) must record its
  // attempts as 'retest', never 'baseline', or a later comparison that
  // splits phases by attempt_kind would silently compare a baseline against
  // itself. This predicate is exactly the one 0074's protocol_attempts
  // trigger enforces, which is the actual backstop: if this ever drifts,
  // the insert is refused rather than mislabelling evidence.
  const attemptKind = ctx.protocol.baselineProtocolId !== null ? "retest" : "baseline";
  const admitted = await deps.db.admitAndReserveAttemptForJob({
    jobId: f.jobId,
    claimToken: f.claimToken,
    projectId: f.projectId,
    attemptKind,
    idempotencyKey: `${f.jobId}:baseline:${ordinal}`,
    perplexityReservedCostUsd: opts.perplexityReservedCostUsd,
    analysisReservedCostUsd: opts.analysisReservedCostUsd,
  });
  // Five distinct cap refusals, and they do not mean the same thing.
  // A durable cap closes the job; a transient one is retried under this
  // same claim, because letting the lease lapse would burn an attempt.
  const DURABLE_CAPS = {
    RUN_CAP_EXCEEDED: "run_cap_exceeded",
    SPEND_CAP_EXCEEDED: "spend_cap_exceeded",
    RETRY_CAP_EXCEEDED: "retry_cap_exceeded",
  } as const;
  const durable = (DURABLE_CAPS as Record<string, FailJobWithoutAttemptReason | undefined>)[
    admitted.outcome
  ];
  if (durable) {
    // Admission made zero mutation, so there is no attempt to terminalise.
    const closed = await deps.db.failJobWithoutAttemptForJob({
      jobId: f.jobId,
      claimToken: f.claimToken,
      projectId: f.projectId,
      reason: durable,
    });
    return { outcome: "capped", jobId: f.jobId, detail: `${admitted.outcome}:${closed.outcome}` };
  }
  if (
    admitted.outcome === "RATE_LIMIT_EXCEEDED" ||
    admitted.outcome === "CONCURRENCY_LIMIT_EXCEEDED"
  ) {
    return { outcome: "throttled", jobId: f.jobId, detail: admitted.outcome };
  }
  if (admitted.outcome === "PROTOCOL_NOT_APPROVED") {
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
      // Resumed onto a provider receipt that failed. The analysis leg
      // never left `reserved`, so reconcile can only refuse: T3 cancels it
      // and closes the attempt in one fenced transition.
      return await closeAttemptFailed(deps, f, attempt.id, "provider_error");
    }
    answer = answerFromRawResponseBody(now.perplexityReceipt.rawResponseBody);
  } else {
    const r = await runProviderCall(deps, opts, f, now.perplexity, probeRunId, {
      prompt,
      brandName: project.companyName ?? project.domain,
      domain: project.domain,
    });
    if ("done" in r) {
      if (r.done.outcome === "provider_failed") {
        // Known failure: the analysis leg never left `reserved`, so
        // reconcile alone could never close this. T3 cancels it, ends the
        // attempt and closes the job, atomically.
        const closed = await deps.db.abortAttemptAndFailJobForJob({
          jobId: f.jobId,
          claimToken: f.claimToken,
          projectId: f.projectId,
          attemptId: attempt.id,
          attemptStatus: "failed",
          terminationReason: r.done.detail,
          failureReason: "provider_error",
        });
        return { outcome: "failed", jobId: f.jobId, detail: `${r.done.detail}:${closed.outcome}` };
      }
      return r.done;
    }
    answer = r.probe.answer.trim().length === 0 ? null : r.probe.answer;
  }
  if (answer === null) {
    return await closeAttemptFailed(deps, f, attempt.id, "empty_provider_answer");
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
      const replayed = await replayAnalysisReceipt(deps, f, now, project.domain, attempt.id);
      if (replayed) return replayed;
    } else if (now.analysis) {
      const r = await runAnalysisCall(deps, opts, f, now.analysis, probeRunId, agentInput);
      if (r?.outcome === "provider_failed") {
        return await closeAttemptFailed(deps, f, attempt.id, r.detail ?? "analysis_error");
      }
      if (r?.outcome === "parse_failed") {
        // The durable mark stays; only the attempt and the job are closed,
        // so D-027's operator retry still has something to key off.
        return await closeAttemptForParseFailure(deps, f, attempt.id, now.analysis.id, r.detail);
      }
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
  domain: string,
  attemptId: string
): Promise<IterationResult | null> {
  const receipt = now.analysisReceipt;
  const call = now.analysis;
  if (!receipt || !call) return { outcome: "failed", jobId: f.jobId, detail: "NO_ANALYSIS_RECEIPT" };
  if (receipt.outcome !== "success" || receipt.rawContent === null) {
    // Resumed onto an analysis receipt that failed. Nothing is replayable
    // and nothing more will be bought; the attempt has to close.
    return await closeAttemptFailed(deps, f, attemptId, "analysis_receipt_not_replayable");
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
    return await closeAttemptForParseFailure(deps, f, attemptId, call.id, `${parsed.code}:${mk.outcome}`);
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
    return await closeAttemptForParseFailure(
      deps, f, attemptId, call.id, `normalization_failed:${mk.outcome}`
    );
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

/**
 * Closes an attempt that failed deterministically.
 *
 * Always T3, never `reconcileAttemptForJob`: reconcile refuses while any
 * leg is still `reserved`, and after a provider or analysis error at
 * least one leg always is. T3 cancels the unsent legs, terminalises the
 * attempt and closes the job in a single fenced transition.
 */
async function closeAttemptFailed(
  deps: WorkerDeps,
  f: Fenced,
  attemptId: string,
  reason: string
): Promise<IterationResult> {
  const closed = await deps.db.abortAttemptAndFailJobForJob({
    jobId: f.jobId,
    claimToken: f.claimToken,
    projectId: f.projectId,
    attemptId,
    attemptStatus: "failed",
    terminationReason: reason,
    failureReason: reason,
  });
  return { outcome: "failed", jobId: f.jobId, detail: `${reason}:${closed.outcome}` };
}

/**
 * Closes an attempt around a durable parse-failure mark.
 *
 * The mark is preserved — it is what D-027's operator retry keys off —
 * and only the attempt and the job move. Without this the job would sit
 * claimed until its lease lapsed, which is not a closed state.
 */
async function closeAttemptForParseFailure(
  deps: WorkerDeps,
  f: Fenced,
  attemptId: string,
  externalCallId: string,
  detail: string | null
): Promise<IterationResult> {
  const closed = await deps.db.closeAttemptForParseFailureForJob({
    jobId: f.jobId,
    claimToken: f.claimToken,
    projectId: f.projectId,
    attemptId,
    externalCallId,
  });
  return { outcome: "parse_failed", jobId: f.jobId, detail: `${detail}:${closed.outcome}` };
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
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  onIteration?: (r: IterationResult) => void,
  health: WorkerHealth = new WorkerHealth(deps.now)
): Promise<WorkerHealth> {
  let idle = 0;
  while (!signal.aborted) {
    // B3-intrinsic — asked BEFORE the claim, on every pass, and never
    // after. A claim is a lease plus, in short order, money, so the bound
    // reserves the two provider windows and the shutdown grace before one
    // is issued. That reservation is not a promise the claim will finish:
    // the RPCs, the parsing and the writes are outside it.
    //
    // No optional chaining and no fallback. The bound is a required
    // option, so there is no "absent" case to be lenient about, and a
    // reader cannot mistake this line for one that tolerates its absence.
    if (!opts.runtimeBound.allowsNewClaim()) break;
    // B1 — no try/catch here on purpose. An unhandled throw during the first
    // job propagates out of this loop and ends the process; it can never
    // fall through to a second claim.
    const r = await runOneIteration(deps, opts, health);
    onIteration?.(r);
    if (r.outcome === "no_job") {
      idle += 1;
      // Still waits on an empty queue: single-job mode bounds JOBS, not
      // patience.
      await sleep(backoffWithJitter(opts, idle), deps.abortSignal);
      continue;
    }
    idle = 0;
    // Any outcome other than no_job means a job WAS claimed — completed,
    // failed, capped, parse_failed, needs_review, lost_ownership alike. In
    // single-job mode that is the whole mandate: break before the loop can
    // issue a second claim.
    if (opts.exitAfterClaimedJob) break;
  }
  health.markShuttingDown();
  return health;
}
