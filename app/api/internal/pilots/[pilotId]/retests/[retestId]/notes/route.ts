import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { getDb } from "@/lib/db";
import { handleAddPilotRetestNote } from "@/lib/pilots/retest-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/internal/pilots/:pilotId/retests/:retestId/notes
 *
 * D-062 — logs another change seen during the retest (add_pilot_retest_note).
 * Not behind the retest gate: it spends nothing and is forward recovery
 * once the gate is off.
 * The handler is lib/pilots/retest-routes.ts, which the tests run.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ pilotId: string; retestId: string }> }
): Promise<NextResponse> {
  return handleAddPilotRetestNote(request, await params, {
    env: process.env,
    guard: () => requireFounderForRoute("pilot-retest-note"),
    db: getDb,
  });
}
