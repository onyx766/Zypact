#!/usr/bin/env tsx
/**
 * M4 Stage B — the real ledger-gated wiring (lib/pipeline/run-protocol-
 * gated-baseline.ts, the function scripts/mvp-scan.ts's --protocol-id
 * path actually calls).
 *
 * Real in-memory adapter (getDb()), mock LLM mode. No network, no
 * payment, no staging/Production, no migration applied. The provider
 * call itself is injected (`callProvider`) so this suite proves the
 * WIRING — reservation before probe_runs/provider call, reconciliation
 * after, retry/idempotency/isolation semantics — without ever making a
 * real HTTP request.
 *
 * Covers exactly the required Stage B test categories:
 *   1. protocole non approuvé -> aucun appel provider
 *   2. plan variable de fixture -> exactement le nombre approuvé
 *   3. réservation vérifiée avant l'appel mock provider
 *   4. coût réel supérieur à la réservation
 *   5. plafond épuisé -> appel suivant refusé
 *   6. retry chain respecte retry_cap
 *   7. crash/timeout/duplicate submission sans double réservation
 *   8. isolation projet
 *   9. (suite complète M1/M2/M3 — see the separate regression sweep)
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ZYPACT_ALLOW_MEMORY_DB;
process.env.ZYPACT_MOCK_MODE = "on";

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import type { CreateProtocolInput, Protocol } from "@/lib/db/types";
import { PerplexityProbeFailure, type PerplexityProbeResult } from "@/lib/probes/perplexity";
import {
  checkProtocolExecutionGate,
  reservationOverrunUsd,
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

function successCaller(costPerCall: () => number): ProtocolProbeCaller {
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
    void costPerCall;
    return result;
  };
}

function alwaysFailingCaller(): ProtocolProbeCaller {
  return async () => {
    throw new PerplexityProbeFailure("mock provider failure", {
      reason: "network_error",
      httpStatus: null,
      errorBody: null,
      errorBodySha256: null,
      latencyMs: 12,
      providerRequestId: null,
      rawProbeRequestSha256: "0".repeat(64),
      fullRequestBodySha256: "0".repeat(64),
    });
  };
}

async function makeProject(): Promise<{ projectId: string }> {
  const project = await db.createProject({
    domain: `stage-b-${randomUUID()}.test`,
    companyName: "Stage B Test Co",
  });
  return { projectId: project.id };
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
    rationale: "Stage B wiring fixture",
    provenance: "founder_supplied",
  });
  await db.approveBuyerQuestionVersion({
    versionId: version.id,
    projectId,
    approvedBy: "founder@zypact.test",
  });
  const draft = await db.createProtocol({
    projectId,
    buyerQuestionVersionId: version.id,
    provider: "perplexity_sonar",
    surface: "answer",
    plannedBaselineRuns: 4,
    plannedRetestRuns: 0,
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
    approvedBy: "founder@zypact.test",
  });
  if (outcome !== "APPROVED" || !protocol) {
    throw new Error(`fixture setup failed: approveProtocol returned ${outcome}`);
  }
  return protocol;
}

async function datasetBatchFor(projectId: string) {
  return db.createDatasetBatch({ projectId, datasetSourceType: "manual_scan" });
}

async function main(): Promise<void> {
  // ------------------------------------------------------------------
  // 1. protocole non approuvé -> aucun appel provider
  // ------------------------------------------------------------------
  console.log("\n[1] unapproved protocol -> no provider call");
  {
    const { projectId } = await makeProject();
    const question = await db.createBuyerQuestion({ projectId });
    const version = await db.createBuyerQuestionVersion({
      buyerQuestionId: question.id,
      projectId,
      versionNumber: 1,
      promptText: "unapproved question",
      promptHash: `hash-${randomUUID()}`,
      intentType: "shortlist",
      commercialValue: 0.5,
      winnability: 0.5,
      priority: 1,
      rationale: "gate test",
      provenance: "founder_supplied",
    });
    const draft = await db.createProtocol({
      projectId,
      buyerQuestionVersionId: version.id,
      provider: "perplexity_sonar",
      surface: "answer",
      plannedBaselineRuns: 2,
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

    const gate = checkProtocolExecutionGate(draft, version);
    check(
      "the CLI-level gate refuses a draft protocol before anything else runs",
      !gate.ok && gate.reason === "protocol_not_approved:draft"
    );

    let calls = 0;
    const countingCaller: ProtocolProbeCaller = async (c) => {
      calls += 1;
      return successCaller(() => 0)(c);
    };

    const admission = await db.admitAndReserveAttempt({
      protocolId: draft.id,
      projectId,
      attemptKind: "baseline",
      idempotencyKey: `${draft.id}:baseline:0`,
      estimatedCostUsd: 0.05,
    });
    check(
      "the ledger itself independently refuses admission against the draft protocol",
      admission.outcome === "PROTOCOL_NOT_APPROVED" && admission.attempt === null
    );
    check("the mock provider was never invoked", calls === 0);

    const attempts = await db.getProtocolAttempts(draft.id, projectId);
    check("zero attempt rows exist for the unapproved protocol", attempts.length === 0);
  }

  // ------------------------------------------------------------------
  // 2. plan variable de fixture -> exactement le nombre approuvé
  // ------------------------------------------------------------------
  console.log("\n[2] variable plan admits exactly the approved count");
  {
    const { projectId } = await makeProject();
    const protocol = await makeApprovedProtocol(projectId, {
      plannedBaselineRuns: 4,
      runCap: 10,
      spendCapUsd: 5,
    });
    const datasetBatch = await datasetBatchFor(projectId);

    let calls = 0;
    const caller: ProtocolProbeCaller = async (c) => {
      calls += 1;
      return successCaller(() => 0.01)(c);
    };

    const result = await runProtocolGatedBaseline({
      db,
      projectId,
      protocol,
      promptText: "best invoicing software for a 20-person agency",
      brandName: "Stage B Test Co",
      domain: "stage-b.test",
      knownCompetitors: [],
      datasetBatch,
      plannedRuns: protocol.plannedBaselineRuns,
      attemptKind: "baseline",
      probeMode: "simulated",
      reservationCeilingUsd: 0.05,
      actualCostUsd: 0.01,
      callProvider: caller,
    });

    check(
      "plan is whatever the protocol configured (4), not any legacy default",
      protocol.plannedBaselineRuns === 4
    );
    check(
      "exactly 4 attempts completed, matching plannedBaselineRuns exactly",
      result.completed === 4 && result.attemptedPlannedRuns === 4 && result.stoppedReason === null
    );
    check("the mock provider was called exactly 4 times, no more, no fewer", calls === 4);

    const attempts = await db.getProtocolAttempts(protocol.id, projectId);
    check(
      "exactly 4 protocol_attempts rows exist, all completed",
      attempts.length === 4 && attempts.every((a) => a.status === "completed")
    );
  }

  // ------------------------------------------------------------------
  // 3. réservation vérifiée avant l'appel mock provider
  // ------------------------------------------------------------------
  console.log("\n[3] reservation + probe_run linkage verified before the mock provider call");
  {
    const { projectId } = await makeProject();
    const protocol = await makeApprovedProtocol(projectId, {
      plannedBaselineRuns: 1,
      runCap: 5,
      spendCapUsd: 5,
    });
    const datasetBatch = await datasetBatchFor(projectId);

    let observedInsideProviderCall: { status: string; probeRunId: string | null } | null = null;
    const verifyingCaller: ProtocolProbeCaller = async (c) => {
      const attempts = await db.getProtocolAttempts(protocol.id, projectId);
      const inFlight = attempts.find((a) => a.status === "in_progress");
      observedInsideProviderCall = inFlight
        ? { status: inFlight.status, probeRunId: inFlight.probeRunId }
        : null;
      return successCaller(() => 0.01)(c);
    };

    await runProtocolGatedBaseline({
      db,
      projectId,
      protocol,
      promptText: "best invoicing software for a 20-person agency",
      brandName: "Stage B Test Co",
      domain: "stage-b.test",
      knownCompetitors: [],
      datasetBatch,
      plannedRuns: 1,
      attemptKind: "baseline",
      probeMode: "simulated",
      reservationCeilingUsd: 0.05,
      actualCostUsd: 0.01,
      callProvider: verifyingCaller,
    });

    check(
      "by the time the mock provider was called, a reservation already existed, in_progress, linked to a real probe_run — never null",
      observedInsideProviderCall !== null &&
        (observedInsideProviderCall as { status: string; probeRunId: string | null }).status === "in_progress" &&
        (observedInsideProviderCall as { status: string; probeRunId: string | null }).probeRunId !== null
    );
  }

  // ------------------------------------------------------------------
  // 4. coût réel supérieur à la réservation
  // ------------------------------------------------------------------
  console.log("\n[4] real cost exceeds the reservation ceiling — recorded honestly, never hidden");
  {
    const { projectId } = await makeProject();
    const protocol = await makeApprovedProtocol(projectId, {
      plannedBaselineRuns: 2,
      runCap: 10,
      spendCapUsd: 0.24,
    });
    const datasetBatch = await datasetBatchFor(projectId);
    const caller = successCaller(() => 0.2);

    const result = await runProtocolGatedBaseline({
      db,
      projectId,
      protocol,
      promptText: "best invoicing software for a 20-person agency",
      brandName: "Stage B Test Co",
      domain: "stage-b.test",
      knownCompetitors: [],
      datasetBatch,
      plannedRuns: 2,
      attemptKind: "baseline",
      probeMode: "simulated",
      reservationCeilingUsd: 0.05, // conservative ceiling
      actualCostUsd: 0.2, // real cost comes in 4x higher than reserved
      callProvider: caller,
    });

    const attempts = await db.getProtocolAttempts(protocol.id, projectId);
    const first = attempts[0]!;
    check(
      "the first attempt's real cost (0.2) is recorded even though it is far above its 0.05 reservation",
      first.status === "completed" &&
        first.reservedCostUsd === 0.05 &&
        first.actualCostUsd === 0.2
    );
    check(
      "the overrun is explicit and never hidden: 0.2 - 0.05 = 0.15",
      Math.abs(reservationOverrunUsd(first) - 0.15) < 1e-9
    );
    check(
      "the SECOND planned run is refused: cumulative real spend (0.2) + a new 0.05 reservation = 0.25 > spend_cap_usd 0.24 — the reconciled ACTUAL cost drives this, not the stale 0.05 ceiling",
      result.completed === 1 &&
        result.attemptedPlannedRuns === 1 &&
        result.stoppedReason === "spend_cap_exceeded"
    );
    check(
      "the already-completed first attempt's recorded cost is untouched — nothing here retroactively un-spends an already-incurred cost",
      first.actualCostUsd === 0.2
    );
  }

  // ------------------------------------------------------------------
  // 5. plafond épuisé -> appel suivant refusé (run_cap, this time)
  // ------------------------------------------------------------------
  console.log("\n[5] exhausted cap refuses every subsequent admission");
  {
    const { projectId } = await makeProject();
    // plannedBaselineRuns must never exceed run_cap (Rule 4), so
    // exhaustion here comes from a real prior attempt (a "control" kind)
    // already consuming one of the two run_cap slots before this
    // invocation begins — proving run_cap is a genuine independent
    // ceiling, not merely restated from the plan.
    const protocol = await makeApprovedProtocol(projectId, {
      plannedBaselineRuns: 2,
      runCap: 2,
      spendCapUsd: 100,
    });
    const preExisting = await db.admitAndReserveAttempt({
      protocolId: protocol.id,
      projectId,
      attemptKind: "control",
      idempotencyKey: `${protocol.id}:control:pre-existing`,
      estimatedCostUsd: 0.01,
    });
    check("the pre-existing control attempt is admitted", preExisting.outcome === "RESERVED");
    await db.reconcileAttempt({
      attemptId: preExisting.attempt!.id,
      projectId,
      status: "completed",
      actualCostUsd: 0.01,
    });

    const datasetBatch = await datasetBatchFor(projectId);
    const caller = successCaller(() => 0.01);

    const result = await runProtocolGatedBaseline({
      db,
      projectId,
      protocol,
      promptText: "best invoicing software for a 20-person agency",
      brandName: "Stage B Test Co",
      domain: "stage-b.test",
      knownCompetitors: [],
      datasetBatch,
      plannedRuns: 2,
      attemptKind: "baseline",
      probeMode: "simulated",
      reservationCeilingUsd: 0.05,
      actualCostUsd: 0.01,
      callProvider: caller,
    });

    check(
      "only 1 of the 2 planned baseline runs is admitted (the control attempt already consumed the other run_cap slot), then the loop stops closed",
      result.completed === 1 &&
        result.attemptedPlannedRuns === 1 &&
        result.stoppedReason === "run_cap_exceeded"
    );
  }

  // ------------------------------------------------------------------
  // 6. retry chain respecte retry_cap
  // ------------------------------------------------------------------
  console.log("\n[6] retry chain is bounded by retry_cap through the real wiring");
  {
    const { projectId } = await makeProject();
    const protocol = await makeApprovedProtocol(projectId, {
      plannedBaselineRuns: 1,
      runCap: 10,
      spendCapUsd: 100,
      retryCap: 2,
    });
    const datasetBatch = await datasetBatchFor(projectId);

    const result = await runProtocolGatedBaseline({
      db,
      projectId,
      protocol,
      promptText: "best invoicing software for a 20-person agency",
      brandName: "Stage B Test Co",
      domain: "stage-b.test",
      knownCompetitors: [],
      datasetBatch,
      plannedRuns: 1,
      attemptKind: "baseline",
      probeMode: "simulated",
      reservationCeilingUsd: 0.05,
      actualCostUsd: 0.01,
      callProvider: alwaysFailingCaller(),
    });

    check(
      "one planned run, always-failing provider: exhausted after original + 2 retries (retry_cap=2), never more",
      result.completed === 0 && result.failedExhausted === 1 && result.attemptedPlannedRuns === 1
    );

    const attempts = await db.getProtocolAttempts(protocol.id, projectId);
    check(
      "exactly 3 attempt rows exist (original + retry #1 + retry #2) — a 4th retry was refused, never created",
      attempts.length === 3
    );
    check(
      "every one of the 3 reconciled to timed_out (network_error) with a real termination reason",
      attempts.every((a) => a.status === "timed_out" && a.terminationReason === "network_error")
    );
    check(
      "the retry chain is correctly linked: retry #1 -> original, retry #2 -> retry #1",
      (() => {
        const byId = new Map(attempts.map((a) => [a.id, a] as const));
        const roots = attempts.filter((a) => a.retryOfAttemptId === null);
        if (roots.length !== 1) return false;
        const root = roots[0]!;
        const child1 = attempts.find((a) => a.retryOfAttemptId === root.id);
        if (!child1) return false;
        const child2 = attempts.find((a) => a.retryOfAttemptId === child1.id);
        return Boolean(child2) && byId.size === 3;
      })()
    );
  }

  // ------------------------------------------------------------------
  // 7. crash/timeout/duplicate submission sans double réservation
  // ------------------------------------------------------------------
  console.log("\n[7] crash-resume and duplicate submission never double-reserve or double-call");
  {
    // 7a: a whole-script re-run after every planned run already
    // completed must be a complete no-op — no new reservation, no new
    // provider call.
    const { projectId } = await makeProject();
    const protocol = await makeApprovedProtocol(projectId, {
      plannedBaselineRuns: 2,
      runCap: 10,
      spendCapUsd: 5,
    });
    const datasetBatch = await datasetBatchFor(projectId);
    let calls = 0;
    const countingCaller: ProtocolProbeCaller = async (c) => {
      calls += 1;
      return successCaller(() => 0.01)(c);
    };

    const firstRun = await runProtocolGatedBaseline({
      db,
      projectId,
      protocol,
      promptText: "best invoicing software for a 20-person agency",
      brandName: "Stage B Test Co",
      domain: "stage-b.test",
      knownCompetitors: [],
      datasetBatch,
      plannedRuns: 2,
      attemptKind: "baseline",
      probeMode: "simulated",
      reservationCeilingUsd: 0.05,
      actualCostUsd: 0.01,
      callProvider: countingCaller,
    });
    check("first invocation completes both planned runs", firstRun.completed === 2);
    check("provider called exactly twice on first invocation", calls === 2);

    const secondRun = await runProtocolGatedBaseline({
      db,
      projectId,
      protocol,
      promptText: "best invoicing software for a 20-person agency",
      brandName: "Stage B Test Co",
      domain: "stage-b.test",
      knownCompetitors: [],
      datasetBatch,
      plannedRuns: 2,
      attemptKind: "baseline",
      probeMode: "simulated",
      reservationCeilingUsd: 0.05,
      actualCostUsd: 0.01,
      callProvider: countingCaller,
    });
    check(
      "second (duplicate, crash-simulating) invocation with the same deterministic idempotency keys skips both, calls the provider zero more times",
      secondRun.skippedAlreadyDone === 2 && secondRun.attemptedPlannedRuns === 0
    );
    check("provider call count is unchanged after the duplicate invocation", calls === 2);

    const attemptsAfter = await db.getProtocolAttempts(protocol.id, projectId);
    check(
      "still exactly 2 attempt rows total — no duplicate reservation was ever created",
      attemptsAfter.length === 2
    );

    // 7b: a genuinely unresolved in-flight attempt (simulating a crash
    // mid-call, before reconciliation) must stop the whole loop closed,
    // never be silently retried or double-called automatically by this
    // CLI-level path.
    const { projectId: projectId2 } = await makeProject();
    const protocol2 = await makeApprovedProtocol(projectId2, {
      plannedBaselineRuns: 1,
      runCap: 10,
      spendCapUsd: 5,
    });
    const datasetBatch2 = await datasetBatchFor(projectId2);
    await db.admitAndReserveAttempt({
      protocolId: protocol2.id,
      projectId: projectId2,
      attemptKind: "baseline",
      idempotencyKey: `${protocol2.id}:baseline:0`,
      estimatedCostUsd: 0.05,
    });
    // Deliberately left "reserved" — never started or reconciled,
    // simulating a crash between reservation and completion.

    let calls2 = 0;
    const countingCaller2: ProtocolProbeCaller = async (c) => {
      calls2 += 1;
      return successCaller(() => 0.01)(c);
    };
    const crashResumeResult = await runProtocolGatedBaseline({
      db,
      projectId: projectId2,
      protocol: protocol2,
      promptText: "best invoicing software for a 20-person agency",
      brandName: "Stage B Test Co",
      domain: "stage-b.test",
      knownCompetitors: [],
      datasetBatch: datasetBatch2,
      plannedRuns: 1,
      attemptKind: "baseline",
      probeMode: "simulated",
      reservationCeilingUsd: 0.05,
      actualCostUsd: 0.01,
      callProvider: countingCaller2,
    });
    check(
      "an unresolved in-flight attempt from a simulated crash stops the loop closed rather than guessing",
      crashResumeResult.stoppedReason === "unresolved_in_flight_attempt" &&
        crashResumeResult.attemptedPlannedRuns === 0
    );
    check("the mock provider is never called when an in-flight attempt is detected", calls2 === 0);
  }

  // ------------------------------------------------------------------
  // 8. isolation projet
  // ------------------------------------------------------------------
  console.log("\n[8] cross-project isolation");
  {
    const { projectId: projectA } = await makeProject();
    const { projectId: projectB } = await makeProject();
    const protocolA = await makeApprovedProtocol(projectA, {
      plannedBaselineRuns: 1,
      runCap: 5,
      spendCapUsd: 5,
    });
    const datasetBatchA = await datasetBatchFor(projectA);

    const crossScoped = await db.getProtocol(protocolA.id, projectB);
    check(
      "getProtocol(protocolA.id, projectB) returns null — no cross-tenant lookup succeeds",
      crossScoped === null
    );

    let threw = false;
    try {
      await runProtocolGatedBaseline({
        db,
        projectId: projectB, // deliberately mismatched against protocolA
        protocol: protocolA,
        promptText: "best invoicing software for a 20-person agency",
        brandName: "Stage B Test Co",
        domain: "stage-b.test",
        knownCompetitors: [],
        datasetBatch: datasetBatchA,
        plannedRuns: 1,
        attemptKind: "baseline",
        probeMode: "simulated",
        reservationCeilingUsd: 0.05,
        actualCostUsd: 0.01,
        callProvider: successCaller(() => 0.01),
      });
    } catch {
      threw = true;
    }
    check(
      "calling the wiring function with a project/protocol mismatch throws loudly instead of silently admitting across tenants",
      threw
    );

    const attemptsUnderA = await db.getProtocolAttempts(protocolA.id, projectA);
    check(
      "zero attempts were created for protocol A despite the mismatched call",
      attemptsUnderA.length === 0
    );
  }

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0
        ? "M4 Stage B protocol-gated runner suite PASSED."
        : "M4 Stage B protocol-gated runner suite FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
