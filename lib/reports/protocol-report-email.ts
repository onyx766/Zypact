/**
 * Notification email for a V1 protocol report.
 *
 * Deliberately carries NO findings — not the presence rate, not the interval,
 * not a recommendation. The existing client-report email template renders
 * fixed labels ("Branded reputation", "First priority action") for concepts a
 * V1 protocol report does not produce, and a recommendation is exactly the
 * kind of claim this methodology withholds until there is evidence for it.
 *
 * An email cannot show the attempt reconciliation, the interval, or the
 * limitations that make a number honest. Restating a figure without them is
 * how a directional reading becomes a quoted statistic, so the message says
 * the snapshot is ready and links to the page that states it in full.
 *
 * Transport mirrors `client-report-delivery.ts`: same provider, same
 * idempotency-key discipline, same bounded timeout, same error codes — so a
 * caller can treat failures from either path identically.
 */

import {
  buildClientReportLink,
  ClientReportDeliveryError,
  MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH,
  type ClientReportDeliveryConfig,
} from "@/lib/snapshot-requests/client-report-delivery";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";

const REQUEST_TIMEOUT_MS = 8_000;

export interface ProtocolReportEmailInput {
  to: string;
  companyName: string;
  publicToken: string;
  /** Question text, quoted so the recipient recognizes what was asked. */
  questionText: string;
  deliveryIdempotencyKey: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** First line only, bounded: a pasted multi-line prompt must not become a wall of text. */
function previewQuestion(value: string): string {
  const firstLine = value.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const trimmed = firstLine.trim();
  return trimmed.length > 160
    ? `${trimmed.slice(0, 157)}…`
    : trimmed;
}

export function buildProtocolReportEmail(
  input: ProtocolReportEmailInput,
  appBaseUrl: string
): { subject: string; text: string; html: string } {
  const link = buildClientReportLink(appBaseUrl, input.publicToken);
  const question = previewQuestion(input.questionText);

  const subject = `Your AI answer snapshot — ${input.companyName}`;

  const text = [
    `Your AI answer snapshot for ${input.companyName} is ready.`,
    "",
    "We asked one AI answer engine a single buyer question and recorded",
    "what it replied, run by run:",
    "",
    `  "${question}"`,
    "",
    "The full snapshot shows every run, what was and was not observed,",
    "how certain it is, and what it does not tell you:",
    "",
    link,
    "",
    "This link is private to you. It is a directional reading of one",
    "AI surface at one point in time, not a measure of how every AI",
    "assistant describes you.",
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#18181b;">
    <div style="max-width:560px;margin:0 auto;padding:32px 24px;">
      <p style="margin:0 0 10px;color:#71717a;font-size:13px;text-transform:uppercase;letter-spacing:.05em;">
        AI answer snapshot
      </p>

      <h1 style="margin:0 0 22px;font-size:26px;line-height:1.25;">
        Your snapshot for ${escapeHtml(input.companyName)} is ready
      </h1>

      <p style="margin:0 0 22px;line-height:1.65;">
        We asked one AI answer engine a single buyer question and recorded
        what it replied, run by run.
      </p>

      <blockquote style="margin:0 0 22px;padding:12px 16px;border-left:3px solid #d4d4d8;background:#f4f4f5;line-height:1.6;">
        ${escapeHtml(question)}
      </blockquote>

      <p style="margin:0 0 26px;line-height:1.65;">
        The full snapshot shows every run, what was and was not observed,
        how certain it is, and what it does not tell you.
      </p>

      <p style="margin:0 0 26px;">
        <a href="${escapeHtml(link)}"
           style="display:inline-block;padding:12px 20px;background:#18181b;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;">
          View your snapshot
        </a>
      </p>

      <p style="margin:26px 0 0;color:#71717a;font-size:13px;line-height:1.55;">
        This link is private to you. It is a directional reading of one AI
        surface at one point in time, not a measure of how every AI
        assistant describes you.
      </p>
    </div>
  </body>
</html>`;

  return { subject, text, html };
}

export async function sendProtocolReportEmail(
  input: ProtocolReportEmailInput,
  config: ClientReportDeliveryConfig,
  fetchImpl: typeof fetch = fetch
): Promise<{ provider: "resend"; messageId: string }> {
  if (!config.apiKey?.trim()) {
    throw new ClientReportDeliveryError("missing_api_key");
  }
  if (!config.from?.trim()) {
    throw new ClientReportDeliveryError("missing_from_address");
  }
  if (!input.to.trim() || !input.to.includes("@")) {
    throw new ClientReportDeliveryError("invalid_recipient");
  }

  const idempotencyKey = input.deliveryIdempotencyKey.trim();

  if (
    !idempotencyKey ||
    idempotencyKey.length > MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH
  ) {
    throw new ClientReportDeliveryError("invalid_idempotency_key");
  }

  const { subject, text, html } = buildProtocolReportEmail(
    input,
    config.appBaseUrl
  );

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  let response: Response;

  try {
    response = await fetchImpl(RESEND_EMAILS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        from: config.from,
        to: [input.to],
        subject,
        text,
        html,
        ...(config.replyTo ? { reply_to: config.replyTo } : {}),
      }),
      signal: controller.signal,
    });
  } catch {
    // Never distinguished from a send that succeeded: the request may have
    // reached the provider before the process gave up. The caller must treat
    // this as ambiguous and must not release its delivery claim.
    throw new ClientReportDeliveryError("provider_unreachable");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new ClientReportDeliveryError(
      response.status >= 500 ? "provider_error" : "provider_rejected",
      response.status
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ClientReportDeliveryError("provider_unparsable", response.status);
  }

  const messageId = (body as Record<string, unknown> | null)?.id;

  if (typeof messageId !== "string" || !messageId.trim()) {
    // The provider accepted it; the id is simply unreadable. Reported as
    // ambiguous rather than failed, so the claim stays held.
    throw new ClientReportDeliveryError("provider_missing_id", response.status);
  }

  return { provider: "resend", messageId };
}
