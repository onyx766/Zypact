import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { hashSnapshotEmailVerificationToken } from "@/lib/snapshot-requests/email-verification";
import {
  sendFounderSnapshotRequestNotification,
  type FounderSnapshotNotificationConfig,
} from "@/lib/snapshot-requests/founder-notification-delivery";

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

function readFounderNotificationConfiguration():
  | FounderSnapshotNotificationConfig
  | null {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.SNAPSHOT_EMAIL_FROM;
  const replyTo =
    process.env.SNAPSHOT_EMAIL_REPLY_TO || null;
  const appBaseUrl =
    process.env.SNAPSHOT_PUBLIC_BASE_URL;

  const founderEmails = (
    process.env.SNAPSHOT_FOUNDER_EMAILS || ""
  )
    .split(",")
    .map((email) =>
      email.trim().toLowerCase()
    )
    .filter(Boolean);

  if (
    !apiKey ||
    !from ||
    !appBaseUrl ||
    founderEmails.length === 0
  ) {
    return null;
  }

  return {
    apiKey,
    from,
    replyTo,
    appBaseUrl,
    founderEmails,
  };
}

async function notifyFounder(
  verified: {
    id: string;
    companyName: string;
    contactName?: string | null;
    workEmail: string;
    websiteUrl: string;
    normalizedDomain: string;
    buyerCategory: string;
  }
): Promise<void> {
  if (
    process.env
      .SNAPSHOT_FOUNDER_NOTIFICATIONS_ENABLED !==
    "true"
  ) {
    return;
  }

  const config =
    readFounderNotificationConfiguration();

  if (!config) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event:
          "snapshot_founder_notification_configuration_error",
        requestId: verified.id,
      })
    );

    return;
  }

  try {
    const delivered =
      await sendFounderSnapshotRequestNotification(
        {
          requestId: verified.id,
          companyName: verified.companyName,
          contactName: verified.contactName,
          workEmail: verified.workEmail,
          websiteUrl: verified.websiteUrl,
          normalizedDomain:
            verified.normalizedDomain,
          buyerCategory:
            verified.buyerCategory,
        },
        config
      );

    console.info(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        event:
          "snapshot_founder_notification_sent",
        requestId: verified.id,
        provider: delivered.provider,
        messageId: delivered.messageId,
      })
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event:
          "snapshot_founder_notification_failed",
        requestId: verified.id,
        error:
          error instanceof Error
            ? error.message
            : "unknown_error",
      })
    );
  }
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
        tokenHash
      );

    if (!verified) {
      return invalidTokenResponse();
    }

    await notifyFounder(verified);

    return jsonResponse(
      {
        ok: true,
        status: "pending_approval",
        nextStep: "awaiting_founder_approval",
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
