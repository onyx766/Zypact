#!/usr/bin/env tsx
/**
 * Contract for the Outcome Card view: what it must always show, and what its
 * pictures may never contradict. Pure render of synthetic payloads — no
 * database, no provider, no network.
 */
import { readFileSync } from "node:fs";

/*
 * Next resolves `import "./x.css"` itself; bare Node cannot parse one. Same
 * stub scripts/test-public-report-preview.ts uses.
 */
(require("node:module") as { _extensions: Record<string, unknown> })
  ._extensions[".css"] = () => undefined;

import type { OutcomeCardPayload } from "@/lib/reports/outcome-card-types";
import { NON_CAUSALITY_FOOTER } from "@/lib/reports/outcome-card-types";
import {
  FIXTURE_HASH,
  OUTCOME_CARD_FIXTURES,
  outcomeCardFixture,
} from "./fixtures/outcome-card-view-fixtures";

let passed = 0;
let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log("  ok   " + label);
  } else {
    failures += 1;
    console.error("  FAIL " + label);
  }
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Text as a reader sees it: tags dropped, entities decoded, whitespace flattened. */
function textOf(html: string): string {
  return html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function main(): void {
  console.log("test-outcome-card-view");
  (globalThis as unknown as { React: unknown }).React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { createElement } = require("react");
  const { OutcomeCardView } = require("@/components/report/outcome-card-view");

  const render = (payload: OutcomeCardPayload): string =>
    renderToStaticMarkup(createElement(OutcomeCardView, { payload }));

  const viewSource = readFileSync("components/report/outcome-card-view.tsx", "utf8");
  const cssSource = readFileSync("components/report/outcome-card.css", "utf8");

  console.log("[1] Every status renders, with the permanent footer");
  const labels: Record<string, string> = {
    no_clear_change: "No clear change",
    increase_observed: "Increase observed",
    decrease_observed: "Decrease observed",
    inconclusive: "Inconclusive",
  };
  for (const [key, label] of Object.entries(labels)) {
    const html = render(OUTCOME_CARD_FIXTURES[key]);
    check(`${key}: status label renders`, textOf(html).includes(label));
    check(`${key}: non-causality footer renders verbatim`, textOf(html).includes(NON_CAUSALITY_FOOTER));
  }
  check(
    "exactly four statuses are selectable",
    (viewSource.match(/^\s{2}(increase_observed|decrease_observed|no_clear_change|inconclusive): \{/gm) ?? []).length === 4
  );

  console.log("[2] The footer does not depend on the payload");
  const tampered = {
    ...outcomeCardFixture(),
    nonCausalityFooter: "The intervention worked.",
  } as unknown as OutcomeCardPayload;
  const tamperedText = textOf(render(tampered));
  check("a corrupted payload footer is not rendered", !tamperedText.includes("The intervention worked."));
  check("the literal footer still is", tamperedText.includes(NON_CAUSALITY_FOOTER));
  check("the view never interpolates payload.nonCausalityFooter", !/\{\s*payload\.nonCausalityFooter\s*\}/.test(viewSource));

  console.log("[3] The view adds no causal language of its own");
  const bare = textOf(render(outcomeCardFixture({ uncertainty: [], limitations: [] })))
    .replace(NON_CAUSALITY_FOOTER, "")
    .replace("not a causal claim", "");
  check("no causal wording outside the hero disclaimer and the footer", !/caus/i.test(bare));
  for (const key of Object.keys(labels)) {
    const reading = textOf(render(outcomeCardFixture({
      uncertainty: [],
      limitations: [],
      comparison: { status: key as OutcomeCardPayload["comparison"]["status"] },
    })));
    check(`${key}: no legacy verdict vocabulary`, !/\b(won|lost|partial)\b/i.test(reading));
  }
  check("no status reading mentions the intervention", !/reading:\s*\n?\s*"[^"]*intervention/i.test(viewSource));

  console.log("[4] Identity and timing are shown in full");
  const base = render(OUTCOME_CARD_FIXTURES.no_clear_change);
  const baseText = textOf(base);
  check("the prompt hash renders complete and unbroken", base.includes(`>${FIXTURE_HASH}<`));
  check("the hash is not laid out on the baseline report's three-column grid", !viewSource.includes('zpr-question"'));
  check("the hash box has a fixed, usable width", /grid-template-columns:\s*minmax\(0, 1fr\) 272px/.test(cssSource));
  check("the window is shown to the minute in UTC", baseText.includes("2026-01-03 20:46 UTC → 2026-01-18 20:46 UTC"));
  check("claim-frozen and implemented times render", baseText.includes("2026-01-03 16:21 UTC") && baseText.includes("Implemented"));
  check("stored codes are humanised for display", baseText.includes("Page created") && !baseText.includes("page_created") && !baseText.includes("customer_supplied"));

  console.log("[5] Deviations are prominent when recorded, absent when not");
  check("no deviation block without a deviation", !baseText.includes("Recorded deviations"));
  const deviated = textOf(render(OUTCOME_CARD_FIXTURES.inconclusive));
  check("recorded deviation renders", deviated.includes("Recorded deviations") && deviated.includes("The homepage was rebuilt twice inside the observation window"));
  check("early-retest reason renders", deviated.includes("Customer requested the retest two days early."));
  check("recorded reasons render", deviated.includes("PLAN_UNDERPOWERED_FOR_MINIMUM_USEFUL_CHANGE"));

  const late = textOf(render(outcomeCardFixture({
    intervention: {
      lateDeviations: [
        { note: "Homepage rebuilt on day 5.", recordedAt: "2026-01-08T10:00:00+00:00", afterRetestBegan: false },
        { note: "FAQ restyled after the run.", recordedAt: "2026-01-18T22:30:00+00:00", afterRetestBegan: true },
      ],
    },
  })));
  check("a late deviation alone opens the deviation block", late.includes("Recorded deviations"));
  check("a note written before the retest says so",
    /Recorded 2026-01-08 10:00 UTC, before the retest began\s?\. Homepage rebuilt on day 5\./.test(late));
  check("a note written after the retest began says so",
    /Recorded 2026-01-18 22:30 UTC, after the retest had begun\s?\. FAQ restyled after the run\./.test(late));

  console.log("[6] Run markers equal the stated counts");
  const markers = (html: string) => {
    // The legend repeats one marker of each kind; the phase strips hold the rest.
    const strips = html.split('class="zoc-dots"').slice(1).map((part) => part.split("</div>")[0]);
    return strips.map((strip) => ({
      named: count(strip, "zoc-dot is-named"),
      absent: count(strip, "zoc-dot is-absent"),
      unreadable: count(strip, "zoc-dot is-unreadable"),
    }));
  };
  const up = markers(render(OUTCOME_CARD_FIXTURES.increase_observed));
  check("baseline 0 of 5: five hollow markers", up[0].named === 0 && up[0].absent === 5 && up[0].unreadable === 0);
  check("retest 4 of 5: four filled, one hollow", up[1].named === 4 && up[1].absent === 1 && up[1].unreadable === 0);
  const short = markers(render(OUTCOME_CARD_FIXTURES.inconclusive));
  check("retest 1 of 4 readable of 5 planned: 1 filled, 3 hollow, 1 unreadable", short[1].named === 1 && short[1].absent === 3 && short[1].unreadable === 1);
  check("an unreadable run is never drawn as 'not named'", short[1].absent === 3);
  check("the unreadable legend entry appears only when needed", textOf(render(OUTCOME_CARD_FIXTURES.inconclusive)).includes("Planned, not readable") && !baseText.includes("Planned, not readable"));
  check("markers are not numbered as an ordered series", !/zoc-dot[^>]*>\s*\d/.test(base));

  console.log("[7] Numbers shown match the payload");
  check("observed change and interval", baseText.includes("-43% to +43%") && baseText.includes("Observed change (retest minus baseline)"));
  check("minimum useful and smallest detectable change", count(baseText, "60%") >= 3);
  check("detectable change disclosed at approval renders when present", baseText.includes("Detectable change disclosed at approval"));
  const unmeasured = textOf(render(OUTCOME_CARD_FIXTURES.unmeasured));
  check("no difference chart or delta without a comparison", !unmeasured.includes("Observed change (retest minus baseline)") && !unmeasured.includes("Vertical marks"));
  check("absent approval disclosure is omitted, not shown as zero", !unmeasured.includes("Detectable change disclosed at approval"));
  check("counts are stated in words beside every picture", baseText.includes("0 of 5 readable runs named Example Co"));

  console.log(`\n${passed}/${passed + failures} checks passed.`);
  if (failures > 0) {
    console.error(`${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("Outcome Card view contract PASSED.");
}

main();
