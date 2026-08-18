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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function unavailableResponse() {
  return NextResponse.json(
    {
      ok: false,
      error:
        "Snapshot rejection is temporarily unavailable.",
    },
    { status: 503 }
  );
}

export async function POST(
  _request: Request,
  context: {
    params: Promise<{
      requestId: string;
    }>;
  }
) {
  if (
    process.env.SNAPSHOT_APPROVAL_ENABLED !==
    "true"
  ) {
    return unavailableResponse();
  }

  let user;

  try {
    user = await requireCurrentUser();
  } catch (error) {
    const response = authErrorResponse(error, {
      route: "snapshot-founder-rejection",
      projectId: null,
    });

    if (response) {
      return response;
    }

    throw error;
  }

  if (
    getFounderEmailAllowlist().size === 0
  ) {
    return unavailableResponse();
  }

  if (!isFounderEmail(user.email)) {
    return NextResponse.json(
      {
        ok: false,
        error: "not_found",
      },
      { status: 404 }
    );
  }

  const { requestId } =
    await context.params;

  if (!UUID_PATTERN.test(requestId)) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid_request_id",
      },
      { status: 400 }
    );
  }

  const rejected =
    await getDb().rejectSnapshotRequest(
      requestId
    );

  if (!rejected) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "snapshot_request_not_rejectable",
      },
      { status: 409 }
    );
  }

  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event:
        "snapshot_request_rejected",
      requestId: rejected.id,
      rejectedBy: user.id,
      status: rejected.status,
    })
  );

  return NextResponse.json(
    {
      ok: true,
      status: rejected.status,
    },
    { status: 200 }
  );
}
