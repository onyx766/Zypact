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

export async function POST(
  _request: Request,
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
