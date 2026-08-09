#!/usr/bin/env tsx
/**
 * Founder-led landing guard.
 *
 * The public homepage should explain the current diagnostic clearly without
 * presenting Zypact as a self-service subscription checkout. These checks
 * render the actual production page and assert against client-visible HTML.
 */
import { readFileSync } from "node:fs";

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}`);
  }
}

async function main(): Promise<void> {
  console.log("test-landing-page");

  (globalThis as unknown as { React: unknown }).React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const Page = require("@/app/page").default;
  const html: string = renderToStaticMarkup(await Page());
  const flat = html.replace(/\s+/g, " ");

  check(
    "hero positioning is visible",
    html.includes("See why AI assistants recommend your competitors instead of you.")
  );
  check(
    "mechanism is visible",
    flat.includes("tests real buyer questions") &&
      flat.includes("evidence gap") &&
      flat.includes("first fix worth testing")
  );
  check(
    "free snapshot CTA is visible and targets the real route",
    html.includes("Run your free AI visibility snapshot") &&
      /href=["']\/scan["']/.test(html)
  );

  check("synthetic product visual is visible", html.includes("Synthetic example"));
  check(
    "synthetic visual has no real prospect name",
    !/HockeyStack|hockeystack\.com/i.test(html)
  );
  check(
    "visual communicates the evidence-to-fix flow",
    html.includes("Missing comparison proof") &&
      html.includes("Build an evidence-backed comparison page")
  );
  check(
    "visibility progression is visible",
    html.includes("Absent") && html.includes("Mentioned") &&
      html.includes("Cited") && html.includes("Recommended")
  );

  check("what-you-get section is visible", html.includes("What your snapshot shows"));
  check(
    "buyer evidence outputs are visible",
    html.includes("Buyer questions your brand wins or loses") &&
      html.includes("Competitors that appear in the same buying frame") &&
      html.includes("What to re-test after the change")
  );
  check(
    "workflow is visible",
    flat.includes("Buyer question") && flat.includes("Live AI runs") &&
      flat.includes("Evidence") && flat.includes("First fix") && flat.includes("Re-test")
  );
  check(
    "B2B SaaS marketing ICP is explicit",
    /B2B SaaS marketing teams/i.test(html)
  );
  check(
    "current platform scope is explicit",
    /current live snapshot uses Perplexity Sonar/i.test(flat)
  );
  check(
    "multiplatform limitation is explicit",
    flat.includes("does not present the snapshot as equivalent coverage of ChatGPT, Gemini, Claude")
  );

  check("FAQ section is visible", html.includes("What the current snapshot does"));
  check(
    "all seven FAQ questions render",
    (html.match(/<details/g) ?? []).length === 7
  );
  check(
    "no guarantee answer is explicit",
    flat.includes("Can Zypact guarantee that AI will recommend my company?") &&
      flat.includes("No. AI answers vary.")
  );

  for (const banned of [
    "$99",
    "$199",
    "Start Growth",
    "Start Pro",
    "Growth $99",
    "Pro $199",
  ]) {
    check(`no public landing pricing string: ${banned}`, !html.includes(banned));
  }
  check(
    "no Stripe checkout URL in rendered landing",
    !/stripe\.com|buy\.stripe|checkout\.stripe/i.test(html)
  );
  check(
    "no pricing navigation or pricing section",
    !html.includes('href="#pricing"') && !html.includes('id="pricing"')
  );
  check(
    "no invented booking destination",
    !/calendly|cal\.com|savvycal|hubspot\.com\/meetings/i.test(html)
  );
  check(
    "no fake social proof",
    !/trusted by|customers love|\d+[,+]? customers|testimonial/i.test(flat)
  );

  const plans = readFileSync("lib/pricing/plans.ts", "utf8");
  check(
    "Growth historical pricing remains intact",
    plans.includes("priceMonthlyUsd: 99") && plans.includes('primaryCta: "Start Growth"')
  );
  check(
    "Pro historical pricing remains intact",
    plans.includes("priceMonthlyUsd: 199") && plans.includes('primaryCta: "Start Pro"')
  );
  check(
    "saved-project entitlements remain 0/3/5",
    /free:[\s\S]*limits:\s*{[\s\S]*?projects:\s*0/.test(plans) &&
      /growth:[\s\S]*limits:\s*{[\s\S]*?projects:\s*3/.test(plans) &&
      /pro:[\s\S]*limits:\s*{[\s\S]*?projects:\s*5/.test(plans)
  );

  const scanPage = readFileSync("app/scan/page.tsx", "utf8");
  check(
    "free snapshot route exists in application source",
    scanPage.includes("Free AI visibility snapshot") && scanPage.includes("Perplexity")
  );

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("ERROR", error?.message ?? error);
  process.exit(1);
});
