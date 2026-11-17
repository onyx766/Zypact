import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { getDb } from "@/lib/db";
import { CLOSE_PILOT_REFUSAL } from "@/lib/pilots/copy";
import { UUID_PATTERN } from "@/lib/pilots/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_REASON_LENGTH = 10;
const MAX_REASON_LENGTH = 2000;

/**
 * POST /api/internal/pilots/:pilotId/close — D-054: closes a pilot. It
 * records who closed it and why, and changes no measurement: the database
 * refuses every later Run for the pilot's questions, and its evidence is
 * kept as it is.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ pilotId: string }> }
): Promise<NextResponse> {
  if (process.env.SNAPSHOT_APPROVAL_ENABLED !== "true") {
    return NextResponse.json(
      { ok: false, error: "Closing a pilot is temporarily unavailable." },
      { status: 503 }
    );
  }

  const guard = await requireFounderForRoute("pilot-close");
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
  const { reason } = (body ?? {}) as Record<string, unknown>;
  if (typeof reason !== "string" || reason.trim().length < MIN_REASON_LENGTH || reason.length > MAX_REASON_LENGTH) {
    return NextResponse.json(
      { ok: false, error: `A reason of ${MIN_REASON_LENGTH}-${MAX_REASON_LENGTH} characters is required.` },
      { status: 400 }
    );
  }

  const outcome = await getDb().closePilot({ pilotId, closedBy: guard.user.id, reason: reason.trim() });

  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "pilot_close",
      actorUserId: guard.user.id,
      pilotId,
      outcome,
    })
  );

  if (outcome === "CLOSED") {
    return NextResponse.json({ ok: true, outcome }, { status: 200 });
  }
  return NextResponse.json(
    { ok: false, outcome, error: CLOSE_PILOT_REFUSAL[outcome] },
    { status: outcome === "PILOT_NOT_FOUND" ? 404 : 409 }
  );
}
