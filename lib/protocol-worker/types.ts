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
  execute(prepared: PreparedCallModelRequest): Promise<CallModelResult>;
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
}

/**
 * Why one iteration ended. Every value is a closed, privacy-safe label:
 * no prompt, no body, no claim token ever reaches a log line.
 */
export type IterationOutcome =
  | "no_job"
  | "completed"
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
