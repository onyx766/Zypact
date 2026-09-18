import { authorizeEarlyRetest } from "@/lib/interventions/intervention-actions";
import { transitionHandler } from "@/lib/interventions/route-handlers";
import { parseReasonBody } from "@/lib/interventions/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/internal/interventions/:id/authorize-early-retest   body: { reason }
 *
 * Records a permanent deviation: the retest may start before the observation
 * window closes. The reason is immutable once written.
 */
export const POST = transitionHandler<string>({
  route: "intervention-authorize-early-retest",
  event: "intervention_early_retest_authorized",
  parse: (body) => parseReasonBody(body, "A reason for the early retest"),
  act: (client, id, actor, reason, onUnmapped) => authorizeEarlyRetest(client, id, actor, reason, onUnmapped),
});
