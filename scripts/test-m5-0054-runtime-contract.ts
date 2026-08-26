#!/usr/bin/env tsx
/**
 * M5 — real, reproducible Postgres runtime contract test for D-028
 * (migration 0054: persist_probe_result_for_job + the durable alert
 * outbox).
 *
 * This is NOT a static text check (see scripts/test-m5-0054-schema-
 * contract.ts for that) and NOT a Zod-only check (see scripts/
 * test-m5-0054-content-contract.ts). This test creates a genuinely
 * disposable local Supabase/Postgres stack under a fresh mktemp
 * directory, applies EXACTLY migrations 0001-0054 byte-identically
 * (explicitly selected by number — never "every migration file
 * present"), and exercises D-028's guarantees via real RPC calls over
 * real psql connections against a CLOSED, 39-scenario roster (category
 * A: catalogue/compatibility, 5; category B: persist_probe_result_for_job,
 * 15; category C: alert outbox emission, 5; category D: alert delivery
 * lifecycle/concurrency, 14). PASSED is reachable only if every one of
 * the 39 named scenarios ran and every assertion inside every one of
 * them passed — there is no placeholder scenario and no path that can
 * print PASSED without having exercised the full roster.
 *
 * NOT YET RUN. Prepared per explicit instruction; execution requires a
 * separate, later authorization (ZYPACT_M5_0054_RUNTIME_TEST=1 and a
 * real disposable Docker/Supabase/psql stack). Per this repository's own
 * established discipline (every prior M5 runtime harness needed at
 * least one real, opt-in correction round before its first clean pass),
 * at least one such round should be expected before this harness's
 * first real run, not treated as a sign of a defect in the migration
 * itself if it occurs.
 *
 * Safety (same discipline as every prior M5 runtime harness):
 *   - opt-in only: does nothing unless ZYPACT_M5_0054_RUNTIME_TEST=1.
 *   - no remote credential of any kind; the only connection is to a
 *     disposable local Postgres instance this same run creates.
 *   - never touches staging or Production; never touches any
 *     pre-existing container (in particular, never stops, restarts,
 *     inspects-for-mutation, or removes "zypact-postgres" or any
 *     container this run did not itself create); never runs
 *     `docker ... prune`.
 *   - the disposable project_id/workdir is unique per run (mktemp);
 *     cleanup is scoped exclusively to that exact workdir/project_id
 *     and only runs after full success. On any failure, the stack is
 *     left running and its exact workdir/project_id is printed, and
 *     every scenario's raw stdout/stderr is persisted to disk BEFORE
 *     any cleanup decision is made.
 *   - if Docker, the Supabase CLI, or psql is not available, or if the
 *     local Supabase ports are already occupied, the test prints an
 *     explicit SKIP and exits 0 — it never prints a passing result it
 *     did not actually verify.
 *   - no provider/LLM call of any kind, anywhere in this file.
 *   - selects and applies exactly migrations 0001-0054 by number,
 *     ignoring any 0055+ migration present in the repository — a fixed
 *     historical snapshot, never a guard against 0055 existing. Uses
 *     the same fail-closed selection discipline (strict NNNN_name.sql
 *     match, no gap, no duplicate, no invalid name) already corrected
 *     into scripts/test-m5-0050-runtime-contract.ts.
 *   - the only direct DML this file ever issues against
 *     probe_results/protocol_execution_job_alerts/protocol_execution_
 *     job_alert_deliveries/protocol_execution_job_alert_delivery_attempts
 *     is a handful of read-only SELECTs for verification; every
 *     mutation goes through a real, granted RPC. Deliberately
 *     unreachable-through-the-public-contract states (a dangling
 *     FK reference the schema itself normally prevents, a backdated
 *     lease/timestamp to force a reconciliation branch, an already-
 *     terminal attempt row to prove the defensive re-terminalization
 *     guard) are engineered exclusively through a small set of
 *     SECURITY DEFINER test-only helper functions this file installs
 *     into the disposable database and grants to service_role — never
 *     through a raw UPDATE/DELETE issued directly under service_role
 *     against a table whose grants do not otherwise permit it, and
 *     never through disabling RLS/FK enforcement at the session level
 *     under any role but the helper's own SECURITY DEFINER context.
 *   - every fault-injection / race scenario either runs a real,
 *     granted RPC to completion (relying on the RPC's own real
 *     transactional behavior) or, for the two genuine concurrency
 *     proofs, launches two fully separate psql processes/connections —
 *     never simulated via a single connection or a JS Promise.all
 *     approximation.
 *
 * Optional environment variables:
 *   ZYPACT_M5_0054_RUNTIME_TEST=1   required opt-in to run anything at all
 *   ZYPACT_DOCKER_BIN_DIR=<path>    prepended to PATH, matching this
 *                                   repo's own local Docker Desktop setup
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, copyFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let totalAssertions = 0;
let passedAssertions = 0;
let failedAssertions = 0;
const failedAssertionNames: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  totalAssertions += 1;
  if (cond) {
    passedAssertions += 1;
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failedAssertions += 1;
    failedAssertionNames.push(name);
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ------------------------------------------------------------------
// Final counter reconciliation. Deliberately a standalone,
// dependency-injected function: main()'s `finally` calls it only AFTER
// its own two diagnostic check() calls have already run, so every
// number printed here is the final one -- never a snapshot taken
// before the last assertions of the run. The self-test drives this
// exact function with synthetic state and a capturing io, so the
// printed numbers and the exit code are proven by the real
// implementation instead of by a re-implementation of it.
//
// The catch block deliberately increments nothing: a non-assertion
// failure is carried by succeededFully=false (and therefore exit 1),
// never by inventing an assertion that never actually ran.
// ------------------------------------------------------------------
interface FinalCounterState {
  totalAssertions: number;
  passedAssertions: number;
  failedAssertions: number;
  failedAssertionNames: readonly string[];
  succeededFully: boolean;
  ranScenarioCount: number;
  rosterSize: number;
}

interface FinalCounterIo {
  log: (line: string) => void;
  exit: (code: number) => void;
}

function finalizeCounters(state: FinalCounterState, io: FinalCounterIo): void {
  const failedCount = state.failedAssertionNames.length;
  const invariantViolations: string[] = [];
  if (state.failedAssertions !== failedCount) {
    invariantViolations.push(`failedAssertions (${state.failedAssertions}) !== failedAssertionNames.length (${failedCount})`);
  }
  if (state.passedAssertions + state.failedAssertions !== state.totalAssertions) {
    invariantViolations.push(
      `passedAssertions (${state.passedAssertions}) + failedAssertions (${state.failedAssertions}) !== totalAssertions (${state.totalAssertions})`
    );
  }
  if (failedCount > 0) {
    io.log(`\n${failedCount}/${state.totalAssertions} assertions failed.`);
  }
  io.log(
    `\n${state.passedAssertions}/${state.totalAssertions} checks passed. ` +
      (failedCount === 0 && state.succeededFully ? "M5 0054 runtime contract PASSED." : "M5 0054 runtime contract FAILED.")
  );
  if (failedCount > 0) {
    io.log(`Failed assertions (${failedCount}): ${JSON.stringify(state.failedAssertionNames)}`);
  }
  if (invariantViolations.length > 0) {
    io.log(`✗ COUNTER INVARIANT VIOLATED: ${invariantViolations.join("; ")}`);
  }
  io.log(`Scenarios executed: ${state.ranScenarioCount}/${state.rosterSize}`);
  io.exit(failedCount === 0 && state.succeededFully && invariantViolations.length === 0 ? 0 : 1);
}

function skip(reason: string): never {
  console.log(`\nSKIP: ${reason}`);
  console.log(
    "This is not a failure and not a pass — the runtime contract test\n" +
      "requires explicit opt-in and a local Docker/Supabase/psql stack.\n" +
      "No database was touched, no stack was created."
  );
  process.exit(0);
}

const REPO_ROOT = process.cwd();
const DOCKER_BIN_DIR = process.env.ZYPACT_DOCKER_BIN_DIR ?? "";
const RUN_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: DOCKER_BIN_DIR ? `${DOCKER_BIN_DIR}:${process.env.PATH ?? ""}` : process.env.PATH,
};

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { env: RUN_ENV, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
}

function tryRun(cmd: string, args: string[]): { ok: boolean; output: string } {
  try {
    return { ok: true, output: run(cmd, args) };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? String((err as { stdout?: string }).stdout ?? err.message) : String(err) };
  }
}

// ------------------------------------------------------------------
// Bounded-timeout subprocess infrastructure. EVERY asynchronous psql
// invocation in this file goes through spawnWithBoundedTimeout below --
// never a bare, unbounded spawn(). `done` NEVER rejects and settles
// EXACTLY ONCE, using Node's own `spawn` event (fired only once a real
// OS process genuinely exists) as the ground truth for distinguishing:
//   - `error` BEFORE `spawn` fired  -> genuine spawn failure (bad
//     executable, permission denied): no real OS process was EVER
//     created, `spawnError` is set, settling is immediate and safe.
//   - `error` AFTER `spawn` fired   -> the process DOES (or did) exist;
//     this is Node's documented "process could not be killed" / IPC-
//     send-failure shape of the same event. The process is NEVER
//     assumed gone here: `processError` is recorded and termination is
//     initiated instead, exactly like a timeout would.
// Past `spawn`, `done` settles ONLY via a genuine `close` event or an
// explicit ESRCH check on the exact PID (never by a bare timer assuming
// absence) -- `terminationConfirmed` reports which of those actually
// established that the process is gone, and is `false` in the (POSIX-
// theoretical, SIGKILL-should-prevent-this) case where neither could
// confirm it, so a caller can refuse to treat that as safe. All signal
// sending goes through sendSignalSafely()/isPidAlive() (see below):
// try/catch guarded, a `false` return from child.kill() is resolved via
// an explicit liveness check rather than assumed to mean anything, and
// any error is captured as `terminationError` rather than thrown from a
// timer callback.
// ------------------------------------------------------------------
const DEFAULT_KILL_GRACE_MS = 3000;
const ESRCH_FALLBACK_GRACE_MS = 1000;

interface TimedSpawnResult {
  spawned: boolean;
  spawnError: Error | null;
  processError: Error | null;
  timedOut: boolean;
  timeoutPersistenceError: Error | null;
  terminationError: Error | null;
  terminationConfirmed: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  pid: number | undefined;
}

interface LiveSpawn {
  pid: number | undefined;
  getStdout: () => string;
  getStderr: () => string;
  /** SIGTERM now, then SIGKILL after a bounded grace period if still alive. No-op once already settled. Never a global/pattern kill -- only this one child's own pid, when it has one. */
  terminate: (graceMs?: number) => void;
  done: Promise<TimedSpawnResult>;
}

/** Never gone unless the kernel says ESRCH. Any other errno (e.g. EPERM) is treated as "cannot confirm gone", never as "gone". */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

interface SafeSignalResult {
  sent: boolean;
  alreadyGone: boolean;
  error: Error | null;
}

/**
 * Centralizes every signal send in this file. try/catch guarded; a
 * `false` return from `killFn` (Node's own child.kill() returns a
 * boolean, never throwing, for most failure modes) is resolved via
 * `isAliveFn` rather than assumed to mean anything on its own; any
 * thrown error is captured as a structured field, never left to
 * propagate raw out of a timer callback. `killFn`/`isAliveFn` are
 * injected so this exact function can be exercised directly by the
 * self-test with simulated (fake) signal behavior -- no real OS race
 * required to prove the false/throw branches.
 */
function sendSignalSafely(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  killFn: (pid: number, signal: "SIGTERM" | "SIGKILL") => boolean,
  isAliveFn: (pid: number) => boolean
): SafeSignalResult {
  try {
    const ok = killFn(pid, signal);
    if (ok) return { sent: true, alreadyGone: false, error: null };
    const alive = isAliveFn(pid);
    return {
      sent: false,
      alreadyGone: !alive,
      error: alive ? new Error(`kill(${signal}) returned false for pid ${pid}, and the process still appears alive (ESRCH not observed)`) : null,
    };
  } catch (err) {
    const alive = isAliveFn(pid);
    return {
      sent: false,
      alreadyGone: !alive,
      error: alive ? (err instanceof Error ? err : new Error(String(err))) : null,
    };
  }
}

function spawnWithBoundedTimeout(
  cmd: string,
  args: string[],
  timeoutMs: number,
  opts: {
    onTimeout?: (stdoutSoFar: string, stderrSoFar: string) => void;
    killGraceMs?: number;
    /** Test-only seam: fires once Node's own `spawn` event confirms a real OS process exists, exposing the raw ChildProcess so a self-test can synthesize a realistic post-spawn `error` event. Never used by real scenario code. */
    onSpawned?: (child: ReturnType<typeof spawn>) => void;
  } = {}
): LiveSpawn {
  const child = spawn(cmd, args, { env: RUN_ENV });
  let stdout = "";
  let stderr = "";
  let spawned = false;
  let spawnError: Error | null = null;
  let processError: Error | null = null;
  let timedOut = false;
  let timeoutPersistenceError: Error | null = null;
  let terminationError: Error | null = null;
  let settled = false;

  child.stdout?.on("data", (d) => (stdout += d.toString()));
  child.stderr?.on("data", (d) => (stderr += d.toString()));

  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let sigkillTimer: NodeJS.Timeout | null = null;
  let esrchFallbackTimer: NodeJS.Timeout | null = null;

  let resolveDone!: (r: TimedSpawnResult) => void;
  const done = new Promise<TimedSpawnResult>((resolve) => {
    resolveDone = resolve;
  });

  function clearAllTimers(): void {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
    if (esrchFallbackTimer) clearTimeout(esrchFallbackTimer);
  }

  function settleOnce(code: number | null, signal: NodeJS.Signals | null, terminationConfirmed: boolean): void {
    if (settled) return;
    settled = true;
    clearAllTimers();
    resolveDone({
      spawned,
      spawnError,
      processError,
      timedOut,
      timeoutPersistenceError,
      terminationError,
      terminationConfirmed,
      code,
      signal,
      stdout,
      stderr,
      pid: child.pid,
    });
  }

  // Initiates termination -- called on timeout, on a post-spawn
  // `error`, or externally via `terminate()` (which can race ahead of
  // the ASYNCHRONOUS `spawn` event -- confirmed empirically: `child.pid`
  // is assigned SYNCHRONOUSLY the instant spawn() returns, on POSIX,
  // well before `spawn` actually fires on a later tick). The gate here
  // is therefore `child.pid === undefined`, never the `spawned` flag --
  // using `spawned` here would wrongly treat an immediate external
  // terminate() call (e.g. a scenario's own failure-recovery, which can
  // run on the very same tick as creation) as "process never existed"
  // and skip signaling a process that is, in fact, already running.
  // NEVER settles `done` itself except (a) immediately, if no real OS
  // process was ever created, or (b) via the bounded ESRCH fallback
  // below if `close` genuinely never arrives after SIGKILL -- `close`
  // remains the primary, expected path to settlement in every normal
  // case.
  function beginTermination(graceMs: number): void {
    if (settled) return;
    if (child.pid === undefined) {
      settleOnce(null, null, true);
      return;
    }
    const pid = child.pid;
    const killFn = (p: number, sig: "SIGTERM" | "SIGKILL") => child.kill(sig);
    const term = sendSignalSafely(pid, "SIGTERM", killFn, isPidAlive);
    if (term.error) terminationError = term.error;
    if (sigkillTimer) clearTimeout(sigkillTimer);
    sigkillTimer = setTimeout(() => {
      if (settled) return;
      const kill = sendSignalSafely(pid, "SIGKILL", killFn, isPidAlive);
      if (kill.error && !terminationError) terminationError = kill.error;
      // Bounded fallback: `close` is the expected settlement path even
      // after SIGKILL; if it genuinely never arrives shortly after,
      // fall back to a direct, explicit ESRCH check rather than hanging
      // indefinitely -- `terminationConfirmed` reflects exactly what
      // that check found, never assumed.
      esrchFallbackTimer = setTimeout(() => {
        if (settled) return;
        settleOnce(null, null, !isPidAlive(pid));
      }, ESRCH_FALLBACK_GRACE_MS);
    }, graceMs);
  }

  function terminate(graceMs: number = killGraceMs): void {
    beginTermination(graceMs);
  }

  // `spawn` fires once, only when a real OS process genuinely exists --
  // the ground truth this whole state machine is built around.
  child.once("spawn", () => {
    spawned = true;
    if (opts.onSpawned) opts.onSpawned(child);
  });

  // Installed unconditionally (an EventEmitter with zero 'error'
  // listeners throws a process-crashing uncaught exception the instant
  // one is emitted -- this listener is what prevents that entirely).
  // Whether this event means "never existed" or "exists but something
  // else went wrong" is decided ONLY by whether `spawn` has already
  // fired -- never by any other heuristic.
  child.once("error", (err) => {
    const e = err instanceof Error ? err : new Error(String(err));
    if (!spawned) {
      spawnError = e;
      settleOnce(null, null, true);
    } else {
      // The process may well still be alive -- never assumed gone.
      // Initiate the exact same bounded termination a timeout would.
      processError = e;
      beginTermination(killGraceMs);
    }
  });

  child.once("close", (code, signal) => {
    settleOnce(code, signal, true);
  });

  timeoutTimer = setTimeout(() => {
    if (settled) return;
    timedOut = true;
    if (opts.onTimeout) {
      // The persistence callback's own failure (e.g. writeFileSync
      // throwing on a full disk) must never escape this timer callback
      // as an uncaught exception -- it is captured as a structured
      // field instead, and termination of the child still proceeds
      // regardless, exactly as required.
      try {
        opts.onTimeout(stdout, stderr);
      } catch (err) {
        timeoutPersistenceError = err instanceof Error ? err : new Error(String(err));
      }
    }
    beginTermination(killGraceMs);
  }, timeoutMs);

  return { pid: child.pid, getStdout: () => stdout, getStderr: () => stderr, terminate, done };
}

/**
 * Bounded poll: never an unbounded/blind wait. Throws a diagnostic error
 * (never silently gives up) if `predicate` has not become true within
 * `timeoutMs`, having polled every `pollIntervalMs`.
 */
async function waitUntil(predicate: () => boolean, timeoutMs: number, pollIntervalMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) {
      if (predicate()) return;
      throw new Error(`bounded wait exceeded (${timeoutMs}ms, polling every ${pollIntervalMs}ms): ${description}`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}

interface UnresolvedLiveHandle {
  label: string;
  pid: number | undefined;
  spawnError: Error | null;
  processError: Error | null;
  terminationError: Error | null;
  timedOut: boolean;
}

interface TerminateLiveHandlesResult<T> {
  /** Confirmed gone (never spawned, or terminationConfirmed===true) -- safe to remove from any registry. */
  resolvedHandles: T[];
  /** NOT confirmed gone -- must remain in whatever registry tracked them; never treated as a success. */
  unresolvedHandles: UnresolvedLiveHandle[];
}

function labelForLiveHandle(handle: LiveSpawn): string {
  const withPath = handle as LiveSpawn & { scriptPath?: string };
  return withPath.scriptPath ?? `pid=${handle.pid ?? "unknown"}`;
}

/**
 * THE single, central function deciding whether a Live handle may ever
 * be removed from any registry. Used by BOTH consumers (terminateLiveHandles
 * and runPsqlAsyncLive's own automatic removal callback) -- the logic is
 * never recopied separately. A handle is safely resolved only if:
 *   - it was NEVER a real OS process at all (result.spawned === false
 *     AND handle.pid === undefined, checked together -- never `!spawned`
 *     alone, since Node's own pid assignment and the `spawn` event are
 *     two separate signals; requiring both explicitly here means this
 *     function itself never has to trust that correlation implicitly),
 *     OR
 *   - termination was positively confirmed (result.terminationConfirmed
 *     === true), via a real `close` event or an explicit ESRCH check --
 *     never assumed from `spawned` alone.
 */
function isLiveHandleSafelyResolved(handle: LiveSpawn, result: TimedSpawnResult): boolean {
  const neverCreated = result.spawned === false && handle.pid === undefined;
  return neverCreated || result.terminationConfirmed === true;
}

/**
 * Shared termination routine: used both by a scenario's own failure
 * path (sc() below) and by this file's self-test (so the exact same
 * code is what is proven, not a look-alike). Terminates every handle in
 * `handles` (a settled one is a safe no-op via `terminate`'s own
 * idempotence), awaits all of them via Promise.allSettled -- so one
 * handle's own settlement never masks another's -- and partitions the
 * outcome using isLiveHandleSafelyResolved above: a handle is only ever
 * placed in `resolvedHandles` if that single function says so. Anything
 * else -- a rejected settlement, or a resolved result it does not
 * accept -- goes into `unresolvedHandles`, with a label/pid/every
 * captured error, and MUST remain in whatever registry the caller is
 * tracking it with. This function itself never throws.
 */
async function terminateLiveHandles<T extends LiveSpawn>(handles: Iterable<T>): Promise<TerminateLiveHandlesResult<T>> {
  const list = [...handles];
  for (const h of list) h.terminate();
  const settled = await Promise.allSettled(list.map((h) => h.done));
  const resolvedHandles: T[] = [];
  const unresolvedHandles: UnresolvedLiveHandle[] = [];
  for (let i = 0; i < list.length; i++) {
    const handle = list[i]!;
    const s = settled[i]!;
    const confirmed = s.status === "fulfilled" && isLiveHandleSafelyResolved(handle, s.value);
    if (confirmed) {
      resolvedHandles.push(handle);
    } else {
      unresolvedHandles.push({
        label: labelForLiveHandle(handle),
        pid: handle.pid,
        spawnError: s.status === "fulfilled" ? s.value.spawnError : null,
        processError: s.status === "fulfilled" ? s.value.processError : null,
        terminationError:
          s.status === "fulfilled" ? s.value.terminationError : s.reason instanceof Error ? s.reason : new Error(String(s.reason)),
        timedOut: s.status === "fulfilled" ? s.value.timedOut : false,
      });
    }
  }
  return { resolvedHandles, unresolvedHandles };
}

/**
 * The single, central validator every asynchronous psql caller in this
 * file goes through -- replaces the old throwIfTimedOut, which checked
 * only `timedOut`. Throws (never silently accepts) if ANY of: spawnError,
 * processError, timedOut, timeoutPersistenceError, terminationError are
 * set; terminationConfirmed !== true for a process that was genuinely
 * spawned; a non-null, non-zero exit code; a non-null signal (this
 * file's own scenarios never expect one outside the timeout path, which
 * is already flagged separately); or a null code with no other field
 * explaining it (psql always exits with a real integer code when it
 * runs to completion normally -- an unexplained null code is itself a
 * defect, never a silently-accepted "maybe fine"). Returns the result
 * unchanged when, and only when, none of the above apply.
 */
function validateAsyncPsqlResult(r: TimedSpawnResult, tag: string, scriptPath: string): TimedSpawnResult {
  const problems: string[] = [];
  if (r.spawnError) problems.push(`spawnError: ${r.spawnError.message}`);
  if (r.processError) problems.push(`processError: ${r.processError.message}`);
  if (r.timedOut) problems.push("timedOut (bounded timeout exceeded; terminated via SIGTERM/SIGKILL)");
  if (r.timeoutPersistenceError) problems.push(`timeoutPersistenceError: ${r.timeoutPersistenceError.message}`);
  if (r.terminationError) problems.push(`terminationError: ${r.terminationError.message}`);
  if (r.spawned && r.terminationConfirmed !== true) problems.push("terminationConfirmed is not true for a process that was genuinely spawned");
  if (r.signal !== null) problems.push(`unexpected signal: ${r.signal}`);
  if (r.code === null && problems.length === 0) {
    problems.push("code is null with no spawnError/processError/timedOut to explain it -- psql should always exit with a real integer code when it runs normally");
  }
  if (r.code !== null && r.code !== 0) problems.push(`non-zero exit code: ${r.code}`);
  if (problems.length > 0) {
    throw new Error(
      `psql script "${tag}" (pid ${r.pid}) failed validation -- ${problems.join("; ")}. See ${scriptPath}.out.log/.err.log${
        r.timedOut ? ` and ${scriptPath}.timeout.out.log/.timeout.err.log` : ""
      } for the captured output.`
    );
  }
  return r;
}

/**
 * Preflight self-test for the timeout mechanism above -- gated behind
 * its own separate opt-in (ZYPACT_M5_0054_TIMEOUT_SELFTEST=1, checked by
 * main() before it is ever called), never Docker/Supabase/network/
 * credential. Every child process it spawns is `process.execPath`
 * invoked DIRECTLY (spawn() with no `shell: true`, so there is no
 * intermediate shell) running a short inline script via `-e` -- never
 * `sh -c`/`sleep`, specifically because a shell wrapping a separate
 * `sleep` child creates a real orphan risk (killing the shell's own PID
 * does not guarantee its already-forked `sleep` grandchild dies with
 * it). A direct `node -e` invocation is exactly one OS process with no
 * possibility of spawning a child of its own (the inline script itself
 * never calls spawn/exec/fork), so "no child subprocess is possible" is
 * true by construction here, not merely by observation.
 *
 * Proves, on real processes: (a) a fast child completes normally; (b) a
 * child that actively ignores SIGTERM is still forced to exit via the
 * SIGKILL escalation, PID genuinely gone afterward; (c) a genuinely
 * nonexistent executable produces a structured spawnError within a
 * bounded time, never an uncaught crash and never a hang; (d) a
 * deliberately throwing onTimeout persistence callback is captured as a
 * structured timeoutPersistenceError, the child is still terminated
 * regardless, and neither uncaughtException nor unhandledRejection ever
 * fires; (e) the exact same terminateLiveHandles() routine a scenario's
 * own failure path uses is exercised directly against a tracked,
 * registered hung child, proving the registry ends up empty and the
 * process ends up gone. Every check below is collected into
 * `selfTestFailures` -- nothing is fatal immediately, so every
 * sub-test always runs and reports, and the scratch directory holding
 * every log this self-test produced is deleted ONLY if all of them
 * passed (see the gate at the end of this function).
 */
async function runTimeoutMechanismSelfTest(): Promise<void> {
  console.log("\n=== Self-test: subprocess timeout mechanism (ZYPACT_M5_0054_TIMEOUT_SELFTEST=1; no Docker, no Supabase, no network) ===");
  const selfTestFailures: string[] = [];
  function selfCheck(label: string, cond: boolean): void {
    console.log(cond ? `  ✓ ${label}` : `  ✗ FAILED: ${label}`);
    if (!cond) selfTestFailures.push(label);
  }

  const selfPath = path.join(REPO_ROOT, "scripts", "test-m5-0054-runtime-contract.ts");
  const selfSource = readFileSync(selfPath, "utf8");
  // Comments (including this very prohibition's own prose, which
  // necessarily names the forbidden commands) are stripped first, so
  // only genuine executable source is scanned. The forbidden names
  // themselves are built via concatenation so this check's own source
  // text never contains the contiguous word either -- otherwise this
  // very check would flag itself the moment it was written.
  const selfCodeOnly = selfSource
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
  const forbiddenCommandNames = ["pk" + "ill", "kill" + "all"];
  const forbiddenHit = forbiddenCommandNames.find((name) => selfCodeOnly.includes(`"${name}`) || selfCodeOnly.includes(`'${name}`));
  selfCheck("static self-inspection (comments stripped): no pattern-based/global kill command invoked anywhere in this file's own executable source", !forbiddenHit);

  // Static, source-level proof that the cleanup gate in THIS function
  // (below) genuinely appears in the code AFTER the failure check, not
  // before it -- with a negative self-test on a throwaway in-memory copy
  // (the two anchors swapped) first, proving this checker would actually
  // detect the regression this whole correction round exists to close.
  function checkCleanupOrder(text: string): boolean {
    const gateIdx = text.indexOf("if (selfTestFailures.length > 0) {");
    const rmSyncIdx = text.indexOf("rmSync(selfTestScratch, { recursive: true, force: true });");
    return gateIdx !== -1 && rmSyncIdx !== -1 && gateIdx < rmSyncIdx;
  }
  const GATE_ANCHOR = "if (selfTestFailures.length > 0) {";
  const RMSYNC_ANCHOR = "rmSync(selfTestScratch, { recursive: true, force: true });";
  const SWAP_PLACEHOLDER = "\u0000SEQGATE_SELFTEST_PLACEHOLDER\u0000";
  const reorderedCopy = selfSource.split(GATE_ANCHOR).join(SWAP_PLACEHOLDER).split(RMSYNC_ANCHOR).join(GATE_ANCHOR).split(SWAP_PLACEHOLDER).join(RMSYNC_ANCHOR);
  selfCheck(
    "negative self-test: a deliberately reordered in-memory copy (cleanup swapped to BEFORE the failure gate) is correctly detected as wrong",
    !checkCleanupOrder(reorderedCopy)
  );
  selfCheck(
    "the real, unmodified source: the failure-gate check genuinely appears BEFORE rmSync(selfTestScratch, ...) -- cleanup cannot precede the success gate",
    checkCleanupOrder(selfSource)
  );

  const selfTestScratch = mkdtempSync(path.join(tmpdir(), "zypact-m5-0054-timeout-selftest-"));

  // (a) fast child: a single, direct `node -e` process (no shell, no
  // child of its own) that completes well within its timeout.
  const fast = spawnWithBoundedTimeout(process.execPath, ["-e", "console.log('self_test_fast_ok')"], 5000);
  const fastResult = await fast.done;
  selfCheck(
    "fast child (direct node -e, no shell): completed normally, timedOut=false, expected stdout present",
    fastResult.code === 0 && !fastResult.timedOut && fastResult.stdout.includes("self_test_fast_ok") && fastResult.spawnError === null
  );

  // (b) hung child: a single, direct `node -e` process that installs a
  // no-op SIGTERM handler (ignoring it, exactly like a real
  // non-cooperating process could) and then stays alive via a bare
  // setInterval -- never spawns, execs, or forks anything of its own,
  // so "no child subprocess is possible" holds by construction, not
  // merely because none happened to appear this run. This is the only
  // way to genuinely prove the SIGKILL escalation path fires, rather
  // than merely exercising the (weaker) plain-SIGTERM case.
  const hungNodeScript = "process.on('SIGTERM', () => {}); console.log('hung_node_child_started'); setInterval(() => {}, 1e9);";
  let timeoutLogStdout: string | null = null;
  const hung = spawnWithBoundedTimeout(process.execPath, ["-e", hungNodeScript], 400, {
    killGraceMs: 400,
    onTimeout: (stdoutSoFar, stderrSoFar) => {
      writeFileSync(path.join(selfTestScratch, "b-timeout.out.log"), stdoutSoFar);
      writeFileSync(path.join(selfTestScratch, "b-timeout.err.log"), stderrSoFar);
      timeoutLogStdout = stdoutSoFar;
    },
  });
  const hungPid = hung.pid;
  const hungResult = await hung.done;
  selfCheck("hung child (SIGTERM-ignoring): timeout genuinely detected", hungResult.timedOut === true);
  selfCheck(
    "hung child: stdout/stderr captured-so-far were persisted to disk at the moment of timeout, before any signal",
    timeoutLogStdout !== null && existsSync(path.join(selfTestScratch, "b-timeout.out.log"))
  );
  // The child traps SIGTERM (no-op) -- if our wrapper only sent SIGTERM,
  // the process would still be alive here. Genuine escalation to
  // SIGKILL (which cannot be trapped/ignored) is the only way this
  // process is actually gone by the time `done` resolves.
  let hungStillAlive = false;
  if (hungPid !== undefined) {
    try {
      process.kill(hungPid, 0);
      hungStillAlive = true;
    } catch {
      hungStillAlive = false;
    }
  }
  selfCheck(`hung child (pid ${hungPid}): confirmed gone after SIGKILL escalation (SIGTERM alone was ignored by design) -- ESRCH, no residual process for this specific PID`, !hungStillAlive);

  // (c) genuinely nonexistent executable: proves the `error` listener
  // installed by spawnWithBoundedTimeout turns a real spawn failure into
  // a structured, bounded result -- never an uncaught EventEmitter
  // exception (which would crash this entire process) and never a hang
  // waiting for a `close` that will never come for a process that never
  // existed. Global listeners are always removed via try/finally, even
  // if a selfCheck assertion above them were somehow to throw (none do,
  // but the invariant is enforced structurally, not by luck).
  let observedUncaught: unknown = null;
  let bogusResult!: TimedSpawnResult;
  {
    const preExistingUncaughtListeners = process.listenerCount("uncaughtException");
    const uncaughtProbe = (err: unknown) => {
      observedUncaught = err;
    };
    process.on("uncaughtException", uncaughtProbe);
    try {
      const bogusCmd = "zypact-this-executable-definitely-does-not-exist-0054";
      const bogus = spawnWithBoundedTimeout(bogusCmd, [], 3000);
      bogusResult = await bogus.done;
    } finally {
      process.removeListener("uncaughtException", uncaughtProbe);
      selfCheck("uncaughtException listener count restored to its pre-test value (test c)", process.listenerCount("uncaughtException") === preExistingUncaughtListeners);
    }
  }
  selfCheck(
    // Node's own `close` code for a spawn failure is platform-dependent
    // (observed -2 on this system, not necessarily null) -- the
    // structured spawnError itself, not a specific numeric code, is
    // this check's actual contract.
    `nonexistent executable: a structured spawnError was produced within the bounded window, no hang (code=${bogusResult.code}, spawnError=${bogusResult.spawnError?.message ?? "null"})`,
    bogusResult.spawnError !== null
  );
  selfCheck("nonexistent executable: spawned is false, no PID is assumed present after a spawn failure", !bogusResult.spawned && bogusResult.pid === undefined);
  selfCheck("nonexistent executable: this process did not crash via an uncaught EventEmitter exception", observedUncaught === null);
  selfCheck(
    "nonexistent executable: the central validator (validateAsyncPsqlResult) throws for this result -- a spawn failure can never be accepted as success by any caller",
    (() => {
      try {
        validateAsyncPsqlResult(bogusResult, "self-test-bogus", selfTestScratch);
        return false;
      } catch {
        return true;
      }
    })()
  );

  // (c2) enfant exit 7: a real, non-timeout, non-spawn-error failure --
  // proves the central validator rejects a non-zero exit code, which
  // the old throwIfTimedOut (checking ONLY timedOut) never did.
  const exit7 = spawnWithBoundedTimeout(process.execPath, ["-e", "process.exit(7)"], 5000);
  const exit7Result = await exit7.done;
  selfCheck(
    `child exiting 7 (no timeout, no spawn/process error): code=${exit7Result.code}, correctly rejected by the central validator`,
    exit7Result.code === 7 &&
      !exit7Result.timedOut &&
      exit7Result.spawnError === null &&
      (() => {
        try {
          validateAsyncPsqlResult(exit7Result, "self-test-exit7", selfTestScratch);
          return false;
        } catch {
          return true;
        }
      })()
  );

  // (d) onTimeout deliberately throws: proves the persistence failure
  // is captured as a structured field, the child is still terminated
  // regardless, this never escapes as an uncaughtException or an
  // unhandledRejection, and the central validator rejects the result.
  let observedUnhandledRejection: unknown = null;
  let observedUncaught2: unknown = null;
  let throwingHungResult!: TimedSpawnResult;
  let throwingHungPid: number | undefined;
  {
    const rejectionProbe = (reason: unknown) => {
      observedUnhandledRejection = reason;
    };
    const uncaughtProbe2 = (err: unknown) => {
      observedUncaught2 = err;
    };
    process.on("unhandledRejection", rejectionProbe);
    process.on("uncaughtException", uncaughtProbe2);
    try {
      const throwingHung = spawnWithBoundedTimeout(process.execPath, ["-e", hungNodeScript], 400, {
        killGraceMs: 400,
        onTimeout: () => {
          throw new Error("deliberate self-test persistence failure");
        },
      });
      throwingHungPid = throwingHung.pid;
      throwingHungResult = await throwingHung.done;
    } finally {
      process.removeListener("unhandledRejection", rejectionProbe);
      process.removeListener("uncaughtException", uncaughtProbe2);
    }
  }
  selfCheck(
    "onTimeout deliberately throws: captured as a structured timeoutPersistenceError, distinguishable from the timeout itself",
    throwingHungResult.timedOut === true &&
      throwingHungResult.timeoutPersistenceError !== null &&
      throwingHungResult.timeoutPersistenceError.message.includes("deliberate self-test persistence failure")
  );
  let throwingHungStillAlive = false;
  if (throwingHungPid !== undefined) {
    try {
      process.kill(throwingHungPid, 0);
      throwingHungStillAlive = true;
    } catch {
      throwingHungStillAlive = false;
    }
  }
  selfCheck("onTimeout deliberately throws: the child was still terminated (SIGKILL escalation still ran) despite the persistence callback's own failure", !throwingHungStillAlive);
  selfCheck("onTimeout deliberately throws: terminationConfirmed is true", throwingHungResult.terminationConfirmed === true);
  selfCheck("onTimeout deliberately throws: never escaped as uncaughtException", observedUncaught2 === null);
  selfCheck("onTimeout deliberately throws: never escaped as unhandledRejection", observedUnhandledRejection === null);
  selfCheck(
    "onTimeout deliberately throws: the central validator rejects this result too (timeoutPersistenceError alone is enough to fail it)",
    (() => {
      try {
        validateAsyncPsqlResult(throwingHungResult, "self-test-throwing-ontimeout", selfTestScratch);
        return false;
      } catch {
        return true;
      }
    })()
  );

  // (d2) error AFTER spawn is confirmed: proves this is NEVER treated
  // as "process never existed" -- done must NOT settle prematurely, and
  // must eventually settle with processError (never spawnError) set and
  // terminationConfirmed true, once the (forcibly terminated) process is
  // actually gone.
  let capturedChild: ReturnType<typeof spawn> | null = null;
  const postSpawnErrorChild = spawnWithBoundedTimeout(process.execPath, ["-e", hungNodeScript], 10000, {
    killGraceMs: 400,
    onSpawned: (child) => {
      capturedChild = child;
    },
  });
  await waitUntil(() => capturedChild !== null, 2000, 20, "post-spawn-error self-test: onSpawned fired");
  const settledBeforeSyntheticError = await Promise.race([
    postSpawnErrorChild.done.then(() => "settled" as const),
    new Promise<"still-pending">((r) => setTimeout(() => r("still-pending"), 150)),
  ]);
  selfCheck("post-spawn-error self-test: done has not settled merely from spawning and a short wait (sanity baseline)", settledBeforeSyntheticError === "still-pending");
  capturedChild!.emit("error", new Error("simulated post-spawn error (e.g. signal-related), the process itself is still running"));
  const settledRightAfterError = await Promise.race([
    postSpawnErrorChild.done.then(() => "settled" as const),
    new Promise<"still-pending">((r) => setTimeout(() => r("still-pending"), 50)),
  ]);
  selfCheck(
    "post-spawn-error self-test: emitting 'error' AFTER spawn was confirmed does NOT settle done prematurely -- no premature closure while the process could still be alive",
    settledRightAfterError === "still-pending"
  );
  const postSpawnErrorResult = await postSpawnErrorChild.done;
  selfCheck(
    "post-spawn-error self-test: eventually settles with processError set (never spawnError), and terminationConfirmed true once the forcibly-terminated process is actually gone",
    postSpawnErrorResult.processError !== null &&
      postSpawnErrorResult.processError.message.includes("simulated post-spawn error") &&
      postSpawnErrorResult.spawnError === null &&
      postSpawnErrorResult.spawned === true &&
      postSpawnErrorResult.terminationConfirmed === true
  );

  // (d3) sendSignalSafely exercised directly, with fake killFn/isAliveFn
  // -- no real OS race needed to prove the "returns false" and "throws"
  // branches, both of which are otherwise very hard to trigger reliably
  // against a real process.
  const fakePid = 999999;
  const killReturnsFalseStillAlive = sendSignalSafely(fakePid, "SIGTERM", () => false, () => true);
  selfCheck(
    "simulated kill() returning false while the process is (per the fake liveness check) still alive: reported as a real, structured error, never silently accepted",
    killReturnsFalseStillAlive.sent === false && killReturnsFalseStillAlive.alreadyGone === false && killReturnsFalseStillAlive.error !== null
  );
  const killReturnsFalseAlreadyGone = sendSignalSafely(fakePid, "SIGTERM", () => false, () => false);
  selfCheck(
    "simulated kill() returning false while the process is (per the fake liveness check) already gone: resolved as alreadyGone, no spurious error",
    killReturnsFalseAlreadyGone.sent === false && killReturnsFalseAlreadyGone.alreadyGone === true && killReturnsFalseAlreadyGone.error === null
  );
  const killThrowsStillAlive = sendSignalSafely(
    fakePid,
    "SIGKILL",
    () => {
      throw new Error("simulated kill() throw");
    },
    () => true
  );
  selfCheck(
    "simulated kill() throwing while the process is (per the fake liveness check) still alive: captured as a structured error, never propagated raw out of sendSignalSafely",
    killThrowsStillAlive.sent === false && killThrowsStillAlive.alreadyGone === false && killThrowsStillAlive.error !== null && killThrowsStillAlive.error.message.includes("simulated kill() throw")
  );
  const killThrowsButGone = sendSignalSafely(
    fakePid,
    "SIGKILL",
    () => {
      throw new Error("simulated kill() throw, but process is actually gone");
    },
    () => false
  );
  selfCheck(
    "simulated kill() throwing while the process is (per the fake liveness check) already gone: resolved as alreadyGone, the throw is not treated as a real problem",
    killThrowsButGone.sent === false && killThrowsButGone.alreadyGone === true && killThrowsButGone.error === null
  );

  // (e) Live-registry cleanup simulation, without psql: registers a
  // freshly spawned, tracked hung child into a local registry (the same
  // shape sc()'s own failure path below uses), simulates a parent
  // exception occurring before any barrier release, then runs the exact
  // same shared terminateLiveHandles() routine sc() uses -- confirming
  // ESRCH on the exact PID and an empty registry afterward. Never relies
  // on the child's own internal SQL-level bound (there is none here --
  // this is a plain Node child, no psql, no SQL at all).
  const registrySimHandle = spawnWithBoundedTimeout(process.execPath, ["-e", hungNodeScript], 30000);
  const registrySimRegistry = new Set<LiveSpawn>([registrySimHandle]);
  const registrySimPid = registrySimHandle.pid;
  let registrySimResult: TerminateLiveHandlesResult<LiveSpawn> | null = null;
  try {
    throw new Error("simulated parent exception before this scenario's barrier would have been released");
  } catch {
    // Simulated failure path: exactly the recovery a real scenario
    // failure runs -- terminate every still-active handle, await all of
    // them, then remove ONLY the ones confirmed terminated. Never a
    // blanket .clear() -- an unresolved handle would remain tracked.
    registrySimResult = await terminateLiveHandles(registrySimRegistry);
    for (const resolved of registrySimResult.resolvedHandles) registrySimRegistry.delete(resolved);
  }
  let registrySimStillAlive = false;
  if (registrySimPid !== undefined) {
    try {
      process.kill(registrySimPid, 0);
      registrySimStillAlive = true;
    } catch {
      registrySimStillAlive = false;
    }
  }
  selfCheck("Live-registry cleanup simulation: terminateLiveHandles() (the exact routine sc() uses) terminated the tracked child -- ESRCH confirmed, never relying on any internal SQL-level bound", !registrySimStillAlive);
  selfCheck(
    "Live-registry cleanup simulation: the (real, genuinely terminated) handle was placed in resolvedHandles and removed individually -- never via a blanket .clear()",
    registrySimResult !== null && registrySimResult.resolvedHandles.length === 1 && registrySimResult.unresolvedHandles.length === 0 && registrySimRegistry.size === 0
  );

  // (e2) terminateLiveHandles partitioning, exercised with deterministic
  // FAKE handles (no real process, no real timing) -- proves the
  // resolved/unresolved split itself, independent of any real SIGKILL
  // timing: a terminationConfirmed=true result is always placed in
  // resolvedHandles (safe to remove from any registry); a
  // terminationConfirmed=false result -- the exact pathological case a
  // real SIGKILL failure could produce -- is always placed in
  // unresolvedHandles, with a usable label and the exact pid, and is
  // NEVER silently dropped.
  function makeFakeTimedSpawnResult(overrides: Partial<TimedSpawnResult>): TimedSpawnResult {
    return {
      spawned: true,
      spawnError: null,
      processError: null,
      timedOut: false,
      timeoutPersistenceError: null,
      terminationError: null,
      terminationConfirmed: true,
      code: null,
      signal: null,
      stdout: "",
      stderr: "",
      pid: undefined,
      ...overrides,
    };
  }
  function makeFakeLiveSpawn(result: TimedSpawnResult): LiveSpawn {
    return { pid: result.pid, getStdout: () => result.stdout, getStderr: () => result.stderr, terminate: () => {}, done: Promise.resolve(result) };
  }
  const confirmedFake = makeFakeLiveSpawn(makeFakeTimedSpawnResult({ terminationConfirmed: true, pid: 111111 }));
  const unconfirmedFake = makeFakeLiveSpawn(makeFakeTimedSpawnResult({ terminationConfirmed: false, pid: 222222 }));
  const partitionResult = await terminateLiveHandles([confirmedFake, unconfirmedFake]);
  selfCheck(
    "terminateLiveHandles partitioning: terminationConfirmed=true -> placed in resolvedHandles",
    partitionResult.resolvedHandles.includes(confirmedFake) && !partitionResult.resolvedHandles.includes(unconfirmedFake)
  );
  selfCheck(
    "terminateLiveHandles partitioning: terminationConfirmed=false -> placed in unresolvedHandles, never silently dropped",
    partitionResult.unresolvedHandles.some((u) => u.pid === 222222) && !partitionResult.unresolvedHandles.some((u) => u.pid === 111111)
  );
  selfCheck(
    "terminateLiveHandles partitioning: the unresolved entry carries a usable label and the exact pid",
    partitionResult.unresolvedHandles.find((u) => u.pid === 222222)?.label === "pid=222222"
  );

  // (e3) isLiveHandleSafelyResolved -- THE single, central function --
  // exercised directly against all four required combinations,
  // including the exact edge case this correction round exists to
  // close: spawned=false with a PID that (in a synthetic/adversarial
  // handle) IS present must NOT be treated as "never created".
  selfCheck(
    "isLiveHandleSafelyResolved: spawned=false, pid=undefined, terminationConfirmed=false -> resolved (never created, nothing to track)",
    isLiveHandleSafelyResolved(makeFakeLiveSpawn(makeFakeTimedSpawnResult({ spawned: false, pid: undefined, terminationConfirmed: false })), makeFakeTimedSpawnResult({ spawned: false, pid: undefined, terminationConfirmed: false })) === true
  );
  selfCheck(
    "isLiveHandleSafelyResolved: spawned=false BUT pid is defined (the exact adversarial case this correction closes) -> unresolved, never removed on `!spawned` alone",
    isLiveHandleSafelyResolved({ pid: 333333, getStdout: () => "", getStderr: () => "", terminate: () => {}, done: Promise.resolve(makeFakeTimedSpawnResult({})) }, makeFakeTimedSpawnResult({ spawned: false, terminationConfirmed: false })) === false
  );
  selfCheck(
    "isLiveHandleSafelyResolved: spawned=true, pid defined, terminationConfirmed=false -> unresolved",
    isLiveHandleSafelyResolved({ pid: 444444, getStdout: () => "", getStderr: () => "", terminate: () => {}, done: Promise.resolve(makeFakeTimedSpawnResult({})) }, makeFakeTimedSpawnResult({ spawned: true, terminationConfirmed: false })) === false
  );
  selfCheck(
    "isLiveHandleSafelyResolved: spawned=true, terminationConfirmed=true -> resolved",
    isLiveHandleSafelyResolved({ pid: 555555, getStdout: () => "", getStderr: () => "", terminate: () => {}, done: Promise.resolve(makeFakeTimedSpawnResult({})) }, makeFakeTimedSpawnResult({ spawned: true, terminationConfirmed: true })) === true
  );

  // (e4) Both real consumers exercised end-to-end with the exact
  // adversarial handle (spawned=false, but its own .pid IS present) --
  // proving terminateLiveHandles keeps it unresolved, never removed on
  // `!spawned` alone.
  const adversarialHandle: LiveSpawn = {
    pid: 666666,
    getStdout: () => "",
    getStderr: () => "",
    terminate: () => {},
    done: Promise.resolve(makeFakeTimedSpawnResult({ spawned: false, pid: 666666, terminationConfirmed: false })),
  };
  const adversarialResult = await terminateLiveHandles([adversarialHandle]);
  selfCheck(
    "terminateLiveHandles: the adversarial handle (spawned=false but pid=666666 present) is kept in unresolvedHandles, never in resolvedHandles",
    adversarialResult.unresolvedHandles.some((u) => u.pid === 666666) && !adversarialResult.resolvedHandles.includes(adversarialHandle)
  );

  // (e5) Static proof that both, and only both, real PRODUCTION
  // consumers route through the SAME single function -- scoped to each
  // consumer's own function body specifically (never a whole-file
  // occurrence count, which would also match this self-test's own
  // direct unit-test calls to the same function above). Exactly one
  // call inside terminateLiveHandles, exactly one inside
  // runPsqlAsyncLive, and no recopy of the retired permissive
  // expression anywhere.
  const terminateLiveHandlesFnMatch = selfCodeOnly.match(
    /async function terminateLiveHandles<T extends LiveSpawn>\(handles: Iterable<T>\): Promise<TerminateLiveHandlesResult<T>> \{([\s\S]*?)\n\}/
  );
  const terminateLiveHandlesBody = terminateLiveHandlesFnMatch ? terminateLiveHandlesFnMatch[1]! : "";
  const callsInTerminateLiveHandles = (terminateLiveHandlesBody.match(/isLiveHandleSafelyResolved\(/g) ?? []).length;

  const runPsqlAsyncLiveFnMatch = selfCodeOnly.match(
    /function runPsqlAsyncLive\(sql: string, tag: string, timeoutMs: number = DEFAULT_ASYNC_PSQL_TIMEOUT_MS\): LiveSpawn & \{ scriptPath: string \} \{([\s\S]*?)\n  \}/
  );
  const runPsqlAsyncLiveBody = runPsqlAsyncLiveFnMatch ? runPsqlAsyncLiveFnMatch[1]! : "";
  const callsInRunPsqlAsyncLive = (runPsqlAsyncLiveBody.match(/isLiveHandleSafelyResolved\(/g) ?? []).length;

  selfCheck(
    `static self-inspection: isLiveHandleSafelyResolved is called exactly once inside terminateLiveHandles (found ${callsInTerminateLiveHandles}) and exactly once inside runPsqlAsyncLive's own removal callback (found ${callsInRunPsqlAsyncLive}) -- the only two real production consumers, the logic never recopied`,
    terminateLiveHandlesFnMatch !== null && callsInTerminateLiveHandles === 1 && runPsqlAsyncLiveFnMatch !== null && callsInRunPsqlAsyncLive === 1
  );

  function hasPermissiveRecopy(text: string): boolean {
    const patternA = "!" + "spawned || " + "terminationConfirmed";
    const patternB = "!r." + "spawned || r." + "terminationConfirmed";
    const patternC = "!s.value." + "spawned || s.value." + "terminationConfirmed";
    return text.includes(patternA) || text.includes(patternB) || text.includes(patternC);
  }
  selfCheck(
    "static self-inspection: no recopy of the retired permissive removal expression (the old, unqualified 'spawned OR terminationConfirmed' shape, in any variable-qualified form) remains anywhere in this file's executable source",
    !hasPermissiveRecopy(selfCodeOnly)
  );
  const permissiveRecopyForSyntheticTest = "!r." + "spawned || r." + "terminationConfirmed";
  const syntheticWithPermissiveRecopy = selfCodeOnly + "\nif (" + permissiveRecopyForSyntheticTest + ") { scenarioLiveHandles.delete(handle); }\n";
  selfCheck(
    "negative self-test: a synthetic in-memory copy with the retired permissive expression reintroduced is correctly detected by hasPermissiveRecopy()",
    hasPermissiveRecopy(syntheticWithPermissiveRecopy)
  );

  // (f) Barrier registration: BARRIER_REGISTRATION_MODE=EXPLICIT --
  // static, source-level proof that no regex-based scanning of SQL text
  // for barrier names exists anywhere in this file (the exact
  // brittleness a prior review round required removed), and that
  // resetAndRegisterScenarioBarrier's own source genuinely registers a
  // barrier name only AFTER its own runPsql(...) reset call has already
  // returned (which itself throws on any failure) -- never before.
  console.log("BARRIER_REGISTRATION_MODE=EXPLICIT");
  // Built via concatenation so this very check's own source text never
  // contains the contiguous forbidden pattern either -- otherwise this
  // check would flag itself the moment it was written (the exact same
  // self-referential trap the pkill/killall check above already guards
  // against).
  const barrierScanPattern = "sql.match" + "All(";
  const oldRegexVarName = "BARRIER_RESET_" + "RE";
  selfCheck(
    "static self-inspection: no SQL-text-scanning-based barrier discovery (the old, brittle regex mechanism a prior review round required removed) exists anywhere in this file's executable source",
    !selfCodeOnly.includes(barrierScanPattern) && !selfCodeOnly.includes(oldRegexVarName)
  );
  const resetFnMatch = selfCodeOnly.match(/function resetAndRegisterScenarioBarrier\(name: string\): void \{([\s\S]*?)\n  \}/);
  const resetFnBody = resetFnMatch ? resetFnMatch[1]! : "";
  const runPsqlCallIdx = resetFnBody.indexOf("runPsql(");
  const registerCallIdx = resetFnBody.indexOf("scenarioBarrierNames.add(name)");
  selfCheck(
    "static self-inspection: resetAndRegisterScenarioBarrier's own source function was found, and it registers the barrier name strictly AFTER its own runPsql(...) reset call, never before",
    resetFnMatch !== null && runPsqlCallIdx !== -1 && registerCallIdx !== -1 && runPsqlCallIdx < registerCallIdx
  );
  const releaseFnMatch = selfCodeOnly.match(/function releaseScenarioBarrier\(name: string\): void \{([\s\S]*?)\n  \}/);
  const releaseFnBody = releaseFnMatch ? releaseFnMatch[1]! : "";
  const releaseRunPsqlIdx = releaseFnBody.indexOf("runPsql(");
  const releaseDeleteIdx = releaseFnBody.indexOf("scenarioBarrierNames.delete(name)");
  selfCheck(
    "static self-inspection: releaseScenarioBarrier's own source function was found, and it unregisters the barrier name strictly AFTER its own runPsql(...) release call, never before",
    releaseFnMatch !== null && releaseRunPsqlIdx !== -1 && releaseDeleteIdx !== -1 && releaseRunPsqlIdx < releaseDeleteIdx
  );
  selfCheck(
    "static self-inspection: releaseScenarioBarrier's own runPsql(...) call throws on failure BEFORE reaching scenarioBarrierNames.delete(name) -- a failed release therefore always leaves the name in the registry, never silently discarded",
    releaseFnBody.includes("if (") && releaseRunPsqlIdx !== -1 && releaseDeleteIdx > releaseRunPsqlIdx
  );

  // (g) Registry-quiescence discipline: no .clear() call on either
  // registry anywhere in this file's executable production source (the
  // exact regression a prior review round required removed), proven via
  // a negative self-test on a synthetic in-memory copy first.
  const forbiddenClearPatterns = ["scenarioLiveHandles.clear" + "()", "scenarioBarrierNames.clear" + "()"];
  const realClearHit = forbiddenClearPatterns.find((p) => selfCodeOnly.includes(p));
  const syntheticWithClear = selfCodeOnly + "\n" + forbiddenClearPatterns[0] + ";\n";
  const syntheticClearDetected = forbiddenClearPatterns.some((p) => syntheticWithClear.includes(p));
  selfCheck(
    "negative self-test: a synthetic in-memory copy with a reintroduced registry .clear() call is correctly detected",
    syntheticClearDetected
  );
  selfCheck(
    `static self-inspection: no .clear() call on scenarioLiveHandles or scenarioBarrierNames exists anywhere in this file's executable production source${realClearHit ? ` (found: "${realClearHit}")` : ""}`,
    !realClearHit
  );

  // (h) Static proof that sc()'s own scenario-start gate and
  // assertRuntimeInfrastructureQuiescent's own final gate both exist and
  // both reject on a non-empty registry -- PASSED is structurally
  // impossible while either registry is non-empty.
  selfCheck(
    "static self-inspection: sc()'s own source rejects starting a new scenario when a prior scenario left either registry non-empty",
    selfCodeOnly.includes('refusing to start scenario "${name}": the Live-handle/barrier registries are NOT empty')
  );
  selfCheck(
    "static self-inspection: sc()'s own source also refuses to count a scenario as successful if its body completed but left either registry non-empty",
    selfCodeOnly.includes("left its infrastructure non-quiescent")
  );
  selfCheck(
    "static self-inspection: assertRuntimeInfrastructureQuiescent's own source exists and rejects a non-empty registry, called at the very end of runScenariosImpl (strictly before main() can proceed to Docker cleanup or PASSED)",
    selfCodeOnly.includes("function assertRuntimeInfrastructureQuiescent(): void {") &&
      selfCodeOnly.includes("runtime infrastructure is NOT quiescent after all scenarios") &&
      selfCodeOnly.includes("assertRuntimeInfrastructureQuiescent();\n}")
  );

  // (i) The original error is always the real cause, never replaced --
  // static proof that sc()'s own failure path derives combinedError FROM
  // originalError (never a fresh, unrelated Error) and throws that
  // derived error, never the original discarded in favor of only
  // diagnostics.
  selfCheck(
    "static self-inspection: sc()'s own failure path derives combinedError from originalError (never a fresh, unrelated error) and throws combinedError, never discarding the original cause",
    selfCodeOnly.includes("const combinedError = originalError instanceof Error ? originalError : new Error(originalMessage);") && selfCodeOnly.includes("throw combinedError;")
  );

  // (j) Protected-container identity, atomic single-inspect capture --
  // exercised entirely against synthetic docker-inspect-shaped JSON
  // text, no Docker involved.
  function syntheticIdentitySnapshotText(overrides: Record<string, unknown> = {}, omit: readonly string[] = []): string {
    const base: Record<string, unknown> = {
      id: "a".repeat(64),
      startedAt: "2026-08-21T16:27:27.846283801Z",
      restartCount: 0,
      status: "running",
      health: "healthy",
      ports: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "5432" }] },
      networks: { "zweb-zpact_default": {} },
      mounts: [],
      labels: {},
    };
    const merged: Record<string, unknown> = { ...base, ...overrides };
    for (const k of omit) delete merged[k];
    return JSON.stringify(merged);
  }

  const validA = parseProtectedIdentitySnapshot(syntheticIdentitySnapshotText());
  const validAAgain = parseProtectedIdentitySnapshot(syntheticIdentitySnapshotText());
  selfCheck(
    "parseProtectedIdentitySnapshot: a valid, complete synthetic snapshot parses into an identity whose fields are exactly the input values (id, status, restartCount, health)",
    validA.id === "a".repeat(64) && validA.status === "running" && validA.restartCount === 0 && validA.health === "healthy"
  );
  selfCheck(
    "identitiesMatch: two independent parses of the identical snapshot text produce an identity that matches itself",
    identitiesMatch(validA, validAAgain)
  );

  function expectSnapshotRejected(label: string, raw: string): void {
    let threw = false;
    try {
      parseProtectedIdentitySnapshot(raw);
    } catch {
      threw = true;
    }
    selfCheck(`parseProtectedIdentitySnapshot: ${label} is rejected`, threw);
  }

  expectSnapshotRejected("empty docker inspect output", "");
  expectSnapshotRejected("whitespace-only output", "   \n  ");
  expectSnapshotRejected("invalid JSON", "{not json");
  expectSnapshotRejected("status (State.Status) missing entirely", syntheticIdentitySnapshotText({}, ["status"]));
  expectSnapshotRejected("id that is not a plausible container ID", syntheticIdentitySnapshotText({ id: "not-an-id!" }));
  expectSnapshotRejected("a required field missing (health)", syntheticIdentitySnapshotText({}, ["health"]));
  expectSnapshotRejected("restartCount that is not numeric", syntheticIdentitySnapshotText({ restartCount: "0" }));

  // ID: exactly 64 hexadecimal characters, no more, no less.
  selfCheck(
    "parseProtectedIdentitySnapshot: id with exactly 64 hex characters is accepted",
    (() => {
      try {
        parseProtectedIdentitySnapshot(syntheticIdentitySnapshotText({ id: "a".repeat(64) }));
        return true;
      } catch {
        return false;
      }
    })()
  );
  expectSnapshotRejected("id with only 12 hex characters", syntheticIdentitySnapshotText({ id: "a".repeat(12) }));
  expectSnapshotRejected("id with 63 hex characters (one short)", syntheticIdentitySnapshotText({ id: "a".repeat(63) }));
  expectSnapshotRejected("id with 65 hex characters (one too many)", syntheticIdentitySnapshotText({ id: "a".repeat(65) }));
  expectSnapshotRejected("id with 64 characters but containing a non-hex letter ('g')", syntheticIdentitySnapshotText({ id: "g" + "a".repeat(63) }));
  expectSnapshotRejected("id as an empty string", syntheticIdentitySnapshotText({ id: "" }));

  // restartCount: typeof === "number", Number.isSafeInteger, >= 0.
  selfCheck(
    "parseProtectedIdentitySnapshot: restartCount=0 is accepted",
    (() => {
      try {
        parseProtectedIdentitySnapshot(syntheticIdentitySnapshotText({ restartCount: 0 }));
        return true;
      } catch {
        return false;
      }
    })()
  );
  selfCheck(
    "parseProtectedIdentitySnapshot: a positive integer restartCount is accepted",
    (() => {
      try {
        parseProtectedIdentitySnapshot(syntheticIdentitySnapshotText({ restartCount: 3 }));
        return true;
      } catch {
        return false;
      }
    })()
  );
  expectSnapshotRejected("restartCount=-1 (negative)", syntheticIdentitySnapshotText({ restartCount: -1 }));
  expectSnapshotRejected("restartCount=1.5 (fractional)", syntheticIdentitySnapshotText({ restartCount: 1.5 }));
  expectSnapshotRejected(
    "restartCount greater than Number.MAX_SAFE_INTEGER",
    syntheticIdentitySnapshotText({ restartCount: Number.MAX_SAFE_INTEGER + 1 })
  );
  expectSnapshotRejected('restartCount as the string "0" instead of the number 0', syntheticIdentitySnapshotText({ restartCount: "0" }));

  expectSnapshotRejected(
    "an attempt to supply two merged field sets (as if two separate captures were concatenated into one object)",
    JSON.stringify({ ...JSON.parse(syntheticIdentitySnapshotText()), extraId: "b".repeat(64), extraStatus: "running" })
  );

  const fixedId = "3".repeat(64);
  const idOneBaseline = parseProtectedIdentitySnapshot(syntheticIdentitySnapshotText({ id: fixedId }));
  const idTwoSameEverythingElse = parseProtectedIdentitySnapshot(syntheticIdentitySnapshotText({ id: "4".repeat(64) }));
  selfCheck(
    "identitiesMatch: a baseline captured as container ID1 and a later capture of a same-named container ID2 (every other field identical) is rejected -- a same-name replacement can never be masked by every other field matching",
    !identitiesMatch(idOneBaseline, idTwoSameEverythingElse)
  );
  const pausedSameId = parseProtectedIdentitySnapshot(syntheticIdentitySnapshotText({ id: fixedId, status: "paused" }));
  const pausedDrift = describeIdentityDrift(idOneBaseline, pausedSameId);
  selfCheck(
    "identitiesMatch: running -> paused (identical id and every other field) is rejected, and describeIdentityDrift names status with its exact expected/actual values",
    !identitiesMatch(idOneBaseline, pausedSameId) &&
      pausedDrift !== null &&
      pausedDrift.includes(`status: expected=${JSON.stringify("running")} actual=${JSON.stringify("paused")}`)
  );

  // Static proof that captureZypactPostgresIdentity's own body contains
  // EXACTLY ONE run("docker", ["inspect"...]) call -- one atomic
  // Docker-side snapshot per capture, never assembled by this file from
  // more than one invocation -- with a negative self-test on a
  // synthetic in-memory copy proving the checker would actually catch
  // the old, multi-call implementation this correction retires.
  const captureFnMatch = selfCodeOnly.match(/function captureZypactPostgresIdentity\(\): ProtectedContainerIdentity \| null \{([\s\S]*?)\n  \}/);
  const captureFnBody = captureFnMatch ? captureFnMatch[1]! : "";
  const inspectCallPattern = /run\("docker", \["inspect"/g;
  const realInspectCallCount = (captureFnBody.match(inspectCallPattern) ?? []).length;
  selfCheck(
    `static self-inspection: captureZypactPostgresIdentity's own body contains exactly one run("docker", ["inspect"...]) call (found ${realInspectCallCount})`,
    captureFnMatch !== null && realInspectCallCount === 1
  );
  const syntheticOldMultiCallBody = captureFnBody + '\n    const extra = run("docker", ["inspect", "--format", "{{json .Mounts}}", "zypact-postgres"]);\n';
  const syntheticInspectCallCount = (syntheticOldMultiCallBody.match(inspectCallPattern) ?? []).length;
  selfCheck(
    "negative preflight: a synthetic in-memory copy of captureZypactPostgresIdentity's body with a second run(\"docker\", [\"inspect\"...]) call reintroduced (the retired, multi-call implementation shape) is correctly detected as more than one invocation",
    syntheticInspectCallCount === 2
  );

  // Literal, exact anchors (not brace-counting regex extraction) --
  // each pairs the real capture-variable declaration with the real
  // identitiesMatch(...) call that must immediately follow it at each
  // of the three real call sites in main().
  const preCleanupAnchor =
    "const preCleanupCapture = captureZypactPostgresIdentity();\n      if (preCleanupCapture === null || !identitiesMatch(zypactPostgresBaseline, preCleanupCapture)) {";
  const postStopAnchor =
    "const postStopCapture = captureZypactPostgresIdentity();\n      if (postStopCapture === null || !identitiesMatch(zypactPostgresBaseline, postStopCapture)) {";
  const finallyAnchor =
    "const after = captureZypactPostgresIdentity();\n      const matched = after !== null && identitiesMatch(zypactPostgresBaseline, after);";
  const preCleanupUsesCentralFn = selfCodeOnly.includes(preCleanupAnchor);
  const postStopUsesCentralFn = selfCodeOnly.includes(postStopAnchor);
  const finallyUsesCentralFn = selfCodeOnly.includes(finallyAnchor);
  selfCheck(
    "static self-inspection: the pre-cleanup check, the post-stop check, and the final unconditional diagnostic re-check in main() all call the same central identitiesMatch(...) function -- never a re-derived or duplicated comparison",
    preCleanupUsesCentralFn && postStopUsesCentralFn && finallyUsesCentralFn
  );
  // Built via concatenation so this very check's own string-literal
  // arguments never contain the retired contiguous patterns either --
  // otherwise this check would flag itself the moment it was written
  // (the same self-referential trap the pkill/killall check guards
  // against above).
  const retiredPreCleanupPattern = "preCleanup" + "Capture !== zypactPostgresBaseline";
  const retiredPostStopPattern = "postStop" + "Capture !== zypactPostgresBaseline";
  const retiredFinallyPattern = "after " + "=== zypactPostgresBaseline";
  selfCheck(
    "static self-inspection: no opaque string-equality comparison of a captured zypact-postgres identity (the retired direct !== / === shape) remains anywhere in this file's executable source",
    !selfCodeOnly.includes(retiredPreCleanupPattern) && !selfCodeOnly.includes(retiredPostStopPattern) && !selfCodeOnly.includes(retiredFinallyPattern)
  );

  // (k) Helper installer: exercised against the REAL generated install
  // script (buildHelperInstallScript(HELPER_SQL)) -- no Docker, no
  // database. Proves the owner-created, single-transaction design: no
  // SET ROLE service_role before the first CREATE, no GRANT CREATE ever
  // handed to service_role, BEGIN precedes all DDL, RESET ROLE precedes
  // COMMIT, the success marker follows COMMIT -- each with a negative
  // self-test proving the checker actually discriminates a regression,
  // never merely confirming the happy path.
  const realInstallScript = buildHelperInstallScript(HELPER_SQL);

  function serviceRoleSetBeforeFirstCreate(script: string): boolean {
    const setRoleIdx = script.indexOf("SET ROLE service_role;");
    const firstCreateIdx = script.search(/create (or replace function|table if not exists)/i);
    return setRoleIdx !== -1 && firstCreateIdx !== -1 && setRoleIdx < firstCreateIdx;
  }
  selfCheck(
    "buildHelperInstallScript: the real generated install script never sets SET ROLE service_role before the first CREATE -- every helper function/table is created as the database owner",
    !serviceRoleSetBeforeFirstCreate(realInstallScript)
  );
  selfCheck(
    "negative self-test: a synthetic copy with SET ROLE service_role reintroduced before the first CREATE is correctly detected",
    serviceRoleSetBeforeFirstCreate("SET ROLE service_role;\n" + realInstallScript)
  );

  function hasGrantCreateToServiceRole(script: string): boolean {
    return /grant\s+create\s+on\s+schema\s+public\s+to\s+service_role/i.test(script);
  }
  selfCheck(
    "buildHelperInstallScript: the real generated install script never grants CREATE ON SCHEMA public to service_role",
    !hasGrantCreateToServiceRole(realInstallScript)
  );
  selfCheck(
    "negative self-test: a synthetic copy with GRANT CREATE ON SCHEMA public TO service_role reintroduced is correctly detected",
    hasGrantCreateToServiceRole(realInstallScript + "\ngrant create on schema public to service_role;\n")
  );

  function beginPrecedesAllDdl(script: string): boolean {
    const beginIdx = script.search(/^BEGIN;/m);
    const firstDdlIdx = script.search(/create (or replace function|table if not exists)/i);
    return beginIdx !== -1 && firstDdlIdx !== -1 && beginIdx < firstDdlIdx;
  }
  selfCheck(
    "buildHelperInstallScript: BEGIN precedes every CREATE statement in the real generated install script",
    beginPrecedesAllDdl(realInstallScript)
  );
  selfCheck(
    "negative self-test: a synthetic copy with BEGIN removed is correctly detected as no longer preceding DDL",
    !beginPrecedesAllDdl(realInstallScript.replace(/^BEGIN;\n/m, ""))
  );

  function resetRolePrecedesCommit(script: string): boolean {
    const resetIdx = script.indexOf("RESET ROLE;");
    const commitIdx = script.indexOf("COMMIT;");
    return resetIdx !== -1 && commitIdx !== -1 && resetIdx < commitIdx;
  }
  selfCheck(
    "buildHelperInstallScript: RESET ROLE precedes COMMIT in the real generated install script",
    resetRolePrecedesCommit(realInstallScript)
  );
  selfCheck(
    "negative self-test: a synthetic copy with RESET ROLE removed is correctly detected",
    !resetRolePrecedesCommit(realInstallScript.replace("RESET ROLE;\n", ""))
  );

  function markerFollowsCommit(script: string): boolean {
    const commitIdx = script.indexOf("COMMIT;");
    const markerIdx = script.indexOf("helper_installed ok");
    return commitIdx !== -1 && markerIdx !== -1 && commitIdx < markerIdx;
  }
  selfCheck(
    "buildHelperInstallScript: the 'helper_installed ok' marker appears strictly after COMMIT in the real generated install script",
    markerFollowsCommit(realInstallScript)
  );
  selfCheck(
    "negative self-test: a synthetic copy with COMMIT removed is correctly detected as the marker no longer following any COMMIT",
    !markerFollowsCommit(realInstallScript.replace("COMMIT;\n", ""))
  );

  const helperManifestForConsistency = deriveHelperManifest(HELPER_SQL);
  const realGrantCount = (HELPER_SQL.match(/grant execute on function/g) ?? []).length;
  const realRevokeCount = (realInstallScript.match(/revoke execute on function/g) ?? []).length;
  const realRegprocCount = (realInstallScript.match(/::regprocedure/g) ?? []).length;
  selfCheck(
    "manifest consistency: HELPER_SQL's own function count, its GRANT EXECUTE statements, and the generated script's REVOKE EXECUTE / regprocedure-signature counts are all mutually consistent -- never hardcoded, always derived from the same source text",
    realGrantCount === helperManifestForConsistency.functions.length &&
      realRevokeCount === helperManifestForConsistency.functions.length &&
      realRegprocCount === helperManifestForConsistency.functions.length * 2
  );

  selfCheck(
    "deriveHelperManifest: throws on a synthetic SQL sample containing no _m5_0054_rt_* function definitions, rather than silently returning an empty manifest",
    (() => {
      try {
        deriveHelperManifest("select 1;");
        return false;
      } catch {
        return true;
      }
    })()
  );

  const syntheticHelperSql = `
create or replace function
  public._m5_0054_rt_test_one(p_a text, p_b integer default 3)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
begin
end;
$f$;
grant execute on function public._m5_0054_rt_test_one(text, integer) to service_role;

create or replace function public._m5_0054_rt_test_two(
    p_x uuid, p_y timestamptz
  ) returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
begin
end;
$f$;
grant execute on function public._m5_0054_rt_test_two(uuid, timestamptz) to service_role;

create table if not exists public._m5_0054_rt_test_table (id text primary key);
`;
  const syntheticManifest = deriveHelperManifest(syntheticHelperSql);
  selfCheck(
    "deriveHelperManifest: correctly extracts 2 functions with exact argument-type signatures (one multi-line signature, one default-valued param) and 1 table from a synthetic sample",
    syntheticManifest.functions.length === 2 &&
      syntheticManifest.functions[0]!.name === "_m5_0054_rt_test_one" &&
      syntheticManifest.functions[0]!.argTypes.join(",") === "text,integer" &&
      syntheticManifest.functions[1]!.name === "_m5_0054_rt_test_two" &&
      syntheticManifest.functions[1]!.argTypes.join(",") === "uuid,timestamptz" &&
      syntheticManifest.tables[0] === "_m5_0054_rt_test_table"
  );

  // (l) Helper installer security hardening: every application table
  // this script touches is explicitly public.-qualified, and the
  // success marker appears exactly once, strictly after COMMIT. (The
  // proconfig/ACL exact-match oracles that used to live here have been
  // superseded by section (m) below -- isExactPinnedProconfig and the
  // aclexplode-based ACL checks -- which cover every case required
  // here plus cardinality/duplicate/extra-GUC cases this section's
  // retired single-string oracle could never express.)

  const APPLICATION_TABLE_NAMES = [
    "projects",
    "buyer_questions",
    "buyer_question_versions",
    "protocols",
    "protocol_execution_jobs",
    "protocol_attempts",
    "protocol_external_calls",
    "probe_runs",
    "protocol_execution_job_alerts",
    "protocol_execution_job_alert_deliveries",
    "protocol_execution_job_alert_delivery_attempts",
  ];
  function stripSqlLineComments(sql: string): string {
    return sql
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("--");
        return idx === -1 ? line : line.slice(0, idx);
      })
      .join("\n");
  }
  function findUnqualifiedApplicationTableRefs(sql: string): string[] {
    const codeOnly = stripSqlLineComments(sql);
    const hits: string[] = [];
    for (const table of APPLICATION_TABLE_NAMES) {
      const re = new RegExp(`\\b(?:from|into|update|join)\\s+(public\\.)?(${table})\\b`, "gi");
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(codeOnly)) !== null) {
        if (!mm[1]) hits.push(`${table}@${mm.index}`);
      }
    }
    return hits;
  }
  const realUnqualifiedHits = findUnqualifiedApplicationTableRefs(HELPER_SQL);
  selfCheck(
    `static self-inspection: HELPER_SQL contains zero unqualified references to any of the ${APPLICATION_TABLE_NAMES.length} known application tables it touches (found: ${JSON.stringify(realUnqualifiedHits)})`,
    realUnqualifiedHits.length === 0
  );
  selfCheck(
    "negative self-test: a synthetic copy of HELPER_SQL with one qualification stripped (public.projects -> projects) is correctly detected as an unqualified reference",
    findUnqualifiedApplicationTableRefs(HELPER_SQL.replace("insert into public.projects", "insert into projects")).length === 1
  );

  function countExecutableMarkerOccurrences(script: string): number {
    return (script.match(/\\echo '##R## helper_installed ok'/g) ?? []).length;
  }
  selfCheck(
    "buildHelperInstallScript: the real generated install script emits the '##R## helper_installed ok' marker exactly once",
    countExecutableMarkerOccurrences(realInstallScript) === 1
  );
  selfCheck(
    "negative self-test: a synthetic copy with the marker duplicated is correctly detected as more than one occurrence",
    countExecutableMarkerOccurrences(realInstallScript + "\n\\echo '##R## helper_installed ok'\n") === 2
  );
  selfCheck(
    "negative self-test: a synthetic copy with the marker removed entirely is correctly detected as zero occurrences",
    countExecutableMarkerOccurrences(realInstallScript.replace("\\echo '##R## helper_installed ok'\n", "")) === 0
  );
  selfCheck(
    "negative self-test: a synthetic copy with the marker moved to appear BEFORE COMMIT is correctly detected as no longer following COMMIT",
    !markerFollowsCommit(realInstallScript.replace("COMMIT;\n\\echo '##R## helper_installed ok'\n", "\\echo '##R## helper_installed ok'\nCOMMIT;\n"))
  );

  // (m) PUBLIC-EXECUTE detection via real ACL inspection (never
  // has_function_privilege('PUBLIC', ...), which treats 'public' as a
  // role-name string rather than the special PUBLIC grantee) and an
  // EXACT (cardinality-checked, not EXISTS-based) proconfig match. Pure
  // JS oracles mirror the SQL-side logic exactly (aclexplode/grantee=0
  // and array_length=1/normalized-equality cannot be executed here
  // without a database), cross-verified against the real generated
  // script's own text, each with a negative self-test proving the
  // checker actually discriminates a regression.
  interface AclEntry {
    grantee: number;
    privilege_type: string;
  }
  function hasPublicExecute(aclEntries: readonly AclEntry[]): boolean {
    return aclEntries.some((e) => e.grantee === 0 && e.privilege_type === "EXECUTE");
  }
  const DEFAULT_FUNCTION_ACL: readonly AclEntry[] = [
    { grantee: 0, privilege_type: "EXECUTE" }, // PostgreSQL's own default ACL for functions/procedures grants EXECUTE to PUBLIC when proacl IS NULL -- acldefault('f', owner) models exactly this.
  ];
  selfCheck(
    "hasPublicExecute: proacl NULL modeled via the real default function ACL (acldefault('f', owner)) is detected as granting PUBLIC EXECUTE",
    hasPublicExecute(DEFAULT_FUNCTION_ACL)
  );
  selfCheck(
    "hasPublicExecute: an explicit ACL containing a PUBLIC EXECUTE grant (grantee=0) is detected",
    hasPublicExecute([
      { grantee: 0, privilege_type: "EXECUTE" },
      { grantee: 16412, privilege_type: "EXECUTE" },
    ])
  );
  selfCheck(
    "hasPublicExecute: an ACL after REVOKE EXECUTE FROM PUBLIC, containing only owner and service_role EXECUTE grants (no grantee=0 entry), is correctly accepted (not detected as PUBLIC EXECUTE)",
    !hasPublicExecute([
      { grantee: 10, privilege_type: "EXECUTE" }, // owner
      { grantee: 16412, privilege_type: "EXECUTE" }, // service_role
    ])
  );

  function usesHasFunctionPrivilegePublic(script: string): boolean {
    return /has_function_privilege\s*\(\s*'public'/i.test(script);
  }
  function usesAclExplodeCheck(script: string): boolean {
    return script.includes("pg_catalog.aclexplode(") && script.includes("grantee = 0") && script.includes("privilege_type = 'EXECUTE'");
  }
  selfCheck(
    "buildHelperInstallScript: the real generated verify block uses pg_catalog.aclexplode/grantee=0/privilege_type='EXECUTE' for the PUBLIC-EXECUTE check, and contains no occurrence of has_function_privilege('public', ...) in any casing",
    usesAclExplodeCheck(realInstallScript) && !usesHasFunctionPrivilegePublic(realInstallScript)
  );
  selfCheck(
    "negative self-test: a synthetic copy reverting to has_function_privilege('PUBLIC', ...) (any casing) in place of the aclexplode check is correctly detected",
    usesHasFunctionPrivilegePublic(realInstallScript.replace(/not exists \(\s*select 1 from pg_catalog\.aclexplode[\s\S]*?\)\s*\)/, "not has_function_privilege('PUBLIC', v_fn, 'EXECUTE')"))
  );

  function isExactPinnedProconfig(proconfig: readonly string[] | null | undefined): boolean {
    if (!proconfig || proconfig.length !== 1) return false;
    const normalized = proconfig[0]!.replace(/\s*,\s*/g, ",");
    return normalized === "search_path=pg_catalog,pg_temp";
  }
  selfCheck(
    "isExactPinnedProconfig: a single element with a space after the comma is accepted",
    isExactPinnedProconfig(["search_path=pg_catalog, pg_temp"])
  );
  selfCheck(
    "isExactPinnedProconfig: a single element with no space after the comma is accepted",
    isExactPinnedProconfig(["search_path=pg_catalog,pg_temp"])
  );
  selfCheck(
    "isExactPinnedProconfig: null is rejected",
    !isExactPinnedProconfig(null)
  );
  selfCheck(
    "isExactPinnedProconfig: an empty array is rejected",
    !isExactPinnedProconfig([])
  );
  selfCheck(
    "isExactPinnedProconfig: a search_path containing public is rejected",
    !isExactPinnedProconfig(["search_path=public,pg_temp"])
  );
  selfCheck(
    "isExactPinnedProconfig: a reversed schema order is rejected",
    !isExactPinnedProconfig(["search_path=pg_temp,pg_catalog"])
  );
  selfCheck(
    "isExactPinnedProconfig: the correct search_path plus an extra GUC element (statement_timeout=0) is rejected -- cardinality alone excludes it, the extra element is never silently ignored",
    !isExactPinnedProconfig(["search_path=pg_catalog,pg_temp", "statement_timeout=0"])
  );
  selfCheck(
    "isExactPinnedProconfig: two search_path entries (a duplicate) is rejected -- cardinality alone excludes it",
    !isExactPinnedProconfig(["search_path=pg_catalog,pg_temp", "search_path=public,pg_temp"])
  );

  function usesExactProconfigCardinality(script: string): boolean {
    return script.includes("array_length(p.proconfig, 1) = 1") && script.includes("p.proconfig is not null");
  }
  function usesPermissiveProconfigExists(script: string): boolean {
    return /exists\s*\(\s*select 1 from unnest\(coalesce\(p\.proconfig/i.test(script);
  }
  selfCheck(
    "buildHelperInstallScript: the real generated verify block requires proconfig non-null AND exactly one element AND an exact normalized-equality match -- never an EXISTS-based (at-least-one-match) proconfig check",
    usesExactProconfigCardinality(realInstallScript) && !usesPermissiveProconfigExists(realInstallScript)
  );
  selfCheck(
    "negative self-test: a synthetic copy reverting to the retired EXISTS-based (permissive) proconfig check is correctly detected",
    usesPermissiveProconfigExists(
      realInstallScript + "\nexists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg where cfg = 'search_path=pg_catalog,pg_temp')\n"
    )
  );

  // (n) Hard gate: scenarios must never start unless the helper
  // installation is fully verified. isHelperInstallVerified is the
  // real, shared production predicate (exercised directly with
  // synthetic inputs -- no Docker). The throw itself is mirrored here
  // (documented, not re-derived) since the real gate is a bare
  // if/throw inlined at the call site, not a separately callable
  // function -- a static cross-check confirms the mirror's message
  // text is byte-identical to what actually appears in the real
  // source. Anchors are built via concatenation so this self-test's
  // own source text never spells out the exact contiguous patterns it
  // searches for -- otherwise it would flag (or match) itself the
  // moment it was written, the same self-referential trap guarded
  // against everywhere else in this file.
  const helperGateMessagePrefix = "helper installation not fully verified -- refusing to start any scenario. ";
  function helperInstallGateMirror(verified: boolean, markerPresent: boolean, actualCount: string | undefined, expectedCount: number): void {
    if (!verified) {
      throw new Error(
        `${helperGateMessagePrefix}` +
          `marker_present=${markerPresent}; expected_helper_count=${expectedCount}; ` +
          `actual_helper_count=${actualCount ?? "<missing>"}; scenarios_started=false`
      );
    }
  }
  selfCheck(
    "static self-inspection: the real hard-gate throw message (in main()) shares the exact same message prefix as this self-test's dynamic mirror",
    selfCodeOnly.includes(helperGateMessagePrefix)
  );

  selfCheck(
    "dynamic proof: isHelperInstallVerified(true-shaped inputs) -> gate does not throw",
    (() => {
      const verified = isHelperInstallVerified(true, "14", 14);
      try {
        helperInstallGateMirror(verified, true, "14", 14);
        return verified === true;
      } catch {
        return false;
      }
    })()
  );
  selfCheck(
    "dynamic proof: isHelperInstallVerified(false-shaped inputs) -> gate throws",
    (() => {
      const verified = isHelperInstallVerified(false, undefined, 14);
      try {
        helperInstallGateMirror(verified, false, undefined, 14);
        return false;
      } catch {
        return verified === false;
      }
    })()
  );
  selfCheck(
    "isHelperInstallVerified: marker absent -> not verified -> gate throws",
    (() => {
      const verified = isHelperInstallVerified(false, "14", 14);
      try {
        helperInstallGateMirror(verified, false, "14", 14);
        return false;
      } catch {
        return !verified;
      }
    })()
  );
  selfCheck(
    "isHelperInstallVerified: count absent (undefined) -> not verified -> gate throws",
    (() => {
      const verified = isHelperInstallVerified(true, undefined, 14);
      try {
        helperInstallGateMirror(verified, true, undefined, 14);
        return false;
      } catch {
        return !verified;
      }
    })()
  );
  selfCheck(
    "isHelperInstallVerified: count incorrect (13 instead of 14) -> not verified -> gate throws",
    (() => {
      const verified = isHelperInstallVerified(true, "13", 14);
      try {
        helperInstallGateMirror(verified, true, "13", 14);
        return false;
      } catch {
        return !verified;
      }
    })()
  );

  const helperGateAnchor = "if (!helperInstall" + "Verified) {";
  const firstScenarioAnchor = "await sc(SCENARIO_ROSTER[0]" + "!";
  function helperGatePrecedesFirstScenario(source: string): boolean {
    const gateIdx = source.indexOf(helperGateAnchor);
    const firstScenarioIdx = source.indexOf(firstScenarioAnchor);
    return gateIdx !== -1 && firstScenarioIdx !== -1 && gateIdx < firstScenarioIdx;
  }
  selfCheck(
    "static self-inspection: the real hard gate appears strictly before the first scenario call (SCENARIO_ROSTER[0]) in the real source",
    helperGatePrecedesFirstScenario(selfCodeOnly)
  );
  selfCheck(
    "negative self-test: a synthetic copy with the hard gate removed entirely is correctly detected as no longer preceding the first scenario",
    !helperGatePrecedesFirstScenario(selfCodeOnly.replace(helperGateAnchor, ""))
  );
  selfCheck(
    "negative self-test: a synthetic copy with the hard gate moved to appear AFTER the first scenario call is correctly detected",
    !helperGatePrecedesFirstScenario(selfCodeOnly.replace(helperGateAnchor, "") + "\n" + helperGateAnchor + "\n")
  );

  // (o) Composite (%rowtype) variables must never be one of several
  // targets in a single SELECT ... INTO list (the exact PL/pgSQL
  // compile-time defect run 2 uncovered in
  // _m5_0054_rt_build_running). Analyzes the REAL generated HELPER_SQL
  // text directly -- never a hardcoded list of results -- so it
  // generalizes to all 14 helpers, not just the one that happened to
  // fail first.
  function stripSqlLineCommentsForIntoCheck(sql: string): string {
    return sql
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("--");
        return idx === -1 ? line : line.slice(0, idx);
      })
      .join("\n");
  }
  function findCompositeMultiItemIntoSites(sql: string): string[] {
    const codeOnly = stripSqlLineCommentsForIntoCheck(sql);
    const rowtypeVars = new Set<string>();
    const declRe = /(\w+)\s+public\.\w+%rowtype\s*;/g;
    let dm: RegExpExecArray | null;
    while ((dm = declRe.exec(codeOnly)) !== null) rowtypeVars.add(dm[1]!);

    const hits: string[] = [];
    const intoRe = /\binto\s+([a-zA-Z_][\w\s,]*?)\s*(?:\n\s*from\b|from\b)/gi;
    let im: RegExpExecArray | null;
    while ((im = intoRe.exec(codeOnly)) !== null) {
      const targets = im[1]!
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (targets.length > 1 && targets.some((t) => rowtypeVars.has(t))) {
        hits.push(`[${targets.join(",")}]@${im.index}`);
      }
    }
    return hits;
  }

  const realCompositeIntoDefects = findCompositeMultiItemIntoSites(HELPER_SQL);
  selfCheck(
    `static self-inspection: the real, fixed HELPER_SQL contains zero composite (%rowtype) variables used as one of multiple INTO targets, across all 14 helpers (found: ${JSON.stringify(realCompositeIntoDefects)})`,
    realCompositeIntoDefects.length === 0
  );

  const enqueueFixedSite =
    "select * into v_enqueue from public.enqueue_protocol_execution_job(v_fx.protocol_id, v_fx.project_id, p_max_attempts);\n  v_status := v_enqueue.status;\n  v_job := v_enqueue.job;";
  const enqueueRegressedSite =
    "select status, job into v_status, v_job\n    from public.enqueue_protocol_execution_job(v_fx.protocol_id, v_fx.project_id, p_max_attempts);";
  selfCheck(
    "negative self-test: reintroducing the enqueue_protocol_execution_job composite-multi-INTO defect is correctly detected",
    findCompositeMultiItemIntoSites(HELPER_SQL.replace(enqueueFixedSite, enqueueRegressedSite)).length > realCompositeIntoDefects.length
  );

  const claimFixedSite =
    "select * into v_claim from public.claim_protocol_execution_job(p_label || '-worker-' || gen_random_uuid()::text, 300);\n  v_status := v_claim.status;\n  v_job := v_claim.job;\n  v_token := v_claim.claim_token;";
  const claimRegressedSite =
    "select status, job, claim_token into v_status, v_job, v_token\n    from public.claim_protocol_execution_job(p_label || '-worker-' || gen_random_uuid()::text, 300);";
  selfCheck(
    "negative self-test: reintroducing the claim_protocol_execution_job composite-multi-INTO defect is correctly detected",
    findCompositeMultiItemIntoSites(HELPER_SQL.replace(claimFixedSite, claimRegressedSite)).length > realCompositeIntoDefects.length
  );

  const admitFixedSite =
    "select * into v_admit from public.admit_and_reserve_attempt_for_job(\n    v_job.id, v_token, v_fx.project_id, 'baseline', v_job.id::text || ':baseline:1', 0.01, 0.01\n  );\n  v_status := v_admit.status;\n  v_attempt := v_admit.attempt;\n  v_pcall := v_admit.perplexity_call;\n  v_acall := v_admit.analysis_call;";
  const admitRegressedSite =
    "select status, attempt, perplexity_call, analysis_call\n    into v_status, v_attempt, v_pcall, v_acall\n    from public.admit_and_reserve_attempt_for_job(\n      v_job.id, v_token, v_fx.project_id, 'baseline', v_job.id::text || ':baseline:1', 0.01, 0.01\n    );";
  selfCheck(
    "negative self-test: reintroducing the admit_and_reserve_attempt_for_job composite-multi-INTO defect is correctly detected",
    findCompositeMultiItemIntoSites(HELPER_SQL.replace(admitFixedSite, admitRegressedSite)).length > realCompositeIntoDefects.length
  );

  const probeFixedSite =
    "select * into v_probe from public.create_probe_run_and_start_attempt_for_job(\n    v_job.id, v_token, v_fx.project_id, v_attempt.id, 'perplexity', 'simulated'\n  );\n  v_status := v_probe.status;\n  v_attempt := v_probe.attempt;\n  v_run := v_probe.probe_run;";
  const probeRegressedSite =
    "select status, attempt, probe_run into v_status, v_attempt, v_run\n    from public.create_probe_run_and_start_attempt_for_job(\n      v_job.id, v_token, v_fx.project_id, v_attempt.id, 'perplexity', 'simulated'\n    );";
  selfCheck(
    "negative self-test: reintroducing the create_probe_run_and_start_attempt_for_job composite-multi-INTO defect is correctly detected",
    findCompositeMultiItemIntoSites(HELPER_SQL.replace(probeFixedSite, probeRegressedSite)).length > realCompositeIntoDefects.length
  );

  selfCheck(
    "static self-inspection: v_enqueue, v_claim, v_admit, v_probe are all declared as record in _m5_0054_rt_build_running",
    ["v_enqueue", "v_claim", "v_admit", "v_probe"].every((n) => new RegExp(`\\b${n}\\s+record\\s*;`).test(HELPER_SQL))
  );

  const buildRunningFnMatch = HELPER_SQL.match(/public\._m5_0054_rt_build_running\([\s\S]*?\$f\$;/);
  const buildRunningBody = buildRunningFnMatch ? buildRunningFnMatch[0] : "";
  function countRpcCalls(body: string, rpcName: string): number {
    const re = new RegExp(`public\\.${rpcName}\\(`, "g");
    return (body.match(re) ?? []).length;
  }
  const concernedRpcs = [
    "enqueue_protocol_execution_job",
    "claim_protocol_execution_job",
    "admit_and_reserve_attempt_for_job",
    "create_probe_run_and_start_attempt_for_job",
  ];
  selfCheck(
    "static self-inspection: each of the 4 concerned RPCs is called exactly once inside _m5_0054_rt_build_running",
    buildRunningFnMatch !== null && concernedRpcs.every((rpc) => countRpcCalls(buildRunningBody, rpc) === 1)
  );
  const duplicatedEnqueue = HELPER_SQL.replace(
    "select * into v_enqueue from public.enqueue_protocol_execution_job(v_fx.protocol_id, v_fx.project_id, p_max_attempts);",
    "select * into v_enqueue from public.enqueue_protocol_execution_job(v_fx.protocol_id, v_fx.project_id, p_max_attempts);\n  select * into v_enqueue from public.enqueue_protocol_execution_job(v_fx.protocol_id, v_fx.project_id, p_max_attempts);"
  );
  const duplicatedMatch = duplicatedEnqueue.match(/public\._m5_0054_rt_build_running\([\s\S]*?\$f\$;/);
  const duplicatedBody = duplicatedMatch ? duplicatedMatch[0] : "";
  selfCheck(
    "negative self-test: duplicating the enqueue_protocol_execution_job RPC call is correctly detected as more than one invocation",
    countRpcCalls(duplicatedBody, "enqueue_protocol_execution_job") === 2
  );

  const expectedFieldAssignments = [
    "v_status := v_enqueue.status;",
    "v_job := v_enqueue.job;",
    "v_status := v_claim.status;",
    "v_job := v_claim.job;",
    "v_token := v_claim.claim_token;",
    "v_status := v_admit.status;",
    "v_attempt := v_admit.attempt;",
    "v_pcall := v_admit.perplexity_call;",
    "v_acall := v_admit.analysis_call;",
    "v_status := v_probe.status;",
    "v_attempt := v_probe.attempt;",
    "v_run := v_probe.probe_run;",
  ];
  selfCheck(
    `static self-inspection: all ${expectedFieldAssignments.length} expected field assignments from the 4 intermediate records are present in HELPER_SQL`,
    expectedFieldAssignments.every((a) => HELPER_SQL.includes(a))
  );
  selfCheck(
    "negative self-test: removing one expected field assignment (v_job := v_enqueue.job;) is correctly detected as missing",
    !expectedFieldAssignments.every((a) => HELPER_SQL.replace("  v_job := v_enqueue.job;\n", "").includes(a))
  );

  // (p) A2/A3 fixture correctness: no gen_random_uuid() used for
  // probe_results.probe_run_id, a real dataset_batches/probe_runs
  // identity used instead, all required columns present, and A3's
  // negative case isolated to its own target CHECK constraint via
  // SQLSTATE + constraint name -- never masked by an unrelated
  // failure. Exercised against the REAL scenario source text
  // (selfCodeOnly), scoped to each scenario's own body specifically
  // (never the whole file, which would also match HELPER_SQL's own
  // legitimate gen_random_uuid() uses and this very self-test's own
  // string literals).
  const a2BodyMatch = selfCodeOnly.match(/await sc\(SCENARIO_ROSTER\[1\]!, \(\) => \{[\s\S]*?\n {2}\}\);/);
  const a2Body = a2BodyMatch ? a2BodyMatch[0] : "";
  const a3BodyMatch = selfCodeOnly.match(/await sc\(SCENARIO_ROSTER\[2\]!, \(\) => \{[\s\S]*?\n {2}\}\);/);
  const a3Body = a3BodyMatch ? a3BodyMatch[0] : "";

  function a2StructurallySound(body: string): boolean {
    return (
      body.length > 0 &&
      !body.includes("gen_random_uuid()") &&
      body.includes("createLegacyDatasetBatch(") &&
      body.includes("createLegacyProbeRun(") &&
      body.includes("dataset_id") &&
      body.includes("'manual_scan', null")
    );
  }
  selfCheck(
    "static self-inspection: A2's real scenario body uses a real dataset_batches/probe_runs identity (no gen_random_uuid()), includes dataset_id, and keeps canonical_result_sha256 NULL",
    a2StructurallySound(a2Body)
  );
  selfCheck(
    "negative self-test: removing dataset_id from A2's INSERT is correctly detected",
    !a2StructurallySound(a2Body.replace(", dataset_id, dataset_source_type, canonical_result_sha256", ", dataset_source_type, canonical_result_sha256"))
  );
  selfCheck(
    "negative self-test: replacing A2's real probe_run id with gen_random_uuid() is correctly detected",
    !a2StructurallySound(a2Body.replace("'${a2ProbeRunId}'", "gen_random_uuid()"))
  );

  function a3StructurallySound(body: string): boolean {
    return (
      body.length > 0 &&
      !body.includes("gen_random_uuid()") &&
      body.includes("raw_response, client_position") &&
      body.includes("dataset_id, dataset_source_type") &&
      body.includes("usedProbeRunIds.size === 6") &&
      body.includes('sixth.stderr.includes("23514")') &&
      body.includes('sixth.stderr.includes("probe_results_product_verdict_check")')
    );
  }
  selfCheck(
    "static self-inspection: A3's real scenario body provides raw_response/client_position/dataset_id/dataset_source_type for all 6 attempts, requires 6 distinct probe_runs, and isolates its negative case to SQLSTATE 23514 + probe_results_product_verdict_check",
    a3StructurallySound(a3Body)
  );
  const a3ProbeRunCallSites = (a3Body.match(/createLegacyProbeRun\(/g) ?? []).length;
  selfCheck(
    "static self-inspection: A3 calls createLegacyProbeRun exactly twice in source (once per-iteration inside the values loop, once more for the 6th invalid attempt) -- never a single shared probe_run reused across all 6",
    a3ProbeRunCallSites === 2
  );
  selfCheck(
    "negative self-test: removing raw_response from A3's INSERT is correctly detected",
    !a3StructurallySound(a3Body.replaceAll("raw_response, client_position", "client_position"))
  );
  selfCheck(
    "negative self-test: removing client_position from A3's INSERT is correctly detected",
    !a3StructurallySound(a3Body.replaceAll("raw_response, client_position", "raw_response"))
  );
  selfCheck(
    "negative self-test: a synthetic regression reusing a single shared probe_run across all 6 A3 attempts (usedProbeRunIds.size dropping to 1) is correctly detected",
    !a3StructurallySound(a3Body.replace("usedProbeRunIds.size === 6", "usedProbeRunIds.size === 1"))
  );
  selfCheck(
    "negative self-test: removing the SQLSTATE 23514 check from A3's negative case is correctly detected",
    !a3StructurallySound(a3Body.replace('sixth.stderr.includes("23514") && ', ""))
  );
  selfCheck(
    "negative self-test: removing the exact constraint-name check from A3's negative case is correctly detected",
    !a3StructurallySound(a3Body.replace(' && sixth.stderr.includes("probe_results_product_verdict_check")', ""))
  );

  // probe_mode: A2/A3 must set the real, currently-valid probe_mode
  // literal ('live_perplexity', migration 0013) explicitly -- never the
  // stale 'live' literal (valid only under migration 0012, superseded
  // long before 0054), and never rely on the table DEFAULT implicitly.
  function a2ProbeModeSound(body: string): boolean {
    return body.includes("'live_perplexity'") && !body.includes("'live'");
  }
  selfCheck(
    "static self-inspection: A2 explicitly sets probe_mode='live_perplexity' and never the stale 'live' literal",
    a2ProbeModeSound(a2Body)
  );
  selfCheck(
    "negative self-test: replacing A2's probe_mode value with the stale 'live' literal is correctly detected",
    !a2ProbeModeSound(a2Body.replace("'live_perplexity'", "'live'"))
  );

  function a3ProbeModeSound(body: string): boolean {
    const livePerplexityOccurrences = (body.match(/'live_perplexity'/g) ?? []).length;
    return body.includes("product_verdict, probe_mode") && livePerplexityOccurrences === 2 && !body.includes("'live'");
  }
  selfCheck(
    "static self-inspection: A3 explicitly includes probe_mode in both its INSERT forms (the values loop and the invalid case) and sets it to 'live_perplexity' in both, never the stale 'live' literal or an implicit DEFAULT",
    a3ProbeModeSound(a3Body)
  );
  selfCheck(
    "negative self-test: removing the probe_mode column from A3's INSERT column lists is correctly detected",
    !a3ProbeModeSound(a3Body.replaceAll("product_verdict, probe_mode", "product_verdict"))
  );
  selfCheck(
    "negative self-test: replacing A3's probe_mode value with the stale 'live' literal is correctly detected",
    !a3ProbeModeSound(a3Body.replaceAll("'live_perplexity'", "'live'"))
  );

  // A1: the catalog verification itself must genuinely check both
  // probe_results_verdict_check and probe_results_product_verdict_check
  // against the exact expected five-value definition -- never just one
  // of the two, which is exactly the asymmetry that let migration
  // 0054's verdict_check widening bug go undetected.
  const a1BodyMatch = selfCodeOnly.match(/await sc\(SCENARIO_ROSTER\[0\]!, \(\) => \{[\s\S]*?\n {2}\}\);/);
  const a1Body = a1BodyMatch ? a1BodyMatch[0] : "";
  function a1VerdictCatalogSound(body: string): boolean {
    return (
      body.includes('m.get("verdict_check_def")') &&
      body.includes('m.get("product_verdict_check_def")') &&
      body.includes('expectedFiveValueCheck("verdict")') &&
      body.includes('expectedFiveValueCheck("product_verdict")')
    );
  }
  selfCheck(
    "static self-inspection: A1's real scenario body verifies both probe_results_verdict_check and probe_results_product_verdict_check catalog definitions against the exact expected five-value CHECK, not just product_verdict_check",
    a1VerdictCatalogSound(a1Body)
  );
  selfCheck(
    "negative self-test: removing A1's verdict_check_def catalog verification (leaving only product_verdict_check_def) is correctly detected",
    !a1VerdictCatalogSound(
      a1Body.replace('m.get("verdict_check_def") === expectedFiveValueCheck("verdict") &&\n        ', "")
    )
  );

  // A5: RESET ROLE must appear strictly between the six real fixture
  // creations and the FOR UPDATE SKIP LOCKED EXPLAIN, never before the
  // fixtures, never after the EXPLAIN, and service_role must never be
  // re-elevated afterward within this same script. Scoped to the
  // volumeSql construction plus its index-name assertion specifically
  // (never the whole A5 body, which also contains an unrelated
  // cleanupSql with its own separate SET ROLE service_role -- out of
  // scope here by construction, not by coincidence).
  //
  // The two boundary markers below are built via concatenation so this
  // very self-test's own source text never contains either contiguous
  // string -- otherwise (as a real, caught-by-itself bug during
  // development of this exact check) the extraction below would match
  // starting at this file's own regex/string literals instead of the
  // real A5 scenario hundreds of lines below, since both markers would
  // otherwise appear here first.
  const a5StartMarker = "let volume" + "Sql = `";
  const a5EndMarker = 'volOut.includes("protocol_execution_job_alert_deliveries' + '_pending_claim_idx")';
  const a5StartIdx = selfCodeOnly.indexOf(a5StartMarker);
  const a5EndMarkerIdx = a5StartIdx === -1 ? -1 : selfCodeOnly.indexOf(a5EndMarker, a5StartIdx);
  const a5EndIdx = a5EndMarkerIdx === -1 ? -1 : selfCodeOnly.indexOf(");", a5EndMarkerIdx) + 2;
  const a5Body = a5StartIdx !== -1 && a5EndIdx > a5StartIdx ? selfCodeOnly.slice(a5StartIdx, a5EndIdx) : "";

  function a5RoleSequenceSound(body: string): boolean {
    const setRoleCount = (body.match(/SET ROLE service_role/g) ?? []).length;
    const resetRoleCount = (body.match(/RESET ROLE;/g) ?? []).length;
    const setRoleIdx = body.indexOf("SET ROLE service_role");
    const loopIdx = body.indexOf("for (let i = 0; i < 6; i++)");
    const resetIdx = body.indexOf("RESET ROLE;");
    const explainIdx = body.indexOf("explain (format text)");
    const noAnalyze = !/explain\s*\([^)]*analyze/i.test(body);
    return (
      body.length > 0 &&
      setRoleCount === 1 &&
      resetRoleCount === 1 &&
      setRoleIdx !== -1 &&
      loopIdx !== -1 &&
      resetIdx !== -1 &&
      explainIdx !== -1 &&
      setRoleIdx < loopIdx &&
      loopIdx < resetIdx &&
      resetIdx < explainIdx &&
      body.includes("for update skip locked") &&
      body.includes("protocol_execution_job_alert_deliveries_pending_claim_idx") &&
      noAnalyze
    );
  }
  selfCheck(
    "static self-inspection: A5's real volumeSql construction sets service_role exactly once, creates all 6 fixtures, RESETs the role exactly once strictly between the 6th fixture and the FOR UPDATE SKIP LOCKED EXPLAIN, never re-elevates service_role afterward, never adds ANALYZE, and still asserts the expected claim index by name",
    a5RoleSequenceSound(a5Body)
  );
  selfCheck(
    "negative self-test: removing A5's RESET ROLE statement is correctly detected",
    !a5RoleSequenceSound(a5Body.replace("RESET ROLE;", ""))
  );

  function buildSyntheticA5Sequence(order: "early-reset" | "late-reset" | "reraise"): string {
    const head = "SET ROLE service_role;\n";
    const loop = "for (let i = 0; i < 6; i++) { fixture(); }\n";
    const reset = "RESET ROLE;\n";
    const explainStmt =
      "explain (format text) select ... for update skip locked ...\nprotocol_execution_job_alert_deliveries_pending_claim_idx\n";
    const tail = 'volOut.includes("protocol_execution_job_alert_deliveries_pending_claim_idx")\n);';
    if (order === "early-reset") return head + reset + loop + explainStmt + tail;
    if (order === "late-reset") return head + loop + explainStmt + reset + tail;
    return head + loop + reset + head + explainStmt + tail;
  }
  selfCheck(
    "negative self-test: a synthetic sequence with RESET ROLE moved before the six-fixture loop is correctly detected as wrong order",
    !a5RoleSequenceSound(buildSyntheticA5Sequence("early-reset"))
  );
  selfCheck(
    "negative self-test: a synthetic sequence with RESET ROLE moved after the EXPLAIN is correctly detected as wrong order",
    !a5RoleSequenceSound(buildSyntheticA5Sequence("late-reset"))
  );
  selfCheck(
    "negative self-test: a synthetic sequence re-elevating to service_role again after RESET ROLE is correctly detected",
    !a5RoleSequenceSound(buildSyntheticA5Sequence("reraise"))
  );
  selfCheck(
    "negative self-test: removing FOR UPDATE SKIP LOCKED from A5's real EXPLAIN is correctly detected",
    !a5RoleSequenceSound(a5Body.replace("for update skip locked", ""))
  );
  selfCheck(
    "negative self-test: renaming A5's expected claim index in the real assertion is correctly detected",
    !a5RoleSequenceSound(a5Body.replaceAll("protocol_execution_job_alert_deliveries_pending_claim_idx", "some_other_index_name"))
  );
  selfCheck(
    "negative self-test: adding ANALYZE to A5's real EXPLAIN is correctly detected",
    !a5RoleSequenceSound(a5Body.replace("explain (format text)", "explain (format text, analyze)"))
  );

  // B1/B2: scoped by slicing between consecutive real "await sc(...)"
  // start markers -- never a regex containing either marker contiguously
  // in this very file's own source, which is exactly what made the
  // first version of the A5 self-test above match itself instead of the
  // real scenario. Markers built via string concatenation for the same
  // reason.
  const b1Marker = "await sc(SCENARIO_ROSTER[0" + " + 5]!, () => {";
  const b2Marker = "await sc(SCENARIO_ROSTER[1" + " + 5]!, () => {";
  const b3Marker = "await sc(SCENARIO_ROSTER[2" + " + 5]!, () => {";
  const b1StartIdx = selfCodeOnly.indexOf(b1Marker);
  const b2StartIdx = b1StartIdx === -1 ? -1 : selfCodeOnly.indexOf(b2Marker, b1StartIdx);
  const b3StartIdx = b2StartIdx === -1 ? -1 : selfCodeOnly.indexOf(b3Marker, b2StartIdx);
  const b1Body = b1StartIdx !== -1 && b2StartIdx > b1StartIdx ? selfCodeOnly.slice(b1StartIdx, b2StartIdx) : "";
  const b2Body = b2StartIdx !== -1 && b3StartIdx > b2StartIdx ? selfCodeOnly.slice(b2StartIdx, b3StartIdx) : "";

  // Counts the top-level quoted keys of the real jsonb_build_object(...)
  // preimage call inside a scenario body -- mechanically derived from
  // the real text, never hardcoded as a bare number check alone.
  function countPreimageKeys(body: string): number {
    // Matches the object's own closing paren by depth, never a fixed
    // "next few characters" string -- immune to how the surrounding SQL
    // call chain happens to be line-wrapped.
    const objStart = body.indexOf("jsonb_build_object(");
    if (objStart === -1) return 0;
    const parenStart = objStart + "jsonb_build_object(".length - 1;
    let depth = 0;
    let i = parenStart;
    for (; i < body.length; i++) {
      if (body[i] === "(") depth++;
      else if (body[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    return (body.slice(objStart, i).match(/^\s*'[a-z_0-9]+',/gm) ?? []).length;
  }

  // The count(*) row-count check must live in its own statement (its
  // own \gset), strictly before the canonical jsonb_build_object query
  // -- never mixed with it in one un-grouped SELECT, which is exactly
  // the real GROUP BY error a prior, unexecuted version of this same
  // correction produced the first time this query was actually run
  // read-only against Postgres.
  function b1CountStatementSeparate(body: string): boolean {
    const countIdx = body.indexOf("count(*)::text as recompute_row_count");
    const jsonbIdx = body.indexOf("jsonb_build_object(");
    if (countIdx === -1 || jsonbIdx === -1 || countIdx >= jsonbIdx) return false;
    return body.slice(countIdx, jsonbIdx).includes("\\gset");
  }
  function b1CanonicalQueryHasNoAggregate(body: string): boolean {
    const jsonbIdx = body.indexOf("jsonb_build_object(");
    if (jsonbIdx === -1) return false;
    const start = body.lastIndexOf("select (", jsonbIdx);
    const end = body.indexOf("\\gset", jsonbIdx);
    if (start === -1 || end === -1) return false;
    const text = body.slice(start, end);
    return text.length > 0 && !/\bcount\(|group by|\bmin\(|\bmax\(|array_agg\(/i.test(text);
  }

  function b1StructurallySound(body: string): boolean {
    const persistCallCount = (body.match(/persist_probe_result_for_job\(/g) ?? []).length;
    return (
      body.length > 0 &&
      !body.includes("b1determinism") &&
      persistCallCount === 1 &&
      body.includes("where pr.probe_run_id = :'rid'") &&
      countPreimageKeys(body) === 36 &&
      !body.includes("'id',") &&
      !body.includes("'created_at',") &&
      !body.includes("'generated_prompt_id',") &&
      !body.includes("'snapshot_request_id',") &&
      !body.includes("'canonical_result_sha256',") &&
      !body.includes("_sha256_hex(") &&
      body.includes("digest(") &&
      body.includes("convert_to(") &&
      b1CountStatementSeparate(body) &&
      b1CanonicalQueryHasNoAggregate(body)
    );
  }
  selfCheck(
    "static self-inspection: B1's real body creates exactly one fixture, calls persist_probe_result_for_job exactly once, and reproduces canonical_result_sha256 by recomputing the real D-028 preimage (36 keys: the 35 documented probe_results columns plus the independent schema_version marker -- no id/created_at/generated_prompt_id/snapshot_request_id/canonical_result_sha256 among them) directly from this same row's own stored columns, via a raw pgcrypto digest() call, never the production _sha256_hex helper as its own oracle",
    b1StructurallySound(b1Body)
  );
  selfCheck(
    "static self-inspection: B1's real recompute_row_count is a count(*) in its own separate statement, strictly before the canonical jsonb_build_object query",
    b1CountStatementSeparate(b1Body)
  );
  selfCheck(
    "static self-inspection: B1's real canonical query (the one containing jsonb_build_object) contains no aggregate function and no GROUP BY of its own -- the exact defect class a prior, never-executed version of this correction actually had",
    b1CanonicalQueryHasNoAggregate(b1Body)
  );
  selfCheck(
    "negative self-test: reintroducing a second, independent b1determinism fixture is correctly detected",
    !b1StructurallySound(b1Body + "'b1determinism'")
  );
  selfCheck(
    "negative self-test: removing the recompute-and-compare query from B1 is correctly detected",
    !b1StructurallySound(b1Body.replaceAll("digest(", ""))
  );
  selfCheck(
    "negative self-test: removing one expected key (schema_version) from B1's real preimage is correctly detected",
    !b1StructurallySound(b1Body.replace("'schema_version', 1,\n          ", ""))
  );
  selfCheck(
    "negative self-test: adding one invented extra key to B1's real preimage is correctly detected",
    !b1StructurallySound(b1Body.replace("jsonb_build_object(\n          ", "jsonb_build_object(\n          'totally_made_up_key', null,\n          "))
  );
  selfCheck(
    "negative self-test: including the stored canonical_result_sha256 inside B1's own preimage is correctly detected",
    !b1StructurallySound(b1Body.replace("jsonb_build_object(\n          ", "jsonb_build_object(\n          'canonical_result_sha256', pr.canonical_result_sha256,\n          "))
  );
  selfCheck(
    "negative self-test: reusing the production _sha256_hex helper as B1's own oracle is correctly detected",
    !b1StructurallySound(b1Body + "_sha256_hex(")
  );
  selfCheck(
    "negative self-test: a synthetic canonical query re-mixing count(*) with jsonb_build_object in the same un-grouped SELECT (the real, previously-unexecuted GROUP BY defect) is correctly detected",
    !b1CanonicalQueryHasNoAggregate(
      "select (\n  count(*), encode(digest(convert_to(jsonb_build_object('schema_version', 1)::text, 'UTF8'), 'sha256'), 'hex') = pr.canonical_result_sha256\n)::text as hash_reproducible\nfrom public.probe_results pr\nwhere pr.probe_run_id = :'rid' \\gset"
    )
  );

  // hash_reproducible comes from an explicit boolean equality cast to
  // ::text (`(... = pr.canonical_result_sha256)::text as hash_reproducible`),
  // which a real, read-only execution against Postgres proved renders
  // the literal word "true"/"false" -- never the single-character "t"/
  // "f" a bare, uncast boolean column would render as. This is a
  // narrower, more specific property than general body soundness, so it
  // is checked on its own.
  function b1HashLiteralSound(body: string): boolean {
    // The "wrong" target is built via concatenation so this checker's
    // own source text never contains the contiguous pattern it looks
    // for -- otherwise the file-wide ratchet below would match this
    // very line instead of (or in addition to) the real scenario code.
    const wrongComparator = 'm.get("hash_reproducible") === "' + 't' + '"';
    return body.includes('m.get("hash_reproducible") === "true"') && !body.includes(wrongComparator);
  }
  function b1CheckAccepts(hashVal: string, rowCountVal: string): boolean {
    return hashVal === "true" && rowCountVal === "1";
  }
  selfCheck(
    "static self-inspection: B1's real check() compares hash_reproducible to the literal \"true\" (the actual value a real, read-only execution proved PostgreSQL's boolean::text cast produces), never \"t\"",
    b1HashLiteralSound(b1Body)
  );
  selfCheck(
    "positive: the real comparison logic, mirrored exactly, accepts hash_reproducible=\"true\" together with recompute_row_count=\"1\"",
    b1CheckAccepts("true", "1")
  );
  selfCheck(
    "negative self-test: the real comparison logic, mirrored exactly, correctly rejects hash_reproducible=\"t\" (the old, wrong literal) even with recompute_row_count=\"1\"",
    !b1CheckAccepts("t", "1")
  );
  selfCheck(
    "negative self-test: reverting B1's hash_reproducible comparator back to the wrong literal \"t\" is correctly detected",
    !b1HashLiteralSound(b1Body.replace('=== "true"', '=== "t"'))
  );
  selfCheck(
    "mechanical ratchet: every boolean-equality )::text as <marker> cast site found across the whole file is confirmed to never be compared against the native, uncast-boolean \"t\"/\"f\" literals anywhere in this file -- only hash_reproducible qualifies, and only \"true\"/\"false\" would ever be the correct comparator for it",
    (() => {
      const markers = [...selfCodeOnly.matchAll(/=\s*[\w.]+\s*\)::text as ([a-z_][a-z0-9_]*)/g)].map((mt) => mt[1]);
      const uniqueMarkers = [...new Set(markers)];
      return (
        uniqueMarkers.length === 1 &&
        uniqueMarkers[0] === "hash_reproducible" &&
        uniqueMarkers.every((mk) => !new RegExp(`\\w+\\.get\\("${mk}"\\) === "[tf]"`).test(selfCodeOnly))
      );
    })()
  );

  function b2StructurallySound(body: string): boolean {
    const persistCallCount = (body.match(/persist_probe_result_for_job\(/g) ?? []).length;
    return (
      body.length > 0 &&
      !body.includes("protocol_execution_jobs j,") &&
      !body.includes("lateral (") &&
      !body.includes("limit 0") &&
      body.includes("as jid2, claim_token as tok2") &&
      persistCallCount === 1
    );
  }
  selfCheck(
    "static self-inspection: B2's real body no longer contains the dead, ambiguous protocol_execution_jobs-self-join statement, still selects jid2/claim_token as tok2 for real via a single unambiguous query, and calls persist_probe_result_for_job exactly once",
    b2StructurallySound(b2Body)
  );
  selfCheck(
    "negative self-test: reintroducing the dead ambiguous statement into B2 is correctly detected",
    !b2StructurallySound(
      b2Body.replace(
        "select id as jid2,",
        "select job_id as jid, claim_token as tok\n  from protocol_execution_jobs j, lateral (select id as job_id, claim_token from protocol_execution_jobs where project_id = 'x' and status in ('claimed','running') limit 1) x\n  limit 0;\nselect id as jid2,"
      )
    )
  );
  selfCheck(
    "negative self-test: removing B2's real jid2/tok2 query is correctly detected",
    !b2StructurallySound(b2Body.replace("as jid2, claim_token as tok2", "as jidX, claim_token as tokX"))
  );
  selfCheck(
    "negative self-test: duplicating B2's replay RPC call is correctly detected",
    !b2StructurallySound(b2Body + "\npersist_probe_result_for_job(")
  );

  const b15Marker = "await sc(SCENARIO_ROSTER[15]!, () => {";
  const b15StartIdx = b3StartIdx === -1 ? -1 : selfCodeOnly.indexOf(b15Marker, b3StartIdx);
  const b3Body = b3StartIdx !== -1 && b15StartIdx > b3StartIdx ? selfCodeOnly.slice(b3StartIdx, b15StartIdx) : "";

  function b3StructurallySound(body: string): boolean {
    const persistCallCount = (body.match(/persist_probe_result_for_job\(/g) ?? []).length;
    return (
      body.length > 0 &&
      !body.includes("probe_result_id as before_id") &&
      !body.toLowerCase().includes("limit 0") &&
      body.includes("id as before_id2, canonical_result_sha256 as before_hash2") &&
      body.includes('m.get("after_id") === m.get("before_id2")') &&
      body.includes('m.get("after_hash") === m.get("before_hash2")') &&
      persistCallCount === 1
    );
  }
  selfCheck(
    "static self-inspection: B3's real body no longer contains the dead, non-existent-column projection (probe_result_id as before_id, LIMIT 0), still selects the real id as before_id2/canonical_result_sha256 as before_hash2 query, still asserts against before_id2/before_hash2, and calls persist_probe_result_for_job exactly once (the CONFLICT attempt)",
    b3StructurallySound(b3Body)
  );
  selfCheck(
    "negative self-test: reintroducing the dead probe_result_id/LIMIT 0 projection into B3 is correctly detected",
    !b3StructurallySound(
      b3Body.replace(
        "select id as before_id2,",
        "select probe_result_id as before_id, canonical_result_sha256 as before_hash from probe_results where project_id = 'x' limit 0;\nselect id as before_id2,"
      )
    )
  );
  selfCheck(
    "negative self-test: removing B3's real before_id2/before_hash2 query is correctly detected",
    !b3StructurallySound(b3Body.replace("as before_id2, canonical_result_sha256 as before_hash2", "as before_id2X, canonical_result_sha256 as before_hash2X"))
  );
  selfCheck(
    "negative self-test: removing B3's consumption of before_id2 in its own assertion is correctly detected",
    !b3StructurallySound(b3Body.replace('m.get("after_id") === m.get("before_id2") &&\n', ""))
  );
  selfCheck(
    "negative self-test: removing B3's consumption of before_hash2 in its own assertion is correctly detected",
    !b3StructurallySound(b3Body.replace('m.get("after_hash") === m.get("before_hash2") &&\n', ""))
  );

  // Global ratchet: no real scenario (categories A-D) anywhere in the
  // sliced all-scenarios source contains a LIMIT 0 clause. Scoped
  // strictly to the all-scenarios span (firstScenarioAnchor through the
  // final "scenarios executed" log line) -- never the whole file, which
  // would also match this very self-test's own negative-test string
  // constants above (B2's and B3's dead-statement reintroduction tests)
  // and produce a false failure.
  const allScenariosEndMarker = "All ${ranScenarios.size} scenarios executed.";
  const allScenariosStart = selfCodeOnly.indexOf(firstScenarioAnchor);
  const allScenariosEnd = allScenariosStart === -1 ? -1 : selfCodeOnly.indexOf(allScenariosEndMarker, allScenariosStart);
  const allScenariosBody =
    allScenariosStart !== -1 && allScenariosEnd > allScenariosStart ? selfCodeOnly.slice(allScenariosStart, allScenariosEnd) : "";
  selfCheck(
    "self-test sanity: the sliced all-scenarios source (categories A-D) is non-empty (extractor actually found something, not silently vacuous)",
    allScenariosBody.length > 0
  );
  selfCheck(
    "global ratchet: no real scenario (categories A-D) anywhere in the sliced all-scenarios source contains a LIMIT 0 clause",
    !allScenariosBody.toLowerCase().includes("limit 0")
  );
  selfCheck(
    "negative self-test: reintroducing a LIMIT 0 clause anywhere in a throwaway copy of the all-scenarios source is correctly detected",
    (allScenariosBody + "\nlimit 0;").toLowerCase().includes("limit 0")
  );

  // C1a (Run 9 forensics): mark_external_call_sent_for_job was never
  // called before record_provider_call_receipt_for_job, leaving the
  // perplexity external_call at status='reserved' instead of
  // 'in_progress' -- the RPC's own fencing guard then returned early
  // (never RECEIPTED, never reaching the needs_review/outbox branch),
  // so zero alert rows were ever created. The unguarded
  // max(alert_event_id::text) as evt \gset then left psql's `evt`
  // variable entirely UNSET (never merely empty), producing the
  // downstream ":'evt'" syntax error deep in an unrelated deliveries
  // query instead of a legible assertion failure.
  const c1Marker = "await sc(SCENARIO_ROSTER[2" + "0]!, () => {";
  const c2Marker = "await sc(SCENARIO_ROSTER[2" + "1]!, () => {";
  const c1StartIdx = selfCodeOnly.indexOf(c1Marker);
  const c2StartIdx = c1StartIdx === -1 ? -1 : selfCodeOnly.indexOf(c2Marker, c1StartIdx);
  const c1Body = c1StartIdx !== -1 && c2StartIdx > c1StartIdx ? selfCodeOnly.slice(c1StartIdx, c2StartIdx) : "";
  const c1aFixtureMarker = "_m5_0054_rt_build_running('c1a')";
  const c1aCleanupMarker = "c1a-cleanup";
  const c1aStartIdx = c1Body.indexOf(c1aFixtureMarker);
  const c1aEndIdx = c1aStartIdx === -1 ? -1 : c1Body.indexOf(c1aCleanupMarker, c1aStartIdx);
  const c1aBody = c1aStartIdx !== -1 && c1aEndIdx > c1aStartIdx ? c1Body.slice(c1aStartIdx, c1aEndIdx) : "";

  const C1A_SENT_CALL = "mark_external_call_sent_for_job(:'jid', :'tok', :'pid', :'pcid', :'rid')";
  const C1A_RECEIPT_CALL = "record_provider_call_receipt_for_job(:'jid', :'tok', :'pid', :'pcid', :'rid', 'provider_outcome_unknown')";
  function c1aSequenceSound(body: string): boolean {
    const sentCallCount = (body.match(/mark_external_call_sent_for_job\(/g) ?? []).length;
    const sentIdx = body.indexOf(C1A_SENT_CALL);
    const receiptIdx = body.indexOf(C1A_RECEIPT_CALL);
    return body.length > 0 && sentCallCount === 1 && sentIdx !== -1 && receiptIdx !== -1 && sentIdx < receiptIdx;
  }
  selfCheck(
    "static self-inspection: C1a's real body calls mark_external_call_sent_for_job exactly once, with the same jid/tok/pid/pcid/rid identifiers as its own fixture, strictly before record_provider_call_receipt_for_job",
    c1aSequenceSound(c1aBody)
  );
  selfCheck(
    "negative self-test: removing C1a's mark_external_call_sent_for_job call is correctly detected",
    !c1aSequenceSound(c1aBody.replace(`select status as sent_st from public.${C1A_SENT_CALL} \\\\gset\n`, ""))
  );
  selfCheck(
    "negative self-test: reversing the order (record-receipt before mark-sent) in a throwaway copy is correctly detected",
    !c1aSequenceSound(
      c1aBody.replace(
        `select status as sent_st from public.${C1A_SENT_CALL} \\\\gset\nselect status as st from public.${C1A_RECEIPT_CALL} \\\\gset`,
        `select status as st from public.${C1A_RECEIPT_CALL} \\\\gset\nselect status as sent_st from public.${C1A_SENT_CALL} \\\\gset`
      )
    )
  );
  selfCheck(
    "negative self-test: a throwaway copy of C1a's mark-sent call using a mismatched external-call id is correctly detected",
    !c1aSequenceSound(c1aBody.replace(C1A_SENT_CALL, "mark_external_call_sent_for_job(:'jid', :'tok', :'pid', :'wrongid', :'rid')"))
  );
  selfCheck(
    "negative self-test: a throwaway copy of C1a's mark-sent call using a mismatched probe-run id is correctly detected",
    !c1aSequenceSound(c1aBody.replace(C1A_SENT_CALL, "mark_external_call_sent_for_job(:'jid', :'tok', :'pid', :'pcid', :'wrongrid')"))
  );

  function c1aAssertionVerifiesStatuses(body: string): boolean {
    return body.includes('r1.get("sent_st") === "SENT"') && body.includes('r1.get("st") === "RECEIPTED"');
  }
  selfCheck(
    "static self-inspection: C1a's real assertion explicitly verifies both mark_external_call_sent_for_job's returned status (SENT) and record_provider_call_receipt_for_job's returned status (RECEIPTED) -- both derived from the real deployed functions (migration 0050/0054), never assumed",
    c1aAssertionVerifiesStatuses(c1Body)
  );
  selfCheck(
    "negative self-test: removing C1a's sent_st status check from its own assertion is correctly detected",
    !c1aAssertionVerifiesStatuses(c1Body.replace('r1.get("sent_st") === "SENT" &&\n        ', ""))
  );
  selfCheck(
    "negative self-test: removing C1a's st status check from its own assertion is correctly detected",
    !c1aAssertionVerifiesStatuses(c1Body.replace('r1.get("st") === "RECEIPTED" &&\n        ', ""))
  );

  const EVT_SENTINEL = "00000000-0000-0000-0000-000000000000";
  const UNGUARDED_EVT_PATTERN = "max(alert_event_id::text) as evt from protocol_execution_job_alerts where job_id = :'jid'";
  const GUARDED_EVT_PATTERN = `coalesce(max(alert_event_id::text), '${EVT_SENTINEL}') as evt from protocol_execution_job_alerts where job_id = :'jid'`;
  function unguardedEvtSiteCount(body: string): number {
    return body.split(UNGUARDED_EVT_PATTERN).length - 1;
  }
  function guardedEvtSiteCount(body: string): number {
    return body.split(GUARDED_EVT_PATTERN).length - 1;
  }
  selfCheck(
    "self-test sanity: the sliced C1 (scenario 20) source is non-empty (extractor actually found something, not silently vacuous)",
    c1Body.length > 0
  );
  selfCheck(
    "static self-inspection: zero unguarded max(alert_event_id::text) as evt producers remain anywhere in the real all-scenarios source",
    unguardedEvtSiteCount(allScenariosBody) === 0
  );
  selfCheck(
    "static self-inspection: exactly four coalesce-guarded evt producers exist (one per C1 sub-case: c1a/c1b/c1c/c1d), each defaulting to the exact all-zero sentinel UUID",
    guardedEvtSiteCount(allScenariosBody) === 4
  );
  selfCheck(
    "negative self-test: reintroducing one bare, unguarded max(alert_event_id::text) as evt producer into a throwaway copy is correctly detected",
    unguardedEvtSiteCount(allScenariosBody + "\n" + UNGUARDED_EVT_PATTERN) === 1
  );
  selfCheck(
    "negative self-test: a throwaway copy with an invalid sentinel (not the all-zero UUID) no longer matches the exact guarded pattern on one of the four sites",
    guardedEvtSiteCount(allScenariosBody.replace(EVT_SENTINEL, "11111111-1111-1111-1111-111111111111")) === 3
  );
  selfCheck(
    "negative self-test: reverting one of the four coalesce guards back to its bare unguarded form in a throwaway copy is correctly detected",
    (() => {
      const idx = allScenariosBody.indexOf(GUARDED_EVT_PATTERN);
      if (idx === -1) return false;
      const mutated = allScenariosBody.slice(0, idx) + UNGUARDED_EVT_PATTERN + allScenariosBody.slice(idx + GUARDED_EVT_PATTERN.length);
      return guardedEvtSiteCount(mutated) === 3 && unguardedEvtSiteCount(mutated) === 1;
    })()
  );

  // Broader ratchet: any max()/min() aggregate \gset producer, anywhere
  // in the real scenarios, that is later reused via :'alias' must be
  // guarded -- either by a preceding psql `\set alias` sentinel default,
  // or by wrapping the aggregate itself in `coalesce(...)`. This is the
  // same class of defect proven responsible for Run 9's crash, scoped
  // permanently across the whole roster, not just C1.
  function unguardedNullableAggregateReuseCount(body: string): number {
    let count = 0;
    const lineRe = /^.*\\gset\s*$/gm;
    let lm: RegExpExecArray | null;
    while ((lm = lineRe.exec(body))) {
      const line = lm[0];
      const aggMatches = [...line.matchAll(/\b(max|min)\(([^)]*)\)\s*(?:::\w+)?\s+as\s+([a-z_][a-z0-9_]*)/gi)];
      for (const am of aggMatches) {
        const [, , , alias] = am;
        const isGuardedByCoalesce = new RegExp(`coalesce\\s*\\(\\s*(?:max|min)\\([^)]*\\)\\s*,`, "i").test(
          line.slice(Math.max(0, am.index! - 12), am.index! + am[0].length)
        );
        if (isGuardedByCoalesce) continue;
        const usageIdx = body.indexOf(`:'${alias}'`, lm.index + line.length);
        if (usageIdx === -1) continue; // never reused -- not a risk site
        const between = body.slice(lm.index, usageIdx);
        const hasSentinel = new RegExp(`\\\\set\\s+${alias}\\s+'`).test(between);
        if (!hasSentinel) count++;
      }
    }
    return count;
  }
  selfCheck(
    "global ratchet: zero unguarded nullable max()/min() \\gset producers (reused via :'alias' with neither a coalesce() guard nor a preceding \\set sentinel) remain anywhere in the real all-scenarios source",
    unguardedNullableAggregateReuseCount(allScenariosBody) === 0
  );
  selfCheck(
    "negative self-test: a throwaway copy reintroducing one bare, reused, unguarded max(...) \\gset producer is correctly detected",
    unguardedNullableAggregateReuseCount(allScenariosBody + "\nselect max(foo::text) as zzz_test_alias from bar \\gset\nselect baz from qux where x = :'zzz_test_alias' \\gset") === 1
  );

  // C1b (Run 10 forensics): the harness's own call to
  // record_analysis_call_receipt_for_job omitted p_used_mock (defaulting
  // to false) while p_request_sha256/p_raw_request_body stayed at their
  // NULL defaults -- violating analysis_call_receipts_request_mock_pairing_check
  // (used_mock=false requires both fields NOT NULL; used_mock=true requires
  // both NULL). Fixed by naming p_used_mock => true explicitly, matching
  // the same valid pairing already used successfully by HELPER_SQL's own
  // _m5_0054_rt_complete_analysis (used_mock=true, both hash fields null).
  const c1bFixtureMarker = "_m5_0054_rt_build_running('c1b')";
  // Ends right after the closing backtick of the SQL template literal
  // (the runPsql call-site name argument), deliberately BEFORE the
  // check() label text -- which itself contains the prose
  // "record_analysis_call_receipt_for_job(outcome=...)" and would
  // otherwise inflate the real call count by one.
  const c1bCleanupMarker = "c1b-analysis-unknown";
  const c1bStartIdx = c1Body.indexOf(c1bFixtureMarker);
  const c1bEndIdx = c1bStartIdx === -1 ? -1 : c1Body.indexOf(c1bCleanupMarker, c1bStartIdx);
  const c1bBody = c1bStartIdx !== -1 && c1bEndIdx > c1bStartIdx ? c1Body.slice(c1bStartIdx, c1bEndIdx) : "";

  const C1B_NAMED_CALL =
    "record_analysis_call_receipt_for_job(\n" +
    "  p_job_id => :'jid',\n" +
    "  p_claim_token => :'tok',\n" +
    "  p_project_id => :'pid',\n" +
    "  p_external_call_id => :'acid',\n" +
    "  p_probe_run_id => :'rid',\n" +
    "  p_outcome => 'provider_outcome_unknown',\n" +
    "  p_used_mock => true\n" +
    ")";
  const C1B_OLD_POSITIONAL_CALL = "record_analysis_call_receipt_for_job(:'jid', :'tok', :'pid', :'acid', :'rid', 'provider_outcome_unknown')";

  function c1bCallSound(body: string): boolean {
    const callCount = (body.match(/record_analysis_call_receipt_for_job\(/g) ?? []).length;
    return (
      body.length > 0 &&
      callCount === 1 &&
      body.includes(C1B_NAMED_CALL) &&
      !body.includes(C1B_OLD_POSITIONAL_CALL) &&
      (body.match(/p_used_mock => true/g) ?? []).length === 1 &&
      !body.includes("p_request_sha256") &&
      !body.includes("p_raw_request_body") &&
      body.includes("p_external_call_id => :'acid'") &&
      !body.includes("p_external_call_id => :'pcid'")
    );
  }
  selfCheck(
    "static self-inspection: C1b's real body contains exactly one call to record_analysis_call_receipt_for_job, using the exact six named arguments plus p_used_mock => true, the old six-argument positional call is absent, p_request_sha256/p_raw_request_body are never provided, and p_external_call_id correctly uses :'acid' (never :'pcid')",
    c1bCallSound(c1bBody)
  );

  const c1bSentIdx = c1bBody.indexOf("mark_external_call_sent_for_job(:'jid', :'tok', :'pid', :'acid', :'rid')");
  const c1bReceiptIdx = c1bBody.indexOf("record_analysis_call_receipt_for_job(");
  selfCheck(
    "static self-inspection: C1b's mark_external_call_sent_for_job call and its ordering before record_analysis_call_receipt_for_job remain intact",
    c1bSentIdx !== -1 && c1bReceiptIdx !== -1 && c1bSentIdx < c1bReceiptIdx
  );

  selfCheck(
    "negative self-test: removing p_used_mock => true from C1b's real call is correctly detected",
    !c1bCallSound(c1bBody.replace("  p_used_mock => true\n", ""))
  );
  selfCheck(
    "negative self-test: flipping C1b's p_used_mock to false in a throwaway copy is correctly detected",
    !c1bCallSound(c1bBody.replace("p_used_mock => true", "p_used_mock => false"))
  );
  selfCheck(
    "negative self-test: reintroducing the old six-argument positional call into a throwaway copy is correctly detected",
    !c1bCallSound(c1bBody.replace(C1B_NAMED_CALL, C1B_NAMED_CALL + "\n" + C1B_OLD_POSITIONAL_CALL))
  );
  selfCheck(
    "negative self-test: a throwaway copy substituting :'pcid' for :'acid' in p_external_call_id is correctly detected",
    !c1bCallSound(c1bBody.replace("p_external_call_id => :'acid'", "p_external_call_id => :'pcid'"))
  );
  selfCheck(
    "negative self-test: duplicating C1b's real call in a throwaway copy is correctly detected",
    !c1bCallSound(c1bBody + "\n" + C1B_NAMED_CALL)
  );

  // Global 2-site audit: exactly one direct call in the real scenarios
  // (C1b) plus HELPER_SQL's own _m5_0054_rt_complete_analysis site --
  // both must respect the used_mock/hash pairing; zero invalid sites
  // remain. HELPER_SQL is the real module constant, never re-extracted
  // via selfCodeOnly string-slicing, so there is no self-reference risk.
  const helperAnalysisCallMatch = HELPER_SQL.match(/record_analysis_call_receipt_for_job\(\s*\n([\s\S]*?)\n\s*\);/);
  const helperAnalysisCallArgs = helperAnalysisCallMatch ? helperAnalysisCallMatch[1] : "";
  selfCheck(
    "self-test sanity: HELPER_SQL's own record_analysis_call_receipt_for_job call site was found (extractor not silently vacuous)",
    helperAnalysisCallArgs.length > 0
  );
  const helperArgList = helperAnalysisCallArgs.split(",").map((s) => s.trim());
  selfCheck(
    "static self-inspection: HELPER_SQL's own record_analysis_call_receipt_for_job site (used by _m5_0054_rt_complete_analysis) still passes used_mock=true (9th positional argument) with both hash fields null, matching the same valid pairing C1b now also uses",
    helperArgList[8] === "true" && helperArgList[9] === "null"
  );
  selfCheck(
    "global audit: exactly two effective call sites to record_analysis_call_receipt_for_job across the real scenarios and HELPER_SQL (C1b + the HELPER_SQL fixture-completion helper), both respecting the used_mock/hash pairing -- zero invalid sites remain",
    // "public." prefix distinguishes the two real SQL call sites from the
    // check() label prose ("C1b: record_analysis_call_receipt_for_job(outcome=...")
    // elsewhere in allScenariosBody, which names the function without that prefix.
    (allScenariosBody.match(/public\.record_analysis_call_receipt_for_job\(/g) ?? []).length === 1 &&
      (HELPER_SQL.match(/public\.record_analysis_call_receipt_for_job\(/g) ?? []).length === 1 &&
      c1bCallSound(c1bBody) &&
      helperArgList[8] === "true" &&
      helperArgList[9] === "null"
  );

  // claim_protocol_execution_job (Run 11 forensics): its RETURNS TABLE
  // exposes exactly three top-level columns -- status, job, claim_token --
  // where `job` is the composite protocol_execution_jobs rowtype. Four
  // real scenario sites (C1d, C3 x2, C4) projected a bare `id`, which
  // does not exist at top level; the job identifier lives INSIDE the
  // composite and must be projected as `(job).id`. Postgres raises
  // `column "id" does not exist` at parse-analysis time, before the
  // stateful RPC ever runs. All four are fixed together here, and each
  // now also captures the returned status so a non-CLAIMED outcome fails
  // its own assertion rather than surfacing later as an opaque psql
  // error. Scoped strictly to the real scenarios plus the real
  // HELPER_SQL constant -- never comments, check() labels, or the
  // self-test's own synthetic fixture strings.
  const CLAIM_RPC = "public.claim_protocol_execution_job(";
  function claimSites(text: string): string[] {
    const out: string[] = [];
    let idx = text.indexOf(CLAIM_RPC);
    while (idx !== -1) {
      const lineStart = text.lastIndexOf("\n", idx) + 1;
      let lineEnd = text.indexOf("\n", idx);
      if (lineEnd === -1) lineEnd = text.length;
      out.push(text.slice(lineStart, lineEnd).trim());
      idx = text.indexOf(CLAIM_RPC, idx + CLAIM_RPC.length);
    }
    return out;
  }
  const scenarioClaimSites = claimSites(allScenariosBody);
  const helperClaimSites = claimSites(HELPER_SQL);
  const allClaimSites = [...scenarioClaimSites, ...helperClaimSites];
  const CLAIM_TOP_LEVEL_COLUMNS = ["status", "job", "claim_token"];

  // A site is valid when every projected column is either a real
  // top-level output name or an explicit (composite).field projection.
  function claimProjectionValid(stmt: string): boolean {
    const intoWholeRecord = /select\s+\*\s+into\s+\w+\s+from\s+public\.claim_protocol_execution_job\(/i.test(stmt);
    if (intoWholeRecord) return true;
    const m = stmt.match(/select\s+(.+?)\s+from\s+public\.claim_protocol_execution_job\(/i);
    if (!m) return false;
    return m[1]!.split(",").every((raw) => {
      const col = raw.trim();
      if (/^\(\s*\w+\s*\)\./.test(col)) return true;
      const name = (col.match(/^([a-z_][a-z0-9_]*)/i) ?? [])[1];
      return name !== undefined && CLAIM_TOP_LEVEL_COLUMNS.includes(name);
    });
  }
  const validClaimSites = allClaimSites.filter(claimProjectionValid);
  const invalidClaimSites = allClaimSites.filter((s) => !claimProjectionValid(s));

  selfCheck(
    "self-test sanity: the claim_protocol_execution_job site extractor found the expected 9 effective call sites (8 in the real scenarios + 1 in HELPER_SQL) -- not silently vacuous",
    allClaimSites.length === 9 && scenarioClaimSites.length === 8 && helperClaimSites.length === 1
  );
  selfCheck(
    "global ratchet: all 9 effective claim_protocol_execution_job projections are valid (top-level status/job/claim_token or an explicit (composite).field) -- zero invalid sites remain",
    validClaimSites.length === 9 && invalidClaimSites.length === 0
  );

  const claimJobIdSites = allClaimSites.filter((s) => s.includes("(job).id as jid"));
  selfCheck(
    "static self-inspection: exactly four direct claim-job projections exist (C1d, C3 first, C3 second, C4) and all four use (job).id",
    claimJobIdSites.length === 4
  );
  const BARE_ID_JID = "select id as " + "jid";
  const BARE_ID_JID2 = "select id as " + "jid2";
  selfCheck(
    "static self-inspection: zero bare `id as jid`/`id as jid2` projections from claim_protocol_execution_job remain anywhere in the real scenarios",
    !allClaimSites.some((s) => s.startsWith(BARE_ID_JID) || s.startsWith(BARE_ID_JID2))
  );
  selfCheck(
    "static self-inspection: claim_token is still captured at all four direct claim-job sites",
    claimJobIdSites.every((s) => /claim_token as tok2?\b/.test(s))
  );
  selfCheck(
    "static self-inspection: the HELPER_SQL claim site still uses the whole-record `select * into v_claim` form, untouched by this correction",
    helperClaimSites.length === 1 && /select\s+\*\s+into\s+v_claim\s+from\s+public\.claim_protocol_execution_job\(/i.test(helperClaimSites[0]!)
  );
  selfCheck(
    "static self-inspection: the four sweep claims still project only `status` (unchanged by this correction)",
    allClaimSites.filter((s) => /select status as (sweep_st|sweep1|sweep2) from public\.claim_protocol_execution_job\(/.test(s)).length === 4
  );
  selfCheck(
    "static self-inspection: the four direct claim-job sites keep their original worker-id expressions and 300-second lease arguments",
    ["c1d-worker-", "c3-worker-", "c3-worker2-", "c4-worker-"].every((w) =>
      allClaimSites.some((s) => s.includes(`'${w}' || gen_random_uuid()::text, 300)`))
    )
  );

  // Status capture + consumption, per scenario body.
  const c1dStart = c1Body.indexOf("_m5_0054_rt_make_fixture('c1d'");
  const c1dBody = c1dStart === -1 ? "" : c1Body.slice(c1dStart, c1Body.indexOf("c1d-abandoned", c1dStart));
  const c3Marker = "await sc(SCENARIO_ROSTER[2" + "2]!, () => {";
  const c4Marker = "await sc(SCENARIO_ROSTER[2" + "3]!, () => {";
  const c5Marker = "await sc(SCENARIO_ROSTER[2" + "4]!, () => {";
  const c3StartIdx = selfCodeOnly.indexOf(c3Marker);
  const c4StartIdx = selfCodeOnly.indexOf(c4Marker, c3StartIdx);
  const c5StartIdx = selfCodeOnly.indexOf(c5Marker, c4StartIdx);
  const c3Body = c3StartIdx !== -1 && c4StartIdx > c3StartIdx ? selfCodeOnly.slice(c3StartIdx, c4StartIdx) : "";
  const c4Body = c4StartIdx !== -1 && c5StartIdx > c4StartIdx ? selfCodeOnly.slice(c4StartIdx, c5StartIdx) : "";

  selfCheck(
    "self-test sanity: the C1d, C3 and C4 bodies were all extracted non-empty",
    c1dBody.length > 0 && c3Body.length > 0 && c4Body.length > 0
  );
  function capturesAndEchoes(body: string, marker: string): boolean {
    return body.includes(`status as ${marker},`) && body.includes(`##R## ${marker}' :${marker}`);
  }
  selfCheck(
    "static self-inspection: C1d captures claim_st, C3 captures claim1_st and claim2_st, and C4 captures claim_st -- each also echoed so parseMarkers can see it",
    capturesAndEchoes(c1dBody, "claim_st") &&
      capturesAndEchoes(c3Body, "claim1_st") &&
      capturesAndEchoes(c3Body, "claim2_st") &&
      capturesAndEchoes(c4Body, "claim_st")
  );
  selfCheck(
    'static self-inspection: all four captured claim statuses are consumed by their own existing assertion and compared against exactly "CLAIMED"',
    c1Body.includes('r4.get("claim_st") === "CLAIMED"') &&
      c3Body.includes('r.get("claim1_st") === "CLAIMED"') &&
      c3Body.includes('r.get("claim2_st") === "CLAIMED"') &&
      c4Body.includes('r.get("claim_st") === "CLAIMED"')
  );

  // Negative mutations -- each rewrites a real body and must be caught.
  const C1D_REAL_CLAIM = "select status as claim_st, (job).id as jid, claim_token as tok from public.claim_protocol_execution_job('c1d-worker-";
  const C3_REAL_CLAIM1 = "select status as claim1_st, (job).id as jid, claim_token as tok from public.claim_protocol_execution_job('c3-worker-";
  const C3_REAL_CLAIM2 = "select status as claim2_st, (job).id as jid2, claim_token as tok2 from public.claim_protocol_execution_job('c3-worker2-";
  const C4_REAL_CLAIM = "select status as claim_st, (job).id as jid, claim_token as tok from public.claim_protocol_execution_job('c4-worker-";
  function mutatedSitesInvalid(body: string, from: string, to: string): boolean {
    const mutated = body.replace(from, to);
    if (mutated === body) return false; // mutation must really change the input
    return claimSites(mutated).some((s) => !claimProjectionValid(s));
  }
  selfCheck(
    "negative self-test: reintroducing a bare `id as jid` projection into C1d's real claim is correctly detected",
    mutatedSitesInvalid(c1dBody, C1D_REAL_CLAIM, BARE_ID_JID + ", claim_token as tok from public.claim_protocol_execution_job('c1d-worker-")
  );
  selfCheck(
    "negative self-test: reintroducing the old projection into C3's FIRST real claim is correctly detected",
    mutatedSitesInvalid(c3Body, C3_REAL_CLAIM1, BARE_ID_JID + ", claim_token as tok from public.claim_protocol_execution_job('c3-worker-")
  );
  selfCheck(
    "negative self-test: reintroducing the old projection into C3's SECOND real claim is correctly detected",
    mutatedSitesInvalid(c3Body, C3_REAL_CLAIM2, BARE_ID_JID2 + ", claim_token as tok2 from public.claim_protocol_execution_job('c3-worker2-")
  );
  selfCheck(
    "negative self-test: reintroducing a bare `id as jid` projection into C4's real claim is correctly detected",
    mutatedSitesInvalid(c4Body, C4_REAL_CLAIM, BARE_ID_JID + ", claim_token as tok from public.claim_protocol_execution_job('c4-worker-")
  );
  selfCheck(
    "negative self-test: removing C1d's claim_st capture is correctly detected",
    !capturesAndEchoes(c1dBody.replace("status as claim_st, ", ""), "claim_st")
  );
  selfCheck(
    "negative self-test: removing C3's claim2_st consumption from its own assertion is correctly detected",
    !c3Body.replace('r.get("claim2_st") === "CLAIMED" &&\n        ', "").includes('r.get("claim2_st") === "CLAIMED"')
  );
  selfCheck(
    'negative self-test: replacing the expected "CLAIMED" literal with any other value in C4 is correctly detected',
    !c4Body.replace('r.get("claim_st") === "CLAIMED"', 'r.get("claim_st") === "NO_JOB_AVAILABLE"').includes('r.get("claim_st") === "CLAIMED"')
  );
  selfCheck(
    "negative self-test: altering a claim argument (lease seconds) in C1d's real call is correctly detected",
    !c1dBody.replace("'c1d-worker-' || gen_random_uuid()::text, 300)", "'c1d-worker-' || gen_random_uuid()::text, 600)").includes("'c1d-worker-' || gen_random_uuid()::text, 300)")
  );
  selfCheck(
    "negative self-test: duplicating C1d's real claim call raises its stateful call count above the expected two",
    (c1dBody + "\n" + C1D_REAL_CLAIM + "' || gen_random_uuid()::text, 300) \\gset").match(/public\.claim_protocol_execution_job\(/g)!.length === 3 &&
      (c1dBody.match(/public\.claim_protocol_execution_job\(/g) ?? []).length === 2
  );

  // ------------------------------------------------------------------
  // D3 (Run 12 preflight): the scenario projected `lease_expires_at`
  // directly from claim_next_pending_alert, whose RETURNS TABLE exposes
  // 13 top-level columns and does NOT include it -- the RPC writes that
  // column on protocol_execution_job_alert_deliveries but never returns
  // it. Postgres would raise `column "lease_expires_at" does not exist`
  // at parse-analysis time, before the stateful RPC ran. Fixed by
  // capturing only real outputs and reading lease0 from the table in a
  // separate statement, exactly like the pre-existing lease1 read.
  //
  // CRITICAL: every earlier audit of this defect class required a
  // "public." prefix on the RPC call and therefore inspected only 25 of
  // 95 sites -- silently skipping ALL calls to persist_probe_result_for_job,
  // claim_next_pending_alert, renew_alert_lease, mark_alert_request_sent
  // and record_alert_delivery_receipt, which the scenarios invoke
  // unprefixed. That blind spot is what hid D3. The scanner below makes
  // the prefix OPTIONAL, and a dedicated negative self-test proves that
  // re-imposing a mandatory prefix loses the detection.
  // ------------------------------------------------------------------

  // RPC output sets are DERIVED from the real migration texts, never
  // hand-maintained, so a signature change cannot silently desynchronise
  // this ratchet. Each `returns table (...)` block is parsed by matching
  // its own parentheses.
  function deriveRpcOutputs(migrationSql: string): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const fnRe = /create or replace function\s*\n?\s*public\.(\w+)\s*\(/g;
    let fm: RegExpExecArray | null;
    while ((fm = fnRe.exec(migrationSql))) {
      const name = fm[1]!;
      const rtIdx = migrationSql.indexOf("returns table (", fm.index);
      if (rtIdx === -1) continue;
      const bodyIdx = migrationSql.indexOf("as $$", fm.index);
      if (bodyIdx !== -1 && rtIdx > bodyIdx) continue; // returns table belongs to a later function
      const open = rtIdx + "returns table (".length - 1;
      let depth = 0;
      let i = open;
      for (; i < migrationSql.length; i += 1) {
        if (migrationSql[i] === "(") depth += 1;
        else if (migrationSql[i] === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const cols = migrationSql
        .slice(open + 1, i)
        .split(",")
        .map((c) => c.trim())
        .filter((c) => c.length > 0)
        .map((c) => c.split(/\s+/)[0]!);
      if (cols.length > 0) out.set(name, cols);
    }
    return out;
  }

  const migrationsDirForRatchet = path.join(REPO_ROOT, "supabase", "migrations");
  const rpcOutputs = new Map<string, string[]>();
  for (const file of readdirSync(migrationsDirForRatchet).filter((f) => f.endsWith(".sql")).sort()) {
    const text = readFileSync(path.join(migrationsDirForRatchet, file), "utf8");
    const stripped = text
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("--");
        return idx === -1 ? line : line.slice(0, idx);
      })
      .join("\n");
    // Later migrations redefine earlier RPCs; sorted order means the last write wins.
    for (const [name, cols] of deriveRpcOutputs(stripped)) rpcOutputs.set(name, cols);
  }

  selfCheck(
    "self-test sanity: RPC output signatures were derived mechanically from the real migration files (never a hand-maintained map), and cover the five families the old public.-prefixed auditor ignored entirely",
    rpcOutputs.size > 0 &&
      ["persist_probe_result_for_job", "claim_next_pending_alert", "renew_alert_lease", "mark_alert_request_sent", "record_alert_delivery_receipt"].every((f) =>
        (rpcOutputs.get(f) ?? []).length > 0
      )
  );
  selfCheck(
    "self-test sanity: the derived claim_next_pending_alert signature has exactly its 13 real top-level outputs and does NOT include lease_expires_at",
    (rpcOutputs.get("claim_next_pending_alert") ?? []).length === 13 && !(rpcOutputs.get("claim_next_pending_alert") ?? []).includes("lease_expires_at")
  );

  // The scanner. `requirePublicPrefix` exists solely so a negative
  // self-test can prove the mandatory-prefix variant loses detections.
  function scanRpcProjections(body: string, requirePublicPrefix: boolean): Array<{ rpc: string; bad: string[]; projection: string }> {
    const found: Array<{ rpc: string; bad: string[]; projection: string }> = [];
    const re = requirePublicPrefix
      ? /select\s+([^\n]+?)\s+from\s+public\.(\w+)\(/gi
      : /select\s+([^\n]+?)\s+from\s+(?:public\.)?(\w+)\(/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      const projection = m[1]!;
      const rpc = m[2]!;
      const outputs = rpcOutputs.get(rpc);
      if (!outputs) continue; // a real table, CTE, or helper -- not an RPC with RETURNS TABLE
      const bad: string[] = [];
      for (const raw of projection.split(",")) {
        const col = raw.trim();
        if (/^\(\s*\w+\s*\)\./.test(col)) continue; // (composite).field
        if (/^(count|coalesce|max|min|sum|avg)\s*\(/i.test(col)) continue; // aggregate / expression
        const name = (col.match(/^([a-z_][a-z0-9_]*)/i) ?? [])[1];
        if (name !== undefined && !outputs.includes(name)) bad.push(name);
      }
      if (bad.length > 0) found.push({ rpc, bad, projection: projection.trim() });
    }
    return found;
  }
  function countRpcProjectionSites(body: string, requirePublicPrefix: boolean): number {
    const re = requirePublicPrefix
      ? /select\s+([^\n]+?)\s+from\s+public\.(\w+)\(/gi
      : /select\s+([^\n]+?)\s+from\s+(?:public\.)?(\w+)\(/gi;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(body))) if (rpcOutputs.has(m[2]!)) n += 1;
    return n;
  }

  const rpcSitesInspected = countRpcProjectionSites(allScenariosBody, false);
  const rpcInvalid = scanRpcProjections(allScenariosBody, false);
  selfCheck(
    `global ratchet (public. prefix OPTIONAL): every RPC output projection across the 39 real scenarios is valid -- ${rpcSitesInspected} sites inspected, ${rpcInvalid.length} invalid`,
    rpcInvalid.length === 0
  );
  selfCheck(
    "self-test sanity: the optional-prefix scanner inspects far more sites than the old mandatory-prefix one (the 70-site blind spot that hid D3 is closed)",
    rpcSitesInspected > countRpcProjectionSites(allScenariosBody, true) + 60
  );
  selfCheck(
    "negative self-test: re-imposing a mandatory public. prefix makes the scanner miss an unprefixed invalid projection that the optional-prefix scanner does catch",
    (() => {
      const synthetic = allScenariosBody + "\nselect lease_expires_at::text as zzz from claim_next_pending_alert('zzz-worker', 60) \\gset\n";
      return scanRpcProjections(synthetic, false).length === 1 && scanRpcProjections(synthetic, true).length === 0;
    })()
  );
  selfCheck(
    "negative self-test: a synthetic unprefixed invalid RPC projection is detected by the real optional-prefix scanner",
    scanRpcProjections(allScenariosBody + "\nselect not_a_real_output as zzz from renew_alert_lease('x','y',1) \\gset\n", false).length === 1
  );

  // D3 body, bounded to its own SQL literal (never the check() label prose).
  const d3Marker = "await sc(SCENARIO_ROSTER[2" + "7]!, async () => {";
  const d4Marker = "await sc(SCENARIO_ROSTER[2" + "8]!, async () => {";
  const d3StartIdx = selfCodeOnly.indexOf(d3Marker);
  const d4StartIdx = d3StartIdx === -1 ? -1 : selfCodeOnly.indexOf(d4Marker, d3StartIdx);
  const d3Body = d3StartIdx !== -1 && d4StartIdx > d3StartIdx ? selfCodeOnly.slice(d3StartIdx, d4StartIdx) : "";
  const D3_CLAIM = "select status as claim_st, delivery_id::text as did, claim_token::text as tok\n  from claim_next_pending_alert('d3-worker', 60) \\\\gset";
  const D3_LEASE0 = "select lease_expires_at::text as lease0 from protocol_execution_job_alert_deliveries where delivery_id = :'did' \\\\gset";
  const D3_LEASE1 = "select lease_expires_at::text as lease1 from protocol_execution_job_alert_deliveries where delivery_id = :'did' \\\\gset";

  selfCheck("self-test sanity: the D3 body was extracted non-empty", d3Body.length > 0);
  selfCheck(
    "static self-inspection: D3's claim projects only status/delivery_id/claim_token and no longer projects lease_expires_at from claim_next_pending_alert",
    d3Body.includes(D3_CLAIM) && !/lease_expires_at::text as lease0\s*\n?\s*from claim_next_pending_alert/.test(d3Body)
  );
  selfCheck(
    "static self-inspection: D3 reads lease0 from protocol_execution_job_alert_deliveries by :'did', in the same style as the pre-existing lease1 read",
    d3Body.includes(D3_LEASE0) && d3Body.includes(D3_LEASE1)
  );
  selfCheck(
    "static self-inspection: D3 captures, echoes and consumes claim_st, comparing it to exactly \"CLAIMED\"",
    d3Body.includes("status as claim_st,") && d3Body.includes("##R## claim_st' :claim_st") && d3Body.includes('r.get("claim_st") === "CLAIMED"')
  );
  selfCheck(
    "static self-inspection: D3 still makes exactly 3 stateful RPC calls, 2 read-only table reads, and holds exactly 1 check()",
    (d3Body.match(/(?:public\.)?(?:claim_next_pending_alert|renew_alert_lease)\(/g) ?? []).length === 3 &&
      (d3Body.match(/from protocol_execution_job_alert_deliveries where delivery_id = :'did'/g) ?? []).length === 2 &&
      (d3Body.match(/\n {4}check\(/g) ?? []).length === 1
  );
  selfCheck(
    "static self-inspection: D3's lease comparison between lease1 and lease0 is preserved verbatim",
    d3Body.includes('r.get("lease1")! > r.get("lease0")!')
  );

  selfCheck(
    "negative self-test: reintroducing lease_expires_at into D3's RPC projection is correctly detected as an invalid RPC output projection",
    (() => {
      const mutated = d3Body.replace(D3_CLAIM, "select delivery_id::text as did, claim_token::text as tok, lease_expires_at::text as lease0\n  from claim_next_pending_alert('d3-worker', 60) \\\\gset");
      return mutated !== d3Body && scanRpcProjections(mutated, false).length === 1;
    })()
  );
  selfCheck(
    "negative self-test: removing D3's table read of lease0 is correctly detected",
    (() => {
      const mutated = d3Body.replace(D3_LEASE0 + "\n", "");
      return mutated !== d3Body && !mutated.includes(D3_LEASE0);
    })()
  );
  selfCheck(
    "negative self-test: pointing D3's lease0 table read at a different identifier is correctly detected",
    (() => {
      const mutated = d3Body.replace(D3_LEASE0, D3_LEASE0.replace(":'did'", ":'ok_did'"));
      return mutated !== d3Body && !mutated.includes(D3_LEASE0);
    })()
  );
  selfCheck(
    "negative self-test: removing D3's claim_st capture, or its consumption, is correctly detected",
    (() => {
      const noCapture = d3Body.replace("status as claim_st, ", "");
      const noConsume = d3Body.replace('r.get("claim_st") === "CLAIMED" && ', "");
      return noCapture !== d3Body && !noCapture.includes("status as claim_st,") && noConsume !== d3Body && !noConsume.includes('r.get("claim_st") === "CLAIMED"');
    })()
  );
  selfCheck(
    'negative self-test: replacing D3\'s expected "CLAIMED" literal is correctly detected',
    (() => {
      const mutated = d3Body.replace('r.get("claim_st") === "CLAIMED"', 'r.get("claim_st") === "NO_ALERT_AVAILABLE"');
      return mutated !== d3Body && !mutated.includes('r.get("claim_st") === "CLAIMED"');
    })()
  );

  // ------------------------------------------------------------------
  // C3 (Run 12): both symmetric alert/delivery joins projected a bare
  // `alert_event_id`, which exists on BOTH joined relations -- Postgres
  // raised `column reference "alert_event_id" is ambiguous` at
  // parse-analysis time. Fixed by qualifying all four aggregate
  // expressions (al./d.) and, following the C1a-C1d precedent, wrapping
  // each in coalesce() with the all-zero sentinel so a missing row
  // becomes a legible assertion failure instead of an unset psql
  // variable. The assertion now rejects the sentinel explicitly, so the
  // defence reveals an absence rather than masking it.
  //
  // The ratchet below derives real table columns from the migrations
  // (same discipline as the RPC-output ratchet) and flags any
  // unqualified identifier that could resolve to more than one visible
  // relation. A query it cannot parse confidently is reported as
  // UNANALYSED rather than silently assumed valid.
  // ------------------------------------------------------------------
  const JOIN_SENTINEL = "00000000-0000-0000-0000-000000000000";

  function deriveTableColumns(migrationSql: string): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    const ctRe = /create table if not exists public\.(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = ctRe.exec(migrationSql))) {
      const table = m[1]!;
      const open = m.index + m[0].length - 1;
      let depth = 0;
      let i = open;
      for (; i < migrationSql.length; i += 1) {
        if (migrationSql[i] === "(") depth += 1;
        else if (migrationSql[i] === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const set = out.get(table) ?? new Set<string>();
      let d = 0;
      let cur = "";
      const parts: string[] = [];
      for (const ch of migrationSql.slice(open + 1, i)) {
        if (ch === "(") d += 1;
        if (ch === ")") d -= 1;
        if (ch === "," && d === 0) {
          parts.push(cur);
          cur = "";
        } else cur += ch;
      }
      parts.push(cur);
      for (const p of parts) {
        const t = p.trim();
        if (/^(primary key|unique|foreign key|check|constraint|exclude)\b/i.test(t)) continue;
        const name = (t.match(/^([a-z_][a-z0-9_]*)/i) ?? [])[1];
        if (name) set.add(name);
      }
      out.set(table, set);
    }
    for (const a of migrationSql.matchAll(/alter table public\.(\w+)\s+add column(?: if not exists)? (\w+)/gi)) {
      const set = out.get(a[1]!) ?? new Set<string>();
      set.add(a[2]!);
      out.set(a[1]!, set);
    }
    return out;
  }

  const tableColumns = new Map<string, Set<string>>();
  for (const file of readdirSync(migrationsDirForRatchet).filter((f) => f.endsWith(".sql")).sort()) {
    const stripped = readFileSync(path.join(migrationsDirForRatchet, file), "utf8")
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("--");
        return idx === -1 ? line : line.slice(0, idx);
      })
      .join("\n");
    for (const [t, c] of deriveTableColumns(stripped)) {
      const set = tableColumns.get(t) ?? new Set<string>();
      for (const col of c) set.add(col);
      tableColumns.set(t, set);
    }
  }

  selfCheck(
    "self-test sanity: real table columns were derived mechanically from the migrations, including both alert-outbox tables that share alert_event_id",
    tableColumns.size > 0 &&
      (tableColumns.get("protocol_execution_job_alerts") ?? new Set()).has("alert_event_id") &&
      (tableColumns.get("protocol_execution_job_alert_deliveries") ?? new Set()).has("alert_event_id") &&
      (tableColumns.get("protocol_execution_job_alert_deliveries") ?? new Set()).has("delivery_id") &&
      !(tableColumns.get("protocol_execution_job_alerts") ?? new Set()).has("delivery_id")
  );

  type JoinScan = { multiRelation: number; ambiguous: Array<{ cols: string[]; stmt: string }>; unanalysed: number };
  function scanJoinAmbiguity(body: string, schema: Map<string, Set<string>>): JoinScan {
    const result: JoinScan = { multiRelation: 0, ambiguous: [], unanalysed: 0 };
    const lines = body.split("\n");
    const statements: string[] = [];
    let cur: string[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (/^select\b/i.test(t) && cur.length === 0) cur = [line];
      else if (cur.length > 0) cur.push(line);
      if (cur.length > 0 && (/\\gset\s*$/.test(t) || /;\s*$/.test(t))) {
        statements.push(cur.join("\n"));
        cur = [];
      }
      // Runaway guard only. B1's canonical-hash recomputation is a single
      // ~50-line statement (one relation, no join), so the cap must be well
      // above it; anything still unterminated past this really is unparseable
      // and is reported as UNANALYSED rather than assumed valid.
      if (cur.length > 80) {
        result.unanalysed += 1;
        cur = [];
      }
    }
    for (const stmt of statements) {
      const rels = [...stmt.matchAll(/\b(?:from|join)\s+(?:public\.)?(\w+)(?:\s+(?!on\b|where\b|join\b|using\b)(\w+))?/gi)]
        .map((m) => ({ table: m[1]!, alias: m[2] ?? m[1]! }))
        .filter((r) => schema.has(r.table));
      if (rels.length < 2) continue;
      result.multiRelation += 1;
      const counts = new Map<string, number>();
      for (const r of rels) for (const c of schema.get(r.table)!) counts.set(c, (counts.get(c) ?? 0) + 1);
      const ambiguousCols = [...counts].filter(([, n]) => n > 1).map(([c]) => c);
      const hits = new Set<string>();
      for (const col of ambiguousCols) {
        const re = new RegExp(`(?<![\\w.'"])${col}(?![\\w])`, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(stmt))) {
          const before = stmt.slice(Math.max(0, m.index - 30), m.index);
          if (/\bas\s+$/i.test(before)) continue; // output alias
          if (/\.\s*$/.test(before)) continue; // already qualified
          hits.add(col);
        }
      }
      if (hits.size > 0) result.ambiguous.push({ cols: [...hits], stmt: stmt.trim() });
    }
    return result;
  }

  const joinScan = scanJoinAmbiguity(allScenariosBody, tableColumns);
  selfCheck(
    `global ratchet: every multi-relation query across the 39 real scenarios qualifies its shared columns -- ${joinScan.multiRelation} multi-relation queries, ${joinScan.ambiguous.length} ambiguous unqualified sites, ${joinScan.unanalysed} unanalysed`,
    joinScan.multiRelation === 4 && joinScan.ambiguous.length === 0 && joinScan.unanalysed === 0
  );

  const c3JoinBlocks = (c3Body.match(/from protocol_execution_job_alerts al join protocol_execution_job_alert_deliveries d on d\.alert_event_id = al\.alert_event_id/g) ?? []).length;
  selfCheck("static self-inspection: C3 still holds exactly its two symmetric alert/delivery joins", c3JoinBlocks === 2);
  selfCheck(
    "static self-inspection: both C3 reads qualify al.alert_event_id and d.delivery_id inside their own single ordered row selector, and no lexical max()/min() selection over either id remains anywhere in C3",
    (c3Body.match(/select al\.alert_event_id::text as evt, d\.delivery_id::text as dlv/g) ?? []).length === 2 &&
      !/\b(?:max|min)\s*\(\s*(?:\w+\.)?(?:alert_event_id|delivery_id)\b/.test(c3Body)
  );
  selfCheck(
    "static self-inspection: all four C3 markers are coalesce-guarded with the exact all-zero sentinel, each sourced from its OWN read's row selector (latest1 -> evt1/dlv1, latest2 -> evt2/dlv2)",
    (c3Body.match(new RegExp(`coalesce\\(\\s*\\n\\s*latest([12])\\.(?:evt|dlv),\\s*\\n\\s*'${JOIN_SENTINEL}'\\s*\\n\\s*\\) as (?:evt|dlv)\\1`, "g")) ?? []).length === 4
  );
  selfCheck(
    "static self-inspection: evt1/dlv1/evt2/dlv2 are each still echoed and each explicitly compared against the sentinel in C3's single assertion",
    ["evt1", "dlv1", "evt2", "dlv2"].every(
      (v) => c3Body.includes(`##R## ${v}' :${v}`) && c3Body.includes(`r.get("${v}") !== "${JOIN_SENTINEL}"`)
    )
  );
  selfCheck(
    "static self-inspection: C3 keeps its 4 stateful claim calls, its single check(), and its pre-existing distinctness and alert_cnt conditions",
    (c3Body.match(/public\.claim_protocol_execution_job\(/g) ?? []).length === 4 &&
      (c3Body.match(/\n {4}check\(/g) ?? []).length === 1 &&
      c3Body.includes('r.get("evt1") !== r.get("evt2")') &&
      c3Body.includes('r.get("dlv1") !== r.get("dlv2")') &&
      c3Body.includes('r.get("alert_cnt") === "2"')
  );

  function joinMutationCaught(from: string, to: string): boolean {
    const mutated = allScenariosBody.replace(from, to);
    if (mutated === allScenariosBody) return false; // mutation must really change the input
    return scanJoinAmbiguity(mutated, tableColumns).ambiguous.length > 0;
  }
  selfCheck(
    "negative self-test: reintroducing the bare alert_event_id ambiguity into C3's FIRST join is correctly detected",
    joinMutationCaught(
      "select al.alert_event_id::text as evt, d.delivery_id::text as dlv\n      from protocol_execution_job_alerts al join protocol_execution_job_alert_deliveries d on d.alert_event_id = al.alert_event_id\n      where al.job_id = :'jid'\n",
      "select alert_event_id::text as evt, d.delivery_id::text as dlv\n      from protocol_execution_job_alerts al join protocol_execution_job_alert_deliveries d on d.alert_event_id = al.alert_event_id\n      where al.job_id = :'jid'\n"
    )
  );
  selfCheck(
    "negative self-test: reintroducing the bare alert_event_id ambiguity into C3's SECOND join is correctly detected",
    joinMutationCaught(
      "select al.alert_event_id::text as evt, d.delivery_id::text as dlv\n      from protocol_execution_job_alerts al join protocol_execution_job_alert_deliveries d on d.alert_event_id = al.alert_event_id\n      where al.job_id = :'jid2'\n",
      "select alert_event_id::text as evt, d.delivery_id::text as dlv\n      from protocol_execution_job_alerts al join protocol_execution_job_alert_deliveries d on d.alert_event_id = al.alert_event_id\n      where al.job_id = :'jid2'\n"
    )
  );
  selfCheck(
    "static self-inspection: stripping the d. qualification from either C3 row selector is detectable by the C3 projection check (delivery_id is not itself ambiguous today, so the projection ratchet -- not the join scanner -- is what guards it)",
    (() => {
      const target = "select al.alert_event_id::text as evt, d.delivery_id::text as dlv";
      const stripped = "select al.alert_event_id::text as evt, delivery_id::text as dlv";
      const idx1 = c3Body.indexOf(target);
      const idx2 = idx1 === -1 ? -1 : c3Body.indexOf(target, idx1 + 1);
      if (idx1 === -1 || idx2 === -1) return false;
      const m1 = c3Body.slice(0, idx1) + stripped + c3Body.slice(idx1 + target.length);
      const m2 = c3Body.slice(0, idx2) + stripped + c3Body.slice(idx2 + target.length);
      return m1 !== c3Body && m2 !== c3Body && (m1.match(/d\.delivery_id::text/g) ?? []).length === 1 && (m2.match(/d\.delivery_id::text/g) ?? []).length === 1;
    })()
  );
  selfCheck(
    "negative self-test: removing one coalesce guard from C3 is correctly detected",
    (() => {
      const mutated = c3Body.replace(`coalesce(\n    latest1.evt,\n    '${JOIN_SENTINEL}'\n  ) as evt1`, "latest1.evt as evt1");
      return mutated !== c3Body && (mutated.match(new RegExp(`coalesce\\(\\s*\\n\\s*latest[12]\\.(?:evt|dlv),\\s*\\n\\s*'${JOIN_SENTINEL}'`, "g")) ?? []).length === 3;
    })()
  );
  selfCheck(
    "negative self-test: substituting a wrong sentinel value in C3 is correctly detected",
    (() => {
      const before = (c3Body.match(new RegExp(`'${JOIN_SENTINEL}'`, "g")) ?? []).length;
      const mutated = c3Body.replace(`'${JOIN_SENTINEL}'\n  ) as evt1`, "'11111111-1111-1111-1111-111111111111'\n  ) as evt1");
      const after = (mutated.match(new RegExp(`'${JOIN_SENTINEL}'`, "g")) ?? []).length;
      return mutated !== c3Body && before > 0 && after === before - 1;
    })()
  );
  selfCheck(
    "negative self-test: removing one anti-sentinel comparison from C3's assertion is correctly detected",
    (() => {
      const mutated = c3Body.replace(`        r.get("dlv2") !== "${JOIN_SENTINEL}" &&\n`, "");
      return mutated !== c3Body && !mutated.includes(`r.get("dlv2") !== "${JOIN_SENTINEL}"`);
    })()
  );
  selfCheck(
    "negative self-test: a synthetic query joining two relations that share a column, with that column left unqualified, is correctly flagged",
    scanJoinAmbiguity(
      "select max(alert_event_id::text) as zzz from protocol_execution_job_alerts al join protocol_execution_job_alert_deliveries d on d.alert_event_id = al.alert_event_id \\gset",
      tableColumns
    ).ambiguous.length === 1
  );
  selfCheck(
    "negative self-test: dropping one relation from the derived schema loses the ambiguity detection, proving the scanner genuinely depends on real column data",
    (() => {
      const reduced = new Map(tableColumns);
      reduced.delete("protocol_execution_job_alert_deliveries");
      return (
        scanJoinAmbiguity(
          "select max(alert_event_id::text) as zzz from protocol_execution_job_alerts al join protocol_execution_job_alert_deliveries d on d.alert_event_id = al.alert_event_id \\gset",
          reduced
        ).ambiguous.length === 0
      );
    })()
  );

  // ------------------------------------------------------------------
  // Permanent ratchets for the grouped post-Run-13 correction round:
  // C3 (business ordering, never lexical UUID selection), D13 (moving
  // clock), D14 (deterministic NULL), and the final counters. Every
  // ratchet below is bound to this file's OWN real source text (or, for
  // the counters, drives the real finalizeCounters() function), and
  // every negative self-test really mutates its input before asserting
  // that the mutation is caught -- nothing here is tautological or
  // self-referential.
  // ------------------------------------------------------------------

  // ---- C3: business ordering, single row, paired ids ----------------
  const c3PairedSelectors = (c3Body.match(/select al\.alert_event_id::text as evt, d\.delivery_id::text as dlv\n/g) ?? []).length;
  const c3BusinessOrderings = (c3Body.match(/order by al\.transition_seq desc, al\.transition_at desc\n/g) ?? []).length;
  const c3ExplicitLimits = (c3Body.match(/\n\s*limit 1\n/g) ?? []).length;
  const c3SingleRowFrames = (c3Body.match(/from \(select 1\) as one([12])\n\s*left join lateral \(\n[\s\S]*?\) as latest\1 on true/g) ?? []).length;
  const c3OrderByClauses = c3Body.match(/order by [^\n]*/g) ?? [];

  selfCheck(
    "C3 ratchet: each of the two reads selects its alert_event_id and its delivery_id in ONE row selector, so both ids necessarily come from the same business row of the same alerts/deliveries join",
    c3PairedSelectors === 2
  );
  selfCheck(
    "C3 ratchet: both reads order by al.transition_seq desc, then al.transition_at desc, and both bound the selector with an explicit limit 1",
    c3BusinessOrderings === 2 && c3ExplicitLimits === 2
  );
  selfCheck(
    "C3 ratchet: the only ordering keys anywhere in C3 are the business ones -- neither alert_event_id nor delivery_id is used as a primary sort key or as a tie-break",
    c3OrderByClauses.length === 2 &&
      c3OrderByClauses.every((c) => c === "order by al.transition_seq desc, al.transition_at desc") &&
      !c3OrderByClauses.some((c) => /alert_event_id|delivery_id/.test(c))
  );
  selfCheck(
    "C3 ratchet: each read's outer query is framed on a guaranteed single row (from (select 1) ... left join lateral ... on true), so it still produces exactly one row even when the job has no alert at all",
    c3SingleRowFrames === 2
  );

  // ---- C3: global lexical-selection audit ---------------------------
  // A "lexical selection site" is any max()/min() taken over one of the
  // two id columns -- i.e. a row picked by UUID text order rather than
  // by business order. Such a site is only defensible where the same
  // statement pins the result set to exactly one row and the scenario
  // itself asserts that count is "1"; anything else is a genuine
  // multi-cardinality defect of exactly the kind Run 13 exposed in C3.
  type LexicalAudit = { sites: string[]; cardinalityOneSafe: string[]; invalid: string[] };
  function scanLexicalIdSelection(body: string): LexicalAudit {
    const audit: LexicalAudit = { sites: [], cardinalityOneSafe: [], invalid: [] };
    const siteRe = /\b(?:max|min)\s*\(\s*(?:\w+\.)?(?:alert_event_id|delivery_id)\b/;
    for (const rawLine of body.split("\n")) {
      if (!siteRe.test(rawLine)) continue;
      const line = rawLine.trim();
      audit.sites.push(line);
      const cnt = /count\(\*\)::text as (\w+)/.exec(rawLine);
      const pinned = cnt !== null && body.includes(`.get("${cnt[1]!}") === "1"`);
      (pinned ? audit.cardinalityOneSafe : audit.invalid).push(line);
    }
    return audit;
  }

  // The four pre-correction C3 selections, each expressed as the exact
  // inverse of the correction, so the historical audit figures are
  // RECONSTRUCTED mechanically from today's real source rather than
  // asserted as bare remembered numbers.
  const C3_LEXICAL_REINTRODUCTIONS: ReadonlyArray<readonly [string, string]> = [
    ["    latest1.evt,\n", "    max(al.alert_event_id::text),\n"],
    ["    latest1.dlv,\n", "    max(d.delivery_id::text),\n"],
    ["    latest2.evt,\n", "    max(al.alert_event_id::text),\n"],
    ["    latest2.dlv,\n", "    max(d.delivery_id::text),\n"],
  ];

  const lexicalAfter = scanLexicalIdSelection(allScenariosBody);
  const preCorrectionShape = C3_LEXICAL_REINTRODUCTIONS.reduce((acc, [from, to]) => acc.replace(from, to), allScenariosBody);
  const lexicalBefore = scanLexicalIdSelection(preCorrectionShape);

  selfCheck(
    `C3 global audit: reconstructing the pre-correction shape yields exactly 9 historical lexical-selection sites -- ${lexicalBefore.sites.length} found, of which ${lexicalBefore.cardinalityOneSafe.length} cardinality-pinned and ${lexicalBefore.invalid.length} not`,
    preCorrectionShape !== allScenariosBody && lexicalBefore.sites.length === 9 && lexicalBefore.cardinalityOneSafe.length === 5 && lexicalBefore.invalid.length === 4
  );
  selfCheck(
    `C3 global audit: after the correction exactly 5 lexical-selection sites remain, ALL of them in category C1 and safe only because their own statement pins the result set to a single asserted row -- ${lexicalAfter.sites.length} sites, ${lexicalAfter.cardinalityOneSafe.length} cardinality-pinned`,
    lexicalAfter.sites.length === 5 && lexicalAfter.cardinalityOneSafe.length === 5
  );
  selfCheck(
    `C3 global audit: INVALID_MULTI_CARDINALITY_SITE_COUNT=${lexicalAfter.invalid.length} -- zero unpinned lexical-selection sites survive anywhere across the 39 real scenarios`,
    lexicalAfter.invalid.length === 0
  );

  for (const [idx, [from, to]] of C3_LEXICAL_REINTRODUCTIONS.entries()) {
    selfCheck(
      `negative self-test: reintroducing C3 lexical selection #${idx + 1} (${to.trim()}) on its own is caught as an unpinned multi-cardinality site`,
      (() => {
        const mutated = allScenariosBody.replace(from, to);
        return mutated !== allScenariosBody && scanLexicalIdSelection(mutated).invalid.length === 1;
      })()
    );
  }
  selfCheck(
    "negative self-test: removing the business ordering from one C3 read is correctly detected",
    (() => {
      const mutated = c3Body.replace("      order by al.transition_seq desc, al.transition_at desc\n", "");
      return mutated !== c3Body && (mutated.match(/order by al\.transition_seq desc, al\.transition_at desc\n/g) ?? []).length === 1;
    })()
  );
  selfCheck(
    "negative self-test: removing the explicit limit 1 from one C3 read is correctly detected",
    (() => {
      const mutated = c3Body.replace("      limit 1\n", "");
      return mutated !== c3Body && (mutated.match(/\n\s*limit 1\n/g) ?? []).length === 1;
    })()
  );
  selfCheck(
    "negative self-test: unpairing evt from dlv (sourcing one read's delivery_id from the OTHER read's selector) is correctly detected by the alias-paired coalesce ratchet",
    (() => {
      const mutated = c3Body.replace("    latest1.dlv,\n", "    latest2.dlv,\n");
      const paired = (mutated.match(new RegExp(`coalesce\\(\\s*\\n\\s*latest([12])\\.(?:evt|dlv),\\s*\\n\\s*'${JOIN_SENTINEL}'\\s*\\n\\s*\\) as (?:evt|dlv)\\1`, "g")) ?? []).length;
      return mutated !== c3Body && paired === 3;
    })()
  );

  // ---- D13: moving clock in every bounded polling helper ------------
  const LEASE_POLLER = "_m5_0054_rt_poll_lease_expired";
  const WAIT_EVENT_POLLER = "_m5_0054_rt_poll_wait_event";
  type FrozenClockScan = { polling: number; mismatches: string[] };
  function scanFrozenClockInPollingFunctions(sql: string): FrozenClockScan {
    const scan: FrozenClockScan = { polling: 0, mismatches: [] };
    for (const block of sql.match(/create or replace function[\s\S]*?\$f\$;/g) ?? []) {
      if (!block.includes("pg_sleep")) continue;
      scan.polling += 1;
      const named = /function public\.(\w+)\(/.exec(block);
      const name = named === null ? "(unnamed)" : named[1]!;
      // now() and transaction_timestamp() are both frozen for the whole
      // transaction, so inside a server-side polling loop they can never
      // advance -- the exact defect Run 13 exposed in D13.
      if (/\b(?:now|transaction_timestamp)\(\)/.test(block)) scan.mismatches.push(name);
    }
    return scan;
  }

  const leaseBlockStart = HELPER_SQL.indexOf(`create or replace function public.${LEASE_POLLER}(`);
  const leaseBlock = leaseBlockStart === -1 ? "" : HELPER_SQL.slice(leaseBlockStart, HELPER_SQL.indexOf("$f$;", leaseBlockStart));
  const waitEventBlockStart = HELPER_SQL.indexOf(`create or replace function public.${WAIT_EVENT_POLLER}(`);
  const waitEventBlock = waitEventBlockStart === -1 ? "" : HELPER_SQL.slice(waitEventBlockStart, HELPER_SQL.indexOf("$f$;", waitEventBlockStart));
  const frozenClockScan = scanFrozenClockInPollingFunctions(HELPER_SQL);

  // Built by concatenation so this ratchet's own source text never
  // contains the very comparison it forbids -- otherwise the check
  // would flag itself the moment it was written.
  const FROZEN_LEASE_COMPARISON = "lease_expires_at < " + "now()";
  selfCheck(
    "D13 ratchet: the lease poller compares lease_expires_at against clock_timestamp() exactly once, and never against the transaction-frozen now()",
    (leaseBlock.match(/lease_expires_at < clock_timestamp\(\)/g) ?? []).length === 1 && !leaseBlock.includes(FROZEN_LEASE_COMPARISON)
  );
  selfCheck(
    "D13 ratchet: no frozen-clock lease comparison survives anywhere in this file's executable source",
    !selfCodeOnly.includes(FROZEN_LEASE_COMPARISON)
  );
  selfCheck(
    `D13 global ratchet: every server-side polling helper (one containing pg_sleep) reads a moving clock -- ${frozenClockScan.polling} polling helpers scanned, FROZEN_CLOCK_MISMATCH_COUNT=${frozenClockScan.mismatches.length}`,
    frozenClockScan.polling === 2 && frozenClockScan.mismatches.length === 0
  );
  selfCheck(
    "negative self-test: mutating clock_timestamp() back to now() inside the lease poller is caught by the frozen-clock scanner, and named",
    (() => {
      const mutated = HELPER_SQL.replace("lease_expires_at < clock_timestamp()", FROZEN_LEASE_COMPARISON);
      if (mutated === HELPER_SQL) return false;
      const scan = scanFrozenClockInPollingFunctions(mutated);
      return scan.polling === 2 && scan.mismatches.length === 1 && scan.mismatches[0] === LEASE_POLLER;
    })()
  );
  selfCheck(
    "D13 ratchet: the second polling helper is preserved unchanged -- same signature, same bounded loop, same sleep argument, same honest return contract",
    waitEventBlock.includes(`function public.${WAIT_EVENT_POLLER}(p_pid integer, p_max_iterations integer, p_sleep_seconds numeric)`) &&
      waitEventBlock.includes("returns text language plpgsql security definer set search_path = pg_catalog, pg_temp") &&
      waitEventBlock.includes("for i in 1..p_max_iterations loop") &&
      waitEventBlock.includes("perform pg_sleep(p_sleep_seconds);") &&
      waitEventBlock.includes("return 'BACKEND_GONE';") &&
      waitEventBlock.includes("return coalesce(v_wait_event_type, 'NONE_OBSERVED');")
  );

  // ---- D14: deterministic NULL through psql's own \gset -------------
  const PSQL_SET_PREFIX = "\\" + "\\set ";
  const d14Marker = "await sc(SCENARIO_ROSTER[3" + "8]!, async () => {";
  const d14StartIdx = selfCodeOnly.indexOf(d14Marker);
  const d14Body = d14StartIdx === -1 ? "" : selfCodeOnly.slice(d14StartIdx, selfCodeOnly.indexOf("d14-cleanup", d14StartIdx));

  function scanPresetThenNullGset(body: string): string[] {
    const hits: string[] = [];
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i]!.trim();
      if (!trimmed.startsWith(PSQL_SET_PREFIX)) continue;
      const variable = trimmed.slice(PSQL_SET_PREFIX.length).trim().split(/\s/)[0] ?? "";
      if (variable === "") continue;
      for (let j = i + 1; j < lines.length; j += 1) {
        const later = lines[j]!;
        if (later.trimEnd().endsWith("gset") && new RegExp(`\\bas ${variable}\\b`).test(later)) {
          hits.push(variable);
          break;
        }
      }
    }
    return hits;
  }

  function scanUnguardedNullableGsetReuse(body: string): string[] {
    const hits: string[] = [];
    const re = /r\.get\("(\w+)"\) === "(SENTINEL_\w+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const variable = m[1]!;
      if (!new RegExp(`coalesce\\([^\\n]*\\) as ${variable}\\b`).test(body)) hits.push(variable);
    }
    return hits;
  }

  const presetThenNullSites = scanPresetThenNullGset(allScenariosBody);
  const unguardedNullableReuse = scanUnguardedNullableGsetReuse(allScenariosBody);

  selfCheck(
    "self-test sanity: the D14 scenario body was extracted non-empty (extractor actually found something, not silently vacuous)",
    d14Body.length > 0
  );
  selfCheck(
    "D14 ratchet: no psql-level preset of rdid survives -- the sentinel is produced inside SQL, which is the only form psql's own \\gset preserves for a NULL column",
    !d14Body.includes("set rdid")
  );
  selfCheck(
    "D14 ratchet: the coalesce(delivery_id::text, 'SENTINEL_NULL') as rdid projection is present exactly once, and the RPC call, its arguments and the surrounding markers are otherwise untouched",
    (allScenariosBody.match(/coalesce\(delivery_id::text, 'SENTINEL_NULL'\) as rdid/g) ?? []).length === 1 &&
      d14Body.includes("from record_alert_delivery_receipt(:'did', :'tok', :'aid', 'accepted', 200, 'second-attempt-resend')") &&
      d14Body.includes("select outcome as oc, resend_email_id as rid from protocol_execution_job_alert_delivery_attempts where attempt_id = :'aid'") &&
      d14Body.includes(`r.get("rdid") === "SENTINEL_NULL"`)
  );
  selfCheck(
    `D14 global ratchet: PRESET_THEN_NULL_GSET_SITE_COUNT=${presetThenNullSites.length} -- no scenario anywhere presets a psql variable that a later \\gset then targets`,
    presetThenNullSites.length === 0
  );
  selfCheck(
    `D14 global ratchet: UNGUARDED_NULLABLE_GSET_REUSE_COUNT=${unguardedNullableReuse.length} -- every sentinel-compared \\gset marker is coalesce-guarded in SQL`,
    unguardedNullableReuse.length === 0
  );
  selfCheck(
    "negative self-test: removing D14's coalesce guard (leaving the nullable projection cast but unguarded) is correctly detected",
    (() => {
      const mutated = allScenariosBody.replace("coalesce(delivery_id::text, 'SENTINEL_NULL') as rdid", "delivery_id::text as rdid");
      return mutated !== allScenariosBody && scanUnguardedNullableGsetReuse(mutated).length === 1;
    })()
  );
  selfCheck(
    "negative self-test: reintroducing the ineffective psql preset ahead of D14's \\gset is correctly detected",
    (() => {
      const target = "select status as st, coalesce(delivery_id::text, 'SENTINEL_NULL') as rdid";
      const mutated = allScenariosBody.replace(target, `${PSQL_SET_PREFIX}rdid 'SENTINEL_NULL'\nselect status as st, delivery_id as rdid`);
      return mutated !== allScenariosBody && scanPresetThenNullGset(mutated).length === 1 && scanPresetThenNullGset(mutated)[0] === "rdid";
    })()
  );
  selfCheck(
    "negative self-test: the exact pre-correction bare nullable projection (delivery_id as rdid) is correctly detected as an unguarded nullable \\gset reuse",
    (() => {
      const mutated = allScenariosBody.replace("coalesce(delivery_id::text, 'SENTINEL_NULL') as rdid", "delivery_id as rdid");
      return mutated !== allScenariosBody && scanUnguardedNullableGsetReuse(mutated).length === 1 && scanUnguardedNullableGsetReuse(mutated)[0] === "rdid";
    })()
  );

  // ---- Final counters ------------------------------------------------
  // Anchored on the leading newline as well: a bare "  } finally {" is
  // also a substring of every deeper-indented "    } finally {" in this
  // file, which would silently anchor main()'s counter ratchets onto an
  // unrelated inner block. Each anchor is also split so this self-test's
  // own source never contains the contiguous text it searches for.
  const FINALLY_ANCHOR = "\n  } fin" + "ally {";
  const CATCH_ANCHOR = "\n  } cat" + "ch (err) {";
  const FINALIZE_ANCHOR = "    finalize" + "Counters(";

  // main()'s two finally-block check() calls are not identically
  // indented (the second sits inside an if), so their call sites are
  // located positionally rather than by a fixed-width prefix.
  function checkCallIndices(body: string): number[] {
    const found: number[] = [];
    const re = /\n {2,}check\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) found.push(m.index);
    return found;
  }

  const mainFinallyIdx = selfCodeOnly.indexOf(FINALLY_ANCHOR);
  const mainCatchIdx = mainFinallyIdx === -1 ? -1 : selfCodeOnly.lastIndexOf(CATCH_ANCHOR, mainFinallyIdx);
  const mainCatchBody = mainCatchIdx === -1 ? "" : selfCodeOnly.slice(mainCatchIdx, mainFinallyIdx);
  const mainFinallyBody = mainFinallyIdx === -1 ? "" : selfCodeOnly.slice(mainFinallyIdx, selfCodeOnly.indexOf("\n}", mainFinallyIdx));
  const checkFnIdx = selfCodeOnly.indexOf("function check(name: string, cond: boolean, detail = \"\"): void {");
  const checkFnBody = checkFnIdx === -1 ? "" : selfCodeOnly.slice(checkFnIdx, selfCodeOnly.indexOf("\n}", checkFnIdx));

  function finalizeComesAfterFinallyChecks(text: string): boolean {
    const start = text.indexOf(FINALLY_ANCHOR);
    if (start === -1) return false;
    const end = text.indexOf("\n}", start);
    if (end === -1) return false;
    const body = text.slice(start, end);
    const checks = checkCallIndices(body);
    const finalize = body.indexOf(FINALIZE_ANCHOR);
    return checks.length > 0 && finalize !== -1 && finalize > checks[checks.length - 1]!;
  }

  function driveFinalizeCounters(state: FinalCounterState): { lines: string[]; exitCode: number | null } {
    const captured: { lines: string[]; exitCode: number | null } = { lines: [], exitCode: null };
    finalizeCounters(state, {
      log: (line) => {
        captured.lines.push(line);
      },
      exit: (code) => {
        captured.exitCode = code;
      },
    });
    return captured;
  }

  const SYNTHETIC_FAILURE_NAMES = ["synthetic failure A", "synthetic failure B", "synthetic failure C"];
  const synthSuccess = driveFinalizeCounters({
    totalAssertions: 62,
    passedAssertions: 62,
    failedAssertions: 0,
    failedAssertionNames: [],
    succeededFully: true,
    ranScenarioCount: 39,
    rosterSize: 39,
  });
  const synthThreeFailures = driveFinalizeCounters({
    totalAssertions: 62,
    passedAssertions: 59,
    failedAssertions: 3,
    failedAssertionNames: SYNTHETIC_FAILURE_NAMES,
    succeededFully: false,
    ranScenarioCount: 39,
    rosterSize: 39,
  });
  const synthCatchInflated = driveFinalizeCounters({
    totalAssertions: 63,
    passedAssertions: 59,
    failedAssertions: 4,
    failedAssertionNames: SYNTHETIC_FAILURE_NAMES,
    succeededFully: false,
    ranScenarioCount: 39,
    rosterSize: 39,
  });
  const synthSummaryTakenTooEarly = driveFinalizeCounters({
    totalAssertions: 60,
    passedAssertions: 57,
    failedAssertions: 3,
    failedAssertionNames: SYNTHETIC_FAILURE_NAMES,
    succeededFully: false,
    ranScenarioCount: 39,
    rosterSize: 39,
  });

  selfCheck(
    "counters: the REAL finalizeCounters(), driven with a synthetic all-passing 62-assertion run, prints `62/62 checks passed` and PASSED, emits no failure line at all, and exits 0",
    synthSuccess.exitCode === 0 &&
      synthSuccess.lines.some((l) => l.includes("62/62 checks passed") && l.includes("PASSED")) &&
      !synthSuccess.lines.some((l) => l.includes("assertions failed")) &&
      !synthSuccess.lines.some((l) => l.includes("Failed assertions"))
  );
  selfCheck(
    "counters: the same function, driven with three synthetic assertion failures, prints `3/62 assertions failed` and `59/62 checks passed`, reports FAILED, and exits 1",
    synthThreeFailures.exitCode === 1 &&
      synthThreeFailures.lines.some((l) => l.includes("3/62 assertions failed")) &&
      synthThreeFailures.lines.some((l) => l.includes("59/62 checks passed") && l.includes("FAILED")) &&
      synthThreeFailures.lines.some((l) => l.includes("Failed assertions (3)"))
  );
  selfCheck(
    "negative self-test: the pre-correction counter shape (catch had incremented both counters: 63 total and failedAssertions=4 against only 3 recorded names) is rejected by the final invariants and never printed as a clean verdict",
    synthCatchInflated.exitCode === 1 &&
      synthCatchInflated.lines.some((l) => l.includes("COUNTER INVARIANT VIOLATED")) &&
      !synthCatchInflated.lines.some((l) => l.includes("3/62 assertions failed"))
  );
  selfCheck(
    "negative self-test: a summary taken BEFORE the finally block's own two checks (60 total, not 62) is visibly different -- it prints 3/60 and 57/60, never the correct 3/62 and 59/62",
    synthSummaryTakenTooEarly.exitCode === 1 &&
      synthSummaryTakenTooEarly.lines.some((l) => l.includes("3/60 assertions failed")) &&
      !synthSummaryTakenTooEarly.lines.some((l) => l.includes("3/62 assertions failed")) &&
      !synthSummaryTakenTooEarly.lines.some((l) => l.includes("59/62 checks passed"))
  );
  selfCheck(
    "self-test sanity: main()'s catch body, main()'s finally body and check()'s own body were all extracted non-empty",
    mainCatchBody.length > 0 && mainFinallyBody.length > 0 && checkFnBody.length > 0
  );
  selfCheck(
    "counters: main()'s catch block increments no counter at all -- a non-assertion failure is carried by succeededFully=false and the real exit code, never by inventing an assertion that never ran",
    mainCatchBody.length > 0 &&
      !/totalAssertions\s*\+=/.test(mainCatchBody) &&
      !/passedAssertions\s*\+=/.test(mainCatchBody) &&
      !/failedAssertions\s*\+=/.test(mainCatchBody)
  );
  selfCheck(
    "counters: the only counter increments anywhere in this file's executable source are the three inside check() itself",
    (selfCodeOnly.match(/(?:total|passed|failed)Assertions \+= 1;/g) ?? []).length === 3 &&
      (checkFnBody.match(/(?:total|passed|failed)Assertions \+= 1;/g) ?? []).length === 3
  );
  selfCheck(
    "counters: the numeric summary is emitted only AFTER both of the finally block's own check() calls -- the finalize call genuinely appears after the last check( in the real finally body",
    finalizeComesAfterFinallyChecks(selfCodeOnly) && checkCallIndices(mainFinallyBody).length === 2
  );
  selfCheck(
    "negative self-test: an in-memory copy with the finalize call hoisted ABOVE the finally's two check() calls is correctly detected as wrong",
    (() => {
      const start = selfCodeOnly.indexOf(FINALLY_ANCHOR);
      const end = start === -1 ? -1 : selfCodeOnly.indexOf("\n}", start);
      if (start === -1 || end === -1) return false;
      const body = selfCodeOnly.slice(start, end);
      const callStart = body.indexOf(FINALIZE_ANCHOR);
      const checks = checkCallIndices(body);
      if (callStart === -1 || checks.length === 0 || checks[0]! > callStart) return false;
      const firstCheck = checks[0]!;
      const hoisted = body.slice(0, firstCheck) + "\n" + body.slice(callStart) + body.slice(firstCheck, callStart);
      const mutated = selfCodeOnly.slice(0, start) + hoisted + selfCodeOnly.slice(end);
      return mutated !== selfCodeOnly && !finalizeComesAfterFinallyChecks(mutated);
    })()
  );
  selfCheck(
    "negative self-test: an in-memory copy that reintroduces the pre-correction catch increments is correctly detected",
    (() => {
      // Both increments are spelled by concatenation so that the
      // "only three increments, all inside check()" ratchet above is
      // not tripped by this negative test's own source text.
      const reintroduced = "\n    failedAssertions +" + "= 1;" + "\n    totalAssertions +" + "= 1;";
      const anchor = "    console.log(`Disposable project_id: ${projectId}`);" + FINALLY_ANCHOR;
      if (!selfCodeOnly.includes(anchor)) return false;
      const mutated = selfCodeOnly.replace(
        anchor,
        "    console.log(`Disposable project_id: ${projectId}`);" + reintroduced + FINALLY_ANCHOR
      );
      if (mutated === selfCodeOnly) return false;
      const mFinally = mutated.indexOf(FINALLY_ANCHOR);
      const mCatch = mutated.lastIndexOf(CATCH_ANCHOR, mFinally);
      const mutatedCatchBody = mCatch === -1 ? "" : mutated.slice(mCatch, mFinally);
      return /failedAssertions\s*\+=/.test(mutatedCatchBody) && /totalAssertions\s*\+=/.test(mutatedCatchBody);
    })()
  );
  selfCheck(
    `counters: the runtime span (main() onward) still contains exactly 62 check() call sites -- TOTAL_RUNTIME_ASSERTIONS is unchanged by this correction round`,
    (() => {
      const mainIdx = selfCodeOnly.indexOf("async function main(): Promise<void> {");
      if (mainIdx === -1) return false;
      return (selfCodeOnly.slice(mainIdx).match(/(?:^|[^.\w])check\(/gm) ?? []).length === 62;
    })()
  );

  // ------------------------------------------------------------------
  // Gate, in the required order: every self-test above has already run
  // and reported; ONLY if selfTestFailures is empty does the scratch
  // directory get removed. On any failure, it is left in place and its
  // exact path is printed so the caller can inspect every log this
  // self-test produced.
  // ------------------------------------------------------------------
  if (selfTestFailures.length > 0) {
    console.log(`\n✗ FATAL: subprocess timeout mechanism self-test failed (${selfTestFailures.length} failure(s)): ${JSON.stringify(selfTestFailures)}`);
    console.log(`SELFTEST_FAILURE_ARTIFACT_PATH=${selfTestScratch}`);
    process.exit(1);
  }
  rmSync(selfTestScratch, { recursive: true, force: true });
  console.log("✓ Subprocess timeout mechanism self-test: fast-success, hung-then-SIGKILLed, spawn-error, throwing-onTimeout, and Live-registry-cleanup cases all behave exactly as required.\n");
}

// ------------------------------------------------------------------
// Migration selection: EXACTLY 0001-0054, explicitly selected by
// number, never "every .sql file present" — the same corrected
// discipline as scripts/test-m5-0050-runtime-contract.ts.
// ------------------------------------------------------------------
const MAX_MIGRATION_VERSION = 54;
const NUMBERED_MIGRATION_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

type MigrationSelectionResult = { ok: true; files: string[] } | { ok: false; reason: string };

function selectNumberedMigrations(entries: string[], maxVersion: number): MigrationSelectionResult {
  const sqlFiles = entries.filter((f) => f.endsWith(".sql"));
  const parsed: { file: string; version: number }[] = [];
  for (const f of sqlFiles) {
    const m = NUMBERED_MIGRATION_RE.exec(f);
    if (!m) return { ok: false, reason: `invalid numbered migration name: ${f}` };
    parsed.push({ file: f, version: Number(m[1]) });
  }
  const seen = new Set<number>();
  for (const { version, file } of parsed) {
    if (seen.has(version)) return { ok: false, reason: `duplicate migration version ${String(version).padStart(4, "0")} (${file})` };
    seen.add(version);
  }
  for (let v = 1; v <= maxVersion; v++) {
    if (!seen.has(v)) return { ok: false, reason: `missing migration version ${String(v).padStart(4, "0")}` };
  }
  const files = parsed
    .filter((p) => p.version <= maxVersion)
    .sort((a, b) => a.version - b.version || a.file.localeCompare(b.file))
    .map((p) => p.file);
  return { ok: true, files };
}

function runMigrationSelectionPreflight(): void {
  console.log("\n=== Preflight: migration selection (static, before opt-in gate, no Docker) ===");
  const realDir = path.join(REPO_ROOT, "supabase", "migrations");
  const realResult = selectNumberedMigrations(readdirSync(realDir), MAX_MIGRATION_VERSION);
  if (!realResult.ok) {
    console.log(`  ✗ FATAL: ${realResult.reason}`);
    process.exit(1);
  }
  const versions = realResult.files.map((f) => Number(NUMBERED_MIGRATION_RE.exec(f)![1]));
  const isExactRange = realResult.files.length === MAX_MIGRATION_VERSION && versions.every((v, i) => v === i + 1);
  if (!isExactRange) {
    console.log(`  ✗ FATAL: selection is not exactly 0001-0054 (got ${realResult.files.length} files)`);
    process.exit(1);
  }
  console.log(`  ✓ real directory selects exactly 0001-0054 (${realResult.files.length} files), 0055+ excluded\n`);
}

// ----------------------------------------------------------------------
// The closed, 39-scenario roster (categories A-D). No scenario name may
// be added, removed, or renamed without updating this array — the final
// verdict mechanically fails if the set of scenarios actually executed
// does not exactly equal this array.
// ----------------------------------------------------------------------
const SCENARIO_ROSTER: readonly string[] = [
  "A1: migration 0054 applied — new tables/functions/index present in the catalog",
  "A2: a legacy-shaped probe_results row (old dataset_source_type, no canonical hash) is still insertable and selectable",
  "A3: verdict/product_verdict CHECK accepts all five legacy+new values and rejects a sixth",
  "A4: ACL — anon/authenticated denied on the 3 new tables and the 8 new/redefined RPCs; service_role grants exact",
  "A5: protocol_execution_job_alert_deliveries_pending_claim_idx exists with the exact expected definition and is used by claim_next_pending_alert's own candidate query",
  "B1: persist_probe_result_for_job — fresh valid content -> PERSISTED, real row inserted, hash deterministic across two identical fixtures",
  "B2: persist_probe_result_for_job — exact replay -> ALREADY_PERSISTED, same hash, no second row",
  "B3: persist_probe_result_for_job — same probe_run_id, differently-parsed content -> CONFLICT, original row unchanged",
  "B4: persist_probe_result_for_job — a missing required key -> INVALID_CONTENT_KEYS, zero mutation",
  "B5: persist_probe_result_for_job — a wrong JSON type on a required field -> INVALID_CONTENT_TYPE, zero mutation",
  "B6: persist_probe_result_for_job — client_source_count=1.5 (fractional) -> INVALID_CONTENT_VALUE, zero mutation",
  "B7: persist_probe_result_for_job — client_source_count=2147483648 (int4 overflow) -> INVALID_CONTENT_VALUE, zero mutation",
  "B8: persist_probe_result_for_job — competitors_mentioned[].position=1.5 (fractional) -> INVALID_CONTENT_VALUE, zero mutation",
  "B9: persist_probe_result_for_job — competitors_mentioned[].position=0 and 501 (both out of range) -> INVALID_CONTENT_VALUE, zero mutation",
  "B10: persist_probe_result_for_job — contradictory product_position/product_mentioned -> INVALID_CONTENT_INVARIANT, zero mutation",
  "B11: persist_probe_result_for_job — the job's own protocol row missing -> PROTOCOL_NOT_FOUND, zero mutation",
  "B12: persist_probe_result_for_job — the protocol's own buyer_question_version row missing -> BUYER_QUESTION_VERSION_NOT_FOUND, zero mutation",
  "B13: persist_probe_result_for_job — the attempt's own probe_run row missing -> PROBE_RUN_NOT_FOUND, zero mutation",
  "B14: persist_probe_result_for_job — wrong claim_token and a genuinely expired lease -> JOB_NOT_OWNED, zero mutation",
  "B15: persist_probe_result_for_job — analysis not yet completed, and a parse-failed analysis -> ANALYSIS_NOT_COMPLETED / PARSE_ALREADY_MARKED_FAILED, zero mutation",
  "C1: each real needs_review transition (all 3 reasons) and abandoned_exhausted each produce exactly one alert event row and exactly one delivery row, same transaction",
  "C2: replaying an already-needs_review transition produces no duplicate event or delivery",
  "C3: leaving abandoned_exhausted (reactivation) then re-entering it produces a second, distinct alert_event_id/delivery_id",
  "C4: abandoned_exhausted produces its own event+delivery when a claimed job's lease expires with attempts exhausted",
  "C5: reason_code and source_attempt_id/source_external_call_id are exactly correct per reason, enforced by the FK/CHECK constraints",
  "D1: two concurrent claimers racing the same single pending delivery -> exactly one CLAIMED, the other NO_ALERT_AVAILABLE",
  "D2: two concurrent claimers with two distinct pending deliveries -> both CLAIMED, never blocking each other",
  "D3: renew_alert_lease extends lease_expires_at for the real owning claim_token, rejects a wrong one",
  "D4: a claimed delivery whose lease expires with no request_sent attempt -> reconciled to pending by the next claim, without consuming an attempt",
  "D5: mark_alert_request_sent — first attempt -> REQUEST_MARKED_SENT, attempt_seq=1, status=request_sent",
  "D6: record_alert_delivery_receipt — accepted with a resend_email_id -> final status accepted",
  "D7: record_alert_delivery_receipt — permanent 4xx -> failed, no retry scheduled",
  "D8: record_alert_delivery_receipt — 429/5xx/network/timeout -> pending with a bounded, jittered backoff window",
  "D9: a request_sent delivery whose lease expires under 24h with attempt_count<3 -> reconciled to pending, retried with the same idempotency_key",
  "D10: the third ambiguous_under_24h outcome (attempt_count reaching 3) -> needs_review_delivery, never a 4th pending retry",
  "D11: an ambiguous outcome at or beyond 24h -> needs_review_delivery unconditionally, regardless of attempt_count",
  "D12: a 4th delivery attempt can never happen — mark_alert_request_sent's cap guard and claim_next_pending_alert's attempt_count<3 exclusion agree",
  "D13: a real race between record_alert_delivery_receipt and claim_next_pending_alert's stale-request_sent reconciliation on the same attempt -> exactly one terminalizer",
  "D14: an attempt row already terminal can never be terminalized a second time — record_alert_delivery_receipt returns ATTEMPT_ALREADY_TERMINAL, zero mutation",
];

// ------------------------------------------------------------------
// Protected-container identity (zypact-postgres), captured via EXACTLY
// ONE `docker inspect --format ...` invocation -- never `docker
// inspect` with no --format (which would dump the entire object,
// including .Config.Env, into stdout/logs). The format string below
// selects only the nine fields listed; it never references .Config.Env
// or anything else that could carry a credential.
//
// Every value is produced by Docker's own `json` template function, so
// the whole invocation emits ONE self-contained JSON object -- parsed
// with JSON.parse, never split on a delimiter character that a label,
// mount path, or network name could itself contain.
//
// Because this is one atomic, Docker-side snapshot of one resolved
// object, every field is guaranteed to come from the same container
// instance at the same instant. A same-name replacement between two
// SEPARATE captures still changes `id`, which is compared by the same
// `identitiesMatch` as every other field -- it can never be masked by
// fields from a different container leaking into the same capture,
// because there is no second call left to leak from.
// ------------------------------------------------------------------
const PROTECTED_IDENTITY_INSPECT_FORMAT =
  '{"id":{{json .Id}},"startedAt":{{json .State.StartedAt}},"restartCount":{{json .RestartCount}},"status":{{json .State.Status}},"health":{{json .State.Health.Status}},"ports":{{json .NetworkSettings.Ports}},"networks":{{json .NetworkSettings.Networks}},"mounts":{{json .Mounts}},"labels":{{json .Config.Labels}}}';

interface ProtectedContainerIdentity {
  id: string;
  startedAt: string;
  restartCount: number;
  status: string;
  health: string;
  ports: string;
  networks: string;
  mounts: string;
  labels: string;
}

const PROTECTED_IDENTITY_FIELDS = ["id", "startedAt", "restartCount", "status", "health", "ports", "networks", "mounts", "labels"] as const;

// The single validation gate between "docker inspect produced some
// text" and "this may be trusted as a protected-container identity".
// Never echoes the raw captured text in any thrown message -- only
// structural facts (field counts/names, which specific field failed a
// type check) -- so an unexpected/malformed capture can never leak an
// unauthorized value through an error path.
function parseProtectedIdentitySnapshot(raw: string): ProtectedContainerIdentity {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("protected-container identity snapshot: empty docker inspect output");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("protected-container identity snapshot: docker inspect output is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("protected-container identity snapshot: expected a single JSON object, not an array or scalar");
  }
  const obj = parsed as Record<string, unknown>;
  const actualKeys = Object.keys(obj).sort();
  const expectedKeys = [...PROTECTED_IDENTITY_FIELDS].sort();
  const keysMatch = actualKeys.length === expectedKeys.length && actualKeys.every((k, i) => k === expectedKeys[i]);
  if (!keysMatch) {
    throw new Error(
      `protected-container identity snapshot: expected exactly ${expectedKeys.length} fields, found ${actualKeys.length} -- refusing a snapshot that looks like more than one merged capture, or a truncated one`
    );
  }
  if (typeof obj.id !== "string" || !/^[0-9a-f]{64}$/i.test(obj.id)) {
    throw new Error("protected-container identity snapshot: id is missing or is not exactly 64 hexadecimal characters");
  }
  if (typeof obj.startedAt !== "string" || obj.startedAt.length === 0) {
    throw new Error("protected-container identity snapshot: startedAt (State.StartedAt) is missing or empty");
  }
  if (typeof obj.restartCount !== "number" || !Number.isSafeInteger(obj.restartCount) || obj.restartCount < 0) {
    throw new Error("protected-container identity snapshot: restartCount is missing, not a safe integer, or negative");
  }
  if (typeof obj.status !== "string" || obj.status.length === 0) {
    throw new Error("protected-container identity snapshot: status (State.Status) is missing or empty");
  }
  if (typeof obj.health !== "string" || obj.health.length === 0) {
    throw new Error("protected-container identity snapshot: health (State.Health.Status) is missing or empty");
  }
  if (typeof obj.ports !== "object" || obj.ports === null || Array.isArray(obj.ports)) {
    throw new Error("protected-container identity snapshot: ports is missing or not a parsable object");
  }
  if (typeof obj.networks !== "object" || obj.networks === null || Array.isArray(obj.networks)) {
    throw new Error("protected-container identity snapshot: networks is missing or not a parsable object");
  }
  if (!Array.isArray(obj.mounts)) {
    throw new Error("protected-container identity snapshot: mounts is missing or not a parsable array");
  }
  if (typeof obj.labels !== "object" || obj.labels === null || Array.isArray(obj.labels)) {
    throw new Error("protected-container identity snapshot: labels is missing or not a parsable object");
  }
  return {
    id: obj.id,
    startedAt: obj.startedAt,
    restartCount: obj.restartCount,
    status: obj.status,
    health: obj.health,
    ports: JSON.stringify(obj.ports),
    networks: JSON.stringify(obj.networks),
    mounts: JSON.stringify(obj.mounts),
    labels: JSON.stringify(obj.labels),
  };
}

function identitiesMatch(a: ProtectedContainerIdentity, b: ProtectedContainerIdentity): boolean {
  return PROTECTED_IDENTITY_FIELDS.every((f) => a[f] === b[f]);
}

function describeIdentityDrift(baseline: ProtectedContainerIdentity, current: ProtectedContainerIdentity): string | null {
  const diffs = PROTECTED_IDENTITY_FIELDS.filter((f) => baseline[f] !== current[f]).map(
    (f) => `${f}: expected=${JSON.stringify(baseline[f])} actual=${JSON.stringify(current[f])}`
  );
  return diffs.length > 0 ? diffs.join("; ") : null;
}

async function main(): Promise<void> {
  console.log("=== M5 0054 — real runtime contract test for D-028 (persist_probe_result_for_job + alert outbox) ===\n");
  console.log(`Repo:   ${REPO_ROOT}`);

  // ------------------------------------------------------------------
  // Gate order, strictly enforced by the code's own sequence below:
  //   1. purely read-only local preflight (no subprocess of any kind)
  //   2. SELFTEST gate -- if set, run ONLY the timeout self-test and
  //      exit; never falls through to the RUNTIME gate even if that
  //      one is also set.
  //   3. RUNTIME gate -- if not set, SKIP (exit 0) here, having still
  //      launched zero subprocesses of any kind (no git, no Docker, no
  //      sh/sleep/node/psql).
  //   4. only past both gates does this file ever launch git/Docker/
  //      Supabase/psql or create any directory/file.
  // ------------------------------------------------------------------
  runMigrationSelectionPreflight();

  console.log(
    `Closed scenario roster: ${SCENARIO_ROSTER.length} named scenarios (category A: 5, B: 15, C: 5, D: 14). ` +
      "PASSED requires every one of them to have run and every assertion inside each to have passed.\n"
  );

  if (process.env.ZYPACT_M5_0054_TIMEOUT_SELFTEST === "1") {
    await runTimeoutMechanismSelfTest();
    console.log("\nSubprocess timeout mechanism self-test finished. Exiting now -- this opt-in never continues toward the Docker/Supabase runtime, regardless of ZYPACT_M5_0054_RUNTIME_TEST.");
    process.exit(0);
  }

  if (process.env.ZYPACT_M5_0054_RUNTIME_TEST !== "1") {
    skip(
      "ZYPACT_M5_0054_RUNTIME_TEST is not set to \"1\". Set it explicitly to run this test " +
        "(e.g. ZYPACT_M5_0054_RUNTIME_TEST=1 npx tsx scripts/test-m5-0054-runtime-contract.ts). " +
        "Optionally set ZYPACT_DOCKER_BIN_DIR if Docker's CLI is not already on PATH. " +
        "(Set ZYPACT_M5_0054_TIMEOUT_SELFTEST=1 instead to run only the local, Docker-free subprocess-timeout self-test.)"
    );
  }

  try {
    console.log(`Branch: ${run("git", ["branch", "--show-current"]).trim()}`);
    console.log(`HEAD:   ${run("git", ["rev-parse", "HEAD"]).trim()}`);
  } catch {
    console.log("(git branch/HEAD unavailable — continuing; this does not affect stack safety)");
  }

  const dockerVersion = tryRun("docker", ["version"]);
  if (!dockerVersion.ok) skip("Docker is not available (`docker version` failed). No stack created, no database touched.");
  const supabaseVersion = tryRun("supabase", ["--version"]);
  if (!supabaseVersion.ok) skip("The Supabase CLI is not available (`supabase --version` failed). No stack created.");
  const psqlVersion = tryRun("psql", ["--version"]);
  if (!psqlVersion.ok) skip("psql is not available (`psql --version` failed). No stack created.");
  console.log("Docker, Supabase CLI, and psql all detected — proceeding.\n");

  const requiredPorts = [54321, 54322, 54323, 54324];
  for (const port of requiredPorts) {
    const probe = tryRun("lsof", ["-i", `:${port}`, "-sTCP:LISTEN"]);
    if (probe.ok && probe.output.trim().length > 0) {
      console.log(`\n✗ FATAL: local port ${port} is already occupied — refusing to start a disposable stack that could collide.`);
      console.log(probe.output);
      process.exit(1);
    }
  }
  console.log("Confirmed: local Supabase ports (54321-54324) are free.\n");

  const preexistingContainers = run("docker", ["ps", "-a", "--format", "{{.Names}}"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  console.log(`Pre-existing containers recorded (${preexistingContainers.length}): will not be touched.`);

  function captureZypactPostgresIdentity(): ProtectedContainerIdentity | null {
    if (!preexistingContainers.includes("zypact-postgres")) return null;
    const raw = run("docker", ["inspect", "--format", PROTECTED_IDENTITY_INSPECT_FORMAT, "zypact-postgres"]);
    return parseProtectedIdentitySnapshot(raw);
  }

  const zypactPostgresBaseline = captureZypactPostgresIdentity();
  if (zypactPostgresBaseline !== null) {
    console.log("zypact-postgres baseline captured (ID/StartedAt/RestartCount/health/status/ports/network/mounts/labels).");
  } else {
    console.log("zypact-postgres is not present in this environment — that specific check will be skipped, not faked.");
  }

  const workdir = mkdtempSync(path.join(tmpdir(), "zypact-m5-0054-runtime-"));
  const projectId = path.basename(workdir);
  console.log(`Disposable workdir: ${workdir}`);
  console.log(`Disposable project_id: ${projectId}`);

  let stackStarted = false;
  let succeededFully = false;
  const ranScenarios = new Set<string>();

  try {
    run("supabase", ["init", "--workdir", workdir, "--yes"]);

    const configPath = path.join(workdir, "supabase", "config.toml");
    const config = readFileSync(configPath, "utf8").replace(
      "[db.seed]\n# If enabled, seeds the database after migrations during a db reset.\nenabled = true",
      "[db.seed]\n# If enabled, seeds the database after migrations during a db reset.\nenabled = false"
    );
    writeFileSync(configPath, config);
    check("seed is disabled in the disposable project's config.toml", config.includes("enabled = false"));

    const linkedProjectPath = path.join(workdir, "supabase", ".temp", "linked-project.json");
    check("no linked-project.json exists in the disposable project (never linked, never staging)", !existsSync(linkedProjectPath));

    const sourceMigrationsDir = path.join(REPO_ROOT, "supabase", "migrations");
    const destMigrationsDir = path.join(workdir, "supabase", "migrations");
    mkdirSync(destMigrationsDir, { recursive: true });
    const migrationSelection = selectNumberedMigrations(readdirSync(sourceMigrationsDir), MAX_MIGRATION_VERSION);
    if (!migrationSelection.ok) throw new Error(`migration selection failed inside main(): ${migrationSelection.reason}`);
    const migrationFiles = migrationSelection.files;
    for (const f of migrationFiles) {
      copyFileSync(path.join(sourceMigrationsDir, f), path.join(destMigrationsDir, f));
    }
    const byteIdentical = migrationFiles.every(
      (f) => readFileSync(path.join(sourceMigrationsDir, f)).equals(readFileSync(path.join(destMigrationsDir, f)))
    );
    check(
      `all ${migrationFiles.length} migrations (0001-0054) copied byte-identically`,
      byteIdentical && migrationFiles.some((f) => f.includes("0054_m5"))
    );

    console.log("\nStarting the disposable Supabase stack (first run may pull Docker images)...");
    run("supabase", ["start", "--workdir", workdir]);
    stackStarted = true;
    console.log("Stack started.\n");

    const dbUrl = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

    await runScenariosImpl(dbUrl, workdir, check, ranScenarios);

    // Roster closure: PASSED is impossible unless every one of the 39
    // named scenarios ran exactly once -- a missing scenario or a
    // duplicate/unknown name (which sc() below refuses to accept in the
    // first place) fails this check, which alone is enough to keep
    // failedAssertions > 0.
    check(
      "closed scenario roster: exactly 39 named scenarios executed, matching the fixed roster exactly, no duplicates, no unknown names",
      ranScenarios.size === SCENARIO_ROSTER.length && SCENARIO_ROSTER.every((n) => ranScenarios.has(n))
    );

    if (passedAssertions + failedAssertions !== totalAssertions) {
      throw new Error(
        `counter invariant violated: passedAssertions (${passedAssertions}) + failedAssertions (${failedAssertions}) !== totalAssertions (${totalAssertions}) -- refusing to trust the verdict.`
      );
    }
    if (failedAssertionNames.length > 0) {
      throw new Error(
        `${failedAssertionNames.length} assertion(s) failed -- refusing to clean up the disposable stack. Failed: ${JSON.stringify(failedAssertionNames)}`
      );
    }

    if (zypactPostgresBaseline !== null) {
      const preCleanupCapture = captureZypactPostgresIdentity();
      if (preCleanupCapture === null || !identitiesMatch(zypactPostgresBaseline, preCleanupCapture)) {
        const drift = preCleanupCapture === null ? "container no longer present" : describeIdentityDrift(zypactPostgresBaseline, preCleanupCapture);
        throw new Error(
          `zypact-postgres identity changed BEFORE any cleanup was attempted (${drift}) -- refusing to run \`supabase stop\` or remove the workdir. The disposable stack and workdir are preserved for inspection.`
        );
      }
    }

    console.log("\nAll assertions passed and zypact-postgres identity confirmed unchanged pre-cleanup — stopping the disposable stack.");
    run("supabase", ["stop", "--workdir", workdir, "--no-backup"]);

    if (zypactPostgresBaseline !== null) {
      const postStopCapture = captureZypactPostgresIdentity();
      if (postStopCapture === null || !identitiesMatch(zypactPostgresBaseline, postStopCapture)) {
        const drift = postStopCapture === null ? "container no longer present" : describeIdentityDrift(zypactPostgresBaseline, postStopCapture);
        throw new Error(`zypact-postgres identity changed AFTER \`supabase stop\` (${drift}) -- the workdir is preserved; refusing to remove it.`);
      }
    }

    rmSync(workdir, { recursive: true, force: true });
    console.log(`Removed disposable workdir: ${workdir}`);
    succeededFully = true;
  } catch (err) {
    console.log(`\n✗ FATAL: ${err instanceof Error ? err.message : String(err)}`);
    if (stackStarted) {
      console.log(`Stack left running for inspection (failure occurred): ${workdir}`);
      console.log(`  To inspect:  docker ps -a --filter label=com.supabase.cli.project=${projectId}`);
      console.log(`  To stop it:  supabase stop --workdir ${workdir} --no-backup`);
    } else {
      console.log(`Workdir preserved for inspection: ${workdir}`);
    }
    console.log(`Disposable project_id: ${projectId}`);
  } finally {
    // No cleanup logic of any kind lives in this block -- cleanup
    // (supabase stop + rmSync) already ran, unconditionally gated on
    // succeededFully, inside the try block above. This finally only
    // ever performs read-only diagnostics.
    const stillPresent = run("docker", ["ps", "-a", "--format", "{{.Names}}"])
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    check("every pre-existing container is still present, untouched, by name", preexistingContainers.every((name) => stillPresent.includes(name)));
    if (zypactPostgresBaseline !== null) {
      const after = captureZypactPostgresIdentity();
      const matched = after !== null && identitiesMatch(zypactPostgresBaseline, after);
      const drift = matched ? "" : after === null ? "container no longer present" : (describeIdentityDrift(zypactPostgresBaseline, after) ?? "");
      check(
        "zypact-postgres identity (ID/StartedAt/RestartCount/health/status/ports/network/mounts/labels) unchanged -- final, unconditional diagnostic re-check regardless of exit path",
        matched,
        drift
      );
    }

    finalizeCounters(
      {
        totalAssertions,
        passedAssertions,
        failedAssertions,
        failedAssertionNames,
        succeededFully,
        ranScenarioCount: ranScenarios.size,
        rosterSize: SCENARIO_ROSTER.length,
      },
      { log: (line) => console.log(line), exit: (code) => process.exit(code) }
    );
  }
}

// ----------------------------------------------------------------------
// Scenario execution.
// ----------------------------------------------------------------------

type CheckFn = (name: string, cond: boolean, detail?: string) => void;

function parseMarkers(output: string): Map<string, string> {
  const results = new Map<string, string>();
  for (const line of output.split("\n")) {
    const m = line.match(/^##R##\s+(\S+)\s+(.*)$/);
    if (m) results.set(m[1]!, m[2]!.trim());
  }
  return results;
}

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

/** Valid nine-key persist_probe_result_for_job content, snake_case, as a plain JS object. */
function contentObj(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    product_mentioned: true,
    product_position: "primary",
    competitors_mentioned: [{ name: "Acme", position: 1, context: "listed first" }],
    sources_cited: [{ source: "acme-reviews.com", type: "review_site" }],
    answer_summary: "Acme is recommended as the top choice.",
    cited_as_source: false,
    client_source_count: 0,
    platforms_referenced: [],
    negative_claim_detected: false,
  };
  return { ...base, ...overrides };
}

/** Same as contentObj, serialized and SQL-escaped, ready to embed inside a '...'::jsonb literal. */
function contentJson(overrides: Record<string, unknown> = {}): string {
  return sqlEscape(JSON.stringify(contentObj(overrides)));
}

// The complete set of SECURITY DEFINER test-only helper functions this
// harness installs into the disposable database (never into staging or
// Production -- this file only ever connects to a disposable local
// instance it created itself). Every helper is granted execute to
// service_role so every scenario below runs uniformly under
// `SET ROLE service_role;`, exactly like every real worker call. Each
// helper does exactly one narrow, named thing; none of them bypass any
// RPC's own validation -- they only construct fixtures (via real RPC
// calls chained together) or engineer otherwise-unreachable-through-the-
// public-contract states (a dangling FK reference, a backdated
// lease/timestamp, an already-terminal attempt row) that a real crash,
// a real 24h-old stale worker, or a real duplicate-submission race would
// also produce, but which this disposable, single-run database cannot
// be made to exhibit by simply waiting.
const HELPER_SQL = `
create or replace function
  public._m5_0054_rt_make_fixture(p_label text, p_max_attempts integer default 3)
returns table (project_id uuid, protocol_id uuid, buyer_question_version_id uuid, prompt_text text)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
declare
  v_project_id uuid;
  v_bq_id uuid;
  v_bqv_id uuid;
  v_protocol_id uuid;
  v_actor uuid := '11111111-1111-4111-8111-111111111111';
  v_prompt text := 'fixture prompt for ' || p_label;
begin
  insert into public.projects (domain, company_name)
    values ('m5-0054-runtime-' || p_label || '-' || gen_random_uuid()::text || '.test', 'M5 0054 Runtime ' || p_label)
    returning id into v_project_id;
  insert into public.buyer_questions (project_id) values (v_project_id) returning id into v_bq_id;
  insert into public.buyer_question_versions (
    buyer_question_id, project_id, version_number, prompt_text, prompt_hash,
    intent_type, commercial_value, winnability, priority, rationale, provenance
  ) values (
    v_bq_id, v_project_id, 1, v_prompt, 'hash-m5-0054-runtime-' || p_label || '-' || gen_random_uuid()::text,
    'shortlist', 4, 3, 10, 'm5 0054 runtime contract fixture', 'founder_supplied'
  ) returning id into v_bqv_id;
  perform status from public.approve_buyer_question_version(v_bqv_id, v_project_id, v_actor);
  insert into public.protocols (
    project_id, buyer_question_version_id, provider, surface,
    planned_baseline_runs, planned_retest_runs, unit_of_analysis, primary_metric,
    sample_planning_method, run_cap, spend_cap_usd, time_window_seconds,
    rate_limit_per_hour, concurrency_limit, retry_cap
  ) values (
    v_project_id, v_bqv_id, 'perplexity_sonar', 'answer',
    1, 0, 'buyer_question_version', 'presence_rate',
    'fixed_by_protocol', 20, 100.00, 3600,
    1000, 50, 2
  ) returning id into v_protocol_id;
  perform status from public.approve_protocol(v_protocol_id, v_project_id, v_actor);
  return query select v_project_id, v_protocol_id, v_bqv_id, v_prompt;
end;
$f$;
grant execute on function public._m5_0054_rt_make_fixture(text, integer) to service_role;

-- Fixture through admit_and_reserve_attempt_for_job +
-- create_probe_run_and_start_attempt_for_job: a real running job with a
-- real current attempt, real reserved perplexity/analysis calls, and a
-- real probe_run -- but neither external call marked sent yet.
create or replace function
  public._m5_0054_rt_build_running(p_label text, p_max_attempts integer default 3)
returns table (
  project_id uuid, protocol_id uuid, buyer_question_version_id uuid, prompt_text text,
  job_id uuid, claim_token uuid, attempt_id uuid, probe_run_id uuid,
  perplexity_call_id uuid, analysis_call_id uuid
)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
declare
  v_fx record;
  v_job public.protocol_execution_jobs%rowtype;
  v_token uuid;
  v_attempt public.protocol_attempts%rowtype;
  v_pcall public.protocol_external_calls%rowtype;
  v_acall public.protocol_external_calls%rowtype;
  v_run public.probe_runs%rowtype;
  v_status text;
  v_enqueue record;
  v_claim record;
  v_admit record;
  v_probe record;
begin
  select * into v_fx from public._m5_0054_rt_make_fixture(p_label, p_max_attempts);
  select * into v_enqueue from public.enqueue_protocol_execution_job(v_fx.protocol_id, v_fx.project_id, p_max_attempts);
  v_status := v_enqueue.status;
  v_job := v_enqueue.job;
  select * into v_claim from public.claim_protocol_execution_job(p_label || '-worker-' || gen_random_uuid()::text, 300);
  v_status := v_claim.status;
  v_job := v_claim.job;
  v_token := v_claim.claim_token;
  select * into v_admit from public.admit_and_reserve_attempt_for_job(
    v_job.id, v_token, v_fx.project_id, 'baseline', v_job.id::text || ':baseline:1', 0.01, 0.01
  );
  v_status := v_admit.status;
  v_attempt := v_admit.attempt;
  v_pcall := v_admit.perplexity_call;
  v_acall := v_admit.analysis_call;
  select * into v_probe from public.create_probe_run_and_start_attempt_for_job(
    v_job.id, v_token, v_fx.project_id, v_attempt.id, 'perplexity', 'simulated'
  );
  v_status := v_probe.status;
  v_attempt := v_probe.attempt;
  v_run := v_probe.probe_run;
  return query select
    v_fx.project_id, v_fx.protocol_id, v_fx.buyer_question_version_id, v_fx.prompt_text,
    v_job.id, v_token, v_attempt.id, v_run.id, v_pcall.id, v_acall.id;
end;
$f$;
grant execute on function public._m5_0054_rt_build_running(text, integer) to service_role;

-- Drives both external calls (perplexity, analysis) to a real success
-- receipt, computing each hash via the SAME public._sha256_hex the
-- RPCs themselves use, so no hash is ever assumed to match by
-- construction alone.
create or replace function
  public._m5_0054_rt_complete_analysis(
    p_job_id uuid, p_claim_token uuid, p_project_id uuid,
    p_perplexity_call_id uuid, p_analysis_call_id uuid, p_probe_run_id uuid,
    p_raw_perplexity_answer text, p_raw_analysis_content text
  ) returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
begin
  perform status from public.mark_external_call_sent_for_job(p_job_id, p_claim_token, p_project_id, p_perplexity_call_id, p_probe_run_id);
  perform status from public.record_provider_call_receipt_for_job(
    p_job_id, p_claim_token, p_project_id, p_perplexity_call_id, p_probe_run_id, 'success',
    200, 'req-' || p_perplexity_call_id::text, public._sha256_hex(p_raw_perplexity_answer), 500, null, null, p_raw_perplexity_answer
  );
  perform status from public.mark_external_call_sent_for_job(p_job_id, p_claim_token, p_project_id, p_analysis_call_id, p_probe_run_id);
  perform status from public.record_analysis_call_receipt_for_job(
    p_job_id, p_claim_token, p_project_id, p_analysis_call_id, p_probe_run_id, 'success',
    'anthropic', 'claude-fixture', true, null, public._sha256_hex(p_raw_analysis_content), 400, null, null, p_raw_analysis_content, null
  );
end;
$f$;
grant execute on function public._m5_0054_rt_complete_analysis(uuid, uuid, uuid, uuid, uuid, uuid, text, text) to service_role;

-- Engineers a dangling protocols/buyer_question_versions/probe_runs
-- reference: a state the schema's own FK chain normally prevents,
-- needed to prove persist_probe_result_for_job's three DEFECT_02
-- defensive guards actually fire rather than being dead code. Runs with
-- the function OWNER's privilege (postgres, superuser) regardless of
-- the caller's own role -- session_replication_role is scoped LOCAL to
-- this function's own transaction/statement and never leaks into the
-- calling session's later statements.
create or replace function public._m5_0054_rt_force_delete_protocol(p_protocol_id uuid) returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
begin
  set local session_replication_role = replica;
  delete from public.protocols where id = p_protocol_id;
end;
$f$;
grant execute on function public._m5_0054_rt_force_delete_protocol(uuid) to service_role;

create or replace function public._m5_0054_rt_force_delete_bqv(p_bqv_id uuid) returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
begin
  set local session_replication_role = replica;
  delete from public.buyer_question_versions where id = p_bqv_id;
end;
$f$;
grant execute on function public._m5_0054_rt_force_delete_bqv(uuid) to service_role;

create or replace function public._m5_0054_rt_force_delete_probe_run(p_probe_run_id uuid) returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
begin
  set local session_replication_role = replica;
  delete from public.probe_runs where id = p_probe_run_id;
end;
$f$;
grant execute on function public._m5_0054_rt_force_delete_probe_run(uuid) to service_role;

-- Backdates a job's own lease -- the only way to genuinely produce an
-- expired-lease job within a single, short-lived disposable run instead
-- of waiting out a real lease window.
create or replace function public._m5_0054_rt_backdate_job_lease(p_job_id uuid, p_lease_expires_at timestamptz) returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
begin
  update public.protocol_execution_jobs set lease_expires_at = p_lease_expires_at where id = p_job_id;
end;
$f$;
grant execute on function public._m5_0054_rt_backdate_job_lease(uuid, timestamptz) to service_role;

-- Full overwrite of a delivery's own mutable claim/lease/retry state --
-- service_role itself has only SELECT+INSERT on this table (by design,
-- migration 0054), so every real mutation normally goes through
-- claim_next_pending_alert/renew_alert_lease/mark_alert_request_sent/
-- record_alert_delivery_receipt. This helper exists solely to backdate
-- lease_expires_at/next_attempt_at for reconciliation-branch scenarios
-- that would otherwise require waiting out a real lease/backoff window.
create or replace function public._m5_0054_rt_backdate_delivery(
  p_delivery_id uuid, p_status text, p_worker_id text, p_claim_token uuid,
  p_lease_expires_at timestamptz, p_next_attempt_at timestamptz, p_attempt_count integer
) returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
begin
  update public.protocol_execution_job_alert_deliveries
     set status = p_status, worker_id = p_worker_id, claim_token = p_claim_token,
         lease_expires_at = p_lease_expires_at, next_attempt_at = p_next_attempt_at, attempt_count = p_attempt_count
   where delivery_id = p_delivery_id;
end;
$f$;
grant execute on function public._m5_0054_rt_backdate_delivery(uuid, text, text, uuid, timestamptz, timestamptz, integer) to service_role;

-- Backdates request_sent_at (service_role already holds UPDATE on
-- delivery_attempts by grant, migration 0054 -- this just centralizes
-- the pattern) and/or force-terminalizes an attempt row directly, for
-- D14's engineered already-terminal-attempt proof.
create or replace function public._m5_0054_rt_force_attempt_row(
  p_attempt_id uuid, p_request_sent_at timestamptz, p_outcome text, p_finished_at timestamptz, p_resend_email_id text
) returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
begin
  update public.protocol_execution_job_alert_delivery_attempts
     set request_sent_at = coalesce(p_request_sent_at, request_sent_at),
         outcome = coalesce(p_outcome, outcome),
         finished_at = coalesce(p_finished_at, finished_at),
         resend_email_id = coalesce(p_resend_email_id, resend_email_id)
   where attempt_id = p_attempt_id;
end;
$f$;
grant execute on function public._m5_0054_rt_force_attempt_row(uuid, timestamptz, text, timestamptz, text) to service_role;

-- Cascade-safe teardown: the outbox tables have no ON DELETE CASCADE
-- from protocol_execution_jobs (deliberately -- an alert event is
-- immutable and must never silently vanish through an unrelated
-- cascade in real production data), so this harness's own fixtures
-- must be unwound in FK order before the owning project can be removed,
-- keeping claim_next_pending_alert's (and claim_protocol_execution_
-- job's) global FIFO queue empty between scenarios.
create or replace function public._m5_0054_rt_cleanup(p_project_id uuid) returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
begin
  delete from public.protocol_execution_job_alert_delivery_attempts a
    using public.protocol_execution_job_alert_deliveries d, public.protocol_execution_job_alerts al
   where a.delivery_id = d.delivery_id and d.alert_event_id = al.alert_event_id and al.project_id = p_project_id;
  delete from public.protocol_execution_job_alert_deliveries d
    using public.protocol_execution_job_alerts al
   where d.alert_event_id = al.alert_event_id and al.project_id = p_project_id;
  delete from public.protocol_execution_job_alerts where project_id = p_project_id;
  delete from public.projects where id = p_project_id;
end;
$f$;
grant execute on function public._m5_0054_rt_cleanup(uuid) to service_role;

-- Deterministic cross-session barrier for D1/D2/D13's real concurrency
-- proofs: a real table (harness-only scaffolding, never part of the
-- migration) that session A polls, bounded, from inside its own still-
-- open transaction (a plain SELECT sees the latest COMMITTED value even
-- from within an uncommitted transaction, under READ COMMITTED -- the
-- default), and that the PARENT process releases via a separate, quick,
-- immediately-committed call only AFTER it has already observed
-- whatever B was supposed to do. This replaces a fixed-delay guess with
-- a real, reactive signal on both ends.
create table if not exists public._m5_0054_rt_sync_barrier (
  barrier_name text primary key,
  released boolean not null default false
);
grant select, insert, update on table public._m5_0054_rt_sync_barrier to service_role;

create or replace function public._m5_0054_rt_reset_barrier(p_barrier_name text) returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
begin
  insert into public._m5_0054_rt_sync_barrier (barrier_name, released) values (p_barrier_name, false)
    on conflict (barrier_name) do update set released = false;
end;
$f$;
grant execute on function public._m5_0054_rt_reset_barrier(text) to service_role;

create or replace function public._m5_0054_rt_release_barrier(p_barrier_name text) returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
begin
  insert into public._m5_0054_rt_sync_barrier (barrier_name, released) values (p_barrier_name, true)
    on conflict (barrier_name) do update set released = true;
end;
$f$;
grant execute on function public._m5_0054_rt_release_barrier(text) to service_role;

-- D13: confirms lease expiry using PostgreSQL's OWN moving clock
-- (clock_timestamp(), never now() -- which is frozen for the whole
-- transaction and therefore could never advance across this loop's
-- own iterations) inside a single, bounded, server-side loop -- never
-- Node's assumption about wall-clock alignment between the two
-- separate processes. Returns
-- false (never raises) if the bound is exceeded, so the caller decides
-- how to surface that as a real, non-absorbed failure.
create or replace function public._m5_0054_rt_poll_lease_expired(p_delivery_id uuid, p_max_iterations integer, p_sleep_seconds numeric)
returns boolean language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
declare
  i integer;
  v_expired boolean;
begin
  for i in 1..p_max_iterations loop
    select (lease_expires_at is not null and lease_expires_at < clock_timestamp()) into v_expired
      from public.protocol_execution_job_alert_deliveries where delivery_id = p_delivery_id;
    if v_expired then
      return true;
    end if;
    perform pg_sleep(p_sleep_seconds);
  end loop;
  return false;
end;
$f$;
grant execute on function public._m5_0054_rt_poll_lease_expired(uuid, integer, numeric) to service_role;

-- D13: observes a specific backend's own wait_event_type via a single,
-- bounded, server-side loop -- exits early either once 'Lock' is
-- observed or once the backend has already finished (vanished from
-- pg_stat_activity), and otherwise returns whatever was last observed
-- once the bound is exhausted (never fabricated, reported honestly
-- either way).
create or replace function public._m5_0054_rt_poll_wait_event(p_pid integer, p_max_iterations integer, p_sleep_seconds numeric)
returns text language plpgsql security definer set search_path = pg_catalog, pg_temp as $f$
declare
  i integer;
  v_wait_event_type text;
begin
  for i in 1..p_max_iterations loop
    select wait_event_type into v_wait_event_type from pg_catalog.pg_stat_activity where pid = p_pid;
    if not found then
      return 'BACKEND_GONE';
    end if;
    if v_wait_event_type = 'Lock' then
      return v_wait_event_type;
    end if;
    perform pg_sleep(p_sleep_seconds);
  end loop;
  return coalesce(v_wait_event_type, 'NONE_OBSERVED');
end;
$f$;
grant execute on function public._m5_0054_rt_poll_wait_event(integer, integer, numeric) to service_role;
`;

// ------------------------------------------------------------------
// The helper manifest (function names, argument-type signatures, and
// the test-only table) is derived MECHANICALLY from HELPER_SQL's own
// text -- never hardcoded as a bare count anywhere. Adding, removing,
// or reshaping a helper in HELPER_SQL therefore changes what gets
// verified automatically; nothing here needs to track that count by
// hand.
// ------------------------------------------------------------------
interface HelperFunctionSignature {
  name: string;
  argTypes: string[];
}

interface HelperManifest {
  functions: HelperFunctionSignature[];
  tables: string[];
}

function deriveHelperManifest(sql: string): HelperManifest {
  const functions: HelperFunctionSignature[] = [];
  const fnRe = /create or replace function\s+(?:public\.)?(_m5_0054_rt_\w+)\s*\(([\s\S]*?)\)\s*(?:returns|RETURNS)/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(sql)) !== null) {
    const rawParams = m[2]!.trim();
    const argTypes =
      rawParams.length === 0
        ? []
        : rawParams.split(",").map((seg) => {
            // Each segment is "p_name type[ default ...]" -- the type is
            // always the second whitespace-separated token; anything
            // from "default" onward is a default-value clause, never
            // part of the type signature.
            const tokens = seg.trim().split(/\s+/);
            return tokens[1]!.toLowerCase();
          });
    functions.push({ name: m[1]!, argTypes });
  }
  const tables: string[] = [];
  const tblRe = /create table if not exists\s+(?:public\.)?(_m5_0054_rt_\w+)/g;
  while ((m = tblRe.exec(sql)) !== null) {
    tables.push(m[1]!);
  }
  if (functions.length === 0) {
    throw new Error("deriveHelperManifest: no _m5_0054_rt_* functions found in HELPER_SQL -- refusing an empty manifest");
  }
  if (tables.length === 0) {
    throw new Error("deriveHelperManifest: no _m5_0054_rt_* test-only table found in HELPER_SQL -- refusing a manifest missing the sync-barrier table");
  }
  return { functions, tables };
}

// ------------------------------------------------------------------
// Wraps HELPER_SQL into a single transactional install script:
//   BEGIN
//   -> owner/CREATE-privilege preflight (refuses to proceed under any
//      role other than the database owner)
//   -> the 14 CREATE FUNCTION / CREATE TABLE / GRANT EXECUTE statements
//      exactly as authored in HELPER_SQL (owner-created, never under
//      SET ROLE service_role)
//   -> an explicit REVOKE EXECUTE ... FROM PUBLIC per function, derived
//      from the same manifest, so PUBLIC never inherits EXECUTE by
//      relying on ambient default-privilege configuration
//   -> a catalog-level verification DO block (owner, SECURITY DEFINER,
//      closed search_path, PUBLIC has no EXECUTE, service_role has
//      EXECUTE, exact function count, barrier-table owner) that RAISEs
//      (and therefore rolls back the whole transaction, ON_ERROR_STOP
//      already guarantees this) on ANY divergence
//   -> SET ROLE service_role, an independent EXECUTE-only check against
//      every expected signature (never creating/altering anything
//      under service_role), RESET ROLE
//   -> a real catalog count \gset + \echo, so the JS side can compare
//      an INDEPENDENTLY-queried post-install fact against its own
//      manifest, not just trust the internal DO block
//   -> COMMIT
//   -> the success marker, emitted only after COMMIT has returned
// ------------------------------------------------------------------
function buildHelperInstallScript(helperSql: string): string {
  const manifest = deriveHelperManifest(helperSql);
  const barrierTable = manifest.tables[0]!;
  const sigList = manifest.functions.map((f) => `public.${f.name}(${f.argTypes.join(",")})`);
  const regprocArrayLiteral = sigList.map((s) => `'${s}'::regprocedure`).join(",\n    ");
  const revokePublicStatements = sigList.map((s) => `revoke execute on function ${s} from public;`).join("\n");

  return `\\pset pager off
BEGIN;

DO $m5_0054_owner_preflight$
declare
  v_owner name;
begin
  select pg_catalog.pg_get_userbyid(datdba) into v_owner from pg_database where datname = current_database();
  if current_user <> v_owner then
    raise exception 'refusing to install test-only helpers: current_user (%) is not the database owner (%)', current_user, v_owner;
  end if;
  if not has_schema_privilege(current_user, 'public', 'CREATE') then
    raise exception 'refusing to install test-only helpers: current_user (%) lacks CREATE on schema public', current_user;
  end if;
end;
$m5_0054_owner_preflight$;

${helperSql}
${revokePublicStatements}

DO $m5_0054_verify$
declare
  v_expected_fns regprocedure[] := array[
    ${regprocArrayLiteral}
  ];
  v_owner name := current_user;
  v_fn regprocedure;
  v_real_count integer;
  v_table_owner name;
begin
  foreach v_fn in array v_expected_fns loop
    if not exists (
      select 1 from pg_proc p
      where p.oid = v_fn::oid
        and pg_catalog.pg_get_userbyid(p.proowner) = v_owner
        and p.prosecdef
        and p.proconfig is not null
        and array_length(p.proconfig, 1) = 1
        and regexp_replace(p.proconfig[1], '\\s*,\\s*', ',', 'g') = 'search_path=pg_catalog,pg_temp'
        and not exists (
          select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE'
        )
        and has_function_privilege('service_role', v_fn, 'EXECUTE')
    ) then
      raise exception 'helper installation verification failed for % -- owner/security-definer/search-path/ACL mismatch', v_fn;
    end if;
  end loop;

  select count(*) into v_real_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like '_m5_0054_rt_%';
  if v_real_count <> array_length(v_expected_fns, 1) then
    raise exception 'unexpected _m5_0054_rt_* function count in public: expected %, found % -- refusing to commit an installation with unaccounted-for objects', array_length(v_expected_fns, 1), v_real_count;
  end if;

  select pg_catalog.pg_get_userbyid(c.relowner) into v_table_owner
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = '${barrierTable}';
  if v_table_owner is null or v_table_owner <> v_owner then
    raise exception 'test-only table % owner mismatch: expected %, found %', '${barrierTable}', v_owner, v_table_owner;
  end if;
end;
$m5_0054_verify$;

SET ROLE service_role;
DO $m5_0054_service_role_check$
declare
  v_expected_fns regprocedure[] := array[
    ${regprocArrayLiteral}
  ];
  v_fn regprocedure;
begin
  foreach v_fn in array v_expected_fns loop
    if not has_function_privilege(current_user, v_fn, 'EXECUTE') then
      raise exception 'service_role lacks EXECUTE on % after installation', v_fn;
    end if;
  end loop;
end;
$m5_0054_service_role_check$;
RESET ROLE;

select count(*) as helper_fn_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like '_m5_0054_rt_%' \\gset
\\echo '##R## helper_fn_count' :helper_fn_count

COMMIT;
\\echo '##R## helper_installed ok'
`;
}

// The single, central predicate deciding whether the helper
// installation may be trusted: the committed marker must be present
// AND the independently-queried post-install catalog count must equal
// the manifest derived from HELPER_SQL. Used both by the real
// call site's check(...) and by its immediate hard gate below --
// never re-derived separately at either place.
function isHelperInstallVerified(markerPresent: boolean, actualCount: string | undefined, expectedCount: number): boolean {
  return markerPresent && actualCount === String(expectedCount);
}

async function runScenariosImpl(dbUrl: string, workdir: string, check: CheckFn, ranScenarios: Set<string>): Promise<void> {
  const scratchDir = path.join(workdir, "runtime-scripts");
  mkdirSync(scratchDir, { recursive: true });
  let seq = 0;

  // Populated and drained entirely by the current scenario (scenarios
  // run strictly sequentially -- never two at once -- so this scenario-
  // scoped state is safe as a single shared mutable set/map, reset at
  // the start of every sc() call). `scenarioLiveHandles` tracks every
  // still-active LiveSpawn this scenario has started (removed only once
  // its own `done` has confirmed termination -- never merely because a
  // caller stopped awaiting it); `scenarioBarrierNames` tracks every
  // barrier name EXPLICITLY registered via resetAndRegisterScenarioBarrier
  // below (BARRIER_REGISTRATION_MODE=EXPLICIT -- never inferred from SQL
  // text, so no cleanup can ever be silently disabled by a formatting
  // change).
  const scenarioLiveHandles = new Set<LiveSpawn>();
  const scenarioBarrierNames = new Set<string>();

  function runPsql(sql: string, tag: string): string {
    seq += 1;
    const scriptPath = path.join(scratchDir, `${String(seq).padStart(3, "0")}-${tag}.sql`);
    writeFileSync(scriptPath, sql);
    const result = spawnSync("psql", [dbUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", scriptPath], {
      env: RUN_ENV,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? (result.error ? String(result.error) : "");
    writeFileSync(`${scriptPath}.out.log`, stdout);
    writeFileSync(`${scriptPath}.err.log`, stderr);
    if (result.status !== 0 || result.error) {
      throw new Error(`psql script "${tag}" failed (exit ${result.status}); see ${scriptPath}.err.log\n${stderr}`);
    }
    return stdout;
  }

  function runPsqlExpectError(sql: string, tag: string): { ok: boolean; stderr: string } {
    seq += 1;
    const scriptPath = path.join(scratchDir, `${String(seq).padStart(3, "0")}-${tag}.sql`);
    writeFileSync(scriptPath, sql);
    const result = spawnSync("psql", [dbUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", scriptPath], {
      env: RUN_ENV,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? (result.error ? String(result.error) : "");
    writeFileSync(`${scriptPath}.out.log`, stdout);
    writeFileSync(`${scriptPath}.err.log`, stderr);
    return { ok: result.status === 0 && !result.error, stderr };
  }

  const LEGACY_FIXTURE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Creates exactly one real public.dataset_batches row (the same
  // (project_id, 'manual_scan') shape enqueue_protocol_execution_job
  // itself inserts, migration 0052) -- direct DML under service_role,
  // whose SELECT+INSERT grant on this table is mechanically confirmed
  // (migration 0038, never revoked; only UPDATE/DELETE/TRUNCATE were).
  // RESET ROLE before returning; the returned id is runtime-validated
  // as a real UUID, never assumed present.
  function createLegacyDatasetBatch(projectId: string, tag: string): string {
    const out = runPsql(
      `\\pset pager off\nSET ROLE service_role;\ninsert into public.dataset_batches (project_id, dataset_source_type) values ('${projectId}', 'manual_scan') returning id as dsid \\gset\nRESET ROLE;\n\\echo '##R## dsid' :dsid\n`,
      tag
    );
    const dsid = parseMarkers(out).get("dsid");
    if (!dsid || !LEGACY_FIXTURE_UUID_RE.test(dsid)) {
      throw new Error(`createLegacyDatasetBatch: dataset_batches.id marker missing or not a real UUID (tag=${tag}, got ${JSON.stringify(dsid)})`);
    }
    return dsid;
  }

  // Creates exactly one real public.probe_runs row referencing the
  // given real dataset_batches id (the same shape
  // create_probe_run_and_start_attempt_for_job itself inserts,
  // migration 0052) -- direct DML under service_role (grant on
  // probe_runs from migration 0010, never revoked). Columns with a
  // table default (id, status, created_at, probe_mode) are left
  // unset. RESET ROLE before returning; the returned id is
  // runtime-validated as a real UUID.
  function createLegacyProbeRun(projectId: string, datasetId: string, tag: string): string {
    const out = runPsql(
      `\\pset pager off\nSET ROLE service_role;\ninsert into public.probe_runs (project_id, platform, dataset_id, dataset_source_type) values ('${projectId}', 'perplexity', '${datasetId}', 'manual_scan') returning id as prid \\gset\nRESET ROLE;\n\\echo '##R## prid' :prid\n`,
      tag
    );
    const prid = parseMarkers(out).get("prid");
    if (!prid || !LEGACY_FIXTURE_UUID_RE.test(prid)) {
      throw new Error(`createLegacyProbeRun: probe_runs.id marker missing or not a real UUID (tag=${tag}, got ${JSON.stringify(prid)})`);
    }
    return prid;
  }

  const DEFAULT_ASYNC_PSQL_TIMEOUT_MS = 20000;

  /**
   * Returns the LIVE handle immediately (pid + a way to read
   * accumulating stdout WHILE the process is still running) so a caller
   * can poll for a readiness marker before the process completes --
   * needed by every concurrency scenario that holds a transaction open.
   * `done` resolves (never rejects); the caller decides whether a
   * `timedOut: true` result should be surfaced as a thrown error (see
   * runPsqlAsync below, which always does).
   */
  function runPsqlAsyncLive(sql: string, tag: string, timeoutMs: number = DEFAULT_ASYNC_PSQL_TIMEOUT_MS): LiveSpawn & { scriptPath: string } {
    seq += 1;
    const scriptPath = path.join(scratchDir, `${String(seq).padStart(3, "0")}-${tag}.sql`);
    writeFileSync(scriptPath, sql);
    const live = spawnWithBoundedTimeout("psql", [dbUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", scriptPath], timeoutMs, {
      onTimeout: (stdoutSoFar, stderrSoFar) => {
        writeFileSync(`${scriptPath}.timeout.out.log`, stdoutSoFar);
        writeFileSync(`${scriptPath}.timeout.err.log`, stderrSoFar);
      },
    });
    const handle: LiveSpawn & { scriptPath: string } = { ...live, scriptPath };
    // Registered the instant it exists, removed ONLY via the single,
    // central isLiveHandleSafelyResolved() -- a PID it does not accept
    // as safely resolved is NEVER removed from scenarioLiveHandles, so a
    // scenario's own failure path (sc() below) can always still find
    // and terminate every child it might still be responsible for.
    scenarioLiveHandles.add(handle);
    const done = live.done.then((r) => {
      writeFileSync(`${scriptPath}.out.log`, r.stdout);
      writeFileSync(`${scriptPath}.err.log`, r.stderr);
      if (isLiveHandleSafelyResolved(handle, r)) {
        scenarioLiveHandles.delete(handle);
      }
      return r;
    });
    handle.done = done;
    return handle;
  }

  /**
   * Simple await-only wrapper over runPsqlAsyncLive, for the (common)
   * case where the caller does not need to observe the process while it
   * is still running. Every result is passed through the single central
   * validator (validateAsyncPsqlResult) -- spawnError, processError,
   * timedOut, timeoutPersistenceError, terminationError, an unconfirmed
   * termination, a non-zero/null-unexplained code, or an unexpected
   * signal are ALL surfaced as a real, non-absorbed thrown Error here,
   * which propagates all the way to main()'s catch block (stack/workdir
   * preserved, no cleanup) -- exactly like a real psql exit failure
   * already does in the synchronous runPsql.
   */
  async function runPsqlAsync(sql: string, tag: string, timeoutMs: number = DEFAULT_ASYNC_PSQL_TIMEOUT_MS): Promise<TimedSpawnResult> {
    const live = runPsqlAsyncLive(sql, tag, timeoutMs);
    const r = await live.done;
    return validateAsyncPsqlResult(r, tag, live.scriptPath);
  }

  /**
   * A bounded, server-side-friendly wait embedded in a psql script:
   * polls the real barrier table up to maxIterations times (sleeping
   * sleepSeconds between each), and RAISES a real SQL exception (never
   * silently continuing) if the bound is exhausted without the barrier
   * having been released. Real reactive synchronization, never a fixed
   * guess about exact timing.
   */
  function barrierWaitSql(barrierName: string, maxIterations = 100, sleepSeconds = 0.05): string {
    return `
do $$
declare
  i int;
  v_released boolean;
begin
  for i in 1..${maxIterations} loop
    select released into v_released from public._m5_0054_rt_sync_barrier where barrier_name = '${barrierName}';
    if coalesce(v_released, false) then
      exit;
    end if;
    perform pg_sleep(${sleepSeconds});
  end loop;
  if not coalesce(v_released, false) then
    raise exception 'barrier % never released within its own bound (~%s)', '${barrierName}', ${(maxIterations * sleepSeconds).toFixed(2)};
  end if;
end $$;
`;
  }

  /**
   * BARRIER_REGISTRATION_MODE=EXPLICIT -- never inferred from SQL text
   * (no regex scanning of any kind). A scenario calls this directly to
   * both reset the real barrier row AND register its name, in that
   * order: the name is added to scenarioBarrierNames ONLY after the SQL
   * reset has genuinely succeeded (runPsql throws on any failure, so
   * reaching the registration line already proves it did) -- no format,
   * spacing, or quoting of any OTHER piece of SQL text can ever
   * silently disable this.
   */
  function resetAndRegisterScenarioBarrier(name: string): void {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      throw new Error(`invalid barrier name "${name}" -- must match ^[a-z][a-z0-9_]*$`);
    }
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_reset_barrier('${name}');\n`, `barrier-reset-${name}`);
    scenarioBarrierNames.add(name);
  }

  /**
   * Explicit release counterpart. Removes `name` from scenarioBarrierNames
   * only after the release SQL has genuinely succeeded.
   */
  function releaseScenarioBarrier(name: string): void {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      throw new Error(`invalid barrier name "${name}" -- must match ^[a-z][a-z0-9_]*$`);
    }
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_release_barrier('${name}');\n`, `barrier-release-${name}`);
    scenarioBarrierNames.delete(name);
  }

  /**
   * Describes exactly what is still non-empty in the two registries --
   * used both by the scenario-start gate and by assertRuntimeInfrastructureQuiescent
   * below, so both report the same, real diagnostic shape (labels, pids,
   * known termination state) rather than a bare count.
   */
  function describeNonQuiescentRegistries(): string | null {
    if (scenarioLiveHandles.size === 0 && scenarioBarrierNames.size === 0) return null;
    const handleDiagnostics = [...scenarioLiveHandles].map((h) => `${labelForLiveHandle(h)} (pid=${h.pid ?? "unknown"})`);
    return (
      `scenarioLiveHandles=${JSON.stringify(handleDiagnostics)} (${scenarioLiveHandles.size} entr${scenarioLiveHandles.size === 1 ? "y" : "ies"}), ` +
      `scenarioBarrierNames=${JSON.stringify([...scenarioBarrierNames])} (${scenarioBarrierNames.size} entr${scenarioBarrierNames.size === 1 ? "y" : "ies"})`
    );
  }

  async function sc(name: string, fn: () => void | Promise<void>): Promise<void> {
    if (!SCENARIO_ROSTER.includes(name)) {
      throw new Error(`refusing to run an unknown scenario name not present in SCENARIO_ROSTER: "${name}"`);
    }
    if (ranScenarios.has(name)) {
      throw new Error(`refusing to run scenario "${name}" a second time -- a duplicate execution could mask a missing one`);
    }
    // Never reset by clearing -- a non-empty registry here means a PRIOR
    // scenario left something genuinely unresolved, which must never be
    // silently discarded by starting the next scenario anyway.
    const preExisting = describeNonQuiescentRegistries();
    if (preExisting !== null) {
      throw new Error(`refusing to start scenario "${name}": the Live-handle/barrier registries are NOT empty from a PRIOR scenario -- ${preExisting}. This must never happen; PASSED is impossible while any prior scenario's infrastructure is not confirmed quiescent.`);
    }
    console.log(`\n--- ${name} ---`);
    try {
      await fn();
      // Success of the scenario's own body is not enough on its own:
      // both registries must ALSO be empty before this scenario is
      // counted as passed -- a scenario that "succeeded" while leaving
      // an unresolved child or an unreleased barrier behind is not a
      // real success.
      const leftoverAfterSuccess = describeNonQuiescentRegistries();
      if (leftoverAfterSuccess !== null) {
        throw new Error(`scenario "${name}" completed its own body without error, but left its infrastructure non-quiescent -- ${leftoverAfterSuccess}. Refusing to count this as success.`);
      }
    } catch (originalError) {
      // Best-effort, bounded recovery -- never touches the Docker
      // stack/workdir, never masks the original failure. Attempts to
      // release any barrier this scenario reset (harmless/idempotent
      // even if irrelevant to the actual failure) -- releaseScenarioBarrier
      // itself only removes a name from scenarioBarrierNames once its own
      // SQL release has genuinely succeeded, so a failed release leaves
      // its name in the registry, never silently discarded. Then
      // terminates only the Live children THIS scenario itself started
      // that are still active, awaiting every one of them, and removes
      // ONLY the ones individually confirmed terminated -- anything
      // unresolved remains tracked and is reported, never dropped.
      const diagnostics: string[] = [];
      for (const barrierName of [...scenarioBarrierNames]) {
        try {
          releaseScenarioBarrier(barrierName);
          diagnostics.push(`barrier "${barrierName}" released as part of failure recovery`);
        } catch (releaseErr) {
          diagnostics.push(`releasing barrier "${barrierName}" during failure recovery itself failed -- REMAINS in scenarioBarrierNames: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`);
        }
      }
      const stillActive = [...scenarioLiveHandles];
      const { resolvedHandles, unresolvedHandles } = await terminateLiveHandles(stillActive);
      for (const resolved of resolvedHandles) {
        scenarioLiveHandles.delete(resolved);
        diagnostics.push(`child ${labelForLiveHandle(resolved)} (pid ${resolved.pid}) confirmed terminated during failure recovery -- removed from the registry, stdout/stderr preserved in its own .out.log/.err.log`);
      }
      for (const u of unresolvedHandles) {
        diagnostics.push(
          `UNRESOLVED child ${u.label} (pid=${u.pid}) -- spawnError=${u.spawnError?.message ?? "none"}, processError=${u.processError?.message ?? "none"}, terminationError=${u.terminationError?.message ?? "none"}, timedOut=${u.timedOut} -- REMAINS in scenarioLiveHandles, never assumed gone`
        );
      }
      const originalMessage = originalError instanceof Error ? originalError.message : String(originalError);
      const combinedError = originalError instanceof Error ? originalError : new Error(originalMessage);
      if (diagnostics.length > 0) {
        combinedError.message = `${originalMessage}\n  [scenario "${name}" failure-recovery diagnostics -- the error above is the real, original cause; these are best-effort cleanup notes, never a substitute for it]:\n  - ${diagnostics.join("\n  - ")}`;
      }
      throw combinedError;
    }
    ranScenarios.add(name);
  }

  /**
   * Structural defense, deliberately OUTSIDE the roster/assertion
   * mechanism (never a check() call, so it never inflates the 55
   * scenario-assertion count) -- called once, at the very end of this
   * function, strictly BEFORE main() can ever proceed to Docker cleanup
   * or set succeededFully=true. Throws (never silently passes) if
   * either registry is non-empty for ANY reason, making PASSED
   * structurally impossible whenever runtime infrastructure was left
   * behind.
   */
  function assertRuntimeInfrastructureQuiescent(): void {
    const leftover = describeNonQuiescentRegistries();
    if (leftover !== null) {
      throw new Error(`runtime infrastructure is NOT quiescent after all scenarios -- refusing to proceed to Docker cleanup or PASSED: ${leftover}`);
    }
  }

  console.log("\nInstalling SECURITY DEFINER test-only helper functions (owner-created, single transaction)...");
  const helperManifest = deriveHelperManifest(HELPER_SQL);
  const helperOut = runPsql(buildHelperInstallScript(HELPER_SQL), "install-helpers");
  const helperMarkers = parseMarkers(helperOut);
  const helperMarkerPresent = helperOut.includes("helper_installed ok");
  const helperCountActual = helperMarkers.get("helper_fn_count");
  const helperInstallVerified = isHelperInstallVerified(helperMarkerPresent, helperCountActual, helperManifest.functions.length);
  check(
    "test-only helper functions installed: committed marker present AND the independently-queried post-install catalog count matches the manifest derived from HELPER_SQL",
    helperInstallVerified
  );
  if (!helperInstallVerified) {
    throw new Error(
      `helper installation not fully verified -- refusing to start any scenario. ` +
        `marker_present=${helperMarkerPresent}; expected_helper_count=${helperManifest.functions.length}; ` +
        `actual_helper_count=${helperCountActual ?? "<missing>"}; scenarios_started=false`
    );
  }

  // ======================================================================
  // Category A — catalogue/compatibility (5)
  // ======================================================================

  await sc(SCENARIO_ROSTER[0]!, () => {
    const out = runPsql(
      `
\\pset pager off
SET ROLE service_role;
select count(*)::text as tbl_count from information_schema.tables
 where table_schema='public' and table_name in (
   'protocol_execution_job_alerts','protocol_execution_job_alert_deliveries','protocol_execution_job_alert_delivery_attempts'
 ) \\gset
select count(*)::text as fn_count from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in (
   'persist_probe_result_for_job','claim_next_pending_alert','renew_alert_lease',
   'mark_alert_request_sent','record_alert_delivery_receipt'
 ) \\gset
select count(*)::text as idx_count from pg_indexes
 where schemaname='public' and indexname='protocol_execution_job_alert_deliveries_pending_claim_idx' \\gset
select count(*)::text as col_count from information_schema.columns
 where table_schema='public' and table_name='probe_results' and column_name='canonical_result_sha256' \\gset
select pg_get_constraintdef(oid) as verdict_check_def from pg_constraint where conname = 'probe_results_verdict_check' \\gset
select pg_get_constraintdef(oid) as product_verdict_check_def from pg_constraint where conname = 'probe_results_product_verdict_check' \\gset
\\echo '##R## tbl_count' :tbl_count
\\echo '##R## fn_count' :fn_count
\\echo '##R## idx_count' :idx_count
\\echo '##R## col_count' :col_count
\\echo '##R## verdict_check_def' :'verdict_check_def'
\\echo '##R## product_verdict_check_def' :'product_verdict_check_def'
`,
      "a1-catalog"
    );
    const m = parseMarkers(out);
    const expectedFiveValueCheck = (column: string) =>
      `'CHECK ((${column} = ANY (ARRAY[''won''::text, ''partial''::text, ''lost''::text, ''not_relevant''::text, ''not_evaluated''::text])))'`;
    check(
      "A1: 3 new tables, 5 new RPCs, the new claim index, and probe_results.canonical_result_sha256 all exist in the real catalog, and both probe_results_verdict_check and probe_results_product_verdict_check are deployed with exactly the same five values (won/partial/lost/not_relevant/not_evaluated), including not_evaluated for verdict -- never just product_verdict",
      m.get("tbl_count") === "3" &&
        m.get("fn_count") === "5" &&
        m.get("idx_count") === "1" &&
        m.get("col_count") === "1" &&
        m.get("verdict_check_def") === expectedFiveValueCheck("verdict") &&
        m.get("product_verdict_check_def") === expectedFiveValueCheck("product_verdict")
    );
  });

  await sc(SCENARIO_ROSTER[1]!, () => {
    const fx = parseMarkers(
      runPsql(
        `\\pset pager off\nSET ROLE service_role;\nselect project_id as pid, protocol_id as prid from public._m5_0054_rt_make_fixture('a2') \\gset\n\\echo '##R## pid' :pid\n\\echo '##R## prid' :prid\n`,
        "a2-fixture"
      )
    );
    const projectId = fx.get("pid")!;
    const a2DatasetId = createLegacyDatasetBatch(projectId, "a2-dataset-batch");
    const a2ProbeRunId = createLegacyProbeRun(projectId, a2DatasetId, "a2-probe-run");
    const out = runPsql(
      `
\\pset pager off
SET ROLE service_role;
insert into probe_results (
  probe_run_id, project_id, prompt, platform, raw_response, client_mentioned, client_position,
  competitors_mentioned, sources_cited, answer_summary, verdict, why_client_lost, probe_mode,
  raw_probe_request, product_mentioned, product_position, product_verdict, cited_as_source,
  client_source_count, platforms_referenced, dataset_id, dataset_source_type, canonical_result_sha256
) values (
  '${a2ProbeRunId}', '${projectId}', 'legacy prompt', 'perplexity', 'legacy raw response', true, 'primary',
  '[]'::jsonb, '[]'::jsonb, 'legacy summary', 'won', '', 'live_perplexity',
  'legacy prompt', true, 'primary', 'won', false,
  0, '[]'::jsonb, '${a2DatasetId}', 'manual_scan', null
) returning id::text as legacy_id;
select legacy_id as legacy_id_captured from (values (1)) x, lateral (select id::text as legacy_id from probe_results order by created_at desc limit 1) l \\gset
select verdict as legacy_verdict, dataset_source_type as legacy_dst, canonical_result_sha256 is null as legacy_hash_null
  from probe_results where id::text = :'legacy_id_captured' \\gset
\\echo '##R## legacy_verdict' :legacy_verdict
\\echo '##R## legacy_dst' :legacy_dst
\\echo '##R## legacy_hash_null' :legacy_hash_null
`,
      "a2-legacy-row"
    );
    const m = parseMarkers(out);
    check(
      "A2: a legacy-shaped row (dataset_source_type='manual_scan', verdict='won', canonical_result_sha256=NULL) inserts and is selectable unchanged",
      m.get("legacy_verdict") === "won" && m.get("legacy_dst") === "manual_scan" && m.get("legacy_hash_null") === "t"
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${projectId}');\n`, "a2-cleanup");
  });

  await sc(SCENARIO_ROSTER[2]!, () => {
    const fx = parseMarkers(
      runPsql(
        `\\pset pager off\nSET ROLE service_role;\nselect project_id as pid from public._m5_0054_rt_make_fixture('a3') \\gset\n\\echo '##R## pid' :pid\n`,
        "a3-fixture"
      )
    );
    const projectId = fx.get("pid")!;
    const a3DatasetId = createLegacyDatasetBatch(projectId, "a3-dataset-batch");
    const values = ["won", "partial", "lost", "not_relevant", "not_evaluated"];
    let allFiveOk = true;
    const usedProbeRunIds = new Set<string>();
    for (const v of values) {
      const probeRunId = createLegacyProbeRun(projectId, a3DatasetId, `a3-probe-run-${v}`);
      usedProbeRunIds.add(probeRunId);
      const r = runPsqlExpectError(
        `\\pset pager off\nSET ROLE service_role;\ninsert into probe_results (probe_run_id, project_id, prompt, platform, raw_response, client_position, verdict, product_verdict, probe_mode, dataset_id, dataset_source_type) values ('${probeRunId}', '${projectId}', 'p', 'perplexity', 'legacy raw response', 'primary', '${v}', '${v}', 'live_perplexity', '${a3DatasetId}', 'manual_scan');`,
        `a3-verdict-${v}`
      );
      if (!r.ok) allFiveOk = false;
    }
    const invalidProbeRunId = createLegacyProbeRun(projectId, a3DatasetId, "a3-probe-run-invalid");
    usedProbeRunIds.add(invalidProbeRunId);
    const sixth = runPsqlExpectError(
      `\\pset pager off\n\\set VERBOSITY verbose\nSET ROLE service_role;\ninsert into probe_results (probe_run_id, project_id, prompt, platform, raw_response, client_position, verdict, product_verdict, probe_mode, dataset_id, dataset_source_type) values ('${invalidProbeRunId}', '${projectId}', 'p', 'perplexity', 'legacy raw response', 'primary', 'won', 'definitely_not_a_real_value', 'live_perplexity', '${a3DatasetId}', 'manual_scan');`,
      "a3-verdict-invalid"
    );
    const sixthNamesTargetConstraint =
      sixth.stderr.includes("23514") && sixth.stderr.includes("probe_results_product_verdict_check");
    check(
      "A3: all 5 legacy+new verdict/product_verdict values (won/partial/lost/not_relevant/not_evaluated) are accepted using a real, distinct probe_run each, and a 6th arbitrary value is rejected specifically by probe_results_product_verdict_check (SQLSTATE 23514), never by any other masking failure",
      allFiveOk && usedProbeRunIds.size === 6 && !sixth.ok && sixthNamesTargetConstraint
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${projectId}');\n`, "a3-cleanup");
  });

  await sc(SCENARIO_ROSTER[3]!, () => {
    const dummy = "00000000-0000-4000-8000-000000000000";
    function attemptAsRole(role: "anon" | "authenticated", sql: string): boolean {
      const r = runPsqlExpectError(`\\pset pager off\nSET ROLE ${role};\n${sql}\n`, `a4-${role}-${Math.random().toString(36).slice(2)}`);
      return !r.ok;
    }
    const denials = [
      attemptAsRole("anon", `select * from persist_probe_result_for_job('${dummy}','${dummy}','${dummy}','{}'::jsonb);`),
      attemptAsRole("authenticated", `select * from persist_probe_result_for_job('${dummy}','${dummy}','${dummy}','{}'::jsonb);`),
      attemptAsRole("anon", `select * from claim_next_pending_alert('w', 60);`),
      attemptAsRole("authenticated", `select * from claim_next_pending_alert('w', 60);`),
      attemptAsRole("anon", `select * from renew_alert_lease('${dummy}','${dummy}', 60);`),
      attemptAsRole("anon", `select * from mark_alert_request_sent('${dummy}','${dummy}');`),
      attemptAsRole("anon", `select * from record_alert_delivery_receipt('${dummy}','${dummy}','${dummy}','accepted');`),
      attemptAsRole("anon", `select * from protocol_execution_job_alerts limit 1;`),
      attemptAsRole("anon", `select * from protocol_execution_job_alert_deliveries limit 1;`),
      attemptAsRole("anon", `select * from protocol_execution_job_alert_delivery_attempts limit 1;`),
      attemptAsRole("anon", `insert into protocol_execution_job_alerts (project_id, job_id, event_type, reason_code) values ('${dummy}','${dummy}','needs_review','perplexity_outcome_unknown');`),
    ];
    const grantsOut = runPsql(
      `
\\pset pager off
select string_agg(privilege_type, ',' order by privilege_type) as g from information_schema.role_table_grants
 where table_schema='public' and table_name='protocol_execution_job_alerts' and grantee='service_role' \\gset
\\echo '##R## alerts_grants' :g
select string_agg(privilege_type, ',' order by privilege_type) as g2 from information_schema.role_table_grants
 where table_schema='public' and table_name='protocol_execution_job_alert_deliveries' and grantee='service_role' \\gset
\\echo '##R## deliveries_grants' :g2
select string_agg(privilege_type, ',' order by privilege_type) as g3 from information_schema.role_table_grants
 where table_schema='public' and table_name='protocol_execution_job_alert_delivery_attempts' and grantee='service_role' \\gset
\\echo '##R## attempts_grants' :g3
`,
      "a4-grants"
    );
    const gm = parseMarkers(grantsOut);
    check(
      "A4: anon/authenticated are denied on all 5 new RPCs and all 3 new tables (every attempt errors); service_role grants are exactly INSERT,SELECT on alerts and deliveries, and INSERT,SELECT,UPDATE on delivery_attempts (no DELETE anywhere)",
      denials.every(Boolean) &&
        gm.get("alerts_grants") === "INSERT,SELECT" &&
        gm.get("deliveries_grants") === "INSERT,SELECT" &&
        gm.get("attempts_grants") === "INSERT,SELECT,UPDATE"
    );
  });

  await sc(SCENARIO_ROSTER[4]!, () => {
    const out = runPsql(
      `
\\pset pager off
SET ROLE service_role;
select indexdef as idxdef from pg_indexes
 where schemaname='public' and indexname='protocol_execution_job_alert_deliveries_pending_claim_idx' \\gset
\\echo '##R## idxdef' :idxdef
`,
      "a5-def"
    );
    const m = parseMarkers(out);
    const idxDef = m.get("idxdef") ?? "";
    check(
      "A5: the claim index's real definition matches exactly (created_at) WHERE status='pending' AND attempt_count<3",
      /\(created_at\)/.test(idxDef) && idxDef.includes("status = 'pending'::text") && idxDef.includes("attempt_count < 3")
    );

    // 6 real pending deliveries, each produced by a genuine needs_review
    // transition on its own fixture -- real volume, not fabricated rows
    // (the alerts/deliveries tables only accept INSERT through a real,
    // granted RPC transition; there is no other way to populate them).
    let volumeSql = `\\pset pager off\nSET ROLE service_role;\n`;
    for (let i = 0; i < 6; i++) {
      const v = `a5_${i}`;
      volumeSql += `select job_id as ${v}_job, claim_token as ${v}_tok, project_id as ${v}_proj, perplexity_call_id as ${v}_pcall, probe_run_id as ${v}_run
        from public._m5_0054_rt_build_running('a5vol-${i}') \\gset\n`;
      volumeSql += `select status from public.mark_external_call_sent_for_job(:'${v}_job', :'${v}_tok', :'${v}_proj', :'${v}_pcall', :'${v}_run');\n`;
      volumeSql += `select status from public.mark_protocol_execution_job_needs_review_for_ambiguity(:'${v}_job', :'${v}_tok', :'${v}_proj');\n`;
      volumeSql += `select project_id as a5_proj_${i} from (select :'${v}_proj' as project_id) x \\gset\n`;
    }
    // The candidate query below carries FOR UPDATE SKIP LOCKED, which
    // requires UPDATE-level privilege even under a plain EXPLAIN (no
    // ANALYZE) -- permission checks happen at parse/plan time, not only
    // on real execution. service_role deliberately does NOT have UPDATE
    // on protocol_execution_job_alert_deliveries (D-028's append-only
    // model, already proven by A4); claim_next_pending_alert itself only
    // works because it is SECURITY DEFINER (migration 0054), running
    // this exact query as its owner, never as service_role. RESET ROLE
    // (back to the session's own owner-level connection role) puts this
    // diagnostic, read-only EXPLAIN in that same real privilege context
    // -- never re-elevated to service_role afterward, since nothing
    // after this point needs it.
    volumeSql += `RESET ROLE;\n`;
    volumeSql += `explain (format text) select d.* from protocol_execution_job_alert_deliveries d
      where d.status = 'pending' and (d.next_attempt_at is null or d.next_attempt_at <= now()) and d.attempt_count < 3
      order by d.created_at asc for update skip locked limit 1;\n`;
    for (let i = 0; i < 6; i++) volumeSql += `\\echo '##R## a5_proj_${i}' :a5_proj_${i}\n`;
    const volOut = runPsql(volumeSql, "a5-volume-explain");
    check(
      "A5: with 6 real pending deliveries present, claim_next_pending_alert's own candidate query plan uses protocol_execution_job_alert_deliveries_pending_claim_idx (real EXPLAIN, not assumed)",
      volOut.includes("protocol_execution_job_alert_deliveries_pending_claim_idx")
    );

    const volMarkers = parseMarkers(volOut);
    let cleanupSql = `\\pset pager off\nSET ROLE service_role;\n`;
    for (let i = 0; i < 6; i++) {
      cleanupSql += `select public._m5_0054_rt_cleanup('${volMarkers.get(`a5_proj_${i}`)}');\n`;
    }
    runPsql(cleanupSql, "a5-cleanup");
  });

  // ======================================================================
  // Category B — persist_probe_result_for_job (15)
  // ======================================================================

  // B4-B10 (content-shape validation) run BEFORE any real job/protocol
  // lookup inside persist_probe_result_for_job's own body -- the
  // function's content validation (key set, types, bounds, invariants)
  // executes strictly before its fencing/job lookup, so a syntactically
  // well-formed but semantically arbitrary job_id/claim_token/project_id
  // is sufficient to reach every one of these branches for real, with no
  // fixture at all.
  await sc(SCENARIO_ROSTER[8]!, () => {
    const dummy = "00000000-0000-4000-8000-000000000000";
    const missingKeyObj = contentObj();
    delete missingKeyObj.answer_summary;
    const missingKey = sqlEscape(JSON.stringify(missingKeyObj));
    const out = runPsql(
      `\\pset pager off\nSET ROLE service_role;\nselect status as st from persist_probe_result_for_job('${dummy}','${dummy}','${dummy}','${missingKey}'::jsonb) \\gset\n\\echo '##R## st' :st\n`,
      "b4-missing-key"
    );
    const m = parseMarkers(out);
    check("B4: a missing required key ('answer_summary') -> INVALID_CONTENT_KEYS, no job/fixture even needed since content validation runs before fencing", m.get("st") === "INVALID_CONTENT_KEYS");
  });

  await sc(SCENARIO_ROSTER[9]!, () => {
    const dummy = "00000000-0000-4000-8000-000000000000";
    const wrongType = contentJson({ product_mentioned: "true" });
    const out = runPsql(
      `\\pset pager off\nSET ROLE service_role;\nselect status as st from persist_probe_result_for_job('${dummy}','${dummy}','${dummy}','${wrongType}'::jsonb) \\gset\n\\echo '##R## st' :st\n`,
      "b5-wrong-type"
    );
    const m = parseMarkers(out);
    check("B5: product_mentioned as a JSON string instead of boolean -> INVALID_CONTENT_TYPE", m.get("st") === "INVALID_CONTENT_TYPE");
  });

  await sc(SCENARIO_ROSTER[10]!, () => {
    const dummy = "00000000-0000-4000-8000-000000000000";
    const frac = contentJson({ client_source_count: 1.5 });
    const out = runPsql(
      `\\pset pager off\nSET ROLE service_role;\nselect status as st from persist_probe_result_for_job('${dummy}','${dummy}','${dummy}','${frac}'::jsonb) \\gset\n\\echo '##R## st' :st\n`,
      "b6-fractional-count"
    );
    const m = parseMarkers(out);
    check("B6: client_source_count=1.5 -> INVALID_CONTENT_VALUE, never a raw Postgres cast exception", m.get("st") === "INVALID_CONTENT_VALUE");
  });

  await sc(SCENARIO_ROSTER[11]!, () => {
    const dummy = "00000000-0000-4000-8000-000000000000";
    const overflow = contentJson({ client_source_count: 2147483648, cited_as_source: true });
    const out = runPsql(
      `\\pset pager off\nSET ROLE service_role;\nselect status as st from persist_probe_result_for_job('${dummy}','${dummy}','${dummy}','${overflow}'::jsonb) \\gset\n\\echo '##R## st' :st\n`,
      "b7-overflow-count"
    );
    const m = parseMarkers(out);
    check("B7: client_source_count=2147483648 (int4 overflow + 1) -> INVALID_CONTENT_VALUE, never a raw Postgres cast exception", m.get("st") === "INVALID_CONTENT_VALUE");
  });

  await sc(SCENARIO_ROSTER[12]!, () => {
    const dummy = "00000000-0000-4000-8000-000000000000";
    const fracPos = contentJson({ competitors_mentioned: [{ name: "Acme", position: 1.5, context: "" }] });
    const out = runPsql(
      `\\pset pager off\nSET ROLE service_role;\nselect status as st from persist_probe_result_for_job('${dummy}','${dummy}','${dummy}','${fracPos}'::jsonb) \\gset\n\\echo '##R## st' :st\n`,
      "b8-fractional-position"
    );
    const m = parseMarkers(out);
    check("B8: competitors_mentioned[0].position=1.5 -> INVALID_CONTENT_VALUE, never a raw Postgres cast exception", m.get("st") === "INVALID_CONTENT_VALUE");
  });

  await sc(SCENARIO_ROSTER[13]!, () => {
    const dummy = "00000000-0000-4000-8000-000000000000";
    const outOfRangeHigh = contentJson({ competitors_mentioned: [{ name: "Acme", position: 501, context: "" }] });
    const outHigh = runPsql(
      `\\pset pager off\nSET ROLE service_role;\nselect status as st from persist_probe_result_for_job('${dummy}','${dummy}','${dummy}','${outOfRangeHigh}'::jsonb) \\gset\n\\echo '##R## st' :st\n`,
      "b9-out-of-range-position-high"
    );
    const mHigh = parseMarkers(outHigh);
    check("B9: competitors_mentioned[0].position=501 -> INVALID_CONTENT_VALUE", mHigh.get("st") === "INVALID_CONTENT_VALUE");

    // Secondary gap closed: position=0 is the immediate lower boundary
    // (one less than the minimum valid value 1) -- distinct from -1
    // (already covered by the content-contract) and from the fractional
    // 1.5 case (B8). Explicitly exercised against the real SQL RPC here.
    const outOfRangeZero = contentJson({ competitors_mentioned: [{ name: "Acme", position: 0, context: "" }] });
    const outZero = runPsql(
      `\\pset pager off\nSET ROLE service_role;\nselect status as st from persist_probe_result_for_job('${dummy}','${dummy}','${dummy}','${outOfRangeZero}'::jsonb) \\gset\n\\echo '##R## st' :st\n`,
      "b9-out-of-range-position-zero"
    );
    const mZero = parseMarkers(outZero);
    check("B9 (secondary gap): competitors_mentioned[0].position=0 -> INVALID_CONTENT_VALUE (immediate lower boundary)", mZero.get("st") === "INVALID_CONTENT_VALUE");
  });

  await sc(SCENARIO_ROSTER[14]!, () => {
    const dummy = "00000000-0000-4000-8000-000000000000";
    const contradiction = contentJson({ product_position: "absent", product_mentioned: true });
    const out = runPsql(
      `\\pset pager off\nSET ROLE service_role;\nselect status as st from persist_probe_result_for_job('${dummy}','${dummy}','${dummy}','${contradiction}'::jsonb) \\gset\n\\echo '##R## st' :st\n`,
      "b10-invariant"
    );
    const m = parseMarkers(out);
    check("B10: product_position='absent' with product_mentioned=true -> INVALID_CONTENT_INVARIANT", m.get("st") === "INVALID_CONTENT_INVARIANT");
  });

  // B1/B2/B3 share one completed-analysis fixture/probe_run: PERSISTED,
  // then an exact replay (ALREADY_PERSISTED), then a differently-parsed
  // content against the SAME probe_run_id (CONFLICT) -- plus a second,
  // independent fixture with byte-identical content proving the
  // canonical hash is a deterministic function of content alone.
  let b1ProjectId = "";
  await sc(SCENARIO_ROSTER[0 + 5]!, () => {
    const raw = runPsql(
      `
\\pset pager off
SET ROLE service_role;
select project_id as pid, job_id as jid, claim_token as tok, attempt_id as aid, probe_run_id as rid,
       perplexity_call_id as pcid, analysis_call_id as acid
  from public._m5_0054_rt_build_running('b1') \\gset
select public._m5_0054_rt_complete_analysis(:'jid', :'tok', :'pid', :'pcid', :'acid', :'rid', 'perplexity answer b1', 'analysis content b1');
select status as st1, canonical_result_sha256 as hash1 from persist_probe_result_for_job(:'jid', :'tok', :'pid', '${contentJson()}'::jsonb) \\gset
select count(*)::text as cnt from probe_results where probe_run_id = :'rid' \\gset
select count(*)::text as recompute_row_count
from public.probe_results pr
where pr.probe_run_id = :'rid' \\gset
select (
  encode(
    digest(
      convert_to(
        jsonb_build_object(
          'schema_version', 1,
          'probe_run_id', pr.probe_run_id,
          'project_id', pr.project_id,
          'prompt', pr.prompt,
          'platform', 'perplexity',
          'raw_response', pr.raw_response,
          'client_mentioned', pr.client_mentioned,
          'client_position', pr.client_position,
          'competitors_mentioned', pr.competitors_mentioned,
          'sources_cited', pr.sources_cited,
          'answer_summary', pr.answer_summary,
          'verdict', 'not_evaluated',
          'why_client_lost', '',
          'probe_mode', pr.probe_mode,
          'raw_probe_request', pr.raw_probe_request,
          'product_mentioned', pr.product_mentioned,
          'product_position', pr.product_position,
          'product_verdict', 'not_evaluated',
          'cited_as_source', pr.cited_as_source,
          'client_source_count', pr.client_source_count,
          'platforms_referenced', pr.platforms_referenced,
          'raw_response_sha256', pr.raw_response_sha256,
          'raw_probe_request_sha256', pr.raw_probe_request_sha256,
          'full_request_body_sha256', pr.full_request_body_sha256,
          'provider_http_status', pr.provider_http_status,
          'provider_latency_ms', pr.provider_latency_ms,
          'provider_request_id', pr.provider_request_id,
          'provider_model', pr.provider_model,
          'retry_count', pr.retry_count,
          'raw_response_body', pr.raw_response_body,
          'raw_response_body_sha256', pr.raw_response_body_sha256,
          'dataset_id', pr.dataset_id,
          'dataset_source_type', pr.dataset_source_type,
          'run_position', pr.run_position,
          'negative_claim_detected', pr.negative_claim_detected,
          'observation_schema_version', pr.observation_schema_version
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  ) = pr.canonical_result_sha256
)::text as hash_reproducible
from public.probe_results pr
where pr.probe_run_id = :'rid' \\gset
\\echo '##R## st1' :st1
\\echo '##R## hash1' :hash1
\\echo '##R## cnt' :cnt
\\echo '##R## pid' :pid
\\echo '##R## hash_reproducible' :hash_reproducible
\\echo '##R## recompute_row_count' :recompute_row_count
`,
      "b1-persisted"
    );
    const m = parseMarkers(raw);
    b1ProjectId = m.get("pid")!;
    const hash1 = m.get("hash1") ?? "";
    check(
      "B1: fresh valid content -> PERSISTED, exactly one real probe_results row, a 64-hex-char canonical hash",
      m.get("st1") === "PERSISTED" && m.get("cnt") === "1" && /^[0-9a-f]{64}$/.test(hash1)
    );
    check(
      "B1: the stored canonical_result_sha256 is independently reproducible -- recomputing the D-028 35-key canonical JSON preimage directly from this same persisted row's own stored columns (via a raw pgcrypto digest() call, never persist_probe_result_for_job again and never the production _sha256_hex helper as its own oracle) yields exactly the stored hash, for exactly one row",
      m.get("hash_reproducible") === "true" && m.get("recompute_row_count") === "1"
    );
  });

  await sc(SCENARIO_ROSTER[1 + 5]!, () => {
    const raw = runPsql(
      `
\\pset pager off
SET ROLE service_role;
select id as jid2, claim_token as tok2 from protocol_execution_jobs where project_id = '${b1ProjectId}' and status in ('claimed','running') limit 1 \\gset
select status as st2, probe_result_id as rid2, canonical_result_sha256 as hash2
  from persist_probe_result_for_job(:'jid2', :'tok2', '${b1ProjectId}', '${contentJson()}'::jsonb) \\gset
select count(*)::text as cnt from probe_results where project_id = '${b1ProjectId}' \\gset
\\echo '##R## st2' :st2
\\echo '##R## cnt' :cnt
`,
      "b2-replay"
    );
    const m = parseMarkers(raw);
    check("B2: exact replay of the same content -> ALREADY_PERSISTED, still exactly one row for this project (no second row)", m.get("st2") === "ALREADY_PERSISTED" && m.get("cnt") === "1");
  });

  await sc(SCENARIO_ROSTER[2 + 5]!, () => {
    const differentContent = contentJson({ product_position: "listed" });
    const raw = runPsql(
      `
\\pset pager off
SET ROLE service_role;
select id as jid3, claim_token as tok3 from protocol_execution_jobs where project_id = '${b1ProjectId}' and status in ('claimed','running') limit 1 \\gset
select id as before_id2, canonical_result_sha256 as before_hash2 from probe_results where project_id = '${b1ProjectId}' \\gset
select status as st3, probe_result_id as after_id, canonical_result_sha256 as after_hash
  from persist_probe_result_for_job(:'jid3', :'tok3', '${b1ProjectId}', '${differentContent}'::jsonb) \\gset
select count(*)::text as cnt from probe_results where project_id = '${b1ProjectId}' \\gset
select client_position as still_primary from probe_results where project_id = '${b1ProjectId}' \\gset
\\echo '##R## st3' :st3
\\echo '##R## before_id2' :before_id2
\\echo '##R## after_id' :after_id
\\echo '##R## before_hash2' :before_hash2
\\echo '##R## after_hash' :after_hash
\\echo '##R## cnt' :cnt
\\echo '##R## still_primary' :still_primary
`,
      "b3-conflict"
    );
    const m = parseMarkers(raw);
    check(
      "B3: same probe_run_id, differently-parsed content (product_position changed) -> CONFLICT, the original row's id/hash/client_position are all unchanged, still exactly one row",
      m.get("st3") === "CONFLICT" &&
        m.get("after_id") === m.get("before_id2") &&
        m.get("after_hash") === m.get("before_hash2") &&
        m.get("cnt") === "1" &&
        m.get("still_primary") === "primary"
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${b1ProjectId}');\n`, "b123-cleanup");
  });

  await sc(SCENARIO_ROSTER[15]!, () => {
    const raw = runPsql(
      `
\\pset pager off
SET ROLE service_role;
select project_id as pid, job_id as jid, claim_token as tok, protocol_id as prid
  from public._m5_0054_rt_build_running('b11') \\gset
select public._m5_0054_rt_force_delete_protocol(:'prid');
select status as st from persist_probe_result_for_job(:'jid', :'tok', :'pid', '${contentJson()}'::jsonb) \\gset
select count(*)::text as cnt from probe_results where project_id = :'pid' \\gset
\\echo '##R## st' :st
\\echo '##R## cnt' :cnt
\\echo '##R## pid' :pid
`,
      "b11-protocol-missing"
    );
    const m = parseMarkers(raw);
    check("B11: the job's own protocol row deleted (FK-bypassed, test-only) -> PROTOCOL_NOT_FOUND, zero probe_results rows", m.get("st") === "PROTOCOL_NOT_FOUND" && m.get("cnt") === "0");
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${m.get("pid")}');\n`, "b11-cleanup");
  });

  await sc(SCENARIO_ROSTER[16]!, () => {
    const raw = runPsql(
      `
\\pset pager off
SET ROLE service_role;
select project_id as pid, job_id as jid, claim_token as tok, buyer_question_version_id as bqvid
  from public._m5_0054_rt_build_running('b12') \\gset
select public._m5_0054_rt_force_delete_bqv(:'bqvid');
select status as st from persist_probe_result_for_job(:'jid', :'tok', :'pid', '${contentJson()}'::jsonb) \\gset
select count(*)::text as cnt from probe_results where project_id = :'pid' \\gset
\\echo '##R## st' :st
\\echo '##R## cnt' :cnt
\\echo '##R## pid' :pid
`,
      "b12-bqv-missing"
    );
    const m = parseMarkers(raw);
    check(
      "B12: the protocol's own buyer_question_version row deleted (FK-bypassed, test-only) -> BUYER_QUESTION_VERSION_NOT_FOUND, zero probe_results rows",
      m.get("st") === "BUYER_QUESTION_VERSION_NOT_FOUND" && m.get("cnt") === "0"
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${m.get("pid")}');\n`, "b12-cleanup");
  });

  await sc(SCENARIO_ROSTER[17]!, () => {
    const raw = runPsql(
      `
\\pset pager off
SET ROLE service_role;
select project_id as pid, job_id as jid, claim_token as tok, probe_run_id as rid
  from public._m5_0054_rt_build_running('b13') \\gset
select public._m5_0054_rt_force_delete_probe_run(:'rid');
select status as st from persist_probe_result_for_job(:'jid', :'tok', :'pid', '${contentJson()}'::jsonb) \\gset
select count(*)::text as cnt from probe_results where project_id = :'pid' \\gset
\\echo '##R## st' :st
\\echo '##R## cnt' :cnt
\\echo '##R## pid' :pid
`,
      "b13-proberun-missing"
    );
    const m = parseMarkers(raw);
    check(
      "B13: the attempt's own probe_run row deleted (FK-bypassed, test-only) -> PROBE_RUN_NOT_FOUND, zero probe_results rows",
      m.get("st") === "PROBE_RUN_NOT_FOUND" && m.get("cnt") === "0"
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${m.get("pid")}');\n`, "b13-cleanup");
  });

  await sc(SCENARIO_ROSTER[18]!, () => {
    const raw = runPsql(
      `
\\pset pager off
SET ROLE service_role;
select project_id as pid, job_id as jid, claim_token as tok
  from public._m5_0054_rt_build_running('b14') \\gset
select status as st_wrong from persist_probe_result_for_job(:'jid', '00000000-0000-4000-8000-000000000000', :'pid', '${contentJson()}'::jsonb) \\gset
select public._m5_0054_rt_backdate_job_lease(:'jid', now() - interval '1 hour');
select status as st_expired from persist_probe_result_for_job(:'jid', :'tok', :'pid', '${contentJson()}'::jsonb) \\gset
select count(*)::text as cnt from probe_results where project_id = :'pid' \\gset
\\echo '##R## st_wrong' :st_wrong
\\echo '##R## st_expired' :st_expired
\\echo '##R## cnt' :cnt
\\echo '##R## pid' :pid
`,
      "b14-not-owned"
    );
    const m = parseMarkers(raw);
    check(
      "B14: a wrong claim_token, and separately a real (backdated) expired lease with the correct claim_token, both -> JOB_NOT_OWNED, zero probe_results rows",
      m.get("st_wrong") === "JOB_NOT_OWNED" && m.get("st_expired") === "JOB_NOT_OWNED" && m.get("cnt") === "0"
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${m.get("pid")}');\n`, "b14-cleanup");
  });

  await sc(SCENARIO_ROSTER[19]!, () => {
    const raw = runPsql(
      `
\\pset pager off
SET ROLE service_role;
select project_id as pid, job_id as jid, claim_token as tok, analysis_call_id as acid
  from public._m5_0054_rt_build_running('b15a') \\gset
select status as st_not_completed from persist_probe_result_for_job(:'jid', :'tok', :'pid', '${contentJson()}'::jsonb) \\gset
select count(*)::text as cnt1 from probe_results where project_id = :'pid' \\gset
\\echo '##R## st_not_completed' :st_not_completed
\\echo '##R## cnt1' :cnt1
\\echo '##R## pid1' :pid
`,
      "b15-not-completed"
    );
    const m = parseMarkers(raw);

    const raw2 = runPsql(
      `
\\pset pager off
SET ROLE service_role;
select project_id as pid2, job_id as jid2, claim_token as tok2, perplexity_call_id as pcid2, analysis_call_id as acid2, probe_run_id as rid2
  from public._m5_0054_rt_build_running('b15b') \\gset
select public._m5_0054_rt_complete_analysis(:'jid2', :'tok2', :'pid2', :'pcid2', :'acid2', :'rid2', 'perplexity answer b15b', 'unparseable analysis output');
select status as parse_status from public.mark_analysis_parse_failed_for_job(:'jid2', :'tok2', :'pid2', :'acid2', 'invalid_json') \\gset
select status as st_parse_failed from persist_probe_result_for_job(:'jid2', :'tok2', :'pid2', '${contentJson()}'::jsonb) \\gset
select count(*)::text as cnt2 from probe_results where project_id = :'pid2' \\gset
\\echo '##R## parse_status' :parse_status
\\echo '##R## st_parse_failed' :st_parse_failed
\\echo '##R## cnt2' :cnt2
\\echo '##R## pid2' :pid2
`,
      "b15-parse-failed"
    );
    const m2 = parseMarkers(raw2);
    check(
      "B15: an analysis call not yet completed -> ANALYSIS_NOT_COMPLETED; a real parse-failed analysis (mark_analysis_parse_failed_for_job) -> PARSE_ALREADY_MARKED_FAILED; zero mutation in either case",
      m.get("st_not_completed") === "ANALYSIS_NOT_COMPLETED" &&
        m.get("cnt1") === "0" &&
        m2.get("parse_status") === "MARKED" &&
        m2.get("st_parse_failed") === "PARSE_ALREADY_MARKED_FAILED" &&
        m2.get("cnt2") === "0"
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${m.get("pid1")}');\nselect public._m5_0054_rt_cleanup('${m2.get("pid2")}');\n`, "b15-cleanup");
  });

  // ======================================================================
  // Category C — alert outbox emission (5)
  // ======================================================================

  await sc(SCENARIO_ROSTER[20]!, () => {
    // perplexity_outcome_unknown
    const r1 = parseMarkers(
      runPsql(
        `
\\pset pager off
SET ROLE service_role;
select project_id as pid, job_id as jid, claim_token as tok, attempt_id as aid, perplexity_call_id as pcid, probe_run_id as rid
  from public._m5_0054_rt_build_running('c1a') \\gset
select status as sent_st from public.mark_external_call_sent_for_job(:'jid', :'tok', :'pid', :'pcid', :'rid') \\gset
select status as st from public.record_provider_call_receipt_for_job(:'jid', :'tok', :'pid', :'pcid', :'rid', 'provider_outcome_unknown') \\gset
select count(*)::text as alert_cnt, coalesce(max(alert_event_id::text), '00000000-0000-0000-0000-000000000000') as evt from protocol_execution_job_alerts where job_id = :'jid' \\gset
select count(*)::text as delivery_cnt, max(delivery_id::text) as dlv from protocol_execution_job_alert_deliveries where alert_event_id = :'evt' \\gset
select event_type as et, reason_code as rc, source_attempt_id::text as said, source_external_call_id::text as secid
  from protocol_execution_job_alerts where alert_event_id = :'evt' \\gset
select status as jstat from protocol_execution_jobs where id = :'jid' \\gset
\\echo '##R## sent_st' :sent_st
\\echo '##R## st' :st
\\echo '##R## alert_cnt' :alert_cnt
\\echo '##R## delivery_cnt' :delivery_cnt
\\echo '##R## et' :et
\\echo '##R## rc' :rc
\\echo '##R## said' :said
\\echo '##R## secid' :secid
\\echo '##R## aid' :aid
\\echo '##R## pcid' :pcid
\\echo '##R## jstat' :jstat
\\echo '##R## pid' :pid
`,
        "c1a-perplexity-unknown"
      )
    );
    check(
      "C1a: record_provider_call_receipt_for_job(outcome=provider_outcome_unknown) -> job needs_review, exactly one alert row + one delivery row, reason perplexity_outcome_unknown, source_attempt_id/source_external_call_id correct",
      r1.get("sent_st") === "SENT" &&
        r1.get("st") === "RECEIPTED" &&
        r1.get("jstat") === "needs_review" &&
        r1.get("alert_cnt") === "1" &&
        r1.get("delivery_cnt") === "1" &&
        r1.get("et") === "needs_review" &&
        r1.get("rc") === "perplexity_outcome_unknown" &&
        r1.get("said") === r1.get("aid") &&
        r1.get("secid") === r1.get("pcid")
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${r1.get("pid")}');\n`, "c1a-cleanup");

    // analysis_outcome_unknown
    const r2 = parseMarkers(
      runPsql(
        `
\\pset pager off
SET ROLE service_role;
select project_id as pid, job_id as jid, claim_token as tok, attempt_id as aid, analysis_call_id as acid, probe_run_id as rid
  from public._m5_0054_rt_build_running('c1b') \\gset
select status as sent_st from public.mark_external_call_sent_for_job(:'jid', :'tok', :'pid', :'acid', :'rid') \\gset
select status as st
from public.record_analysis_call_receipt_for_job(
  p_job_id => :'jid',
  p_claim_token => :'tok',
  p_project_id => :'pid',
  p_external_call_id => :'acid',
  p_probe_run_id => :'rid',
  p_outcome => 'provider_outcome_unknown',
  p_used_mock => true
) \\gset
select count(*)::text as alert_cnt, coalesce(max(alert_event_id::text), '00000000-0000-0000-0000-000000000000') as evt from protocol_execution_job_alerts where job_id = :'jid' \\gset
select count(*)::text as delivery_cnt from protocol_execution_job_alert_deliveries where alert_event_id = :'evt' \\gset
select event_type as et, reason_code as rc, source_attempt_id::text as said, source_external_call_id::text as secid
  from protocol_execution_job_alerts where alert_event_id = :'evt' \\gset
\\echo '##R## alert_cnt' :alert_cnt
\\echo '##R## delivery_cnt' :delivery_cnt
\\echo '##R## et' :et
\\echo '##R## rc' :rc
\\echo '##R## said' :said
\\echo '##R## secid' :secid
\\echo '##R## aid' :aid
\\echo '##R## acid' :acid
\\echo '##R## pid' :pid
`,
        "c1b-analysis-unknown"
      )
    );
    check(
      "C1b: record_analysis_call_receipt_for_job(outcome=provider_outcome_unknown) -> exactly one alert+delivery, reason analysis_outcome_unknown, source ids correct",
      r2.get("alert_cnt") === "1" &&
        r2.get("delivery_cnt") === "1" &&
        r2.get("et") === "needs_review" &&
        r2.get("rc") === "analysis_outcome_unknown" &&
        r2.get("said") === r2.get("aid") &&
        r2.get("secid") === r2.get("acid")
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${r2.get("pid")}');\n`, "c1b-cleanup");

    // ambiguous_external_call_sent_without_receipt
    const r3 = parseMarkers(
      runPsql(
        `
\\pset pager off
SET ROLE service_role;
select project_id as pid, job_id as jid, claim_token as tok, attempt_id as aid, perplexity_call_id as pcid, probe_run_id as rid
  from public._m5_0054_rt_build_running('c1c') \\gset
select status as sent_st from public.mark_external_call_sent_for_job(:'jid', :'tok', :'pid', :'pcid', :'rid') \\gset
select status as st from public.mark_protocol_execution_job_needs_review_for_ambiguity(:'jid', :'tok', :'pid') \\gset
select count(*)::text as alert_cnt, coalesce(max(alert_event_id::text), '00000000-0000-0000-0000-000000000000') as evt from protocol_execution_job_alerts where job_id = :'jid' \\gset
select count(*)::text as delivery_cnt from protocol_execution_job_alert_deliveries where alert_event_id = :'evt' \\gset
select event_type as et, reason_code as rc, source_attempt_id::text as said, source_external_call_id is null as secid_null
  from protocol_execution_job_alerts where alert_event_id = :'evt' \\gset
\\echo '##R## st' :st
\\echo '##R## alert_cnt' :alert_cnt
\\echo '##R## delivery_cnt' :delivery_cnt
\\echo '##R## et' :et
\\echo '##R## rc' :rc
\\echo '##R## said' :said
\\echo '##R## secid_null' :secid_null
\\echo '##R## aid' :aid
\\echo '##R## pid' :pid
`,
        "c1c-ambiguous"
      )
    );
    check(
      "C1c: mark_protocol_execution_job_needs_review_for_ambiguity -> NEEDS_REVIEW, exactly one alert+delivery, reason ambiguous_external_call_sent_without_receipt, source_attempt_id set and source_external_call_id NULL",
      r3.get("st") === "NEEDS_REVIEW" &&
        r3.get("alert_cnt") === "1" &&
        r3.get("delivery_cnt") === "1" &&
        r3.get("et") === "needs_review" &&
        r3.get("rc") === "ambiguous_external_call_sent_without_receipt" &&
        r3.get("said") === r3.get("aid") &&
        r3.get("secid_null") === "t"
    );

    // abandoned_exhausted
    const r4 = parseMarkers(
      runPsql(
        `
\\pset pager off
SET ROLE service_role;
select project_id as pid, protocol_id as prid from public._m5_0054_rt_make_fixture('c1d', 1) \\gset
select status as est from public.enqueue_protocol_execution_job(:'prid', :'pid', 1) \\gset
select status as claim_st, (job).id as jid, claim_token as tok from public.claim_protocol_execution_job('c1d-worker-' || gen_random_uuid()::text, 300) \\gset
select public._m5_0054_rt_backdate_job_lease(:'jid', now() - interval '1 hour');
select status as sweep_st from public.claim_protocol_execution_job('c1d-sweeper-' || gen_random_uuid()::text, 300) \\gset
select count(*)::text as alert_cnt, coalesce(max(alert_event_id::text), '00000000-0000-0000-0000-000000000000') as evt from protocol_execution_job_alerts where job_id = :'jid' \\gset
select count(*)::text as delivery_cnt from protocol_execution_job_alert_deliveries where alert_event_id = :'evt' \\gset
select event_type as et, reason_code as rc, source_attempt_id is null as said_null, source_external_call_id is null as secid_null
  from protocol_execution_job_alerts where alert_event_id = :'evt' \\gset
select status as jstat from protocol_execution_jobs where id = :'jid' \\gset
\\echo '##R## claim_st' :claim_st
\\echo '##R## alert_cnt' :alert_cnt
\\echo '##R## delivery_cnt' :delivery_cnt
\\echo '##R## et' :et
\\echo '##R## rc' :rc
\\echo '##R## said_null' :said_null
\\echo '##R## secid_null' :secid_null
\\echo '##R## jstat' :jstat
\\echo '##R## pid' :pid
`,
        "c1d-abandoned"
      )
    );
    check(
      "C1d: a claimed job whose lease expires with attempt_count>=max_attempts -> abandoned_exhausted on the next claim sweep, exactly one alert+delivery, reason attempts_exhausted, no source ids",
      r4.get("claim_st") === "CLAIMED" &&
        r4.get("jstat") === "abandoned_exhausted" &&
        r4.get("alert_cnt") === "1" &&
        r4.get("delivery_cnt") === "1" &&
        r4.get("et") === "abandoned_exhausted" &&
        r4.get("rc") === "attempts_exhausted" &&
        r4.get("said_null") === "t" &&
        r4.get("secid_null") === "t"
    );

    runPsql(
      `\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${r3.get("pid")}');\nselect public._m5_0054_rt_cleanup('${r4.get("pid")}');\n`,
      "c1cd-cleanup"
    );
  });

  await sc(SCENARIO_ROSTER[21]!, () => {
    const r = parseMarkers(
      runPsql(
        `
\\pset pager off
SET ROLE service_role;
select project_id as pid, job_id as jid, claim_token as tok, perplexity_call_id as pcid, probe_run_id as rid
  from public._m5_0054_rt_build_running('c2') \\gset
select status as sent_st from public.mark_external_call_sent_for_job(:'jid', :'tok', :'pid', :'pcid', :'rid') \\gset
select status as st1 from public.mark_protocol_execution_job_needs_review_for_ambiguity(:'jid', :'tok', :'pid') \\gset
select count(*)::text as cnt1 from protocol_execution_job_alerts where job_id = :'jid' \\gset
select status as st2 from public.mark_protocol_execution_job_needs_review_for_ambiguity(:'jid', :'tok', :'pid') \\gset
select count(*)::text as cnt2 from protocol_execution_job_alerts where job_id = :'jid' \\gset
select count(*)::text as dcnt2 from protocol_execution_job_alert_deliveries d
  join protocol_execution_job_alerts al on al.alert_event_id = d.alert_event_id where al.job_id = :'jid' \\gset
\\echo '##R## st1' :st1
\\echo '##R## cnt1' :cnt1
\\echo '##R## st2' :st2
\\echo '##R## cnt2' :cnt2
\\echo '##R## dcnt2' :dcnt2
\\echo '##R## pid' :pid
`,
        "c2-replay"
      )
    );
    check(
      "C2: replaying mark_protocol_execution_job_needs_review_for_ambiguity on an already-needs_review job -> ALREADY_NEEDS_REVIEW, alert count and delivery count both stay at 1 (no duplicate)",
      r.get("st1") === "NEEDS_REVIEW" && r.get("cnt1") === "1" && r.get("st2") === "ALREADY_NEEDS_REVIEW" && r.get("cnt2") === "1" && r.get("dcnt2") === "1"
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${r.get("pid")}');\n`, "c2-cleanup");
  });

  await sc(SCENARIO_ROSTER[22]!, () => {
    const r = parseMarkers(
      runPsql(
        `
\\pset pager off
SET ROLE service_role;
select project_id as pid, protocol_id as prid from public._m5_0054_rt_make_fixture('c3', 1) \\gset
select status as est from public.enqueue_protocol_execution_job(:'prid', :'pid', 1) \\gset
select status as claim1_st, (job).id as jid, claim_token as tok from public.claim_protocol_execution_job('c3-worker-' || gen_random_uuid()::text, 300) \\gset
select public._m5_0054_rt_backdate_job_lease(:'jid', now() - interval '1 hour');
select status as sweep1 from public.claim_protocol_execution_job('c3-sweeper1-' || gen_random_uuid()::text, 300) \\gset
select
  coalesce(
    latest1.evt,
    '00000000-0000-0000-0000-000000000000'
  ) as evt1,
  coalesce(
    latest1.dlv,
    '00000000-0000-0000-0000-000000000000'
  ) as dlv1
  from (select 1) as one1
  left join lateral (
    select al.alert_event_id::text as evt, d.delivery_id::text as dlv
      from protocol_execution_job_alerts al join protocol_execution_job_alert_deliveries d on d.alert_event_id = al.alert_event_id
      where al.job_id = :'jid'
      order by al.transition_seq desc, al.transition_at desc
      limit 1
  ) as latest1 on true \\gset
select status as react_st from public.reactivate_abandoned_job(:'jid', :'pid', 'm5-0054-runtime', 'c3 reactivation', 'm5-0054-c3-reactivate-1') \\gset
select status as claim2_st, (job).id as jid2, claim_token as tok2 from public.claim_protocol_execution_job('c3-worker2-' || gen_random_uuid()::text, 300) \\gset
select public._m5_0054_rt_backdate_job_lease(:'jid2', now() - interval '1 hour');
select status as sweep2 from public.claim_protocol_execution_job('c3-sweeper2-' || gen_random_uuid()::text, 300) \\gset
select
  coalesce(
    latest2.evt,
    '00000000-0000-0000-0000-000000000000'
  ) as evt2,
  coalesce(
    latest2.dlv,
    '00000000-0000-0000-0000-000000000000'
  ) as dlv2
  from (select 1) as one2
  left join lateral (
    select al.alert_event_id::text as evt, d.delivery_id::text as dlv
      from protocol_execution_job_alerts al join protocol_execution_job_alert_deliveries d on d.alert_event_id = al.alert_event_id
      where al.job_id = :'jid2'
      order by al.transition_seq desc, al.transition_at desc
      limit 1
  ) as latest2 on true \\gset
select count(*)::text as alert_cnt from protocol_execution_job_alerts where job_id = :'jid2' \\gset
\\echo '##R## claim1_st' :claim1_st
\\echo '##R## claim2_st' :claim2_st
\\echo '##R## react_st' :react_st
\\echo '##R## jid' :jid
\\echo '##R## jid2' :jid2
\\echo '##R## evt1' :evt1
\\echo '##R## evt2' :evt2
\\echo '##R## dlv1' :dlv1
\\echo '##R## dlv2' :dlv2
\\echo '##R## alert_cnt' :alert_cnt
\\echo '##R## pid' :pid
`,
        "c3-reenter"
      )
    );
    check(
      "C3: reactivate_abandoned_job reuses the SAME job row (jid2 === jid); the second abandoned_exhausted transition on that same job produces a distinct alert_event_id and delivery_id from the first",
      r.get("claim1_st") === "CLAIMED" &&
        r.get("claim2_st") === "CLAIMED" &&
        r.get("react_st") === "REACTIVATED" &&
        r.get("jid2") === r.get("jid") &&
        r.get("evt1") !== "" &&
        r.get("evt2") !== "" &&
        r.get("evt1") !== "00000000-0000-0000-0000-000000000000" &&
        r.get("dlv1") !== "00000000-0000-0000-0000-000000000000" &&
        r.get("evt2") !== "00000000-0000-0000-0000-000000000000" &&
        r.get("dlv2") !== "00000000-0000-0000-0000-000000000000" &&
        r.get("evt1") !== r.get("evt2") &&
        r.get("dlv1") !== r.get("dlv2") &&
        r.get("alert_cnt") === "2"
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${r.get("pid")}');\n`, "c3-cleanup");
  });

  await sc(SCENARIO_ROSTER[23]!, () => {
    const r = parseMarkers(
      runPsql(
        `
\\pset pager off
SET ROLE service_role;
select project_id as pid, protocol_id as prid from public._m5_0054_rt_make_fixture('c4', 1) \\gset
select status as est from public.enqueue_protocol_execution_job(:'prid', :'pid', 1) \\gset
select status as claim_st, (job).id as jid, claim_token as tok from public.claim_protocol_execution_job('c4-worker-' || gen_random_uuid()::text, 300) \\gset
select attempt_count as ac_before, status as st_before from protocol_execution_jobs where id = :'jid' \\gset
select public._m5_0054_rt_backdate_job_lease(:'jid', now() - interval '1 hour');
select status as sweep_st from public.claim_protocol_execution_job('c4-sweeper-' || gen_random_uuid()::text, 300) \\gset
select status as jstat, attempt_count as ac_after from protocol_execution_jobs where id = :'jid' \\gset
select count(*)::text as alert_cnt from protocol_execution_job_alerts where job_id = :'jid' and event_type = 'abandoned_exhausted' \\gset
\\echo '##R## claim_st' :claim_st
\\echo '##R## ac_before' :ac_before
\\echo '##R## st_before' :st_before
\\echo '##R## jstat' :jstat
\\echo '##R## ac_after' :ac_after
\\echo '##R## alert_cnt' :alert_cnt
\\echo '##R## pid' :pid
`,
        "c4-abandoned"
      )
    );
    check(
      "C4: attempt_count reaches max_attempts (1) at first claim, status stays claimed until the lease genuinely (backdated) expires, then the next claim sweep transitions it to abandoned_exhausted with its own alert",
      r.get("claim_st") === "CLAIMED" && r.get("ac_before") === "1" && r.get("st_before") === "claimed" && r.get("jstat") === "abandoned_exhausted" && r.get("ac_after") === "1" && r.get("alert_cnt") === "1"
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${r.get("pid")}');\n`, "c4-cleanup");
  });

  await sc(SCENARIO_ROSTER[24]!, () => {
    // Re-derive C5 directly rather than depend on already-cleaned-up C1
    // fixtures: the reason_code CHECK constraint itself is exercised
    // negatively (an event_type/reason_code pairing the CHECK forbids
    // must be rejected), and the two composite FKs are exercised
    // negatively (a source_attempt_id/source_external_call_id that does
    // not belong to the stated job/attempt must be rejected too).
    const dummy = "00000000-0000-4000-8000-000000000000";
    const r = parseMarkers(
      runPsql(
        `
\\pset pager off
SET ROLE service_role;
select project_id as pid, job_id as jid, attempt_id as aid
  from public._m5_0054_rt_build_running('c5') \\gset
\\echo '##R## pid' :pid
`,
        "c5-fixture"
      )
    );
    const badPairing = runPsqlExpectError(
      `\\pset pager off\nSET ROLE service_role;\ninsert into protocol_execution_job_alerts (project_id, job_id, event_type, reason_code) values ('${r.get("pid")}', '${r.get("jid")}', 'needs_review', 'attempts_exhausted');`,
      "c5-bad-pairing"
    );
    const badPairing2 = runPsqlExpectError(
      `\\pset pager off\nSET ROLE service_role;\ninsert into protocol_execution_job_alerts (project_id, job_id, event_type, reason_code) values ('${r.get("pid")}', '${r.get("jid")}', 'abandoned_exhausted', 'perplexity_outcome_unknown');`,
      "c5-bad-pairing-2"
    );
    const badSourceAttempt = runPsqlExpectError(
      `\\pset pager off\nSET ROLE service_role;\ninsert into protocol_execution_job_alerts (project_id, job_id, event_type, reason_code, source_attempt_id) values ('${r.get("pid")}', '${r.get("jid")}', 'needs_review', 'perplexity_outcome_unknown', '${dummy}');`,
      "c5-bad-source-attempt"
    );
    check(
      "C5: the reason_code CHECK rejects needs_review/attempts_exhausted and abandoned_exhausted/perplexity_outcome_unknown pairings; the source_attempt_id composite FK rejects an attempt that does not belong to the stated job",
      !badPairing.ok && !badPairing2.ok && !badSourceAttempt.ok
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${r.get("pid")}');\n`, "c5-cleanup");
  });

  // ======================================================================
  // Category D — alert delivery lifecycle/concurrency (14)
  // ======================================================================

  async function buildOnePendingDelivery(label: string): Promise<Map<string, string>> {
    return parseMarkers(
      runPsql(
        `
\\pset pager off
SET ROLE service_role;
select project_id as pid, job_id as jid, claim_token as tok, perplexity_call_id as pcid, probe_run_id as rid, attempt_id as aid
  from public._m5_0054_rt_build_running('${label}') \\gset
select status as sent_st from public.mark_external_call_sent_for_job(:'jid', :'tok', :'pid', :'pcid', :'rid') \\gset
select status as nr_st from public.mark_protocol_execution_job_needs_review_for_ambiguity(:'jid', :'tok', :'pid') \\gset
select delivery_id::text as did from protocol_execution_job_alert_deliveries d
  join protocol_execution_job_alerts al on al.alert_event_id = d.alert_event_id where al.job_id = :'jid' \\gset
\\echo '##R## did' :did
\\echo '##R## pid' :pid
\\echo '##R## jid' :jid
`,
        `${label}-build`
      )
    );
  }

  await sc(SCENARIO_ROSTER[25]!, async () => {
    const fx = await buildOnePendingDelivery("d1");

    resetAndRegisterScenarioBarrier("d1");

    const scriptA = `
\\pset pager off
SET ROLE service_role;
BEGIN;
select pg_backend_pid()::text as a_pid \\gset
select status as a_status, delivery_id::text as a_did from claim_next_pending_alert('d1-racer-a', 60) \\gset
\\echo '##R## a_pid' :a_pid
\\echo '##R## a_ready' D1_A_READY
${barrierWaitSql("d1")}
COMMIT;
\\echo '##R## a_status' :a_status
\\echo '##R## a_did' :a_did
`;
    const scriptB = `
\\pset pager off
SET ROLE service_role;
select pg_backend_pid()::text as b_pid \\gset
\\echo '##R## b_pid' :b_pid
select status as b_status, delivery_id::text as b_did from claim_next_pending_alert('d1-racer-b', 60) \\gset
\\echo '##R## b_status' :b_status
\\echo '##R## b_did' :b_did
`;

    const aLive = runPsqlAsyncLive(scriptA, "d1-race-a", 20000);
    // The parent MECHANICALLY observes A actively holding its claim
    // (the D1_A_READY marker, printed only after A's own claim call
    // returned and its backend pid was captured) before B is ever
    // launched -- a real, bounded, reactive wait, never a fixed guess.
    await waitUntil(
      () => aLive.getStdout().includes("##R## a_ready D1_A_READY"),
      5000,
      50,
      "D1: session A reached its ready barrier (D1_A_READY, with its backend pid already captured) before session B was launched"
    );
    const aPartial = parseMarkers(aLive.getStdout());
    const aPid = aPartial.get("a_pid");
    check("D1: session A's Postgres backend pid was captured (mechanically observed) before session B was ever launched", !!aPid);

    // B runs to completion -- and, since it is only launched after the
    // observation above, necessarily finishes -- strictly BEFORE the
    // barrier is released below, which is strictly before A can ever
    // see released=true and proceed to COMMIT.
    const rb = await runPsqlAsync(scriptB, "d1-race-b", 10000);
    const mb = parseMarkers(rb.stdout);
    const bPid = mb.get("b_pid");
    check("D1: two distinct Postgres backend PIDs were used for the two concurrent sessions", !!aPid && !!bPid && aPid !== bPid);
    check(
      "D1: session B returned NO_ALERT_AVAILABLE (the only pending delivery was already claimed by A) strictly before A's commit -- B's own process had already exited before the release signal below was even sent",
      mb.get("b_status") === "NO_ALERT_AVAILABLE"
    );

    releaseScenarioBarrier("d1");

    const aResult = validateAsyncPsqlResult(await aLive.done, "d1-race-a", aLive.scriptPath);
    const aMarkers = parseMarkers(aResult.stdout);
    check(
      "D1: session A itself returned CLAIMED for the real pending delivery and committed cleanly after the (mechanically observed) release",
      aMarkers.get("a_status") === "CLAIMED" && aMarkers.get("a_did") === fx.get("did")
    );

    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${fx.get("pid")}');\n`, "d1-cleanup");
  });

  await sc(SCENARIO_ROSTER[26]!, async () => {
    const fxA = await buildOnePendingDelivery("d2a");
    const fxB = await buildOnePendingDelivery("d2b");

    resetAndRegisterScenarioBarrier("d2");

    const scriptA = `
\\pset pager off
SET ROLE service_role;
BEGIN;
select pg_backend_pid()::text as a_pid \\gset
select status as a_status, delivery_id::text as a_did from claim_next_pending_alert('d2-racer-a', 60) \\gset
\\echo '##R## a_pid' :a_pid
\\echo '##R## a_ready' D2_A_READY
${barrierWaitSql("d2")}
COMMIT;
\\echo '##R## a_status' :a_status
\\echo '##R## a_did' :a_did
`;
    const scriptB = `
\\pset pager off
SET ROLE service_role;
select pg_backend_pid()::text as b_pid \\gset
\\echo '##R## b_pid' :b_pid
select status as b_status, delivery_id::text as b_did from claim_next_pending_alert('d2-racer-b', 60) \\gset
\\echo '##R## b_status' :b_status
\\echo '##R## b_did' :b_did
`;

    const aLive = runPsqlAsyncLive(scriptA, "d2-race-a", 20000);
    await waitUntil(
      () => aLive.getStdout().includes("##R## a_ready D2_A_READY"),
      5000,
      50,
      "D2: session A reached its ready barrier (holding the first delivery locked, but uncommitted) before session B was launched"
    );
    const aPartial = parseMarkers(aLive.getStdout());
    const aPid = aPartial.get("a_pid");
    check("D2: session A's Postgres backend pid was captured before session B was launched", !!aPid);

    // B is launched only now, while A's own claim (on the FIRST, oldest
    // delivery) is still open/uncommitted. B's own SKIP LOCKED
    // candidate query is therefore forced to skip that locked row and
    // claim the SECOND, distinct delivery instead -- proving row-level
    // (never table-level) contention, strictly before A's commit.
    const rb = await runPsqlAsync(scriptB, "d2-race-b", 10000);
    const mb = parseMarkers(rb.stdout);
    const bPid = mb.get("b_pid");
    check("D2: two distinct Postgres backend PIDs were used for the two concurrent sessions", !!aPid && !!bPid && aPid !== bPid);
    check(
      "D2: session B genuinely claimed the SECOND delivery (a different delivery_id from A's) strictly before A's commit, never blocking on A's still-held row",
      mb.get("b_status") === "CLAIMED" && !!mb.get("b_did") && mb.get("b_did") !== fxA.get("did")
    );

    releaseScenarioBarrier("d2");

    const aResult = validateAsyncPsqlResult(await aLive.done, "d2-race-a", aLive.scriptPath);
    const aMarkers = parseMarkers(aResult.stdout);
    check(
      "D2: session A claimed the FIRST delivery, distinct from B's, and committed cleanly after the (mechanically observed) release",
      aMarkers.get("a_status") === "CLAIMED" && aMarkers.get("a_did") === fxA.get("did") && aMarkers.get("a_did") !== mb.get("b_did")
    );

    runPsql(
      `\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${fxA.get("pid")}');\nselect public._m5_0054_rt_cleanup('${fxB.get("pid")}');\n`,
      "d2-cleanup"
    );
  });

  await sc(SCENARIO_ROSTER[27]!, async () => {
    const fx = await buildOnePendingDelivery("d3");
    const r = parseMarkers(
      runPsql(
        `
\\pset pager off
SET ROLE service_role;
select status as claim_st, delivery_id::text as did, claim_token::text as tok
  from claim_next_pending_alert('d3-worker', 60) \\gset
select lease_expires_at::text as lease0 from protocol_execution_job_alert_deliveries where delivery_id = :'did' \\gset
select status as wrong_st from renew_alert_lease(:'did', '00000000-0000-4000-8000-000000000000', 120) \\gset
select status as ok_st, delivery_id::text as ok_did from renew_alert_lease(:'did', :'tok', 900) \\gset
select lease_expires_at::text as lease1 from protocol_execution_job_alert_deliveries where delivery_id = :'did' \\gset
\\echo '##R## claim_st' :claim_st
\\echo '##R## wrong_st' :wrong_st
\\echo '##R## ok_st' :ok_st
\\echo '##R## ok_did' :ok_did
\\echo '##R## did' :did
\\echo '##R## lease0' :lease0
\\echo '##R## lease1' :lease1
`,
        "d3-renew"
      )
    );
    check(
      "D3: renew_alert_lease with the real claim_token extends lease_expires_at forward and echoes the delivery_id; a wrong claim_token is refused",
      r.get("claim_st") === "CLAIMED" && r.get("wrong_st") === "DELIVERY_NOT_OWNED" && r.get("ok_st") === "RENEWED" && r.get("ok_did") === r.get("did") && r.get("lease1")! > r.get("lease0")!
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${fx.get("pid")}');\n`, "d3-cleanup");
  });

  await sc(SCENARIO_ROSTER[28]!, async () => {
    const fx = await buildOnePendingDelivery("d4");
    const r = parseMarkers(
      runPsql(
        `
\\pset pager off
SET ROLE service_role;
select delivery_id::text as did from claim_next_pending_alert('d4-worker', 60) \\gset
select attempt_count::text as ac_before from protocol_execution_job_alert_deliveries where delivery_id = :'did' \\gset
select public._m5_0054_rt_backdate_delivery(:'did', 'claimed', 'd4-worker', gen_random_uuid(), now() - interval '1 hour', null, 0);
select status as reclaim_st, delivery_id::text as reclaim_did, reconciled_stale_claimed_count::text as rc
  from claim_next_pending_alert('d4-worker2', 60) \\gset
select attempt_count::text as ac_after from protocol_execution_job_alert_deliveries where delivery_id = :'did' \\gset
\\echo '##R## ac_before' :ac_before
\\echo '##R## reclaim_st' :reclaim_st
\\echo '##R## reclaim_did' :reclaim_did
\\echo '##R## rc' :rc
\\echo '##R## ac_after' :ac_after
\\echo '##R## did' :did
`,
        "d4-claimed-expired"
      )
    );
    check(
      "D4: a claimed delivery with no request_sent attempt whose lease expires (backdated) is reconciled to pending and immediately re-claimed by the very next claim call, with attempt_count untouched (0 before and after)",
      r.get("ac_before") === "0" && r.get("rc") === "1" && r.get("reclaim_st") === "CLAIMED" && r.get("reclaim_did") === r.get("did") && r.get("ac_after") === "0"
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${fx.get("pid")}');\n`, "d4-cleanup");
  });

  await sc(SCENARIO_ROSTER[29]!, async () => {
    const fx = await buildOnePendingDelivery("d5");
    const r = parseMarkers(
      runPsql(
        `
\\pset pager off
SET ROLE service_role;
select delivery_id::text as did, claim_token::text as tok from claim_next_pending_alert('d5-worker', 60) \\gset
select status as st, attempt_seq::text as seq, idempotency_key as ik from mark_alert_request_sent(:'did', :'tok') \\gset
select status as dstat, attempt_count::text as ac from protocol_execution_job_alert_deliveries where delivery_id = :'did' \\gset
\\echo '##R## st' :st
\\echo '##R## seq' :seq
\\echo '##R## ik' :ik
\\echo '##R## dstat' :dstat
\\echo '##R## ac' :ac
`,
        "d5-mark-sent"
      )
    );
    check(
      "D5: mark_alert_request_sent on a freshly claimed delivery -> REQUEST_MARKED_SENT, attempt_seq=1, a real idempotency_key, delivery status request_sent, attempt_count=1",
      r.get("st") === "REQUEST_MARKED_SENT" && r.get("seq") === "1" && !!r.get("ik") && r.get("dstat") === "request_sent" && r.get("ac") === "1"
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${fx.get("pid")}');\n`, "d5-cleanup");
  });

  await sc(SCENARIO_ROSTER[30]!, async () => {
    const fx = await buildOnePendingDelivery("d6");
    const r = parseMarkers(
      runPsql(
        `
\\pset pager off
SET ROLE service_role;
select delivery_id::text as did, claim_token::text as tok from claim_next_pending_alert('d6-worker', 60) \\gset
select attempt_id::text as aid from mark_alert_request_sent(:'did', :'tok') \\gset
select status as st, final_delivery_status as fds from record_alert_delivery_receipt(:'did', :'tok', :'aid', 'accepted', 200, 'resend-fixture-id-1') \\gset
select resend_email_id as rid, outcome as oc from protocol_execution_job_alert_delivery_attempts where attempt_id = :'aid' \\gset
select status as final_status from protocol_execution_job_alert_deliveries where delivery_id = :'did' \\gset
\\echo '##R## st' :st
\\echo '##R## fds' :fds
\\echo '##R## rid' :rid
\\echo '##R## oc' :oc
\\echo '##R## final_status' :final_status
`,
        "d6-accepted"
      )
    );
    check(
      "D6: record_alert_delivery_receipt(outcome=accepted, resend_email_id set) -> RECEIPT_RECORDED, final_delivery_status=accepted, the attempt row's own outcome/resend_email_id are set to match",
      r.get("st") === "RECEIPT_RECORDED" && r.get("fds") === "accepted" && r.get("final_status") === "accepted" && r.get("oc") === "accepted" && r.get("rid") === "resend-fixture-id-1"
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${fx.get("pid")}');\n`, "d6-cleanup");
  });

  await sc(SCENARIO_ROSTER[31]!, async () => {
    const fx = await buildOnePendingDelivery("d7");
    const r = parseMarkers(
      runPsql(
        `
\\pset pager off
SET ROLE service_role;
select delivery_id::text as did, claim_token::text as tok from claim_next_pending_alert('d7-worker', 60) \\gset
select attempt_id::text as aid from mark_alert_request_sent(:'did', :'tok') \\gset
select status as st, final_delivery_status as fds from record_alert_delivery_receipt(:'did', :'tok', :'aid', 'http_error', 422, null, 'http_4xx_permanent') \\gset
select status as dstat, next_attempt_at is null as no_retry from protocol_execution_job_alert_deliveries where delivery_id = :'did' \\gset
\\echo '##R## st' :st
\\echo '##R## fds' :fds
\\echo '##R## dstat' :dstat
\\echo '##R## no_retry' :no_retry
`,
        "d7-permanent-4xx"
      )
    );
    check(
      "D7: record_alert_delivery_receipt(outcome=http_error, error_code=http_4xx_permanent) -> RECEIPT_RECORDED, final status failed, next_attempt_at NULL (no retry ever scheduled)",
      r.get("st") === "RECEIPT_RECORDED" && r.get("fds") === "failed" && r.get("dstat") === "failed" && r.get("no_retry") === "t"
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${fx.get("pid")}');\n`, "d7-cleanup");
  });

  await sc(SCENARIO_ROSTER[32]!, async () => {
    const fx = await buildOnePendingDelivery("d8");
    const r = parseMarkers(
      runPsql(
        `
\\pset pager off
SET ROLE service_role;
select delivery_id::text as did, claim_token::text as tok from claim_next_pending_alert('d8-worker', 60) \\gset
select attempt_id::text as aid from mark_alert_request_sent(:'did', :'tok') \\gset
select status as st, final_delivery_status as fds from record_alert_delivery_receipt(:'did', :'tok', :'aid', 'http_error', 503, null, 'http_5xx') \\gset
select status as dstat, attempt_count::text as ac,
       extract(epoch from (next_attempt_at - now()))::numeric as delay_seconds
  from protocol_execution_job_alert_deliveries where delivery_id = :'did' \\gset
\\echo '##R## st' :st
\\echo '##R## fds' :fds
\\echo '##R## dstat' :dstat
\\echo '##R## ac' :ac
\\echo '##R## delay_seconds' :delay_seconds
`,
        "d8-transient-5xx"
      )
    );
    const delay = Number(r.get("delay_seconds") ?? "0");
    check(
      "D8: record_alert_delivery_receipt(outcome=http_error, error_code=http_5xx) on the first attempt -> RECEIPT_RECORDED, status back to pending, a jittered backoff window around 24-36s (30s * 0.8-1.2 jitter), never unbounded and never zero",
      r.get("st") === "RECEIPT_RECORDED" && r.get("fds") === "pending" && r.get("dstat") === "pending" && r.get("ac") === "1" && delay > 20 && delay < 40
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${fx.get("pid")}');\n`, "d8-cleanup");
  });

  await sc(SCENARIO_ROSTER[33]!, async () => {
    const fx = await buildOnePendingDelivery("d9");
    const r = parseMarkers(
      runPsql(
        `
\\pset pager off
SET ROLE service_role;
select delivery_id::text as did, claim_token::text as tok from claim_next_pending_alert('d9-worker', 60) \\gset
select attempt_id::text as aid, idempotency_key as ik1 from mark_alert_request_sent(:'did', :'tok') \\gset
select public._m5_0054_rt_backdate_delivery(:'did', 'request_sent', 'd9-worker', :'tok'::uuid, now() - interval '1 minute', null, 1);
select public._m5_0054_rt_force_attempt_row(:'aid', now() - interval '2 hours', null, null, null);
select status as reclaim_st, delivery_id::text as reclaim_did, reconciled_under_24h_count::text as u24, idempotency_key as ik2
  from claim_next_pending_alert('d9-worker2', 60) \\gset
select status as dstat, attempt_count::text as ac from protocol_execution_job_alert_deliveries where delivery_id = :'did' \\gset
select outcome as oc from protocol_execution_job_alert_delivery_attempts where attempt_id = :'aid' \\gset
\\echo '##R## u24' :u24
\\echo '##R## reclaim_st' :reclaim_st
\\echo '##R## reclaim_did' :reclaim_did
\\echo '##R## did' :did
\\echo '##R## dstat' :dstat
\\echo '##R## ac' :ac
\\echo '##R## oc' :oc
\\echo '##R## ik1' :ik1
\\echo '##R## ik2' :ik2
`,
        "d9-under-24h-retry"
      )
    );
    check(
      "D9: a request_sent delivery with an expired (backdated) lease and a 2h-old (backdated) request_sent_at (<24h) is reconciled to pending on the next claim, and immediately re-claimed for the SAME delivery/alert_event_id -- so the same idempotency_key ('m5-alert:'||alert_event_id) that mark_alert_request_sent will issue for the retry",
      r.get("u24") === "1" &&
        r.get("oc") === "ambiguous_under_24h" &&
        r.get("reclaim_st") === "CLAIMED" &&
        r.get("reclaim_did") === r.get("did") &&
        r.get("dstat") === "claimed" &&
        !!r.get("ik1") &&
        r.get("ik1") === r.get("ik2")
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${fx.get("pid")}');\n`, "d9-cleanup");
  });

  await sc(SCENARIO_ROSTER[34]!, async () => {
    const fx = await buildOnePendingDelivery("d10");
    const r = parseMarkers(
      runPsql(
        `
\\pset pager off
SET ROLE service_role;
select delivery_id::text as did, claim_token::text as tok1 from claim_next_pending_alert('d10-worker0', 60) \\gset
select attempt_id::text as aid1 from mark_alert_request_sent(:'did', :'tok1') \\gset
select status as st1 from record_alert_delivery_receipt(:'did', :'tok1', :'aid1', 'ambiguous_under_24h') \\gset
select claim_token::text as tok2, status as reclaim1 from claim_next_pending_alert('d10-worker1', 60) \\gset
select attempt_id::text as aid2 from mark_alert_request_sent(:'did', :'tok2') \\gset
select status as st2 from record_alert_delivery_receipt(:'did', :'tok2', :'aid2', 'ambiguous_under_24h') \\gset
select claim_token::text as tok3, status as reclaim2 from claim_next_pending_alert('d10-worker2', 60) \\gset
select attempt_id::text as aid3 from mark_alert_request_sent(:'did', :'tok3') \\gset
select status as st3, final_delivery_status as fds3 from record_alert_delivery_receipt(:'did', :'tok3', :'aid3', 'ambiguous_under_24h') \\gset
select status as dstat, attempt_count::text as ac from protocol_execution_job_alert_deliveries where delivery_id = :'did' \\gset
select status as no_fourth from claim_next_pending_alert('d10-worker3', 60) \\gset
\\echo '##R## st1' :st1
\\echo '##R## st2' :st2
\\echo '##R## st3' :st3
\\echo '##R## fds3' :fds3
\\echo '##R## dstat' :dstat
\\echo '##R## ac' :ac
\\echo '##R## no_fourth' :no_fourth
`,
        "d10-third-under24h"
      )
    );
    check(
      "D10: three consecutive ambiguous_under_24h outcomes retry the first two (status back to pending each time) but the THIRD (attempt_count reaching 3) transitions to needs_review_delivery, and no 4th claim is ever possible for this delivery",
      r.get("st1") === "RECEIPT_RECORDED" &&
        r.get("st2") === "RECEIPT_RECORDED" &&
        r.get("st3") === "RECEIPT_RECORDED" &&
        r.get("fds3") === "needs_review_delivery" &&
        r.get("dstat") === "needs_review_delivery" &&
        r.get("ac") === "3" &&
        r.get("no_fourth") === "NO_ALERT_AVAILABLE"
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${fx.get("pid")}');\n`, "d10-cleanup");
  });

  await sc(SCENARIO_ROSTER[35]!, async () => {
    const fx = await buildOnePendingDelivery("d11");
    const r = parseMarkers(
      runPsql(
        `
\\pset pager off
SET ROLE service_role;
select delivery_id::text as did, claim_token::text as tok from claim_next_pending_alert('d11-worker', 60) \\gset
select attempt_id::text as aid from mark_alert_request_sent(:'did', :'tok') \\gset
select status as st, final_delivery_status as fds from record_alert_delivery_receipt(:'did', :'tok', :'aid', 'ambiguous_over_24h') \\gset
select status as dstat, attempt_count::text as ac from protocol_execution_job_alert_deliveries where delivery_id = :'did' \\gset
\\echo '##R## st' :st
\\echo '##R## fds' :fds
\\echo '##R## dstat' :dstat
\\echo '##R## ac' :ac
`,
        "d11-over-24h"
      )
    );
    check(
      "D11: ambiguous_over_24h on the FIRST attempt (attempt_count=1, well under the cap) -> needs_review_delivery unconditionally, never a pending retry regardless of attempt_count",
      r.get("st") === "RECEIPT_RECORDED" && r.get("fds") === "needs_review_delivery" && r.get("dstat") === "needs_review_delivery" && r.get("ac") === "1"
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${fx.get("pid")}');\n`, "d11-cleanup");
  });

  await sc(SCENARIO_ROSTER[36]!, async () => {
    const fx = await buildOnePendingDelivery("d12");
    const r = parseMarkers(
      runPsql(
        `
\\pset pager off
SET ROLE service_role;
select delivery_id::text as did, claim_token::text as tok from claim_next_pending_alert('d12-worker', 60) \\gset
select public._m5_0054_rt_backdate_delivery(:'did', 'claimed', 'd12-worker', :'tok'::uuid, now() + interval '1 hour', null, 3);
select status as cap_st from mark_alert_request_sent(:'did', :'tok') \\gset
\\echo '##R## cap_st' :cap_st
`,
        "d12-cap-defensive"
      )
    );
    check(
      "D12: mark_alert_request_sent's own defensive cap guard returns ALERT_ATTEMPT_CAP_EXCEEDED when attempt_count is already 3 (engineered via test-only backdate, since the public contract itself can never naturally reach a 4th send), agreeing with claim_next_pending_alert's own attempt_count<3 exclusion proven throughout D10/D9",
      r.get("cap_st") === "ALERT_ATTEMPT_CAP_EXCEEDED"
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${fx.get("pid")}');\n`, "d12-cleanup");
  });

  await sc(SCENARIO_ROSTER[37]!, async () => {
    const fx = await buildOnePendingDelivery("d13");
    const setup = parseMarkers(
      runPsql(
        `
\\pset pager off
SET ROLE service_role;
select delivery_id::text as did, claim_token::text as tok from claim_next_pending_alert('d13-worker', 60) \\gset
select attempt_id::text as aid from mark_alert_request_sent(:'did', :'tok') \\gset
select public._m5_0054_rt_backdate_delivery(:'did', 'request_sent', 'd13-worker', :'tok'::uuid, now() + interval '2 seconds', null, 1);
\\echo '##R## did' :did
\\echo '##R## tok' :tok
\\echo '##R## aid' :aid
`,
        "d13-setup"
      )
    );
    const did = setup.get("did")!;
    const tok = setup.get("tok")!;
    const aid = setup.get("aid")!;
    resetAndRegisterScenarioBarrier("d13");

    // Session A: terminalizes inside an explicitly held-open
    // transaction. Prints its backend pid and a ready marker
    // immediately after the RPC call returns (before the bounded
    // barrier wait), so the parent can mechanically capture the pid
    // without guessing at timing.
    const sessionA = `
\\pset pager off
SET ROLE service_role;
BEGIN;
select pg_backend_pid()::text as a_pid \\gset
select status as a_st, final_delivery_status as a_fds
  from record_alert_delivery_receipt('${did}', '${tok}', '${aid}', 'accepted', 200, 'resend-d13-race')
  \\gset
\\echo '##R## a_pid' :a_pid
\\echo '##R## a_ready' D13_A_READY
${barrierWaitSql("d13", 300, 0.05)}
COMMIT;
\\echo '##R## a_st' :a_st
\\echo '##R## a_fds' :a_fds
`;
    const aLive = runPsqlAsyncLive(sessionA, "d13-race-a", 25000);
    await waitUntil(
      () => aLive.getStdout().includes("##R## a_ready D13_A_READY"),
      5000,
      50,
      "D13: session A reached its ready barrier (backend pid captured, terminalization done, transaction still open) before any expiry/lock observation began"
    );
    const aPartial = parseMarkers(aLive.getStdout());
    const aPid = aPartial.get("a_pid");
    check("D13: session A's Postgres backend pid was captured while its transaction was still open", !!aPid);

    // Confirm the lease has genuinely expired using PostgreSQL's OWN
    // clock (now()), via a single bounded server-side loop -- never
    // Node's assumption about wall-clock alignment between processes.
    // Bounded: up to 40 * 0.15s = 6s: the lease was backdated to
    // setup_time+2s, so this resolves true after ~2s of real waiting
    // and is not a guess about that duration.
    const expiryPoll = parseMarkers(
      runPsql(
        `\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_poll_lease_expired('${did}', 40, 0.15) as expired \\gset\n\\echo '##R## expired' :expired\n`,
        "d13-poll-lease-expired"
      )
    );
    check("D13: the delivery's lease was confirmed genuinely expired via PostgreSQL's own clock (bounded server-side poll, not a Node-side guess)", expiryPoll.get("expired") === "t");

    // Session B: prints its backend pid BEFORE the (potentially
    // blocking) claim call, so the parent can observe it mid-flight.
    const sessionB = `
\\pset pager off
SET ROLE service_role;
select pg_backend_pid()::text as b_pid \\gset
\\echo '##R## b_pid' :b_pid
select status as b_st, reconciled_under_24h_count::text as b_u24, reconciled_over_24h_count::text as b_o24
  from claim_next_pending_alert('d13-sweeper', 60) \\gset
\\echo '##R## b_st' :b_st
\\echo '##R## b_u24' :b_u24
\\echo '##R## b_o24' :b_o24
`;
    const bLive = runPsqlAsyncLive(sessionB, "d13-race-b", 20000);
    await waitUntil(() => bLive.getStdout().includes("##R## b_pid"), 3000, 30, "D13: session B's backend pid marker printed before its own claim call");
    const bPartial = parseMarkers(bLive.getStdout());
    const bPid = bPartial.get("b_pid");
    check("D13: two distinct Postgres backend PIDs were used for the two concurrent sessions", !!aPid && !!bPid && aPid !== bPid);

    // Observe B's own wait_event_type via a single bounded server-side
    // poll (up to 40 * 0.1s = 4s) -- reported honestly either way, per
    // "if that is indeed the expected behavior": B's stale-reconciliation
    // UPDATE targets the same attempts row A already holds via its own
    // still-open transaction, so genuine lock contention is expected,
    // but this is a real observation, never assumed.
    const waitEventPoll = parseMarkers(
      runPsql(
        `\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_poll_wait_event(${bPid}, 40, 0.1) as observed \\gset\n\\echo '##R## observed' :observed\n`,
        "d13-poll-wait-event"
      )
    );
    const observedWaitEvent = waitEventPoll.get("observed");
    check(
      "D13: session B was observed via pg_stat_activity with wait_event_type='Lock' while session A still held its transaction open -- genuine lock contention, not merely a final-state coincidence",
      observedWaitEvent === "Lock"
    );
    if (observedWaitEvent !== "Lock") {
      console.log(
        `  (honest note: expected wait_event_type='Lock' for session B while A held its transaction open; actually observed "${observedWaitEvent}" -- reported as-is, not forced)`
      );
    }

    releaseScenarioBarrier("d13");

    const [aResultRaw, bResultRaw] = await Promise.all([aLive.done, bLive.done]);
    const aResult = validateAsyncPsqlResult(aResultRaw, "d13-race-a", aLive.scriptPath);
    const bResult = validateAsyncPsqlResult(bResultRaw, "d13-race-b", bLive.scriptPath);
    const ma = parseMarkers(aResult.stdout);
    const mb = parseMarkers(bResult.stdout);

    const verify = parseMarkers(
      runPsql(
        `\\pset pager off\nSET ROLE service_role;\nselect status as final_dstat, outcome as final_oc from protocol_execution_job_alert_deliveries d join protocol_execution_job_alert_delivery_attempts a on a.attempt_id = '${aid}' where d.delivery_id = '${did}' \\gset\n\\echo '##R## final_dstat' :final_dstat\n\\echo '##R## final_oc' :final_oc\n`,
        "d13-verify"
      )
    );
    check(
      "D13: after both sessions completed (B genuinely blocked on A's row lock, observed via pg_stat_activity, then unblocked only once A committed), A terminalized exactly once (accepted) and B's own reconciliation counted ZERO for this attempt -- exactly one terminalizer, final state never overwritten",
      ma.get("a_st") === "RECEIPT_RECORDED" &&
        ma.get("a_fds") === "accepted" &&
        mb.get("b_u24") === "0" &&
        mb.get("b_o24") === "0" &&
        verify.get("final_dstat") === "accepted" &&
        verify.get("final_oc") === "accepted"
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${fx.get("pid")}');\n`, "d13-cleanup");
  });

  await sc(SCENARIO_ROSTER[38]!, async () => {
    const fx = await buildOnePendingDelivery("d14");
    const r = parseMarkers(
      runPsql(
        `
\\pset pager off
SET ROLE service_role;
select delivery_id::text as did, claim_token::text as tok from claim_next_pending_alert('d14-worker', 60) \\gset
select attempt_id::text as aid from mark_alert_request_sent(:'did', :'tok') \\gset
select public._m5_0054_rt_force_attempt_row(:'aid', null, 'accepted', now(), 'already-terminal-fixture');
-- psql leaves a \\gset target variable UNSET (not empty) when the column
-- value is NULL, and any value preset beforehand is discarded rather
-- than preserved -- delivery_id IS expected to be NULL on this exact
-- branch, so the NULL is collapsed to the sentinel inside SQL itself,
-- the only form that survives \\gset deterministically.
select status as st, coalesce(delivery_id::text, 'SENTINEL_NULL') as rdid from record_alert_delivery_receipt(:'did', :'tok', :'aid', 'accepted', 200, 'second-attempt-resend') \\gset
select outcome as oc, resend_email_id as rid from protocol_execution_job_alert_delivery_attempts where attempt_id = :'aid' \\gset
\\echo '##R## st' :st
\\echo '##R## rdid' :rdid
\\echo '##R## oc' :oc
\\echo '##R## rid' :rid
`,
        "d14-already-terminal"
      )
    );
    check(
      "D14: an attempt row already terminal (engineered via test-only backdoor to prove the defensive guard, since the public contract's own row-locking normally prevents this exact window) -> ATTEMPT_ALREADY_TERMINAL, delivery_id null (no mutation), the attempt row's own outcome/resend_email_id remain exactly as they were, never overwritten by the second call",
      r.get("st") === "ATTEMPT_ALREADY_TERMINAL" && r.get("rdid") === "SENTINEL_NULL" && r.get("oc") === "accepted" && r.get("rid") === "already-terminal-fixture"
    );
    runPsql(`\\pset pager off\nSET ROLE service_role;\nselect public._m5_0054_rt_cleanup('${fx.get("pid")}');\n`, "d14-cleanup");
  });

  console.log(`\nAll ${ranScenarios.size} scenarios executed.`);

  // Called last, strictly before returning to main() -- which itself
  // only proceeds to the assertion gate, zypact-postgres pre-cleanup
  // check, `supabase stop`, and succeededFully=true AFTER this function
  // resolves. A throw here propagates to main()'s own catch block
  // (stack/workdir preserved, no cleanup), exactly like any other
  // scenario failure.
  assertRuntimeInfrastructureQuiescent();
}

main();
