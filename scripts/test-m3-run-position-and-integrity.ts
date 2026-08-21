#!/usr/bin/env tsx
/**
 * M3 closure — reliquats.
 *
 * Two independent halves:
 *
 *  1. `runPosition` is now actually persisted, using only the three
 *     deterministic mappings the pipeline's existing productPosition
 *     signal supports (D-014 §9). `ambiguous_in_run` is never
 *     fabricated (no branch of mapProductPositionToRunPosition can
 *     produce it — enforced by its return type). `analysis_failed` is
 *     never fabricated either: the existing failure path
 *     (probe_runs.status="failed", no probe_results row) is
 *     unchanged, confirmed by static inspection of
 *     analyze-probe-response.ts's source.
 *
 *  2. The new report-integrity classifier (lib/export/report-integrity.ts)
 *     — the first real implementation of integrity_passed/needs_review/
 *     blocked anywhere in this codebase — correctly blocks a report that
 *     still exposes the legacy won/partial/lost aggregate as client-facing
 *     truth, holds an otherwise-clean report at needs_review while M4's
 *     protocol/sampling/reservation preconditions remain unmet, and only
 *     reaches integrity_passed when every checked gate is satisfied.
 *
 * Real in-memory adapter (getDb()), mock LLM mode. No network, no
 * payment, no staging/Production.
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ZYPACT_ALLOW_MEMORY_DB;
process.env.ZYPACT_MOCK_MODE = "on";

import { readFileSync } from "node:fs";
import { getDb } from "@/lib/db";
import { analyzeProbeResponse } from "@/lib/pipeline/analyze-probe-response";
import {
  classifyProductRecommendation,
  mapProductPositionToRunPosition,
  type DeterministicRunPosition,
} from "@/lib/probe-analysis/product-recommendation";
import {
  evaluateReportIntegrity,
  reportExposesLegacyVerdictAsTruth,
} from "@/lib/export/report-integrity";
import { buildMvpReport, loadReportInputs } from "@/lib/export/build-mvp-report";

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

function freshDomain(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 10)}.example.com`;
}

async function main(): Promise<void> {
  const db = getDb();

  /* ================================================================== */
  /* Part 1 — runPosition: the four deterministic mappings              */
  /* ================================================================== */
  console.log("\n[runPosition: deterministic mappings]");

  const ALL_MAPPED: DeterministicRunPosition[] = ["primary", "listed", "negative", "absent"].map(
    (p) => mapProductPositionToRunPosition(p as any)
  );
  check(
    "primary -> primary_in_run",
    mapProductPositionToRunPosition("primary") === "primary_in_run"
  );
  check(
    "listed -> listed_in_run",
    mapProductPositionToRunPosition("listed") === "listed_in_run"
  );
  check(
    "negative -> listed_in_run (D-014 v1.1: sentiment tracked separately, not as its own position)",
    mapProductPositionToRunPosition("negative") === "listed_in_run"
  );
  check(
    "absent -> not_observed_in_run",
    mapProductPositionToRunPosition("absent") === "not_observed_in_run"
  );
  check(
    "no mapping ever produces ambiguous_in_run or analysis_failed",
    ALL_MAPPED.every((v) => v !== ("ambiguous_in_run" as any) && v !== ("analysis_failed" as any))
  );

  // The real, exported contract also used by the live (non-mock) LLM
  // path — the mock agent never returns clientPosition:"negative"
  // itself, but the deterministic classifier's handling of it is real,
  // reachable production code, exercised here directly.
  const negativeSignals = classifyProductRecommendation({
    prompt: "who should we use",
    rawResponse: "Acme Corp is a poor fit and lacks key features.",
    brandTerms: ["Acme Corp"],
    clientPosition: "negative",
  });
  check(
    "classifyProductRecommendation: an authoritative 'negative' clientPosition passes through as productPosition",
    negativeSignals.productPosition === "negative"
  );
  check(
    "runPosition for that same signal is listed_in_run, not a fabricated fourth label",
    mapProductPositionToRunPosition(negativeSignals.productPosition) === "listed_in_run"
  );

  /* ================================================================== */
  /* Part 2 — runPosition actually persisted end to end                 */
  /* ================================================================== */
  console.log("\n[runPosition: persisted through analyzeProbeResponse -> saveProbeResult]");

  {
    const project = await db.createProject({
      domain: freshDomain("runpos-primary"),
      companyName: "Acme Pipeline Co.",
    });
    const datasetBatch = await db.createDatasetBatch({
      projectId: project.id,
      datasetSourceType: "manual_scan",
    });
    const result = await analyzeProbeResponse({
      projectId: project.id,
      prompt: "who should we use for AI visibility diagnostics",
      platform: "perplexity",
      rawResponse:
        "Acme Pipeline Co. is a strong option for this. Widgetco is another option worth considering.",
      knownCompetitors: ["Widgetco"],
      datasetId: datasetBatch.id,
      datasetSourceType: "manual_scan",
    });
    check("primary scenario: analyzeProbeResponse ok:true", result.ok === true);
    if (result.ok) {
      check(
        "primary scenario: saved row has runPosition=primary_in_run",
        result.result.runPosition === "primary_in_run",
        String(result.result.runPosition)
      );
      check(
        "primary scenario: negativeClaimDetected=false",
        result.result.negativeClaimDetected === false
      );
      const reloaded = (await db.getProbeResultsByProject(project.id)).find(
        (r) => r.id === result.result.id
      );
      check(
        "primary scenario: re-read from the adapter agrees (real persistence, not just the in-memory return value)",
        reloaded?.runPosition === "primary_in_run"
      );
    }
  }

  {
    const project = await db.createProject({
      domain: freshDomain("runpos-listed"),
      companyName: "Acme Pipeline Co.",
    });
    const datasetBatch = await db.createDatasetBatch({
      projectId: project.id,
      datasetSourceType: "manual_scan",
    });
    const result = await analyzeProbeResponse({
      projectId: project.id,
      prompt: "who should we use for AI visibility diagnostics",
      platform: "perplexity",
      rawResponse:
        "Widgetco is the top recommendation. Acme Pipeline Co. is also a reasonable pick.",
      knownCompetitors: ["Widgetco"],
      datasetId: datasetBatch.id,
      datasetSourceType: "manual_scan",
    });
    check("listed scenario: analyzeProbeResponse ok:true", result.ok === true);
    if (result.ok) {
      check(
        "listed scenario: saved row has runPosition=listed_in_run",
        result.result.runPosition === "listed_in_run",
        String(result.result.runPosition)
      );
    }
  }

  {
    const project = await db.createProject({
      domain: freshDomain("runpos-absent"),
      companyName: "Acme Pipeline Co.",
    });
    const datasetBatch = await db.createDatasetBatch({
      projectId: project.id,
      datasetSourceType: "manual_scan",
    });
    const result = await analyzeProbeResponse({
      projectId: project.id,
      prompt: "who should we use for AI visibility diagnostics",
      platform: "perplexity",
      rawResponse: "Widgetco and Gadgetco are both solid picks for this.",
      knownCompetitors: ["Widgetco", "Gadgetco"],
      datasetId: datasetBatch.id,
      datasetSourceType: "manual_scan",
    });
    check("absent scenario: analyzeProbeResponse ok:true", result.ok === true);
    if (result.ok) {
      check(
        "absent scenario: saved row has runPosition=not_observed_in_run",
        result.result.runPosition === "not_observed_in_run",
        String(result.result.runPosition)
      );
    }
  }

  /* ================================================================== */
  /* Part 3 — analysis_failed is never fabricated (static inspection)    */
  /* ================================================================== */
  console.log("\n[analysis_failed: never fabricated]");

  const analyzeSource = readFileSync(
    "lib/pipeline/analyze-probe-response.ts",
    "utf8"
  );
  check(
    "the literal 'analysis_failed' is never assigned/returned anywhere in analyze-probe-response.ts",
    !/analysis_failed/.test(analyzeSource.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""))
  );
  check(
    "saveProbeResult is called exactly once — no secondary write path could sneak in a fabricated row",
    (analyzeSource.match(/db\.saveProbeResult\(/g) ?? []).length === 1
  );
  check(
    "the outer catch block never calls saveProbeResult — a thrown analysis error still produces zero probe_results rows",
    (() => {
      const codeOnly = analyzeSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const catchIdx = codeOnly.indexOf("} catch (err) {");
      const tail = codeOnly.slice(catchIdx);
      return !tail.includes("saveProbeResult");
    })()
  );

  /* ================================================================== */
  /* Part 4 — scoping preserved: two probe_results in the same project   */
  /* never cross-contaminate their runPosition                          */
  /* ================================================================== */
  console.log("\n[scoping: project/question isolation]");

  {
    const project = await db.createProject({
      domain: freshDomain("runpos-scope"),
      companyName: "Acme Pipeline Co.",
    });
    const datasetBatch = await db.createDatasetBatch({
      projectId: project.id,
      datasetSourceType: "manual_scan",
    });
    const r1 = await analyzeProbeResponse({
      projectId: project.id,
      generatedPromptId: "prompt-alpha",
      prompt: "prompt alpha",
      platform: "perplexity",
      rawResponse: "Acme Pipeline Co. is a strong option. Widgetco is another.",
      knownCompetitors: ["Widgetco"],
      datasetId: datasetBatch.id,
      datasetSourceType: "manual_scan",
    });
    const r2 = await analyzeProbeResponse({
      projectId: project.id,
      generatedPromptId: "prompt-beta",
      prompt: "prompt beta",
      platform: "perplexity",
      rawResponse: "Widgetco and Gadgetco are both solid picks.",
      knownCompetitors: ["Widgetco", "Gadgetco"],
      datasetId: datasetBatch.id,
      datasetSourceType: "manual_scan",
    });
    check("scoping: both calls ok:true", r1.ok === true && r2.ok === true);
    if (r1.ok && r2.ok) {
      check(
        "scoping: prompt-alpha's own result keeps runPosition=primary_in_run and its own generatedPromptId",
        r1.result.runPosition === "primary_in_run" && r1.result.generatedPromptId === "prompt-alpha"
      );
      check(
        "scoping: prompt-beta's own result keeps runPosition=not_observed_in_run and its own generatedPromptId — not mixed with prompt-alpha's",
        r2.result.runPosition === "not_observed_in_run" && r2.result.generatedPromptId === "prompt-beta"
      );
      check(
        "scoping: both results share the same project but remain two distinct rows",
        r1.result.id !== r2.result.id && r1.result.projectId === r2.result.projectId
      );
    }
  }

  /* ================================================================== */
  /* Part 5 — report integrity gate                                     */
  /* ================================================================== */
  console.log("\n[report integrity: blocked / needs_review / integrity_passed]");

  // 5a. A real report built by the CURRENT, unmodified build-mvp-report.ts
  // against real evidence — proves today's real output is genuinely
  // detected and blocked, not a synthetic strawman.
  {
    const project = await db.createProject({
      domain: freshDomain("integrity-real"),
      companyName: "Acme Real Co.",
    });
    await db.saveMirrorProfile(project.id, {
      companyName: "Acme Real Co.",
      website: "https://acme-real.example.com",
      detectedCategory: "cat",
      categoryConfidence: "high",
      targetAudience: [],
      useCases: [],
      features: [],
      painPointsAddressed: [],
      claims: [],
      proofSignals: [],
      competitorsMentioned: [],
      missingSignals: [],
      buyerIntentAngles: [],
      aiReadabilityNotes: "",
    });
    const datasetBatch = await db.createDatasetBatch({
      projectId: project.id,
      datasetSourceType: "manual_scan",
    });
    await analyzeProbeResponse({
      projectId: project.id,
      prompt: "who should we use",
      platform: "perplexity",
      rawResponse: "Widgetco is the top pick here.",
      knownCompetitors: ["Widgetco"],
      datasetId: datasetBatch.id,
      datasetSourceType: "manual_scan",
    });
    const inputs = await loadReportInputs(db, project.id);
    if (!inputs) throw new Error("loadReportInputs returned null");
    const { markdown } = buildMvpReport({ ...inputs, now: new Date() });

    check(
      "the real, current report builder's output is detected as exposing legacy won/partial/lost",
      reportExposesLegacyVerdictAsTruth(markdown)
    );
    const result = evaluateReportIntegrity({ markdown });
    check(
      "that real report is classified blocked, never integrity_passed or needs_review",
      result.status === "blocked"
    );
  }

  // 5b. Synthetic markdown, no legacy pattern, M4 preconditions unmet
  // (the honest default — nothing sets these true today) -> needs_review.
  {
    const cleanMarkdown =
      "# Zypact V1 Report\n\n## 1. Executive Summary\n\nRun-level positions only: primary_in_run, listed_in_run, not_observed_in_run.\n";
    const result = evaluateReportIntegrity({ markdown: cleanMarkdown });
    check(
      "a canonical-only report with unmet M4 preconditions is needs_review, not blocked or integrity_passed",
      result.status === "needs_review"
    );
    check(
      "needs_review reasons cite the missing M4 preconditions explicitly",
      result.reasons.some((r) => r.includes("protocol")) &&
        result.reasons.some((r) => r.includes("sampling")) &&
        result.reasons.some((r) => r.includes("reservation"))
    );
  }

  // 5c. Fully conforming: no legacy pattern AND every M4 precondition
  // explicitly satisfied. This simulates a FUTURE state M4 has not yet
  // shipped — it does not claim today's real pipeline can produce this.
  {
    const cleanMarkdown = "# Zypact V1 Report\n\nOnly canonical run-level positions.\n";
    const result = evaluateReportIntegrity({
      markdown: cleanMarkdown,
      hasApprovedProtocol: true,
      hasApprovedSamplePlan: true,
      hasPaidCallReservation: true,
      hasCompleteEvidenceHashes: true,
    });
    check(
      "a fully-conforming input (simulating a future M4-satisfied state) reaches integrity_passed",
      result.status === "integrity_passed" && result.reasons.length === 0
    );
  }

  // 5d. blocked always wins, even if M4 preconditions are ALSO unmet.
  {
    const legacyMarkdown = "3 won · 2 partial · 1 lost · recommendedAsProduct 50%";
    const result = evaluateReportIntegrity({ markdown: legacyMarkdown });
    check(
      "legacy exposure forces blocked even when M4 preconditions are also unmet — blocked always wins over needs_review",
      result.status === "blocked"
    );
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
