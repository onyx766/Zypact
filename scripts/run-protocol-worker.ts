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
import { runWorkerLoop } from "@/lib/protocol-worker/worker";
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
  execute: (prepared) => executePreparedCallModelRequest(prepared),
};

async function main(): Promise<void> {
  const workerId = process.env.WORKER_ID ?? `worker-${process.pid}`;

  const deps: WorkerDeps = {
    db: getDb(),
    runProbe: runPerplexityProbe,
    analysis,
    realFetch: fetch,
    now: () => Date.now(),
    probeMode: "live_perplexity",
  };

  const opts: WorkerOptions = {
    workerId,
    leaseSeconds: intFromEnv("WORKER_LEASE_SECONDS", 60),
    idleBackoffMs: intFromEnv("WORKER_IDLE_BACKOFF_MS", 2000),
    maxBackoffMs: intFromEnv("WORKER_MAX_BACKOFF_MS", 30000),
    maxSlotsPerClaim: intFromEnv("WORKER_MAX_SLOTS_PER_CLAIM", 32),
    perplexityReservedCostUsd: floatFromEnv("WORKER_PERPLEXITY_RESERVED_USD", 0.02),
    analysisReservedCostUsd: floatFromEnv("WORKER_ANALYSIS_RESERVED_USD", 0.02),
  };

  const signal = { aborted: false };
  const stop = (sig: string) => {
    if (signal.aborted) return;
    signal.aborted = true;
    log("shutdown_requested", { signal: sig });
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  log("worker_started", {
    workerId,
    leaseSeconds: opts.leaseSeconds,
    probeMode: deps.probeMode,
  });

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });

  const health = await runWorkerLoop(deps, opts, signal, sleep, (r: IterationResult) => {
    if (r.outcome === "no_job") return;
    // Closed labels only: an RPC outcome, a job id, never a prompt or a token.
    log("iteration", { outcome: r.outcome, jobId: r.jobId, detail: r.detail });
  });

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
