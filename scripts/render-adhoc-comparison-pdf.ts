#!/usr/bin/env tsx
/**
 * Renders a two-question comparison PDF from founder-operated ad-hoc probe
 * evidence.
 *
 * Usage:
 *   npx tsx scripts/render-adhoc-comparison-pdf.ts \
 *     --config output/<prospect>/report-config.json \
 *     --out    output/<prospect>/report.pdf
 *
 * The config carries everything prospect-specific: who it is for, which
 * evidence directories to read, and the operator's prose. It lives under
 * `output/`, which is gitignored, so a prospect's narrative and evidence
 * never enter the repository — only this renderer does.
 *
 * The prose is an INPUT, not something this script composes. Every number on
 * the page is read from the evidence files; every sentence of interpretation
 * was written by a person who read them first. A script that could generate
 * its own findings would defeat the purpose of the artifact.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { renderReportPdf } from "@/lib/pdf";
import {
  buildAdhocComparisonReport,
  type AdhocEvidence,
  type BuildAdhocComparisonInput,
  type CitationCheckRow,
} from "@/lib/pdf/reports/adhoc-comparison-report";

function option(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} requires a value.`);
  }
  return value;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** The prospect-specific config file's shape. */
interface ReportConfig {
  subject: string;
  subjectUrl: string;
  preparedFor: string;
  brandTermsScanned: string[];
  /** Directory holding each question's evidence.json. */
  questions: [
    {
      label: string;
      evidenceDir: string;
      quoteFromRun: number;
      reading: string;
      toolsNamed: Array<{ tool: string; runs: number }>;
    },
    {
      label: string;
      evidenceDir: string;
      quoteFromRun: number;
      reading: string;
      toolsNamed: Array<{ tool: string; runs: number }>;
    },
  ];
  citationCheckFile: string;
  claimSupport?: BuildAdhocComparisonInput["claimSupport"];
  narrative: BuildAdhocComparisonInput["narrative"];
}

async function main(): Promise<void> {
  const configPath = option("config");
  if (!configPath) throw new Error("--config is required.");
  const outPath = option("out") ?? "output/adhoc-comparison.pdf";

  const config = readJson<ReportConfig>(configPath);

  const questions = config.questions.map((question) => ({
    label: question.label,
    evidence: readJson<AdhocEvidence>(
      path.join(question.evidenceDir, "evidence.json"),
    ),
    quoteFromRun: question.quoteFromRun,
    reading: question.reading,
    toolsNamed: question.toolsNamed,
  })) as BuildAdhocComparisonInput["questions"];

  const citationCheck = readJson<{ results: CitationCheckRow[] }>(
    config.citationCheckFile,
  ).results;

  const doc = buildAdhocComparisonReport({
    subject: config.subject,
    subjectUrl: config.subjectUrl,
    preparedFor: config.preparedFor,
    generatedAt: new Date().toISOString(),
    brandTermsScanned: config.brandTermsScanned,
    questions,
    citationCheck,
    claimSupport: config.claimSupport,
    narrative: config.narrative,
  });

  const { bytes, font } = await renderReportPdf(doc);

  mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  writeFileSync(outPath, bytes);

  console.log(`Rendered ${bytes.length} bytes to ${outPath}`);
  console.log(`  font        : ${font.source} — ${font.detail}`);
  console.log(`  sections    : ${doc.sections.length}`);
  console.log(`  citations   : ${citationCheck.length} checked`);
  for (const question of questions) {
    console.log(
      `  ${question.label}: ${question.evidence.reconciliation.succeeded}/${question.evidence.reconciliation.attempted} runs succeeded, ` +
        `${question.evidence.presenceRate?.numerator ?? 0}/${question.evidence.presenceRate?.denominator ?? 0} naming the brand`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
