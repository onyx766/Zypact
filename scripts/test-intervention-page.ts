#!/usr/bin/env tsx
/** Guards the registered intervention page: its frozen copy, CTA, and indexability. */
export {};

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log("  ok   " + label);
  else { failures += 1; console.error("  FAIL " + label); }
}

const PATH = "/perplexity-content-change-test";

const FROZEN_COPY = [
  "Test whether a content change changed the Perplexity answer",
  "AI answers can change even when your website does not. That makes it difficult to know whether a new comparison page, positioning update, proof point, or content change actually moved the answer.",
  "Zypact tests one approved buyer question before and after one documented intervention using the same controlled protocol.",
  "The problem with checking once",
  "Asking Perplexity once before a change and once afterward is not enough to distinguish meaningful movement from normal model and retrieval variation.",
  "A controlled test keeps the buyer question fixed, preserves the baseline evidence, records the intervention before the result exists, waits through the observation window, and retests the same question.",
  "How Zypact tests a change",
  "Baseline — run the same approved buyer question and preserve the answers, sources, and metadata.",
  "Register one change — record one content or positioning intervention before it is implemented.",
  "Implement — publish the documented change and preserve implementation evidence.",
  "Wait — use the predefined observation window rather than immediately checking for a favorable answer.",
  "Retest — ask the exact same buyer question again under the registered protocol and compare the evidence.",
  "What Zypact looks for",
  "The retest does not ask whether your SEO “improved.” It asks whether the observed buyer answer changed within the registered experiment.",
  "Was the company named?",
  "Did its position in the answer change?",
  "Did the cited evidence change?",
  "Did competitors appear differently?",
  "Did the result pass the predefined decision threshold?",
  "What this does not prove",
  "An observed change is not proof that one page caused the model response. Perplexity, retrieved sources, competitor content, and other external factors can change during the observation window. Zypact preserves those limitations rather than turning one experiment into a causal or revenue claim.",
  "Test one buyer question",
];

async function main(): Promise<void> {
  console.log("test-intervention-page");
  (globalThis as unknown as { React: unknown }).React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const mod = require("@/app/perplexity-content-change-test/page");
  const { INDEXABLE_PATHS, isNoindexPath, DISALLOWED_PATH_PREFIXES } = require("@/lib/seo/legacy-routes");

  const html: string = renderToStaticMarkup(mod.default());
  const text = html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

  for (const copy of FROZEN_COPY) {
    check(`renders: ${copy.slice(0, 60)}`, text.includes(copy));
  }

  check("exactly one h1", (html.match(/<h1[\s>]/g) ?? []).length === 1);
  check("uses the marketing design root", html.includes('class="v2-root"'));
  check("header and final CTA both link to /scan", (html.match(/href="\/scan"/g) ?? []).length === 2);
  check("no structured data is added", !html.includes("application/ld+json"));

  const meta = mod.metadata;
  check("exact page title", meta.title?.absolute === "Did Your Content Change Move the Perplexity Answer? | Zypact");
  check("self-referencing canonical", meta.alternates?.canonical === PATH);
  check("no page-level noindex", meta.robots === undefined);

  check("listed as indexable (sitemap)", INDEXABLE_PATHS.includes(PATH));
  check("not served with noindex", !isNoindexPath(PATH));
  check("not disallowed in robots.txt", !DISALLOWED_PATH_PREFIXES.some((p: string) => PATH === p || PATH.startsWith(`${p}/`)));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nall intervention page checks passed.");
}

main().catch((err) => { console.error(err); process.exit(1); });
