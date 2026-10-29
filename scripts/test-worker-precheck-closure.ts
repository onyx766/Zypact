/**
 * Follow-up to PR #77 — runOneSlot()'s two remaining pre-admission exits,
 * MISSING_CONTEXT and INVALID_BASELINE_ORDINAL, close their job durably.
 *
 * Neither can occur with valid database data (the claim loop already
 * returns when the protocol is missing; next_baseline_ordinal is NOT NULL
 * DEFAULT 1 CHECK >= 1, 0051), so both are reached here by making the
 * adapter return the bad context. What it pins, for each:
 *
 *   - genuinely pre-admission (no open attempt, no reserved or in-flight
 *     call): closed through the fenced fail RPC, which answers FAILED; the
 *     stored job is `failed` with the exact reason; no attempt, request or
 *     probe; not reclaimed after the lease lapses; the worker finds
 *     nothing to run;
 *   - an unconfirmed closure (JOB_NOT_OWNED) is reported as lost ownership
 *     with the reason kept;
 *   - an open attempt from a crashed earlier claim — reserved only, or
 *     holding a receipted paid answer — is left exactly as it was: no fail
 *     RPC, no T3, attempt not terminalized, receipt intact, no new call.
 *
 * Offline: the in-memory adapter, injected fetch and probe. No provider.
 */

import { sha256Hex } from "@/lib/evidence/hash";
import { runOneIteration } from "@/lib/protocol-worker/worker";
import { WorkerHealth } from "@/lib/protocol-worker/health";
import type { AnalysisTransport, IterationResult, WorkerDeps, WorkerOptions } from "@/lib/protocol-worker/types";
import type { DbAdapter } from "@/lib/db/types";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
function must<T>(v: T | null | undefined, label: string): T {
  if (v === null || v === undefined) throw new Error(`missing ${label}`);
  return v;
}

let globalFetchCalls = 0;
globalThis.fetch = (async () => { globalFetchCalls += 1; throw new Error("no network"); }) as typeof fetch;

const QUESTION = "Which SOC 2 compliance tools suit a 50-person SaaS company?";
const APPROVER = "11111111-1111-4111-8111-111111111111";
const LEASE = 0.4;
const lapse = () => new Promise((res) => setTimeout(res, 500));
const PROVIDER_BODY = JSON.stringify({ id: "pplx-1", object: "chat.completion", model: "sonar", choices: [{ message: { content: "Vanta and Drata." } }] });

async function main(): Promise<void> {
  console.log("\nPre-admission job closure (MISSING_CONTEXT, INVALID_BASELINE_ORDINAL)\n");
  const { memoryAdapter } = await import("@/lib/db/memory-adapter");
  const db: DbAdapter = memoryAdapter;

  async function seed(domain: string) {
    const project = await db.createProject({ domain, companyName: "Example Client" });
    const question = await db.createBuyerQuestion({ projectId: project.id });
    const version = await db.createBuyerQuestionVersion({
      buyerQuestionId: question.id, projectId: project.id, versionNumber: 1, promptText: QUESTION,
      promptHash: sha256Hex(QUESTION), intentType: "comparison", commercialValue: 3, winnability: 3, priority: 10,
      rationale: "fixture", provenance: "founder_supplied",
    });
    await db.approveBuyerQuestionVersion({ versionId: version.id, projectId: project.id, approvedBy: APPROVER });
    const protocol = await db.createProtocol({
      projectId: project.id, buyerQuestionVersionId: version.id, provider: "perplexity_sonar", surface: "answer",
      modelConfig: { model: "sonar" }, plannedBaselineRuns: 1, plannedRetestRuns: 0,
      paraphrasePlan: [{ text: QUESTION, hash: sha256Hex(QUESTION) }], unitOfAnalysis: "run",
      primaryMetric: "listed_in_run", samplePlanningMethod: "fixed", runCap: 3, spendCapUsd: 1,
      timeWindowSeconds: 3600, rateLimitPerHour: 100, concurrencyLimit: 5, retryCap: 0,
    });
    await db.approveProtocol({ protocolId: protocol.id, projectId: project.id, approvedBy: APPROVER });
    await db.enqueueProtocolExecutionJob({ protocolId: protocol.id, projectId: project.id });
    return { projectId: project.id, protocolId: protocol.id };
  }

  /** A crashed earlier claim: an attempt admitted (and optionally a paid answer receipted), then the lease lapsed. */
  async function crashedClaim(frontier: "reserved" | "provider_receipted") {
    const claimed = await db.claimProtocolExecutionJob({ workerId: "crashed", leaseSeconds: LEASE });
    const job = must(claimed.job, "job");
    const f = { jobId: job.id, claimToken: must(claimed.claimToken, "token"), projectId: job.projectId };
    const admitted = await db.admitAndReserveAttemptForJob({
      ...f, attemptKind: "baseline", idempotencyKey: `${job.id}:baseline:${job.nextBaselineOrdinal}`,
      perplexityReservedCostUsd: 0.02, analysisReservedCostUsd: 0.02,
    });
    const attempt = must(admitted.attempt, "attempt");
    const perplexityCall = must(admitted.perplexityCall, "perplexity call");
    if (frontier === "provider_receipted") {
      const started = await db.createProbeRunAndStartAttemptForJob({ ...f, attemptId: attempt.id, platform: "perplexity", probeMode: "live_perplexity" });
      const probeRunId = must(started.probeRun, "probe run").id;
      const body = JSON.stringify({ model: "sonar", messages: [{ role: "user", content: QUESTION }] });
      await db.markExternalCallSentForJob({ ...f, externalCallId: perplexityCall.id, probeRunId, callKind: "perplexity", requestBody: body, requestBodySha256: sha256Hex(body) });
      await db.recordProviderCallReceiptForJob({
        ...f, externalCallId: perplexityCall.id, probeRunId, outcome: "success", httpStatus: 200,
        providerRequestId: "req-1", rawResponseSha256: sha256Hex(PROVIDER_BODY), latencyMs: 7, rawResponseBody: PROVIDER_BODY,
        actualCostUsd: 0.0035, costBasis: "measured",
      });
    }
    await lapse();
    return { jobId: job.id, attemptId: attempt.id, perplexityCallId: perplexityCall.id };
  }

  const analysis: AnalysisTransport = {
    prepare: () => { throw new Error("analysis must not be prepared"); },
    execute: async () => { throw new Error("analysis must not run"); },
  };
  const OPTS: WorkerOptions = {
    workerId: "precheck-test", leaseSeconds: LEASE, idleBackoffMs: 1, maxBackoffMs: 2, maxSlotsPerClaim: 4,
    perplexityReservedCostUsd: 0.02, analysisReservedCostUsd: 0.02, jitterRatio: 0, maxThrottledRetries: 0, graceMs: 1000,
    exitAfterClaimedJob: false, providerTimeoutMs: 45000, runtimeBound: { allowsNewClaim: () => true },
  };

  /** A worker whose adapter hands runOneSlot the bad context for `reason`. */
  function harness(reason: "MISSING_CONTEXT" | "INVALID_BASELINE_ORDINAL", over: Partial<DbAdapter> = {}) {
    const wire = { fetches: 0, probes: 0 };
    const closures: Array<{ outcome: string; job: { status?: string; failureReason?: string | null } | null }> = [];
    const aborts: unknown[] = [];
    const spyDb: DbAdapter = {
      ...db,
      ...(reason === "MISSING_CONTEXT"
        ? { getProject: async () => null }
        : {
            getProtocolExecutionJobContext: async (input) => {
              const r = await db.getProtocolExecutionJobContext(input);
              return r.job ? { ...r, job: { ...r.job, nextBaselineOrdinal: 0 } } : r;
            },
          }),
      failProtocolExecutionJob: async (input) => {
        const r = await db.failProtocolExecutionJob(input);
        closures.push(r as never);
        return r;
      },
      abortAttemptAndFailJobForJob: async (input) => { aborts.push(input); return db.abortAttemptAndFailJobForJob(input); },
      ...over,
    };
    const deps: WorkerDeps = {
      db: spyDb, analysis, now: () => Date.now(), sleep: async () => {}, probeMode: "live_perplexity",
      realFetch: (async () => { wire.fetches += 1; throw new Error("no"); }) as typeof fetch,
      runProbe: (async () => { wire.probes += 1; throw new Error("no"); }) as unknown as WorkerDeps["runProbe"],
    };
    return { deps, wire, closures, aborts };
  }
  const iterate = (deps: WorkerDeps): Promise<IterationResult> => runOneIteration(deps, OPTS, new WorkerHealth(deps.now));

  for (const reason of ["MISSING_CONTEXT", "INVALID_BASELINE_ORDINAL"] as const) {
    console.log(`\n[${reason}]`);

    /* ── genuinely pre-admission ─────────────────────────────────────── */
    {
      const { projectId, protocolId } = await seed(`pre-${reason.toLowerCase()}.test`);
      const h = harness(reason);
      const r = await iterate(h.deps);
      check("refused with the exact reason", r.outcome === "failed" && r.detail === reason, `${r.outcome}:${r.detail}`);
      check("closed through the fenced fail RPC, which answered FAILED",
        h.closures.length === 1 && h.closures[0].outcome === "FAILED", JSON.stringify(h.closures.map((c) => c.outcome)));
      check("the stored job is failed with that exact reason",
        h.closures[0]?.job?.status === "failed" && h.closures[0]?.job?.failureReason === reason,
        `${h.closures[0]?.job?.status}/${h.closures[0]?.job?.failureReason}`);
      check("zero cost: no attempt, request or probe",
        (await db.getProtocolAttempts(protocolId, projectId)).length === 0 && h.wire.fetches === 0 && h.wire.probes === 0);
      await lapse();
      const reclaim = await db.claimProtocolExecutionJob({ workerId: "reclaimer", leaseSeconds: 60 });
      check("after the lease lapses, the job is not reclaimed",
        reclaim.job === null || reclaim.job.protocolId !== protocolId, JSON.stringify(reclaim.job?.protocolId ?? null));
      const again = await iterate(h.deps);
      check("the worker finds nothing to run — no repeated failure",
        again.outcome === "no_job" && h.closures.length === 1, `${again.outcome}:${again.detail}`);
    }

    /* ── unconfirmed closure ─────────────────────────────────────────── */
    {
      const { projectId, protocolId } = await seed(`notowned-${reason.toLowerCase()}.test`);
      const h = harness(reason, { failProtocolExecutionJob: async () => ({ outcome: "JOB_NOT_OWNED" as const, job: null }) });
      const r = await iterate(h.deps);
      check("an unconfirmed closure (JOB_NOT_OWNED) is lost ownership, reason kept",
        r.outcome === "lost_ownership" && r.detail === `${reason}:JOB_NOT_OWNED`, `${r.outcome}:${r.detail}`);
      check("…with nothing admitted", (await db.getProtocolAttempts(protocolId, projectId)).length === 0);
      // Close it so it cannot leak into later claims.
      await lapse();
      const c = await db.claimProtocolExecutionJob({ workerId: "cleanup", leaseSeconds: 60 });
      if (c.job && c.claimToken) await db.failProtocolExecutionJob({ jobId: c.job.id, claimToken: c.claimToken, projectId: c.job.projectId, reason: "test_cleanup" });
    }

    /* ── an open attempt from a crashed claim is preserved ───────────── */
    for (const frontier of ["reserved", "provider_receipted"] as const) {
      const { projectId, protocolId } = await seed(`open-${frontier}-${reason.toLowerCase()}.test`);
      const crashed = await crashedClaim(frontier);
      const before = (await db.getProtocolAttempts(protocolId, projectId)).find((a) => a.id === crashed.attemptId);
      const h = harness(reason);
      const r = await iterate(h.deps);
      const after = (await db.getProtocolAttempts(protocolId, projectId)).find((a) => a.id === crashed.attemptId);
      check(`open attempt (${frontier}): reported as preserved, not closed`,
        r.outcome === "failed" && r.detail === `${reason}:OPEN_ATTEMPT_PRESERVED`, `${r.outcome}:${r.detail}`);
      check(`open attempt (${frontier}): no fail RPC and no T3 abort`, h.closures.length === 0 && h.aborts.length === 0,
        `${h.closures.length}/${h.aborts.length}`);
      check(`open attempt (${frontier}): the attempt is not terminalized or changed`,
        after !== undefined && after.terminalizedAt === null && after.status === before?.status && after.actualCostUsd === before?.actualCostUsd,
        `${before?.status}→${after?.status} ${after?.terminalizedAt}`);
      check(`open attempt (${frontier}): no new request or probe`, h.wire.fetches === 0 && h.wire.probes === 0);
      if (frontier === "provider_receipted") {
        // Read the stored evidence back under a fresh claim.
        await lapse();
        const c = await db.claimProtocolExecutionJob({ workerId: "inspector", leaseSeconds: 60 });
        const claimed = c.job && c.claimToken ? { jobId: c.job.id, claimToken: c.claimToken, projectId: c.job.projectId } : null;
        const ctx = claimed ? await db.getProtocolExecutionJobContext(claimed) : null;
        const receipt = ctx?.providerReceipts.find((x) => x.externalCallId === crashed.perplexityCallId);
        check("open attempt (provider_receipted): the paid answer's receipt is intact",
          receipt !== undefined && receipt.rawResponseBody === PROVIDER_BODY && receipt.outcome === "success",
          JSON.stringify(receipt?.outcome ?? null));
        const call = ctx?.externalCalls.find((x) => x.id === crashed.perplexityCallId);
        check("open attempt (provider_receipted): its measured cost is intact",
          call?.actualCostUsd === 0.0035 && call?.costBasis === "measured", `${call?.actualCostUsd}/${call?.costBasis}`);
        if (claimed) await db.failProtocolExecutionJob({ ...claimed, reason: "test_cleanup" });
      } else {
        await lapse();
        const c = await db.claimProtocolExecutionJob({ workerId: "cleanup", leaseSeconds: 60 });
        if (c.job && c.claimToken) await db.failProtocolExecutionJob({ jobId: c.job.id, claimToken: c.claimToken, projectId: c.job.projectId, reason: "test_cleanup" });
      }
    }
  }

  check("global fetch was never called", globalFetchCalls === 0, String(globalFetchCalls));
  console.log(`\n${checks - failures}/${checks} checks passed.${failures ? ` ${failures} FAILED.` : ""}\n`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
