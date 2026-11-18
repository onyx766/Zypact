import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { getDb } from "@/lib/db";
import { handleRequeuePilotRetest } from "@/lib/pilots/retest-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/internal/pilots/:pilotId/retests/:retestId/requeue
 *
 * D-062 — queues again one retest that stopped before any answer, so
 * nothing was reserved or spent (requeue_pilot_retest_job), at most 3 times.
 * Behind the kill switch, the founder guard and the retest gate.
 * The handler is lib/pilots/retest-routes.ts, which the tests run.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ pilotId: string; retestId: string }> }
): Promise<NextResponse> {
  return handleRequeuePilotRetest(request, await params, {
    env: process.env,
    guard: () => requireFounderForRoute("pilot-retest-requeue"),
    db: getDb,
  });
}
