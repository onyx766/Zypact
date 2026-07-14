/**
 * Sprint 3 smoke test — Probe Analysis Agent.
 *
 * Usage:
 *   npm run test:probe
 *     → full pipeline: fresh scan of linear.app + generate prompts + analyze a
 *       synthetic AI answer that mentions competitors but not the client.
 *   npm run test:probe -- <projectId>
 *     → uses an existing project (must already have generated prompts).
 *
 * Works in mock mode when no LLM key is set.
 */

import "dotenv/config";
import { runMirrorScan } from "../lib/pipeline/run-mirror-scan";
import { generateBuyerPrompts } from "../lib/pipeline/generate-buyer-prompts";
import { analyzeProbeResponse } from "../lib/pipeline/analyze-probe-response";
import { getDb } from "../lib/db";
import type { GeneratedPrompt } from "../lib/db/types";
import type {
  CompetitorMention,
  SourceCitation,
} from "../lib/schemas/probe-analysis.schema";

async function ensureProjectWithPrompts(): Promise<{
  projectId: string;
  selected: GeneratedPrompt;
}> {
  const args = process.argv.slice(2);
  const db = getDb();

  if (args[0]) {
    const projectId = args[0];
    const project = await db.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    const prompts = await db.getGeneratedPrompts(projectId);
    const selected = prompts.find((p) => p.selected);
    if (!selected) {
      throw new Error(
        `Project ${projectId} has no selected buyer prompts. Run test:prompts first.`
      );
    }
    return { projectId, selected };
  }

  const websiteUrl = "https://linear.app";
  console.log(`▸ Running Mirror Scan on ${websiteUrl}…`);
  const scan = await runMirrorScan({ websiteUrl });
  if (!scan.ok) throw new Error(`Mirror Scan failed: ${scan.error}`);
  console.log(`▸ Generating buyer prompts for ${scan.project.id}…`);
  const prompts = await generateBuyerPrompts({ projectId: scan.project.id });
  if (!prompts.ok) throw new Error(`Prompt generation failed: ${prompts.error}`);
  const selected = prompts.stored.find((p) => p.selected);
  if (!selected) throw new Error("No prompts were marked selected");
  return { projectId: scan.project.id, selected };
}

function synthesizeCompetitorAnswer(
  competitors: string[]
): string {
  const list = competitors.length > 0 ? competitors : ["Jira", "Asana", "Trello"];
  const top = list.slice(0, 3);
  return [
    `For teams looking for a modern project management tool, most reviewers recommend ${top[0]} first, followed by ${top[1] ?? "Notion"} and ${top[2] ?? "Asana"}.`,
    `According to G2 and Capterra, ${top[0]} leads on velocity while ${top[1] ?? "Notion"} is preferred for documentation.`,
    `See https://www.g2.com/categories/project-management for more.`,
  ].join(" ");
}

async function main() {
  const { projectId, selected } = await ensureProjectWithPrompts();
  const db = getDb();
  const mirrorRow = await db.getMirrorProfile(projectId);
  const competitors =
    (mirrorRow?.json &&
      typeof mirrorRow.json === "object" &&
      (mirrorRow.json as Record<string, unknown>).competitorsMentioned) ||
    [];
  const compArr: string[] = Array.isArray(competitors) ? (competitors as string[]) : [];

  const rawResponse = synthesizeCompetitorAnswer(compArr);
  console.log(`\n▸ Analyzing a synthetic answer for prompt: "${selected.prompt}"\n`);
  console.log(`──── AI answer (synthetic) ────`);
  console.log(rawResponse);
  console.log(`──────────────────────────────\n`);

  const result = await analyzeProbeResponse({
    projectId,
    generatedPromptId: selected.id,
    prompt: selected.prompt,
    platform: "perplexity",
    rawResponse,
    knownCompetitors: compArr.length > 0 ? undefined : ["Jira", "Asana", "Trello", "Notion"],
  });

  if (!result.ok) {
    console.error(`\n✗ analyzeProbeResponse failed: ${result.error}`);
    process.exit(1);
  }

  const { output, usedMock, usedRetry } = result;

  console.log("─────────────────────────────────────────────");
  console.log("Prompt:              ", selected.prompt);
  console.log("Verdict:             ", output.verdict);
  console.log("Client mentioned:    ", output.clientMentioned);
  console.log("Client position:     ", output.clientPosition);
  console.log("Competitors mentioned:");
  const cms = output.competitorsMentioned as CompetitorMention[];
  if (cms.length === 0) {
    console.log("  (none)");
  } else {
    for (const c of cms) console.log(`  ${c.position}. ${c.name}  — "${c.context}"`);
  }
  console.log("Sources cited:");
  const scs = output.sourcesCited as SourceCitation[];
  if (scs.length === 0) console.log("  (none)");
  else for (const s of scs) console.log(`  [${s.type}] ${s.source}`);
  console.log("Answer summary:      ", output.answerSummary);
  console.log("Why client lost:     ", output.whyClientLost);
  console.log("─────────────────────────────────────────────");
  console.log(
    `Mode: ${usedMock ? "MOCK" : "LIVE LLM"}${usedRetry ? " (retry used)" : ""}`
  );
  console.log(`Project ID:   ${projectId}`);
  console.log(`ProbeRun ID:  ${result.probeRunId}`);
  console.log(`Result ID:    ${result.result.id}`);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
