#!/usr/bin/env tsx

import "dotenv/config";

import {
  mkdirSync,
} from "node:fs";
import {
  dirname,
} from "node:path";
import {
  spawnSync,
} from "node:child_process";
import {
  createClient,
} from "@supabase/supabase-js";

import {
  getDb,
} from "../lib/db";

type CliArgs =
  Record<string, string | boolean>;

type ProbeMode =
  | "live"
  | "simulated";

interface ApprovedSnapshotRow {
  id: string;
  company_name: string;
  website_url: string;
  normalized_domain: string;
  buyer_category: string;
  status: string;
  project_id: string | null;
}

interface ParsedArgs {
  requestId: string;
  competitors: string[];
  probeMode: ProbeMode;
  budgetUsd: number;
  prompts: number;
  runs: number;
  out: string;
  dryRun: boolean;
  execute: boolean;
}

function fail(message: string): never {
  throw new Error(message);
}

function parseCli(
  argv: string[]
): CliArgs {
  const result: CliArgs = {};

  for (
    let index = 0;
    index < argv.length;
    index += 1
  ) {
    const current = argv[index];

    if (!current.startsWith("--")) {
      fail(
        `Unexpected argument: ${current}`
      );
    }

    const key = current.slice(2);
    const next = argv[index + 1];

    if (
      !next ||
      next.startsWith("--")
    ) {
      result[key] = true;
      continue;
    }

    result[key] = next;
    index += 1;
  }

  return result;
}

function stringArg(
  args: CliArgs,
  name: string
): string | undefined {
  const value = args[name];

  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    return undefined;
  }

  return value.trim();
}

function hasFlag(
  args: CliArgs,
  name: string
): boolean {
  return args[name] === true;
}

function positiveInteger(
  raw: string | undefined,
  fallback: number,
  label: string
): number {
  if (!raw) return fallback;

  const value =
    Number.parseInt(raw, 10);

  if (
    !Number.isInteger(value) ||
    value < 1
  ) {
    fail(
      `${label} must be a positive integer.`
    );
  }

  return value;
}

function nonNegativeMoney(
  raw: string | undefined,
  label: string
): number {
  if (!raw) {
    fail(`${label} is required.`);
  }

  const value =
    Number.parseFloat(raw);

  if (
    !Number.isFinite(value) ||
    value < 0
  ) {
    fail(
      `${label} must be a non-negative number.`
    );
  }

  return value;
}

function parseCompetitors(
  raw: string | undefined
): string[] {
  if (!raw) {
    fail("--competitors is required.");
  }

  const seen =
    new Set<string>();

  const competitors: string[] = [];

  for (const item of raw.split(",")) {
    const value = item.trim();

    if (!value) continue;

    const key =
      value.toLowerCase();

    if (seen.has(key)) continue;

    seen.add(key);
    competitors.push(value);
  }

  if (competitors.length < 2) {
    fail(
      "--competitors requires at least two real competitors."
    );
  }

  return competitors;
}

function parseArgs(
  argv: string[]
): ParsedArgs {
  const raw = parseCli(argv);

  const allowed =
    new Set([
      "request-id",
      "competitors",
      "probe-mode",
      "budget-usd",
      "prompts",
      "runs",
      "out",
      "dry-run",
      "execute",
    ]);

  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      fail(`Unknown argument --${key}.`);
    }
  }

  const requestId =
    stringArg(raw, "request-id");

  if (
    !requestId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      requestId
    )
  ) {
    fail(
      "--request-id must be a valid UUID."
    );
  }

  const dryRun =
    hasFlag(raw, "dry-run");

  const execute =
    hasFlag(raw, "execute");

  if (dryRun === execute) {
    fail(
      "Choose exactly one mode: --dry-run or --execute."
    );
  }

  const probeModeRaw =
    stringArg(raw, "probe-mode");

  if (
    probeModeRaw !== "live" &&
    probeModeRaw !== "simulated"
  ) {
    fail(
      '--probe-mode must be explicitly set to "live" or "simulated".'
    );
  }

  const out =
    stringArg(raw, "out") ??
    `./exports/snapshots/${requestId}/mvp-scan.md`;

  return {
    requestId,
    competitors:
      parseCompetitors(
        stringArg(raw, "competitors")
      ),
    probeMode: probeModeRaw,
    budgetUsd:
      nonNegativeMoney(
        stringArg(raw, "budget-usd"),
        "--budget-usd"
      ),
    prompts:
      positiveInteger(
        stringArg(raw, "prompts"),
        5,
        "--prompts"
      ),
    runs:
      positiveInteger(
        stringArg(raw, "runs"),
        3,
        "--runs"
      ),
    out,
    dryRun,
    execute,
  };
}

function getSupabaseClient() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    fail(
      "Supabase service-role configuration is required."
    );
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

async function readRequest(
  requestId: string
): Promise<ApprovedSnapshotRow> {
  const client =
    getSupabaseClient();

  const {
    data,
    error,
  } = await client
    .from("snapshot_requests")
    .select(
      [
        "id",
        "company_name",
        "website_url",
        "normalized_domain",
        "buyer_category",
        "status",
        "project_id",
      ].join(",")
    )
    .eq("id", requestId)
    .maybeSingle<ApprovedSnapshotRow>();

  if (error) throw error;

  if (!data) {
    fail(
      "Snapshot request was not found."
    );
  }

  return data;
}

function validateRequestState(
  request: ApprovedSnapshotRow
): void {
  if (request.status === "queued") {
    if (request.project_id) {
      fail(
        "Queued request unexpectedly already has a project."
      );
    }

    return;
  }

  if (
    request.status === "running" &&
    request.project_id
  ) {
    return;
  }

  fail(
    `Snapshot request cannot run from status "${request.status}".`
  );
}

function printPlan(
  args: ParsedArgs,
  request: ApprovedSnapshotRow
): void {
  console.log(
    "Zypact approved snapshot plan"
  );

  console.log(
    `requestId       : ${request.id}`
  );

  console.log(
    `company         : ${request.company_name}`
  );

  console.log(
    `domain          : ${request.normalized_domain}`
  );

  console.log(
    `category        : ${request.buyer_category}`
  );

  console.log(
    `current status  : ${request.status}`
  );

  console.log(
    `project action  : ${
      request.project_id
        ? `reuse ${request.project_id}`
        : "reserve on execute"
    }`
  );

  console.log(
    `probe mode      : ${args.probeMode}`
  );

  console.log(
    `prompts x runs  : ${args.prompts} x ${args.runs}`
  );

  console.log(
    `budget limit    : $${args.budgetUsd.toFixed(2)}`
  );

  console.log(
    `competitors     : ${args.competitors.join(", ")}`
  );

  console.log(
    `report path     : ${args.out}`
  );
}

async function executeScan(
  args: ParsedArgs,
  request: ApprovedSnapshotRow
): Promise<void> {
  const db = getDb();

  let projectId =
    request.project_id;

  if (request.status === "queued") {
    const reserved =
      await db.reserveSnapshotRequestProject(
        request.id
      );

    if (
      !reserved ||
      reserved.status !== "running" ||
      !reserved.projectId
    ) {
      fail(
        "Snapshot project reservation failed."
      );
    }

    projectId =
      reserved.projectId;
  }

  if (!projectId) {
    fail(
      "No reserved project is available."
    );
  }

  const reservedProjectId =
    projectId;

  const shortReportPath =
    args.out.replace(/\.md$/i, "") +
    "-short.md";

  mkdirSync(
    dirname(args.out),
    {
      recursive: true,
    }
  );

  const command = spawnSync(
    "npx",
    [
      "tsx",
      "scripts/mvp-scan.ts",
      "--brand",
      request.company_name,
      "--domain",
      request.website_url,
      "--category",
      request.buyer_category,
      "--competitors",
      args.competitors.join(","),
      "--project-id",
      reservedProjectId,
      "--probe-mode",
      args.probeMode,
      "--budget-usd",
      String(args.budgetUsd),
      "--prompts",
      String(args.prompts),
      "--runs",
      String(args.runs),
      "--out",
      args.out,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SNAPSHOT_REQUEST_ID:
          request.id,
      },
      stdio: "inherit",
    }
  );

  const markFailed =
    async (
      message: string
    ): Promise<never> => {
      const failedRequest =
        await db.finalizeSnapshotRequest(
          request.id,
          reservedProjectId,
          "failed"
        );

      if (
        !failedRequest ||
        failedRequest.status !== "failed"
      ) {
        throw new Error(
          `${message}\nSnapshot failure state could not be recorded.`
        );
      }

      throw new Error(message);
    };

  if (command.error) {
    await markFailed(
      command.error.message
    );
  }

  if (command.status !== 0) {
    await markFailed(
      `MVP runner exited with status ${command.status ?? "unknown"}.`
    );
  }

  const shortReportCommand =
    spawnSync(
      "npx",
      [
        "tsx",
        "scripts/render-sales-report.ts",
        args.out,
        shortReportPath,
        "--focus-competitors",
        args.competitors.join(","),
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
      `Short report renderer exited with status ${shortReportCommand.status ?? "unknown"}.`
    );
  }

  const completedRequest =
    await db.finalizeSnapshotRequest(
      request.id,
      reservedProjectId,
      "report_ready"
    );

  if (
    !completedRequest ||
    completedRequest.status !==
      "report_ready"
  ) {
    fail(
      "Snapshot completion could not be recorded."
    );
  }

  console.log(
    "Approved snapshot runner completed."
  );

  console.log(
    `projectId       : ${reservedProjectId}`
  );

  console.log(
    "request status  : report_ready"
  );

  console.log(
    `report path     : ${args.out}`
  );

  console.log(
    `short report    : ${shortReportPath}`
  );
}

async function main() {
  const args =
    parseArgs(
      process.argv.slice(2)
    );

  const request =
    await readRequest(
      args.requestId
    );

  validateRequestState(request);
  printPlan(args, request);

  if (args.dryRun) {
    console.log(
      "dry-run complete: no reservation, no crawl, no prompts, no probes."
    );

    return;
  }

  await executeScan(args, request);
}

main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message
      : String(error)
  );

  process.exitCode = 1;
});
