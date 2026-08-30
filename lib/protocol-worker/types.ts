/**
 * M5-A — protocol execution worker: shared types and injection seams.
 *
 * Option A: the worker drives the job-scoped RPCs directly and never
 * calls the raw M4 entry points (`admitAndReserveAttempt`,
 * `startAttempt`, `reconcileAttempt`). `lib/pipeline/run-protocol-gated-
 * baseline.ts` is left untouched and keeps serving the manual path.
 */

import type { DbAdapter, ProbeMode } from "@/lib/db/types";
import type { runPerplexityProbe } from "@/lib/probes/perplexity";
import type { CallModelResult, PreparedCallModelRequest } from "@/lib/llm/call-model";

/**
 * Provider seam for the Perplexity call.
 *
 * The worker passes a `fetchImpl` that marks the external call as sent
 * immediately before the real network write — see `execute-job.ts`. A
 * test injects a fake here and asserts that a failed mark produces zero
 * fetches.
 */
export type PerplexityProbeRunner = typeof runPerplexityProbe;

/** Two-phase analysis seam: prepare first, then execute the prepared body. */
export interface AnalysisTransport {
  prepare(call: {
    system: string;
    user: string;
    jsonMode: true;
    temperature: number;
    maxTokens: number;
    mockResponse: string;
  }): PreparedCallModelRequest;
  execute(prepared: PreparedCallModelRequest, opts?: { signal?: AbortSignal }): Promise<CallModelResult>;
}

/** The real outbound transport, injected so tests never touch the network. */
export type RealFetch = typeof fetch;

export interface WorkerDeps {
  db: DbAdapter;
  runProbe: PerplexityProbeRunner;
  analysis: AnalysisTransport;
  realFetch: RealFetch;
  /** Wall clock, injected so tests are deterministic. */
  now: () => number;
  /**
   * Injected so a test can wait without really waiting. Must resolve
   * early when the signal aborts: a shutdown that has to outlast a full
   * backoff is not a bounded shutdown.
   */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Cooperative shutdown. Reaches both providers — the Perplexity fetch
   * and the analysis call — and cuts the idle wait short.
   */
  abortSignal?: AbortSignal;
  /**
   * The probe mode every started attempt is recorded under. Injected
   * rather than hardcoded so a runtime test can drive the identical code
   * path without a live provider key.
   */
  probeMode: ProbeMode;
}

export interface WorkerOptions {
  workerId: string;
  leaseSeconds: number;
  /** Base sleep on NO_JOB_AVAILABLE, in ms. */
  idleBackoffMs: number;
  /** Upper bound for the exponential backoff, in ms. */
  maxBackoffMs: number;
  /**
   * Hard bound on baseline slots driven under a single claim. The SQL
   * completion gate is the real authority; this only stops a malformed
   * ledger from spinning the loop forever.
   */
  maxSlotsPerClaim: number;
  /**
   * Conservative per-call reservations, in USD. The SQL admission gate
   * compares these against the project's remaining budget before any
   * request leaves; they are ceilings, never the amount finally billed
   * (that comes from the receipt).
   */
  perplexityReservedCostUsd: number;
  analysisReservedCostUsd: number;
  /**
   * Backoff jitter, as a fraction of the delay. Without it, N workers that
   * started together stay in lockstep for ever.
   */
  jitterRatio: number;
  /**
   * Timed retries allowed under a SINGLE claim when a transient cap
   * refuses admission. The claim and the heartbeat are held throughout:
   * letting the lease lapse would burn an attempt_count and could turn a
   * transient cap into abandoned_exhausted.
   */
  maxThrottledRetries: number;
  /** Cooperative shutdown budget. Must stay below the lease. */
  graceMs: number;
  /**
   * B1 — when true, the loop exits after the first iteration that actually
   * claimed a job, whatever its outcome, and never claims again.
   */
  exitAfterClaimedJob: boolean;
  /** B2 — per-provider-call ceiling in ms, applied separately to each leg. */
  providerTimeoutMs: number;
}

/**
 * Why one iteration ended. Every value is a closed, privacy-safe label:
 * no prompt, no body, no claim token ever reaches a log line.
 */
export type IterationOutcome =
  | "no_job"
  | "completed"
  /** 0056 — the call was already sent once with this exact request. */
  | "already_sent"
  /** 0056 — request evidence absent or divergent; the job is under review. */
  | "needs_review_request_evidence"
  /** 0056 — a receipt exists whose evidence differs from the one offered. */
  | "needs_review_receipt_evidence"
  /** A transient cap held for every retry allowed under one claim. */
  | "throttled"
  /** The provider failed definitively; the caller must close with T3. */
  | "provider_failed"
  | "needs_review_perplexity_unknown"
  | "needs_review_analysis_unknown"
  | "parse_failed"
  | "lost_ownership"
  | "capped"
  | "failed";

export interface IterationResult {
  outcome: IterationOutcome;
  jobId: string | null;
  /** Closed detail label — an RPC outcome string, never free text. */
  detail: string | null;
}

/** Raised when a fenced RPC refuses the write; nothing was sent. */
export class WorkerAbort extends Error {
  readonly rpcOutcome: string;
  constructor(rpcOutcome: string) {
    super(`worker aborted: ${rpcOutcome}`);
    this.name = "WorkerAbort";
    this.rpcOutcome = rpcOutcome;
  }
}
