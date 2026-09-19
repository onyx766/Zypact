/**
 * Notification email for a delivered Outcome Card.
 *
 * Same discipline as protocol-report-email.ts, extended by one more rule
 * this card specifically needs: the email carries no findings AND no
 * status word. Not the rate, not the interval, not "increase_observed" —
 * nothing that could be quoted back as "our card said X" without the
 * uncertainty and the permanent non-causality footer that make the number
 * honest. The message says the card is ready and links to the page that
 * states everything in full.
 *
 * Transport mirrors protocol-report-email.ts exactly: same provider, same
 * idempotency-key discipline, same bounded timeout, same error codes.
 */

import {
  ClientReportDeliveryError,
  MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH,
  type ClientReportDeliveryConfig,
} from "@/lib/snapshot-requests/client-report-delivery";
import { NON_CAUSALITY_FOOTER } from "@/lib/reports/outcome-card-types";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const REQUEST_TIMEOUT_MS = 8_000;

export interface OutcomeCardEmailInput {
  to: string;
  companyName: string;
  publicToken: string;
  /** Question text, quoted so the recipient recognizes what was retested. */
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

function previewQuestion(value: string): string {
  const firstLine = value.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const trimmed = firstLine.trim();
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}…` : trimmed;
}

/**
 * `/outcome-card/<token>`, not `/report/<token>` — a different public page
 * for a different artifact. `buildClientReportLink`
 * (client-report-delivery.ts) is deliberately not reused: it hardcodes the
 * `/report/` prefix, which is the baseline snapshot's route, not this one's.
 */
export function buildOutcomeCardLink(appBaseUrl: string, publicToken: string): string {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(publicToken)) {
    throw new ClientReportDeliveryError("invalid_public_token");
  }
  return new URL(`/outcome-card/${publicToken}`, appBaseUrl).toString();
}

export function buildOutcomeCardEmail(
  input: OutcomeCardEmailInput,
  appBaseUrl: string
): { subject: string; text: string; html: string } {
  const link = buildOutcomeCardLink(appBaseUrl, input.publicToken);
  const question = previewQuestion(input.questionText);

  const subject = `Your Outcome Card — ${input.companyName}`;

  const text = [
    `Your Outcome Card for ${input.companyName} is ready.`,
    "",
    "You registered a buyer question, recorded a baseline, implemented an",
    "intervention, and waited through the observation window. The retest",
    "for the same question has now run:",
    "",
    `  "${question}"`,
    "",
    "The full card shows the baseline, the retest, the observed change and",
    "its uncertainty, and what it does and does not establish:",
    "",
    link,
    "",
    "This link is private to you.",
    "",
    NON_CAUSALITY_FOOTER,
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#18181b;">
    <div style="max-width:560px;margin:0 auto;padding:32px 24px;">
      <p style="margin:0 0 10px;color:#71717a;font-size:13px;text-transform:uppercase;letter-spacing:.05em;">
        Outcome Card
      </p>

      <h1 style="margin:0 0 22px;font-size:26px;line-height:1.25;">
        Your Outcome Card for ${escapeHtml(input.companyName)} is ready
      </h1>

      <p style="margin:0 0 22px;line-height:1.65;">
        You registered a buyer question, recorded a baseline, implemented an
        intervention, and waited through the observation window. The retest
        for the same question has now run.
      </p>

      <blockquote style="margin:0 0 22px;padding:12px 16px;border-left:3px solid #d4d4d8;background:#f4f4f5;line-height:1.6;">
        ${escapeHtml(question)}
      </blockquote>

      <p style="margin:0 0 26px;line-height:1.65;">
        The full card shows the baseline, the retest, the observed change
        and its uncertainty, and what it does and does not establish.
      </p>

      <p style="margin:0 0 26px;">
        <a href="${escapeHtml(link)}"
           style="display:inline-block;padding:12px 20px;background:#18181b;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;">
          View your Outcome Card
        </a>
      </p>

      <p style="margin:26px 0 0;color:#71717a;font-size:13px;line-height:1.55;">
        This link is private to you.
      </p>

      <p style="margin:10px 0 0;color:#71717a;font-size:13px;line-height:1.55;">
        ${escapeHtml(NON_CAUSALITY_FOOTER)}
      </p>
    </div>
  </body>
</html>`;

  return { subject, text, html };
}

export async function sendOutcomeCardEmail(
  input: OutcomeCardEmailInput,
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
  if (!idempotencyKey || idempotencyKey.length > MAX_DELIVERY_IDEMPOTENCY_KEY_LENGTH) {
    throw new ClientReportDeliveryError("invalid_idempotency_key");
  }

  const { subject, text, html } = buildOutcomeCardEmail(input, config.appBaseUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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
    throw new ClientReportDeliveryError("provider_missing_id", response.status);
  }

  return { provider: "resend", messageId };
}
