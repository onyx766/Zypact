const RESEND_EMAILS_URL =
  "https://api.resend.com/emails";
const REQUEST_TIMEOUT_MS = 8_000;

export interface FounderSnapshotNotificationConfig {
  apiKey: string;
  from: string;
  replyTo?: string | null;
  founderEmails: string[];
  appBaseUrl: string;
}

export interface FounderSnapshotNotificationInput {
  requestId: string;
  companyName: string;
  contactName?: string | null;
  workEmail: string;
  websiteUrl: string;
  normalizedDomain: string;
  buyerCategory: string;
}

export class FounderNotificationDeliveryError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(
    code: string,
    status: number | null = null
  ) {
    super(
      `Founder notification delivery failed: ${code}`
    );
    this.name =
      "FounderNotificationDeliveryError";
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
  config: FounderSnapshotNotificationConfig
): void {
  if (!config.apiKey.trim()) {
    throw new FounderNotificationDeliveryError(
      "missing_api_key"
    );
  }

  if (
    !config.from.trim() ||
    !config.from.includes("@")
  ) {
    throw new FounderNotificationDeliveryError(
      "invalid_sender"
    );
  }

  if (
    config.founderEmails.length === 0 ||
    config.founderEmails.some(
      (email) => !email.includes("@")
    )
  ) {
    throw new FounderNotificationDeliveryError(
      "invalid_founder_recipients"
    );
  }

  let baseUrl: URL;

  try {
    baseUrl = new URL(config.appBaseUrl);
  } catch {
    throw new FounderNotificationDeliveryError(
      "invalid_app_base_url"
    );
  }

  if (
    baseUrl.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(
      baseUrl.hostname
    )
  ) {
    throw new FounderNotificationDeliveryError(
      "insecure_app_base_url"
    );
  }
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

export async function sendFounderSnapshotRequestNotification(
  input: FounderSnapshotNotificationInput,
  config: FounderSnapshotNotificationConfig,
  fetchImpl: typeof fetch = fetch
): Promise<{
  provider: "resend";
  messageId: string;
}> {
  validateConfiguration(config);

  const adminUrl = new URL(
    "/admin/snapshot-requests",
    config.appBaseUrl
  ).toString();

  const subject =
    `New verified snapshot request — ${input.companyName}`;

  const text = [
    "A prospect verified their email for a Zypact snapshot.",
    "",
    `Company: ${input.companyName}`,
    `Website: ${input.websiteUrl}`,
    `Contact: ${input.contactName?.trim() || "(not provided)"} <${input.workEmail}>`,
    `Buyer question: ${input.buyerCategory}`,
    `Request ID: ${input.requestId}`,
    "",
    `Review request: ${adminUrl}`,
  ].join("\n");

  const html = `
<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f7f7f8;font-family:Arial,sans-serif;color:#18181b;">
    <div style="max-width:620px;margin:0 auto;padding:32px 20px;">
      <div style="background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:32px;">
        <p style="margin:0 0 8px;color:#71717a;font-size:13px;text-transform:uppercase;letter-spacing:.04em;">
          Zypact founder operations
        </p>

        <h1 style="margin:0 0 24px;font-size:24px;">
          New verified snapshot request
        </h1>

        <p style="margin:0 0 10px;">
          <strong>Company:</strong>
          ${escapeHtml(input.companyName)}
        </p>

        <p style="margin:0 0 10px;">
          <strong>Website:</strong>
          ${escapeHtml(input.normalizedDomain)}
        </p>

        <p style="margin:0 0 10px;">
          <strong>Contact:</strong>
          ${escapeHtml(input.contactName?.trim() || "(not provided)")}
          &lt;${escapeHtml(input.workEmail)}&gt;
        </p>

        <p style="margin:0 0 24px;line-height:1.55;">
          <strong>Buyer question:</strong>
          ${escapeHtml(input.buyerCategory)}
        </p>

        <a
          href="${escapeHtml(adminUrl)}"
          style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700;"
        >
          Review request
        </a>
      </div>
    </div>
  </body>
</html>`.trim();

  const body: Record<string, unknown> = {
    from: config.from,
    to: config.founderEmails,
    subject,
    text,
    html,
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
          authorization:
            `Bearer ${config.apiKey}`,
          "content-type":
            "application/json",
          "idempotency-key":
            `snapshot-founder-${input.requestId}`,
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
      throw new FounderNotificationDeliveryError(
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
      throw new FounderNotificationDeliveryError(
        "invalid_provider_response",
        response.status
      );
    }

    return {
      provider: "resend",
      messageId: payload.id,
    };
  } catch (error) {
    if (
      error instanceof
      FounderNotificationDeliveryError
    ) {
      throw error;
    }

    throw new FounderNotificationDeliveryError(
      error instanceof Error &&
        error.name === "AbortError"
        ? "provider_timeout"
        : "provider_connection_failed"
    );
  } finally {
    clearTimeout(timeout);
  }
}
