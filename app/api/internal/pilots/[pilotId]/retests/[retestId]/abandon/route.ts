import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { getDb } from "@/lib/db";
import { handleAbandonPilotRetest } from "@/lib/pilots/retest-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/internal/pilots/:pilotId/retests/:retestId/abandon
 *
 * D-062 — withdraws every question and engine of the change together, until
 * the first retest answer (abandon_pilot_retest). Not behind the retest
 * gate: it spends nothing and is forward recovery once the gate is off.
 * The handler is lib/pilots/retest-routes.ts, which the tests run.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ pilotId: string; retestId: string }> }
): Promise<NextResponse> {
  return handleAbandonPilotRetest(request, await params, {
    env: process.env,
    guard: () => requireFounderForRoute("pilot-retest-abandon"),
    db: getDb,
  });
}
