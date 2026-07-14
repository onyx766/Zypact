#!/usr/bin/env tsx
/**
 * Sprint 12.1 — re-run QA for one generated asset.
 *
 * Usage:
 *   python3 scripts/run-with-env.py npx tsx scripts/rerun-qa-asset.ts <projectId> <assetId>
 *
 * No secrets are printed. The script reports only ids, verdict/status,
 * retry/mock flags, and counts.
 */

import "dotenv/config";
import { runQa } from "@/lib/pipeline/run-qa";
import { getDb } from "@/lib/db";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const [projectId, assetId] = process.argv.slice(2);
  if (!projectId || !assetId) {
    fail("Usage: tsx scripts/rerun-qa-asset.ts <projectId> <assetId>");
  }

  const result = await runQa({ projectId, assetId });
  if (!result.ok) {
    const db = getDb();
    const asset = await db.getGeneratedAsset(assetId);
    console.log("QA re-run failed safely.");
    console.log(`projectId : ${projectId}`);
    console.log(`assetId   : ${assetId}`);
    console.log(`qaStatus  : ${asset?.qaStatus ?? "<asset not found>"}`);
    console.log(`error     : ${result.error.slice(0, 500)}`);
    process.exit(1);
  }

  console.log("QA re-run completed.");
  console.log(`projectId      : ${projectId}`);
  console.log(`assetId        : ${assetId}`);
  console.log(`verdict        : ${result.output.verdict}`);
  console.log(`qaStatus       : ${result.updatedAsset.qaStatus}`);
  console.log(`violations     : ${result.output.violations.length}`);
  console.log(`placeholders   : ${result.output.placeholdersRemaining.length}`);
  console.log(`usedRetry      : ${result.usedRetry ? "yes" : "no"}`);
  console.log(`usedMock       : ${result.usedMock ? "yes" : "no"}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
