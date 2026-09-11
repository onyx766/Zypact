import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import {
  requireCurrentUser,
} from "@/lib/auth/current-user";
import {
  authErrorResponse,
} from "@/lib/auth/route-helpers";
import {
  parseCompetitorsInput,
} from "@/lib/snapshot-requests/competitors";
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
        "Snapshot approval is temporarily unavailable.",
    },
    { status: 503 }
  );
}

function founderEmails(): Set<string> {
  const configured =
    process.env.SNAPSHOT_FOUNDER_EMAILS || "";

  return new Set(
    configured
      .split(",")
      .map((email) =>
        email.trim().toLowerCase()
      )
      .filter(Boolean)
  );
}

async function readCompetitorsField(
  request: Request
): Promise<unknown> {
  try {
    const body = await request.json();
    return (body as { competitors?: unknown })?.competitors;
  } catch {
    return undefined;
  }
}

export async function POST(
  request: Request,
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
      route: "snapshot-founder-approval",
      projectId: null,
    });

    if (response) {
      return response;
    }

    throw error;
  }

  const allowedEmails = founderEmails();

  if (allowedEmails.size === 0) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event:
          "snapshot_approval_configuration_error",
        reason:
          "missing_founder_allowlist",
      })
    );

    return unavailableResponse();
  }

  const normalizedUserEmail =
    user.email?.trim().toLowerCase() ||
    null;

  if (
    !normalizedUserEmail ||
    !allowedEmails.has(
      normalizedUserEmail
    )
  ) {
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        event:
          "snapshot_approval_denied",
        reason:
          "not_founder",
        userId: user.id,
      })
    );

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

  // Read after authentication and the founder check, never before. The
  // identity used for self-competitor validation must come from the stored
  // row — a client-supplied company or domain could be chosen to make a
  // self-reference look valid here.
  const db = getDb();

  const snapshotRequest =
    await db.getSnapshotRequest(requestId);

  if (!snapshotRequest) {
    return NextResponse.json(
      {
        ok: false,
        error: "not_found",
      },
      { status: 404 }
    );
  }

  // Parsed at the boundary so the founder gets a precise message instead of
  // a generic 409, and with the same self-reference rule the RPC applies, so
  // local feedback cannot say "valid" for input the RPC will reject. This
  // read is for feedback only: the RPC re-normalizes, re-validates, and
  // remains authoritative for any state change between here and approval.
  const parsed = parseCompetitorsInput(
    await readCompetitorsField(request),
    snapshotRequest.companyName,
    snapshotRequest.normalizedDomain
  );

  if (!parsed.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: parsed.error,
      },
      { status: 400 }
    );
  }

  // Prompt identity: the SHA-256 of the exact buyer-question text this
  // founder is approving. Computed here, from the same locked-and-read
  // request, and never recomputed or verified by the database — matching
  // migration 0047's prompt_hash authority rule.
  const promptHash = createHash("sha256")
    .update(snapshotRequest.buyerCategory)
    .digest("hex");

  const approved =
    await db
      .approveAndLaunchSnapshotBaseline(
        requestId,
        user.id,
        parsed.competitors,
        promptHash
      );

  if (!approved) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "snapshot_request_not_approvable",
      },
      { status: 409 }
    );
  }

  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event:
        "snapshot_request_approved",
      requestId: approved.id,
      approvedBy: user.id,
      status: approved.status,
      protocolId: approved.protocolId,
    })
  );

  return NextResponse.json(
    {
      ok: true,
      status: approved.status,
      nextStep:
        "awaiting_baseline_worker",
    },
    { status: 200 }
  );
}
