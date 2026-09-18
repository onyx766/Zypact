import { NextResponse } from "next/server";
import { getReportServiceClient } from "@/lib/reports/service-client";
import { failureResponse, guardInterventionRoute, logUnmappedRpcError } from "@/lib/interventions/route-guard";
import { createRetest } from "@/lib/interventions/retest-actions";
import { invalidId, type RouteContext } from "@/lib/interventions/route-handlers";
import { UUID_PATTERN } from "@/lib/interventions/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "intervention-create-retest";

/**
 * POST /api/internal/interventions/:id/create-retest
 *
 * Creates the retest protocol for an eligible intervention: same question
 * version, same provider and sampling plan as its baseline. Queues nothing
 * and spends nothing — see /queue-retest for that.
 *
 * Idempotent: a repeat returns the existing retest (200, replayed), including
 * a completed one (0079), so an intervention can never acquire a second
 * measurement.
 */
export async function POST(_request: Request, context: RouteContext) {
  const guard = await guardInterventionRoute(ROUTE);
  if (!guard.ok) return guard.response;

  const { interventionId } = await context.params;
  if (!UUID_PATTERN.test(interventionId)) return invalidId();

  const result = await createRetest(
    getReportServiceClient(),
    interventionId,
    guard.user.id,
    (d) => logUnmappedRpcError(ROUTE, d)
  );
  if (!result.ok) return failureResponse(result.failure);

  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: result.replayed ? "retest_protocol_already_exists" : "retest_protocol_created",
      interventionId,
      retestProtocolId: result.retestProtocolId,
      actor: guard.user.id,
    })
  );

  return NextResponse.json(
    { ok: true, retestProtocolId: result.retestProtocolId, replayed: result.replayed },
    { status: result.replayed ? 200 : 201 }
  );
}
