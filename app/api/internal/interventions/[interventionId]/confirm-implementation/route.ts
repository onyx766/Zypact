import { confirmImplementation } from "@/lib/interventions/intervention-actions";
import { transitionHandler } from "@/lib/interventions/route-handlers";
import { parseConfirmBody, type ConfirmInput } from "@/lib/interventions/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/internal/interventions/:id/confirm-implementation
 * body: { evidence: {...}, artifactSha256?, deviations? }
 *
 * Opens the observation window. Its closing instant is computed once, here,
 * and frozen — so this is a verification step, deliberately founder-only.
 */
export const POST = transitionHandler<ConfirmInput>({
  route: "intervention-confirm-implementation",
  event: "intervention_implementation_confirmed",
  parse: parseConfirmBody,
  act: (client, id, actor, input, onUnmapped) => confirmImplementation(client, id, actor, input, onUnmapped),
});
