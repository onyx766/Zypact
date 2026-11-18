import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { getDb } from "@/lib/db";
import { handleAddPilotQuestionEngine } from "@/lib/pilots/engine-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/internal/pilots/:pilotId/questions/:pilotQuestionId/engines
 *
 * D-061 — adds the ChatGPT baseline to an existing pilot question, body
 * `{ "engine": "openai_chatgpt" }`: the question's own approved version, 5
 * planned runs, caps of 7 runs, 2 retries and 4 USD (D-059), approved and
 * queued in one database transaction (add_pilot_question_engine). Behind the
 * console's kill switch, the founder guard and the web host's ChatGPT gate
 * (ZYPACT_PILOT_CHATGPT_ENABLED). It never starts the worker: the founder
 * presses Run for the question on ChatGPT. The handler is
 * lib/pilots/engine-routes.ts, which the tests run.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ pilotId: string; pilotQuestionId: string }> }
): Promise<NextResponse> {
  return handleAddPilotQuestionEngine(request, await params, {
    env: process.env,
    guard: () => requireFounderForRoute("pilot-question-engine-add"),
    db: getDb,
  });
}
