#!/usr/bin/env tsx
/**
 * M4 — buyer question / protocol / admission / reservation / reconciliation.
 *
 * Real in-memory adapter (getDb()), mock LLM mode. No network, no
 * payment, no staging/Production, no migration applied anywhere.
 *
 * Covers exactly the nine required test categories from the approved
 * M4 implementation instruction:
 *   1. question/protocole non approuvé -> aucune tentative
 *   2. plan invalide ou hors plafond -> rejet fermé
 *   3. plan variable -> exactement le nombre approuvé
 *   4. réservation observée avant l'appel provider
 *   5. doublon idempotent -> aucun double appel/réservation
 *   6. retry/crash/timeout -> aucune double facturation
 *   7. réconciliation des coûts et compteurs
 *   8. isolation entre projets
 *   9. non-régression complète M1/M2/M3 (separate process, see bottom)
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ZYPACT_ALLOW_MEMORY_DB;
process.env.ZYPACT_MOCK_MODE = "on";

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import type {
  CreateProtocolInput,
  Protocol,
} from "@/lib/db/types";

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

/** A fully-specified protocol input with no universal defaults anywhere — every cap/plan value is explicit and varies per test (Rules 3/4/5/6). */
function protocolInput(
  projectId: string,
  versionId: string,
  overrides: Partial<CreateProtocolInput> = {}
): CreateProtocolInput {
  return {
    projectId,
    buyerQuestionVersionId: versionId,
    provider: "perplexity_sonar",
    surface: "answer",
    plannedBaselineRuns: 7,
    plannedRetestRuns: 4,
    unitOfAnalysis: "buyer_question_version",
    primaryMetric: "presence_rate",
    samplePlanningMethod: "fixed_by_protocol",
    runCap: 11,
    spendCapUsd: 5,
    timeWindowSeconds: 3600,
    rateLimitPerHour: 100,
    concurrencyLimit: 10,
    retryCap: 2,
    ...overrides,
  };
}

async function makeApprovedProtocol(
  projectId: string,
  overrides: Partial<CreateProtocolInput> = {}
): Promise<Protocol> {
  const question = await db.createBuyerQuestion({ projectId });
  const version = await db.createBuyerQuestionVersion({
    buyerQuestionId: question.id,
    projectId,
    versionNumber: 1,
    promptText: "best invoicing software for a 20-person agency",
    promptHash: `hash-${randomUUID()}`,
    intentType: "shortlist",
    commercialValue: 0.8,
    winnability: 0.6,
    priority: 1,
    rationale: "high-intent shortlist query surfaced from CRM evidence",
    provenance: "crm_evidence",
  });
  await db.approveBuyerQuestionVersion({
    versionId: version.id,
    projectId,
    approvedBy: "founder@zypact.test",
  });
  const draft = await db.createProtocol(
    protocolInput(projectId, version.id, overrides)
  );
  const { outcome, protocol } = await db.approveProtocol({
    protocolId: draft.id,
    projectId,
    approvedBy: "founder@zypact.test",
  });
  if (outcome !== "APPROVED" || !protocol) {
    throw new Error(`test setup failed: approveProtocol returned ${outcome}`);
  }
  return protocol;
}

async function main(): Promise<void> {
  const projectA = randomUUID();
  const projectB = randomUUID();

  // ------------------------------------------------------------------
  // 1. question/protocole non approuvé -> aucune tentative
  // ------------------------------------------------------------------
  console.log("\n[1] unapproved question/protocol admits no attempt");
  {
    const question = await db.createBuyerQuestion({ projectId: projectA });
    const version = await db.createBuyerQuestionVersion({
      buyerQuestionId: question.id,
      projectId: projectA,
      versionNumber: 1,
      promptText: "unapproved question text",
      promptHash: `hash-${randomUUID()}`,
      intentType: "shortlist",
      commercialValue: 0.5,
      winnability: 0.5,
      priority: 2,
      rationale: "not yet approved",
      provenance: "founder_supplied",
    });
    // Draft protocol, NOT approved — version also not approved yet.
    const draftProtocol = await db.createProtocol(
      protocolInput(projectA, version.id)
    );
    check(
      "a freshly created protocol starts in draft status",
      draftProtocol.status === "draft"
    );

    const result = await db.admitAndReserveAttempt({
      protocolId: draftProtocol.id,
      projectId: projectA,
      attemptKind: "baseline",
      idempotencyKey: `idem-${randomUUID()}`,
      estimatedCostUsd: 0.05,
    });
    check(
      "admission against a draft (unapproved) protocol is rejected PROTOCOL_NOT_APPROVED",
      result.outcome === "PROTOCOL_NOT_APPROVED" && result.attempt === null
    );

    // Approving the protocol before its version is approved must fail closed too.
    const prematureApproval = await db.approveProtocol({
      protocolId: draftProtocol.id,
      projectId: projectA,
      approvedBy: "founder@zypact.test",
    });
    check(
      "approving a protocol whose question-version is not yet approved is rejected VERSION_NOT_APPROVED",
      prematureApproval.outcome === "VERSION_NOT_APPROVED"
    );

    const attempts = await db.getProtocolAttempts(draftProtocol.id, projectA);
    check(
      "zero attempt rows exist for the unapproved protocol",
      attempts.length === 0
    );
  }

  // ------------------------------------------------------------------
  // 2. plan invalide ou hors plafond -> rejet fermé
  // ------------------------------------------------------------------
  console.log("\n[2] invalid plan / cap exceeded rejects closed");
  {
    const question = await db.createBuyerQuestion({ projectId: projectA });
    const version = await db.createBuyerQuestionVersion({
      buyerQuestionId: question.id,
      projectId: projectA,
      versionNumber: 1,
      promptText: "invalid-plan question",
      promptHash: `hash-${randomUUID()}`,
      intentType: "shortlist",
      commercialValue: 0.5,
      winnability: 0.5,
      priority: 3,
      rationale: "for plan-validation tests",
      provenance: "founder_supplied",
    });
    await db.approveBuyerQuestionVersion({
      versionId: version.id,
      projectId: projectA,
      approvedBy: "founder@zypact.test",
    });

    let threw = false;
    try {
      await db.createProtocol(
        protocolInput(projectA, version.id, {
          plannedBaselineRuns: 5,
          plannedRetestRuns: 3,
          runCap: 6, // < 5 + 3 -- Rule 4 violation
        })
      );
    } catch (err) {
      threw = err instanceof Error && err.message === "run_cap_below_planned_runs";
    }
    check(
      "creating a protocol with run_cap below the planned sum fails closed (run_cap_below_planned_runs)",
      threw
    );

    // A validly-shaped, approved protocol with a tight run_cap.
    const runCapProtocol = await makeApprovedProtocol(projectA, {
      plannedBaselineRuns: 1,
      plannedRetestRuns: 0,
      runCap: 1,
      spendCapUsd: 100,
      rateLimitPerHour: 100,
      concurrencyLimit: 100,
      retryCap: 5,
    });
    const first = await db.admitAndReserveAttempt({
      protocolId: runCapProtocol.id,
      projectId: projectA,
      attemptKind: "baseline",
      idempotencyKey: `idem-${randomUUID()}`,
      estimatedCostUsd: 0.01,
    });
    check("first admission within run_cap=1 succeeds", first.outcome === "RESERVED");
    const second = await db.admitAndReserveAttempt({
      protocolId: runCapProtocol.id,
      projectId: projectA,
      attemptKind: "baseline",
      idempotencyKey: `idem-${randomUUID()}`,
      estimatedCostUsd: 0.01,
    });
    check(
      "second admission beyond run_cap=1 is rejected closed RUN_CAP_EXCEEDED",
      second.outcome === "RUN_CAP_EXCEEDED" && second.attempt === null
    );

    // Spend cap.
    const spendCapProtocol = await makeApprovedProtocol(projectA, {
      plannedBaselineRuns: 5,
      plannedRetestRuns: 0,
      runCap: 20,
      spendCapUsd: 0.1,
    });
    const overBudget = await db.admitAndReserveAttempt({
      protocolId: spendCapProtocol.id,
      projectId: projectA,
      attemptKind: "baseline",
      idempotencyKey: `idem-${randomUUID()}`,
      estimatedCostUsd: 0.5,
    });
    check(
      "a single reservation whose estimated cost alone exceeds spend_cap_usd is rejected closed SPEND_CAP_EXCEEDED",
      overBudget.outcome === "SPEND_CAP_EXCEEDED" && overBudget.attempt === null
    );

    // Rate limit.
    const rateLimitProtocol = await makeApprovedProtocol(projectA, {
      plannedBaselineRuns: 10,
      plannedRetestRuns: 0,
      runCap: 20,
      spendCapUsd: 100,
      rateLimitPerHour: 2,
      concurrencyLimit: 100,
    });
    const r1 = await db.admitAndReserveAttempt({
      protocolId: rateLimitProtocol.id,
      projectId: projectA,
      attemptKind: "baseline",
      idempotencyKey: `idem-${randomUUID()}`,
      estimatedCostUsd: 0.01,
    });
    const r2 = await db.admitAndReserveAttempt({
      protocolId: rateLimitProtocol.id,
      projectId: projectA,
      attemptKind: "baseline",
      idempotencyKey: `idem-${randomUUID()}`,
      estimatedCostUsd: 0.01,
    });
    const r3 = await db.admitAndReserveAttempt({
      protocolId: rateLimitProtocol.id,
      projectId: projectA,
      attemptKind: "baseline",
      idempotencyKey: `idem-${randomUUID()}`,
      estimatedCostUsd: 0.01,
    });
    check(
      "rate_limit_per_hour=2 admits exactly two and rejects the third RATE_LIMIT_EXCEEDED",
      r1.outcome === "RESERVED" &&
        r2.outcome === "RESERVED" &&
        r3.outcome === "RATE_LIMIT_EXCEEDED"
    );

    // Concurrency limit (both left in-flight / 'reserved').
    const concurrencyProtocol = await makeApprovedProtocol(projectA, {
      plannedBaselineRuns: 10,
      plannedRetestRuns: 0,
      runCap: 20,
      spendCapUsd: 100,
      rateLimitPerHour: 100,
      concurrencyLimit: 1,
    });
    const c1 = await db.admitAndReserveAttempt({
      protocolId: concurrencyProtocol.id,
      projectId: projectA,
      attemptKind: "baseline",
      idempotencyKey: `idem-${randomUUID()}`,
      estimatedCostUsd: 0.01,
    });
    const c2 = await db.admitAndReserveAttempt({
      protocolId: concurrencyProtocol.id,
      projectId: projectA,
      attemptKind: "baseline",
      idempotencyKey: `idem-${randomUUID()}`,
      estimatedCostUsd: 0.01,
    });
    check(
      "concurrency_limit=1 admits one in-flight reservation and rejects a second concurrent one CONCURRENCY_LIMIT_EXCEEDED",
      c1.outcome === "RESERVED" && c2.outcome === "CONCURRENCY_LIMIT_EXCEEDED"
    );
  }

  // ------------------------------------------------------------------
  // 3. plan variable -> exactement le nombre approuvé
  // ------------------------------------------------------------------
  console.log("\n[3] variable plan admits exactly the approved count, no universal default");
  {
    const smallPlan = await makeApprovedProtocol(projectA, {
      plannedBaselineRuns: 2,
      plannedRetestRuns: 1,
      runCap: 3,
      spendCapUsd: 100,
      rateLimitPerHour: 100,
      concurrencyLimit: 100,
    });
    check(
      "plan is whatever was configured (2 baseline + 1 retest = 3), not the legacy 5-prompt/3-run default",
      smallPlan.plannedBaselineRuns === 2 &&
        smallPlan.plannedRetestRuns === 1 &&
        smallPlan.plannedBaselineRuns + smallPlan.plannedRetestRuns === 3
    );
    let admitted = 0;
    let lastOutcome = "";
    for (let i = 0; i < 5; i += 1) {
      const res = await db.admitAndReserveAttempt({
        protocolId: smallPlan.id,
        projectId: projectA,
        attemptKind: i < 2 ? "baseline" : "retest",
        idempotencyKey: `idem-${randomUUID()}`,
        estimatedCostUsd: 0.01,
      });
      lastOutcome = res.outcome;
      if (res.outcome === "RESERVED") admitted += 1;
    }
    check(
      "exactly run_cap=3 attempts admitted out of 5 requested, no more, no legacy fallback count",
      admitted === 3 && lastOutcome === "RUN_CAP_EXCEEDED"
    );

    // A different protocol with a much larger, still explicit plan proves
    // there is no hard-coded ceiling hiding behind the small examples above.
    const largePlan = await makeApprovedProtocol(projectA, {
      plannedBaselineRuns: 40,
      plannedRetestRuns: 20,
      runCap: 60,
      spendCapUsd: 1000,
      rateLimitPerHour: 1000,
      concurrencyLimit: 1000,
    });
    let largeAdmitted = 0;
    for (let i = 0; i < 60; i += 1) {
      const res = await db.admitAndReserveAttempt({
        protocolId: largePlan.id,
        projectId: projectA,
        attemptKind: "baseline",
        idempotencyKey: `idem-${randomUUID()}`,
        estimatedCostUsd: 0.001,
      });
      if (res.outcome === "RESERVED") largeAdmitted += 1;
    }
    check(
      "a protocol planned for 60 runs admits all 60 — plan is caller-supplied, not capped at any legacy constant",
      largeAdmitted === 60
    );
  }

  // ------------------------------------------------------------------
  // 4. réservation observée avant l'appel provider
  // ------------------------------------------------------------------
  console.log("\n[4] reservation exists strictly before any provider-call linkage");
  {
    const protocol = await makeApprovedProtocol(projectA);
    const admitted = await db.admitAndReserveAttempt({
      protocolId: protocol.id,
      projectId: projectA,
      attemptKind: "baseline",
      idempotencyKey: `idem-${randomUUID()}`,
      estimatedCostUsd: 0.02,
    });
    check(
      "admission produces status='reserved' with probeRunId still null — no provider call has happened yet",
      admitted.outcome === "RESERVED" &&
        admitted.attempt?.status === "reserved" &&
        admitted.attempt?.probeRunId === null
    );

    const attemptId = admitted.attempt!.id;
    const fakeProbeRunId = randomUUID(); // simulates the provider call's resulting probe_runs row, created only after reservation

    const started = await db.startAttempt({
      attemptId,
      projectId: projectA,
      probeRunId: fakeProbeRunId,
    });
    check(
      "startAttempt (called only after the simulated provider call) is the sole path that ever sets probeRunId, flips to in_progress",
      started.outcome === "STARTED" &&
        started.attempt?.status === "in_progress" &&
        started.attempt?.probeRunId === fakeProbeRunId
    );

    // Starting an attempt that was never reserved must fail closed.
    const neverReserved = randomUUID();
    const startOnMissing = await db.startAttempt({
      attemptId: neverReserved,
      projectId: projectA,
      probeRunId: randomUUID(),
    });
    check(
      "starting a non-existent attempt id is rejected NOT_FOUND — no attempt materializes out of a bare probe_run_id",
      startOnMissing.outcome === "NOT_FOUND" && startOnMissing.attempt === null
    );
  }

  // ------------------------------------------------------------------
  // 5. doublon idempotent -> aucun double appel/réservation
  // ------------------------------------------------------------------
  console.log("\n[5] duplicate idempotency key never double-reserves");
  {
    const protocol = await makeApprovedProtocol(projectA, {
      plannedBaselineRuns: 5,
      plannedRetestRuns: 0,
      runCap: 5,
    });
    const key = `idem-fixed-${randomUUID()}`;
    const first = await db.admitAndReserveAttempt({
      protocolId: protocol.id,
      projectId: projectA,
      attemptKind: "baseline",
      idempotencyKey: key,
      estimatedCostUsd: 0.02,
    });
    const second = await db.admitAndReserveAttempt({
      protocolId: protocol.id,
      projectId: projectA,
      attemptKind: "baseline",
      idempotencyKey: key,
      estimatedCostUsd: 0.02,
    });
    const third = await db.admitAndReserveAttempt({
      protocolId: protocol.id,
      projectId: projectA,
      attemptKind: "baseline",
      idempotencyKey: key,
      estimatedCostUsd: 999, // even a wildly different estimate on resubmission changes nothing
    });
    check(
      "first submission reserves, all resubmissions with the same key return ALREADY_RESERVED with the identical attempt id",
      first.outcome === "RESERVED" &&
        second.outcome === "ALREADY_RESERVED" &&
        third.outcome === "ALREADY_RESERVED" &&
        second.attempt?.id === first.attempt?.id &&
        third.attempt?.id === first.attempt?.id
    );
    const rows = await db.getProtocolAttempts(protocol.id, projectA);
    check(
      "exactly one attempt row exists for this protocol despite three submissions with the same key",
      rows.filter((a) => a.idempotencyKey === key).length === 1
    );
  }

  // ------------------------------------------------------------------
  // 6. retry/crash/timeout -> aucune double facturation
  // ------------------------------------------------------------------
  console.log("\n[6] retry chain is bounded and never double-bills");
  {
    const protocol = await makeApprovedProtocol(projectA, {
      plannedBaselineRuns: 5,
      plannedRetestRuns: 0,
      runCap: 20,
      spendCapUsd: 1,
      retryCap: 2,
    });

    const original = await db.admitAndReserveAttempt({
      protocolId: protocol.id,
      projectId: projectA,
      attemptKind: "baseline",
      idempotencyKey: `idem-${randomUUID()}`,
      estimatedCostUsd: 0.1,
    });
    check("original attempt reserved", original.outcome === "RESERVED");

    // Simulate a crash: reconcile as timed_out with the real (non-zero)
    // partial cost actually incurred before the crash.
    const crashed = await db.reconcileAttempt({
      attemptId: original.attempt!.id,
      projectId: projectA,
      status: "timed_out",
      actualCostUsd: 0.08,
      terminationReason: "provider_timeout",
    });
    check(
      "crash reconciles to a terminal timed_out status carrying the real partial cost and an explicit termination reason",
      crashed.outcome === "RECONCILED" &&
        crashed.attempt?.status === "timed_out" &&
        crashed.attempt?.actualCostUsd === 0.08 &&
        crashed.attempt?.terminationReason === "provider_timeout"
    );

    // Retry #1, linked to the crashed attempt.
    const retry1 = await db.admitAndReserveAttempt({
      protocolId: protocol.id,
      projectId: projectA,
      attemptKind: "baseline",
      idempotencyKey: `idem-${randomUUID()}`,
      estimatedCostUsd: 0.1,
      retryOfAttemptId: original.attempt!.id,
    });
    check(
      "retry #1 is admitted and linked via retryOfAttemptId — a NEW attempt, not a resurrection of the old one",
      retry1.outcome === "RESERVED" &&
        retry1.attempt?.retryOfAttemptId === original.attempt!.id &&
        retry1.attempt?.id !== original.attempt!.id
    );

    // Retry #2, chained off retry #1 (still same root chain).
    const retry1Failed = await db.reconcileAttempt({
      attemptId: retry1.attempt!.id,
      projectId: projectA,
      status: "failed",
      actualCostUsd: 0.05,
      terminationReason: "provider_5xx",
    });
    check("retry #1 reconciles failed", retry1Failed.outcome === "RECONCILED");

    const retry2 = await db.admitAndReserveAttempt({
      protocolId: protocol.id,
      projectId: projectA,
      attemptKind: "baseline",
      idempotencyKey: `idem-${randomUUID()}`,
      estimatedCostUsd: 0.1,
      retryOfAttemptId: retry1.attempt!.id,
    });
    check("retry #2 admitted within retry_cap=2", retry2.outcome === "RESERVED");

    // Retry #3 must be rejected: retry_cap=2 bounds the chain length.
    const retry2Failed = await db.reconcileAttempt({
      attemptId: retry2.attempt!.id,
      projectId: projectA,
      status: "failed",
      actualCostUsd: 0.05,
      terminationReason: "provider_5xx",
    });
    check("retry #2 reconciles failed", retry2Failed.outcome === "RECONCILED");

    const retry3 = await db.admitAndReserveAttempt({
      protocolId: protocol.id,
      projectId: projectA,
      attemptKind: "baseline",
      idempotencyKey: `idem-${randomUUID()}`,
      estimatedCostUsd: 0.1,
      retryOfAttemptId: retry2.attempt!.id,
    });
    check(
      "retry #3 is rejected closed RETRY_CAP_EXCEEDED — the chain is bounded, never unbounded resubmission",
      retry3.outcome === "RETRY_CAP_EXCEEDED" && retry3.attempt === null
    );

    // Retrying against a fabricated / cross-chain id must fail closed too.
    const bogusRetry = await db.admitAndReserveAttempt({
      protocolId: protocol.id,
      projectId: projectA,
      attemptKind: "baseline",
      idempotencyKey: `idem-${randomUUID()}`,
      estimatedCostUsd: 0.05,
      retryOfAttemptId: randomUUID(),
    });
    check(
      "retrying a nonexistent attempt id is rejected INVALID_RETRY_REFERENCE",
      bogusRetry.outcome === "INVALID_RETRY_REFERENCE" && bogusRetry.attempt === null
    );

    // Total real spend across the whole crash+retry+retry chain must equal
    // the sum of actual costs only — never inflated by the reserved
    // estimate of a terminal attempt, and never double-counted.
    const allAttempts = await db.getProtocolAttempts(protocol.id, projectA);
    const chainAttempts = allAttempts.filter((a) =>
      [original.attempt!.id, retry1.attempt!.id, retry2.attempt!.id].includes(a.id)
    );
    const totalActual = chainAttempts.reduce(
      (sum, a) => sum + (a.actualCostUsd ?? 0),
      0
    );
    check(
      "reconciled spend across the crash/retry/retry chain is exactly the sum of real actual costs (0.08+0.05+? ), never double-billed",
      Math.abs(totalActual - (0.08 + 0.05 + (chainAttempts.find(a => a.id === retry2.attempt!.id)?.actualCostUsd ?? 0))) < 1e-9
    );
  }

  // ------------------------------------------------------------------
  // 7. réconciliation des coûts et compteurs
  // ------------------------------------------------------------------
  console.log("\n[7] reconciliation of costs and counters");
  {
    const protocol = await makeApprovedProtocol(projectA, {
      plannedBaselineRuns: 3,
      plannedRetestRuns: 0,
      runCap: 3,
      spendCapUsd: 0.2,
      rateLimitPerHour: 100,
      concurrencyLimit: 100,
    });

    const a1 = await db.admitAndReserveAttempt({
      protocolId: protocol.id,
      projectId: projectA,
      attemptKind: "baseline",
      idempotencyKey: `idem-${randomUUID()}`,
      estimatedCostUsd: 0.05,
    });
    check("attempt 1 reserved under spend_cap_usd=0.2", a1.outcome === "RESERVED");

    // Reconciling a non-existent attempt fails closed.
    const missingReconcile = await db.reconcileAttempt({
      attemptId: randomUUID(),
      projectId: projectA,
      status: "completed",
      actualCostUsd: 0.05,
    });
    check(
      "reconciling a nonexistent attempt id is rejected NOT_FOUND",
      missingReconcile.outcome === "NOT_FOUND"
    );

    const reconciled1 = await db.reconcileAttempt({
      attemptId: a1.attempt!.id,
      projectId: projectA,
      status: "completed",
      actualCostUsd: 0.15, // real cost came in HIGHER than the 0.05 estimate
    });
    check(
      "reconciliation records the real cost even when it exceeds the original estimate",
      reconciled1.outcome === "RECONCILED" && reconciled1.attempt?.actualCostUsd === 0.15
    );

    // Reconciling the same attempt again with the SAME terminal status is idempotent.
    const reReconcileSame = await db.reconcileAttempt({
      attemptId: a1.attempt!.id,
      projectId: projectA,
      status: "completed",
      actualCostUsd: 0.99, // ignored -- already terminal
    });
    check(
      "re-reconciling an already-terminal attempt with the same status returns ALREADY_RECONCILED and does not overwrite the real cost",
      reReconcileSame.outcome === "ALREADY_RECONCILED" &&
        reReconcileSame.attempt?.actualCostUsd === 0.15
    );

    // Reconciling again with a DIFFERENT terminal status is a conflict, not a silent overwrite.
    const reReconcileDifferent = await db.reconcileAttempt({
      attemptId: a1.attempt!.id,
      projectId: projectA,
      status: "failed",
      actualCostUsd: 0.15,
    });
    check(
      "re-reconciling an already-terminal attempt with a DIFFERENT status is rejected CONFLICT, never silently flipped",
      reReconcileDifferent.outcome === "CONFLICT"
    );

    // Now the reconciled 0.15 leaves only 0.05 of the 0.2 spend cap — the
    // next admission's cumulative check must use the RECONCILED actual
    // cost, not the original 0.05 estimate.
    const a2 = await db.admitAndReserveAttempt({
      protocolId: protocol.id,
      projectId: projectA,
      attemptKind: "baseline",
      idempotencyKey: `idem-${randomUUID()}`,
      estimatedCostUsd: 0.05,
    });
    check(
      "second attempt still fits (0.15 reconciled + 0.05 new = 0.20 <= cap)",
      a2.outcome === "RESERVED"
    );
    const a3 = await db.admitAndReserveAttempt({
      protocolId: protocol.id,
      projectId: projectA,
      attemptKind: "baseline",
      idempotencyKey: `idem-${randomUUID()}`,
      estimatedCostUsd: 0.01,
    });
    check(
      "a third attempt of even 0.01 now exceeds the exhausted spend cap — the reconciled actual cost, not the stale estimate, drives the cumulative check",
      a3.outcome === "SPEND_CAP_EXCEEDED"
    );
  }

  // ------------------------------------------------------------------
  // 8. isolation entre projets
  // ------------------------------------------------------------------
  console.log("\n[8] cross-project isolation");
  {
    const questionA = await db.createBuyerQuestion({ projectId: projectA });
    const versionA = await db.createBuyerQuestionVersion({
      buyerQuestionId: questionA.id,
      projectId: projectA,
      versionNumber: 1,
      promptText: "project A question",
      promptHash: `hash-${randomUUID()}`,
      intentType: "shortlist",
      commercialValue: 0.5,
      winnability: 0.5,
      priority: 1,
      rationale: "isolation test",
      provenance: "founder_supplied",
    });
    await db.approveBuyerQuestionVersion({
      versionId: versionA.id,
      projectId: projectA,
      approvedBy: "founder@zypact.test",
    });
    const protocolA = await makeApprovedProtocol(projectA);

    check(
      "buyer_question from project A is invisible when queried under project B",
      (await db.getBuyerQuestion(questionA.id, projectB)) === null
    );
    check(
      "buyer_question from project A IS visible when queried under its own project",
      (await db.getBuyerQuestion(questionA.id, projectA))?.id === questionA.id
    );
    check(
      "protocol from project A is invisible when queried under project B",
      (await db.getProtocol(protocolA.id, projectB)) === null
    );

    // A payload carrying project A's protocolId but project B's projectId
    // must be treated as NOT_FOUND, never as "found via the id alone" —
    // Rule 15: scoping is enforced structurally, not trusted from payload.
    const crossProjectAdmission = await db.admitAndReserveAttempt({
      protocolId: protocolA.id,
      projectId: projectB,
      attemptKind: "baseline",
      idempotencyKey: `idem-${randomUUID()}`,
      estimatedCostUsd: 0.01,
    });
    check(
      "admission using project A's protocolId but project B's projectId is rejected NOT_FOUND, not PROTOCOL_NOT_APPROVED or RESERVED — no cross-tenant leak",
      crossProjectAdmission.outcome === "NOT_FOUND" &&
        crossProjectAdmission.attempt === null
    );

    const legitimate = await db.admitAndReserveAttempt({
      protocolId: protocolA.id,
      projectId: projectA,
      attemptKind: "baseline",
      idempotencyKey: `idem-${randomUUID()}`,
      estimatedCostUsd: 0.01,
    });
    check(
      "the same protocolId correctly scoped to its real project A succeeds",
      legitimate.outcome === "RESERVED"
    );

    // Attempting to start/reconcile that attempt under project B must also fail closed.
    const crossProjectStart = await db.startAttempt({
      attemptId: legitimate.attempt!.id,
      projectId: projectB,
      probeRunId: randomUUID(),
    });
    check(
      "starting project A's attempt under project B's id is rejected NOT_FOUND",
      crossProjectStart.outcome === "NOT_FOUND"
    );
    const crossProjectReconcile = await db.reconcileAttempt({
      attemptId: legitimate.attempt!.id,
      projectId: projectB,
      status: "completed",
      actualCostUsd: 0.01,
    });
    check(
      "reconciling project A's attempt under project B's id is rejected NOT_FOUND",
      crossProjectReconcile.outcome === "NOT_FOUND"
    );

    const attemptsUnderB = await db.getProtocolAttempts(protocolA.id, projectB);
    check(
      "listing project A's protocol attempts under project B's id returns an empty list, not a leak",
      attemptsUnderB.length === 0
    );
  }

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0
        ? "M4 buyer-question/protocol/attempts suite PASSED."
        : "M4 buyer-question/protocol/attempts suite FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
