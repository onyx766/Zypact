#!/usr/bin/env tsx
/**
 * Runnable snapshot worker.
 *
 * Launch with:  npx tsx scripts/snapshot-worker.ts
 *
 * Deliberately thin. Everything decidable lives in
 * `lib/snapshot-worker/worker.ts`, which is testable without a database,
 * provider, real timer, or process signal. This file owns only the things a
 * process owns: identity, signal handlers, the startup gate, wiring the real
 * adapter and engine, and the exit code.
 *
 * Process management — systemd unit, restart policy, TimeoutStopSec — is a
 * separate operational step and is intentionally not part of this file.
 */

import { randomBytes } from "node:crypto";

import { getDb } from "@/lib/db";
import { runApprovedSnapshot } from "@/lib/snapshot-engine/run-approved-snapshot";
import {
  LEASE_SECONDS,
  MAX_EXECUTION_MS,
  RENEW_EVERY_MS,
  ShutdownSignal,
  runSnapshotWorker,
  type WorkerDb,
  type WorkerLogFields,
} from "@/lib/snapshot-worker/worker";

/**
 * Per-process identity.
 *
 * No hostname and no pid: the id only needs to distinguish concurrent
 * processes in logs. `claimToken`, not `claimedBy`, is what actually fences
 * a stalled worker, so a restart generating a fresh id is correct — it can
 * never inherit prior ownership.
 */
function makeWorkerId(): string {
  return `zypact-worker-${randomBytes(4).toString("hex")}`;
}

function log(fields: WorkerLogFields): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: fields.event === "worker_fatal" ? "error" : "info",
      ...fields,
    })
  );
}

/**
 * Operational startup gate for the cost estimate.
 *
 * `mvp-scan` compares its projected spend against the budget using this
 * per-probe figure, defaulting to a value when unset. Requiring it
 * explicitly makes the guard's meaning auditable rather than implicit.
 *
 * This gates *startup only*. It does not create a measured spend cap and
 * changes no budget enforcement — a run that costs more than projected is
 * still not halted mid-flight.
 */
export function costEstimateIsConfigured(
  raw: string | undefined
): boolean {
  if (typeof raw !== "string" || raw.trim() === "") return false;

  const value = Number(raw);

  return Number.isFinite(value) && value > 0;
}

async function main(): Promise<void> {
  const workerId = makeWorkerId();
  const shutdown = new ShutdownSignal();

  if (
    !costEstimateIsConfigured(
      process.env.ZYPACT_ESTIMATED_COST_PER_LIVE_PROBE_USD
    )
  ) {
    log({
      event: "worker_fatal",
      workerId,
      reason: "cost_estimate_not_configured",
    });
    process.exitCode = 1;
    return;
  }

  // Idempotent by construction: ShutdownSignal ignores repeated requests.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      log({ event: "worker_shutdown_requested", workerId });
      shutdown.request();
    });
  }

  // Never keep polling in an unknown process state. No raw error object is
  // logged, because it may carry connection or credential detail.
  const fatal = (reason: string): void => {
    log({ event: "worker_fatal", workerId, reason });
    process.exitCode = 1;
    shutdown.request();
  };

  process.on("uncaughtException", (error) => {
    fatal(error instanceof Error ? error.name : "uncaught_exception");
  });

  process.on("unhandledRejection", () => {
    fatal("unhandled_rejection");
  });

  const db = getDb() as unknown as WorkerDb;

  const result = await runSnapshotWorker(
    {
      db,
      workerId,
      log,
      sleep: (ms) => shutdown.sleep(ms),
      engine: async (claimed, options, claimToken) => {
        await runApprovedSnapshot(
          {
            id: claimed.id,
            companyName: claimed.companyName,
            websiteUrl: claimed.websiteUrl,
            buyerCategory: claimed.buyerCategory,
            status: claimed.status,
            projectId: claimed.projectId,
          },
          options,
          {},
          {
            mode: "worker",
            claimToken,
            lease: {
              leaseSeconds: LEASE_SECONDS,
              renewEveryMs: RENEW_EVERY_MS,
              maxExecutionMs: MAX_EXECUTION_MS,
            },
          }
        );
      },
    },
    shutdown
  );

  if (result.reason !== "shutdown") {
    process.exitCode = 1;
  }
}

main().catch(() => {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      event: "worker_fatal",
      reason: "startup_failed",
    })
  );
  process.exitCode = 1;
});
