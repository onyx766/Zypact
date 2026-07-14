import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  extractRequestIp,
  hashRequestIp,
  parseSnapshotRequestSubmission,
  SnapshotRequestValidationError,
} from "@/lib/snapshot-requests/normalize-request";
import {
  SNAPSHOT_TURNSTILE_ACTION,
  verifyTurnstileToken,
} from "@/lib/snapshot-requests/turnstile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8_192;

function unavailableResponse() {
  return NextResponse.json(
    {
      ok: false,
      error: "Snapshot requests are temporarily unavailable.",
    },
    { status: 503 }
  );
}

export async function POST(request: Request) {
  // Closed by default until Turnstile, limits, and the public form
  // have all been tested together.
  if (process.env.SNAPSHOT_REQUESTS_ENABLED !== "true") {
    return unavailableResponse();
  }

  const ipHashSecret = process.env.SNAPSHOT_IP_HASH_SECRET;
  const turnstileSecret = process.env.TURNSTILE_SECRET_KEY;

  if (
    !ipHashSecret ||
    ipHashSecret.length < 32 ||
    !turnstileSecret
  ) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event: "snapshot_request_configuration_error",
        reason: "missing_security_configuration",
      })
    );

    return unavailableResponse();
  }

  const contentLength = Number(
    request.headers.get("content-length") || "0"
  );

  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_BODY_BYTES
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: "Request body is too large.",
      },
      { status: 413 }
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "Invalid JSON body.",
      },
      { status: 400 }
    );
  }

  try {
    const submission = parseSnapshotRequestSubmission(body);
    const requestIp = extractRequestIp(request.headers);

    const turnstile = await verifyTurnstileToken({
      token: submission.turnstileToken,
      secret: turnstileSecret,
      remoteIp: requestIp,
      expectedAction: SNAPSHOT_TURNSTILE_ACTION,
      expectedHostname:
        process.env.TURNSTILE_EXPECTED_HOSTNAME || null,
    });

    if (!turnstile.ok) {
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          event: "snapshot_request_turnstile_rejected",
          reason: turnstile.reason,
          errorCodes: turnstile.errorCodes,
        })
      );

      return NextResponse.json(
        {
          ok: false,
          error: "Complete the security check and try again.",
        },
        { status: 400 }
      );
    }

    const requestIpHash = hashRequestIp(
      requestIp,
      ipHashSecret
    );

    const saved = await getDb().createSnapshotRequest({
      ...submission.input,
      requestIpHash,
    });

    return NextResponse.json(
      {
        ok: true,
        requestId: saved.id,
        status: saved.status,
        nextStep: "verify_email",
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof SnapshotRequestValidationError) {
      return NextResponse.json(
        {
          ok: false,
          error: "Please correct the highlighted fields.",
          issues: error.issues,
        },
        { status: 400 }
      );
    }

    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event: "snapshot_request_create_failed",
        error:
          error instanceof Error
            ? error.message
            : "unknown_error",
      })
    );

    return NextResponse.json(
      {
        ok: false,
        error: "The request could not be saved.",
      },
      { status: 500 }
    );
  }
}
