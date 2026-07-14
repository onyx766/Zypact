import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import type { DbAdapter } from "@/lib/db/types";
import { SnapshotRequestLimitError } from "@/lib/db/types";
import {
  generateSnapshotEmailVerificationToken,
} from "@/lib/snapshot-requests/email-verification";
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
import {
  sendSnapshotVerificationEmail,
  SnapshotEmailDeliveryError,
  type SnapshotVerificationEmailConfig,
} from "@/lib/snapshot-requests/verification-email-delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8_192;
const DEFAULT_VERIFICATION_TTL_MINUTES = 30;

interface EmailFlowConfiguration {
  email: SnapshotVerificationEmailConfig;
  ttlMinutes: number;
}

function unavailableResponse() {
  return NextResponse.json(
    {
      ok: false,
      error:
        "Snapshot requests are temporarily unavailable.",
    },
    { status: 503 }
  );
}

function requestLimitResponse() {
  return NextResponse.json(
    {
      ok: false,
      error:
        "A free snapshot was already requested recently. Try again later or contact Zypact.",
      code: "snapshot_request_limit",
    },
    { status: 429 }
  );
}

function deliveryFailureResponse() {
  return NextResponse.json(
    {
      ok: false,
      error:
        "The verification email could not be sent. Please try again.",
      code: "verification_email_delivery_failed",
    },
    { status: 503 }
  );
}

function readEmailFlowConfiguration():
  | EmailFlowConfiguration
  | null {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.SNAPSHOT_EMAIL_FROM;
  const replyTo =
    process.env.SNAPSHOT_EMAIL_REPLY_TO || null;
  const appBaseUrl =
    process.env.SNAPSHOT_PUBLIC_BASE_URL;

  const ttlRaw =
    process.env
      .SNAPSHOT_EMAIL_VERIFICATION_TTL_MINUTES ||
    String(DEFAULT_VERIFICATION_TTL_MINUTES);

  const ttlMinutes = Number(ttlRaw);

  if (
    !apiKey ||
    !from ||
    !from.includes("@") ||
    !appBaseUrl ||
    !Number.isInteger(ttlMinutes) ||
    ttlMinutes < 5 ||
    ttlMinutes > 24 * 60
  ) {
    return null;
  }

  try {
    const parsed = new URL(appBaseUrl);

    if (
      parsed.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(
        parsed.hostname
      )
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return {
    email: {
      apiKey,
      from,
      replyTo,
      appBaseUrl,
    },
    ttlMinutes,
  };
}

async function safelyFailDelivery(
  db: DbAdapter,
  requestId: string
): Promise<void> {
  try {
    const changed =
      await db.failSnapshotVerificationDelivery(
        requestId
      );

    if (!changed) {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          event:
            "snapshot_verification_delivery_cleanup_not_applied",
          requestId,
        })
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event:
          "snapshot_verification_delivery_cleanup_failed",
        requestId,
        error:
          error instanceof Error
            ? error.message
            : "unknown_error",
      })
    );
  }
}

export async function POST(request: Request) {
  // Both routes remain closed until the public form,
  // Resend configuration, and verification page are tested.
  if (
    process.env.SNAPSHOT_REQUESTS_ENABLED !==
      "true" ||
    process.env
      .SNAPSHOT_EMAIL_VERIFICATION_ENABLED !==
      "true"
  ) {
    return unavailableResponse();
  }

  const ipHashSecret =
    process.env.SNAPSHOT_IP_HASH_SECRET;

  const turnstileSecret =
    process.env.TURNSTILE_SECRET_KEY;

  const emailFlow =
    readEmailFlowConfiguration();

  if (
    !ipHashSecret ||
    ipHashSecret.length < 32 ||
    !turnstileSecret ||
    !emailFlow
  ) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event:
          "snapshot_request_configuration_error",
        reason:
          "missing_security_or_email_configuration",
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
    const submission =
      parseSnapshotRequestSubmission(body);

    const requestIp =
      extractRequestIp(request.headers);

    const turnstile =
      await verifyTurnstileToken({
        token: submission.turnstileToken,
        secret: turnstileSecret,
        remoteIp: requestIp,
        expectedAction:
          SNAPSHOT_TURNSTILE_ACTION,
        expectedHostname:
          process.env
            .TURNSTILE_EXPECTED_HOSTNAME ||
          null,
      });

    if (!turnstile.ok) {
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          event:
            "snapshot_request_turnstile_rejected",
          reason: turnstile.reason,
          errorCodes:
            turnstile.errorCodes,
        })
      );

      return NextResponse.json(
        {
          ok: false,
          error:
            "Complete the security check and try again.",
        },
        { status: 400 }
      );
    }

    const requestIpHash =
      hashRequestIp(
        requestIp,
        ipHashSecret
      );

    const db = getDb();

    const saved =
      await db.createSnapshotRequest({
        ...submission.input,
        requestIpHash,
      });

    const verification =
      generateSnapshotEmailVerificationToken({
        ttlMinutes:
          emailFlow.ttlMinutes,
      });

    let issued = false;

    try {
      issued =
        await db.issueSnapshotRequestVerification({
          requestId: saved.id,
          tokenHash:
            verification.tokenHash,
          expiresAt:
            verification.expiresAt,
        });
    } catch (error) {
      await safelyFailDelivery(
        db,
        saved.id
      );

      throw error;
    }

    if (!issued) {
      await safelyFailDelivery(
        db,
        saved.id
      );

      throw new Error(
        "snapshot_verification_issue_failed"
      );
    }

    try {
      await sendSnapshotVerificationEmail(
        {
          requestId: saved.id,
          to: saved.workEmail,
          companyName:
            saved.companyName,
          token:
            verification.token,
          expiresInMinutes:
            emailFlow.ttlMinutes,
        },
        emailFlow.email
      );
    } catch (error) {
      await safelyFailDelivery(
        db,
        saved.id
      );

      if (
        error instanceof
        SnapshotEmailDeliveryError
      ) {
        console.error(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "error",
            event:
              "snapshot_verification_email_delivery_failed",
            requestId: saved.id,
            provider: "resend",
            code: error.code,
            status: error.status,
          })
        );
      } else {
        console.error(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: "error",
            event:
              "snapshot_verification_email_delivery_failed",
            requestId: saved.id,
            provider: "resend",
            code: "unknown_error",
          })
        );
      }

      return deliveryFailureResponse();
    }

    return NextResponse.json(
      {
        ok: true,
        requestId: saved.id,
        status: saved.status,
        nextStep: "check_email",
      },
      { status: 201 }
    );
  } catch (error) {
    if (
      error instanceof
      SnapshotRequestLimitError
    ) {
      return requestLimitResponse();
    }

    if (
      error instanceof
      SnapshotRequestValidationError
    ) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Please correct the highlighted fields.",
          issues: error.issues,
        },
        { status: 400 }
      );
    }

    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event:
          "snapshot_request_create_failed",
        error:
          error instanceof Error
            ? error.message
            : "unknown_error",
      })
    );

    return NextResponse.json(
      {
        ok: false,
        error:
          "The request could not be saved.",
      },
      { status: 500 }
    );
  }
}
