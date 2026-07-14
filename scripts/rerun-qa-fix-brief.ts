#!/usr/bin/env tsx
/** Rerun QA for all generated assets attached to one Fix Brief. */

import { getDb } from "@/lib/db";
import { runQa } from "@/lib/pipeline/run-qa";

function usage(): never {
  console.error("Usage: npm run rerun:qa-fix-brief <projectId> <fixBriefId>");
  process.exit(1);
}

async function main(): Promise<void> {
  const projectId = process.argv[2]?.trim();
  const fixBriefId = process.argv[3]?.trim();
  if (!projectId || !fixBriefId) usage();

  const db = getDb();
  const fixBrief = await db.getFixBrief(fixBriefId);
  if (!fixBrief || fixBrief.projectId !== projectId) {
    throw new Error(`Fix Brief not found on project: ${fixBriefId}`);
  }
  const assets = await db.getGeneratedAssetsByFixBrief(fixBriefId);
  console.log(`Rerunning QA for ${assets.length} asset(s) on Fix Brief ${fixBriefId}`);

  const rows: Array<{ assetType: string; assetId: string; qaStatus: string; violations: number; placeholders: number }> = [];
  for (const asset of assets) {
    const qa = await runQa({ projectId, assetId: asset.id });
    if (!qa.ok) {
      rows.push({ assetType: asset.assetType, assetId: asset.id, qaStatus: "qa_failed", violations: 0, placeholders: asset.placeholders.length });
      console.log(`- ${asset.assetType} ${asset.id}: QA failed — ${qa.error}`);
      continue;
    }
    rows.push({
      assetType: asset.assetType,
      assetId: asset.id,
      qaStatus: qa.updatedAsset.qaStatus,
      violations: qa.qaReport.violations.length,
      placeholders: qa.qaReport.placeholdersRemaining.length,
    });
    console.log(`- ${asset.assetType} ${asset.id}: ${qa.updatedAsset.qaStatus} · ${qa.qaReport.violations.length} violation(s) · ${qa.qaReport.placeholdersRemaining.length} placeholder(s)`);
  }
  console.table(rows);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
