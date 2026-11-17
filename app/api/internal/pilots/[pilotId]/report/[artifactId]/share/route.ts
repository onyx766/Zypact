import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { UUID_PATTERN } from "@/lib/pilots/validate";
import { SHARE_PILOT_REPORT_REFUSAL } from "@/lib/reports/pilot-report-copy";
import { sharePilotReport } from "@/lib/reports/process-pilot-report";
import { getReportServiceClient } from "@/lib/reports/service-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/internal/pilots/:pilotId/report/:artifactId/share — D-055: the
 * founder's review and share of one revision. The database refuses a
 * blocked revision, a revision that needs review without the explicit
 * acknowledgement, and any revision that is not the latest. Nothing is
 * emailed; the founder copies the private link.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ pilotId: string; artifactId: string }> }
): Promise<NextResponse> {
  if (process.env.SNAPSHOT_APPROVAL_ENABLED !== "true") {
    return NextResponse.json({ ok: false, error: "Sharing a pilot report is temporarily unavailable." }, { status: 503 });
  }

  const guard = await requireFounderForRoute("pilot-report-share");
  if (!guard.ok) return guard.response;

  const { pilotId, artifactId } = await params;
  if (!UUID_PATTERN.test(pilotId) || !UUID_PATTERN.test(artifactId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const { acknowledgeNeedsReview } = (body ?? {}) as Record<string, unknown>;
  if (typeof acknowledgeNeedsReview !== "boolean") {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }

  const result = await sharePilotReport(getReportServiceClient(), {
    pilotId,
    artifactId,
    sharedBy: guard.user.id,
    acknowledgeNeedsReview,
  });

  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "pilot_report_share",
      actorUserId: guard.user.id,
      pilotId,
      artifactId,
      outcome: result.outcome,
    })
  );

  if (result.outcome === "SHARED" || result.outcome === "ALREADY_SHARED") {
    return NextResponse.json({ ok: true, outcome: result.outcome, path: `/pilot-report/${result.publicToken}` }, { status: 200 });
  }
  return NextResponse.json(
    { ok: false, outcome: result.outcome, error: SHARE_PILOT_REPORT_REFUSAL[result.outcome] },
    { status: result.outcome === "NOT_FOUND" ? 404 : 409 }
  );
}
