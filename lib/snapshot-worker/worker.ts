/**
 * Persistent snapshot worker controller.
 *
 * Claims one approved request at a time and runs it through the existing
 * worker-safe engine. The claim RPC *is* the queue — there is no external
 * queue product, no cron, and no inline serverless execution.
 *
 * Concurrency is one **structurally**, not by configuration: a single
 * sequential `while` loop with one awaited claim per iteration. There is no
 * pool, no promise array, and no concurrency parameter, so running two jobs
 * at once would require rewriting this loop rather than changing a number.
 *
 * Everything external is injected — claim, fenced failure write, resolver,
 * engine, sleep, clock, logger — so the whole state machine is testable with
 * no database, no provider, no real timer, and no process signal.
 *
 * What this file deliberately does NOT own:
 *
 *   - execution option values: `resolveWorkerExecutionOptions` decides them;
 *   - lease renewal: `runApprovedSnapshot` and `mvp-scan` own it;
 *   - report completion and execution failure: the engine owns both.
 *
 * The one failure window that *is* the worker's own is between a successful
 * claim and the engine's first line: the claim already moved the row to
 * `running`, so if resolution fails there, nothing else will record it.
 */

import type { SnapshotRequest } from "@/lib/db/types";
import {
  WorkerExecutionOptionsError,
  resolveWorkerExecutionOptions as defaultResolver,
} from "@/lib/snapshot-worker/execution-options";
import type { ApprovedSnapshotExecutionOptions } from "@/lib/snapshot-engine/run-approved-snapshot";

/** Idle wait when the queue is empty. */
export const IDLE_POLL_MS = 15_000;

/** Lease requested at claim and handed to the engine's renewal plan. */
export const LEASE_SECONDS = 300;

/** Renewal cadence. Three renewals per lease leaves margin for a slow call. */
export const RENEW_EVERY_MS = 100_000;

/** Wall-clock ceiling for one scan. Bounds a hung provider call. */
export const MAX_EXECUTION_MS = 1_800_000;

/**
 * Claim attempts before the RPC terminalizes a request as failed. Two
 * reclaims survive a crash without re-spending indefinitely on a request
 * that cannot complete.
 */
export const MAX_ATTEMPTS = 3;

/** Backoff after a claim RPC error. Resets on any successful claim call. */
export const ERROR_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000] as const;

/**
 * Reasons that mean the request itself can never succeed. A founder must
 * fix the competitor frame; retrying cannot help.
 */
const PERMANENT_RESOLVER_REASONS = new Set([
  "competitors_not_an_array",
  "competitor_not_a_string",
  "competitors_below_minimum",
  "competitors_above_maximum",
  "competitor_too_long",
]);

export type WorkerLogEvent =
  | "worker_started"
  | "worker_idle"
  | "claim_succeeded"
  | "claim_error"
  | "claim_abandoned_for_shutdown"
  | "resolver_rejected"
  | "execution_started"
  | "execution_succeeded"
  | "execution_failed"
  | "ownership_lost"
  | "worker_shutdown_requested"
  | "worker_stopped"
  | "worker_fatal";

/**
 * Structured log line.
 *
 * The field list is closed on purpose. A claim token, work email, company
 * name, domain, website, competitor value, provider response, or report
 * content has nowhere to go, so it cannot leak through a log call.
 */
export interface WorkerLogFields {
  event: WorkerLogEvent;
  workerId: string;
  requestId?: string;
  attemptCount?: number;
  durationMs?: number;
  reason?: string;
}

export type WorkerLogger = (fields: WorkerLogFields) => void;

/** Why the loop stopped. The entrypoint maps this to an exit code. */
export type WorkerStopReason =
  /** Shutdown was requested and the loop drained cleanly. */
  | "shutdown"
  /** A contract violation the claim RPC should have prevented. */
  | "impossible_state"
  /** The engine failed in a way that is not attributable to one request. */
  | "systemic_engine_error";

export interface WorkerResult {
  reason: WorkerStopReason;
  claimed: number;
  succeeded: number;
  failed: number;
}

/** The narrow database surface. No adapter method beyond these two. */
export interface WorkerDb {
  claimNextSnapshotRequest(input: {
    workerId: string;
    leaseSeconds: number;
    maxAttempts: number;
  }): Promise<SnapshotRequest | null>;
  markSnapshotRequestFailedWorker(input: {
    requestId: string;
    projectId: string;
    claimToken: string;
  }): Promise<SnapshotRequest | null>;
}

/** Engine invocation, injected so tests never spawn a real scan. */
export type WorkerEngine = (
  claimed: SnapshotRequest,
  options: ApprovedSnapshotExecutionOptions,
  claimToken: string
) => Promise<unknown>;

export interface WorkerDeps {
  db: WorkerDb;
  engine: WorkerEngine;
  workerId: string;
  /** Awaitable, interruptible wait. Resolves early on shutdown. */
  sleep: (ms: number) => Promise<void>;
  log: WorkerLogger;
  resolver?: (claimed: SnapshotRequest) => ApprovedSnapshotExecutionOptions;
  now?: () => number;
}

/**
 * Shutdown intent, shared between the signal handlers and the loop.
 *
 * `wake` lets a signal cut an idle or backoff sleep short instead of waiting
 * out a full interval.
 */
export class ShutdownSignal {
  private requested = false;
  private wakers: Array<() => void> = [];

  get isRequested(): boolean {
    return this.requested;
  }

  /** Idempotent: repeated signals are harmless. */
  request(): void {
    if (this.requested) return;

    this.requested = true;

    const waiting = this.wakers;
    this.wakers = [];
    for (const wake of waiting) wake();
  }

  /** Sleep that returns early once shutdown is requested. */
  sleep(ms: number, timer: typeof setTimeout = setTimeout): Promise<void> {
    if (this.requested) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let settled = false;

      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      this.wakers.push(finish);
      timer(finish, ms);
    });
  }
}

function isOwnershipLost(error: unknown): boolean {
  // The engine reports, in a typed field, whether it managed to record the
  // failure itself. `false` means the fenced write was refused — ownership
  // is gone and any repair from here would be unfenced.
  return (
    typeof error === "object" &&
    error !== null &&
    "requestMarkedFailed" in error &&
    (error as { requestMarkedFailed: unknown }).requestMarkedFailed === false
  );
}

function isEngineHandledFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "requestMarkedFailed" in error &&
    (error as { requestMarkedFailed: unknown }).requestMarkedFailed === true
  );
}

/**
 * Runs the claim/execute loop until shutdown or an unrecoverable condition.
 *
 * Returns rather than exiting so the entrypoint owns process semantics and
 * tests can assert the stop reason.
 */
export async function runSnapshotWorker(
  deps: WorkerDeps,
  shutdown: ShutdownSignal
): Promise<WorkerResult> {
  const resolver = deps.resolver ?? defaultResolver;
  const now = deps.now ?? (() => Date.now());

  let backoffIndex = -1;
  const result: WorkerResult = {
    reason: "shutdown",
    claimed: 0,
    succeeded: 0,
    failed: 0,
  };

  deps.log({ event: "worker_started", workerId: deps.workerId });

  while (!shutdown.isRequested) {
    let claimed: SnapshotRequest | null;

    try {
      claimed = await deps.db.claimNextSnapshotRequest({
        workerId: deps.workerId,
        leaseSeconds: LEASE_SECONDS,
        maxAttempts: MAX_ATTEMPTS,
      });

      // Any completed call proves the database is reachable, including a
      // no-work result.
      backoffIndex = -1;
    } catch (error) {
      backoffIndex = Math.min(
        backoffIndex + 1,
        ERROR_BACKOFF_MS.length - 1
      );

      // Only a summarized reason: a raw error may carry connection details.
      deps.log({
        event: "claim_error",
        workerId: deps.workerId,
        reason: error instanceof Error ? error.name : "unknown_error",
      });

      await deps.sleep(ERROR_BACKOFF_MS[backoffIndex]!);
      continue;
    }

    // Shutdown arrived while the claim was in flight. A claimed request is
    // healthy — it must NOT be executed and must NOT be marked failed just
    // because this process is stopping. Leaving it untouched costs one
    // attempt and lets the existing stale-lease reclaim recover it.
    if (shutdown.isRequested) {
      if (claimed) {
        deps.log({
          event: "claim_abandoned_for_shutdown",
          workerId: deps.workerId,
          requestId: claimed.id,
          attemptCount: claimed.attemptCount,
        });
      }
      break;
    }

    if (!claimed) {
      deps.log({ event: "worker_idle", workerId: deps.workerId });
      await deps.sleep(IDLE_POLL_MS);
      continue;
    }

    result.claimed += 1;

    deps.log({
      event: "claim_succeeded",
      workerId: deps.workerId,
      requestId: claimed.id,
      attemptCount: claimed.attemptCount,
    });

    let options: ApprovedSnapshotExecutionOptions;

    try {
      options = resolver(claimed);
    } catch (error) {
      const reason =
        error instanceof WorkerExecutionOptionsError
          ? error.reason
          : "resolver_error";

      const permanent = PERMANENT_RESOLVER_REASONS.has(reason);

      deps.log({
        event: "resolver_rejected",
        workerId: deps.workerId,
        requestId: claimed.id,
        reason,
      });

      // The claim already moved this row to `running`, so the worker owns
      // recording the failure. Only the fenced write is ever used.
      const owned = await markFailedFenced(deps, claimed);

      if (!owned) {
        deps.log({
          event: "ownership_lost",
          workerId: deps.workerId,
          requestId: claimed.id,
          reason,
        });
      } else {
        result.failed += 1;
      }

      if (permanent) continue;

      // An impossible state means the claim RPC's guarantees were violated.
      // Continuing would repeat the fault against every queued request.
      result.reason = "impossible_state";
      deps.log({ event: "worker_stopped", workerId: deps.workerId, reason });
      return result;
    }

    if (shutdown.isRequested) {
      deps.log({
        event: "claim_abandoned_for_shutdown",
        workerId: deps.workerId,
        requestId: claimed.id,
        attemptCount: claimed.attemptCount,
      });
      break;
    }

    const startedAt = now();

    deps.log({
      event: "execution_started",
      workerId: deps.workerId,
      requestId: claimed.id,
    });

    try {
      await deps.engine(claimed, options, claimed.claimToken ?? "");

      result.succeeded += 1;
      deps.log({
        event: "execution_succeeded",
        workerId: deps.workerId,
        requestId: claimed.id,
        durationMs: now() - startedAt,
      });
    } catch (error) {
      const durationMs = now() - startedAt;

      if (isEngineHandledFailure(error)) {
        // The engine already recorded this through its fenced RPC. Writing
        // again would be a duplicate.
        result.failed += 1;
        deps.log({
          event: "execution_failed",
          workerId: deps.workerId,
          requestId: claimed.id,
          durationMs,
          reason: "engine_recorded",
        });
        continue;
      }

      if (isOwnershipLost(error)) {
        // The fenced write was refused. Any repair from here is unfenced.
        deps.log({
          event: "ownership_lost",
          workerId: deps.workerId,
          requestId: claimed.id,
          durationMs,
        });
        continue;
      }

      // Not an engine-classified failure: the fault may be in the worker
      // runtime or its configuration, so it is not attributable to this one
      // request. Halting beats consuming the rest of the queue with it.
      deps.log({
        event: "worker_fatal",
        workerId: deps.workerId,
        requestId: claimed.id,
        durationMs,
        reason: error instanceof Error ? error.name : "unknown_error",
      });

      result.reason = "systemic_engine_error";
      deps.log({ event: "worker_stopped", workerId: deps.workerId });
      return result;
    }
  }

  deps.log({ event: "worker_stopped", workerId: deps.workerId });
  return result;
}

/**
 * Token-fenced failure write for the pre-engine window.
 *
 * Returns false when ownership is gone. A refusal is never retried and never
 * escalated to a direct table write.
 */
async function markFailedFenced(
  deps: WorkerDeps,
  claimed: SnapshotRequest
): Promise<boolean> {
  if (!claimed.projectId || !claimed.claimToken) return false;

  try {
    const failed = await deps.db.markSnapshotRequestFailedWorker({
      requestId: claimed.id,
      projectId: claimed.projectId,
      claimToken: claimed.claimToken,
    });

    return failed !== null;
  } catch {
    return false;
  }
}
