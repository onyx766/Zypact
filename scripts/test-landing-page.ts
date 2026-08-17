#!/usr/bin/env tsx
/** Landing-only guard for the canonical automated V1 public journey. */
import { readFileSync } from "node:fs";

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log("  ok   " + label);
  else { failures += 1; console.error("  FAIL " + label); }
}

async function main(): Promise<void> {
  console.log("test-landing-page");
  (globalThis as unknown as { React: unknown }).React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const Page = require("@/app/page").default;
  const html: string = renderToStaticMarkup(await Page());
  const flat = html.replace(/\s+/g, " ");

  const pageSource = readFileSync("app/page.tsx", "utf8");
  const interactionSource = readFileSync("components/landing-interactions.tsx", "utf8");
  const cssSource = readFileSync("app/landing-v1.css", "utf8");
  const layoutSource = readFileSync("app/layout.tsx", "utf8");
  const scanPageSource = readFileSync("app/scan/page.tsx", "utf8");
  const scanFormSource = readFileSync("app/scan/scan-form.tsx", "utf8");
  const verifyClientSource = readFileSync("app/verify-email/verify-email-client.tsx", "utf8");
  const verificationEmailSource = readFileSync("lib/snapshot-requests/verification-email-delivery.ts", "utf8");
  const publicFormSource = readFileSync("lib/snapshot-requests/public-form.ts", "utf8");
  const publicJourneySource = [
    pageSource,
    interactionSource,
    scanPageSource,
    scanFormSource,
    verifyClientSource,
    verificationEmailSource,
    publicFormSource,
  ].join("\n");

  check("light Evidence Trail root renders", html.includes('class="ev-page"'));
  check("approved headline renders", flat.includes("See which competitors appear for one critical buyer question.") && flat.includes("Choose what to test next."));
  check("primary CTA keeps the protected request route", flat.includes("Request Demo") && /href=["']\/scan["']/.test(html));
  check("five scroll chapters have real anchors", ["evidence", "method", "fit", "faq"].every((id) => html.includes(`id="${id}"`)));
  check("nav placeholders are absent", !/href=["']#["']/.test(html));

  check("V1 automation is explicit", flat.includes("Automated after approval") && flat.includes("controlled baseline runs automatically"));
  check("approval remains a hard precondition", flat.includes("Nothing runs until the question, limits, sampling plan and observation window are approved"));
  check("integrity delivery branches render", ["integrity_passed", "needs_review", "blocked"].every((status) => flat.includes(status)));
  check("human review is an exception path", flat.includes("Human review is an exception path for `needs_review`, not the normal V1 workflow."));

  check("hero orbit centers the Buyer question", interactionSource.includes("Buyer question") && interactionSource.includes("ev-orbit-center"));
  check("hero orbit shows the V1 evidence loop", ["Approve", "Perplexity", "Evidence", "Observe", "Register", "Retest"].every((label) => interactionSource.includes(label)));
  check("hero orbit explicitly excludes other surfaces", interactionSource.includes("Other AI surfaces are not represented because they are not part of V1"));
  check("orbit animation respects reduced motion", interactionSource.includes("useReducedMotion()") && interactionSource.includes("if (reducedMotion) return"));
  check("multi-model logos are not presented as orbit nodes", !/short:\s*"(ChatGPT|Gemini|Copilot|Claude)"/.test(interactionSource));

  check("one synthetic Question Record is prominent", flat.includes("QUESTION RECORD · QR-EXAMPLE-001") && flat.includes("SYNTHETIC EXAMPLE — NOT CUSTOMER DATA"));
  check("Question Record exposes exact evidence structure", ["Synthetic answer excerpt", "Source rows", "Prompt-scoped observation", "Registered intervention"].every((copy) => flat.includes(copy)));
  check("canonical observation labels render", ["Primary", "Listed", "Not observed", "Ambiguous"].every((status) => flat.includes(status)));
  check("registration stamp renders", pageSource.includes('aria-label="Registered before retest"'));
  check("Question Record has a four-stage retest rail", ["Baseline", "Registered", "Window", "Retest"].every((stage) => flat.includes(stage)));
  check("three-question carousel was removed", !interactionSource.includes("demoQuestions") && !interactionSource.includes('role="tablist" aria-label="Synthetic approved buyer question examples"'));

  check("monitoring distinction is neutral", flat.includes("Category monitoring") && flat.includes("Gives one question a record, an owner and a later check"));
  check("one question is framed as the evidence unit", flat.includes("One question is not a quota. It is the controlled unit of evidence."));
  check("all four Outcome Card results render equally", ["Increase observed", "Decrease observed", "No clear change", "Inconclusive"].every((copy) => flat.includes(copy)));
  check("limitations remain visible", flat.includes("Limitations remain on the primary card") && flat.includes("Observed movement is not proof of causality or revenue impact"));

  check("six V1 deliverables render", (html.match(/<li><span>0[1-6]<\/span><div><strong>/g) ?? []).length === 6);
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

  check("request page explains controlled automation", scanPageSource.includes("Zypact V1 · Controlled automation") && scanPageSource.includes("controlled baseline then runs") && scanPageSource.includes("automatically"));
  check("request form separates request from execution", scanFormSource.includes("Request only. Automation begins after") && scanFormSource.includes("does not approve a protocol or start an"));
  check("request Turnstile uses the light design", scanFormSource.includes('theme: "light"'));
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

  check("mobile menu exposes expanded state", interactionSource.includes('aria-expanded={open}') && interactionSource.includes('aria-controls="ev-mobile-menu"'));
  check("FAQ and method use native details", pageSource.includes("<details") && pageSource.includes("<summary"));
  check("new visual stylesheet is imported last", layoutSource.indexOf('"./landing-v1.css"') > layoutSource.indexOf('"./globals.css"'));
  check("warm light evidence palette exists", cssSource.includes("--ev-canvas: #f6f5f1") && cssSource.includes("--ev-accent: #214f73"));
  check("12-column-ready 1200px container exists", cssSource.includes("width: min(1200px, calc(100% - 48px))"));
  check("desktop hero type stays in the calibrated 52–56px range", cssSource.includes("font-size: clamp(3.25rem, 4.4vw, 3.5rem)") && cssSource.includes("line-height: 1.02") && cssSource.includes("letter-spacing: -.025em") && cssSource.includes("font-weight: 690"));
  check("hero copy keeps a readable measure and supporting scale", cssSource.includes(".ev-hero h1 { max-width: 620px") && cssSource.includes("font-size: clamp(17px, 1.35vw, 18px)") && cssSource.includes("line-height: 1.58"));
  check("diagram labels are product-readable", cssSource.includes(".ev-orbit-node strong { display: block; margin-top: 2px; font-size: 13px") && cssSource.includes(".ev-orbit-node small { display: block; margin-top: 3px; color: var(--ev-muted); font-size: 11px"));
  check("mobile headline stays in the 38–42px range", cssSource.includes("font-size: clamp(2.375rem, 10.5vw, 2.625rem); line-height: 1.05"));
  check("status meaning is not color-only", pageSource.includes("ev-status-primary\">Primary") && pageSource.includes("ev-status-not-observed\">Not observed"));
  check("mobile breakpoint preserves single-column records", cssSource.includes("@media (max-width: 600px)") && cssSource.includes(".ev-brand-rows,"));
  check("reduced-motion CSS exists", cssSource.includes("prefers-reduced-motion: reduce"));

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
