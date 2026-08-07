/**
 * Reusable approved-snapshot execution.
 *
 * This is the orchestration that `scripts/run-approved-snapshot.ts` used to
 * hold inline. It was extracted so a future background worker can call the
 * same code path after claiming a request, instead of the founder having to
 * run the CLI.
 *
 * Behavior is deliberately identical to the previous inline implementation:
 * the same two synchronous child processes, the same filesystem exchange,
 * the same argument order, the same status transitions, and the same failure
 * messages. Nothing here is an improvement on the old flow — improving it is
 * a separate decision.
 *
 * What this module must NOT do, because the CLI and the future worker
 * disagree about it:
 *
 *   - read `process.argv`;
 *   - print a plan or a completion summary;
 *   - set `process.exitCode` or terminate the process.
 *
 * Failures throw. The caller decides what a failure means for its process.
 */

import {
  mkdirSync,
  readFileSync,
} from "node:fs";
import {
  basename,
  dirname,
} from "node:path";
import { spawnSync } from "node:child_process";

import { getDb } from "@/lib/db";
import type {
  SnapshotProgressStage,
  SnapshotReportArtifact,
  SnapshotRequest,
  SnapshotWorkerCompletionInput,
  SnapshotWorkerFailureInput,
  SnapshotWorkerProgressInput,
} from "@/lib/db/types";

export type SnapshotProbeMode = "live" | "simulated";

/**
 * The request fields execution actually needs.
 *
 * Narrower than `SnapshotRequest` on purpose: the CLI reads a raw row with a
 * hand-written select, while a worker will hold a mapped `SnapshotRequest`.
 * Both can satisfy this shape without either having to convert to the other.
 */
export interface ApprovedSnapshotExecutionRequest {
  id: string;
  companyName: string;
  websiteUrl: string;
  buyerCategory: string;
  status: string;
  projectId: string | null;
}

/** Execution options — one per meaningful CLI flag. */
export interface ApprovedSnapshotExecutionOptions {
  competitors: string[];
  probeMode: SnapshotProbeMode;
  budgetUsd: number;
  prompts: number;
  runs: number;
  /** Full-report path. The short report is derived from it. */
  out: string;
}

/**
 * The subset of the database adapter this flow touches. Declared structurally
 * so a test can supply three functions instead of a whole adapter.
 */
/**
 * Which lifecycle a run uses.
 *
 * `manual` is the founder's CLI path and stays the default, so existing
 * callers are unaffected. `worker` is for a request already claimed through
 * `claim_next_snapshot_request`: every manual RPC refuses a row that carries
 * a claim token, so a worker must use the fenced surface instead.
 */
export type ApprovedSnapshotExecutionContext =
  | { mode: "manual" }
  | { mode: "worker"; claimToken: string };

/**
 * The fenced write surface, required only in worker mode. Declared as a
 * separate required type so worker callers cannot compile without it, even
 * though the methods are optional on the shared adapter interface.
 */
export interface ApprovedSnapshotWorkerDb {
  updateSnapshotRequestProgressWorker?(
    input: SnapshotWorkerProgressInput
  ): Promise<SnapshotRequest | null>;
  completeSnapshotReportWorker(
    input: SnapshotWorkerCompletionInput
  ): Promise<SnapshotReportArtifact | null>;
  markSnapshotRequestFailedWorker(
    input: SnapshotWorkerFailureInput
  ): Promise<SnapshotRequest | null>;
}

export interface ApprovedSnapshotDb {
  reserveSnapshotRequestProject(
    requestId: string
  ): Promise<SnapshotRequest | null>;
  saveSnapshotReportArtifact(input: {
    snapshotRequestId: string;
    projectId: string;
    fullReportMarkdown: string;
    shortReportMarkdown: string;
    fullReportFilename: string;
    shortReportFilename: string;
    generatedAt: string;
  }): Promise<SnapshotReportArtifact | null>;
  finalizeSnapshotRequest(
    requestId: string,
    projectId: string,
    status: "report_ready" | "failed"
  ): Promise<SnapshotRequest | null>;
}

/** Minimal `spawnSync` shape — only the fields this flow reads. */
export interface SpawnResult {
  error?: Error;
  status: number | null;
}

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: "inherit";
}

export type SpawnRunner = (
  command: string,
  args: string[],
  options: SpawnOptions
) => SpawnResult;

/**
 * Injectable external edges. Every one defaults to exactly what the CLI used
 * before extraction, so production behavior is unchanged when the caller
 * passes nothing.
 */
export interface ApprovedSnapshotDeps {
  db?: ApprovedSnapshotDb;
  /**
   * Fenced worker surface. Defaults to the same adapter instance as `db`,
   * which carries these methods in production.
   */
  workerDb?: ApprovedSnapshotWorkerDb;
  spawn?: SpawnRunner;
  ensureDirectory?: (directory: string) => void;
  readReportFile?: (path: string) => string;
  now?: () => Date;
}

export interface ApprovedSnapshotResult {
  projectId: string;
  fullReportPath: string;
  shortReportPath: string;
}

/**
 * Thrown for every failure in this flow.
 *
 * `requestMarkedFailed` records whether the request reached the `failed`
 * state before the error propagated. A caller that sees `false` knows the
 * database may still show the request as running.
 */
export class ApprovedSnapshotExecutionError extends Error {
  readonly requestMarkedFailed: boolean;

  constructor(message: string, requestMarkedFailed: boolean) {
    super(message);
    this.name = "ApprovedSnapshotExecutionError";
    this.requestMarkedFailed = requestMarkedFailed;
  }
}

/** The short-report path derived from the full-report path. */
export function shortReportPathFor(out: string): string {
  return out.replace(/\.md$/i, "") + "-short.md";
}

export async function runApprovedSnapshot(
  request: ApprovedSnapshotExecutionRequest,
  options: ApprovedSnapshotExecutionOptions,
  deps: ApprovedSnapshotDeps = {},
  execution: ApprovedSnapshotExecutionContext = { mode: "manual" }
): Promise<ApprovedSnapshotResult> {
  const db = deps.db ?? getDb();
  const workerDb =
    deps.workerDb ??
    (db as unknown as ApprovedSnapshotWorkerDb);

  if (
    execution.mode === "worker" &&
    execution.claimToken.trim() === ""
  ) {
    throw new ApprovedSnapshotExecutionError(
      "Worker execution requires a claim token.",
      false
    );
  }
  const spawn: SpawnRunner =
    deps.spawn ??
    ((command, args, spawnOptions) =>
      spawnSync(command, args, spawnOptions));
  const ensureDirectory =
    deps.ensureDirectory ??
    ((directory: string) => {
      mkdirSync(directory, { recursive: true });
    });
  const readReportFile =
    deps.readReportFile ??
    ((path: string) => readFileSync(path, "utf-8"));
  const now = deps.now ?? (() => new Date());

  let projectId = request.projectId;

  // A claimed request already has a project: `claim_next_snapshot_request`
  // reserves one inside the claim. Reservation is manual-only, and the
  // manual RPC refuses worker-owned rows anyway.
  if (
    execution.mode === "worker" &&
    !projectId
  ) {
    throw new ApprovedSnapshotExecutionError(
      "Worker execution requires a claimed request with a reserved project.",
      false
    );
  }

  if (
    execution.mode === "manual" &&
    request.status === "queued"
  ) {
    const reserved =
      await db.reserveSnapshotRequestProject(request.id);

    if (
      !reserved ||
      reserved.status !== "running" ||
      !reserved.projectId
    ) {
      throw new ApprovedSnapshotExecutionError(
        "Snapshot project reservation failed.",
        false
      );
    }

    projectId = reserved.projectId;
  }

  if (!projectId) {
    throw new ApprovedSnapshotExecutionError(
      "No reserved project is available.",
      false
    );
  }

  const reservedProjectId = projectId;
  const shortReportPath = shortReportPathFor(options.out);

  ensureDirectory(dirname(options.out));

  const command = spawn(
    "npx",
    [
      "tsx",
      "scripts/mvp-scan.ts",
      "--brand",
      request.companyName,
      "--domain",
      request.websiteUrl,
      "--category",
      request.buyerCategory,
      "--competitors",
      options.competitors.join(","),
      "--project-id",
      reservedProjectId,
      "--probe-mode",
      options.probeMode,
      "--budget-usd",
      String(options.budgetUsd),
      "--prompts",
      String(options.prompts),
      "--runs",
      String(options.runs),
      "--out",
      options.out,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SNAPSHOT_REQUEST_ID: request.id,
        // Present only in worker mode. `mvp-scan` uses it to write progress
        // through the fenced RPC; without it the child keeps the manual
        // progress path unchanged. Never logged or written to disk.
        ...(execution.mode === "worker"
          ? {
              SNAPSHOT_CLAIM_TOKEN: execution.claimToken,
              SNAPSHOT_PROJECT_ID: reservedProjectId,
            }
          : {}),
      },
      stdio: "inherit",
    }
  );

  // Records the failure, then throws. Mirrors the previous `markFailed`,
  // including its behavior when the failure itself cannot be recorded.
  const markFailed = async (message: string): Promise<never> => {
    // Worker mode must record failure through the fenced RPC. The manual
    // one silently refuses a row that carries a claim token, which would
    // leave the request stranded in `running` until its lease expired.
    const failedRequest =
      execution.mode === "worker"
        ? await workerDb.markSnapshotRequestFailedWorker({
            requestId: request.id,
            projectId: reservedProjectId,
            claimToken: execution.claimToken,
          })
        : await db.finalizeSnapshotRequest(
            request.id,
            reservedProjectId,
            "failed"
          );

    if (!failedRequest || failedRequest.status !== "failed") {
      throw new ApprovedSnapshotExecutionError(
        `${message}\nSnapshot failure state could not be recorded.`,
        false
      );
    }

    throw new ApprovedSnapshotExecutionError(message, true);
  };

  if (command.error) {
    await markFailed(command.error.message);
  }

  if (command.status !== 0) {
    await markFailed(
      `MVP runner exited with status ${command.status ?? "unknown"}.`
    );
  }

  const shortReportCommand = spawn(
    "npx",
    [
      "tsx",
      "scripts/render-sales-report.ts",
      options.out,
      shortReportPath,
      "--focus-competitors",
      options.competitors.join(","),
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    }
  );

  if (shortReportCommand.error) {
    await markFailed(
      `Short report renderer failed: ${shortReportCommand.error.message}`
    );
  }

  if (shortReportCommand.status !== 0) {
    await markFailed(
      `Short report renderer exited with status ${
        shortReportCommand.status ?? "unknown"
      }.`
    );
  }

  let fullReportMarkdown: string;
  let shortReportMarkdown: string;

  try {
    fullReportMarkdown = readReportFile(options.out);
    shortReportMarkdown = readReportFile(shortReportPath);
  } catch (error) {
    return markFailed(
      `Generated report files could not be read: ${
        error instanceof Error ? error.message : "unknown_error"
      }`
    );
  }

  const generatedAt = now().toISOString();

  if (execution.mode === "worker") {
    // One fenced statement persists the report AND finalizes the request.
    // Splitting it the way the manual path does would leave a window in
    // which the lease could lapse between the two writes.
    let completedArtifact: SnapshotReportArtifact | null;

    try {
      completedArtifact =
        await workerDb.completeSnapshotReportWorker({
          requestId: request.id,
          projectId: reservedProjectId,
          claimToken: execution.claimToken,
          fullReportMarkdown,
          shortReportMarkdown,
          fullReportFilename: basename(options.out),
          shortReportFilename: basename(shortReportPath),
          generatedAt,
        });
    } catch (error) {
      return markFailed(
        `Generated reports could not be persisted: ${
          error instanceof Error ? error.message : "unknown_error"
        }`
      );
    }

    // A null result is a refused fence — wrong token, expired lease, or the
    // request moved on. It is a failure, not a success with no rows.
    if (!completedArtifact) {
      return markFailed(
        "Worker completion was refused: the claim is no longer valid."
      );
    }

    return {
      projectId: reservedProjectId,
      fullReportPath: options.out,
      shortReportPath,
    };
  }

  let savedArtifact: SnapshotReportArtifact | null;

  try {
    savedArtifact = await db.saveSnapshotReportArtifact({
      snapshotRequestId: request.id,
      projectId: reservedProjectId,
      fullReportMarkdown,
      shortReportMarkdown,
      fullReportFilename: basename(options.out),
      shortReportFilename: basename(shortReportPath),
      generatedAt,
    });
  } catch (error) {
    return markFailed(
      `Generated reports could not be persisted: ${
        error instanceof Error ? error.message : "unknown_error"
      }`
    );
  }

  // Previously only a thrown error was treated as a failure. The RPC can
  // also refuse by returning no rows — a delivered artifact, for instance —
  // and execution used to continue to finalization as though the report had
  // been stored.
  if (!savedArtifact) {
    return markFailed(
      "Generated reports could not be persisted: the save was refused."
    );
  }

  const completedRequest = await db.finalizeSnapshotRequest(
    request.id,
    reservedProjectId,
    "report_ready"
  );

  if (
    !completedRequest ||
    completedRequest.status !== "report_ready"
  ) {
    throw new ApprovedSnapshotExecutionError(
      "Snapshot completion could not be recorded.",
      false
    );
  }

  return {
    projectId: reservedProjectId,
    fullReportPath: options.out,
    shortReportPath,
  };
}
