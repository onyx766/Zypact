#!/usr/bin/env tsx
/**
 * M5-A — receipt identity, field by field.
 *
 * CONFLICT alone never said whether the same RPC had been replayed after
 * losing its reply, or whether a second provider call had happened. The
 * identity comparison now covers every evidentiary field. Latency and
 * cost are included deliberately: idempotence means replaying the SAME
 * call with the SAME parameters, and a second provider call cannot
 * reproduce a latency — so it must conflict rather than pass as a replay.
 */

Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { sha256Hex } from "@/lib/evidence/hash";
import type {
  CreateProtocolInput, DbAdapter,
  RecordAnalysisCallReceiptForJobInput, RecordProviderCallReceiptForJobInput,
} from "@/lib/db/types";

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
const ANALYSIS_REQ = JSON.stringify({ model: "gpt-4o-mini", messages: [] });
const CONTENT = JSON.stringify({ clientPosition: "absent", competitorsMentioned: [], sourcesCited: [], answerSummary: "" });

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

  /** A job driven to "both legs marked sent", ready to receive receipts. */
  async function armed() {
    seq += 1;
    const project = await db.createProject({ domain: `identity-${seq}.test`, companyName: "C" });
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
    let claimed = await db.claimProtocolExecutionJob({ workerId: `w-${seq}`, leaseSeconds: 300 });
    while (claimed.job && claimed.job.id !== jobId) {
      await db.failProtocolExecutionJob({
        jobId: claimed.job.id, claimToken: must(claimed.claimToken, "t"),
        projectId: claimed.job.projectId, reason: "skip",
      });
      claimed = await db.claimProtocolExecutionJob({ workerId: `w-${seq}`, leaseSeconds: 300 });
    }
    const f = { jobId, claimToken: must(claimed.claimToken, "t"), projectId: project.id };
    const ad = await db.admitAndReserveAttemptForJob({
      ...f, attemptKind: "baseline",
      idempotencyKey: `${jobId}:baseline:${must(claimed.job, "j").nextBaselineOrdinal}`,
      perplexityReservedCostUsd: 0.02, analysisReservedCostUsd: 0.02,
    });
    const st = await db.createProbeRunAndStartAttemptForJob({
      ...f, attemptId: must(ad.attempt, "a").id, platform: "perplexity", probeMode: "live_perplexity",
    });
    const probeRunId = must(st.probeRun, "pr").id;
    const perplexityCall = must(ad.perplexityCall, "p").id;
    const analysisCall = must(ad.analysisCall, "a").id;
    await db.markExternalCallSentForJob({
      ...f, externalCallId: perplexityCall, probeRunId, callKind: "perplexity",
      requestBody: PERPLEXITY_REQ, requestBodySha256: sha256Hex(PERPLEXITY_REQ),
    });
    await db.markExternalCallSentForJob({
      ...f, externalCallId: analysisCall, probeRunId, callKind: "analysis",
      requestBody: ANALYSIS_REQ, requestBodySha256: sha256Hex(ANALYSIS_REQ),
    });
    return { f, probeRunId, perplexityCall, analysisCall };
  }

  const providerReceipt = (
    f: { jobId: string; claimToken: string; projectId: string },
    externalCallId: string,
    probeRunId: string
  ): RecordProviderCallReceiptForJobInput => ({
    ...f, externalCallId, probeRunId, outcome: "success", httpStatus: 200,
    providerRequestId: "req-1", rawResponseSha256: sha256Hex(BODY), latencyMs: 120,
    actualCostUsd: 0.01, costBasis: "measured", rawResponseBody: BODY,
  });

  const analysisReceipt = (
    f: { jobId: string; claimToken: string; projectId: string },
    externalCallId: string,
    probeRunId: string
  ): RecordAnalysisCallReceiptForJobInput => ({
    ...f, externalCallId, probeRunId, outcome: "success", provider: "openai",
    model: "gpt-4o-mini", usedMock: false, requestSha256: sha256Hex(ANALYSIS_REQ),
    responseSha256: sha256Hex(CONTENT), latencyMs: 90, actualCostUsd: 0.002,
    costBasis: "measured", rawContent: CONTENT, rawRequestBody: ANALYSIS_REQ,
  });

  // ======================================================================
  console.log("[1] provider leg — an exact replay is idempotent");
  // ======================================================================
  {
    const a = await armed();
    const first = await db.recordProviderCallReceiptForJob(providerReceipt(a.f, a.perplexityCall, a.probeRunId));
    check("first receipt -> RECEIPTED", first.outcome === "RECEIPTED", first.outcome);
    const replay = await db.recordProviderCallReceiptForJob(providerReceipt(a.f, a.perplexityCall, a.probeRunId));
    check("identical replay -> ALREADY_RECEIPTED_IDENTICAL", replay.outcome === "ALREADY_RECEIPTED_IDENTICAL", replay.outcome);
    check("…and the DURABLE receipt is returned, not the one in hand", replay.receipt?.id === first.receipt?.id);
  }

  // ======================================================================
  console.log("\n[2] provider leg — every field is part of the identity");
  // ======================================================================
  const providerMutations: Array<[string, (i: RecordProviderCallReceiptForJobInput) => RecordProviderCallReceiptForJobInput]> = [
    ["outcome", (i) => ({ ...i, outcome: "provider_error" as const })],
    ["httpStatus", (i) => ({ ...i, httpStatus: 500 })],
    ["providerRequestId", (i) => ({ ...i, providerRequestId: "req-2" })],
    ["latencyMs", (i) => ({ ...i, latencyMs: 121 })],
    ["actualCostUsd", (i) => ({ ...i, actualCostUsd: 0.02 })],
    ["costBasis", (i) => ({ ...i, costBasis: "estimated" })],
    ["rawResponseBody", (i) => {
      const other = JSON.stringify({ id: "r2", choices: [{ message: { content: "different" } }] });
      return { ...i, rawResponseBody: other, rawResponseSha256: sha256Hex(other) };
    }],
  ];
  for (const [field, mutate] of providerMutations) {
    const a = await armed();
    await db.recordProviderCallReceiptForJob(providerReceipt(a.f, a.perplexityCall, a.probeRunId));
    const second = await db.recordProviderCallReceiptForJob(
      mutate(providerReceipt(a.f, a.perplexityCall, a.probeRunId))
    );
    check(
      `a different ${field} conflicts, never passes as a replay`,
      second.outcome === "RECEIPT_EVIDENCE_CONFLICT",
      second.outcome
    );
    const job = await db.getProtocolExecutionJobContext(a.f);
    check(`…and the job is under review, not silently continued (${field})`, job.outcome === "JOB_NOT_OWNED" || job.job?.status === "needs_review");
  }

  // ======================================================================
  console.log("\n[3] analysis leg — same rule, same fields");
  // ======================================================================
  {
    const a = await armed();
    const first = await db.recordAnalysisCallReceiptForJob(analysisReceipt(a.f, a.analysisCall, a.probeRunId));
    check("first receipt -> RECEIPTED", first.outcome === "RECEIPTED", first.outcome);
    const replay = await db.recordAnalysisCallReceiptForJob(analysisReceipt(a.f, a.analysisCall, a.probeRunId));
    check("identical replay -> ALREADY_RECEIPTED_IDENTICAL", replay.outcome === "ALREADY_RECEIPTED_IDENTICAL", replay.outcome);
    check("the durable receipt is returned", replay.receipt?.id === first.receipt?.id);
  }
  const analysisMutations: Array<[string, (i: RecordAnalysisCallReceiptForJobInput) => RecordAnalysisCallReceiptForJobInput]> = [
    ["model", (i) => ({ ...i, model: "gpt-4o" })],
    ["latencyMs", (i) => ({ ...i, latencyMs: 91 })],
    ["actualCostUsd", (i) => ({ ...i, actualCostUsd: 0.003 })],
    ["rawContent", (i) => {
      const other = JSON.stringify({ clientPosition: "listed", competitorsMentioned: [], sourcesCited: [], answerSummary: "x" });
      return { ...i, rawContent: other, responseSha256: sha256Hex(other) };
    }],
  ];
  for (const [field, mutate] of analysisMutations) {
    const a = await armed();
    await db.recordAnalysisCallReceiptForJob(analysisReceipt(a.f, a.analysisCall, a.probeRunId));
    const second = await db.recordAnalysisCallReceiptForJob(
      mutate(analysisReceipt(a.f, a.analysisCall, a.probeRunId))
    );
    check(`a different ${field} conflicts`, second.outcome === "RECEIPT_EVIDENCE_CONFLICT", second.outcome);
  }

  // ======================================================================
  console.log("\n[4] two durable proofs of one request may never contradict");
  // ======================================================================
  {
    const a = await armed();
    const other = JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "different" }] });
    const bad = await db.recordAnalysisCallReceiptForJob({
      ...analysisReceipt(a.f, a.analysisCall, a.probeRunId),
      rawRequestBody: other,
      requestSha256: sha256Hex(other),
    });
    check(
      "a receipt whose request differs from the recorded evidence -> REQUEST_EVIDENCE_CONFLICT",
      bad.outcome === "REQUEST_EVIDENCE_CONFLICT",
      bad.outcome
    );
    check("no receipt was written", bad.receipt === null);
  }

  // ======================================================================
  console.log("\n[5] the marking RPC itself distinguishes replay from divergence");
  // ======================================================================
  {
    const a = await armed();
    const replay = await db.markExternalCallSentForJob({
      ...a.f, externalCallId: a.perplexityCall, probeRunId: a.probeRunId,
      callKind: "perplexity", requestBody: PERPLEXITY_REQ, requestBodySha256: sha256Hex(PERPLEXITY_REQ),
    });
    check(
      "re-marking with the SAME body -> ALREADY_SENT_SAME_EVIDENCE",
      replay.outcome === "ALREADY_SENT_SAME_EVIDENCE",
      replay.outcome
    );

    const b = await armed();
    const other = JSON.stringify({ model: "sonar", messages: [{ role: "user", content: "different" }] });
    const diverged = await db.markExternalCallSentForJob({
      ...b.f, externalCallId: b.perplexityCall, probeRunId: b.probeRunId,
      callKind: "perplexity", requestBody: other, requestBodySha256: sha256Hex(other),
    });
    check(
      "re-marking with a DIFFERENT body -> REQUEST_EVIDENCE_CONFLICT",
      diverged.outcome === "REQUEST_EVIDENCE_CONFLICT",
      diverged.outcome
    );

    const c = await armed();
    const wrongKind = await db.markExternalCallSentForJob({
      ...c.f, externalCallId: c.perplexityCall, probeRunId: c.probeRunId,
      callKind: "analysis", requestBody: PERPLEXITY_REQ, requestBodySha256: sha256Hex(PERPLEXITY_REQ),
    });
    check("a mismatched call kind -> WRONG_CALL_KIND", wrongKind.outcome === "WRONG_CALL_KIND", wrongKind.outcome);

    const d = await armed();
    let threw = false;
    try {
      await db.markExternalCallSentForJob({
        ...d.f, externalCallId: d.perplexityCall, probeRunId: d.probeRunId,
        callKind: "perplexity", requestBody: PERPLEXITY_REQ, requestBodySha256: "0".repeat(64),
      });
    } catch { threw = true; }
    check("a hash that does not cover the body is refused outright", threw);
  }

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "M5-A conflict identity PASSED." : "M5-A conflict identity FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
