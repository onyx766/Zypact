#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

type CliArgs = Record<string, string | boolean>;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith("--")) continue;

    const key = current.slice(2);
    const next = argv[i + 1];

    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i += 1;
  }

  return args;
}

function usage(): never {
  console.error(`Usage:
  npx tsx scripts/build-mvp-package-from-scan.ts \\
    --brand <Brand> \\
    --scan <mvp-scan-report.md> \\
    --out <client-package-directory> \\
    [--focus-competitors "A,B,C"] \\
    [--expected-competitors "A,B,C"] \\
    [--allow-unguarded-frame] \\
    [--allow-simulated-package] \\
    [--skip-qa]`);
  process.exit(1);
}

function required(args: CliArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    console.error(`Missing required --${key}`);
    usage();
  }
  return value.trim();
}

function optional(args: CliArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function scanLooksSimulated(markdown: string): boolean {
  const lower = markdown.toLowerCase();

  return (
    lower.includes("probe mode          : simulated") ||
    lower.includes("probe mode: simulated") ||
    lower.includes("probe mode | simulated") ||
    lower.includes("simulated orchestration row") ||
    lower.includes("simulated competitor")
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "client";
}

function run(label: string, commandArgs: string[]): void {
  console.log(`\n▶ ${label}`);
  console.log(`npx tsx ${commandArgs.join(" ")}`);

  execFileSync("npx", ["tsx", ...commandArgs], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env,
  });
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const brand = required(args, "brand");
  const scan = required(args, "scan");
  const out = required(args, "out");
  const focusCompetitors = optional(args, "focus-competitors");
  const expectedCompetitors = optional(args, "expected-competitors") || focusCompetitors;
  const skipQa = args["skip-qa"] === true;
  const allowUnguardedFrame = args["allow-unguarded-frame"] === true;

  if (!expectedCompetitors && !allowUnguardedFrame) {
    console.error("Missing competitor frame guard.");
    console.error("Pass --expected-competitors \"A,B,C\" or --focus-competitors \"A,B,C\".");
    console.error("Use --allow-unguarded-frame only for internal/manual tests.");
    process.exit(1);
  }

  if (!fs.existsSync(scan)) {
    console.error(`Scan report not found: ${scan}`);
    process.exit(1);
  }

  const scanMarkdown = fs.readFileSync(scan, "utf8");
  const allowSimulatedPackage = args["allow-simulated-package"] === true;

  if (scanLooksSimulated(scanMarkdown) && !allowSimulatedPackage) {
    console.error("Simulated scan detected.");
    console.error("This package would not be safe to send as live evidence.");
    console.error("Use --allow-simulated-package only for internal QA/testing.");
    process.exit(1);
  }

  const slug = slugify(brand);
  const baseDir = path.dirname(out);
  const intermediateDir = path.join(baseDir, `.${slug}-intermediate`);

  fs.mkdirSync(intermediateDir, { recursive: true });
  fs.mkdirSync(out, { recursive: true });

  const salesReport = path.join(intermediateDir, `${slug}-sales-report.md`);
  const evidenceIntake = path.join(intermediateDir, `${slug}-evidence-intake.md`);
  const evidenceIntakeJson = path.join(intermediateDir, `${slug}-evidence-intake.json`);
  const evidenceBankBlocked = path.join(intermediateDir, `${slug}-evidence-bank-blocked.json`);
  const pageDraftBlocked = path.join(intermediateDir, `${slug}-page-draft-blocked.md`);

  const salesArgs = [
    "scripts/render-sales-report.ts",
    scan,
    salesReport,
  ];

  if (focusCompetitors) {
    salesArgs.push("--focus-competitors", focusCompetitors);
  }

  run("Render sales report", salesArgs);

  run("Render evidence intake", [
    "scripts/render-evidence-intake.ts",
    salesReport,
    evidenceIntake,
    "--json-out",
    evidenceIntakeJson,
  ]);

  run("Convert evidence intake to blocked evidence bank", [
    "scripts/convert-evidence-intake.ts",
    evidenceIntakeJson,
    evidenceBankBlocked,
  ]);

  run("Render blocked page draft", [
    "scripts/render-page-draft-from-evidence-bank.ts",
    evidenceBankBlocked,
    pageDraftBlocked,
  ]);

  const packageArgs = [
    "scripts/build-client-package.ts",
    "--brand",
    brand,
    "--sales-report",
    salesReport,
    "--evidence-intake",
    evidenceIntake,
    "--page-draft",
    pageDraftBlocked,
    "--out",
    out,
  ];

  if (expectedCompetitors) {
    packageArgs.push("--expected-competitors", expectedCompetitors);
  }

  run("Build guarded client package", packageArgs);

  if (!skipQa) {
    run("QA client package", [
      "scripts/qa-client-package.ts",
      out,
    ]);
  }

  console.log(`\n✅ MVP package built`);
  console.log(`brand: ${brand}`);
  console.log(`package: ${out}`);
  console.log(`intermediate: ${intermediateDir}`);
  console.log(`qa: ${skipQa ? "skipped" : "passed"}`);
  console.log(`frame guard: ${expectedCompetitors ? "required" : "unguarded allowed manually"}`);
  console.log(`simulated package: ${allowSimulatedPackage ? "allowed for internal test" : "blocked by default"}`);
}

main();
