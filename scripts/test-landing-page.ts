#!/usr/bin/env tsx
/** Landing-only guard for the bounded V1 public journey. */
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
  const cssSource = readFileSync("app/globals.css", "utf8");
  const scanPageSource = readFileSync("app/scan/page.tsx", "utf8");
  const scanFormSource = readFileSync("app/scan/scan-form.tsx", "utf8");
  const verifyPageSource = readFileSync("app/verify-email/page.tsx", "utf8");
  const verifyClientSource = readFileSync("app/verify-email/verify-email-client.tsx", "utf8");
  const verificationEmailSource = readFileSync("lib/snapshot-requests/verification-email-delivery.ts", "utf8");
  const publicFormSource = readFileSync("lib/snapshot-requests/public-form.ts", "utf8");
  const publicJourneySource = [
    pageSource,
    interactionSource,
    scanPageSource,
    scanFormSource,
    verifyPageSource,
    verifyClientSource,
    verificationEmailSource,
    publicFormSource,
  ].join("\n");

  check("dark intelligence root renders", html.includes('class="di-page"'));
  check("bounded V1 positioning renders", flat.includes("See which competitors") && flat.includes("one buyer question surfaces") && flat.includes("what to test first"));
  check("V1 mechanism renders", flat.includes("one commercially important buyer question") && flat.includes("one evidence-backed intervention") && flat.includes("after the observation window"));
  check("primary CTA uses the protected request route", flat.includes("Request Demo") && /href=["']\/scan["']/.test(html));
  check("real section anchors exist", html.includes('id="what-you-get"') && html.includes('id="how-it-works"') && html.includes('id="faq"'));
  check("nav placeholders removed", !/href=["']#["']/.test(html));

  check("synthetic protocol example is labeled", flat.includes("synthetic V1 example") && flat.includes("SIMULATION"));
  check("synthetic example does not use a LIVE badge", !/>\s*LIVE\s*</i.test(html) && !/snapshot-live/i.test(html));
  check("synthetic example has no real prospect", !/HockeyStack|hockeystack\.com/i.test(html));
  check("canonical observation labels render", ["Not observed", "Listed", "Primary", "Ambiguous"].every((status) => html.includes(status)));
  check("three synthetic buyer questions exist", (interactionSource.match(/question:\s*"/g) ?? []).length === 3);
  check("demo switching is state-driven", interactionSource.includes("setSelected(index)") && interactionSource.includes('role="tablist"'));
  check("synthetic demo auto-rotates safely", interactionSource.includes("V1 EXAMPLE") && interactionSource.includes("5200") && interactionSource.includes("setManual(true)"));
  check("hero explains the bounded V1 flow", ["V1 PILOT FLOW", "Approved question", "Bounded protocol", "Exact baseline", "One hypothesis", "Outcome Card"].every((copy) => interactionSource.includes(copy)));
  check("hero process animation respects reduced motion", interactionSource.includes("useReducedMotion()") && interactionSource.includes("if (reducedMotion) return"));

  check("six V1 deliverables render", (html.match(/di-deliverable-card/g) ?? []).length === 6);
  check("registered intervention and Outcome Card render", ["Registered intervention", "Auditable Outcome Card", "increase observed", "decrease observed", "no clear change", "inconclusive"].every((copy) => flat.includes(copy)));
  const workflowBlock = interactionSource.match(/const workflow = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
  check("five workflow steps exist", (workflowBlock.match(/number: "0[1-5]"/g) ?? []).length === 5);
  check("workflow accordion is state-driven", interactionSource.includes("setActive(index)") && interactionSource.includes("di-step-selector"));

  check("eight FAQ questions render", (html.match(/<details/g) ?? []).length === 8);
  check("Perplexity-only V1 scope is explicit", /Perplexity Sonar is the initial live V1 surface/i.test(flat));
  check("market-wide score refusal is explicit", /No market-wide score/i.test(flat));
  check("fixed three-run default is refused", /does not silently treat three runs/i.test(flat));
  check("guarantee refusal is explicit", flat.includes("Do you guarantee ranking, recommendation, or revenue improvement?") && flat.includes("Zypact guarantees the agreed process and evidence contract"));
  check("no-subscription pilot scope renders", flat.includes("No self-serve subscription is required"));
  check("demo form cannot imply automatic execution", flat.includes("No AI scan starts from the form"));

  const bannedPublicCopy = [
    "Request free snapshot",
    "Free AI visibility snapshot",
    "five unbranded buyer questions",
    "three times in Perplexity",
    "Buyer questions won or lost",
    "Recommendation rate",
    "Citation rate",
    "See why AI assistants",
    "shows where your brand loses",
    "tests real buyer questions",
  ];
  for (const banned of bannedPublicCopy) {
    check("legacy public copy removed: " + banned, !publicJourneySource.includes(banned));
  }

  for (const banned of ["$99", "$199", "Start Growth", "Start Pro", "Growth $99", "Pro $199"]) {
    check("no public pricing string: " + banned, !html.includes(banned));
  }
  check("no Stripe checkout string", !/stripe\.com|buy\.stripe|checkout\.stripe/i.test(html));
  check("no fake multi-platform coverage", !/test(s|ed|ing)? (ChatGPT|Gemini|Claude).*(and|,)/i.test(flat));
  check("no guarantee language as a positive claim", !/we guarantee|guaranteed (ranking|citation|recommendation|visibility)/i.test(flat));

  check("mobile menu has accessible expanded state", interactionSource.includes('aria-expanded={open}') && interactionSource.includes('aria-controls="di-mobile-menu"'));
  check("FAQ uses native accessible details", pageSource.includes("<details") && pageSource.includes("<summary"));
  check("reduced-motion CSS exists", cssSource.includes("prefers-reduced-motion"));
  check("modern startup typography uses Inter", cssSource.includes("family=Inter:wght@400;500;600;700;800") && cssSource.includes(".di-page") && cssSource.includes('font-family: "Inter", -apple-system, BlinkMacSystemFont'));
  check("landing display scale remains compact", cssSource.includes("clamp(2.35rem, 3.55vw, 3.65rem)") && cssSource.includes("clamp(1.65rem, 2.4vw, 2.5rem)"));
  check("mobile display scale remains compact", cssSource.includes("clamp(2rem, 8.4vw, 2.65rem)") && cssSource.includes("clamp(1.55rem, 6.6vw, 2rem)"));
  check("section spacing remains tightened", cssSource.includes(".di-section { padding: 72px 0;") && cssSource.includes(".di-final-cta { position: relative; overflow: hidden; padding: 72px 0 68px;"));
  check("professional motion UI remains present", cssSource.includes("di-process-scan") && cssSource.includes("di-demo-auto-bar") && cssSource.includes("di-process-step.is-active"));
  check("request-page heading scale remains compact", cssSource.includes("clamp(2.05rem, 3.9vw, 3.05rem)") && cssSource.includes("clamp(1.65rem, 4vw, 2.3rem)"));
  check("protected request journey keeps its dark palette", cssSource.includes("Dark intelligence snapshot journey") && cssSource.includes("--snapshot-teal: #00ddb4"));
  check("request form Turnstile uses dark theme", scanFormSource.includes('theme: "dark"'));
  check("email verification shares dark palette", cssSource.includes(".verification-page") && cssSource.includes(".verification-card"));

  const plans = readFileSync("lib/pricing/plans.ts", "utf8");
  check("Growth pricing source remains intact", plans.includes("priceMonthlyUsd: 99"));
  check("Pro pricing source remains intact", plans.includes("priceMonthlyUsd: 199"));
  check("saved-project entitlements remain 0/3/5", /free:[\s\S]*projects:\s*0/.test(plans) && /growth:[\s\S]*projects:\s*3/.test(plans) && /pro:[\s\S]*projects:\s*5/.test(plans));

  check("protected request route is preserved", scanPageSource.includes("Request a Zypact V1 demo") && scanPageSource.includes("Perplexity Sonar"));
  check("request form is reframed as a demo", scanFormSource.includes("Request Demo") && scanFormSource.includes("No AI scan has"));
  check("verification journey is reframed as a demo", verifyPageSource.includes("Zypact V1 demo request") && verifyClientSource.includes("demo request") && verificationEmailSource.includes("Zypact V1 demo request"));
  check("public errors refer to demo requests", publicFormSource.includes("Demo requests are temporarily unavailable."));

  console.log(failures === 0 ? "\nALL PASS" : "\n" + failures + " FAILURE(S)");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("ERROR", error?.message ?? error);
  process.exit(1);
});
