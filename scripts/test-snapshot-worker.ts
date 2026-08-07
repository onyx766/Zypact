#!/usr/bin/env tsx
/**
 * Runnable snapshot worker tests.
 *
 * Every dependency is injected: claim, fenced failure write, resolver,
 * engine, sleep, clock, logger. No database, no provider, no real timer, no
 * process signal, no spawned process, and no real worker is started.
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ERROR_BACKOFF_MS,
  IDLE_POLL_MS,
  LEASE_SECONDS,
  MAX_ATTEMPTS,
  MAX_EXECUTION_MS,
  RENEW_EVERY_MS,
  ShutdownSignal,
  runSnapshotWorker,
  type WorkerDeps,
  type WorkerLogFields,
} from "@/lib/snapshot-worker/worker";
import { WorkerExecutionOptionsError } from "@/lib/snapshot-worker/execution-options";
import { costEstimateIsConfigured } from "@/scripts/snapshot-worker";
import type { SnapshotRequest } from "@/lib/db/types";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/* Synthetic sentinels — none may ever reach a log line. */
const TOKEN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EMAIL = "founder@northwind.example";
const COMPANY = "Northwind Analytics";
const DOMAIN = "northwind.example";
const WEBSITE = "https://northwind.example";
const COMPETITOR = "Zzz Secret Competitor Ltd";

function claimedRequest(
  overrides: Partial<SnapshotRequest> = {}
): SnapshotRequest {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workEmail: EMAIL,
    normalizedEmail: EMAIL,
    companyName: COMPANY,
    websiteUrl: WEBSITE,
    normalizedDomain: DOMAIN,
    buyerCategory: "B2B SaaS analytics",
    status: "running",
    requestIpHash: null,
    projectId: "33333333-3333-4333-8333-333333333333",
    progressStage: "reserved",
    progressUpdatedAt: null,
    approvedAt: "2026-08-07T00:00:00.000Z",
    approvedBy: "44444444-4444-4444-8444-444444444444",
    competitors: [COMPETITOR, "Beta Insights"],
    claimedBy: "zypact-worker-deadbeef",
    claimToken: TOKEN,
    leaseExpiresAt: "2026-08-07T01:00:00.000Z",
    attemptCount: 1,
  } as SnapshotRequest;
}

interface Harness {
  calls: string[];
  logs: WorkerLogFields[];
  sleeps: number[];
  engineArgs: unknown[];
  claimArgs: unknown[];
  failArgs: unknown[];
  deps: WorkerDeps;
  shutdown: ShutdownSignal;
}

function makeHarness(opts: {
  claims?: Array<SnapshotRequest | null | Error>;
  engineResult?: (n: number) => Promise<unknown>;
  resolverError?: Error;
  failReturnsNull?: boolean;
  onClaim?: (n: number, shutdown: ShutdownSignal) => void;
} = {}): Harness {
  const calls: string[] = [];
  const logs: WorkerLogFields[] = [];
  const sleeps: number[] = [];
  const engineArgs: unknown[] = [];
  const claimArgs: unknown[] = [];
  const failArgs: unknown[] = [];
  const shutdown = new ShutdownSignal();

  const claims = opts.claims ?? [null];
  let claimIndex = 0;
  let engineIndex = 0;
  let inFlight = 0;

  const deps: WorkerDeps = {
    workerId: "zypact-worker-abcd1234",
    db: {
      async claimNextSnapshotRequest(input) {
        inFlight += 1;
        if (inFlight > 1) calls.push("OVERLAP");
        calls.push("claim");
        claimArgs.push(input);

        const n = claimIndex;
        claimIndex += 1;
        opts.onClaim?.(n, shutdown);

        const next = claims[Math.min(n, claims.length - 1)];
        inFlight -= 1;

        if (next instanceof Error) throw next;
        return next ?? null;
      },
      async markSnapshotRequestFailedWorker(input) {
        calls.push("markFailed");
        failArgs.push(input);
        return opts.failReturnsNull
          ? null
          : ({ status: "failed" } as unknown as SnapshotRequest);
      },
    },
    engine: async (claimed, options, claimToken) => {
      inFlight += 1;
      if (inFlight > 1) calls.push("OVERLAP");
      calls.push("engine");
      engineArgs.push({ id: claimed.id, options, claimToken });

      const n = engineIndex;
      engineIndex += 1;
      const outcome = opts.engineResult?.(n);
      inFlight -= 1;

      if (outcome) return outcome;
      return undefined;
    },
    resolver: (claimed) => {
      calls.push("resolve");
      if (opts.resolverError) throw opts.resolverError;
      return {
        competitors: claimed.competitors,
        probeMode: "live",
        budgetUsd: 2,
        prompts: 5,
        runs: 3,
        out: `./exports/snapshots/${claimed.id}/mvp-scan.md`,
      };
    },
    sleep: async (ms) => {
      calls.push(`sleep:${ms}`);
      sleeps.push(ms);
    },
    log: (fields) => {
      logs.push(fields);
    },
    now: () => 1_000_000,
  };

  return { calls, logs, sleeps, engineArgs, claimArgs, failArgs, deps, shutdown };
}

/** Stops the loop after N claim attempts so tests terminate. */
function stopAfter(h: Harness, n: number): void {
  const original = h.deps.db.claimNextSnapshotRequest.bind(h.deps.db);
  let count = 0;
  h.deps.db.claimNextSnapshotRequest = async (input) => {
    count += 1;
    try {
      return await original(input);
    } finally {
      // Must fire even when the claim throws, or an always-failing claim
      // would loop forever.
      if (count >= n) h.shutdown.request();
    }
  };
}

async function main(): Promise<void> {
  /* ── Polling ──────────────────────────────────────────────────────── */

  console.log("\nPolling");

  const idle = makeHarness({ claims: [null] });
  stopAfter(idle, 2);
  await runSnapshotWorker(idle.deps, idle.shutdown);

  check(
    "1. an empty queue sleeps at the idle interval",
    idle.sleeps.includes(IDLE_POLL_MS) && IDLE_POLL_MS === 15_000
  );
  check(
    "2. no engine or failure write occurs with no work",
    !idle.calls.includes("engine") && !idle.calls.includes("markFailed")
  );
  check(
    "3. claim and sleep alternate — no tight spin",
    idle.calls.filter((c) => c === "claim").length ===
      idle.sleeps.length + 0 ||
      idle.calls.join(",").includes("claim,sleep"),
    idle.calls.join(" ")
  );
  check(
    "4. claims never overlap",
    !idle.calls.includes("OVERLAP")
  );

  /* ── Successful job ───────────────────────────────────────────────── */

  console.log("\nSuccessful job");

  const ok = makeHarness({ claims: [claimedRequest(), null] });
  stopAfter(ok, 2);
  const okResult = await runSnapshotWorker(ok.deps, ok.shutdown);

  check(
    "5. ordering is claim → resolve → engine",
    ok.calls.slice(0, 3).join(",") === "claim,resolve,engine",
    ok.calls.join(" ")
  );
  check(
    "6. the engine runs exactly once for one claim",
    ok.calls.filter((c) => c === "engine").length === 1
  );
  check(
    "7. the worker writes no completion of its own",
    !ok.calls.includes("markFailed") && okResult.succeeded === 1
  );
  check(
    "8. claim forwards the exact lease and attempt policy",
    JSON.stringify(ok.claimArgs[0]) ===
      JSON.stringify({
        workerId: "zypact-worker-abcd1234",
        leaseSeconds: 300,
        maxAttempts: 3,
      }),
    JSON.stringify(ok.claimArgs[0])
  );
  check(
    "9. the engine receives the claim token and resolver options",
    (ok.engineArgs[0] as { claimToken: string }).claimToken === TOKEN &&
      (ok.engineArgs[0] as { options: { probeMode: string } }).options
        .probeMode === "live"
  );
  check(
    "10. no overlapping claim or engine call",
    !ok.calls.includes("OVERLAP")
  );

  /* ── Resolver failures ────────────────────────────────────────────── */

  console.log("\nResolver failures");

  const perm = makeHarness({
    claims: [claimedRequest(), null],
    resolverError: new WorkerExecutionOptionsError(
      "competitors_below_minimum",
      "competitors"
    ),
  });
  stopAfter(perm, 2);
  const permResult = await runSnapshotWorker(perm.deps, perm.shutdown);

  check(
    "11. a permanent resolver error never reaches the engine",
    !perm.calls.includes("engine")
  );
  check(
    "12. it writes the fenced failure exactly once",
    perm.calls.filter((c) => c === "markFailed").length === 1
  );
  check(
    "13. the fenced write carries request, project, and token",
    JSON.stringify(perm.failArgs[0]) ===
      JSON.stringify({
        requestId: claimedRequest().id,
        projectId: claimedRequest().projectId,
        claimToken: TOKEN,
      })
  );
  check(
    "14. the worker keeps polling after a permanent error",
    permResult.reason === "shutdown" && permResult.failed === 1
  );

  const impossible = makeHarness({
    claims: [claimedRequest(), null],
    resolverError: new WorkerExecutionOptionsError(
      "request_project_missing",
      "projectId"
    ),
  });
  const impResult = await runSnapshotWorker(
    impossible.deps,
    impossible.shutdown
  );

  check(
    "15. an impossible state halts the worker",
    impResult.reason === "impossible_state"
  );
  check(
    "16. it still attempted the fenced failure write first",
    impossible.calls.includes("markFailed")
  );
  check(
    "17. it claims no further work after halting",
    impossible.calls.filter((c) => c === "claim").length === 1
  );

  const refused = makeHarness({
    claims: [claimedRequest(), null],
    resolverError: new WorkerExecutionOptionsError(
      "competitors_below_minimum",
      "competitors"
    ),
    failReturnsNull: true,
  });
  stopAfter(refused, 2);
  const refResult = await runSnapshotWorker(refused.deps, refused.shutdown);

  check(
    "18. a refused failure write is never retried",
    refused.calls.filter((c) => c === "markFailed").length === 1
  );
  check(
    "19. a refusal is reported as ownership lost, not a failure",
    refused.logs.some((l) => l.event === "ownership_lost") &&
      refResult.failed === 0
  );

  /* ── Claim errors and backoff ─────────────────────────────────────── */

  console.log("\nClaim errors");

  const boom = new Error("transport_failure");
  const backoff = makeHarness({ claims: [boom] });
  stopAfter(backoff, 6);
  await runSnapshotWorker(backoff.deps, backoff.shutdown);

  check(
    "20. backoff escalates 15s → 30s → 60s → 120s",
    JSON.stringify(backoff.sleeps.slice(0, 4)) ===
      JSON.stringify([15_000, 30_000, 60_000, 120_000]),
    JSON.stringify(backoff.sleeps)
  );
  check(
    "21. backoff caps at 120s",
    backoff.sleeps.slice(4).every((ms) => ms === 120_000) &&
      ERROR_BACKOFF_MS[ERROR_BACKOFF_MS.length - 1] === 120_000
  );
  check(
    "22. no engine call is made on a claim error",
    !backoff.calls.includes("engine")
  );
  check(
    "23. the error log carries no raw error payload",
    backoff.logs
      .filter((l) => l.event === "claim_error")
      .every((l) => l.reason === "Error")
  );

  const reset = makeHarness({ claims: [boom, null, boom] });
  stopAfter(reset, 4);
  await runSnapshotWorker(reset.deps, reset.shutdown);

  check(
    "24. a successful null claim resets the backoff to 15s",
    reset.sleeps[0] === 15_000 &&
      reset.sleeps[1] === IDLE_POLL_MS &&
      reset.sleeps[2] === 15_000,
    JSON.stringify(reset.sleeps)
  );

  /* ── Shutdown ─────────────────────────────────────────────────────── */

  console.log("\nShutdown");

  const idleStop = makeHarness({ claims: [null] });
  idleStop.shutdown.request();
  await runSnapshotWorker(idleStop.deps, idleStop.shutdown);

  check(
    "25. shutdown before the loop makes no claim at all",
    !idleStop.calls.includes("claim")
  );

  const inFlight = makeHarness({
    claims: [claimedRequest()],
    onClaim: (_n, shutdown) => shutdown.request(),
  });
  const inFlightResult = await runSnapshotWorker(
    inFlight.deps,
    inFlight.shutdown
  );

  check(
    "26. a request claimed as shutdown began is not executed",
    !inFlight.calls.includes("engine")
  );
  check(
    "27. it is NOT marked failed merely because of shutdown",
    !inFlight.calls.includes("markFailed"),
    inFlight.calls.join(" ")
  );
  check(
    "28. the abandonment is logged for later lease reclaim",
    inFlight.logs.some(
      (l) => l.event === "claim_abandoned_for_shutdown"
    ) && inFlightResult.reason === "shutdown"
  );
  check(
    "29. no resolver or renewal work happens after abandonment",
    !inFlight.calls.includes("resolve")
  );

  const nullInFlight = makeHarness({
    claims: [null],
    onClaim: (_n, shutdown) => shutdown.request(),
  });
  await runSnapshotWorker(nullInFlight.deps, nullInFlight.shutdown);

  check(
    "30. shutdown during a no-work claim exits without sleeping",
    !nullInFlight.calls.some((c) => c.startsWith("sleep"))
  );

  const duringEngine = makeHarness({
    claims: [claimedRequest(), claimedRequest()],
    engineResult: async () => undefined,
  });
  duringEngine.deps.engine = async (claimed, options, token) => {
    duringEngine.calls.push("engine");
    duringEngine.engineArgs.push({ id: claimed.id, options, token });
    duringEngine.shutdown.request();
  };
  await runSnapshotWorker(duringEngine.deps, duringEngine.shutdown);

  check(
    "31. an engine call in progress is allowed to resolve",
    duringEngine.calls.filter((c) => c === "engine").length === 1
  );
  check(
    "32. no second claim happens after shutdown during execution",
    duringEngine.calls.filter((c) => c === "claim").length === 1
  );

  /* ── Engine failures ──────────────────────────────────────────────── */

  console.log("\nEngine failures");

  class EngineError extends Error {
    requestMarkedFailed: boolean;
    constructor(marked: boolean) {
      super("engine");
      this.name = "ApprovedSnapshotExecutionError";
      this.requestMarkedFailed = marked;
    }
  }

  const handled = makeHarness({
    claims: [claimedRequest(), null],
    engineResult: () => Promise.reject(new EngineError(true)),
  });
  stopAfter(handled, 2);
  const handledResult = await runSnapshotWorker(
    handled.deps,
    handled.shutdown
  );

  check(
    "33. an engine-recorded failure is not written twice",
    !handled.calls.includes("markFailed")
  );
  check(
    "34. the worker keeps polling after a recorded failure",
    handledResult.reason === "shutdown" && handledResult.failed === 1
  );

  const lost = makeHarness({
    claims: [claimedRequest(), null],
    engineResult: () => Promise.reject(new EngineError(false)),
  });
  stopAfter(lost, 2);
  const lostResult = await runSnapshotWorker(lost.deps, lost.shutdown);

  check(
    "35. ownership loss receives no repair write",
    !lost.calls.includes("markFailed")
  );
  check(
    "36. ownership loss is logged and polling continues",
    lost.logs.some((l) => l.event === "ownership_lost") &&
      lostResult.reason === "shutdown"
  );

  const systemic = makeHarness({
    claims: [claimedRequest(), null],
    engineResult: () => Promise.reject(new TypeError("undefined is not a fn")),
  });
  const sysResult = await runSnapshotWorker(systemic.deps, systemic.shutdown);

  check(
    "37. an unclassified engine error halts rather than draining the queue",
    sysResult.reason === "systemic_engine_error" &&
      systemic.calls.filter((c) => c === "claim").length === 1
  );
  check(
    "38. it performs no repair write either",
    !systemic.calls.includes("markFailed")
  );

  /* ── Configuration ────────────────────────────────────────────────── */

  console.log("\nConfiguration");

  check("39. idle poll is 15000ms", IDLE_POLL_MS === 15_000);
  check("40. lease is 300 seconds", LEASE_SECONDS === 300);
  check("41. renewal is 100000ms", RENEW_EVERY_MS === 100_000);
  check("42. max execution is 1800000ms", MAX_EXECUTION_MS === 1_800_000);
  check("43. max attempts is 3", MAX_ATTEMPTS === 3);
  check(
    "44. renewal leaves margin: renew*2 <= lease window",
    RENEW_EVERY_MS * 2 <= LEASE_SECONDS * 1000
  );

  /* ── Cost-estimate startup gate ───────────────────────────────────── */

  console.log("\nCost-estimate startup gate");

  check("45. a missing estimate blocks startup", !costEstimateIsConfigured(undefined));
  check("46. a blank estimate blocks startup", !costEstimateIsConfigured("   "));
  check("47. zero blocks startup", !costEstimateIsConfigured("0"));
  check("48. a negative value blocks startup", !costEstimateIsConfigured("-1"));
  check("49. a non-numeric value blocks startup", !costEstimateIsConfigured("abc"));
  check("50. a non-finite value blocks startup", !costEstimateIsConfigured("Infinity"));
  check("51. a valid positive estimate allows startup", costEstimateIsConfigured("0.03"));

  /* ── Log confidentiality ──────────────────────────────────────────── */

  console.log("\nLog confidentiality");

  const everyLog = [
    ...ok.logs,
    ...perm.logs,
    ...refused.logs,
    ...inFlight.logs,
    ...lost.logs,
    ...systemic.logs,
    ...backoff.logs,
  ];
  const serialized = JSON.stringify(everyLog);

  for (const [label, secret] of [
    ["52. no claim token", TOKEN],
    ["53. no work email", EMAIL],
    ["54. no company name", COMPANY],
    ["55. no domain", DOMAIN],
    ["56. no website URL", WEBSITE],
    ["57. no competitor value", COMPETITOR],
  ] as Array<[string, string]>) {
    check(`${label} appears in any log`, !serialized.includes(secret));
  }

  check(
    "58. logs still carry the operational fields",
    everyLog.some((l) => l.requestId) &&
      everyLog.some((l) => l.event === "claim_succeeded") &&
      everyLog.every((l) => typeof l.workerId === "string")
  );

  /* ── Source scope ─────────────────────────────────────────────────── */

  console.log("\nScope");

  const read = (rel: string): string =>
    readFileSync(join(process.cwd(), rel), "utf-8");

  const controller = read("lib/snapshot-worker/worker.ts");
  const entry = read("scripts/snapshot-worker.ts");
  const executable = (s: string): string =>
    s
      .split("\n")
      .filter((line) => {
        const t = line.trimStart();
        return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
      })
      .join("\n");

  check(
    "59. concurrency is structurally one — no pool or parallel await",
    !/Promise\.all|Promise\.allSettled|concurrency|new Worker\(/.test(
      executable(controller)
    )
  );
  check(
    "60. the controller reads no environment and opens no connection",
    !/process\.env|createClient|getDb\(/.test(executable(controller))
  );
  check(
    "61. no direct table write or SQL from the worker",
    !/\.from\(|insert\(|update\(|delete\(/.test(executable(controller))
  );
  check(
    "62. no cron, queue product, or systemd reference",
    !/cron|bull|pg-boss|systemd|amqp|redis/i.test(
      executable(controller) + executable(entry)
    )
  );
  check(
    "63. the worker never renews a lease itself",
    !/renewSnapshotRequestLease|LeaseRenewer/.test(
      executable(controller) + executable(entry)
    )
  );
  check(
    "64. execution values come only from the resolver",
    !/probeMode|budgetUsd|prompts:|runs:/.test(executable(controller))
  );
  check(
    "65. both SIGTERM and SIGINT are handled",
    /"SIGTERM", "SIGINT"/.test(entry) &&
      /uncaughtException/.test(entry) &&
      /unhandledRejection/.test(entry)
  );
  check(
    "66. the manual CLI is untouched by this change",
    /parseCompetitors/.test(read("scripts/run-approved-snapshot.ts")) &&
      !/runSnapshotWorker/.test(read("scripts/run-approved-snapshot.ts"))
  );
  check(
    "67. package.json is not modified for the worker",
    !/snapshot-worker\.ts/.test(read("package.json"))
  );

  console.log("\n─────────────────────────────────────────────────────────");
  console.log("One sequential loop, one claim at a time. The resolver always");
  console.log("runs before the engine, and a request claimed as shutdown");
  console.log("began is abandoned for lease reclaim rather than falsely");
  console.log("failed. No worker was started and no queue was polled.");
  console.log("─────────────────────────────────────────────────────────");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
