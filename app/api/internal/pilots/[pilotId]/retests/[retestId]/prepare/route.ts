import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { getDb } from "@/lib/db";
import { handlePreparePilotRetests } from "@/lib/pilots/retest-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/internal/pilots/:pilotId/retests/:retestId/prepare
 *
 * D-062 — once the waiting period has ended, queues one retest per question
 * and engine (prepare_pilot_retests). Nothing runs and nothing is spent:
 * each retest is run from the pilot page. Behind the kill switch, the
 * founder guard and the retest gate.
 * The handler is lib/pilots/retest-routes.ts, which the tests run.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ pilotId: string; retestId: string }> }
): Promise<NextResponse> {
  return handlePreparePilotRetests(request, await params, {
    env: process.env,
    guard: () => requireFounderForRoute("pilot-retest-prepare"),
    db: getDb,
  });
}
