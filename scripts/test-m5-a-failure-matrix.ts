#!/usr/bin/env tsx
/**
 * M5-A — every failure path ends somewhere closed.
 *
 * One row per way a run can go wrong, and for each one: is a receipt
 * owed, does the attempt get terminalised, and where does the job land.
 * Nothing here may end in a state that reconcile can never close.
 */

Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { sha256Hex } from "@/lib/evidence/hash";
import { CallModelFailure } from "@/lib/llm/call-model";
import { PerplexityProbeFailure } from "@/lib/probes/perplexity";
import { runOneIteration } from "@/lib/protocol-worker/worker";

import { WorkerHealth } from "@/lib/protocol-worker/health";
import type { AnalysisTransport, WorkerDeps, WorkerOptions } from "@/lib/protocol-worker/types";
import type { CreateProtocolInput, DbAdapter } from "@/lib/db/types";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else { failures += 1; console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const APPROVER = "11111111-1111-4111-8111-111111111111";
const ANSWER = "Acme Rival and Example Client are both options.";
const REQ = JSON.stringify({ model: "gpt-4o-mini", messages: [] });
const M5 = JSON.stringify({ clientPosition: "absent", competitorsMentioned: [], sourcesCited: [], answerSummary: "" });
const BODY = JSON.stringify({ id: "r", choices: [{ message: { content: ANSWER } }] });

const PROTOCOL: Omit<CreateProtocolInput, "projectId" | "buyerQuestionVersionId"> = {
  provider: "perplexity", surface: "sonar", plannedBaselineRuns: 1, plannedRetestRuns: 0,
  paraphrasePlan: [{ text: "Q?", hash: "b".repeat(64) }], unitOfAnalysis: "run",
  primaryMetric: "listed_in_run", samplePlanningMethod: "fixed", runCap: 20, spendCapUsd: 100,
  timeWindowSeconds: 3600, rateLimitPerHour: 100, concurrencyLimit: 5, retryCap: 2,
};
// A ONE SECOND lease, deliberately. "Not claimable" only proves closure
// once the lease has lapsed: while it is still held, every job looks
// unclaimable, closed or not.
/**
 * B3-intrinsic test double. `runtimeBound` is a REQUIRED worker option, so
 * a suite that is not about the total runtime ceiling has to state that it
 * wants no ceiling — deliberately, in its own file. `lib/` exports no such
 * helper on purpose: an unbounded worker must never be one import away.
 */
const ALWAYS_ALLOWS = { allowsNewClaim: (): boolean => true };

const OPTS: WorkerOptions = {
  workerId: "matrix", leaseSeconds: 1, idleBackoffMs: 1, maxBackoffMs: 2,
  maxSlotsPerClaim: 4, perplexityReservedCostUsd: 0.02, analysisReservedCostUsd: 0.02,
  jitterRatio: 0, maxThrottledRetries: 3, graceMs: 1000,
  exitAfterClaimedJob: false, providerTimeoutMs: 45000,
  runtimeBound: ALWAYS_ALLOWS,
};

function probeFailure(reason: "network_error" | "http_error" | "empty_answer", status: number | null) {
  return new PerplexityProbeFailure("provider failed", {
    reason,
    httpStatus: status,
    errorBody: status === null ? null : BODY,
    errorBodySha256: status === null ? null : sha256Hex(BODY),
    latencyMs: 12,
    providerRequestId: null,
    rawProbeRequestSha256: sha256Hex("prompt"),
    fullRequestBody: JSON.stringify({ model: "sonar" }),
    fullRequestBodySha256: sha256Hex(JSON.stringify({ model: "sonar" })),
  });
}

async function main(): Promise<void> {
  const { memoryAdapter } = await import("@/lib/db/memory-adapter");
  const db: DbAdapter = memoryAdapter;
  let seq = 0;

  async function seed(): Promise<{ jobId: string; projectId: string; protocolId: string }> {
    seq += 1;
    const project = await db.createProject({ domain: `matrix-${seq}.test`, companyName: "C" });
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
    return { jobId: enq.job!.id, projectId: project.id, protocolId: proto.id };
  }

  /**
   * Real proof that a run is closed, not merely unreachable.
   *
   * "Not claimable" on its own proves nothing while the lease is still
   * held — every claimed job looks that way. So the lease is allowed to
   * lapse first, and the attempt is inspected directly: a closed run has
   * a terminalised attempt AND stays unclaimable afterwards.
   */
  async function assertClosed(
    label: string,
    seeded: { jobId: string; projectId: string; protocolId: string }
  ): Promise<void> {
    const attempts = await db.getProtocolAttempts(seeded.protocolId, seeded.projectId);
    check(
      `${label}: the attempt is terminalised`,
      attempts.length > 0 && attempts.every((a) => a.terminalizedAt !== null),
      attempts.map((a) => `${a.status}/${a.terminalizedAt ? "term" : "OPEN"}`).join(",") || "no attempt"
    );
    check(
      `${label}: the attempt carries a terminal status`,
      attempts.every((a) => ["failed", "timed_out", "cancelled", "excluded", "completed"].includes(a.status)),
      attempts.map((a) => a.status).join(",")
    );
    // Let the lease lapse, then try to take the job back.
    await sleep(1200);
    const again = await db.claimProtocolExecutionJob({ workerId: "after-lapse", leaseSeconds: 30 });
    check(
      `${label}: still unclaimable AFTER the lease lapsed — genuinely terminal`,
      again.job?.id !== seeded.jobId,
      `${again.outcome}/${again.job?.id === seeded.jobId ? "RECLAIMED" : "other"}`
    );
    if (again.job) {
      await db.failProtocolExecutionJob({
        jobId: again.job.id, claimToken: again.claimToken!, projectId: again.job.projectId,
        reason: "matrix_teardown",
      });
    }
  }

  function baseDeps(over: Partial<WorkerDeps>): WorkerDeps {
    const analysis: AnalysisTransport = {
      prepare: () => ({
        provider: "openai" as const, model: "gpt-4o-mini",
        url: "https://api.openai.com/v1/chat/completions",
        rawRequestBody: REQ, requestSha256: sha256Hex(REQ),
      }),
      execute: async () => ({
        provider: "openai" as const, model: "gpt-4o-mini", content: M5, usedMock: false,
        modelReturned: null,
        latencyMs: 5, requestSha256: sha256Hex(REQ), contentSha256: sha256Hex(M5),
        providerRequestId: "ana", httpStatus: 200,
      }),
    };
    return {
      db, analysis, now: () => Date.now(), sleep: async () => {}, probeMode: "live_perplexity",
      realFetch: (async () => new Response("{}", { status: 200 })) as typeof fetch,
      runProbe: (async (input: { prompt: string; fetchImpl?: typeof fetch }) => {
        await (input.fetchImpl ?? fetch)("https://api.perplexity.ai/x", { method: "POST", body: "{}" });
        return {
          prompt: input.prompt, answer: ANSWER, rawResponse: BODY, citations: [], searchResults: [],
          sourceCitations: [], model: "sonar", usedMock: false, rawResponseBody: BODY,
          rawResponseBodySha256: sha256Hex(BODY), httpStatus: 200, latencyMs: 7, providerRequestId: "r",
        };
      }) as WorkerDeps["runProbe"],
      ...over,
    };
  }

  console.log("[1] Perplexity failures");
  for (const [label, reason, status, expected] of [
    ["http_error", "http_error", 500, "failed"],
    ["empty_answer", "empty_answer", 200, "failed"],
    ["network_error", "network_error", null, "needs_review_perplexity_unknown"],
  ] as const) {
    const seeded = await seed();
    const deps = baseDeps({
      runProbe: (async (input: { fetchImpl?: typeof fetch }) => {
        await (input.fetchImpl ?? fetch)("https://api.perplexity.ai/x", { method: "POST", body: "{}" });
        throw probeFailure(reason, status);
      }) as WorkerDeps["runProbe"],
    });
    const r = await runOneIteration(deps, OPTS, new WorkerHealth(() => Date.now()));
    check(`${label} -> ${expected}`, r.outcome === expected && r.jobId === seeded.jobId, `${r.outcome}/${r.detail}`);
    await assertClosed(label, seeded);
  }

  console.log("\n[2] Analysis failures");
  for (const [label, reason, expected] of [
    ["http_error", "http_error", "failed"],
    ["malformed_response", "malformed_response", "failed"],
    ["empty_content", "empty_content", "failed"],
    ["network_error", "network_error", "needs_review_analysis_unknown"],
    ["aborted", "aborted", "needs_review_analysis_unknown"],
  ] as const) {
    const seeded = await seed();
    const deps = baseDeps({});
    const failing: WorkerDeps = {
      ...deps,
      analysis: {
        ...deps.analysis,
        execute: async () => {
          throw new CallModelFailure(reason, {
            httpStatus: reason === "http_error" ? 503 : null,
            providerRequestId: null,
            latencyMs: 9,
            requestSha256: sha256Hex(REQ),
          });
        },
      },
    };
    const r = await runOneIteration(failing, OPTS, new WorkerHealth(() => Date.now()));
    check(`analysis ${label} -> ${expected}`, r.outcome === expected && r.jobId === seeded.jobId, `${r.outcome}/${r.detail}`);
    await assertClosed(`analysis ${label}`, seeded);
  }

  console.log("\n[3] Parse failures — the receipt exists first");
  {
    const seeded = await seed();
    const deps = baseDeps({});
    const bad: WorkerDeps = {
      ...deps,
      analysis: {
        ...deps.analysis,
        execute: async () => ({
          provider: "openai" as const, model: "gpt-4o-mini", content: "not json at all {{{",
          usedMock: false, latencyMs: 5, requestSha256: sha256Hex(REQ),
          modelReturned: null,
          contentSha256: sha256Hex("not json at all {{{"), providerRequestId: "ana", httpStatus: 200,
        }),
      },
    };
    const r = await runOneIteration(bad, OPTS, new WorkerHealth(() => Date.now()));
    check("invalid JSON -> parse_failed", r.outcome === "parse_failed" && r.jobId === seeded.jobId, `${r.outcome}/${r.detail}`);
    check("…and the attempt is closed, not left open", (r.detail ?? "").includes("CLOSED"), r.detail ?? "");
    await assertClosed("invalid_json", seeded);
  }
  {
    const seeded = await seed();
    const deps = baseDeps({});
    const extraKey = JSON.stringify({
      clientPosition: "absent", competitorsMentioned: [], sourcesCited: [],
      answerSummary: "", verdict: "won",
    });
    const legacy: WorkerDeps = {
      ...deps,
      analysis: {
        ...deps.analysis,
        execute: async () => ({
          provider: "openai" as const, model: "gpt-4o-mini", content: extraKey, usedMock: false,
          modelReturned: null,
          latencyMs: 5, requestSha256: sha256Hex(REQ), contentSha256: sha256Hex(extraKey),
          providerRequestId: "ana", httpStatus: 200,
        }),
      },
    };
    const r = await runOneIteration(legacy, OPTS, new WorkerHealth(() => Date.now()));
    check(
      "a legacy verdict key -> parse_failed, never silently stripped",
      r.outcome === "parse_failed" && r.jobId === seeded.jobId,
      `${r.outcome}/${r.detail}`
    );
    check("…and the attempt is closed", (r.detail ?? "").includes("CLOSED"), r.detail ?? "");
    await assertClosed("normalization_failed", seeded);
  }

  console.log("\n[4] The happy path still ends completed");
  {
    const seeded = await seed();
    const r = await runOneIteration(baseDeps({}), OPTS, new WorkerHealth(() => Date.now()));
    check("a clean run completes", r.outcome === "completed" && r.jobId === seeded.jobId, `${r.outcome}/${r.detail}`);
    await assertClosed("clean run", seeded);
  }

  // ======================================================================
  console.log("\n[5] Resuming onto a failed receipt buys nothing more");
  // ======================================================================
  //
  // A crash can leave a receipt that records a FAILURE. Resuming must
  // close the run from that receipt — never call the provider or the
  // model again to find out what it already says.

  async function crashedWith(
    kind: "provider" | "analysis"
  ): Promise<{ seeded: Awaited<ReturnType<typeof seed>>; }> {
    const seeded = await seed();
    const c = await db.claimProtocolExecutionJob({ workerId: "crashed", leaseSeconds: 1 });
    const job = c.job!;
    const f = { jobId: job.id, claimToken: c.claimToken!, projectId: seeded.projectId };
    const ad = await db.admitAndReserveAttemptForJob({
      ...f, attemptKind: "baseline",
      idempotencyKey: `${job.id}:baseline:${job.nextBaselineOrdinal}`,
      perplexityReservedCostUsd: 0.02, analysisReservedCostUsd: 0.02,
    });
    const st = await db.createProbeRunAndStartAttemptForJob({
      ...f, attemptId: ad.attempt!.id, platform: "perplexity", probeMode: "live_perplexity",
    });
    const probeRunId = st.probeRun!.id;
    const pReq = JSON.stringify({ model: "sonar", messages: [] });
    await db.markExternalCallSentForJob({
      ...f, externalCallId: ad.perplexityCall!.id, probeRunId,
      callKind: "perplexity", requestBody: pReq, requestBodySha256: sha256Hex(pReq),
    });
    await db.recordProviderCallReceiptForJob({
      ...f, externalCallId: ad.perplexityCall!.id, probeRunId,
      outcome: kind === "provider" ? "provider_error" : "success",
      httpStatus: kind === "provider" ? 500 : 200, providerRequestId: "r",
      rawResponseSha256: sha256Hex(BODY), latencyMs: 5, rawResponseBody: BODY,
    });
    if (kind === "analysis") {
      await db.markExternalCallSentForJob({
        ...f, externalCallId: ad.analysisCall!.id, probeRunId,
        callKind: "analysis", requestBody: REQ, requestBodySha256: sha256Hex(REQ),
      });
      await db.recordAnalysisCallReceiptForJob({
        ...f, externalCallId: ad.analysisCall!.id, probeRunId, outcome: "provider_error",
        provider: "openai", model: "gpt-4o-mini", usedMock: false,
        requestSha256: sha256Hex(REQ), responseSha256: null, latencyMs: 5,
        rawContent: null, rawRequestBody: REQ,
      });
    }
    await sleep(1200); // the lease lapses: the worker is gone
    return { seeded };
  }

  for (const kind of ["provider", "analysis"] as const) {
    const { seeded } = await crashedWith(kind);
    let providerCalls = 0;
    let analysisCalls = 0;
    const base = baseDeps({});
    const counting: WorkerDeps = {
      ...base,
      realFetch: (async () => { providerCalls += 1; return new Response("{}", { status: 200 }); }) as typeof fetch,
      runProbe: (async (input: { fetchImpl?: typeof fetch }) => {
        await (input.fetchImpl ?? fetch)("https://api.perplexity.ai/x", { method: "POST", body: "{}" });
        throw new Error("the provider must not be called on resume");
      }) as WorkerDeps["runProbe"],
      analysis: {
        ...base.analysis,
        execute: async () => { analysisCalls += 1; throw new Error("the model must not be called on resume"); },
      },
    };
    const r = await runOneIteration(counting, OPTS, new WorkerHealth(() => Date.now()));
    check(
      `resume onto a ${kind} receipt in error -> failed, closed`,
      r.outcome === "failed" && r.jobId === seeded.jobId && (r.detail ?? "").includes("ABORTED"),
      `${r.outcome}/${r.detail}`
    );
    check(`resume onto a ${kind} receipt: ZERO new provider calls`, providerCalls === 0, String(providerCalls));
    check(`resume onto a ${kind} receipt: ZERO new model calls`, analysisCalls === 0, String(analysisCalls));
    await assertClosed(`resume ${kind}`, seeded);
  }

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "M5-A failure matrix PASSED." : "M5-A failure matrix FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
