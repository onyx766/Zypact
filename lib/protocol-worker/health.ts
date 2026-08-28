/**
 * M5-A — in-memory health state.
 *
 * Deliberately never reads the database: a health check that queries the
 * DB turns a database blip into a restart storm. It also carries no
 * secret, no prompt, no request body and no claim token — only closed
 * counters and timestamps.
 */

export interface HealthSnapshot {
  readonly alive: boolean;
  readonly startedAtMs: number;
  readonly lastClaimAtMs: number | null;
  readonly lastHeartbeatAtMs: number | null;
  readonly lastDbContactAtMs: number | null;
  readonly iterations: number;
  readonly shuttingDown: boolean;
}

export class WorkerHealth {
  private startedAtMs: number;
  private lastClaimAtMs: number | null = null;
  private lastHeartbeatAtMs: number | null = null;
  private lastDbContactAtMs: number | null = null;
  private iterations = 0;
  private shuttingDown = false;

  constructor(private readonly now: () => number) {
    this.startedAtMs = now();
  }

  markClaim(): void {
    this.lastClaimAtMs = this.now();
  }
  /** True when the database was reachable within `staleMs`. */
  isReady(staleMs: number): boolean {
    if (this.lastDbContactAtMs === null) return false;
    return this.now() - this.lastDbContactAtMs < staleMs;
  }

  markHeartbeat(): void {
    this.lastHeartbeatAtMs = this.now();
  }
  markIteration(): void {
    this.iterations += 1;
  }
  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  /**
   * Any RPC that returned without throwing — a claim answering
   * NO_JOB_AVAILABLE included. Readiness cannot rest on the heartbeat
   * alone: a healthy worker with nothing to do never renews a lease, and
   * would otherwise look dead.
   */
  markDbContact(): void {
    this.lastDbContactAtMs = this.now();
  }

  snapshot(): HealthSnapshot {
    return {
      alive: true,
      startedAtMs: this.startedAtMs,
      lastClaimAtMs: this.lastClaimAtMs,
      lastHeartbeatAtMs: this.lastHeartbeatAtMs,
      lastDbContactAtMs: this.lastDbContactAtMs,
      iterations: this.iterations,
      shuttingDown: this.shuttingDown,
    };
  }
}
