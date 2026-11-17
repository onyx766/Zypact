import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { getDb } from "@/lib/db";
import { CREATE_PILOT_REFUSAL } from "@/lib/pilots/copy";
import { parseCreatePilot } from "@/lib/pilots/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/internal/pilots";
const MAX_BODY_BYTES = 8_192;

/**
 * POST /api/internal/pilots — D-054: creates a managed pilot and its one
 * project. Nothing is measured or charged: questions are added one by one,
 * each with the customer's written approval, and each is run by its own
 * Run press.
 */
export async function POST(request: Request): Promise<NextResponse> {
  // The same kill switch as approve, retry and close.
  if (process.env.SNAPSHOT_APPROVAL_ENABLED !== "true") {
    return NextResponse.json(
      { ok: false, error: "Creating a pilot is temporarily unavailable." },
      { status: 503 }
    );
  }

  const guard = await requireFounderForRoute(ROUTE);
  if (!guard.ok) return guard.response;

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "request_body_too_large" }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const parsed = parseCreatePilot(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, error: "Check the highlighted fields.", issues: parsed.issues },
      { status: 400 }
    );
  }

  const result = await getDb().createPilot({ createdBy: guard.user.id, ...parsed.value });

  // Closed fields only: ids, an outcome and the domain. No company name,
  // note or question text reaches the log.
  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "pilot_create",
      route: ROUTE,
      actorUserId: guard.user.id,
      outcome: result.outcome,
      pilotId: result.pilotId,
      normalizedDomain: parsed.value.normalizedDomain,
    })
  );

  if (result.outcome === "CREATED" || result.outcome === "ALREADY_CREATED") {
    return NextResponse.json(
      { ok: true, outcome: result.outcome, pilotId: result.pilotId, pilotPath: `/admin/pilots/${result.pilotId}` },
      { status: result.outcome === "CREATED" ? 201 : 200 }
    );
  }
  return NextResponse.json(
    { ok: false, outcome: result.outcome, error: CREATE_PILOT_REFUSAL[result.outcome] },
    { status: 409 }
  );
}
