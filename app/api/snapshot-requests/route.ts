import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  extractRequestIp,
  hashRequestIp,
  normalizeSnapshotRequestInput,
  SnapshotRequestValidationError,
} from "@/lib/snapshot-requests/normalize-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8_192;

export async function POST(request: Request) {
  // Closed by default until Turnstile and request limits are implemented.
  if (process.env.SNAPSHOT_REQUESTS_ENABLED !== "true") {
    return NextResponse.json(
      {
        ok: false,
        error: "Snapshot requests are temporarily unavailable.",
      },
      { status: 503 }
    );
  }

  const ipHashSecret = process.env.SNAPSHOT_IP_HASH_SECRET;

  if (!ipHashSecret || ipHashSecret.length < 32) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event: "snapshot_request_configuration_error",
        reason: "missing_or_short_ip_hash_secret",
      })
    );

    return NextResponse.json(
      {
        ok: false,
        error: "Snapshot requests are temporarily unavailable.",
      },
      { status: 503 }
    );
  }

  const contentLength = Number(request.headers.get("content-length") || "0");

  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
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
    const input = normalizeSnapshotRequestInput(body);
    const requestIp = extractRequestIp(request.headers);
    const requestIpHash = hashRequestIp(requestIp, ipHashSecret);

    const saved = await getDb().createSnapshotRequest({
      ...input,
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
        error: error instanceof Error ? error.message : "unknown_error",
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
