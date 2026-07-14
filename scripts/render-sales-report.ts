#!/usr/bin/env tsx
/**
 * Sprint 14B — render a short prospect-facing sales report from an
 * existing long MVP markdown export.
 *
 * Usage:
 *   npx tsx scripts/render-sales-report.ts <longMvpReport.md> <outFile.md>
 *
 * Optional:
 *   --focus-competitors "B&H Photo,KEH Camera,MPB"
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildSalesReportFromMvpMarkdown } from "@/lib/export/build-sales-report";

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv: string[]): { input: string; output: string; focusCompetitors?: string[] } {
  const positional: string[] = [];
  let focusCompetitors: string[] | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--focus-competitors") {
      const value = argv[i + 1];
      if (!value) fail("Missing value for --focus-competitors", 2);
      focusCompetitors = value.split(",").map((item) => item.trim()).filter(Boolean);
      i += 1;
      continue;
    }
    positional.push(arg);
  }

  const [input, output] = positional;
  if (!input || !output) {
    fail(
      "Usage: npx tsx scripts/render-sales-report.ts <longMvpReport.md> <outFile.md> [--focus-competitors \"B&H Photo,KEH Camera,MPB\"]",
      2
    );
  }
  return { input, output, focusCompetitors };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = resolve(args.input);
  const outputPath = resolve(args.output);
  const source = readFileSync(inputPath, "utf-8");

  const report = buildSalesReportFromMvpMarkdown(source, {
    focusCompetitors: args.focusCompetitors,
  });

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, report.markdown, "utf-8");

  console.log(JSON.stringify({
    status: "ok",
    input: inputPath,
    output: outputPath,
    bytes: report.markdown.length,
    brand: report.summary.brand,
    visibility: report.summary.visibilityLine,
    brandedReputation: report.summary.brandedReputation,
    focusCompetitors: report.summary.focusCompetitors,
  }, null, 2));
}

main();
