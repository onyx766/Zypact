/**
 * Server-side authenticated-user helpers.
 *
 * `getCurrentUser`   — soft check; returns `null` when no session.
 * `requireCurrentUser` — hard gate; throws `UnauthorizedError` (→ 401).
 * `requireProjectOwner` — hard gate; throws `UnauthorizedError` /
 *   `NotFoundError` following Sprint 10.5's non-owner-as-404 rule (see
 *   below).
 *
 * ## Ownership guard rule (Sprint 10.5)
 *
 * The HTTP response codes intentionally diverge from a naïve REST
 * mapping. When the project row exists but the caller does not own it,
 * we return **404**, not 403. Returning 403 confirms that the
 * `projectId` exists and lets an attacker enumerate valid ids by
 * scanning the response code. We log the real reason
 * (`ownership_denied`) server-side for debugging, but the wire
 * response is indistinguishable from "project does not exist".
 *
 * Legacy rows with `user_id IS NULL` are treated as *not owned by
 * anyone* and therefore not accessible via protected routes. They
 * exist in the DB because migrations 0001-0009 pre-date the auth
 * surface; per the sprint brief we do NOT backfill them.
 */

import { notFound, redirect } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getDb } from "@/lib/db";
import type { Project } from "@/lib/db/types";
import { isEmailAllowed } from "@/lib/auth/access-allowlist";

export class UnauthorizedError extends Error {
  readonly code = "unauthorized" as const;
  constructor(message = "unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class NotFoundError extends Error {
  readonly code = "not_found" as const;
  /**
   * Server-side-only reason for structured logging. Never included in
   * the HTTP response body — clients only ever see a generic 404.
   */
  readonly reason: "project_not_found" | "ownership_denied" | "legacy_null_owner";
  constructor(reason: NotFoundError["reason"], message = "not_found") {
    super(message);
    this.name = "NotFoundError";
    this.reason = reason;
  }
}

/**
 * Signed in, but not on the access allowlist (lib/auth/access-allowlist.ts).
 * A 403 rather than the 404 used for ownership: it says nothing about any
 * project, only that this account has not been invited.
 */
export class ForbiddenError extends Error {
  readonly code = "not_invited" as const;
  constructor(message = "not_invited") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export interface CurrentUser {
  id: string;
  email: string | null;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return {
    id: data.user.id,
    email: data.user.email ?? null,
  };
}

/**
 * Signed in, nothing more. Every caller must apply a stricter check of its
 * own: the founder routes require a founder (always on the access
 * allowlist), and anything open to non-founders goes through
 * `requireInvitedUser` instead. scripts/test-paid-execution-guards.ts fails
 * if a route calls this without a founder check.
 */
export async function requireCurrentUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

/**
 * Signed in AND on the access allowlist (lib/auth/access-allowlist.ts).
 * The gate for every route and page a non-founder may use.
 */
export async function requireInvitedUser(): Promise<CurrentUser> {
  const user = await requireCurrentUser();
  if (!isEmailAllowed(user.email)) throw new ForbiddenError();
  return user;
}

/**
 * Load a project and verify the current user owns it.
 *
 * Contract:
 *   - No session          → `UnauthorizedError` (401)
 *   - Not on the allowlist → `ForbiddenError` (403)
 *   - Project missing     → `NotFoundError("project_not_found")` (404)
 *   - Owner is another user → `NotFoundError("ownership_denied")` (404)
 *   - Owner is NULL       → `NotFoundError("legacy_null_owner")` (404)
 *   - Owner matches user  → returns `{ user, project }`
 */
export async function requireProjectOwner(
  projectId: string
): Promise<{ user: CurrentUser; project: Project }> {
  const user = await requireInvitedUser();
  const project = await getDb().getProject(projectId);
  if (!project) {
    throw new NotFoundError("project_not_found");
  }
  if (project.userId === null) {
    throw new NotFoundError("legacy_null_owner");
  }
  if (project.userId !== user.id) {
    throw new NotFoundError("ownership_denied");
  }
  return { user, project };
}

/**
 * Server-Component variant of `requireProjectOwner`. Uses Next.js
 * navigation primitives instead of throwing typed errors:
 *
 *   - No session → `redirect("/login?next=<current>")`
 *   - Any not-found / non-owner / legacy-null-owner → `notFound()`
 *     (renders the nearest `not-found.tsx` — same UX as a 404, no
 *     enumeration signal)
 *
 * Server-side console logs still carry the true reason for operators.
 */
export async function requireProjectOwnerForPage(
  projectId: string,
  currentPath: string
): Promise<{ user: CurrentUser; project: Project }> {
  const user = await getCurrentUser();
  if (!user) {
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        event: "auth_denied",
        route: currentPath,
        reason: "unauthorized",
        projectId,
      })
    );
    redirect(`/login?next=${encodeURIComponent(currentPath)}`);
  }
  if (!isEmailAllowed(user.email)) {
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        event: "auth_denied",
        route: currentPath,
        reason: "not_invited",
        projectId,
      })
    );
    redirect(`/login?error=${encodeURIComponent("This account has not been invited.")}`);
  }
  const project = await getDb().getProject(projectId);
  let reason: NotFoundError["reason"] | null = null;
  if (!project) reason = "project_not_found";
  else if (project.userId === null) reason = "legacy_null_owner";
  else if (project.userId !== user.id) reason = "ownership_denied";

  if (reason) {
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        event: "auth_denied",
        route: currentPath,
        reason,
        projectId,
      })
    );
    notFound();
  }
  return { user, project: project! };
}
