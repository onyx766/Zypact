import { NextResponse } from "next/server";
import { getReportServiceClient } from "@/lib/reports/service-client";
import { failureResponse, guardInterventionRoute } from "@/lib/interventions/route-guard";
import { sendReviewedOutcomeCard } from "@/lib/interventions/outcome-card-actions";
import { invalidId, readJsonBody, validationResponse, type RouteContext } from "@/lib/interventions/route-handlers";
import { UUID_PATTERN } from "@/lib/interventions/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ROUTE = "intervention-outcome-card-send";

/**
 * POST /api/internal/interventions/:id/outcome-card/send
 * body: { expectedArtifactId, expectedRevision, acknowledgeReview }
 *
 * Emails the customer the card the founder reviewed — that exact artifact
 * and revision, or nothing. `blocked` is refused before any claim;
 * `needs_review` requires acknowledgeReview. Goes through
 * deliverSavedOutcomeCard, the one function that emails a customer a card.
 *
 * The link base follows the existing web send route
 * (app/api/internal/snapshot-requests/[requestId]/send-report), NOT the
 * worker's SNAPSHOT_PUBLIC_BASE_URL — the two paths already differ there,
 * recorded in docs/OPTION_A_TODO.md rather than silently reconciled here.
 */
export async function POST(request: Request, context: RouteContext) {
  const guard = await guardInterventionRoute(ROUTE);
  if (!guard.ok) return guard.response;

  const { interventionId } = await context.params;
  if (!UUID_PATTERN.test(interventionId)) return invalidId();

  const body = (await readJsonBody(request)) as Record<string, unknown> | undefined;
  const expectedArtifactId = body?.expectedArtifactId;
  const expectedRevision = body?.expectedRevision;
  if (typeof expectedArtifactId !== "string" || !UUID_PATTERN.test(expectedArtifactId)) {
    return validationResponse({ error: "invalid_expected_artifact_id", message: "Reload the page and review the card before sending." });
  }
  if (typeof expectedRevision !== "string" || expectedRevision.trim() === "") {
    return validationResponse({ error: "invalid_expected_revision", message: "Reload the page and review the card before sending." });
  }

  // Validated before anything that could take a claim, so a misconfigured
  // deployment can never strand one.
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.SNAPSHOT_EMAIL_FROM;
  if (!apiKey || !from) {
    return NextResponse.json(
      { ok: false, error: "email_not_configured", message: "Email delivery is not configured on this deployment." },
      { status: 503 }
    );
  }

  const result = await sendReviewedOutcomeCard(
    getReportServiceClient(),
    interventionId,
    { expectedArtifactId, expectedRevision, acknowledgeReview: body?.acknowledgeReview === true },
    { apiKey, from, appBaseUrl: process.env.NEXT_PUBLIC_SITE_URL || "https://zypact.com" }
  );

  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: result.ok ? "info" : "warn",
      event: result.ok ? "outcome_card_sent" : "outcome_card_send_refused",
      interventionId,
      artifactId: expectedArtifactId,
      error: result.ok ? null : result.failure.error,
      actor: guard.user.id,
    })
  );

  if (!result.ok) return failureResponse(result.failure);
  return NextResponse.json({ ok: true, messageId: result.messageId }, { status: 200 });
}
