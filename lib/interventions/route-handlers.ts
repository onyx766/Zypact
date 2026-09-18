/**
 * The one shape every intervention transition route shares:
 *
 *   guard → validate path id → parse body → act → respond
 *
 * in that order, and never out of it: nothing reads the body, the path or the
 * database before the kill switch and founder guard have passed.
 */

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getReportServiceClient } from "@/lib/reports/service-client";
import {
  failureResponse,
  guardInterventionRoute,
  logUnmappedRpcError,
} from "@/lib/interventions/route-guard";
import type { ActionResult } from "@/lib/interventions/intervention-actions";
import { UUID_PATTERN, type Validated } from "@/lib/interventions/validate";

export type RouteContext = { params: Promise<{ interventionId: string }> };

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export function invalidId(): NextResponse {
  return NextResponse.json(
    { ok: false, error: "invalid_intervention_id", message: "That is not a valid intervention ID." },
    { status: 400 }
  );
}

export function validationResponse(v: { error: string; message: string }): NextResponse {
  return NextResponse.json({ ok: false, error: v.error, message: v.message }, { status: 400 });
}

/**
 * Builds a POST handler for one intervention transition.
 *
 * `parse` turns the body into the action's input; `act` performs it. A
 * transition that needs no body (approve) passes a parse that ignores it.
 */
export function transitionHandler<T>(config: {
  route: string;
  event: string;
  parse: (body: unknown) => Validated<T>;
  act: (
    client: SupabaseClient,
    interventionId: string,
    actor: string,
    input: T,
    onUnmapped: (d: { code: string | null; message: string | null }) => void
  ) => Promise<ActionResult>;
}) {
  return async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
    const guard = await guardInterventionRoute(config.route);
    if (!guard.ok) return guard.response;

    const { interventionId } = await context.params;
    if (!UUID_PATTERN.test(interventionId)) return invalidId();

    const parsed = config.parse(await readJsonBody(request));
    if (!parsed.ok) return validationResponse(parsed);

    const result = await config.act(
      getReportServiceClient(),
      interventionId,
      guard.user.id,
      parsed.value,
      (d) => logUnmappedRpcError(config.route, d)
    );

    if (!result.ok) return failureResponse(result.failure);

    // Closed fields only: no hypothesis, reason, evidence or target text,
    // which can carry client-confidential detail.
    console.info(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        event: config.event,
        interventionId: result.intervention.id,
        projectId: result.intervention.projectId,
        actor: guard.user.id,
        status: result.intervention.status,
      })
    );

    return NextResponse.json({ ok: true, intervention: result.intervention }, { status: 200 });
  };
}
