/**
 * Sprint 10 — Full MVP pipeline validation.
 *
 * Runs the complete Zypact MVP flow (Sprints 1–9) end-to-end in a single
 * script and prints a concise validation report. Fails hard if any stage
 * is missing data or if QA didn't move every asset out of `pending_qa`.
 *
 * Usage:
 *   npm run test:full-pipeline
 *     → default URL: https://linear.app
 *   npm run test:full-pipeline -- <websiteUrl>
 *
 * This is a *validation* script, not a feature. It never mutates schemas,
 * never adds new agents, and never touches Sprint 11+ concerns (export,
 * publish, Stripe, automated probes). If a stage regresses, fix the
 * underlying bug — do NOT change this script to hide the failure.
 */

import "dotenv/config";
import { runMirrorScan } from "../lib/pipeline/run-mirror-scan";
import { generateBuyerPrompts } from "../lib/pipeline/generate-buyer-prompts";
import { analyzeProbeResponse } from "../lib/pipeline/analyze-probe-response";
import {
  NO_PROBE_RESULTS_MESSAGE as COMPETITOR_NO_PROBE_MESSAGE,
  discoverCompetitors,
} from "../lib/pipeline/discover-competitors";
import {
  NO_PROBE_RESULTS_MESSAGE as GAP_NO_PROBE_MESSAGE,
  NO_COMPETITORS_MESSAGE,
  generateGapMap,
} from "../lib/pipeline/generate-gap-map";
import { getOrCreateEvidenceBank } from "../lib/pipeline/get-or-create-evidence-bank";
import {
  EVIDENCE_BANK_REQUIRED_MESSAGE as FIX_BRIEF_EVIDENCE_REQUIRED_MESSAGE,
  NO_LOST_PROBE_MESSAGE,
  generateFixBrief,
} from "../lib/pipeline/generate-fix-brief";
import {
  EVIDENCE_BANK_REQUIRED_MESSAGE as ASSET_EVIDENCE_REQUIRED_MESSAGE,
  FIX_BRIEF_REQUIRED_MESSAGE,
  generateAsset,
} from "../lib/pipeline/generate-asset";
import {
  EVIDENCE_BANK_REQUIRED_MESSAGE as QA_EVIDENCE_REQUIRED_MESSAGE,
  runQa,
} from "../lib/pipeline/run-qa";
import { getDb } from "../lib/db";
import { hasUsableEvidenceBank } from "../lib/evidence-bank/has-usable-evidence-bank";
import { EvidenceBankOutputSchema } from "../lib/schemas/evidence-bank.schema";
import type { GeneratedPrompt } from "../lib/db/types";
import type { Platform } from "../lib/schemas/probe-analysis.schema";
import type { AssetTypeValue } from "../lib/schemas/generated-asset.schema";

/* -------------------------------------------------------------------------- */
/*  Config                                                                    */
/* -------------------------------------------------------------------------- */

const DEFAULT_URL = "https://linear.app";

/**
 * Three synthetic AI answers used to seed manual probe analysis. Each one
 * mentions the incumbent competitor for the mock category so the probe
 * agent produces `lost`/`partial` verdicts without needing a live LLM.
 */
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

const KNOWN_COMPETITORS = [
  "Jira",
  "Asana",
  "Trello",
  "Notion",
  "Monday.com",
  "ClickUp",
];

const ALL_ASSET_TYPES: readonly AssetTypeValue[] = [
  "comparison_page_outline",
  "faq_block",
  "proof_block",
  "comparison_table",
  "json_ld_schema",
] as const;

const QA_STATUSES = [
  "pending_qa",
  "needs_evidence",
  "safe_to_publish",
  "unsupported_claims",
] as const;

/**
 * Canonical guard-message strings the Sprint 10 brief expects to still be
 * live in the pipeline. Verified at test time so refactors can't silently
 * change the wording UI or docs depend on.
 */
const REQUIRED_GUARD_MESSAGES: ReadonlyArray<{
  label: string;
  actual: string;
  expected: string;
}> = [
  {
    label: "competitor-discovery / no probes",
    actual: COMPETITOR_NO_PROBE_MESSAGE,
    expected: "Run at least one probe analysis before discovering competitors.",
  },
  {
    label: "gap-map / no probes",
    actual: GAP_NO_PROBE_MESSAGE,
    expected: "Run at least one probe analysis before generating a gap map.",
  },
  {
    label: "gap-map / no competitors",
    actual: NO_COMPETITORS_MESSAGE,
    expected: "Run competitor discovery before generating a gap map.",
  },
  {
    label: "fix-brief / no evidence bank",
    actual: FIX_BRIEF_EVIDENCE_REQUIRED_MESSAGE,
    expected: "Prepare the Evidence Bank before generating fix briefs.",
  },
  {
    label: "fix-brief / no lost probe",
    actual: NO_LOST_PROBE_MESSAGE,
    expected:
      "Run at least one lost or partial probe analysis before generating fix briefs.",
  },
  {
    label: "generate-asset / no evidence bank",
    actual: ASSET_EVIDENCE_REQUIRED_MESSAGE,
    expected: "Prepare the Evidence Bank before generating assets.",
  },
  {
    label: "generate-asset / no fix brief",
    actual: FIX_BRIEF_REQUIRED_MESSAGE,
    expected: "Generate a Fix Brief before generating assets.",
  },
  {
    label: "run-qa / no evidence bank",
    actual: QA_EVIDENCE_REQUIRED_MESSAGE,
    expected: "Prepare the Evidence Bank before running QA.",
  },
];

/* -------------------------------------------------------------------------- */
/*  Assertion helpers                                                         */
/* -------------------------------------------------------------------------- */

interface Failure {
  stage: string;
  message: string;
}

const failures: Failure[] = [];

function check(stage: string, cond: boolean, message: string) {
  if (cond) {
    console.log(`✓ [${stage}] ${message}`);
  } else {
    console.error(`✗ [${stage}] ${message}`);
    failures.push({ stage, message });
  }
}

function severityRank(s: string): number {
  return s === "high" ? 0 : s === "medium" ? 1 : 2;
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                      */
/* -------------------------------------------------------------------------- */

async function main() {
  const websiteUrl = process.argv[2]?.trim() || DEFAULT_URL;
  const db = getDb();

  console.log("");
  console.log("Zypact MVP — full pipeline validation");
  console.log("=====================================");
  console.log(`URL              : ${websiteUrl}`);
  const mockForced = process.env.ZYPACT_MOCK_MODE === "on";
  const hasKey =
    !!process.env.OPENAI_API_KEY || !!process.env.ANTHROPIC_API_KEY;
  const isLive = !mockForced && hasKey;
  const pinned = (process.env.LLM_PROVIDER ?? "").toLowerCase() || "(auto)";
  console.log(`Model mode       : ${isLive ? "LIVE" : "MOCK"}`);
  console.log(`LLM_PROVIDER     : ${pinned}`);
  if (isLive) {
    const model =
      process.env.OPENAI_API_KEY
        ? process.env.OPENAI_MODEL || "gpt-4o-mini"
        : process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest";
    console.log(`Model            : ${model}`);
  }
  console.log("");

  // Guard-message contract — checked before we start so a broken constant
  // fails the run early instead of masquerading as some other regression.
  for (const g of REQUIRED_GUARD_MESSAGES) {
    check(
      "guards",
      g.actual === g.expected,
      `${g.label} verbatim: "${g.expected}"`
    );
  }

  // ---------------- Stage 1: Mirror Scan --------------------------------
  console.log("");
  // Sprint 10.5: propagate an authenticated owner if one was seeded
  // via `MVP_TEST_USER_ID`. Left unset → legacy `user_id = NULL` row
  // (still allowed for CLI/internal scripts; protected UI/API routes
  // will reject those rows via `requireProjectOwner`).
  const testUserId = process.env.MVP_TEST_USER_ID?.trim() || null;
  console.log(`▸ Stage 1 — Mirror Scan on ${websiteUrl}`);
  console.log(`Owner (auth.users.id) : ${testUserId ?? "<none — legacy row>"}`);
  const scan = await runMirrorScan({ websiteUrl, userId: testUserId });
  if (!scan.ok) {
    console.error(`✗ Mirror Scan failed: ${scan.error}`);
    process.exit(1);
  }
  const projectId = scan.project.id;
  check("mirror-scan", scan.pages.length > 0, "at least one page crawled");
  check(
    "mirror-scan",
    scan.mirrorProfile.missingSignals.length >= 3,
    "mirror profile has ≥ 3 missingSignals (Sprint 1 rule)"
  );
  const mirrorRow = await db.getMirrorProfile(projectId);
  check("mirror-scan", mirrorRow !== null, "Mirror Profile persisted");

  // Sprint 10.5 ownership assertion: if we seeded a MVP_TEST_USER_ID,
  // the persisted project must carry it. This proves the auth-wiring
  // change to `runMirrorScan` actually reaches the DB.
  if (testUserId) {
    const stored = await db.getProject(projectId);
    check(
      "mirror-scan",
      stored?.userId === testUserId,
      `project.userId is the authenticated user (${stored?.userId ?? "null"})`
    );
  }

  // ---------------- Stage 2: Prompt Mirror ------------------------------
  console.log("");
  console.log("▸ Stage 2 — Prompt Mirror");
  const promptRes = await generateBuyerPrompts({ projectId });
  if (!promptRes.ok) {
    console.error(`✗ generateBuyerPrompts failed: ${promptRes.error}`);
    process.exit(1);
  }
  check(
    "prompt-mirror",
    promptRes.stored.length === 50,
    `exactly 50 prompts generated (got ${promptRes.stored.length})`
  );
  const selectedPrompts = promptRes.stored.filter(
    (p: GeneratedPrompt) => p.selected
  );
  check(
    "prompt-mirror",
    selectedPrompts.length > 0,
    `at least one prompt marked recommendedForProbe (got ${selectedPrompts.length})`
  );

  // ---------------- Stage 3: Manual Probe Analysis ----------------------
  console.log("");
  console.log("▸ Stage 3 — Manual Probe Analysis (3 synthetic answers)");
  const probeTargets = [...selectedPrompts]
    .sort((a, b) => b.priority - a.priority)
    .slice(0, Math.min(3, selectedPrompts.length));
  for (let i = 0; i < probeTargets.length; i++) {
    const target = probeTargets[i];
    const answer = SYNTHETIC_ANSWERS[i % SYNTHETIC_ANSWERS.length];
    const r = await analyzeProbeResponse({
      projectId,
      generatedPromptId: target.id,
      prompt: target.prompt,
      platform: answer.platform,
      rawResponse: answer.text,
      knownCompetitors: KNOWN_COMPETITORS,
    });
    if (!r.ok) {
      console.error(`✗ analyzeProbeResponse failed: ${r.error}`);
      process.exit(1);
    }
  }
  const probeResults = await db.getProbeResultsByProject(projectId);
  const lostOrPartial = probeResults.filter(
    (r) => r.verdict === "lost" || r.verdict === "partial"
  );
  check(
    "probe-analysis",
    probeResults.length >= 1,
    `at least one probe result stored (got ${probeResults.length})`
  );
  check(
    "probe-analysis",
    lostOrPartial.length >= 1,
    `at least one lost/partial probe result (got ${lostOrPartial.length})`
  );

  // ---------------- Stage 4: Competitor Discovery -----------------------
  console.log("");
  console.log("▸ Stage 4 — Competitor Discovery");
  const disc = await discoverCompetitors({
    projectId,
    userCompetitors: ["Jira", "Airtable"],
  });
  if (!disc.ok) {
    console.error(`✗ discoverCompetitors failed: ${disc.error}`);
    process.exit(1);
  }
  const competitors = await db.getCompetitorsByProject(projectId);
  const blindSpots = competitors.filter((c) => c.isBlindSpot);
  const phantoms = competitors.filter((c) => c.isPhantom);
  check(
    "competitor-discovery",
    competitors.length >= 1,
    `at least one competitor discovered (got ${competitors.length})`
  );

  // ---------------- Stage 5: Gap Map ------------------------------------
  console.log("");
  console.log("▸ Stage 5 — Gap Map");
  const gm = await generateGapMap({ projectId });
  if (!gm.ok) {
    console.error(`✗ generateGapMap failed: ${gm.error}`);
    process.exit(1);
  }
  const gaps = await db.getGapsByProject(projectId);
  check(
    "gap-map",
    gm.output.competitorDistances.length >= 1,
    `Gap Map produced competitorDistances (got ${gm.output.competitorDistances.length})`
  );
  check(
    "gap-map",
    gaps.length >= 1,
    `at least one prioritized Gap stored (got ${gaps.length})`
  );

  // ---------------- Stage 6: Evidence Bank ------------------------------
  console.log("");
  console.log("▸ Stage 6 — Evidence Bank (get-or-create)");
  const eb = await getOrCreateEvidenceBank(projectId);
  if (!eb.ok) {
    console.error(`✗ getOrCreateEvidenceBank failed: ${eb.error}`);
    process.exit(1);
  }
  const bankRow = await db.getEvidenceBankByProject(projectId);
  const bankParsed = bankRow
    ? EvidenceBankOutputSchema.safeParse(bankRow)
    : null;
  const bank = bankParsed && bankParsed.success ? bankParsed.data : null;
  const bankUsable = hasUsableEvidenceBank(bank);
  check("evidence-bank", bank !== null, "Evidence Bank exists");
  check("evidence-bank", bankUsable, "Evidence Bank is usable (Sprint 6 rule)");

  // ---------------- Stage 7: Fix Brief ----------------------------------
  console.log("");
  console.log("▸ Stage 7 — Fix Brief");
  const targetGap = [...gaps].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity)
  )[0]!;
  const fb = await generateFixBrief({ projectId, gapId: targetGap.id });
  if (!fb.ok) {
    console.error(`✗ generateFixBrief failed: ${fb.error}`);
    process.exit(1);
  }
  const fixBriefs = await db.getFixBriefsByProject(projectId);
  check(
    "fix-brief",
    fixBriefs.length >= 1,
    `at least one Fix Brief stored (got ${fixBriefs.length})`
  );

  // ---------------- Stage 8: Generated Assets ---------------------------
  console.log("");
  console.log("▸ Stage 8 — Generated Assets (all 5 types)");
  for (const assetType of ALL_ASSET_TYPES) {
    const res = await generateAsset({
      projectId,
      fixBriefId: fb.fixBrief.id,
      assetType,
    });
    if (!res.ok) {
      console.error(`✗ generateAsset(${assetType}) failed: ${res.error}`);
      process.exit(1);
    }
  }
  const assets = await db.getGeneratedAssetsByFixBrief(fb.fixBrief.id);
  check(
    "generated-assets",
    assets.length === ALL_ASSET_TYPES.length,
    `exactly ${ALL_ASSET_TYPES.length} assets generated (got ${assets.length})`
  );
  const storedTypes = new Set(assets.map((a) => a.assetType));
  for (const t of ALL_ASSET_TYPES) {
    check(
      "generated-assets",
      storedTypes.has(t),
      `asset "${t}" persisted under Fix Brief`
    );
  }
  check(
    "generated-assets",
    assets.every((a) => a.qaStatus === "pending_qa"),
    "every fresh asset is stored with qa_status='pending_qa'"
  );

  // ---------------- Stage 9: QA Agent -----------------------------------
  console.log("");
  console.log("▸ Stage 9 — QA Agent (per asset)");
  for (const asset of assets) {
    const qa = await runQa({ projectId, assetId: asset.id });
    if (!qa.ok) {
      console.error(`✗ runQa(${asset.assetType}) failed: ${qa.error}`);
      process.exit(1);
    }
  }
  const projectAssets = await db.getGeneratedAssetsByProject(projectId);
  const qaReports = await db.getQaReportsByProject(projectId);
  check(
    "qa",
    qaReports.length >= projectAssets.length,
    `at least one QaReport per asset (${qaReports.length} reports for ${projectAssets.length} assets)`
  );
  check(
    "qa",
    projectAssets.every((a) => a.qaStatus !== "pending_qa"),
    "no asset remains qa_status='pending_qa' after QA"
  );
  for (const a of projectAssets) {
    const latest = await db.getLatestQaReportForAsset(a.id);
    check(
      "qa",
      latest !== null && latest.verdict === a.qaStatus,
      `asset "${a.assetType}" qaStatus matches latest QA verdict ("${a.qaStatus}")`
    );
  }

  // ---------------- Summary counts --------------------------------------
  const qaDist: Record<(typeof QA_STATUSES)[number], number> = {
    pending_qa: 0,
    needs_evidence: 0,
    safe_to_publish: 0,
    unsupported_claims: 0,
  };
  for (const a of projectAssets) {
    if (a.qaStatus in qaDist) {
      qaDist[a.qaStatus as (typeof QA_STATUSES)[number]]++;
    }
  }

  console.log("");
  console.log("=== Pipeline validation report ===");
  console.log(`projectId                : ${projectId}`);
  console.log(`URL tested               : ${websiteUrl}`);
  console.log(`pages crawled            : ${scan.pages.length}`);
  console.log(`detectedCategory         : ${scan.mirrorProfile.detectedCategory}`);
  console.log(`prompts generated        : ${promptRes.stored.length}`);
  console.log(`selected prompts         : ${selectedPrompts.length}`);
  console.log(`probe results            : ${probeResults.length}`);
  console.log(`lost/partial results     : ${lostOrPartial.length}`);
  console.log(`competitors              : ${competitors.length}`);
  console.log(`  · blind spots          : ${blindSpots.length}`);
  console.log(`  · phantoms             : ${phantoms.length}`);
  console.log(
    `competitor distances     : ${gm.output.competitorDistances.length}`
  );
  console.log(`prioritized gaps         : ${gaps.length}`);
  console.log(`evidence bank present    : ${bank ? "yes" : "no"}`);
  console.log(`evidence bank usable     : ${bankUsable ? "yes" : "no"}`);
  console.log(`fix briefs               : ${fixBriefs.length}`);
  console.log(`generated assets         : ${projectAssets.length}`);
  console.log(`QA reports               : ${qaReports.length}`);
  console.log(`QA status distribution   :`);
  for (const s of QA_STATUSES) {
    console.log(`  · ${s.padEnd(20, " ")}: ${qaDist[s]}`);
  }

  console.log("");
  if (failures.length > 0) {
    console.error(`✗ Full pipeline validation FAILED (${failures.length} check${failures.length === 1 ? "" : "s"}).`);
    for (const f of failures) {
      console.error(`  · [${f.stage}] ${f.message}`);
    }
    process.exit(1);
  }
  console.log("Full pipeline validation PASSED.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
