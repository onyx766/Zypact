/**
 * M5-A — protocol execution worker entrypoint.
 *
 * A plain long-running Node process: `npm run worker:protocol`. It is not
 * a Next.js route and not a serverless function, because a claim + lease
 * + heartbeat only means anything inside a process that outlives a single
 * HTTP request.
 *
 * Everything the loop touches is injected here and nowhere else — the db
 * adapter, the real Perplexity probe, the two-phase analysis transport,
 * `fetch`, and the clock. That is what lets the tests drive the identical
 * code path with fakes and zero network access.
 *
 * Shutdown is cooperative: SIGINT/SIGTERM set the abort flag, the current
 * iteration finishes its fenced RPC sequence, and the lease is simply
 * allowed to lapse. Nothing is force-killed mid-write.
 */

import { getDb } from "@/lib/db";
import { runPerplexityProbe } from "@/lib/probes/perplexity";
import {
  executePreparedCallModelRequest,
  prepareCallModelRequest,
} from "@/lib/llm/call-model";
import { createServer } from "node:http";
import { sleep } from "@/lib/protocol-worker/lifecycle";
import { runWorkerLoop } from "@/lib/protocol-worker/worker";
import { WorkerHealth } from "@/lib/protocol-worker/health";
import type { AnalysisTransport, IterationResult, WorkerDeps, WorkerOptions } from "@/lib/protocol-worker/types";

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function floatFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const analysis: AnalysisTransport = {
  prepare: (call) =>
    prepareCallModelRequest({
      system: call.system,
      user: call.user,
      jsonMode: call.jsonMode,
      temperature: call.temperature,
      maxTokens: call.maxTokens,
      mockResponse: call.mockResponse,
    }),
  execute: (prepared, opts) => executePreparedCallModelRequest(prepared, opts),
};

/**
 * The idle timer is deliberately NOT unref'd: an unreferenced timer lets
 * Node exit during a backoff, so a healthy idle worker would simply
 * vanish. Shutdown is cooperative, never accidental.
 */

async function main(): Promise<void> {
  const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;

  // Declared before `deps` so the same signal reaches the probe fetch, the
  // analysis call and the idle wait.
  const shutdown = new AbortController();

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
    workerId,
    leaseSeconds: intFromEnv("WORKER_LEASE_SECONDS", 60),
    idleBackoffMs: intFromEnv("WORKER_IDLE_BACKOFF_MS", 2000),
    maxBackoffMs: intFromEnv("WORKER_MAX_BACKOFF_MS", 30000),
    maxSlotsPerClaim: intFromEnv("WORKER_MAX_SLOTS_PER_CLAIM", 32),
    jitterRatio: floatFromEnv("WORKER_JITTER_RATIO", 0.5),
    maxThrottledRetries: intFromEnv("WORKER_MAX_THROTTLED_RETRIES", 3),
    graceMs: intFromEnv("WORKER_GRACE_MS", 10000),
    perplexityReservedCostUsd: floatFromEnv("WORKER_PERPLEXITY_RESERVED_USD", 0.02),
    analysisReservedCostUsd: floatFromEnv("WORKER_ANALYSIS_RESERVED_USD", 0.02),
  };

  const signal = { aborted: false };
  // Cooperative shutdown, bounded by a grace budget that stays BELOW the
  // lease: the current iteration finishes its fenced RPC sequence, and if
  // it overruns, in-flight provider calls are aborted rather than left to
  // outlive a lease we can no longer renew.
  const stop = (sig: string) => {
    if (signal.aborted) return;
    signal.aborted = true;
    log("shutdown_requested", { signal: sig, graceMs: opts.graceMs });
    const t = setTimeout(() => shutdown.abort(), Math.min(opts.graceMs, opts.leaseSeconds * 1000 - 1));
    t.unref();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  log("worker_started", {
    workerId,
    leaseSeconds: opts.leaseSeconds,
    probeMode: deps.probeMode,
  });

  // Local-only health surface. Bound to the loopback address on purpose:
  // this is for a supervisor on the same host, never a public endpoint.
  const healthPort = intFromEnv("WORKER_HEALTH_PORT", 0);
  const readyStaleMs = Math.max(opts.maxBackoffMs * 2, intFromEnv("WORKER_READY_STALE_MS", 60000));
  const healthRef: WorkerHealth = new WorkerHealth(deps.now);
  const healthServer =
    healthPort > 0
      ? createServer((req, res) => {
          const snap = healthRef.snapshot();
          if (req.url === "/healthz") {
            // Six closed scalars and one timestamp. No job id, no project
            // id, no claim token, no prompt, no body — nothing that could
            // identify a customer or authorise anything.
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(snap));
            return;
          }
          if (req.url === "/readyz") {
            const ready = healthRef.isReady(readyStaleMs);
            res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
            res.end(JSON.stringify({ ready }));
            return;
          }
          res.writeHead(404).end();
        })
      : null;
  healthServer?.listen(healthPort, "127.0.0.1");
  healthServer?.unref();

  const health = await runWorkerLoop(deps, opts, signal, sleep, (r: IterationResult) => {
    if (r.outcome === "no_job") return;
    // Closed labels only: an RPC outcome, a job id, never a prompt or a token.
    log("iteration", { outcome: r.outcome, jobId: r.jobId, detail: r.detail });
  }, healthRef);

  healthServer?.close();
  log("worker_stopped", { ...health.snapshot() });
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", event, ...fields }));
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      event: "worker_crashed",
      // The message only; a stack could carry a URL or a body fragment.
      reason: err instanceof Error ? err.name : "unknown",
    })
  );
  process.exitCode = 1;
});
