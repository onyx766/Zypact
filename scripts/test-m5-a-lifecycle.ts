#!/usr/bin/env tsx
/**
 * M5-A — process lifecycle.
 *
 * The parts that only matter when the worker runs for days: a timer that
 * actually keeps the process alive, a heartbeat that cannot pile up on
 * itself, readiness that does not mistake an idle worker for a dead one,
 * and a health surface that leaks nothing.
 */

Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { readFileSync } from "node:fs";
import path from "node:path";
import { WorkerHealth } from "@/lib/protocol-worker/health";
import { startHeartbeat } from "@/lib/protocol-worker/heartbeat";
import { backoffWithJitter } from "@/lib/protocol-worker/worker";
import type { DbAdapter } from "@/lib/db/types";
import type { WorkerOptions } from "@/lib/protocol-worker/types";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else { failures += 1; console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const OPTS: WorkerOptions = {
  workerId: "lifecycle", leaseSeconds: 60, idleBackoffMs: 100, maxBackoffMs: 1600,
  maxSlotsPerClaim: 4, perplexityReservedCostUsd: 0.02, analysisReservedCostUsd: 0.02,
  jitterRatio: 0.5, maxThrottledRetries: 3, graceMs: 5000,
};

async function main(): Promise<void> {
  const src = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
  const code = (p: string) =>
    src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  // ======================================================================
  console.log("[1] The idle timer keeps the process alive");
  // ======================================================================
  {
    // Behavioural, not textual: the entrypoint's own `sleep` is imported
    // and exercised. A regex could only ever describe the code; this
    // measures what it does.
    const { __workerLifecycleTestUtils } = await import("@/lib/protocol-worker/lifecycle");
    const { sleep: entrySleep } = __workerLifecycleTestUtils;

    const t0 = Date.now();
    await entrySleep(120);
    const slept = Date.now() - t0;
    check("an uninterrupted wait really waits", slept >= 100, `${slept}ms`);

    const ac = new AbortController();
    const t1 = Date.now();
    const waited = entrySleep(5000, ac.signal);
    setTimeout(() => ac.abort(), 40);
    await waited;
    const cut = Date.now() - t1;
    check(
      "an aborted wait is cut short — shutdown never outlasts a backoff",
      cut < 1000,
      `${cut}ms instead of 5000ms`
    );

    const already = new AbortController();
    already.abort();
    const t2 = Date.now();
    await entrySleep(5000, already.signal);
    check("a wait that starts already aborted returns at once", Date.now() - t2 < 200, `${Date.now() - t2}ms`);

    const entry = code("scripts/run-protocol-worker.ts");
    check(
      "only the health server is unref'd, because it must never hold the process open",
      /healthServer\?\.unref\(\)/.test(entry)
    );
    check(
      "the backoff timer is not unref'd anywhere in the entrypoint",
      !/setTimeout\(resolve, ms\)[\s\S]{0,60}unref/.test(entry)
    );
  }

  // ======================================================================
  console.log("\n[1b] The abort signal reaches BOTH providers");
  // ======================================================================
  {
    const { runOneIteration } = await import("@/lib/protocol-worker/worker");
    const { memoryAdapter } = await import("@/lib/db/memory-adapter");
    const { sha256Hex } = await import("@/lib/evidence/hash");
    const db = memoryAdapter;
    const A = "11111111-1111-4111-8111-111111111111";
    const project = await db.createProject({ domain: `abort-${Date.now()}.test`, companyName: "C" });
    const q = await db.createBuyerQuestion({ projectId: project.id });
    const v = await db.createBuyerQuestionVersion({
      buyerQuestionId: q.id, projectId: project.id, versionNumber: 1, promptText: "Q?",
      promptHash: "a".repeat(64), intentType: "comparison", commercialValue: 3, winnability: 3,
      priority: 10, rationale: "f", provenance: "founder_supplied",
    });
    await db.approveBuyerQuestionVersion({ versionId: v.id, projectId: project.id, approvedBy: A });
    const proto = await db.createProtocol({
      projectId: project.id, buyerQuestionVersionId: v.id, provider: "perplexity", surface: "sonar",
      plannedBaselineRuns: 1, plannedRetestRuns: 0,
      paraphrasePlan: [{ text: "Q?", hash: "b".repeat(64) }], unitOfAnalysis: "run",
      primaryMetric: "listed_in_run", samplePlanningMethod: "fixed", runCap: 20, spendCapUsd: 100,
      timeWindowSeconds: 3600, rateLimitPerHour: 100, concurrencyLimit: 5, retryCap: 2,
    });
    await db.approveProtocol({ protocolId: proto.id, projectId: project.id, approvedBy: A });
    await db.enqueueProtocolExecutionJob({ protocolId: proto.id, projectId: project.id });

    const ac = new AbortController();
    const seen: { fetch: AbortSignal | null | undefined; analysis: AbortSignal | undefined } =
      { fetch: undefined, analysis: undefined };
    const BODY = JSON.stringify({ id: "r", choices: [{ message: { content: "answer" } }] });
    const REQ = JSON.stringify({ model: "gpt-4o-mini", messages: [] });
    const CONTENT = JSON.stringify({
      clientPosition: "absent", competitorsMentioned: [], sourcesCited: [], answerSummary: "",
    });
    await runOneIteration(
      {
        db,
        now: () => Date.now(),
        sleep: async () => {},
        abortSignal: ac.signal,
        probeMode: "live_perplexity",
        realFetch: (async (_u: unknown, init?: { signal?: AbortSignal | null }) => {
          seen.fetch = init?.signal;
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
        runProbe: (async (input: { prompt: string; fetchImpl?: typeof fetch }) => {
          // The real runner forwards whatever signal it was given.
          await (input.fetchImpl ?? fetch)("https://api.perplexity.ai/x", {
            method: "POST", body: "{}", signal: ac.signal,
          });
          return {
            prompt: input.prompt, answer: "answer", rawResponse: BODY, citations: [],
            searchResults: [], sourceCitations: [], model: "sonar", usedMock: false,
            rawResponseBody: BODY, rawResponseBodySha256: sha256Hex(BODY),
            httpStatus: 200, latencyMs: 1, providerRequestId: "r",
          };
        }) as never,
        analysis: {
          prepare: () => ({
            provider: "openai" as const, model: "gpt-4o-mini",
            url: "https://api.openai.com/v1/chat/completions",
            rawRequestBody: REQ, requestSha256: sha256Hex(REQ),
          }),
          execute: async (_p, opts) => {
            seen.analysis = opts?.signal;
            return {
              provider: "openai" as const, model: "gpt-4o-mini", content: CONTENT, usedMock: false,
              modelReturned: null,
              latencyMs: 1, requestSha256: sha256Hex(REQ), contentSha256: sha256Hex(CONTENT),
              providerRequestId: "a", httpStatus: 200,
            };
          },
        },
      },
      { ...OPTS, workerId: "abort-probe", maxSlotsPerClaim: 2 },
      new WorkerHealth(() => Date.now())
    );
    check("the analysis call receives the shutdown signal", seen.analysis === ac.signal);
    check("the provider fetch receives it too", seen.fetch === ac.signal);
  }

  // ======================================================================
  console.log("\n[2] Readiness rests on the last successful database contact");
  // ======================================================================
  {
    let t = 1_000_000;
    const h = new WorkerHealth(() => t);
    check("a worker that has not reached the database yet is not ready", !h.isReady(10_000));
    h.markDbContact();
    check("after one successful call it is ready", h.isReady(10_000));
    t += 5_000;
    check("still ready inside the window, with no heartbeat at all", h.isReady(10_000));
    check(
      "…and it produced no heartbeat — an idle worker renews nothing",
      h.snapshot().lastHeartbeatAtMs === null
    );
    t += 10_000;
    check("outside the window it stops being ready", !h.isReady(10_000));
    h.markDbContact();
    check("a fresh contact makes it ready again", h.isReady(10_000));
  }

  // ======================================================================
  console.log("\n[3] The health surface carries nothing identifying");
  // ======================================================================
  {
    const h = new WorkerHealth(() => 1);
    h.markClaim();
    h.markHeartbeat();
    h.markDbContact();
    h.markIteration();
    const snap = h.snapshot();
    const keys = Object.keys(snap).sort();
    check(
      "the snapshot is a closed set of scalars",
      keys.join(",") === "alive,consecutiveNoJobCycles,iterations,lastClaimAtMs,lastDbContactAtMs,lastHeartbeatAtMs,lastNoJobAtMs,maxConsecutiveNoJobCycles,noJobCycles,shuttingDown,startedAtMs",
      keys.join(",")
    );
    check(
      "every value is a boolean or a number — never a string that could be an identifier",
      Object.values(snap).every((v) => typeof v === "boolean" || typeof v === "number" || v === null)
    );
    const serialized = JSON.stringify(snap);
    // `lastClaimAtMs` names a timestamp, not a claim token — so the test
    // looks at the VALUES, which is where an identifier could actually
    // hide: no UUID, no JWT, no free text of any kind.
    check(
      "no value looks like an identifier or a credential",
      !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(serialized) &&
        !/eyJ[A-Za-z0-9_-]{10,}/.test(serialized) &&
        !/"[^"]{16,}"/.test(serialized.replace(/"[a-zA-Z]+":/g, "")),
      serialized
    );
    const healthSrc = code("lib/protocol-worker/health.ts");
    check("health.ts never reads the database", !/db\./.test(healthSrc) && !/await/.test(healthSrc));
  }

  // ======================================================================
  console.log("\n[4] The heartbeat is single-flight");
  // ======================================================================
  {
    let inFlight = 0;
    let maxInFlight = 0;
    let renewals = 0;
    const slowDb = {
      async renewProtocolExecutionJobLease() {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        renewals += 1;
        await sleep(60);
        inFlight -= 1;
        return { outcome: "RENEWED" as const, job: null };
      },
    } as unknown as DbAdapter;

    const health = new WorkerHealth(() => Date.now());
    const hb = startHeartbeat({
      db: slowDb, health, jobId: "j", claimToken: "t", projectId: "p",
      // 3 s lease -> a 1 s tick, while each renewal takes 60 ms.
      leaseSeconds: 3, onLost: () => {},
    });
    await sleep(2400);
    hb.stop();
    check("renewals really happened", renewals >= 1, String(renewals));
    check("never two renewals in the air at once", maxInFlight <= 1, `max=${maxInFlight}`);
    check("a successful renewal counts as a database contact", health.isReady(60_000));
  }

  // ======================================================================
  console.log("\n[5] Losing ownership stops the heartbeat for good");
  // ======================================================================
  {
    let lost = 0;
    let calls = 0;
    const db = {
      async renewProtocolExecutionJobLease() {
        calls += 1;
        return { outcome: "JOB_NOT_OWNED" as const, job: null };
      },
    } as unknown as DbAdapter;
    const health = new WorkerHealth(() => Date.now());
    const hb = startHeartbeat({
      db, health, jobId: "j", claimToken: "t", projectId: "p",
      leaseSeconds: 3, onLost: () => { lost += 1; },
    });
    await sleep(2400);
    hb.stop();
    check("onLost fired", lost >= 1, String(lost));
    check("…exactly once, never repeatedly", lost === 1, String(lost));
    check("and it stopped renewing after that", calls === 1, String(calls));
    check("ownership is reported as lost", hb.owned() === false);
  }

  // ======================================================================
  console.log("\n[6] The grace budget stays below the lease");
  // ======================================================================
  {
    const entry = code("scripts/run-protocol-worker.ts");
    check(
      "shutdown aborts in-flight calls after a grace bounded by the lease",
      /Math\.min\(opts\.graceMs, opts\.leaseSeconds \* 1000 - 1\)/.test(entry)
    );
    check("an AbortController is wired into the real transport", /shutdown\.signal/.test(entry));
    check("SIGTERM and SIGINT are both handled", /SIGTERM/.test(entry) && /SIGINT/.test(entry));
    check(
      "the health server binds the validated configured host",
      /listen\(healthPort, healthHost\)/.test(entry)
    );
    check("both endpoints exist", /\/healthz/.test(entry) && /\/readyz/.test(entry));
  }

  // ======================================================================
  console.log("\n[7] Backoff stays inside its ceiling");
  // ======================================================================
  {
    const s = Array.from({ length: 500 }, (_, i) => backoffWithJitter(OPTS, (i % 8) + 1));
    check("never above maxBackoffMs", Math.max(...s) <= OPTS.maxBackoffMs, String(Math.max(...s)));
    check("never below the base", Math.min(...s) >= OPTS.idleBackoffMs, String(Math.min(...s)));
    check("it does grow with the attempt", backoffWithJitter({ ...OPTS, jitterRatio: 0 }, 4) > backoffWithJitter({ ...OPTS, jitterRatio: 0 }, 1));
  }

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "M5-A lifecycle PASSED." : "M5-A lifecycle FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
