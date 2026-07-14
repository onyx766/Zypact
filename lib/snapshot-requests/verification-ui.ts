const VERIFICATION_TOKEN_PATTERN =
  /^[A-Za-z0-9_-]{43}$/;

export type SnapshotVerificationUiResult =
  | {
      ok: true;
      status: "pending_approval";
      nextStep: "awaiting_founder_approval";
    }
  | {
      ok: true;
      status: "queued";
      nextStep: "awaiting_scan_runner";
    }
  | {
      ok: false;
      reason:
        | "invalid_link"
        | "unavailable"
        | "request_failed";
    };

export function normalizeSnapshotVerificationToken(
  raw: string | null | undefined
): string | null {
  if (typeof raw !== "string") {
    return null;
  }

  const token = raw.trim();

  return VERIFICATION_TOKEN_PATTERN.test(token)
    ? token
    : null;
}

export async function verifySnapshotEmailLink(
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<SnapshotVerificationUiResult> {
  const normalizedToken =
    normalizeSnapshotVerificationToken(token);

  if (!normalizedToken) {
    return {
      ok: false,
      reason: "invalid_link",
    };
  }

  try {
    const response = await fetchImpl(
      "/api/snapshot-requests/verify-email",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({
          token: normalizedToken,
        }),
      }
    );

    let payload: unknown = null;

    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (
      response.ok &&
      payload &&
      typeof payload === "object" &&
      "ok" in payload &&
      payload.ok === true &&
      "status" in payload
    ) {
      if (payload.status === "queued") {
        return {
          ok: true,
          status: "queued",
          nextStep: "awaiting_scan_runner",
        };
      }

      if (
        payload.status ===
        "pending_approval"
      ) {
        return {
          ok: true,
          status: "pending_approval",
          nextStep:
            "awaiting_founder_approval",
        };
      }
    }

    if (response.status === 400) {
      return {
        ok: false,
        reason: "invalid_link",
      };
    }

    if (response.status === 503) {
      return {
        ok: false,
        reason: "unavailable",
      };
    }

    return {
      ok: false,
      reason: "request_failed",
    };
  } catch {
    return {
      ok: false,
      reason: "request_failed",
    };
  }
}
