/**
 * B3-intrinsic — the total runtime bound.
 *
 * Every other bound in this worker is per-something: `providerTimeoutMs`
 * bounds one provider leg, `maxSlotsPerClaim` bounds the slots under one
 * claim, `exitAfterClaimedJob` bounds the jobs. None of them bounds the
 * PROCESS. On an empty queue the loop sleeps, claims, sleeps and claims
 * again for as long as it is left alone, and the only thing that ever
 * stopped it was an operator watching a clock.
 *
 * That is an operational bound, not an intrinsic one, and an operational
 * bound is exactly the kind that is missing the night it is needed. This
 * module makes the ceiling part of the program:
 *
 *   T0                       set before the first dynamic import, so the
 *                            budget covers module evaluation, client
 *                            construction and the first claim alike.
 *   deadlineMs               T0 + maxRuntimeSeconds x 1000. Absolute; it
 *                            never slides, whatever the loop is doing.
 *   graceAtMs                deadlineMs - graceMs. Entering this window
 *                            triggers the ORDINARY cooperative stop — the
 *                            same one SIGTERM triggers, not a second
 *                            shutdown path.
 *   requiredMsForNewClaim    a RESERVATION, computed by `claimBudgetMs` in
 *                            `execution-mode.ts` and passed in here. It
 *                            reserves TWO provider ceilings plus the
 *                            grace, because one baseline slot calls
 *                            Perplexity and then the analysis model and
 *                            the timeout bounds each separately. It is
 *                            scoped to a single-slot claim
 *                            (WORKER_MAX_SLOTS_PER_CLAIM=1).
 *
 *                            What it does NOT cover: the job-scoped RPCs,
 *                            the parsing, the derivation and the writes. A
 *                            claim is declined once the remaining runtime
 *                            drops below this reservation; it is not a
 *                            promise that the claim will finish. Admission
 *                            is `remaining >= required`, so at equality a
 *                            claim is issued with zero modelled margin
 *                            beyond the two provider windows and the
 *                            grace.
 *
 * Three refusals, three distinct events, never one blurred "timeout":
 * declining a claim, winding down, and being cut off are three different
 * facts about a run and an operator has to be able to tell them apart.
 *
 * Timers are injected so the tests exercise this logic rather than a
 * paraphrase of it, and the real ones are unref'd: a bound whose own timer
 * keeps the process alive would be the thing it exists to prevent.
 */

/** Opaque handle; the injected implementation owns its real type. */
export type RuntimeTimerHandle = unknown;

export interface RuntimeTimers {
  set(fn: () => void, ms: number): RuntimeTimerHandle;
  clear(handle: RuntimeTimerHandle): void;
}

/**
 * Node timers, unref'd. An unreferenced timer still fires while anything
 * else holds the loop open — which is precisely when a runtime ceiling is
 * needed — and never holds it open by itself.
 */
export const unrefTimers: RuntimeTimers = {
  set(fn: () => void, ms: number): RuntimeTimerHandle {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clear(handle: RuntimeTimerHandle): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * Closed scalars only. No environment, no configuration value that could
 * carry a credential, no job id, no prompt — these lines are logged.
 */
export type RuntimeBoundEvent =
  | {
      readonly event: "worker_runtime_budget_exhausted";
      readonly remainingMs: number;
      readonly requiredMs: number;
      readonly maxRuntimeSeconds: number;
    }
  | {
      readonly event: "worker_runtime_deadline_grace";
      readonly elapsedMs: number;
      readonly graceMs: number;
      readonly maxRuntimeSeconds: number;
    }
  | {
      readonly event: "worker_runtime_deadline_forced";
      readonly elapsedMs: number;
      readonly maxRuntimeSeconds: number;
    };

export interface RuntimeBoundInput {
  /** T0 — captured before the dynamic imports, never inside the loop. */
  readonly startedAtMs: number;
  readonly maxRuntimeSeconds: number;
  /**
   * What one claim can still need, in ms. Computed ONCE by
   * `claimBudgetMs` in `execution-mode.ts` and passed in, so this module
   * holds no second copy of the rule — and stays free of imports, which is
   * what lets the entrypoint load it statically without touching the
   * disabled path.
   */
  readonly requiredMsForNewClaim: number;
  readonly graceMs: number;
  readonly now: () => number;
  readonly timers?: RuntimeTimers;
  /** Cooperative wind-down. Must be the existing stop, not a new one. */
  readonly onGrace: () => void;
  /** Last resort at the absolute deadline. Must terminate the process. */
  readonly onForced: () => void;
  readonly onEvent: (e: RuntimeBoundEvent) => void;
}

export interface RuntimeBound {
  readonly startedAtMs: number;
  readonly deadlineMs: number;
  readonly graceAtMs: number;
  readonly requiredMsForNewClaim: number;
  remainingMs(): number;
  /** True while a full provider call plus the wind-down still fits. */
  allowsNewClaim(): boolean;
  /** Idempotent; releases every timer this bound armed. */
  dispose(): void;
  /** Test-visible leak check: 0 once disposed or once both have fired. */
  armedTimerCount(): number;
}

export function startRuntimeBound(input: RuntimeBoundInput): RuntimeBound {
  const timers = input.timers ?? unrefTimers;
  const startedAtMs = input.startedAtMs;
  const deadlineMs = startedAtMs + input.maxRuntimeSeconds * 1000;
  const graceAtMs = deadlineMs - input.graceMs;
  const requiredMsForNewClaim = input.requiredMsForNewClaim;

  let graceTimer: RuntimeTimerHandle | null = null;
  let forcedTimer: RuntimeTimerHandle | null = null;
  // Each of the three facts is reported at most once. A budget check runs
  // on every pass of the loop; without this the exhausted line would be
  // printed as fast as the loop can spin.
  let exhaustedReported = false;
  let graceFired = false;
  let forcedFired = false;

  const clearGrace = (): void => {
    if (graceTimer !== null) {
      timers.clear(graceTimer);
      graceTimer = null;
    }
  };
  const clearForced = (): void => {
    if (forcedTimer !== null) {
      timers.clear(forcedTimer);
      forcedTimer = null;
    }
  };

  // Armed in this order on purpose: when graceMs is 0 both deadlines land
  // on the same millisecond, and the cooperative stop must be the one that
  // is offered first.
  graceTimer = timers.set(() => {
    graceTimer = null;
    if (graceFired) return;
    graceFired = true;
    // try/finally, not a plain sequence: the wind-down must happen even if
    // the logger throws. An event line is worth reporting; it is not worth
    // silently skipping the stop it was announcing.
    try {
      input.onEvent({
        event: "worker_runtime_deadline_grace",
        elapsedMs: input.now() - startedAtMs,
        graceMs: input.graceMs,
        maxRuntimeSeconds: input.maxRuntimeSeconds,
      });
    } finally {
      input.onGrace();
    }
  }, Math.max(0, graceAtMs - input.now()));

  forcedTimer = timers.set(() => {
    forcedTimer = null;
    if (forcedFired) return;
    forcedFired = true;
    // The grace timer is released first: if the process is about to be cut
    // off, a cooperative stop scheduled behind it has nothing left to do.
    clearGrace();
    // Same reasoning, and it matters more here: a logger that throws must
    // not be what keeps a process alive past its absolute deadline.
    try {
      input.onEvent({
        event: "worker_runtime_deadline_forced",
        elapsedMs: input.now() - startedAtMs,
        maxRuntimeSeconds: input.maxRuntimeSeconds,
      });
    } finally {
      input.onForced();
    }
  }, Math.max(0, deadlineMs - input.now()));

  return {
    startedAtMs,
    deadlineMs,
    graceAtMs,
    requiredMsForNewClaim,
    remainingMs(): number {
      return deadlineMs - input.now();
    },
    allowsNewClaim(): boolean {
      const remaining = deadlineMs - input.now();
      if (remaining >= requiredMsForNewClaim) return true;
      if (!exhaustedReported) {
        exhaustedReported = true;
        input.onEvent({
          event: "worker_runtime_budget_exhausted",
          remainingMs: remaining,
          requiredMs: requiredMsForNewClaim,
          maxRuntimeSeconds: input.maxRuntimeSeconds,
        });
      }
      return false;
    },
    dispose(): void {
      clearGrace();
      clearForced();
    },
    armedTimerCount(): number {
      return (graceTimer !== null ? 1 : 0) + (forcedTimer !== null ? 1 : 0);
    },
  };
}

/**
 * The cooperative stop, extracted from the entrypoint so its idempotence
 * can be exercised rather than described.
 *
 * The mechanism is unchanged: the first request flips the abort flag the
 * loop reads, announces itself once, and arms a single timer that aborts
 * in-flight provider calls after the grace budget — capped one millisecond
 * below the lease, because aborting after a lease we can no longer renew
 * would be aborting into someone else's claim.
 *
 * Every entry point now goes through here: SIGINT, SIGTERM and the runtime
 * grace deadline. Whichever arrives first wins; the others are no-ops. The
 * loop therefore cannot observe two shutdowns, and the abort timer cannot
 * be armed twice.
 */
export interface CooperativeStopInput {
  readonly graceMs: number;
  readonly leaseSeconds: number;
  /** The flag the worker loop polls. Mutated in place, as before. */
  readonly signal: { aborted: boolean };
  /** Aborts in-flight provider calls once the grace budget is spent. */
  readonly abort: () => void;
  readonly timers?: RuntimeTimers;
  readonly onRequested: (reason: string) => void;
}

export interface CooperativeStop {
  /** Idempotent: only the first call has any effect. */
  request(reason: string): void;
  readonly requested: boolean;
  dispose(): void;
  armedTimerCount(): number;
}

/**
 * The live bootstrap sequence — the ORDER, as a function rather than as a
 * shape the entrypoint happens to have.
 *
 * It owns three things that were previously only readable in the
 * entrypoint's indentation, and each of them is a guarantee that has to
 * hold on the exception path as much as on the ordinary one:
 *
 *   1. THE SIGNAL HANDLERS. Installed first, inside the caller's try, and
 *      removed in this function's finally with the EXACT references that
 *      were installed. Only what was actually installed is removed, so a
 *      failure part-way through installation can neither leave a listener
 *      behind nor throw while tearing one down. They are removed BEFORE
 *      the caller disposes the cooperative stop, so a late signal can no
 *      longer arm a timer after everything has been released.
 *
 *   2. THE HEALTH SERVER. `run` adopts it the moment it is bound, and it
 *      is closed exactly once — on success, when the loop throws, and when
 *      anything after the listen throws. Never when it was never adopted.
 *      The close is awaited, because the API is asynchronous, and a
 *      failure to close is reported under a closed label rather than
 *      replacing the error the loop was already raising.
 *
 *   3. THE ABANDON CHECK. Initialisation reads the stop flag after its one
 *      await. If the grace window opened while the modules were loading,
 *      nothing is built: no client, no server, no worker, no claim. A
 *      late-resolving import must not start a run that was already winding
 *      down.
 *
 * The ceiling is deliberately NOT disposed here. It belongs to the
 * caller's own finally, after this function returns or throws, so the
 * absolute deadline still covers the server close and the handler removal
 * — the cleanup is exactly where a stuck run tends to end up.
 */
export interface SignalHost {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}

/** One installable handler: the event name and the exact callback. */
export type SignalHandler = readonly [event: string, listener: () => void];

export interface LiveBootstrapInput<M, S> {
  /** The flag the cooperative stop sets; read after initialisation. */
  readonly signal: { readonly aborted: boolean };
  readonly host: SignalHost;
  readonly handlers: readonly SignalHandler[];
  /** The one awaited initialisation step: the dynamic module graph. */
  readonly load: () => Promise<M>;
  /**
   * Everything that may construct a client, bind a port or claim a job.
   * Calls `adopt` immediately after the health surface is bound, which is
   * what makes "closed exactly once, on every path" possible.
   */
  readonly run: (modules: M, adopt: (server: S) => void) => Promise<void>;
  readonly closeServer: (server: S) => Promise<void> | void;
  readonly onAbandoned: (stage: string) => void;
  /** Closed label only — never a message, a path or a value. */
  readonly onCloseFailed: (detail: string) => void;
}

export async function runLiveBootstrap<M, S>(input: LiveBootstrapInput<M, S>): Promise<void> {
  const installed: SignalHandler[] = [];
  try {
    for (const handler of input.handlers) {
      input.host.on(handler[0], handler[1]);
      installed.push(handler);
    }

    const modules = await input.load();
    if (input.signal.aborted) {
      input.onAbandoned("modules");
      return;
    }

    let server: S | null = null;
    try {
      await input.run(modules, (s) => { server = s; });
    } finally {
      // Read through a local alias: TypeScript narrows `server` to `null`
      // from the initialiser and cannot see the assignment made inside the
      // callback above.
      const adopted = server as S | null;
      if (adopted !== null) {
        try {
          await input.closeServer(adopted);
        } catch (e) {
          // Reported, never rethrown: a failure to close must not replace
          // the error the loop was already raising.
          input.onCloseFailed(e instanceof Error ? e.name : "unknown");
        }
      }
    }
  } finally {
    for (const handler of installed) input.host.off(handler[0], handler[1]);
  }
}

export function createCooperativeStop(input: CooperativeStopInput): CooperativeStop {
  const timers = input.timers ?? unrefTimers;
  let abortTimer: RuntimeTimerHandle | null = null;
  let requested = false;

  return {
    get requested(): boolean {
      return requested;
    },
    request(reason: string): void {
      // Two guards, not one. `signal.aborted` may already be true because
      // the loop set it, and `requested` protects the timer even if a
      // caller resets the flag.
      if (requested || input.signal.aborted) {
        requested = true;
        return;
      }
      requested = true;
      input.signal.aborted = true;
      input.onRequested(reason);
      abortTimer = timers.set(() => {
        abortTimer = null;
        input.abort();
      }, Math.min(input.graceMs, input.leaseSeconds * 1000 - 1));
    },
    dispose(): void {
      if (abortTimer !== null) {
        timers.clear(abortTimer);
        abortTimer = null;
      }
    },
    armedTimerCount(): number {
      return abortTimer !== null ? 1 : 0;
    },
  };
}
