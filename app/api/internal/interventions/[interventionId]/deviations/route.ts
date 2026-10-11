import { recordDeviation } from "@/lib/interventions/intervention-actions";
import { transitionHandler } from "@/lib/interventions/route-handlers";
import { parseDeviationBody } from "@/lib/interventions/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/internal/interventions/:id/deviations   body: { note }
 *
 * Appends one note to the insert-only deviation ledger (migration 0082).
 * Accepted only while the intervention is 'implemented'; 409 otherwise. The
 * database stamps who recorded it, when, and whether the retest had already
 * produced attempts or the Outcome Card had already been delivered. A repeat
 * of the same note is answered as a success and writes nothing.
 */
export const POST = transitionHandler<string>({
  route: "intervention-deviation",
  event: "intervention_deviation_recorded",
  parse: parseDeviationBody,
  act: (client, id, actor, note, onUnmapped) => recordDeviation(client, id, actor, note, onUnmapped),
});
