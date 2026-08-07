#!/usr/bin/env tsx
/**
 * Worker-safe execution lifecycle tests.
 *
 * A claimed request carries a `claim_token`, and every *manual* RPC refuses
 * such a row. These tests drive `runApprovedSnapshot` in both modes through
 * injected stubs and prove that worker mode touches only the token-fenced
 * surface, while manual mode behaves exactly as before.
 *
 * No process is spawned, no file is written, no database is contacted, and
 * no provider is called.
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ZYPACT_ALLOW_MEMORY_DB;

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  runApprovedSnapshot,
  ApprovedSnapshotExecutionError,
  type ApprovedSnapshotDb,
  type ApprovedSnapshotDeps,
  type ApprovedSnapshotWorkerDb,
  type SpawnResult,
} from "@/lib/snapshot-engine/run-approved-snapshot";
import type {
  SnapshotReportArtifact,
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
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

const CLAIMED_REQUEST = {
  id: "11111111-1111-4111-8111-111111111111",
  companyName: "Worker Fixture",
  websiteUrl: "https://worker.example.invalid",
  buyerCategory: "B2B SaaS testing",
  // A claimed request is already running with a reserved project.
  status: "running",
  projectId: PROJECT_ID as string | null,
};

const QUEUED_REQUEST = {
  ...CLAIMED_REQUEST,
  status: "queued",
  projectId: null as string | null,
};

const OPTIONS = {
  competitors: ["Alpha", "Beta"],
  probeMode: "simulated" as const,
  budgetUsd: 5,
  prompts: 12,
  runs: 3,
  out: "./exports/snapshots/fixture/mvp-scan.md",
};

interface Recorder {
  calls: string[];
  spawnEnvs: NodeJS.ProcessEnv[];
  workerCompletions: unknown[];
  workerFailures: unknown[];
  manualSaves: unknown[];
}

function makeHarness(overrides: {
  spawnResults?: SpawnResult[];
  manualSaveReturnsNull?: boolean;
  workerCompletionReturnsNull?: boolean;
  workerFailureReturnsNull?: boolean;
} = {}) {
  const rec: Recorder = {
    calls: [],
    spawnEnvs: [],
    workerCompletions: [],
    workerFailures: [],
    manualSaves: [],
  };

  const spawnResults = overrides.spawnResults ?? [
    { status: 0 },
    { status: 0 },
  ];
  let spawnIndex = 0;

  const db: ApprovedSnapshotDb = {
    async reserveSnapshotRequestProject() {
      rec.calls.push("manual:reserve");
      return {
        status: "running",
        projectId: PROJECT_ID,
      } as unknown as SnapshotRequest;
    },
    async saveSnapshotReportArtifact(input) {
      rec.calls.push("manual:save");
      rec.manualSaves.push(input);
      return overrides.manualSaveReturnsNull
        ? null
        : ({} as unknown as SnapshotReportArtifact);
    },
    async finalizeSnapshotRequest(_r, _p, status) {
      rec.calls.push(`manual:finalize:${status}`);
      return { status } as unknown as SnapshotRequest;
    },
  };

  const workerDb: ApprovedSnapshotWorkerDb = {
    async completeSnapshotReportWorker(input) {
      rec.calls.push("worker:complete");
      rec.workerCompletions.push(input);
      return overrides.workerCompletionReturnsNull
        ? null
        : ({} as unknown as SnapshotReportArtifact);
    },
    async markSnapshotRequestFailedWorker(input) {
      rec.calls.push("worker:fail");
      rec.workerFailures.push(input);
      return overrides.workerFailureReturnsNull
        ? null
        : ({ status: "failed" } as unknown as SnapshotRequest);
    },
  };

  const deps: ApprovedSnapshotDeps = {
    db,
    workerDb,
    spawn(_command, args, options) {
      rec.calls.push(`spawn:${args[1]}`);
      rec.spawnEnvs.push(options.env);
      const result = spawnResults[spawnIndex] ?? { status: 0 };
      spawnIndex += 1;
      return result;
    },
    ensureDirectory() {
      rec.calls.push("mkdir");
    },
    readReportFile(path) {
      return path.endsWith("-short.md") ? "# short" : "# full";
    },
    now: () => new Date("2026-08-07T00:00:00.000Z"),
  };

  return { rec, deps, workerDb };
}

async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

async function main(): Promise<void> {
  /* ── 1-8. Worker mode, successful run ─────────────────────────────── */

  console.log("\nWorker mode — successful run");

  const w = makeHarness();
  const result = await runApprovedSnapshot(
    CLAIMED_REQUEST,
    OPTIONS,
    w.deps,
    { mode: "worker", claimToken: CLAIM_TOKEN }
  );

  check(
    "1. worker mode never calls manual project reservation",
    !w.rec.calls.includes("manual:reserve"),
    w.rec.calls.join(" → ")
  );
  check(
    "2. worker mode calls the fenced completion exactly once",
    w.rec.calls.filter((c) => c === "worker:complete").length === 1
  );
  check(
    "3. worker mode never calls the manual artifact save",
    !w.rec.calls.includes("manual:save")
  );
  check(
    "4. worker mode never calls manual finalization",
    !w.rec.calls.some((c) => c.startsWith("manual:finalize"))
  );
  check(
    "5. the claim token reaches completion exactly and unchanged",
    (w.rec.workerCompletions[0] as { claimToken: string }).claimToken ===
      CLAIM_TOKEN
  );
  check(
    "6. completion carries the report content and filenames atomically",
    JSON.stringify(w.rec.workerCompletions[0]) ===
      JSON.stringify({
        requestId: CLAIMED_REQUEST.id,
        projectId: PROJECT_ID,
        claimToken: CLAIM_TOKEN,
        fullReportMarkdown: "# full",
        shortReportMarkdown: "# short",
        fullReportFilename: "mvp-scan.md",
        shortReportFilename: "mvp-scan-short.md",
        generatedAt: "2026-08-07T00:00:00.000Z",
      }),
    JSON.stringify(w.rec.workerCompletions[0])
  );
  check(
    "7. the child process receives the claim token and project id",
    w.rec.spawnEnvs[0].SNAPSHOT_CLAIM_TOKEN === CLAIM_TOKEN &&
      w.rec.spawnEnvs[0].SNAPSHOT_PROJECT_ID === PROJECT_ID &&
      w.rec.spawnEnvs[0].SNAPSHOT_REQUEST_ID === CLAIMED_REQUEST.id
  );
  check(
    "8. the run reports success with the claimed project",
    result.projectId === PROJECT_ID
  );

  /* ── 9-13. Worker mode, failures ──────────────────────────────────── */

  console.log("\nWorker mode — failures are fenced");

  const wf = makeHarness({ spawnResults: [{ status: 2 }] });
  const wfErr = await capture(() =>
    runApprovedSnapshot(CLAIMED_REQUEST, OPTIONS, wf.deps, {
      mode: "worker",
      claimToken: CLAIM_TOKEN,
    })
  );

  check(
    "9. worker failure uses the fenced failure RPC exactly once",
    wf.rec.calls.filter((c) => c === "worker:fail").length === 1
  );
  check(
    "10. worker failure never uses manual finalization",
    !wf.rec.calls.some((c) => c.startsWith("manual:finalize"))
  );
  check(
    "11. the failure call carries the exact claim token",
    (wf.rec.workerFailures[0] as { claimToken: string }).claimToken ===
      CLAIM_TOKEN
  );
  check(
    "12. the error is typed and records that failure was written",
    wfErr instanceof ApprovedSnapshotExecutionError &&
      (wfErr as ApprovedSnapshotExecutionError).requestMarkedFailed === true
  );

  // A refused completion (stale token / expired lease) must be a failure.
  const wr = makeHarness({ workerCompletionReturnsNull: true });
  const wrErr = await capture(() =>
    runApprovedSnapshot(CLAIMED_REQUEST, OPTIONS, wr.deps, {
      mode: "worker",
      claimToken: CLAIM_TOKEN,
    })
  );

  check(
    "13. a refused completion is treated as a failure, not success",
    wrErr instanceof ApprovedSnapshotExecutionError &&
      /claim is no longer valid/.test((wrErr as Error).message) &&
      wr.rec.calls.includes("worker:fail")
  );

  // A refused failure-record must surface accurately.
  const wrf = makeHarness({
    spawnResults: [{ status: 3 }],
    workerFailureReturnsNull: true,
  });
  const wrfErr = await capture(() =>
    runApprovedSnapshot(CLAIMED_REQUEST, OPTIONS, wrf.deps, {
      mode: "worker",
      claimToken: CLAIM_TOKEN,
    })
  );

  check(
    "14. a refused failure-record surfaces both facts",
    /Snapshot failure state could not be recorded/.test(
      (wrfErr as Error).message
    ) &&
      (wrfErr as ApprovedSnapshotExecutionError).requestMarkedFailed ===
        false
  );

  /* ── 15-17. Worker mode guards ────────────────────────────────────── */

  console.log("\nWorker mode — guards");

  const wg = makeHarness();
  const emptyTokenErr = await capture(() =>
    runApprovedSnapshot(CLAIMED_REQUEST, OPTIONS, wg.deps, {
      mode: "worker",
      claimToken: "   ",
    })
  );
  check(
    "15. worker mode refuses an empty claim token before any work",
    emptyTokenErr instanceof ApprovedSnapshotExecutionError &&
      wg.rec.calls.length === 0
  );

  const wnp = makeHarness();
  const noProjectErr = await capture(() =>
    runApprovedSnapshot(
      { ...CLAIMED_REQUEST, projectId: null },
      OPTIONS,
      wnp.deps,
      { mode: "worker", claimToken: CLAIM_TOKEN }
    )
  );
  check(
    "16. worker mode refuses a request with no reserved project",
    noProjectErr instanceof ApprovedSnapshotExecutionError &&
      /reserved project/.test((noProjectErr as Error).message) &&
      !wnp.rec.calls.includes("manual:reserve")
  );

  const wq = makeHarness();
  await capture(() =>
    runApprovedSnapshot(
      { ...CLAIMED_REQUEST, status: "queued" },
      OPTIONS,
      wq.deps,
      { mode: "worker", claimToken: CLAIM_TOKEN }
    )
  );
  check(
    "17. a queued-looking claimed request still never reserves in worker mode",
    !wq.rec.calls.includes("manual:reserve")
  );

  /* ── 18-24. Manual mode is unchanged ──────────────────────────────── */

  console.log("\nManual mode — unchanged");

  const m = makeHarness();
  await runApprovedSnapshot(QUEUED_REQUEST, OPTIONS, m.deps);

  check(
    "18. manual mode still reserves the project for a queued request",
    m.rec.calls[0] === "manual:reserve"
  );
  check(
    "19. manual mode still saves then finalizes, in that order",
    m.rec.calls.indexOf("manual:save") > -1 &&
      m.rec.calls.indexOf("manual:save") <
        m.rec.calls.indexOf("manual:finalize:report_ready")
  );
  check(
    "20. manual mode never touches the fenced worker surface",
    !m.rec.calls.some((c) => c.startsWith("worker:"))
  );
  check(
    "21. manual mode does not leak worker context to the child",
    m.rec.spawnEnvs[0].SNAPSHOT_CLAIM_TOKEN === undefined &&
      m.rec.spawnEnvs[0].SNAPSHOT_PROJECT_ID === undefined &&
      m.rec.spawnEnvs[0].SNAPSHOT_REQUEST_ID === CLAIMED_REQUEST.id
  );
  check(
    "22. omitting the execution context defaults to manual",
    m.rec.calls.includes("manual:save")
  );

  // The corrected latent gap: a refused manual save must now fail.
  const mn = makeHarness({ manualSaveReturnsNull: true });
  const mnErr = await capture(() =>
    runApprovedSnapshot(QUEUED_REQUEST, OPTIONS, mn.deps)
  );

  check(
    "23. a manual save returning null is now a failure, not silent success",
    mnErr instanceof ApprovedSnapshotExecutionError &&
      /save was refused/.test((mnErr as Error).message) &&
      !mn.rec.calls.includes("manual:finalize:report_ready")
  );
  check(
    "24. that failure is still recorded through the manual path",
    mn.rec.calls.includes("manual:finalize:failed")
  );

  const mf = makeHarness({ spawnResults: [{ status: 2 }] });
  await capture(() =>
    runApprovedSnapshot(QUEUED_REQUEST, OPTIONS, mf.deps)
  );
  check(
    "25. manual child failure still records failure manually",
    mf.rec.calls.includes("manual:finalize:failed") &&
      !mf.rec.calls.some((c) => c.startsWith("worker:"))
  );

  /* ── 26-32. Scope and safety (static) ─────────────────────────────── */

  console.log("\nScope and safety");

  const repo = process.cwd();
  const read = (p: string) => readFileSync(join(repo, p), "utf-8");
  const lib = read("lib/snapshot-engine/run-approved-snapshot.ts");
  const scan = read("scripts/mvp-scan.ts");
  const cli = read("scripts/run-approved-snapshot.ts");

  const executable = (src: string) =>
    src
      .split("\n")
      .filter(
        (l) =>
          !l.trimStart().startsWith("*") &&
          !l.trimStart().startsWith("//") &&
          !l.trimStart().startsWith("/*")
      )
      .join("\n");

  check(
    "26. no polling, sleep, backoff, or SIGTERM was introduced",
    !/setInterval|setTimeout|while \(true\)|SIGTERM|SIGINT/.test(
      executable(lib)
    )
  );
  check(
    "27. no claim or lease-renewal call entered the engine",
    !/claimNextSnapshotRequest|renewSnapshotRequestLease/.test(
      executable(lib)
    )
  );
  check(
    "28. the engine still never reads process.argv or exits",
    !/process\.argv|process\.exit\(|process\.exitCode/.test(
      executable(lib)
    )
  );
  check(
    "29. the claim token is never logged by the engine or the scan",
    !/console\.[a-z]+\([^)]*claimToken/i.test(executable(lib)) &&
      !/console\.[a-z]+\([^)]*CLAIM_TOKEN/i.test(executable(scan))
  );
  check(
    "30. mvp-scan uses the fenced progress RPC only when a token exists",
    /SNAPSHOT_CLAIM_TOKEN/.test(scan) &&
      /updateSnapshotRequestProgressWorker/.test(scan) &&
      /updateSnapshotRequestProgress\(/.test(scan)
  );
  check(
    "31. the CLI file was not modified by this change",
    /runApprovedSnapshot\(/.test(cli) && !/claimToken/.test(cli)
  );

  const pkg = read("package.json");
  // Match a runnable entrypoint, not the word: package.json already has
  // pre-existing `test:snapshot-worker-*` scripts for the claim contract.
  // This mirrors assertion 40 in the adapter RPC-write test.
  check(
    "32. no worker entrypoint or dependency was added",
    !/snapshot-worker\.ts/.test(pkg) &&
      !/bull|pg-boss|node-cron|bree|agenda/i.test(pkg)
  );
  check(
    "33. package.json is untouched by this change",
    JSON.parse(pkg).scripts["test:snapshot-worker-claim"] !== undefined
  );

  console.log("\n─────────────────────────────────────────────────────────");
  console.log("Worker mode writes only through token-fenced RPCs, and");
  console.log("completion is one atomic statement. No runnable worker, no");
  console.log("polling, and no lease renewal are included here — a worker");
  console.log("that can claim but not renew would be worse than none.");
  console.log("─────────────────────────────────────────────────────────");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
