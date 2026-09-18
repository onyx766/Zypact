#!/usr/bin/env tsx
/**
 * One approved request, all the way to a report.
 *
 * Runs the two stages the founder would otherwise run by hand:
 *   1. the protocol worker, which claims the queued job and makes the paid
 *      provider calls (it exits after one job when
 *      WORKER_EXIT_AFTER_CLAIMED_JOB is true);
 *   2. the report orchestrator, which builds, classifies and — only when
 *      integrity passed and sending is enabled — delivers.
 *
 * Stage 1 is a CHILD PROCESS rather than an import. The worker owns lease
 * renewal, claim fencing and its own shutdown handling, and running it inside
 * another process would put a paid, leased execution inside a lifecycle it
 * does not control. Spawning keeps the proven entry point intact and means a
 * crash here cannot orphan a lease that the worker itself would have released.
 *
 * NODE_ENV=production is set for the child on purpose: live execution mode
 * requires it, while the Next dev server that triggers this runs in
 * development. It is scoped to the child and never mutated globally.
 *
 * Usage:
 *   DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config \
 *     scripts/run-pipeline-once.ts --request-id <uuid>
 */

import { spawn } from "node:child_process";

import { createClient } from "@supabase/supabase-js";
import { publicSiteUrl } from "@/lib/seo/site";

import { processProtocolReport } from "@/lib/reports/deliver-protocol-report";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...fields,
    })
  );
}

function fail(message: string): never {
  log("pipeline_failed", { message });
  process.exit(1);
}

function parseArgs(argv: string[]): { requestId: string } {
  let requestId = "";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--request-id") {
      requestId = argv[i + 1] ?? "";
      i += 1;
    } else {
      fail(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!UUID.test(requestId)) fail("--request-id must be a valid UUID.");
  return { requestId };
}

/** Resolves with the child's exit code; never rejects. */
function runProtocolWorker(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/run-protocol-worker.ts",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: "production",
        },
        stdio: "inherit",
      }
    );

    child.on("error", () => resolve(-1));
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

async function main() {
  const { requestId } = parseArgs(process.argv.slice(2));

  log("pipeline_started", { requestId });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) fail("Supabase service-role configuration is required.");

  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const workerExit = await runProtocolWorker();
  log("protocol_worker_exited", { code: workerExit });

  // A non-zero worker exit is not fatal to this stage. The job may have
  // completed and then failed to shut down cleanly, and evidence already
  // written is still reportable — the integrity gate decides, not the exit
  // code.
  const autoSendEnabled =
    process.env.SNAPSHOT_AUTO_DELIVERY_ENABLED === "true";

  try {
    const result = await processProtocolReport(requestId, {
      client,
      autoSendEnabled,
      deliveryConfig: {
        apiKey: process.env.RESEND_API_KEY ?? "",
        from: process.env.SNAPSHOT_EMAIL_FROM ?? "",
        appBaseUrl: publicSiteUrl(),
      },
    });

    log("pipeline_finished", {
      requestId,
      outcome: result.outcome,
      integrityStatus: result.integrityStatus,
      integrityReasonCount: result.integrityReasons.length,
      artifactId: result.artifactId,
      ...(result.detail ? { detail: result.detail } : {}),
    });
  } catch (error) {
    fail(
      error instanceof Error
        ? error.message
        : typeof error === "object" && error
          ? JSON.stringify(error)
          : String(error)
    );
  }
}

main().catch((error) =>
  fail(
    error instanceof Error
      ? error.message
      : typeof error === "object" && error
        ? JSON.stringify(error)
        : String(error)
  )
);
