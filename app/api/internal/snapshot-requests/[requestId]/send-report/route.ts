import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import {
  requireCurrentUser,
} from "@/lib/auth/current-user";
import {
  authErrorResponse,
} from "@/lib/auth/route-helpers";
import {
  getFounderEmailAllowlist,
  isFounderEmail,
} from "@/lib/auth/founder";
import { getDb } from "@/lib/db";
import {
  parsePublicSnapshotReport,
} from "@/lib/snapshot-requests/parse-public-report";
import {
  ClientReportDeliveryError,
  sendClientSnapshotReport,
} from "@/lib/snapshot-requests/client-report-delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function unavailableResponse() {
  return NextResponse.json(
    {
      ok: false,
      error:
        "Report delivery is temporarily unavailable.",
    },
    { status: 503 }
  );
}

function invalidBodyResponse() {
  return NextResponse.json(
    {
      ok: false,
      error: "invalid_body",
    },
    { status: 400 }
  );
}

/**
 * Parse the request body.
 *
 * An absent or empty body means "first delivery". Anything malformed,
 * non-object, or carrying an unknown property is rejected rather than
 * being treated as a first send — a typo must never silently email a
 * customer.
 */
async function parseSendReportBody(
  request: Request
): Promise<{ resend: boolean } | null> {
  let raw: string;

  try {
    raw = await request.text();
  } catch {
    return null;
  }

  if (!raw.trim()) {
    return { resend: false };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return null;
  }

  const entries = Object.entries(
    parsed as Record<string, unknown>
  );

  for (const [key] of entries) {
    if (key !== "resend") return null;
  }

  const value = (
    parsed as { resend?: unknown }
  ).resend;

  if (value === undefined) {
    return { resend: false };
  }

  if (typeof value !== "boolean") {
    return null;
  }

  return { resend: value };
}

/**
 * Idempotency key for the current delivery generation.
 *
 * The initial send and each subsequent resend must differ, or the
 * provider deduplicates the resend against the original email. The
 * previous message ID is hashed rather than embedded so no provider
 * identifier travels in a request header.
 */
function buildDeliveryIdempotencyKey(input: {
  artifactId: string;
  deliveredAt: string | null;
  deliveryMessageId: string | null;
  resend: boolean;
}): string {
  const prefix =
    `snapshot-report/${input.artifactId}`;

  if (!input.resend || !input.deliveredAt) {
    return `${prefix}/initial`;
  }

  if (!input.deliveryMessageId) {
    // Delivered before message IDs were recorded. A constant key keeps
    // concurrent retries deduplicated; repeated legacy resends share one
    // key, which favours not duplicating a customer email.
    return `${prefix}/resend/legacy`;
  }

  const digest = createHash("sha256")
    .update(input.deliveryMessageId)
    .digest("hex");

  return `${prefix}/resend/${digest}`;
}

export async function POST(
  request: Request,
  context: {
    params: {
      requestId: string;
    };
  }
) {
  let user;

  try {
    user = await requireCurrentUser();
  } catch (error) {
    const response = authErrorResponse(
      error,
      {
        route:
          "snapshot-client-report-delivery",
        projectId: null,
      }
    );

    if (response) {
      return response;
    }

    throw error;
  }

  if (
    getFounderEmailAllowlist().size ===
      0 ||
    !isFounderEmail(user.email)
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: "not_found",
      },
      { status: 404 }
    );
  }

  const requestId =
    context.params.requestId;

  if (!UUID_PATTERN.test(requestId)) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_request_id",
      },
      { status: 400 }
    );
  }

  // Parsed after authorization so an unauthenticated caller can never
  // distinguish a malformed body from a concealed 404.
  const body =
    await parseSendReportBody(request);

  if (!body) {
    return invalidBodyResponse();
  }

  const apiKey =
    process.env.RESEND_API_KEY;

  const from =
    process.env.SNAPSHOT_EMAIL_FROM;

  const appBaseUrl =
    process.env.NEXT_PUBLIC_SITE_URL ||
    "https://zypact.com";

  if (!apiKey || !from) {
    return unavailableResponse();
  }

  const db = getDb();

  const [snapshotRequest, artifact] =
    await Promise.all([
      db.getSnapshotRequest(requestId),
      db.getSnapshotReportArtifact(
        requestId
      ),
    ]);

  if (!snapshotRequest || !artifact) {
    return NextResponse.json(
      {
        ok: false,
        error: "report_not_found",
      },
      { status: 404 }
    );
  }

  // Permanent founder-intent guard. This blocks an *accidental* resend
  // indefinitely; it is not the concurrency mechanism — two concurrent
  // first sends can both pass it. Concurrency is handled by the provider
  // idempotency key below.
  if (
    artifact.deliveredAt &&
    !body.resend
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: "already_delivered",
        deliveredAt:
          artifact.deliveredAt,
      },
      { status: 409 }
    );
  }

  const deliveryIdempotencyKey =
    buildDeliveryIdempotencyKey({
      artifactId: artifact.id,
      deliveredAt: artifact.deliveredAt,
      deliveryMessageId:
        artifact.deliveryMessageId,
      resend: body.resend,
    });

  const report =
    parsePublicSnapshotReport(
      artifact.shortReportMarkdown
    );

  try {
    const delivery =
      await sendClientSnapshotReport(
        {
          requestId,
          to: snapshotRequest.workEmail,
          companyName:
            snapshotRequest.companyName,
          publicToken:
            artifact.publicToken,
          visibilitySummary:
            report.visibility ||
            "See the private report",
          brandedReputation:
            report.brandedReputation ||
            "See the private report",
          firstPriorityAction:
            report.firstFixHeading ||
            "Review the first priority action in your private report.",
          deliveryIdempotencyKey,
        },
        {
          apiKey,
          from,
          replyTo:
            user.email || null,
          appBaseUrl,
        }
      );

    const deliveredAt =
      new Date().toISOString();

    const updated =
      await db.markSnapshotReportDelivered(
        requestId,
        delivery.messageId,
        deliveredAt
      );

    if (!updated) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "delivery_record_not_found",
        },
        { status: 500 }
      );
    }

    console.info(
      JSON.stringify({
        ts: deliveredAt,
        level: "info",
        event:
          "snapshot_report_delivered",
        requestId,
        deliveredBy: user.id,
        recipient:
          snapshotRequest.workEmail,
        messageId:
          delivery.messageId,
      })
    );

    return NextResponse.json(
      {
        ok: true,
        deliveredAt,
      },
      { status: 200 }
    );
  } catch (error) {
    if (
      error instanceof
      ClientReportDeliveryError
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: error.code,
        },
        {
          status:
            error.status &&
            error.status >= 400 &&
            error.status < 600
              ? error.status
              : 502,
        }
      );
    }

    throw error;
  }
}
