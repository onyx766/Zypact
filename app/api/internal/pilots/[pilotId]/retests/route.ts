import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { getDb } from "@/lib/db";
import { handleRegisterPilotRetest } from "@/lib/pilots/retest-routes";
import { getReportServiceClient } from "@/lib/reports/service-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/internal/pilots/:pilotId/retests
 *
 * D-062 — registers a customer change across 1-5 live questions, each on
 * both engines, after the customer approved it in writing: one approved M7
 * intervention per question and engine, in one database transaction
 * (register_pilot_retest). Behind the console's kill switch, the founder
 * guard and the retest gate (ZYPACT_PILOT_RETEST_ENABLED). It never runs or
 * reserves anything. The handler is lib/pilots/retest-routes.ts, which the
 * tests run.
 */
export async function POST(request: Request, { params }: { params: Promise<{ pilotId: string }> }): Promise<NextResponse> {
  return handleRegisterPilotRetest(request, await params, {
    env: process.env,
    guard: () => requireFounderForRoute("pilot-retest-register"),
    db: getDb,
    questionOrdinal: async (pilotQuestionId) => {
      const { data, error } = await getReportServiceClient().from("pilot_questions").select("ordinal").eq("id", pilotQuestionId).maybeSingle();
      if (error || !data) return null;
      return Number((data as Record<string, unknown>).ordinal);
    },
  });
}
