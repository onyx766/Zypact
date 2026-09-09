#!/usr/bin/env tsx
/**
 * D-023 §3 — `measuredCostUsdFromRawResponseBody`. No database, no network.
 *
 * The property under test is totality in the safe direction. A real
 * provider-reported cost must be read exactly; EVERY other shape must
 * yield null, because the caller pairs null with an omitted `cost_basis`
 * and the ledger then records an honest `unknown`. A shape that wrongly
 * produced a number here would write a fabricated cost into a column the
 * spend cap is enforced against, which is the one failure this function
 * exists to prevent.
 *
 * The reservation is never an acceptable answer: migration 0050 forbids
 * copying `reserved_cost_usd` into `actual_cost_usd`, so no case below
 * may return a value that came from anywhere but the provider's own
 * accounting.
 */

import { measuredCostUsdFromRawResponseBody } from "@/lib/protocol-worker/worker";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** The exact usage shape a live sonar call returned on 2026-09-09. */
const REAL_BODY = JSON.stringify({
  choices: [{ message: { content: "an answer" } }],
  usage: {
    cost: {
      total_cost: 0.00517,
      request_cost: 0.005,
      input_tokens_cost: 0.00001,
      output_tokens_cost: 0.00016,
    },
    total_tokens: 169,
    prompt_tokens: 12,
    completion_tokens: 157,
    search_context_size: "low",
  },
});

function main(): void {
  console.log("[1] the real provider shape is read exactly");
  check(
    "total_cost is returned unrounded",
    measuredCostUsdFromRawResponseBody(REAL_BODY) === 0.00517,
    String(measuredCostUsdFromRawResponseBody(REAL_BODY))
  );
  check(
    "a zero cost is a real cost, not an absent one",
    measuredCostUsdFromRawResponseBody(
      JSON.stringify({ usage: { cost: { total_cost: 0 } } })
    ) === 0
  );

  console.log("\n[2] every unusable shape yields null, never a guess");
  const nullCases: Array<[string, string | null | undefined]> = [
    ["null body", null],
    ["undefined body", undefined],
    ["empty string", ""],
    ["unparseable JSON", "{not json"],
    ["JSON that is not an object", "42"],
    ["no usage key", JSON.stringify({ choices: [] })],
    ["usage is null", JSON.stringify({ usage: null })],
    ["usage is not an object", JSON.stringify({ usage: "free" })],
    ["no cost key", JSON.stringify({ usage: { total_tokens: 169 } })],
    ["cost is null", JSON.stringify({ usage: { cost: null } })],
    ["cost is not an object", JSON.stringify({ usage: { cost: "0.005" } })],
    ["no total_cost", JSON.stringify({ usage: { cost: { request_cost: 0.005 } } })],
    ["total_cost is a string", JSON.stringify({ usage: { cost: { total_cost: "0.005" } } })],
    ["total_cost is null", JSON.stringify({ usage: { cost: { total_cost: null } } })],
    ["total_cost is negative", JSON.stringify({ usage: { cost: { total_cost: -1 } } })],
  ];
  for (const [name, body] of nullCases) {
    check(name, measuredCostUsdFromRawResponseBody(body) === null);
  }

  // NaN and Infinity cannot survive JSON.stringify, so they are injected
  // the only way a real body could carry them: not at all. This asserts the
  // guard directly, against a hand-built string.
  check(
    "total_cost is NaN (raw text)",
    measuredCostUsdFromRawResponseBody('{"usage":{"cost":{"total_cost":NaN}}}') === null
  );
  check(
    "total_cost is Infinity (raw text)",
    measuredCostUsdFromRawResponseBody('{"usage":{"cost":{"total_cost":1e400}}}') === null,
    "1e400 parses to Infinity"
  );

  console.log("\n[3] an error body carries no cost");
  check(
    "a provider error body yields null",
    measuredCostUsdFromRawResponseBody(
      JSON.stringify({ error: { message: "rate limited", type: "rate_limit" } })
    ) === null
  );

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

main();
