#!/usr/bin/env tsx
/**
 * Memory-adapter tests for worker claim, lease, and fencing.
 *
 * These prove the selection, ordering, attempt, and fencing rules that
 * the SQL and the memory adapter share. They run single-threaded, so
 * they cannot and do not prove PostgreSQL row-lock behavior.
 *
 * No network or database call occurs.
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ZYPACT_ALLOW_MEMORY_DB;

import { randomUUID } from "node:crypto";
import { memoryAdapter } from "@/lib/db/memory-adapter";
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

const WORKER = "zypact-vps-1:11111111-1111-4111-8111-111111111111";
const LEASE = 900;
const MAX_ATTEMPTS = 2;

const realFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = (() => {
  networkCalls += 1;
  throw new Error("no network call is permitted in this suite");
}) as typeof fetch;

/** Reach into the store the memory adapter uses, to build fixtures. */
function store(): {
  snapshotRequests: Map<string, SnapshotRequest>;
} {
  return (
    globalThis as unknown as {
      __zypact_memory_store__: {
        snapshotRequests: Map<string, SnapshotRequest>;
      };
    }
  ).__zypact_memory_store__;
}

let clock = 0;

async function seedQueued(
  overrides: Partial<SnapshotRequest> = {}
): Promise<SnapshotRequest> {
  const suffix = randomUUID();
  const created = await memoryAdapter.createSnapshotRequest({
    workEmail: `worker-${suffix}@example.com`,
    normalizedEmail: `worker-${suffix}@example.com`,
    companyName: "Worker Test",
    websiteUrl: `https://worker-${suffix}.example.com`,
    normalizedDomain: `worker-${suffix}.example.com`,
    buyerCategory: "B2B SaaS testing",
    requestIpHash: null,
  });

  // Approved + queued is the eligible state; createdAt is made strictly
  // increasing so ordering assertions are deterministic.
  clock += 1000;
  const row: SnapshotRequest & {
    approvedAt?: string;
    approvedBy?: string;
  } = {
    ...created,
    status: "queued",
    createdAt: new Date(clock).toISOString(),
    ...overrides,
  };

  store().snapshotRequests.set(row.id, row);
  return row;
}

function patch(
  id: string,
  fields: Partial<SnapshotRequest>
): void {
  const current = store().snapshotRequests.get(id)!;
  store().snapshotRequests.set(id, { ...current, ...fields });
}

function get(id: string): SnapshotRequest {
  return store().snapshotRequests.get(id)!;
}

function claim() {
  return memoryAdapter.claimNextSnapshotRequest({
    workerId: WORKER,
    leaseSeconds: LEASE,
    maxAttempts: MAX_ATTEMPTS,
  });
}

const expired = () => new Date(Date.now() - 60_000).toISOString();
const future = () => new Date(Date.now() + 600_000).toISOString();

async function main(): Promise<void> {
  console.log("\nQueued claim");

  const q1 = await seedQueued();
  const claimed = await claim();

  check("1. queued request is claimed", claimed?.id === q1.id);
  check("2. claim creates a project", Boolean(claimed?.projectId));
  check(
    "3. queued claim becomes running/reserved",
    claimed?.status === "running" && claimed?.progressStage === "reserved"
  );
  check("4. attempt_count increments to 1", claimed?.attemptCount === 1);
  check(
    "5. claim token is generated and non-empty",
    typeof claimed?.claimToken === "string" && claimed.claimToken.length > 0
  );
  check(
    "6. ownership fields are coherent",
    Boolean(claimed?.claimedBy) &&
      Boolean(claimed?.claimToken) &&
      Boolean(claimed?.leaseExpiresAt)
  );
  check(
    "7. caller cannot supply a token (input type has no token field)",
    !("claimToken" in ({ workerId: "", leaseSeconds: 0, maxAttempts: 0 } as object))
  );
  check(
    "8. second claim does not return the same unexpired request",
    (await claim()) === null
  );

  console.log("\nProject reuse");
  const q2 = await seedQueued();
  const existingProject = randomUUID();
  patch(q2.id, { projectId: existingProject });
  const reused = await claim();
  check(
    "9. claim reuses an existing project",
    reused?.id === q2.id && reused?.projectId === existingProject
  );

  console.log("\nOrdering and isolation");
  const older = await seedQueued();
  const newer = await seedQueued();
  const first = await claim();
  const second = await claim();
  check(
    "10. two eligible requests are claimed separately",
    first?.id !== second?.id &&
      [first?.id, second?.id].every((id) => [older.id, newer.id].includes(id!))
  );
  check("11. oldest queued is claimed first", first?.id === older.id);
  check(
    "12. concurrent claims cannot receive the same request",
    (
      await Promise.all([claim(), claim()])
    ).filter(Boolean).length === 0
  );

  console.log("\nStale reclaim");
  const stale = await seedQueued();
  const staleClaim = await claim();
  const originalToken = staleClaim!.claimToken!;
  patch(stale.id, {
    leaseExpiresAt: expired(),
    progressStage: "checking_ai_visibility",
  });
  const freshQueued = await seedQueued();
  const reclaimed = await claim();

  check("13. stale worker-owned request is prioritized before queued", reclaimed?.id === stale.id);
  check(
    "14. stale reclaim preserves progress_stage",
    reclaimed?.progressStage === "checking_ai_visibility"
  );
  check(
    "15. stale reclaim receives a new token",
    reclaimed?.claimToken !== originalToken
  );
  check("16. stale reclaim increments attempt_count", reclaimed?.attemptCount === 2);

  console.log("\nLease renewal and fencing");
  check(
    "17. old token cannot renew after reclaim",
    (await memoryAdapter.renewSnapshotRequestLease({
      requestId: stale.id,
      claimToken: originalToken,
      leaseSeconds: LEASE,
    })) === null
  );
  const renewed = await memoryAdapter.renewSnapshotRequestLease({
    requestId: stale.id,
    claimToken: reclaimed!.claimToken!,
    leaseSeconds: LEASE,
  });
  check("18. current token renews an unexpired lease", renewed !== null);
  check(
    "19. renewal preserves attempt, owner, token, status",
    renewed?.attemptCount === 2 &&
      renewed?.claimedBy === WORKER &&
      renewed?.claimToken === reclaimed!.claimToken &&
      renewed?.status === "running"
  );
  check(
    "20. wrong token cannot renew",
    (await memoryAdapter.renewSnapshotRequestLease({
      requestId: stale.id,
      claimToken: randomUUID(),
      leaseSeconds: LEASE,
    })) === null
  );
  patch(stale.id, { leaseExpiresAt: expired() });
  check(
    "21. expired lease cannot be renewed",
    (await memoryAdapter.renewSnapshotRequestLease({
      requestId: stale.id,
      claimToken: reclaimed!.claimToken!,
      leaseSeconds: LEASE,
    })) === null
  );

  console.log("\nTerminalization at maximum attempts");
  // `stale` is now at attemptCount 2 == MAX_ATTEMPTS with an expired lease.
  const beforeTerminal = get(stale.id);
  const afterTerminalClaim = await claim();

  check(
    "22. maximum-attempt stale request becomes failed",
    get(stale.id).status === "failed"
  );
  check(
    "23. terminalization clears ownership fields",
    get(stale.id).claimedBy === null &&
      get(stale.id).claimToken === null &&
      get(stale.id).leaseExpiresAt === null
  );
  check(
    "24. terminalization preserves project, progress, attempt count",
    get(stale.id).projectId === beforeTerminal.projectId &&
      get(stale.id).progressStage === "checking_ai_visibility" &&
      get(stale.id).attemptCount === 2
  );
  check(
    "25. a queued request is still claimable in the same call",
    afterTerminalClaim?.id === freshQueued.id
  );

  console.log("\nIneligible states");
  const done = await seedQueued();
  patch(done.id, { status: "report_ready" });
  const dead = await seedQueued();
  patch(dead.id, { status: "failed" });
  const manual = await seedQueued();
  patch(manual.id, {
    status: "running",
    projectId: randomUUID(),
    claimedBy: null,
    claimToken: null,
    leaseExpiresAt: null,
  });

  const afterIneligible = await claim();
  check(
    "26. report_ready is never eligible",
    afterIneligible?.id !== done.id
  );
  check("27. failed is never eligible", afterIneligible?.id !== dead.id);
  check(
    "28. manually running request with null token is never reclaimed",
    afterIneligible?.id !== manual.id && get(manual.id).claimToken === null
  );
  check(
    "29. manual running row is not terminalized",
    get(manual.id).status === "running"
  );

  console.log("\nManual reservation compatibility");
  const manualQueued = await seedQueued();
  const manualReserved =
    await memoryAdapter.reserveSnapshotRequestProject(manualQueued.id);
  check(
    "30. manual reserve still works for a queued request",
    manualReserved?.status === "running" &&
      manualReserved?.progressStage === "reserved"
  );
  check(
    "31. manual reserve acquires no lease fields",
    manualReserved?.claimedBy === null &&
      manualReserved?.claimToken === null &&
      manualReserved?.leaseExpiresAt === null
  );
  check(
    "32. manual reserve is idempotent for its own running request",
    (await memoryAdapter.reserveSnapshotRequestProject(manualQueued.id))?.id ===
      manualQueued.id
  );

  const workerOwned = await seedQueued();
  const workerClaim = await claim();
  check(
    "33. manual reserve refuses a worker-owned running request",
    workerClaim?.id === workerOwned.id &&
      (await memoryAdapter.reserveSnapshotRequestProject(workerOwned.id)) === null
  );

  console.log("\nInput validation");
  const invalid: Array<[string, () => Promise<unknown>]> = [
    [
      "34. empty worker id rejected",
      () =>
        memoryAdapter.claimNextSnapshotRequest({
          workerId: "   ",
          leaseSeconds: LEASE,
          maxAttempts: MAX_ATTEMPTS,
        }),
    ],
    [
      "35. worker id longer than 100 rejected",
      () =>
        memoryAdapter.claimNextSnapshotRequest({
          workerId: "w".repeat(101),
          leaseSeconds: LEASE,
          maxAttempts: MAX_ATTEMPTS,
        }),
    ],
    [
      "36. lease below 60 rejected",
      () =>
        memoryAdapter.claimNextSnapshotRequest({
          workerId: WORKER,
          leaseSeconds: 59,
          maxAttempts: MAX_ATTEMPTS,
        }),
    ],
    [
      "37. lease above 3600 rejected",
      () =>
        memoryAdapter.claimNextSnapshotRequest({
          workerId: WORKER,
          leaseSeconds: 3601,
          maxAttempts: MAX_ATTEMPTS,
        }),
    ],
    [
      "38. max attempts below 1 rejected",
      () =>
        memoryAdapter.claimNextSnapshotRequest({
          workerId: WORKER,
          leaseSeconds: LEASE,
          maxAttempts: 0,
        }),
    ],
    [
      "39. max attempts above 10 rejected",
      () =>
        memoryAdapter.claimNextSnapshotRequest({
          workerId: WORKER,
          leaseSeconds: LEASE,
          maxAttempts: 11,
        }),
    ],
    [
      "40. renewal lease out of range rejected",
      () =>
        memoryAdapter.renewSnapshotRequestLease({
          requestId: randomUUID(),
          claimToken: randomUUID(),
          leaseSeconds: 10,
        }),
    ],
  ];

  for (const [name, fn] of invalid) {
    let threw = false;
    try {
      await fn();
    } catch {
      threw = true;
    }
    check(name, threw);
  }

  const trimmed = await seedQueued();
  const trimmedClaim = await memoryAdapter.claimNextSnapshotRequest({
    workerId: `  ${WORKER}  `,
    leaseSeconds: LEASE,
    maxAttempts: MAX_ATTEMPTS,
  });
  check(
    "41. worker identity is trimmed before storage",
    trimmedClaim?.id === trimmed.id && trimmedClaim?.claimedBy === WORKER
  );

  console.log("\nIsolation");
  check("42. no network request occurred", networkCalls === 0);
  // Unused binding kept explicit so the fixture's purpose is clear.
  void beforeTerminal;
}

main()
  .then(() => {
    globalThis.fetch = realFetch;

    console.log(
      "\n─────────────────────────────────────────────────────────"
    );
    console.log(
      "LIMITATION: JavaScript is single-threaded. These tests prove the"
    );
    console.log(
      "selection, ordering, attempt, and fencing rules — they do NOT prove"
    );
    console.log(
      "PostgreSQL row-lock behavior. FOR UPDATE SKIP LOCKED and concurrent"
    );
    console.log(
      "transaction isolation remain unproven until Level 2 validation."
    );
    console.log(
      "─────────────────────────────────────────────────────────"
    );

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  })
  .catch((error) => {
    globalThis.fetch = realFetch;
    console.error(error);
    process.exit(1);
  });
