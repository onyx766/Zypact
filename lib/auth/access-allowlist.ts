/**
 * Who may use any authenticated part of the product.
 *
 * Signing in proves an email address, nothing more: Supabase still accepts
 * new sign-ups unless `disable_signup` is set, so a session alone must not
 * open a paid route or a project page. Access is the union of:
 *
 *   ZYPACT_ALLOWED_EMAILS     invited testers, comma-separated
 *   SNAPSHOT_FOUNDER_EMAILS   founders (the same list lib/auth/founder.ts reads)
 *
 * so founder access is never lost by adding this check. With neither set,
 * nobody is allowed: an empty list is a closed door, not an open one.
 *
 * Read here directly rather than imported from founder.ts, which imports
 * current-user.ts and would make this a cycle.
 */

function parseEmailList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function getAccessAllowlist(
  env: Record<string, string | undefined> = process.env
): Set<string> {
  return new Set([
    ...parseEmailList(env.ZYPACT_ALLOWED_EMAILS),
    ...parseEmailList(env.SNAPSHOT_FOUNDER_EMAILS),
  ]);
}

export function isEmailAllowed(
  email: string | null | undefined,
  allowlist: Set<string> = getAccessAllowlist()
): boolean {
  const normalized = email?.trim().toLowerCase();
  return Boolean(normalized && allowlist.has(normalized));
}
