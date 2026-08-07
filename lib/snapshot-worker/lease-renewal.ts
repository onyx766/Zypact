/**
 * Child-side lease renewal for worker-executed snapshots.
 *
 * `runApprovedSnapshot` uses `spawnSync`, so the parent's event loop is
 * blocked for the whole scan and a timer there can never fire. `mvp-scan`
 * is the long child and its loop *is* free between awaits, so renewal has
 * to live here rather than in the parent.
 *
 * A renewed lease is not optional bookkeeping. `renew_snapshot_request_lease`
 * refuses once `lease_expires_at <= now()`, and an expired token can never
 * recover. If the lease lapses mid-scan another worker reclaims the request
 * and re-runs it at full provider cost, while every write from this process
 * is refused by the SQL fence.
 *
 * Two rules make that safe:
 *
 *   1. Ownership loss is terminal. Once refused, errored, or past the
 *      execution deadline, this never renews again and never recovers.
 *   2. Renewal is bounded. Without `maxExecutionMs` a hung provider call
 *      would renew forever and pin the request in `running` — strictly
 *      worse than letting it expire and be reclaimed.
 *
 * Nothing here claims a request, polls, sleeps, backs off, or handles
 * signals.
 */

import type {
  RenewSnapshotRequestLeaseInput,
  SnapshotRequest,
} from "@/lib/db/types";

/** The single adapter method this needs. Declared structurally for tests. */
export interface LeaseRenewalDb {
  renewSnapshotRequestLease(
    input: RenewSnapshotRequestLeaseInput
  ): Promise<SnapshotRequest | null>;
}

export type LeaseOwnershipLossReason =
  /** The RPC returned no row: wrong token, moved on, or already expired. */
  | "refused"
  /** The RPC threw. Ownership is unknown, so it is treated as lost. */
  | "error"
  /** The execution ceiling passed. Renewal stops so the row can be reclaimed. */
  | "deadline";

export type LeaseOwnership =
  | { owned: true }
  | {
      owned: false;
      reason: LeaseOwnershipLossReason;
      detail: string;
    };

export interface LeaseRenewalConfig {
  requestId: string;
  claimToken: string;
  /** Lease length requested on every renewal. The RPC enforces 60-3600. */
  leaseSeconds: number;
  /** Renewal cadence. Must leave room for at least one retry before expiry. */
  renewEveryMs: number;
  /** Hard wall-clock ceiling for the whole scan. */
  maxExecutionMs: number;
}

/** Thrown when a provider-capable operation is attempted without ownership. */
export class LeaseOwnershipLostError extends Error {
  readonly reason: LeaseOwnershipLossReason;

  constructor(reason: LeaseOwnershipLossReason, detail: string) {
    super(`Worker lease ownership lost (${reason}): ${detail}`);
    this.name = "LeaseOwnershipLostError";
    this.reason = reason;
  }
}

/** Matches the database bounds so a bad value fails here, not mid-scan. */
export const MIN_LEASE_SECONDS = 60;
export const MAX_LEASE_SECONDS = 3600;

export function validateLeaseRenewalConfig(
  config: LeaseRenewalConfig
): string | null {
  if (config.requestId.trim() === "") return "requestId is required.";
  if (config.claimToken.trim() === "") return "claimToken is required.";

  if (
    !Number.isInteger(config.leaseSeconds) ||
    config.leaseSeconds < MIN_LEASE_SECONDS ||
    config.leaseSeconds > MAX_LEASE_SECONDS
  ) {
    return `leaseSeconds must be an integer between ${MIN_LEASE_SECONDS} and ${MAX_LEASE_SECONDS}.`;
  }

  if (!Number.isInteger(config.renewEveryMs) || config.renewEveryMs <= 0) {
    return "renewEveryMs must be a positive integer.";
  }

  // Renew at least twice per lease. One renewal per lease would leave no
  // margin: a single slow or failed call would expire the lease outright.
  if (config.renewEveryMs * 2 > config.leaseSeconds * 1000) {
    return "renewEveryMs must be at most half of leaseSeconds so a missed renewal still has margin.";
  }

  if (
    !Number.isInteger(config.maxExecutionMs) ||
    config.maxExecutionMs <= 0
  ) {
    return "maxExecutionMs must be a positive integer.";
  }

  return null;
}

export interface LeaseRenewerDeps {
  db: LeaseRenewalDb;
  now?: () => number;
  setIntervalFn?: (handler: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

/**
 * Keeps a claim alive while the scan runs, and reports the moment it stops
 * being the owner. It never cancels anything itself — the caller checks
 * `assertOwned()` before starting the next provider-capable operation.
 */
export class LeaseRenewer {
  private readonly config: LeaseRenewalConfig;
  private readonly db: LeaseRenewalDb;
  private readonly now: () => number;
  private readonly setIntervalFn: (
    handler: () => void,
    ms: number
  ) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;

  private state: LeaseOwnership = { owned: true };
  private handle: unknown = null;
  private deadlineAt: number | null = null;
  private renewals = 0;

  constructor(config: LeaseRenewalConfig, deps: LeaseRenewerDeps) {
    const invalid = validateLeaseRenewalConfig(config);
    if (invalid) throw new Error(`Invalid lease configuration: ${invalid}`);

    this.config = config;
    this.db = deps.db;
    this.now = deps.now ?? (() => Date.now());
    this.setIntervalFn =
      deps.setIntervalFn ??
      ((handler, ms) => setInterval(handler, ms).unref());
    this.clearIntervalFn =
      deps.clearIntervalFn ??
      ((handle) => clearInterval(handle as NodeJS.Timeout));
  }

  /** Renewals performed so far. Test and log visibility only. */
  get renewalCount(): number {
    return this.renewals;
  }

  ownership(): LeaseOwnership {
    return this.state;
  }

  /**
   * Call immediately before any provider-capable operation. Throwing here
   * is the whole cancellation mechanism: it unwinds the scan, which exits
   * non-zero, which lets the parent record failure through the fenced RPC.
   */
  assertOwned(): void {
    this.checkDeadline();

    if (!this.state.owned) {
      throw new LeaseOwnershipLostError(
        this.state.reason,
        this.state.detail
      );
    }
  }

  /**
   * Prove ownership, then begin renewing.
   *
   * The initial renewal is not a formality. Scheduling alone would let the
   * scan spend money for a full `renewEveryMs` before anything verified the
   * claim was still ours, so a revoked or already-expired claim would only
   * surface after the first paid probes. Periodic renewal is scheduled only
   * after that first call succeeds; a refused or throwing initial renewal
   * leaves no timer running and ownership permanently lost.
   */
  async start(): Promise<LeaseOwnership> {
    if (this.handle !== null) return this.state;
    if (!this.state.owned) return this.state;

    this.deadlineAt = this.now() + this.config.maxExecutionMs;

    const initial = await this.renewOnce();
    if (!initial.owned) return initial;

    this.handle = this.setIntervalFn(() => {
      void this.renewOnce();
    }, this.config.renewEveryMs);

    return this.state;
  }

  stop(): void {
    if (this.handle === null) return;

    this.clearIntervalFn(this.handle);
    this.handle = null;
  }

  /**
   * One renewal attempt. Exposed so the scan can top the lease up right
   * before it exits, leaving the parent a full lease for report rendering
   * and the fenced completion write.
   */
  async renewOnce(): Promise<LeaseOwnership> {
    // Never renew after ownership is lost: that is what stops a hung scan
    // from holding the request in `running` indefinitely.
    if (!this.state.owned) return this.state;

    this.checkDeadline();
    if (!this.state.owned) return this.state;

    let renewed: SnapshotRequest | null;

    try {
      renewed = await this.db.renewSnapshotRequestLease({
        requestId: this.config.requestId,
        claimToken: this.config.claimToken,
        leaseSeconds: this.config.leaseSeconds,
      });
    } catch (error) {
      // An error leaves ownership unknown. Unknown is treated as lost:
      // continuing would risk paid work whose result cannot be written.
      return this.lose(
        "error",
        error instanceof Error ? error.message : "unknown_error"
      );
    }

    if (!renewed) {
      return this.lose(
        "refused",
        "the claim is no longer valid"
      );
    }

    this.renewals += 1;
    return this.state;
  }

  private checkDeadline(): void {
    if (!this.state.owned || this.deadlineAt === null) return;

    if (this.now() >= this.deadlineAt) {
      this.lose(
        "deadline",
        `execution exceeded ${this.config.maxExecutionMs}ms`
      );
    }
  }

  private lose(
    reason: LeaseOwnershipLossReason,
    detail: string
  ): LeaseOwnership {
    this.state = { owned: false, reason, detail };
    this.stop();
    return this.state;
  }
}

/**
 * Reserved after the renderer finishes, before the lease window closes.
 *
 * The parent still has to collect the child, read both report files, and
 * perform the fenced completion RPC. All of that must land inside the lease
 * `mvp-scan` renewed just before it exited, because a lapsed lease means the
 * completion write is refused after a fully paid scan.
 */
export const COMPLETION_SAFETY_MARGIN_MS = 30_000;

/** Ceiling for the renderer itself. Rendering is fast; this is a backstop. */
export const MAX_RENDERER_TIMEOUT_MS = 120_000;

/**
 * Renderer timeout derived from the freshly renewed lease.
 *
 * Guaranteed for every valid configuration:
 *
 *   0 < rendererTimeoutMs
 *   rendererTimeoutMs + COMPLETION_SAFETY_MARGIN_MS <= leaseSeconds * 1000
 *
 * The lower bound holds because `leaseSeconds` is at least 60, so the lease
 * window is at least 60000ms and always exceeds the 30000ms margin.
 */
export function rendererTimeoutMsFor(leaseSeconds: number): number {
  const leaseWindowMs = leaseSeconds * 1000;

  return Math.min(
    leaseWindowMs - COMPLETION_SAFETY_MARGIN_MS,
    MAX_RENDERER_TIMEOUT_MS
  );
}

/** Environment channel used by `run-approved-snapshot` to reach the child. */
export const LEASE_ENV_KEYS = {
  claimToken: "SNAPSHOT_CLAIM_TOKEN",
  requestId: "SNAPSHOT_REQUEST_ID",
  leaseSeconds: "SNAPSHOT_LEASE_SECONDS",
  renewEveryMs: "SNAPSHOT_LEASE_RENEW_EVERY_MS",
  maxExecutionMs: "SNAPSHOT_LEASE_MAX_EXECUTION_MS",
} as const;

/**
 * Reads the worker lease configuration a parent passed to this child.
 *
 * Returns null when no claim token is present — that is a manual CLI run,
 * which has no lease and must behave exactly as before. When a token *is*
 * present the configuration must be complete: a claimed run without a
 * renewal plan is the failure mode this module exists to prevent.
 */
export function readLeaseRenewalConfigFromEnv(
  env: Record<string, string | undefined>
): LeaseRenewalConfig | null {
  const claimToken = env[LEASE_ENV_KEYS.claimToken]?.trim();
  if (!claimToken) return null;

  const requestId = env[LEASE_ENV_KEYS.requestId]?.trim() ?? "";

  const asInt = (raw: string | undefined): number => {
    const value = Number(raw?.trim());
    return Number.isFinite(value) ? Math.trunc(value) : Number.NaN;
  };

  const config: LeaseRenewalConfig = {
    requestId,
    claimToken,
    leaseSeconds: asInt(env[LEASE_ENV_KEYS.leaseSeconds]),
    renewEveryMs: asInt(env[LEASE_ENV_KEYS.renewEveryMs]),
    maxExecutionMs: asInt(env[LEASE_ENV_KEYS.maxExecutionMs]),
  };

  const invalid = validateLeaseRenewalConfig(config);
  if (invalid) {
    throw new Error(
      `Worker lease configuration is invalid or incomplete: ${invalid}`
    );
  }

  return config;
}
