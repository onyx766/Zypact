#!/usr/bin/env tsx
/**
 * The Outcome Card notification email.
 *
 * Same rule this whole tranche keeps re-verifying: an email that can be
 * forwarded, quoted, or screenshotted must never carry a finding, a status
 * word, or causal language — only that the card is ready and a private
 * link to it. This file's ONE extra job beyond the baseline email
 * (protocol-report-email.ts) is the permanent non-causality sentence,
 * which is checked here in the same literal form the renderer and the
 * builder both already commit to.
 *
 * Pure. No network — fetch is never called by buildOutcomeCardEmail/
 * buildOutcomeCardLink.
 */

import {
  buildOutcomeCardEmail,
  buildOutcomeCardLink,
} from "@/lib/reports/outcome-card-email";
import { ClientReportDeliveryError } from "@/lib/snapshot-requests/client-report-delivery";
import { NON_CAUSALITY_FOOTER } from "@/lib/reports/outcome-card-types";

let checks = 0;
let failures = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (condition) console.log(`✓ ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const VALID_TOKEN = "a".repeat(64);
const BASE_URL = "https://app.zypact.test";

async function main(): Promise<void> {
  console.log("[1] Link building");
  check(
    "the link uses /outcome-card/, NOT /report/ — a different artifact, a different route",
    buildOutcomeCardLink(BASE_URL, VALID_TOKEN) === `${BASE_URL}/outcome-card/${VALID_TOKEN}`
  );
  check("a too-short token is refused", (() => {
    try { buildOutcomeCardLink(BASE_URL, "short"); return false; }
    catch (e) { return e instanceof ClientReportDeliveryError && e.code === "invalid_public_token"; }
  })());
  check("a token containing a path-breaking character is refused", (() => {
    try { buildOutcomeCardLink(BASE_URL, "a".repeat(40) + "/../x"); return false; }
    catch (e) { return e instanceof ClientReportDeliveryError && e.code === "invalid_public_token"; }
  })());

  console.log("\n[2] The email carries no findings — no rate, no status word");
  const { subject, text, html } = buildOutcomeCardEmail(
    {
      to: "founder@example.test",
      companyName: "Acme Corp",
      publicToken: VALID_TOKEN,
      questionText: "Which SOC 2 automation tool should we shortlist?",
      deliveryIdempotencyKey: "outcome-card:iv-1:abc",
    },
    BASE_URL
  );
  check("subject names the company, not a result", subject.includes("Acme Corp") && !/increase|decrease|change/i.test(subject));
  for (const STATUS of ["increase_observed", "decrease_observed", "no_clear_change", "inconclusive"]) {
    check(`text carries no status word (${STATUS})`, !text.includes(STATUS));
    check(`html carries no status word (${STATUS})`, !html.includes(STATUS));
  }
  check("no percentage figure appears anywhere in the email", !/\d+(\.\d+)?%/.test(text) && !/\d+(\.\d+)?%/.test(html));
  check("the link to the card is present in both bodies", text.includes(`${BASE_URL}/outcome-card/${VALID_TOKEN}`) && html.includes(`${BASE_URL}/outcome-card/${VALID_TOKEN}`));

  console.log("\n[3] The permanent non-causality sentence is present, verbatim, in the email too");
  check("plain text carries the exact sentence", text.includes(NON_CAUSALITY_FOOTER));
  check("html carries the exact sentence", html.includes(NON_CAUSALITY_FOOTER));

  console.log("\n[4] HTML escaping — a hostile company name or question cannot break the markup");
  const hostile = buildOutcomeCardEmail(
    {
      to: "founder@example.test",
      companyName: `Acme <script>alert(1)</script> & Co "quoted"`,
      publicToken: VALID_TOKEN,
      questionText: `<img src=x onerror=alert(1)> which tool?`,
      deliveryIdempotencyKey: "outcome-card:iv-2:def",
    },
    BASE_URL
  );
  check("no raw <script> tag reaches the HTML body", !hostile.html.includes("<script>"));
  // The injected question contains the substring "onerror=" as literal text,
  // and escapeHtml never touches "=" — that substring surviving is expected
  // and harmless. The actual property that matters is that the surrounding
  // angle brackets were entity-encoded, so no `<img ...>` element can ever
  // be parsed out of it by a mail client.
  check("no literal <img tag reaches the HTML body — the angle brackets are entity-encoded",
    !hostile.html.includes("<img") && hostile.html.includes("&lt;img"));
  check("the escaped company name still renders recognizably", hostile.html.includes("Acme &lt;script&gt;"));

  console.log("\n[5] Long/multi-line question text is bounded to one preview line");
  const multiline = buildOutcomeCardEmail(
    {
      to: "founder@example.test",
      companyName: "Acme",
      publicToken: VALID_TOKEN,
      questionText: `${"x".repeat(200)}\nsecond line should never appear`,
      deliveryIdempotencyKey: "outcome-card:iv-3:ghi",
    },
    BASE_URL
  );
  check("the preview is truncated with an ellipsis", multiline.text.includes("…"));
  check("the second line never appears", !multiline.text.includes("second line should never appear"));

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "Outcome Card email contract PASSED." : "Outcome Card email contract FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("HARNESS ERROR", e);
  process.exit(1);
});
