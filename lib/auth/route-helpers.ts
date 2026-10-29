/**
 * Route-level helpers that turn `UnauthorizedError` / `NotFoundError`
 * into safe `NextResponse` payloads.
 *
 * Contract (Sprint 10.5):
 *  - 401 for missing session.
 *  - 403 for a session whose email is not on the access allowlist.
 *  - 404 for BOTH "project not found" AND "authenticated but not owner"
 *    AND "legacy null-owner project" — to prevent id enumeration.
 *  - Server-side console log records the *real* reason on the deny
 *    path (`ownership_denied` / `legacy_null_owner`) so operators can
 *    still see what happened without leaking it over the wire.
 */

import { NextResponse } from "next/server";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "./current-user";
import { readPaidExecutionConfig } from "@/lib/worker-control/paid-execution-gate";

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
  if (err instanceof ForbiddenError) {
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        event: "auth_denied",
        route: ctx.route,
        reason: "not_invited",
        projectId: ctx.projectId ?? null,
      })
    );
    return NextResponse.json(
      { ok: false, error: "not_invited" },
      { status: 403 }
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

/**
 * The legacy Sprint pipeline routes (`app/api/projects/*` that call an LLM
 * in the web process). Their spend never reaches the protocol ledger, so the
 * daily ceiling cannot count it, and they still carry the won/lost
 * vocabulary V1 retired. Off unless BOTH switches are explicitly on:
 *
 *   ZYPACT_LEGACY_PIPELINE_ENABLED=true   and   paid execution enabled
 *   (lib/worker-control/paid-execution-gate.ts)
 *
 * Returns the refusal to send, or null when the route may proceed. Checked
 * before authentication and before any work, so a refused call does nothing.
 */
export function legacyPipelineRefusal(
  route: string,
  env: Record<string, string | undefined> = process.env
): NextResponse | null {
  const enabled =
    env.ZYPACT_LEGACY_PIPELINE_ENABLED?.trim() === "true" &&
    readPaidExecutionConfig(env).enabled;
  if (enabled) return null;
  console.warn(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "warn",
      event: "legacy_pipeline_refused",
      route,
    })
  );
  return NextResponse.json(
    { ok: false, error: "legacy_pipeline_disabled" },
    { status: 403 }
  );
}
