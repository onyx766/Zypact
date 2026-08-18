#!/usr/bin/env tsx
/**
 * The public client report is a founder-led conversation, not a checkout.
 *
 * Two things this locks down. First, the preview used to end in Growth/Pro
 * plan cards with Stripe links, which framed a validation-phase snapshot as
 * self-service SaaS. Second, it labelled the competitor tally "Brands
 * appearing where <brand> did not" — but that tally is global across every
 * tested prompt, so it included brands that showed up on prompts the client
 * won or partially won. On the first real commercial snapshot that meant
 * naming three competitors as displacing the client when two of them had
 * done no such thing.
 *
 * The parser assertions execute the real production parser against a
 * synthetic fixture. The page assertions render the real async server
 * component to HTML with a stubbed database module, so every claim below is
 * about what a client would actually see.
 *
 * Source-text assertions are kept only where they say something the render
 * cannot — that the pricing source of truth still exists elsewhere. An
 * earlier version of this file checked the page as text throughout, and an
 * independent review showed that was not enough: replacing the prompt table
 * with an empty array left `report.promptRows` in the source, so the grep
 * passed while the evidence vanished from the page.
 */
import { readFileSync } from "node:fs";
import { parsePublicSnapshotReport } from "@/lib/snapshot-requests/parse-public-report";

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ok   ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}`); }
}

const BRAND = "Northwind";
const FIXTURE = `# Zypact Short Report — ${BRAND}

Generated: 2026-01-02
Website: northwind.example
Category read by AI: B2B revenue data intelligence platform

## 1. Executive diagnosis

**Visibility:** 40% recommended as a product across 5 buyer prompts and 15 live AI runs.
**Branded reputation:** Not tested in this snapshot.
**Competitors AI recommended across the tested prompts:** Dreamdata — 6 mentions, Ruler Analytics — 6 mentions and Clari — 3 mentions.

## 2. What happened in the AI probes

All 5 tested buyer prompts are shown below. Each prompt was run 3 times using live AI answers.

| Buyer prompt tested | Runs | Recommended ${BRAND}? | Cited ${BRAND} as source? | Outcome | Result type | Brands / products observed |
|---|---:|---:|---:|---|---|---|
| How to compare B2B revenue intelligence platforms? | 3 | 0% | 0% | lost | Competitive discovery loss | Clari (3), Gong (3) |
| Alternatives to Factors.ai for custom reporting in B2B? | 3 | 100% | 0% | won | Won — brand recommended | Dreamdata (3) |

## 3. Why this matters commercially

AI answers increasingly behave like shortlists. Brands that do not appear are invisible at the moment of consideration.

For ${BRAND}, the clearest under-performance opportunity is:

> How to compare B2B revenue intelligence platforms?

In that frame, AI also recommended Clari and Gong, so ${BRAND} is not yet the clear primary choice.

## 4. First recommended fix

**Strengthen comparison / proof content around the under-performing buying frame.**

Create a comparison page.

### Evidence needed before publish-ready copy

- Specific features and advantages.

## 5. Suggested next step

Expand the prompt set on a recurring scan.

## 6. Integrity notes

- Probe source: live Perplexity Sonar responses from the stored scan for this project.
`;

console.log("test-public-report-preview");

async function main(): Promise<void> {

/* ---- executable: the real parser ---- */
{
  const report = parsePublicSnapshotReport(FIXTURE);

  check("competitor label is the neutral global-tally wording",
    report.competitorLabel === "Most-mentioned brands across the tested buyer prompts");
  check("competitor label no longer claims displacement",
    !/appearing where/i.test(report.competitorLabel) &&
    !report.competitorLabel.includes(BRAND));
  check("label is generic, not brand-specific",
    !new RegExp(BRAND, "i").test(report.competitorLabel));

  // The counts themselves must be untouched by the relabelling.
  check("mention counts are preserved verbatim",
    report.competitors.includes("Dreamdata — 6 mentions") &&
    report.competitors.includes("Ruler Analytics — 6 mentions") &&
    report.competitors.includes("Clari — 3 mentions"));

  // Evidence the client actually reads must survive.
  check("visibility sentence preserved", /40%/.test(report.visibility));
  check("prompt evidence preserved",
    report.promptRows.some((row) =>
      row.prompt.includes("How to compare B2B revenue intelligence platforms?")));
  check("won prompt still present in the evidence table",
    report.promptRows.some((row) => /Alternatives to Factors\.ai/.test(row.prompt)));
  check("per-prompt observed brands preserved",
    report.promptRows.some((row) => /Clari/.test(JSON.stringify(row))));
  check("first recommended fix preserved",
    /comparison/i.test(report.firstFixHeading + report.firstFixBody));
  check("integrity notes preserved", report.integrityNotes.length > 0);
}

/* ---- source-level: the preview page carries no checkout ---- */
{
  const page = readFileSync("app/report/[secureToken]/page.tsx", "utf8");

  check("no $99 in the preview", !page.includes("$99"));
  check("no $199 in the preview", !page.includes("$199"));
  check("no Start Growth CTA", !page.includes("Start Growth"));
  check("no Start Pro CTA", !page.includes("Start Pro"));
  check("no Stripe checkout URLs", !/STRIPE_[A-Z_]*URL|stripe\.com|buy\.stripe/i.test(page));
  check("no pricing plan source pulled into the preview",
    !page.includes("PRICING_PLANS") && !page.includes("@/lib/pricing/plans"));
  check("no plan grid markup", !page.includes("report-plan-grid"));
  check("no billing label rendered", !page.includes("billingLabel"));

  check("founder-led heading present", page.includes("Want to go deeper?"));
  check("founder-led walkthrough copy present",
    page.includes("the buyer") && page.includes("the first") &&
    page.includes("fix worth testing"));
  check("founder-led re-test copy present",
    page.includes("more buyer") && page.includes("re-test what changes"));
  check("no invented booking destination",
    !/calendly|cal\.com|hubspot\.com\/meetings|savvycal/i.test(page));

  // The report body itself must still render.
  check("report evidence sections still rendered",
    page.includes("report.promptRows") && page.includes("report.integrityNotes"));
}

/* ---- the pricing source of truth is untouched ---- */
{
  const plans = readFileSync("lib/pricing/plans.ts", "utf8");
  check("Growth pricing source of truth intact",
    plans.includes("priceMonthlyUsd: 99") && plans.includes('primaryCta: "Start Growth"'));
  check("Pro pricing source of truth intact",
    plans.includes("priceMonthlyUsd: 199") && plans.includes('primaryCta: "Start Pro"'));
}

/* ---- rendered: the real page component, stubbed database ---- */
{
  // Set the classic-runtime global the compiled JSX expects, without
  // declaring a top-level `React` binding that would collide with the
  // ambient React namespace during typecheck.
  (globalThis as unknown as { React: unknown }).React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");

  const TOKEN = "t".repeat(43);
  const dbPath = require.resolve("@/lib/db");
  require.cache[dbPath] = {
    id: dbPath,
    loaded: true,
    exports: {
      getDb: () => ({
        getSnapshotReportArtifactByPublicToken: async () => ({
          id: "00000000-0000-4000-8000-0000000000ff",
          shortReportMarkdown: FIXTURE,
          fullReportMarkdown: "# full report",
          publicToken: TOKEN,
          deliveredAt: null,
        }),
      }),
    },
  } as unknown as NodeJS.Module;

  const Page = require("@/app/report/[secureToken]/page").default;
  const html: string = renderToStaticMarkup(
    await Page({ params: Promise.resolve({ secureToken: TOKEN }) })
  );
  const flat = html.replace(/\s+/g, " ");

  /* what the client must still see */
  check("rendered: report identity", html.includes(BRAND) && html.includes("northwind.example"));
  check("rendered: category read by AI", html.includes("B2B revenue data intelligence platform"));
  check("rendered: visibility content", html.includes("40%") && html.includes("15 live AI runs"));
  check("rendered: competitor summary with counts",
    html.includes("Dreamdata — 6 mentions") && html.includes("Clari — 3 mentions"));
  check("rendered: corrected competitor label",
    html.includes("Most-mentioned brands across the tested buyer prompts"));

  // The regression an earlier source-only assertion missed entirely: emptying
  // the prompt rows leaves the source untouched but blanks the evidence table.
  check("rendered: concrete buyer prompt row present",
    html.includes("How to compare B2B revenue intelligence platforms?"));
  check("rendered: second prompt row present",
    html.includes("Alternatives to Factors.ai for custom reporting in B2B?"));
  check("rendered: prompt row carries its run count and outcome",
    /lost/i.test(html) && /won/i.test(html));
  check("rendered: prompt evidence is a populated table",
    (html.match(/<tr/g) ?? []).length >= 3);

  check("rendered: why this matters content", flat.includes("behave like shortlists"));
  check("rendered: first priority action",
    /Strengthen comparison|comparison page/i.test(html));
  check("rendered: evidence needed", html.includes("Specific features and advantages"));
  check("rendered: methodology / integrity content", html.includes("Perplexity"));
  check("rendered: founder-led CTA", html.includes("Want to go deeper?"));

  /* what the client must never see */
  for (const banned of ["$99", "$199", "Start Growth", "Start Pro", "Growth $99", "Pro $199"]) {
    check(`rendered: no "${banned}"`, !html.includes(banned));
  }
  check("rendered: no old plan-card markup",
    !html.includes("report-plan-grid") && !html.includes("Continue with Zypact"));
  check("rendered: no Stripe checkout URL",
    !/stripe\.com|buy\.stripe|checkout\.stripe/i.test(html));
  check("rendered: no /#pricing fallback link", !html.includes("/#pricing"));
  check("rendered: no old displacement label", !/appearing where/i.test(html));
  check("rendered: no invented booking destination",
    !/calendly|cal\.com|savvycal|hubspot\.com\/meetings|mailto:/i.test(html));
  check("rendered: no guarantee language", !/guarantee/i.test(html));
}

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("ERROR", error?.message ?? error);
  process.exit(1);
});
