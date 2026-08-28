#!/usr/bin/env tsx
/**
 * M5-A — crash recovery, network-free.
 *
 * Every scenario builds a half-finished job through the real job-scoped
 * RPCs, lets the lease expire, and then hands the wreckage to a fresh
 * worker iteration. The question each one answers is the same: does the
 * worker pay twice, or does it read the ledger?
 *
 *   [A] provider call marked sent, no receipt  → ambiguous, needs_review
 *   [B] analysis call marked sent, no receipt  → ambiguous, needs_review
 *   [C] provider receipt present, analysis not → resume, ZERO new provider call
 *   [D] analysis receipt present, no result    → re-parse, ZERO new model call
 *   [E] a stale claim token is refused by every fenced RPC
 */

import { sha256Hex } from "@/lib/evidence/hash";
import { runOneIteration } from "@/lib/protocol-worker/worker";
import { WorkerHealth } from "@/lib/protocol-worker/health";
import type {
  AnalysisTransport,
  WorkerDeps,
  WorkerOptions,
} from "@/lib/protocol-worker/types";
import type { CreateProtocolInput, DbAdapter } from "@/lib/db/types";
import type { ProbeAnalysisM5Parsed } from "@/lib/protocol-worker/analysis-m5";
import type { PerplexityProbeResult } from "@/lib/probes/perplexity";

const MARK_BODY_PERPLEXITY = JSON.stringify({ model: "sonar", messages: [] });
const MARK_BODY_ANALYSIS = JSON.stringify({ model: "gpt-4o-mini", messages: [] });

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
  if (value === null || value === undefined) throw new Error(`missing ${label}`);
  return value;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The crashed worker's lease: long enough to build the half-finished
 * state through real fenced RPCs, short enough to lapse right after.
 */
const CRASH_LEASE_SECONDS = 0.4;
const CRASH_LEASE_LAPSE_MS = 500;

const APPROVER = "11111111-1111-4111-8111-111111111111";
const ANSWER = "Acme Rival and Example Client are both options.";
const ANALYSIS_REQUEST_BODY = JSON.stringify({ model: "gpt-4o-mini", messages: [] });

const M5_OUTPUT: ProbeAnalysisM5Parsed = {
  clientPosition: "listed",
  competitorsMentioned: [{ name: "Acme Rival", position: 1, context: "listed first" }],
  sourcesCited: [{ source: "g2.com/products/example", type: "review_site" }],
  answerSummary: "Two vendors are listed.",
};
const M5_CONTENT = JSON.stringify(M5_OUTPUT);

function providerBody(answer: string): string {
  return JSON.stringify({ id: "req-fixture", choices: [{ message: { content: answer } }] });
}
const PROVIDER_BODY = providerBody(ANSWER);

const PROTOCOL_FIXTURE: Omit<CreateProtocolInput, "projectId" | "buyerQuestionVersionId"> = {
  provider: "perplexity",
  surface: "sonar",
  plannedBaselineRuns: 1,
  plannedRetestRuns: 0,
  paraphrasePlan: [{ text: "Which vendors handle X best?", hash: "b".repeat(64) }],
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

const OPTS: WorkerOptions = {
  workerId: "recovery-worker",
  leaseSeconds: 60,
  idleBackoffMs: 1,
  maxBackoffMs: 2,
  maxSlotsPerClaim: 4,
  perplexityReservedCostUsd: 0.02,
  analysisReservedCostUsd: 0.02,
    jitterRatio: 0,
    maxThrottledRetries: 3,
    graceMs: 1000,
};

async function main(): Promise<void> {
  const { memoryAdapter } = await import("@/lib/db/memory-adapter");
  const db: DbAdapter = memoryAdapter;

  interface Spy {
    providerFetches: number;
    analysisExecutes: number;
  }

  function makeDeps(spy: Spy): WorkerDeps {
    const analysis: AnalysisTransport = {
      prepare: () => ({
        provider: "openai" as const,
        model: "gpt-4o-mini",
        url: "https://api.openai.com/v1/chat/completions",
        rawRequestBody: ANALYSIS_REQUEST_BODY,
        requestSha256: sha256Hex(ANALYSIS_REQUEST_BODY),
      }),
      execute: async () => {
        spy.analysisExecutes += 1;
        return {
          provider: "openai" as const,
          model: "gpt-4o-mini",
          content: M5_CONTENT,
          usedMock: false,
          latencyMs: 5,
          requestSha256: sha256Hex(ANALYSIS_REQUEST_BODY),
          contentSha256: sha256Hex(M5_CONTENT),
          providerRequestId: "analysis-fixture",
          httpStatus: 200,
        };
      },
    };
    return {
      db,
      analysis,
      now: () => Date.now(),
      sleep: async () => {},
      probeMode: "live_perplexity",
      realFetch: (async () => {
        spy.providerFetches += 1;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      runProbe: (async (input) => {
        await (input.fetchImpl ?? fetch)("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          body: "{}",
        });
        return {
          prompt: input.prompt,
          answer: ANSWER,
          rawResponse: PROVIDER_BODY,
          citations: [],
          searchResults: [],
          sourceCitations: [],
          model: "sonar",
          usedMock: false,
          rawResponseBody: PROVIDER_BODY,
          rawResponseBodySha256: sha256Hex(PROVIDER_BODY),
          httpStatus: 200,
          latencyMs: 7,
          providerRequestId: "req-fixture",
        } satisfies PerplexityProbeResult;
      }) as WorkerDeps["runProbe"],
    };
  }

  /** Seeds an approved protocol with one queued job. */
  async function seed(domain: string): Promise<{ projectId: string }> {
    const project = await db.createProject({ domain, companyName: "Example Client" });
    const question = await db.createBuyerQuestion({ projectId: project.id });
    const version = await db.createBuyerQuestionVersion({
      buyerQuestionId: question.id,
      projectId: project.id,
      versionNumber: 1,
      promptText: "Which vendors handle X best?",
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
      approvedBy: APPROVER,
    });
    const protocol = await db.createProtocol({
      ...PROTOCOL_FIXTURE,
      projectId: project.id,
      buyerQuestionVersionId: version.id,
    });
    await db.approveProtocol({ protocolId: protocol.id, projectId: project.id, approvedBy: APPROVER });
    await db.enqueueProtocolExecutionJob({ protocolId: protocol.id, projectId: project.id });
    return { projectId: project.id };
  }

  /**
   * Drives a job up to a chosen frontier under a 1 ms lease, then lets the
   * lease lapse — the exact state a killed worker leaves behind.
   */
  async function crashAt(
    domain: string,
    frontier: "provider_sent" | "analysis_sent" | "provider_receipted" | "analysis_receipted"
  ): Promise<{ jobId: string; projectId: string; claimToken: string }> {
    const { projectId } = await seed(domain);
    const claimed = await db.claimProtocolExecutionJob({
      workerId: "crashed",
      leaseSeconds: CRASH_LEASE_SECONDS,
    });
    const job = must(claimed.job, "claimed job");
    const claimToken = must(claimed.claimToken, "claim token");
    const f = { jobId: job.id, claimToken, projectId };

    const admitted = await db.admitAndReserveAttemptForJob({
      ...f,
      attemptKind: "baseline",
      idempotencyKey: `${job.id}:baseline:${job.nextBaselineOrdinal}`,
      perplexityReservedCostUsd: 0.02,
      analysisReservedCostUsd: 0.02,
    });
    const attempt = must(admitted.attempt, "attempt");
    const perplexityCall = must(admitted.perplexityCall, "perplexity call");
    const analysisCall = must(admitted.analysisCall, "analysis call");

    const started = await db.createProbeRunAndStartAttemptForJob({
      ...f,
      attemptId: attempt.id,
      platform: "perplexity",
      probeMode: "live_perplexity",
    });
    if (started.outcome !== "STARTED") {
      throw new Error(`crashAt setup: start returned ${started.outcome}, expected STARTED`);
    }
    const probeRunId = must(started.probeRun, "probe run").id;

    await db.markExternalCallSentForJob({ ...f, externalCallId: perplexityCall.id, probeRunId, callKind: "perplexity", requestBody: MARK_BODY_PERPLEXITY, requestBodySha256: sha256Hex(MARK_BODY_PERPLEXITY) });
    if (frontier !== "provider_sent") {
      await db.recordProviderCallReceiptForJob({
        ...f,
        externalCallId: perplexityCall.id,
        probeRunId,
        outcome: "success",
        httpStatus: 200,
        providerRequestId: "req-fixture",
        rawResponseSha256: sha256Hex(PROVIDER_BODY),
        latencyMs: 7,
        rawResponseBody: PROVIDER_BODY,
      });
    }
    if (frontier === "analysis_sent" || frontier === "analysis_receipted") {
      await db.markExternalCallSentForJob({ ...f, externalCallId: analysisCall.id, probeRunId, callKind: "analysis", requestBody: MARK_BODY_ANALYSIS, requestBodySha256: sha256Hex(MARK_BODY_ANALYSIS) });
    }
    if (frontier === "analysis_receipted") {
      await db.recordAnalysisCallReceiptForJob({
        ...f,
        externalCallId: analysisCall.id,
        probeRunId,
        outcome: "success",
        provider: "openai",
        model: "gpt-4o-mini",
        usedMock: false,
        requestSha256: sha256Hex(ANALYSIS_REQUEST_BODY),
        responseSha256: sha256Hex(M5_CONTENT),
        latencyMs: 5,
        rawContent: M5_CONTENT,
        rawRequestBody: ANALYSIS_REQUEST_BODY,
      });
    }

    await sleep(CRASH_LEASE_LAPSE_MS); // the lease lapses; the worker is gone.
    return { jobId: job.id, projectId, claimToken };
  }

  // ======================================================================
  // [A] Provider request sent, no receipt — genuinely unknown.
  // ======================================================================
  console.log("[A] provider call sent, no receipt");
  {
    const { jobId } = await crashAt("crash-provider-sent.test", "provider_sent");
    const spy: Spy = { providerFetches: 0, analysisExecutes: 0 };
    const r = await runOneIteration(makeDeps(spy), OPTS, new WorkerHealth(() => Date.now()));
    check(
      "the job is routed to needs_review, never retried blind",
      r.outcome === "needs_review_perplexity_unknown" && r.jobId === jobId,
      `${r.outcome}/${r.detail}`
    );
    check("ZERO provider calls were made", spy.providerFetches === 0);
    check("ZERO model calls were made", spy.analysisExecutes === 0);
    // needs_review is not a claimable status: the job has left the pool.
    const nothingLeft = await db.claimProtocolExecutionJob({
      workerId: "probe-after-review",
      leaseSeconds: 60,
    });
    check(
      "a needs_review job is no longer claimable by anyone",
      nothingLeft.outcome === "NO_JOB_AVAILABLE",
      nothingLeft.outcome
    );
  }

  // ======================================================================
  // [B] Analysis request sent, no receipt — the second frontier.
  // ======================================================================
  console.log("\n[B] analysis call sent, no receipt");
  {
    const { jobId } = await crashAt("crash-analysis-sent.test", "analysis_sent");
    const spy: Spy = { providerFetches: 0, analysisExecutes: 0 };
    const r = await runOneIteration(makeDeps(spy), OPTS, new WorkerHealth(() => Date.now()));
    check(
      "the analysis frontier is distinguished from the provider one",
      r.outcome === "needs_review_analysis_unknown" && r.jobId === jobId,
      `${r.outcome}/${r.detail}`
    );
    check("ZERO provider calls", spy.providerFetches === 0);
    check("ZERO model calls", spy.analysisExecutes === 0);
  }

  // ======================================================================
  // [C] Provider receipt present — replay the answer, never re-buy it.
  // ======================================================================
  console.log("\n[C] provider receipt present, analysis never started");
  {
    const { jobId } = await crashAt("crash-provider-receipted.test", "provider_receipted");
    const spy: Spy = { providerFetches: 0, analysisExecutes: 0 };
    const r = await runOneIteration(makeDeps(spy), OPTS, new WorkerHealth(() => Date.now()));
    check("the job finishes", r.outcome === "completed" && r.jobId === jobId, `${r.outcome}/${r.detail}`);
    check(
      "ZERO new provider calls — the answer came from the stored receipt (D-026)",
      spy.providerFetches === 0
    );
    check("exactly one model call, the one that was still owed", spy.analysisExecutes === 1);
  }

  // ======================================================================
  // [D] Analysis receipt present — re-parse, never re-invoke.
  // ======================================================================
  console.log("\n[D] analysis receipt present, probe result never saved");
  {
    const { jobId } = await crashAt("crash-analysis-receipted.test", "analysis_receipted");
    const spy: Spy = { providerFetches: 0, analysisExecutes: 0 };
    const r = await runOneIteration(makeDeps(spy), OPTS, new WorkerHealth(() => Date.now()));
    check("the job finishes", r.outcome === "completed" && r.jobId === jobId, `${r.outcome}/${r.detail}`);
    check("ZERO new provider calls", spy.providerFetches === 0);
    check(
      "ZERO new model calls — the output was re-parsed from the stored receipt (D-026)",
      spy.analysisExecutes === 0
    );
  }

  // ======================================================================
  // [E] A stale claim token buys nothing.
  // ======================================================================
  console.log("\n[E] stale claim token");
  {
    const { projectId } = await seed("stale-token.test");
    const first = await db.claimProtocolExecutionJob({
      workerId: "w1",
      leaseSeconds: CRASH_LEASE_SECONDS,
    });
    const job = must(first.job, "job");
    const staleToken = must(first.claimToken, "stale token");
    await sleep(CRASH_LEASE_LAPSE_MS);
    const second = await db.claimProtocolExecutionJob({ workerId: "w2", leaseSeconds: 60 });
    check("a second worker re-claims the lapsed job", second.job?.id === job.id);
    check("and receives a different claim token", second.claimToken !== staleToken);

    const stale = { jobId: job.id, claimToken: staleToken, projectId };
    const ctx = await db.getProtocolExecutionJobContext(stale);
    check("the stale token cannot even read the context", ctx.outcome === "JOB_NOT_OWNED", ctx.outcome);
    const admit = await db.admitAndReserveAttemptForJob({
      ...stale,
      attemptKind: "baseline",
      idempotencyKey: `${job.id}:baseline:1`,
      perplexityReservedCostUsd: 0.02,
      analysisReservedCostUsd: 0.02,
    });
    check("the stale token cannot reserve spend", admit.outcome === "JOB_NOT_OWNED", admit.outcome);
    const complete = await db.completeProtocolExecutionJob(stale);
    check("the stale token cannot complete the job", complete.outcome === "JOB_NOT_OWNED", complete.outcome);
  }

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "M5-A recovery contract PASSED." : "M5-A recovery contract FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
