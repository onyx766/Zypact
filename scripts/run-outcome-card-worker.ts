#!/usr/bin/env tsx
/**
 * Outcome Card delivery worker.
 *
 * Mirrors run-report-delivery-worker.ts's exact shape and reasoning,
 * applied to the Outcome Card. Kept as a separate process for the same
 * reason that one is separate from the protocol worker: this touches no
 * provider that charges per call, and folding it into a paid-execution
 * process would couple two failure domains that retry on different
 * timescales.
 *
 * For each implemented intervention whose retest job has succeeded and
 * whose card is not yet delivered: build the card, classify its combined
 * integrity, persist it, and — only when integrity passed AND auto-send is
 * enabled — email the link.
 *
 * Reuses the SAME environment surface as the report-delivery worker
 * (SNAPSHOT_AUTO_DELIVERY_ENABLED, SNAPSHOT_PUBLIC_BASE_URL, RESEND_API_KEY,
 * SNAPSHOT_EMAIL_FROM) rather than inventing a parallel one: it is the same
 * provider, the same founder-operated decision about whether to auto-send,
 * and the same safe default (off) for a process that mails customers.
 *
 * Usage:
 *   DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config \
 *     scripts/run-outcome-card-worker.ts [--once] [--intervention-id <uuid>]
 *                                        [--limit N] [--interval-seconds N]
 */

import { createClient } from "@supabase/supabase-js";

import {
  findDeliverableInterventions,
  processOutcomeCard,
  type OutcomeCardProcessResult,
} from "@/lib/reports/deliver-outcome-card";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string): never {
  console.error(JSON.stringify({ level: "error", message }));
  process.exit(1);
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  // Closed field list. No prompt text, response body, recipient address,
  // credential or claim token is ever logged.
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), level: "info", event, ...fields })
  );
}

function parseArgs(argv: string[]) {
  let once = false;
  let interventionId: string | undefined;
  let limit = 25;
  let intervalSeconds = 60;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1] ?? "";

    if (arg === "--once") once = true;
    else if (arg === "--intervention-id") { interventionId = next; i += 1; }
    else if (arg === "--limit") { limit = Number(next); i += 1; }
    else if (arg === "--interval-seconds") { intervalSeconds = Number(next); i += 1; }
    else fail(`Unknown argument: ${arg}`);
  }

  if (interventionId !== undefined && !UUID.test(interventionId)) {
    fail("--intervention-id must be a valid UUID.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    fail("--limit must be an integer between 1 and 200.");
  }
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 5) {
    fail("--interval-seconds must be an integer of at least 5.");
  }

  return { once, interventionId, limit, intervalSeconds };
}

function resolveConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    fail("Supabase service-role configuration is required. Run with DOTENV_CONFIG_PATH=.env.local.");
  }

  // Exactly "true", same rule as the report-delivery worker: a typo leaves
  // auto-send off rather than accidentally on.
  const autoSendEnabled = process.env.SNAPSHOT_AUTO_DELIVERY_ENABLED === "true";

  const appBaseUrl = process.env.SNAPSHOT_PUBLIC_BASE_URL ?? "";
  const apiKey = process.env.RESEND_API_KEY ?? "";
  const from = process.env.SNAPSHOT_EMAIL_FROM ?? "";

  if (autoSendEnabled) {
    if (!appBaseUrl) fail("SNAPSHOT_PUBLIC_BASE_URL is required when auto-delivery is enabled.");
    if (!apiKey) fail("RESEND_API_KEY is required when auto-delivery is enabled.");
    if (!from) fail("SNAPSHOT_EMAIL_FROM is required when auto-delivery is enabled.");
  }

  return {
    client: createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }),
    autoSendEnabled,
    deliveryConfig: { apiKey, from, appBaseUrl },
  };
}

/** Outcomes that mean a human needs to look. */
const ATTENTION: ReadonlySet<OutcomeCardProcessResult["outcome"]> = new Set([
  "held_blocked",
  "delivery_ambiguous",
  "delivery_rejected",
  "delivery_claim_unavailable",
]);

async function runOnce(
  config: ReturnType<typeof resolveConfig>,
  interventionIds: string[]
): Promise<void> {
  for (const interventionId of interventionIds) {
    try {
      const result = await processOutcomeCard(interventionId, {
        client: config.client,
        autoSendEnabled: config.autoSendEnabled,
        deliveryConfig: config.deliveryConfig,
      });

      log("outcome_card_processed", {
        interventionId,
        outcome: result.outcome,
        integrityStatus: result.integrityStatus,
        integrityReasonCount: result.integrityReasons.length,
        artifactId: result.artifactId,
        needsAttention: ATTENTION.has(result.outcome),
        ...(result.detail ? { detail: result.detail } : {}),
      });
    } catch (error) {
      // One bad intervention must not stop the batch.
      log("outcome_card_failed", {
        interventionId,
        message:
          error instanceof Error
            ? error.message
            : typeof error === "object" && error
              ? JSON.stringify(error)
              : String(error),
      });
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = resolveConfig();

  log("outcome_card_worker_started", {
    autoSendEnabled: config.autoSendEnabled,
    once: args.once || Boolean(args.interventionId),
    limit: args.limit,
  });

  if (!config.autoSendEnabled) {
    log("auto_send_disabled", {
      detail:
        "Outcome Cards will be built, classified and persisted. No email will be sent. Set SNAPSHOT_AUTO_DELIVERY_ENABLED=true to enable delivery.",
    });
  }

  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      shuttingDown = true;
      log("outcome_card_worker_shutdown_requested", { signal });
    });
  }

  if (args.interventionId) {
    await runOnce(config, [args.interventionId]);
    log("outcome_card_worker_stopped", { reason: "single_intervention" });
    return;
  }

  do {
    const ids = await findDeliverableInterventions(config.client, args.limit);

    if (ids.length === 0) {
      log("no_deliverable_outcome_cards", {});
    } else {
      await runOnce(config, ids);
    }

    if (args.once || shuttingDown) break;

    await new Promise((resolve) => setTimeout(resolve, args.intervalSeconds * 1000));
  } while (!shuttingDown);

  log("outcome_card_worker_stopped", { reason: shuttingDown ? "signal" : "once" });
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
