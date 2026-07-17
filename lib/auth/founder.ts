import { notFound, redirect } from "next/navigation";
import {
  getCurrentUser,
  type CurrentUser,
} from "@/lib/auth/current-user";
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
