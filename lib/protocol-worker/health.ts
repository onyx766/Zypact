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
  /**
   * TK-R-0 — idle proof.
   *
   * `iterations` counts CLAIMED jobs and nothing else; a worker that polls
   * an empty queue forever leaves it at zero. That is correct, and it is
   * also why "the loop really did poll" could not be evidenced: no counter
   * existed for a claim that answered NO_JOB_AVAILABLE. These four carry
   * that proof, and they are strictly additive — `iterations` keeps its
   * original meaning untouched.
   *
   *   noJobCycles                 every idle claim, for the process's life.
   *   consecutiveNoJobCycles      the current streak; any non-idle outcome,
   *                               or a claim that threw, resets it to 0.
   *   maxConsecutiveNoJobCycles   the high-water mark of that streak, so a
   *                               later busy period cannot erase the proof.
   *   lastNoJobAtMs               when the most recent idle claim answered.
   */
  readonly noJobCycles: number;
  readonly consecutiveNoJobCycles: number;
  readonly maxConsecutiveNoJobCycles: number;
  readonly lastNoJobAtMs: number | null;
  readonly shuttingDown: boolean;
}

/**
 * TK-R-0 — how many consecutive idle claims constitute proof that the loop
 * really is polling. Three: one claim proves the database answered, two
 * prove it was not a fluke, three prove a repeating cycle.
 */
export const IDLE_PROOF_THRESHOLD = 3;

/** The bounded idle-proof payload. Closed counters only — never an id. */
export interface IdleProofEvent {
  readonly consecutiveNoJobCycles: number;
  readonly noJobCycles: number;
  readonly maxConsecutiveNoJobCycles: number;
}

/**
 * TK-R-0 — the idle-proof decision, in ONE place.
 *
 * Returns a payload the moment a streak FIRST reaches the threshold, and
 * null on every other cycle — cycles 4..n of the same streak included,
 * which is exactly what stops an idle worker from filling the log. The
 * runner calls this, and so does its test: neither restates the condition,
 * so neither can drift from the other.
 */
export function idleProofEvent(snapshot: HealthSnapshot): IdleProofEvent | null {
  if (snapshot.consecutiveNoJobCycles !== IDLE_PROOF_THRESHOLD) return null;
  return {
    consecutiveNoJobCycles: snapshot.consecutiveNoJobCycles,
    noJobCycles: snapshot.noJobCycles,
    maxConsecutiveNoJobCycles: snapshot.maxConsecutiveNoJobCycles,
  };
}

export class WorkerHealth {
  private startedAtMs: number;
  private lastClaimAtMs: number | null = null;
  private lastHeartbeatAtMs: number | null = null;
  private lastDbContactAtMs: number | null = null;
  private iterations = 0;
  private noJobCycles = 0;
  private consecutiveNoJobCycles = 0;
  private maxConsecutiveNoJobCycles = 0;
  private lastNoJobAtMs: number | null = null;
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

  /**
   * TK-R-0 — one claim answered "nothing to do". Deliberately separate
   * from `markIteration`, which still means "a job was claimed".
   */
  markNoJob(): void {
    this.noJobCycles += 1;
    this.consecutiveNoJobCycles += 1;
    if (this.consecutiveNoJobCycles > this.maxConsecutiveNoJobCycles) {
      this.maxConsecutiveNoJobCycles = this.consecutiveNoJobCycles;
    }
    this.lastNoJobAtMs = this.now();
  }

  /**
   * TK-R-0 — anything that is not an idle claim breaks the streak: a job
   * actually claimed, or a claim that threw before it could answer. The
   * totals and the high-water mark are never rewound.
   */
  resetNoJobStreak(): void {
    this.consecutiveNoJobCycles = 0;
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
      noJobCycles: this.noJobCycles,
      consecutiveNoJobCycles: this.consecutiveNoJobCycles,
      maxConsecutiveNoJobCycles: this.maxConsecutiveNoJobCycles,
      lastNoJobAtMs: this.lastNoJobAtMs,
      shuttingDown: this.shuttingDown,
    };
  }
}
