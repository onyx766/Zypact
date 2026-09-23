#!/usr/bin/env tsx
/**
 * Report delivery worker.
 *
 * Separate from the protocol worker on purpose. The protocol worker spends
 * money and holds leases on paid calls; folding email into it would let a
 * provider outage surface as paid-execution noise and would couple two
 * failure domains that retry on completely different timescales. This process
 * touches no provider that charges per call.
 *
 * For each snapshot request whose protocol job has succeeded and whose report
 * is not yet delivered: build the report, classify its integrity, persist it,
 * and — only when integrity passed AND auto-send is enabled — email the link.
 *
 * Auto-send defaults to OFF. Without SNAPSHOT_AUTO_DELIVERY_ENABLED=true the
 * pipeline runs end to end and stops before the provider, which is the safe
 * default for a process that mails customers.
 *
 * Usage:
 *   DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config \
 *     scripts/run-report-delivery-worker.ts [--once] [--request-id <uuid>]
 *                                           [--limit N] [--interval-seconds N]
 */

import { findDeliverableRequests } from "@/lib/reports/deliver-protocol-report";
import {
  processReportRequests,
  resolveReportPassConfig,
  type ReportPassConfig,
} from "@/lib/reports/report-pass";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string): never {
  console.error(JSON.stringify({ level: "error", message }));
  process.exit(1);
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  // Closed field list. No prompt text, response body, recipient address,
  // credential or claim token is ever logged.
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event,
      ...fields,
    })
  );
}

function parseArgs(argv: string[]) {
  let once = false;
  let requestId: string | undefined;
  let limit = 25;
  let intervalSeconds = 60;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1] ?? "";

    if (arg === "--once") once = true;
    else if (arg === "--request-id") { requestId = next; i += 1; }
    else if (arg === "--limit") { limit = Number(next); i += 1; }
    else if (arg === "--interval-seconds") { intervalSeconds = Number(next); i += 1; }
    else fail(`Unknown argument: ${arg}`);
  }

  if (requestId !== undefined && !UUID.test(requestId)) {
    fail("--request-id must be a valid UUID.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    fail("--limit must be an integer between 1 and 200.");
  }
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 5) {
    fail("--interval-seconds must be an integer of at least 5.");
  }

  return { once, requestId, limit, intervalSeconds };
}

function resolveConfig(): ReportPassConfig {
  const resolved = resolveReportPassConfig(process.env);
  if (!resolved.ok) fail(`${resolved.reason} Run with DOTENV_CONFIG_PATH=.env.local.`);
  return resolved.config;
}

async function runOnce(config: ReportPassConfig, requestIds: string[]): Promise<void> {
  await processReportRequests(config, requestIds, log);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = resolveConfig();

  log("delivery_worker_started", {
    autoSendEnabled: config.autoSendEnabled,
    once: args.once || Boolean(args.requestId),
    limit: args.limit,
  });

  if (!config.autoSendEnabled) {
    log("auto_send_disabled", {
      detail:
        "Reports will be built, classified and persisted. No email will be sent. Set SNAPSHOT_AUTO_DELIVERY_ENABLED=true to enable delivery.",
    });
  }

  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      shuttingDown = true;
      log("delivery_worker_shutdown_requested", { signal });
    });
  }

  if (args.requestId) {
    await runOnce(config, [args.requestId]);
    log("delivery_worker_stopped", { reason: "single_request" });
    return;
  }

  do {
    const ids = await findDeliverableRequests(config.client, args.limit);

    if (ids.length === 0) {
      log("no_deliverable_reports", {});
    } else {
      await runOnce(config, ids);
    }

    if (args.once || shuttingDown) break;

    await new Promise((resolve) =>
      setTimeout(resolve, args.intervalSeconds * 1000)
    );
  } while (!shuttingDown);

  log("delivery_worker_stopped", {
    reason: shuttingDown ? "signal" : "once",
  });
}

main().catch((error) => {
  fail(
    error instanceof Error
      ? error.message
      : typeof error === "object" && error
        ? JSON.stringify(error)
        : String(error)
  );
});
