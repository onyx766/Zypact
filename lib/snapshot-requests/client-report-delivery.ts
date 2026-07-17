const RESEND_EMAILS_URL =
  "https://api.resend.com/emails";

const REQUEST_TIMEOUT_MS = 8_000;

export interface ClientReportDeliveryConfig {
  apiKey: string;
  from: string;
  replyTo?: string | null;
  appBaseUrl: string;
}

export interface ClientReportDeliveryInput {
  requestId: string;
  to: string;
  companyName: string;
  publicToken: string;
  visibilitySummary: string;
  brandedReputation: string;
  firstPriorityAction: string;
}

export class ClientReportDeliveryError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(
    code: string,
    status: number | null = null
  ) {
    super(
      `Client report delivery failed: ${code}`
    );

    this.name =
      "ClientReportDeliveryError";

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
  config: ClientReportDeliveryConfig
): void {
  if (!config.apiKey.trim()) {
    throw new ClientReportDeliveryError(
      "missing_api_key"
    );
  }

  if (
    !config.from.trim() ||
    !config.from.includes("@")
  ) {
    throw new ClientReportDeliveryError(
      "invalid_sender"
    );
  }

  let baseUrl: URL;

  try {
    baseUrl = new URL(config.appBaseUrl);
  } catch {
    throw new ClientReportDeliveryError(
      "invalid_app_base_url"
    );
  }

  if (
    baseUrl.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(
      baseUrl.hostname
    )
  ) {
    throw new ClientReportDeliveryError(
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

export function buildClientReportLink(
  appBaseUrl: string,
  publicToken: string
): string {
  if (
    !/^[A-Za-z0-9_-]{43,128}$/.test(
      publicToken
    )
  ) {
    throw new ClientReportDeliveryError(
      "invalid_public_token"
    );
  }

  return new URL(
    `/report/${publicToken}`,
    appBaseUrl
  ).toString();
}

export async function sendClientSnapshotReport(
  input: ClientReportDeliveryInput,
  config: ClientReportDeliveryConfig,
  fetchImpl: typeof fetch = fetch
): Promise<{
  provider: "resend";
  messageId: string;
}> {
  validateConfiguration(config);

  if (
    !input.to.trim() ||
    !input.to.includes("@")
  ) {
    throw new ClientReportDeliveryError(
      "invalid_recipient"
    );
  }

  const reportLink =
    buildClientReportLink(
      config.appBaseUrl,
      input.publicToken
    );

  const companyName =
    input.companyName.trim() ||
    "your company";

  const subject =
    `Your Zypact AI visibility snapshot — ${companyName}`;

  const text = [
    `Your Zypact AI visibility snapshot for ${companyName} is ready.`,
    "",
    `Visibility: ${input.visibilitySummary}`,
    `Branded reputation: ${input.brandedReputation}`,
    "",
    `First priority action: ${input.firstPriorityAction}`,
    "",
    `View your private report: ${reportLink}`,
    "",
    "This is a private report link. Please do not forward it publicly.",
  ].join("\n");

  const html = `
<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f7f7f8;font-family:Arial,sans-serif;color:#18181b;">
    <div style="max-width:620px;margin:0 auto;padding:32px 20px;">
      <div style="background:#ffffff;border:1px solid #e4e4e7;border-radius:14px;padding:32px;">
        <p style="margin:0 0 10px;color:#71717a;font-size:13px;text-transform:uppercase;letter-spacing:.05em;">
          Zypact AI visibility snapshot
        </p>

        <h1 style="margin:0 0 22px;font-size:26px;line-height:1.25;">
          Your private report is ready
        </h1>

        <p style="margin:0 0 22px;line-height:1.65;">
          We completed the AI visibility snapshot for
          <strong>${escapeHtml(companyName)}</strong>.
        </p>

        <div style="margin:0 0 18px;padding:18px;border-radius:10px;background:#f8f8f8;">
          <p style="margin:0 0 8px;">
            <strong>Visibility:</strong>
            ${escapeHtml(input.visibilitySummary)}
          </p>

          <p style="margin:0;">
            <strong>Branded reputation:</strong>
            ${escapeHtml(input.brandedReputation)}
          </p>
        </div>

        <p style="margin:0 0 8px;font-weight:700;">
          First priority action
        </p>

        <p style="margin:0 0 26px;line-height:1.65;color:#52525b;">
          ${escapeHtml(input.firstPriorityAction)}
        </p>

        <a
          href="${escapeHtml(reportLink)}"
          style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:13px 20px;border-radius:999px;font-weight:700;"
        >
          View private report
        </a>

        <p style="margin:26px 0 0;color:#71717a;font-size:13px;line-height:1.55;">
          This link provides access to a private report. Please do not publish or forward it publicly.
        </p>
      </div>
    </div>
  </body>
</html>`.trim();

  const body: Record<string, unknown> = {
    from: config.from,
    to: [input.to],
    subject,
    text,
    html,
  };

  if (config.replyTo?.trim()) {
    body.reply_to =
      config.replyTo.trim();
  }

  const controller =
    new AbortController();

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
            `snapshot-report-${input.requestId}`,
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
      throw new ClientReportDeliveryError(
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
      throw new ClientReportDeliveryError(
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
      ClientReportDeliveryError
    ) {
      throw error;
    }

    throw new ClientReportDeliveryError(
      error instanceof Error &&
        error.name === "AbortError"
        ? "provider_timeout"
        : "provider_connection_failed"
    );
  } finally {
    clearTimeout(timeout);
  }
}
