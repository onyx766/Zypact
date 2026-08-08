#!/usr/bin/env tsx
/**
 * Short-report grounding regression.
 *
 * The first real post-worker commercial snapshot (HockeyStack) shipped a
 * short report containing a "First recommended fix" and a buyer frame
 * called "Alternatives in the core buying category" — while the full report
 * said "No Fix Brief generated yet" and no such prompt existed in any
 * stored run. Two defects produced that:
 *
 *   1. the lost-prompt parser matched one literal prospect brand name, so
 *      for every other client the section was never found;
 *   2. the recommended fix was synthesised unconditionally, with no gate on
 *      a Fix Brief actually existing.
 *
 * The existing suite missed both because all of its fixtures carry a Fix
 * Brief, which short-circuits `focusPrompt` before the broken parser is
 * consulted. The fixtures here deliberately include the no-Fix-Brief case.
 *
 * Pure string rendering: no provider, no database, no network.
 */

import { buildSalesReportFromMvpMarkdown } from "@/lib/export/build-sales-report";

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ok   ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}`); }
}

const SYNTHETIC_FRAME = "Alternatives in the core buying category";

/**
 * Builds a report fixture. `brand` is interpolated into the lost-prompt
 * heading exactly the way `build-mvp-report.ts` does it.
 */
function fixture(opts: {
  brand: string;
  domain: string;
  lostPrompt: string;
  lostCompetitors: string[];
  otherPrompt: string;
  otherCompetitors: string[];
  withFixBrief: boolean;
  summaryLine?: string;
}): string {
  const fixBrief = opts.withFixBrief
    ? `## 13. Fix Brief

- **lostPrompt**: ${opts.lostPrompt}
- **competitorRecommended**: ${opts.lostCompetitors.join(", ")}
- **fixType**: \`comparison_page\`

#### Root cause
${opts.brand} was absent from that answer.

#### Recommended fix
GROUNDED_FIX_MARKER publish a comparison page for that exact buyer question.

#### Evidence needed
- verifiable product details
`
    : `## 13. Fix Brief

No Fix Brief generated yet.
`;

  return `# Zypact MVP — Client Report

> Read-only snapshot of the AI-visibility scan for **${opts.brand}** (\`${opts.domain}\`).

## 1. Executive Summary

- **Brand**: ${opts.brand}
- **Domain**: \`${opts.domain}\`
- **Category (Mirror Profile)**: B2B analytics
- **AI probe result (live Perplexity unbranded product-recommendation scorecard)**: ${opts.summaryLine ?? "0 won · 0 partial · 1 lost · recommendedAsProduct 0% · citedAsSource 0%"}
- **Branded reputation**: not measured

## 7. Probe Results

### Prompt-level aggregation

| prompt | scorecard status | runs | recommendedAsProduct | citedAsSource | negativeMentions | product verdict |
|---|---|---|---|---|---|---|
| ${opts.lostPrompt} | included | 3 | 0% | 0% | 0% | lost |
| ${opts.otherPrompt} | included | 3 | 100% | 33% | 0% | partial |

### Which prompts ${opts.brand} lost or under-performed
**Lost prompts** (brand was not recommended as a product/tool):
- ${opts.lostPrompt} (3 runs, recommendedAsProduct 0%, citedAsSource 0%)

### Which competitors appeared instead
| competitor | mentions across main probes |
|---|---|
${[...opts.lostCompetitors, ...opts.otherCompetitors].map((c) => `| ${c} | 3 |`).join("\n")}

### Live Perplexity Sonar probe · product verdict: **lost**

- **prompt**: ${opts.lostPrompt}
- **scorecard status**: included
- **competitors mentioned (position | name | mentions)**:
${opts.lostCompetitors.map((c, i) => `| ${i + 1} | ${c} | 3 |`).join("\n")}
- **sources cited**:

### Live Perplexity Sonar probe · product verdict: **partial**

- **prompt**: ${opts.otherPrompt}
- **scorecard status**: included
- **competitors mentioned (position | name | mentions)**:
${opts.otherCompetitors.map((c, i) => `| ${i + 1} | ${c} | 3 |`).join("\n")}
- **sources cited**:

${fixBrief}`;
}

const HS_LOST = "How to compare B2B revenue intelligence platforms?";
const HS_PARTIAL =
  "What are the best B2B marketing attribution tools for measuring campaign effectiveness?";
const HS_LOST_COMPETITORS = ["Clari", "Gong", "People.ai"];
const HS_PARTIAL_COMPETITORS = ["Dreamdata", "Ruler Analytics"];

console.log("test-short-report-grounding");

// ---------- A/C/D dynamic brand heading ----------
console.log("\n [A/C/D dynamic brand heading]");
for (const brand of ["HockeyStack", "Zypact", "Breakout", "Acme Corp", "O'Neill & Sons, Inc."]) {
  const md = fixture({
    brand, domain: "example.com",
    lostPrompt: HS_LOST, lostCompetitors: HS_LOST_COMPETITORS,
    otherPrompt: HS_PARTIAL, otherCompetitors: HS_PARTIAL_COMPETITORS,
    withFixBrief: false,
  });
  const out = buildSalesReportFromMvpMarkdown(md).markdown;
  check(`${brand.padEnd(22)} lost prompt extracted (no synthetic frame)`,
    out.includes(HS_LOST) && !out.includes(SYNTHETIC_FRAME));
}

// ---------- B no hardcoded prospect brand in the parser ----------
console.log("\n [B no hardcoded prospect brand in parsing]");
{
  const src = require("node:fs").readFileSync("lib/export/build-sales-report.ts", "utf-8") as string;
  check("renderer source contains no hardcoded 'Vugio'", !/Vugio/.test(src));
  check("renderer source contains no synthetic buying-frame literal",
    !src.includes(SYNTHETIC_FRAME));
}

// ---------- E no evidence section -> no synthetic frame ----------
console.log("\n [E missing evidence yields no invented frame]");
{
  const md = `# Zypact MVP — Client Report

## 1. Executive Summary

- **Brand**: Nowhere
- **Domain**: \`nowhere.com\`

## 13. Fix Brief

No Fix Brief generated yet.
`;
  const out = buildSalesReportFromMvpMarkdown(md).markdown;
  check("no synthetic buying frame rendered", !out.includes(SYNTHETIC_FRAME));
  check("neutral no-frame statement rendered",
    /No evidence-backed under-performance frame/i.test(out));
}

// ---------- F/G no Fix Brief -> no fabricated fix ----------
console.log("\n [F/G no Fix Brief means no fabricated fix]");
{
  const md = fixture({
    brand: "HockeyStack", domain: "hockeystack.com",
    lostPrompt: HS_LOST, lostCompetitors: HS_LOST_COMPETITORS,
    otherPrompt: HS_PARTIAL, otherCompetitors: HS_PARTIAL_COMPETITORS,
    withFixBrief: false,
  });
  const out = buildSalesReportFromMvpMarkdown(md).markdown;
  const res = buildSalesReportFromMvpMarkdown(md);
  check("explicit no-fix statement present",
    /No evidence-backed recommended fix was produced/i.test(out));
  check("no hardcoded fallback fix sentence",
    !/Publish a focused, evidence-backed page for the missing buyer question/i.test(out));
  check("frameAwareFix output not present (no comparison-page invention)",
    !/comparison page/i.test(out.split("## 4.")[1] ?? ""));
  check("summary.firstFix carries the neutral statement",
    /No evidence-backed recommended fix/i.test(res.summary.firstFix));
  check("no 'Evidence needed before publish-ready copy' block without a brief",
    !out.includes("Evidence needed before publish-ready copy"));
}

// ---------- H real Fix Brief -> that fix only ----------
console.log("\n [H real Fix Brief renders that brief]");
{
  const md = fixture({
    brand: "HockeyStack", domain: "hockeystack.com",
    lostPrompt: HS_LOST, lostCompetitors: HS_LOST_COMPETITORS,
    otherPrompt: HS_PARTIAL, otherCompetitors: HS_PARTIAL_COMPETITORS,
    withFixBrief: true,
  });
  const out = buildSalesReportFromMvpMarkdown(md).markdown;
  // Not asserted verbatim: `frameAwareFix` deliberately rewrites an
  // unsupported "comparison page" recommendation when no competitor was
  // observed in that frame. That safeguard is retained; what matters here is
  // that the fix derives from the brief and not from a hardcoded fallback.
  check("a grounded fix is rendered from the brief",
    !/No evidence-backed recommended fix was produced/i.test(out) &&
      /## 4\. First recommended fix/.test(out));
  check("hardcoded fallback sentence never used",
    !/Publish a focused, evidence-backed page for the missing buyer question/i.test(out));
  check("neutral no-fix statement absent",
    !/No evidence-backed recommended fix was produced/i.test(out));
  check("evidence block returns when a brief exists",
    out.includes("Evidence needed before publish-ready copy"));
}

// ---------- I/J grounding and no cross-prompt leakage ----------
// The earlier version of this block was vacuous: the fixture carried only the
// global "Which competitors appeared instead" table, so `frameCompetitors`
// was always empty and "X does not leak" passed because no competitor name
// ever reached the sentence. A mutation pointing the lookup at the wrong
// prompt therefore survived. The fixture now carries real per-prompt probe
// blocks, and fixture quality is asserted before the grounding claim.
console.log("\n [I/J prompt grounding, no cross-prompt leakage]");
{
  const md = fixture({
    brand: "HockeyStack", domain: "hockeystack.com",
    lostPrompt: HS_LOST, lostCompetitors: HS_LOST_COMPETITORS,
    otherPrompt: HS_PARTIAL, otherCompetitors: HS_PARTIAL_COMPETITORS,
    withFixBrief: false,
  });
  const out = buildSalesReportFromMvpMarkdown(md).markdown;
  const section3 = (out.split("## 3.")[1] ?? "").split("## 4.")[0] ?? "";

  // Fixture quality: the frame must actually name competitors, otherwise
  // every leakage assertion below is meaningless.
  const focusHits = HS_LOST_COMPETITORS.filter((c) => section3.includes(c));
  check(`fixture quality: focus prompt contributes competitors (${focusHits.length} of ${HS_LOST_COMPETITORS.length})`,
    focusHits.length > 0);
  check("fixture quality: the two prompts have distinct competitor sets",
    HS_LOST_COMPETITORS.every((c) => !HS_PARTIAL_COMPETITORS.includes(c)));

  check("why-this-matters quotes a real stored prompt", section3.includes(HS_LOST));
  check("frame does not quote the other prompt", !section3.includes(HS_PARTIAL));
  for (const leaked of HS_PARTIAL_COMPETITORS) {
    check(`no cross-prompt leakage of "${leaked}" into the frame`, !section3.includes(leaked));
  }
}

// ---------- K HockeyStack golden fixture ----------
console.log("\n [K HockeyStack golden fixture]");
{
  const md = fixture({
    brand: "HockeyStack", domain: "hockeystack.com",
    lostPrompt: HS_LOST, lostCompetitors: HS_LOST_COMPETITORS,
    otherPrompt: HS_PARTIAL, otherCompetitors: HS_PARTIAL_COMPETITORS,
    withFixBrief: false,
    summaryLine:
      "1 won · 1 partial · 3 lost · recommendedAsProduct 40% · citedAsSource 20%",
  });
  const out = buildSalesReportFromMvpMarkdown(md).markdown;
  // The short report summarises visibility as the recommended rate only; the
  // cited rate and won/partial/lost split live in the full report, so they are
  // asserted there rather than fabricated as an expectation here.
  const summary = buildSalesReportFromMvpMarkdown(md).summary;
  check("recommended rate 40% preserved in the summary line",
    /40%/.test(summary.visibilityLine));
  check("no rate other than the stored 40% is asserted",
    !/\b(0%|100%)\s+recommended/.test(summary.visibilityLine));
  check("NO synthetic buying frame", !out.includes(SYNTHETIC_FRAME));
  check("NO fabricated first fix",
    /No evidence-backed recommended fix was produced/i.test(out));
  check("frame is a real stored prompt", out.includes(HS_LOST));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
