#!/usr/bin/env tsx
/** Landing-only guard for the canonical automated V1 public journey. */
import { readFileSync } from "node:fs";

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log("  ok   " + label);
  else { failures += 1; console.error("  FAIL " + label); }
}

/** JSX wraps prose across source lines, so phrase guards must read it flattened. */
function flatten(source: string): string {
  return source.replace(/\s+/g, " ");
}

async function main(): Promise<void> {
  console.log("test-landing-page");
  (globalThis as unknown as { React: unknown }).React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const Page = require("@/app/page").default;
  const html: string = renderToStaticMarkup(await Page());
  const flat = html.replace(/\s+/g, " ");

  const pageSource = readFileSync("app/page.tsx", "utf8");
  const headerSource = readFileSync("components/marketing/site-header.tsx", "utf8");
  const dashboardSource = readFileSync("components/marketing/evidence-dashboard.tsx", "utf8");
  const cssSource = readFileSync("app/tailwind.css", "utf8");
  const layoutSource = readFileSync("app/layout.tsx", "utf8");
  const tailwindConfigSource = readFileSync("tailwind.config.ts", "utf8");
  const scanPageSource = readFileSync("app/scan/page.tsx", "utf8");
  const scanFormSource = readFileSync("app/scan/scan-form.tsx", "utf8");
  const verifyClientSource = readFileSync("app/verify-email/verify-email-client.tsx", "utf8");
  const verificationEmailSource = readFileSync("lib/snapshot-requests/verification-email-delivery.ts", "utf8");
  const publicFormSource = readFileSync("lib/snapshot-requests/public-form.ts", "utf8");
  const publicJourneySource = [
    pageSource,
    headerSource,
    dashboardSource,
    scanPageSource,
    scanFormSource,
    verifyClientSource,
    verificationEmailSource,
    publicFormSource,
  ].join("\n");

  check("Tailwind marketing root renders", html.includes('class="v2-root"'));
  check("approved headline renders", flat.includes("Turn AI answers") && flat.includes("into evidence"));
  check("primary CTA keeps the protected request route", flat.includes("Request demo") && /href=["']\/scan["']/.test(html));
  check("scroll chapters have real anchors", ["evidence", "how-it-works", "features", "scope", "outcomes", "faq"].every((id) => html.includes(`id="${id}"`)));
  check("nav placeholders are absent", !/href=["']#["']/.test(html));

  check("V1 automation is explicit", flat.includes("Automated after approval") && flat.includes("controlled baseline runs automatically"));
  check("approval remains a hard precondition", flat.includes("Nothing runs until the question, limits, sampling plan and observation window are approved"));
  check("integrity delivery branches render", ["integrity_passed", "needs_review", "blocked"].every((status) => flat.includes(status)));
  check("blocked never delivers a conclusion", flat.includes("No conclusion or report delivered as certainty"));
  check("delivery gate meaning is not colour-only", pageSource.includes("{gate.status}") && pageSource.includes('aria-hidden="true"'));

  check("hero product preview is labelled synthetic", flat.includes("Synthetic example") && flat.includes("not a live Perplexity probe"));
  check("excluded attempts stay in the denominator", flat.includes("Failed and excluded attempts stay visible in the denominator"));
  check("preview reports attempt reconciliation, not a headline score", ["Preserved", "Retried", "Excluded"].every((label) => flat.includes(label)));
  check("no universal visibility score is claimed", flat.includes("No universal score, no market-wide claim"));

  check("all four Outcome Card results render equally", ["Increase observed", "Decrease observed", "No clear change", "Inconclusive"].every((copy) => flat.includes(copy)));
  check("limitations remain visible", flat.includes("Observed movement is not proof of causality or revenue impact"));
  check("incomplete evidence fails closed", flat.includes("Incomplete or inconsistent evidence fails closed"));

  check("eight FAQ questions render", [
    "What does Zypact V1 include?",
    "Which AI platform does V1 test?",
    "Why is there no fixed number of runs?",
    "Is this an SEO audit?",
    "Do you guarantee ranking, recommendation or revenue improvement?",
    "What if nothing clearly changes?",
    "What happens after I request a demo?",
    "Do I need a subscription?",
  ].every((question) => flat.includes(question)));
  check("Perplexity-only scope is explicit", flat.includes("Perplexity Sonar is the only live V1 surface"));
  check("no fixed three-run default is promised", flat.includes("does not silently treat three runs"));
  check("no favorable outcome is guaranteed", flat.includes("not a favorable model response"));

  const flatScanPage = flatten(scanPageSource);
  const flatScanForm = flatten(scanFormSource);

  check("request page explains controlled automation", flatScanPage.includes("Zypact V1 · Controlled automation") && flatScanPage.includes("Zypact reviews the question and protocol first") && flatScanPage.includes("baseline runs automatically"));
  check("request page states that submitting starts no paid call", flatScanPage.includes("Submitting this form does not start an AI call"));
  check("request form separates request from execution", flatScanForm.includes("Request only.") && flatScanForm.includes("No AI call starts until the question and protocol are approved"));
  check("verification page no longer makes founder review the normal path", verifyClientSource.includes("automation begins only after the buyer") && !verifyClientSource.includes("waiting for a fit review"));
  check("verification email explains the approval gate", verificationEmailSource.includes("V1 automation begins only after the buyer question and protocol are approved"));

  const bannedPublicCopy = [
    "Request free snapshot",
    "Free AI visibility snapshot",
    "five unbranded buyer questions",
    "Buyer questions won or lost",
    "Recommendation rate",
    "Citation rate",
    "See why AI assistants",
    "shows where your brand loses",
    "tests real buyer questions",
    "one buyer question surfaces",
    "FOUNDER-LED PILOT · NO AUTOMATIC SCAN",
    "Founder reviewed. No AI call starts",
  ];
  for (const banned of bannedPublicCopy) {
    check("legacy public copy removed: " + banned, !publicJourneySource.includes(banned));
  }

  for (const banned of ["$99", "$199", "Start Growth", "Start Pro", "Growth $99", "Pro $199"]) {
    check("no public pricing string: " + banned, !html.includes(banned));
  }
  check("no Stripe checkout string", !/stripe\.com|buy\.stripe|checkout\.stripe/i.test(html));
  check("public errors remain request-scoped", publicFormSource.includes("Demo requests are temporarily unavailable."));

  check("mobile menu exposes expanded state", headerSource.includes("aria-expanded={open}") && headerSource.includes('aria-controls="marketing-mobile-menu"'));
  check("mobile nav reaches every section", headerSource.includes('aria-label="Primary (mobile)"'));
  check("FAQ uses native details", pageSource.includes("<details") && pageSource.includes("<summary"));

  // Tailwind is loaded globally but every utility is scoped, so the legacy
  // stylesheets that still style /scan, /report and /projects cannot be reset.
  check("Tailwind stylesheet is imported by the root layout", layoutSource.includes('"./tailwind.css"'));
  check("legacy stylesheets still load for the remaining legacy routes", layoutSource.includes('"./globals.css"') && layoutSource.includes('"./landing-v1.css"'));
  check("utilities stay scoped to the marketing/admin root", tailwindConfigSource.includes('important: ".v2-root"'));
  check("preflight cannot leak into legacy pages", tailwindConfigSource.includes("preflight: false"));
  check("scoped preflight out-specifies legacy element rules", cssSource.includes(".v2-root :where(h1, h2, h3, h4)"));
  check("legacy .grid margin leak stays neutralised", cssSource.includes(".v2-root.v2-root :where(.grid)"));
  check("reduced-motion CSS exists", cssSource.includes("prefers-reduced-motion: reduce"));
  check("focus-visible outline is preserved", cssSource.includes(":focus-visible"));

  const plans = readFileSync("lib/pricing/plans.ts", "utf8");
  check("Growth pricing source remains intact", plans.includes("priceMonthlyUsd: 99"));
  check("Pro pricing source remains intact", plans.includes("priceMonthlyUsd: 199"));
  check("saved-project entitlements remain 0/3/5", /free:[\s\S]*projects:\s*0/.test(plans) && /growth:[\s\S]*projects:\s*3/.test(plans) && /pro:[\s\S]*projects:\s*5/.test(plans));

  console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURE(S)");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("ERROR", error?.message ?? error);
  process.exit(1);
});
