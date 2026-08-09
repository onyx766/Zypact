#!/usr/bin/env tsx
/** Landing-only guard for the dark intelligence homepage. */
import { readFileSync } from "node:fs";

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ok   ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}`); }
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
  const scanFormSource = readFileSync("app/scan/scan-form.tsx", "utf8");

  check("dark intelligence root renders", html.includes('class="di-page"'));
  check("hero positioning renders", flat.includes("See why AI assistants") && flat.includes("recommend your competitors"));
  check("B2B mechanism renders", flat.includes("tests real buyer questions") && flat.includes("evidence gaps") && flat.includes("first fix worth testing"));
  check("primary CTA uses real scan route", flat.includes("Request free snapshot") && /href=["']\/scan["']/.test(html));
  check("real section anchors exist", html.includes('id="what-you-get"') && html.includes('id="how-it-works"') && html.includes('id="faq"'));
  check("nav placeholders removed", !/href=["']#["']/.test(html));

  check("synthetic demo is explicitly labeled", flat.includes("synthetic demo") && flat.includes("SIMULATION"));
  check("synthetic demo does not use LIVE badge", !/>\s*LIVE\s*</i.test(html) && !/snapshot-live/i.test(html));
  check("synthetic demo has no real prospect", !/HockeyStack|hockeystack\.com/i.test(html));
  check("demo statuses render", ["Absent", "Mentioned", "Cited", "Recommended"].every((status) => html.includes(status)));
  check("three synthetic buyer questions exist", (interactionSource.match(/question: "/g) ?? []).length === 3);
  check("demo switching is state-driven", interactionSource.includes("setSelected(index)") && interactionSource.includes('role="tablist"'));
  check("synthetic demo auto-rotates safely", interactionSource.includes("AUTO DEMO") && interactionSource.includes("5200") && interactionSource.includes("setManual(true)"));
  check("hero explains the snapshot flow", interactionSource.includes("SNAPSHOT FLOW") && interactionSource.includes("Buyer question") && interactionSource.includes("AI run") && interactionSource.includes("Evidence map") && interactionSource.includes("First fix") && interactionSource.includes("Re-test"));
  check("hero process animation respects reduced motion", interactionSource.includes("useReducedMotion()") && interactionSource.includes("if (reducedMotion) return"));

  check("six deliverables render", (html.match(/di-deliverable-card/g) ?? []).length === 6);
  check("re-test output renders", flat.includes("What to re-test afterward"));
  const workflowBlock = interactionSource.match(/const workflow = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
  check("five workflow steps exist", (workflowBlock.match(/number: "0[1-5]"/g) ?? []).length === 5);
  check("cached typo is corrected", interactionSource.includes("no cached or synthetic answers") && !interactionSource.includes("no cached, cached"));
  check("workflow accordion is state-driven", interactionSource.includes("setActive(index)") && interactionSource.includes("di-step-selector"));

  check("eight FAQ questions render", (html.match(/<details/g) ?? []).length === 8);
  check("Perplexity-only scope is explicit", /Perplexity Sonar only right now/i.test(flat));
  check("market-wide limitation is explicit", /not a market-wide benchmark/i.test(flat));
  check("guarantee refusal is explicit", flat.includes("Do you guarantee ranking or recommendation improvements?") && flat.includes("No. AI answers vary."));
  check("no subscription required FAQ renders", flat.includes("No subscription is required to request the free snapshot"));

  for (const banned of ["$99", "$199", "Start Growth", "Start Pro", "Growth $99", "Pro $199"]) {
    check(`no public pricing string: ${banned}`, !html.includes(banned));
  }
  check("no Stripe checkout string", !/stripe\.com|buy\.stripe|checkout\.stripe/i.test(html));
  check("no fake multi-platform coverage", !/test(s|ed|ing)? (ChatGPT|Gemini|Claude).*(and|,)/i.test(flat));
  check("no guarantee language as positive claim", !/we guarantee|guaranteed (ranking|citation|recommendation|visibility)/i.test(flat));

  check("mobile menu has accessible expanded state", interactionSource.includes('aria-expanded={open}') && interactionSource.includes('aria-controls="di-mobile-menu"'));
  check("FAQ uses native accessible details", pageSource.includes("<details") && pageSource.includes("<summary"));
  check("reduced-motion CSS exists", cssSource.includes("prefers-reduced-motion"));
  check("modern startup typography uses Inter on public journey", cssSource.includes('family=Inter:wght@400;500;600;700;800') && cssSource.includes('.di-page') && cssSource.includes('font-family: "Inter", -apple-system, BlinkMacSystemFont'));
  check("landing display scale is Peec-like compact", cssSource.includes("clamp(2.35rem, 3.55vw, 3.65rem)") && cssSource.includes("clamp(1.65rem, 2.4vw, 2.5rem)"));
  check("mobile display scale is compact", cssSource.includes("clamp(2rem, 8.4vw, 2.65rem)") && cssSource.includes("clamp(1.55rem, 6.6vw, 2rem)"));
  check("section spacing is tightened", cssSource.includes(".di-section { padding: 72px 0;") && cssSource.includes(".di-final-cta { position: relative; overflow: hidden; padding: 72px 0 68px;"));
  check("professional motion UI is present", cssSource.includes("di-process-scan") && cssSource.includes("di-demo-auto-bar") && cssSource.includes("di-process-step.is-active"));
  check("snapshot heading scale is compact", cssSource.includes("clamp(2.05rem, 3.9vw, 3.05rem)") && cssSource.includes("clamp(1.65rem, 4vw, 2.3rem)"));
  check("snapshot request uses dark intelligence palette", cssSource.includes("Dark intelligence snapshot journey") && cssSource.includes("--snapshot-teal: #00ddb4"));
  check("snapshot form Turnstile uses dark theme", scanFormSource.includes('theme: "dark"'));
  check("snapshot verification shares dark palette", cssSource.includes(".verification-page") && cssSource.includes(".verification-card"));

  const plans = readFileSync("lib/pricing/plans.ts", "utf8");
  check("Growth pricing source remains intact", plans.includes("priceMonthlyUsd: 99"));
  check("Pro pricing source remains intact", plans.includes("priceMonthlyUsd: 199"));
  check("saved-project entitlements remain 0/3/5", /free:[\s\S]*projects:\s*0/.test(plans) && /growth:[\s\S]*projects:\s*3/.test(plans) && /pro:[\s\S]*projects:\s*5/.test(plans));

  const scanPage = readFileSync("app/scan/page.tsx", "utf8");
  check("existing snapshot route is preserved", scanPage.includes("Free AI visibility snapshot") && scanPage.includes("Perplexity"));

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => { console.error("ERROR", error?.message ?? error); process.exit(1); });
