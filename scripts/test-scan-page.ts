#!/usr/bin/env tsx
/**
 * Guard for the demo request page (/scan) after it moved onto the landing
 * design.
 *
 * The restyle was visual only: the metadata, the form contract and every
 * process statement had to survive unchanged. This suite renders the page in
 * both form states (SNAPSHOT_PUBLIC_FORM_ENABLED unset and "true") and reads
 * the sources, so a later redesign cannot quietly drop a field, a disclosure
 * or the `.lx` scope, or reintroduce copy the methodology forbids.
 *
 * Offline: no network (a throwing fetch stub proves nothing calls out), no
 * database, no environment beyond the one flag it sets itself.
 */
import { readFileSync } from "node:fs";

let failures = 0;
let total = 0;
function check(label: string, condition: boolean): void {
  total += 1;
  if (condition) console.log("  ✓ " + label);
  else {
    failures += 1;
    console.error("  ✗ " + label);
  }
}

let fetchCalls = 0;
(globalThis as unknown as { fetch: unknown }).fetch = () => {
  fetchCalls += 1;
  throw new Error("network disabled in test-scan-page");
};

const flatten = (source: string) => source.replace(/\s+/g, " ");

function render(enabled: boolean): string {
  const previous = process.env.SNAPSHOT_PUBLIC_FORM_ENABLED;
  if (enabled) process.env.SNAPSHOT_PUBLIC_FORM_ENABLED = "true";
  else delete process.env.SNAPSHOT_PUBLIC_FORM_ENABLED;
  try {
    const { renderToStaticMarkup } = require("react-dom/server");
    const Page = require("@/app/scan/page").default;
    return renderToStaticMarkup(Page());
  } finally {
    if (previous === undefined) delete process.env.SNAPSHOT_PUBLIC_FORM_ENABLED;
    else process.env.SNAPSHOT_PUBLIC_FORM_ENABLED = previous;
  }
}

function main(): void {
  console.log("test-scan-page");
  (globalThis as unknown as { React: unknown }).React = require("react");

  const pageSource = readFileSync("app/scan/page.tsx", "utf8");
  const formSource = readFileSync("app/scan/scan-form.tsx", "utf8");
  const headerSource = readFileSync("components/marketing/site-header.tsx", "utf8");
  const layoutSource = readFileSync("app/layout.tsx", "utf8");

  // ------------------------------------------------------------ Metadata
  const { metadata } = require("@/app/scan/page");
  check(
    "title describes the paid pilot and remains absolute",
    (metadata.title as { absolute?: string } | undefined)?.absolute === "Zypact Founding Paid Pilots — Request a Walkthrough"
  );
  check(
    "description describes guided scope without claiming a guaranteed pilot",
    metadata.description ===
      "Discuss a scoped founding paid pilot for Zypact's AI Answer Measurement & Intelligence platform. Review buyer questions, repeated measurements on supported APIs, competitors, citations, and possible marketing actions. Scope and pricing are agreed directly."
  );
  check("canonical stays /scan", metadata.alternates?.canonical === "/scan");
  check(
    "metadata declares nothing else",
    Object.keys(metadata).sort().join(",") === "alternates,description,title"
  );

  // ------------------------------------------------------ Rendered: open
  const open = render(true);
  const flatOpen = flatten(open);
  check("renders inside the Tailwind root", open.includes('class="v2-root"'));
  check("renders the landing .lx scope", /class="[^"]*\blx\b[^"]*"/.test(open));
  check("exactly one h1", (open.match(/<h1\b/g) ?? []).length === 1);
  check("h1 is the request headline", flatOpen.includes("Explore a founding paid pilot"));
  check("landing header renders", open.includes("data-lx-header"));
  check("header CTA jumps to the form on this page", /href="#request-form"/.test(open));
  check("form anchor exists", open.includes('id="request-form"'));
  check("landing footer renders", open.includes("lx-footer"));
  check(
    "footer keeps the execution line",
    flatOpen.includes("Launched by Zypact after approval")
  );
  check("footer links are not same-page landing anchors", !/href="#(how-it-works|reports|evidence|outcomes|scope|contact|faq)"/.test(open));
  check("steps band renders three steps", (open.match(/class="lx-how-step(?: |")/g) ?? []).length === 3);
  check("steps band avoids the landing scrollspy ids", !/id="(how-it-works|method|evidence|reports|faq)"/.test(open));

  for (const name of ["contactName", "companyName", "workEmail", "websiteUrl", "buyerCategory"]) {
    check(`field ${name} renders with id and name`, open.includes(`id="${name}"`) && open.includes(`name="${name}"`));
    check(`field ${name} keeps its label`, open.includes(`for="${name}"`));
  }
  check("form keeps noValidate", /<form[^>]*novalidate/i.test(open));
  check("submit button is a real submit", /<button[^>]*type="submit"/.test(open) && flatOpen.includes("Discuss a paid pilot"));
  check("buyer question keeps its help text", open.includes('id="buyerCategory-help"'));
  check("process disclosure renders", flatOpen.includes("Submitting this form does not start an AI call."));
  check("request-only disclosure renders", flatOpen.includes("Request only. No AI call starts until the question and protocol are approved."));

  // ---------------------------------------------------- Rendered: closed
  const closed = render(false);
  const flatClosed = flatten(closed);
  check("closed state says requests are not open", flatClosed.includes("Founding paid pilot inquiries are not open yet."));
  check("closed state renders no form", !/<form\b/.test(closed));
  check("closed state keeps the return link", /href="\/"[^>]*>\s*Return to Zypact/.test(closed));

  // ------------------------------------------------------------ Copy bans
  const banned = [
    /sign in/i,
    /sign up/i,
    /href="\/login"/,
    /free (ai )?(diagnostic|snapshot|score)/i,
    /runs automatically/i,
    /visibility score/i,
    /testimonial/i,
    /trusted by/i,
    /\+\s?\d+\s?%/,
    /\$\d/,
  ];
  for (const pattern of banned) {
    check("no banned copy: " + pattern, !pattern.test(flatOpen) && !pattern.test(flatClosed));
  }
  check("no comment or string says the baseline runs automatically", !/runs automatically/i.test(pageSource + formSource));

  // --------------------------------------------- Source-level invariants
  check("form uses no scroll-reveal hooks", !/data-(reveal|tilt|count-to)/.test(formSource));
  check("form posts through the shared request client", formSource.includes("submitSnapshotRequest(values)"));
  check("open/closed switch stays server-side", pageSource.includes('process.env.SNAPSHOT_PUBLIC_FORM_ENABLED === "true"'));
  check("no stylesheet imported by the page or form", !/import\s+["'][^"']+\.css["']/.test(pageSource + formSource + headerSource));
  check("request stylesheet loads from the root layout", layoutSource.includes('"@/components/landing/styles/request.css"'));
  check("header default CTA is still the demo route", headerSource.includes('{ label: "Request demo", href: "/scan" }'));
  check("no network call during render", fetchCalls === 0);

  console.log(`\n${total - failures}/${total} checks passed.`);
  if (failures === 0) console.log("ALL PASS");
  process.exit(failures === 0 ? 0 : 1);
}

main();
