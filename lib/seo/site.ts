/**
 * The one canonical origin for every public URL Zypact emits.
 *
 * Everything that must agree on the site's address — canonical tags,
 * Open Graph URLs, JSON-LD, the sitemap, robots.txt — reads it from here, so
 * the host can never drift between two surfaces and hand Google two
 * competing versions of the same page.
 *
 * `www` is deliberate: it is the host Google has indexed and the host the
 * live deployment answers on. The apex must 301 to it at the platform/DNS
 * layer (Vercel domain settings), which is outside this repository.
 *
 * `NEXT_PUBLIC_SITE_URL` overrides it for preview and staging deployments so
 * a preview build never emits canonicals pointing at production. Any trailing
 * slash is stripped, because every caller joins paths onto this value.
 */

const FALLBACK_SITE_URL = "https://www.zypact.com";

function normalize(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

const configured = process.env.NEXT_PUBLIC_SITE_URL;

export const CANONICAL_SITE_URL: string =
  configured && configured.trim() !== ""
    ? normalize(configured)
    : FALLBACK_SITE_URL;

/** Absolute URL for a site-relative path. `canonicalUrl("/scan")`. */
export function canonicalUrl(path = "/"): string {
  if (!path.startsWith("/")) {
    return `${CANONICAL_SITE_URL}/${path}`;
  }
  return path === "/" ? CANONICAL_SITE_URL : `${CANONICAL_SITE_URL}${path}`;
}
