#!/usr/bin/env tsx
/**
 * M5-A — the three closed failure transitions.
 *
 * Before 0056 a failed run could not actually be closed. After a provider
 * error the analysis leg stayed `reserved`, so `reconcile_attempt_for_job`
 * answered EXTERNAL_CALLS_NOT_TERMINAL for ever, and
 * `fail_protocol_execution_job` touched neither the calls nor the attempt.
 *
 *   T1  unknown outcome  — inside the receipt RPC's own transaction
 *   T2  no attempt yet   — caps refused before admission created anything
 *   T3  attempt exists   — cancel unsent legs, terminalise, close
 */

Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { sha256Hex } from "@/lib/evidence/hash";
import type { CreateProtocolInput, DbAdapter } from "@/lib/db/types";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else { failures += 1; console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function must<T>(v: T | null | undefined, l: string): T {
  if (v === null || v === undefined) throw new Error(`missing ${l}`);
  return v;
}

const APPROVER = "11111111-1111-4111-8111-111111111111";
const BODY = JSON.stringify({ id: "r", choices: [{ message: { content: "answer" } }] });
const PERPLEXITY_REQ = JSON.stringify({ model: "sonar", messages: [] });
const PROTOCOL: Omit<CreateProtocolInput, "projectId" | "buyerQuestionVersionId"> = {
  provider: "perplexity", surface: "sonar", plannedBaselineRuns: 1, plannedRetestRuns: 0,
  paraphrasePlan: [{ text: "Q?", hash: "b".repeat(64) }], unitOfAnalysis: "run",
  primaryMetric: "listed_in_run", samplePlanningMethod: "fixed", runCap: 20, spendCapUsd: 100,
  timeWindowSeconds: 3600, rateLimitPerHour: 100, concurrencyLimit: 5, retryCap: 2,
};

async function main(): Promise<void> {
  const { memoryAdapter } = await import("@/lib/db/memory-adapter");
  const db: DbAdapter = memoryAdapter;
  let seq = 0;

  async function claimedJob() {
    seq += 1;
    const project = await db.createProject({ domain: `abort-${seq}.test`, companyName: "C" });
    const q = await db.createBuyerQuestion({ projectId: project.id });
    const v = await db.createBuyerQuestionVersion({
      buyerQuestionId: q.id, projectId: project.id, versionNumber: 1, promptText: "Q?",
      promptHash: "a".repeat(64), intentType: "comparison", commercialValue: 3, winnability: 3,
      priority: 10, rationale: "f", provenance: "founder_supplied",
    });
    await db.approveBuyerQuestionVersion({ versionId: v.id, projectId: project.id, approvedBy: APPROVER });
    const proto = await db.createProtocol({ ...PROTOCOL, projectId: project.id, buyerQuestionVersionId: v.id });
    await db.approveProtocol({ protocolId: proto.id, projectId: project.id, approvedBy: APPROVER });
    const enq = await db.enqueueProtocolExecutionJob({ protocolId: proto.id, projectId: project.id });
    const jobId = must(enq.job, "job").id;
    let c = await db.claimProtocolExecutionJob({ workerId: `w-${seq}`, leaseSeconds: 300 });
    while (c.job && c.job.id !== jobId) {
      await db.failProtocolExecutionJob({
        jobId: c.job.id, claimToken: must(c.claimToken, "t"), projectId: c.job.projectId, reason: "skip",
      });
      c = await db.claimProtocolExecutionJob({ workerId: `w-${seq}`, leaseSeconds: 300 });
    }
    return { f: { jobId, claimToken: must(c.claimToken, "t"), projectId: project.id }, job: must(c.job, "j") };
  }

  async function withAttempt() {
    const { f, job } = await claimedJob();
    const ad = await db.admitAndReserveAttemptForJob({
      ...f, attemptKind: "baseline", idempotencyKey: `${f.jobId}:baseline:${job.nextBaselineOrdinal}`,
      perplexityReservedCostUsd: 0.02, analysisReservedCostUsd: 0.02,
    });
    const st = await db.createProbeRunAndStartAttemptForJob({
      ...f, attemptId: must(ad.attempt, "a").id, platform: "perplexity", probeMode: "live_perplexity",
    });
    return {
      f,
      attemptId: must(ad.attempt, "a").id,
      probeRunId: must(st.probeRun, "pr").id,
      perplexityCall: must(ad.perplexityCall, "p").id,
      analysisCall: must(ad.analysisCall, "an").id,
    };
  }

  // ======================================================================
  console.log("[T2] caps refused before any attempt exists");
  // ======================================================================
  for (const [reason, status] of [
    ["run_cap_exceeded", "failed"],
    ["spend_cap_exceeded", "failed"],
    ["retry_cap_exceeded", "failed"],
    ["throttled_retries_exhausted", "needs_review"],
    ["slot_budget_exhausted", "needs_review"],
  ] as const) {
    const { f } = await claimedJob();
    const r = await db.failJobWithoutAttemptForJob({ ...f, reason });
    check(`${reason} -> CLOSED as ${status}`, r.outcome === "CLOSED" && r.job?.status === status, `${r.outcome}/${r.job?.status}`);
    const replay = await db.failJobWithoutAttemptForJob({ ...f, reason });
    check(`${reason} replay -> ALREADY_CLOSED`, replay.outcome === "ALREADY_CLOSED", replay.outcome);
  }
  {
    const { f } = await claimedJob();
    const a = await db.failJobWithoutAttemptForJob({ ...f, reason: "run_cap_exceeded" });
    check("first close succeeds", a.outcome === "CLOSED");
    const other = await db.failJobWithoutAttemptForJob({ ...f, reason: "spend_cap_exceeded" });
    check("a DIFFERENT reason on a closed job -> STATE_CONFLICT", other.outcome === "STATE_CONFLICT", other.outcome);
  }
  {
    const w = await withAttempt();
    const r = await db.failJobWithoutAttemptForJob({ ...w.f, reason: "run_cap_exceeded" });
    check(
      "T2 refuses while an attempt is open; the caller must use T3",
      r.outcome === "ATTEMPT_STILL_OPEN",
      r.outcome
    );
  }

  // ======================================================================
  console.log("\n[T3] an attempt exists");
  // ======================================================================
  {
    const w = await withAttempt();
    // The perplexity leg went out and failed; the analysis leg never did.
    await db.markExternalCallSentForJob({
      ...w.f, externalCallId: w.perplexityCall, probeRunId: w.probeRunId,
      callKind: "perplexity", requestBody: PERPLEXITY_REQ, requestBodySha256: sha256Hex(PERPLEXITY_REQ),
    });
    await db.recordProviderCallReceiptForJob({
      ...w.f, externalCallId: w.perplexityCall, probeRunId: w.probeRunId, outcome: "provider_error",
      httpStatus: 500, providerRequestId: null, rawResponseSha256: sha256Hex(BODY), latencyMs: 10,
      rawResponseBody: BODY,
    });

    const beforeReconcile = await db.reconcileAttemptForJob({
      ...w.f, attemptId: w.attemptId, status: "failed",
    });
    check(
      "reconcile alone still cannot close it — the analysis leg is reserved",
      beforeReconcile.outcome === "EXTERNAL_CALLS_NOT_TERMINAL",
      beforeReconcile.outcome
    );

    const r = await db.abortAttemptAndFailJobForJob({
      ...w.f, attemptId: w.attemptId, attemptStatus: "failed",
      terminationReason: "provider_error", failureReason: "provider_error",
    });
    check("T3 -> ABORTED", r.outcome === "ABORTED", r.outcome);
    check("the attempt is terminal", r.attempt?.status === "failed" && r.attempt?.terminalizedAt !== null);
    check("the job is failed with its reason", r.job?.status === "failed" && r.job?.failureReason === "provider_error");

    const replay = await db.abortAttemptAndFailJobForJob({
      ...w.f, attemptId: w.attemptId, attemptStatus: "failed",
      terminationReason: "provider_error", failureReason: "provider_error",
    });
    check("an exact replay -> ALREADY_ABORTED", replay.outcome === "ALREADY_ABORTED", replay.outcome);

    const divergent = await db.abortAttemptAndFailJobForJob({
      ...w.f, attemptId: w.attemptId, attemptStatus: "cancelled",
      terminationReason: "other", failureReason: "other",
    });
    check("a divergent replay -> STATE_CONFLICT", divergent.outcome === "STATE_CONFLICT", divergent.outcome);
  }
  {
    const w = await withAttempt();
    // A leg that is genuinely in flight may not be cancelled: its receipt
    // is the only thing that may terminalise it.
    await db.markExternalCallSentForJob({
      ...w.f, externalCallId: w.perplexityCall, probeRunId: w.probeRunId,
      callKind: "perplexity", requestBody: PERPLEXITY_REQ, requestBodySha256: sha256Hex(PERPLEXITY_REQ),
    });
    const r = await db.abortAttemptAndFailJobForJob({
      ...w.f, attemptId: w.attemptId, attemptStatus: "failed",
      terminationReason: "x", failureReason: "x",
    });
    check("T3 refuses while a call is in flight", r.outcome === "CALL_STILL_IN_PROGRESS", r.outcome);
    check("nothing was terminalised", r.attempt?.terminalizedAt === null);
  }

  // ======================================================================
  console.log("\n[T1] an unknown outcome closes everything, in one call");
  // ======================================================================
  {
    const w = await withAttempt();
    await db.markExternalCallSentForJob({
      ...w.f, externalCallId: w.perplexityCall, probeRunId: w.probeRunId,
      callKind: "perplexity", requestBody: PERPLEXITY_REQ, requestBodySha256: sha256Hex(PERPLEXITY_REQ),
    });
    const rec = await db.recordProviderCallReceiptForJob({
      ...w.f, externalCallId: w.perplexityCall, probeRunId: w.probeRunId,
      outcome: "provider_outcome_unknown", httpStatus: null, providerRequestId: null,
      rawResponseSha256: null, latencyMs: 10, rawResponseBody: null,
    });
    check("the receipt is recorded", rec.outcome === "RECEIPTED", rec.outcome);

    // Everything below must already be true, with no second application call.
    const ctx = await db.getProtocolExecutionJobContext(w.f);
    check("the job left the live states", ctx.outcome === "JOB_NOT_OWNED", ctx.outcome);
  }

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "M5-A abort and cancel PASSED." : "M5-A abort and cancel FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
