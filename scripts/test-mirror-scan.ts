/**
 * Sprint 1 smoke test.
 *
 * Usage:
 *   npm run test:mirror -- https://linear.app
 *   npm run test:mirror -- https://linear.app "Linear"
 *
 * Runs the full pipeline end-to-end (crawl → Site Reader → store) and prints
 * the key fields. Works in mock mode when no LLM key is set.
 */

import "dotenv/config";
import { runMirrorScan } from "../lib/pipeline/run-mirror-scan";

async function main() {
  const [, , rawUrl, companyName] = process.argv;
  if (!rawUrl) {
    console.error("Usage: npm run test:mirror -- <websiteUrl> [companyName]");
    process.exit(1);
  }
  const websiteUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;

  console.log(`\n▸ Running Mirror Scan on ${websiteUrl}\n`);
  const result = await runMirrorScan({ websiteUrl, companyName });

  if (!result.ok) {
    console.error(`\n✗ Mirror Scan failed: ${result.error}`);
    process.exit(1);
  }

  console.log("─────────────────────────────────────────────");
  console.log("Pages crawled:      ", result.pages.length);
  for (const p of result.pages) {
    console.log(`  · [${p.pageType}] ${p.url}`);
  }
  console.log("");
  console.log("Detected category:  ", result.mirrorProfile.detectedCategory);
  console.log("Confidence:         ", result.mirrorProfile.categoryConfidence);
  console.log("Target audience:    ", result.mirrorProfile.targetAudience);
  console.log("Missing signals:");
  for (const m of result.mirrorProfile.missingSignals) {
    console.log(`  · ${m.signal} — ${m.whyItMatters}`);
  }
  console.log("Buyer intent angles:");
  for (const a of result.mirrorProfile.buyerIntentAngles) {
    console.log(`  · ${a}`);
  }
  console.log("─────────────────────────────────────────────");
  console.log(
    `Mode: ${result.usedMock ? "MOCK" : "LIVE LLM"}${
      result.usedRetry ? " (retry used)" : ""
    }`
  );
  console.log(`Project ID: ${result.project.id}`);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
