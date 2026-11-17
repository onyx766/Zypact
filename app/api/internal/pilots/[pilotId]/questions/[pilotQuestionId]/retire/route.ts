import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { getDb } from "@/lib/db";
import { RETIRE_QUESTION_REFUSAL } from "@/lib/pilots/copy";
import { UUID_PATTERN } from "@/lib/pilots/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_REASON_LENGTH = 10;
const MAX_REASON_LENGTH = 2000;

/**
 * POST /api/internal/pilots/:pilotId/questions/:pilotQuestionId/retire
 *
 * D-054 — retires a pilot question whose measurement stopped and cannot go
 * on: abandoned, or failed in a way the D-052 retry does not take. Every
 * row and all evidence are kept. The question stops counting toward the
 * limit, its approved text may be added again, and the database refuses
 * any later Run or retry of it. Nothing is started or reserved here.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ pilotId: string; pilotQuestionId: string }> }
): Promise<NextResponse> {
  if (process.env.SNAPSHOT_APPROVAL_ENABLED !== "true") {
    return NextResponse.json(
      { ok: false, error: "Retiring a pilot question is temporarily unavailable." },
      { status: 503 }
    );
  }

  const guard = await requireFounderForRoute("pilot-question-retire");
  if (!guard.ok) return guard.response;

  const { pilotId, pilotQuestionId } = await params;
  if (!UUID_PATTERN.test(pilotId) || !UUID_PATTERN.test(pilotQuestionId)) {
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

  const outcome = await getDb().retirePilotQuestion({
    pilotId,
    pilotQuestionId,
    retiredBy: guard.user.id,
    reason: reason.trim(),
  });

  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "pilot_question_retire",
      actorUserId: guard.user.id,
      pilotId,
      pilotQuestionId,
      outcome,
    })
  );

  if (outcome === "RETIRED") {
    return NextResponse.json({ ok: true, outcome }, { status: 200 });
  }
  return NextResponse.json(
    { ok: false, outcome, error: RETIRE_QUESTION_REFUSAL[outcome] },
    { status: outcome === "PILOT_NOT_FOUND" || outcome === "QUESTION_NOT_FOUND" ? 404 : 409 }
  );
}
