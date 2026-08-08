import { snapshotReportArtifactRevision } from "./report-artifact-revision";
import type { SnapshotReportArtifact } from "@/lib/db/types";

/**
 * What a founder needs to approve or replace a stored report, and nothing more.
 *
 * `revision` is computed from the persisted markdown by the canonical helper,
 * so it is the same value the database recomputes inside its locked
 * transaction — that is what makes it usable as an optimistic-concurrency
 * token. `updated_at` deliberately is not used: no trigger maintains it.
 *
 * The raw `delivery_claim_token` never appears here. Claim state is reduced to
 * a boolean plus a diagnostic timestamp, so a serialisation mistake cannot leak
 * a token that would let a caller finalize or release someone else's delivery.
 */
export interface SnapshotReportPublicationState {
  artifactId: string;
  snapshotRequestId: string;
  revision: string;
  fullReportMarkdown: string;
  shortReportMarkdown: string;
  deliveredAt: string | null;
  deliveryMessageId: string | null;
  deliveryClaimActive: boolean;
  deliveryClaimedAt: string | null;
}

export function toSnapshotReportPublicationState(
  artifact: SnapshotReportArtifact
): SnapshotReportPublicationState {
  return {
    artifactId: artifact.id,
    snapshotRequestId: artifact.snapshotRequestId,
    revision: snapshotReportArtifactRevision(
      artifact.fullReportMarkdown,
      artifact.shortReportMarkdown
    ),
    fullReportMarkdown: artifact.fullReportMarkdown,
    shortReportMarkdown: artifact.shortReportMarkdown,
    deliveredAt: artifact.deliveredAt,
    deliveryMessageId: artifact.deliveryMessageId,
    deliveryClaimActive: artifact.deliveryClaimActive,
    deliveryClaimedAt: artifact.deliveryClaimedAt,
  };
}
