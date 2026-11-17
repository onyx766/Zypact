import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { WITHDRAW_PILOT_ACTION_REFUSAL } from "@/lib/pilots/action-rules";
import { withdrawPilotAction } from "@/lib/pilots/action-store";
import { UUID_PATTERN } from "@/lib/pilots/validate";
import { getReportServiceClient } from "@/lib/reports/service-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_REASON_LENGTH = 10;
const MAX_REASON_LENGTH = 2000;

/**
 * POST /api/internal/pilots/:pilotId/actions/:actionId/withdraw — D-057:
 * withdraws a suggested action. Its versions and review history are kept;
 * it appears in no later report and can no longer be edited. A revision
 * already shared keeps what it showed.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ pilotId: string; actionId: string }> }
): Promise<NextResponse> {
  if (process.env.SNAPSHOT_APPROVAL_ENABLED !== "true") {
    return NextResponse.json({ ok: false, error: "Withdrawing suggested actions is temporarily unavailable." }, { status: 503 });
  }

  const guard = await requireFounderForRoute("pilot-action-withdraw");
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
  const { reason } = (body ?? {}) as Record<string, unknown>;
  if (typeof reason !== "string" || reason.trim().length < MIN_REASON_LENGTH || reason.length > MAX_REASON_LENGTH) {
    return NextResponse.json(
      { ok: false, error: `A reason of ${MIN_REASON_LENGTH}-${MAX_REASON_LENGTH} characters is required.` },
      { status: 400 }
    );
  }

  const outcome = await withdrawPilotAction(getReportServiceClient(), {
    pilotId,
    actionId,
    withdrawnBy: guard.user.id,
    reason: reason.trim(),
  });

  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "pilot_action_withdraw",
      actorUserId: guard.user.id,
      pilotId,
      actionId,
      outcome,
    })
  );

  if (outcome === "WITHDRAWN") return NextResponse.json({ ok: true, outcome }, { status: 200 });
  return NextResponse.json(
    { ok: false, outcome, error: WITHDRAW_PILOT_ACTION_REFUSAL[outcome] ?? "The action could not be withdrawn." },
    { status: outcome === "PILOT_NOT_FOUND" || outcome === "ACTION_NOT_FOUND" ? 404 : 409 }
  );
}
