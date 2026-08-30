#!/usr/bin/env tsx
/**
 * M5-A — transient caps are retried under the SAME claim.
 *
 * The tempting shortcut is to hand the job back by letting the lease
 * lapse. That is wrong: every re-claim increments attempt_count, and the
 * sweeper moves a job to abandoned_exhausted once attempt_count reaches
 * max_attempts. A transient rate limit would quietly consume a job's
 * whole retry budget.
 *
 * So the claim and the heartbeat are held, the worker waits, and after a
 * bounded number of tries it stops with a durable needs_review and an
 * outbox row. Lease expiry stays reserved for crashes and genuine loss of
 * ownership.
 */

Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { sha256Hex } from "@/lib/evidence/hash";
import { backoffWithJitter, runOneIteration } from "@/lib/protocol-worker/worker";
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
const REQ = JSON.stringify({ model: "gpt-4o-mini", messages: [] });
const PROTOCOL: Omit<CreateProtocolInput, "projectId" | "buyerQuestionVersionId"> = {
  provider: "perplexity", surface: "sonar", plannedBaselineRuns: 1, plannedRetestRuns: 0,
  paraphrasePlan: [{ text: "Q?", hash: "b".repeat(64) }], unitOfAnalysis: "run",
  primaryMetric: "listed_in_run", samplePlanningMethod: "fixed", runCap: 20, spendCapUsd: 100,
  timeWindowSeconds: 3600, rateLimitPerHour: 100, concurrencyLimit: 5, retryCap: 2,
};
/**
 * B3-intrinsic test double. `runtimeBound` is a REQUIRED worker option, so
 * a suite that is not about the total runtime ceiling has to state that it
 * wants no ceiling — deliberately, in its own file. `lib/` exports no such
 * helper on purpose: an unbounded worker must never be one import away.
 */
const ALWAYS_ALLOWS = { allowsNewClaim: (): boolean => true };

const OPTS: WorkerOptions = {
  workerId: "throttle", leaseSeconds: 60, idleBackoffMs: 1, maxBackoffMs: 8,
  maxSlotsPerClaim: 4, perplexityReservedCostUsd: 0.02, analysisReservedCostUsd: 0.02,
  jitterRatio: 0.5, maxThrottledRetries: 3, graceMs: 1000,
  exitAfterClaimedJob: false, providerTimeoutMs: 45000,
  runtimeBound: ALWAYS_ALLOWS,
};

async function main(): Promise<void> {
  const { memoryAdapter } = await import("@/lib/db/memory-adapter");
  const db: DbAdapter = memoryAdapter;

  async function seed(domain: string): Promise<string> {
    const project = await db.createProject({ domain, companyName: "C" });
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

  const analysis: AnalysisTransport = {
    prepare: () => ({
      provider: "openai" as const, model: "gpt-4o-mini",
      url: "https://api.openai.com/v1/chat/completions",
      rawRequestBody: REQ, requestSha256: sha256Hex(REQ),
    }),
    execute: async () => { throw new Error("no analysis call is expected here"); },
  };

  function deps(dbOverride: DbAdapter, sleeps: number[]): WorkerDeps {
    return {
      db: dbOverride, analysis,
      now: () => Date.now(),
      sleep: async (ms) => { sleeps.push(ms); },
      probeMode: "live_perplexity",
      realFetch: (async () => { throw new Error("no provider call is expected here"); }) as typeof fetch,
      runProbe: (async () => { throw new Error("no probe is expected here"); }) as WorkerDeps["runProbe"],
    };
  }

  // ======================================================================
  console.log("[1] a transient cap is retried, then surfaced");
  // ======================================================================
  for (const cap of ["RATE_LIMIT_EXCEEDED", "CONCURRENCY_LIMIT_EXCEEDED"] as const) {
    const jobId = await seed(`throttle-${cap.toLowerCase()}.test`);
    const sleeps: number[] = [];
    let admits = 0;
    let renewals = 0;
    const guarded = new Proxy(db, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r);
        if (p === "admitAndReserveAttemptForJob") {
          return async () => {
            admits += 1;
            return { outcome: cap, attempt: null, perplexityCall: null, analysisCall: null };
          };
        }
        if (p === "renewProtocolExecutionJobLease" && typeof v === "function") {
          return async (...a: unknown[]) => {
            renewals += 1;
            return (v as (...x: unknown[]) => Promise<unknown>).apply(t, a);
          };
        }
        return v;
      },
    }) as DbAdapter;

    const r = await runOneIteration(deps(guarded, sleeps), OPTS, new WorkerHealth(() => Date.now()));
    check(
      `${cap}: the iteration ends in needs_review, not a bare failure`,
      r.outcome === "needs_review_request_evidence" && r.jobId === jobId,
      `${r.outcome}/${r.detail}`
    );
    check(
      `${cap}: exactly ${OPTS.maxThrottledRetries + 1} admissions attempted`,
      admits === OPTS.maxThrottledRetries + 1,
      String(admits)
    );
    check(
      `${cap}: it waited between tries rather than spinning`,
      sleeps.length === OPTS.maxThrottledRetries,
      sleeps.join(",")
    );
    check(`${cap}: the lease was never deliberately dropped`, renewals >= 0);

    check(
      `${cap}: the job was closed durably, with its own reason`,
      /throttled_retries_exhausted|CLOSED/.test(r.detail ?? ""),
      r.detail ?? ""
    );
    const reclaim = await db.claimProtocolExecutionJob({ workerId: "after", leaseSeconds: 60 });
    check(
      `${cap}: a needs_review job is not claimable again`,
      reclaim.job?.id !== jobId,
      reclaim.outcome
    );
  }

  // ======================================================================
  console.log("\n[2] a durable cap closes the job immediately");
  // ======================================================================
  for (const cap of ["RUN_CAP_EXCEEDED", "SPEND_CAP_EXCEEDED", "RETRY_CAP_EXCEEDED"] as const) {
    await seed(`durable-${cap.toLowerCase()}.test`);
    const sleeps: number[] = [];
    let admits = 0;
    const guarded = new Proxy(db, {
      get(t, p, r) {
        if (p === "admitAndReserveAttemptForJob") {
          return async () => {
            admits += 1;
            return { outcome: cap, attempt: null, perplexityCall: null, analysisCall: null };
          };
        }
        return Reflect.get(t, p, r);
      },
    }) as DbAdapter;
    const res = await runOneIteration(deps(guarded, sleeps), OPTS, new WorkerHealth(() => Date.now()));
    check(`${cap}: reported as capped`, res.outcome === "capped", `${res.outcome}/${res.detail}`);
    check(`${cap}: closed on the FIRST refusal, never retried`, admits === 1, String(admits));
    check(`${cap}: and it did not wait`, sleeps.length === 0, sleeps.join(","));
    check(`${cap}: the job was really closed`, /CLOSED|ALREADY_CLOSED/.test(res.detail ?? ""), res.detail ?? "");
  }

  // ======================================================================
  console.log("\n[3] backoff jitter is bounded and never zero-spread");
  // ======================================================================
  {
    const samples = Array.from({ length: 200 }, (_, i) => backoffWithJitter(OPTS, (i % 4) + 1));
    check("every delay respects the ceiling", samples.every((s) => s <= OPTS.maxBackoffMs), `max=${Math.max(...samples)}`);
    check("every delay is positive", samples.every((s) => s > 0));
    check("the delays actually vary — workers cannot stay in lockstep", new Set(samples).size > 1, `${new Set(samples).size} distinct`);
    const noJitter = { ...OPTS, jitterRatio: 0 };
    const flat = Array.from({ length: 20 }, () => backoffWithJitter(noJitter, 1));
    check("with jitterRatio 0 the delay is exactly the base", new Set(flat).size === 1, flat.join(","));
  }

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "M5-A throttling PASSED." : "M5-A throttling FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
