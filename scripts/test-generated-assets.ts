/**
 * Sprint 8 smoke test — Generated Assets (`generate_asset` mode only).
 *
 * Usage:
 *   npm run test:assets
 *     → full path: Mirror Scan → prompts → probes → competitors → gap map
 *       → evidence bank → fix brief → 5 generated assets (one per asset type).
 *   npm run test:assets -- <projectId>
 *     → uses an existing project that already has all prerequisites +
 *       at least one Fix Brief.
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
import {
  EVIDENCE_BANK_REQUIRED_MESSAGE,
  FIX_BRIEF_REQUIRED_MESSAGE,
  generateAsset,
} from "../lib/pipeline/generate-asset";
import { getDb } from "../lib/db";
import type { GeneratedPrompt } from "../lib/db/types";
import type { Platform } from "../lib/schemas/probe-analysis.schema";
import {
  AssetTypeSchema,
  GeneratedAssetOutputSchema,
  extractEvidencePlaceholders,
  type AssetTypeValue,
} from "../lib/schemas/generated-asset.schema";

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

async function ensureFixBrief(): Promise<{
  projectId: string;
  fixBriefId: string;
}> {
  const args = process.argv.slice(2);
  const db = getDb();

  if (args[0]) {
    const projectId = args[0];
    const project = await db.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    const briefs = await db.getFixBriefsByProject(projectId);
    if (briefs.length === 0) {
      throw new Error(
        `Project ${projectId} has no Fix Briefs — run test:fix-brief first.`
      );
    }
    return {
      projectId,
      fixBriefId: briefs.sort((a, b) => a.priority - b.priority)[0]!.id,
    };
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

  return { projectId: scan.project.id, fixBriefId: fb.fixBrief.id };
}

async function main() {
  const { projectId, fixBriefId } = await ensureFixBrief();
  const db = getDb();

  const assetTypes: AssetTypeValue[] = [
    "comparison_page_outline",
    "faq_block",
    "proof_block",
    "comparison_table",
    "json_ld_schema",
  ];

  console.log("");
  console.log(`Project ID:   ${projectId}`);
  console.log(`Fix Brief ID: ${fixBriefId}`);
  console.log("");

  for (const assetType of assetTypes) {
    console.log(`▸ Generating asset: ${assetType}`);
    const res = await generateAsset({
      projectId,
      fixBriefId,
      assetType,
    });
    if (!res.ok) {
      console.error(`✗ generateAsset(${assetType}) failed: ${res.error}`);
      process.exit(1);
    }
    const { asset, output } = res;
    assert(
      GeneratedAssetOutputSchema.safeParse(output).success,
      `${assetType}: agent output re-validates against GeneratedAssetOutputSchema`
    );
    assert(
      asset.qaStatus === "pending_qa",
      `${assetType}: stored asset has qaStatus="pending_qa"`
    );
    assert(
      asset.assetType === assetType,
      `${assetType}: stored assetType matches requested`
    );
    assert(
      asset.title.length > 0 && asset.content.length > 0,
      `${assetType}: title + content non-empty`
    );

    // Placeholder round-trip integrity (redundant check — schema already
    // does this — but useful to fail loudly if the mock ever drifts).
    const foundInContent = extractEvidencePlaceholders(asset.content);
    const declared = new Set(asset.placeholders);
    assert(
      foundInContent.every((p) => declared.has(p)),
      `${assetType}: every [EVIDENCE NEEDED] in content is declared`
    );
    assert(
      asset.placeholders.every((p) => asset.content.includes(p)),
      `${assetType}: every declared placeholder appears in content`
    );

    if (assetType === "json_ld_schema") {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(asset.content);
      } catch (e) {
        console.error(`✗ json_ld_schema content is not valid JSON: ${e}`);
        process.exit(1);
      }
      assert(
        typeof parsed === "object" && parsed !== null,
        "json_ld_schema content parses as a JSON object"
      );
      const p = parsed as { "@context"?: unknown; "@type"?: unknown };
      assert(
        p["@context"] === "https://schema.org",
        "json_ld_schema declares @context=https://schema.org"
      );
      assert(
        p["@type"] === "SoftwareApplication" || p["@type"] === "FAQPage",
        `json_ld_schema @type is SoftwareApplication or FAQPage (got ${String(p["@type"])})`
      );
    }

    console.log(
      `  · ${assetType.padEnd(24, " ")} title="${asset.title}" · placeholders=${asset.placeholders.length} · claimsUsed=${asset.claimsUsed.length} · qaStatus=${asset.qaStatus}`
    );
  }

  // Sanity: all five assets stored under the fix brief.
  const stored = await db.getGeneratedAssetsByFixBrief(fixBriefId);
  assert(
    stored.length >= assetTypes.length,
    `at least ${assetTypes.length} assets stored under fix brief`
  );
  const storedTypes = new Set(stored.map((a) => a.assetType));
  for (const t of assetTypes) {
    assert(storedTypes.has(t), `asset ${t} persisted under fix brief`);
  }
  assert(
    stored.every((a) => a.qaStatus === "pending_qa"),
    "every stored asset has qaStatus='pending_qa'"
  );

  // Guard message constants are exported.
  assert(
    EVIDENCE_BANK_REQUIRED_MESSAGE.length > 0,
    "EVIDENCE_BANK_REQUIRED_MESSAGE is exported"
  );
  assert(
    FIX_BRIEF_REQUIRED_MESSAGE.length > 0,
    "FIX_BRIEF_REQUIRED_MESSAGE is exported"
  );

  // Schema enum sanity — the source of truth used by the API route.
  assert(
    AssetTypeSchema.options.length === assetTypes.length,
    `AssetTypeSchema covers exactly ${assetTypes.length} asset types`
  );

  console.log("");
  console.log("Sprint 8 smoke test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
