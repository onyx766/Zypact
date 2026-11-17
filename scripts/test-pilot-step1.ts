#!/usr/bin/env tsx
/**
 * Pilot Mode step 1 (D-052), offline.
 *
 *   W  the real worker loop on the memory adapter: a Run names its job, a
 *      provider error stops the measurement, the founder retry resumes it,
 *      and the plan finishes with every attempt still on record;
 *   M  the memory mirrors of the new functions, branch for branch;
 *   S  static contracts: the live runner, the start path, the routes and the
 *      migration;
 *   C  copy: the Run confirmation, page titles, provenance labels.
 *
 * The same rules against a real PostgreSQL are in test-pilot-step1-db.ts.
 * No database, no network, no provider.
 */
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { DbAdapter, ProtocolAttempt, ProtocolExecutionJob } from "@/lib/db/types";
import { sha256Hex } from "@/lib/evidence/hash";
import { PerplexityProbeFailure } from "@/lib/probes/perplexity";
import { WorkerHealth } from "@/lib/protocol-worker/health";
import type { AnalysisTransport, IterationResult, WorkerDeps, WorkerOptions } from "@/lib/protocol-worker/types";
import { runWorkerLoop } from "@/lib/protocol-worker/worker";
import { QUESTION_PROVENANCE_LABELS, questionProvenanceLabel } from "@/lib/reports/question-provenance";
import { FORBIDDEN_W1_PHRASES } from "@/lib/site-diagnostic/copy";
import { runConfirmationText } from "@/lib/reports/run-confirmation";
import { parseMigrationName } from "./lib/migration-names";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`✓ ${name}`);
  else {
    failures += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
(globalThis as unknown as { fetch: unknown }).fetch = () => {
  throw new Error("network disabled");
};

const FOUNDER = "11111111-1111-4111-8111-111111111111";
const QUESTION = "Which retail analytics tools suit small shops?";
const ANSWER = "Acme Rival and Example Client are both options.";
const REQ = JSON.stringify({ model: "gpt-4o-mini", messages: [] });
const M5 = JSON.stringify({ clientPosition: "absent", competitorsMentioned: [], sourcesCited: [], answerSummary: "" });
const BODY = JSON.stringify({ id: "r", choices: [{ message: { content: ANSWER } }] });
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const ALWAYS_ALLOWS = { allowsNewClaim: (): boolean => true };
const PAID_GATE_ALLOWS = async () => ({ ok: true as const, ceilingUsd: 10, spentLast24hUsd: 0, nextJobCapUsd: 0 });
const OPTS: WorkerOptions = {
  workerId: "pilot-step1", leaseSeconds: 30, idleBackoffMs: 1, maxBackoffMs: 2,
  maxSlotsPerClaim: 7, perplexityReservedCostUsd: 0.02, analysisReservedCostUsd: 0.02,
  jitterRatio: 0, maxThrottledRetries: 0, graceMs: 1000,
  exitAfterClaimedJob: true, claimScope: "requested", providerTimeoutMs: 45000,
  runtimeBound: ALWAYS_ALLOWS,
};

function httpError(): PerplexityProbeFailure {
  return new PerplexityProbeFailure("provider failed", {
    reason: "http_error",
    httpStatus: 500,
    errorBody: BODY,
    errorBodySha256: sha256Hex(BODY),
    latencyMs: 12,
    providerRequestId: null,
    rawProbeRequestSha256: sha256Hex("prompt"),
    fullRequestBody: JSON.stringify({ model: "sonar" }),
    fullRequestBodySha256: sha256Hex(JSON.stringify({ model: "sonar" })),
  });
}

interface Store {
  protocolExecutionJobs: Map<string, ProtocolExecutionJob>;
  protocolAttempts: Map<string, ProtocolAttempt>;
  protocolJobRunRequests: Map<string, { jobId: string; status: string; refusalCode: string | null; expiresAt: string }>;
}
const store = () => (globalThis as unknown as Record<string, Store>)["__zypact_memory_store__"];

async function main(): Promise<void> {
  const { memoryAdapter } = await import("@/lib/db/memory-adapter");
  const db: DbAdapter = memoryAdapter;

  /** Perplexity calls made so far, and the call number that fails with HTTP 500. */
  let probeCalls = 0;
  let failOnCall: number | null = null;

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
  const deps: WorkerDeps = {
    db, analysis, now: () => Date.now(), sleep: async () => {}, probeMode: "live_perplexity",
    realFetch: (async () => new Response("{}", { status: 200 })) as typeof fetch,
    runProbe: (async (input: { prompt: string; fetchImpl?: typeof fetch }) => {
      await (input.fetchImpl ?? (async () => new Response("{}")))("https://api.perplexity.ai/x", { method: "POST", body: "{}" });
      probeCalls += 1;
      if (failOnCall !== null && probeCalls === failOnCall) throw httpError();
      return {
        prompt: input.prompt, answer: ANSWER, rawResponse: BODY, citations: [], searchResults: [],
        sourceCitations: [], model: "sonar", usedMock: false, rawResponseBody: BODY,
        rawResponseBodySha256: sha256Hex(BODY), httpStatus: 200, latencyMs: 7, providerRequestId: "r",
      };
    }) as WorkerDeps["runProbe"],
  };

  async function runLoop(): Promise<IterationResult[]> {
    const seen: IterationResult[] = [];
    await runWorkerLoop(deps, OPTS, PAID_GATE_ALLOWS, { aborted: false }, async () => undefined,
      (r) => seen.push(r), new WorkerHealth(() => Date.now()));
    return seen;
  }

  async function launch(domain: string, provenance: "customer_supplied" | "founder_supplied") {
    const request = await db.createFounderSnapshotRequest({
      workEmail: `p@${domain}`, normalizedEmail: `p@${domain}`, companyName: `Co ${domain}`,
      websiteUrl: `https://${domain}`, normalizedDomain: domain, buyerCategory: QUESTION,
    });
    const approved = await db.approveAndLaunchSnapshotBaseline(
      request.id, FOUNDER, ["Beta Co", "Gamma Co"], sha(QUESTION), provenance
    );
    const protocolId = approved!.protocolId!;
    const projectId = approved!.projectId!;
    const job = [...store().protocolExecutionJobs.values()].find((j) => j.protocolId === protocolId)!;
    return { requestId: request.id, protocolId, projectId, jobId: job.id };
  }
  const job = (id: string) => store().protocolExecutionJobs.get(id)!;
  const attemptsOf = (protocolId: string) =>
    [...store().protocolAttempts.values()].filter((a) => a.protocolId === protocolId);
  const run = (target: { jobId: string; projectId: string }) =>
    db.requestProtocolJobRun({
      jobId: target.jobId, projectId: target.projectId, via: "admin_run_pipeline",
      requestedBy: FOUNDER, ttlSeconds: 120,
    });

  /* W: the worker loop --------------------------------------------------- */
  console.log("[W] a Run names its job; a provider error is retried and the plan finishes");
  const older = await launch("older.example", "customer_supplied");
  const target = await launch("target.example", "founder_supplied");

  const idle = await runLoop();
  check("W1 with no run request a single-job worker claims nothing and stops at once",
    idle.length === 1 && idle[0].outcome === "no_job" && idle[0].detail === "NO_RUN_REQUEST"
      && job(older.jobId).status === "queued" && job(target.jobId).status === "queued",
    JSON.stringify(idle));

  check("W2 the Run for the newer request is recorded", (await run(target)).outcome === "REQUESTED");
  check("W3 a Run for another job while one is pending is refused", (await run(older)).outcome === "ANOTHER_RUN_PENDING");
  const pendingRow = [...store().protocolJobRunRequests.values()].find((r) => r.status === "pending")!;
  pendingRow.expiresAt = new Date(Date.now() + 5000).toISOString(); // test setup: a press near its expiry
  const again = await run(target);
  check("W3b a second press for the same job refreshes a nearly expired request to a full TTL",
    again.outcome === "ALREADY_REQUESTED" && new Date(again.expiresAt ?? 0).getTime() >= Date.now() + 110_000);
  failOnCall = probeCalls + 3;
  const first = await runLoop();
  check("W4 the worker claimed the requested job, not the older one, and stopped on the provider error",
    first.length === 1 && first[0].jobId === target.jobId && first[0].outcome === "failed"
      && job(older.jobId).status === "queued", JSON.stringify(first));
  const stopped = job(target.jobId);
  check("W5 the job stopped failed at run 3 with a provider error",
    stopped.status === "failed" && stopped.failureReason === "provider_error" && stopped.nextBaselineOrdinal === 3,
    `${stopped.status}/${stopped.failureReason}/${stopped.nextBaselineOrdinal}`);
  const failedRun = attemptsOf(target.protocolId).find((a) => a.status === "failed")!;
  check("W6 runs 1-2 completed and run 3 failed", attemptsOf(target.protocolId).filter((a) => a.status === "completed").length === 2
    && failedRun?.baselineOrdinal === 3);

  const key = randomUUID();
  const retried = await db.retryFailedProtocolJob({
    jobId: target.jobId, projectId: target.projectId, actor: FOUNDER,
    reason: "Perplexity returned HTTP 500 on run 3.", sourceAttemptId: failedRun.id, idempotencyKey: key,
  });
  check("W7 the founder retry is approved", retried.outcome === "APPROVED" && Boolean(retried.newAttemptId), JSON.stringify(retried));
  check("W8 the job is queued again with a fresh claim budget",
    job(target.jobId).status === "queued" && job(target.jobId).attemptCount === 0
      && job(target.jobId).currentAttemptId === retried.newAttemptId && job(target.jobId).failureReason === null);
  const replay = await db.retryFailedProtocolJob({
    jobId: target.jobId, projectId: target.projectId, actor: FOUNDER,
    reason: "Perplexity returned HTTP 500 on run 3.", sourceAttemptId: failedRun.id, idempotencyKey: key,
  });
  check("W9 a replay of the key answers the same", replay.outcome === "APPROVED" && replay.newAttemptId === retried.newAttemptId);
  const second = await db.retryFailedProtocolJob({
    jobId: target.jobId, projectId: target.projectId, actor: FOUNDER,
    reason: "Perplexity returned HTTP 500 on run 3.", sourceAttemptId: failedRun.id, idempotencyKey: randomUUID(),
  });
  check("W10 a second key is refused: the job is no longer failed", second.outcome === "JOB_NOT_FAILED");
  const otherRun = attemptsOf(target.protocolId).find((a) => a.status === "completed")!;
  const conflict = await db.retryFailedProtocolJob({
    jobId: target.jobId, projectId: target.projectId, actor: FOUNDER,
    reason: "Perplexity returned HTTP 500 on run 3.", sourceAttemptId: otherRun.id, idempotencyKey: key,
  });
  check("W10b the same key for a different run is a conflict, never the first run's answer",
    conflict.outcome === "IDEMPOTENCY_KEY_CONFLICT", JSON.stringify(conflict));

  const idleAgain = await runLoop();
  check("W11 a queued job still does not run without its own Run", idleAgain[0]?.detail === "NO_RUN_REQUEST"
    && job(target.jobId).status === "queued");
  check("W12 the Run for the retried job is recorded", (await run(target)).outcome === "REQUESTED");
  failOnCall = null;
  const resumed = await runLoop();
  check("W13 the worker resumes and completes the plan", resumed[0]?.jobId === target.jobId
    && job(target.jobId).status === "succeeded", `${JSON.stringify(resumed)} ${job(target.jobId).status}`);
  const finalAttempts = attemptsOf(target.protocolId);
  const child = finalAttempts.find((a) => a.id === retried.newAttemptId);
  check("W14 every attempt is on record: 5 completed, 1 failed, 6 in all",
    finalAttempts.length === 6 && finalAttempts.filter((a) => a.status === "completed").length === 5
      && finalAttempts.filter((a) => a.status === "failed").length === 1,
    finalAttempts.map((a) => `${a.baselineOrdinal}:${a.status}`).join(","));
  check("W15 the completed retry sits in run 3's slot and names the run it retried",
    child?.status === "completed" && child.baselineOrdinal === 3 && child.retryOfAttemptId === failedRun.id);
  check("W16 the older job was never touched", job(older.jobId).status === "queued" && job(older.jobId).attemptCount === 0);

  // A request whose job is no longer claimable is refused, and the worker stops.
  check("W17 a Run for the older job is recorded", (await run(older)).outcome === "REQUESTED");
  const sneaky = await db.claimProtocolExecutionJob({ workerId: "global-claim", leaseSeconds: 30 });
  check("W18 (setup) the global claim takes the older job first", sneaky.job?.id === older.jobId);
  const refused = await runLoop();
  check("W19 the named job is no longer eligible: the request is refused and the worker stops",
    refused.length === 1 && refused[0].outcome === "run_request_refused" && refused[0].detail === "JOB_NOT_ELIGIBLE",
    JSON.stringify(refused));
  check("W20 the refusal is recorded on the request",
    [...store().protocolJobRunRequests.values()].some((r) => r.jobId === older.jobId && r.status === "refused" && r.refusalCode === "JOB_NOT_ELIGIBLE"));

  /* M: memory mirrors ----------------------------------------------------- */
  console.log("\n[M] memory mirrors");
  check("M1 while a job holds a live lease, a Run is WORKER_BUSY", (await run(target)).outcome === "WORKER_BUSY");
  await db.failProtocolExecutionJob({
    jobId: older.jobId, claimToken: sneaky.claimToken!, projectId: older.projectId, reason: "test_teardown",
  });
  const olderAttempt = attemptsOf(older.protocolId)[0];
  check("M2 a failure that is not a provider error cannot be retried",
    (await db.retryFailedProtocolJob({
      jobId: older.jobId, projectId: older.projectId, actor: FOUNDER, reason: "Trying a retry anyway.",
      sourceAttemptId: olderAttempt?.id ?? randomUUID(), idempotencyKey: randomUUID(),
    })).outcome === "JOB_NOT_RETRYABLE");
  check("M3 a failed request closes", (await db.closeFailedSnapshotRequest({
    requestId: older.requestId, closedBy: FOUNDER, reason: "The measurement stopped; closing it.",
  })) === "CLOSED" && (await db.getSnapshotRequest(older.requestId))?.status === "failed");
  check("M4 closing again replays", (await db.closeFailedSnapshotRequest({
    requestId: older.requestId, closedBy: FOUNDER, reason: "The measurement stopped; closing it.",
  })) === "ALREADY_CLOSED");
  check("M5 a request whose job succeeded cannot be closed", (await db.closeFailedSnapshotRequest({
    requestId: target.requestId, closedBy: FOUNDER, reason: "This should be refused here.",
  })) === "JOB_NOT_ENDED_IN_FAILURE");
  let refusedApproval = "";
  const pending = await db.createFounderSnapshotRequest({
    workEmail: "p@noprov.example", normalizedEmail: "p@noprov.example", companyName: "Co",
    websiteUrl: "https://noprov.example", normalizedDomain: "noprov.example", buyerCategory: QUESTION,
  });
  try {
    await db.approveAndLaunchSnapshotBaseline(pending.id, FOUNDER, ["Beta Co", "Gamma Co"], sha(QUESTION));
  } catch (error) {
    refusedApproval = error instanceof Error ? error.message : String(error);
  }
  check("M6 a founder-created approval without provenance is refused", refusedApproval === "question_provenance_required");
  const targetProtocol = await db.getProtocol(target.protocolId, target.projectId);
  const version = await db.getBuyerQuestionVersion(targetProtocol!.buyerQuestionVersionId, target.projectId);
  check("M7 the chosen provenance is stored with its rationale",
    version?.provenance === "founder_supplied" && version.rationale.includes("recommended or drafted by Zypact and entered by the founder"));

  /* F: the start path, with Fly and the run requests stubbed ------------- */
  console.log("\n[F] the start path");
  {
    const flyModule = await import("@/lib/worker-control/fly-machine");
    const savedFetch = globalThis.fetch;
    Object.assign(process.env, { FLY_WORKER_APP: "zypact-protocol-worker", FLY_WORKER_MACHINE_ID: "m1", FLY_API_TOKEN: "t" });
    flyModule.__setPaidExecutionGateForTests(async () => ({ ok: true as const, ceilingUsd: 10, spentLast24hUsd: 0, nextJobCapUsd: 0 }));
    let calls: string[] = [];
    let answer: "REQUESTED" | "ALREADY_REQUESTED" | "WORKER_BUSY" = "REQUESTED";
    let cancelAnswer: "CANCELLED" | "NOT_PENDING" = "CANCELLED";
    flyModule.__setRunRequestsForTests({
      request: async () => {
        calls.push("request");
        return answer === "WORKER_BUSY"
          ? { outcome: answer, requestId: null, expiresAt: null }
          : { outcome: answer, requestId: "r1", expiresAt: "2099-01-01T00:00:00.000Z" };
      },
      cancel: async (id: string) => {
        calls.push(`cancel:${id}`);
        return cancelAnswer;
      },
    });
    const stubFly = (status: number | "throw", previous = "stopped") => {
      globalThis.fetch = (async () => {
        calls.push("fly");
        if (status === "throw") throw new Error("network down");
        return new Response(JSON.stringify({ previous_state: previous }), { status });
      }) as typeof fetch;
    };
    const target = { jobId: "j1", projectId: "p1", via: "admin_run_pipeline" as const, requestedBy: FOUNDER };
    const start = async (a: typeof answer, status: number | "throw", previous = "stopped") => {
      answer = a;
      calls = [];
      stubFly(status, previous);
      return flyModule.startWorkerMachine(target);
    };

    const busy = await start("WORKER_BUSY", 200);
    check("F1 a refused run never reaches Fly", !busy.ok && busy.code === "run_request_refused" && calls.join() === "request");
    const failedOwn = await start("REQUESTED", 500);
    check("F2 a start Fly refuses withdraws the request it created", !failedOwn.ok && calls.join() === "request,fly,cancel:r1");
    const failedShared = await start("ALREADY_REQUESTED", 500);
    check("F3 it never withdraws a request an earlier start created", !failedShared.ok && calls.join() === "request,fly");
    const thrown = await start("REQUESTED", "throw");
    check("F4 a start whose Fly call throws withdraws its own request", !thrown.ok && calls.join() === "request,fly,cancel:r1");
    const upOwn = await start("REQUESTED", 200, "started");
    check("F5 a machine already running gets this press's new request withdrawn, and says so",
      upOwn.ok && upOwn.alreadyRunning && upOwn.runRequestWithdrawn && calls.join() === "request,fly,cancel:r1");
    const booting = await start("REQUESTED", 200, "starting");
    check("F5b a machine still booting keeps the request: its first claim may serve it",
      booting.ok && booting.alreadyRunning && !booting.runRequestWithdrawn && calls.join() === "request,fly");
    cancelAnswer = "NOT_PENDING";
    const taken = await start("REQUESTED", 200, "started");
    check("F5c a request the running worker already took is not reported as withdrawn",
      taken.ok && taken.alreadyRunning && !taken.runRequestWithdrawn && calls.join() === "request,fly,cancel:r1");
    cancelAnswer = "CANCELLED";
    const upShared = await start("ALREADY_REQUESTED", 200, "started");
    check("F6 a press for a job whose start is already pending leaves that request alone",
      upShared.ok && upShared.alreadyRunning && !upShared.runRequestWithdrawn && calls.join() === "request,fly");
    const fresh = await start("REQUESTED", 200, "stopped");
    check("F7 a normal start keeps its request for the worker it started",
      fresh.ok && !fresh.alreadyRunning && fresh.runRequestCreated && calls.join() === "request,fly");

    flyModule.__setPaidExecutionGateForTests(null);
    flyModule.__setRunRequestsForTests(null);
    globalThis.fetch = savedFetch;
    for (const key of ["FLY_WORKER_APP", "FLY_WORKER_MACHINE_ID", "FLY_API_TOKEN"]) delete process.env[key];
  }

  /* S: static contracts ---------------------------------------------------- */
  console.log("\n[S] static contracts");
  check("S1 the live runner claims only requested jobs", read("scripts/run-protocol-worker.ts").includes('claimScope: "requested"'));
  check("S1b the one-line no-request log is for single-job workers; a continuous worker keeps the idle proof",
    read("scripts/run-protocol-worker.ts").includes('r.detail === "NO_RUN_REQUEST" && cfg.exitAfterClaimedJob'));
  const cli = read("scripts/run-pipeline-once.ts");
  check("S1c the operator CLI names its job and withdraws only a request it created, after its worker exits",
    cli.includes('p_requested_via: "operator_cli"') && cli.includes('runOutcome === "REQUESTED" ? runRow?.request_id')
      && cli.indexOf("cancel_protocol_job_run_request") > cli.indexOf("await runProtocolWorker()"));
  const fly = read("lib/worker-control/fly-machine.ts");
  const startBody = fly.slice(fly.indexOf("export async function startWorkerMachine("));
  const iGate = startBody.indexOf("decision = await gate()");
  const iRequest = startBody.indexOf("runRequests.request(");
  const iFly = startBody.indexOf('flyFetch(config, "/start"');
  check("S2 a start requires its target, and names the job after the paid gate and before Fly",
    fly.includes("export async function startWorkerMachine(target: WorkerRunTarget)")
      && iGate > 0 && iRequest > iGate && iFly > iRequest, `${iGate}/${iRequest}/${iFly}`);
  check("S3 every withdrawal in the start path is guarded by this call having created the request",
    (startBody.match(/await withdraw\(runRequestId\)/g) ?? []).length === 3
      && /if \(created\) await withdraw\(runRequestId\)/.test(startBody)
      && /if \(created && \(status < 200 \|\| status >= 300\)\) await withdraw\(runRequestId\)/.test(startBody)
      && /if \(previous === "started" && created\)/.test(startBody));
  for (const [file, via, actor] of [
    ["app/api/internal/snapshot-requests/[requestId]/run-pipeline/route.ts", "admin_run_pipeline", "requestedBy: user.id"],
    ["app/api/internal/interventions/[interventionId]/run-retest/route.ts", "admin_run_retest", "requestedBy: guard.user.id"],
    ["app/api/internal/founder-baselines/[jobId]/run/route.ts", "admin_founder_baseline", "requestedBy: guard.user.id"],
  ] as const) {
    const src = read(file);
    check(`S4 ${path.basename(path.dirname(file))} names its job and the signed-in founder when it starts the worker`,
      src.includes("startWorkerMachine({") && src.includes(`via: "${via}"`) && src.includes(actor));
  }
  const runRoute = read("app/api/internal/snapshot-requests/[requestId]/run-pipeline/route.ts");
  check("S5 Run refuses an ended measurement before starting anything",
    ["\"failed\"", "\"abandoned_exhausted\"", "\"succeeded\""].every((s) => runRoute.indexOf(s) > 0 && runRoute.indexOf(s) < runRoute.indexOf("startWorkerMachine({")));
  for (const file of [
    "app/api/internal/snapshot-requests/[requestId]/retry-measurement/route.ts",
    "app/api/internal/snapshot-requests/[requestId]/close/route.ts",
  ]) {
    const src = read(file);
    check(`S6 ${path.basename(path.dirname(file))}: kill switch, then the founder guard, actor from the session`,
      src.indexOf('process.env.SNAPSHOT_APPROVAL_ENABLED !== "true"') > 0
        && src.indexOf('process.env.SNAPSHOT_APPROVAL_ENABLED !== "true"') < src.indexOf("requireFounderForRoute(")
        && /(actor|closedBy): guard\.user\.id/.test(src));
  }
  const retryRoute = read("app/api/internal/snapshot-requests/[requestId]/retry-measurement/route.ts");
  check("S7 the retry route never starts the worker and never takes the failed run from the body",
    !retryRoute.includes("startWorkerMachine") && !/sourceAttemptId\s*}\s*=\s*\(body/.test(retryRoute) && !retryRoute.includes("body.sourceAttemptId"));

  const DIR = "supabase/migrations";
  const FILE = "20261114120000_pilot_step1_operator_controls.sql";
  const versions = readdirSync(DIR).filter((f) => f.endsWith(".sql")).map((f) => parseMigrationName(f)).filter((r) => r.ok);
  const parsed = parseMigrationName(FILE);
  check("S8 the migration name is valid and is the newest", parsed.ok && parsed.kind === "timestamp"
    && Math.max(...versions.map((r) => (r.ok ? r.version : 0))) === (parsed.ok ? parsed.version : -1));
  const sql = read(path.join(DIR, FILE));
  const code = sql.replace(/--[^\n]*/g, "");
  const defined = [...code.matchAll(/create\s+or\s+replace\s+function\s+public\.([a-z_0-9]+)/gi)].map((m) => m[1]).sort();
  check("S9 it defines exactly the five new functions and the approval redefinition",
    defined.join(",") === [
      "approve_and_launch_snapshot_baseline", "cancel_protocol_job_run_request", "claim_requested_protocol_execution_job",
      "close_failed_snapshot_request", "request_protocol_job_run", "retry_failed_protocol_job",
    ].join(","), defined.join(","));
  const GUARDED = [
    "claim_protocol_execution_job", "claim_protocol_execution_job_by_id", "authorize_operator_retry",
    "reactivate_abandoned_job", "resolve_protocol_job_review", "complete_protocol_execution_job",
    "abort_attempt_and_fail_job_for_job", "admit_and_reserve_attempt_for_job", "_admit_and_reserve_attempt_core",
    "reconcile_attempt_for_job", "approve_protocol", "begin_snapshot_report_delivery",
  ];
  check("S10 it redefines none of the guarded M5/M7 functions",
    GUARDED.every((fn) => !new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\s*\\(`, "i").test(code)));
  const blocks = code.split(/create\s+or\s+replace\s+function/i).slice(1);
  check("S11 every function is SECURITY DEFINER with search_path pinned",
    blocks.length === 6 && blocks.every((b) => /security definer/i.test(b) && /set search_path = public, pg_temp/i.test(b)));
  const SIGNATURES = [
    "request_protocol_job_run(uuid, uuid, text, uuid, integer)",
    "cancel_protocol_job_run_request(uuid)",
    "claim_requested_protocol_execution_job(text, integer)",
    "retry_failed_protocol_job(uuid, uuid, uuid, text, uuid, text)",
    "close_failed_snapshot_request(uuid, uuid, text)",
  ];
  check("S12 each new function is revoked from public, anon and authenticated and granted to service_role only",
    SIGNATURES.every((s) => ["public", "anon", "authenticated"].every((r) => code.includes(`revoke all on function public.${s} from ${r};`))
      && code.includes(`grant execute on function public.${s} to service_role;`)));
  check("S13 both new tables are read-only to service_role and closed to every other role",
    ["protocol_job_run_requests", "snapshot_request_closures"].every((t) =>
      code.includes(`revoke all on table public.${t} from public, anon, authenticated, service_role;`)
        && code.includes(`grant select on table public.${t} to service_role;`)
        && code.includes(`alter table public.${t} enable row level security;`)));
  check("S14 no evidence row is written directly: no insert, update or delete of attempts, calls, receipts or probe rows",
    !/(insert\s+into|update|delete\s+from)\s+public\.(protocol_attempts|protocol_external_calls|provider_call_receipts|analysis_call_receipts|external_call_requests|probe_runs|probe_results)\b/i.test(code));
  check("S15 the only rows changed are a job's status fields, a request's status and the two new tables",
    [...code.matchAll(/update\s+public\.([a-z_]+)/gi)].every((m) =>
      ["protocol_execution_jobs", "protocol_job_run_requests", "snapshot_requests"].includes(m[1])));

  // Section 4 must be 0069's function with exactly the provenance change.
  const v0069 = read(path.join(DIR, "0069_new_baseline_default_five_runs.sql"));
  let expected = v0069.slice(v0069.indexOf("create or replace function\n  public.approve_and_launch_snapshot_baseline("));
  const swap = (from: string, to: string) => {
    if (!expected.includes(from)) throw new Error(`0069 no longer contains: ${from.slice(0, 60)}`);
    expected = expected.replace(from, to);
  };
  swap("    p_prompt_hash text\n  )\nreturns setof", "    p_prompt_hash text,\n    p_question_provenance text default null\n  )\nreturns setof");
  swap("  v_enqueue_status text;\nbegin", "  v_enqueue_status text;\n  v_provenance     text;\n  v_rationale      text;\nbegin");
  swap("    'Buyer question supplied directly by the requester via the public demo-request form; not independently scored.',\n    'customer_supplied'\n  )",
    "    v_rationale,\n    v_provenance\n  )");
  expected = expected.split("approve_and_launch_snapshot_baseline(uuid, uuid, jsonb, text)").join("approve_and_launch_snapshot_baseline(uuid, uuid, jsonb, text, text)");
  const actual = sql.slice(sql.indexOf("create or replace function\n  public.approve_and_launch_snapshot_baseline("));
  const block = actual.slice(actual.indexOf("  -- D-052: who wrote the question."), actual.indexOf("  -- Mirrors") > 0 ? actual.indexOf("  -- Mirrors") : undefined);
  const provenanceBlock = actual.slice(
    actual.indexOf("  -- D-052: who wrote the question."),
    actual.indexOf("  v_competitors := public._normalize_snapshot_competitors")
  );
  check("S16 the approval redefinition is 0069 plus only the provenance parameter, variables, block and insert values",
    actual.replace(provenanceBlock, "") === expected && block.length > 0,
    "the redefinition differs from 0069 outside the provenance change");
  check("S17 the provenance block sits after the replay and pending-approval checks",
    actual.indexOf("  -- D-052: who wrote the question.") > actual.indexOf("if v_request.status <> 'pending_approval' then")
      && actual.indexOf("if v_request.status <> 'pending_approval' then") > actual.indexOf("Idempotent replay"));
  check("S18 the four-argument approval is dropped before the five-argument one is created",
    sql.indexOf("drop function if exists public.approve_and_launch_snapshot_baseline(uuid, uuid, jsonb, text);")
      > 0 && sql.indexOf("drop function if exists public.approve_and_launch_snapshot_baseline(uuid, uuid, jsonb, text);")
      < sql.indexOf("create or replace function\n  public.approve_and_launch_snapshot_baseline("));

  /* C: copy ---------------------------------------------------------------- */
  console.log("\n[C] copy");
  const confirm = runConfirmationText({ plannedRuns: 5, runCap: 7, spendCapUsd: 2, stale: false });
  check("C1 the Run confirmation states this request only, the plan, the call ceiling and the cap",
    confirm.startsWith("Run the scan for this request now?") && confirm.includes("Only this request's measurement runs")
      && confirm.includes("5 planned runs") && confirm.includes("10 calls if nothing fails")
      && confirm.includes("at most 14 calls") && confirm.includes("$2.00") && confirm.includes("about 2 minutes"), confirm);
  check("C2 a resumed run says so, and an unknown plan never invents numbers",
    runConfirmationText({ plannedRuns: 5, runCap: 7, spendCapUsd: 2, stale: true }).startsWith("Resume the scan")
      && !/\d/.test(runConfirmationText({ plannedRuns: null, runCap: null, spendCapUsd: null, stale: false })));
  const button = read("app/admin/snapshot-requests/run-pipeline-button.tsx");
  check("C3 the old three-call, five-minute copy is gone",
    !button.includes("3 real, paid provider calls") && !button.includes("5-6 minutes")
      && !runRoute.includes("about 2 minutes per run"));
  check("C4b a finished measurement is never offered as a paid Run",
    button.includes('state.jobStatus === "succeeded"') && button.includes("Finished: report pending")
      && button.indexOf('state.jobStatus === "succeeded"') < button.lastIndexOf("onClick={start}"));
  const { runEndLabel } = await import("@/lib/reports/run-end-label");
  const view = read("components/report/protocol-report-view.tsx");
  check("C4f a run that ended without an answer is described in words, never by its stored code",
    runEndLabel("failed", "http_error:RECEIPTED") === "The AI engine returned an error"
      && runEndLabel("failed", "empty_answer:RECEIPTED") === "The AI engine returned an error"
      && runEndLabel("failed", "empty_provider_answer") === "The AI engine's answer was empty"
      && runEndLabel("completed", null) === null
      && view.includes("runEndLabel(run.status, run.terminationReason)") && !view.includes("{run.terminationReason}")
      && [runEndLabel("failed", "x"), runEndLabel("excluded", null), runEndLabel("timed_out", null)].every(
        (s) => s !== null && !FORBIDDEN_W1_PHRASES.some((p) => s.toLowerCase().includes(p))));
  check("C4c the report view shows sources only for a slot's readable run",
    read("components/report/protocol-report-view.tsx").includes('if (run.status !== "completed" || run.brandPresent === null) return "—";'));
  const retryRouteSrc = read("app/api/internal/snapshot-requests/[requestId]/retry-measurement/route.ts");
  check("C4d after a lost response the same click reaches the database: the route no longer skips a retried run",
    !retryRouteSrc.includes("retried.has(") && retryRouteSrc.includes('a.status === "failed" && a.baseline_ordinal === job.next_baseline_ordinal'));
  const panelSrc = read("app/admin/snapshot-requests/review-panel.tsx");
  check("C4e the panel takes a new retry key once the database has answered, never after a lost response",
    panelSrc.indexOf('if (endpoint === "retry-measurement") setRetryKey(crypto.randomUUID());')
      > panelSrc.indexOf("const data = await response.json();")
      && panelSrc.indexOf("const data = await response.json();") > 0);
  check("C4 a stopped measurement links to its page instead of offering Run",
    button.includes('state.jobStatus === "failed" || state.jobStatus === "abandoned_exhausted"') && button.includes("Stopped: open"));
  const pages: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "page.tsx" || entry.name === "layout.tsx") pages.push(full);
    }
  };
  walk(path.join(process.cwd(), "app"));
  const doubled = pages.filter((file) => {
    const src = readFileSync(file, "utf8");
    const m = src.match(/export const metadata[^=]*=\s*\{\s*(?:\/\/[^\n]*\n\s*)*title:\s*("[^"]*"|`[^`]*`)/);
    return m !== null && /Zypact/.test(m[1]);
  });
  check("C5 no page title names Zypact while the root template adds it again", doubled.length === 0,
    doubled.map((f) => path.relative(process.cwd(), f)).join(","));
  const reportPage = read("app/report/[secureToken]/page.tsx");
  check("C6 the report page is titled as the report itself is named, without 'visibility'",
    reportPage.includes('title: "Private AI answer snapshot",') && !/title:[^\n]*visibility/i.test(reportPage));
  check("C7 provenance reads as words in every client view",
    questionProvenanceLabel("customer_supplied") === "supplied by the requester"
      && questionProvenanceLabel("founder_supplied") === "supplied by Zypact"
      && questionProvenanceLabel("some_new_code") === "some new code");
  check("C8 the retest panel no longer says a queued retest runs on any start",
    !read("app/admin/interventions/[interventionId]/intervention-actions-panel.tsx").includes("for any reason, it runs"));

  const customerFacing = [
    ...Object.values(QUESTION_PROVENANCE_LABELS),
    "Private AI answer snapshot",
    "A private AI answer snapshot prepared by Zypact.",
    "Private Outcome Card",
  ];
  const lintHits = customerFacing.flatMap((s) => FORBIDDEN_W1_PHRASES.filter((p) => s.toLowerCase().includes(p)).map((p) => `${p} in "${s}"`));
  check("C9 the new customer-facing strings use none of the methodology's forbidden phrases",
    lintHits.length === 0 && customerFacing.slice(-3).every((s) => reportPage.includes(s) || read("app/outcome-card/[secureToken]/page.tsx").includes(s)),
    lintHits.join("; "));

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  console.log(failures === 0 ? "Pilot step 1 PASSED." : `${failures} check(s) failed. Pilot step 1 FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
