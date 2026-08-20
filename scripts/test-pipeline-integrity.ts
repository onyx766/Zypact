#!/usr/bin/env tsx
/**
 * Sprint 12 unit tests — pipeline integrity fixes that do not require
 * network, Supabase, or live LLM calls.
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ZYPACT_ALLOW_MEMORY_DB;
delete process.env.LLM_PROVIDER;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_MODEL;
process.env.ZYPACT_MOCK_MODE = "on";

import { z } from "zod";
import { getDb } from "@/lib/db";
import type {
  Competitor,
  EvidenceBankRow,
  FixBriefRow,
  GapMapRow,
  GeneratedAssetRow,
  MirrorProfileRow,
  ProbeResult,
  QaReportRow,
} from "@/lib/db/types";
import { buildGapMapUserMessageForTest } from "@/lib/agents/gap-map";
import { buildEvidenceBankPrefill } from "@/lib/evidence-bank/build-evidence-bank-prefill";
import { buildMvpReport } from "@/lib/export/build-mvp-report";
import {
  buildAllowedUrlSet,
  detectAssetTypeConformity,
  detectEvidenceBankProvenanceCeiling,
  detectFabricatedUrls,
  detectUnsupportedCompetitorClaims,
  downgradeSupportedLlmViolations,
  mergeQaViolations,
} from "@/lib/qa/deterministic-checks";
import type { ResolvedCompetitorMention } from "@/lib/evidence/get-resolved-competitor-mentions";
import { mergeSourcesFromRawResponse } from "@/lib/probe-analysis/merge-sources";
import { classifyProductRecommendation, probeRequestLeaksClientIdentity } from "@/lib/probe-analysis/product-recommendation";
import { selectCommercialProbePromptIds } from "@/lib/prompts/commercial-selection";
import { isAiPlatformName } from "@/lib/ai-platforms/platform-registry";
import { buildProbeSetSummary } from "@/lib/probe-results/report-selection";
import { computeGapScores } from "@/lib/gap-map/compute-gap-scores";
import { runPerplexityProbe } from "@/lib/probes/perplexity";
import {
  buildMockGeneratedAsset,
  resolveGenerateAssetModelOverride,
  runGenerateAssetAgent,
} from "@/lib/agents/fix-agent";
import { QaAgentOutputSchema } from "@/lib/schemas/qa-agent.schema";
import type { QaAgentOutput } from "@/lib/schemas/qa-agent.schema";
import { parseJsonOrRetry } from "@/lib/llm/parse-json-or-retry";
import type { SiteReaderOutput } from "@/lib/schemas/site-reader.schema";
import type { EvidenceBankOutput } from "@/lib/schemas/evidence-bank.schema";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const now = "2026-07-10T00:00:00.000Z";
const projectId = "11111111-1111-1111-1111-111111111111";

function evidenceBank(
  overrides: Partial<EvidenceBankRow> = {},
): EvidenceBankRow {
  return {
    id: "eb-1",
    projectId,
    productDescription: "Linear is a product development platform for teams.",
    targetAudience: ["Product teams"],
    mainUseCases: ["Issue tracking"],
    features: [{ name: "Project updates", description: "" }],
    proofItems: [
      {
        type: "customer",
        detail: "Linear powers over 33,000 product teams.",
        sourceUrl: "https://linear.app/customers",
      },
    ],
    competitors: ["Jira"],
    allowedClaims: ["Linear powers over 33,000 product teams."],
    forbiddenClaims: ["guaranteed rankings", "#1 platform", "10x growth"],
    tone: "plain",
    notes: "",
    provenance: "auto_filled_from_mirror_profile",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function mirrorProfile(): MirrorProfileRow {
  return {
    id: "mp-1",
    projectId,
    json: {
      companyName: "Linear",
      website: "https://linear.app/",
      detectedCategory: "Product development platform for teams",
      categoryConfidence: "high",
      targetAudience: ["Product teams"],
      useCases: ["Issue tracking"],
      features: ["Project updates"],
      painPointsAddressed: ["Coordination"],
      claims: [
        {
          claim: "Linear powers over 33,000 product teams.",
          sourceUrl: "https://linear.app/customers",
          hasProof: true,
        },
      ],
      proofSignals: [
        {
          type: "customer",
          detail: "Linear powers over 33,000 product teams.",
          sourceUrl: "https://linear.app/customers",
        },
      ],
      competitorsMentioned: ["Jira"],
      missingSignals: [
        { signal: "Pricing", whyItMatters: "Buyers need it" },
        { signal: "Reviews", whyItMatters: "Third-party proof" },
        { signal: "FAQ", whyItMatters: "Buyer clarity" },
      ],
      buyerIntentAngles: ["Linear vs Jira"],
      aiReadabilityNotes: "",
    },
    createdAt: now,
  };
}

function fixBrief(): FixBriefRow {
  return {
    id: "fb-1",
    projectId,
    gapId: null,
    probeResultId: null,
    lostPrompt: "How can I improve coordination across product teams?",
    competitorRecommended: "Jira",
    rootCause: "Linear was absent.",
    recommendedFix: "Publish a Linear vs Jira comparison page.",
    fixType: "comparison_page",
    assetsToGenerate: ["comparison_page_outline"],
    evidenceNeeded: ["specific coordination proof"],
    evidenceAvailable: ["Linear powers over 33,000 product teams."],
    priority: 1,
    expectedImpact: "May improve visibility.",
    status: "needs_evidence",
    createdAt: now,
    updatedAt: now,
  };
}

function asset(
  assetType: string,
  content: string,
  extra: Partial<GeneratedAssetRow> = {},
): GeneratedAssetRow {
  return {
    id: `asset-${assetType}`,
    projectId,
    fixBriefId: "fb-1",
    assetType,
    title: `${assetType} test`,
    content,
    placeholders: [],
    claimsUsed: [],
    qaStatus: "pending_qa",
    createdAt: now,
    updatedAt: now,
    ...extra,
    lifecycleStatus: extra.lifecycleStatus ?? "active",
    generationProvider: extra.generationProvider ?? null,
    generationModel: extra.generationModel ?? null,
  };
}

function probeResult(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    id: "pr-1",
    probeRunId: "run-1",
    projectId,
    generatedPromptId: "prompt-1",
    prompt: "Best project management tools for product teams?",
    platform: "chatgpt",
    probeMode: "simulated",
    rawResponse:
      "Jira is commonly cited by G2: https://www.g2.com/products/jira/reviews",
    clientMentioned: false,
    clientPosition: "absent",
    competitorsMentioned: [
      { name: "Jira", position: 1, context: "recommended" },
    ],
    sourcesCited: [
      {
        source: "https://www.g2.com/products/jira/reviews",
        type: "review_site",
      },
    ],
    answerSummary: "Jira was recommended.",
    verdict: "lost",
    whyClientLost: "Linear was absent.",
    createdAt: now,
    ...overrides,
  };
}

/**
 * M3 — simulates the M2 canonical layer's own output for a fixture
 * probe_result's `competitorsMentioned`, the same way
 * scripts/test-scorecard-competitors.ts does: the same (trimmed,
 * lowercased) name always resolves to the same canonical_entity_id.
 * Used only to build `resolvedCompetitorMentions` for
 * `detectUnsupportedCompetitorClaims`, which no longer reads
 * `probeResults`/`competitorsMentioned` directly.
 */
function toResolvedMentions(...probes: ProbeResult[]): ResolvedCompetitorMention[] {
  const out: ResolvedCompetitorMention[] = [];
  for (const pr of probes) {
    const mentions = Array.isArray(pr.competitorsMentioned)
      ? (pr.competitorsMentioned as Array<{ name?: unknown; position?: unknown; context?: unknown }>)
      : [];
    for (const m of mentions) {
      if (typeof m.name !== "string") continue;
      out.push({
        canonicalEntityId: `canonical:${m.name.trim().toLowerCase()}`,
        rawText: m.name,
        normalizedText: m.name.trim().toLowerCase(),
        mentionOrdinal: typeof m.position === "number" ? m.position : 1,
        context: typeof m.context === "string" ? m.context : null,
        generatedPromptId: pr.generatedPromptId ?? null,
      });
    }
  }
  return out;
}

/** Same simulation as toResolvedMentions, keyed per probe_result.id for buildMvpReport's resolvedMentionsByProbeResult. */
function toResolvedMentionsByProbeResult(
  probes: readonly ProbeResult[]
): ReadonlyMap<string, ResolvedCompetitorMention[]> {
  return new Map(probes.map((pr) => [pr.id, toResolvedMentions(pr)]));
}

function competitor(): Competitor {
  return {
    id: "comp-1",
    projectId,
    name: "Jira",
    website: "https://www.atlassian.com/software/jira",
    discoverySource: "ai_answer",
    mentionCount: 1,
    promptIds: ["prompt-1"],
    threatLevel: "high",
    confidence: "verified",
    isPhantom: false,
    isBlindSpot: false,
    // Matches toResolvedMentions()'s canonical:${name.toLowerCase()}
    // simulation below for a mention named "Jira" — so tests exercising
    // computeGapScores' canonical-identity matching see this fixture as
    // genuinely linked, the same way a real ai_answer discovery row would be.
    canonicalEntityId: "canonical:jira",
    createdAt: now,
    updatedAt: now,
  };
}

function testProbeModePersistence(): void {
  const db = getDb();
  // Memory adapter test: probes must persist mode on both run and result.
  db.createProject({
    domain: "linear.app",
    companyName: "Linear",
    userId: "user-1",
  })
    .then(async (project) => {
      const run = await db.createProbeRun(
        project.id,
        "chatgpt",
        "simulated",
        "pending",
      );
      const result = await db.saveProbeResult({
        probeRunId: run.id,
        projectId: project.id,
        generatedPromptId: null,
        prompt: "Best tools?",
        platform: "chatgpt",
        probeMode: "simulated",
        rawResponse: "Jira",
        clientMentioned: false,
        clientPosition: "absent",
        competitorsMentioned: [
          { name: "Jira", position: 1, context: "recommended" },
        ],
        sourcesCited: [],
        answerSummary: "Jira recommended.",
        verdict: "lost",
        whyClientLost: "Linear absent.",
      });
      check(
        "probe run persists probeMode=simulated",
        run.probeMode === "simulated",
      );
      check(
        "probe result persists probeMode=simulated",
        result.probeMode === "simulated",
      );
    })
    .catch((err) => {
      console.error(err);
      process.exit(2);
    });
}

async function testProbeModePersistenceAsync(): Promise<void> {
  const db = getDb();
  const project = await db.createProject({
    domain: "linear.app",
    companyName: "Linear",
    userId: "user-1",
  });
  const run = await db.createProbeRun(
    project.id,
    "chatgpt",
    "simulated",
    "pending",
  );
  const result = await db.saveProbeResult({
    probeRunId: run.id,
    projectId: project.id,
    generatedPromptId: null,
    prompt: "Best tools?",
    platform: "chatgpt",
    probeMode: "simulated",
    rawResponse: "Jira",
    clientMentioned: false,
    clientPosition: "absent",
    competitorsMentioned: [
      { name: "Jira", position: 1, context: "recommended" },
    ],
    sourcesCited: [],
    answerSummary: "Jira recommended.",
    verdict: "lost",
    whyClientLost: "Linear absent.",
  });
  const rows = await db.getProbeResultsByProject(project.id);
  check(
    "probe run persists probeMode=simulated",
    run.probeMode === "simulated",
  );
  check(
    "probe result persists probeMode=simulated",
    result.probeMode === "simulated",
  );
  check(
    "probe rows hydrate probeMode=simulated",
    rows[0]?.probeMode === "simulated",
  );
}

async function testLivePerplexityProbeMode(): Promise<void> {
  const db = getDb();
  const project = await db.createProject({
    domain: "linear.app",
    companyName: "Linear",
    userId: "user-1",
  });
  const run = await db.createProbeRun(
    project.id,
    "perplexity",
    "live_perplexity",
    "pending",
  );
  const result = await db.saveProbeResult({
    probeRunId: run.id,
    projectId: project.id,
    generatedPromptId: null,
    prompt: "Compare Linear vs Jira for issue tracking.",
    platform: "perplexity",
    probeMode: "live_perplexity",
    rawResponse: "Linear and Jira are both discussed. Source: https://linear.app/",
    clientMentioned: true,
    clientPosition: "listed",
    competitorsMentioned: [
      { name: "Jira", position: 2, context: "comparison target" },
    ],
    sourcesCited: [
      { source: "https://linear.app/", type: "vendor_site" },
    ],
    answerSummary: "Linear and Jira were discussed.",
    verdict: "partial",
    whyClientLost: "Linear was listed, not primary.",
  });
  const rows = await db.getProbeResultsByProject(project.id);
  check("probe run persists probeMode=live_perplexity", run.probeMode === "live_perplexity");
  check("probe result persists probeMode=live_perplexity", result.probeMode === "live_perplexity");
  check("probe rows hydrate probeMode=live_perplexity", rows[0]?.probeMode === "live_perplexity");
}

async function testPerplexityProbeResponseShape(): Promise<void> {
  const result = await runPerplexityProbe({
    prompt: "Compare Linear vs Jira for issue tracking.",
    brandName: "Linear",
    domain: "linear.app",
    mockResponse: {
      prompt: "Compare Linear vs Jira for issue tracking.",
      answer: "Linear and Jira are both issue tracking tools.",
      rawResponse: "Linear and Jira are both issue tracking tools.\n\nPerplexity citations:\n- https://linear.app/",
      citations: ["https://linear.app/"],
      searchResults: [{ title: "Linear", url: "https://linear.app/", snippet: "Product development platform." }],
      sourceCitations: [{ source: "https://linear.app/", type: "vendor_site" }],
      model: "sonar",
      usedMock: true,
    },
  });
  check("Perplexity mock probe preserves raw answer", result.rawResponse.includes("Linear and Jira"));
  check("Perplexity mock probe carries citations", result.sourceCitations.some((s) => s.source === "https://linear.app/"));
}

function testLivePerplexityExportLabels(): void {
  const probeResultsFixture = [
    probeResult({
      platform: "perplexity",
      probeMode: "live_perplexity",
      clientMentioned: true,
      clientPosition: "listed",
      verdict: "partial",
      whyClientLost: "Linear appeared but was not primary.",
      rawResponse: "Linear and Jira appeared. https://linear.app/",
    }),
  ];
  const report = buildMvpReport({
    project: {
      id: projectId,
      userId: "user-1",
      companyName: "Linear",
      domain: "linear.app",
      category: null,
      createdAt: now,
    },
    mirrorProfile: mirrorProfile(),
    prompts: [],
    probeResults: probeResultsFixture,
    resolvedMentionsByProbeResult: toResolvedMentionsByProbeResult(probeResultsFixture),
    competitors: [competitor()],
    gapMap: null,
    gaps: [],
    evidenceBank: evidenceBank(),
    fixBriefs: [fixBrief()],
    assets: [],
    latestQaByAsset: new Map(),
    llmProvider: "openai",
    llmModel: "gpt-4o-mini",
    mockMode: false,
    now: new Date(now),
  });
  check("live Perplexity probe appears in report", report.markdown.includes("Live Perplexity Sonar probe"));
  check("export labels probe origin live_perplexity", report.markdown.includes("probe origin**: live_perplexity"));
  check("appendix records live_perplexity origin", report.markdown.includes("live_perplexity (real Perplexity Sonar API responses)"));
}

function testUrlFabricationGuard(): void {
  const eb = evidenceBank();
  const mp = mirrorProfile();
  const allowed = buildAllowedUrlSet({
    evidenceBank: eb,
    mirrorProfile: mp,
    fixBriefs: [fixBrief()],
    projectDomain: "linear.app",
  });
  const bad = asset(
    "json_ld_schema",
    '{"@context":"https://schema.org","@type":"SoftwareApplication","sameAs":"https://www.producthunt.com/posts/linear"}',
  );
  const violations = detectFabricatedUrls(bad, allowed);
  check(
    "fabricated producthunt URL is flagged",
    violations.some(
      (v) =>
        v.type === "fabrication" &&
        v.quote.includes("producthunt.com/posts/linear"),
    ),
  );
  check(
    "schema.org JSON-LD URL is allowlisted",
    !violations.some((v) => v.quote.includes("schema.org")),
  );
  const schemaCondition = asset(
    "json_ld_schema",
    '{"@context":"https://schema.org","@type":"SoftwareApplication","itemCondition":"https://schema.org/NewCondition"}',
  );
  check(
    "schema.org vocabulary paths are allowlisted",
    detectFabricatedUrls(schemaCondition, allowed).length === 0,
  );

  const ok = asset(
    "proof_block",
    "See https://linear.app/customers for proof.",
  );
  const okViolations = detectFabricatedUrls(ok, allowed);
  check("allowed evidence URL is not flagged", okViolations.length === 0);

  const llm: QaAgentOutput = {
    verdict: "safe_to_publish",
    violations: [],
    placeholdersRemaining: [],
    overallNotes: "Clean from LLM.",
  };
  const merged = mergeQaViolations(llm, violations);
  check(
    "fabricated URL merge recomputes unsupported_claims",
    merged.verdict === "unsupported_claims",
  );
  check(
    "LLM notes preserved with deterministic summary",
    merged.overallNotes.includes("Deterministic QA layer added"),
  );
}

function testAssetTypeConformity(): void {
  const eb = evidenceBank();
  check(
    "faq_block with zero Q&A fails conformity",
    detectAssetTypeConformity({
      asset: asset("faq_block", "# FAQ\n\nThis is prose without questions."),
      evidenceBank: eb,
    }).some((v) => v.type === "quality"),
  );
  check(
    "proof_block with zero proof references fails conformity",
    detectAssetTypeConformity({
      asset: asset("proof_block", "# Proof\n\nA generic trust paragraph."),
      evidenceBank: eb,
    }).some((v) => v.type === "quality"),
  );
  check(
    "proof_block referencing an Evidence Bank proof passes conformity",
    detectAssetTypeConformity({
      asset: asset("proof_block", "Linear powers over 33,000 product teams."),
      evidenceBank: eb,
    }).length === 0,
  );
  const ebWithCaseStudy = evidenceBank({
    proofItems: [
      {
        type: "case_study",
        detail: "OpenAI scaled to 3,000 users using Linear.",
        sourceUrl: "https://linear.app/customers/openai",
      },
    ],
  });
  check(
    "proof_block markdown bold numeric proof passes conformity",
    detectAssetTypeConformity({
      asset: asset("proof_block", "OpenAI scaled to **3,000 users** using Linear."),
      evidenceBank: ebWithCaseStudy,
    }).length === 0,
  );
  check(
    "comparison_table without Markdown table fails conformity",
    detectAssetTypeConformity({
      asset: asset("comparison_table", "Linear vs Jira prose only."),
      evidenceBank: eb,
    }).some((v) => v.type === "quality"),
  );
  check(
    "comparison_table with Markdown table passes conformity",
    detectAssetTypeConformity({
      asset: asset(
        "comparison_table",
        "| Tool | Fit |\n|---|---|\n| Linear | Product teams |",
      ),
      evidenceBank: eb,
    }).length === 0,
  );
  check(
    "valid json_ld_schema with @type passes conformity",
    detectAssetTypeConformity({
      asset: asset(
        "json_ld_schema",
        '{"@context":"https://schema.org","@type":"SoftwareApplication"}',
      ),
      evidenceBank: eb,
    }).length === 0,
  );
  check(
    "invalid json_ld_schema fails conformity",
    detectAssetTypeConformity({
      asset: asset("json_ld_schema", '{"@context":"https://schema.org"}'),
      evidenceBank: eb,
    }).some((v) => v.type === "quality"),
  );
  check(
    "comparison_page_outline with fewer than 3 headings fails conformity",
    detectAssetTypeConformity({
      asset: asset(
        "comparison_page_outline",
        "# Linear vs Jira\n\n## Overview",
      ),
      evidenceBank: eb,
    }).some((v) => v.type === "quality"),
  );
}

function testCompetitorClaimIntegrity(): void {
  const eb = evidenceBank({ provenance: "user_reviewed" });
  const jira = competitor();
  const notion: Competitor = {
    ...competitor(),
    id: "comp-2",
    name: "Notion",
    website: "https://www.notion.com",
    mentionCount: 1,
    threatLevel: "medium",
  };

  const unsupportedTable = asset(
    "comparison_table",
    [
      "| Feature | Linear | Jira | Notion |",
      "|---|---|---|---|",
      "| Automated updates | Yes | Limited automation features for updates | No, primarily manual updates required |",
      "| Slack | Yes | Yes | Limited integration options for Slack |",
    ].join("\n"),
  );
  const tableViolations = detectUnsupportedCompetitorClaims({
    asset: unsupportedTable,
    evidenceBank: eb,
    competitors: [jira, notion],
    fixBriefs: [fixBrief()],
    resolvedCompetitorMentions: toResolvedMentions(probeResult()),
  });
  check(
    "unsupported Jira/Notion table cells fail competitor guard",
    tableViolations.some(
      (v) =>
        v.type === "unsupported_claim" &&
        v.quote.includes("Limited automation"),
    ) &&
      tableViolations.some(
        (v) =>
          v.type === "unsupported_claim" &&
          v.quote.includes("Limited integration"),
      ),
  );

  const placeholdersOnly = asset(
    "comparison_table",
    [
      "| Feature | Linear | Jira | Notion |",
      "|---|---|---|---|",
      "| Automated updates | Yes | [EVIDENCE NEEDED: Jira automation evidence] | [EVIDENCE NEEDED: Notion automation evidence] |",
    ].join("\n"),
  );
  check(
    "competitor placeholders pass competitor guard",
    detectUnsupportedCompetitorClaims({
      asset: placeholdersOnly,
      evidenceBank: eb,
      competitors: [jira, notion],
      fixBriefs: [fixBrief()],
      resolvedCompetitorMentions: toResolvedMentions(probeResult()),
    }).length === 0,
  );

  const neutral = asset(
    "comparison_page_outline",
    "# Linear vs Jira\n\n## Overview\n\n## Feature comparison\n\n## Next steps",
  );
  check(
    "neutral competitor mention passes competitor guard",
    detectUnsupportedCompetitorClaims({
      asset: neutral,
      evidenceBank: eb,
      competitors: [jira],
      fixBriefs: [fixBrief()],
      resolvedCompetitorMentions: toResolvedMentions(probeResult()),
    }).length === 0,
  );

  const neutralTitle = asset(
    "comparison_page_outline",
    "# Linear vs. Jira vs. Notion: A Comparison for Product Teams\n\n## Overview\n\n## Evidence Needed",
  );
  check(
    "H1 Linear vs Jira vs Notion title passes competitor guard",
    detectUnsupportedCompetitorClaims({
      asset: neutralTitle,
      evidenceBank: eb,
      competitors: [jira, notion],
      fixBriefs: [fixBrief()],
      resolvedCompetitorMentions: toResolvedMentions(probeResult()),
    }).length === 0,
  );

  const neutralFraming = asset(
    "comparison_page_outline",
    "This comparison outlines the key features of Linear, Jira, and Notion.\n\nChoosing the right tool depends on your team's needs.",
  );
  check(
    "neutral comparison framing sentence passes competitor guard",
    detectUnsupportedCompetitorClaims({
      asset: neutralFraming,
      evidenceBank: eb,
      competitors: [jira, notion],
      fixBriefs: [fixBrief()],
      resolvedCompetitorMentions: toResolvedMentions(probeResult()),
    }).length === 0,
  );

  const unsupportedProse = asset(
    "comparison_page_outline",
    "Jira has limited automation features. Notion has no Slack integration.",
  );
  const proseViolations = detectUnsupportedCompetitorClaims({
    asset: unsupportedProse,
    evidenceBank: eb,
    competitors: [jira, notion],
    fixBriefs: [fixBrief()],
    resolvedCompetitorMentions: toResolvedMentions(probeResult()),
  });
  check(
    "competitor capability prose is flagged",
    proseViolations.some((v) =>
      v.quote.includes("Jira has limited automation"),
    ) && proseViolations.some((v) => v.quote.includes("Notion has no Slack")),
  );

  check(
    "competitor table quote includes row label and full cell",
    tableViolations.some((v) =>
      v.quote.includes(
        "Jira / Automated updates: Limited automation features for updates",
      ),
    ),
  );

  const supported = asset(
    "comparison_table",
    [
      "| Feature | Linear | Jira |",
      "|---|---|---|",
      "| Automation rules | Project updates | Supports automation rules |",
    ].join("\n"),
  );
  const supportedBank = evidenceBank({
    provenance: "user_reviewed",
    allowedClaims: [
      "Linear powers over 33,000 product teams.",
      "Jira supports automation rules.",
    ],
  });
  check(
    "source-backed competitor claim passes competitor guard",
    detectUnsupportedCompetitorClaims({
      asset: supported,
      evidenceBank: supportedBank,
      competitors: [jira],
      fixBriefs: [fixBrief()],
      resolvedCompetitorMentions: toResolvedMentions(probeResult()),
    }).length === 0,
  );

  const merged = mergeQaViolations(
    {
      verdict: "safe_to_publish",
      violations: [],
      placeholdersRemaining: [],
      overallNotes: "Clean.",
    },
    tableViolations,
  );
  check(
    "competitor guard prevents safe_to_publish",
    merged.verdict === "unsupported_claims",
  );
}

function testSupportedClaimCounterCheck(): void {
  const llm: QaAgentOutput = {
    verdict: "unsupported_claims",
    violations: [
      {
        type: "fabrication",
        quote:
          "Linear is an AI product development platform for teams, supporting project management, product planning, issue tracking, and AI agent integration.",
        reason:
          "The description includes unsupported claims about the product's capabilities.",
        suggestedFix:
          "Remove or verify the specific claims about the platform's features.",
      },
    ],
    placeholdersRemaining: [],
    overallNotes: "LLM found one issue.",
  };
  const eb = evidenceBank({
    productDescription:
      "Linear is an AI product development platform for teams.",
    mainUseCases: [
      "Project management",
      "Product planning",
      "Issue tracking",
      "AI agent integration",
    ],
    allowedClaims: [
      "Linear is an AI product development platform for teams.",
      "Supports: Project management",
      "Supports: Product planning",
      "Supports: Issue tracking",
      "Supports: AI agent integration",
    ],
    provenance: "user_reviewed",
  });
  const downgraded = downgradeSupportedLlmViolations(llm, {
    evidenceBank: eb,
    mirrorProfile: mirrorProfile(),
  });
  check(
    "supported JSON-LD description LLM fabrication is downgraded",
    downgraded.violations.length === 0 &&
      downgraded.verdict === "safe_to_publish",
  );
  check(
    "downgraded supported LLM finding is preserved in notes",
    downgraded.overallNotes.includes("Non-blocking QA warning"),
  );

  const unsupported = downgradeSupportedLlmViolations(
    {
      ...llm,
      violations: [
        {
          type: "unsupported_claim",
          quote:
            "Linear seamlessly integrates with Slack to improve productivity.",
          reason: "Puffery and result claim are not supported.",
          suggestedFix: "Remove seamless/improve productivity or add evidence.",
        },
      ],
    },
    { evidenceBank: eb, mirrorProfile: mirrorProfile() },
  );
  check(
    "unsupported client puffery remains blocking",
    unsupported.violations.length === 1 &&
      unsupported.verdict === "unsupported_claims",
  );
}

function testEvidenceBankProvenanceCeiling(): void {
  const auto = detectEvidenceBankProvenanceCeiling(
    evidenceBank({ provenance: "auto_filled_from_mirror_profile" }),
  );
  check(
    "auto-filled Evidence Bank caps publishability",
    auto.some((v) => v.type === "quality"),
  );

  const edited = detectEvidenceBankProvenanceCeiling(
    evidenceBank({ provenance: "user_edited" }),
  );
  check(
    "edited but unreviewed Evidence Bank still caps publishability",
    edited.some((v) => v.type === "quality"),
  );

  const reviewed = detectEvidenceBankProvenanceCeiling(
    evidenceBank({ provenance: "user_reviewed" }),
  );
  check(
    "user-reviewed Evidence Bank does not cap publishability",
    reviewed.length === 0,
  );

  const merged = mergeQaViolations(
    {
      verdict: "safe_to_publish",
      violations: [],
      placeholdersRemaining: [],
      overallNotes: "Clean.",
    },
    auto,
  );
  check(
    "provenance cap recomputes verdict to needs_evidence",
    merged.verdict === "needs_evidence",
  );
}

function testSourcesCitedWiring(): void {
  const merged = mergeSourcesFromRawResponse(
    "According to G2, Jira is highly reviewed: https://www.g2.com/products/jira/reviews",
    [],
  );
  check(
    "mergeSourcesFromRawResponse extracts G2 URL",
    merged.some(
      (s) =>
        s.source.includes("g2.com/products/jira/reviews") &&
        s.type === "review_site",
    ),
  );

  const input = {
    mirrorProfile: mirrorProfile().json as SiteReaderOutput,
    probeResults: [probeResult({ sourcesCited: merged })],
    competitors: [competitor()],
    resolvedMentionsByProbeResult: new Map(),
  };
  const payload = buildGapMapUserMessageForTest(input);
  check(
    "Gap Map input payload contains sourcesCited",
    payload.includes('"sourcesCited"'),
  );
  check(
    "Gap Map input payload contains G2 cited source",
    payload.includes("g2.com/products/jira/reviews"),
  );
}

function testEvidenceBankProvenanceExport(): void {
  const profile = mirrorProfile().json as SiteReaderOutput;
  const prefill = buildEvidenceBankPrefill(profile);
  check(
    "Evidence Bank prefill provenance is auto_filled",
    prefill.provenance === "auto_filled_from_mirror_profile",
  );

  const eb = evidenceBank({ provenance: "auto_filled_from_mirror_profile" });
  const report = buildMvpReport({
    project: {
      id: projectId,
      userId: "user-1",
      companyName: null,
      domain: "linear.app",
      category: null,
      createdAt: now,
    },
    mirrorProfile: mirrorProfile(),
    prompts: [],
    probeResults: [probeResult()],
    resolvedMentionsByProbeResult: toResolvedMentionsByProbeResult([probeResult()]),
    competitors: [competitor()],
    gapMap: null,
    gaps: [],
    evidenceBank: eb,
    fixBriefs: [fixBrief()],
    assets: [],
    latestQaByAsset: new Map(),
    llmProvider: "openai",
    llmModel: "gpt-4o-mini",
    mockMode: false,
    now: new Date(now),
  });
  check(
    "export shows Evidence Bank provenance",
    report.markdown.includes(
      "**provenance**: `auto_filled_from_mirror_profile`",
    ),
  );
  check(
    "companyName fallback still works in Sprint 12 report",
    report.markdown.includes("**Brand**: Linear"),
  );
  check(
    "simulated probe appears in report",
    report.markdown.includes("Simulated Chatgpt-style probe"),
  );
}

async function testQaValidationResilience(): Promise<void> {
  const emptyNotes = QaAgentOutputSchema.parse({
    verdict: "unsupported_claims",
    violations: [
      {
        type: "fabrication",
        quote: "Proven track record",
        reason: "Vague proof language is not supported by the Evidence Bank.",
        suggestedFix: "Replace with a specific proof item.",
      },
    ],
    placeholdersRemaining: [],
    overallNotes: "",
  });
  check(
    "QA schema normalizes empty overallNotes",
    emptyNotes.overallNotes === "No additional notes.",
  );

  const fakeSchema = z.object({
    decision: z.enum(["ok"]),
    requiredText: z.string().min(1),
  });
  const parsed = await parseJsonOrRetry({
    schema: fakeSchema,
    rawOutput: JSON.stringify({ decision: "ok", requiredText: "" }),
    originalCall: {
      system: "Return JSON only.",
      user: "Return a test object.",
      jsonMode: true,
      provider: "mock",
      mockResponse: JSON.stringify({
        decision: "ok",
        requiredText: "fixed on retry",
      }),
    },
  });
  check(
    "Zod validation failure triggers one retry",
    parsed.ok && parsed.usedRetry,
  );
  check(
    "Zod-aware retry returns corrected JSON",
    parsed.ok && parsed.data.requiredText === "fixed on retry",
  );
}

function testLiveProbeReportSelection(): void {
  const simulatedLost = probeResult({
    id: "sim-lost",
    prompt: "Compare Linear vs Jira for issue tracking.",
    probeMode: "simulated",
    verdict: "lost",
    clientMentioned: false,
    clientPosition: "absent",
    createdAt: "2026-07-10T06:00:00.000Z",
  });
  const liveWon = probeResult({
    id: "live-won",
    prompt: "Compare Linear vs Jira for issue tracking.",
    platform: "perplexity",
    probeMode: "live_perplexity",
    verdict: "won",
    clientMentioned: true,
    clientPosition: "primary",
    answerSummary: "Linear was the primary recommendation.",
    whyClientLost: "",
    createdAt: "2026-07-10T07:00:00.000Z",
  });
  const staleGapMap: GapMapRow = {
    id: "gap-stale",
    projectId,
    json: { competitorDistances: [], prioritizedGaps: [] },
    createdAt: "2026-07-10T06:30:00.000Z",
  };
  const summary = buildProbeSetSummary([simulatedLost, liveWon], staleGapMap);
  check(
    "live probes drive main report when mixed with simulated",
    summary.includedMode === "live_perplexity" && summary.mainProbeResults.length === 1,
  );
  check(
    "same prompt simulated lost + live won counts as live won",
    summary.mainProbeResults[0]?.id === "live-won" && summary.historicalProbeResults[0]?.id === "sim-lost",
  );
  check("stale Gap Map detected after live probes", summary.gapMapStale);

  const report = buildMvpReport({
    project: {
      id: projectId,
      userId: "user-1",
      companyName: "Linear",
      domain: "linear.app",
      category: null,
      createdAt: now,
    },
    mirrorProfile: mirrorProfile(),
    prompts: [],
    probeResults: [simulatedLost, liveWon],
    resolvedMentionsByProbeResult: toResolvedMentionsByProbeResult([simulatedLost, liveWon]),
    competitors: [competitor()],
    gapMap: staleGapMap,
    gaps: [
      {
        id: "gap-1",
        projectId,
        competitorName: "Jira",
        type: "prompt_loss",
        severity: "high",
        explanation: "Old stale gap.",
        affectedPrompts: ["Compare Linear vs Jira for issue tracking."],
        suggestedFixDirection: "Regenerate with live probes.",
        createdAt: now,
      },
    ],
    evidenceBank: evidenceBank(),
    fixBriefs: [],
    assets: [],
    latestQaByAsset: new Map(),
    llmProvider: "openai",
    llmModel: "gpt-4o-mini",
    mockMode: false,
    now: new Date(now),
  });
  check(
    "mixed report Executive Summary uses live scorecard",
    report.markdown.includes("AI probe result (live Perplexity product-recommendation scorecard, 1 prompt / 1 run)**: 1 won · 0 partial · 0 lost · recommendedAsProduct 100% · citedAsSource 0%"),
  );
  check(
    "historical simulated probes are excluded from main summary",
    report.markdown.includes("Historical simulated probes excluded from main summary"),
  );
  check(
    "stale Gap Map warning appears in report",
    report.markdown.includes("Gap Map may be stale — regenerate after live probes"),
  );
}


function testSprint13A2ProbeAggregationAndDeterministicScores(): void {
  const unbrandedWon = probeResult({
    id: "live-unbranded-won-1",
    prompt: "Switching from Jira to a new project management tool?",
    generatedPromptId: "prompt-unbranded",
    platform: "perplexity",
    probeMode: "live_perplexity",
    verdict: "won",
    clientMentioned: true,
    clientPosition: "primary",
    sourcesCited: [{ source: "https://www.atlassian.com/software/jira", type: "vendor_site" }],
    createdAt: "2026-07-10T07:03:00.000Z",
  });
  const unbrandedLost = probeResult({
    id: "live-unbranded-lost-2",
    prompt: "Switching from Jira to a new project management tool?",
    generatedPromptId: "prompt-unbranded",
    platform: "perplexity",
    probeMode: "live_perplexity",
    verdict: "lost",
    clientMentioned: false,
    clientPosition: "absent",
    sourcesCited: [{ source: "https://www.atlassian.com/software/jira", type: "vendor_site" }],
    createdAt: "2026-07-10T07:02:00.000Z",
  });
  const brandedWon = probeResult({
    id: "live-branded-won",
    prompt: "Compare Linear vs Jira for issue tracking.",
    generatedPromptId: "prompt-branded",
    platform: "perplexity",
    probeMode: "live_perplexity",
    verdict: "won",
    clientMentioned: true,
    clientPosition: "primary",
    sourcesCited: [],
    createdAt: "2026-07-10T07:01:00.000Z",
  });

  const summary = buildProbeSetSummary([unbrandedWon, unbrandedLost, brandedWon], null, {
    brandTerms: ["Linear", "linear.app"],
  });
  check("multi-run rows are preserved for mentionRate", summary.mainProbeResults.length === 3);
  check("branded prompts are separated from unbranded scorecard", summary.unbrandedPromptGroups.length === 1 && summary.brandedPromptGroups.length === 1);
  check("scorecard uses unbranded prompt groups when available", summary.scorecardUsesUnbranded && summary.scorecardPromptGroups.length === 1);
  check("mentionRate is aggregated across runs", summary.scorecardPromptGroups[0]?.mentionRate === 0.5);

  const scores = computeGapScores({
    mirrorProfile: mirrorProfile().json as SiteReaderOutput,
    probeResults: [unbrandedWon, brandedWon],
    competitors: [competitor()],
    resolvedMentionsByProbeResult: toResolvedMentionsByProbeResult([unbrandedWon, brandedWon]),
  });
  check("deterministic prompt_loss stays zero when client wins", scores.Jira.prompt_loss === 0);
  check("deterministic review score stays zero without review_site sources", scores.Jira.review === 0);
  check("deterministic citation score is sourced from direct competitor URLs", scores.Jira.citation > 0);

  const scoresWithOneLostRunInWinningGroup = computeGapScores({
    mirrorProfile: mirrorProfile().json as SiteReaderOutput,
    probeResults: [unbrandedWon, unbrandedLost],
    competitors: [competitor()],
    resolvedMentionsByProbeResult: toResolvedMentionsByProbeResult([unbrandedWon, unbrandedLost]),
  });
  check(
    "prompt_loss is computed from aggregate prompt verdict, not a single volatile run",
    scoresWithOneLostRunInWinningGroup.Jira.prompt_loss === 0,
  );
}


async function testSprint13BAssetGenerationBenchmarkControls(): Promise<void> {
  process.env.ASSET_GENERATION_MODEL = "asset-prod-model-test";
  check(
    "asset generation model override is isolated to generate_asset",
    resolveGenerateAssetModelOverride() === "asset-prod-model-test",
  );
  delete process.env.ASSET_GENERATION_MODEL;
  check(
    "asset generation model override is optional",
    resolveGenerateAssetModelOverride() === undefined,
  );

  const bank = evidenceBank({
    productDescription: "Linear is an AI product development platform for teams.",
    proofItems: [
      {
        type: "case_study",
        detail: "OpenAI scaled to 3,000 users using Linear.",
        sourceUrl: "https://linear.app/customers/openai",
      },
      {
        type: "case_study",
        detail: "Ramp's internal coding agent authored over 60% of merged PRs.",
        sourceUrl: "https://linear.app/customers/ramp",
      },
    ],
    allowedClaims: [
      "OpenAI scaled to 3,000 users using Linear.",
      "Ramp's internal coding agent authored over 60% of merged PRs.",
      "Linear is an AI product development platform for teams.",
    ],
  }) as EvidenceBankOutput;
  const consolidationBrief: FixBriefRow = {
    ...fixBrief(),
    id: "fb-consolidation",
    lostPrompt: "Live scorecard consolidation: Linear appears in sampled unbranded prompts",
    competitorRecommended: "Jira, Asana, ClickUp",
    fixType: "proof_block",
    assetsToGenerate: ["proof_block", "faq_block", "json_ld_schema"],
    rootCause:
      "Linear is already appearing in the selected live scorecard prompt groups.",
    recommendedFix:
      "Consolidate the current AI shortlist position with reviewed proof blocks.",
  };

  const proof = buildMockGeneratedAsset({
    fixBrief: consolidationBrief,
    evidenceBank: bank,
    mirrorProfile: mirrorProfile().json as SiteReaderOutput,
    assetType: "proof_block",
  });
  check(
    "13B proof_block generation cites a real proof item",
    proof.content.includes("OpenAI scaled to 3,000 users") ||
      proof.content.includes("Ramp's internal coding agent"),
  );

  const faq = buildMockGeneratedAsset({
    fixBrief: consolidationBrief,
    evidenceBank: bank,
    mirrorProfile: mirrorProfile().json as SiteReaderOutput,
    assetType: "faq_block",
  });
  const faqQuestionCount = faq.content
    .split("\n")
    .filter((line) => line.trim().startsWith("### ") && line.trim().endsWith("?")).length;
  check("13B faq_block generation has 3+ real Q&A headings", faqQuestionCount >= 3);

  const table = buildMockGeneratedAsset({
    fixBrief: consolidationBrief,
    evidenceBank: bank,
    mirrorProfile: mirrorProfile().json as SiteReaderOutput,
    assetType: "comparison_table",
  });
  check(
    "13B comparison_table keeps competitor facts as placeholders",
    table.content.includes("[EVIDENCE NEEDED: neutral, verifiable statement about Jira, Asana, ClickUp]"),
  );

  const jsonLd = buildMockGeneratedAsset({
    fixBrief: consolidationBrief,
    evidenceBank: bank,
    mirrorProfile: mirrorProfile().json as SiteReaderOutput,
    assetType: "json_ld_schema",
  });
  const parsed = JSON.parse(jsonLd.content) as Record<string, unknown>;
  check("13B json_ld_schema remains valid JSON-LD", parsed["@context"] === "https://schema.org");
  check(
    "13B json_ld_schema does not invent ProductHunt URLs",
    !jsonLd.content.toLowerCase().includes("producthunt"),
  );
  check(
    "13B json_ld_schema does not invent fake ratings",
    !jsonLd.content.includes("aggregateRating") && !jsonLd.content.includes("ratingValue"),
  );

  const deterministic = await runGenerateAssetAgent({
    fixBrief: consolidationBrief,
    evidenceBank: bank,
    mirrorProfile: mirrorProfile().json as SiteReaderOutput,
    assetType: "json_ld_schema",
  });
  check(
    "13B.1 json_ld_schema uses deterministic template provider",
    deterministic.generationProvider === "deterministic" &&
      deterministic.generationModel === "json_ld_template_v1",
  );
}


function testSprint13B2LifecycleReportTruth(): void {
  const fb = { ...fixBrief(), id: "fb-active", status: "needs_evidence", assetsToGenerate: ["proof_block", "faq_block", "json_ld_schema"], evidenceNeeded: ["Human-review the Evidence Bank before publishing generated assets."] };
  const activeProof = asset("proof_block", "OpenAI scaled to 3,000 users using Linear.", { id: "asset-active-proof", fixBriefId: fb.id, qaStatus: "safe_to_publish", lifecycleStatus: "active" });
  const activeFaq = asset("faq_block", "### What is Linear?\nLinear powers over 33,000 product teams.", { id: "asset-active-faq", fixBriefId: fb.id, qaStatus: "safe_to_publish", lifecycleStatus: "active" });
  const activeJson = asset("json_ld_schema", JSON.stringify({ "@context": "https://schema.org", "@type": "SoftwareApplication", name: "Linear" }), { id: "asset-active-json", fixBriefId: fb.id, qaStatus: "safe_to_publish", lifecycleStatus: "active" });
  const oldBad = asset("json_ld_schema", '{"aggregateRating":{"ratingValue":"4.5"}}', { id: "asset-superseded-json", fixBriefId: fb.id, qaStatus: "unsupported_claims", lifecycleStatus: "superseded" });
  const qaReports = new Map<string, QaReportRow>();
  for (const a of [activeProof, activeFaq, activeJson]) qaReports.set(a.id, { id: `qa-${a.id}`, projectId, generatedAssetId: a.id, verdict: "safe_to_publish", violations: [], placeholdersRemaining: [], overallNotes: "OK", createdAt: now });
  qaReports.set(oldBad.id, { id: "qa-old-bad", projectId, generatedAssetId: oldBad.id, verdict: "unsupported_claims", violations: [{ type: "unsupported_number", quote: "4.5", reason: "fake rating", suggestedFix: "remove" }], placeholdersRemaining: [], overallNotes: "Blocked", createdAt: now });
  const report = buildMvpReport({ project: { id: projectId, userId: "user-1", companyName: "Linear", domain: "linear.app", category: null, createdAt: now }, mirrorProfile: mirrorProfile(), prompts: [], probeResults: [], resolvedMentionsByProbeResult: new Map(), competitors: [], gapMap: null, gaps: [], evidenceBank: { ...evidenceBank(), provenance: "user_reviewed" }, fixBriefs: [fb], assets: [activeProof, activeFaq, activeJson, oldBad], latestQaByAsset: qaReports, llmProvider: "openai", llmModel: "gpt-4o-mini", mockMode: false, now: new Date(now) });
  check("13B.2 current publishability ignores superseded bad assets", report.publishability.total === 3 && report.publishability.publishReady === 3);
  check("13B.2 superseded assets remain auditable", report.markdown.includes("### Superseded assets (1)") && report.markdown.includes("asset-superseded-json"));
  check("13B.2 Fix Brief derives assets_ready from requested safe types", report.markdown.includes("status: **assets_ready**"));
  check("13B.2 reviewed Evidence Bank removes human-review from current evidence blockers", !report.markdown.includes("Human-review the Evidence Bank before publishing generated assets."));
}

function testQaFailedExportState(): void {
  const failed = asset("comparison_page_outline", "# Outline\n\n## A\n\n## B", {
    id: "asset-qa-failed",
    qaStatus: "qa_failed",
  });
  const report = buildMvpReport({
    project: {
      id: projectId,
      userId: "user-1",
      companyName: "Linear",
      domain: "linear.app",
      category: null,
      createdAt: now,
    },
    mirrorProfile: mirrorProfile(),
    prompts: [],
    probeResults: [probeResult()],
    resolvedMentionsByProbeResult: toResolvedMentionsByProbeResult([probeResult()]),
    competitors: [competitor()],
    gapMap: null,
    gaps: [],
    evidenceBank: evidenceBank(),
    fixBriefs: [fixBrief()],
    assets: [failed],
    latestQaByAsset: new Map(),
    llmProvider: "openai",
    llmModel: "gpt-4o-mini",
    mockMode: false,
    now: new Date(now),
  });
  check(
    "qa_failed is counted as not ready",
    report.warnings.notReadyAssetCount === 1,
  );
  check(
    "export groups qa_failed assets",
    report.markdown.includes("### QA failed (1)"),
  );
  check(
    "export explains QA did not complete",
    report.markdown.includes("QA did not complete"),
  );
}

function testSprint13CCommercialScorecardIntegrity(): void {
  const sourceOnly = classifyProductRecommendation({
    prompt: "best AI visibility tools for B2B SaaS teams",
    rawResponse: [
      "The best options are Profound, Otterly, and Peec AI for AI visibility monitoring.",
      "",
      "Perplexity citations:",
      "- https://zypact.com/blog",
    ].join("\n"),
    brandTerms: ["Zypact", "zypact.com"],
    domain: "zypact.com",
    competitorsMentioned: [
      { name: "Profound", position: 1, context: "recommended" },
      { name: "Otterly", position: 2, context: "recommended" },
      { name: "Perplexity", position: 3, context: "platform referenced" },
    ],
    sourcesCited: [{ source: "https://zypact.com/blog", type: "vendor_site" }],
  });
  check("13C source citation is not product recommendation", !sourceOnly.productMentioned && sourceOnly.citedAsSource && sourceOnly.productVerdict === "lost");
  check("13C AI platforms are split away from competitors", sourceOnly.platformReferences.includes("Perplexity") && sourceOnly.directCompetitorsMentioned.length === 2);

  const request = "best AI visibility tools for B2B SaaS teams";
  check(
    "13C raw probe request has no hidden client identity",
    !probeRequestLeaksClientIdentity({ rawRequest: request, originalPrompt: request, brandTerms: ["Zypact"], domain: "zypact.com" }),
  );
  check(
    "13C raw probe request leak is detected",
    probeRequestLeaksClientIdentity({ rawRequest: `${request}\nThe brand being audited is Zypact (zypact.com).`, originalPrompt: request, brandTerms: ["Zypact"], domain: "zypact.com" }),
  );

  const prompts = [
    { id: 1, prompt: "How to improve my brand's AI visibility strategy?", intentType: "use_case", commercialValue: 5, winnability: 5, priority: 25, rationale: "easy" },
    { id: 2, prompt: "Why is my brand not being cited by AI systems?", intentType: "problem_aware", commercialValue: 5, winnability: 5, priority: 25, rationale: "easy" },
    { id: 3, prompt: "best AI visibility tools for B2B SaaS teams", intentType: "best_tools", commercialValue: 5, winnability: 2, priority: 10, rationale: "commercial" },
    { id: 4, prompt: "Profound alternatives for small SaaS teams", intentType: "alternatives", commercialValue: 5, winnability: 2, priority: 10, rationale: "commercial" },
    { id: 5, prompt: "compare Profound vs Otterly for AI visibility", intentType: "comparison", commercialValue: 5, winnability: 2, priority: 10, rationale: "commercial" },
  ];
  const selected = selectCommercialProbePromptIds(prompts as any, [1, 2], { max: 5 });
  check("13C prompt selection forces best_tools", selected.includes(3));
  check("13C prompt selection forces alternatives", selected.includes(4));
  check("13C prompt selection forces comparison", selected.includes(5));
  check("13C registry excludes AI platforms as competitors", isAiPlatformName("ChatGPT") && isAiPlatformName("Google AI Overviews") && !isAiPlatformName("Semrush"));

  const negativeVugio = classifyProductRecommendation({
    prompt: "Compare Vugio vs Adorama for purchasing studio products.",
    rawResponse: [
      "Vugio is likely non-existent or misnamed and does not have a credible reputation as a retailer for studio products.",
      "Adorama is recommended as a top choice due to its established reputation and extensive offerings.",
    ].join(" "),
    brandTerms: ["Vugio", "vugio.com"],
    domain: "vugio.com",
    clientPosition: "negative",
    competitorsMentioned: [{ name: "Adorama", position: 1, context: "recommended as a well-established retailer" }],
    sourcesCited: [],
  });
  check("14A.1 negative mention is not product recommendation", !negativeVugio.productMentioned && negativeVugio.productPosition === "negative");
  check("14A.1 negative mention verdict is never won", negativeVugio.productVerdict === "lost");

  const listedBrand = classifyProductRecommendation({
    prompt: "Compare Tool A vs Vugio",
    rawResponse: "Vugio is listed as one option alongside Tool A.",
    brandTerms: ["Vugio", "vugio.com"],
    domain: "vugio.com",
    clientPosition: "listed",
    competitorsMentioned: [{ name: "Tool A", position: 1, context: "listed" }],
    sourcesCited: [],
  });
  check("14A.1 listed mention remains product recommendation", listedBrand.productMentioned && listedBrand.productPosition === "listed" && listedBrand.productVerdict === "partial");

  const vugioProbeResultsFixture = [
      probeResult({
        id: "vugio-branded-1",
        platform: "perplexity",
        probeMode: "live_perplexity",
        prompt: "Compare Vugio vs Adorama for purchasing studio products.",
        rawProbeRequest: "Compare Vugio vs Adorama for purchasing studio products.",
        clientMentioned: true,
        clientPosition: "negative",
        productPosition: "primary",
        productVerdict: "won",
        recommendedAsProduct: true,
        answerSummary: "Vugio is likely non-existent or misnamed and does not have a credible reputation as a retailer for studio products.",
        verdict: "won",
        whyClientLost: "Vugio was mentioned negatively.",
        createdAt: "2026-07-10T17:10:00.000Z",
      } as Partial<ProbeResult>),
      probeResult({
        id: "vugio-branded-2",
        platform: "perplexity",
        probeMode: "live_perplexity",
        prompt: "Compare Vugio vs Adorama for purchasing studio products.",
        rawProbeRequest: "Compare Vugio vs Adorama for purchasing studio products.",
        clientMentioned: true,
        clientPosition: "negative",
        productPosition: "listed",
        productVerdict: "partial",
        recommendedAsProduct: true,
        answerSummary: "Vugio is likely a non-existent or obscure entity and should be verified for legitimacy before purchasing.",
        verdict: "partial",
        whyClientLost: "Vugio was mentioned negatively.",
        createdAt: "2026-07-10T17:11:00.000Z",
      } as Partial<ProbeResult>),
      probeResult({
        id: "vugio-unbranded-lost",
        platform: "perplexity",
        probeMode: "live_perplexity",
        prompt: "Alternatives to Adorama for studio equipment?",
        rawProbeRequest: "Alternatives to Adorama for studio equipment?",
        clientMentioned: false,
        clientPosition: "absent",
        answerSummary: "B&H Photo and KEH Camera were recommended.",
        verdict: "lost",
        whyClientLost: "Vugio was absent.",
        createdAt: "2026-07-10T17:12:00.000Z",
      }),
  ];
  const vugioReport = buildMvpReport({
    project: {
      id: projectId,
      userId: "user-1",
      companyName: "Vugio",
      domain: "vugio.com",
      category: "B2C e-commerce",
      createdAt: now,
    },
    mirrorProfile: null,
    prompts: [],
    probeResults: vugioProbeResultsFixture,
    resolvedMentionsByProbeResult: toResolvedMentionsByProbeResult(vugioProbeResultsFixture),
    competitors: [competitor()],
    gapMap: null,
    gaps: [],
    evidenceBank: evidenceBank(),
    fixBriefs: [],
    assets: [],
    latestQaByAsset: new Map(),
    llmProvider: "openai",
    llmModel: "gpt-4o-mini",
    mockMode: false,
    now: new Date(now),
  });
  check("14A.2 negative branded probe header uses derived product verdict", vugioReport.markdown.includes("product verdict: **lost**") && !vugioReport.markdown.includes("verdict: **won**") && !vugioReport.markdown.includes("verdict: **partial**"));
  check("14A.2 renderer does not expose legacy probe fields", !vugioReport.markdown.includes("legacy clientPosition") && !vugioReport.markdown.includes("legacy clientMentioned") && !vugioReport.markdown.includes("legacy mentionRate"));
  check("14A.2 branded reputation risk is reported as run count", vugioReport.markdown.includes("Branded reputation**: at risk (2/2 branded runs negative)") && vugioReport.markdown.includes("2/2 branded runs mentioned Vugio negatively"));

}


async function main(): Promise<void> {
  await testProbeModePersistenceAsync();
  await testLivePerplexityProbeMode();
  await testPerplexityProbeResponseShape();
  testLivePerplexityExportLabels();
  await testQaValidationResilience();
  testUrlFabricationGuard();
  testAssetTypeConformity();
  testCompetitorClaimIntegrity();
  testSupportedClaimCounterCheck();
  testEvidenceBankProvenanceCeiling();
  testSourcesCitedWiring();
  testEvidenceBankProvenanceExport();
  testLiveProbeReportSelection();
  testSprint13A2ProbeAggregationAndDeterministicScores();
  await testSprint13BAssetGenerationBenchmarkControls();
  testSprint13B2LifecycleReportTruth();
  testSprint13CCommercialScorecardIntegrity();
  testQaFailedExportState();

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0
        ? "Sprint 13 pipeline integrity unit scenario PASSED."
        : "Sprint 13 pipeline integrity unit scenario FAILED."),
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(2);
});
