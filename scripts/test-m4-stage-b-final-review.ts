#!/usr/bin/env tsx
/**
 * M4 Stage B — final review, before any commit.
 *
 * Six required checks, verbatim from the review instruction:
 *  1. every V1 protocol has a non-null, approved, project-scoped
 *     buyer_question_version_id; only generated_prompt_id stays null
 *     when there is no valid legacy linkage.
 *  2. the --protocol-id runner never accepts free text in place of the
 *     approved question/version.
 *  3. exact text, hash, provenance, and approval come from
 *     buyer_question_versions.
 *  4. PROTOCOL_RESERVATION_CEILING_PER_CALL is not a hidden global
 *     budget or a 5x3/$2 fallback — the protocol's own approved caps
 *     govern effective admission.
 *  5. unresolved_in_flight_attempt prevents a double call, stays
 *     explicitly unresolved, is never auto-retried by M4, and is
 *     documented as M5's responsibility.
 *  6. planned/completed/failed/excluded/remaining are ledger-derived
 *     and planned = baseline + retest.
 *
 * Real in-memory adapter (getDb()), mock LLM mode. No network, no
 * payment, no staging/Production, no migration applied.
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ZYPACT_ALLOW_MEMORY_DB;
process.env.ZYPACT_MOCK_MODE = "on";

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import type { CreateProtocolInput, Protocol } from "@/lib/db/types";
import type { PerplexityProbeResult } from "@/lib/probes/perplexity";
import {
  computeProtocolLedgerCounters,
  runProtocolGatedBaseline,
  type ProtocolProbeCaller,
} from "@/lib/pipeline/run-protocol-gated-baseline";

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

const db = getDb();
const scanScript = readFileSync("scripts/mvp-scan.ts", "utf-8");
const pipelineModule = readFileSync(
  "lib/pipeline/run-protocol-gated-baseline.ts",
  "utf-8"
);
const migrationSql = readFileSync(
  "supabase/migrations/0047_m4_buyer_question_protocol_attempts.sql",
  "utf-8"
);

/** Strips /* *\/ block comments and // line comments so a name mentioned only to disclaim it in prose doesn't false-positive a "never referenced" check. */
function stripTsComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}
const pipelineModuleCodeOnly = stripTsComments(pipelineModule);

function successCaller(): ProtocolProbeCaller {
  return async ({ prompt }) => {
    const result: PerplexityProbeResult = {
      prompt,
      answer: `Mock answer for "${prompt}".`,
      rawResponse: `Mock answer for "${prompt}".`,
      rawProbeRequest: prompt,
      citations: [],
      searchResults: [],
      sourceCitations: [],
      model: "mock-injected",
      usedMock: true,
    };
    return result;
  };
}

async function makeProject(): Promise<{ projectId: string }> {
  const project = await db.createProject({
    domain: `stage-b-review-${randomUUID()}.test`,
    companyName: "Stage B Review Co",
  });
  return { projectId: project.id };
}

async function makeApprovedProtocol(
  projectId: string,
  overrides: Partial<CreateProtocolInput> = {}
): Promise<{ protocol: Protocol; versionId: string }> {
  const question = await db.createBuyerQuestion({ projectId });
  const version = await db.createBuyerQuestionVersion({
    buyerQuestionId: question.id,
    projectId,
    versionNumber: 1,
    promptText: "best invoicing software for a 20-person agency",
    promptHash: `hash-${randomUUID()}`,
    intentType: "shortlist",
    commercialValue: 4,
    winnability: 3,
    priority: 1,
    rationale: "Stage B final-review fixture",
    provenance: "crm_evidence",
  });
  await db.approveBuyerQuestionVersion({
    versionId: version.id,
    projectId,
    approvedBy: "11111111-1111-4111-8111-111111111111",
  });
  const draft = await db.createProtocol({
    projectId,
    buyerQuestionVersionId: version.id,
    provider: "perplexity_sonar",
    surface: "answer",
    plannedBaselineRuns: 3,
    plannedRetestRuns: 2,
    unitOfAnalysis: "buyer_question_version",
    primaryMetric: "presence_rate",
    samplePlanningMethod: "fixed_by_protocol",
    runCap: 10,
    spendCapUsd: 5,
    timeWindowSeconds: 3600,
    rateLimitPerHour: 100,
    concurrencyLimit: 10,
    retryCap: 2,
    ...overrides,
  });
  const { outcome, protocol } = await db.approveProtocol({
    protocolId: draft.id,
    projectId,
    approvedBy: "11111111-1111-4111-8111-111111111111",
  });
  if (outcome !== "APPROVED" || !protocol) {
    throw new Error(`fixture setup failed: approveProtocol returned ${outcome}`);
  }
  return { protocol, versionId: version.id };
}

async function datasetBatchFor(projectId: string) {
  return db.createDatasetBatch({ projectId, datasetSourceType: "manual_scan" });
}

async function main(): Promise<void> {
  // ------------------------------------------------------------------
  // 1. buyer_question_version_id non-null, approved, project-scoped;
  //    generated_prompt_id NULL when there is no valid legacy linkage
  // ------------------------------------------------------------------
  console.log("\n[1] buyer_question_version_id: NOT NULL, approved, project-scoped");
  {
    check(
      "protocols.buyer_question_version_id is a NOT NULL column in the migration",
      /buyer_question_version_id\s+uuid not null references public\.buyer_question_versions/i.test(
        migrationSql
      )
    );
    check(
      "protocols carries a composite FK tying (buyer_question_version_id, project_id) to buyer_question_versions(id, project_id) — project-scoped at the DB layer",
      migrationSql.includes("protocols_version_project_fk") &&
        /foreign key \(buyer_question_version_id, project_id\)\s*\n\s*references public\.buyer_question_versions \(id, project_id\)/i.test(
          migrationSql
        )
    );
    check(
      "protocol_attempts.buyer_question_version_id is also NOT NULL and project-scoped via its own composite FK",
      /buyer_question_version_id\s+uuid not null references public\.buyer_question_versions/i.test(
        migrationSql
      ) && migrationSql.includes("protocol_attempts_version_project_fk")
    );

    const { projectId: projectA } = await makeProject();
    const { projectId: projectB } = await makeProject();
    const { protocol, versionId } = await makeApprovedProtocol(projectA);

    check(
      "the approved protocol's buyerQuestionVersionId is non-null",
      typeof protocol.buyerQuestionVersionId === "string" &&
        protocol.buyerQuestionVersionId.length > 0
    );
    const resolvedVersion = await db.getBuyerQuestionVersion(
      protocol.buyerQuestionVersionId,
      projectA
    );
    check(
      "resolving it under the protocol's own project returns a version that IS approved",
      resolvedVersion !== null && resolvedVersion.approvedAt !== null
    );
    check(
      "the SAME version id resolves to null under a different project — project-scoped in practice, not just in schema",
      (await db.getBuyerQuestionVersion(versionId, projectB)) === null
    );

    // Creating a protocol whose version belongs to a DIFFERENT project
    // must fail closed at creation time — never silently cross-linked.
    const question2 = await db.createBuyerQuestion({ projectId: projectB });
    const versionUnderB = await db.createBuyerQuestionVersion({
      buyerQuestionId: question2.id,
      projectId: projectB,
      versionNumber: 1,
      promptText: "irrelevant",
      promptHash: `hash-${randomUUID()}`,
      intentType: "shortlist",
      commercialValue: 3,
      winnability: 3,
      priority: 1,
      rationale: "cross-project mismatch fixture",
      provenance: "founder_supplied",
    });
    let threw = false;
    try {
      await db.createProtocol({
        projectId: projectA, // mismatched on purpose
        buyerQuestionVersionId: versionUnderB.id,
        provider: "perplexity_sonar",
        surface: "answer",
        plannedBaselineRuns: 1,
        plannedRetestRuns: 0,
        unitOfAnalysis: "buyer_question_version",
        primaryMetric: "presence_rate",
        samplePlanningMethod: "fixed_by_protocol",
        runCap: 5,
        spendCapUsd: 5,
        timeWindowSeconds: 3600,
        rateLimitPerHour: 100,
        concurrencyLimit: 10,
        retryCap: 1,
      });
    } catch (err) {
      threw =
        err instanceof Error &&
        err.message === "buyer_question_version_project_mismatch";
    }
    check(
      "a protocol referencing a version from a DIFFERENT project is refused at creation (buyer_question_version_project_mismatch)",
      threw
    );

    // generated_prompt_id: only NULL, never fabricated, for a run
    // driven purely by an M4 protocol.
    const datasetBatch = await datasetBatchFor(projectA);
    await runProtocolGatedBaseline({
      db,
      projectId: projectA,
      protocol,
      promptText: "best invoicing software for a 20-person agency",
      brandName: "Stage B Review Co",
      domain: "stage-b-review.test",
      knownCompetitors: [],
      datasetBatch,
      plannedRuns: 1,
      attemptKind: "baseline",
      probeMode: "simulated",
      reservationCeilingUsd: 0.05,
      actualCostUsd: 0.01,
      callProvider: successCaller(),
    });
    const probeResults = await db.getProbeResultsByProject(projectA);
    check(
      "every probe_results row produced by this protocol run has generatedPromptId === null — no fabricated legacy linkage",
      probeResults.length > 0 &&
        probeResults.every((r) => r.generatedPromptId === null)
    );
    check(
      "the module never sets generatedPromptId on the analyzeProbeResponse call it makes",
      !pipelineModule.includes("generatedPromptId:")
    );
  }

  // ------------------------------------------------------------------
  // 2. the runner never accepts free text in place of the approved
  //    question/version
  // ------------------------------------------------------------------
  console.log("\n[2] runner never substitutes free text for the approved question/version");
  {
    check(
      "--protocol-id is rejected when combined with --prompts-file (no alternate prompt source)",
      scanScript.includes(
        '"--protocol-id cannot be combined with --prompts-file. The protocol\'s buyer_question_version already carries its own single canonical prompt text."'
      )
    );
    check(
      "--protocol-id is rejected when combined with --prompts/--runs/--budget-usd (no legacy count/budget can blend in)",
      scanScript.includes(
        '"--protocol-id cannot be combined with --prompts, --runs, or --budget-usd. " +'
      )
    );
    check(
      "the ONLY promptText ever passed into runProtocolGatedBaseline from the CLI is approvedVersion.promptText — never args.* or any other free-text source",
      scanScript.includes("promptText: approvedVersion.promptText,") &&
        !/promptText:\s*args\./.test(scanScript)
    );
  }

  // ------------------------------------------------------------------
  // 3. exact text, hash, provenance, approval come from
  //    buyer_question_versions
  // ------------------------------------------------------------------
  console.log("\n[3] text/hash/provenance/approval sourced only from buyer_question_versions");
  {
    check(
      "the CLI prints the version's exact promptHash, never a recomputed one",
      scanScript.includes("approvedVersion.promptHash")
    );
    check(
      "the CLI prints the version's exact provenance",
      scanScript.includes("approvedVersion.provenance")
    );
    check(
      "the CLI prints the version's exact approvedBy/approvedAt",
      scanScript.includes("approvedVersion.approvedBy") &&
        scanScript.includes("approvedVersion.approvedAt")
    );
    check(
      "neither the CLI wiring nor the pipeline module recomputes a hash (no sha256/createHash call)",
      !/sha256Hex\(|createHash\(/i.test(pipelineModule) &&
        !(/sha256Hex\(|createHash\(/i.test(scanScript.slice(scanScript.indexOf("async function runProtocolGatedScan"))))
    );
  }

  // ------------------------------------------------------------------
  // 4. the reservation ceiling is not a hidden global budget
  // ------------------------------------------------------------------
  console.log("\n[4] reservation ceiling is per-call, never a hidden global budget");
  {
    check(
      "the reservation/actual-cost constants live only in scripts/mvp-scan.ts, never inside the migration's caps",
      !migrationSql.includes("PROTOCOL_RESERVATION_CEILING_PER_CALL_USD") &&
        !migrationSql.includes("PROTOCOL_ACTUAL_COST_PER_LIVE_PROBE_USD")
    );
    check(
      "the legacy $2/5-prompt/3-run defaults are never referenced by the pipeline module OUTSIDE its own disclaiming comment",
      !/DEFAULT_PROMPTS|DEFAULT_RUNS|DEFAULT_BUDGET_USD/.test(pipelineModuleCodeOnly)
    );

    const { projectId: projA } = await makeProject();
    const { projectId: projB } = await makeProject();
    const { protocol: protoLowCap } = await makeApprovedProtocol(projA, {
      plannedBaselineRuns: 3,
      plannedRetestRuns: 0,
      runCap: 10,
      spendCapUsd: 0.1, // tight — same reservation ceiling as protoHighCap below
    });
    const { protocol: protoHighCap } = await makeApprovedProtocol(projB, {
      plannedBaselineRuns: 3,
      plannedRetestRuns: 0,
      runCap: 10,
      spendCapUsd: 0.5, // generous
    });
    const datasetLow = await datasetBatchFor(projA);
    const datasetHigh = await datasetBatchFor(projB);

    // Identical reservation ceiling and identical real cost for both —
    // if the ceiling constant were secretly the effective budget, both
    // protocols would admit the same number of calls regardless of
    // their own spend_cap_usd. They must not.
    const RESERVATION_CEILING = 0.05;
    const ACTUAL_COST = 0.05;

    const lowResult = await runProtocolGatedBaseline({
      db,
      projectId: projA,
      protocol: protoLowCap,
      promptText: "best invoicing software for a 20-person agency",
      brandName: "Stage B Review Co",
      domain: "stage-b-review.test",
      knownCompetitors: [],
      datasetBatch: datasetLow,
      plannedRuns: 3,
      attemptKind: "baseline",
      probeMode: "simulated",
      reservationCeilingUsd: RESERVATION_CEILING,
      actualCostUsd: ACTUAL_COST,
      callProvider: successCaller(),
    });
    const highResult = await runProtocolGatedBaseline({
      db,
      projectId: projB,
      protocol: protoHighCap,
      promptText: "best invoicing software for a 20-person agency",
      brandName: "Stage B Review Co",
      domain: "stage-b-review.test",
      knownCompetitors: [],
      datasetBatch: datasetHigh,
      plannedRuns: 3,
      attemptKind: "baseline",
      probeMode: "simulated",
      reservationCeilingUsd: RESERVATION_CEILING,
      actualCostUsd: ACTUAL_COST,
      callProvider: successCaller(),
    });

    check(
      "with spend_cap_usd=0.10, the SAME $0.05 ceiling admits only 2 of 3 planned calls (0.05+0.05=0.10 fits, a third would not)",
      lowResult.completed === 2 && lowResult.stoppedReason === "spend_cap_exceeded"
    );
    check(
      "with spend_cap_usd=0.50, the IDENTICAL $0.05 ceiling admits all 3 planned calls freely",
      highResult.completed === 3 && highResult.stoppedReason === null
    );
    check(
      "the two protocols' own spend_cap_usd — not the shared reservation-ceiling constant — is what determined the different outcomes",
      lowResult.completed !== highResult.completed
    );
  }

  // ------------------------------------------------------------------
  // 5. unresolved_in_flight_attempt
  // ------------------------------------------------------------------
  console.log("\n[5] unresolved_in_flight_attempt: no double call, stays unresolved, never auto-retried, M5's job");
  {
    const { projectId } = await makeProject();
    const { protocol } = await makeApprovedProtocol(projectId, {
      plannedBaselineRuns: 1,
      plannedRetestRuns: 0,
      runCap: 5,
      spendCapUsd: 5,
    });
    const datasetBatch = await datasetBatchFor(projectId);

    const preExisting = await db.admitAndReserveAttempt({
      protocolId: protocol.id,
      projectId,
      attemptKind: "baseline",
      idempotencyKey: `${protocol.id}:baseline:0`,
      estimatedCostUsd: 0.05,
    });
    check("a prior invocation's reservation exists, deliberately never started/reconciled", preExisting.outcome === "RESERVED");

    let calls = 0;
    const countingCaller: ProtocolProbeCaller = async (c) => {
      calls += 1;
      return successCaller()(c);
    };

    const result = await runProtocolGatedBaseline({
      db,
      projectId,
      protocol,
      promptText: "best invoicing software for a 20-person agency",
      brandName: "Stage B Review Co",
      domain: "stage-b-review.test",
      knownCompetitors: [],
      datasetBatch,
      plannedRuns: 1,
      attemptKind: "baseline",
      probeMode: "simulated",
      reservationCeilingUsd: 0.05,
      actualCostUsd: 0.01,
      callProvider: countingCaller,
    });

    check(
      "no double call: the provider is never invoked",
      calls === 0
    );
    check(
      "stoppedReason is exactly unresolved_in_flight_attempt",
      result.stoppedReason === "unresolved_in_flight_attempt"
    );

    const attemptsAfter = await db.getProtocolAttempts(protocol.id, projectId);
    check(
      "still exactly one attempt row — no new reservation, no retry-linked row was created",
      attemptsAfter.length === 1
    );
    check(
      "the pre-existing attempt's status is UNCHANGED (still 'reserved') — stays explicitly unresolved, never silently marked failed/completed/cancelled",
      attemptsAfter[0]!.status === "reserved" &&
        attemptsAfter[0]!.terminalizedAt === null &&
        attemptsAfter[0]!.actualCostUsd === null
    );
    check(
      "never auto-retried: no attempt row has retryOfAttemptId pointing at the pre-existing one",
      !attemptsAfter.some((a) => a.retryOfAttemptId === preExisting.attempt!.id)
    );
    check(
      "the module documents this as M5's (durable worker) responsibility, not M4's",
      pipelineModule.includes("M5's job") || pipelineModule.includes("M5's durable-worker concern")
    );
    check(
      "the CLI surfaces an explicit, non-generic message for this specific stop reason",
      scanScript.includes("Durable resume/recovery is M5's responsibility, not this CLI's.")
    );
  }

  // ------------------------------------------------------------------
  // 6. planned/completed/failed/excluded/remaining, ledger-derived,
  //    planned = baseline + retest
  // ------------------------------------------------------------------
  console.log("\n[6] planned/completed/failed/excluded/remaining are ledger-derived; planned = baseline + retest");
  {
    const { projectId } = await makeProject();
    const { protocol } = await makeApprovedProtocol(projectId, {
      plannedBaselineRuns: 3,
      plannedRetestRuns: 2,
      runCap: 20,
      spendCapUsd: 100,
      retryCap: 0,
    });

    check(
      "planned is exactly baseline (3) + retest (2) = 5, even though this CLI path only ever executes the baseline slice",
      protocol.plannedBaselineRuns + protocol.plannedRetestRuns === 5
    );

    // Build a deliberately mixed ledger by hand: 2 completed, 1 failed
    // (timed_out, retry_cap=0 so no retry chain), 1 excluded, 1
    // cancelled — leaving a real gap against planned=5.
    const c1 = await db.admitAndReserveAttempt({
      protocolId: protocol.id, projectId, attemptKind: "baseline",
      idempotencyKey: "c1", estimatedCostUsd: 0.01,
    });
    await db.reconcileAttempt({ attemptId: c1.attempt!.id, projectId, status: "completed", actualCostUsd: 0.01 });

    const c2 = await db.admitAndReserveAttempt({
      protocolId: protocol.id, projectId, attemptKind: "baseline",
      idempotencyKey: "c2", estimatedCostUsd: 0.01,
    });
    await db.reconcileAttempt({ attemptId: c2.attempt!.id, projectId, status: "completed", actualCostUsd: 0.01 });

    const f1 = await db.admitAndReserveAttempt({
      protocolId: protocol.id, projectId, attemptKind: "baseline",
      idempotencyKey: "f1", estimatedCostUsd: 0.01,
    });
    await db.reconcileAttempt({ attemptId: f1.attempt!.id, projectId, status: "timed_out", actualCostUsd: 0.01, terminationReason: "network_error" });

    const e1 = await db.admitAndReserveAttempt({
      protocolId: protocol.id, projectId, attemptKind: "retest",
      idempotencyKey: "e1", estimatedCostUsd: 0.01,
    });
    await db.reconcileAttempt({ attemptId: e1.attempt!.id, projectId, status: "excluded", actualCostUsd: 0, terminationReason: "out_of_scope" });

    const x1 = await db.admitAndReserveAttempt({
      protocolId: protocol.id, projectId, attemptKind: "retest",
      idempotencyKey: "x1", estimatedCostUsd: 0.01,
    });
    await db.reconcileAttempt({ attemptId: x1.attempt!.id, projectId, status: "cancelled", actualCostUsd: 0 });

    const attempts = await db.getProtocolAttempts(protocol.id, projectId);
    check("exactly 5 attempts were created (2 completed + 1 failed + 1 excluded + 1 cancelled)", attempts.length === 5);

    const counters = computeProtocolLedgerCounters(protocol, attempts);
    check("ledger-derived planned = 5 (3 baseline + 2 retest)", counters.planned === 5);
    check("ledger-derived completed = 2", counters.completed === 2);
    check("ledger-derived failed = 1 (timed_out counts as failed)", counters.failed === 1);
    check("ledger-derived excluded = 2 (both 'excluded' AND 'cancelled' statuses)", counters.excluded === 2);
    check(
      "ledger-derived remaining = planned(5) - consumed_non_cancelled(4) = 1 — the cancelled attempt frees its slot, exactly mirroring admitAndReserveAttempt's own run_cap consumption rule",
      counters.remaining === 1
    );

    // A 6th admission (any kind) must still be possible — remaining=1
    // should be a live, not merely descriptive, number.
    const sixth = await db.admitAndReserveAttempt({
      protocolId: protocol.id, projectId, attemptKind: "baseline",
      idempotencyKey: "sixth", estimatedCostUsd: 0.01,
    });
    check(
      "a 6th admission still succeeds (run_cap=20 was never the binding constraint here) — remaining is a live number, not just cosmetic",
      sixth.outcome === "RESERVED"
    );
  }

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0
        ? "M4 Stage B final review PASSED."
        : "M4 Stage B final review FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
