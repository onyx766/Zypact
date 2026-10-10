import { NextResponse } from "next/server";

import { requireFounderForRoute } from "@/lib/auth/founder";
import { getReportServiceClient } from "@/lib/reports/service-client";
import {
  readWorkerState,
  startWorkerMachine,
} from "@/lib/worker-control/fly-machine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RUNNABLE_JOB_STATUSES = ["queued", "claimed", "running", "needs_review"];

export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const guard = await requireFounderForRoute("founder-baselines/run");
  if (!guard.ok) return guard.response;

  const { jobId } = await params;
  if (!UUID_PATTERN.test(jobId)) {
    return NextResponse.json(
      { ok: false, error: "invalid_job_id" },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_json_body" },
      { status: 400 }
    );
  }

  const protocolId = (body as { protocolId?: unknown } | null)?.protocolId;
  if (typeof protocolId !== "string" || !UUID_PATTERN.test(protocolId)) {
    return NextResponse.json(
      { ok: false, error: "invalid_protocol_id" },
      { status: 400 }
    );
  }

  const client = getReportServiceClient();

  const { data: job, error: jobError } = await client
    .from("protocol_execution_jobs")
    .select(
      "id,project_id,protocol_id,status,attempt_count,max_attempts,worker_id,claim_token,lease_expires_at,next_baseline_ordinal"
    )
    .eq("id", jobId)
    .eq("protocol_id", protocolId)
    .maybeSingle();

  if (jobError) {
    console.error(
      JSON.stringify({
        event: "founder_baseline_job_read_failed",
        jobId,
        code: jobError.code ?? null,
      })
    );
    return NextResponse.json(
      { ok: false, error: "temporarily_unavailable" },
      { status: 503 }
    );
  }

  const jobRow = (job ?? null) as Record<string, any> | null;
  if (!jobRow) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const { data: protocol, error: protocolError } = await client
    .from("protocols")
    .select(
      "id,project_id,baseline_protocol_id,status,planned_baseline_runs,planned_retest_runs,run_cap,retry_cap,spend_cap_usd"
    )
    .eq("id", protocolId)
    .eq("project_id", jobRow.project_id)
    .maybeSingle();

  if (protocolError || !protocol) {
    return NextResponse.json(
      { ok: false, error: "protocol_not_available" },
      { status: 409 }
    );
  }

  const protocolRow = protocol as Record<string, any>;

  const exactPlan =
    protocolRow.baseline_protocol_id === null &&
    protocolRow.status === "approved" &&
    protocolRow.planned_baseline_runs === 5 &&
    protocolRow.planned_retest_runs === 0 &&
    protocolRow.run_cap === 5 &&
    protocolRow.retry_cap === 0 &&
    Number(protocolRow.spend_cap_usd) <= 0.25;

  const exactJob =
    jobRow.status === "queued" &&
    jobRow.attempt_count === 0 &&
    jobRow.max_attempts === 1 &&
    jobRow.worker_id === null &&
    jobRow.claim_token === null &&
    jobRow.lease_expires_at === null &&
    jobRow.next_baseline_ordinal === 1;

  if (!exactPlan || !exactJob) {
    return NextResponse.json(
      {
        ok: false,
        error: "safety_guard_failed",
        detail:
          "The job or protocol no longer matches the approved 5-run standalone-baseline plan.",
      },
      { status: 409 }
    );
  }

  const { data: competing, error: competingError } = await client
    .from("protocol_execution_jobs")
    .select("id,status")
    .eq("project_id", jobRow.project_id)
    .in("status", RUNNABLE_JOB_STATUSES)
    .neq("id", jobId)
    .limit(1);

  if (competingError) {
    return NextResponse.json(
      { ok: false, error: "queue_check_failed" },
      { status: 503 }
    );
  }

  if ((competing ?? []).length > 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "competing_job_present",
        detail: "Another runnable job exists for this project. Nothing was started.",
      },
      { status: 409 }
    );
  }

  const workerState = await readWorkerState();
  if (workerState !== "stopped") {
    return NextResponse.json(
      {
        ok: false,
        error: "worker_not_stopped",
        detail: `Worker state is '${workerState}'. Nothing was started.`,
      },
      { status: 409 }
    );
  }

  const start = await startWorkerMachine();
  if (!start.ok) {
    return NextResponse.json(
      { ok: false, error: start.code, detail: start.detail },
      { status: start.code === "not_configured" ? 503 : 502 }
    );
  }

  if (start.alreadyRunning) {
    return NextResponse.json(
      {
        ok: false,
        error: "worker_race_detected",
        detail: "The worker was already running by the time Fly processed the start.",
      },
      { status: 409 }
    );
  }

  return NextResponse.json(
    {
      ok: true,
      started: true,
      jobId,
      protocolId,
      plannedRuns: 5,
      runCap: 5,
      retryCap: 0,
      spendCapUsd: 0.25,
    },
    { status: 202 }
  );
}
