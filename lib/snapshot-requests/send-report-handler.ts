import { NextResponse } from "next/server";
import type { BegunSnapshotReportDelivery } from "@/lib/db/types";

/**
 * Deterministic provider idempotency for one report revision.
 *
 * Keyed on artifact + content revision so retrying the same revision cannot
 * become a second logical send, while a *replaced* revision is genuinely a
 * new message. The previous key mixed in deliveredAt, the prior message id
 * and a resend flag, none of which track content — a replacement could reuse
 * a key tied to the old generation and be deduplicated away by Resend.
 */
export function buildRevisionIdempotencyKey(
  artifactId: string,
  revision: string
): string {
  return `snapshot-report:${artifactId}:${revision}`;
}

/**
 * Whether a post-provider failure proves the email was NOT accepted.
 *
 * Only an explicit HTTP 4xx qualifies: the provider answered and refused, so
 * nothing was queued. Everything else defaults to ambiguous, including cases
 * that look like failures but are not proof of non-delivery:
 *
 *   5xx                        — the provider may have queued before erroring
 *   provider_timeout           — request dispatched, answer never arrived
 *   provider_connection_failed — the wrapper cannot tell pre- from post-dispatch
 *   invalid_provider_response  — fires on a 2xx: accepted, receipt unusable
 *   any unknown throw          — no basis to claim non-delivery
 *
 * Getting this backwards sends a customer a duplicate report, so the default
 * is deliberately the unhelpful one.
 */
export type ProviderFailureClassification =
  | "DEFINITIVE_REJECTION"
  | "AMBIGUOUS";

export function classifyProviderDeliveryFailure(
  error: unknown
): ProviderFailureClassification {
  if (typeof error !== "object" || error === null) return "AMBIGUOUS";
  const status = (error as { status?: unknown }).status;
  if (
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500
  ) {
    return "DEFINITIVE_REJECTION";
  }
  return "AMBIGUOUS";
}

/**
 * Fail-closed outcome for anything that goes wrong after BEGIN.
 *
 * The claim is released only where non-delivery is proven. Once BEGIN commits, the provider
 * may have accepted the email at any point past dispatch, and the wrapper
 * cannot always prove otherwise — `invalid_provider_response` fires on a 2xx.
 * Holding the claim costs availability; releasing it wrongly costs a customer
 * a duplicate email. Selective release covers only the cases where non-delivery is
 * provable.
 */
const DELIVERY_UNCERTAIN = {
  error: "delivery_uncertain",
  message:
    "Delivery status is uncertain. Do not resend automatically. Refresh and investigate.",
} as const;

const FINALIZATION_UNCONFIRMED = {
  error: "finalization_unconfirmed",
  message:
    "Delivery may have been accepted, but final confirmation failed. Do not resend automatically.",
} as const;

/** The provider was never invoked and the claim went back; retrying is safe. */
const DELIVERY_NOT_SENT = {
  error: "delivery_not_sent",
  message:
    "The report was not sent and remains unlocked. Refresh and try again.",
} as const;

/** Provider answered and refused; the claim was released, so a later retry is safe. */
const PROVIDER_REJECTED = {
  error: "provider_rejected",
  message:
    "The email provider rejected this delivery. Fix the underlying issue and try again.",
} as const;

/** A release we were entitled to make did not take. Never claim it unlocked. */
const RELEASE_FAILED = {
  error: "release_failed",
  message:
    "Delivery did not proceed, but the report could not be unlocked. Refresh and investigate before retrying.",
} as const;

const CONFLICT = {
  error: "conflict",
  message:
    "The report changed or delivery became locked. Refresh before sending.",
} as const;

/**
 * `blocked` never delivers. The admin UI already hides the control, but a gate
 * that exists only in a React component is not a gate: this route is reachable
 * by any founder-authenticated caller.
 */
const INTEGRITY_BLOCKED = {
  error: "integrity_blocked",
  message:
    "This report failed its integrity gate and cannot be delivered. Resolve the blocking reasons and re-render it.",
} as const;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

export interface SendReportDeps {
  requireCurrentUser: () => Promise<{ email: string | null } | null>;
  isFounderEmail: (email: string | null) => boolean;
  /** Recipient and local context. Runs BEFORE the claim, deliberately. */
  loadRequestContext: (requestId: string) => Promise<{
    workEmail: string;
    companyName: string;
    publicToken: string;
    /** Null for artifacts written before migration 0068 recorded a decision. */
    integrityStatus: string | null;
  } | null>;
  beginSnapshotReportDelivery: (input: {
    snapshotRequestId: string;
    expectedArtifactId: string;
    expectedRevision: string;
  }) => Promise<BegunSnapshotReportDelivery | null>;
  /** Receives the markdown the claim covers — never a re-read. */
  sendReportEmail: (input: {
    requestId: string;
    to: string;
    companyName: string;
    publicToken: string;
    shortReportMarkdown: string;
    deliveryIdempotencyKey: string;
  }) => Promise<{ messageId: string }>;
  /**
   * Called ONLY where non-delivery is proven: the provider was never invoked,
   * or it answered with an explicit 4xx.
   */
  releaseSnapshotReportDeliveryClaim: (input: {
    snapshotRequestId: string;
    artifactId: string;
    deliveryClaimToken: string;
  }) => Promise<{ artifactId: string } | null>;
  finalizeSnapshotReportDelivery: (input: {
    snapshotRequestId: string;
    artifactId: string;
    deliveryClaimToken: string;
    deliveryMessageId: string;
  }) => Promise<{ artifactId: string; deliveredAt: string } | null>;
}

/**
 * Founder-only fenced delivery.
 *
 * AUTH + LOCAL PREP → BEGIN → PROVIDER → FINALIZE.
 *
 * Everything fallible that can happen before the claim does, so the window in
 * which a held claim can be orphaned stays as small as possible. After BEGIN
 * the report content is pinned to what the claim returned: re-reading the
 * artifact here would reopen the exact race this closes, because a
 * replacement could land between the claim and the send.
 */
/**
 * The ONLY place production code hands a claim back.
 *
 * Both callers must have already proven non-delivery — either the provider was
 * never invoked, or it answered with an explicit 4xx. Returns false rather than
 * throwing so callers report a locked state instead of a false unlock.
 */
async function releaseClaimAfterProvenNonDelivery(
  deps: SendReportDeps,
  snapshotRequestId: string,
  claimed: { artifactId: string; deliveryClaimToken: string }
): Promise<boolean> {
  try {
    const released = await deps.releaseSnapshotReportDeliveryClaim({
      snapshotRequestId,
      artifactId: claimed.artifactId,
      deliveryClaimToken: claimed.deliveryClaimToken,
    });
    return released !== null && released !== undefined;
  } catch {
    return false;
  }
}

export function createSendReportHandler(deps: SendReportDeps) {
  return async function POST(
    request: Request,
    { params }: { params: Promise<{ requestId: string }> }
  ): Promise<Response> {
    const resolvedParams = await params;
    let user: { email: string | null } | null;
    try {
      user = await deps.requireCurrentUser();
    } catch {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!user || !deps.isFounderEmail(user.email)) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid_body" }, { status: 400 });
    }

    const { expectedArtifactId, expectedRevision } = (body ?? {}) as Record<
      string,
      unknown
    >;

    // A request naming only the snapshot is no longer sufficient: without the
    // reviewed artifact and revision there is nothing to fence against.
    if (!isNonEmptyString(expectedArtifactId) || !UUID.test(expectedArtifactId)) {
      return NextResponse.json(
        { error: "invalid_expected_artifact_id" },
        { status: 400 }
      );
    }
    if (!isNonEmptyString(expectedRevision)) {
      return NextResponse.json(
        { error: "invalid_expected_revision" },
        { status: 400 }
      );
    }

    const context = await deps.loadRequestContext(resolvedParams.requestId);
    if (!context) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    // Refused before the claim, so a blocked artifact never holds one.
    if (context.integrityStatus === "blocked") {
      return NextResponse.json(INTEGRITY_BLOCKED, { status: 409 });
    }

    // ---- BEGIN: the concurrency boundary -----------------------------------
    let claimed: BegunSnapshotReportDelivery | null;
    try {
      claimed = await deps.beginSnapshotReportDelivery({
        snapshotRequestId: resolvedParams.requestId,
        expectedArtifactId,
        expectedRevision,
      });
    } catch {
      // Stale revision, stale artifact, already delivered, active claim, wrong
      // status. No provider call, no retry.
      return NextResponse.json(CONFLICT, { status: 409 });
    }
    if (!claimed) {
      return NextResponse.json(CONFLICT, { status: 409 });
    }

    // ---- Past this point the claim is held unless non-delivery is proven. ----
    // Deterministic, BEGIN-dependent validation. It runs before dispatch, so
    // a failure here proves the provider was never invoked and the claim can
    // safely go back. Everything fallible that does NOT depend on BEGIN stays
    // ahead of BEGIN, where no claim is held.
    if (
      !isNonEmptyString(claimed.artifactId) ||
      !isNonEmptyString(claimed.revision) ||
      !isNonEmptyString(claimed.deliveryClaimToken) ||
      !isNonEmptyString(claimed.shortReportMarkdown)
    ) {
      const released = await releaseClaimAfterProvenNonDelivery(
        deps,
        resolvedParams.requestId,
        claimed
      );
      return NextResponse.json(released ? DELIVERY_NOT_SENT : RELEASE_FAILED, {
        status: 500,
      });
    }

    const deliveryIdempotencyKey = buildRevisionIdempotencyKey(
      claimed.artifactId,
      claimed.revision
    );

    let delivery: { messageId: string };
    try {
      delivery = await deps.sendReportEmail({
        requestId: resolvedParams.requestId,
        to: context.workEmail,
        companyName: context.companyName,
        publicToken: context.publicToken,
        // Pinned to the claim. Not re-read, not re-rendered.
        shortReportMarkdown: claimed.shortReportMarkdown,
        deliveryIdempotencyKey,
      });
    } catch (error) {
      if (classifyProviderDeliveryFailure(error) === "DEFINITIVE_REJECTION") {
        // The provider answered and refused: nothing was queued, so the claim
        // can be handed back. No finalize, no second provider call.
        const released = await releaseClaimAfterProvenNonDelivery(
          deps,
          resolvedParams.requestId,
          claimed
        );
        if (!released) {
          return NextResponse.json(RELEASE_FAILED, { status: 500 });
        }
        return NextResponse.json(PROVIDER_REJECTED, { status: 502 });
      }
      // Ambiguous: the email may have been accepted. Hold the claim.
      return NextResponse.json(DELIVERY_UNCERTAIN, { status: 500 });
    }

    if (!isNonEmptyString(delivery?.messageId)) {
      // A receipt we cannot record, from a provider that may have accepted.
      return NextResponse.json(DELIVERY_UNCERTAIN, { status: 500 });
    }

    try {
      const finalized = await deps.finalizeSnapshotReportDelivery({
        snapshotRequestId: resolvedParams.requestId,
        artifactId: claimed.artifactId,
        deliveryClaimToken: claimed.deliveryClaimToken,
        deliveryMessageId: delivery.messageId,
      });
      if (!finalized) {
        return NextResponse.json(FINALIZATION_UNCONFIRMED, { status: 500 });
      }
      return NextResponse.json(
        {
          ok: true,
          artifactId: finalized.artifactId,
          deliveredAt: finalized.deliveredAt,
        },
        { status: 200 }
      );
    } catch {
      // The email was accepted. Retrying would send it twice, and releasing
      // would invite exactly that.
      return NextResponse.json(FINALIZATION_UNCONFIRMED, { status: 500 });
    }
  };
}
