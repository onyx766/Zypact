#!/usr/bin/env tsx
/**
 * M2 canonical observations contract, second tranche (D-014, D-015).
 *
 * Historical backfill of dataset_id/dataset_source_type onto existing
 * probe_runs/probe_results rows.
 *
 * Usage:
 *   npx tsx scripts/backfill-probe-result-dataset-identity.ts \
 *     --project-id <id> [--project-id <id> ...] [--dry-run | --apply]
 *
 * --dry-run (default): classifies each project and reports what would
 *   happen. Writes nothing — no dataset_batches row is created, no
 *   probe_runs/probe_results row is touched.
 * --apply: performs the writes described below. NOT invoked against
 *   any staging or production environment by this tranche — this
 *   tranche only exercises --dry-run, locally, against the in-memory
 *   adapter (see scripts/test-m2-tranche2-writers.ts).
 *
 * Classification rule (D-014, never changed by this script):
 *   - exactly one snapshot_requests row for the project → "snapshot_request";
 *   - anything else (zero, or more than one) → "legacy_unresolved".
 *   "manual_scan" is NEVER assigned by this script: it requires a
 *   contemporaneous dataset_batches row created at the moment of a
 *   real manual invocation, which historical data cannot supply.
 *
 * Project targets are explicit (--project-id), never auto-discovered:
 * a backfill script's blast radius should be exactly what the operator
 * named, not "every project in the database".
 *
 * Order (mandatory, see the M2 tranche-2 audit):
 *   1. classify (this script, --dry-run);
 *   2. review;
 *   3. HockeyStack fixture captured separately, before any --apply;
 *   4. explicit staging authorization;
 *   5. --apply on staging;
 *   6. post-backfill verification (HockeyStack fixture + the two
 *      NULL-count queries below);
 *   7. NOT NULL tightening migration, only if both counts are zero.
 */

import { getDb } from "@/lib/db";
import type { DatasetBatch, DbAdapter, ProbeResult, ProbeRun } from "@/lib/db/types";
import {
  resolveLegacyUnresolvedDatasetBatch,
  resolveSnapshotRequestDatasetBatch,
} from "@/lib/evidence/resolve-dataset-batch";

export interface ProjectClassification {
  projectId: string;
  datasetSourceType: "snapshot_request" | "legacy_unresolved";
  snapshotRequestId: string | null;
  reason: string;
}

export async function classifyProjectForBackfill(
  db: DbAdapter,
  projectId: string
): Promise<ProjectClassification> {
  const requests = await db.getSnapshotRequestsByProject(projectId);
  if (requests.length === 1) {
    return {
      projectId,
      datasetSourceType: "snapshot_request",
      snapshotRequestId: requests[0]!.id,
      reason: "exactly one candidate snapshot_requests row",
    };
  }
  return {
    projectId,
    datasetSourceType: "legacy_unresolved",
    snapshotRequestId: null,
    reason:
      requests.length === 0
        ? "zero candidate snapshot_requests rows"
        : `${requests.length} candidate snapshot_requests rows — ambiguous, never guessed`,
  };
}

export async function resolveClassifiedDatasetBatch(
  db: DbAdapter,
  classification: ProjectClassification
): Promise<DatasetBatch> {
  if (classification.datasetSourceType === "snapshot_request") {
    return resolveSnapshotRequestDatasetBatch(
      db,
      classification.projectId,
      classification.snapshotRequestId!
    );
  }
  return resolveLegacyUnresolvedDatasetBatch(
    db,
    classification.projectId,
    `Historical backfill: ${classification.reason}.`
  );
}

export function nullProbeRuns(rows: ProbeRun[]): ProbeRun[] {
  return rows.filter((r) => r.datasetId == null || r.datasetSourceType == null);
}

export function nullProbeResults(rows: ProbeResult[]): ProbeResult[] {
  return rows.filter((r) => r.datasetId == null || r.datasetSourceType == null);
}

interface RunOptions {
  projectIds: string[];
  apply: boolean;
}

function parseArgs(argv: string[]): RunOptions {
  const projectIds: string[] = [];
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project-id") {
      const value = argv[i + 1];
      if (!value) throw new Error("--project-id requires a value");
      projectIds.push(value);
      i += 1;
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--dry-run") {
      apply = false;
    }
  }
  if (projectIds.length === 0) {
    throw new Error(
      "At least one --project-id is required. This script never auto-discovers projects."
    );
  }
  return { projectIds, apply };
}

async function runForProject(
  db: DbAdapter,
  projectId: string,
  apply: boolean
): Promise<void> {
  const classification = await classifyProjectForBackfill(db, projectId);
  console.log(
    `project ${projectId}: dataset_source_type=${classification.datasetSourceType} (${classification.reason})`
  );

  const [probeRuns, probeResults] = await Promise.all([
    db.getProbeRunsByProject(projectId),
    db.getProbeResultsByProject(projectId),
  ]);
  const targetRuns = nullProbeRuns(probeRuns);
  const targetResults = nullProbeResults(probeResults);

  console.log(
    `  probe_runs: ${targetRuns.length} row(s) with a null dataset field`
  );
  console.log(
    `  probe_results: ${targetResults.length} row(s) with a null dataset field`
  );

  if (!apply) {
    console.log(
      `  [dry-run] would resolve a dataset_batches row (${classification.datasetSourceType}) and backfill ${targetRuns.length} probe_runs row(s) and ${targetResults.length} probe_results row(s). Nothing written.`
    );
    return;
  }

  const batch = await resolveClassifiedDatasetBatch(db, classification);

  for (const run of targetRuns) {
    await db.updateProbeRunDatasetIdentity(run.id, {
      datasetId: batch.id,
      datasetSourceType: batch.datasetSourceType,
    });
  }

  const statusCounts: Record<string, number> = {};
  for (const result of targetResults) {
    const outcome = await db.backfillProbeResultDatasetIdentity({
      probeResultId: result.id,
      projectId,
      datasetId: batch.id,
      datasetSourceType: batch.datasetSourceType,
      runPosition: null,
      negativeClaimDetected: null,
      observationSchemaVersion: null,
    });
    statusCounts[outcome.status] = (statusCounts[outcome.status] ?? 0) + 1;
  }
  console.log(`  probe_results outcomes:`, statusCounts);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const db = getDb();

  console.log(
    options.apply
      ? "MODE: --apply (writes will be performed)"
      : "MODE: --dry-run (no writes)"
  );

  for (const projectId of options.projectIds) {
    await runForProject(db, projectId, options.apply);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack || err.message : String(err));
    process.exit(1);
  });
}
