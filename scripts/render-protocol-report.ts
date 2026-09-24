#!/usr/bin/env tsx
/**
 * Renders the canonical V1 report for one snapshot request from stored
 * protocol evidence.
 *
 * Read-only by default: it prints the report and writes nothing. Persisting
 * an artifact is a separate, explicitly-flagged step, because an artifact is
 * the thing a client can be sent.
 *
 * Usage:
 *   npx tsx -r dotenv/config scripts/render-protocol-report.ts \
 *     --request-id <uuid> [--json] [--short] [--out <file.md>]
 *
 * Credentials come from the environment. This repository keeps them in
 * `.env.local`, which plain `dotenv/config` does not load by default, so
 * run with DOTENV_CONFIG_PATH=.env.local.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createClient } from "@supabase/supabase-js";

import { buildProtocolReport } from "@/lib/reports/build-protocol-report";
import { processProtocolReport } from "@/lib/reports/deliver-protocol-report";
import { readProtocolEvidence } from "@/lib/reports/read-protocol-evidence";
import {
  renderProtocolReportMarkdown,
  renderProtocolShortReportMarkdown,
} from "@/lib/reports/render-protocol-report-markdown";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  let requestId = "";
  let json = false;
  let short = false;
  let persist = false;
  let out: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--request-id") {
      requestId = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--short") {
      short = true;
    } else if (arg === "--persist") {
      persist = true;
    } else if (arg === "--out") {
      out = argv[i + 1];
      i += 1;
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }

  if (!UUID.test(requestId)) {
    fail("--request-id must be a valid UUID.");
  }

  return { requestId, json, short, persist, out };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    fail(
      "Supabase service-role configuration is required. Run with DOTENV_CONFIG_PATH=.env.local if your credentials live there."
    );
  }

  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const evidence = await readProtocolEvidence(client, args.requestId);
  const payload = buildProtocolReport(evidence);

  if (args.persist) {
    // Delegates to the same orchestrator the delivery worker uses, with
    // sending forced off. Two persist paths would eventually disagree about
    // the integrity gate, and this one exists for inspection, not delivery.
    const result = await processProtocolReport(args.requestId, {
      client,
      autoSendEnabled: false,
      deliveryConfig: { apiKey: "", from: "", appBaseUrl: "" },
    });

    if (!result.artifactId) {
      fail(result.detail ?? `Persist refused (${result.outcome}).`);
    }

    console.log(
      JSON.stringify(
        {
          status: result.outcome,
          artifactId: result.artifactId,
          integrityStatus: result.integrityStatus,
          integrityReasons: result.integrityReasons,
          reportPath:
            result.integrityStatus === "blocked"
              ? null
              : `/report/${result.publicToken}`,
        },
        null,
        2
      )
    );
    return;
  }

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const markdown = args.short
    ? renderProtocolShortReportMarkdown(payload)
    : renderProtocolReportMarkdown(payload);

  if (args.out) {
    const outPath = resolve(args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, markdown, "utf-8");
    console.log(`Wrote ${outPath} (${markdown.length} bytes)`);
    return;
  }

  console.log(markdown);
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
