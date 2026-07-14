#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";

type Level = "PASS" | "WARN" | "FAIL";

interface Check {
  level: Level;
  name: string;
  message: string;
}

function add(checks: Check[], level: Level, name: string, message: string): void {
  checks.push({ level, name, message });
}

function exists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function readText(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function readJson(filePath: string): any {
  return JSON.parse(readText(filePath));
}

function print(checks: Check[]): void {
  for (const check of checks) {
    const icon =
      check.level === "PASS" ? "✅" :
      check.level === "WARN" ? "⚠️" :
      "❌";

    console.log(`${icon} ${check.level} ${check.name}: ${check.message}`);
  }
}

function main(): void {
  const packageDir = process.argv[2];

  if (!packageDir) {
    console.error("Usage: npx tsx scripts/qa-client-package.ts <package-directory>");
    process.exit(1);
  }

  const checks: Check[] = [];
  const resolvedDir = path.resolve(packageDir);

  if (!exists(resolvedDir)) {
    add(checks, "FAIL", "package_dir", `Package directory not found: ${packageDir}`);
    print(checks);
    process.exit(1);
  }

  add(checks, "PASS", "package_dir", resolvedDir);

  const manifestPath = path.join(resolvedDir, "manifest.json");
  if (!exists(manifestPath)) {
    add(checks, "FAIL", "manifest", "manifest.json is missing.");
    print(checks);
    process.exit(1);
  }

  let manifest: any;
  try {
    manifest = readJson(manifestPath);
    add(checks, "PASS", "manifest", "manifest.json is valid JSON.");
  } catch (error) {
    add(checks, "FAIL", "manifest", `manifest.json is invalid JSON: ${(error as Error).message}`);
    print(checks);
    process.exit(1);
  }

  const requiredFiles = [
    "00-README.md",
    "01-ai-visibility-summary.md",
    "02-evidence-request.md",
    "04-next-email.md",
    "manifest.json",
  ];

  for (const file of requiredFiles) {
    if (exists(path.join(resolvedDir, file))) {
      add(checks, "PASS", `file:${file}`, "present");
    } else {
      add(checks, "FAIL", `file:${file}`, "missing");
    }
  }

  const status = manifest.status;

  if (status === "frame_mismatch_detected") {
    add(checks, "FAIL", "status", "frame_mismatch_detected — do not send this package.");
  } else if (status === "page_draft_blocked" || status === "page_draft_ready" || status === "evidence_needed") {
    add(checks, "PASS", "status", String(status));
  } else {
    add(checks, "FAIL", "status", `Unknown status: ${String(status)}`);
  }

  const frameStatus = manifest.frameConsistency?.status;

  if (frameStatus === "passed") {
    add(checks, "PASS", "frame_consistency", "passed");
  } else if (frameStatus === "skipped") {
    add(checks, "WARN", "frame_consistency", "skipped — expected competitors were probably not provided.");
  } else {
    add(checks, "FAIL", "frame_consistency", `not passed: ${String(frameStatus)}`);
  }

  const matched = manifest.frameConsistency?.matchedCompetitors || [];
  if (Array.isArray(matched) && matched.length > 0) {
    add(checks, "PASS", "matched_competitors", matched.join(", "));
  } else {
    add(checks, frameStatus === "passed" ? "WARN" : "FAIL", "matched_competitors", "No matched competitors found.");
  }

  const safety = manifest.safety || {};
  const safetyFlags = [
    "noGuaranteedAiRecommendationClaims",
    "publicCopyMustUseReviewedSourceBackedClaims",
    "blockedWhenCompetitorFrameMismatches",
  ];

  for (const flag of safetyFlags) {
    if (safety[flag] === true) {
      add(checks, "PASS", `safety:${flag}`, "true");
    } else {
      add(checks, "FAIL", `safety:${flag}`, "missing or false");
    }
  }

  const blockedDraft = path.join(resolvedDir, "03-page-draft-blocked.md");
  const publicDraft = path.join(resolvedDir, "03-page-draft.md");

  if (status === "page_draft_blocked") {
    if (exists(blockedDraft)) {
      add(checks, "PASS", "blocked_page_draft", "03-page-draft-blocked.md present.");
    } else {
      add(checks, "FAIL", "blocked_page_draft", "Status is page_draft_blocked but blocked draft file is missing.");
    }

    if (exists(publicDraft)) {
      add(checks, "FAIL", "public_page_draft", "03-page-draft.md exists while status is blocked.");
    } else {
      add(checks, "PASS", "public_page_draft", "No public page draft generated while evidence is blocked.");
    }
  }

  const emailPath = path.join(resolvedDir, "04-next-email.md");
  if (exists(emailPath)) {
    const email = readText(emailPath).toLowerCase();

    if (email.includes("frame_mismatch_detected") || email.includes("do not send")) {
      add(checks, "FAIL", "next_email", "Email appears to be a blocked/internal warning email.");
    } else {
      add(checks, "PASS", "next_email", "Email does not contain obvious blocked-frame warning text.");
    }
  }

  const failures = checks.filter((check) => check.level === "FAIL").length;
  const warnings = checks.filter((check) => check.level === "WARN").length;

  console.log(`\nQA package: ${packageDir}`);
  print(checks);

  console.log(`\nResult: ${failures === 0 ? "PASS" : "FAIL"} (${failures} failures, ${warnings} warnings)`);

  if (failures > 0) {
    process.exit(1);
  }
}

main();
