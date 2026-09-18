/**
 * The opening lines every `/api/internal/interventions/*` route shares.
 *
 * Order matters and mirrors the snapshot approval route:
 *
 *   1. Kill switch. `INTERVENTION_ADMIN_ENABLED` must be exactly "true", or
 *      every intervention route answers 503 before touching auth or the
 *      database. These routes lead to paid provider execution (a created
 *      retest is enqueued), so they fail closed — an unset variable on a new
 *      deployment disables them rather than exposing them.
 *   2. Founder guard. 401 / 503 / 404, per `requireFounderForRoute`.
 *
 * A route must not read request bodies, path params or the database before
 * this returns `ok: true`.
 */

import { NextResponse } from "next/server";
import { requireFounderForRoute, type FounderRouteGuard } from "@/lib/auth/founder";
import type { MappedRpcFailure } from "@/lib/interventions/rpc-errors";

export const INTERVENTION_ADMIN_FLAG = "INTERVENTION_ADMIN_ENABLED";

export function interventionAdminEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env[INTERVENTION_ADMIN_FLAG] === "true";
}

export async function guardInterventionRoute(
  route: string
): Promise<FounderRouteGuard> {
  if (!interventionAdminEnabled()) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "temporarily_unavailable" },
        { status: 503 }
      ),
    };
  }
  return requireFounderForRoute(route);
}

export function failureResponse(failure: MappedRpcFailure): NextResponse {
  return NextResponse.json(
    { ok: false, error: failure.error, message: failure.message },
    { status: failure.status }
  );
}

/**
 * Closed-field log for an RPC error that `mapRpcError` did not recognise.
 * The raw message goes to the server log only — it is the one place it is
 * useful and the one place it cannot leak.
 */
export function logUnmappedRpcError(
  route: string,
  detail: { code: string | null; message: string | null }
): void {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      event: "intervention_rpc_unmapped_error",
      route,
      code: detail.code,
      message: detail.message,
    })
  );
}
