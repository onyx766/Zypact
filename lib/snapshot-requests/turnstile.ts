import { randomUUID } from "node:crypto";

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export const SNAPSHOT_TURNSTILE_ACTION = "snapshot_request";

interface SiteverifyResponse {
  success?: boolean;
  challenge_ts?: string;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
}

export type TurnstileFailureReason =
  | "invalid_token"
  | "service_error"
  | "challenge_failed"
  | "action_mismatch"
  | "hostname_mismatch";

export type TurnstileVerificationResult =
  | {
      ok: true;
      hostname: string | null;
      action: string | null;
    }
  | {
      ok: false;
      reason: TurnstileFailureReason;
      errorCodes: string[];
    };

interface VerifyTurnstileInput {
  token: string;
  secret: string;
  remoteIp?: string | null;
  expectedAction?: string | null;
  expectedHostname?: string | null;
  fetchImpl?: typeof fetch;
}

export async function verifyTurnstileToken({
  token,
  secret,
  remoteIp,
  expectedAction,
  expectedHostname,
  fetchImpl = fetch,
}: VerifyTurnstileInput): Promise<TurnstileVerificationResult> {
  if (!token || token.length > 2048) {
    return {
      ok: false,
      reason: "invalid_token",
      errorCodes: ["invalid-token-format"],
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const payload: Record<string, string> = {
      secret,
      response: token,
      idempotency_key: randomUUID(),
    };

    if (remoteIp) {
      payload.remoteip = remoteIp;
    }

    const response = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        ok: false,
        reason: "service_error",
        errorCodes: [`http-${response.status}`],
      };
    }

    const result = (await response.json()) as SiteverifyResponse;

    if (result.success !== true) {
      return {
        ok: false,
        reason: "challenge_failed",
        errorCodes: result["error-codes"] ?? ["unknown-turnstile-error"],
      };
    }

    if (expectedAction && result.action !== expectedAction) {
      return {
        ok: false,
        reason: "action_mismatch",
        errorCodes: ["action-mismatch"],
      };
    }

    if (expectedHostname && result.hostname !== expectedHostname) {
      return {
        ok: false,
        reason: "hostname_mismatch",
        errorCodes: ["hostname-mismatch"],
      };
    }

    return {
      ok: true,
      hostname: result.hostname ?? null,
      action: result.action ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "service_error",
      errorCodes: [
        error instanceof Error && error.name === "AbortError"
          ? "validation-timeout"
          : "validation-request-failed",
      ],
    };
  } finally {
    clearTimeout(timeout);
  }
}
