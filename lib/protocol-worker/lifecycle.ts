/**
 * M5-A — the shutdown-shaped parts of the worker's lifecycle.
 *
 * `sleep` lives here rather than in the entrypoint so a test can measure
 * what it actually does. A regex over `run-protocol-worker.ts` could only
 * ever describe the code; the behaviour that matters — that an aborted
 * wait returns immediately instead of running its full backoff — has to
 * be exercised.
 */

/**
 * Waits `ms`, or until `signal` aborts, whichever comes first.
 *
 * Deliberately NOT unref'd: an unreferenced timer lets Node exit during a
 * backoff, so a healthy idle worker would simply vanish. Shutdown is
 * cooperative, never accidental — and never slower than the abort.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** The same function, exported under the name the lifecycle test uses. */
export const __workerLifecycleTestUtils = { sleep };
