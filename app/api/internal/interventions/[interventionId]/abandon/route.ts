import { abandonIntervention } from "@/lib/interventions/intervention-actions";
import { transitionHandler } from "@/lib/interventions/route-handlers";
import { parseReasonBody } from "@/lib/interventions/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/internal/interventions/:id/abandon   body: { reason }
 *
 * Refused with 409 retest_already_started once the retest has produced an
 * attempt or has a claimed/running job (migration 0077). Before that, it
 * also takes the live retest protocol down and cancels its queued job.
 */
export const POST = transitionHandler<string>({
  route: "intervention-abandon",
  event: "intervention_abandoned",
  parse: (body) => parseReasonBody(body, "An abandonment reason"),
  act: (client, id, actor, reason, onUnmapped) => abandonIntervention(client, id, actor, reason, onUnmapped),
});
