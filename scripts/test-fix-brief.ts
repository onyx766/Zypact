/**
 * Sprint 7 smoke test — Fix Brief Agent (`fix_brief` mode only).
 *
 * Usage:
 *   npm run test:fix-brief
 *     → full path: Mirror Scan → prompts → probes → competitors → gap map
 *       → evidence bank (prefilled) → generate Fix Brief for the highest
 *       severity gap.
 *   npm run test:fix-brief -- <projectId>
 *     → uses an existing project that already has all prerequisites.
 *
 * Works entirely in mock mode when no LLM key is configured.
 */

import "dotenv/config";
import { runMirrorScan } from "../lib/pipeline/run-mirror-scan";
import { generateBuyerPrompts } from "../lib/pipeline/generate-buyer-prompts";
import { analyzeProbeResponse } from "../lib/pipeline/analyze-probe-response";
import { discoverCompetitors } from "../lib/pipeline/discover-competitors";
import { generateGapMap } from "../lib/pipeline/generate-gap-map";
import { getOrCreateEvidenceBank } from "../lib/pipeline/get-or-create-evidence-bank";
import {
  EVIDENCE_BANK_REQUIRED_MESSAGE,
  NO_LOST_PROBE_MESSAGE,
  generateFixBrief,
} from "../lib/pipeline/generate-fix-brief";
import { getDb } from "../lib/db";
import type { GeneratedPrompt } from "../lib/db/types";
import type { Platform } from "../lib/schemas/probe-analysis.schema";
import { FixBriefOutputSchema } from "../lib/schemas/fix-brief.schema";

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

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("✗", msg);
    process.exit(1);
  } else {
    console.log("✓", msg);
  }
}

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
      datasetId: "test-fixture-dataset-fix-brief",
      datasetSourceType: "manual_scan",
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

  console.log("▸ Generating Gap Map…");
  const gm = await generateGapMap({ projectId: scan.project.id });
  if (!gm.ok) throw new Error(`generateGapMap failed: ${gm.error}`);

  console.log("▸ Creating Evidence Bank (prefill)…");
  const eb = await getOrCreateEvidenceBank(scan.project.id);
  if (!eb.ok) throw new Error(`Evidence Bank creation failed: ${eb.error}`);
  return scan.project.id;
}

function severityRank(s: string): number {
  return s === "high" ? 0 : s === "medium" ? 1 : 2;
}

async function main() {
  const projectId = await ensureProject();
  const db = getDb();

  // Sanity: gap map generated at least one gap.
  const allGaps = await db.getGapsByProject(projectId);
  assert(allGaps.length > 0, "at least one prioritized gap available");
  const targetGap = [...allGaps].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity)
  )[0]!;
  console.log("");
  console.log(
    `▸ Selected gap: [${targetGap.severity.toUpperCase()}] ${targetGap.type} — ${targetGap.explanation}`
  );

  // 1. Happy path — generate the Fix Brief.
  const result = await generateFixBrief({ projectId, gapId: targetGap.id });
  if (!result.ok) {
    console.error(`✗ generateFixBrief failed: ${result.error}`);
    process.exit(1);
  }
  const { fixBrief, output, usedMock, usedRetry } = result;
  assert(
    FixBriefOutputSchema.safeParse(output).success,
    "agent output re-validates against FixBriefOutputSchema"
  );
  assert(fixBrief.priority === output.priority, "row priority matches agent output");
  assert(
    fixBrief.lostPrompt === output.lostPrompt,
    "row lostPrompt matches agent output"
  );
  assert(
    fixBrief.assetsToGenerate.length >= 1,
    "assetsToGenerate has at least one entry"
  );
  assert(
    fixBrief.status === "needs_evidence" || fixBrief.status === "ready_for_assets",
    `status is derived (${fixBrief.status})`
  );
  assert(
    fixBrief.status === "needs_evidence"
      ? fixBrief.evidenceNeeded.length > 0
      : fixBrief.evidenceNeeded.length === 0,
    "status matches evidenceNeeded.length semantics"
  );
  assert(fixBrief.rootCause.length <= 1000, "rootCause within Zod ceiling");
  assert(
    !/guaranteed|will rank in ChatGPT|10x growth|#1 platform|best in the market|proven revenue growth|AI will recommend you/i.test(
      `${fixBrief.rootCause} | ${fixBrief.recommendedFix} | ${fixBrief.expectedImpact}`
    ),
    "no banned guarantee language in stored fields"
  );

  console.log("");
  console.log("Fix Brief");
  console.log("─────────────────────────────────────────────");
  console.log(`lostPrompt            : ${fixBrief.lostPrompt}`);
  console.log(`competitorRecommended : ${fixBrief.competitorRecommended}`);
  console.log(`fixType               : ${fixBrief.fixType}`);
  console.log(`priority              : ${fixBrief.priority}`);
  console.log(`status                : ${fixBrief.status}`);
  console.log(
    `evidenceNeeded (${fixBrief.evidenceNeeded.length}):`
  );
  for (const e of fixBrief.evidenceNeeded) console.log(`  · ${e}`);
  console.log(
    `evidenceAvailable (${fixBrief.evidenceAvailable.length}):`
  );
  for (const e of fixBrief.evidenceAvailable) console.log(`  · ${e}`);
  console.log(`expectedImpact        : ${fixBrief.expectedImpact}`);
  console.log(`rootCause             : ${fixBrief.rootCause}`);
  console.log(`recommendedFix        : ${fixBrief.recommendedFix}`);
  console.log(
    `assetsToGenerate      : ${fixBrief.assetsToGenerate.join(", ")}`
  );
  console.log("─────────────────────────────────────────────");
  console.log(
    `Mode: ${usedMock ? "MOCK" : "LIVE LLM"}${usedRetry ? " (retry used)" : ""}`
  );
  console.log(`Project ID:   ${projectId}`);
  console.log(`Fix Brief ID: ${fixBrief.id}`);

  // 2. Round-trip: getFixBrief(id) returns the same row.
  const reloaded = await db.getFixBrief(fixBrief.id);
  if (!reloaded) throw new Error("getFixBrief returned null");
  assert(reloaded.id === fixBrief.id, "getFixBrief round-trip returns same id");
  assert(
    reloaded.lostPrompt === fixBrief.lostPrompt &&
      reloaded.status === fixBrief.status &&
      reloaded.assetsToGenerate.length === fixBrief.assetsToGenerate.length,
    "reload matches saved row"
  );

  // 3. Guard messages: the exact strings are exported.
  assert(
    EVIDENCE_BANK_REQUIRED_MESSAGE.length > 0,
    "EVIDENCE_BANK_REQUIRED_MESSAGE is exported"
  );
  assert(
    NO_LOST_PROBE_MESSAGE.length > 0,
    "NO_LOST_PROBE_MESSAGE is exported"
  );

  console.log("");
  console.log("Sprint 7 smoke test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
