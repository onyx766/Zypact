import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { getDb } from "@/lib/db";
import type { RetryFailedProtocolJobOutcome } from "@/lib/db/types";
import { getReportServiceClient } from "@/lib/reports/service-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIN_NOTE_LENGTH = 10;
const MAX_NOTE_LENGTH = 2000;

/** Fixed text for every refusal. Nothing from the request is echoed. */
const REFUSAL_TEXT: Record<Exclude<RetryFailedProtocolJobOutcome, "APPROVED">, string> = {
  DENIED:
    "The measurement's own limits refused the retry, so nothing was reserved. Close the request instead.",
  JOB_NOT_FOUND: "This measurement no longer exists.",
  JOB_NOT_FAILED: "This measurement is not stopped, so there is nothing to retry. Refresh the page.",
  JOB_NOT_RETRYABLE:
    "Only a run that failed at the AI provider can be retried here. Close the request instead.",
  REQUEST_NOT_OPEN: "This request is closed, so its measurement cannot be retried.",
  SOURCE_ATTEMPT_NOT_OWNED_BY_JOB: "The failed run could not be found on this measurement.",
  SOURCE_ATTEMPT_NOT_RETRYABLE:
    "The failed run cannot be retried: it has already been retried, or its place in the plan is filled.",
  AMBIGUOUS_CALL_PRESENT:
    "A call of the failed run may have reached the provider without a reply on record, so a retry could pay twice. Close the request instead.",
  NOT_A_PROVIDER_FAILURE:
    "The failed run's answer reached Zypact, so a full retry would throw away a paid answer. Close the request instead.",
  RUN_CAP_INSUFFICIENT_FOR_REMAINING_PLAN:
    "This measurement has too few runs left under its run cap to finish its plan, so a retry would be wasted. Close the request instead.",
  IDEMPOTENCY_KEY_CONFLICT:
    "This page already retried a different run. Reload the page before retrying again.",
};

/**
 * POST /api/internal/snapshot-requests/:requestId/retry-measurement
 *
 * D-052 — reserves one retry of the run that stopped a measurement at the
 * AI provider. It does not start the worker: after an approved retry the
 * founder presses Run, which goes through the paid-execution gate and the
 * run request like every other start (D-035).
 *
 * The failed run is chosen here, from the database, never from the body:
 * the newest `failed` run in the slot the job stopped at, whether or not it
 * has been retried. A repeated click after a lost response then reaches the
 * database with the same key and the same run, and is answered by replay;
 * every other condition is re-checked there under its own locks.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ requestId: string }> }
) {
  // The same kill switch as approve and reject.
  if (process.env.SNAPSHOT_APPROVAL_ENABLED !== "true") {
    return NextResponse.json(
      { ok: false, error: "Retrying a measurement is temporarily unavailable." },
      { status: 503 }
    );
  }

  const guard = await requireFounderForRoute("snapshot-retry-measurement");
  if (!guard.ok) return guard.response;

  const { requestId } = await params;
  if (!UUID_PATTERN.test(requestId)) {
    return NextResponse.json({ ok: false, error: "invalid_request_id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const { note, idempotencyKey } = (body ?? {}) as Record<string, unknown>;
  if (
    typeof note !== "string" ||
    note.trim().length < MIN_NOTE_LENGTH ||
    note.length > MAX_NOTE_LENGTH
  ) {
    return NextResponse.json(
      { ok: false, error: `A note of ${MIN_NOTE_LENGTH}-${MAX_NOTE_LENGTH} characters is required.` },
      { status: 400 }
    );
  }
  if (typeof idempotencyKey !== "string" || !UUID_PATTERN.test(idempotencyKey)) {
    return NextResponse.json({ ok: false, error: "invalid_idempotency_key" }, { status: 400 });
  }

  const client = getReportServiceClient();

  const { data: requestRow } = await client
    .from("snapshot_requests")
    .select("protocol_id")
    .eq("id", requestId)
    .maybeSingle();
  const protocolId = (requestRow as { protocol_id?: string | null } | null)?.protocol_id ?? null;
  if (!protocolId) {
    return NextResponse.json(
      { ok: false, error: "This request has no measurement to retry." },
      { status: 409 }
    );
  }

  const { data: jobRow } = await client
    .from("protocol_execution_jobs")
    .select("id,project_id,next_baseline_ordinal")
    .eq("protocol_id", protocolId)
    .maybeSingle();
  const job = jobRow as { id: string; project_id: string; next_baseline_ordinal: number } | null;
  if (!job) {
    return NextResponse.json(
      { ok: false, error: "This request has no measurement to retry." },
      { status: 409 }
    );
  }

  const { data: attemptRows } = await client
    .from("protocol_attempts")
    .select("id,status,retry_of_attempt_id,baseline_ordinal,created_at")
    .eq("job_id", job.id)
    .order("created_at", { ascending: false });
  const attempts = (attemptRows ?? []) as Array<{
    id: string;
    status: string;
    retry_of_attempt_id: string | null;
    baseline_ordinal: number | null;
  }>;
  const source = attempts.find(
    (a) => a.status === "failed" && a.baseline_ordinal === job.next_baseline_ordinal
  );
  if (!source) {
    return NextResponse.json(
      { ok: false, error: REFUSAL_TEXT.SOURCE_ATTEMPT_NOT_RETRYABLE },
      { status: 409 }
    );
  }

  const result = await getDb().retryFailedProtocolJob({
    jobId: job.id,
    projectId: job.project_id,
    actor: guard.user.id,
    reason: note.trim(),
    sourceAttemptId: source.id,
    idempotencyKey,
  });

  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "snapshot_measurement_retry",
      requestId,
      jobId: job.id,
      actorUserId: guard.user.id,
      outcome: result.outcome,
      denialCode: result.denialCode,
    })
  );

  if (result.outcome === "APPROVED") {
    return NextResponse.json(
      {
        ok: true,
        outcome: result.outcome,
        detail:
          `Retry of run ${job.next_baseline_ordinal} reserved. Press Run scan on the requests list to continue the measurement.`,
      },
      { status: 200 }
    );
  }

  return NextResponse.json(
    { ok: false, outcome: result.outcome, denialCode: result.denialCode, error: REFUSAL_TEXT[result.outcome] },
    { status: result.outcome === "JOB_NOT_FOUND" ? 404 : 409 }
  );
}
