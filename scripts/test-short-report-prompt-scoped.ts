#!/usr/bin/env tsx
/**
 * Section 1 must answer "who are we losing to?" the same way section 3 does.
 *
 * The executive summary used to build its strategic sentence from the
 * project-wide competitor tally while sections 3 and 4 used the priority
 * buyer question's own competitors. On the first real commercial snapshot
 * that told the client to consolidate against Dreamdata, Ruler Analytics and
 * Fibbler — products recommended for a different buyer question, and in
 * Fibbler's case only for a question the brand won — while the recommended
 * fix two sections later correctly targeted Clari and Gong.
 *
 * The fixtures below are synthetic and self-contained: no /tmp file, no
 * database, no provider, no customer report body. They carry only the
 * minimum evidence needed to make the global tally and the prompt-scoped set
 * genuinely disagree, and they run through the real production renderer.
 */

import { buildSalesReportFromMvpMarkdown } from "@/lib/export/build-sales-report";

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ok   ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}`); }
}

const REVENUE = "How to compare B2B revenue intelligence platforms?";
const ATTRIBUTION = "What are the best B2B marketing attribution tools for measuring campaign effectiveness?";
const FACTORS = "Alternatives to Factors.ai for custom reporting in B2B?";

const REVENUE_LOCAL = ["Clari", "Gong", "Salesforce Revenue Intelligence", "People.ai"];
const PROMPT_FOREIGN = ["Dreamdata", "Ruler Analytics", "Fibbler", "Adobe Marketo Measure"];

/**
 * Builds a full-report fixture.
 *
 * `revenueCompetitors` is parameterised so the same shape covers both the
 * normal case and the empty case that proves there is no global fallback.
 */
function fixture(revenueCompetitors: string[]): string {
  const competitorTable = (names: string[]) =>
    names.length === 0
      ? "- **competitors mentioned (in the live Perplexity answer)**: none recorded\n"
      : `- **competitors mentioned (in the live Perplexity answer)**:\n\n` +
        `    | position | name | context |\n    |---|---|---|\n` +
        names.map((n, i) => `    | ${i + 1} | ${n} | recommended alternative |`).join("\n") +
        "\n";

  return `# Zypact MVP — Client Report

> Read-only snapshot of the AI-visibility scan for **Northwind** (\`northwind.example\`). Generated 2026-01-02T00:00:00.000Z.

## 1. Executive Summary

- **Brand**: Northwind
- **Domain**: \`northwind.example\`
- **Category (Mirror Profile)**: B2B revenue data intelligence platform
- **AI probe result (live Perplexity unbranded product-recommendation scorecard, 3 prompts / 9 runs)**: 1 won · 1 partial · 1 lost · recommendedAsProduct 40% · citedAsSource 20%
- **Top competitors AI recommended instead**: Dreamdata, Ruler Analytics, Fibbler
- **Next recommended fix**: Create a comparison page for the selected buyer question. _(fixType \`comparison_page\`, status \`needs_evidence\`)_

## 7. Probe Results

### Probe Set

- **scorecard prompt groups**: 3
- **scorecard runs**: 9

### Prompt-level aggregation

| prompt | scorecard status | runs | recommendedAsProduct | citedAsSource | negativeMentions | product verdict |
|---|---|---|---|---|---|---|
| ${REVENUE} | included | 3 | 0% | 0% | 0% | lost |
| ${ATTRIBUTION} | included | 3 | 100% | 100% | 0% | partial |
| ${FACTORS} | included | 3 | 100% | 0% | 0% | won |

### Live Perplexity Sonar probe · product verdict: **lost**

- **scorecard status**: included
- **prompt**: ${REVENUE}
- **platform**: \`perplexity\`
- **recommendedAsProduct**: no
- **productPosition**: absent
- **citedAsSource**: no
${competitorTable(revenueCompetitors)}
### Live Perplexity Sonar probe · product verdict: **partial**

- **scorecard status**: included
- **prompt**: ${ATTRIBUTION}
- **platform**: \`perplexity\`
- **recommendedAsProduct**: yes
- **productPosition**: 3
- **citedAsSource**: yes
${competitorTable(["Dreamdata", "Ruler Analytics", "Adobe Marketo Measure"])}
### Live Perplexity Sonar probe · product verdict: **won**

- **scorecard status**: included
- **prompt**: ${FACTORS}
- **platform**: \`perplexity\`
- **recommendedAsProduct**: yes
- **productPosition**: 1
- **citedAsSource**: no
${competitorTable(["Dreamdata", "Ruler Analytics", "Fibbler"])}
## 11. Gap Map

### Which prompts Northwind lost or under-performed

- ${REVENUE}
- ${ATTRIBUTION}

## 13. Fix Brief

- **lostPrompt**: ${REVENUE}
- **competitorRecommended**: ${revenueCompetitors.join(", ") || "none recorded"}
- **fixType**: comparison_page

#### Root cause

Observed: for the buyer question "${REVENUE}", the brand was not recommended in the stored runs examined. The stored evidence records this outcome but does not establish why the AI system produced it.

#### Recommended fix

Create an evidence-backed comparison page for the selected revenue-intelligence buyer question.

#### Evidence needed

- Specific features and advantages of Northwind for this buyer question.
`;
}

/** The strategic sentence, isolated from the neutral tally line above it. */
function strategicSentence(markdown: string): string {
  const section1 = markdown.slice(markdown.indexOf("## 1."), markdown.indexOf("## 2."));
  return section1.split("\n").find((l) => l.includes("The opportunity is")) ?? "";
}
function section1(markdown: string): string {
  return markdown.slice(markdown.indexOf("## 1."), markdown.indexOf("## 2."));
}
function rowFor(markdown: string, fragment: string): string {
  return markdown.split("\n").find((l) => l.startsWith("| ") && l.includes(fragment)) ?? "";
}
/** The "Result type" column. */
function resultType(row: string): string {
  return (row.split("|")[6] ?? "").trim();
}

console.log("test-short-report-prompt-scoped");

/* ---- normal case: global tally and prompt-scoped set genuinely differ ---- */
{
  const md = buildSalesReportFromMvpMarkdown(fixture(REVENUE_LOCAL)).markdown;
  const strategic = strategicSentence(md);
  const s1 = section1(md);

  check("strategic sentence is present", strategic !== "");

  // Fixture precondition: the global picture really is different, otherwise
  // the assertions below would pass trivially.
  check("PRECONDITION global tally names prompt-foreign products",
    PROMPT_FOREIGN.some((n) => s1.includes(n)));

  for (const n of ["Clari", "Gong", "Salesforce Revenue Intelligence"]) {
    check(`strategy names prompt-local "${n}"`, strategic.includes(n));
  }
  for (const n of PROMPT_FOREIGN) {
    check(`strategy excludes prompt-foreign "${n}"`, !strategic.includes(n));
  }
  check("global tally may remain as neutral context",
    s1.includes("Competitors AI recommended across the tested prompts"));
  check("neutral tally is separate from the strategic sentence",
    s1.includes("Dreamdata") && !strategic.includes("Dreamdata"));

  /* ---- verdict-aware result labels ---- */
  const won = rowFor(md, FACTORS);
  const partial = rowFor(md, ATTRIBUTION);
  const lost = rowFor(md, REVENUE);
  check("won row exists", won !== "");
  check("won row is not labelled a loss", !/loss/i.test(resultType(won)));
  check("won row states it was won", /won/i.test(resultType(won)));
  check("partial row is not labelled a full loss", !/loss/i.test(resultType(partial)));
  check("lost row keeps an accurate loss classification", /loss/i.test(resultType(lost)));

  /* ---- date provenance ---- */
  check("render date is not presented as the scan date",
    !/live scan performed on/.test(md));
  check("render date is labelled honestly", /render date, not the scan date/.test(md));

  /* ---- PR #22 protections ---- */
  check("recommended fix comes from the Fix Brief, not a synthetic replacement",
    md.includes("Create an evidence-backed comparison page for the selected revenue-intelligence buyer question."));
  check("fix keeps the AI-recommendation guardrail",
    md.includes("should not claim that AI will recommend"));
  check("no synthetic buyer frame — §3 uses the Fix Brief's own prompt",
    md.includes(REVENUE));
}

/* ---- empty case: no global fallback when the prompt has no competitors ---- */
{
  const md = buildSalesReportFromMvpMarkdown(fixture([])).markdown;
  const strategic = strategicSentence(md);
  const s1 = section1(md);

  // Precondition: globally frequent competitors still exist in this fixture,
  // so a fallback would have something to reach for.
  check("PRECONDITION global competitors still exist in the empty case",
    PROMPT_FOREIGN.some((n) => s1.includes(n)));

  for (const n of PROMPT_FOREIGN) {
    check(`empty case: global "${n}" never enters the strategic sentence`,
      !strategic.includes(n));
  }
  for (const n of REVENUE_LOCAL) {
    check(`empty case: no competitor is invented ("${n}")`, !strategic.includes(n));
  }
  // `formatList` substitutes a placeholder for an empty list; the clause must
  // be dropped rather than rendering "against not enough evidence yet".
  check("empty case: no placeholder text leaks into the sentence",
    !/not enough evidence yet/.test(strategic));
  check("empty case: the sentence still renders without a competitor clause",
    strategic === "" || !/against\s+\w/.test(strategic));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
