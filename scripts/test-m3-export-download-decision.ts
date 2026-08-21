#!/usr/bin/env tsx
/**
 * M3 reliquat — the export QA page's download button must never trigger
 * a download for a blocked/needs_review response, even though that
 * response is HTTP 200 with `ok: true`.
 *
 * Pure unit tests of lib/export/export-download-decision.ts (the exact
 * function app/projects/[id]/qa/export-download-button.tsx calls). No
 * DOM, no React, no browser — this repository has no jsdom/React
 * testing harness, so the decision logic a UI component depends on is
 * kept in a plain, directly-testable function, matching every other
 * pure module in this codebase.
 *
 * The header-emission side (lib/export/export-gate-response.ts actually
 * setting X-Zypact-Integrity-Status / X-Zypact-Deliverable on both
 * branches) is covered by scripts/test-m3-export-route-integrity-gate.ts.
 */

import { decideExportDownload } from "@/lib/export/export-download-decision";

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

function main(): void {
  console.log("[decideExportDownload]");

  check(
    "all three conditions satisfied -> shouldDownload:true",
    decideExportDownload({
      contentType: "text/markdown; charset=utf-8",
      integrityStatus: "integrity_passed",
      deliverable: "true",
    }).shouldDownload === true
  );

  const blockedDecision = decideExportDownload({
    contentType: "application/json",
    integrityStatus: "blocked",
    deliverable: "false",
  });
  check(
    "blocked (JSON content-type) -> shouldDownload:false",
    blockedDecision.shouldDownload === false
  );
  check(
    "blocked decision reports the real integrityStatus, not a placeholder",
    !blockedDecision.shouldDownload && blockedDecision.integrityStatus === "blocked"
  );

  const needsReviewDecision = decideExportDownload({
    contentType: "application/json",
    integrityStatus: "needs_review",
    deliverable: "false",
  });
  check(
    "needs_review (JSON content-type) -> shouldDownload:false",
    needsReviewDecision.shouldDownload === false
  );
  check(
    "needs_review decision reports the real integrityStatus",
    !needsReviewDecision.shouldDownload && needsReviewDecision.integrityStatus === "needs_review"
  );

  // Defensive combinations: a real deployment should never produce these
  // (export-gate-response.ts always keeps the three signals consistent),
  // but the client-side decision must fail closed regardless — it must
  // never trust a single signal in isolation.
  check(
    "markdown content-type but integrityStatus missing -> never downloads",
    decideExportDownload({
      contentType: "text/markdown",
      integrityStatus: null,
      deliverable: "true",
    }).shouldDownload === false
  );
  check(
    "markdown content-type and integrity_passed but deliverable header missing -> never downloads",
    decideExportDownload({
      contentType: "text/markdown",
      integrityStatus: "integrity_passed",
      deliverable: null,
    }).shouldDownload === false
  );
  check(
    "deliverable header present but not the literal string 'true' -> never downloads",
    decideExportDownload({
      contentType: "text/markdown",
      integrityStatus: "integrity_passed",
      deliverable: "TRUE",
    }).shouldDownload === false
  );
  check(
    "integrityStatus is 'needs_review' even with markdown content-type and deliverable:true -> never downloads",
    decideExportDownload({
      contentType: "text/markdown",
      integrityStatus: "needs_review",
      deliverable: "true",
    }).shouldDownload === false
  );
  check(
    "JSON content-type never downloads even if integrityStatus/deliverable headers claim otherwise",
    decideExportDownload({
      contentType: "application/json",
      integrityStatus: "integrity_passed",
      deliverable: "true",
    }).shouldDownload === false
  );
  check(
    "all headers entirely absent -> never downloads, reports 'unknown'",
    (() => {
      const d = decideExportDownload({
        contentType: null,
        integrityStatus: null,
        deliverable: null,
      });
      return !d.shouldDownload && d.integrityStatus === "unknown";
    })()
  );
  check(
    "content-type check is case-insensitive",
    decideExportDownload({
      contentType: "TEXT/MARKDOWN; charset=utf-8",
      integrityStatus: "integrity_passed",
      deliverable: "true",
    }).shouldDownload === true
  );

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) process.exit(1);
}

main();
