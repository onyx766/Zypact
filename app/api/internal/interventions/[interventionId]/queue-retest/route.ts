import { NextResponse } from "next/server";
import { getReportServiceClient } from "@/lib/reports/service-client";
import { failureResponse, guardInterventionRoute, logUnmappedRpcError } from "@/lib/interventions/route-guard";
import { queueRetestRun } from "@/lib/interventions/retest-actions";
import { invalidId, type RouteContext } from "@/lib/interventions/route-handlers";
import { UUID_PATTERN } from "@/lib/interventions/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "intervention-queue-retest";

/**
 * POST /api/internal/interventions/:id/queue-retest
 *
 * Queues the retest protocol's execution job through the same
 * enqueue_protocol_execution_job RPC the baseline path uses. The request
 * itself calls no provider and reserves no spend; the worker does that later
 * under a claim token and the SQL admission gate. Nothing runs while the
 * worker is stopped.
 *
 * Not `/api/projects/:projectId/protocol-runs`: that route authorizes the
 * project OWNER, and projects created from snapshot requests have none, so it
 * answers the founder 404 by design. The RPC underneath is the shared
 * contract; the authorization model is not.
 *
 * Idempotent per protocol: a repeat returns the existing job (200, replayed)
 * and spends nothing.
 */
export async function POST(_request: Request, context: RouteContext) {
  const guard = await guardInterventionRoute(ROUTE);
  if (!guard.ok) return guard.response;

  const { interventionId } = await context.params;
  if (!UUID_PATTERN.test(interventionId)) return invalidId();

  const result = await queueRetestRun(getReportServiceClient(), interventionId, (d) =>
    logUnmappedRpcError(ROUTE, d)
  );
  if (!result.ok) return failureResponse(result.failure);

  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: result.replayed ? "retest_job_already_queued" : "retest_job_queued",
      interventionId,
      jobId: result.jobId,
      jobStatus: result.jobStatus,
      actor: guard.user.id,
    })
  );

  return NextResponse.json(
    { ok: true, jobId: result.jobId, jobStatus: result.jobStatus, replayed: result.replayed },
    { status: result.replayed ? 200 : 201 }
  );
}
