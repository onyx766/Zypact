import { NextResponse } from "next/server";
import { getReportServiceClient } from "@/lib/reports/service-client";
import { guardInterventionRoute } from "@/lib/interventions/route-guard";
import { readIntervention } from "@/lib/interventions/intervention-actions";
import { readRetestProgress } from "@/lib/interventions/retest-actions";
import { PILOT_MEMBER_FAILURE, pilotMemberInterventionIds } from "@/lib/interventions/pilot-exclusions";
import { invalidId, type RouteContext } from "@/lib/interventions/route-handlers";
import { UUID_PATTERN } from "@/lib/interventions/validate";
import { startFailureHttpStatus, startWorkerMachine } from "@/lib/worker-control/fly-machine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "intervention-run-retest";

/**
 * POST /api/internal/interventions/:id/run-retest
 *
 * Starts the worker so the already-queued retest job is claimed and run.
 *
 * Queueing and running are separate on purpose, and this route is the second
 * half that the console was missing: `queue-retest` writes a job row and
 * spends nothing, and until now only an operator with a shell could cause
 * that row to be executed. A retest could therefore sit at "queued · 0
 * attempts" with nothing in the product able to move it.
 *
 * It starts a machine; it does not claim, reserve or call a provider. The
 * worker does that under its own claim token and the SQL admission gate, and
 * its configuration — exit after one claimed job, never restart — is what
 * keeps one start to one job.
 *
 * Refuses unless this intervention's own retest job is `queued`. A start with
 * nothing claimable would spend nothing, but it would also tell the founder
 * that something is happening when nothing is.
 */
export async function POST(_request: Request, context: RouteContext) {
  const guard = await guardInterventionRoute(ROUTE);
  if (!guard.ok) return guard.response;

  const { interventionId } = await context.params;
  if (!UUID_PATTERN.test(interventionId)) return invalidId();

  const client = getReportServiceClient();
  const intervention = await readIntervention(client, interventionId);
  if (!intervention) {
    return NextResponse.json(
      { ok: false, error: "not_found", message: "That intervention was not found." },
      { status: 404 }
    );
  }

  // D-062 — a pilot member's retest runs only from its pilot page.
  if ((await pilotMemberInterventionIds(client, [interventionId])).has(interventionId)) {
    return NextResponse.json({ ok: false, error: PILOT_MEMBER_FAILURE.error, message: PILOT_MEMBER_FAILURE.message }, { status: 409 });
  }

  const retest = await readRetestProgress(client, intervention);
  const jobStatus = retest?.job?.status ?? null;

  if (jobStatus === null) {
    return NextResponse.json(
      {
        ok: false, error: "no_queued_job",
        message: "There is no retest job to run. Queue the retest run first.",
      },
      { status: 409 }
    );
  }

  if (jobStatus !== "queued") {
    // `claimed` and `running` mean a worker already holds it; the terminal
    // states mean there is nothing left to do. Either way a start would be
    // a claim of progress this route cannot support.
    return NextResponse.json(
      {
        ok: false, error: "job_not_queued",
        message: `The retest job is '${jobStatus.replace(/_/g, " ")}', so it is not waiting to be started.`,
      },
      { status: 409 }
    );
  }

  const jobId = retest?.job?.id ?? null;
  if (!jobId) {
    return NextResponse.json(
      {
        ok: false, error: "no_queued_job",
        message: "There is no retest job to run. Queue the retest run first.",
      },
      { status: 409 }
    );
  }

  // D-052 — the start names this intervention's own retest job; the worker
  // claims it or nothing.
  const start = await startWorkerMachine({
    jobId,
    projectId: intervention.projectId,
    via: "admin_run_retest",
    requestedBy: guard.user.id,
  });
  if (!start.ok) {
    return NextResponse.json(
      { ok: false, error: start.code, message: start.detail },
      { status: startFailureHttpStatus(start.code) }
    );
  }

  if (start.alreadyRunning && start.runRequestWithdrawn) {
    return NextResponse.json(
      {
        ok: false, error: "worker_already_running",
        message:
          "The worker is still running from an earlier start, so nothing new was started. "
          + "Press Run retest now again once it has stopped, usually within a minute.",
      },
      { status: 409 }
    );
  }

  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: start.alreadyRunning ? "retest_worker_already_running" : "retest_worker_started",
      interventionId,
      jobId,
      actor: guard.user.id,
    })
  );

  return NextResponse.json(
    {
      ok: true,
      started: true,
      alreadyRunning: start.alreadyRunning,
      message: start.alreadyRunning
        ? "The worker was already starting and takes this retest when it is ready, or has already taken it."
        : "The worker is starting. It runs only this retest, then stops. Five runs usually take about 2 minutes.",
    },
    { status: 202 }
  );
}
