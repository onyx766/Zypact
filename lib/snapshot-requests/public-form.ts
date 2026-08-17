export interface SnapshotRequestFormValues {
  workEmail: string;
  companyName: string;
  websiteUrl: string;
  buyerCategory: string;
}

export type SnapshotRequestFormField =
  | keyof SnapshotRequestFormValues
  | "turnstileToken";

export interface SnapshotRequestFormErrors {
  [field: string]: string[];
}

export type SnapshotRequestSubmissionResult =
  | {
      ok: true;
      status: "pending_verification";
      nextStep: "check_email";
    }
  | {
      ok: false;
      reason:
        | "validation"
        | "security_check"
        | "limit"
        | "delivery_failed"
        | "unavailable"
        | "request_failed";
      message: string;
      fieldErrors: SnapshotRequestFormErrors;
    };

function genericFailure(
  reason: Exclude<
    SnapshotRequestSubmissionResult,
    { ok: true }
  >["reason"],
  message: string,
  fieldErrors: SnapshotRequestFormErrors = {}
): SnapshotRequestSubmissionResult {
  return {
    ok: false,
    reason,
    message,
    fieldErrors,
  };
}

function parseIssues(
  payload: unknown
): SnapshotRequestFormErrors {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("issues" in payload) ||
    !payload.issues ||
    typeof payload.issues !== "object"
  ) {
    return {};
  }

  const errors: SnapshotRequestFormErrors = {};

  for (const [field, messages] of Object.entries(
    payload.issues
  )) {
    if (
      Array.isArray(messages) &&
      messages.every(
        (message) => typeof message === "string"
      )
    ) {
      errors[field] = messages;
    }
  }

  return errors;
}

function payloadCode(payload: unknown): string | null {
  if (
    payload &&
    typeof payload === "object" &&
    "code" in payload &&
    typeof payload.code === "string"
  ) {
    return payload.code;
  }

  return null;
}

export function buildSnapshotRequestPayload(
  values: SnapshotRequestFormValues,
  turnstileToken: string
) {
  return {
    workEmail: values.workEmail.trim(),
    companyName: values.companyName.trim(),
    websiteUrl: values.websiteUrl.trim(),
    buyerCategory: values.buyerCategory.trim(),
    turnstileToken,
  };
}

export async function submitSnapshotRequest(
  values: SnapshotRequestFormValues,
  turnstileToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<SnapshotRequestSubmissionResult> {
  if (!turnstileToken.trim()) {
    return genericFailure(
      "security_check",
      "Complete the security check before submitting.",
      {
        turnstileToken: [
          "Complete the security check.",
        ],
      }
    );
  }

  try {
    const response = await fetchImpl(
      "/api/snapshot-requests",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify(
          buildSnapshotRequestPayload(
            values,
            turnstileToken
          )
        ),
      }
    );

    let payload: unknown = null;

    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (
      response.status === 201 &&
      payload &&
      typeof payload === "object" &&
      "ok" in payload &&
      payload.ok === true &&
      "status" in payload &&
      payload.status === "pending_verification" &&
      "nextStep" in payload &&
      payload.nextStep === "check_email"
    ) {
      return {
        ok: true,
        status: "pending_verification",
        nextStep: "check_email",
      };
    }

    const code = payloadCode(payload);

    if (response.status === 400) {
      const issues = parseIssues(payload);

      if ("turnstileToken" in issues) {
        return genericFailure(
          "security_check",
          "Complete the security check and try again.",
          issues
        );
      }

      if (Object.keys(issues).length > 0) {
        return genericFailure(
          "validation",
          "Please correct the highlighted fields.",
          issues
        );
      }

      return genericFailure(
        "security_check",
        "Complete the security check and try again."
      );
    }

    if (response.status === 429) {
      return genericFailure(
        "limit",
        "A demo request was already submitted recently for this email, domain, or network."
      );
    }

    if (
      response.status === 503 &&
      code ===
        "verification_email_delivery_failed"
    ) {
      return genericFailure(
        "delivery_failed",
        "The verification email could not be sent. Please try again."
      );
    }

    if (response.status === 503) {
      return genericFailure(
        "unavailable",
        "Demo requests are temporarily unavailable."
      );
    }

    return genericFailure(
      "request_failed",
      "The request could not be submitted. Please try again."
    );
  } catch {
    return genericFailure(
      "request_failed",
      "The request could not be submitted. Check your connection and try again."
    );
  }
}
