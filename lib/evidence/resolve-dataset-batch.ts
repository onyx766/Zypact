import type { DatasetBatch, DbAdapter } from "@/lib/db/types";

/**
 * M2 canonical observations contract, second tranche (D-014) — shared
 * dataset_batches resolution for the writers that create probe_runs/
 * probe_results. Every new write must resolve or create its
 * dataset_batches row before creating any probe_run — never after.
 *
 * "snapshot_request" is resolved (found-or-created), never duplicated:
 * a single approved snapshot request can drive several probe attempts
 * within the same execution, and they must all share one dataset_id.
 * "manual_scan" is always created fresh, once per invocation: each
 * manual scan is its own dataset by definition (D-014), never reused
 * across separate invocations.
 */

export async function resolveSnapshotRequestDatasetBatch(
  db: DbAdapter,
  projectId: string,
  snapshotRequestId: string
): Promise<DatasetBatch> {
  const existing = await db.getDatasetBatchesByProject(projectId);
  const found = existing.find(
    (b) =>
      b.datasetSourceType === "snapshot_request" &&
      b.snapshotRequestId === snapshotRequestId
  );
  if (found) return found;

  return db.createDatasetBatch({
    projectId,
    datasetSourceType: "snapshot_request",
    snapshotRequestId,
  });
}

export async function createManualScanDatasetBatch(
  db: DbAdapter,
  projectId: string
): Promise<DatasetBatch> {
  return db.createDatasetBatch({
    projectId,
    datasetSourceType: "manual_scan",
  });
}

/**
 * M2 canonical observations contract, second tranche (D-014) — used
 * only by the historical backfill, never by a live writer. One
 * synthetic batch per project, idempotent via `backfillKey`: rerunning
 * the backfill reuses the same batch instead of creating a duplicate.
 */
export async function resolveLegacyUnresolvedDatasetBatch(
  db: DbAdapter,
  projectId: string,
  note: string
): Promise<DatasetBatch> {
  const backfillKey = `legacy-backfill:${projectId}:legacy_unresolved`;
  const existing = await db.getDatasetBatchesByProject(projectId);
  const found = existing.find((b) => b.backfillKey === backfillKey);
  if (found) return found;

  return db.createDatasetBatch({
    projectId,
    datasetSourceType: "legacy_unresolved",
    backfillKey,
    note,
  });
}

/**
 * Top-level dispatcher for a script invocation: resolves the
 * snapshot_request batch when a real snapshot request id is known
 * (the approved-worker path, propagated via the SNAPSHOT_REQUEST_ID
 * environment variable into scripts/mvp-scan.ts), otherwise creates a
 * fresh manual_scan batch. Never infers "manual_scan" from the mere
 * absence of a snapshot request id on historical data — this
 * dispatcher is for live writes only, where the invocation itself is
 * the proof.
 */
export async function resolveDatasetBatchForInvocation(
  db: DbAdapter,
  projectId: string,
  snapshotRequestId: string | null | undefined
): Promise<DatasetBatch> {
  const trimmed = snapshotRequestId?.trim();
  if (trimmed) {
    return resolveSnapshotRequestDatasetBatch(db, projectId, trimmed);
  }
  return createManualScanDatasetBatch(db, projectId);
}
