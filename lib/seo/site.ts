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

function resolveSiteUrl(configured: string | undefined): string {
  return configured && configured.trim() !== ""
    ? normalize(configured)
    : FALLBACK_SITE_URL;
}

export const CANONICAL_SITE_URL: string = resolveSiteUrl(
  process.env.NEXT_PUBLIC_SITE_URL
);

/**
 * The same origin, read at call time rather than at module load.
 *
 * For links in customer email — report and Outcome Card deliveries, from the
 * web routes and from the workers alike. Every one of those paths reads this,
 * so a card sent by the worker and one sent by the founder can never point at
 * different hosts. Call-time because the send paths have always read the
 * variable per call, and their tests set it after import.
 *
 * On staging this must be the staging host: a link to the production host
 * carries a staging token production has never seen, and answers 404.
 */
export function publicSiteUrl(): string {
  return resolveSiteUrl(process.env.NEXT_PUBLIC_SITE_URL);
}

/** Absolute URL for a site-relative path. `canonicalUrl("/scan")`. */
export function canonicalUrl(path = "/"): string {
  if (!path.startsWith("/")) {
    return `${CANONICAL_SITE_URL}/${path}`;
  }
  return path === "/" ? CANONICAL_SITE_URL : `${CANONICAL_SITE_URL}${path}`;
}
