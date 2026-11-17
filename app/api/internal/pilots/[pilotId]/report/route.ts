import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { UUID_PATTERN } from "@/lib/pilots/validate";
import { BUILD_PILOT_REPORT_REFUSAL } from "@/lib/reports/pilot-report-copy";
import { buildAndSavePilotReport } from "@/lib/reports/process-pilot-report";
import { pilotMeasurementInProgress } from "@/lib/reports/read-pilot-evidence";
import { getReportServiceClient } from "@/lib/reports/service-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/internal/pilots/:pilotId/report — D-055: builds a new revision
 * of the pilot's combined report from stored evidence and saves it. No
 * provider or model call, no email, nothing shared: sharing is a separate,
 * reviewed step. Refused while any of the pilot's measurements is still
 * running, so a report never reads answers that are still being written;
 * save_pilot_report_artifact refuses it again in the database.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ pilotId: string }> }
): Promise<NextResponse> {
  if (process.env.SNAPSHOT_APPROVAL_ENABLED !== "true") {
    return NextResponse.json({ ok: false, error: "Building a pilot report is temporarily unavailable." }, { status: 503 });
  }

  const guard = await requireFounderForRoute("pilot-report-build");
  if (!guard.ok) return guard.response;

  const { pilotId } = await params;
  if (!UUID_PATTERN.test(pilotId)) {
    return NextResponse.json({ ok: false, error: "invalid_pilot_id" }, { status: 400 });
  }

  const client = getReportServiceClient();
  if (await pilotMeasurementInProgress(client, pilotId)) {
    console.info(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        event: "pilot_report_build",
        actorUserId: guard.user.id,
        pilotId,
        outcome: "MEASUREMENT_IN_PROGRESS",
      })
    );
    return NextResponse.json(
      { ok: false, outcome: "MEASUREMENT_IN_PROGRESS", error: BUILD_PILOT_REPORT_REFUSAL.MEASUREMENT_IN_PROGRESS },
      { status: 409 }
    );
  }

  const result = await buildAndSavePilotReport(client, pilotId, guard.user.id);

  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "pilot_report_build",
      actorUserId: guard.user.id,
      pilotId,
      outcome: result.outcome,
      artifactId: result.artifactId,
      revision: result.revision,
      integrityStatus: result.integrityStatus,
      integrityReasonCount: result.integrityReasons.length,
    })
  );

  if (result.outcome === "SAVED") {
    return NextResponse.json(
      {
        ok: true,
        outcome: result.outcome,
        artifactId: result.artifactId,
        revision: result.revision,
        integrityStatus: result.integrityStatus,
        integrityReasons: result.integrityReasons,
      },
      { status: 200 }
    );
  }
  return NextResponse.json(
    { ok: false, outcome: result.outcome, error: BUILD_PILOT_REPORT_REFUSAL[result.outcome] },
    { status: result.outcome === "PILOT_NOT_FOUND" ? 404 : 409 }
  );
}
