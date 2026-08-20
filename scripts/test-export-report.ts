#!/usr/bin/env tsx
/**
 * Sprint 11 + 11.5 unit tests for `lib/export/build-mvp-report.ts`.
 *
 * Coverage:
 *   Fence / secret sweep (Sprint 11)
 *     - `computeDynamicFence` scales past nested backtick runs
 *     - `wrapAssetContent` survives nested ```json blocks
 *     - `redactSensitive` catches literal values + known prefixes
 *   Section structure (Sprint 11.5)
 *     - Every section in `REPORT_SECTIONS` appears in the report body
 *     - Executive Summary appears at the top and technical metadata is
 *       moved into a final "Appendix — Technical metadata" section
 *     - Assets are grouped by publish status
 *     - NOT READY blockquotes carry the QA-context tagline
 *     - "What this means" plain-English section renders after probes
 *     - Recommended Next Actions produces concrete website actions
 *   Sprint 12 honesty rule (display only)
 *     - Every probe reference is labeled `Simulated <Platform>-style probe`
 *     - Metadata explicitly says "probe origin: simulated"
 *   companyName fallback (Sprint 11.5 + Sprint 12 test hook)
 *     - `resolveCompanyName` falls back from project → mirrorProfile → domain
 *     - Report brand line reflects the fallback source
 *   Read-only invariant preserved from Sprint 11
 */

delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.LLM_PROVIDER;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_MODEL;

import {
  buildMvpReport,
  computeDynamicFence,
  longestBacktickRun,
  redactSensitive,
  resolveCompanyName,
  simulatedProbeLabel,
  deriveProbeMode,
  aggregateEvidenceNeeded,
  gapToRecommendedAction,
  wrapAssetContent,
  REDACTED_MARKER,
  REPORT_SECTIONS,
} from "@/lib/export/build-mvp-report";
import type {
  BuildMvpReportInput,
} from "@/lib/export/build-mvp-report";
import type {
  Project,
  MirrorProfileRow,
  GeneratedPrompt,
  ProbeResult,
  Competitor,
  GapMapRow,
  Gap,
  EvidenceBankRow,
  FixBriefRow,
  GeneratedAssetRow,
  QaReportRow,
} from "@/lib/db/types";
import type { ResolvedCompetitorMention } from "@/lib/evidence/get-resolved-competitor-mentions";

let checks = 0;
let failures = 0;

function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) {
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * M3 — simulates the M2 canonical layer's own output for a fixture
 * probe_result's `competitorsMentioned`, the same way
 * scripts/test-scorecard-competitors.ts does: the same (trimmed,
 * lowercased) name always resolves to the same canonical_entity_id.
 * Used only to build `resolvedMentionsByProbeResult` for `buildMvpReport`,
 * which no longer reads `probeResults[].competitorsMentioned` directly.
 */
function toResolvedMentionsByProbeResult(
  probes: readonly ProbeResult[]
): ReadonlyMap<string, ResolvedCompetitorMention[]> {
  return new Map(
    probes.map((pr) => {
      const mentions = Array.isArray(pr.competitorsMentioned)
        ? (pr.competitorsMentioned as Array<{ name?: unknown; position?: unknown; context?: unknown }>)
        : [];
      const resolved: ResolvedCompetitorMention[] = [];
      for (const m of mentions) {
        if (typeof m.name !== "string") continue;
        resolved.push({
          canonicalEntityId: `canonical:${m.name.trim().toLowerCase()}`,
          rawText: m.name,
          normalizedText: m.name.trim().toLowerCase(),
          mentionOrdinal: typeof m.position === "number" ? m.position : 1,
          context: typeof m.context === "string" ? m.context : null,
          generatedPromptId: pr.generatedPromptId ?? null,
        });
      }
      return [pr.id, resolved] as const;
    })
  );
}

/* -------------------------------------------------------------------------- */
/*  Dynamic fence                                                              */
/* -------------------------------------------------------------------------- */

function testFence(): void {
  check("longestBacktickRun('no backticks') === 0", longestBacktickRun("no backticks") === 0);
  check("longestBacktickRun('```code```') === 3", longestBacktickRun("```code```") === 3);
  check("longestBacktickRun('`````') === 5", longestBacktickRun("`````") === 5);

  check("floor is 4 backticks", computeDynamicFence("plain text").length === 4);
  check("dyn fence for ```` is 5", computeDynamicFence("````").length === 5);
  check("dyn fence for ````` is 6", computeDynamicFence("`````").length === 6);

  const nested = ["# Nested", "", "```json", '{ "foo": "bar" }', "```", "", "prose"].join("\n");
  const wrapped = wrapAssetContent(nested, "asset-markdown");
  check("wrapped opening declares info string", wrapped.split("\n")[0].endsWith("asset-markdown"));

  const spicy = "hello ```` fence inside";
  const spicyWrap = wrapAssetContent(spicy, "asset-markdown");
  check(
    "wrapper scales to 5 for 4-backtick content",
    spicyWrap.startsWith("`````asset-markdown\n") && spicyWrap.endsWith("\n`````")
  );

  const spicier = "hello ````` fence inside";
  const spicierWrap = wrapAssetContent(spicier, "json");
  check(
    "wrapper scales to 6 for 5-backtick content",
    spicierWrap.startsWith("``````json\n") && spicierWrap.endsWith("\n``````")
  );
}

/* -------------------------------------------------------------------------- */
/*  Secret sweep                                                               */
/* -------------------------------------------------------------------------- */

function testRedactSensitive(): void {
  const secret1 = "sb_secret_ABCDEFGHIJKLMNO1234567";
  const secret2 = ["sk", "live", "XYZABCDEFGHIJKL1234567"].join("-");
  const secret3 = ["sk", "proj", "abcd1234efgh5678ijkl9012"].join("-");
  const noise = "This is a normal paragraph.";
  const raw = [noise, secret1, secret2, secret3].join("\n\n");
  const { output, redactionCount } = redactSensitive(raw, [secret1, secret2]);
  check("explicit secret values are replaced", !output.includes(secret1) && !output.includes(secret2));
  check("prefix sweep catches sk-proj-", !output.includes(secret3));
  check(">= 3 redactions applied", redactionCount >= 3, `count=${redactionCount}`);
  check("redacted marker is present", output.includes(REDACTED_MARKER));
  check("innocuous prose preserved", output.includes(noise));
  const trivial = "ok";
  const { output: tOut, redactionCount: tCount } = redactSensitive(trivial, ["ok"]);
  check("short values ignored", tOut === trivial && tCount === 0);
}

/* -------------------------------------------------------------------------- */
/*  companyName fallback                                                       */
/* -------------------------------------------------------------------------- */

function testCompanyNameFallback(): void {
  const mkProject = (companyName: string | null): Project => ({
    id: "p1",
    userId: "u1",
    companyName,
    domain: "https://acme.example.com",
    category: null,
    createdAt: "2026-07-10T00:00:00.000Z",
  });
  const mkMirror = (companyName: unknown): MirrorProfileRow => ({
    id: "mp1",
    projectId: "p1",
    json: { companyName },
    createdAt: "2026-07-10T00:00:00.000Z",
  });

  // 1. project.companyName wins
  const r1 = resolveCompanyName(mkProject("Acme Corp"), mkMirror("Should not be used"));
  check("project.companyName wins", r1.name === "Acme Corp" && r1.source === "project");

  // 2. missing project.companyName falls back to mirror
  const r2 = resolveCompanyName(mkProject(null), mkMirror("Linear"));
  check("falls back to mirrorProfile.companyName", r2.name === "Linear" && r2.source === "mirror_profile");

  // 3. missing both falls back to domain
  const r3 = resolveCompanyName(mkProject(null), mkMirror(""));
  check("falls back to domain", r3.name === "https://acme.example.com" && r3.source === "domain");

  // 4. no mirror profile at all
  const r4 = resolveCompanyName(mkProject(null), null);
  check("no mirror profile → domain", r4.name === "https://acme.example.com" && r4.source === "domain");
}

/* -------------------------------------------------------------------------- */
/*  Simulated probe honesty                                                    */
/* -------------------------------------------------------------------------- */

function testSimulatedProbeHonesty(): void {
  check(
    "deriveProbeMode returns simulated (no probeMode column exists yet)",
    deriveProbeMode(null) === "simulated"
  );
  check(
    "simulatedProbeLabel builds a plain-English phrase",
    simulatedProbeLabel("chatgpt") === "Simulated Chatgpt-style probe"
  );
  check(
    "simulatedProbeLabel preserves platform casing seed",
    simulatedProbeLabel("perplexity") === "Simulated Perplexity-style probe"
  );
}

/* -------------------------------------------------------------------------- */
/*  Recommended actions                                                        */
/* -------------------------------------------------------------------------- */

function testGapToRecommendedAction(): void {
  const mk = (type: string, competitorName: string | null = "Jira"): Gap => ({
    id: `g-${type}`,
    projectId: "p1",
    competitorName,
    type,
    severity: "high",
    explanation: "e",
    affectedPrompts: [],
    suggestedFixDirection: "Enhance SEO",
    createdAt: "2026-07-10T00:00:00.000Z",
  });
  check(
    "comparison_content → concrete comparison page action",
    gapToRecommendedAction(mk("comparison_content"), "Acme").includes(
      "comparison page: **Acme vs Jira**"
    )
  );
  check(
    "prompt_loss → FAQ block action",
    gapToRecommendedAction(mk("prompt_loss"), "Acme").includes("FAQ answers")
  );
  check(
    "proof → proof block action",
    gapToRecommendedAction(mk("proof"), "Acme").includes("proof blocks")
  );
  check(
    "citation → third-party review action",
    gapToRecommendedAction(mk("citation"), "Acme").includes("third-party reviews")
  );
  check(
    "entity_clarity → JSON-LD action",
    gapToRecommendedAction(mk("entity_clarity"), "Acme").includes("JSON-LD schema markup")
  );
  check(
    "pricing → pricing evidence action",
    gapToRecommendedAction(mk("pricing"), "Acme").includes("pricing evidence")
  );
  check(
    "unknown gap type falls back to suggestedFixDirection",
    gapToRecommendedAction(mk("unknown-fictional-type"), "Acme").includes("Enhance SEO")
  );
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function makeFixtures(opts: {
  ownerId: string;
  spicyAssetContent: string;
  jsonLdContent: string;
  projectCompanyName?: string | null;
  mirrorCompanyName?: string;
  categoryConfidence?: string;
  detectedCategory?: string;
}): BuildMvpReportInput {
  const now = new Date("2026-07-10T01:30:00.000Z");
  const projectId = "11111111-1111-1111-1111-111111111111";
  const project: Project = {
    id: projectId,
    userId: opts.ownerId,
    // `??` would turn an explicit `null` into "Acme Corp" — the fallback
    // test needs `null` to reach the builder verbatim.
    companyName:
      opts.projectCompanyName === undefined ? "Acme Corp" : opts.projectCompanyName,
    domain: "https://acme.example.com",
    category: "AI product development platform for teams",
    createdAt: now.toISOString(),
  };
  const mirrorProfile: MirrorProfileRow = {
    id: "mp-1",
    projectId,
    json: {
      companyName: opts.mirrorCompanyName ?? "Acme Corp",
      website: "https://acme.example.com",
      detectedCategory:
        opts.detectedCategory ?? "AI product development platform for teams",
      categoryConfidence: opts.categoryConfidence ?? "high",
      targetAudience: ["Product managers"],
      useCases: ["Async issue tracking"],
      features: ["Cycle boards"],
      painPointsAddressed: ["Manual triage"],
      claims: [{ claim: "Faster shipping", sourceUrl: "/home", hasProof: false }],
      proofSignals: [
        { type: "customer", detail: "Vercel uses Acme", sourceUrl: "/customers" },
      ],
      competitorsMentioned: ["Jira", "Height"],
      missingSignals: [
        { signal: "SOC2", whyItMatters: "Enterprise trust" },
        { signal: "Pricing calculator", whyItMatters: "Buyer clarity" },
        { signal: "Case study PDFs", whyItMatters: "Sales enablement" },
      ],
      buyerIntentAngles: ["Alternative to Jira"],
      aiReadabilityNotes: "Site copy is scannable.",
    },
    createdAt: now.toISOString(),
  };
  const prompts: GeneratedPrompt[] = Array.from({ length: 3 }).map((_, i) => ({
    id: `prompt-${i}`,
    projectId,
    prompt: `Best tools for prompt ${i}`,
    intentType: "best_tools",
    commercialValue: 5,
    winnability: 4,
    priority: 20,
    rationale: "test",
    selected: i === 0,
    createdAt: now.toISOString(),
  }));
  const probeResults: ProbeResult[] = [
    {
      id: "probe-1",
      probeRunId: "run-1",
      projectId,
      generatedPromptId: prompts[0].id,
      prompt: prompts[0].prompt,
      platform: "chatgpt",
      probeMode: "simulated",
      rawResponse: "raw",
      clientMentioned: false,
      clientPosition: "absent",
      competitorsMentioned: [
        { name: "Jira", position: 1, context: "AI recommended Jira" },
        { name: "Height", position: 2, context: "AI mentioned Height as an alternative" },
      ],
      sourcesCited: [{ source: "G2", type: "review_site" }],
      answerSummary: "AI recommends Jira and Height, no Acme mention.",
      verdict: "lost",
      whyClientLost: "Acme absent from AI answer.",
      createdAt: now.toISOString(),
    },
    {
      id: "probe-2",
      probeRunId: "run-1",
      projectId,
      generatedPromptId: prompts[1].id,
      prompt: prompts[1].prompt,
      platform: "perplexity",
      probeMode: "simulated",
      rawResponse: "raw",
      clientMentioned: true,
      clientPosition: "listed",
      competitorsMentioned: [
        { name: "Jira", position: 1, context: "Perplexity recommended Jira first" },
      ],
      sourcesCited: [],
      answerSummary: "Perplexity listed Acme second after Jira.",
      verdict: "partial",
      whyClientLost: "Ranked below Jira.",
      createdAt: now.toISOString(),
    },
  ];
  const competitors: Competitor[] = [
    {
      id: "comp-1",
      projectId,
      name: "Jira",
      website: "https://atlassian.com/jira",
      discoverySource: "user",
      mentionCount: 3,
      promptIds: [],
      threatLevel: "high",
      confidence: "verified",
      isPhantom: false,
      isBlindSpot: false,
      canonicalEntityId: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: "comp-2",
      projectId,
      name: "Height",
      website: null,
      discoverySource: "ai_answer",
      mentionCount: 1,
      promptIds: [],
      threatLevel: "medium",
      confidence: "unverified",
      isPhantom: true,
      isBlindSpot: false,
      canonicalEntityId: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
  ];
  const gapMap: GapMapRow = {
    id: "gm-1",
    projectId,
    json: {
      competitorDistances: [
        {
          competitor: "Jira",
          recommendationDistance: 24,
          gapScores: {
            prompt_loss: 5,
            citation: 4,
            review: 3,
            comparison_content: 4,
            proof: 4,
            entity_clarity: 4,
          },
          topReasons: ["Missing comparison"],
          evidenceStrength: "moderate",
        },
      ],
      prioritizedGaps: [],
    },
    createdAt: now.toISOString(),
  };
  const gaps: Gap[] = [
    {
      id: "gap-1",
      projectId,
      competitorName: "Jira",
      type: "comparison_content",
      severity: "high",
      explanation: "Missing comparison page for Acme vs Jira.",
      affectedPrompts: [prompts[0].id],
      suggestedFixDirection: "Enhance SEO and content marketing strategies.",
      createdAt: now.toISOString(),
    },
    {
      id: "gap-2",
      projectId,
      competitorName: "Jira",
      type: "citation",
      severity: "medium",
      explanation: "No third-party review citations.",
      affectedPrompts: [prompts[1].id],
      suggestedFixDirection: "Improve visibility.",
      createdAt: now.toISOString(),
    },
  ];
  const evidenceBank: EvidenceBankRow = {
    id: "eb-1",
    projectId,
    productDescription: "Acme is an issue tracker for high-velocity teams.",
    targetAudience: ["PMs"],
    mainUseCases: ["Issue tracking"],
    features: [{ name: "Cycles", description: "Time-boxed sprints" }],
    proofItems: [{ type: "customer", detail: "Vercel" }],
    competitors: ["Jira", "Height"],
    allowedClaims: ["Async-first"],
    forbiddenClaims: ["guaranteed rankings", "guaranteed AI mentions", "guaranteed citations"],
    tone: "confident",
    notes: "",
    provenance: "auto_filled_from_mirror_profile",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const fixBriefs: FixBriefRow[] = [
    {
      id: "fb-1",
      projectId,
      gapId: gaps[0].id,
      probeResultId: probeResults[0].id,
      lostPrompt: prompts[0].prompt,
      competitorRecommended: "Jira",
      rootCause: "No comparison content.",
      recommendedFix: "Publish Acme vs Jira comparison page.",
      fixType: "comparison_page",
      assetsToGenerate: ["comparison_page_outline"],
      evidenceNeeded: ["pricing information", "third-party review URL"],
      evidenceAvailable: ["Customer list"],
      priority: 1,
      expectedImpact: "Recover 10+ lost prompts.",
      status: "ready_for_assets",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
  ];

  const spicyAsset: GeneratedAssetRow = {
    id: "asset-needs-evidence",
    projectId,
    fixBriefId: fixBriefs[0].id,
    assetType: "comparison_page_outline",
    title: "Acme vs Jira — comparison outline",
    content: opts.spicyAssetContent,
    placeholders: [],
    claimsUsed: [{ claim: "Async-first", source: "evidence_bank" }],
    qaStatus: "needs_evidence",
    lifecycleStatus: "active",
    generationProvider: "mock",
    generationModel: "mock",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const jsonLdAsset: GeneratedAssetRow = {
    id: "asset-pending",
    projectId,
    fixBriefId: fixBriefs[0].id,
    assetType: "json_ld_schema",
    title: "JSON-LD FAQPage schema",
    content: opts.jsonLdContent,
    placeholders: [],
    claimsUsed: [],
    qaStatus: "pending_qa",
    lifecycleStatus: "active",
    generationProvider: "mock",
    generationModel: "mock",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const safeAsset: GeneratedAssetRow = {
    id: "asset-safe",
    projectId,
    fixBriefId: fixBriefs[0].id,
    assetType: "faq_block",
    title: "Acme FAQ block",
    content: "## FAQ\n\n**Is Acme async-first?** Yes.",
    placeholders: [],
    claimsUsed: [],
    qaStatus: "safe_to_publish",
    lifecycleStatus: "active",
    generationProvider: "mock",
    generationModel: "mock",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const unsupportedAsset: GeneratedAssetRow = {
    id: "asset-unsupported",
    projectId,
    fixBriefId: fixBriefs[0].id,
    assetType: "proof_block",
    title: "Acme proof block",
    content: "Trusted by thousands (uh oh).",
    placeholders: [],
    claimsUsed: [],
    qaStatus: "unsupported_claims",
    lifecycleStatus: "active",
    generationProvider: "mock",
    generationModel: "mock",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const assets: GeneratedAssetRow[] = [spicyAsset, jsonLdAsset, safeAsset, unsupportedAsset];

  const latestQaByAsset = new Map<string, QaReportRow>();
  latestQaByAsset.set(spicyAsset.id, {
    id: "qa-1",
    projectId,
    generatedAssetId: spicyAsset.id,
    verdict: "needs_evidence",
    violations: [
      {
        type: "quality",
        quote: "Async-first",
        reason: "Needs example.",
        suggestedFix: "Add case study.",
      },
    ],
    placeholdersRemaining: ["[EVIDENCE NEEDED: third-party review]"],
    overallNotes: "Add third-party evidence.",
    createdAt: now.toISOString(),
  });
  latestQaByAsset.set(safeAsset.id, {
    id: "qa-2",
    projectId,
    generatedAssetId: safeAsset.id,
    verdict: "safe_to_publish",
    violations: [],
    placeholdersRemaining: [],
    overallNotes: "Clean.",
    createdAt: now.toISOString(),
  });
  latestQaByAsset.set(unsupportedAsset.id, {
    id: "qa-3",
    projectId,
    generatedAssetId: unsupportedAsset.id,
    verdict: "unsupported_claims",
    violations: [
      {
        type: "forbidden_claim",
        quote: "Trusted by thousands",
        reason: "Forbidden claim per Evidence Bank.",
        suggestedFix: "Remove the claim.",
      },
    ],
    placeholdersRemaining: [],
    overallNotes: "Trim the claim.",
    createdAt: now.toISOString(),
  });

  return {
    project,
    mirrorProfile,
    prompts,
    probeResults,
    resolvedMentionsByProbeResult: toResolvedMentionsByProbeResult(probeResults),
    competitors,
    gapMap,
    gaps,
    evidenceBank,
    fixBriefs,
    assets,
    latestQaByAsset,
    llmProvider: "openai",
    llmModel: "gpt-4o-mini",
    mockMode: false,
    now,
  };
}

/* -------------------------------------------------------------------------- */
/*  Full report render                                                         */
/* -------------------------------------------------------------------------- */

function testFullReport(): void {
  const jsonLd = ["{", '  "@context": "https://schema.org",', '  "@type": "FAQPage"', "}"].join("\n");
  const spicy = [
    "# H1",
    "",
    "```json",
    jsonLd,
    "```",
    "",
    "Prose with `inline` and ```triple```.",
    "",
    "```md",
    "nested",
    "```",
  ].join("\n");

  const input = makeFixtures({
    ownerId: "user-alice",
    spicyAssetContent: spicy,
    jsonLdContent: jsonLd,
  });

  const snapshotJson = JSON.stringify(input, mapReplacer);
  const savedMapSize = input.latestQaByAsset.size;

  const { markdown, filename, qaDistribution, publishability, warnings } = buildMvpReport(input);

  // All 19 section headings appear.
  for (const s of REPORT_SECTIONS) {
    check(`report contains "${s}"`, markdown.includes(`## ${s}`));
  }

  // Executive Summary is first, appendix is last.
  const execIdx = markdown.indexOf(`## ${REPORT_SECTIONS[0]}`);
  const appendixIdx = markdown.indexOf(`## ${REPORT_SECTIONS[18]}`);
  // Executive Summary is the first `##` heading — no other section starts
  // before it. Compare directly against the position of any other `## `.
  const firstAnyHeading = markdown.indexOf("\n## ");
  check(
    "Executive Summary is the first ## section in the body",
    execIdx > 0 && firstAnyHeading + 1 === execIdx
  );
  check("Appendix is the last section", appendixIdx > execIdx);

  // Appendix contains the technical metadata.
  check("appendix contains projectId", markdown.slice(appendixIdx).includes("**projectId**:"));
  check("appendix contains exportFormatVersion", markdown.slice(appendixIdx).includes("**exportFormatVersion**: 3"));
  check("appendix contains provider=openai", markdown.slice(appendixIdx).includes("**provider**: openai"));
  check("appendix contains model=gpt-4o-mini", markdown.slice(appendixIdx).includes("**model**: gpt-4o-mini"));
  check("appendix contains mock mode: off", markdown.slice(appendixIdx).includes("**mock mode**: off"));
  check(
    "appendix contains probe origin simulated",
    markdown.slice(appendixIdx).includes("**probe origin**: simulated")
  );

  // Helper to slice a single section without getting eaten by markdown
  // table separators (`|---|---|`). Section joiners are `\n---\n\n`.
  const sectionSliceBySepOrHeading = (heading: string): string => {
    const start = markdown.indexOf(`## ${heading}`);
    if (start < 0) return "";
    const nextHeading = markdown.indexOf("\n## ", start + heading.length);
    return markdown.slice(start, nextHeading > 0 ? nextHeading : markdown.length);
  };

  // Executive Summary contains the client-facing scoreboard.
  const execSection = sectionSliceBySepOrHeading(REPORT_SECTIONS[0]);
  check("exec summary mentions the brand", execSection.includes("Acme Corp"));
  check(
    "exec summary describes probe as product-recommendation scorecard",
    execSection.includes("AI probe result (") && execSection.includes("product-recommendation scorecard") && execSection.includes("recommendedAsProduct")
  );
  check("exec summary lists top competitors", execSection.includes("Top competitors AI recommended instead"));
  check("exec summary lists biggest gap", execSection.includes("Biggest gap"));
  check("exec summary lists next recommended fix", execSection.includes("Next recommended fix"));
  check("exec summary lists publishability", execSection.includes("Publishability"));
  check("exec summary lists evidence needed", execSection.includes("Evidence needed to unlock publish-ready assets"));

  // Publishability section groups counts.
  const pubSection = sectionSliceBySepOrHeading(REPORT_SECTIONS[1]);
  check("Publishability lists all 4 buckets", [
    "Publish-ready",
    "Needs evidence",
    "Unsupported claims",
    "Pending QA",
  ].every((s) => pubSection.includes(s)));

  // Evidence Needed section aggregates gaps.
  const evidenceNeededSection = sectionSliceBySepOrHeading(REPORT_SECTIONS[2]);
  check(
    "Evidence Needed lists 'pricing information' (from fix brief)",
    evidenceNeededSection.includes("pricing information")
  );
  check(
    "Evidence Needed extracts placeholder plain text",
    evidenceNeededSection.includes("third-party review")
  );

  // Probe Results section labels each probe as simulated.
  const probeIdx = markdown.indexOf(`## ${REPORT_SECTIONS[6]}`);
  const probeSection = markdown.slice(probeIdx, markdown.indexOf(`## ${REPORT_SECTIONS[7]}`));
  check(
    "probe section warns 'every result … came from a simulated' probe",
    probeSection.includes("simulated") && probeSection.includes("No live call was made")
  );
  check(
    "probe headings use 'Simulated <Platform>-style probe'",
    probeSection.includes("Simulated Chatgpt-style probe") &&
      probeSection.includes("Simulated Perplexity-style probe")
  );
  check(
    "each probe body includes 'probe origin: simulated'",
    (probeSection.match(/probe origin\*\*:\s*simulated/g) ?? []).length >= 2
  );

  // What this means section covers the four bullet-points from the brief.
  const wtmSection = sectionSliceBySepOrHeading(REPORT_SECTIONS[7]);
  check("What this means mentions lost prompts", wtmSection.includes("lost or under-performed"));
  check("What this means mentions competitors that appeared", wtmSection.includes("competitors appeared instead"));
  check("What this means mentions commercial impact", wtmSection.includes("Why this matters commercially"));
  check("What this means calls out the sampling caveat", wtmSection.includes("small, simulated probe"));

  // Recommended Next Actions section produces concrete website actions.
  const rnaSection = sectionSliceBySepOrHeading(REPORT_SECTIONS[10]);
  check(
    "Recommended Next Actions contains a comparison-page action",
    rnaSection.includes("comparison page: **Acme Corp vs Jira**")
  );
  check(
    "Recommended Next Actions surfaces a citation/review action",
    rnaSection.includes("third-party reviews")
  );

  // Generated Assets section is grouped by status.
  const assetsIdx = markdown.indexOf(`## ${REPORT_SECTIONS[13]}`);
  const assetsSection = markdown.slice(assetsIdx, markdown.indexOf(`## ${REPORT_SECTIONS[14]}`));
  check("Generated Assets section has Publish-ready subheading", /###\s+Publish-ready\s+\(\d+\)/.test(assetsSection));
  check("Generated Assets section has Needs evidence subheading", /###\s+Needs evidence\s+\(\d+\)/.test(assetsSection));
  check("Generated Assets section has Unsupported claims subheading", /###\s+Unsupported claims\s+\(\d+\)/.test(assetsSection));
  check("Generated Assets section has Pending QA subheading", /###\s+Pending QA\s+\(\d+\)/.test(assetsSection));

  // NOT READY blockquotes carry the QA-context tagline.
  const nrCount = (markdown.match(/NOT READY TO PUBLISH/g) ?? []).length;
  check("Multiple NOT READY TO PUBLISH labels present", nrCount >= 3, `count=${nrCount}`);
  check(
    "needs_evidence carries the 'Held by QA to prevent unsupported claims' tagline",
    markdown.includes("Held by QA to prevent unsupported claims")
  );
  check(
    "pending_qa carries the 'QA has not run against this draft yet' tagline",
    markdown.includes("QA has not run against this draft yet")
  );
  check(
    "unsupported_claims carries the 'not backed by the Evidence Bank yet' tagline",
    markdown.includes("not backed by the Evidence Bank yet")
  );

  // Read-only invariant preserved.
  check(
    "buildMvpReport did not mutate input tree",
    JSON.stringify(input, mapReplacer) === snapshotJson
  );
  check(
    "buildMvpReport did not mutate latestQaByAsset",
    input.latestQaByAsset.size === savedMapSize
  );

  // Distribution & publishability output correctness.
  check("qaDistribution.pending_qa = 1", qaDistribution.pending_qa === 1);
  check("qaDistribution.needs_evidence = 1", qaDistribution.needs_evidence === 1);
  check("qaDistribution.safe_to_publish = 1", qaDistribution.safe_to_publish === 1);
  check("qaDistribution.unsupported_claims = 1", qaDistribution.unsupported_claims === 1);
  check("publishability.publishReady = 1", publishability.publishReady === 1);
  check("publishability.total = 4", publishability.total === 4);
  check("warnings.notReadyAssetCount = 3", warnings.notReadyAssetCount === 3);

  // Filename shape.
  check(
    "filename is zypact-report-<projectId>-<yyyymmdd>.md",
    /^zypact-report-[a-f0-9-]{36}-\d{8}\.md$/.test(filename)
  );
}

function mapReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return { __map: [...value.entries()].sort((a, b) => a[0].localeCompare(b[0])) };
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/*  companyName fallback flows into the exported report                         */
/* -------------------------------------------------------------------------- */

function testCompanyNameInReport(): void {
  const jsonLd = '{"@context":"https://schema.org"}';
  const spicy = "prose";

  // Case: project.companyName is null but mirror profile has "Linear".
  const input = makeFixtures({
    ownerId: "user-alice",
    spicyAssetContent: spicy,
    jsonLdContent: jsonLd,
    projectCompanyName: null,
    mirrorCompanyName: "Linear",
  });
  const { markdown } = buildMvpReport(input);
  check(
    "exec summary uses mirror-profile companyName when project has none",
    markdown.includes("**Brand**: Linear")
  );
  check(
    "project summary tags source as mirror_profile",
    markdown.includes("**Brand**: Linear _(source: `mirror_profile`)_")
  );
  check(
    "report NEVER shows 'companyName: n/a' when mirror profile has a name",
    !markdown.includes("companyName: n/a") && !markdown.includes("**Brand**: n/a")
  );
}

/* -------------------------------------------------------------------------- */
/*  Category caveat surfaces model-inferred over-specificity                    */
/* -------------------------------------------------------------------------- */

function testCategoryCaveat(): void {
  const input = makeFixtures({
    ownerId: "user-alice",
    spicyAssetContent: "prose",
    jsonLdContent: '{"@type":"Thing"}',
    categoryConfidence: "high",
    detectedCategory: "AI product development platform for teams",
  });
  const { markdown } = buildMvpReport(input);
  check(
    "over-specific 'for teams'-shaped category gets a model-inferred caveat",
    markdown.includes("model-inferred and may over-specify the brand")
  );

  const inputLow = makeFixtures({
    ownerId: "user-alice",
    spicyAssetContent: "prose",
    jsonLdContent: '{"@type":"Thing"}',
    categoryConfidence: "low",
    detectedCategory: "SaaS",
  });
  const { markdown: mdLow } = buildMvpReport(inputLow);
  check(
    "low-confidence category emits a confidence caveat",
    mdLow.includes("Category confidence is `low`")
  );
}

/* -------------------------------------------------------------------------- */
/*  Aggregation                                                                */
/* -------------------------------------------------------------------------- */

function testAggregateEvidenceNeeded(): void {
  const input = makeFixtures({
    ownerId: "user-alice",
    spicyAssetContent: "prose",
    jsonLdContent: "{}",
  });
  const agg = aggregateEvidenceNeeded(input);
  check(
    "aggregate contains 'pricing information'",
    agg.includes("pricing information")
  );
  check(
    "aggregate strips [EVIDENCE NEEDED: …] wrapper from placeholders",
    agg.every((s) => !s.startsWith("[EVIDENCE NEEDED"))
  );

  // Controlled dedup test: inject an exact-duplicate evidence need into
  // the fix brief and assert only one copy makes it into the aggregate.
  const dupInput: BuildMvpReportInput = {
    ...input,
    fixBriefs: [
      { ...input.fixBriefs[0], evidenceNeeded: ["Pricing information", "pricing information"] },
    ],
  };
  const dupAgg = aggregateEvidenceNeeded(dupInput);
  check(
    "aggregate deduplicates by canonical lowercase whitespace",
    dupAgg.filter((s) => s.toLowerCase() === "pricing information").length === 1
  );
}

/* -------------------------------------------------------------------------- */
/*  Secret leak inside a report body                                           */
/* -------------------------------------------------------------------------- */

function testSecretLeakThroughReport(): void {
  const fake = "sb_secret_TESTREDACTABLEBUTNOTREAL123456";
  const jsonLd = '{"@context":"https://schema.org"}';
  const spicy = "prose containing service token: " + fake;
  const input = makeFixtures({
    ownerId: "user-alice",
    spicyAssetContent: spicy,
    jsonLdContent: jsonLd,
  });
  const { markdown, warnings } = buildMvpReport({ ...input, sensitiveValues: [fake] });
  check("sensitive value not present in exported markdown", !markdown.includes(fake));
  check("redaction marker appears", markdown.includes(REDACTED_MARKER));
  check("warnings.secretsRedactedCount >= 1", warnings.secretsRedactedCount >= 1);
}

/* -------------------------------------------------------------------------- */
/*  Prompt-count integrity: stored `selected` rows are NOT prompts probed      */
/* -------------------------------------------------------------------------- */

/** Slice one `## ` section so assertions target the right part of the report. */
function sliceReportSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(`## ${heading}`);
  if (start < 0) return "";
  const next = markdown.indexOf("\n## ", start + heading.length);
  return markdown.slice(start, next > 0 ? next : markdown.length);
}

function testPromptCountIntegrity(): void {
  const now = new Date("2026-08-04T00:00:00.000Z");
  const iso = now.toISOString();
  const projectId = "22222222-2222-2222-2222-222222222222";

  // Deliberately brand-free so every group is unbranded and the scorecard
  // subset equals the full prompt-group set for this fixture.
  const texts = [
    "best alpha analytics workflow",
    "best bravo billing reconciliation",
    "best charlie deployment pipeline",
    "best delta inventory forecasting",
    "best echo payroll compliance",
    "best foxtrot shipping logistics",
    "best golf recruiting onboarding",
    "best hotel warehouse robotics",
    "best india telemetry dashboards",
    "best juliet contract redlining",
    "best kilo procurement sourcing",
    "best lima translation localisation",
  ];

  const project: Project = {
    id: projectId,
    userId: "user-count",
    companyName: "Acme Corp",
    domain: "acme.example.com",
    category: "test category",
    createdAt: iso,
  };

  // 12 stored prompt rows, ALL flagged selected — the misleading input.
  const prompts: GeneratedPrompt[] = texts.map((prompt, i) => ({
    id: `gp-${i}`,
    projectId,
    prompt,
    intentType: "manual",
    commercialValue: 5,
    winnability: 3,
    priority: 100 - i,
    rationale: "",
    selected: true,
    createdAt: iso,
  }));

  const probeRow = (
    n: number,
    prompt: string,
    generatedPromptId: string | null,
    probeMode: ProbeResult["probeMode"]
  ): ProbeResult => ({
    id: `pr-${n}`,
    probeRunId: `run-${n}`,
    projectId,
    generatedPromptId,
    prompt,
    platform: "perplexity",
    probeMode,
    rawResponse: "answer body",
    clientMentioned: false,
    clientPosition: "absent",
    competitorsMentioned: [],
    sourcesCited: [],
    answerSummary: "summary",
    verdict: "lost",
    whyClientLost: "not recommended",
    createdAt: iso,
  });

  // Only the first ELEVEN prompts were probed, 3 live runs each = 33.
  // Prompt 0 varies by case/whitespace; prompt 1 carries a null prompt id.
  const probeResults: ProbeResult[] = [];
  let n = 0;
  for (let p = 0; p < 11; p += 1) {
    for (let r = 0; r < 3; r += 1) {
      let text = texts[p]!;
      if (p === 0 && r === 1) text = "Best Alpha Analytics Workflow";
      if (p === 0 && r === 2) text = "  best   alpha  analytics   workflow ";
      probeResults.push(
        probeRow(n++, text, p === 1 ? null : `gp-${p}`, "live_perplexity")
      );
    }
  }

  const input: BuildMvpReportInput = {
    project,
    mirrorProfile: null,
    prompts,
    probeResults,
    resolvedMentionsByProbeResult: toResolvedMentionsByProbeResult(probeResults),
    competitors: [],
    gapMap: null,
    gaps: [],
    evidenceBank: null,
    fixBriefs: [],
    assets: [],
    latestQaByAsset: new Map(),
    llmProvider: "openai",
    llmModel: "gpt-4o-mini",
    mockMode: false,
    now,
  };

  const { markdown } = buildMvpReport(input);
  const execSection = sliceReportSection(markdown, REPORT_SECTIONS[0]);
  const promptSection = sliceReportSection(markdown, REPORT_SECTIONS[5]);
  const appendix = sliceReportSection(markdown, REPORT_SECTIONS[18]);

  check(
    "section 6 reports 12 stored prompt rows marked selected",
    promptSection.includes("**stored prompt rows**: 12") &&
      promptSection.includes("**rows marked selected**: 12")
  );
  check(
    "section 6 heading is 'Stored prompt targets'",
    promptSection.includes("### Stored prompt targets") &&
      !promptSection.includes("### Selected prompts")
  );
  check(
    "appendix reports 11 distinct scorecard prompts, not 12",
    appendix.includes("**distinct prompts represented in scorecard results**: 11")
  );
  check(
    "appendix reports 33 scorecard probe runs",
    appendix.includes("**scorecard probe runs**: 33")
  );
  check(
    "appendix reports 33 stored probe rows",
    appendix.includes("**all stored probe rows**: 33")
  );
  check(
    "executive summary agrees with the appendix (11 prompts / 33 runs)",
    execSection.includes("11 prompts / 33 runs")
  );
  check(
    "phrase 'selected for probe' is absent from the whole report",
    !markdown.includes("selected for probe")
  );

  // Mixed modes: 3 simulated rows for a 12th prompt must NOT enter the
  // scorecard subset while live rows exist, but must still be stored rows.
  const mixedInput: BuildMvpReportInput = {
    ...input,
    probeResults: [
      ...probeResults,
      probeRow(100, texts[11]!, "gp-11", "simulated"),
      probeRow(101, texts[11]!, "gp-11", "simulated"),
      probeRow(102, texts[11]!, "gp-11", "simulated"),
    ],
  };
  const mixed = buildMvpReport(mixedInput).markdown;
  const mixedExec = sliceReportSection(mixed, REPORT_SECTIONS[0]);
  const mixedAppendix = sliceReportSection(mixed, REPORT_SECTIONS[18]);

  check(
    "mixed modes keep the scorecard subset at 11 prompts / 33 runs",
    mixedAppendix.includes("**distinct prompts represented in scorecard results**: 11") &&
      mixedAppendix.includes("**scorecard probe runs**: 33")
  );
  check(
    "mixed modes report 36 stored probe rows",
    mixedAppendix.includes("**all stored probe rows**: 36")
  );
  check(
    "mixed-mode executive summary still agrees with the appendix",
    mixedExec.includes("11 prompts / 33 runs")
  );
}

/* -------------------------------------------------------------------------- */
/*  M3 — canonicalEntityId tally sites (top competitors, ranked table,       */
/*  per-run transcript) and Mirror Profile / platformsReferenced non-        */
/*  regression                                                               */
/* -------------------------------------------------------------------------- */

function testM3CanonicalTallySites(): void {
  const now = new Date("2026-07-10T01:30:00.000Z");
  const projectId = "33333333-3333-3333-3333-333333333333";
  const project: Project = {
    id: projectId,
    userId: "owner-m3",
    companyName: "Acme Corp",
    domain: "https://acme.example.com",
    category: "AI product development platform for teams",
    createdAt: now.toISOString(),
  };
  const mirrorProfile: MirrorProfileRow = {
    id: "mp-m3",
    projectId,
    json: {
      companyName: "Acme Corp",
      website: "https://acme.example.com",
      detectedCategory: "AI product development platform for teams",
      categoryConfidence: "high",
      targetAudience: [],
      useCases: [],
      features: [],
      painPointsAddressed: [],
      claims: [],
      proofSignals: [],
      // Site-reader source, never AI-probe evidence. Must render exactly
      // as-is regardless of resolvedMentionsByProbeResult below.
      competitorsMentioned: ["SiteOnlyRival"],
      missingSignals: [],
      buyerIntentAngles: [],
      aiReadabilityNotes: "",
    },
    createdAt: now.toISOString(),
  };
  const prompts: GeneratedPrompt[] = ["a", "b", "c", "d"].map((k, i) => ({
    id: `prompt-${k}`,
    projectId,
    prompt: `Best tools, question ${k}`,
    intentType: "best_tools",
    commercialValue: 5,
    winnability: 4,
    priority: 20,
    rationale: "test",
    selected: i === 0,
    createdAt: now.toISOString(),
  }));
  function probe(id: string, promptIdx: number, platform: string): ProbeResult {
    return {
      id,
      probeRunId: "run-m3",
      projectId,
      generatedPromptId: prompts[promptIdx].id,
      prompt: prompts[promptIdx].prompt,
      platform,
      probeMode: "simulated",
      rawResponse: "raw",
      clientMentioned: false,
      clientPosition: "absent",
      competitorsMentioned: [],
      sourcesCited: [],
      answerSummary: "AI recommended other products, not Acme.",
      verdict: "lost",
      whyClientLost: "Acme absent from AI answer.",
      createdAt: now.toISOString(),
    };
  }
  const probeA = probe("probe-m3-a", 0, "chatgpt");
  const probeB = probe("probe-m3-b", 1, "perplexity");
  const probeC = probe("probe-m3-c", 2, "perplexity");
  const probeD = probe("probe-m3-d", 3, "perplexity");
  const probeResults = [probeA, probeB, probeC, probeD];

  const resolvedMentionsByProbeResult = new Map<string, ResolvedCompetitorMention[]>([
    [
      probeA.id,
      [
        {
          canonicalEntityId: "canonical:widgetco",
          rawText: "Widgetco",
          normalizedText: "widgetco",
          mentionOrdinal: 1,
          context: null,
          generatedPromptId: probeA.generatedPromptId,
        },
      ],
    ],
    [
      probeB.id,
      [
        // Different surface form, SAME canonicalEntityId as probeA's
        // mention — must merge into ONE tallied competitor, not two.
        {
          canonicalEntityId: "canonical:widgetco",
          rawText: "Widgetco Inc.",
          normalizedText: "widgetco",
          mentionOrdinal: 1,
          context: null,
          generatedPromptId: probeB.generatedPromptId,
        },
      ],
    ],
    [
      // A resolved mention whose rawText happens to be a platform name.
      // Real entity resolution never produces this (platforms are
      // diverted upstream), but tallyResolvedCompetitors defends against
      // it anyway — prove that defense fires.
      probeC.id,
      [
        {
          canonicalEntityId: "canonical:chatgpt",
          rawText: "ChatGPT",
          normalizedText: "chatgpt",
          mentionOrdinal: 1,
          context: null,
          generatedPromptId: probeC.generatedPromptId,
        },
      ],
    ],
    [
      // Same competitor named twice within one run — the per-run
      // transcript (site 2) must preserve both ordinals, not collapse
      // them, even though the tally sites (1 and 3) count both.
      probeD.id,
      [
        {
          canonicalEntityId: "canonical:gadgetco",
          rawText: "Gadgetco",
          normalizedText: "gadgetco",
          mentionOrdinal: 1,
          context: "first mention",
          generatedPromptId: probeD.generatedPromptId,
        },
        {
          canonicalEntityId: "canonical:gadgetco",
          rawText: "Gadgetco",
          normalizedText: "gadgetco",
          mentionOrdinal: 2,
          context: "second mention",
          generatedPromptId: probeD.generatedPromptId,
        },
      ],
    ],
  ]);

  const input: BuildMvpReportInput = {
    project,
    mirrorProfile,
    prompts,
    probeResults,
    resolvedMentionsByProbeResult,
    competitors: [],
    gapMap: null,
    gaps: [],
    evidenceBank: null,
    fixBriefs: [],
    assets: [],
    latestQaByAsset: new Map(),
    now,
  };
  const { markdown } = buildMvpReport(input);

  console.log("\n[M3 build-mvp-report.ts: canonicalEntityId tally sites]");

  check(
    "exec summary: two surface forms of one canonicalEntityId collapse into ONE top competitor",
    markdown.includes("Top competitors AI recommended instead") &&
      /Top competitors AI recommended instead\*\*: [^\n]*Widgetco Inc\.[^\n]*/.test(markdown) &&
      !/Top competitors AI recommended instead\*\*: [^\n]*Widgetco Inc\.[^\n]*Widgetco Inc\./.test(
        markdown
      )
  );
  check(
    "exec summary: the richer surface form ('Widgetco Inc.') is the displayed name, not the shorter 'Widgetco'",
    (() => {
      const line = markdown
        .split("\n")
        .find((l) => l.includes("Top competitors AI recommended instead"));
      return Boolean(line) && line!.includes("Widgetco Inc.") && !/\bWidgetco\b(?!\sInc\.)/.test(line!);
    })()
  );
  check(
    "exec summary: a resolved mention that is actually a platform name (ChatGPT) never appears as a top competitor",
    (() => {
      const line = markdown
        .split("\n")
        .find((l) => l.includes("Top competitors AI recommended instead"));
      return Boolean(line) && !line!.includes("ChatGPT");
    })()
  );
  check(
    "ranked table: Widgetco/Widgetco Inc. merge into one row with count 2, not two rows of count 1",
    markdown.includes("| Widgetco Inc. | 2 |") && !markdown.includes("| Widgetco | 1 |")
  );
  check(
    "ranked table: ChatGPT is never listed as a competitor row",
    (() => {
      const start = markdown.indexOf("### Which competitors appeared instead");
      if (start === -1) return false;
      const end = markdown.indexOf("\n### ", start + 1);
      const section = markdown.slice(start, end === -1 ? undefined : end);
      return !section.includes("ChatGPT");
    })()
  );
  check(
    "per-run transcript (probe-m3-d): both ordinals of the duplicate 'Gadgetco' mention are preserved, not deduplicated",
    markdown.includes("| 1 | Gadgetco | first mention |") &&
      markdown.includes("| 2 | Gadgetco | second mention |")
  );
  check(
    "Mirror Profile's own site-competitor list (SiteOnlyRival) still renders, untouched by resolvedMentionsByProbeResult",
    markdown.includes("SiteOnlyRival")
  );
  check(
    "Mirror Profile section does not leak AI-probe-evidence competitors (Widgetco) into its own list",
    (() => {
      const start = markdown.indexOf("### Competitors mentioned on the site");
      if (start === -1) return false;
      const end = markdown.indexOf("\n### ", start + 1);
      const section = markdown.slice(start, end === -1 ? undefined : end);
      return section.includes("SiteOnlyRival") && !section.includes("Widgetco");
    })()
  );
}

/* -------------------------------------------------------------------------- */
/*  Entry                                                                     */
/* -------------------------------------------------------------------------- */

testFence();
testRedactSensitive();
testCompanyNameFallback();
testSimulatedProbeHonesty();
testGapToRecommendedAction();
testAggregateEvidenceNeeded();
testFullReport();
testCompanyNameInReport();
testCategoryCaveat();
testSecretLeakThroughReport();
testPromptCountIntegrity();
testM3CanonicalTallySites();

console.log(
  `\n${checks - failures}/${checks} checks passed. ` +
    (failures === 0
      ? "Sprint 11.5 export builder scenario PASSED."
      : "Sprint 11.5 export builder scenario FAILED.")
);
process.exit(failures === 0 ? 0 : 1);
