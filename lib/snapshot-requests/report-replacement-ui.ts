import type { SnapshotReportPublicationState } from "./report-publication-state";

/**
 * Pure decision logic for the founder replacement panel.
 *
 * Kept out of the React component so it is directly executable: the previous
 * B1a review showed that security-relevant behaviour asserted only by reading
 * source can be wrong in ways nobody notices.
 *
 * None of this is a security boundary. A disabled button is a courtesy; the
 * real exclusion is the 0035 fencing the server route calls. This exists so the
 * founder is not invited into an action the database will refuse.
 */
export type ReplacementAvailability =
  | { canReplace: true }
  | { canReplace: false; reason: "delivered" | "claimed"; message: string };

export function replacementAvailability(
  state: Pick<
    SnapshotReportPublicationState,
    "deliveredAt" | "deliveryClaimActive" | "deliveryClaimedAt"
  >
): ReplacementAvailability {
  // Delivered first: a delivered report is final regardless of claim state.
  if (state.deliveredAt !== null) {
    return {
      canReplace: false,
      reason: "delivered",
      message: "This report has been delivered and can no longer be replaced.",
    };
  }
  if (state.deliveryClaimActive) {
    return {
      canReplace: false,
      reason: "claimed",
      message:
        "Delivery is locked pending confirmation. Replacement is unavailable until it resolves.",
    };
  }
  return { canReplace: true };
}

export interface ReplacePayload {
  expectedArtifactId: string;
  expectedRevision: string;
  fullReportMarkdown: string;
  shortReportMarkdown: string;
}

/**
 * The exact request body. Built from the artifact the founder loaded, so the
 * server fences against the revision actually reviewed — not whatever is
 * current by the time the request lands.
 */
export function buildReplacePayload(
  state: Pick<SnapshotReportPublicationState, "artifactId" | "revision">,
  edited: { fullReportMarkdown: string; shortReportMarkdown: string }
): ReplacePayload {
  return {
    expectedArtifactId: state.artifactId,
    expectedRevision: state.revision,
    fullReportMarkdown: edited.fullReportMarkdown,
    shortReportMarkdown: edited.shortReportMarkdown,
  };
}

export type ReplaceOutcome =
  | { kind: "success" }
  | { kind: "stale"; message: string }
  | { kind: "applied_reload_failed"; message: string }
  | { kind: "failed"; message: string };

/**
 * Maps the B1a response to what the founder should do next.
 *
 * The distinctions matter operationally: 409 means refresh and re-read, a
 * generic 5xx means the write probably did not land, and
 * `replacement_applied_reload_failed` means it *did* land and resubmitting
 * would replace content that was never reviewed. None of them retry.
 */
export function classifyReplaceResponse(
  status: number,
  body: { error?: unknown } | null
): ReplaceOutcome {
  if (status >= 200 && status < 300) return { kind: "success" };

  if (status === 409) {
    return {
      kind: "stale",
      message:
        "The stored report changed or became locked. Refresh before replacing it.",
    };
  }

  if (body && (body as { error?: unknown }).error === "replacement_applied_reload_failed") {
    return {
      kind: "applied_reload_failed",
      message:
        "The replacement was applied but its state could not be re-read. Refresh and check the stored report before doing anything else — do not replace again.",
    };
  }

  return {
    kind: "failed",
    message:
      "Report replacement failed. Refresh and check the stored report before trying again.",
  };
}

/** A conflict or failure never triggers another attempt. */
export function shouldRetryAutomatically(): false {
  return false;
}
