/**
 * Route-level helpers that turn `UnauthorizedError` / `NotFoundError`
 * into safe `NextResponse` payloads.
 *
 * Contract (Sprint 10.5):
 *  - 401 for missing session.
 *  - 404 for BOTH "project not found" AND "authenticated but not owner"
 *    AND "legacy null-owner project" — to prevent id enumeration.
 *  - Server-side console log records the *real* reason on the deny
 *    path (`ownership_denied` / `legacy_null_owner`) so operators can
 *    still see what happened without leaking it over the wire.
 */

import { NextResponse } from "next/server";
import { NotFoundError, UnauthorizedError } from "./current-user";

export interface AuthGuardLogContext {
  route: string;
  projectId?: string | null;
}

export function authErrorResponse(
  err: unknown,
  ctx: AuthGuardLogContext
): NextResponse | null {
  if (err instanceof UnauthorizedError) {
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        event: "auth_denied",
        route: ctx.route,
        reason: "unauthorized",
        projectId: ctx.projectId ?? null,
      })
    );
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 }
    );
  }
  if (err instanceof NotFoundError) {
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        event: "auth_denied",
        route: ctx.route,
        reason: err.reason,
        projectId: ctx.projectId ?? null,
      })
    );
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404 }
    );
  }
  return null;
}
