import { NextResponse } from "next/server";
import { getReportServiceClient } from "@/lib/reports/service-client";
import {
  failureResponse,
  guardInterventionRoute,
  logUnmappedRpcError,
} from "@/lib/interventions/route-guard";
import {
  listInterventions,
  registerIntervention,
} from "@/lib/interventions/intervention-actions";
import { INTERVENTION_STATUSES } from "@/lib/interventions/types";
import { parseRegisterBody } from "@/lib/interventions/validate";
import { readJsonBody, validationResponse } from "@/lib/interventions/route-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "intervention-list-register";

/** GET /api/internal/interventions?status=implemented&limit=50 */
export async function GET(request: Request) {
  const guard = await guardInterventionRoute(ROUTE);
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  if (status && !(INTERVENTION_STATUSES as readonly string[]).includes(status)) {
    return validationResponse({
      error: "invalid_status",
      message: `Status must be one of: ${INTERVENTION_STATUSES.join(", ")}.`,
    });
  }
  const limitRaw = Number(url.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(limitRaw) ? limitRaw : 50;

  const items = await listInterventions(getReportServiceClient(), {
    status: status ?? undefined,
    limit,
  });
  return NextResponse.json({ ok: true, items }, { status: 200 });
}

/** POST /api/internal/interventions — register a new intervention as 'proposed'. */
export async function POST(request: Request) {
  const guard = await guardInterventionRoute(ROUTE);
  if (!guard.ok) return guard.response;

  const parsed = parseRegisterBody(await readJsonBody(request));
  if (!parsed.ok) return validationResponse(parsed);

  const result = await registerIntervention(
    getReportServiceClient(),
    parsed.value,
    (d) => logUnmappedRpcError(ROUTE, d)
  );
  if (!result.ok) return failureResponse(result.failure);

  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "intervention_registered",
      interventionId: result.intervention.id,
      projectId: result.intervention.projectId,
      protocolId: result.intervention.protocolId,
      actor: guard.user.id,
      evidenceCount: result.intervention.supportingEvidence.length,
    })
  );

  return NextResponse.json({ ok: true, intervention: result.intervention }, { status: 201 });
}
