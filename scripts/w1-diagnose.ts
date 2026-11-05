#!/usr/bin/env tsx
/**
 * Run the W1 Website Buyer-Readiness Diagnostic against one public site and
 * print the report.
 *
 *   npm run w1:diagnose -- example.com            # Markdown to stdout
 *   npm run w1:diagnose -- example.com --json     # canonical JSON
 *   npm run w1:diagnose -- example.com --out report.md
 *
 * Makes live HTTP requests to that site only (at most 10 pages plus
 * robots.txt, sitemap.xml and llms.txt, under W1_FETCH_POLICY, respecting
 * robots.txt). No model, paid or third-party call; no database; no
 * environment variables needed. Nothing is stored unless --out is given.
 * Only use it on sites you are entitled to examine.
 */
import { writeFileSync } from "node:fs";

import { REFUSAL_TEXT, runSiteDiagnostic } from "@/lib/site-diagnostic/engine";
import { exportReportJson, exportReportMarkdown } from "@/lib/site-diagnostic/export";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const url = args.find((arg) => !arg.startsWith("--"));
  if (!url) {
    console.error("usage: npm run w1:diagnose -- <url> [--json] [--out <file>]");
    process.exit(2);
  }
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? args[outIndex + 1] : null;

  const result = await runSiteDiagnostic(url);
  if (!result.ok) {
    console.error(`refused: ${result.refusal} — ${REFUSAL_TEXT[result.refusal]}`);
    process.exit(1);
  }
  const rendered = args.includes("--json") ? exportReportJson(result.report) : exportReportMarkdown(result.report);
  if (out) {
    writeFileSync(out, rendered);
    console.error(`wrote ${out} (report sha256 ${result.report.reportSha256})`);
  } else {
    process.stdout.write(rendered);
  }
}

main().catch((error) => {
  console.error(`w1:diagnose failed: ${error instanceof Error ? error.name : "unknown error"}`);
  process.exit(1);
});
