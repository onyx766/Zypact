import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { SAVE_PILOT_ACTION_REFUSAL, parseSavePilotAction } from "@/lib/pilots/action-rules";
import { savePilotAction, verifyActionEvidence } from "@/lib/pilots/action-store";
import { UUID_PATTERN } from "@/lib/pilots/validate";
import { getReportServiceClient } from "@/lib/reports/service-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/internal/pilots/:pilotId/actions — D-057: saves a new suggested
 * action, or a new version of one (an edit), written by the team. The
 * version is a draft until it is reviewed; nothing is shared, sent,
 * measured or spent. The wording lint runs here and again at every report
 * build; every linked answer must be one of this pilot's completed answers
 * (checked here and by the database), and every named source must be among
 * that answer's own sources (checked here and at every build).
 */
export async function POST(request: Request, { params }: { params: Promise<{ pilotId: string }> }): Promise<NextResponse> {
  if (process.env.SNAPSHOT_APPROVAL_ENABLED !== "true") {
    return NextResponse.json({ ok: false, error: "Writing suggested actions is temporarily unavailable." }, { status: 503 });
  }

  const guard = await requireFounderForRoute("pilot-action-save");
  if (!guard.ok) return guard.response;

  const { pilotId } = await params;
  if (!UUID_PATTERN.test(pilotId)) {
    return NextResponse.json({ ok: false, error: "invalid_pilot_id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const parsed = parseSavePilotAction(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, error: "Some fields need attention.", issues: parsed.issues },
      { status: 400 }
    );
  }

  const client = getReportServiceClient();
  const checked = await verifyActionEvidence(client, pilotId, parsed.value.evidence);
  const result =
    checked === "OK"
      ? await savePilotAction(client, { pilotId, writtenBy: guard.user.id, fields: parsed.value })
      : { outcome: checked, actionId: null, versionId: null, versionNumber: null };

  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "pilot_action_save",
      actorUserId: guard.user.id,
      pilotId,
      edit: parsed.value.actionId !== null,
      evidenceLinks: parsed.value.evidence.length,
      outcome: result.outcome,
      actionId: result.actionId,
      versionNumber: result.versionNumber,
    })
  );

  if (result.outcome === "SAVED") {
    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  }
  return NextResponse.json(
    { ok: false, outcome: result.outcome, error: SAVE_PILOT_ACTION_REFUSAL[result.outcome] ?? "The action could not be saved." },
    { status: result.outcome === "PILOT_NOT_FOUND" || result.outcome === "ACTION_NOT_FOUND" ? 404 : 409 }
  );
}
