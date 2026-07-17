export const FOUNDER_ADMIN_PATH =
  "/admin/snapshot-requests";

export function safeNextPath(
  value: string | null | undefined,
  fallback = FOUNDER_ADMIN_PATH
): string {
  const candidate = value?.trim();

  if (
    !candidate ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\")
  ) {
    return fallback;
  }

  return candidate;
}
