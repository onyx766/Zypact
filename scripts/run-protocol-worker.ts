/**
 * M5-A — protocol execution worker entrypoint.
 *
 * A plain long-running Node process: `npm run worker:protocol`, which is
 * exactly `node --import tsx scripts/run-protocol-worker.ts`. It is not a
 * Next.js route and not a serverless function, because a claim + lease +
 * heartbeat only means anything inside a process that outlives a single
 * HTTP request.
 *
 * That command shape is load-bearing, not cosmetic. The `tsx` CLI forks a
 * child and the parent dies on SIGTERM before the child can run its
 * handler, so the cooperative stop below is never reached and the process
 * reports 143. `node --import tsx` is one process, and one process is what
 * a supervisor can actually signal. A container must therefore exec this
 * command directly in exec form; `npm` must not be PID 1, because npm's
 * own signal forwarding is not part of this contract.
 *
 * M0 — the execution gate.
 *
 * `WORKER_EXECUTION_MODE` decides, before anything else happens, whether
 * this process is inert or spending. Absent or empty means `disabled`, so
 * a host that forgets the variable gets the inert worker.
 *
 * The branch is structural, not a flag threaded through the loop. The db
 * adapter, the Perplexity probe, the analysis transport and the loop
 * itself are imported DYNAMICALLY, inside the live branch only. In
 * `disabled` those modules are never evaluated, so no db client is
 * constructed, no provider transport is built, no credential is read and
 * no `fetch` reference is created — not merely unused, absent.
 *
 * Everything the loop touches is still injected in one place, which is what
 * lets the tests drive the identical code path with fakes and zero network.
 *
 * Shutdown is cooperative in both modes: SIGINT/SIGTERM set the abort flag,
 * the current iteration finishes its fenced RPC sequence, and the lease is
 * simply allowed to lapse. Nothing is force-killed mid-write.
 */

import { createServer, type Server } from "node:http";
import { resolveExecutionPlan, WorkerConfigError } from "@/lib/protocol-worker/execution-mode";
import type { ExecutionPlan, HealthHost, LiveWorkerConfig } from "@/lib/protocol-worker/execution-mode";
// Type-only: erased at compile time, so it creates no runtime dependency
// and the disabled path still never evaluates the worker modules.
import type { AnalysisTransport, IterationResult, WorkerDeps, WorkerOptions } from "@/lib/protocol-worker/types";

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", event, ...fields }));
}

/**
 * Health surface, bound to the address the configuration validated and
 * nothing else. `127.0.0.1` — the default — keeps it on the host, which is
 * what a supervisor sharing that host needs. `0.0.0.0` is reachable by an
 * orchestrator's health prober off-box, and is therefore only ever the
 * result of `WORKER_HEALTH_HOST` being set to it explicitly.
 *
 * `payload` yields closed scalars only — no job id, project id, prompt,
 * body or token may reach it. That holds identically on both addresses:
 * widening the bind must never widen what is disclosed.
 */
function startHealthServer(
  healthPort: number,
  healthHost: HealthHost,
  payload: () => { healthz: unknown; readyz: unknown; readyStatus: number },
): Server | null {
  if (healthPort <= 0) return null;
  const healthServer = createServer((req, res) => {
    const p = payload();
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(p.healthz));
      return;
    }
    if (req.url === "/readyz") {
      res.writeHead(p.readyStatus, { "content-type": "application/json" });
      res.end(JSON.stringify(p.readyz));
      return;
    }
    res.writeHead(404).end();
  });
  healthServer.listen(healthPort, healthHost);
  // Unref'd on purpose: the health surface must never be the only thing
  // holding the process open. In disabled mode a referenced keep-alive
  // handle does that job; in live mode the loop's own timers do.
  healthServer?.unref();
  return healthServer;
}

/**
 * Inert mode. Stays up so a supervisor sees a healthy process, answers the
 * local health surface, and does nothing else. It requires no Supabase,
 * Perplexity, OpenAI or Anthropic credential, because it never reaches any
 * code that would read one.
 */
async function runDisabled(healthPort: number, healthHost: HealthHost): Promise<void> {
  log("worker_execution_disabled", { executionEnabled: false, healthPort, healthHost });

  const server = startHealthServer(healthPort, healthHost, () => ({
    healthz: { ready: true, executionEnabled: false },
    readyz: { ready: true, executionEnabled: false },
    readyStatus: 200,
  }));

  // A REFERENCED handle, on purpose. `startHealthServer` unrefs its server
  // so it can never be the only thing holding the process open, and a
  // signal handler alone does not keep Node's event loop alive. Without
  // this the inert worker printed its one line and exited straight away —
  // a supervisor would see a process that will not stay up, which is the
  // opposite of an idle worker waiting for work to be enabled.
  const keepAlive = setInterval(() => {}, 60_000);

  const signalName = await new Promise<string>((resolve) => {
    process.once("SIGINT", () => resolve("SIGINT"));
    process.once("SIGTERM", () => resolve("SIGTERM"));
  });

  clearInterval(keepAlive);
  await new Promise<void>((resolve) => {
    if (!server) { resolve(); return; }
    server.close(() => resolve());
  });

  // The positive proof of a cooperative stop, emitted only after the
  // keep-alive handle is released and the health server has actually
  // closed. A process that was killed by the default signal disposition,
  // or that never installed a handler, cannot print this line — which is
  // what lets the contract tell a clean shutdown from a plain kill.
  log("worker_execution_disabled_stopped", {
    signal: signalName, executionEnabled: false, healthServerClosed: server !== null,
  });
}

/**
 * Live mode. Every dependency that can spend money or touch the database is
 * imported here, after `resolveExecutionPlan` has already accepted the
 * configuration.
 */
async function runLive(cfg: LiveWorkerConfig): Promise<void> {
  const [{ getDb }, { runPerplexityProbe }, callModel, { sleep }, { runWorkerLoop }, { WorkerHealth }] =
    await Promise.all([
      import("@/lib/db"),
      import("@/lib/probes/perplexity"),
      import("@/lib/llm/call-model"),
      import("@/lib/protocol-worker/lifecycle"),
      import("@/lib/protocol-worker/worker"),
      import("@/lib/protocol-worker/health"),
    ]);
  // Declared before `deps` so the same signal reaches the probe fetch, the
  // analysis call and the idle wait.
  const shutdown = new AbortController();

  const analysis: AnalysisTransport = {
    prepare: (call) =>
      callModel.prepareCallModelRequest({
        system: call.system,
        user: call.user,
        jsonMode: call.jsonMode,
        temperature: call.temperature,
        maxTokens: call.maxTokens,
        mockResponse: call.mockResponse,
      }),
    execute: (prepared, opts) => callModel.executePreparedCallModelRequest(prepared, opts),
  };

  const deps: WorkerDeps = {
    db: getDb(),
    runProbe: runPerplexityProbe,
    analysis,
    realFetch: ((url, init) =>
      fetch(url, { ...init, signal: init?.signal ?? shutdown.signal })) as typeof fetch,
    now: () => Date.now(),
    sleep,
    abortSignal: shutdown.signal,
    probeMode: "live_perplexity",
  };

  const opts: WorkerOptions = {
    workerId: cfg.workerId,
    leaseSeconds: cfg.leaseSeconds,
    idleBackoffMs: cfg.idleBackoffMs,
    maxBackoffMs: cfg.maxBackoffMs,
    maxSlotsPerClaim: cfg.maxSlotsPerClaim,
    jitterRatio: cfg.jitterRatio,
    maxThrottledRetries: cfg.maxThrottledRetries,
    graceMs: cfg.graceMs,
    perplexityReservedCostUsd: cfg.perplexityReservedCostUsd,
    analysisReservedCostUsd: cfg.analysisReservedCostUsd,
  };

  const signal = { aborted: false };
  // Cooperative shutdown, bounded by a grace budget that stays BELOW the
  // lease: the current iteration finishes its fenced RPC sequence, and if
  // it overruns, in-flight provider calls are aborted rather than left to
  // outlive a lease we can no longer renew.
  const stop = (sig: string): void => {
    if (signal.aborted) return;
    signal.aborted = true;
    log("shutdown_requested", { signal: sig, graceMs: opts.graceMs });
    const t = setTimeout(() => shutdown.abort(), Math.min(opts.graceMs, opts.leaseSeconds * 1000 - 1));
    t.unref();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  log("worker_started", {
    workerId: cfg.workerId,
    leaseSeconds: cfg.leaseSeconds,
    probeMode: deps.probeMode,
    executionEnabled: true,
  });

  const healthRef = new WorkerHealth(deps.now);
  const server = startHealthServer(cfg.healthPort, cfg.healthHost, () => {
    const ready = healthRef.isReady(cfg.readyStaleMs);
    return {
      // Closed scalars and one timestamp. No job id, no project id, no
      // claim token, no prompt, no body.
      healthz: healthRef.snapshot(),
      readyz: { ready },
      readyStatus: ready ? 200 : 503,
    };
  });

  /**
   * The idle timer is deliberately NOT unref'd inside the loop: an
   * unreferenced timer lets Node exit during a backoff, so a healthy idle
   * worker would simply vanish. Shutdown is cooperative, never accidental.
   */
  const health = await runWorkerLoop(deps, opts, signal, sleep, (r: IterationResult) => {
    if (r.outcome === "no_job") return;
    // Closed labels only: an RPC outcome, a job id, never a prompt or a token.
    log("iteration", { outcome: r.outcome, jobId: r.jobId, detail: r.detail });
  }, healthRef);

  server?.close();
  log("worker_stopped", { ...health.snapshot() });
}

async function main(): Promise<void> {
  let plan: ExecutionPlan;
  try {
    plan = resolveExecutionPlan(process.env);
  } catch (err) {
    if (err instanceof WorkerConfigError) {
      // Variable names only. Never a value, a length, a prefix or a hash.
      console.error(JSON.stringify({
        ts: new Date().toISOString(), level: "error",
        event: "worker_configuration_rejected",
        reason: err.message, variables: err.variables,
      }));
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }

  if (plan.mode === "disabled") {
    await runDisabled(plan.healthPort, plan.healthHost);
    return;
  }
  await runLive(plan.config);
}

main().catch((err) => {
  console.error(JSON.stringify({
    ts: new Date().toISOString(), level: "error", event: "worker_crashed",
    message: err instanceof Error ? err.message : String(err),
  }));
  process.exit(1);
});
