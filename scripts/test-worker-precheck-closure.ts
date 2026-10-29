/**
 * Follow-up to PR #77 — runOneSlot()'s two remaining pre-admission exits,
 * MISSING_CONTEXT and INVALID_BASELINE_ORDINAL, close their job durably,
 * but only a job that was never admitted.
 *
 * Neither can occur with valid database data (the claim loop already
 * returns when the protocol is missing; next_baseline_ordinal is NOT NULL
 * DEFAULT 1 CHECK >= 1, 0051), so both are reached here by making the
 * adapter return the bad context. What it pins, for each:
 *
 *   - never admitted (no attempt in the job's full history, no call):
 *     closed through the fenced fail RPC, which answers FAILED; the stored
 *     job is `failed` with the exact reason; no attempt, request or probe;
 *     not reclaimed after the lease lapses; the worker finds nothing to run;
 *   - an unconfirmed closure (JOB_NOT_OWNED) is reported as lost ownership
 *     with the reason kept;
 *   - an unreadable history closes nothing;
 *   - between two baseline slots (slot 1 completed, current_attempt_id
 *     cleared): not closed, the completed slot unchanged, no new call;
 *   - a terminalized attempt that is still the current one: not closed;
 *   - an open attempt from a crashed earlier claim — reserved only, or
 *     holding a receipted paid answer — is left exactly as it was: no fail
 *     RPC, no T3, attempt not terminalized, receipt intact, no new call.
 *
 * Offline: the in-memory adapter, injected fetch and probe. No provider.
 */

import { sha256Hex } from "@/lib/evidence/hash";
import { runPerplexityProbe } from "@/lib/probes/perplexity";
import { runOneIteration } from "@/lib/protocol-worker/worker";
import { WorkerHealth } from "@/lib/protocol-worker/health";
import type { AnalysisTransport, IterationResult, WorkerDeps, WorkerOptions } from "@/lib/protocol-worker/types";
import type { DbAdapter, ProtocolAttempt } from "@/lib/db/types";

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
process.env.PERPLEXITY_API_KEY = "test-only-not-a-key";

const QUESTION = "Which SOC 2 compliance tools suit a 50-person SaaS company?";
const APPROVER = "11111111-1111-4111-8111-111111111111";
const LEASE = 0.4;
const lapse = () => new Promise((res) => setTimeout(res, 500));
const PROVIDER_BODY = JSON.stringify({ id: "pplx-1", object: "chat.completion", model: "sonar", choices: [{ message: { content: "Vanta and Drata." } }] });
const ANALYSIS_BODY = JSON.stringify({ model: "gpt-4o-2024-08-06", messages: [] });
const ANALYSIS_OUT = JSON.stringify({ clientPosition: "absent", competitorsMentioned: [], sourcesCited: [], answerSummary: "None." });

type Reason = "MISSING_CONTEXT" | "INVALID_BASELINE_ORDINAL";
type JobContext = Awaited<ReturnType<DbAdapter["getProtocolExecutionJobContext"]>>;

async function main(): Promise<void> {
  console.log("\nPre-admission job closure (MISSING_CONTEXT, INVALID_BASELINE_ORDINAL)\n");
  const { memoryAdapter } = await import("@/lib/db/memory-adapter");
  const db: DbAdapter = memoryAdapter;

  async function seed(domain: string, plannedBaselineRuns = 1) {
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
      modelConfig: { model: "sonar" }, plannedBaselineRuns, plannedRetestRuns: 0,
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

  /** Reclaims the job after its lease lapses; returns whether it was this protocol's, then closes it for isolation. */
  async function reclaimAndClose(protocolId: string): Promise<boolean> {
    await lapse();
    const c = await db.claimProtocolExecutionJob({ workerId: "reclaimer", leaseSeconds: 60 });
    if (c.job && c.claimToken) await db.failProtocolExecutionJob({ jobId: c.job.id, claimToken: c.claimToken, projectId: c.job.projectId, reason: "test_cleanup" });
    return c.job?.protocolId === protocolId;
  }

  const OPTS: WorkerOptions = {
    workerId: "precheck-test", leaseSeconds: LEASE, idleBackoffMs: 1, maxBackoffMs: 2, maxSlotsPerClaim: 4,
    perplexityReservedCostUsd: 0.02, analysisReservedCostUsd: 0.02, jitterRatio: 0, maxThrottledRetries: 0, graceMs: 1000,
    exitAfterClaimedJob: false, providerTimeoutMs: 45000, runtimeBound: { allowsNewClaim: () => true },
  };

  /**
   * A worker whose adapter hands runOneSlot the bad context for `reason`,
   * once `active()` says so (always, by default). The probe path is the
   * real Sonar adapter against a fixture fetch, so a slot run before
   * activation is a genuine completed attempt with a receipt.
   */
  function harness(reason: Reason, opts: {
    over?: Partial<DbAdapter>;
    active?: () => Promise<boolean>;
    shapeContext?: (ctx: JobContext) => Promise<JobContext>;
  } = {}) {
    const wire = { fetches: 0, analyses: 0 };
    const closures: Array<{ outcome: string; job: { status?: string; failureReason?: string | null } | null }> = [];
    const aborts: unknown[] = [];
    const active = opts.active ?? (async () => true);
    const spyDb: DbAdapter = {
      ...db,
      getProject: async (id) => (reason === "MISSING_CONTEXT" && (await active()) ? null : db.getProject(id)),
      getProtocolExecutionJobContext: async (input) => {
        let r = await db.getProtocolExecutionJobContext(input);
        if (!r.job || !(await active())) return r;
        if (reason === "INVALID_BASELINE_ORDINAL") r = { ...r, job: { ...r.job, nextBaselineOrdinal: 0 } };
        return opts.shapeContext ? opts.shapeContext(r) : r;
      },
      failProtocolExecutionJob: async (input) => {
        const r = await db.failProtocolExecutionJob(input);
        closures.push(r as never);
        return r;
      },
      abortAttemptAndFailJobForJob: async (input) => { aborts.push(input); return db.abortAttemptAndFailJobForJob(input); },
      ...opts.over,
    };
    const analysis: AnalysisTransport = {
      prepare: () => ({ provider: "openai" as const, model: "gpt-4o-2024-08-06", url: "https://api.openai.com/v1/chat/completions",
        rawRequestBody: ANALYSIS_BODY, requestSha256: sha256Hex(ANALYSIS_BODY) }),
      execute: async () => {
        wire.analyses += 1;
        return { provider: "openai" as const, model: "gpt-4o-2024-08-06", content: ANALYSIS_OUT, usedMock: false,
          modelReturned: "gpt-4o-2024-08-06", latencyMs: 5, requestSha256: sha256Hex(ANALYSIS_BODY),
          contentSha256: sha256Hex(ANALYSIS_OUT), providerRequestId: "a-1", httpStatus: 200, usage: null };
      },
    };
    const deps: WorkerDeps = {
      db: spyDb, analysis, now: () => Date.now(), sleep: async () => {}, probeMode: "live_perplexity",
      realFetch: (async () => {
        wire.fetches += 1;
        return new Response(PROVIDER_BODY, { status: 200, headers: { "x-request-id": `req-${wire.fetches}` } });
      }) as typeof fetch,
      runProbe: runPerplexityProbe,
    };
    return { deps, wire, closures, aborts };
  }
  const iterate = (deps: WorkerDeps): Promise<IterationResult> => runOneIteration(deps, OPTS, new WorkerHealth(deps.now));
  const attemptsOf = (protocolId: string, projectId: string) => db.getProtocolAttempts(protocolId, projectId);
  const same = (a: ProtocolAttempt[], b: ProtocolAttempt[]) => JSON.stringify(a) === JSON.stringify(b);

  for (const reason of ["MISSING_CONTEXT", "INVALID_BASELINE_ORDINAL"] as const) {
    console.log(`\n[${reason}]`);

    /* ── never admitted ──────────────────────────────────────────────── */
    {
      const { projectId, protocolId } = await seed(`pre-${reason.toLowerCase()}.test`);
      const h = harness(reason);
      const r = await iterate(h.deps);
      check("never admitted: refused with the exact reason", r.outcome === "failed" && r.detail === reason, `${r.outcome}:${r.detail}`);
      check("never admitted: closed through the fenced fail RPC, which answered FAILED",
        h.closures.length === 1 && h.closures[0].outcome === "FAILED", JSON.stringify(h.closures.map((c) => c.outcome)));
      check("never admitted: the stored job is failed with that exact reason",
        h.closures[0]?.job?.status === "failed" && h.closures[0]?.job?.failureReason === reason,
        `${h.closures[0]?.job?.status}/${h.closures[0]?.job?.failureReason}`);
      check("never admitted: zero cost — no attempt, request or analysis",
        (await attemptsOf(protocolId, projectId)).length === 0 && h.wire.fetches === 0 && h.wire.analyses === 0);
      await lapse();
      const reclaim = await db.claimProtocolExecutionJob({ workerId: "reclaimer", leaseSeconds: 60 });
      check("never admitted: after the lease lapses, the job is not reclaimed",
        reclaim.job === null || reclaim.job.protocolId !== protocolId, JSON.stringify(reclaim.job?.protocolId ?? null));
      const again = await iterate(h.deps);
      check("never admitted: the worker finds nothing to run — no repeated failure",
        again.outcome === "no_job" && h.closures.length === 1, `${again.outcome}:${again.detail}`);
    }

    /* ── unconfirmed closure ─────────────────────────────────────────── */
    {
      const { projectId, protocolId } = await seed(`notowned-${reason.toLowerCase()}.test`);
      const h = harness(reason, { over: { failProtocolExecutionJob: async () => ({ outcome: "JOB_NOT_OWNED" as const, job: null }) } });
      const r = await iterate(h.deps);
      check("an unconfirmed closure (JOB_NOT_OWNED) is lost ownership, reason kept",
        r.outcome === "lost_ownership" && r.detail === `${reason}:JOB_NOT_OWNED`, `${r.outcome}:${r.detail}`);
      check("…with nothing admitted", (await attemptsOf(protocolId, projectId)).length === 0);
      await reclaimAndClose(protocolId);
    }

    /* ── unreadable history ──────────────────────────────────────────── */
    {
      const { projectId, protocolId } = await seed(`unread-${reason.toLowerCase()}.test`);
      const h = harness(reason, { over: { getProtocolAttempts: async () => { throw new Error("read failed"); } } });
      const r = await iterate(h.deps);
      check("history unreadable: nothing is closed",
        r.outcome === "failed" && r.detail === `${reason}:ATTEMPT_HISTORY_UNVERIFIED` && h.closures.length === 0,
        `${r.outcome}:${r.detail} closures=${h.closures.length}`);
      check("history unreadable: nothing admitted or sent",
        (await attemptsOf(protocolId, projectId)).length === 0 && h.wire.fetches === 0);
      check("history unreadable: the job is still recoverable (reclaimable, not failed)", await reclaimAndClose(protocolId));
    }

    /* ── between two baseline slots, and a terminalized current attempt ─ */
    for (const variant of ["between_slots", "terminalized_current"] as const) {
      const { projectId, protocolId } = await seed(`${variant}-${reason.toLowerCase()}.test`, 2);
      let snapshot: ProtocolAttempt[] | null = null;
      // Activate once slot 1 has completed: the job then sits between slots.
      const active = async () => {
        const attempts = await attemptsOf(protocolId, projectId);
        const on = attempts.some((a) => a.status === "completed");
        if (on && snapshot === null) snapshot = attempts;
        return on;
      };
      let sawCleared = false;
      const h = harness(reason, {
        active,
        shapeContext: async (ctx) => {
          if (ctx.currentAttempt === null) sawCleared = true;
          if (variant === "between_slots") return ctx;
          // The completed attempt still current, as a terminalized attempt.
          const done = (await attemptsOf(protocolId, projectId)).find((a) => a.status === "completed") ?? null;
          return { ...ctx, currentAttempt: done };
        },
      });
      const r = await iterate(h.deps);
      const after = await attemptsOf(protocolId, projectId);
      const label = variant === "between_slots" ? "between two slots" : "terminalized current attempt";
      check(`${label}: slot 1 genuinely completed first (one request, one analysis)`,
        h.wire.fetches === 1 && h.wire.analyses === 1 && after.filter((a) => a.status === "completed").length === 1,
        `fetches=${h.wire.fetches} analyses=${h.wire.analyses} ${after.map((a) => a.status).join(",")} r=${r.outcome}:${r.detail}`);
      if (variant === "between_slots") {
        check(`${label}: current_attempt_id was cleared, so the current-attempt check alone would pass`, sawCleared);
      }
      check(`${label}: not closed — reported as history preserved`,
        r.outcome === "failed" && r.detail === `${reason}:ATTEMPT_HISTORY_PRESERVED`, `${r.outcome}:${r.detail}`);
      check(`${label}: no fail RPC and no T3 abort`, h.closures.length === 0 && h.aborts.length === 0,
        `${h.closures.length}/${h.aborts.length}`);
      check(`${label}: the completed slot is unchanged, and nothing new was admitted`,
        snapshot !== null && same(snapshot, after), `${(snapshot as ProtocolAttempt[] | null)?.length}→${after.length}`);
      check(`${label}: no new request or analysis`, h.wire.fetches === 1 && h.wire.analyses === 1);
      check(`${label}: the job stays recoverable (reclaimable, not failed)`, await reclaimAndClose(protocolId));
    }

    /* ── an open attempt from a crashed claim is preserved ───────────── */
    for (const frontier of ["reserved", "provider_receipted"] as const) {
      const { projectId, protocolId } = await seed(`open-${frontier}-${reason.toLowerCase()}.test`);
      const crashed = await crashedClaim(frontier);
      const before = await attemptsOf(protocolId, projectId);
      const h = harness(reason);
      const r = await iterate(h.deps);
      const after = await attemptsOf(protocolId, projectId);
      const attempt = after.find((a) => a.id === crashed.attemptId);
      check(`open attempt (${frontier}): reported as preserved, not closed`,
        r.outcome === "failed" && r.detail === `${reason}:OPEN_ATTEMPT_PRESERVED`, `${r.outcome}:${r.detail}`);
      check(`open attempt (${frontier}): no fail RPC and no T3 abort`, h.closures.length === 0 && h.aborts.length === 0,
        `${h.closures.length}/${h.aborts.length}`);
      check(`open attempt (${frontier}): the attempt is not terminalized or changed`,
        attempt !== undefined && attempt.terminalizedAt === null && same(before, after),
        `${attempt?.status} ${attempt?.terminalizedAt}`);
      check(`open attempt (${frontier}): no new request or analysis`, h.wire.fetches === 0 && h.wire.analyses === 0);
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
        await reclaimAndClose(protocolId);
      }
    }
  }

  check("global fetch was never called", globalFetchCalls === 0, String(globalFetchCalls));
  console.log(`\n${checks - failures}/${checks} checks passed.${failures ? ` ${failures} FAILED.` : ""}\n`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
