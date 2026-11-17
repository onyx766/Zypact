import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { REVIEW_PILOT_ACTION_REFUSAL } from "@/lib/pilots/action-rules";
import { reviewPilotAction } from "@/lib/pilots/action-store";
import { UUID_PATTERN } from "@/lib/pilots/validate";
import { getReportServiceClient } from "@/lib/reports/service-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/internal/pilots/:pilotId/actions/:actionId/review — D-057: the
 * founder marks the latest version of a suggested action reviewed, after
 * confirming they have read it and the answers it rests on. Only a reviewed
 * latest version appears in a report; an edit needs a new review. Nothing is
 * shared or sent.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ pilotId: string; actionId: string }> }
): Promise<NextResponse> {
  if (process.env.SNAPSHOT_APPROVAL_ENABLED !== "true") {
    return NextResponse.json({ ok: false, error: "Reviewing suggested actions is temporarily unavailable." }, { status: 503 });
  }

  const guard = await requireFounderForRoute("pilot-action-review");
  if (!guard.ok) return guard.response;

  const { pilotId, actionId } = await params;
  if (!UUID_PATTERN.test(pilotId) || !UUID_PATTERN.test(actionId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const { versionNumber, confirmed } = (body ?? {}) as Record<string, unknown>;
  if (typeof versionNumber !== "number" || !Number.isInteger(versionNumber) || versionNumber < 1 || typeof confirmed !== "boolean") {
    return NextResponse.json({ ok: false, error: "Reload the page and try again." }, { status: 400 });
  }

  const outcome = await reviewPilotAction(getReportServiceClient(), {
    pilotId,
    actionId,
    versionNumber,
    reviewedBy: guard.user.id,
    confirmed,
  });

  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "pilot_action_review",
      actorUserId: guard.user.id,
      pilotId,
      actionId,
      versionNumber,
      outcome,
    })
  );

  if (outcome === "REVIEWED") return NextResponse.json({ ok: true, outcome }, { status: 200 });
  return NextResponse.json(
    { ok: false, outcome, error: REVIEW_PILOT_ACTION_REFUSAL[outcome] ?? "The action could not be reviewed." },
    { status: outcome === "PILOT_NOT_FOUND" || outcome === "ACTION_NOT_FOUND" || outcome === "VERSION_NOT_FOUND" ? 404 : 409 }
  );
}
