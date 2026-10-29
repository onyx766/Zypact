#!/usr/bin/env tsx
/**
 * PG-9 — the paid-execution gate against a real, disposable Supabase stack.
 *
 * The offline suites prove the gate's arithmetic over a fake PostgREST.
 * This proves it over the real one: the three service-role reads, the
 * exact counts, the database clock, the claim function's eligibility and
 * ordering, and the worker loop's refusal through the real adapter.
 *
 * OPT-IN ONLY: does nothing unless ZYPACT_PG9_STACK_TEST=1. Running it needs
 * a separate approval. Safety, matching test-m5-a-supabase-stack-runtime.ts:
 *   - a fresh `supabase init` under mktemp, never linked to a remote; the
 *     seed disabled and [api] confirmed enabled before start;
 *   - migrations copied byte-identically from an explicit allowlist
 *     (scripts/pg9-harness.ts): 0001-0081 and 0083, 0082 on HOLD;
 *   - the only credentials are the disposable stack's, held in memory and
 *     never printed; any pre-existing Supabase or provider variable is
 *     removed from this process before anything else runs;
 *   - a network guard refuses every fetch and socket that is not the
 *     stack's loopback API (the guard's record is asserted at the end);
 *   - psql runs only inside this stack's own database container, found by
 *     the project_id `supabase init` wrote; no other container is touched,
 *     never `docker prune`;
 *   - `supabase stop --no-backup` only after full success; otherwise the
 *     workdir is printed and the stack left for inspection.
 *
 * Results are reported in two classes (PG9_CASES): assertions, which must
 * pass, and limitations, which must reproduce a documented gap of the gate
 * (G1 concurrency, G3 read-to-claim change, G4 clock skew). A limitation is
 * never reported as a pass.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { sha256Hex } from "@/lib/evidence/hash";
import type { DbAdapter, ProtocolExecutionJob } from "@/lib/db/types";
import type { AnalysisTransport, IterationResult, WorkerDeps, WorkerOptions } from "@/lib/protocol-worker/types";
import type { ProbeAnalysisM5Parsed } from "@/lib/protocol-worker/analysis-m5";
import type { PerplexityProbeResult } from "@/lib/probes/perplexity";
import type { PaidExecutionDecision } from "@/lib/worker-control/paid-execution-gate";
import { PG9_API_ORIGIN, PG9_CASES, installLocalOnlyNetworkGuard, type NetworkGuard } from "./pg9-harness";
import { describeError, reportLifecycle, runPg9Lifecycle, type LifecycleResult, type StackContext } from "./pg9-lifecycle";

const REPO_ROOT = process.cwd();

/**
 * Run only as the entry point. Imported (by test-pg9-harness-offline.ts, for
 * the fixture helpers below), this module starts nothing and exits nothing.
 */
const IS_ENTRY = /test-pg9-paid-gate-runtime\.ts$/.test(process.argv[1] ?? "");

if (IS_ENTRY && process.env.ZYPACT_PG9_STACK_TEST !== "1") {
  console.log("\n[PG-9] not requested — set ZYPACT_PG9_STACK_TEST=1 (needs Docker + the Supabase CLI, and separate approval).");
  console.log("[PG-9] NOTHING was started, migrated or validated by this run. PG-9 remains OPEN.");
  process.exit(0);
}

/* ─────────────────────────── results, in two classes ─────────────────────────── */

const results = new Map<string, { ok: boolean; notes: string[] }>();
let harnessChecks = 0;
let harnessFailures = 0;
function harness(name: string, ok: boolean, detail = ""): void {
  harnessChecks += 1;
  if (!ok) harnessFailures += 1;
  console.log(`${ok ? "✓" : "✗"} [harness] ${name}${detail ? ` — ${detail}` : ""}`);
}
function record(caseId: string, name: string, ok: boolean, detail = ""): void {
  const r = results.get(caseId) ?? { ok: true, notes: [] };
  r.ok = r.ok && ok;
  r.notes.push(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  results.set(caseId, r);
  console.log(`${ok ? "✓" : "✗"} [${caseId}] ${name}${detail ? ` — ${detail}` : ""}`);
}
function must<T>(v: T | null | undefined, label: string): T {
  if (v === null || v === undefined) throw new Error(`missing ${label}`);
  return v;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Reads `supabase status -o env` without ever printing a value. */
function serviceRoleKeyFrom(ctx: StackContext): string {
  const out = ctx.exec("supabase", ["status", "-o", "env", "--workdir", ctx.workdir]);
  for (const line of out.split("\n")) {
    const m = /^SERVICE_ROLE_KEY="?([^"]+)"?$/.exec(line.trim());
    if (m) return m[1];
  }
  throw new Error("supabase status did not report SERVICE_ROLE_KEY");
}

/* ─────────────────────────── psql, with bounded failures ─────────────────────────── */

/** What `docker exec … psql` failed with, reduced to something safe to print. */
export interface PsqlFailure {
  /** The first `ERROR:`/`FATAL:`/`PANIC:` line of stderr, one line, bounded and redacted; null if none was found. */
  errorLine: string | null;
  /** What a thrown failure says: never the command, its arguments, the SQL or unbounded stderr. */
  safeMessage: string;
}

const PSQL_NO_ERROR_LINE = "psql failed: no PostgreSQL ERROR line could be extracted (see the database log)";

/**
 * execFileSync's Error message begins with the whole command line, SQL
 * included, so it is never used. Only stderr is read, and only its first
 * PostgreSQL error line (`DETAIL:` and later lines can carry row values).
 */
export function psqlFailure(e: unknown): PsqlFailure {
  const raw = (e as { stderr?: unknown } | null)?.stderr;
  const stderr = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : "";
  const line = stderr.split(/\r?\n/).map((l) => l.trim()).find((l) => /^(ERROR|FATAL|PANIC):\s/.test(l)) ?? null;
  if (line === null) return { errorLine: null, safeMessage: PSQL_NO_ERROR_LINE };
  // describeError on a string redacts, flattens and clips (200).
  const errorLine = describeError(line.replace(/\s+/g, " "));
  return { errorLine, safeMessage: `psql failed: ${errorLine}` };
}

export type PsqlExec = (cmd: string, args: string[], opts: { encoding: "utf8"; stdio: ["ignore", "pipe", "pipe"] }) => string;

/** psql against this run's own database container only. */
export function psqlRunner(container: string, exec: PsqlExec = execFileSync as unknown as PsqlExec) {
  const run = (sql: string): string =>
    exec("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tAc", sql],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const psql = (sql: string): string => {
    try {
      return run(sql);
    } catch (e) {
      throw new Error(psqlFailure(e).safeMessage);
    }
  };
  /** For statements EXPECTED to fail (P14): `stderr` is the safe PostgreSQL error line, or "". */
  const psqlFails = (sql: string): { failed: boolean; stderr: string } => {
    try {
      run(sql);
      return { failed: false, stderr: "" };
    } catch (e) {
      return { failed: true, stderr: psqlFailure(e).errorLine ?? "" };
    }
  };
  return { psql, psqlFails };
}

/* ─────────────────────────── fixture claim contract ─────────────────────────── */

export interface FixtureJobOptions {
  plannedBaselineRuns?: number;
  /** Omitted: the enqueue default (3). 1: a job the targeted claim may take. */
  maxAttempts?: number;
}

/**
 * One independent baseline: its own buyer question and approved version, an
 * approved protocol on that version, and its queued job. `maxAttempts` is
 * passed through only when given.
 *
 * A fresh question per baseline is required, not incidental: 0073's
 * protocols_one_live_baseline_per_version allows at most ONE approved/active
 * baseline protocol per buyer-question version (a retest reuses its
 * baseline's version on purpose). Sharing one version across fixture
 * baselines made the second approve_protocol fail with 23505 (run
 * 40890954215).
 */
export function fixtureJobFactory(db: DbAdapter, ids: { projectId: string }) {
  return async (spendCapUsd: number, o: FixtureJobOptions = {}): Promise<ProtocolExecutionJob> => {
    const question = await db.createBuyerQuestion({ projectId: ids.projectId });
    const version = await db.createBuyerQuestionVersion({
      buyerQuestionId: question.id, projectId: ids.projectId, versionNumber: 1, promptText: QUESTION,
      promptHash: sha256Hex(QUESTION), intentType: "comparison", commercialValue: 3, winnability: 3, priority: 10,
      rationale: "fixture", provenance: "founder_supplied",
    });
    await db.approveBuyerQuestionVersion({ versionId: version.id, projectId: ids.projectId, approvedBy: APPROVER });
    const protocol = await db.createProtocol({
      projectId: ids.projectId, buyerQuestionVersionId: version.id, provider: "perplexity", surface: "sonar",
      plannedBaselineRuns: o.plannedBaselineRuns ?? 1, plannedRetestRuns: 0, paraphrasePlan: [{ text: QUESTION, hash: sha256Hex(QUESTION) }],
      unitOfAnalysis: "run", primaryMetric: "listed_in_run", samplePlanningMethod: "fixed",
      runCap: 20, spendCapUsd, timeWindowSeconds: 3600, rateLimitPerHour: 100, concurrencyLimit: 5, retryCap: 2,
    });
    await db.approveProtocol({ protocolId: protocol.id, projectId: ids.projectId, approvedBy: APPROVER });
    const enqueued = await db.enqueueProtocolExecutionJob({
      protocolId: protocol.id, projectId: ids.projectId, ...(o.maxAttempts === undefined ? {} : { maxAttempts: o.maxAttempts }),
    });
    return must(enqueued.job, `enqueued job (${enqueued.outcome})`);
  };
}

/**
 * The two ways a fixture takes a job, matching the two claim functions:
 *
 *   claimById   the targeted claim (0059). Its contract admits only a queued,
 *               untouched job with max_attempts = 1; anything else is
 *               JOB_NOT_ELIGIBLE. So it refuses a multi-attempt job before
 *               calling, and a one-attempt job it claims is exhausted (1 of 1)
 *               once its lease lapses — the shape of a one-shot fixture.
 *   claimNext   the ordinary claim (0054), oldest eligible job first, for
 *               multi-attempt jobs that must stay "claimed with attempts left".
 *               It must take exactly the job the fixture expects.
 *
 * Both require CLAIMED, the expected job id and a claim token, and a refusal
 * names only the RPC's closed outcome — never a token or a body.
 */
export function fixtureClaims(db: DbAdapter, workerId = "pg9-fixture") {
  const claimById = async (job: ProtocolExecutionJob, leaseSeconds = 600) => {
    if (job.maxAttempts !== 1) {
      throw new Error(`targeted claim is for one-attempt jobs; this fixture job has maxAttempts=${job.maxAttempts}`);
    }
    const c = await db.claimProtocolExecutionJobById({ workerId, leaseSeconds, jobId: job.id, projectId: job.projectId });
    if (c.outcome !== "CLAIMED") throw new Error(`targeted claim refused: ${c.outcome}`);
    if (!c.job || c.job.id !== job.id || !c.claimToken) throw new Error("targeted claim returned CLAIMED without this job and a token");
    return { job: c.job, claimToken: c.claimToken };
  };
  const claimNext = async (expected: ProtocolExecutionJob, leaseSeconds = 600) => {
    if (expected.maxAttempts < 2) {
      throw new Error(`ordinary claim is for multi-attempt jobs; this fixture job has maxAttempts=${expected.maxAttempts}`);
    }
    const c = await db.claimProtocolExecutionJob({ workerId, leaseSeconds });
    if (c.outcome !== "CLAIMED") throw new Error(`ordinary claim refused: ${c.outcome}`);
    if (!c.job || !c.claimToken) throw new Error("ordinary claim returned CLAIMED without a job and a token");
    if (c.job.id !== expected.id) throw new Error("ordinary claim took a different job than the fixture expected (oldest eligible first)");
    return { job: c.job, claimToken: c.claimToken };
  };
  return { claimById, claimNext };
}

/* ─────────────────────────── fixtures ─────────────────────────── */

const APPROVER = "11111111-1111-4111-8111-111111111111";
const QUESTION = "Which vendors handle X best?";
const ANSWER = "Acme Rival and Example Client are both options.";
const PROVIDER_BODY = JSON.stringify({ id: "req-fixture", choices: [{ message: { content: ANSWER } }] });
const ANALYSIS_BODY = JSON.stringify({ model: "gpt-4o-mini", messages: [] });
const M5_OUTPUT: ProbeAnalysisM5Parsed = {
  clientPosition: "listed",
  competitorsMentioned: [{ name: "Acme Rival", position: 1, context: "listed first" }],
  sourcesCited: [{ source: "g2.com/products/example", type: "review_site" }],
  answerSummary: "Two vendors are listed.",
};
const M5_CONTENT = JSON.stringify(M5_OUTPUT);
const ON = (ceiling: string) => ({ ZYPACT_PAID_EXECUTION_ENABLED: "true", ZYPACT_DAILY_SPEND_CEILING_USD: ceiling });

async function main(): Promise<void> {
  // ── 0. nothing from the caller's environment reaches this process's clients
  for (const k of Object.keys(process.env)) {
    if (/^(NEXT_PUBLIC_SUPABASE_|SUPABASE_|PERPLEXITY_|OPENAI_|ANTHROPIC_|ZYPACT_PAID_|ZYPACT_DAILY_)/.test(k)) delete process.env[k];
  }
  const guard = installLocalOnlyNetworkGuard();
  let result: LifecycleResult;
  try {
    // Preflight, start, cases, stop: scripts/pg9-lifecycle.ts. Any preflight
    // failure ends before `supabase start`; any later failure keeps the
    // workdir and reports what is running; a failed stop fails the run.
    result = await runPg9Lifecycle({
      migrationsDir: path.join(REPO_ROOT, "supabase", "migrations"),
      body: async (ctx) => {
        await runCases(ctx, guard);
        return summary(false).success;
      },
    });
  } finally {
    guard.restore();
  }
  for (const m of result.migrations) console.log(`  migration ${m.file} sha256=${m.sha256}`);
  const s = summary(true);
  reportLifecycle(result);
  const success = result.status === "passed" && s.success;
  console.log(success
    ? "\nPG-9 stack run PASSED (limitations above are demonstrated gaps, not passes)."
    : `\nPG-9 stack run FAILED (lifecycle: ${result.status}).`);
  process.exitCode = success ? 0 : 1;
}

/** The cases, against the started stack. Recorded into `results`; never throws past a restore. */
async function runCases(ctx: StackContext, guard: NetworkGuard): Promise<void> {
  const { container } = ctx;
  const { psql, psqlFails } = psqlRunner(container);

  process.env.NEXT_PUBLIC_SUPABASE_URL = PG9_API_ORIGIN;
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKeyFrom(ctx);
  harness("the client points only at the disposable stack", new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin === PG9_API_ORIGIN);
  const { getDb } = await import("@/lib/db");
  const { getReportServiceClient } = await import("@/lib/reports/service-client");
  const { evaluatePaidExecution, paidExecutionGateFor } = await import("@/lib/worker-control/paid-execution-gate");
  const { runWorkerLoop } = await import("@/lib/protocol-worker/worker");
  const { WorkerHealth } = await import("@/lib/protocol-worker/health");
  const db: DbAdapter = getDb();
  const service = getReportServiceClient();

  /** A client that counts every PostgREST read it starts. */
  const counting = () => {
    let reads = 0;
    const client = new Proxy(service, {
      get(target, prop, recv) {
        if (prop === "from") return (t: string) => { reads += 1; return target.from(t); };
        return Reflect.get(target, prop, recv);
      },
    }) as SupabaseClient;
    return { client, reads: () => reads };
  };
  const dbNowMs = (): number => Math.round(Number(psql("select extract(epoch from clock_timestamp()) * 1000")));
  const gate = (env: Record<string, string>, nowMs?: number, client: SupabaseClient = service): Promise<PaidExecutionDecision> =>
    evaluatePaidExecution({ client, env, now: () => new Date(nowMs ?? dbNowMs()) });

  // ── fixtures
  const project = await db.createProject({ domain: "pg9.example.test", companyName: "PG-9 Fixture" });
  const makeJob = fixtureJobFactory(db, { projectId: project.id });
  const { claimById, claimNext } = fixtureClaims(db);
  /**
   * One ledger row with the given shape. Created through the real claim and
   * admission RPCs (two calls), then — disposable database only — the
   * perplexity call is given the age and cost under test and the analysis
   * call is moved out of the window; the job is closed so it is not claimable.
   */
  const ledgerRow = async (o: { ageSeconds: number; reserved: number; actual: number | null; basis: "measured" | "estimated" | null }) => {
    // Admitted once, then closed: a one-attempt job, taken by the targeted claim.
    const job = await makeJob(100, { maxAttempts: 1 });
    const c = await claimById(job);
    const a = await db.admitAndReserveAttemptForJob({
      jobId: job.id, claimToken: c.claimToken, projectId: job.projectId, attemptKind: "baseline",
      idempotencyKey: `${job.id}:baseline:1`, perplexityReservedCostUsd: o.reserved, analysisReservedCostUsd: 0.01,
    });
    const p = must(a.perplexityCall, "perplexity call");
    const an = must(a.analysisCall, "analysis call");
    psql(`update public.protocol_external_calls set created_at = clock_timestamp() - make_interval(secs => ${o.ageSeconds}),
            reserved_cost_usd = ${o.reserved}, actual_cost_usd = ${o.actual === null ? "null" : o.actual},
            cost_basis = ${o.basis === null ? "null" : `'${o.basis}'`} where id = '${p.id}'`);
    psql(`update public.protocol_external_calls set created_at = clock_timestamp() - interval '30 days' where id = '${an.id}'`);
    psql(`update public.protocol_execution_jobs set status = 'failed', failure_reason = 'pg9_fixture' where id = '${job.id}'`);
    return p.id;
  };
  /** Every case starts from an empty window and no claimable job. Disposable database only. */
  const reset = async () => {
    psql("update public.protocol_external_calls set created_at = clock_timestamp() - interval '30 days'");
    psql(`update public.protocol_execution_jobs set status = 'failed', failure_reason = 'pg9_reset'
            where status in ('queued', 'claimed', 'running')`);
    const d = await gate(ON("50"));
    if (!(d.ok && d.spentLast24hUsd === 0 && d.nextJobCapUsd === 0)) throw new Error(`reset did not empty the gate: ${JSON.stringify(d)}`);
  };
  const snapshot = (): string => psql(`select md5(coalesce(string_agg(x, '|' order by x), '')) from (
      select row_to_json(j)::text x from public.protocol_execution_jobs j
      union all select row_to_json(a)::text from public.protocol_attempts a
      union all select row_to_json(c)::text from public.protocol_external_calls c
      union all select row_to_json(r)::text from public.provider_call_receipts r) s`);

  const spy = { providerFetches: 0, analysisExecutes: 0 };
  const analysis: AnalysisTransport = {
    prepare: () => ({ provider: "openai" as const, model: "gpt-4o-mini", url: "https://api.openai.com/v1/chat/completions",
      rawRequestBody: ANALYSIS_BODY, requestSha256: sha256Hex(ANALYSIS_BODY) }),
    execute: async () => {
      spy.analysisExecutes += 1;
      return { provider: "openai" as const, model: "gpt-4o-mini", content: M5_CONTENT, usedMock: false, modelReturned: null,
        latencyMs: 5, requestSha256: sha256Hex(ANALYSIS_BODY), contentSha256: sha256Hex(M5_CONTENT),
        providerRequestId: "analysis-fixture", httpStatus: 200 };
    },
  };
  const deps: WorkerDeps = {
    db, analysis, now: () => Date.now(), sleep: async () => {}, probeMode: "live_perplexity",
    // Never the network: the injected transport counts instead.
    realFetch: (async () => { spy.providerFetches += 1; return new Response("{}", { status: 200 }); }) as typeof fetch,
    runProbe: (async (input) => {
      await (input.fetchImpl ?? fetch)("https://api.perplexity.ai/v1/sonar", { method: "POST", body: "{}" });
      return { prompt: input.prompt, answer: ANSWER, rawResponse: PROVIDER_BODY, citations: [], searchResults: [], sourceCitations: [],
        model: "sonar", usedMock: false, rawResponseBody: PROVIDER_BODY, rawResponseBodySha256: sha256Hex(PROVIDER_BODY),
        httpStatus: 200, latencyMs: 7, providerRequestId: "req-fixture" } satisfies PerplexityProbeResult;
    }) as WorkerDeps["runProbe"],
  };
  const opts: WorkerOptions = {
    workerId: "pg9-worker", leaseSeconds: 60, idleBackoffMs: 1, maxBackoffMs: 2, maxSlotsPerClaim: 8,
    perplexityReservedCostUsd: 0.02, analysisReservedCostUsd: 0.02, jitterRatio: 0, maxThrottledRetries: 0, graceMs: 1000,
    exitAfterClaimedJob: true, providerTimeoutMs: 45000, runtimeBound: { allowsNewClaim: () => true },
  };
  const loop = async (env: Record<string, string>): Promise<IterationResult[]> => {
    const seen: IterationResult[] = [];
    await runWorkerLoop(deps, opts, paidExecutionGateFor(getReportServiceClient, env), { aborted: false }, async () => {},
      (r) => seen.push(r), new WorkerHealth(deps.now));
    return seen;
  };
  const attemptCount = (jobId: string) => Number(psql(`select attempt_count from public.protocol_execution_jobs where id = '${jobId}'`));

  /* ═══ P1 configuration refuses before any read ═══ */
  for (const [label, env] of [
    ["switch missing", {}], ["switch \"TRUE \"", { ZYPACT_PAID_EXECUTION_ENABLED: "TRUE ", ZYPACT_DAILY_SPEND_CEILING_USD: "5" }],
    ["switch \"false\"", { ZYPACT_PAID_EXECUTION_ENABLED: "false", ZYPACT_DAILY_SPEND_CEILING_USD: "5" }],
    ["ceiling missing", { ZYPACT_PAID_EXECUTION_ENABLED: "true" }], ["ceiling \"abc\"", ON("abc")], ["ceiling 0", ON("0")],
    ["ceiling -1", ON("-1")], ["ceiling 51", ON("51")], ["ceiling 1e2", ON("1e2")],
  ] as const) {
    const c = counting();
    const d = await gate(env as Record<string, string>, undefined, c.client);
    record("P1", `${label} → refused with zero stack reads`,
      !d.ok && (d.code === "paid_execution_disabled" || d.code === "spend_ceiling_not_configured") && c.reads() === 0,
      `${d.ok ? "ok" : d.code} reads=${c.reads()}`);
  }

  /* ═══ P2 the 24-hour ledger, by basis, on the database clock ═══ */
  await reset();
  await ledgerRow({ ageSeconds: 3600, reserved: 0.02, actual: 0.004, basis: "measured" });
  await ledgerRow({ ageSeconds: 86_340, reserved: 0.02, actual: 0.003, basis: "estimated" });
  await ledgerRow({ ageSeconds: 600, reserved: 0.02, actual: null, basis: null });
  await ledgerRow({ ageSeconds: 86_460, reserved: 0.5, actual: null, basis: null });
  await ledgerRow({ ageSeconds: 172_800, reserved: 9, actual: 9, basis: "measured" });
  {
    const d = await gate(ON("50"));
    record("P2", "measured counts actual, estimated max(actual, reserved), in-flight reserved; outside 24h ignored",
      d.ok && Math.abs(d.spentLast24hUsd - (0.004 + 0.02 + 0.02)) < 1e-9, JSON.stringify(d));
  }

  /* ═══ P3 the largest eligible cap ═══ */
  await reset();
  {
    // Claimed jobs with attempts left need the ordinary claim on multi-attempt
    // jobs; each is created and claimed while it is the only eligible job, so
    // oldest-first takes exactly it. The exhausted job is a one-attempt job,
    // exhausted naturally (1 of 1). Leases move only after every claim, and
    // the queued job is created last so no claim takes it.
    const live = await makeJob(2); await claimNext(live, 600);
    const expired = await makeJob(1.5); await claimNext(expired, 600);
    const exhausted = await makeJob(9, { maxAttempts: 1 }); await claimById(exhausted, 600);
    for (const [cap, sql] of [
      [7, "status = 'failed', failure_reason = 'pg9_fixture'"],
      [8, "status = 'needs_review', needs_review_reason = 'pg9_fixture'"],
      [6, "status = 'abandoned_exhausted'"],
    ] as const) {
      const j = await makeJob(cap);
      psql(`update public.protocol_execution_jobs set ${sql} where id = '${j.id}'`);
    }
    const queued = await makeJob(0.5);
    psql(`update public.protocol_execution_jobs set lease_expires_at = clock_timestamp() - interval '1 minute' where id in ('${expired.id}', '${exhausted.id}')`);
    const d = await gate(ON("50"));
    record("P3", "largest of queued (0.5), live claim (2), expired-with-attempts (1.5); exhausted (9) and terminal (7, 8, 6) excluded",
      d.ok && d.nextJobCapUsd === 2, JSON.stringify(d));
    psql(`update public.protocol_execution_jobs set status = 'failed', failure_reason = 'pg9_fixture' where id = '${live.id}'`);
    const d2 = await gate(ON("50"));
    record("P3", "closing the largest moves the answer to the next eligible (1.5)", d2.ok && d2.nextJobCapUsd === 1.5, JSON.stringify(d2));
    void queued;
  }

  /* ═══ P4 the boundary ═══ */
  await reset();
  await ledgerRow({ ageSeconds: 60, reserved: 0.25, actual: null, basis: null });
  await makeJob(0.5);
  {
    const at = await gate(ON("0.75"));
    const over = await gate(ON("0.7499"));
    record("P4", "spent + cap == ceiling is allowed", at.ok, JSON.stringify(at));
    record("P4", "one hundredth of a cent over is refused", !over.ok && over.code === "spend_ceiling_reached", JSON.stringify(over));
  }

  /* ═══ P5 a refusal changes nothing ═══ */
  await reset();
  await ledgerRow({ ageSeconds: 60, reserved: 1, actual: null, basis: null });
  {
    const job = await makeJob(0.5);
    const before = snapshot();
    const fetchesBefore = spy.providerFetches;
    const seen = await loop(ON("1.4"));
    record("P5", "the real loop ends with paid_execution_refused", seen.length === 1 && seen[0].outcome === "paid_execution_refused"
      && seen[0].detail === "spend_ceiling_reached", JSON.stringify(seen));
    record("P5", "jobs, attempts, calls and receipts are byte-identical", snapshot() === before);
    record("P5", "no claim and no provider call", attemptCount(job.id) === 0 && spy.providerFetches === fetchesBefore);
  }

  /* ═══ P6 allowed once; the next read sees its spend ═══ */
  await reset();
  {
    const first = await makeJob(0.5);
    const seen = await loop(ON("5"));
    record("P6", "allowed: exactly one claim, and the job ran", attemptCount(first.id) === 1 && seen.some((r) => r.outcome === "completed"),
      JSON.stringify(seen.map((r) => r.outcome)));
    const after = await gate(ON("50"));
    record("P6", "its calls are in the next read", after.ok && after.spentLast24hUsd > 0, JSON.stringify(after));
    const second = await makeJob(0.5);
    const spent = after.ok ? after.spentLast24hUsd : 0;
    const seen2 = await loop(ON(String(Math.max(0.01, Number((spent + 0.5 - 0.001).toFixed(4))))));
    record("P6", "a ceiling below that spend plus the next cap refuses the second claim",
      seen2[0]?.outcome === "paid_execution_refused" && attemptCount(second.id) === 0, JSON.stringify(seen2));
  }

  /* ═══ P7 expired and exhausted: gate and claim agree ═══ */
  await reset();
  {
    // Expired with attempts left: a multi-attempt job, ordinary claim. Exhausted:
    // a one-attempt job, targeted claim (1 of 1). Leases move after both claims.
    const expired = await makeJob(1.5); await claimNext(expired, 600);
    const exhausted = await makeJob(9, { maxAttempts: 1 }); await claimById(exhausted, 600);
    psql(`update public.protocol_execution_jobs set lease_expires_at = clock_timestamp() - interval '1 minute' where id in ('${expired.id}', '${exhausted.id}')`);
    const d = await gate(ON("50"));
    record("P7", "the gate counts the expired job with attempts left (1.5), not the exhausted one (9)", d.ok && d.nextJobCapUsd === 1.5, JSON.stringify(d));
    const c = await db.claimProtocolExecutionJob({ workerId: "pg9-claimer", leaseSeconds: 60 });
    record("P7", "the real claim takes that same expired job", c.job?.id === expired.id, String(c.job?.id === expired.id));
    record("P7", "and the same claim swept the exhausted job to abandoned_exhausted, with its alert",
      psql(`select status from public.protocol_execution_jobs where id = '${exhausted.id}'`) === "abandoned_exhausted"
        && Number(psql(`select count(*) from public.protocol_execution_job_alerts where job_id = '${exhausted.id}' and event_type = 'abandoned_exhausted'`)) === 1);
  }

  /* ═══ P8 LIMITATION G1: concurrent workers ═══ */
  await reset();
  {
    const a = await makeJob(2);
    const b = await makeJob(2);
    const [ga, gb] = await Promise.all([gate(ON("3")), gate(ON("3"))]);
    const [ca, cb] = await Promise.all([
      db.claimProtocolExecutionJob({ workerId: "pg9-w1", leaseSeconds: 60 }),
      db.claimProtocolExecutionJob({ workerId: "pg9-w2", leaseSeconds: 60 }),
    ]);
    const ids = new Set([ca.job?.id, cb.job?.id]);
    record("P8", "both workers' reads allow on the same state (0 + 2 ≤ 3)", ga.ok && gb.ok);
    record("P8", "both claims succeed, on two different jobs (the gate does not serialise claims)",
      ca.outcome === "CLAIMED" && cb.outcome === "CLAIMED" && ids.size === 2 && ids.has(a.id) && ids.has(b.id));
    const claimedCaps = Number(psql(`select coalesce(sum(p.spend_cap_usd), 0) from public.protocol_execution_jobs j
        join public.protocols p on p.id = j.protocol_id where j.status = 'claimed' and j.worker_id in ('pg9-w1', 'pg9-w2')`));
    record("P8", "the claimed jobs' caps, read from the database, exceed the ceiling — exposure neither read counted",
      claimedCaps > 3, `caps=${claimedCaps} ceiling=3`);
  }

  /* ═══ P9 LIMITATION G3: the queue changes between read and claim ═══ */
  await reset();
  {
    const a = await makeJob(0.5);
    const read = await gate(ON("1"));
    const other = await db.claimProtocolExecutionJob({ workerId: "pg9-other", leaseSeconds: 600 });
    const b = await makeJob(5);
    const ours = await db.claimProtocolExecutionJob({ workerId: "pg9-ours", leaseSeconds: 60 });
    record("P9", "our read allowed with the oldest eligible job at cap 0.5", read.ok && read.nextJobCapUsd === 0.5, JSON.stringify(read));
    record("P9", "another worker took that oldest job first (claim order respected)", other.job?.id === a.id);
    record("P9", "our claim then took the oldest eligible job left — enqueued after our read, cap 5 > ceiling 1",
      ours.job?.id === b.id);
  }

  /* ═══ P11 an incomplete ledger window ═══ */
  await reset();
  {
    const template = await ledgerRow({ ageSeconds: 60, reserved: 0.0001, actual: null, basis: null });
    // 1000 copies of one in-window call (generations 2..1001), disposable database only.
    psql(`insert into public.protocol_external_calls
            select (jsonb_populate_record(null::public.protocol_external_calls,
              to_jsonb(t) || jsonb_build_object('id', gen_random_uuid(), 'call_kind', 'analysis', 'generation', 1 + g))).*
            from public.protocol_external_calls t, generate_series(1, 1000) g where t.id = '${template}'`);
    const d = await gate(ON("50"));
    record("P11", "1001 calls in the window, read limit 1000 → spend_ledger_unavailable",
      !d.ok && d.code === "spend_ledger_unavailable", JSON.stringify(d));
  }

  /* ═══ P12 a job queue larger than max_rows (C1) ═══ */
  await reset();
  {
    // 1000 copies of one complete baseline identity chain — question, approved
    // version, approved protocol, dataset batch, queued job — each with new
    // ids, in ONE statement (foreign keys are checked at its end). Every copy
    // gets its own version (0073's one live baseline per version) and its own
    // dataset batch in the same project (0052: dataset_batch_id NOT NULL,
    // UNIQUE, FK (dataset_batch_id, project_id)). Disposable database only.
    const template = await makeJob(0.5);
    const tVersion = psql(`select buyer_question_version_id from public.protocols where id = '${template.protocolId}'`);
    const tQuestion = psql(`select buyer_question_id from public.buyer_question_versions where id = '${tVersion}'`);
    const tBatch = psql(`select dataset_batch_id from public.protocol_execution_jobs where id = '${template.id}'`);
    if (![tVersion, tQuestion, tBatch].every((x) => /^[0-9a-f-]{36}$/.test(x))) throw new Error("P12 template identities are incomplete");
    const inserted = psql(`with g as (
            select gen_random_uuid() as qid, gen_random_uuid() as vid, gen_random_uuid() as pid,
                   gen_random_uuid() as bid, gen_random_uuid() as jid
              from generate_series(1, 1000)),
          q as (insert into public.buyer_questions
              select (jsonb_populate_record(null::public.buyer_questions, to_jsonb(t) || jsonb_build_object('id', g.qid))).*
              from public.buyer_questions t, g where t.id = '${tQuestion}'
            returning id),
          v as (insert into public.buyer_question_versions
              select (jsonb_populate_record(null::public.buyer_question_versions, to_jsonb(t) || jsonb_build_object(
                'id', g.vid, 'buyer_question_id', g.qid))).*
              from public.buyer_question_versions t, g where t.id = '${tVersion}'
            returning id),
          p as (insert into public.protocols
              select (jsonb_populate_record(null::public.protocols, to_jsonb(t) || jsonb_build_object(
                'id', g.pid, 'buyer_question_version_id', g.vid))).*
              from public.protocols t, g where t.id = '${template.protocolId}'
            returning id),
          b as (insert into public.dataset_batches
              select (jsonb_populate_record(null::public.dataset_batches, to_jsonb(t) || jsonb_build_object('id', g.bid))).*
              from public.dataset_batches t, g where t.id = '${tBatch}'
            returning id),
          j as (insert into public.protocol_execution_jobs
              select (jsonb_populate_record(null::public.protocol_execution_jobs, to_jsonb(t) || jsonb_build_object(
                'id', g.jid, 'protocol_id', g.pid, 'dataset_batch_id', g.bid, 'current_attempt_id', null))).*
              from public.protocol_execution_jobs t, g where t.id = '${template.id}'
            returning id)
          select (select count(*) from q) || ',' || (select count(*) from v) || ',' || (select count(*) from p)
            || ',' || (select count(*) from b) || ',' || (select count(*) from j)`);
    record("P12", "1000 questions, versions, protocols, dataset batches and jobs inserted", inserted === "1000,1000,1000,1000,1000", inserted);
    const scope = `j.project_id = '${template.projectId}' and j.status = 'queued'`;
    const chain = psql(`select count(*) || ',' || count(distinct p.id) || ',' || count(distinct v.id) || ',' || count(distinct q.id)
        || ',' || count(distinct db.id)
        || ',' || count(*) filter (where v.approved_at is not null and p.status = 'approved' and p.baseline_protocol_id is null)
        from public.protocol_execution_jobs j
        join public.protocols p on p.id = j.protocol_id and p.project_id = j.project_id
        join public.buyer_question_versions v on v.id = p.buyer_question_version_id and v.project_id = p.project_id
        join public.buyer_questions q on q.id = v.buyer_question_id and q.project_id = v.project_id
        join public.dataset_batches db on db.id = j.dataset_batch_id and db.project_id = j.project_id
       where ${scope}`);
    record("P12", "1001 queued jobs, each joined through its own protocol, version, question and dataset batch; all approved baselines",
      chain === "1001,1001,1001,1001,1001,1001", chain);
    const batches = psql(`select count(*) || ',' || count(distinct j.dataset_batch_id)
        || ',' || count(*) filter (where db.id is null)
        || ',' || count(*) filter (where db.id is not null and db.project_id <> j.project_id)
        from public.protocol_execution_jobs j
        left join public.dataset_batches db on db.id = j.dataset_batch_id
       where ${scope}`);
    record("P12", "every queued job owns a distinct dataset batch: none shared, none missing, none in another project",
      batches === "1001,1001,0,0", batches);
    const liveBaselines = psql(`select count(*) || ',' || count(distinct buyer_question_version_id) from public.protocols
       where project_id = '${template.projectId}' and status in ('approved', 'active') and baseline_protocol_id is null`);
    const [lbCount, lbDistinct] = liveBaselines.split(",").map(Number);
    record("P12", "every live baseline has its own version (the 0073 index's rule)", lbCount >= 1001 && lbCount === lbDistinct, liveBaselines);
    psql(`update public.protocols set spend_cap_usd = 9 where id = (select protocol_id from public.protocol_execution_jobs
            where status = 'queued' order by id desc limit 1)`);
    const live = Number(psql("select count(*) from public.protocol_execution_jobs where status in ('queued','claimed','running')"));
    const d = await gate(ON("50"));
    record("P12", `${live} eligible live jobs (> max_rows 1000) → spend_ledger_unavailable, never a truncated max`,
      live > 1000 && !d.ok && d.code === "spend_ledger_unavailable", JSON.stringify(d));
  }

  /* ═══ P13 LIMITATION G4: clock skew at the window edge ═══ */
  await reset();
  await ledgerRow({ ageSeconds: 86_400 - 60, reserved: 1, actual: null, basis: null });
  await makeJob(0.5);
  {
    const now = dbNowMs();
    const behind = await gate(ON("1.4"), now - 5 * 60_000);
    const ahead = await gate(ON("1.4"), now + 5 * 60_000);
    record("P13", "a worker clock 5 min behind still counts the edge call → refused (safe)",
      !behind.ok && behind.code === "spend_ceiling_reached", JSON.stringify(behind));
    record("P13", "a worker clock 5 min ahead misses it → allowed (undercount the gate cannot see)",
      ahead.ok && ahead.spentLast24hUsd === 0, JSON.stringify(ahead));
  }

  /* ═══ P14 constraints vs. responses ═══ */
  {
    const anyCall = psql("select id from public.protocol_external_calls limit 1");
    for (const [label, sql] of [
      ["an unknown cost_basis", `update public.protocol_external_calls set actual_cost_usd = 0.01, cost_basis = 'guessed' where id = '${anyCall}'`],
      ["an actual cost without its basis", `update public.protocol_external_calls set actual_cost_usd = 0.01, cost_basis = null where id = '${anyCall}'`],
      ["a negative reservation", `update public.protocol_external_calls set reserved_cost_usd = -1 where id = '${anyCall}'`],
      ["a negative spend cap", "update public.protocols set spend_cap_usd = -1 where id = (select id from public.protocols limit 1)"],
    ] as const) {
      const r = psqlFails(sql);
      record("P14", `the database rejects ${label} (check_violation), so no such row can reach the gate`,
        r.failed && /violates check constraint/.test(r.stderr), r.stderr.split("\n")[0]);
    }
    const shape = await service.from("protocols").select("spend_cap_usd").limit(1);
    const v = shape.data?.[0]?.spend_cap_usd;
    record("P14", "real PostgREST returns numeric caps in a shape the gate parses (number or numeric string)",
      typeof v === "number" || (typeof v === "string" && Number.isFinite(Number(v))), `${typeof v}`);
    // Malformed RESPONSES (missing counts, wrong types, duplicates) cannot be produced by a healthy
    // PostgREST; they are covered against a fake client in test-paid-execution-guards [2c]/[2d].
  }

  /* ═══ P15 the per-protocol cap in SQL ═══ */
  await reset();
  {
    const job = await makeJob(0.03, { maxAttempts: 1 });
    const c = await claimById(job);
    const a = await db.admitAndReserveAttemptForJob({
      jobId: job.id, claimToken: c.claimToken, projectId: job.projectId, attemptKind: "baseline",
      idempotencyKey: `${job.id}:baseline:1`, perplexityReservedCostUsd: 0.02, analysisReservedCostUsd: 0.02,
    });
    record("P15", "0.02 + 0.02 against a 0.03 cap → SPEND_CAP_EXCEEDED, nothing reserved",
      a.outcome === "SPEND_CAP_EXCEEDED" && a.perplexityCall === null
        && Number(psql(`select count(*) from public.protocol_attempts where protocol_id = '${job.protocolId}'`)) === 0, a.outcome);
  }

  /* ═══ P10 service-role read failures — last, one at a time, each restored and verified ═══ */
  for (const table of ["protocol_external_calls", "protocol_execution_jobs", "protocols"] as const) {
    await reset();
    const job = await makeJob(0.5);
    const can = () => psql(`select has_table_privilege('service_role', 'public.${table}', 'select')`) === "t";
    if (!can()) throw new Error(`service_role cannot read ${table} before P10 — isolation broken`);
    psql(`revoke select on public.${table} from service_role`);
    try {
      record("P10", `${table}: SELECT revoked from service_role (verified)`, !can());
      const d = await gate(ON("50"));
      record("P10", `${table}: the gate refuses as spend_ledger_unavailable`, !d.ok && d.code === "spend_ledger_unavailable", JSON.stringify(d));
      const seen = await loop(ON("50"));
      record("P10", `${table}: the real loop claims nothing`, seen[0]?.outcome === "paid_execution_refused" && attemptCount(job.id) === 0);
    } finally {
      psql(`grant select on public.${table} to service_role`);
    }
    if (!can()) throw new Error(`could not restore service_role SELECT on ${table} — stopping`);
    record("P10", `${table}: SELECT restored and verified`, true);
  }
  {
    await reset();
    await makeJob(0.5);
    psql("revoke select on public.protocols from service_role; grant select (id) on public.protocols to service_role");
    try {
      const d = await gate(ON("50"));
      record("P10", "a cap column the service role cannot read → spend_ledger_unavailable", !d.ok && d.code === "spend_ledger_unavailable", JSON.stringify(d));
    } finally {
      psql("revoke select (id) on public.protocols from service_role; grant select on public.protocols to service_role");
    }
    record("P10", "column privilege restored and verified",
      psql("select has_column_privilege('service_role', 'public.protocols', 'spend_cap_usd', 'select')") === "t");
  }
  {
    const blockedBefore = guard.blocked.length;
    const elsewhere = createClient("http://127.0.0.1:54399", must(process.env.SUPABASE_SERVICE_ROLE_KEY, "key"),
      { auth: { persistSession: false, autoRefreshToken: false } });
    const d = await gate(ON("50"), undefined, elsewhere);
    record("P10", "an unreachable API (a port outside the stack) refuses, and the guard recorded it",
      !d.ok && d.code === "spend_ledger_unavailable" && guard.blocked.length > blockedBefore, JSON.stringify(d));
  }

  const external = guard.blocked.filter((b) => b !== "http://127.0.0.1:54399" && !b.startsWith("127.0.0.1:54399"));
  harness("no fetch or socket left the disposable stack", external.length === 0, external.slice(0, 3).join(", "));
}

/** Every case accounted for: assertions passed, limitations reproduced, harness checks clean. */
function summary(print: boolean): { success: boolean } {
  let assertionsFailed = 0;
  let limitationsMissing = 0;
  if (print) console.log("\n══════ PG-9 summary ══════");
  for (const c of PG9_CASES) {
    const r = results.get(c.id);
    const okCase = r !== undefined && r.ok;
    if (c.kind === "assertion") { if (!okCase) assertionsFailed += 1; }
    else if (!okCase) limitationsMissing += 1;
    if (!print) continue;
    if (!r) console.log(`  ${c.id} NOT RUN — ${c.title}`);
    else if (c.kind === "assertion") console.log(`  ${c.id} ${r.ok ? "PASS" : "FAIL"} — ${c.title}`);
    else console.log(`  ${c.id} ${r.ok ? `LIMITATION DEMONSTRATED (${c.gap})` : `LIMITATION NOT REPRODUCED (${c.gap})`} — ${c.title}`);
  }
  if (print) {
    console.log(`\n  harness checks: ${harnessChecks - harnessFailures}/${harnessChecks}; assertions failed: ${assertionsFailed}; limitations not reproduced: ${limitationsMissing}`);
  }
  return { success: harnessFailures === 0 && assertionsFailed === 0 && limitationsMissing === 0 };
}

if (IS_ENTRY) {
  main().catch((e) => {
    console.error(`PG-9 harness error: ${describeError(e)}`);
    process.exitCode = 1;
  });
}
