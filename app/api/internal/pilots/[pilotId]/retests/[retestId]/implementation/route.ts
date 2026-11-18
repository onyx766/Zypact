import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { getDb } from "@/lib/db";
import { handleConfirmPilotRetest } from "@/lib/pilots/retest-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/internal/pilots/:pilotId/retests/:retestId/implementation
 *
 * D-062 — records the change as live: every question and engine of it is
 * implemented in one transaction, with one waiting period that can never be
 * moved (confirm_pilot_retest_implementation). Behind the kill switch, the
 * founder guard and the retest gate.
 * The handler is lib/pilots/retest-routes.ts, which the tests run.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ pilotId: string; retestId: string }> }
): Promise<NextResponse> {
  return handleConfirmPilotRetest(request, await params, {
    env: process.env,
    guard: () => requireFounderForRoute("pilot-retest-implementation"),
    db: getDb,
  });
}
