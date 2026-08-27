#!/usr/bin/env tsx
/**
 * M5-A — fencing proved against the REAL Perplexity runner.
 *
 * The earlier zero-fetch proofs injected a fake probe runner, which let a
 * WorkerAbort propagate as itself. `runPerplexityProbe` does not: it wraps
 * EVERY throw from its fetcher into a PerplexityProbeFailure with
 * reason "network_error". A refused mark therefore reached the worker
 * disguised as a provider failure, escaped `runOneIteration`, and killed
 * the loop — while the tests still passed.
 *
 * This file uses the real runner. No network: the transport is a counter
 * that throws if it is ever called. No real key: a fixed non-secret
 * placeholder, which the runner only needs to be present.
 */

Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
// Present, obviously fake, and never sent anywhere: the transport below
// refuses to make a request at all.
process.env.PERPLEXITY_API_KEY = "test-not-a-real-key";

import { sha256Hex } from "@/lib/evidence/hash";
import { runPerplexityProbe } from "@/lib/probes/perplexity";
import { runOneIteration } from "@/lib/protocol-worker/worker";
import { WorkerHealth } from "@/lib/protocol-worker/health";
import type { AnalysisTransport, WorkerDeps, WorkerOptions } from "@/lib/protocol-worker/types";
import type { CreateProtocolInput, DbAdapter } from "@/lib/db/types";

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

const APPROVER = "11111111-1111-4111-8111-111111111111";
const ANSWER = "Acme Rival and Example Client are both options.";
const REQ = JSON.stringify({ model: "gpt-4o-mini", messages: [] });
const M5 = JSON.stringify({
  clientPosition: "listed",
  competitorsMentioned: [],
  sourcesCited: [{ source: "g2.com/x", type: "review_site" }],
  answerSummary: "s",
});
const PROVIDER_BODY = JSON.stringify({ id: "req", choices: [{ message: { content: ANSWER } }] });

const PROTOCOL: Omit<CreateProtocolInput, "projectId" | "buyerQuestionVersionId"> = {
  provider: "perplexity", surface: "sonar", plannedBaselineRuns: 1, plannedRetestRuns: 0,
  paraphrasePlan: [{ text: "Which vendors handle X best?", hash: "b".repeat(64) }],
  unitOfAnalysis: "run", primaryMetric: "listed_in_run", samplePlanningMethod: "fixed",
  runCap: 20, spendCapUsd: 100, timeWindowSeconds: 3600, rateLimitPerHour: 100,
  concurrencyLimit: 5, retryCap: 2,
};

const OPTS: WorkerOptions = {
  workerId: "real-probe", leaseSeconds: 60, idleBackoffMs: 1, maxBackoffMs: 2,
  maxSlotsPerClaim: 4, perplexityReservedCostUsd: 0.02, analysisReservedCostUsd: 0.02,
  jitterRatio: 0, maxThrottledRetries: 3, graceMs: 1000,
};

async function main(): Promise<void> {
  const { memoryAdapter } = await import("@/lib/db/memory-adapter");
  const db: DbAdapter = memoryAdapter;

  async function seed(domain: string): Promise<string> {
    const project = await db.createProject({ domain, companyName: "Example Client" });
    const q = await db.createBuyerQuestion({ projectId: project.id });
    const v = await db.createBuyerQuestionVersion({
      buyerQuestionId: q.id, projectId: project.id, versionNumber: 1,
      promptText: "Which vendors handle X best?", promptHash: "a".repeat(64),
      intentType: "comparison", commercialValue: 3, winnability: 3, priority: 10,
      rationale: "fixture", provenance: "founder_supplied",
    });
    await db.approveBuyerQuestionVersion({ versionId: v.id, projectId: project.id, approvedBy: APPROVER });
    const proto = await db.createProtocol({ ...PROTOCOL, projectId: project.id, buyerQuestionVersionId: v.id });
    await db.approveProtocol({ protocolId: proto.id, projectId: project.id, approvedBy: APPROVER });
    const enq = await db.enqueueProtocolExecutionJob({ protocolId: proto.id, projectId: project.id });
    return enq.job!.id;
  }

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

  function deps(dbOverride: DbAdapter, spy: { transports: number }): WorkerDeps {
    return {
      db: dbOverride,
      analysis,
      now: () => Date.now(),
      sleep: async () => {},
      probeMode: "live_perplexity",
      // The one and only transport. Every call is counted; the body is the
      // real one the real runner built.
      realFetch: (async (_url, init) => {
        spy.transports += 1;
        const sent = typeof init?.body === "string" ? init.body : "";
        if (!sent.includes("sonar")) throw new Error("unexpected outbound body");
        return new Response(PROVIDER_BODY, { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      // The REAL runner. Not a double.
      runProbe: runPerplexityProbe,
    };
  }

  // ======================================================================
  console.log("[1] mark refused ⇒ ZERO transport, and the loop survives");
  // ======================================================================
  {
    await seed("real-probe-refused.test");
    const spy = { transports: 0 };
    const guarded = new Proxy(db, {
      get(t, p, r) {
        if (p === "markExternalCallSentForJob") {
          return async () => ({ outcome: "JOB_NOT_OWNED" as const, externalCall: null });
        }
        return Reflect.get(t, p, r);
      },
    }) as DbAdapter;

    let threw: unknown = null;
    let result: Awaited<ReturnType<typeof runOneIteration>> | null = null;
    try {
      result = await runOneIteration(deps(guarded, spy), OPTS, new WorkerHealth(() => Date.now()));
    } catch (e) {
      threw = e;
    }
    check("the iteration returns instead of throwing", threw === null, threw ? String(threw) : "");
    check(
      "…and reports lost_ownership, not a provider failure",
      result?.outcome === "lost_ownership",
      `${result?.outcome}/${result?.detail}`
    );
    check("ZERO transports", spy.transports === 0, String(spy.transports));
  }

  // ======================================================================
  console.log("\n[2] repeated refusals never leak a single request");
  // ======================================================================
  {
    const spy = { transports: 0 };
    const guarded = new Proxy(db, {
      get(t, p, r) {
        if (p === "markExternalCallSentForJob") {
          return async () => ({ outcome: "JOB_NOT_OWNED" as const, externalCall: null });
        }
        return Reflect.get(t, p, r);
      },
    }) as DbAdapter;
    for (let i = 0; i < 20; i += 1) {
      await seed(`real-probe-loop-${i}.test`);
      await runOneIteration(deps(guarded, spy), OPTS, new WorkerHealth(() => Date.now()));
    }
    check("20 refused iterations ⇒ still ZERO transports", spy.transports === 0, String(spy.transports));
  }

  // ======================================================================
  console.log("\n[3] mark accepted ⇒ exactly one transport");
  // ======================================================================
  {
    await seed("real-probe-accepted.test");
    const spy = { transports: 0 };
    const r = await runOneIteration(deps(db, spy), OPTS, new WorkerHealth(() => Date.now()));
    check("the job completes", r.outcome === "completed", `${r.outcome}/${r.detail}`);
    check("exactly ONE transport", spy.transports === 1, String(spy.transports));
  }

  // ======================================================================
  console.log("\n[4] the recorded evidence is the body that went on the wire");
  // ======================================================================
  {
    const jobId = await seed("real-probe-evidence.test");
    const spy = { transports: 0 };
    let onTheWire = "";
    const observing: WorkerDeps = {
      ...deps(db, spy),
      realFetch: (async (_url, init) => {
        spy.transports += 1;
        onTheWire = typeof init?.body === "string" ? init.body : "";
        return new Response(PROVIDER_BODY, { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    };
    type Recorded = { requestBody: string; requestBodySha256: string };
    const box: { value: Recorded | null } = { value: null };
    const capturing = new Proxy(db, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r);
        if (p !== "markExternalCallSentForJob" || typeof v !== "function") return v;
        return async (input: Parameters<DbAdapter["markExternalCallSentForJob"]>[0]) => {
          if (input.callKind === "perplexity") {
            box.value = { requestBody: input.requestBody, requestBodySha256: input.requestBodySha256 };
          }
          return (v as DbAdapter["markExternalCallSentForJob"]).call(t, input);
        };
      },
    }) as DbAdapter;
    const r = await runOneIteration({ ...observing, db: capturing }, OPTS, new WorkerHealth(() => Date.now()));
    check("the job completes", r.outcome === "completed" && r.jobId === jobId, `${r.outcome}/${r.detail}`);
    const recorded = box.value;
    check("evidence was recorded before the wire", recorded !== null);
    check(
      "the recorded body is byte-identical to what the runner sent",
      recorded !== null && recorded.requestBody === onTheWire,
      recorded === null ? "none" : `${recorded.requestBody.length} vs ${onTheWire.length}`
    );
    check(
      "the recorded hash really covers that body",
      recorded !== null && recorded.requestBodySha256 === sha256Hex(recorded.requestBody)
    );
    check(
      "no authorization header leaked into the evidence",
      recorded !== null && !/authorization|bearer|test-not-a-real-key/i.test(recorded.requestBody)
    );
  }

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "M5-A real-probe fencing PASSED." : "M5-A real-probe fencing FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
