#!/usr/bin/env tsx
/**
 * Behavior-preservation tests for the extracted snapshot execution.
 *
 * The orchestration moved out of `scripts/run-approved-snapshot.ts` into
 * `lib/snapshot-engine/run-approved-snapshot.ts`. These tests drive the
 * library through injected stubs and assert the observable sequence the CLI
 * produced before the extraction: reserve, mkdir, two child processes with
 * exact arguments, two file reads, artifact save, finalize.
 *
 * Nothing real is executed. No process is spawned, no file is written, no
 * database is contacted, and no provider is called.
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
  shortReportPathFor,
  type ApprovedSnapshotDb,
  type ApprovedSnapshotDeps,
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

const REQUEST = {
  id: "11111111-1111-4111-8111-111111111111",
  companyName: "Extraction Fixture",
  websiteUrl: "https://extraction.example.invalid",
  buyerCategory: "B2B SaaS testing",
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

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

/** Records every external interaction in call order. */
interface Recorder {
  order: string[];
  spawns: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }>;
  dirs: string[];
  reads: string[];
  saves: unknown[];
  finalizes: Array<{ requestId: string; projectId: string; status: string }>;
}

function makeHarness(overrides: {
  spawnResults?: SpawnResult[];
  readThrows?: boolean;
  saveThrows?: boolean;
  finalizeStatus?: (status: string) => string;
} = {}) {
  const rec: Recorder = {
    order: [],
    spawns: [],
    dirs: [],
    reads: [],
    saves: [],
    finalizes: [],
  };

  const spawnResults = overrides.spawnResults ?? [
    { status: 0 },
    { status: 0 },
  ];
  let spawnIndex = 0;

  const db: ApprovedSnapshotDb = {
    async reserveSnapshotRequestProject(requestId) {
      rec.order.push("reserve");
      return {
        id: requestId,
        status: "running",
        projectId: PROJECT_ID,
      } as unknown as SnapshotRequest;
    },
    async saveSnapshotReportArtifact(input) {
      rec.order.push("save");
      rec.saves.push(input);
      if (overrides.saveThrows) {
        throw new Error("persist_failed");
      }
      return {} as unknown as SnapshotReportArtifact;
    },
    async finalizeSnapshotRequest(requestId, projectId, status) {
      rec.order.push(`finalize:${status}`);
      rec.finalizes.push({ requestId, projectId, status });
      const resulting = overrides.finalizeStatus
        ? overrides.finalizeStatus(status)
        : status;
      return { status: resulting } as unknown as SnapshotRequest;
    },
  };

  const deps: ApprovedSnapshotDeps = {
    db,
    spawn(command, args, options) {
      rec.order.push(`spawn:${args[1]}`);
      rec.spawns.push({ command, args, env: options.env });
      const result =
        spawnResults[spawnIndex] ?? { status: 0 };
      spawnIndex += 1;
      return result;
    },
    ensureDirectory(directory) {
      rec.order.push("mkdir");
      rec.dirs.push(directory);
    },
    readReportFile(path) {
      rec.order.push("read");
      rec.reads.push(path);
      if (overrides.readThrows) {
        throw new Error("read_failed");
      }
      return path.endsWith("-short.md")
        ? "# short body"
        : "# full body";
    },
    now: () => new Date("2026-08-07T00:00:00.000Z"),
  };

  return { rec, deps };
}

async function capture(
  fn: () => Promise<unknown>
): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

async function main(): Promise<void> {
  /* ── 1-13. Successful orchestration ───────────────────────────────── */

  console.log("\nSuccessful orchestration");

  const ok = makeHarness();
  const result = await runApprovedSnapshot(
    REQUEST,
    OPTIONS,
    ok.deps
  );

  check(
    "1. reservation happens first, before any child process",
    ok.rec.order[0] === "reserve" &&
      ok.rec.order.indexOf("reserve") <
        ok.rec.order.findIndex((s) => s.startsWith("spawn:")),
    ok.rec.order.join(" → ")
  );
  check(
    "2. the output directory is created before spawning",
    ok.rec.order.indexOf("mkdir") <
      ok.rec.order.findIndex((s) => s.startsWith("spawn:")) &&
      ok.rec.dirs.length === 1
  );
  check(
    "3. the directory created is the full report's parent",
    ok.rec.dirs[0] === "./exports/snapshots/fixture",
    ok.rec.dirs[0]
  );
  check(
    "4. exactly two child processes run",
    ok.rec.spawns.length === 2,
    String(ok.rec.spawns.length)
  );
  check(
    "5. the first child is scripts/mvp-scan.ts via npx tsx",
    ok.rec.spawns[0].command === "npx" &&
      ok.rec.spawns[0].args[0] === "tsx" &&
      ok.rec.spawns[0].args[1] === "scripts/mvp-scan.ts"
  );
  check(
    "6. mvp-scan receives the exact expected argument vector",
    JSON.stringify(ok.rec.spawns[0].args) ===
      JSON.stringify([
        "tsx",
        "scripts/mvp-scan.ts",
        "--brand",
        REQUEST.companyName,
        "--domain",
        REQUEST.websiteUrl,
        "--category",
        REQUEST.buyerCategory,
        "--competitors",
        "Alpha,Beta",
        "--project-id",
        PROJECT_ID,
        "--probe-mode",
        "simulated",
        "--budget-usd",
        "5",
        "--prompts",
        "12",
        "--runs",
        "3",
        "--out",
        OPTIONS.out,
      ]),
    ok.rec.spawns[0].args.join(" ")
  );
  check(
    "7. mvp-scan receives SNAPSHOT_REQUEST_ID in its environment",
    ok.rec.spawns[0].env.SNAPSHOT_REQUEST_ID === REQUEST.id
  );
  check(
    "8. the second child is scripts/render-sales-report.ts",
    ok.rec.spawns[1].args[1] === "scripts/render-sales-report.ts" &&
      ok.rec.spawns[1].args[2] === OPTIONS.out &&
      ok.rec.spawns[1].args[3] === shortReportPathFor(OPTIONS.out) &&
      ok.rec.spawns[1].args[4] === "--focus-competitors" &&
      ok.rec.spawns[1].args[5] === "Alpha,Beta"
  );
  check(
    "9. the short report path derives from the full report path",
    shortReportPathFor("./a/b/mvp-scan.md") === "./a/b/mvp-scan-short.md" &&
      shortReportPathFor("./a/b/report.MD") === "./a/b/report-short.md"
  );
  check(
    "10. both report files are read, full then short",
    ok.rec.reads.length === 2 &&
      ok.rec.reads[0] === OPTIONS.out &&
      ok.rec.reads[1] === shortReportPathFor(OPTIONS.out)
  );
  check(
    "11. the artifact save receives exact content and filenames",
    JSON.stringify(ok.rec.saves[0]) ===
      JSON.stringify({
        snapshotRequestId: REQUEST.id,
        projectId: PROJECT_ID,
        fullReportMarkdown: "# full body",
        shortReportMarkdown: "# short body",
        fullReportFilename: "mvp-scan.md",
        shortReportFilename: "mvp-scan-short.md",
        generatedAt: "2026-08-07T00:00:00.000Z",
      }),
    JSON.stringify(ok.rec.saves[0])
  );
  check(
    "12. finalization happens after the save, with report_ready",
    ok.rec.order.indexOf("save") <
      ok.rec.order.indexOf("finalize:report_ready") &&
      ok.rec.finalizes.length === 1 &&
      ok.rec.finalizes[0].status === "report_ready" &&
      ok.rec.finalizes[0].projectId === PROJECT_ID
  );
  check(
    "13. no failure transition occurs and the result reports success",
    !ok.rec.order.includes("finalize:failed") &&
      result.projectId === PROJECT_ID &&
      result.fullReportPath === OPTIONS.out &&
      result.shortReportPath === shortReportPathFor(OPTIONS.out)
  );

  /* ── 14-18. Child-process failure ─────────────────────────────────── */

  console.log("\nChild-process failure");

  const childFail = makeHarness({
    spawnResults: [{ status: 2 }],
  });
  const childError = await capture(() =>
    runApprovedSnapshot(REQUEST, OPTIONS, childFail.deps)
  );

  check(
    "14. a non-zero child exit throws a typed execution error",
    childError instanceof ApprovedSnapshotExecutionError
  );
  check(
    "15. the message preserves the previous wording and status",
    (childError as Error).message ===
      "MVP runner exited with status 2.",
    (childError as Error).message
  );
  check(
    "16. no artifact is saved after a child failure",
    childFail.rec.saves.length === 0
  );
  check(
    "17. the request is marked failed exactly once, not report_ready",
    childFail.rec.finalizes.length === 1 &&
      childFail.rec.finalizes[0].status === "failed"
  );
  check(
    "18. the failure was recorded, so the error says so",
    (childError as ApprovedSnapshotExecutionError)
      .requestMarkedFailed === true
  );

  /* ── 19-22. Artifact-save failure ─────────────────────────────────── */

  console.log("\nArtifact-save failure");

  const saveFail = makeHarness({ saveThrows: true });
  const saveError = await capture(() =>
    runApprovedSnapshot(REQUEST, OPTIONS, saveFail.deps)
  );

  check(
    "19. a save failure throws a typed execution error",
    saveError instanceof ApprovedSnapshotExecutionError
  );
  check(
    "20. the save is attempted exactly once — no retry, no duplicate",
    saveFail.rec.saves.length === 1
  );
  check(
    "21. the request is not finalized report_ready after a save failure",
    !saveFail.rec.order.includes("finalize:report_ready") &&
      saveFail.rec.finalizes.length === 1 &&
      saveFail.rec.finalizes[0].status === "failed"
  );
  check(
    "22. the message names persistence as the cause",
    /could not be persisted/.test((saveError as Error).message)
  );

  /* ── 23-25. Read failure and unrecordable failure ─────────────────── */

  console.log("\nRead failure and unrecordable failure");

  const readFail = makeHarness({ readThrows: true });
  const readError = await capture(() =>
    runApprovedSnapshot(REQUEST, OPTIONS, readFail.deps)
  );

  check(
    "23. an unreadable report fails before any save",
    readFail.rec.saves.length === 0 &&
      /could not be read/.test((readError as Error).message)
  );

  // When the failure itself cannot be recorded, the caller must be told.
  const unrecordable = makeHarness({
    spawnResults: [{ status: 3 }],
    finalizeStatus: () => "running",
  });
  const unrecordableError = await capture(() =>
    runApprovedSnapshot(REQUEST, OPTIONS, unrecordable.deps)
  );

  check(
    "24. an unrecordable failure surfaces both facts",
    /Snapshot failure state could not be recorded/.test(
      (unrecordableError as Error).message
    ) &&
      (unrecordableError as ApprovedSnapshotExecutionError)
        .requestMarkedFailed === false
  );

  // A request already running with a project must not be re-reserved.
  const reuse = makeHarness();
  await runApprovedSnapshot(
    { ...REQUEST, status: "running", projectId: PROJECT_ID },
    OPTIONS,
    reuse.deps
  );
  check(
    "25. an already-running request reuses its project without reserving",
    !reuse.rec.order.includes("reserve") &&
      reuse.rec.finalizes[0].projectId === PROJECT_ID
  );

  /* ── 26-36. CLI parity and scope (static) ─────────────────────────── */

  console.log("\nCLI parity and scope");

  const repo = process.cwd();
  const read = (p: string) => readFileSync(join(repo, p), "utf-8");
  const cli = read("scripts/run-approved-snapshot.ts");
  const lib = read(
    "lib/snapshot-engine/run-approved-snapshot.ts"
  );

  // `parseCli` strips the leading "--" and stores the remainder as a key, so
  // acceptance is proven by the key the parser reads — not by the literal
  // "--flag" string. Several literals only ever appeared in the child-process
  // argument vector, which correctly moved to the library.
  for (const [flag, key] of [
    ["--request-id", '"request-id"'],
    ["--competitors", '"competitors"'],
    ["--probe-mode", '"probe-mode"'],
    ["--budget-usd", '"budget-usd"'],
    ["--prompts", '"prompts"'],
    ["--runs", '"runs"'],
    ["--out", '"out"'],
    ["--dry-run", '"dry-run"'],
    ["--execute", '"execute"'],
  ] as const) {
    check(
      `26. CLI still accepts ${flag}`,
      cli.includes(key),
      `parser key ${key} missing`
    );
  }

  check(
    "27. CLI defaults are unchanged",
    /exports\/snapshots\/\$\{requestId\}\/mvp-scan\.md/.test(cli)
  );
  check(
    "28. dry-run remains available in the CLI",
    /dryRun/.test(cli) && /dry-run complete/.test(cli)
  );
  check(
    "29. the CLI imports and calls the reusable function",
    /runApprovedSnapshot/.test(cli) &&
      /snapshot-engine\/run-approved-snapshot/.test(cli)
  );
  check(
    "30. child-process execution now lives in the library, not the CLI",
    /spawnSync/.test(lib) && !/spawnSync/.test(cli)
  );
  // The library's docblock states that it must not touch process.argv or
  // process.exitCode. A bare substring search flags that prose as a
  // violation, so these scan executable lines only.
  const libExecutable = lib
    .split("\n")
    .filter(
      (line) =>
        !line.trimStart().startsWith("*") &&
        !line.trimStart().startsWith("//") &&
        !line.trimStart().startsWith("/*")
    )
    .join("\n");

  check(
    "31. process-exit behavior stays in the CLI only",
    /process\.exitCode/.test(cli) &&
      !/process\.exitCode|process\.exit\(/.test(libExecutable)
  );
  check(
    "32. the library never reads process.argv",
    !/process\.argv/.test(libExecutable)
  );
  check(
    "33. no claim or lease RPC entered the library",
    // Scans executable lines only: the worker-safe docblock *names*
    // `claim_next_snapshot_request` to explain why manual RPCs refuse a
    // claimed row. Naming it in prose is not invoking it.
    !/claimNextSnapshotRequest|renewSnapshotRequestLease|claim_next|renew_snapshot/.test(
      libExecutable
    )
  );
  check(
    "34. no polling loop or SIGTERM handling was introduced",
    !/setInterval|SIGTERM|while \(true\)/.test(lib)
  );
  check(
    "35. scripts/mvp-scan.ts is still invoked as a child process by path",
    /"scripts\/mvp-scan\.ts"/.test(lib) &&
      !/from ["'].*mvp-scan/.test(lib)
  );
  check(
    "36. the library adds no new dependency",
    !/from "(?!node:|@\/)/.test(
      lib.replace(/from "@supabase\/supabase-js"/g, "")
    )
  );

  console.log("\n─────────────────────────────────────────────────────────");
  console.log("Behavior-preserving extraction only. The synchronous child");
  console.log("process and filesystem exchange are unchanged, and no worker,");
  console.log("claim/lease call, route, or migration is introduced here.");
  console.log("─────────────────────────────────────────────────────────");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
