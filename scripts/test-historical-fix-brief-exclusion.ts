#!/usr/bin/env tsx
/**
 * A Fix Brief marked `historical` must never reach a client.
 *
 * HockeyStack proved this the hard way. An invalid brief — one asserting a
 * cause the evidence never established — was correctly reclassified as
 * `historical` in the database, and the canonical report still printed its
 * recommendation in Recommended Next Actions and rendered it in full in the
 * Fix Brief section. `currentFixBriefs()` honoured the status; the three
 * display paths called `sortFixBriefsForDisplay(input.fixBriefs, …)`
 * directly and never looked at it.
 *
 * The headline recommendation escaped only by luck: ties break on createdAt
 * descending, and the corrected brief happened to be newer. So the fixture
 * below makes the historical brief NEWER, which is exactly the arrangement
 * that would have shipped the invalid claim as the client's first action.
 *
 * Fixtures are synthetic. No database, no provider, no customer data.
 */
import { buildMvpReport } from "@/lib/export/build-mvp-report";
import { buildSalesReportFromMvpMarkdown } from "@/lib/export/build-sales-report";
import type { BuildMvpReportInput } from "@/lib/export/build-mvp-report";

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ok   ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}`); }
}

const CURRENT_MARK = "CURRENTFIXMARKER";
const HISTORICAL_MARK = "HISTORICALFIXMARKER";
const LOST_PROMPT = "How to compare B2B revenue intelligence platforms?";

/** Older than the historical brief, so ordering alone would not select it. */
const CURRENT_CREATED = "2026-01-01T00:00:00.000Z";
/** Deliberately newer: timestamp sorting would prefer this one. */
const HISTORICAL_CREATED = "2026-06-01T00:00:00.000Z";

function brief(over: Partial<any>): any {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    projectId: "p1",
    gapId: null,
    probeResultId: null,
    lostPrompt: LOST_PROMPT,
    competitorRecommended: "Clari, Gong",
    rootCause: "Observed: the brand was not recommended in the stored runs examined.",
    recommendedFix: "Create a comparison page.",
    fixType: "comparison_page",
    assetsToGenerate: ["comparison_page_outline"],
    evidenceNeeded: ["Specific features and advantages."],
    evidenceAvailable: [],
    priority: 1,
    expectedImpact: "Helps buyers compare.",
    status: "needs_evidence",
    createdAt: CURRENT_CREATED,
    updatedAt: CURRENT_CREATED,
    ...over,
  };
}

const CURRENT = brief({
  id: "11111111-1111-4111-8111-111111111111",
  recommendedFix: `Create a comparison page. ${CURRENT_MARK}`,
  expectedImpact: `Helps buyers compare. ${CURRENT_MARK}`,
  rootCause: `Observed outcome only. ${CURRENT_MARK}`,
  evidenceNeeded: [`Specific features and advantages. ${CURRENT_MARK}`],
  status: "needs_evidence",
});

const HISTORICAL = brief({
  id: "22222222-2222-4222-8222-222222222222",
  recommendedFix: `Create a dedicated comparison page. ${HISTORICAL_MARK}`,
  expectedImpact: `Positions the brand. ${HISTORICAL_MARK}`,
  rootCause: `The AI had no basis to recommend the brand because content was missing. ${HISTORICAL_MARK}`,
  lostPrompt: `Which attribution tool is best? ${HISTORICAL_MARK}`,
  evidenceNeeded: [`Positioning proof. ${HISTORICAL_MARK}`],
  status: "historical",
  createdAt: HISTORICAL_CREATED,
  updatedAt: HISTORICAL_CREATED,
});

/**
 * `gaps` is parameterised because §11 renders two different branches: a
 * "Consolidation actions" list when there are no prioritized gaps, and a
 * "From the Fix Briefs" list when there are. Both consume Fix Briefs.
 */
function inputs(fixBriefs: any[], gaps: any[] = []): BuildMvpReportInput {
  return {
    project: { id: "p1", name: "Northwind", domain: "northwind.example" } as any,
    mirrorProfile: null,
    prompts: [],
    probeResults: [],
    competitors: [],
    gapMap: gaps.length > 0 ? ({ id: "gm1", projectId: "p1", gapMap: {}, createdAt: CURRENT_CREATED } as any) : null,
    gaps,
    evidenceBank: null,
    fixBriefs,
    assets: [],
    latestQaByAsset: new Map(),
    now: new Date("2026-07-01T00:00:00.000Z"),
  };
}

const GAP = {
  id: "g1", projectId: "p1", competitorName: null, type: "prompt_loss",
  severity: "high", explanation: "Buyer prompts where you are missing",
  affectedPrompts: [LOST_PROMPT],
  suggestedFixDirection: "Publish a comparison page.",
  createdAt: CURRENT_CREATED,
} as any;

/** Sections that carry a recommendation to the client. */
function clientFacingSections(markdown: string): string {
  const wanted = ["## 1.", "## 11.", "## 13."];
  return wanted
    .map((h) => {
      const start = markdown.indexOf(h);
      if (start === -1) return "";
      const next = markdown.indexOf("\n## ", start + 1);
      return markdown.slice(start, next === -1 ? undefined : next);
    })
    .join("\n");
}

console.log("test-historical-fix-brief-exclusion");

/* ---- §6 full report: historical excluded from every recommendation ---- */
for (const [label, gaps] of [["without gaps", []], ["with gaps", [GAP]]] as [string, any[]][]) {
  const md = buildMvpReport(inputs([CURRENT, HISTORICAL], gaps)).markdown;
  const client = clientFacingSections(md);

  check(`${label}: PRECONDITION historical brief is the newer of the two`,
    new Date(HISTORICAL_CREATED) > new Date(CURRENT_CREATED));
  check(`${label}: §1 headline recommendation is the current brief`,
    md.includes("**Next recommended fix**") &&
    md.slice(md.indexOf("**Next recommended fix**"), md.indexOf("**Next recommended fix**") + 400)
      .includes(CURRENT_MARK));
  check(`${label}: historical marker absent from §1/§11/§13`,
    !client.includes(HISTORICAL_MARK));
  check(`${label}: historical brief id absent from client-facing sections`,
    !client.includes(HISTORICAL.id));
  check(`${label}: current brief still renders`, client.includes(CURRENT_MARK));
  check(`${label}: the invalid causal claim never reaches the client`,
    !client.includes("had no basis to recommend"));
}

/* ---- §7 short report ---- */
{
  const full = buildMvpReport(inputs([CURRENT, HISTORICAL], [GAP])).markdown;
  const short = buildSalesReportFromMvpMarkdown(full).markdown;
  check("short report excludes the historical marker", !short.includes(HISTORICAL_MARK));
  check("short report excludes the invalid causal claim",
    !short.includes("had no basis to recommend"));
  // §4 composes its own client-facing wording, so the brief's own text is not
  // echoed verbatim. What does carry through is the evidence-needed list and
  // the lost prompt — assert on those.
  check("short report still carries the current brief's evidence list",
    short.includes(CURRENT_MARK));
  check("short report uses the current brief's lost prompt, not the historical one",
    short.includes(LOST_PROMPT) && !short.includes("Which attribution tool is best?"));
}

/* ---- §8 order independence ---- */
{
  const arrangements: [string, any[]][] = [
    ["historical first", [HISTORICAL, CURRENT]],
    ["historical last", [CURRENT, HISTORICAL]],
    ["historical newer (both orders already newer)", [HISTORICAL, CURRENT]],
  ];
  for (const [label, briefs] of arrangements) {
    const md = buildMvpReport(inputs(briefs, [GAP])).markdown;
    const client = clientFacingSections(md);
    check(`order-independent (${label}): historical excluded`, !client.includes(HISTORICAL_MARK));
    check(`order-independent (${label}): current selected`, client.includes(CURRENT_MARK));
  }
}

/* ---- §9 only historical briefs ---- */
{
  const md = buildMvpReport(inputs([HISTORICAL], [GAP])).markdown;
  const client = clientFacingSections(md);
  const short = buildSalesReportFromMvpMarkdown(md).markdown;
  check("only-historical: no historical content leaks into the full report",
    !client.includes(HISTORICAL_MARK));
  check("only-historical: no historical content leaks into the short report",
    !short.includes(HISTORICAL_MARK));
  check("only-historical: §1 falls back to the established no-fix wording",
    md.includes("**Next recommended fix**: _no Fix Brief generated yet_"));
  check("only-historical: §13 uses the established empty-state wording",
    md.includes("_No Fix Brief generated yet._"));
  check("only-historical: no invented recommendation appears",
    !client.includes("dedicated comparison page"));
}

/* ---- §10 needs_evidence semantics unchanged ---- */
{
  const md = buildMvpReport(inputs([CURRENT], [GAP])).markdown;
  const client = clientFacingSections(md);
  check("needs_evidence brief is still the headline recommendation",
    client.includes(CURRENT_MARK));
  check("needs_evidence brief still renders in §13 with its own status",
    /### Fix Brief · `11111111-1111-4111-8111-111111111111`[^\n]*needs_evidence/.test(md));
  check("needs_evidence brief still appears in §11",
    md.slice(md.indexOf("## 11."), md.indexOf("## 12.")).includes(CURRENT_MARK));
  const short = buildSalesReportFromMvpMarkdown(md).markdown;
  check("needs_evidence brief still drives the short report fix",
    short.includes(CURRENT_MARK) && short.includes(LOST_PROMPT));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
