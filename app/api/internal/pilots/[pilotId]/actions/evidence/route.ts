import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { loadEvidenceChoices } from "@/lib/pilots/action-store";
import { UUID_PATTERN } from "@/lib/pilots/validate";
import { getReportServiceClient } from "@/lib/reports/service-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/internal/pilots/:pilotId/actions/evidence?pilotQuestionId=… —
 * D-057: the evidence picker. One question's completed answers whose stored
 * response re-hashes to its fingerprint, each with its own extracted
 * sources, so a suggested action links only to what an answer contains.
 * Reads only.
 */
export async function GET(request: Request, { params }: { params: Promise<{ pilotId: string }> }): Promise<NextResponse> {
  if (process.env.SNAPSHOT_APPROVAL_ENABLED !== "true") {
    return NextResponse.json({ ok: false, error: "Writing suggested actions is temporarily unavailable." }, { status: 503 });
  }

  const guard = await requireFounderForRoute("pilot-action-evidence");
  if (!guard.ok) return guard.response;

  const { pilotId } = await params;
  const pilotQuestionId = new URL(request.url).searchParams.get("pilotQuestionId") ?? "";
  if (!UUID_PATTERN.test(pilotId) || !UUID_PATTERN.test(pilotQuestionId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  const choices = await loadEvidenceChoices(getReportServiceClient(), pilotId, pilotQuestionId);

  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "pilot_action_evidence_choices",
      actorUserId: guard.user.id,
      pilotId,
      pilotQuestionId,
      answers: choices?.length ?? null,
    })
  );

  if (choices === null) {
    return NextResponse.json({ ok: false, error: "This question is not one of this pilot's." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, choices }, { status: 200 });
}
