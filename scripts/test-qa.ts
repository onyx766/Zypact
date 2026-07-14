/**
 * Sprint 9 smoke test — QA Agent.
 *
 * Usage:
 *   npm run test:qa
 *     → full path: Mirror Scan → prompts → probes → competitors → gap map
 *       → evidence bank → fix brief → 1 generated asset → run QA (twice:
 *       once on a clean asset with placeholders, once on a synthetic bad
 *       asset).
 *   npm run test:qa -- <projectId>
 *     → uses an existing project that already has all prerequisites +
 *       at least one Fix Brief and at least one Generated Asset.
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
import { generateFixBrief } from "../lib/pipeline/generate-fix-brief";
import { generateAsset } from "../lib/pipeline/generate-asset";
import {
  EVIDENCE_BANK_REQUIRED_MESSAGE,
  ASSET_NOT_FOUND_MESSAGE,
  ASSET_NOT_IN_PROJECT_MESSAGE,
  runQa,
} from "../lib/pipeline/run-qa";
import { getDb } from "../lib/db";
import type { GeneratedAssetRow, GeneratedPrompt } from "../lib/db/types";
import type { Platform } from "../lib/schemas/probe-analysis.schema";
import { QaAgentOutputSchema } from "../lib/schemas/qa-agent.schema";

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

function severityRank(s: string): number {
  return s === "high" ? 0 : s === "medium" ? 1 : 2;
}

/**
 * Build a full project up to and including one Generated Asset, or reuse
 * the projectId passed on the CLI.
 */
async function ensureCleanAsset(): Promise<{
  projectId: string;
  cleanAsset: GeneratedAssetRow;
}> {
  const args = process.argv.slice(2);
  const db = getDb();

  if (args[0]) {
    const projectId = args[0];
    const project = await db.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    const existing = await db.getGeneratedAssetsByProject(projectId);
    if (existing.length === 0) {
      throw new Error(
        `Project ${projectId} has no generated assets — run test:assets first.`
      );
    }
    // Prefer an asset that still has placeholders so the QA verdict is
    // predictable ('needs_evidence'); if none, fall back to the newest.
    const withPh = existing.find((a) => a.placeholders.length > 0);
    return { projectId, cleanAsset: withPh ?? existing[0]! };
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

  console.log("▸ Generating Gap Map…");
  const gm = await generateGapMap({ projectId: scan.project.id });
  if (!gm.ok) throw new Error(`generateGapMap failed: ${gm.error}`);

  console.log("▸ Creating Evidence Bank (prefill)…");
  const eb = await getOrCreateEvidenceBank(scan.project.id);
  if (!eb.ok) throw new Error(`Evidence Bank creation failed: ${eb.error}`);

  const allGaps = await db.getGapsByProject(scan.project.id);
  if (allGaps.length === 0) throw new Error("No gaps produced");
  const topGap = [...allGaps].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity)
  )[0]!;
  console.log(`▸ Generating Fix Brief for gap ${topGap.type}…`);
  const fb = await generateFixBrief({
    projectId: scan.project.id,
    gapId: topGap.id,
  });
  if (!fb.ok) throw new Error(`generateFixBrief failed: ${fb.error}`);

  console.log("▸ Generating one clean asset (faq_block)…");
  const ga = await generateAsset({
    projectId: scan.project.id,
    fixBriefId: fb.fixBrief.id,
    assetType: "faq_block",
  });
  if (!ga.ok) throw new Error(`generateAsset failed: ${ga.error}`);

  return { projectId: scan.project.id, cleanAsset: ga.asset };
}

/**
 * Craft a Generated Asset that packs multiple canonical Sprint 9 red
 * flags into title/content/claimsUsed. We save it directly through the
 * adapter to bypass GeneratedAssetOutputSchema (which would reject
 * the banned phrases at input time — that's exactly the safety layer we
 * want the QA Agent to catch when phrases leak through some other path).
 */
async function insertSyntheticBadAsset(
  projectId: string,
  fixBriefId: string
): Promise<GeneratedAssetRow> {
  const db = getDb();
  return db.saveGeneratedAsset(projectId, {
    fixBriefId,
    assetType: "faq_block",
    title: "The #1 platform for AI visibility",
    content: [
      "# The #1 platform for AI visibility",
      "",
      "### Why choose us?",
      "We are the #1 platform in the market and AI will recommend you to every buyer.",
      "",
      "### What results should you expect?",
      "Customers report 10x growth in 90 days, guaranteed. 42% of teams see a 3x lift within 7 days.",
      "",
      "### How do we compare to competitors?",
      "Competitor tooling is outdated and slow. Nobody uses them anymore.",
    ].join("\n"),
    placeholders: [],
    claimsUsed: [
      {
        claim: "#1 platform trusted by thousands of Fortune 500 customers",
        source: "evidence_bank",
      },
    ],
    qaStatus: "pending_qa",
  });
}

async function main() {
  const { projectId, cleanAsset } = await ensureCleanAsset();
  const db = getDb();

  console.log("");
  console.log(`Project ID:      ${projectId}`);
  console.log(`Clean asset ID:  ${cleanAsset.id}`);
  console.log("");

  // ---------------- Case 1: clean asset -----------------------------------
  console.log("▸ Running QA on the clean generated asset…");
  const cleanRes = await runQa({ projectId, assetId: cleanAsset.id });
  if (!cleanRes.ok) {
    console.error(`✗ runQa (clean) failed: ${cleanRes.error}`);
    process.exit(1);
  }
  assert(
    QaAgentOutputSchema.safeParse(cleanRes.output).success,
    "clean asset: QA output re-validates against QaAgentOutputSchema"
  );
  assert(
    cleanRes.output.verdict === "needs_evidence" ||
      cleanRes.output.verdict === "safe_to_publish",
    `clean asset: verdict is needs_evidence or safe_to_publish (got ${cleanRes.output.verdict})`
  );
  if (cleanRes.output.verdict === "needs_evidence") {
    assert(
      cleanRes.output.placeholdersRemaining.length > 0,
      "clean asset with needs_evidence: at least one placeholder remains"
    );
  }
  assert(
    cleanRes.output.violations.every((v) => v.type !== "fabrication"),
    "clean asset: no fabrication violations"
  );
  assert(
    cleanRes.output.violations.every((v) => v.type !== "forbidden_claim"),
    "clean asset: no forbidden_claim violations"
  );
  assert(
    cleanRes.updatedAsset.qaStatus === cleanRes.output.verdict,
    `clean asset: GeneratedAsset.qaStatus updated to "${cleanRes.output.verdict}"`
  );
  const rehydratedClean = await db.getGeneratedAsset(cleanAsset.id);
  assert(
    rehydratedClean !== null &&
      rehydratedClean.qaStatus === cleanRes.output.verdict,
    "clean asset: qaStatus persisted in DB"
  );

  const cleanReports = await db.getQaReportsByGeneratedAsset(cleanAsset.id);
  assert(cleanReports.length >= 1, "clean asset: QaReport row was saved");
  const latestClean = await db.getLatestQaReportForAsset(cleanAsset.id);
  assert(
    latestClean !== null && latestClean.verdict === cleanRes.output.verdict,
    "clean asset: getLatestQaReportForAsset returns the latest report"
  );

  console.log(
    `  · verdict=${cleanRes.output.verdict} · violations=${cleanRes.output.violations.length} · placeholders=${cleanRes.output.placeholdersRemaining.length}`
  );

  // ---------------- Case 2: synthetic bad asset ---------------------------
  console.log("");
  console.log("▸ Inserting synthetic bad asset with forbidden claims…");
  const badAsset = await insertSyntheticBadAsset(
    projectId,
    cleanAsset.fixBriefId
  );
  console.log(`Bad asset ID:    ${badAsset.id}`);

  console.log("▸ Running QA on the synthetic bad asset…");
  const badRes = await runQa({ projectId, assetId: badAsset.id });
  if (!badRes.ok) {
    console.error(`✗ runQa (bad) failed: ${badRes.error}`);
    process.exit(1);
  }
  assert(
    QaAgentOutputSchema.safeParse(badRes.output).success,
    "bad asset: QA output re-validates against QaAgentOutputSchema"
  );
  assert(
    badRes.output.verdict === "unsupported_claims",
    `bad asset: verdict is unsupported_claims (got ${badRes.output.verdict})`
  );
  assert(
    badRes.output.violations.length >= 1,
    "bad asset: at least one violation"
  );
  const kinds = new Set(badRes.output.violations.map((v) => v.type));
  assert(
    kinds.has("forbidden_claim"),
    "bad asset: violations include forbidden_claim (e.g. #1 platform)"
  );
  assert(
    kinds.has("implied_result"),
    "bad asset: violations include implied_result (e.g. AI will recommend you)"
  );
  assert(
    badRes.output.violations.every((v) => v.quote.length > 0),
    "bad asset: every violation has a non-empty quote"
  );
  assert(
    badRes.output.violations.every((v) => v.suggestedFix.length > 0),
    "bad asset: every violation has a non-empty suggestedFix"
  );
  assert(
    badRes.updatedAsset.qaStatus === "unsupported_claims",
    "bad asset: GeneratedAsset.qaStatus updated to 'unsupported_claims'"
  );
  const rehydratedBad = await db.getGeneratedAsset(badAsset.id);
  assert(
    rehydratedBad !== null && rehydratedBad.qaStatus === "unsupported_claims",
    "bad asset: qaStatus persisted in DB"
  );
  const latestBad = await db.getLatestQaReportForAsset(badAsset.id);
  assert(
    latestBad !== null && latestBad.verdict === "unsupported_claims",
    "bad asset: getLatestQaReportForAsset returns the latest report"
  );

  // ---------------- Case 3: guard messages --------------------------------
  console.log("");
  console.log("▸ Verifying guard behavior…");
  const notFound = await runQa({
    projectId,
    assetId: "00000000-0000-0000-0000-000000000000",
  });
  assert(
    !notFound.ok && notFound.status === 404 && notFound.error === ASSET_NOT_FOUND_MESSAGE,
    "guard: 404 for unknown asset id"
  );
  assert(
    EVIDENCE_BANK_REQUIRED_MESSAGE.length > 0,
    "EVIDENCE_BANK_REQUIRED_MESSAGE is exported"
  );
  assert(
    ASSET_NOT_IN_PROJECT_MESSAGE.length > 0,
    "ASSET_NOT_IN_PROJECT_MESSAGE is exported"
  );

  // ---------------- Print summary ------------------------------------------
  console.log("");
  console.log("=== Summary ===");
  for (const { asset, res } of [
    { asset: rehydratedClean!, res: cleanRes },
    { asset: rehydratedBad!, res: badRes },
  ] as const) {
    console.log(
      [
        `  · ${asset.title.slice(0, 40).padEnd(40, " ")}`,
        `verdict=${res.output.verdict}`,
        `violations=${res.output.violations.length}`,
        `placeholders=${res.output.placeholdersRemaining.length}`,
        `qaStatus=${asset.qaStatus}`,
      ].join(" · ")
    );
  }

  console.log("");
  console.log("Sprint 9 smoke test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
