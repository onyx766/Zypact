import { NextResponse } from "next/server";
import { getReportServiceClient } from "@/lib/reports/service-client";
import { guardInterventionRoute } from "@/lib/interventions/route-guard";
import { readIntervention } from "@/lib/interventions/intervention-actions";
import { readRetestProgress } from "@/lib/interventions/retest-actions";
import { invalidId, type RouteContext } from "@/lib/interventions/route-handlers";
import { UUID_PATTERN } from "@/lib/interventions/validate";
import { startWorkerMachine } from "@/lib/worker-control/fly-machine";

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

  const start = await startWorkerMachine();
  if (!start.ok) {
    return NextResponse.json(
      { ok: false, error: start.code, message: start.detail },
      { status: start.code === "not_configured" || start.code === "paid_execution_blocked" ? 503 : 502 }
    );
  }

  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: start.alreadyRunning ? "retest_worker_already_running" : "retest_worker_started",
      interventionId,
      jobId: retest?.job?.id ?? null,
      actor: guard.user.id,
    })
  );

  return NextResponse.json(
    {
      ok: true,
      started: true,
      alreadyRunning: start.alreadyRunning,
      message: start.alreadyRunning
        ? "The worker was already running. It finishes its current job, then stops; start it again to run this retest."
        : "The worker is starting. It runs this retest, then stops — usually a few minutes.",
    },
    { status: 202 }
  );
}
