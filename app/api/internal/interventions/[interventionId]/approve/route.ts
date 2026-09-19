import { approveIntervention } from "@/lib/interventions/intervention-actions";
import { transitionHandler } from "@/lib/interventions/route-handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/internal/interventions/:id/approve
 *
 * Freezes the registered claim. Refused (409 intervention_needs_evidence)
 * while no supporting run is cited.
 */
export const POST = transitionHandler<null>({
  route: "intervention-approve",
  event: "intervention_approved",
  parse: () => ({ ok: true, value: null }),
  act: (client, id, actor, _input, onUnmapped) => approveIntervention(client, id, actor, onUnmapped),
});
