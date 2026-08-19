/**
 * Sprint 4 smoke test — Competitor Discovery Agent.
 *
 * Usage:
 *   npm run test:competitors
 *     → full pipeline: fresh scan of linear.app, generate prompts, run three
 *       synthetic probes (each grounded in a different mix of competitors),
 *       then discover competitors.
 *   npm run test:competitors -- <projectId>
 *     → uses an existing project (must already have at least one ProbeResult).
 *
 * Works in mock mode when no LLM key is set.
 */

import "dotenv/config";
import { runMirrorScan } from "../lib/pipeline/run-mirror-scan";
import { generateBuyerPrompts } from "../lib/pipeline/generate-buyer-prompts";
import { analyzeProbeResponse } from "../lib/pipeline/analyze-probe-response";
import { discoverCompetitors } from "../lib/pipeline/discover-competitors";
import { getDb } from "../lib/db";
import type { GeneratedPrompt } from "../lib/db/types";
import type { Platform } from "../lib/schemas/probe-analysis.schema";

const SYNTHETIC_ANSWERS: Array<{ prompt?: string; platform: Platform; text: string }> = [
  {
    platform: "perplexity",
    text:
      "Jira leads the market for most engineering teams; Asana and Trello are common lighter alternatives. According to G2, Jira is the top-ranked pick.",
  },
  {
    platform: "chatgpt",
    text:
      "For B2B teams, Asana is broadly recommended, followed by Notion and Monday.com. Reviewers on Capterra highlight Asana's ease of setup.",
  },
  {
    platform: "gemini",
    text:
      "Common picks include Jira, Notion, and ClickUp — each with different strengths. Jira is often described as the industry default.",
  },
];

async function ensureProject(): Promise<{
  projectId: string;
  selectedPrompts: GeneratedPrompt[];
}> {
  const args = process.argv.slice(2);
  const db = getDb();
  if (args[0]) {
    const projectId = args[0];
    const project = await db.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    const prompts = await db.getGeneratedPrompts(projectId);
    return { projectId, selectedPrompts: prompts.filter((p) => p.selected) };
  }
  const websiteUrl = "https://linear.app";
  console.log(`▸ Running Mirror Scan on ${websiteUrl}…`);
  const scan = await runMirrorScan({ websiteUrl });
  if (!scan.ok) throw new Error(`Mirror Scan failed: ${scan.error}`);
  console.log(`▸ Generating buyer prompts for ${scan.project.id}…`);
  const gen = await generateBuyerPrompts({ projectId: scan.project.id });
  if (!gen.ok) throw new Error(`Prompt generation failed: ${gen.error}`);
  return {
    projectId: scan.project.id,
    selectedPrompts: gen.stored.filter((p) => p.selected),
  };
}

async function main() {
  const { projectId, selectedPrompts } = await ensureProject();
  const db = getDb();

  // Ensure we have at least a handful of probe results to work with.
  const existing = await db.getProbeResultsByProject(projectId);
  if (existing.length === 0) {
    if (selectedPrompts.length === 0)
      throw new Error("No selected prompts to probe.");
    const targets = selectedPrompts
      .sort((a, b) => b.priority - a.priority)
      .slice(0, Math.min(3, selectedPrompts.length));
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const answer = SYNTHETIC_ANSWERS[i % SYNTHETIC_ANSWERS.length];
      console.log(
        `▸ Probing "${target.prompt}" on ${answer.platform}…`
      );
      const r = await analyzeProbeResponse({
        projectId,
        generatedPromptId: target.id,
        prompt: target.prompt,
        platform: answer.platform,
        rawResponse: answer.text,
        knownCompetitors: ["Jira", "Asana", "Trello", "Notion", "Monday.com", "ClickUp"],
        datasetId: "test-fixture-dataset-competitor-discovery",
        datasetSourceType: "manual_scan",
      });
      if (!r.ok) throw new Error(`analyzeProbeResponse failed: ${r.error}`);
    }
  }

  console.log("\n▸ Discovering competitors…\n");
  const result = await discoverCompetitors({
    projectId,
    userCompetitors: ["Jira", "Airtable", "Basecamp"],
  });

  if (!result.ok) {
    console.error(`✗ discoverCompetitors failed: ${result.error}`);
    process.exit(1);
  }

  const { stored, output, usedMock, usedRetry } = result;
  console.log("─────────────────────────────────────────────");
  console.log("Total competitors:  ", stored.length);
  const high = stored.filter((c) => c.threatLevel === "high");
  const medium = stored.filter((c) => c.threatLevel === "medium");
  const low = stored.filter((c) => c.threatLevel === "low");
  console.log(
    `Threat: ${high.length} high · ${medium.length} medium · ${low.length} low`
  );
  console.log("");
  console.log("High-threat competitors:");
  if (high.length === 0) console.log("  (none)");
  else
    for (const c of high)
      console.log(
        `  · ${c.name.padEnd(20, " ")} mentions=${c.mentionCount} source=${c.discoverySource}`
      );
  console.log("");
  console.log("Phantom competitors:", output.phantomCompetitors);
  console.log("Blind spots:        ", output.blindSpots);
  console.log("");
  console.log("Summary:", output.summary);
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
