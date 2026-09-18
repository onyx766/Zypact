import { rejectIntervention } from "@/lib/interventions/intervention-actions";
import { transitionHandler } from "@/lib/interventions/route-handlers";
import { parseReasonBody } from "@/lib/interventions/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/internal/interventions/:id/reject   body: { reason }
 *
 * Proposals only. An approved intervention cannot be rejected — its claim is
 * frozen, and the honest exit is abandonment.
 */
export const POST = transitionHandler<string>({
  route: "intervention-reject",
  event: "intervention_rejected",
  parse: (body) => parseReasonBody(body, "A rejection reason"),
  act: (client, id, actor, reason, onUnmapped) => rejectIntervention(client, id, actor, reason, onUnmapped),
});
