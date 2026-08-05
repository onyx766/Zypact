#!/usr/bin/env tsx

import "dotenv/config";

import { getDb } from "../lib/db";
import {
  buildMvpReport,
  loadReportInputs,
} from "../lib/export/build-mvp-report";
import {
  buildSalesReportFromMvpMarkdown,
} from "../lib/export/build-sales-report";

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: string[]): {
  requestId: string;
  focusCompetitors?: string[];
} {
  let requestId = "";
  let focusCompetitors:
    | string[]
    | undefined;

  for (
    let index = 0;
    index < argv.length;
    index += 1
  ) {
    const value = argv[index];

    if (value === "--request-id") {
      requestId =
        argv[index + 1]?.trim() || "";
      index += 1;
      continue;
    }

    if (
      value === "--focus-competitors"
    ) {
      focusCompetitors = (
        argv[index + 1] || ""
      )
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

      index += 1;
      continue;
    }

    fail(`Unknown argument: ${value}`);
  }

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      requestId
    )
  ) {
    fail(
      "--request-id must be a valid UUID."
    );
  }

  return {
    requestId,
    focusCompetitors,
  };
}

function sensitiveEnvValues(): string[] {
  return [
    "SUPABASE_SERVICE_ROLE_KEY",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_ORG_ID",
    "SUPABASE_ACCESS_TOKEN",
    "SUPABASE_DB_PASSWORD",
  ]
    .map((key) => process.env[key])
    .filter(
      (value): value is string =>
        typeof value === "string" &&
        value.length >= 8
    );
}

async function main(): Promise<void> {
  const args =
    parseArgs(process.argv.slice(2));

  const db = getDb();

  const request =
    await db.getSnapshotRequest(
      args.requestId
    );

  if (!request) {
    fail(
      "Snapshot request was not found."
    );
  }

  if (
    request.status !== "report_ready" ||
    !request.projectId
  ) {
    fail(
      `Request must be report_ready with a project. Current status: ${request.status}.`
    );
  }

  const inputs =
    await loadReportInputs(
      db,
      request.projectId
    );

  if (!inputs) {
    fail(
      "Report project inputs were not found."
    );
  }

  const provider =
    process.env.LLM_PROVIDER ?? null;

  const model =
    provider === "openai"
      ? process.env.OPENAI_MODEL ?? null
      : provider === "anthropic"
        ? process.env.ANTHROPIC_MODEL ??
          null
        : null;

  const full = buildMvpReport({
    ...inputs,
    llmProvider: provider,
    llmModel: model,
    mockMode:
      process.env.ZYPACT_MOCK_MODE ===
      "on",
    sensitiveValues:
      sensitiveEnvValues(),
  });

  const short =
    buildSalesReportFromMvpMarkdown(
      full.markdown,
      {
        focusCompetitors:
          args.focusCompetitors,
      }
    );

  // Insert-only: the request is already `report_ready`, which the normal
  // save path deliberately refuses. Returns null when an artifact exists.
  const artifact =
    await db.insertSnapshotReportArtifactBackfill({
      snapshotRequestId: request.id,
      projectId: request.projectId,
      fullReportMarkdown:
        full.markdown,
      shortReportMarkdown:
        short.markdown,
      fullReportFilename:
        full.filename,
      shortReportFilename:
        short.filename,
      generatedAt:
        new Date().toISOString(),
    });

  if (!artifact) {
    fail(
      "Backfill refused: a report artifact already exists for this request."
    );
  }

  console.log(
    JSON.stringify(
      {
        status: "ok",
        requestId: request.id,
        projectId: request.projectId,
        artifactId: artifact.id,
        fullReportFilename:
          artifact.fullReportFilename,
        shortReportFilename:
          artifact.shortReportFilename,
        fullBytes:
          artifact.fullReportMarkdown.length,
        shortBytes:
          artifact.shortReportMarkdown.length,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message
      : String(error)
  );

  process.exitCode = 1;
});
