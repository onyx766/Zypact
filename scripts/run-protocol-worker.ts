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
 *
 * B3-intrinsic — live mode is also bounded in total. `WORKER_MAX_RUNTIME_
 * SECONDS` starts a clock at T0, BEFORE the dynamic imports, so module
 * evaluation and client construction are inside the budget rather than
 * free. The loop declines a claim it could not finish, the grace window
 * enters the ordinary cooperative stop, and the absolute deadline
 * terminates the process even if the wind-down itself is stuck. Nothing
 * about the disabled path changes: the variable is never read there.
 */

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
// PR-2 — pure, like execution-mode: it imports nothing, and its one file
// read is the local provenance record, injected below.
import { readBuildProvenance, type BuildProvenance } from "@/lib/protocol-worker/build-provenance";
import { resolveExecutionPlan, WorkerConfigError } from "@/lib/protocol-worker/execution-mode";
// STATIC, and deliberately so. The ceiling has to be armed before the
// first await, so the primitive that arms it cannot itself arrive through
// one. `runtime-bound` is pure: it imports nothing, constructs no client,
// opens no socket, arms no timer at module scope and has no top-level
// await — the disabled path may evaluate it and remain exactly as inert.
import {
  createCooperativeStop, runLiveBootstrap, startRuntimeBound,
} from "@/lib/protocol-worker/runtime-bound";
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
async function runDisabled(healthPort: number, healthHost: HealthHost, build: BuildProvenance): Promise<void> {
  log("worker_execution_disabled", { executionEnabled: false, healthPort, healthHost, ...build });

  const server = startHealthServer(healthPort, healthHost, () => ({
    healthz: { ready: true, executionEnabled: false, ...build },
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
async function runLive(cfg: LiveWorkerConfig, build: BuildProvenance): Promise<void> {
  // ── T0 ────────────────────────────────────────────────────────────────
  // Every statement between this line and `startRuntimeBound` below is
  // synchronous and allocation-only: no await, no dynamic import, no
  // client, no socket or server, no remote read, no user callback that
  // could block. That restriction is the whole point of the ordering. A
  // ceiling armed after the module graph has loaded does not cover the
  // module graph loading, and an import that never resolves would leave
  // the process running with a clock that started and a timer that never
  // did.
  const startedAtMs = Date.now();

  const shutdown = new AbortController();
  const signal = { aborted: false };

  // Cooperative shutdown, bounded by a grace budget that stays BELOW the
  // lease: the current iteration finishes its fenced RPC sequence, and if
  // it overruns, in-flight provider calls are aborted rather than left to
  // outlive a lease we can no longer renew.
  //
  // One stop, three doors — SIGINT, SIGTERM and the runtime grace deadline
  // all arrive here, and only the first of them does anything.
  const stopper = createCooperativeStop({
    graceMs: cfg.graceMs,
    leaseSeconds: cfg.leaseSeconds,
    signal,
    abort: () => shutdown.abort(),
    // A closed reason label. Never an environment value.
    onRequested: (reason) => log("shutdown_requested", { reason, graceMs: cfg.graceMs }),
  });
  // Installed here, before anything can block, so a SIGTERM that arrives
  // during initialisation is handled rather than queued behind it.
  // B3-intrinsic — the ceiling, armed from T0 and before the first await.
  const bound = startRuntimeBound({
    startedAtMs,
    maxRuntimeSeconds: cfg.maxRuntimeSeconds,
    // Computed once, by the configuration gate that already refused an
    // impossible ceiling with this exact number.
    requiredMsForNewClaim: cfg.claimBudgetMs,
    graceMs: cfg.graceMs,
    now: () => Date.now(),
    onGrace: () => stopper.request("runtime_deadline"),
    onForced: () => {
      // The absolute deadline, and deliberately not a graceful path: we
      // are only ever here because the whole grace window passed and
      // something did not wind down — an import, a client constructor, a
      // provider call or the wind-down itself. Awaiting anything could
      // block on that same thing, so the process ends. 75 is EX_TEMPFAIL:
      // the run hit its ceiling while still busy, which is retryable, not
      // a bad configuration.
      process.exit(75);
    },
    // Closed scalars: three durations and one configured integer. No
    // environment, no job id, no credential. Destructured rather than
    // spread whole: `log` spreads its fields AFTER the event name, so a
    // surviving `event` key would overwrite the very name being logged.
    onEvent: ({ event, ...fields }) => log(event, { ...fields, executionEnabled: true }),
  });

  // The exact references the finally will remove. Named, not inline: an
  // anonymous arrow passed to `on` cannot be passed to `off`.
  const onSigint = (): void => stopper.request("SIGINT");
  const onSigterm = (): void => stopper.request("SIGTERM");

  // ── everything below is inside the ceiling ────────────────────────────
  // `runLiveBootstrap` installs the two handlers as its first act — inside
  // this try — and removes them in its own finally, before either dispose
  // below runs. It also owns the health server and the post-await stop
  // check, so all three are exercised by tests instead of being properties
  // of this file's indentation.
  //
  // The two disposes are ordered and they belong here, not there: the
  // handlers go first so a late signal can no longer reach the stop, the
  // cooperative stop next, and the ceiling LAST — so the absolute deadline
  // still covers the server close and the handler removal, which is
  // exactly where a stuck run tends to end up.
  try {
    await runLiveBootstrap({
    signal,
    host: process,
    handlers: [["SIGINT", onSigint], ["SIGTERM", onSigterm]],
    onAbandoned: (stage) =>
      log("worker_initialisation_abandoned", { stage, executionEnabled: true }),
    // Closed label only: an error name, never a message or a path.
    onCloseFailed: (detail) =>
      log("worker_health_server_close_failed", { detail, executionEnabled: true }),
    // Awaited: `close` is asynchronous, and a bootstrap that returned
    // before the socket was actually released would be reporting a
    // shutdown it had not finished.
    closeServer: (server: Server) =>
      new Promise<void>((resolve) => { server.close(() => resolve()); }),
    load: () =>
      Promise.all([
        import("@/lib/db"),
        import("@/lib/probes/perplexity"),
        import("@/lib/llm/call-model"),
        import("@/lib/protocol-worker/lifecycle"),
        import("@/lib/protocol-worker/worker"),
        import("@/lib/protocol-worker/health"),
        import("@/lib/reports/report-pass"),
        import("@/lib/worker-control/paid-execution-gate"),
        import("@/lib/reports/service-client"),
      ]),
    run: async ([
      { getDb }, { runPerplexityProbe }, callModel, { sleep }, { runWorkerLoop },
      { WorkerHealth, idleProofEvent }, { runReportPass },
      { paidExecutionGateFor }, { getReportServiceClient },
    ], adopt) => {
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
        exitAfterClaimedJob: cfg.exitAfterClaimedJob,
        providerTimeoutMs: cfg.providerTimeoutMs,
        perplexityReservedCostUsd: cfg.perplexityReservedCostUsd,
        analysisReservedCostUsd: cfg.analysisReservedCostUsd,
        runtimeBound: bound,
      };

      // PR-1 — the paid-execution gate, asked by the loop before every
      // claim: the switch, the ceiling and the ledger, read through an
      // explicitly configured service-role client (never the memory
      // adapter, which live mode already refuses). Missing configuration
      // is a refusal.
      const paidExecutionGate = paidExecutionGateFor(getReportServiceClient, process.env);

      log("worker_started", {
        workerId: cfg.workerId,
        leaseSeconds: cfg.leaseSeconds,
        probeMode: deps.probeMode,
        maxRuntimeSeconds: cfg.maxRuntimeSeconds,
        executionEnabled: true,
        ...build,
      });

      const healthRef = new WorkerHealth(deps.now);
      const server = startHealthServer(cfg.healthPort, cfg.healthHost, () => {
        const ready = healthRef.isReady(cfg.readyStaleMs);
        return {
          // Closed scalars and one timestamp. No job id, no project id, no
          // claim token, no prompt, no body.
          healthz: { ...healthRef.snapshot(), ...build },
          readyz: { ready },
          readyStatus: ready ? 200 : 503,
        };
      });
      // Adopted the moment it is bound. From here the bootstrap closes it
      // exactly once, whatever happens below — including a throw.
      if (server) adopt(server);

      /**
       * The idle timer is deliberately NOT unref'd inside the loop: an
       * unreferenced timer lets Node exit during a backoff, so a healthy
       * idle worker would simply vanish. Shutdown is cooperative, never
       * accidental.
       */
      const health = await runWorkerLoop(deps, opts, paidExecutionGate, signal, sleep, (r: IterationResult) => {
        if (r.outcome === "no_job") {
          // TK-R-0 — idle cycles are still NOT logged one by one: a worker
          // on an empty queue would otherwise fill the log with nothing.
          // The threshold decision lives in `idleProofEvent` so that the
          // test can execute this exact rule instead of restating it; here
          // there is only the wiring.
          const proof = idleProofEvent(healthRef.snapshot());
          if (proof) log("worker_idle_proof", { ...proof, executionEnabled: true });
          return;
        }
        // Closed labels only: an RPC outcome, a job id, never a prompt or a token.
        log("iteration", { outcome: r.outcome, jobId: r.jobId, detail: r.detail });
      }, healthRef);

      log("worker_stopped", { ...health.snapshot() });

      // One report pass once the scan loop has stopped, so a finished scan
      // becomes a report without a second process. It calls no paid
      // provider and runs inside the same runtime ceiling. The loop never
      // sets `signal.aborted` itself, so a set flag means SIGINT, SIGTERM or
      // the runtime deadline asked this process to stop: then it starts no
      // new work, and the next run's pass picks the reports up.
      if (signal.aborted) {
        log("report_pass_skipped", { reason: "stop_requested", executionEnabled: true });
      } else {
        await runReportPass({
          env: process.env,
          log: (event, fields = {}) => log(event, { ...fields, executionEnabled: true }),
          shouldStop: () => signal.aborted,
        });
      }
    },
    });
  } finally {
    stopper.dispose();
    bound.dispose();
  }
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

  // PR-2 — read once, synchronously, before either branch: closed values
  // only (a status, a commit SHA, a digest), withheld when inconsistent.
  const build = readBuildProvenance(process.env, (file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  });

  if (plan.mode === "disabled") {
    await runDisabled(plan.healthPort, plan.healthHost, build);
    return;
  }
  await runLive(plan.config, build);
}

main().catch((err) => {
  // A thrown value is not always an Error. Supabase rejects with a plain
  // object ({message, details, hint, code}), and `String()` renders that as
  // "[object Object]" — which is what a crash here used to report, hiding
  // the only description of why a paid run stopped. Non-Errors are
  // serialized instead, with a closed field list so no prompt, response,
  // credential or claim token can reach the log through an unexpected shape.
  const describe = (value: unknown): string => {
    if (value instanceof Error) return value.message;
    if (value && typeof value === "object") {
      const o = value as Record<string, unknown>;
      const parts = ["message", "code", "details", "hint"]
        .filter((k) => typeof o[k] === "string" || typeof o[k] === "number")
        .map((k) => `${k}=${String(o[k])}`);
      if (parts.length > 0) return parts.join(" ");
      return `unserializable ${Object.prototype.toString.call(value)}`;
    }
    return String(value);
  };

  console.error(JSON.stringify({
    ts: new Date().toISOString(), level: "error", event: "worker_crashed",
    message: describe(err),
    errorName: err instanceof Error ? err.name : undefined,
  }));
  process.exit(1);
});
