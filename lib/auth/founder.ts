import { notFound, redirect } from "next/navigation";
import { NextResponse } from "next/server";
import {
  getCurrentUser,
  requireCurrentUser,
  type CurrentUser,
} from "@/lib/auth/current-user";
import { authErrorResponse } from "@/lib/auth/route-helpers";
import {
  FOUNDER_ADMIN_PATH,
} from "@/lib/auth/safe-next-path";

export function getFounderEmailAllowlist(): Set<string> {
  return new Set(
    (process.env.SNAPSHOT_FOUNDER_EMAILS || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isFounderEmail(
  email: string | null | undefined
): boolean {
  const normalized = email?.trim().toLowerCase();

  return Boolean(
    normalized &&
      getFounderEmailAllowlist().has(normalized)
  );
}

/**
 * The founder decision for an already-authenticated user, with no I/O.
 *
 * Split out from `requireFounderForRoute` so the decision itself is testable
 * without a session: the three outcomes, and the fact that an empty allowlist
 * is a configuration error rather than "nobody is a founder", are the part
 * worth pinning.
 */
export function evaluateFounderAccess(
  email: string | null | undefined,
  allowlist: Set<string>
): "founder" | "not_founder" | "allowlist_missing" {
  if (allowlist.size === 0) return "allowlist_missing";
  const normalized = email?.trim().toLowerCase();
  return normalized && allowlist.has(normalized) ? "founder" : "not_founder";
}

export type FounderRouteGuard =
  | { ok: true; user: CurrentUser }
  | { ok: false; response: NextResponse };

/**
 * The route-handler counterpart of `requireFounderForPage`.
 *
 * Semantics match the existing founder routes under
 * `app/api/internal/snapshot-requests/*` exactly, which each inline this
 * logic today:
 *
 *   - no session              → 401
 *   - allowlist not configured → 503, logged as a configuration error. An
 *     empty allowlist must never read as "every signed-in user is refused
 *     for a legitimate reason"; it means the deployment is misconfigured.
 *   - signed in, not a founder → 404, never 403, so the route's existence is
 *     not disclosed. The real reason is logged server-side only.
 *
 * The existing snapshot routes are deliberately not migrated onto this in
 * the same change. They work, they are tested, and moving them is a
 * separate refactor with its own review.
 */
export async function requireFounderForRoute(
  route: string
): Promise<FounderRouteGuard> {
  let user: CurrentUser;

  try {
    user = await requireCurrentUser();
  } catch (error) {
    const response = authErrorResponse(error, { route, projectId: null });
    if (response) return { ok: false, response };
    throw error;
  }

  const decision = evaluateFounderAccess(
    user.email,
    getFounderEmailAllowlist()
  );

  if (decision === "allowlist_missing") {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event: "founder_route_configuration_error",
        route,
        reason: "missing_founder_allowlist",
      })
    );
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "temporarily_unavailable" },
        { status: 503 }
      ),
    };
  }

  if (decision === "not_founder") {
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        event: "founder_route_denied",
        route,
        reason: "not_founder",
        userId: user.id,
      })
    );
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "not_found" },
        { status: 404 }
      ),
    };
  }

  return { ok: true, user };
}

export async function requireFounderForPage(
  currentPath = FOUNDER_ADMIN_PATH
): Promise<CurrentUser> {
  const user = await getCurrentUser();

  if (!user) {
    redirect(
      `/login?next=${encodeURIComponent(currentPath)}`
    );
  }

  const allowlist = getFounderEmailAllowlist();

  if (allowlist.size === 0) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event: "founder_admin_configuration_error",
        reason: "missing_founder_allowlist",
      })
    );

    notFound();
  }

  if (!isFounderEmail(user.email)) {
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        event: "founder_admin_denied",
        reason: "not_founder",
        userId: user.id,
      })
    );

    notFound();
  }

  return user;
}
