#!/usr/bin/env tsx
/**
 * Worker lease-renewal tests.
 *
 * Everything runs on an injected clock and injected timer functions. No
 * real timer is scheduled, no process is spawned, no database is contacted,
 * and no provider is called.
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ZYPACT_ALLOW_MEMORY_DB;

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  COMPLETION_SAFETY_MARGIN_MS,
  LeaseRenewer,
  LeaseOwnershipLostError,
  LEASE_ENV_KEYS,
  MAX_RENDERER_TIMEOUT_MS,
  rendererTimeoutMsFor,
  MAX_LEASE_SECONDS,
  MIN_LEASE_SECONDS,
  readLeaseRenewalConfigFromEnv,
  validateLeaseRenewalConfig,
  type LeaseRenewalConfig,
  type LeaseRenewalDb,
} from "@/lib/snapshot-worker/lease-renewal";
import type {
  RenewSnapshotRequestLeaseInput,
  SnapshotRequest,
} from "@/lib/db/types";

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

const CLAIM_TOKEN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

const CONFIG: LeaseRenewalConfig = {
  requestId: REQUEST_ID,
  claimToken: CLAIM_TOKEN,
  leaseSeconds: 300,
  renewEveryMs: 60_000,
  maxExecutionMs: 600_000,
};

/** Controllable clock and timer so no wall-clock time passes. */
function makeHarness(
  behavior: {
    result?: "ok" | "refused" | "throw";
  } = {}
) {
  const calls: RenewSnapshotRequestLeaseInput[] = [];
  let clock = 1_000_000;
  let tick: (() => void) | null = null;
  let cleared = 0;

  let mode: "ok" | "refused" | "throw" = behavior.result ?? "ok";

  const db: LeaseRenewalDb = {
    async renewSnapshotRequestLease(input) {
      calls.push(input);
      if (mode === "throw") throw new Error("rpc_exploded");
      if (mode === "refused") return null;
      return {} as unknown as SnapshotRequest;
    },
  };

  const renewer = new LeaseRenewer(CONFIG, {
    db,
    now: () => clock,
    setIntervalFn: (handler) => {
      tick = handler;
      return "handle";
    },
    clearIntervalFn: () => {
      cleared += 1;
      tick = null;
    },
  });

  return {
    renewer,
    calls,
    clearedCount: () => cleared,
    advance: (ms: number) => {
      clock += ms;
    },
    hasTimer: () => tick !== null,
    /** Invoke the real scheduled callback — never renewOnce() directly. */
    fireScheduledTick: async (): Promise<void> => {
      if (!tick) throw new Error("no scheduled callback registered");
      tick();
      // The callback is fire-and-forget; drain the microtask queue so its
      // renewal settles before assertions run.
      await new Promise((resolve) => setImmediate(resolve));
    },
    setMode: (next: "ok" | "refused" | "throw") => {
      mode = next;
    },
  };
}

async function main(): Promise<void> {
  /* ── Configuration validation ─────────────────────────────────────── */

  console.log("\nConfiguration validation");

  check(
    "1. a valid plan is accepted",
    validateLeaseRenewalConfig(CONFIG) === null
  );
  check(
    "2. leaseSeconds below the database minimum is rejected",
    validateLeaseRenewalConfig({
      ...CONFIG,
      leaseSeconds: MIN_LEASE_SECONDS - 1,
    }) !== null
  );
  check(
    "3. leaseSeconds above the database maximum is rejected",
    validateLeaseRenewalConfig({
      ...CONFIG,
      leaseSeconds: MAX_LEASE_SECONDS + 1,
    }) !== null
  );
  check(
    "4. a cadence with no margin before expiry is rejected",
    validateLeaseRenewalConfig({
      ...CONFIG,
      leaseSeconds: 60,
      renewEveryMs: 59_000,
    }) !== null
  );
  check(
    "5. a cadence renewing at least twice per lease is accepted",
    validateLeaseRenewalConfig({
      ...CONFIG,
      leaseSeconds: 60,
      renewEveryMs: 30_000,
    }) === null
  );
  check(
    "6. a missing execution ceiling is rejected",
    validateLeaseRenewalConfig({ ...CONFIG, maxExecutionMs: 0 }) !== null
  );
  check(
    "7. an empty claim token is rejected",
    validateLeaseRenewalConfig({ ...CONFIG, claimToken: "  " }) !== null
  );
  check(
    "8. the constructor refuses an invalid plan outright",
    (() => {
      try {
        new LeaseRenewer(
          { ...CONFIG, leaseSeconds: 1 },
          { db: { async renewSnapshotRequestLease() { return null; } } }
        );
        return false;
      } catch {
        return true;
      }
    })()
  );

  /* ── Renewal success ──────────────────────────────────────────────── */

  console.log("\nRenewal");

  const ok = makeHarness();
  const okStart = await ok.renewer.start();

  check(
    "9. startup renewal sends the exact request, token, and lease length",
    JSON.stringify(ok.calls[0]) ===
      JSON.stringify({
        requestId: REQUEST_ID,
        claimToken: CLAIM_TOKEN,
        leaseSeconds: CONFIG.leaseSeconds,
      }),
    JSON.stringify(ok.calls[0])
  );
  check(
    "10. startup performs exactly one real renewal before anything else",
    ok.calls.length === 1 && ok.renewer.renewalCount === 1,
    `calls=${ok.calls.length}`
  );
  check(
    "10a. startup reports retained ownership and arms the timer",
    okStart.owned && ok.renewer.ownership().owned && ok.hasTimer()
  );
  check(
    "11. assertOwned does not throw while owned",
    (() => {
      try {
        ok.renewer.assertOwned();
        return true;
      } catch {
        return false;
      }
    })()
  );

  await ok.renewer.renewOnce();
  await ok.renewer.renewOnce();
  check(
    "12. repeated renewal keeps working and is counted",
    ok.calls.length === 3 && ok.renewer.renewalCount === 3,
    `calls=${ok.calls.length} counted=${ok.renewer.renewalCount}`
  );

  /* ── Startup proves ownership before any provider work ────────────── */

  console.log("\nStartup fails closed");

  const startRefused = makeHarness({ result: "refused" });
  const refusedStart = await startRefused.renewer.start();

  check(
    "12a. a refused initial renewal fails startup",
    !refusedStart.owned && refusedStart.reason === "refused"
  );
  check(
    "12b. no periodic schedule is left running after failed startup",
    !startRefused.hasTimer()
  );
  check(
    "12c. failed startup marks ownership permanently lost",
    (() => {
      try {
        startRefused.renewer.assertOwned();
        return false;
      } catch (error) {
        return error instanceof LeaseOwnershipLostError;
      }
    })()
  );
  startRefused.setMode("ok");
  await startRefused.renewer.start();
  check(
    "12d. startup cannot be retried after ownership loss",
    startRefused.calls.length === 1 && !startRefused.hasTimer(),
    `calls=${startRefused.calls.length}`
  );

  const startThrew = makeHarness({ result: "throw" });
  const threwStart = await startThrew.renewer.start();

  check(
    "12e. a throwing initial renewal fails startup",
    !threwStart.owned && threwStart.reason === "error"
  );
  check(
    "12f. no schedule is armed and no claim token leaks in the error",
    !startThrew.hasTimer() &&
      !threwStart.owned &&
      !threwStart.detail.includes(CLAIM_TOKEN)
  );

  /* ── The scheduled callback itself ────────────────────────────────── */

  console.log("\nScheduled periodic callback");

  const sched = makeHarness();
  await sched.renewer.start();
  const afterStart = sched.calls.length;

  await sched.fireScheduledTick();
  check(
    "12g. the scheduled callback performs a real renewal",
    sched.calls.length === afterStart + 1,
    `calls=${sched.calls.length}`
  );

  await sched.fireScheduledTick();
  await sched.fireScheduledTick();
  check(
    "12h. repeated callback invocation renews repeatedly",
    sched.calls.length === afterStart + 3 &&
      sched.renewer.renewalCount === afterStart + 3,
    `calls=${sched.calls.length}`
  );
  check(
    "12i. every callback renewal carries the same fenced parameters",
    sched.calls.every(
      (call) =>
        call.requestId === REQUEST_ID &&
        call.claimToken === CLAIM_TOKEN &&
        call.leaseSeconds === CONFIG.leaseSeconds
    )
  );

  sched.setMode("refused");
  await sched.fireScheduledTick();
  check(
    "12j. a refusal reached through the callback loses ownership",
    !sched.renewer.ownership().owned &&
      sched.renewer.ownership().owned === false
  );
  check(
    "12k. the callback stops doing useful work after ownership loss",
    !sched.hasTimer() && sched.clearedCount() === 1
  );

  const schedThrow = makeHarness();
  await schedThrow.renewer.start();
  schedThrow.setMode("throw");
  await schedThrow.fireScheduledTick();
  check(
    "12l. an error reached through the callback loses ownership",
    !schedThrow.renewer.ownership().owned && !schedThrow.hasTimer()
  );

  /* ── Refusal is terminal ──────────────────────────────────────────── */

  console.log("\nRefusal and error are terminal");

  const refused = makeHarness();
  await refused.renewer.start();
  refused.setMode("refused");
  const refusedState = await refused.renewer.renewOnce();

  check(
    "13. a refused renewal loses ownership with reason 'refused'",
    !refusedState.owned && refusedState.reason === "refused"
  );
  check(
    "14. assertOwned then throws LeaseOwnershipLostError",
    (() => {
      try {
        refused.renewer.assertOwned();
        return false;
      } catch (error) {
        return error instanceof LeaseOwnershipLostError;
      }
    })()
  );
  check(
    "15. the renewal timer is cleared on ownership loss",
    refused.clearedCount() === 1 && !refused.hasTimer()
  );

  await refused.renewer.renewOnce();
  check(
    "16. it never renews again after losing ownership",
    refused.calls.length === 2,
    `calls=${refused.calls.length}`
  );

  const errored = makeHarness();
  await errored.renewer.start();
  errored.setMode("throw");
  const erroredState = await errored.renewer.renewOnce();

  check(
    "17. a thrown renewal loses ownership with reason 'error'",
    !erroredState.owned && erroredState.reason === "error"
  );
  check(
    "18. the underlying error detail is preserved",
    !erroredState.owned && /rpc_exploded/.test(erroredState.detail)
  );
  await errored.renewer.renewOnce();
  check(
    "19. a thrown renewal also stops all further renewal",
    errored.calls.length === 2,
    `calls=${errored.calls.length}`
  );

  /* ── Execution ceiling ────────────────────────────────────────────── */

  console.log("\nExecution ceiling");

  const bounded = makeHarness();
  await bounded.renewer.start();
  bounded.advance(CONFIG.maxExecutionMs - 1);
  await bounded.renewer.renewOnce();

  check(
    "20. renewal still works just before the ceiling",
    bounded.renewer.ownership().owned && bounded.calls.length === 2,
    `calls=${bounded.calls.length}`
  );

  bounded.advance(2);
  const expiredState = await bounded.renewer.renewOnce();

  check(
    "21. crossing the ceiling loses ownership with reason 'deadline'",
    !expiredState.owned && expiredState.reason === "deadline",
    JSON.stringify(expiredState)
  );
  check(
    "22. no renewal RPC is sent after the ceiling",
    bounded.calls.length === 2,
    `calls=${bounded.calls.length}`
  );
  check(
    "23. a hung scan therefore stops renewing and becomes reclaimable",
    !bounded.hasTimer() && bounded.clearedCount() === 1
  );
  check(
    "24. assertOwned throws with the deadline reason",
    (() => {
      try {
        bounded.renewer.assertOwned();
        return false;
      } catch (error) {
        return (
          error instanceof LeaseOwnershipLostError &&
          error.reason === "deadline"
        );
      }
    })()
  );

  const late = makeHarness();
  await late.renewer.start();
  const afterLateStart = late.calls.length;
  late.advance(CONFIG.maxExecutionMs + 1);
  check(
    "25. the ceiling is enforced by assertOwned without a further renewal",
    (() => {
      try {
        late.renewer.assertOwned();
        return false;
      } catch {
        return late.calls.length === afterLateStart;
      }
    })()
  );

  /* ── Environment contract ─────────────────────────────────────────── */

  console.log("\nEnvironment contract");

  check(
    "26. no claim token means a manual run with no lease",
    readLeaseRenewalConfigFromEnv({}) === null
  );

  const fullEnv = {
    [LEASE_ENV_KEYS.claimToken]: CLAIM_TOKEN,
    [LEASE_ENV_KEYS.requestId]: REQUEST_ID,
    [LEASE_ENV_KEYS.leaseSeconds]: "300",
    [LEASE_ENV_KEYS.renewEveryMs]: "60000",
    [LEASE_ENV_KEYS.maxExecutionMs]: "600000",
  };

  check(
    "27. a complete worker environment parses into the plan",
    JSON.stringify(readLeaseRenewalConfigFromEnv(fullEnv)) ===
      JSON.stringify(CONFIG),
    JSON.stringify(readLeaseRenewalConfigFromEnv(fullEnv))
  );

  check(
    "28. a claimed run with an incomplete plan is a hard error",
    (() => {
      try {
        readLeaseRenewalConfigFromEnv({
          [LEASE_ENV_KEYS.claimToken]: CLAIM_TOKEN,
          [LEASE_ENV_KEYS.requestId]: REQUEST_ID,
        });
        return false;
      } catch {
        return true;
      }
    })()
  );

  check(
    "29. a claimed run with a nonsense lease value is a hard error",
    (() => {
      try {
        readLeaseRenewalConfigFromEnv({
          ...fullEnv,
          [LEASE_ENV_KEYS.leaseSeconds]: "not-a-number",
        });
        return false;
      } catch {
        return true;
      }
    })()
  );

  /* ── Renderer lease-window mathematics ────────────────────────────── */

  console.log("\nRenderer timeout stays inside the renewed lease");

  const everyValidLease = Array.from(
    { length: MAX_LEASE_SECONDS - MIN_LEASE_SECONDS + 1 },
    (_, i) => MIN_LEASE_SECONDS + i
  );

  check(
    "26a. the renderer timeout is positive for every valid lease",
    everyValidLease.every((seconds) => rendererTimeoutMsFor(seconds) > 0)
  );
  check(
    "26b. renderer timeout + completion margin never exceeds the lease window",
    everyValidLease.every(
      (seconds) =>
        rendererTimeoutMsFor(seconds) + COMPLETION_SAFETY_MARGIN_MS <=
        seconds * 1000
    )
  );
  check(
    "26c. the renderer timeout is strictly inside the lease window",
    everyValidLease.every(
      (seconds) => rendererTimeoutMsFor(seconds) < seconds * 1000
    )
  );
  check(
    "26d. the margin cannot collapse to zero at the minimum lease",
    rendererTimeoutMsFor(MIN_LEASE_SECONDS) === 30_000 &&
      COMPLETION_SAFETY_MARGIN_MS === 30_000,
    `renderer=${rendererTimeoutMsFor(MIN_LEASE_SECONDS)}`
  );
  check(
    "26e. long leases are capped by the renderer ceiling, not the lease",
    rendererTimeoutMsFor(MAX_LEASE_SECONDS) === MAX_RENDERER_TIMEOUT_MS
  );
  check(
    "26f. a longer lease never shortens the renderer window",
    everyValidLease
      .slice(1)
      .every(
        (seconds, i) =>
          rendererTimeoutMsFor(seconds) >=
          rendererTimeoutMsFor(everyValidLease[i])
      )
  );

  /* ── Scope and safety (static) ────────────────────────────────────── */

  console.log("\nScope and safety");

  const read = (rel: string): string =>
    readFileSync(join(process.cwd(), rel), "utf-8");

  const executable = (source: string): string =>
    source
      .split("\n")
      .filter((line) => {
        const trimmed = line.trimStart();
        return (
          !trimmed.startsWith("*") &&
          !trimmed.startsWith("//") &&
          !trimmed.startsWith("/*")
        );
      })
      .join("\n");

  const helper = read("lib/snapshot-worker/lease-renewal.ts");
  const scan = read("scripts/mvp-scan.ts");
  const engine = read("lib/snapshot-engine/run-approved-snapshot.ts");

  check(
    "30. the helper never claims a request",
    !/claimNextSnapshotRequest/.test(executable(helper))
  );
  check(
    "31. no polling, sleep, or backoff entered the helper",
    !/setTimeout|while \(true\)|for \(;;\)|sleep\(/.test(
      executable(helper)
    )
  );
  check(
    "32. no signal handling entered the helper",
    !/SIGTERM|SIGINT|process\.on\(/.test(executable(helper))
  );
  check(
    "33. the helper never exits the process",
    !/process\.exit|process\.exitCode/.test(executable(helper))
  );
  check(
    "34. the claim token is never logged by the helper or the scan",
    !/console\.[a-z]+\([^)]*claimToken/i.test(executable(helper)) &&
      !/console\.[a-z]+\([^)]*CLAIM_TOKEN/i.test(executable(scan))
  );
  check(
    "35. mvp-scan checks ownership immediately before each paid probe",
    /assertLeaseOwnership\(\);\s*const live = await runPerplexityProbe/.test(
      executable(scan).replace(/\n\s*/g, " ").replace(/\s+/g, " ")
    ),
    "per-probe guard not found"
  );
  check(
    "36. mvp-scan starts renewal from the parsed environment plan",
    /readLeaseRenewalConfigFromEnv\(process\.env\)/.test(
      executable(scan)
    ) && /leaseRenewer\.start\(\)/.test(executable(scan))
  );
  check(
    "37. mvp-scan tops the lease up before handing back to the parent",
    /leaseRenewer\.renewOnce\(\)/.test(executable(scan))
  );
  check(
    "38. the engine bounds the worker child with a spawn timeout",
    /timeout: execution\.lease\.maxExecutionMs/.test(executable(engine))
  );
  check(
    "39. the engine passes the lease plan only in worker mode",
    /LEASE_ENV_KEYS\.leaseSeconds/.test(executable(engine)) &&
      /execution\.mode === "worker"/.test(executable(engine))
  );
  check(
    "40. no runnable worker entrypoint or poller was added",
    !/snapshot-worker\.ts/.test(read("package.json")) &&
      !/claimNextSnapshotRequest/.test(executable(scan))
  );

  console.log("\n─────────────────────────────────────────────────────────");
  console.log("Renewal lives in the child because the parent blocks in");
  console.log("spawnSync. Ownership loss is terminal and bounded: a hung");
  console.log("scan stops renewing and the request becomes reclaimable.");
  console.log("No poller, no claim, and no runnable worker are added here.");
  console.log("─────────────────────────────────────────────────────────");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
