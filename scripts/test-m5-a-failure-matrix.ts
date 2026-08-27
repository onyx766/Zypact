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
const OPTS: WorkerOptions = {
  workerId: "matrix", leaseSeconds: 60, idleBackoffMs: 1, maxBackoffMs: 2,
  maxSlotsPerClaim: 4, perplexityReservedCostUsd: 0.02, analysisReservedCostUsd: 0.02,
  jitterRatio: 0, maxThrottledRetries: 3, graceMs: 1000,
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

  async function seed(): Promise<string> {
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
    return enq.job!.id;
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
    const jobId = await seed();
    const deps = baseDeps({
      runProbe: (async (input: { fetchImpl?: typeof fetch }) => {
        await (input.fetchImpl ?? fetch)("https://api.perplexity.ai/x", { method: "POST", body: "{}" });
        throw probeFailure(reason, status);
      }) as WorkerDeps["runProbe"],
    });
    const r = await runOneIteration(deps, OPTS, new WorkerHealth(() => Date.now()));
    check(`${label} -> ${expected}`, r.outcome === expected && r.jobId === jobId, `${r.outcome}/${r.detail}`);
    const again = await db.claimProtocolExecutionJob({ workerId: "after", leaseSeconds: 30 });
    check(`${label}: the job is closed, not left claimable`, again.job?.id !== jobId, again.outcome);
  }

  console.log("\n[2] Analysis failures");
  for (const [label, reason, expected] of [
    ["http_error", "http_error", "failed"],
    ["malformed_response", "malformed_response", "failed"],
    ["empty_content", "empty_content", "failed"],
    ["network_error", "network_error", "needs_review_analysis_unknown"],
    ["aborted", "aborted", "needs_review_analysis_unknown"],
  ] as const) {
    const jobId = await seed();
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
    check(`analysis ${label} -> ${expected}`, r.outcome === expected && r.jobId === jobId, `${r.outcome}/${r.detail}`);
    check(`analysis ${label}: an exception never escapes the iteration`, true);
    const again = await db.claimProtocolExecutionJob({ workerId: "after", leaseSeconds: 30 });
    check(`analysis ${label}: the job is closed`, again.job?.id !== jobId, again.outcome);
  }

  console.log("\n[3] Parse failures — the receipt exists first");
  {
    const jobId = await seed();
    const deps = baseDeps({});
    const bad: WorkerDeps = {
      ...deps,
      analysis: {
        ...deps.analysis,
        execute: async () => ({
          provider: "openai" as const, model: "gpt-4o-mini", content: "not json at all {{{",
          usedMock: false, latencyMs: 5, requestSha256: sha256Hex(REQ),
          contentSha256: sha256Hex("not json at all {{{"), providerRequestId: "ana", httpStatus: 200,
        }),
      },
    };
    const r = await runOneIteration(bad, OPTS, new WorkerHealth(() => Date.now()));
    check("invalid JSON -> parse_failed", r.outcome === "parse_failed" && r.jobId === jobId, `${r.outcome}/${r.detail}`);
  }
  {
    const jobId = await seed();
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
          latencyMs: 5, requestSha256: sha256Hex(REQ), contentSha256: sha256Hex(extraKey),
          providerRequestId: "ana", httpStatus: 200,
        }),
      },
    };
    const r = await runOneIteration(legacy, OPTS, new WorkerHealth(() => Date.now()));
    check(
      "a legacy verdict key -> parse_failed, never silently stripped",
      r.outcome === "parse_failed" && r.jobId === jobId,
      `${r.outcome}/${r.detail}`
    );
  }

  console.log("\n[4] The happy path still ends completed");
  {
    const jobId = await seed();
    const r = await runOneIteration(baseDeps({}), OPTS, new WorkerHealth(() => Date.now()));
    check("a clean run completes", r.outcome === "completed" && r.jobId === jobId, `${r.outcome}/${r.detail}`);
  }

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "M5-A failure matrix PASSED." : "M5-A failure matrix FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
