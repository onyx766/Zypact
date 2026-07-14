import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import {
  readSnapshotFiInviteConfiguration,
} from "@/lib/snapshot-requests/fi-invite";
import { hashSnapshotEmailVerificationToken } from "@/lib/snapshot-requests/email-verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_024;

const submissionSchema = z
  .object({
    token: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

function jsonResponse(
  body: Record<string, unknown>,
  status: number
) {
  return NextResponse.json(body, {
    status,
    headers: {
      "cache-control": "no-store, max-age=0",
      pragma: "no-cache",
    },
  });
}

function unavailableResponse() {
  return jsonResponse(
    {
      ok: false,
      error: "Email verification is temporarily unavailable.",
    },
    503
  );
}

function invalidTokenResponse() {
  // Deliberately identical for invalid, expired, and reused tokens.
  return jsonResponse(
    {
      ok: false,
      error:
        "This verification link is invalid or has expired.",
      code: "invalid_verification_link",
    },
    400
  );
}

export async function POST(request: Request) {
  // Closed until email delivery and the verification page
  // have been tested together.
  if (
    process.env
      .SNAPSHOT_EMAIL_VERIFICATION_ENABLED !== "true"
  ) {
    return unavailableResponse();
  }

  const fiInvite =
    readSnapshotFiInviteConfiguration();

  if (fiInvite.kind === "invalid") {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event:
          "snapshot_fi_invite_configuration_error",
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
    return jsonResponse(
      {
        ok: false,
        error: "Request body is too large.",
      },
      413
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return invalidTokenResponse();
  }

  const parsed = submissionSchema.safeParse(body);

  if (!parsed.success) {
    return invalidTokenResponse();
  }

  try {
    const tokenHash =
      hashSnapshotEmailVerificationToken(
        parsed.data.token
      );

    const verified =
      await getDb().consumeSnapshotRequestVerification(
        tokenHash,
        fiInvite.kind === "enabled"
          ? fiInvite.expectedCodeHash
          : null
      );

    if (!verified) {
      return invalidTokenResponse();
    }

    const queued =
      verified.status === "queued";

    if (
      !queued &&
      verified.status !== "pending_approval"
    ) {
      throw new Error(
        "unexpected_snapshot_verification_status"
      );
    }

    return jsonResponse(
      {
        ok: true,
        status: queued
          ? "queued"
          : "pending_approval",
        nextStep: queued
          ? "awaiting_scan_runner"
          : "awaiting_founder_approval",
      },
      200
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event:
          "snapshot_email_verification_failed",
        error:
          error instanceof Error
            ? error.message
            : "unknown_error",
      })
    );

    return jsonResponse(
      {
        ok: false,
        error:
          "The email address could not be verified.",
      },
      500
    );
  }
}
