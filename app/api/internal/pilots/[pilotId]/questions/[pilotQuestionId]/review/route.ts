import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { handleResolvePilotQuestionReview } from "@/lib/pilots/engine-routes";
import { getReportServiceClient } from "@/lib/reports/service-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/internal/pilots/:pilotId/questions/:pilotQuestionId/review
 *
 * D-061 — resolves one engine's measurement of a pilot question that is
 * held for review (for example a ChatGPT answer whose outcome is unknown
 * after a timeout, D-056 item 6), body `{ engine, resolution, note }`, with
 * the request page's two resolutions and note rules, through the same
 * resolve_protocol_job_review call. The job is the question's own slot on
 * that engine, found from the pilot's tables. Behind the console's kill
 * switch and the founder guard; it never starts the worker or reserves
 * anything. The handler is lib/pilots/engine-routes.ts, which the tests run.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ pilotId: string; pilotQuestionId: string }> }
): Promise<NextResponse> {
  return handleResolvePilotQuestionReview(request, await params, {
    env: process.env,
    guard: () => requireFounderForRoute("pilot-question-review"),
    client: getReportServiceClient,
  });
}
