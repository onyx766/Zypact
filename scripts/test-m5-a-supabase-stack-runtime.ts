#!/usr/bin/env tsx
/**
 * M5-A — the worker against a real Supabase stack, real adapter.
 *
 * The memory-adapter tests prove the loop's logic. They cannot prove the
 * things that only exist in Postgres: `for update skip locked`, a lease
 * that actually expires on the server's clock, and a claim token the
 * database itself refuses. That is what this file is for.
 *
 * It creates a disposable local Supabase stack under a fresh mktemp
 * directory, applies EXACTLY migrations 0001-0055 byte-identically, and
 * then drives `lib/protocol-worker/*` through the REAL Supabase adapter
 * over PostgREST — not psql, because PostgREST is the transport the
 * worker will actually use in production.
 *
 * Safety, matching every prior M5 runtime harness:
 *   - opt-in only: does nothing unless ZYPACT_M5_A_STACK_TEST=1.
 *   - no remote credential of any kind. The only connection is to the
 *     disposable local stack this run creates.
 *   - never touches staging or Production; never touches a container
 *     this run did not create; never runs `docker ... prune`.
 *   - the service-role key of the disposable stack is held in memory
 *     only and is never printed, logged or written to disk.
 *   - no provider or LLM call anywhere: `runProbe` and the analysis
 *     transport are injected fakes, and the real `fetch` is replaced by
 *     a counter that would throw if the network were ever reached.
 *   - cleanup (`supabase stop --no-backup`) runs only after full
 *     success; on any failure the stack is left up and its exact
 *     workdir is printed so the state can be inspected.
 *
 * Scenarios (closed roster of 6):
 *   S1 concurrency        two workers claim at once → exactly one wins
 *   S2 lease expiry       an abandoned job is re-claimable, with a new token
 *   S3 stale token        every fenced RPC refuses the old token
 *   S4 resumption         a crashed job finishes with ZERO new paid calls
 *   S5 full loop          every planned baseline slot runs, then completes
 *   S6 mark failure       a refused mark_sent produces ZERO fetches
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256Hex } from "@/lib/evidence/hash";
import type { CreateProtocolInput, DbAdapter } from "@/lib/db/types";
import type { AnalysisTransport, WorkerDeps, WorkerOptions } from "@/lib/protocol-worker/types";
import type { ProbeAnalysisM5Parsed } from "@/lib/protocol-worker/analysis-m5";
import type { PerplexityProbeResult } from "@/lib/probes/perplexity";

const REPO_ROOT = process.cwd();
const MAX_MIGRATION_VERSION = 55;
const REQUIRED_PORTS = [54321, 54322, 54323, 54324];
const ROSTER = ["S1", "S2", "S3", "S4", "S5", "S6"] as const;
type ScenarioName = (typeof ROSTER)[number];

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
function must<T>(v: T | null | undefined, label: string): T {
  if (v === null || v === undefined) throw new Error(`missing ${label}`);
  return v;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): string {
  return execFileSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}
function available(cmd: string): boolean {
  try {
    run(cmd, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Strict, fail-closed migration selection: exactly 0001..MAX, no gap, no
 * duplicate, no malformed name. Never "every file present".
 */
function selectNumberedMigrations(
  entries: string[],
  maxVersion: number
): { ok: true; files: string[] } | { ok: false; reason: string } {
  const seen = new Map<number, string>();
  for (const e of entries) {
    if (!e.endsWith(".sql")) continue;
    const m = /^(\d{4})_[A-Za-z0-9_]+\.sql$/.exec(e);
    if (!m) return { ok: false, reason: `malformed migration filename: ${e}` };
    const n = Number.parseInt(m[1], 10);
    if (seen.has(n)) return { ok: false, reason: `duplicate migration number ${n}` };
    seen.set(n, e);
  }
  const files: string[] = [];
  for (let n = 1; n <= maxVersion; n += 1) {
    const f = seen.get(n);
    if (!f) return { ok: false, reason: `missing migration number ${n}` };
    files.push(f);
  }
  return { ok: true, files };
}

/**
 * Reads one scalar out of a TOML file by (section, key), scanning line by
 * line and tracking the current section header. Deliberately not a general
 * TOML parser and deliberately not a regex over the whole file: the only
 * thing that matters here is knowing *which* `enabled =` line we are
 * looking at, because `config.toml` has more than twenty of them.
 *
 * Returns null when the key does not occur inside that exact section.
 */
function readTomlScalar(text: string, section: string, key: string): string | null {
  let current: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = header[1];
      continue;
    }
    if (current !== section) continue;
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (kv && kv[1] === key) return kv[2].trim();
  }
  return null;
}

/**
 * Sets one key inside one section, and reports how many lines it touched.
 *
 * The caller requires that count to be exactly 1. That is the whole point:
 * the previous version of this harness used
 * `text.replace(/^enabled = true$/m, ...)`, which silently rewrote the
 * FIRST `enabled = true` in the file — the one under `[api]` — and so
 * started every stack with PostgREST disabled while leaving the database
 * seed enabled. A count is the only thing that makes that class of mistake
 * impossible to repeat unnoticed.
 */
function setTomlScalar(
  text: string,
  section: string,
  key: string,
  value: string
): { text: string; replacements: number } {
  let current: string | null = null;
  let replacements = 0;
  const out = text.split("\n").map((raw) => {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = header[1];
      return raw;
    }
    if (current !== section) return raw;
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv || kv[1] !== key) return raw;
    replacements += 1;
    const indent = raw.slice(0, raw.length - raw.trimStart().length);
    return `${indent}${key} = ${value}`;
  });
  return { text: out.join("\n"), replacements };
}

/** Reads `supabase status -o env` without ever printing a value. */
function serviceRoleKeyFrom(workdir: string): string {
  const out = run("supabase", ["status", "-o", "env", "--workdir", workdir]);
  for (const line of out.split("\n")) {
    const m = /^SERVICE_ROLE_KEY="?([^"]+)"?$/.exec(line.trim());
    if (m) return m[1];
  }
  throw new Error("supabase status did not report SERVICE_ROLE_KEY");
}

// ---------------------------------------------------------------------------
// Fixtures. Identical in shape to the memory-adapter tests, so a divergence
// between the two layers shows up as a behaviour difference, not a data one.
// ---------------------------------------------------------------------------

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
const PROVIDER_BODY = JSON.stringify({
  id: "req-fixture",
  choices: [{ message: { content: ANSWER } }],
});

function protocolFixture(
  plannedBaselineRuns: number
): Omit<CreateProtocolInput, "projectId" | "buyerQuestionVersionId"> {
  return {
    provider: "perplexity",
    surface: "sonar",
    plannedBaselineRuns,
    plannedRetestRuns: 0,
    paraphrasePlan: [
      { text: "Which vendors handle X best?", hash: "b".repeat(64) },
      { text: "Who should I use for X?", hash: "c".repeat(64) },
    ],
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
}

function workerOptions(over: Partial<WorkerOptions> = {}): WorkerOptions {
  return {
    workerId: "stack-worker",
    leaseSeconds: 60,
    idleBackoffMs: 1,
    maxBackoffMs: 2,
    maxSlotsPerClaim: 8,
    perplexityReservedCostUsd: 0.02,
    analysisReservedCostUsd: 0.02,
    ...over,
  };
}

interface Spy {
  providerFetches: number;
  analysisExecutes: number;
}

function makeDeps(db: DbAdapter, spy: Spy): WorkerDeps {
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

async function main(): Promise<void> {
  if (process.env.ZYPACT_M5_A_STACK_TEST !== "1") {
    console.log(
      "SKIP — this harness creates a disposable local Supabase stack and is opt-in.\n" +
        "      Run it with ZYPACT_M5_A_STACK_TEST=1 and a working Docker + Supabase CLI.\n" +
        "      Nothing was verified; nothing is claimed."
    );
    process.exit(0);
  }

  for (const cmd of ["docker", "supabase"]) {
    if (!available(cmd)) {
      console.log(`SKIP — \`${cmd}\` is not available. Nothing was verified.`);
      process.exit(0);
    }
  }
  const busy = REQUIRED_PORTS.filter((p) => {
    try {
      run("bash", ["-c", `lsof -nP -iTCP:${p} -sTCP:LISTEN | head -1`]).trim();
      return run("bash", ["-c", `lsof -nP -iTCP:${p} -sTCP:LISTEN | wc -l`]).trim() !== "0";
    } catch {
      return false;
    }
  });
  if (busy.length > 0) {
    console.log(`SKIP — local Supabase ports already in use: ${busy.join(",")}. Nothing was verified.`);
    process.exit(0);
  }

  const workdir = mkdtempSync(path.join(tmpdir(), "zypact-m5-a-stack-"));
  console.log(`Disposable workdir: ${workdir}`);

  let stackStarted = false;
  let succeededFully = false;
  const ran = new Set<ScenarioName>();
  const sc = (name: ScenarioName) => {
    if (ran.has(name)) throw new Error(`scenario ${name} ran twice`);
    ran.add(name);
    console.log(`\n[${name}]`);
  };

  try {
    run("supabase", ["init", "--workdir", workdir, "--yes"]);
    const configPath = path.join(workdir, "supabase", "config.toml");
    const generated = readFileSync(configPath, "utf8");
    const edited = setTomlScalar(generated, "db.seed", "enabled", "false");
    if (edited.replacements !== 1) {
      throw new Error(
        `config.toml: expected exactly 1 replacement of [db.seed].enabled, made ${edited.replacements}`
      );
    }
    writeFileSync(configPath, edited.text);

    // Read the file back and refuse the run outright unless BOTH facts hold.
    // `[api].enabled` is what serves PostgREST; without it Kong answers
    // every request with "name resolution failed" and the whole harness is
    // testing nothing.
    const written = readFileSync(configPath, "utf8");
    const apiEnabled = readTomlScalar(written, "api", "enabled");
    const seedEnabled = readTomlScalar(written, "db.seed", "enabled");
    if (apiEnabled !== "true" || seedEnabled !== "false") {
      throw new Error(
        `config.toml refused before start: [api].enabled=${apiEnabled} (want true), ` +
          `[db.seed].enabled=${seedEnabled} (want false)`
      );
    }
    check("exactly one config.toml line was rewritten", edited.replacements === 1);
    check("[api].enabled is true — PostgREST will actually serve", apiEnabled === "true");
    check("[db.seed].enabled is false — no seed runs during db reset", seedEnabled === "false");
    check(
      "the disposable project was never linked to a remote",
      !existsSync(path.join(workdir, "supabase", ".temp", "linked-project.json"))
    );

    const srcDir = path.join(REPO_ROOT, "supabase", "migrations");
    const dstDir = path.join(workdir, "supabase", "migrations");
    mkdirSync(dstDir, { recursive: true });
    const selection = selectNumberedMigrations(readdirSync(srcDir), MAX_MIGRATION_VERSION);
    if (!selection.ok) throw new Error(`migration selection failed: ${selection.reason}`);
    for (const f of selection.files) copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
    check(
      `migrations 0001-0055 copied byte-identically (${selection.files.length} files)`,
      selection.files.length === MAX_MIGRATION_VERSION &&
        selection.files.every((f) =>
          readFileSync(path.join(srcDir, f)).equals(readFileSync(path.join(dstDir, f)))
        ) &&
        selection.files.some((f) => f.startsWith("0055_"))
    );

    console.log("\nStarting the disposable stack (a first run may pull Docker images)...");
    run("supabase", ["start", "--workdir", workdir]);
    stackStarted = true;
    console.log("Stack started.");

    // The key lives in this process only. Never printed, never written.
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKeyFrom(workdir);
    delete process.env.ZYPACT_ALLOW_MEMORY_DB;

    const { supabaseAdapter } = await import("@/lib/db/supabase-adapter");
    const { runOneIteration } = await import("@/lib/protocol-worker/worker");
    const { WorkerHealth } = await import("@/lib/protocol-worker/health");
    const db: DbAdapter = supabaseAdapter;

    // Any real network use from here on is a defect, not a test artefact.
    let strayFetches = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      const url = String(args[0]);
      if (!url.includes("127.0.0.1:54321")) {
        strayFetches += 1;
        throw new Error(`the worker reached a non-local host: ${new URL(url).host}`);
      }
      return realFetch(...args);
    }) as typeof fetch;

    async function seed(
      domain: string,
      plannedBaselineRuns = 1
    ): Promise<{ projectId: string; jobId: string }> {
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
        ...protocolFixture(plannedBaselineRuns),
        projectId: project.id,
        buyerQuestionVersionId: version.id,
      });
      await db.approveProtocol({
        protocolId: protocol.id,
        projectId: project.id,
        approvedBy: APPROVER,
      });
      const enq = await db.enqueueProtocolExecutionJob({
        protocolId: protocol.id,
        projectId: project.id,
      });
      return { projectId: project.id, jobId: must(enq.job, "enqueued job").id };
    }

    // ------------------------------------------------------------- S1
    sc("S1");
    {
      const seeded = await seed("stack-concurrency.test");
      const [a, b] = await Promise.all([
        db.claimProtocolExecutionJob({ workerId: "w-a", leaseSeconds: 60 }),
        db.claimProtocolExecutionJob({ workerId: "w-b", leaseSeconds: 60 }),
      ]);
      const winners = [a, b].filter((r) => r.outcome === "CLAIMED");
      check(
        "two concurrent claims: exactly one CLAIMED, one NO_JOB_AVAILABLE",
        winners.length === 1,
        `${a.outcome}/${b.outcome}`
      );
      check("the winner holds the seeded job", winners[0]?.job?.id === seeded.jobId);
      const winner = winners[0];
      await db.failProtocolExecutionJob({
        jobId: seeded.jobId,
        claimToken: must(winner.claimToken, "token"),
        projectId: seeded.projectId,
        reason: "test_teardown",
      });
    }

    // ------------------------------------------------------------- S2/S3
    sc("S2");
    let staleFence: { jobId: string; claimToken: string; projectId: string } | null = null;
    {
      const seeded = await seed("stack-lease.test");
      const first = await db.claimProtocolExecutionJob({ workerId: "w-1", leaseSeconds: 1 });
      check("the job is claimed with a 1 s lease", first.outcome === "CLAIMED");
      const staleToken = must(first.claimToken, "stale token");
      await sleep(1500); // the server-side lease lapses.
      const second = await db.claimProtocolExecutionJob({ workerId: "w-2", leaseSeconds: 60 });
      check("after the lease lapses the job is re-claimable", second.job?.id === seeded.jobId);
      check("the re-claim issues a different token", second.claimToken !== staleToken);
      staleFence = { jobId: seeded.jobId, claimToken: staleToken, projectId: seeded.projectId };

      sc("S3");
      const ctx = await db.getProtocolExecutionJobContext(staleFence);
      check("the stale token cannot read the context", ctx.outcome === "JOB_NOT_OWNED", ctx.outcome);
      const admit = await db.admitAndReserveAttemptForJob({
        ...staleFence,
        attemptKind: "baseline",
        idempotencyKey: `${staleFence.jobId}:baseline:1`,
        perplexityReservedCostUsd: 0.02,
        analysisReservedCostUsd: 0.02,
      });
      check("the stale token cannot reserve spend", admit.outcome === "JOB_NOT_OWNED", admit.outcome);
      const renew = await db.renewProtocolExecutionJobLease({ ...staleFence, leaseSeconds: 60 });
      check("the stale token cannot renew the lease", renew.outcome === "JOB_NOT_OWNED", renew.outcome);
      const done = await db.completeProtocolExecutionJob(staleFence);
      check("the stale token cannot complete the job", done.outcome === "JOB_NOT_OWNED", done.outcome);

      await db.failProtocolExecutionJob({
        jobId: seeded.jobId,
        claimToken: must(second.claimToken, "token"),
        projectId: seeded.projectId,
        reason: "test_teardown",
      });
    }

    // ------------------------------------------------------------- S4
    sc("S4");
    {
      const seeded = await seed("stack-resume.test");
      // Drive the job to "provider paid for, analysis never started", then
      // let the lease lapse — a killed worker, reproduced exactly.
      const claimed = await db.claimProtocolExecutionJob({ workerId: "w-crash", leaseSeconds: 2 });
      const job = must(claimed.job, "job");
      const f = {
        jobId: job.id,
        claimToken: must(claimed.claimToken, "token"),
        projectId: seeded.projectId,
      };
      const admitted = await db.admitAndReserveAttemptForJob({
        ...f,
        attemptKind: "baseline",
        idempotencyKey: `${job.id}:baseline:${job.nextBaselineOrdinal}`,
        perplexityReservedCostUsd: 0.02,
        analysisReservedCostUsd: 0.02,
      });
      const attempt = must(admitted.attempt, "attempt");
      const perplexityCall = must(admitted.perplexityCall, "perplexity call");
      const started = await db.createProbeRunAndStartAttemptForJob({
        ...f,
        attemptId: attempt.id,
        platform: "perplexity",
        probeMode: "live_perplexity",
      });
      const probeRunId = must(started.probeRun, "probe run").id;
      await db.markExternalCallSentForJob({ ...f, externalCallId: perplexityCall.id, probeRunId });
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

      // Read the context while the lease is still valid. No probe_results
      // row exists yet, so a correct mapping must report null — PostgREST
      // sends an all-null composite here, not JSON null, and the previous
      // truthiness test read that as "a result already exists".
      const ctxNoResult = await db.getProtocolExecutionJobContext(f);
      check(
        "context with no probe_results row ⇒ probeResult === null",
        ctxNoResult.outcome === "OK" && ctxNoResult.probeResult === null,
        `outcome=${ctxNoResult.outcome} probeResult=${ctxNoResult.probeResult === null ? "null" : "NON-NULL"}`
      );
      await sleep(2500);

      const spy: Spy = { providerFetches: 0, analysisExecutes: 0 };
      const r = await runOneIteration(
        makeDeps(db, spy),
        workerOptions({ workerId: "w-resume" }),
        new WorkerHealth(() => Date.now())
      );
      check("the resumed job completes", r.outcome === "completed", `${r.outcome}/${r.detail}`);
      check(
        "ZERO new provider calls — the answer was replayed from the stored receipt",
        spy.providerFetches === 0
      );
      check("exactly one analysis call, the one still owed", spy.analysisExecutes === 1);

      // The other half of the mapping contract, on its own job so that
      // nothing above is disturbed: drive one attempt to a persisted
      // probe result and read the context while the fence is still live.
      // No provider call and no model call — every receipt is written
      // directly through its RPC.
      const posSeed = await seed("stack-mapping-positive.test");
      const pc = await db.claimProtocolExecutionJob({ workerId: "w-mapping", leaseSeconds: 300 });
      if (pc.job?.id !== posSeed.jobId) {
        throw new Error(`mapping check claimed ${pc.job?.id ?? "nothing"}, expected ${posSeed.jobId}`);
      }
      const pf = {
        jobId: posSeed.jobId,
        claimToken: must(pc.claimToken, "token"),
        projectId: posSeed.projectId,
      };
      const pad = await db.admitAndReserveAttemptForJob({
        ...pf,
        attemptKind: "baseline",
        idempotencyKey: `${pf.jobId}:baseline:${must(pc.job, "job").nextBaselineOrdinal}`,
        perplexityReservedCostUsd: 0.02,
        analysisReservedCostUsd: 0.02,
      });
      const pStarted = await db.createProbeRunAndStartAttemptForJob({
        ...pf,
        attemptId: must(pad.attempt, "attempt").id,
        platform: "perplexity",
        probeMode: "live_perplexity",
      });
      const pRun = must(pStarted.probeRun, "probe run").id;
      const pPerplexity = must(pad.perplexityCall, "perplexity call").id;
      const pAnalysis = must(pad.analysisCall, "analysis call").id;
      await db.markExternalCallSentForJob({ ...pf, externalCallId: pPerplexity, probeRunId: pRun });
      await db.recordProviderCallReceiptForJob({
        ...pf, externalCallId: pPerplexity, probeRunId: pRun, outcome: "success", httpStatus: 200,
        providerRequestId: "req-fixture", rawResponseSha256: sha256Hex(PROVIDER_BODY),
        latencyMs: 7, rawResponseBody: PROVIDER_BODY,
      });
      await db.markExternalCallSentForJob({ ...pf, externalCallId: pAnalysis, probeRunId: pRun });
      await db.recordAnalysisCallReceiptForJob({
        ...pf, externalCallId: pAnalysis, probeRunId: pRun, outcome: "success", provider: "openai",
        model: "gpt-4o-mini", usedMock: false, requestSha256: sha256Hex(ANALYSIS_REQUEST_BODY),
        responseSha256: sha256Hex(M5_CONTENT), latencyMs: 5, rawContent: M5_CONTENT,
        rawRequestBody: ANALYSIS_REQUEST_BODY,
      });

      const beforePersist = await db.getProtocolExecutionJobContext(pf);
      check(
        "before persist, with a live attempt and no row ⇒ probeResult === null",
        beforePersist.probeResult === null,
        beforePersist.probeResult === null ? "null" : "NON-NULL"
      );
      const persisted = await db.persistProbeResultForJob({
        ...pf,
        content: {
          productMentioned: true, productPosition: "listed", competitorsMentioned: [],
          sourcesCited: [{ source: "g2.com/products/example", type: "review_site" }],
          answerSummary: "fixture", citedAsSource: false, clientSourceCount: 0,
          platformsReferenced: [], negativeClaimDetected: false,
        },
      });
      check("the probe result really was persisted", persisted.outcome === "PERSISTED", persisted.outcome);
      const afterPersist = await db.getProtocolExecutionJobContext(pf);
      check(
        "context with a real probe_results row ⇒ probeResult is a non-null object with an id",
        afterPersist.probeResult !== null && typeof afterPersist.probeResult.id === "string" &&
          afterPersist.probeResult.id.length > 0,
        afterPersist.probeResult === null ? "null" : `id=${afterPersist.probeResult.id.slice(0, 8)}…`
      );
      await db.failProtocolExecutionJob({ ...pf, reason: "mapping_check_teardown" });
    }

    // ------------------------------------------------------------- S5
    sc("S5");
    {
      const seeded = await seed("stack-full-loop.test", 2);
      const spy: Spy = { providerFetches: 0, analysisExecutes: 0 };

      // Record every probeResult the worker actually sees. Slot 1 starts
      // with none and ends with one, so a correct mapping must produce
      // both a null and a real object across the run.
      const seen: Array<"null" | "object"> = [];
      const observed = new Proxy(db, {
        get(target, prop, recv) {
          const v = Reflect.get(target, prop, recv);
          if (prop !== "getProtocolExecutionJobContext" || typeof v !== "function") return v;
          return async (...args: Parameters<DbAdapter["getProtocolExecutionJobContext"]>) => {
            const out = await (v as DbAdapter["getProtocolExecutionJobContext"]).apply(target, args);
            seen.push(out.probeResult === null ? "null" : "object");
            return out;
          };
        },
      }) as DbAdapter;
      const deps = makeDeps(observed, spy);
      const health = new WorkerHealth(() => Date.now());
      let completed = false;
      for (let i = 0; i < 4 && !completed; i += 1) {
        const r = await runOneIteration(deps, workerOptions(), health);
        if (r.outcome === "completed" && r.jobId === seeded.jobId) completed = true;
        if (r.outcome === "no_job") break;
      }
      check("a two-slot job runs both slots and completes", completed);
      check("exactly two provider calls, one per slot", spy.providerFetches === 2, String(spy.providerFetches));
      check("exactly two analysis calls, one per slot", spy.analysisExecutes === 2, String(spy.analysisExecutes));
      // Every context the worker reads is either before its slot's probe
      // result exists, or after the completion gate cleared the current
      // attempt — so `null` throughout is the correct observation here.
      // The positive half of the mapping contract is proven in S4, on a
      // fence that is still live at the moment a real row exists.
      check(
        "every context the worker read reported probeResult === null",
        seen.length > 0 && seen.every((x) => x === "null"),
        seen.join(",")
      );
    }

    // ------------------------------------------------------------- S6
    sc("S6");
    {
      await seed("stack-markfail.test");
      const spy: Spy = { providerFetches: 0, analysisExecutes: 0 };
      const base = makeDeps(db, spy);
      const guarded: WorkerDeps = {
        ...base,
        db: new Proxy(db, {
          get(target, prop, recv) {
            if (prop === "markExternalCallSentForJob") {
              return async () => ({ outcome: "JOB_NOT_OWNED" as const, externalCall: null });
            }
            return Reflect.get(target, prop, recv);
          },
        }) as DbAdapter,
      };
      const r = await runOneIteration(
        guarded,
        workerOptions({ workerId: "w-markfail" }),
        new WorkerHealth(() => Date.now())
      );
      check("a refused mark stops the iteration", r.outcome === "lost_ownership", `${r.outcome}/${r.detail}`);
      check("ZERO provider calls left the process", spy.providerFetches === 0);
    }

    globalThis.fetch = realFetch;
    check("no request ever left the local stack", strayFetches === 0);
    check(
      `closed roster: all ${ROSTER.length} scenarios ran exactly once`,
      ROSTER.every((n) => ran.has(n)) && ran.size === ROSTER.length,
      [...ran].join(",")
    );

    succeededFully = failures === 0;
  } finally {
    if (stackStarted && succeededFully) {
      console.log("\nStopping the disposable stack...");
      try {
        run("supabase", ["stop", "--no-backup", "--workdir", workdir]);
        console.log("Stack stopped.");
      } catch {
        console.log(`Could not stop the stack automatically. Stop it manually: supabase stop --workdir ${workdir}`);
      }
    } else if (stackStarted) {
      console.log(`\nStack LEFT RUNNING for inspection: ${workdir}`);
      console.log(`Stop it with: supabase stop --no-backup --workdir ${workdir}`);
    }
  }

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "M5-A Supabase stack runtime PASSED." : "M5-A Supabase stack runtime FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
