import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { getDb } from "@/lib/db";
import { UUID_PATTERN } from "@/lib/pilots/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PURPOSES = new Set(["customer", "internal_practice"]);

/**
 * POST /api/internal/pilots/:pilotId/purpose — 20261109200000: records who a
 * pilot is for, a customer or an internal practice run. A practice run's
 * report says so at the top. Nothing is measured differently, no evidence or
 * stored revision changes, and it works on a closed pilot too; the next
 * report revision carries the new label.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ pilotId: string }> }
): Promise<NextResponse> {
  const guard = await requireFounderForRoute("pilot-purpose");
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
  const { purpose } = (body ?? {}) as Record<string, unknown>;
  if (typeof purpose !== "string" || !PURPOSES.has(purpose)) {
    return NextResponse.json({ ok: false, error: "The purpose must be customer or internal_practice." }, { status: 400 });
  }

  let outcome: Awaited<ReturnType<ReturnType<typeof getDb>["setPilotPurpose"]>>;
  try {
    outcome = await getDb().setPilotPurpose({
      pilotId,
      setBy: guard.user.id,
      purpose: purpose as "customer" | "internal_practice",
    });
  } catch {
    // A database without 20261109200000 has no set_pilot_purpose.
    return NextResponse.json(
      { ok: false, error: "The pilot's purpose cannot be set until the database update for it is applied." },
      { status: 503 }
    );
  }

  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "pilot_purpose_set",
      actorUserId: guard.user.id,
      pilotId,
      purpose,
      outcome,
    })
  );

  if (outcome === "PILOT_NOT_FOUND") {
    return NextResponse.json({ ok: false, outcome, error: "This pilot was not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, outcome }, { status: 200 });
}
