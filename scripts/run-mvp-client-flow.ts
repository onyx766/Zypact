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
  npx tsx scripts/run-mvp-client-flow.ts \\
    --brand <Brand> \\
    --domain <domain.com> \\
    --category <category> \\
    --competitors "A,B,C" \\
    --scan-out <scan-report.md> \\
    --package-out <client-package-dir> \\
    [--prompts-file <prompts.txt>] \\
    [--force-new-project] \\
    [--probe-mode live|simulated] \\
    [--budget-usd 2] \\
    [--runs 3] \\
    [--prompts 5] \\
    [--dry-run]`);
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

function has(args: CliArgs, key: string): boolean {
  return args[key] === true;
}

function looksLikePlaceholder(value: string): boolean {
  const lower = value.toLowerCase();

  return (
    lower.includes("client brand") ||
    lower.includes("prospect brand") ||
    lower.includes("client.com") ||
    lower.includes("prospect.com") ||
    lower.includes("exact buying category") ||
    lower.includes("client buying category") ||
    lower.includes("competitor a") ||
    lower.includes("competitor b") ||
    lower.includes("competitor c")
  );
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
  const domain = required(args, "domain");
  const category = required(args, "category");
  const competitors = required(args, "competitors");
  const competitorItems = competitors
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (competitorItems.length < 2) {
    console.error(`Competitor frame has only ${competitorItems.length} competitor(s).`);
    console.error("Add at least 2 competitors, ideally 3–5, before running the client flow.");
    process.exit(1);
  }

  const scanOut = required(args, "scan-out");
  const packageOut = required(args, "package-out");

  const promptsFile = optional(args, "prompts-file");
  if (promptsFile && !fs.existsSync(promptsFile)) {
    console.error(`Prompts file not found: ${promptsFile}`);
    console.error("Create the file first, with one buyer prompt per line.");
    process.exit(1);
  }

  if (promptsFile) {
    const promptLines = fs.readFileSync(promptsFile, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    if (promptLines.length < 3) {
      console.error(`Prompts file has only ${promptLines.length} usable prompt(s): ${promptsFile}`);
      console.error("Add at least 3 buyer prompts before running the client flow.");
      process.exit(1);
    }

    const dryRunPreview = has(args, "dry-run");
    const hardPlaceholderPattern = /\[[^\]]+\]|\{[^}]+\}|<[^>]+>/;
    const softPlaceholderPattern = /\bcategory\b|\bbuyer persona\b|\bjob-to-be-done\b|\burgent pain\b/i;

    const blockedPromptLines = promptLines.filter((line) => hardPlaceholderPattern.test(line));
    const suspiciousPromptLines = promptLines.filter((line) =>
      !hardPlaceholderPattern.test(line) && softPlaceholderPattern.test(line)
    );

    if (blockedPromptLines.length > 0 && !dryRunPreview) {
      console.error(`Prompts file contains hard placeholder prompts: ${promptsFile}`);
      for (const line of blockedPromptLines.slice(0, 5)) {
        console.error(`- ${line}`);
      }
      console.error("Replace placeholders with real buyer prompts, or use --dry-run for examples.");
      process.exit(1);
    }

    if (suspiciousPromptLines.length > 0) {
      console.warn(`⚠ ${suspiciousPromptLines.length} prompt(s) look generic — review before sending:`);
      for (const line of suspiciousPromptLines.slice(0, 5)) {
        console.warn(`- ${line}`);
      }
    }
  }

  const probeMode = optional(args, "probe-mode") || "live";
  const budgetUsd = optional(args, "budget-usd") || "2";
  const runs = optional(args, "runs") || "3";
  const prompts = optional(args, "prompts") || "5";
  const dryRun = has(args, "dry-run");
  const allowPlaceholder = has(args, "allow-placeholder");

  const placeholderValues = [brand, domain, category, competitors].filter(looksLikePlaceholder);
  if (placeholderValues.length > 0 && !dryRun && !allowPlaceholder) {
    console.error("Placeholder values detected in a non-dry-run command.");
    console.error("Refusing to run live with placeholder brand/domain/category/competitors.");
    console.error(`Placeholders: ${placeholderValues.join(", ")}`);
    console.error("Replace them with a real prospect, or use --dry-run for examples.");
    process.exit(1);
  }

  if (!dryRun) {
    fs.mkdirSync(path.dirname(scanOut), { recursive: true });
    fs.mkdirSync(packageOut, { recursive: true });
  }

  const scanArgs = [
    "scripts/mvp-scan.ts",
    "--brand", brand,
    "--domain", domain,
    "--category", category,
    "--competitors", competitors,
    "--probe-mode", probeMode,
    "--budget-usd", budgetUsd,
    "--runs", runs,
    "--prompts", prompts,
    "--out", scanOut,
  ];

  if (promptsFile) {
    scanArgs.push("--prompts-file", promptsFile);
  }

  if (has(args, "force-new-project")) {
    scanArgs.push("--force-new-project");
  }

  if (dryRun) {
    scanArgs.push("--dry-run");
  }

  run("Run MVP scan", scanArgs);

  if (dryRun) {
    console.log(`\n✅ MVP client flow dry-run complete`);
    console.log(`brand: ${brand}`);
    console.log(`scan: ${scanOut}`);
    console.log(`package: skipped`);
    return;
  }

  if (!fs.existsSync(scanOut)) {
    console.error(`Scan report was not created: ${scanOut}`);
    process.exit(1);
  }

  const packageArgs = [
    "scripts/build-mvp-package-from-scan.ts",
    "--brand", brand,
    "--scan", scanOut,
    "--focus-competitors", competitors,
    "--expected-competitors", competitors,
    "--out", packageOut,
  ];

  if (probeMode === "simulated") {
    packageArgs.push("--allow-simulated-package");
  }

  run("Build guarded package + QA", packageArgs);

  console.log(`\n✅ MVP client flow complete`);
  console.log(`brand: ${brand}`);
  console.log(`scan: ${scanOut}`);
  console.log(`package: ${packageOut}`);
}

main();
