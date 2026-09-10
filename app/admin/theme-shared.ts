/**
 * Theme values shared by the server page (which reads the cookie, so the
 * first paint is already in the right theme) and the client toggle (which
 * writes it). Kept out of theme.tsx because a server component that imports
 * a plain value from a "use client" module receives a client reference, not
 * the value.
 */

export type AdminTheme = "light" | "dark";

export const ADMIN_THEME_COOKIE = "zp_admin_theme";

/** Dark unless the founder has explicitly chosen light. */
export function parseAdminTheme(value: string | undefined): AdminTheme {
  return value === "light" ? "light" : "dark";
}
