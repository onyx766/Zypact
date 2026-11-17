import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { getDb } from "@/lib/db";
import { ADD_QUESTION_REFUSAL } from "@/lib/pilots/copy";
import { parseAddPilotQuestion, UUID_PATTERN } from "@/lib/pilots/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/internal/pilots/questions";
const MAX_BODY_BYTES = 8_192;

/**
 * POST /api/internal/pilots/:pilotId/questions — D-054: adds one
 * customer-approved buyer question to a pilot. In one database transaction
 * it creates the question version, approves it, creates and approves a
 * protocol with the same Perplexity plan a request's approval uses, and
 * queues its job. It does not start the worker: the founder presses Run per
 * question, which goes through the paid-execution gate and a run request.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ pilotId: string }> }
): Promise<NextResponse> {
  if (process.env.SNAPSHOT_APPROVAL_ENABLED !== "true") {
    return NextResponse.json(
      { ok: false, error: "Adding a pilot question is temporarily unavailable." },
      { status: 503 }
    );
  }

  const guard = await requireFounderForRoute(ROUTE);
  if (!guard.ok) return guard.response;

  const { pilotId } = await params;
  if (!UUID_PATTERN.test(pilotId)) {
    return NextResponse.json({ ok: false, error: "invalid_pilot_id" }, { status: 400 });
  }

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

  const parsed = parseAddPilotQuestion(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, error: "Check the highlighted fields.", issues: parsed.issues },
      { status: 400 }
    );
  }

  const result = await getDb().addPilotQuestion({ pilotId, addedBy: guard.user.id, ...parsed.value });

  // Closed fields only. The question text and the approval reference never
  // reach the log.
  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "pilot_question_add",
      route: ROUTE,
      actorUserId: guard.user.id,
      pilotId,
      outcome: result.outcome,
      pilotQuestionId: result.pilotQuestionId,
      protocolId: result.protocolId,
      jobId: result.jobId,
      questionProvenance: parsed.value.questionProvenance,
    })
  );

  if (result.outcome === "ADDED" || result.outcome === "ALREADY_ADDED") {
    return NextResponse.json(
      {
        ok: true,
        outcome: result.outcome,
        pilotQuestionId: result.pilotQuestionId,
        detail: "Question added and its measurement queued. Nothing runs until you press Run for it.",
      },
      { status: result.outcome === "ADDED" ? 201 : 200 }
    );
  }
  return NextResponse.json(
    { ok: false, outcome: result.outcome, error: ADD_QUESTION_REFUSAL[result.outcome] },
    { status: result.outcome === "PILOT_NOT_FOUND" ? 404 : 409 }
  );
}
