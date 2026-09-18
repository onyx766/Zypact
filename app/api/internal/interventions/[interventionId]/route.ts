import { NextResponse } from "next/server";
import { getReportServiceClient } from "@/lib/reports/service-client";
import { guardInterventionRoute } from "@/lib/interventions/route-guard";
import { readEligibility, readIntervention } from "@/lib/interventions/intervention-actions";
import { invalidId, type RouteContext } from "@/lib/interventions/route-handlers";
import { UUID_PATTERN } from "@/lib/interventions/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/internal/interventions/:id — the row plus the authority's eligibility answer. */
export async function GET(_request: Request, context: RouteContext) {
  const guard = await guardInterventionRoute("intervention-detail");
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

  const eligibility = await readEligibility(client, intervention);
  return NextResponse.json({ ok: true, intervention, eligibility }, { status: 200 });
}
