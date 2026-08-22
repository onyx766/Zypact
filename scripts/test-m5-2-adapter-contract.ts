#!/usr/bin/env tsx
/**
 * M5-2 Stage A — adapter contract test (D-020/D-021/D-022/D-023).
 *
 * No Docker, no real Supabase, no network, no worker, no CLI. The
 * MemoryAdapter is exercised directly against its own in-process store;
 * the SupabaseAdapter is exercised against a stub client injected through
 * its existing test seam (`__setSupabaseAdapterClientForTests`, the same
 * pattern already used by scripts/test-snapshot-adapter-rpc-writes.ts) —
 * this proves RPC name/parameter mapping and row-shape translation without
 * ever opening a real connection.
 *
 * This is NOT a substitute for a real disposable-Postgres runtime test
 * (precedent: scripts/test-m5-0051-runtime-contract.ts). It cannot prove
 * FOR UPDATE locking, real concurrency, or genuine constraint enforcement
 * — only that both adapters expose the same canonical contract and that
 * the Supabase adapter calls exactly the RPCs D-023 names as canonical,
 * with exactly the right argument names, and never touches an M5 table
 * directly.
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ZYPACT_ALLOW_MEMORY_DB;

import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  AttemptKind,
  CreateProtocolInput,
  DbAdapter,
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

function must<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`fixture setup failed: ${label} was null/undefined`);
  }
  return value;
}

const PROTOCOL_FIXTURE: Omit<CreateProtocolInput, "projectId" | "buyerQuestionVersionId"> = {
  provider: "perplexity",
  surface: "sonar",
  plannedBaselineRuns: 1,
  plannedRetestRuns: 0,
  unitOfAnalysis: "run",
  primaryMetric: "listed_in_run",
  samplePlanningMethod: "fixed",
  runCap: 20,
  spendCapUsd: 100,
  timeWindowSeconds: 3600,
  rateLimitPerHour: 100,
  concurrencyLimit: 5,
  retryCap: 2,
};

async function main(): Promise<void> {
  const { memoryAdapter } = await import("@/lib/db/memory-adapter");

  // ========================================================================
  // Part A — Static checks (no adapter calls, no network).
  // ========================================================================
  console.log("\n[A] static contract checks");

  const supabaseSrc = readFileSync(
    path.join(process.cwd(), "lib", "db", "supabase-adapter.ts"),
    "utf8"
  );
  const memorySrc = readFileSync(
    path.join(process.cwd(), "lib", "db", "memory-adapter.ts"),
    "utf8"
  );
  const typesSrc = readFileSync(path.join(process.cwd(), "lib", "db", "types.ts"), "utf8");

  check(
    "no direct DML (.from(...)) against any M5 table in the Supabase adapter",
    !/\.from\(\s*["'](protocol_execution_jobs|protocol_external_calls|provider_call_receipts|analysis_call_receipts|protocol_operator_actions)["']/.test(
      supabaseSrc
    )
  );
  check(
    // A bare textual mention (e.g. types.ts's own M4 header note naming
    // lib/snapshot-worker/execution-options.ts as something NOT to reuse)
    // is not a coupling; an actual import statement would be.
    "no import statement referencing lib/snapshot-worker in types.ts, memory-adapter.ts, or supabase-adapter.ts",
    !/from\s+["'][^"']*snapshot-worker/.test(typesSrc) &&
      !/from\s+["'][^"']*snapshot-worker/.test(memorySrc) &&
      !/from\s+["'][^"']*snapshot-worker/.test(supabaseSrc) &&
      !/require\(["'][^"']*snapshot-worker/.test(typesSrc) &&
      !/require\(["'][^"']*snapshot-worker/.test(memorySrc) &&
      !/require\(["'][^"']*snapshot-worker/.test(supabaseSrc)
  );
  check(
    "no reference to a 0052 migration anywhere in these three files",
    !/0052/.test(typesSrc) && !/0052/.test(memorySrc) && !/0052/.test(supabaseSrc)
  );
  check(
    "start_attempt_for_job is not exposed as a DbAdapter method name and not called by either adapter",
    !/\bstartAttemptForJob\b/.test(typesSrc) &&
      !/\bstartAttemptForJob\b/.test(memorySrc) &&
      !/\bstartAttemptForJob\b/.test(supabaseSrc) &&
      !/"start_attempt_for_job"/.test(supabaseSrc)
  );
  check(
    "reserve_additional_analysis_generation_for_job is not exposed as a DbAdapter method name and not called by either adapter",
    !/\breserveAdditionalAnalysisGenerationForJob\b/.test(typesSrc) &&
      !/\breserveAdditionalAnalysisGenerationForJob\b/.test(memorySrc) &&
      !/\breserveAdditionalAnalysisGenerationForJob\b/.test(supabaseSrc) &&
      !/"reserve_additional_analysis_generation_for_job"/.test(supabaseSrc)
  );
  check(
    "every canonical M5 RPC name appears exactly once as a Supabase .rpc(...) call site",
    [
      "enqueue_protocol_execution_job",
      "claim_protocol_execution_job",
      "renew_protocol_execution_job_lease",
      "admit_and_reserve_attempt_for_job",
      "create_probe_run_and_start_attempt_for_job",
      "mark_external_call_sent_for_job",
      "record_provider_call_receipt_for_job",
      "record_analysis_call_receipt_for_job",
      "reconcile_attempt_for_job",
      "complete_protocol_execution_job",
      "fail_protocol_execution_job",
      "reactivate_abandoned_job",
      "retry_full_attempt_for_job",
      "retry_analysis_generation_for_job",
      "authorize_operator_retry",
      "get_protocol_execution_job_context",
      "mark_protocol_execution_job_needs_review_for_ambiguity",
    ].every((rpc) => (supabaseSrc.match(new RegExp(`"${rpc}"`, "g")) ?? []).length === 1)
  );
  check(
    "M4 raw adapter methods (admitAndReserveAttempt/startAttempt/reconcileAttempt) still call the original M4 RPC names, unchanged",
    /"admit_and_reserve_attempt"/.test(supabaseSrc) &&
      /"start_attempt"/.test(supabaseSrc) &&
      /"reconcile_attempt"/.test(supabaseSrc) &&
      !/"admit_and_reserve_attempt_for_job"[\s\S]*"admit_and_reserve_attempt"/.test("")
  );

  // ========================================================================
  // Part B — MemoryAdapter, full sequential lifecycle.
  // ========================================================================
  console.log("\n[B] MemoryAdapter — full lifecycle");

  const db: DbAdapter = memoryAdapter;

  const project = await db.createProject({ domain: "example-b.test" });
  const question = await db.createBuyerQuestion({ projectId: project.id });
  const version = await db.createBuyerQuestionVersion({
    buyerQuestionId: question.id,
    projectId: project.id,
    versionNumber: 1,
    promptText: "Who are the best vendors for X?",
    promptHash: "a".repeat(64),
    intentType: "comparison",
    commercialValue: 3,
    winnability: 3,
    priority: 10,
    rationale: "fixture",
    provenance: "founder_supplied",
  });
  await db.approveBuyerQuestionVersion({
    versionId: version.id,
    projectId: project.id,
    approvedBy: "11111111-1111-4111-8111-111111111111",
  });
  const protocol = await db.createProtocol({
    ...PROTOCOL_FIXTURE,
    projectId: project.id,
    buyerQuestionVersionId: version.id,
  });
  await db.approveProtocol({
    protocolId: protocol.id,
    projectId: project.id,
    approvedBy: "11111111-1111-4111-8111-111111111111",
  });

  // -- enqueue + replay ------------------------------------------------
  const enqueue1 = await db.enqueueProtocolExecutionJob({
    protocolId: protocol.id,
    projectId: project.id,
  });
  check("enqueue: fresh protocol -> QUEUED", enqueue1.outcome === "QUEUED" && enqueue1.job !== null);
  const enqueue2 = await db.enqueueProtocolExecutionJob({
    protocolId: protocol.id,
    projectId: project.id,
  });
  check(
    "enqueue: replay on the same protocol -> ALREADY_EXISTS, same job id, no second row",
    enqueue2.outcome === "ALREADY_EXISTS" && enqueue2.job?.id === enqueue1.job?.id
  );

  const jobId = must(enqueue1.job, "enqueued job").id;

  // -- claim/renew/fencing ----------------------------------------------
  const claim1 = await db.claimProtocolExecutionJob({ workerId: "worker-1", leaseSeconds: 300 });
  check(
    "claim: a queued job is claimed, claimToken issued",
    claim1.outcome === "CLAIMED" && claim1.job?.id === jobId && !!claim1.claimToken
  );
  const claimNone = await db.claimProtocolExecutionJob({ workerId: "worker-2", leaseSeconds: 300 });
  check("claim: nothing left to claim -> NO_JOB_AVAILABLE", claimNone.outcome === "NO_JOB_AVAILABLE");

  const claimToken = must(claim1.claimToken, "claim token");
  const renewWrong = await db.renewProtocolExecutionJobLease({
    jobId,
    claimToken: "00000000-0000-4000-8000-000000000000",
    projectId: project.id,
    leaseSeconds: 300,
  });
  check("renew: wrong claim token -> JOB_NOT_OWNED, never renews", renewWrong.outcome === "JOB_NOT_OWNED");
  const renewOk = await db.renewProtocolExecutionJobLease({
    jobId,
    claimToken,
    projectId: project.id,
    leaseSeconds: 300,
  });
  check("renew: correct claim token -> RENEWED", renewOk.outcome === "RENEWED");

  // -- admission + RESUME_CURRENT_ATTEMPT --------------------------------
  const admit1 = await db.admitAndReserveAttemptForJob({
    jobId,
    claimToken,
    projectId: project.id,
    attemptKind: "baseline" as AttemptKind,
    idempotencyKey: `${jobId}:baseline:1`,
    perplexityReservedCostUsd: 0.01,
    analysisReservedCostUsd: 0.01,
  });
  check(
    "admit: fresh job -> RESERVED, exactly one perplexity + one analysis generation-1 call",
    admit1.outcome === "RESERVED" &&
      admit1.attempt !== null &&
      admit1.perplexityCall?.callKind === "perplexity" &&
      admit1.perplexityCall?.generation === 1 &&
      admit1.analysisCall?.callKind === "analysis" &&
      admit1.analysisCall?.generation === 1
  );
  const attemptId = must(admit1.attempt, "admitted attempt").id;

  const admit2 = await db.admitAndReserveAttemptForJob({
    jobId,
    claimToken,
    projectId: project.id,
    attemptKind: "baseline" as AttemptKind,
    idempotencyKey: `${jobId}:a-totally-different-key`,
    perplexityReservedCostUsd: 0.01,
    analysisReservedCostUsd: 0.01,
  });
  check(
    "admit: current_attempt_id already set -> RESUME_CURRENT_ATTEMPT, same attempt, no second row",
    admit2.outcome === "RESUME_CURRENT_ATTEMPT" && admit2.attempt?.id === attemptId
  );

  // -- atomic start + replay ---------------------------------------------
  const start1 = await db.createProbeRunAndStartAttemptForJob({
    jobId,
    claimToken,
    projectId: project.id,
    attemptId,
    platform: "perplexity",
    probeMode: "simulated",
    datasetId: "44444444-4444-4444-8444-444444444444",
    datasetSourceType: "manual_scan",
  });
  check(
    "start: reserved attempt -> STARTED, probe run created and attached atomically",
    start1.outcome === "STARTED" && start1.attempt?.probeRunId === start1.probeRun?.id
  );
  const probeRunId = must(start1.probeRun, "started probe run").id;
  const start2 = await db.createProbeRunAndStartAttemptForJob({
    jobId,
    claimToken,
    projectId: project.id,
    attemptId,
    platform: "perplexity",
    probeMode: "simulated",
    datasetId: "44444444-4444-4444-8444-444444444444",
    datasetSourceType: "manual_scan",
  });
  check(
    "start: replay -> ALREADY_STARTED with the SAME probe run, never a second one",
    start2.outcome === "ALREADY_STARTED" && start2.probeRun?.id === probeRunId
  );

  // -- sent markers + receipts --------------------------------------------
  const perplexityCallId = must(admit1.perplexityCall, "perplexity call").id;
  const analysisCallId = must(admit1.analysisCall, "analysis call").id;

  const sentP = await db.markExternalCallSentForJob({
    jobId,
    claimToken,
    projectId: project.id,
    externalCallId: perplexityCallId,
    probeRunId,
  });
  check(
    "sent: perplexity call marked sent before any provider call",
    sentP.outcome === "SENT" && sentP.externalCall?.requestSentAt !== null
  );
  const receiptP = await db.recordProviderCallReceiptForJob({
    jobId,
    claimToken,
    projectId: project.id,
    externalCallId: perplexityCallId,
    probeRunId,
    outcome: "success",
    httpStatus: 200,
    providerRequestId: "req-abc",
    rawResponseSha256: "b".repeat(64),
    latencyMs: 500,
  });
  check(
    "receipt: perplexity success -> RECEIPTED, call completed, actualCostUsd left null (no real cost supplied) per D-023 §3",
    receiptP.outcome === "RECEIPTED" &&
      receiptP.externalCall?.status === "completed" &&
      receiptP.externalCall?.actualCostUsd === null &&
      receiptP.externalCall?.costBasis === null
  );

  const sentA = await db.markExternalCallSentForJob({
    jobId,
    claimToken,
    projectId: project.id,
    externalCallId: analysisCallId,
    probeRunId,
  });
  check("sent: analysis call marked sent", sentA.outcome === "SENT");
  const receiptA = await db.recordAnalysisCallReceiptForJob({
    jobId,
    claimToken,
    projectId: project.id,
    externalCallId: analysisCallId,
    probeRunId,
    outcome: "success",
    provider: "openai",
    model: "gpt-4o-mini",
    usedMock: false,
    requestSha256: "c".repeat(64),
    responseSha256: "d".repeat(64),
    latencyMs: 300,
  });
  check(
    "receipt: analysis success -> RECEIPTED, call completed",
    receiptA.outcome === "RECEIPTED" && receiptA.externalCall?.status === "completed"
  );

  // -- reconciliation + completion ----------------------------------------
  const reconciled = await db.reconcileAttemptForJob({
    jobId,
    claimToken,
    projectId: project.id,
    attemptId,
    status: "completed",
  });
  check(
    "reconcile: both calls terminal -> RECONCILED, attempt completed",
    reconciled.outcome === "RECONCILED" && reconciled.attempt?.status === "completed"
  );
  const completed = await db.completeProtocolExecutionJob({ jobId, claimToken, projectId: project.id });
  check(
    "complete: full D-020 gate satisfied -> SUCCEEDED",
    completed.outcome === "SUCCEEDED" && completed.job?.status === "succeeded"
  );
  const completedReplay = await db.completeProtocolExecutionJob({
    jobId,
    claimToken,
    projectId: project.id,
  });
  check(
    "complete: replay after success -> ALREADY_SUCCEEDED, checked before fencing (D-020)",
    completedReplay.outcome === "ALREADY_SUCCEEDED"
  );

  // ========================================================================
  // Part C — retry_full_attempt_for_job, separate fixture.
  // ========================================================================
  console.log("\n[C] MemoryAdapter — retry_full_attempt_for_job");

  const {
    jobId: fullRetryJobId,
    claimToken: fullRetryToken,
    projectId: fullRetryProjectId,
    attemptId: fullRetrySourceAttemptId,
  } = await buildFailedAttemptFixture(db, "full-retry");

  const retryFull1 = await db.retryFullAttemptForJob({
    jobId: fullRetryJobId,
    claimToken: fullRetryToken,
    projectId: fullRetryProjectId,
    sourceAttemptId: fullRetrySourceAttemptId,
    perplexityReservedCostUsd: 0.02,
    analysisReservedCostUsd: 0.02,
  });
  check(
    "retryFull: eligible terminal-failed source -> RESERVED, new attempt created",
    retryFull1.outcome === "RESERVED" && retryFull1.attempt !== null && retryFull1.attempt.id !== fullRetrySourceAttemptId
  );
  const retryFull2 = await db.retryFullAttemptForJob({
    jobId: fullRetryJobId,
    claimToken: fullRetryToken,
    projectId: fullRetryProjectId,
    sourceAttemptId: fullRetrySourceAttemptId,
    perplexityReservedCostUsd: 0.02,
    analysisReservedCostUsd: 0.02,
  });
  check(
    "retryFull: replay (same source, same costs) -> ALREADY_RETRIED, exact same child, no third attempt",
    retryFull2.outcome === "ALREADY_RETRIED" && retryFull2.attempt?.id === retryFull1.attempt?.id
  );
  const retryFull3 = await db.retryFullAttemptForJob({
    jobId: fullRetryJobId,
    claimToken: fullRetryToken,
    projectId: fullRetryProjectId,
    sourceAttemptId: fullRetrySourceAttemptId,
    perplexityReservedCostUsd: 0.99,
    analysisReservedCostUsd: 0.99,
  });
  check(
    "retryFull: different intent on an already-retried source -> SOURCE_ALREADY_RETRIED, zero mutation",
    retryFull3.outcome === "SOURCE_ALREADY_RETRIED"
  );

  // ========================================================================
  // Part D — retry_analysis_generation_for_job, separate fixture.
  // ========================================================================
  console.log("\n[D] MemoryAdapter — retry_analysis_generation_for_job");

  const analysisFixture = await buildAnalysisRetryFixture(db, "analysis-retry");
  const retryAnalysis1 = await db.retryAnalysisGenerationForJob({
    jobId: analysisFixture.jobId,
    claimToken: analysisFixture.claimToken,
    projectId: analysisFixture.projectId,
    sourceExternalCallId: analysisFixture.analysisCallId,
    reservedCostUsd: 0.02,
  });
  check(
    "retryAnalysis: Perplexity completed, analysis gen1 failed -> RESERVED, new generation 2",
    retryAnalysis1.outcome === "RESERVED" && retryAnalysis1.externalCall?.generation === 2
  );
  const retryAnalysis2 = await db.retryAnalysisGenerationForJob({
    jobId: analysisFixture.jobId,
    claimToken: analysisFixture.claimToken,
    projectId: analysisFixture.projectId,
    sourceExternalCallId: analysisFixture.analysisCallId,
    reservedCostUsd: 0.02,
  });
  check(
    "retryAnalysis: replay (same source, same cost) -> ALREADY_RETRIED, same generation-2 call",
    retryAnalysis2.outcome === "ALREADY_RETRIED" && retryAnalysis2.externalCall?.id === retryAnalysis1.externalCall?.id
  );
  const retryAnalysis3 = await db.retryAnalysisGenerationForJob({
    jobId: analysisFixture.jobId,
    claimToken: analysisFixture.claimToken,
    projectId: analysisFixture.projectId,
    sourceExternalCallId: analysisFixture.analysisCallId,
    reservedCostUsd: 0.99,
  });
  check(
    "retryAnalysis: different intent on an already-retried source -> SOURCE_ALREADY_RETRIED",
    retryAnalysis3.outcome === "SOURCE_ALREADY_RETRIED"
  );
  const retryAnalysis4 = await db.retryAnalysisGenerationForJob({
    jobId: analysisFixture.jobId,
    claimToken: analysisFixture.claimToken,
    projectId: analysisFixture.projectId,
    sourceExternalCallId: analysisFixture.analysisCallId,
    reservedCostUsd: 0.02,
  });
  check(
    "retryAnalysis: a third call replaying the same (now-child-having) source still resolves ALREADY_RETRIED — existing-child check is never bypassed by SOURCE_NOT_AUTHORITATIVE_GENERATION (D-023 arbitration)",
    retryAnalysis4.outcome === "ALREADY_RETRIED"
  );

  // ========================================================================
  // Part E — operator idempotence/fingerprint + needs_review.
  // ========================================================================
  console.log("\n[E] MemoryAdapter — authorize_operator_retry + needs_review");

  const opFixture = await buildNeedsReviewFixture(db, "operator-retry");

  const denied = await db.authorizeOperatorRetry({
    jobId: opFixture.jobId,
    projectId: opFixture.projectId,
    actor: "qa",
    reason: "over spend cap on purpose",
    action: "retry_full_attempt",
    sourceAttemptId: opFixture.attemptId,
    reservedCostUsd: 500,
    perplexityReservedCostUsd: 500,
    idempotencyKey: "op:decision-1",
  });
  check("operator: over spend cap -> DENIED, no mutation", denied.status === "DENIED" && denied.outcome === "denied");
  const deniedReplay = await db.authorizeOperatorRetry({
    jobId: opFixture.jobId,
    projectId: opFixture.projectId,
    actor: "qa",
    reason: "replaying, irrelevant text",
    action: "retry_full_attempt",
    sourceAttemptId: opFixture.attemptId,
    reservedCostUsd: 500,
    perplexityReservedCostUsd: 500,
    idempotencyKey: "op:decision-1",
  });
  check(
    "operator: replay of the same key + same fingerprint -> the exact same recorded result",
    deniedReplay.status === "DENIED" && deniedReplay.denialCode === denied.denialCode
  );

  const approved = await db.authorizeOperatorRetry({
    jobId: opFixture.jobId,
    projectId: opFixture.projectId,
    actor: "qa",
    reason: "small enough to approve",
    action: "retry_full_attempt",
    sourceAttemptId: opFixture.attemptId,
    reservedCostUsd: 0.02,
    perplexityReservedCostUsd: 0.02,
    idempotencyKey: "op:decision-2",
  });
  check(
    "operator: genuinely new key, small enough -> APPROVED, new attempt created",
    approved.status === "APPROVED" && approved.newAttempt !== null
  );
  const conflict = await db.authorizeOperatorRetry({
    jobId: opFixture.jobId,
    projectId: opFixture.projectId,
    actor: "qa",
    reason: "same key, different cost -- must conflict",
    action: "retry_full_attempt",
    sourceAttemptId: opFixture.attemptId,
    reservedCostUsd: 0.03,
    perplexityReservedCostUsd: 0.03,
    idempotencyKey: "op:decision-2",
  });
  check(
    "operator: same key + different intent -> IDEMPOTENCY_KEY_CONFLICT, zero mutation",
    conflict.status === "IDEMPOTENCY_KEY_CONFLICT"
  );

  // The APPROVED operator retry above legitimately re-queues opFixture's
  // job (an approved retry always returns it to "queued", D-021) -- this
  // is correct production behavior, not a bug. Drain it explicitly so a
  // later, unrelated fixture's claim_protocol_execution_job call (which
  // claims the oldest eligible job GLOBALLY, by design) cannot accidentally
  // pick it up instead of its own freshly enqueued job.
  const opDrain = await db.claimProtocolExecutionJob({ workerId: "operator-fixture-drain", leaseSeconds: 300 });
  if (opDrain.job && opDrain.claimToken) {
    await db.failProtocolExecutionJob({
      jobId: opDrain.job.id,
      claimToken: opDrain.claimToken,
      projectId: opDrain.job.projectId,
      reason: "test fixture drained after operator-retry coverage",
    });
  }

  // needs_review: ambiguous call after "crash" (sent, no receipt)
  const ambiguousFixture = await buildAmbiguousFixture(db, "needs-review");
  const nr1 = await db.markProtocolExecutionJobNeedsReviewForAmbiguity({
    jobId: ambiguousFixture.jobId,
    claimToken: ambiguousFixture.claimToken,
    projectId: ambiguousFixture.projectId,
  });
  check(
    "needs_review: sent + no receipt -> NEEDS_REVIEW with the exact reason",
    nr1.outcome === "NEEDS_REVIEW" && nr1.job?.needsReviewReason === "ambiguous_external_call_sent_without_receipt"
  );
  const nr2 = await db.markProtocolExecutionJobNeedsReviewForAmbiguity({
    jobId: ambiguousFixture.jobId,
    claimToken: ambiguousFixture.claimToken,
    projectId: ambiguousFixture.projectId,
  });
  check("needs_review: replay -> ALREADY_NEEDS_REVIEW", nr2.outcome === "ALREADY_NEEDS_REVIEW");

  const healthyFixture = await buildHealthyRunningFixture(db, "no-ambiguity");
  const nrHealthy = await db.markProtocolExecutionJobNeedsReviewForAmbiguity({
    jobId: healthyFixture.jobId,
    claimToken: healthyFixture.claimToken,
    projectId: healthyFixture.projectId,
  });
  check(
    "needs_review: healthy job, nothing ambiguous -> NO_AMBIGUOUS_CALL, zero mutation",
    nrHealthy.outcome === "NO_AMBIGUOUS_CALL" && nrHealthy.job?.status === "running"
  );

  // ========================================================================
  // Part F — project/job/protocol scoping.
  // ========================================================================
  console.log("\n[F] MemoryAdapter — project/job/protocol scoping");

  const otherProject = await db.createProject({ domain: "other-project.test" });
  const crossProjectClaim = await db.renewProtocolExecutionJobLease({
    jobId: healthyFixture.jobId,
    claimToken: healthyFixture.claimToken,
    projectId: otherProject.id,
    leaseSeconds: 300,
  });
  check(
    "scoping: a job's projectId must match exactly -- a real job id under the wrong project -> JOB_NOT_FOUND",
    crossProjectClaim.outcome === "JOB_NOT_FOUND"
  );

  const crossJobExternalCall = await db.markExternalCallSentForJob({
    jobId: fullRetryJobId,
    claimToken: fullRetryToken,
    projectId: fullRetryProjectId,
    externalCallId: must(admit1.perplexityCall, "part B perplexity call").id,
    probeRunId,
  });
  check(
    "scoping: an external call belonging to a DIFFERENT job is refused -> CALL_NOT_OWNED_BY_JOB or NOT_FOUND, never SENT",
    crossJobExternalCall.outcome === "CALL_NOT_OWNED_BY_JOB" || crossJobExternalCall.outcome === "NOT_FOUND"
  );

  // ========================================================================
  // Part G — reactivate_abandoned_job (D-024: fingerprinted, replay-safe).
  // ========================================================================
  console.log("\n[G] MemoryAdapter — reactivate_abandoned_job (D-024)");

  const abandonedFixture = await buildAbandonedFixture(db, "abandoned");
  const reactivate1 = await db.reactivateAbandonedJob({
    jobId: abandonedFixture.jobId,
    projectId: abandonedFixture.projectId,
    actor: "qa",
    reason: "recovering an abandoned job",
    idempotencyKey: "reactivate:decision-1",
  });
  check(
    "reactivateAbandonedJob: an abandoned job is reactivated -> REACTIVATED, status queued, attemptCount reset",
    reactivate1.outcome === "REACTIVATED" &&
      reactivate1.job?.status === "queued" &&
      reactivate1.job?.attemptCount === 0
  );

  // Change the job's status again (claim it) before replaying the SAME key
  // -- the replay must still return the exact original decision, regardless
  // of what the job's status is now (D-022 ordering discipline, applied
  // here per D-024).
  await db.claimProtocolExecutionJob({ workerId: "abandoned-worker-2", leaseSeconds: 300 });
  const reactivate1Replay = await db.reactivateAbandonedJob({
    jobId: abandonedFixture.jobId,
    projectId: abandonedFixture.projectId,
    actor: "qa",
    reason: "replaying, irrelevant text",
    idempotencyKey: "reactivate:decision-1",
  });
  check(
    "reactivateAbandonedJob: replay of the same key + same fingerprint -> REACTIVATED again, zero new mutation, even though the job's status has since changed",
    reactivate1Replay.outcome === "REACTIVATED"
  );

  // A denial (job not abandoned) is itself journaled and its replay is
  // equally idempotent.
  const healthyForReactivation = await buildHealthyRunningFixture(db, "reactivate-not-abandoned");
  const denialFixtureJob = healthyForReactivation.jobId;
  const denialFixtureProject = healthyForReactivation.projectId;
  const reactivateDenied = await db.reactivateAbandonedJob({
    jobId: denialFixtureJob,
    projectId: denialFixtureProject,
    actor: "qa",
    reason: "attempting to reactivate a healthy job",
    idempotencyKey: "reactivate:decision-2",
  });
  check(
    "reactivateAbandonedJob: a non-abandoned job is refused -> JOB_NOT_ABANDONED, zero mutation",
    reactivateDenied.outcome === "JOB_NOT_ABANDONED"
  );
  const reactivateDeniedReplay = await db.reactivateAbandonedJob({
    jobId: denialFixtureJob,
    projectId: denialFixtureProject,
    actor: "qa",
    reason: "replaying the same denial",
    idempotencyKey: "reactivate:decision-2",
  });
  check(
    "reactivateAbandonedJob: replay of the same denial key -> the exact same JOB_NOT_ABANDONED denial, no new action",
    reactivateDeniedReplay.outcome === "JOB_NOT_ABANDONED"
  );

  // The unique constraint is (project_id, job_id, idempotency_key) --
  // deliberately WITHOUT `action` (per D-024 and the pre-existing
  // protocol_operator_actions_project_job_key_key constraint) -- so the
  // realistic IDEMPOTENCY_KEY_CONFLICT scenario is the SAME key already
  // used by a DIFFERENT operator action type on the SAME job (its
  // fingerprint was computed under that other action's own formula, never
  // reactivate_abandoned_job's job_id/project_id/action triple).
  const conflictFixture = await buildAbandonedFixture(db, "abandoned-conflict");
  insertFakeOperatorAction(conflictFixture.jobId, conflictFixture.projectId, "reactivate:shared-key");
  const reactivateConflict = await db.reactivateAbandonedJob({
    jobId: conflictFixture.jobId,
    projectId: conflictFixture.projectId,
    actor: "qa",
    reason: "same key already used by a different operator action on this job -- must conflict",
    idempotencyKey: "reactivate:shared-key",
  });
  check(
    "reactivateAbandonedJob: the same idempotency key already used by a different operator action on the SAME job -> IDEMPOTENCY_KEY_CONFLICT, zero mutation",
    reactivateConflict.outcome === "IDEMPOTENCY_KEY_CONFLICT"
  );

  // ========================================================================
  // Part I — D-025: one execution job advances through every planned
  //          baseline slot sequentially.
  // ========================================================================
  console.log("\n[I] MemoryAdapter — D-025 multi-baseline cardinality");

  /** Runs a fresh attempt's Perplexity + analysis calls through sent/receipt/reconcile-completed, in one call. */
  async function completeBaselineSlot(
    jobId: string,
    claimToken: string,
    projectId: string,
    attemptId: string,
    perplexityCallId: string,
    analysisCallId: string
  ): Promise<void> {
    const start = await db.createProbeRunAndStartAttemptForJob({
      jobId, claimToken, projectId, attemptId,
      platform: "perplexity", probeMode: "simulated",
      datasetId: "44444444-4444-4444-8444-444444444444", datasetSourceType: "manual_scan",
    });
    const probeRunId = must(start.probeRun, "probe run").id;
    await db.markExternalCallSentForJob({ jobId, claimToken, projectId, externalCallId: perplexityCallId, probeRunId });
    await db.recordProviderCallReceiptForJob({
      jobId, claimToken, projectId, externalCallId: perplexityCallId, probeRunId, outcome: "success",
      httpStatus: 200, providerRequestId: "req-x", rawResponseSha256: "b".repeat(64), latencyMs: 400,
    });
    await db.markExternalCallSentForJob({ jobId, claimToken, projectId, externalCallId: analysisCallId, probeRunId });
    await db.recordAnalysisCallReceiptForJob({
      jobId, claimToken, projectId, externalCallId: analysisCallId, probeRunId, outcome: "success",
      provider: "openai", model: "gpt-4o-mini", usedMock: false,
      requestSha256: "c".repeat(64), responseSha256: "d".repeat(64), latencyMs: 200,
    });
    await db.reconcileAttemptForJob({ jobId, claimToken, projectId, attemptId, status: "completed" });
  }

  // -- Test 2/6/7/8/9/10 (user's numbered list): planned_baseline_runs = 2,
  //    planned_retest_runs = 1 -- the exact smoke4 shape.
  {
    const mbProject = await db.createProject({ domain: "multi-baseline.test" });
    const mbQuestion = await db.createBuyerQuestion({ projectId: mbProject.id });
    const mbVersion = await db.createBuyerQuestionVersion({
      buyerQuestionId: mbQuestion.id, projectId: mbProject.id, versionNumber: 1,
      promptText: "Multi-baseline fixture", promptHash: "e".repeat(64),
      intentType: "comparison", commercialValue: 3, winnability: 3, priority: 10,
      rationale: "fixture", provenance: "founder_supplied",
    });
    await db.approveBuyerQuestionVersion({
      versionId: mbVersion.id, projectId: mbProject.id, approvedBy: "11111111-1111-4111-8111-111111111111",
    });
    const mbProtocol = await db.createProtocol({
      ...PROTOCOL_FIXTURE, plannedBaselineRuns: 2, plannedRetestRuns: 1, runCap: 5,
      projectId: mbProject.id, buyerQuestionVersionId: mbVersion.id,
    });
    await db.approveProtocol({
      protocolId: mbProtocol.id, projectId: mbProject.id, approvedBy: "11111111-1111-4111-8111-111111111111",
    });

    const mbEnqueue = await db.enqueueProtocolExecutionJob({ protocolId: mbProtocol.id, projectId: mbProject.id });
    const mbJobId = must(mbEnqueue.job, "multi-baseline job").id;
    const mbClaim = await db.claimProtocolExecutionJob({ workerId: "mb-worker", leaseSeconds: 300 });
    const mbClaimToken = must(mbClaim.claimToken, "multi-baseline claim token");

    // Test 8: a wrong-ordinal key, while current_attempt_id is still null,
    // is refused with zero mutation -- checked BEFORE the real admission.
    const mbBadKey = await db.admitAndReserveAttemptForJob({
      jobId: mbJobId, claimToken: mbClaimToken, projectId: mbProject.id, attemptKind: "baseline",
      idempotencyKey: `${mbJobId}:baseline:2`, perplexityReservedCostUsd: 0.01, analysisReservedCostUsd: 0.01,
    });
    check(
      "D-025 test 8: an idempotency key for the wrong ordinal (2, while next_baseline_ordinal is still 1) is refused with INVALID_IDEMPOTENCY_KEY, zero mutation",
      mbBadKey.outcome === "INVALID_IDEMPOTENCY_KEY" && mbBadKey.attempt === null
    );

    // Slot 1/2: admit, run to completion.
    const mbAdmit1 = await db.admitAndReserveAttemptForJob({
      jobId: mbJobId, claimToken: mbClaimToken, projectId: mbProject.id, attemptKind: "baseline",
      idempotencyKey: `${mbJobId}:baseline:1`, perplexityReservedCostUsd: 0.01, analysisReservedCostUsd: 0.01,
    });
    check(
      "D-025 test 2: slot 1 admits RESERVED with baselineOrdinal 1",
      mbAdmit1.outcome === "RESERVED" && mbAdmit1.attempt?.baselineOrdinal === 1
    );
    const mbAttempt1Id = must(mbAdmit1.attempt, "slot 1 attempt").id;
    await completeBaselineSlot(
      mbJobId, mbClaimToken, mbProject.id, mbAttempt1Id,
      must(mbAdmit1.perplexityCall, "slot 1 perplexity call").id,
      must(mbAdmit1.analysisCall, "slot 1 analysis call").id
    );

    const mbComplete1 = await db.completeProtocolExecutionJob({ jobId: mbJobId, claimToken: mbClaimToken, projectId: mbProject.id });
    check(
      "D-025 test 2: completing slot 1 of 2 returns NEXT_BASELINE_REQUIRED, never SUCCEEDED",
      mbComplete1.outcome === "NEXT_BASELINE_REQUIRED"
    );
    check(
      "D-025 test 2: current_attempt_id is cleared and next_baseline_ordinal advances to 2, job stays running with the same claim/lease",
      mbComplete1.job?.currentAttemptId === null &&
        mbComplete1.job?.nextBaselineOrdinal === 2 &&
        mbComplete1.job?.status === "running" &&
        mbComplete1.job?.claimToken === mbClaimToken
    );

    // Test: replay after advancement but before the next admission ->
    // idempotent NEXT_BASELINE_REQUIRED, zero further mutation.
    const mbCompleteReplay = await db.completeProtocolExecutionJob({ jobId: mbJobId, claimToken: mbClaimToken, projectId: mbProject.id });
    check(
      "D-025: a replay of complete() after advancement but before the next admission returns NEXT_BASELINE_REQUIRED idempotently, ordinal unchanged",
      mbCompleteReplay.outcome === "NEXT_BASELINE_REQUIRED" && mbCompleteReplay.job?.nextBaselineOrdinal === 2
    );

    const mbContextAfterSlot1 = await db.getProtocolExecutionJobContext({ jobId: mbJobId, claimToken: mbClaimToken, projectId: mbProject.id });
    check(
      "D-025 test 10: after slot 1, completedBaselineSlots is exactly 1 -- never confused with the raw protocol_attempts row count",
      mbContextAfterSlot1.completedBaselineSlots === 1
    );

    // Slot 2/2: fresh key naming ordinal 2, admits a genuinely new root attempt.
    const mbAdmit2 = await db.admitAndReserveAttemptForJob({
      jobId: mbJobId, claimToken: mbClaimToken, projectId: mbProject.id, attemptKind: "baseline",
      idempotencyKey: `${mbJobId}:baseline:2`, perplexityReservedCostUsd: 0.01, analysisReservedCostUsd: 0.01,
    });
    check(
      "D-025 test 2/9: slot 2 admits RESERVED with baselineOrdinal 2, a genuinely different attempt from slot 1",
      mbAdmit2.outcome === "RESERVED" &&
        mbAdmit2.attempt?.baselineOrdinal === 2 &&
        mbAdmit2.attempt?.id !== mbAttempt1Id
    );
    const mbAttempt2Id = must(mbAdmit2.attempt, "slot 2 attempt").id;

    // Test 3/4 (adapter-level approximation): a second admission call for
    // the same slot 2, after it is already current, resumes rather than
    // creating a second root -- the same single-pointer guard that makes
    // true two-process concurrency safe in the real RPC (proven with real
    // locking in the disposable-Postgres runtime test, not here).
    const mbAdmit2Again = await db.admitAndReserveAttemptForJob({
      jobId: mbJobId, claimToken: mbClaimToken, projectId: mbProject.id, attemptKind: "baseline",
      idempotencyKey: `${mbJobId}:baseline:2`, perplexityReservedCostUsd: 0.01, analysisReservedCostUsd: 0.01,
    });
    check(
      "D-025 test 3/4: a repeated admission call for the same (now-current) slot 2 resumes the same attempt, never a second root",
      mbAdmit2Again.outcome === "RESUME_CURRENT_ATTEMPT" && mbAdmit2Again.attempt?.id === mbAttempt2Id
    );

    await completeBaselineSlot(
      mbJobId, mbClaimToken, mbProject.id, mbAttempt2Id,
      must(mbAdmit2.perplexityCall, "slot 2 perplexity call").id,
      must(mbAdmit2.analysisCall, "slot 2 analysis call").id
    );

    // Read the context WHILE the job is still 'running' (both slots'
    // attempts are reconciled-completed, but complete_protocol_execution_job
    // has not yet been called for slot 2) -- get_protocol_execution_job_
    // context requires claimed/running fencing, so this must run before the
    // job reaches its terminal 'succeeded' status below.
    const mbContextAfterSlot2 = await db.getProtocolExecutionJobContext({ jobId: mbJobId, claimToken: mbClaimToken, projectId: mbProject.id });
    check(
      "D-025 test 9/10: after both planned baseline slots complete, completedBaselineSlots is exactly 2 (smoke4 shape: 2 baseline executed, its planned_retest_runs=1 never auto-run by M5)",
      mbContextAfterSlot2.completedBaselineSlots === 2
    );

    const mbComplete2 = await db.completeProtocolExecutionJob({ jobId: mbJobId, claimToken: mbClaimToken, projectId: mbProject.id });
    check(
      "D-025 test 2: completing slot 2 of 2 (the last planned ordinal) returns SUCCEEDED",
      mbComplete2.outcome === "SUCCEEDED" && mbComplete2.job?.status === "succeeded"
    );

    // A second enqueue for this same protocol still always returns
    // ALREADY_EXISTS, unaffected by D-025 -- retest (M7) would be a
    // separate protocols row with its own protocol_id, never this one.
    const mbEnqueueAgain = await db.enqueueProtocolExecutionJob({ protocolId: mbProtocol.id, projectId: mbProject.id });
    check(
      "D-025: a second enqueue for the same (now succeeded) protocol is still always ALREADY_EXISTS -- no recycling",
      mbEnqueueAgain.outcome === "ALREADY_EXISTS" && mbEnqueueAgain.job?.id === mbJobId
    );
  }

  // -- Test 5: a failed slot 1, recovered by a full retry, still consumes
  //    exactly one baseline slot -- never two, despite three total attempts
  //    existing across the job's lifetime for two planned slots.
  {
    // buildFailedAttemptFixture's protocol uses PROTOCOL_FIXTURE's default
    // plannedBaselineRuns: 1 -- built inline instead with plannedBaselineRuns:
    // 2, so completing the retried child still leaves one slot open.
    const frProject = await db.createProject({ domain: "d025-full-retry.test" });
    const frQuestion = await db.createBuyerQuestion({ projectId: frProject.id });
    const frVersion = await db.createBuyerQuestionVersion({
      buyerQuestionId: frQuestion.id, projectId: frProject.id, versionNumber: 1,
      promptText: "D-025 full retry fixture", promptHash: "f".repeat(64),
      intentType: "comparison", commercialValue: 3, winnability: 3, priority: 10,
      rationale: "fixture", provenance: "founder_supplied",
    });
    await db.approveBuyerQuestionVersion({
      versionId: frVersion.id, projectId: frProject.id, approvedBy: "11111111-1111-4111-8111-111111111111",
    });
    const frProtocol = await db.createProtocol({
      ...PROTOCOL_FIXTURE, plannedBaselineRuns: 2, retryCap: 2,
      projectId: frProject.id, buyerQuestionVersionId: frVersion.id,
    });
    await db.approveProtocol({
      protocolId: frProtocol.id, projectId: frProject.id, approvedBy: "11111111-1111-4111-8111-111111111111",
    });
    const frEnqueue = await db.enqueueProtocolExecutionJob({ protocolId: frProtocol.id, projectId: frProject.id });
    const frJobId = must(frEnqueue.job, "full-retry-slot job").id;
    const frClaim = await db.claimProtocolExecutionJob({ workerId: "d025-fr-worker", leaseSeconds: 300 });
    const frClaimToken = must(frClaim.claimToken, "full-retry-slot claim token");

    const frAdmit = await db.admitAndReserveAttemptForJob({
      jobId: frJobId, claimToken: frClaimToken, projectId: frProject.id, attemptKind: "baseline",
      idempotencyKey: `${frJobId}:baseline:1`, perplexityReservedCostUsd: 0.01, analysisReservedCostUsd: 0.01,
    });
    const frSourceAttemptId = must(frAdmit.attempt, "full-retry-slot source attempt").id;
    // Fail slot 1's root attempt outright (Perplexity provider_error on both legs).
    const frStart = await db.createProbeRunAndStartAttemptForJob({
      jobId: frJobId, claimToken: frClaimToken, projectId: frProject.id, attemptId: frSourceAttemptId,
      platform: "perplexity", probeMode: "simulated",
      datasetId: "44444444-4444-4444-8444-444444444444", datasetSourceType: "manual_scan",
    });
    const frProbeRunId = must(frStart.probeRun, "full-retry-slot probe run").id;
    const frPerplexityCallId = must(frAdmit.perplexityCall, "full-retry-slot perplexity call").id;
    const frAnalysisCallId = must(frAdmit.analysisCall, "full-retry-slot analysis call").id;
    await db.markExternalCallSentForJob({ jobId: frJobId, claimToken: frClaimToken, projectId: frProject.id, externalCallId: frPerplexityCallId, probeRunId: frProbeRunId });
    await db.recordProviderCallReceiptForJob({ jobId: frJobId, claimToken: frClaimToken, projectId: frProject.id, externalCallId: frPerplexityCallId, probeRunId: frProbeRunId, outcome: "provider_error" });
    await db.markExternalCallSentForJob({ jobId: frJobId, claimToken: frClaimToken, projectId: frProject.id, externalCallId: frAnalysisCallId, probeRunId: frProbeRunId });
    await db.recordAnalysisCallReceiptForJob({ jobId: frJobId, claimToken: frClaimToken, projectId: frProject.id, externalCallId: frAnalysisCallId, probeRunId: frProbeRunId, outcome: "provider_error" });
    await db.reconcileAttemptForJob({ jobId: frJobId, claimToken: frClaimToken, projectId: frProject.id, attemptId: frSourceAttemptId, status: "failed" });

    const frRetry = await db.retryFullAttemptForJob({
      jobId: frJobId, claimToken: frClaimToken, projectId: frProject.id,
      sourceAttemptId: frSourceAttemptId, perplexityReservedCostUsd: 0.02, analysisReservedCostUsd: 0.02,
    });
    check(
      "D-025 test 5: a full retry of a failed slot 1 root inherits baselineOrdinal 1 from its source, never a new ordinal",
      frRetry.outcome === "RESERVED" && frRetry.attempt?.baselineOrdinal === 1 && frRetry.attempt?.id !== frSourceAttemptId
    );
    const frChildAttemptId = must(frRetry.attempt, "full-retry-slot child attempt").id;
    await completeBaselineSlot(
      frJobId, frClaimToken, frProject.id, frChildAttemptId,
      must(frRetry.perplexityCall, "full-retry-slot child perplexity call").id,
      must(frRetry.analysisCall, "full-retry-slot child analysis call").id
    );

    const frComplete = await db.completeProtocolExecutionJob({ jobId: frJobId, claimToken: frClaimToken, projectId: frProject.id });
    check(
      "D-025 test 5: completing the retried child (slot 1) with 2 planned baseline runs returns NEXT_BASELINE_REQUIRED -- a retry never consumes a new slot",
      frComplete.outcome === "NEXT_BASELINE_REQUIRED" && frComplete.job?.nextBaselineOrdinal === 2
    );
    const frContext = await db.getProtocolExecutionJobContext({ jobId: frJobId, claimToken: frClaimToken, projectId: frProject.id });
    check(
      "D-025 test 5: three attempts exist for this job (failed root + retried child + none yet for slot 2) but exactly one baseline slot is completed -- counters track slots, never raw attempt rows",
      frContext.completedBaselineSlots === 1
    );
  }

  // -- Test 7: planned_baseline_runs = 0 -- enqueue is refused, no job row.
  {
    const zbProject = await db.createProject({ domain: "d025-zero-baseline.test" });
    const zbQuestion = await db.createBuyerQuestion({ projectId: zbProject.id });
    const zbVersion = await db.createBuyerQuestionVersion({
      buyerQuestionId: zbQuestion.id, projectId: zbProject.id, versionNumber: 1,
      promptText: "D-025 zero baseline fixture", promptHash: "9".repeat(64),
      intentType: "comparison", commercialValue: 3, winnability: 3, priority: 10,
      rationale: "fixture", provenance: "founder_supplied",
    });
    await db.approveBuyerQuestionVersion({
      versionId: zbVersion.id, projectId: zbProject.id, approvedBy: "11111111-1111-4111-8111-111111111111",
    });
    const zbProtocol = await db.createProtocol({
      ...PROTOCOL_FIXTURE, plannedBaselineRuns: 0,
      projectId: zbProject.id, buyerQuestionVersionId: zbVersion.id,
    });
    await db.approveProtocol({
      protocolId: zbProtocol.id, projectId: zbProject.id, approvedBy: "11111111-1111-4111-8111-111111111111",
    });
    const zbEnqueue = await db.enqueueProtocolExecutionJob({ protocolId: zbProtocol.id, projectId: zbProject.id });
    check(
      "D-025 test 7: planned_baseline_runs = 0 refuses enqueue with NO_BASELINE_RUNS_PLANNED, creating no job row",
      zbEnqueue.outcome === "NO_BASELINE_RUNS_PLANNED" && zbEnqueue.job === null
    );
  }

  // ========================================================================
  // Part H — SupabaseAdapter: RPC name/parameter mapping + row-shape parity.
  // ========================================================================
  console.log("\n[H] SupabaseAdapter — RPC mapping (stub client, no network)");

  const { supabaseAdapter, __setSupabaseAdapterClientForTests } = await import(
    "@/lib/db/supabase-adapter"
  );

  type RpcCall = { fn: string; args: Record<string, unknown> };
  let rpcCalls: RpcCall[] = [];
  let nextRpcResponse: { data: unknown; error: unknown } = { data: null, error: null };

  function stubClient() {
    return {
      rpc(fn: string, args: Record<string, unknown>) {
        rpcCalls.push({ fn, args });
        return Promise.resolve(nextRpcResponse);
      },
      from() {
        throw new Error("SupabaseAdapter must never call .from(...) for an M5 table in this test");
      },
    };
  }
  __setSupabaseAdapterClientForTests(
    stubClient() as unknown as Parameters<typeof __setSupabaseAdapterClientForTests>[0]
  );

  const JOB_ROW = {
    id: "j1", project_id: "p1", protocol_id: "pr1", status: "queued",
    worker_id: null, claim_token: null, lease_expires_at: null,
    attempt_count: 0, max_attempts: 3, current_attempt_id: null,
    needs_review_reason: null, failure_reason: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
  };

  rpcCalls = [];
  nextRpcResponse = { data: { status: "QUEUED", job: JOB_ROW }, error: null };
  const supaEnqueue = await supabaseAdapter.enqueueProtocolExecutionJob({
    protocolId: "pr1",
    projectId: "p1",
  });
  check(
    "Supabase enqueueProtocolExecutionJob: calls enqueue_protocol_execution_job with exactly p_protocol_id/p_project_id/p_max_attempts",
    rpcCalls.length === 1 &&
      rpcCalls[0]!.fn === "enqueue_protocol_execution_job" &&
      rpcCalls[0]!.args.p_protocol_id === "pr1" &&
      rpcCalls[0]!.args.p_project_id === "p1" &&
      rpcCalls[0]!.args.p_max_attempts === 3
  );
  check(
    "Supabase enqueueProtocolExecutionJob: outcome/job shape matches MemoryAdapter's own outcome vocabulary",
    supaEnqueue.outcome === "QUEUED" && supaEnqueue.job?.id === "j1" && supaEnqueue.job?.status === "queued"
  );

  rpcCalls = [];
  nextRpcResponse = { data: { status: "CLAIMED", job: { ...JOB_ROW, status: "claimed", claim_token: "tok" }, claim_token: "tok" }, error: null };
  const supaClaim = await supabaseAdapter.claimProtocolExecutionJob({ workerId: "w1", leaseSeconds: 300 });
  check(
    "Supabase claimProtocolExecutionJob: calls claim_protocol_execution_job with p_worker_id/p_lease_seconds",
    rpcCalls.length === 1 &&
      rpcCalls[0]!.fn === "claim_protocol_execution_job" &&
      rpcCalls[0]!.args.p_worker_id === "w1" &&
      rpcCalls[0]!.args.p_lease_seconds === 300 &&
      supaClaim.outcome === "CLAIMED" &&
      supaClaim.claimToken === "tok"
  );

  rpcCalls = [];
  nextRpcResponse = { data: { status: "RENEWED", job: JOB_ROW }, error: null };
  await supabaseAdapter.renewProtocolExecutionJobLease({
    jobId: "j1", claimToken: "tok", projectId: "p1", leaseSeconds: 300,
  });
  check(
    "Supabase renewProtocolExecutionJobLease: p_job_id/p_claim_token/p_project_id/p_lease_seconds",
    rpcCalls[0]!.fn === "renew_protocol_execution_job_lease" &&
      rpcCalls[0]!.args.p_job_id === "j1" &&
      rpcCalls[0]!.args.p_claim_token === "tok" &&
      rpcCalls[0]!.args.p_project_id === "p1" &&
      rpcCalls[0]!.args.p_lease_seconds === 300
  );

  const ATTEMPT_ROW = {
    id: "a1", project_id: "p1", protocol_id: "pr1", buyer_question_version_id: "v1",
    attempt_kind: "baseline", status: "reserved", idempotency_key: "j1:baseline:1",
    reserved_cost_usd: 0.02, actual_cost_usd: null, probe_run_id: null,
    retry_of_attempt_id: null, termination_reason: null,
    reserved_at: "2026-01-01T00:00:00.000Z", last_activity_at: "2026-01-01T00:00:00.000Z",
    terminalized_at: null, created_at: "2026-01-01T00:00:00.000Z", job_id: "j1",
  };
  const CALL_ROW = (kind: string) => ({
    id: `call-${kind}`, project_id: "p1", protocol_attempt_id: "a1", call_kind: kind,
    generation: 1, status: "reserved", reserved_cost_usd: 0.01, actual_cost_usd: null,
    cost_basis: null, probe_run_id: null, request_sent_at: null, terminalized_at: null,
    retry_of_external_call_id: null, created_at: "2026-01-01T00:00:00.000Z",
  });

  rpcCalls = [];
  nextRpcResponse = {
    data: {
      status: "RESERVED",
      attempt: ATTEMPT_ROW,
      perplexity_call: CALL_ROW("perplexity"),
      analysis_call: CALL_ROW("analysis"),
    },
    error: null,
  };
  const supaAdmit = await supabaseAdapter.admitAndReserveAttemptForJob({
    jobId: "j1", claimToken: "tok", projectId: "p1", attemptKind: "baseline",
    idempotencyKey: "j1:baseline:1", perplexityReservedCostUsd: 0.01, analysisReservedCostUsd: 0.01,
  });
  check(
    "Supabase admitAndReserveAttemptForJob: correct RPC name, all 8 params, jobId field mapped onto the attempt",
    rpcCalls[0]!.fn === "admit_and_reserve_attempt_for_job" &&
      rpcCalls[0]!.args.p_job_id === "j1" &&
      rpcCalls[0]!.args.p_attempt_kind === "baseline" &&
      rpcCalls[0]!.args.p_retry_of_attempt_id === null &&
      supaAdmit.outcome === "RESERVED" &&
      supaAdmit.attempt?.jobId === "j1" &&
      supaAdmit.perplexityCall?.callKind === "perplexity" &&
      supaAdmit.analysisCall?.callKind === "analysis"
  );

  rpcCalls = [];
  nextRpcResponse = {
    data: { status: "STARTED", attempt: { ...ATTEMPT_ROW, status: "in_progress", probe_run_id: "run1" }, probe_run: { id: "run1", project_id: "p1", platform: "perplexity", status: "pending", probe_mode: "simulated", dataset_id: "d1", dataset_source_type: "manual_scan", created_at: "2026-01-01T00:00:00.000Z" } },
    error: null,
  };
  const supaStart = await supabaseAdapter.createProbeRunAndStartAttemptForJob({
    jobId: "j1", claimToken: "tok", projectId: "p1", attemptId: "a1",
    platform: "perplexity", probeMode: "simulated", datasetId: "d1", datasetSourceType: "manual_scan",
  });
  check(
    "Supabase createProbeRunAndStartAttemptForJob: correct RPC name, probeRun mapped, never calls start_attempt_for_job",
    rpcCalls[0]!.fn === "create_probe_run_and_start_attempt_for_job" &&
      supaStart.outcome === "STARTED" &&
      supaStart.probeRun?.id === "run1"
  );

  rpcCalls = [];
  nextRpcResponse = { data: { status: "SENT", external_call: { ...CALL_ROW("perplexity"), status: "in_progress", request_sent_at: "2026-01-01T00:00:01.000Z", probe_run_id: "run1" } }, error: null };
  await supabaseAdapter.markExternalCallSentForJob({
    jobId: "j1", claimToken: "tok", projectId: "p1", externalCallId: "call-perplexity", probeRunId: "run1",
  });
  check(
    "Supabase markExternalCallSentForJob: correct RPC name and params",
    rpcCalls[0]!.fn === "mark_external_call_sent_for_job" &&
      rpcCalls[0]!.args.p_external_call_id === "call-perplexity" &&
      rpcCalls[0]!.args.p_probe_run_id === "run1"
  );

  rpcCalls = [];
  nextRpcResponse = {
    data: {
      status: "RECEIPTED",
      external_call: { ...CALL_ROW("perplexity"), status: "completed", actual_cost_usd: null, cost_basis: null },
      receipt: { id: "r1", project_id: "p1", external_call_id: "call-perplexity", probe_run_id: "run1", outcome: "success", http_status: 200, provider_request_id: "req1", raw_response_sha256: "e".repeat(64), latency_ms: 400, received_at: "2026-01-01T00:00:02.000Z", created_at: "2026-01-01T00:00:02.000Z" },
    },
    error: null,
  };
  const supaReceiptP = await supabaseAdapter.recordProviderCallReceiptForJob({
    jobId: "j1", claimToken: "tok", projectId: "p1", externalCallId: "call-perplexity", probeRunId: "run1",
    outcome: "success", httpStatus: 200, providerRequestId: "req1", rawResponseSha256: "e".repeat(64), latencyMs: 400,
    // D-023 §3: no real cost known here -- costBasis intentionally omitted.
  });
  check(
    "Supabase recordProviderCallReceiptForJob: correct RPC name; when costBasis is omitted, p_actual_cost_usd/p_cost_basis are both sent as null, never a fabricated cost",
    rpcCalls[0]!.fn === "record_provider_call_receipt_for_job" &&
      rpcCalls[0]!.args.p_actual_cost_usd === null &&
      rpcCalls[0]!.args.p_cost_basis === null &&
      supaReceiptP.outcome === "RECEIPTED" &&
      supaReceiptP.receipt?.providerRequestId === "req1"
  );

  rpcCalls = [];
  nextRpcResponse = { data: { status: "RECEIPTED", external_call: { ...CALL_ROW("analysis"), status: "completed" }, receipt: { id: "r2", project_id: "p1", external_call_id: "call-analysis", probe_run_id: "run1", outcome: "success", provider: "openai", model: "gpt-4o-mini", used_mock: false, request_sha256: "f".repeat(64), response_sha256: "g".repeat(64), latency_ms: 300, received_at: "2026-01-01T00:00:03.000Z", created_at: "2026-01-01T00:00:03.000Z" } }, error: null };
  const supaReceiptA = await supabaseAdapter.recordAnalysisCallReceiptForJob({
    jobId: "j1", claimToken: "tok", projectId: "p1", externalCallId: "call-analysis", probeRunId: "run1",
    outcome: "success", provider: "openai", model: "gpt-4o-mini", requestSha256: "f".repeat(64), responseSha256: "g".repeat(64), latencyMs: 300,
  });
  check(
    "Supabase recordAnalysisCallReceiptForJob: correct RPC name and full param set",
    rpcCalls[0]!.fn === "record_analysis_call_receipt_for_job" &&
      rpcCalls[0]!.args.p_provider === "openai" &&
      rpcCalls[0]!.args.p_request_sha256 === "f".repeat(64) &&
      supaReceiptA.receipt?.requestSha256 === "f".repeat(64)
  );

  // D-023 §3: an explicit, real, approved cost basis IS forwarded (never
  // suppressed) -- only "unknown" is ever translated to null.
  rpcCalls = [];
  nextRpcResponse = { data: { status: "RECEIPTED", external_call: CALL_ROW("perplexity"), receipt: null }, error: null };
  await supabaseAdapter.recordProviderCallReceiptForJob({
    jobId: "j1", claimToken: "tok", projectId: "p1", externalCallId: "call-perplexity", probeRunId: "run1",
    outcome: "success", actualCostUsd: 0.0123, costBasis: "measured",
  });
  check(
    "Supabase recordProviderCallReceiptForJob: a real, approved 'measured' cost basis IS forwarded to Postgres",
    rpcCalls[0]!.args.p_actual_cost_usd === 0.0123 && rpcCalls[0]!.args.p_cost_basis === "measured"
  );
  rpcCalls = [];
  nextRpcResponse = { data: { status: "RECEIPTED", external_call: CALL_ROW("perplexity"), receipt: null }, error: null };
  await supabaseAdapter.recordProviderCallReceiptForJob({
    jobId: "j1", claimToken: "tok", projectId: "p1", externalCallId: "call-perplexity", probeRunId: "run1",
    outcome: "success", actualCostUsd: 999, costBasis: "unknown",
  });
  check(
    "Supabase recordProviderCallReceiptForJob: 'unknown' cost basis is never forwarded as a literal -- both actualCostUsd and costBasis become null, never the historical flat constant treated as real (D-023 §3)",
    rpcCalls[0]!.args.p_cost_basis === null && rpcCalls[0]!.args.p_actual_cost_usd === null
  );

  rpcCalls = [];
  nextRpcResponse = { data: { status: "RECONCILED", attempt: { ...ATTEMPT_ROW, status: "completed", terminalized_at: "2026-01-01T00:00:04.000Z" } }, error: null };
  await supabaseAdapter.reconcileAttemptForJob({
    jobId: "j1", claimToken: "tok", projectId: "p1", attemptId: "a1", status: "completed",
  });
  check(
    "Supabase reconcileAttemptForJob: correct RPC name and params",
    rpcCalls[0]!.fn === "reconcile_attempt_for_job" && rpcCalls[0]!.args.p_status === "completed"
  );

  rpcCalls = [];
  nextRpcResponse = { data: { status: "SUCCEEDED", job: { ...JOB_ROW, status: "succeeded" } }, error: null };
  const supaComplete = await supabaseAdapter.completeProtocolExecutionJob({
    jobId: "j1", claimToken: "tok", projectId: "p1",
  });
  check(
    "Supabase completeProtocolExecutionJob: correct RPC name; outcome/status mapping matches MemoryAdapter's vocabulary",
    rpcCalls[0]!.fn === "complete_protocol_execution_job" &&
      supaComplete.outcome === "SUCCEEDED" &&
      supaComplete.job?.status === "succeeded"
  );

  rpcCalls = [];
  nextRpcResponse = { data: { status: "FAILED", job: { ...JOB_ROW, status: "failed", failure_reason: "boom" } }, error: null };
  await supabaseAdapter.failProtocolExecutionJob({ jobId: "j1", claimToken: "tok", projectId: "p1", reason: "boom" });
  check(
    "Supabase failProtocolExecutionJob: correct RPC name and reason param",
    rpcCalls[0]!.fn === "fail_protocol_execution_job" && rpcCalls[0]!.args.p_reason === "boom"
  );

  rpcCalls = [];
  nextRpcResponse = { data: { status: "REACTIVATED", job: { ...JOB_ROW, status: "queued" } }, error: null };
  await supabaseAdapter.reactivateAbandonedJob({
    jobId: "j1", projectId: "p1", actor: "qa", reason: "recovering", idempotencyKey: "reactivate:1",
  });
  check(
    "Supabase reactivateAbandonedJob: correct RPC name and full param set including the D-024 mandatory p_idempotency_key",
    rpcCalls[0]!.fn === "reactivate_abandoned_job" &&
      rpcCalls[0]!.args.p_actor === "qa" &&
      rpcCalls[0]!.args.p_reason === "recovering" &&
      rpcCalls[0]!.args.p_idempotency_key === "reactivate:1"
  );

  rpcCalls = [];
  nextRpcResponse = {
    data: { status: "RESERVED", attempt: { ...ATTEMPT_ROW, id: "a2", retry_of_attempt_id: "a1" }, perplexity_call: CALL_ROW("perplexity"), analysis_call: CALL_ROW("analysis") },
    error: null,
  };
  await supabaseAdapter.retryFullAttemptForJob({
    jobId: "j1", claimToken: "tok", projectId: "p1", sourceAttemptId: "a1",
    perplexityReservedCostUsd: 0.02, analysisReservedCostUsd: 0.02,
  });
  check(
    "Supabase retryFullAttemptForJob: correct RPC name and params",
    rpcCalls[0]!.fn === "retry_full_attempt_for_job" && rpcCalls[0]!.args.p_source_attempt_id === "a1"
  );

  rpcCalls = [];
  nextRpcResponse = { data: { status: "RESERVED", external_call: { ...CALL_ROW("analysis"), generation: 2 } }, error: null };
  await supabaseAdapter.retryAnalysisGenerationForJob({
    jobId: "j1", claimToken: "tok", projectId: "p1", sourceExternalCallId: "call-analysis", reservedCostUsd: 0.02,
  });
  check(
    "Supabase retryAnalysisGenerationForJob: correct RPC name and params",
    rpcCalls[0]!.fn === "retry_analysis_generation_for_job" && rpcCalls[0]!.args.p_source_external_call_id === "call-analysis"
  );

  rpcCalls = [];
  nextRpcResponse = { data: { status: "APPROVED", outcome: "approved", denial_code: null, new_attempt: ATTEMPT_ROW, new_external_call: CALL_ROW("perplexity") }, error: null };
  const supaAuth = await supabaseAdapter.authorizeOperatorRetry({
    jobId: "j1", projectId: "p1", actor: "qa", reason: "test", action: "retry_full_attempt",
    sourceAttemptId: "a1", reservedCostUsd: 0.02, idempotencyKey: "op:1", perplexityReservedCostUsd: 0.02,
  });
  check(
    "Supabase authorizeOperatorRetry: correct RPC name; status/outcome kept as two distinct fields, never collapsed",
    rpcCalls[0]!.fn === "authorize_operator_retry" &&
      rpcCalls[0]!.args.p_idempotency_key === "op:1" &&
      supaAuth.status === "APPROVED" &&
      supaAuth.outcome === "approved"
  );

  rpcCalls = [];
  nextRpcResponse = {
    data: {
      status: "OK", job: JOB_ROW, protocol: null, current_attempt: ATTEMPT_ROW,
      external_calls: [CALL_ROW("perplexity"), CALL_ROW("analysis")],
      provider_receipts: [], analysis_receipts: [], probe_run: null,
    },
    error: null,
  };
  const supaCtx = await supabaseAdapter.getProtocolExecutionJobContext({
    jobId: "j1", claimToken: "tok", projectId: "p1",
  });
  check(
    "Supabase getProtocolExecutionJobContext: correct RPC name; composite arrays mapped element-by-element",
    rpcCalls[0]!.fn === "get_protocol_execution_job_context" &&
      supaCtx.outcome === "OK" &&
      supaCtx.externalCalls.length === 2 &&
      supaCtx.externalCalls[0]!.callKind === "perplexity"
  );

  rpcCalls = [];
  nextRpcResponse = { data: { status: "NEEDS_REVIEW", job: { ...JOB_ROW, status: "needs_review", needs_review_reason: "ambiguous_external_call_sent_without_receipt" } }, error: null };
  const supaNr = await supabaseAdapter.markProtocolExecutionJobNeedsReviewForAmbiguity({
    jobId: "j1", claimToken: "tok", projectId: "p1",
  });
  check(
    "Supabase markProtocolExecutionJobNeedsReviewForAmbiguity: correct RPC name; needsReviewReason mapped",
    rpcCalls[0]!.fn === "mark_protocol_execution_job_needs_review_for_ambiguity" &&
      supaNr.outcome === "NEEDS_REVIEW" &&
      supaNr.job?.needsReviewReason === "ambiguous_external_call_sent_without_receipt"
  );

  __setSupabaseAdapterClientForTests(null);

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "M5-2 Stage A adapter contract PASSED." : "M5-2 Stage A adapter contract FAILED.")
  );
  console.log(
    "\nStage A only: types + adapters. No worker, no CLI wiring, no provider\n" +
      "integration, no Docker, no real Supabase, no staging/Production."
  );
  process.exit(failures === 0 ? 0 : 1);
}

/* -------------------------------------------------------------------------- */
/*  Fixture builders — one small, self-contained scenario per helper, all    */
/*  against the MemoryAdapter's own store, no cross-contamination.           */
/* -------------------------------------------------------------------------- */

async function setupProjectProtocol(
  db: DbAdapter,
  tag: string,
  retryCap = 2
): Promise<{ projectId: string; protocolId: string }> {
  const project = await db.createProject({ domain: `${tag}.example.test` });
  const question = await db.createBuyerQuestion({ projectId: project.id });
  const version = await db.createBuyerQuestionVersion({
    buyerQuestionId: question.id,
    projectId: project.id,
    versionNumber: 1,
    promptText: `Fixture prompt for ${tag}`,
    promptHash: "a".repeat(64),
    intentType: "comparison",
    commercialValue: 3,
    winnability: 3,
    priority: 10,
    rationale: "fixture",
    provenance: "founder_supplied",
  });
  await db.approveBuyerQuestionVersion({
    versionId: version.id,
    projectId: project.id,
    approvedBy: "11111111-1111-4111-8111-111111111111",
  });
  const protocol = await db.createProtocol({
    ...PROTOCOL_FIXTURE,
    retryCap,
    projectId: project.id,
    buyerQuestionVersionId: version.id,
  });
  await db.approveProtocol({
    protocolId: protocol.id,
    projectId: project.id,
    approvedBy: "11111111-1111-4111-8111-111111111111",
  });
  return { projectId: project.id, protocolId: protocol.id };
}

async function claimFreshJob(
  db: DbAdapter,
  projectId: string,
  protocolId: string,
  workerId: string
): Promise<{ jobId: string; claimToken: string }> {
  const enqueued = await db.enqueueProtocolExecutionJob({ protocolId, projectId });
  const jobId = must(enqueued.job, "enqueued job").id;
  const claimed = await db.claimProtocolExecutionJob({ workerId, leaseSeconds: 300 });
  // claim_protocol_execution_job claims the oldest eligible job GLOBALLY
  // (by design -- it takes no job filter, matching the real RPC). This
  // assertion converts a fixture-isolation mistake (a leftover queued job
  // from an earlier, unrelated scenario) into a loud, immediate failure
  // instead of a silently wrong job/claimToken pair.
  if (claimed.job?.id !== jobId) {
    throw new Error(
      `claimFreshJob: claimed job id ${claimed.job?.id} does not match freshly enqueued job id ${jobId} (workerId=${workerId}) -- ` +
        "a prior fixture must have left an eligible job behind (e.g. an approved operator retry re-queues its job); drain it explicitly before building the next fixture."
    );
  }
  return { jobId, claimToken: must(claimed.claimToken, "claim token") };
}

/** A job whose current attempt is fully terminal-failed: eligible for retry_full_attempt_for_job. */
async function buildFailedAttemptFixture(
  db: DbAdapter,
  tag: string
): Promise<{ jobId: string; claimToken: string; projectId: string; attemptId: string }> {
  const { projectId, protocolId } = await setupProjectProtocol(db, tag);
  const { jobId, claimToken } = await claimFreshJob(db, projectId, protocolId, `${tag}-worker`);
  const admit = await db.admitAndReserveAttemptForJob({
    jobId, claimToken, projectId, attemptKind: "baseline",
    idempotencyKey: `${jobId}:baseline:1`, perplexityReservedCostUsd: 0.01, analysisReservedCostUsd: 0.01,
  });
  const attempt = must(admit.attempt, `${tag} attempt`);
  const perplexityCall = must(admit.perplexityCall, `${tag} perplexity call`);
  const analysisCall = must(admit.analysisCall, `${tag} analysis call`);
  const start = await db.createProbeRunAndStartAttemptForJob({
    jobId, claimToken, projectId, attemptId: attempt.id,
    platform: "perplexity", probeMode: "simulated",
    datasetId: "44444444-4444-4444-8444-444444444444", datasetSourceType: "manual_scan",
  });
  const probeRunId = must(start.probeRun, `${tag} probe run`).id;
  await db.markExternalCallSentForJob({ jobId, claimToken, projectId, externalCallId: perplexityCall.id, probeRunId });
  await db.recordProviderCallReceiptForJob({
    jobId, claimToken, projectId, externalCallId: perplexityCall.id, probeRunId, outcome: "provider_error",
  });
  await db.markExternalCallSentForJob({ jobId, claimToken, projectId, externalCallId: analysisCall.id, probeRunId });
  await db.recordAnalysisCallReceiptForJob({
    jobId, claimToken, projectId, externalCallId: analysisCall.id, probeRunId, outcome: "provider_error",
  });
  await db.reconcileAttemptForJob({ jobId, claimToken, projectId, attemptId: attempt.id, status: "failed" });
  return { jobId, claimToken, projectId, attemptId: attempt.id };
}

/** Perplexity completed, analysis gen1 failed, attempt left in_progress: eligible for retry_analysis_generation_for_job. */
async function buildAnalysisRetryFixture(
  db: DbAdapter,
  tag: string
): Promise<{ jobId: string; claimToken: string; projectId: string; analysisCallId: string }> {
  const { projectId, protocolId } = await setupProjectProtocol(db, tag, 1);
  const { jobId, claimToken } = await claimFreshJob(db, projectId, protocolId, `${tag}-worker`);
  const admit = await db.admitAndReserveAttemptForJob({
    jobId, claimToken, projectId, attemptKind: "baseline",
    idempotencyKey: `${jobId}:baseline:1`, perplexityReservedCostUsd: 0.01, analysisReservedCostUsd: 0.01,
  });
  const attempt = must(admit.attempt, `${tag} attempt`);
  const perplexityCall = must(admit.perplexityCall, `${tag} perplexity call`);
  const analysisCall = must(admit.analysisCall, `${tag} analysis call`);
  const start = await db.createProbeRunAndStartAttemptForJob({
    jobId, claimToken, projectId, attemptId: attempt.id,
    platform: "perplexity", probeMode: "simulated",
    datasetId: "44444444-4444-4444-8444-444444444444", datasetSourceType: "manual_scan",
  });
  const probeRunId = must(start.probeRun, `${tag} probe run`).id;
  await db.markExternalCallSentForJob({ jobId, claimToken, projectId, externalCallId: perplexityCall.id, probeRunId });
  await db.recordProviderCallReceiptForJob({
    jobId, claimToken, projectId, externalCallId: perplexityCall.id, probeRunId, outcome: "success",
  });
  await db.markExternalCallSentForJob({ jobId, claimToken, projectId, externalCallId: analysisCall.id, probeRunId });
  await db.recordAnalysisCallReceiptForJob({
    jobId, claimToken, projectId, externalCallId: analysisCall.id, probeRunId, outcome: "provider_error",
  });
  // Attempt deliberately left in_progress (never reconciled) --
  // _reserve_additional_analysis_generation_core requires it.
  return { jobId, claimToken, projectId, analysisCallId: analysisCall.id };
}

/** A needs_review job with one in_progress attempt, for authorize_operator_retry. */
async function buildNeedsReviewFixture(
  db: DbAdapter,
  tag: string
): Promise<{ jobId: string; projectId: string; attemptId: string }> {
  const { projectId, protocolId } = await setupProjectProtocol(db, tag, 1);
  const { jobId, claimToken } = await claimFreshJob(db, projectId, protocolId, `${tag}-worker`);
  const admit = await db.admitAndReserveAttemptForJob({
    jobId, claimToken, projectId, attemptKind: "baseline",
    idempotencyKey: `${jobId}:baseline:1`, perplexityReservedCostUsd: 0.01, analysisReservedCostUsd: 0.01,
  });
  const attempt = must(admit.attempt, `${tag} attempt`);
  const perplexityCall = must(admit.perplexityCall, `${tag} perplexity call`);
  const start = await db.createProbeRunAndStartAttemptForJob({
    jobId, claimToken, projectId, attemptId: attempt.id,
    platform: "perplexity", probeMode: "simulated",
    datasetId: "44444444-4444-4444-8444-444444444444", datasetSourceType: "manual_scan",
  });
  const probeRunId = must(start.probeRun, `${tag} probe run`).id;
  await db.markExternalCallSentForJob({ jobId, claimToken, projectId, externalCallId: perplexityCall.id, probeRunId });
  await db.recordProviderCallReceiptForJob({
    jobId, claimToken, projectId, externalCallId: perplexityCall.id, probeRunId, outcome: "provider_outcome_unknown",
  });
  // The receipt RPC itself already transitioned the job to needs_review.
  return { jobId, projectId, attemptId: attempt.id };
}

/** A job whose current attempt has one external call sent but never receipted (simulated crash/reclaim). */
async function buildAmbiguousFixture(
  db: DbAdapter,
  tag: string
): Promise<{ jobId: string; claimToken: string; projectId: string }> {
  const { projectId, protocolId } = await setupProjectProtocol(db, tag);
  const { jobId, claimToken } = await claimFreshJob(db, projectId, protocolId, `${tag}-worker`);
  const admit = await db.admitAndReserveAttemptForJob({
    jobId, claimToken, projectId, attemptKind: "baseline",
    idempotencyKey: `${jobId}:baseline:1`, perplexityReservedCostUsd: 0.01, analysisReservedCostUsd: 0.01,
  });
  const attempt = must(admit.attempt, `${tag} attempt`);
  const perplexityCall = must(admit.perplexityCall, `${tag} perplexity call`);
  const start = await db.createProbeRunAndStartAttemptForJob({
    jobId, claimToken, projectId, attemptId: attempt.id,
    platform: "perplexity", probeMode: "simulated",
    datasetId: "44444444-4444-4444-8444-444444444444", datasetSourceType: "manual_scan",
  });
  const probeRunId = must(start.probeRun, `${tag} probe run`).id;
  // Sent, then never receipted -- exactly the crash/reclaim shape.
  await db.markExternalCallSentForJob({ jobId, claimToken, projectId, externalCallId: perplexityCall.id, probeRunId });
  return { jobId, claimToken, projectId };
}

/** A healthy, running job with nothing ambiguous. */
async function buildHealthyRunningFixture(
  db: DbAdapter,
  tag: string
): Promise<{ jobId: string; claimToken: string; projectId: string }> {
  const { projectId, protocolId } = await setupProjectProtocol(db, tag);
  const { jobId, claimToken } = await claimFreshJob(db, projectId, protocolId, `${tag}-worker`);
  await db.admitAndReserveAttemptForJob({
    jobId, claimToken, projectId, attemptKind: "baseline",
    idempotencyKey: `${jobId}:baseline:1`, perplexityReservedCostUsd: 0.01, analysisReservedCostUsd: 0.01,
  });
  return { jobId, claimToken, projectId };
}

/** A job whose lease has expired and whose attempt count is already exhausted -> abandoned_exhausted after a claim sweep. */
/**
 * `claim_protocol_execution_job` (real RPC and this adapter alike) rejects
 * `leaseSeconds <= 0` outright, so an expired lease cannot be constructed
 * through the public contract alone. Directly patching the in-process
 * store to backdate `leaseExpiresAt` is the same established pattern
 * scripts/test-snapshot-worker-claim.ts already uses for the identical
 * problem (forcing an otherwise-unreachable expired-lease state) --
 * test-only, never how production code would touch this data.
 */
function forceLeaseExpired(jobId: string): void {
  const g = globalThis as unknown as Record<
    string,
    { protocolExecutionJobs: Map<string, { leaseExpiresAt: string | null }> } | undefined
  >;
  const jobs = g["__zypact_memory_store__"]?.protocolExecutionJobs;
  const job = jobs?.get(jobId);
  if (!job) throw new Error(`forceLeaseExpired: job ${jobId} not found in the memory store`);
  jobs!.set(jobId, { ...job, leaseExpiresAt: new Date(Date.now() - 60_000).toISOString() });
}

/**
 * Directly inserts a `protocol_operator_actions` row simulating a
 * DIFFERENT operator action type (e.g. `retry_full_attempt`) already
 * having used this exact `(project_id, job_id, idempotency_key)` triple
 * -- the unique constraint has no `action` column, so this is the
 * realistic collision `reactivate_abandoned_job`'s IDEMPOTENCY_KEY_CONFLICT
 * branch defends against. Its fingerprint is deliberately unrelated to
 * reactivate_abandoned_job's own job_id/project_id/action formula, so a
 * real (not fabricated) mismatch is what triggers the conflict.
 */
function insertFakeOperatorAction(jobId: string, projectId: string, idempotencyKey: string): void {
  const g = globalThis as unknown as Record<
    string,
    { protocolOperatorActions: Map<string, Record<string, unknown>> } | undefined
  >;
  const actions = g["__zypact_memory_store__"]?.protocolOperatorActions;
  if (!actions) throw new Error("insertFakeOperatorAction: store not initialized");
  const id = `fake-${jobId}-${idempotencyKey}`;
  actions.set(id, {
    id,
    projectId,
    jobId,
    actor: "qa",
    reason: "an unrelated, earlier operator decision",
    action: "retry_full_attempt",
    outcome: "denied",
    denialCode: "SPEND_CAP_EXCEEDED",
    idempotencyKey,
    requestFingerprint: "0".repeat(64),
    newAttemptId: null,
    newExternalCallId: null,
    createdAt: new Date().toISOString(),
  });
}

async function buildAbandonedFixture(
  db: DbAdapter,
  tag: string
): Promise<{ jobId: string; projectId: string }> {
  const { projectId, protocolId } = await setupProjectProtocol(db, tag);
  const enqueued = await db.enqueueProtocolExecutionJob({ protocolId, projectId, maxAttempts: 1 });
  const jobId = must(enqueued.job, "enqueued job").id;
  const claimed = await db.claimProtocolExecutionJob({ workerId: `${tag}-worker`, leaseSeconds: 300 });
  if (claimed.job?.id !== jobId) {
    throw new Error(`buildAbandonedFixture: claimed job id ${claimed.job?.id} does not match ${jobId}`);
  }
  forceLeaseExpired(jobId);
  // Lease now in the past and attemptCount (1) >= maxAttempts (1) -- the
  // next claim's sweep step moves this exact job to abandoned_exhausted.
  await db.claimProtocolExecutionJob({ workerId: `${tag}-worker-2`, leaseSeconds: 300 });
  return { jobId, projectId };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
