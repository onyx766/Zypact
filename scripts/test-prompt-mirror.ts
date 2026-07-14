/**
 * Sprint 2 smoke test — Prompt Mirror Agent.
 *
 * Usage:
 *   npm run test:prompts
 *     → runs the full Mirror Scan + Prompt Mirror pipeline on a sample URL
 *   npm run test:prompts -- <projectId>
 *     → uses an existing project's Mirror Profile
 *   npm run test:prompts -- --url https://linear.app
 *     → forces a fresh scan on the given URL
 *
 * Works in mock mode when no LLM key is set.
 */

import "dotenv/config";
import { runMirrorScan } from "../lib/pipeline/run-mirror-scan";
import { generateBuyerPrompts } from "../lib/pipeline/generate-buyer-prompts";
import { getDb } from "../lib/db";
import type { IntentType } from "../lib/schemas/prompt-mirror.schema";

async function ensureProject(): Promise<{ projectId: string; description: string }> {
  const args = process.argv.slice(2);
  const urlIdx = args.indexOf("--url");
  if (urlIdx !== -1 && args[urlIdx + 1]) {
    const url = args[urlIdx + 1];
    const websiteUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    console.log(`▸ Running Mirror Scan on ${websiteUrl} first…`);
    const scan = await runMirrorScan({ websiteUrl });
    if (!scan.ok) throw new Error(`Mirror Scan failed: ${scan.error}`);
    return { projectId: scan.project.id, description: `fresh scan of ${websiteUrl}` };
  }
  if (args[0] && !args[0].startsWith("--")) {
    const projectId = args[0];
    const existing = await getDb().getProject(projectId);
    if (!existing) throw new Error(`Project ${projectId} not found`);
    return { projectId, description: `existing project ${projectId}` };
  }
  const websiteUrl = "https://linear.app";
  console.log(`▸ No projectId or --url given. Running Mirror Scan on ${websiteUrl}…`);
  const scan = await runMirrorScan({ websiteUrl });
  if (!scan.ok) throw new Error(`Mirror Scan failed: ${scan.error}`);
  return { projectId: scan.project.id, description: `fresh scan of ${websiteUrl}` };
}

async function main() {
  const { projectId, description } = await ensureProject();
  console.log(`\n▸ Generating buyer prompts for ${description} (projectId=${projectId})\n`);

  const result = await generateBuyerPrompts({ projectId });
  if (!result.ok) {
    console.error(`\n✗ generateBuyerPrompts failed: ${result.error}`);
    process.exit(1);
  }

  const { output, stored, usedMock, usedRetry } = result;

  console.log("─────────────────────────────────────────────");
  console.log("Total prompts:      ", output.prompts.length);
  console.log("Stored rows:        ", stored.length);
  console.log("Recommended for AI: ", output.recommendedForProbe.length);
  console.log("");

  console.log("Top 10 by priority:");
  const top = [...output.prompts]
    .sort((a, b) => b.priority - a.priority || a.id - b.id)
    .slice(0, 10);
  for (const p of top) {
    const sel = output.recommendedForProbe.includes(p.id) ? "★" : " ";
    console.log(
      `  ${sel} [${String(p.priority).padStart(2, " ")}] (${p.intentType}) ${p.prompt}`
    );
  }
  console.log("");

  const dist: Record<IntentType, number> = {
    best_tools: 0,
    alternatives: 0,
    comparison: 0,
    use_case: 0,
    problem_aware: 0,
    industry_specific: 0,
    pricing_value: 0,
    migration: 0,
    buyer_role: 0,
  };
  for (const p of output.prompts) dist[p.intentType] += 1;
  console.log("Intent type distribution:");
  for (const [k, v] of Object.entries(dist)) {
    console.log(`  · ${k.padEnd(20, " ")} ${v}`);
  }
  console.log("─────────────────────────────────────────────");
  console.log(
    `Mode: ${usedMock ? "MOCK" : "LIVE LLM"}${usedRetry ? " (retry used)" : ""}`
  );
  console.log(`Project ID: ${projectId}`);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
