/**
 * Sprint 5 smoke test — Gap Map Agent.
 *
 * Usage:
 *   npm run test:gap-map
 *     → full pipeline: Mirror Scan → prompts → 3 synthetic probes →
 *       competitor discovery → gap map generation.
 *   npm run test:gap-map -- <projectId>
 *     → uses an existing project that already has Mirror Profile,
 *       ProbeResults, and Competitors.
 *
 * Works in mock mode when no LLM key is set.
 */

import "dotenv/config";
import { runMirrorScan } from "../lib/pipeline/run-mirror-scan";
import { generateBuyerPrompts } from "../lib/pipeline/generate-buyer-prompts";
import { analyzeProbeResponse } from "../lib/pipeline/analyze-probe-response";
import { discoverCompetitors } from "../lib/pipeline/discover-competitors";
import { generateGapMap } from "../lib/pipeline/generate-gap-map";
import { getDb } from "../lib/db";
import type { GeneratedPrompt } from "../lib/db/types";
import type { Platform } from "../lib/schemas/probe-analysis.schema";
import {
  GapMapOutputSchema,
  GAP_DIMENSIONS,
} from "../lib/schemas/gap-map.schema";

const SYNTHETIC_ANSWERS: Array<{ platform: Platform; text: string }> = [
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

async function ensureProject(): Promise<string> {
  const args = process.argv.slice(2);
  const db = getDb();

  if (args[0]) {
    const projectId = args[0];
    const project = await db.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    return projectId;
  }

  const websiteUrl = "https://linear.app";
  console.log(`▸ Running Mirror Scan on ${websiteUrl}…`);
  const scan = await runMirrorScan({ websiteUrl });
  if (!scan.ok) throw new Error(`Mirror Scan failed: ${scan.error}`);

  console.log(`▸ Generating buyer prompts for ${scan.project.id}…`);
  const gen = await generateBuyerPrompts({ projectId: scan.project.id });
  if (!gen.ok) throw new Error(`Prompt generation failed: ${gen.error}`);

  const selected = gen.stored.filter((p: GeneratedPrompt) => p.selected);
  const targets = selected
    .sort((a, b) => b.priority - a.priority)
    .slice(0, Math.min(3, selected.length));

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const answer = SYNTHETIC_ANSWERS[i % SYNTHETIC_ANSWERS.length];
    console.log(`▸ Probing "${target.prompt}" on ${answer.platform}…`);
    const r = await analyzeProbeResponse({
      projectId: scan.project.id,
      generatedPromptId: target.id,
      prompt: target.prompt,
      platform: answer.platform,
      rawResponse: answer.text,
      knownCompetitors: [
        "Jira",
        "Asana",
        "Trello",
        "Notion",
        "Monday.com",
        "ClickUp",
      ],
    });
    if (!r.ok) throw new Error(`analyzeProbeResponse failed: ${r.error}`);
  }

  console.log("▸ Discovering competitors…");
  const disc = await discoverCompetitors({
    projectId: scan.project.id,
    userCompetitors: ["Jira", "Airtable"],
  });
  if (!disc.ok) throw new Error(`discoverCompetitors failed: ${disc.error}`);
  return scan.project.id;
}

async function main() {
  const projectId = await ensureProject();

  console.log("\n▸ Generating Gap Map…\n");
  const result = await generateGapMap({ projectId });
  if (!result.ok) {
    console.error(`✗ generateGapMap failed: ${result.error}`);
    process.exit(1);
  }

  const { output, gapMap, gaps, usedMock, usedRetry, normalizedDistances } =
    result;

  // Post-condition: the stored JSON must re-validate with Zod.
  const revalidated = GapMapOutputSchema.safeParse(gapMap.json);
  if (!revalidated.success) {
    console.error("✗ Stored GapMap failed revalidation:", revalidated.error.message);
    process.exit(1);
  }

  // Post-condition: recommendationDistance = sum of six sub-scores for every row.
  for (const d of output.competitorDistances) {
    const sum =
      d.gapScores.prompt_loss +
      d.gapScores.citation +
      d.gapScores.review +
      d.gapScores.comparison_content +
      d.gapScores.proof +
      d.gapScores.entity_clarity;
    if (sum !== d.recommendationDistance) {
      console.error(
        `✗ Distance mismatch for ${d.competitor}: stored=${d.recommendationDistance}, sum=${sum}`
      );
      process.exit(1);
    }
  }

  console.log("─────────────────────────────────────────────");
  console.log("Competitor distances:");
  for (const d of output.competitorDistances) {
    const bars = GAP_DIMENSIONS.map(
      (dim) => `${dim}=${String(d.gapScores[dim]).padStart(2, " ")}`
    ).join("  ");
    console.log(
      `  · ${d.competitor.padEnd(18, " ")} distance=${String(d.recommendationDistance).padStart(2, " ")}/60  ${bars}  evidence=${d.evidenceStrength}`
    );
  }
  console.log("");
  console.log("Top 5 prioritized gaps:");
  if (gaps.length === 0) console.log("  (none)");
  for (const g of gaps.slice(0, 5)) {
    console.log(
      `  · [${g.severity.toUpperCase()}] ${g.type} — ${g.explanation}`
    );
  }
  console.log("");
  console.log(
    `Graph: ${output.nodes.length + 1} nodes (incl. client) · ${output.edges.length} edges`
  );
  console.log("─────────────────────────────────────────────");
  console.log(
    `Mode: ${usedMock ? "MOCK" : "LIVE LLM"}${usedRetry ? " (retry used)" : ""}${normalizedDistances ? " · distances normalized" : ""}`
  );
  console.log(`Project ID: ${projectId}`);
  console.log(`Gap Map ID: ${gapMap.id}`);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
