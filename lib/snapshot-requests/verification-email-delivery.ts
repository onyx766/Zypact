const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const REQUEST_TIMEOUT_MS = 8_000;

export interface SnapshotVerificationEmailConfig {
  apiKey: string;
  from: string;
  replyTo?: string | null;
  appBaseUrl: string;
}

export interface SendSnapshotVerificationEmailInput {
  requestId: string;
  to: string;
  companyName: string;
  token: string;
  expiresInMinutes: number;
}

export interface SnapshotVerificationEmailResult {
  provider: "resend";
  messageId: string;
}

export class SnapshotEmailDeliveryError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(
    code: string,
    status: number | null = null
  ) {
    super(
      `Snapshot verification email delivery failed: ${code}`
    );
    this.name = "SnapshotEmailDeliveryError";
    this.code = code;
    this.status = status;
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[character] ?? character
  );
}

function validateConfiguration(
  config: SnapshotVerificationEmailConfig
) {
  if (!config.apiKey.trim()) {
    throw new SnapshotEmailDeliveryError(
      "missing_api_key"
    );
  }

  if (
    !config.from.trim() ||
    !config.from.includes("@")
  ) {
    throw new SnapshotEmailDeliveryError(
      "invalid_sender"
    );
  }

  let baseUrl: URL;

  try {
    baseUrl = new URL(config.appBaseUrl);
  } catch {
    throw new SnapshotEmailDeliveryError(
      "invalid_app_base_url"
    );
  }

  if (
    baseUrl.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(
      baseUrl.hostname
    )
  ) {
    throw new SnapshotEmailDeliveryError(
      "insecure_app_base_url"
    );
  }
}

export function buildSnapshotVerificationLink(
  appBaseUrl: string,
  token: string
): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new SnapshotEmailDeliveryError(
      "invalid_verification_token"
    );
  }

  let url: URL;

  try {
    url = new URL("/verify-email", appBaseUrl);
  } catch {
    throw new SnapshotEmailDeliveryError(
      "invalid_app_base_url"
    );
  }

  url.searchParams.set("token", token);

  return url.toString();
}

export function renderSnapshotVerificationEmail(input: {
  companyName: string;
  verificationLink: string;
  expiresInMinutes: number;
}): {
  subject: string;
  text: string;
  html: string;
} {
  const companyName =
    input.companyName.trim() || "your company";

  const subject =
    "Verify your email for your Zypact demo request";

  const text = [
    `Confirm your email to continue the Zypact V1 demo request for ${companyName}.`,
    "",
    input.verificationLink,
    "",
    `This private link expires in ${input.expiresInMinutes} minutes and can be used only once.`,
    "",
    "Email verification records the request; it does not approve a protocol or start an AI scan. V1 automation begins only after the buyer question and protocol are approved.",
    "",
    "You can ignore this email if you did not request a Zypact demo.",
  ].join("\n");

  const safeCompanyName = escapeHtml(companyName);
  const safeLink = escapeHtml(
    input.verificationLink
  );

  const html = `
<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f7f7f8;font-family:Arial,sans-serif;color:#18181b;">
    <div style="max-width:600px;margin:0 auto;padding:32px 20px;">
      <div style="background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:32px;">
        <p style="margin:0 0 20px;font-size:20px;font-weight:700;">
          Verify your email
        </p>

        <p style="margin:0 0 20px;line-height:1.6;">
          Confirm your email to continue the Zypact V1 demo request for
          <strong>${safeCompanyName}</strong>.
        </p>

        <p style="margin:28px 0;">
          <a
            href="${safeLink}"
            style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700;"
          >
            Verify email
          </a>
        </p>

        <p style="margin:0 0 14px;line-height:1.6;color:#52525b;">
          This private link expires in ${input.expiresInMinutes} minutes and can be used only once.
        </p>

        <p style="margin:0 0 14px;line-height:1.6;color:#52525b;">
          Email verification records the request; it does not approve a protocol or start an AI scan. V1 automation begins only after the buyer question and protocol are approved.
        </p>

        <p style="margin:0;line-height:1.6;color:#71717a;font-size:14px;">
          You can ignore this email if you did not request a Zypact demo.
        </p>
      </div>
    </div>
  </body>
</html>`.trim();

  return {
    subject,
    text,
    html,
  };
}

function providerErrorCode(
  payload: unknown
): string {
  if (
    payload &&
    typeof payload === "object" &&
    "name" in payload &&
    typeof payload.name === "string"
  ) {
    return payload.name;
  }

  return "provider_request_failed";
}

export async function sendSnapshotVerificationEmail(
  input: SendSnapshotVerificationEmailInput,
  config: SnapshotVerificationEmailConfig,
  fetchImpl: typeof fetch = fetch
): Promise<SnapshotVerificationEmailResult> {
  validateConfiguration(config);

  const verificationLink =
    buildSnapshotVerificationLink(
      config.appBaseUrl,
      input.token
    );

  const message = renderSnapshotVerificationEmail({
    companyName: input.companyName,
    verificationLink,
    expiresInMinutes: input.expiresInMinutes,
  });

  const idempotencyKey =
    `snapshot-verification-${input.requestId}`;

  if (idempotencyKey.length > 256) {
    throw new SnapshotEmailDeliveryError(
      "invalid_idempotency_key"
    );
  }

  const body: Record<string, unknown> = {
    from: config.from,
    to: [input.to],
    subject: message.subject,
    text: message.text,
    html: message.html,
  };

  if (config.replyTo?.trim()) {
    body.reply_to = config.replyTo.trim();
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetchImpl(
      RESEND_EMAILS_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }
    );

    let payload: unknown = null;

    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      throw new SnapshotEmailDeliveryError(
        providerErrorCode(payload),
        response.status
      );
    }

    if (
      !payload ||
      typeof payload !== "object" ||
      !("id" in payload) ||
      typeof payload.id !== "string" ||
      !payload.id
    ) {
      throw new SnapshotEmailDeliveryError(
        "invalid_provider_response",
        response.status
      );
    }

    return {
      provider: "resend",
      messageId: payload.id,
    };
  } catch (error) {
    if (error instanceof SnapshotEmailDeliveryError) {
      throw error;
    }

    throw new SnapshotEmailDeliveryError(
      error instanceof Error &&
        error.name === "AbortError"
        ? "provider_timeout"
        : "provider_connection_failed"
    );
  } finally {
    clearTimeout(timeout);
  }
}
