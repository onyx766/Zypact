#!/usr/bin/env tsx
/**
 * The branded PDF layer.
 *
 * Three properties carry the weight here:
 *
 *   - `validateReportDocument` refuses a document that would misrepresent
 *     something once rendered — a table row that does not match its header,
 *     an empty verbatim quotation, a non-http source URL. Rendering is the
 *     last point at which a malformed report can still be stopped cheaply;
 *   - every `PdfBlock` kind renders. The dispatch in `blocks.ts` is
 *     exhaustive at compile time, but an exhaustive switch still proves
 *     nothing about whether a branch throws at run time;
 *   - the print palette has not drifted from `tailwind.config.ts`. The two
 *     are duplicated on purpose (the worker image has no devDependencies, so
 *     `lib/` cannot import a Tailwind config) and a silent divergence would
 *     put off-brand colour in front of a client.
 *
 * The fixture is a fictional company with fictional findings. No prospect
 * name, no real evidence and no credential appears in this file.
 *
 * Pure: no database, no provider, no network.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  BRAND_SCALE,
  PdfDocumentInvalidError,
  SURFACE,
  formatUtcDate,
  renderReportPdf,
  validateReportDocument,
  type PdfBlock,
  type PdfReportDocument,
} from "@/lib/pdf";
import { brandPresence } from "@/lib/pdf/reports/adhoc-comparison-report";

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

/* ------------------------------------------------------------------ */
/* Fixture — fictional throughout                                       */
/* ------------------------------------------------------------------ */

/** Every block kind, so the render test cannot miss one. */
const ALL_BLOCK_KINDS: ReadonlyArray<PdfBlock["kind"]> = [
  "heading",
  "paragraph",
  "bullets",
  "keyValues",
  "table",
  "comparison",
  "verbatim",
  "interpretation",
  "sources",
  "note",
  "spacer",
  "pageBreak",
];

function sampleDocument(): PdfReportDocument {
  return {
    meta: {
      title: "AI Answer Visibility — Two-Question Comparison",
      subtitle:
        "A directional look at how one AI surface answers two differently framed buyer questions.",
      subject: "Northwind Telemetry (fictional)",
      preparedFor: "Head of Product Marketing, Northwind Telemetry",
      preparedBy: "Zypact",
      generatedAt: "2026-09-22T09:30:00.000Z",
      methodologyLabel:
        "Founder-operated directional snapshot. One surface, one model. Not a pilot baseline and not a before-and-after test.",
      confidentiality: "Prepared for Northwind Telemetry. Not for redistribution.",
      pageSize: "A4",
    },
    sections: [
      {
        title: "Executive summary",
        standfirst:
          "What this run looked at, and how far the result can be taken.",
        blocks: [
          {
            kind: "paragraph",
            tone: "lead",
            text: "Two buyer questions were put to the same AI surface under identical settings. Neither answer named Northwind Telemetry.",
          },
          {
            kind: "paragraph",
            text: "The two questions returned different tool sets, but with five runs each the difference between them cannot be separated from ordinary run-to-run variation. This document records what was returned; it does not establish that one phrasing performs better than the other.",
          },
          {
            kind: "bullets",
            items: [
              "Ten successful calls, no failures, no retries.",
              "Northwind was not mentioned, recommended or cited in either question.",
              "Four of eleven cited URLs did not support the claim they were attached to.",
            ],
          },
        ],
      },
      {
        title: "Run parameters",
        standfirst: "Identical across both questions, so the two are comparable.",
        blocks: [
          {
            kind: "keyValues",
            items: [
              { label: "Surface", value: "Example AI Search (fictional)" },
              { label: "Model", value: "example-model-1", mono: true },
              { label: "Temperature", value: "0.2", mono: true },
              { label: "Runs per question", value: "5" },
              {
                label: "Request body digest",
                value: "3f1c9ab7e2d04c8a6b5e7f2130da9c4477e8b1a2c3d4e5f60718293a4b5c6d7e",
                mono: true,
              },
              { label: "Retry cap", value: "2 per run", mono: false },
            ],
          },
          {
            kind: "note",
            title: "What identical settings do and do not buy",
            text: "Holding the model and settings constant removes configuration as an explanation for any difference. It does not remove the surface's own non-determinism, which is why both questions were run more than once.",
          },
        ],
      },
      {
        title: "Side-by-side",
        startOnNewPage: true,
        blocks: [
          {
            kind: "comparison",
            columns: [
              {
                label: "Question 1 — Original",
                highlight: "0 / 5",
                highlightCaption: "runs mentioning Northwind",
                rows: [
                  {
                    label: "Question",
                    value:
                      "Which tools help me keep track of what my automated systems did?",
                  },
                  { label: "Distinct tools named", value: "7" },
                  { label: "Citations returned", value: "6" },
                  { label: "95% interval", value: "0% – 43%", mono: true },
                ],
              },
              {
                label: "Question 2 — Problem-driven",
                highlight: "0 / 5",
                highlightCaption: "runs mentioning Northwind",
                rows: [
                  {
                    label: "Question",
                    value: "How do I see what a system actually ran?",
                  },
                  { label: "Distinct tools named", value: "5" },
                  { label: "Citations returned", value: "5" },
                  { label: "95% interval", value: "0% – 43%", mono: true },
                ],
              },
            ],
            caption:
              "Both intervals span the same range. With five runs each, this comparison cannot distinguish the two questions.",
          },
          {
            kind: "table",
            columns: [
              { header: "Tool named", width: 3 },
              { header: "Q1 runs", width: 1, align: "right" },
              { header: "Q2 runs", width: 1, align: "right" },
            ],
            rows: [
              ["Example Observability Co", "5", "4"],
              ["Fictional Traces Inc", "4", "5"],
              ["Placeholder Audit Ltd", "2", "0"],
              ["Northwind Telemetry", "0", "0"],
            ],
            caption: "Counts are of runs in which the answer named the tool.",
          },
        ],
      },
      {
        title: "What the surface actually said",
        blocks: [
          {
            kind: "heading",
            level: 2,
            text: "Question 2, run 3 of 5",
          },
          {
            kind: "verbatim",
            text: "To see what a system actually ran, you generally need an execution log or a trace view. Most teams reach for a general-purpose observability tool rather than something purpose-built.",
            attribution: "Example AI Search, run 3 of 5 — returned 2026-09-22T09:31:44Z",
          },
          {
            kind: "interpretation",
            text: "The answer treats this as a general observability problem rather than a category with dedicated tools. That framing, not Northwind's absence from any particular source, is what kept purpose-built tools out of the answer.",
          },
        ],
      },
      {
        title: "Cited sources",
        standfirst:
          "Every URL returned across both questions, checked individually. Cited is not the same as supporting.",
        blocks: [
          // An explicit break rather than `startOnNewPage`, so the fixture
          // exercises both mechanisms.
          { kind: "pageBreak" },
          {
            kind: "sources",
            items: [
              {
                url: "https://example.com/observability-guide",
                title: "A practical guide to execution logging",
                status: "verified_supports",
                httpStatus: 200,
                note: "Names three of the tools listed in the answer.",
              },
              {
                url: "https://example.org/vendor-comparison-2024",
                title: "Vendor comparison, 2024 edition",
                status: "verified_does_not_support",
                httpStatus: 200,
                note: "Page exists but does not discuss execution logging at all.",
              },
              {
                url: "https://example.net/retired-page",
                status: "unreachable",
                httpStatus: 404,
                note: "Cited by the surface; returns 404 on direct request.",
              },
              {
                url: "https://example.com/pricing",
                status: "not_checked",
                note: "Out of scope for this run.",
              },
            ],
            caption:
              "Four of the eleven URLs returned across both questions are shown. The full list is in the evidence file.",
          },
        ],
      },
      {
        title: "What this does and does not establish",
        blocks: [
          {
            kind: "paragraph",
            text: "It establishes that on this surface, under these settings, on this date, neither question produced an answer naming Northwind Telemetry.",
          },
          {
            kind: "paragraph",
            text: "It does not establish that Northwind is invisible to AI buyers generally, that one question is better than the other, or that any change to Northwind's content would alter these answers. One surface is not all surfaces, and five runs is not enough to separate two questions.",
          },
          { kind: "spacer", size: "sm" },
          {
            kind: "note",
            title: "Not a before-and-after test",
            text: "These are two different questions asked once each, not the same question asked before and after a change. No causal reading is supported.",
          },
        ],
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Checks                                                               */
/* ------------------------------------------------------------------ */

/**
 * Child mode.
 *
 * Re-entered as a subprocess under `node --import tsx`, which is the exact
 * command the protocol worker's container runs. It renders a minimal document
 * and exits; the parent only cares whether it survived module resolution.
 */
async function runAsWorkerRuntimeChild(): Promise<void> {
  const { bytes } = await renderReportPdf({
    meta: { title: "Worker runtime check", generatedAt: "2026-09-22T00:00:00.000Z" },
    sections: [{ blocks: [{ kind: "paragraph", text: "ok" }] }],
  });
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new Error("child rendered something that is not a PDF");
  }
  console.log(`child ok: ${bytes.length} bytes`);
}

async function main(): Promise<void> {
  console.log("PDF layer\n");

  /* -- 1. The fixture is structurally sound ------------------------- */

  const doc = sampleDocument();
  const problems = validateReportDocument(doc);
  check(
    "fixture validates clean",
    problems.length === 0,
    problems.map((p) => `${p.path}: ${p.message}`).join("; "),
  );

  /* -- 2. Validation catches what it exists to catch ---------------- */

  const mismatchedTable = validateReportDocument({
    meta: { title: "t", generatedAt: "2026-01-01T00:00:00.000Z" },
    sections: [
      {
        blocks: [
          {
            kind: "table",
            columns: [{ header: "A" }, { header: "B" }],
            rows: [["only-one-cell"]],
          },
        ],
      },
    ],
  });
  check(
    "a table row that does not match its header is rejected",
    mismatchedTable.some((p) => p.message.includes("declares 2 columns")),
    mismatchedTable.map((p) => p.message).join("; "),
  );

  const emptyVerbatim = validateReportDocument({
    meta: { title: "t", generatedAt: "2026-01-01T00:00:00.000Z" },
    sections: [{ blocks: [{ kind: "verbatim", text: "" }] }],
  });
  check(
    "an empty verbatim quotation is rejected",
    emptyVerbatim.some((p) => p.message.includes("misrepresents the source")),
    emptyVerbatim.map((p) => p.message).join("; "),
  );

  const badSource = validateReportDocument({
    meta: { title: "t", generatedAt: "2026-01-01T00:00:00.000Z" },
    sections: [
      {
        blocks: [
          {
            kind: "sources",
            items: [{ url: "javascript:alert(1)", status: "not_checked" }],
          },
        ],
      },
    ],
  });
  check(
    "a non-http source URL is rejected",
    badSource.some((p) => p.message.includes("not http(s)")),
    badSource.map((p) => p.message).join("; "),
  );

  const badDate = validateReportDocument({
    meta: { title: "t", generatedAt: "not-a-date" },
    sections: [{ blocks: [{ kind: "paragraph", text: "x" }] }],
  });
  check(
    "a non-ISO generatedAt is rejected",
    badDate.some((p) => p.path === "meta.generatedAt"),
  );

  /* -- 3. An invalid document cannot be rendered -------------------- */

  let refused = false;
  try {
    await renderReportPdf({
      meta: { title: "", generatedAt: "nope" },
      sections: [],
    });
  } catch (error) {
    refused = error instanceof PdfDocumentInvalidError;
  }
  check("renderReportPdf refuses an invalid document", refused);

  /* -- 4. The fixture exercises every block kind -------------------- */

  const usedKinds = new Set<string>();
  for (const section of doc.sections) {
    for (const block of section.blocks) usedKinds.add(block.kind);
  }
  const unusedKinds = ALL_BLOCK_KINDS.filter((kind) => !usedKinds.has(kind));
  check(
    "fixture covers every block kind",
    unusedKinds.length === 0,
    unusedKinds.length ? `missing: ${unusedKinds.join(", ")}` : "",
  );

  /* -- 5. It renders to real PDF bytes ------------------------------ */

  const { bytes, font } = await renderReportPdf(doc);

  check(
    "output carries the PDF header",
    bytes.subarray(0, 5).toString("latin1") === "%PDF-",
    bytes.subarray(0, 8).toString("latin1"),
  );
  check(
    "output carries the PDF trailer",
    bytes.subarray(-1024).toString("latin1").includes("%%EOF"),
  );
  check(
    "output is a non-trivial document",
    bytes.length > 12_000,
    `${bytes.length} bytes`,
  );
  console.log(`  font: ${font.source} — ${font.detail}`);

  /* -- 6. The print palette has not drifted from Tailwind ----------- */

  const tailwindSource = readFileSync(
    path.join(process.cwd(), "tailwind.config.ts"),
    "utf8",
  );

  const drifted: string[] = [];
  for (const [step, hex] of Object.entries(BRAND_SCALE)) {
    const declared = new RegExp(`\\b${step}:\\s*"(#[0-9A-Fa-f]{6})"`).exec(
      tailwindSource,
    );
    if (!declared) {
      drifted.push(`brand.${step} absent from tailwind.config.ts`);
    } else if (declared[1].toUpperCase() !== hex.toUpperCase()) {
      drifted.push(`brand.${step}: print ${hex} vs tailwind ${declared[1]}`);
    }
  }
  for (const [name, hex] of Object.entries(SURFACE)) {
    const key = name === "default" ? "DEFAULT" : name;
    const declared = new RegExp(`${key}:\\s*"(#[0-9A-Fa-f]{6})"`).exec(
      tailwindSource,
    );
    if (!declared) {
      drifted.push(`surface.${key} absent from tailwind.config.ts`);
    } else if (declared[1].toUpperCase() !== hex.toUpperCase()) {
      drifted.push(`surface.${key}: print ${hex} vs tailwind ${declared[1]}`);
    }
  }
  check(
    "print palette matches tailwind.config.ts",
    drifted.length === 0,
    drifted.join("; "),
  );

  /* -- 7. The logo geometry is the official asset's ----------------- */

  const logoSource = readFileSync(
    path.join(process.cwd(), "public", "zypact-logo.svg"),
    "utf8",
  );
  const assetPath = /<path\s+d="([^"]+)"/.exec(logoSource)?.[1];
  const { LOGO } = await import("@/lib/pdf");
  check(
    "logo path data matches public/zypact-logo.svg",
    assetPath === LOGO.markPath,
    `asset ${JSON.stringify(assetPath)} vs print ${JSON.stringify(LOGO.markPath)}`,
  );
  check(
    "logo ink matches the official asset",
    logoSource.includes(LOGO.markStroke),
    LOGO.markStroke,
  );

  /* -- 8. Brand presence counts RUNS, and sees retrieved sources ---- */

  /*
   * Two defects are pinned here, both of which produced a plausible-looking
   * number rather than an error.
   *
   * Summing per-term counts overflowed the denominator: a brand scanned
   * under its name, its domain and a spelling variant is still one brand, so
   * three terms each matching both runs reported "6 of 2 runs".
   *
   * Scanning citation URLs alone missed any brand named in a retrieved
   * source's title or snippet. A citation URL contains a brand's name only
   * when the brand owns the domain, so the old scan systematically
   * understated exactly those brands that get written about rather than
   * linked to — and could not tell "never retrieved" from "retrieved and
   * not used", which are different findings with different remedies.
   */
  const presenceEvidence = {
    kind: "founder_operated_adhoc_probe",
    generatedAt: "2026-09-22T00:00:00.000Z",
    startedAt: "2026-09-22T00:00:00.000Z",
    question: { text: "q", sha256: "0".repeat(64) },
    transport: { endpoint: "https://example.invalid", requestedModel: "sonar" },
    plan: { runs: 2, maxRetriesPerRun: 2, maxCalls: 6 },
    reconciliation: {
      attempted: 2,
      succeeded: 2,
      failed: 0,
      retried: 0,
      runsPlanned: 2,
      runsWithAResult: 2,
      accountedFor: true,
    },
    brandScan: [],
    presenceRate: null,
    attempts: [
      {
        attemptOrdinal: 1,
        runOrdinal: 1,
        outcome: "succeeded" as const,
        startedAt: "2026-09-22T00:00:00.000Z",
        completedAt: "2026-09-22T00:00:01.000Z",
        latencyMs: 1000,
        httpStatus: 200,
        providerRequestId: null,
        requestBodySha256: null,
        responseBodySha256: null,
        model: "sonar",
        // Named in the answer, and present in a retrieved title — but the
        // brand does NOT own any cited domain.
        answer: "Acme Telemetry is one option.",
        citations: ["https://example.com/roundup"],
        searchResults: [
          { title: "Best tools 2026: Acme Telemetry reviewed", url: "https://example.com/roundup" },
        ],
      },
      {
        attemptOrdinal: 2,
        runOrdinal: 2,
        outcome: "succeeded" as const,
        startedAt: "2026-09-22T00:00:02.000Z",
        completedAt: "2026-09-22T00:00:03.000Z",
        latencyMs: 1000,
        httpStatus: 200,
        providerRequestId: null,
        requestBodySha256: null,
        responseBodySha256: null,
        model: "sonar",
        answer: "No relevant tool.",
        citations: ["https://example.com/other"],
        searchResults: [{ title: "Something else", url: "https://example.com/other" }],
      },
    ],
  };

  const presence = brandPresence(presenceEvidence, [
    "Acme Telemetry",
    "acmetelemetry.com",
    "Acme",
  ]);

  check(
    "brand presence counts runs, not term-matches summed across terms",
    presence.inAnswer === 1 && presence.runs === 2,
    `inAnswer=${presence.inAnswer} runs=${presence.runs} (3 terms match run 1; a sum would report 3)`,
  );
  check(
    "a brand named only in a retrieved title is still counted as retrieved",
    presence.inRetrievedSources === 1,
    `inRetrievedSources=${presence.inRetrievedSources}`,
  );
  check(
    "retrieved-but-not-cited is distinguishable from cited",
    presence.inCitations === 0 && presence.inRetrievedSources === 1,
    `cited=${presence.inCitations}, retrieved=${presence.inRetrievedSources} — the pair is what separates "never retrieved" from "retrieved and unused"`,
  );

  /* -- 9. It loads under the worker's actual runtime ---------------- */

  /*
   * The regression this guards is specific and easy to reintroduce. A static
   * `import` of `@react-pdf/renderer` anywhere under `lib/pdf/` resolves fine
   * in the Next.js build and fails only under tsx's CommonJS resolver, with
   * ERR_PACKAGE_PATH_NOT_EXPORTED from `@react-pdf/hyphenate`. The worker
   * runs `node --import tsx`, so that failure would surface in the container
   * and nowhere else. Running the real command is the only honest check.
   */
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", __filename, "--worker-runtime-child"],
    { cwd: process.cwd(), encoding: "utf8", timeout: 120_000 },
  );
  check(
    "renders under `node --import tsx` (the worker's command)",
    child.status === 0,
    child.status === 0
      ? (child.stdout ?? "").trim()
      : `exit ${child.status}: ${(child.stderr ?? "").trim().split("\n").slice(-3).join(" / ")}`,
  );

  /* -- 10. Dates are UTC and locale-independent --------------------- */

  check(
    "dates render in UTC regardless of host locale",
    formatUtcDate("2026-09-22T23:30:00.000Z") === "22 September 2026",
    formatUtcDate("2026-09-22T23:30:00.000Z"),
  );

  /* -- 11. Leave the artifact somewhere a human can look at it ------ */

  const outDir = process.argv.includes("--out")
    ? path.resolve(process.argv[process.argv.indexOf("--out") + 1])
    : path.join(tmpdir(), "zypact-pdf-smoke");
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "pdf-layer-sample.pdf");
  writeFileSync(outFile, bytes);
  console.log(`\n  sample written to ${outFile}`);

  /* -- Result ------------------------------------------------------- */

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) process.exit(1);
}

const entry = process.argv.includes("--worker-runtime-child")
  ? runAsWorkerRuntimeChild
  : main;

entry().catch((error) => {
  console.error(error);
  process.exit(1);
});
