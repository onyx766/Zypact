import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { getDb } from "@/lib/db";
import type { RetryFailedProtocolJobOutcome } from "@/lib/db/types";
import { pilotIsOver, resolvePilotQuestionTarget } from "@/lib/pilots/reads";
import { todayUtc, UUID_PATTERN } from "@/lib/pilots/validate";
import { getReportServiceClient } from "@/lib/reports/service-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_NOTE_LENGTH = 10;
const MAX_NOTE_LENGTH = 2000;

/** Fixed text for every refusal. Nothing from the request is echoed. */
const REFUSAL_TEXT: Record<Exclude<RetryFailedProtocolJobOutcome, "APPROVED">, string> = {
  DENIED: "The measurement's own limits refused the retry, so nothing was reserved.",
  JOB_NOT_FOUND: "This measurement no longer exists.",
  JOB_NOT_FAILED: "This measurement is not stopped, so there is nothing to retry. Refresh the page.",
  JOB_NOT_RETRYABLE: "Only a run that failed at the AI provider can be retried here.",
  REQUEST_NOT_OPEN: "This measurement belongs to a closed request, so it cannot be retried.",
  SOURCE_ATTEMPT_NOT_OWNED_BY_JOB: "The failed run could not be found on this measurement.",
  SOURCE_ATTEMPT_NOT_RETRYABLE:
    "The failed run cannot be retried: it has already been retried, or its place in the plan is filled.",
  AMBIGUOUS_CALL_PRESENT:
    "A call of the failed run may have reached the provider without a reply on record, so a retry could pay twice.",
  NOT_A_PROVIDER_FAILURE:
    "The failed run's answer reached Zypact, so a full retry would throw away a paid answer.",
  RUN_CAP_INSUFFICIENT_FOR_REMAINING_PLAN:
    "This measurement has too few runs left under its run cap to finish its plan, so a retry would be wasted.",
  IDEMPOTENCY_KEY_CONFLICT: "This page already retried a different run. Reload the page before retrying again.",
};

/**
 * POST /api/internal/pilots/:pilotId/questions/:pilotQuestionId/retry
 *
 * D-054 — the D-052 founder retry for a pilot question's measurement that
 * stopped at the AI provider. It reserves one retry through
 * retry_failed_protocol_job and does not start the worker: the founder then
 * presses Run, which the database refuses once the pilot is closed or past
 * its end date. The failed run is chosen here, from the database, never
 * from the body.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ pilotId: string; pilotQuestionId: string }> }
): Promise<NextResponse> {
  if (process.env.SNAPSHOT_APPROVAL_ENABLED !== "true") {
    return NextResponse.json(
      { ok: false, error: "Retrying a measurement is temporarily unavailable." },
      { status: 503 }
    );
  }

  const guard = await requireFounderForRoute("pilot-question-retry");
  if (!guard.ok) return guard.response;

  const { pilotId, pilotQuestionId } = await params;
  if (!UUID_PATTERN.test(pilotId) || !UUID_PATTERN.test(pilotQuestionId)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const { note, idempotencyKey } = (body ?? {}) as Record<string, unknown>;
  if (typeof note !== "string" || note.trim().length < MIN_NOTE_LENGTH || note.length > MAX_NOTE_LENGTH) {
    return NextResponse.json(
      { ok: false, error: `A note of ${MIN_NOTE_LENGTH}-${MAX_NOTE_LENGTH} characters is required.` },
      { status: 400 }
    );
  }
  if (typeof idempotencyKey !== "string" || !UUID_PATTERN.test(idempotencyKey)) {
    return NextResponse.json({ ok: false, error: "invalid_idempotency_key" }, { status: 400 });
  }

  const client = getReportServiceClient();
  const target = await resolvePilotQuestionTarget(client, pilotId, pilotQuestionId);
  if (!target) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (pilotIsOver(target.pilotStatus, target.endsOn, todayUtc())) {
    return NextResponse.json(
      { ok: false, error: "This pilot is closed or past its end date, so its questions are no longer measured." },
      { status: 409 }
    );
  }
  const job = target.job;
  if (!job) {
    return NextResponse.json({ ok: false, error: "This question has no measurement to retry." }, { status: 409 });
  }

  const { data: attemptRows, error } = await client
    .from("protocol_attempts")
    .select("id,status,baseline_ordinal,created_at")
    .eq("job_id", job.id)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const attempts = (attemptRows ?? []) as Array<{ id: string; status: string; baseline_ordinal: number | null }>;
  const source = attempts.find((a) => a.status === "failed" && a.baseline_ordinal === job.nextBaselineOrdinal);
  if (!source) {
    return NextResponse.json({ ok: false, error: REFUSAL_TEXT.SOURCE_ATTEMPT_NOT_RETRYABLE }, { status: 409 });
  }

  const result = await getDb().retryFailedProtocolJob({
    jobId: job.id,
    projectId: job.projectId,
    actor: guard.user.id,
    reason: note.trim(),
    sourceAttemptId: source.id,
    idempotencyKey,
  });

  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "pilot_question_retry",
      actorUserId: guard.user.id,
      pilotId,
      pilotQuestionId,
      jobId: job.id,
      outcome: result.outcome,
      denialCode: result.denialCode,
    })
  );

  if (result.outcome === "APPROVED") {
    return NextResponse.json(
      {
        ok: true,
        outcome: result.outcome,
        detail: `Retry of run ${job.nextBaselineOrdinal} reserved. Press Run for this question to continue its measurement.`,
      },
      { status: 200 }
    );
  }
  return NextResponse.json(
    { ok: false, outcome: result.outcome, denialCode: result.denialCode, error: REFUSAL_TEXT[result.outcome] },
    { status: result.outcome === "JOB_NOT_FOUND" ? 404 : 409 }
  );
}
