import { NextResponse } from "next/server";
import { getReportServiceClient } from "@/lib/reports/service-client";
import { failureResponse, guardInterventionRoute } from "@/lib/interventions/route-guard";
import { generateOutcomeCard } from "@/lib/interventions/outcome-card-actions";
import { invalidId, type RouteContext } from "@/lib/interventions/route-handlers";
import { UUID_PATTERN } from "@/lib/interventions/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ROUTE = "intervention-outcome-card-generate";

/**
 * POST /api/internal/interventions/:id/outcome-card
 *
 * Builds, classifies and saves the Outcome Card from the baseline and the
 * FINISHED retest, through the same pipeline the scheduled worker runs.
 * Never sends: auto-send is forced off on this path. Regenerating replaces
 * an undelivered card; a delivered card cannot be replaced.
 */
export async function POST(_request: Request, context: RouteContext) {
  const guard = await guardInterventionRoute(ROUTE);
  if (!guard.ok) return guard.response;

  const { interventionId } = await context.params;
  if (!UUID_PATTERN.test(interventionId)) return invalidId();

  const generated = await generateOutcomeCard(getReportServiceClient(), interventionId);
  if (!generated.ok) return failureResponse(generated.failure);

  const r = generated.result;
  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "outcome_card_generated",
      interventionId,
      artifactId: r.artifactId,
      outcome: r.outcome,
      integrityStatus: r.integrityStatus,
      actor: guard.user.id,
    })
  );

  return NextResponse.json(
    {
      ok: true,
      artifactId: r.artifactId,
      integrityStatus: r.integrityStatus,
      integrityReasons: r.integrityReasons,
      outcome: r.outcome,
    },
    { status: 200 }
  );
}
