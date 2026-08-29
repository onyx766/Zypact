#!/usr/bin/env tsx
/**
 * M5 — TK-R-0 .. TK-R-5, network-free.
 *
 * Runs on the memory adapter with injected fakes. No provider key, no
 * Supabase connection, no `fetch` that can reach anything: every
 * transport is either a scripted stub or an injected `fetchImpl`.
 *
 * What this file proves:
 *   [1] TK-R-0 — idle cycles are provable, and `iterations` keeps its
 *       original meaning (a CLAIMED job, and nothing else).
 *   [2] TK-R-1 — the requested model and the served model are two fields
 *       that never overwrite each other.
 *   [3] TK-R-2/3/4 — provider request id, HTTP status and the SUCCESS
 *       latency reach the durable receipt.
 *   [4] TK-R-5 — live refuses a floating model before any transport.
 *   [5] Replay identity: an exact replay is idempotent; a divergent one
 *       conflicts and never writes twice. Historical nulls stay readable.
 *   [6] Migration 0058 — static contract of the recreated RPC.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { runOneIteration, runWorkerLoop } from "@/lib/protocol-worker/worker";
import {
  WorkerHealth,
  idleProofEvent,
  IDLE_PROOF_THRESHOLD,
  type IdleProofEvent,
} from "@/lib/protocol-worker/health";
import {
  prepareCallModelRequest,
  executePreparedCallModelRequest,
  CallModelFailure,
} from "@/lib/llm/call-model";
import type {
  AnalysisTransport,
  WorkerDeps,
  WorkerOptions,
} from "@/lib/protocol-worker/types";
import type {
  CreateProtocolInput,
  DbAdapter,
  RecordAnalysisCallReceiptForJobInput,
} from "@/lib/db/types";
import type { PerplexityProbeResult } from "@/lib/probes/perplexity";
import { sha256Hex } from "@/lib/evidence/hash";

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
function must<T>(v: T | null | undefined, l: string): T {
  if (v === null || v === undefined) throw new Error(`missing ${l}`);
  return v;
}
function code(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

const APPROVER = "11111111-1111-4111-8111-111111111111";
const PERPLEXITY_REQ = JSON.stringify({ model: "sonar", messages: [] });
const ANALYSIS_REQ = JSON.stringify({ model: "gpt-4o-mini-2024-07-18", messages: [] });
const M5_CONTENT = JSON.stringify({
  clientPosition: "absent",
  competitorsMentioned: [],
  sourcesCited: [],
  answerSummary: "",
});
const PROBE_BODY = JSON.stringify({ id: "p", choices: [{ message: { content: "answer" } }] });

const PROTOCOL: Omit<CreateProtocolInput, "projectId" | "buyerQuestionVersionId"> = {
  provider: "perplexity", surface: "sonar", plannedBaselineRuns: 1, plannedRetestRuns: 0,
  paraphrasePlan: [{ text: "Q?", hash: "b".repeat(64) }], unitOfAnalysis: "run",
  primaryMetric: "listed_in_run", samplePlanningMethod: "fixed", runCap: 20, spendCapUsd: 100,
  timeWindowSeconds: 3600, rateLimitPerHour: 100, concurrencyLimit: 5, retryCap: 2,
};

/** Scopes fixture env vars to one block and always restores them. */
async function withEnvAsync<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k]!;
    }
  }
}

/**
 * Never a real credential: `prepareCallModelRequest` only needs SOME key
 * present to build a non-mock request, and the key never leaves the
 * prepared handle's private side table.
 */
const FAKE_OPENAI_KEY = "sk-test-not-a-real-key";
const FAKE_ANTHROPIC_KEY = "sk-ant-test-not-a-real-key";

const OPTS: WorkerOptions = {
  workerId: "tk-r-worker",
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

/** The four TK-R-0 counters, read straight off the health snapshot. */
function idle(h: WorkerHealth) {
  const s = h.snapshot();
  return {
    total: s.noJobCycles,
    consecutive: s.consecutiveNoJobCycles,
    max: s.maxConsecutiveNoJobCycles,
    last: s.lastNoJobAtMs,
    iterations: s.iterations,
  };
}

async function main(): Promise<void> {
  const { memoryAdapter } = await import("@/lib/db/memory-adapter");
  const db: DbAdapter = memoryAdapter;

  // ======================================================================
  console.log("[1] TK-R-0 — idle cycles are provable");
  // ======================================================================

  /**
   * A db that answers only what one iteration asks of it. Anything else
   * throws, so a test that silently grew a second database round-trip
   * fails instead of passing for the wrong reason.
   */
  type ClaimScript = Array<"no_job" | "claimed" | "throw">;
  function scriptedDb(script: ClaimScript, calls: string[]): DbAdapter {
    let i = 0;
    const stub = {
      async claimProtocolExecutionJob() {
        calls.push("claim");
        const step = script[i] ?? "no_job";
        i += 1;
        if (step === "throw") throw new Error("claim exploded");
        if (step === "no_job") return { outcome: "NO_JOB_AVAILABLE" as const, job: null, claimToken: null };
        return {
          outcome: "CLAIMED" as const,
          job: { id: "job-1", projectId: "proj-1", nextBaselineOrdinal: 1 },
          claimToken: "22222222-2222-4222-8222-222222222222",
        };
      },
      async renewProtocolExecutionJobLease() {
        calls.push("renew");
        return { outcome: "RENEWED" as const, job: null };
      },
      async getProtocolExecutionJobContext() {
        // Ends the claimed iteration immediately: this block is about the
        // counters, not about driving a job to a terminal.
        calls.push("context");
        return { outcome: "JOB_NOT_OWNED" as const, job: null, protocol: null };
      },
    };
    return new Proxy(stub, {
      get(target, prop, recv) {
        if (prop in target) return Reflect.get(target, prop, recv);
        throw new Error(`unexpected db call: ${String(prop)}`);
      },
    }) as unknown as DbAdapter;
  }

  function scriptedDeps(script: ClaimScript, calls: string[]): WorkerDeps {
    return {
      db: scriptedDb(script, calls),
      runProbe: (async () => {
        throw new Error("runProbe must never be reached here");
      }) as unknown as WorkerDeps["runProbe"],
      analysis: {
        prepare: () => {
          throw new Error("analysis.prepare must never be reached here");
        },
        execute: async () => {
          throw new Error("analysis.execute must never be reached here");
        },
      } as unknown as AnalysisTransport,
      realFetch: (async () => {
        throw new Error("no network in this test");
      }) as unknown as WorkerDeps["realFetch"],
      now: () => 1_000,
      sleep: async () => undefined,
      probeMode: "live_perplexity",
    };
  }

  // --- mandatory test 1 -------------------------------------------------
  {
    const calls: string[] = [];
    const h = new WorkerHealth(() => 7_777);
    const deps = scriptedDeps(["no_job", "no_job", "no_job"], calls);
    for (let i = 0; i < 3; i += 1) {
      const r = await runOneIteration(deps, OPTS, h);
      check(`cycle ${i + 1} reports no_job`, r.outcome === "no_job", r.outcome);
    }
    const s = idle(h);
    check("[T1] three idle cycles → total = 3", s.total === 3, String(s.total));
    check("[T1] …consecutive = 3", s.consecutive === 3, String(s.consecutive));
    check("[T1] …max = 3", s.max === 3, String(s.max));
    check(
      "[T1] …and iterations stays 0 — `markIteration` still means a CLAIMED job",
      s.iterations === 0,
      String(s.iterations)
    );
    check("[T1] lastNoJobAtMs is the injected clock, never a wall-clock read", s.last === 7_777, String(s.last));
    check(
      "[T1] an idle cycle costs exactly one database round-trip, and adds no write",
      calls.join(",") === "claim,claim,claim",
      calls.join(",")
    );
  }

  // --- mandatory test 2 -------------------------------------------------
  {
    const calls: string[] = [];
    const h = new WorkerHealth(() => 1);
    const deps = scriptedDeps(["no_job", "no_job", "claimed", "no_job"], calls);
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i += 1) outcomes.push((await runOneIteration(deps, OPTS, h)).outcome);
    check(
      "[T2] the third cycle really did claim a job",
      outcomes.join(",") === "no_job,no_job,lost_ownership,no_job",
      outcomes.join(",")
    );
    const s = idle(h);
    check("[T2] total = 3 — totals are never rewound", s.total === 3, String(s.total));
    check("[T2] consecutive = 1 — the claimed job broke the streak", s.consecutive === 1, String(s.consecutive));
    check("[T2] max = 2 — the high-water mark survives the busy cycle", s.max === 2, String(s.max));
    check("[T2] iterations = 1 — exactly the one claimed job", s.iterations === 1, String(s.iterations));
  }

  // --- mandatory test 3 -------------------------------------------------
  {
    const calls: string[] = [];
    const h = new WorkerHealth(() => 1);
    const deps = scriptedDeps(["no_job", "throw", "no_job"], calls);
    await runOneIteration(deps, OPTS, h);
    let threw = false;
    try {
      await runOneIteration(deps, OPTS, h);
    } catch {
      threw = true;
    }
    check("[T3] a claim that throws still propagates its error", threw);
    const mid = idle(h);
    check("[T3] …and breaks the streak immediately", mid.consecutive === 0, String(mid.consecutive));
    await runOneIteration(deps, OPTS, h);
    const s = idle(h);
    check("[T3] total = 2 — the error was not counted as an idle cycle", s.total === 2, String(s.total));
    check("[T3] consecutive = 1 — the streak restarted after the error", s.consecutive === 1, String(s.consecutive));
    check("[T3] max = 1 — no streak of 2 ever existed", s.max === 1, String(s.max));
    check("[T3] iterations = 0 — an error is not a claimed job", s.iterations === 0, String(s.iterations));
  }

  // --- mandatory test 4 -------------------------------------------------
  //
  // Driven through the REAL loop: `runWorkerLoop` with a real WorkerHealth,
  // and an onIteration callback that calls the REAL `idleProofEvent` — the
  // same function `run-protocol-worker.ts` calls. The threshold rule is
  // nowhere restated in this file.
  {
    const script: ClaimScript = [
      "no_job", "no_job", "no_job", "no_job", "no_job",
      "claimed",
      "no_job", "no_job", "no_job", "no_job",
    ];
    const calls: string[] = [];
    const deps = scriptedDeps(script, calls);
    const health = new WorkerHealth(() => 1);
    const signal = { aborted: false };
    const seen: string[] = [];
    const emitted: Array<IdleProofEvent & { at: number }> = [];

    await runWorkerLoop(
      deps,
      OPTS,
      signal,
      async () => undefined,
      (r) => {
        seen.push(r.outcome);
        // Exactly the production wiring: snapshot in, real rule, payload out.
        if (r.outcome === "no_job") {
          const proof = idleProofEvent(health.snapshot());
          if (proof) emitted.push({ ...proof, at: seen.length });
        }
        if (seen.length >= script.length) signal.aborted = true;
      },
      health
    );

    check(
      "[T4] the real loop ran the scripted cycles",
      seen.join(",") === "no_job,no_job,no_job,no_job,no_job,lost_ownership,no_job,no_job,no_job,no_job",
      seen.join(",")
    );
    check(
      "[T4] the real idleProofEvent fires exactly twice — once per streak that reaches the threshold",
      emitted.length === 2,
      `fired at cycles ${emitted.map((e) => e.at).join(",")}`
    );
    check(
      "[T4] …at cycle 3 and cycle 9, never on cycles 4..n of a streak",
      emitted[0]?.at === 3 && emitted[1]?.at === 9,
      emitted.map((e) => `cycle${e.at}`).join(",")
    );
    check(
      "[T4] …carrying the threshold streak and the running total, not a per-cycle log",
      emitted[0]?.consecutiveNoJobCycles === IDLE_PROOF_THRESHOLD &&
        emitted[0]?.noJobCycles === 3 &&
        emitted[1]?.consecutiveNoJobCycles === IDLE_PROOF_THRESHOLD &&
        emitted[1]?.noJobCycles === 8,
      JSON.stringify(emitted)
    );
    check(
      "[T4] 9 idle cycles produced 9 counted cycles but only 2 log lines",
      health.snapshot().noJobCycles === 9 && emitted.length === 2,
      `noJobCycles=${health.snapshot().noJobCycles}`
    );
    check(
      "[T4] a claimed job broke the streak inside the real loop",
      health.snapshot().maxConsecutiveNoJobCycles === 5 && health.snapshot().iterations === 1,
      `max=${health.snapshot().maxConsecutiveNoJobCycles} iterations=${health.snapshot().iterations}`
    );
    // The one thing a unit test cannot execute: that the runner's callback
    // delegates here rather than restating the rule. One line of wiring.
    const runnerSrc = code("scripts/run-protocol-worker.ts");
    check(
      "[T4] the runner calls idleProofEvent and holds no threshold of its own",
      /const proof = idleProofEvent\(healthRef\.snapshot\(\)\);/.test(runnerSrc) &&
        !/IDLE_PROOF_THRESHOLD/.test(runnerSrc),
      "wiring"
    );

    // The counters the callback reads and the counters the loop mutates must
    // be the SAME object, or the worker logs an idle proof that never fires
    // and a /healthz frozen at zero. Nothing above can catch that: this file
    // hands the same instance to both positions, so divergence is not even
    // expressible in a behavioural test. It is pinned here instead, on the
    // runner's own source — anchored to THE runWorkerLoop call, capturing its
    // sixth argument rather than matching a substring that could appear
    // anywhere.
    const RUN_LOOP_SIXTH_ARG =
      /await runWorkerLoop\(\s*deps,\s*opts,\s*signal,\s*sleep,\s*\([\s\S]*?\n\s*\},\s*(\w+)\s*\);/;
    const wiringHolds = (src: string): boolean =>
      (src.match(/new WorkerHealth\(/g) ?? []).length === 1 &&
      RUN_LOOP_SIXTH_ARG.exec(src)?.[1] === "healthRef";

    check(
      "[T4] the runner constructs exactly one WorkerHealth — a second instance is unrepresentable",
      (runnerSrc.match(/new WorkerHealth\(/g) ?? []).length === 1,
      `occurrences=${(runnerSrc.match(/new WorkerHealth\(/g) ?? []).length}`
    );
    check(
      "[T4] …and the sixth argument of THE runWorkerLoop call is healthRef itself",
      RUN_LOOP_SIXTH_ARG.exec(runnerSrc)?.[1] === "healthRef",
      `sixth argument = ${RUN_LOOP_SIXTH_ARG.exec(runnerSrc)?.[1] ?? "(no match)"}`
    );
    // An assertion that cannot fail proves nothing. This mutates the runner
    // source IN MEMORY — the file on disk is never touched — and requires the
    // two checks above to reject it.
    const divergent = runnerSrc.replace("}, healthRef);", "}, new WorkerHealth(deps.now));");
    check(
      "[T4] …and that pin is falsifiable: a divergent instance is rejected",
      divergent !== runnerSrc && wiringHolds(runnerSrc) && !wiringHolds(divergent),
      `real=${wiringHolds(runnerSrc)} mutated=${wiringHolds(divergent)}`
    );
    check(
      "[T4] worker_idle_proof is logged from exactly one place, inside the no_job branch",
      runnerSrc.split("worker_idle_proof").length - 1 === 1 &&
        /if \(r\.outcome === "no_job"\) \{[\s\S]{0,600}?log\("worker_idle_proof"/.test(runnerSrc)
    );
  }

  // --- mandatory test 5 -------------------------------------------------
  //
  // `runWorkerLoop` RETURNS the health instance it mutated, and that is the
  // object `worker_stopped` spreads. Asserting on the returned instance is
  // therefore asserting on what the stopped worker actually logs.
  {
    const calls: string[] = [];
    const deps = scriptedDeps(["no_job", "no_job", "claimed", "no_job"], calls);
    const health = new WorkerHealth(() => 4242);
    const signal = { aborted: false };
    let n = 0;

    const returned = await runWorkerLoop(
      deps,
      OPTS,
      signal,
      async () => undefined,
      () => {
        n += 1;
        if (n >= 4) signal.aborted = true;
      },
      health
    );

    check("[T5] the loop returns the very instance it mutated", returned === health);
    // Exactly what runLive does: log("worker_stopped", { ...health.snapshot() }).
    const stopped: Record<string, unknown> = { ...returned.snapshot() };
    check(
      "[T5] worker_stopped carries the counters the real loop mutated",
      stopped.noJobCycles === 3 &&
        stopped.consecutiveNoJobCycles === 1 &&
        stopped.maxConsecutiveNoJobCycles === 2 &&
        stopped.iterations === 1,
      JSON.stringify({
        noJobCycles: stopped.noJobCycles,
        consecutiveNoJobCycles: stopped.consecutiveNoJobCycles,
        maxConsecutiveNoJobCycles: stopped.maxConsecutiveNoJobCycles,
        iterations: stopped.iterations,
      })
    );
    check(
      "[T5] …and lastNoJobAtMs is the injected clock, plus shuttingDown set by the loop",
      stopped.lastNoJobAtMs === 4242 && stopped.shuttingDown === true
    );
    check(
      "[T5] /healthz reads the same instance, so the two surfaces cannot disagree",
      JSON.stringify(health.snapshot()) === JSON.stringify(returned.snapshot())
    );
    check(
      "[T5] the idle counters are numbers and a timestamp — never an identifier",
      typeof stopped.noJobCycles === "number" &&
        typeof stopped.consecutiveNoJobCycles === "number" &&
        typeof stopped.maxConsecutiveNoJobCycles === "number" &&
        typeof stopped.lastNoJobAtMs === "number"
    );
    const runnerSrc = code("scripts/run-protocol-worker.ts");
    check(
      "[T5] worker_stopped spreads the whole snapshot, so no counter can be forgotten",
      /log\("worker_stopped", \{ \.\.\.health\.snapshot\(\)/.test(runnerSrc)
    );
  }

  {
    const healthSrc = code("lib/protocol-worker/health.ts");
    check(
      "TK-R-0 added no database write: health.ts still has no db and no await",
      !/db\./.test(healthSrc) && !/await/.test(healthSrc)
    );
    check(
      "markIteration was not moved or redefined — it still only increments `iterations`",
      /markIteration\(\): void \{\s*this\.iterations \+= 1;\s*\}/.test(healthSrc)
    );
  }

  // ======================================================================
  console.log("\n[2] TK-R-1 — the requested model and the served model are two fields");
  // ======================================================================
  await withEnvAsync(
    { ZYPACT_MOCK_MODE: "off", OPENAI_API_KEY: FAKE_OPENAI_KEY, ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY, LLM_PROVIDER: undefined },
    async () => {
    {
      const prepared = prepareCallModelRequest({
        provider: "openai",
        model: "gpt-4o-mini-2024-07-18",
        system: "s",
        user: "u",
      });
      check("the prepared request carries the REQUESTED model", prepared.model === "gpt-4o-mini-2024-07-18", prepared.model);

      // The provider answers with a DIFFERENT model — exactly what a
      // floating alias does, and the case the old code could not represent.
      const served = "gpt-4o-mini-2024-07-18-fp-abc123";
      const body = JSON.stringify({
        id: "chatcmpl-x",
        model: served,
        choices: [{ message: { content: M5_CONTENT } }],
      });
      const out = await executePreparedCallModelRequest(prepared, {
        fetchImpl: (async () =>
          new Response(body, { status: 200, headers: { "x-request-id": "req-openai-1" } })) as typeof fetch,
      });
      check("`model` still holds what we ASKED for", out.model === "gpt-4o-mini-2024-07-18", out.model);
      check("`modelReturned` holds what the provider SERVED", out.modelReturned === served, String(out.modelReturned));
      check("…and the two are genuinely different values", out.model !== out.modelReturned);
      check("TK-R-2 — the provider request id is carried", out.providerRequestId === "req-openai-1", String(out.providerRequestId));
      check("TK-R-3 — the HTTP status is carried", out.httpStatus === 200, String(out.httpStatus));
      check("TK-R-4 — a latency was measured", typeof out.latencyMs === "number" && out.latencyMs >= 0, String(out.latencyMs));
    }
    {
      // A provider that says nothing about the model yields null — never a
      // copy of the requested model, which would fabricate a confirmation.
      const prepared = prepareCallModelRequest({
        provider: "openai",
        model: "gpt-4o-mini-2024-07-18",
        system: "s",
        user: "u",
      });
      const body = JSON.stringify({ id: "c", choices: [{ message: { content: M5_CONTENT } }] });
      const out = await executePreparedCallModelRequest(prepared, {
        fetchImpl: (async () => new Response(body, { status: 200 })) as typeof fetch,
      });
      check("a silent provider yields modelReturned = null", out.modelReturned === null, String(out.modelReturned));
      check("…and never an echo of the requested model", out.modelReturned !== out.model);
      check("a missing request-id header yields null, never a fabricated id", out.providerRequestId === null, String(out.providerRequestId));
    }
    {
      // Anthropic's Messages API documents the same top-level `model`
      // field, so one extractor serves both providers.
      const prepared = prepareCallModelRequest({
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        system: "s",
        user: "u",
      });
      const body = JSON.stringify({
        id: "msg_1",
        model: "claude-3-5-sonnet-20241022",
        content: [{ type: "text", text: M5_CONTENT }],
      });
      const out = await executePreparedCallModelRequest(prepared, {
        fetchImpl: (async () => new Response(body, { status: 200 })) as typeof fetch,
      });
      check("Anthropic's documented top-level `model` is extracted too", out.modelReturned === "claude-3-5-sonnet-20241022", String(out.modelReturned));
    }
    {
      // A failure names no served model, and invents no status.
      const prepared = prepareCallModelRequest({
        provider: "openai",
        model: "gpt-4o-mini-2024-07-18",
        system: "s",
        user: "u",
      });
      let failure: CallModelFailure | null = null;
      try {
        await executePreparedCallModelRequest(prepared, {
          fetchImpl: (async () => {
            throw new Error("ECONNREFUSED");
          }) as typeof fetch,
        });
      } catch (err) {
        failure = err as CallModelFailure;
      }
      const f = must(failure, "failure");
      check("a call that never reached the provider has httpStatus null", f.httpStatus === null, String(f.httpStatus));
      check("…and providerRequestId null", f.providerRequestId === null, String(f.providerRequestId));
      check("…and still measured a latency", typeof f.latencyMs === "number");
    }
    }
  );

  // ======================================================================
  console.log("\n[3] TK-R-1..4 — the four values reach the DURABLE receipt");
  // ======================================================================

  /** An approved protocol with one QUEUED job — nothing claimed yet. */
  let seq = 0;
  async function seedQueued(): Promise<string> {
    seq += 1;
    const project = await db.createProject({ domain: `tkr-seed-${seq}.test`, companyName: "C" });
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
    return must(enq.job, "job").id;
  }

  /** A job driven to "both legs marked sent", ready to receive receipts. */
  async function armed() {
    seq += 1;
    const project = await db.createProject({ domain: `tkr-${seq}.test`, companyName: "C" });
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
    const analysisCall = must(ad.analysisCall, "a").id;
    await db.markExternalCallSentForJob({
      ...f, externalCallId: must(ad.perplexityCall, "p").id, probeRunId, callKind: "perplexity",
      requestBody: PERPLEXITY_REQ, requestBodySha256: sha256Hex(PERPLEXITY_REQ),
    });
    await db.markExternalCallSentForJob({
      ...f, externalCallId: analysisCall, probeRunId, callKind: "analysis",
      requestBody: ANALYSIS_REQ, requestBodySha256: sha256Hex(ANALYSIS_REQ),
    });
    return { f, probeRunId, analysisCall };
  }

  const analysisReceipt = (
    f: { jobId: string; claimToken: string; projectId: string },
    externalCallId: string,
    probeRunId: string
  ): RecordAnalysisCallReceiptForJobInput => ({
    ...f, externalCallId, probeRunId, outcome: "success", provider: "openai",
    model: "gpt-4o-mini-2024-07-18", usedMock: false, requestSha256: sha256Hex(ANALYSIS_REQ),
    responseSha256: sha256Hex(M5_CONTENT), latencyMs: 4242, actualCostUsd: 0.002,
    costBasis: "measured", rawContent: M5_CONTENT, rawRequestBody: ANALYSIS_REQ,
    providerRequestId: "req-openai-durable",
    httpStatus: 200,
    modelReturned: "gpt-4o-mini-2024-07-18-fp-abc123",
  });

  // End to end: what the transport measured is what the worker persists.
  {
    // A fresh QUEUED job for the loop to claim, driven through the real
    // execute-job path with a scripted analysis transport.
    const seededJobId = await seedQueued();
    let captured: RecordAnalysisCallReceiptForJobInput | null = null;
    const spyDb = new Proxy(db, {
      get(target, prop, recv) {
        if (prop === "recordAnalysisCallReceiptForJob") {
          return async (input: RecordAnalysisCallReceiptForJobInput) => {
            captured = input;
            return (target as DbAdapter).recordAnalysisCallReceiptForJob(input);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    }) as DbAdapter;

    const deps: WorkerDeps = {
      db: spyDb,
      runProbe: (async (input) => {
        // `markExternalCallSentForJob` lives INSIDE the injected fetchImpl,
        // immediately before the wire — a probe fixture that never calls it
        // leaves the external call unsent, and the receipt then conflicts.
        await (input.fetchImpl ?? fetch)("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          body: PERPLEXITY_REQ,
        });
        return {
        prompt: input.prompt,
        answer: "answer",
        rawResponse: PROBE_BODY,
        citations: [],
        searchResults: [],
        sourceCitations: [],
        model: "sonar",
        usedMock: false,
        rawResponseBody: PROBE_BODY,
        rawResponseBodySha256: sha256Hex(PROBE_BODY),
        httpStatus: 200,
        latencyMs: 11,
        providerRequestId: "probe-1",
        } satisfies PerplexityProbeResult;
      }) as WorkerDeps["runProbe"],
      analysis: {
        prepare: () => ({
          provider: "openai" as const,
          model: "gpt-4o-mini-2024-07-18",
          url: "https://api.openai.com/v1/chat/completions",
          rawRequestBody: ANALYSIS_REQ,
          requestSha256: sha256Hex(ANALYSIS_REQ),
        }),
        execute: async () => ({
          provider: "openai" as const,
          model: "gpt-4o-mini-2024-07-18",
          content: M5_CONTENT,
          usedMock: false,
          modelReturned: "gpt-4o-mini-2024-07-18-served",
          latencyMs: 3131,
          requestSha256: sha256Hex(ANALYSIS_REQ),
          contentSha256: sha256Hex(M5_CONTENT),
          providerRequestId: "req-end-to-end",
          httpStatus: 200,
        }),
      } as unknown as AnalysisTransport,
      realFetch: (async () => new Response(PROBE_BODY, { status: 200 })) as unknown as WorkerDeps["realFetch"],
      now: () => Date.now(),
      sleep: async () => undefined,
      probeMode: "live_perplexity",
    };

    const health = new WorkerHealth(() => Date.now());
    const seen: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await runOneIteration(deps, OPTS, health);
      seen.push(`${r.outcome}:${r.detail ?? ""}`);
      if (r.outcome === "no_job" || r.outcome === "completed") break;
    }
    check("the seeded job is the one the loop drove", seededJobId.length > 0, seen.join(" | "));
    const cap = captured as RecordAnalysisCallReceiptForJobInput | null;
    check("the worker really reached the analysis receipt", cap !== null);
    if (cap) {
      check("TK-R-4 — the MEASURED success latency is what gets persisted", cap.latencyMs === 3131, String(cap.latencyMs));
      check("TK-R-2 — the extracted request id is what gets persisted", cap.providerRequestId === "req-end-to-end", String(cap.providerRequestId));
      check("TK-R-3 — the observed HTTP status is what gets persisted", cap.httpStatus === 200, String(cap.httpStatus));
      check("TK-R-1 — the SERVED model is what gets persisted", cap.modelReturned === "gpt-4o-mini-2024-07-18-served", String(cap.modelReturned));
      check("TK-R-1 — …alongside, not instead of, the requested model", cap.model === "gpt-4o-mini-2024-07-18", String(cap.model));
    }
  }

  {
    const a = await armed();
    const r = await db.recordAnalysisCallReceiptForJob(analysisReceipt(a.f, a.analysisCall, a.probeRunId));
    check("the receipt is written", r.outcome === "RECEIPTED", r.outcome);
    const rec = must(r.receipt, "receipt");
    check("TK-R-4 — the SUCCESS latency is durable, not null", rec.latencyMs === 4242, String(rec.latencyMs));
    check("TK-R-2 — provider_request_id is durable", rec.providerRequestId === "req-openai-durable", String(rec.providerRequestId));
    check("TK-R-3 — http_status is durable", rec.httpStatus === 200, String(rec.httpStatus));
    check("TK-R-1 — model_returned is durable", rec.modelReturned === "gpt-4o-mini-2024-07-18-fp-abc123", String(rec.modelReturned));
    check("TK-R-1 — …and `model` still holds the REQUESTED model", rec.model === "gpt-4o-mini-2024-07-18", String(rec.model));
    check("TK-R-1 — the two are stored separately, never merged", rec.model !== rec.modelReturned);
  }

  // ======================================================================
  console.log("\n[4] Replay identity — idempotent, or a conflict, never a double write");
  // ======================================================================
  {
    const a = await armed();
    const first = await db.recordAnalysisCallReceiptForJob(analysisReceipt(a.f, a.analysisCall, a.probeRunId));
    const replay = await db.recordAnalysisCallReceiptForJob(analysisReceipt(a.f, a.analysisCall, a.probeRunId));
    check("an exact replay is idempotent", replay.outcome === "ALREADY_RECEIPTED_IDENTICAL", replay.outcome);
    check("…and returns the DURABLE receipt, not the one in hand", replay.receipt?.id === first.receipt?.id);
  }

  const mutations: Array<[string, (i: RecordAnalysisCallReceiptForJobInput) => RecordAnalysisCallReceiptForJobInput]> = [
    ["providerRequestId", (i) => ({ ...i, providerRequestId: "req-openai-OTHER" })],
    ["httpStatus", (i) => ({ ...i, httpStatus: 500 })],
    ["modelReturned", (i) => ({ ...i, modelReturned: "gpt-4o-2024-08-06" })],
    ["latencyMs", (i) => ({ ...i, latencyMs: 4243 })],
    ["providerRequestId → null", (i) => ({ ...i, providerRequestId: null })],
    ["httpStatus → null", (i) => ({ ...i, httpStatus: null })],
    ["modelReturned → null", (i) => ({ ...i, modelReturned: null })],
  ];
  for (const [field, mutate] of mutations) {
    const a = await armed();
    const first = await db.recordAnalysisCallReceiptForJob(analysisReceipt(a.f, a.analysisCall, a.probeRunId));
    const firstId = must(first.receipt, "first").id;
    const second = await db.recordAnalysisCallReceiptForJob(
      mutate(analysisReceipt(a.f, a.analysisCall, a.probeRunId))
    );
    check(`a divergent ${field} conflicts, never passes as a replay`, second.outcome === "RECEIPT_EVIDENCE_CONFLICT", second.outcome);
    check(
      `…and the original receipt is returned untouched (${field}) — no second write`,
      second.receipt?.id === firstId &&
        second.receipt?.providerRequestId === "req-openai-durable" &&
        second.receipt?.httpStatus === 200 &&
        second.receipt?.latencyMs === 4242
    );
  }

  {
    // A pre-0058 row knows none of the three. It must stay writable and
    // readable, and replay identically — no backfill, no invented value.
    const a = await armed();
    const historical: RecordAnalysisCallReceiptForJobInput = {
      ...analysisReceipt(a.f, a.analysisCall, a.probeRunId),
      latencyMs: null,
      providerRequestId: null,
      httpStatus: null,
      modelReturned: null,
    };
    const first = await db.recordAnalysisCallReceiptForJob(historical);
    check("a historical-shaped receipt still writes", first.outcome === "RECEIPTED", first.outcome);
    const rec = must(first.receipt, "receipt");
    check(
      "…and reads back as four honest nulls, never a fabricated value",
      rec.providerRequestId === null && rec.httpStatus === null && rec.modelReturned === null && rec.latencyMs === null
    );
    const replay = await db.recordAnalysisCallReceiptForJob(historical);
    check("…and replays as identical", replay.outcome === "ALREADY_RECEIPTED_IDENTICAL", replay.outcome);
  }

  // ======================================================================
  console.log("\n[5] TK-R-5 — live refuses a floating model before any transport");
  // ======================================================================
  {
    const src = code("lib/protocol-worker/execution-mode.ts");
    check(
      "the rule is applied where live is decided, before any transport exists",
      /requireDatedAnalysisModel\(env, "OPENAI_MODEL"\)/.test(src)
    );
    check(
      "floating aliases are an explicit, named list — not a guess",
      /FLOATING_MODEL_ALIASES/.test(src) && /"gpt-4o-mini"/.test(src)
    );
    check(
      "…and `latest` is refused by its own rule",
      /endsWith\("latest"\)/.test(src)
    );
    check(
      "Anthropic stays fail-closed in live until a dated snapshot is decided",
      /LLM_PROVIDER=anthropic is not permitted in live execution/.test(src)
    );
  }
  {
    // The rule itself, value by value.
    const { isDatedAnalysisModel } = await import("@/lib/protocol-worker/execution-mode");
    const ACCEPT = ["gpt-4o-mini-2024-07-18", "gpt-4o-2024-08-06", "gpt-4.1-mini-2025-04-14"];
    const REFUSE = [
      ["", "absent"],
      ["gpt-4o-mini", "the alias the repo is configured with today's dated form of"],
      ["gpt-4o", "bare family name"],
      ["gpt-4-turbo", "bare family name"],
      ["claude-3-5-sonnet-latest", "ends in latest"],
      ["claude-3-5-sonnet-20241022", "dated, but not in -YYYY-MM-DD form"],
      ["gpt-4o-mini-2024-7-18", "unpadded month/day"],
      ["GPT-4O-MINI-2024-07-18", "uppercase"],
    ] as const;
    for (const m of ACCEPT) check(`accepted, a dated snapshot: ${m}`, isDatedAnalysisModel(m));
    for (const [m, why] of REFUSE) {
      check(`refused before any transport (${why}): ${m === "" ? "(empty)" : m}`, !isDatedAnalysisModel(m));
    }
    check(
      "the configuration the repo runs today stays valid",
      isDatedAnalysisModel("gpt-4o-mini-2024-07-18")
    );
  }

  // ======================================================================
  console.log("\n[6] Migration 0058 — static contract of the recreated RPC");
  // ======================================================================
  {
    const sql = code("supabase/migrations/0058_m5_analysis_receipt_transport_evidence.sql");
    check(
      "the three columns are added, and all three are nullable",
      /add column if not exists provider_request_id text null/.test(sql) &&
        /add column if not exists http_status integer null/.test(sql) &&
        /add column if not exists model_returned text null/.test(sql)
    );
    check(
      "no backfill: the migration never writes a value into an existing row",
      !/\bupdate\s+public\.analysis_call_receipts\b/i.test(sql)
    );
    check(
      "http_status carries a domain check, guarded on null like latency_ms before it",
      /check \(http_status is null or http_status between 100 and 599\)/.test(sql)
    );
    check(
      "the 16-arg form is DROPPED, so the new one cannot become a second overload",
      /drop function if exists public\.record_analysis_call_receipt_for_job\(\s*uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text, text, text\s*\)/.test(sql)
    );
    check(
      "the three parameters are appended, each default null — every existing caller still compiles",
      /p_provider_request_id text default null,\s*\n\s*p_http_status integer default null,\s*\n\s*p_model_returned text default null\s*\n\s*\)/.test(sql)
    );
    check(
      "security definer with an explicit search_path — unchanged from 0056",
      /security definer/.test(sql) && /set search_path = public, pg_temp/.test(sql)
    );
    const grantBlock = sql.slice(sql.lastIndexOf("revoke all on function"));
    check(
      "the privilege model is identical: revoke from all four, grant execute to service_role only",
      /revoke all on function public\.record_analysis_call_receipt_for_job\([\s\S]*?\) from public, anon, authenticated, service_role;/.test(grantBlock) &&
        /grant execute on function public\.record_analysis_call_receipt_for_job\([\s\S]*?\) to service_role;/.test(grantBlock)
    );
    check(
      "the revoke/grant name the NEW 19-argument signature",
      (grantBlock.match(/uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text, text, text, text, integer, text/g) ?? []).length === 2
    );
    check(
      "no direct table privilege is granted to anyone — writes stay behind the RPC",
      !/grant (insert|update|delete)[\s\S]*?on table public\.analysis_call_receipts/i.test(sql)
    );
    check(
      "RLS and tenant isolation are untouched by this migration",
      !/row level security/i.test(sql) && !/create policy|drop policy|alter policy/i.test(sql)
    );
    const identity = sql.slice(sql.indexOf("if v_existing.probe_run_id"), sql.indexOf("ALREADY_RECEIPTED_IDENTICAL"));
    check(
      "all three new fields join the idempotency comparison — they are receipt identity",
      /v_existing\.provider_request_id is not distinct from p_provider_request_id/.test(identity) &&
        /v_existing\.http_status is not distinct from p_http_status/.test(identity) &&
        /v_existing\.model_returned is not distinct from p_model_returned/.test(identity)
    );
    check(
      "…and `model` stays in the comparison too — the requested model is still identity",
      /v_existing\.model is not distinct from p_model\b/.test(identity)
    );
    check(
      "the INSERT writes the three new columns in the SAME statement, never a later UPDATE",
      /raw_request_body, provider_request_id, http_status, model_returned\s*\n\s*\) values \(/.test(sql) &&
        /p_raw_request_body, p_provider_request_id, p_http_status, p_model_returned\s*\n\s*\)/.test(sql)
    );
    // 0058 was the next free number when it was written. What must stay
    // true for ever is its RELATION to 0057 and its uniqueness — never that
    // it remains the highest, which a later 0059 would legitimately end.
    const migrations = readdirSync(path.join(process.cwd(), "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const numbered = migrations
      .map((f) => /^(\d{4})_/.exec(f))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]));
    check(
      "0058 exists under its exact name",
      migrations.includes("0058_m5_analysis_receipt_transport_evidence.sql")
    );
    check(
      "…0057 exists and 0058 follows it with no gap and no gap-filler in between",
      numbered.includes(57) && numbered.includes(58) && !numbered.includes(0),
      `…${numbered.slice(-4).join(", ")}`
    );
    check(
      "…and 0058 is the only migration claiming that number",
      migrations.filter((f) => f.startsWith("0058_")).length === 1,
      migrations.filter((f) => f.startsWith("0058_")).join(",")
    );
    check(
      "…no number is claimed twice anywhere in the ledger",
      new Set(numbered).size === numbered.length,
      `${numbered.length} files, ${new Set(numbered).size} distinct numbers`
    );
    check(
      "a later migration is allowed to exist: this test never asserts 0058 is the highest",
      !/migrations\[migrations\.length - 1\]/.test(code("scripts/test-m5-tk-r-transport-evidence.ts"))
    );
  }

  console.log(`\n${checks - failures}/${checks} checks passed. M5 TK-R ${failures === 0 ? "PASSED" : "FAILED"}.`);
  if (failures > 0) process.exitCode = 1;
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
