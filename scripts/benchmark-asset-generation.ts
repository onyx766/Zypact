#!/usr/bin/env tsx
/**
 * Sprint 13B — controlled asset-generation benchmark.
 *
 * This script changes only the generated assets. It leaves the Gap Map,
 * Fix Briefs, Evidence Bank, QA rules, and deterministic QA guards intact.
 * Use it to compare gpt-4o-mini vs a stronger asset-generation model on the
 * exact same project + Fix Brief inputs.
 *
 * Usage:
 *   npm run benchmark:assets <projectId> [fixBriefId] [assetTypesCsv]
 *
 * Env:
 *   ASSET_GENERATION_MODEL=<model-name>  # optional, generation only
 *   OPENAI_MODEL=<baseline-model>        # still used by all other agents
 */

import { generateAsset } from "@/lib/pipeline/generate-asset";
import { runQa } from "@/lib/pipeline/run-qa";
import { getDb } from "@/lib/db";
import {
  AssetTypeSchema,
  type AssetTypeValue,
} from "@/lib/schemas/generated-asset.schema";
import type { FixBriefRow } from "@/lib/db/types";

const DEFAULT_ASSET_TYPES: AssetTypeValue[] = [
  "proof_block",
  "faq_block",
  "json_ld_schema",
];

function usage(): never {
  console.error(
    "Usage: npm run benchmark:assets <projectId> [fixBriefId] [assetTypesCsv]",
  );
  process.exit(1);
}

function parseAssetTypes(raw?: string): AssetTypeValue[] {
  if (!raw || raw.trim().length === 0) return DEFAULT_ASSET_TYPES;
  const out: AssetTypeValue[] = [];
  for (const part of raw.split(",")) {
    const parsed = AssetTypeSchema.safeParse(part.trim());
    if (!parsed.success) {
      throw new Error(
        `Invalid asset type "${part}". Expected one of: ${AssetTypeSchema.options.join(", ")}`,
      );
    }
    out.push(parsed.data);
  }
  return [...new Set(out)];
}

function chooseFixBrief(
  fixBriefs: FixBriefRow[],
  requestedId?: string,
): FixBriefRow {
  if (requestedId && requestedId.trim().length > 0) {
    const found = fixBriefs.find((f) => f.id === requestedId.trim());
    if (!found) throw new Error(`Fix Brief not found: ${requestedId}`);
    return found;
  }

  const consolidation = fixBriefs.find((f) =>
    f.lostPrompt.toLowerCase().includes("live scorecard consolidation"),
  );
  if (consolidation) return consolidation;

  const newest = [...fixBriefs].sort(
    (a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )[0];
  if (!newest) throw new Error("No Fix Brief found for this project.");
  return newest;
}

function statusEmoji(status: string): string {
  if (status === "safe_to_publish") return "✅";
  if (status === "needs_evidence") return "🟡";
  if (status === "unsupported_claims") return "❌";
  if (status === "qa_failed") return "🚫";
  return "…";
}

async function main(): Promise<void> {
  const projectId = process.argv[2]?.trim();
  if (!projectId) usage();

  const requestedFixBriefId = process.argv[3]?.trim();
  const assetTypes = parseAssetTypes(process.argv[4]);
  const db = getDb();

  const project = await db.getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const fixBriefs = await db.getFixBriefsByProject(projectId);
  const fixBrief = chooseFixBrief(fixBriefs, requestedFixBriefId);
  const model =
    process.env.ASSET_GENERATION_MODEL?.trim() ||
    process.env.OPENAI_MODEL?.trim() ||
    process.env.ANTHROPIC_MODEL?.trim() ||
    "provider default";

  console.log("Sprint 13B asset-generation benchmark");
  console.log(`project: ${project.companyName} (${project.domain})`);
  console.log(`projectId: ${projectId}`);
  console.log(`fixBriefId: ${fixBrief.id}`);
  console.log(`fixType: ${fixBrief.fixType}`);
  console.log(`assetGenerationModel: ${model}`);
  console.log(`assetTypes: ${assetTypes.join(", ")}`);
  console.log("QA is unchanged; this script generates fresh assets then runs QA.\n");

  const rows: Array<{
    assetType: AssetTypeValue;
    assetId: string;
    generation: string;
    qaStatus: string;
    verdict: string;
    violations: number;
    placeholders: number;
  }> = [];

  for (const assetType of assetTypes) {
    console.log(`Generating ${assetType}...`);
    const generated = await generateAsset({
      projectId,
      fixBriefId: fixBrief.id,
      assetType,
    });
    if (!generated.ok) {
      console.log(`  generation failed: ${generated.error}`);
      rows.push({
        assetType,
        assetId: "generation_failed",
        generation: model,
        qaStatus: "qa_failed",
        verdict: "generation_failed",
        violations: 0,
        placeholders: 0,
      });
      continue;
    }

    const qa = await runQa({ projectId, assetId: generated.asset.id });
    if (!qa.ok) {
      console.log(`  QA failed: ${qa.error}`);
      rows.push({
        assetType,
        assetId: generated.asset.id,
        generation: `${generated.asset.generationProvider ?? "unknown"}/${generated.asset.generationModel ?? "unknown"}`,
        qaStatus: "qa_failed",
        verdict: "qa_failed",
        violations: 0,
        placeholders: generated.output.placeholders.length,
      });
      continue;
    }

    rows.push({
      assetType,
      assetId: generated.asset.id,
      generation: `${qa.updatedAsset.generationProvider ?? "unknown"}/${qa.updatedAsset.generationModel ?? "unknown"}`,
      qaStatus: qa.updatedAsset.qaStatus,
      verdict: qa.qaReport.verdict,
      violations: qa.qaReport.violations.length,
      placeholders: qa.qaReport.placeholdersRemaining.length,
    });
    console.log(
      `  ${statusEmoji(qa.updatedAsset.qaStatus)} ${qa.updatedAsset.qaStatus} · ` +
        `${qa.qaReport.violations.length} violation(s) · ` +
        `${qa.qaReport.placeholdersRemaining.length} placeholder(s)`,
    );
  }

  console.log("\nBenchmark summary");
  console.table(
    rows.map((r) => ({
      assetType: r.assetType,
      generation: r.generation,
      qaStatus: r.qaStatus,
      violations: r.violations,
      placeholders: r.placeholders,
      assetId: r.assetId,
    })),
  );

  const byGeneration = rows.reduce<Record<string, { assets: number; violations: number; safe: number; needs: number; unsupported: number }>>((acc, r) => {
    const row = acc[r.generation] ?? { assets: 0, violations: 0, safe: 0, needs: 0, unsupported: 0 };
    row.assets += 1;
    row.violations += r.violations;
    if (r.qaStatus === "safe_to_publish") row.safe += 1;
    if (r.qaStatus === "needs_evidence") row.needs += 1;
    if (r.qaStatus === "unsupported_claims") row.unsupported += 1;
    acc[r.generation] = row;
    return acc;
  }, {});

  console.log("\nMetric by generation model");
  console.table(
    Object.entries(byGeneration).map(([generation, row]) => ({
      generation,
      assets: row.assets,
      safe: row.safe,
      needsEvidence: row.needs,
      unsupportedClaims: row.unsupported,
      totalViolations: row.violations,
      avgViolations: row.assets > 0 ? (row.violations / row.assets).toFixed(1) : "0.0",
    })),
  );

  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.qaStatus] = (acc[r.qaStatus] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`statusCounts: ${JSON.stringify(counts)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
