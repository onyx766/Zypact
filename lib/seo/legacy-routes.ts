/**
 * What to tell Google about URLs from the previous Zypact site.
 *
 * The old marketing site is gone. Its URLs are still in Google's index and
 * currently answer 404, which Google keeps re-crawling for months while the
 * dead pages stay listed. This module is the single source of truth for the
 * correct answer per URL, consumed by `middleware.ts` at request time and by
 * `scripts/test-seo-contract.ts` as a contract.
 *
 * Two answers, and the choice between them is not cosmetic:
 *
 *   - `LEGACY_REDIRECTS` — 301, permanent. Use ONLY where the old URL has a
 *     genuine successor. A 301 passes the old URL's accumulated ranking
 *     signal to the new page. Redirecting an unrelated page to `/` instead
 *     is treated by Google as a soft 404 and helps nothing.
 *   - `LEGACY_GONE` — 410, gone. Use where nothing replaced the page. 410
 *     states the removal is intentional, and Google drops the URL faster
 *     than it drops a 404.
 *
 * Adding the Search Console export: put each URL's path in exactly one of
 * the two lists below. `assertLegacyRouteMapIsSound` (and the SEO contract
 * test) refuses a path that appears in both, a redirect target that is
 * itself a dead or redirected path, and any non-normalized path — so a
 * mistake fails a test rather than silently stranding a URL.
 */

export interface LegacyRedirect {
  /** Old path, lowercase, leading slash, no trailing slash, no query. */
  readonly from: string;
  /** Current path it genuinely replaces. */
  readonly to: string;
  /** Why this is a real successor, not a convenience redirect. */
  readonly reason: string;
}

/**
 * 301s. Every entry needs a real successor page.
 *
 * The `/demo`-style aliases are the plausible old paths behind the
 * "Request a Zypact V1 demo" sitelink Google still shows. They currently
 * 404, so pointing them at the live demo route can only help; confirm the
 * real path against the Search Console export and delete any that never
 * existed.
 */
export const LEGACY_REDIRECTS: readonly LegacyRedirect[] = [
  {
    from: "/v2",
    to: "/",
    reason:
      "Landing-page variant of the homepage. Same offer, so its signal belongs to /.",
  },
  {
    from: "/request-assessment",
    to: "/scan",
    reason:
      "The old 'request an assessment' entry point. /scan is the same action under the current offer: the visitor asks for a diagnostic and nothing runs until it is approved.",
  },
] as const;

/**
 * 410s. Indexed pages of the old site with no successor in the V1 app.
 *
 * `/how-it-works` is listed here rather than redirected to `/` on purpose:
 * Google still shows it as "How it works — 5 metrics, 4 AI …", a claim the
 * V1 methodology disclaims (single surface, directional, no fixed
 * multi-metric score — D-001/D-004). Its replacement is not the homepage; it
 * does not exist, and saying so is the honest answer.
 *
 * `/blog` is a 410 because nothing replaces it today. If a blog is planned,
 * move it out of this list before launch — a 410'd path can be re-indexed
 * later, but only after Google re-crawls it.
 */
export const LEGACY_GONE: readonly string[] = [
  // Old marketing pages.
  "/security",
  "/how-it-works",
  "/contact",
  "/methodology",
  "/pricing",
  "/privacy",
  "/100",

  // Blog and its one indexed post. Nothing replaces them today.
  "/blog",
  "/blog/harnessing-sentiment-ai-visibility-analytics",

  // The old free-tool funnel. These are deliberately NOT redirected to
  // /scan: each promised an instant self-serve score, which V1 does not
  // offer and D-001/D-010 specifically retired. Pointing them at the demo
  // request would advertise the same promise under a new URL, and Google
  // treats a redirect to materially different content as a soft 404 anyway.
  "/grader",
  "/qualification",
  "/check",
  "/audit",

  // Placeholder URLs the previous site leaked through its structured data
  // (`/search?q={search_term_string}`, `/audit?domain={domain}`), which
  // Google then crawled literally. The current JSON-LD declares no such
  // SearchAction, so nothing regenerates them.
  "/search",
] as const;

/**
 * Paths that stay reachable but must never appear in search results.
 *
 * These are served with `X-Robots-Tag: noindex, nofollow` rather than being
 * disallowed in robots.txt, because a disallowed URL is never crawled and a
 * noindex Google cannot read is a noindex Google cannot obey. Anything truly
 * private (`/admin`, `/api`, `/projects`, `/report`) is blocked from
 * crawling in robots.txt instead — those must not be fetched at all.
 */
export const NOINDEX_PATH_PREFIXES: readonly string[] = [
  "/login",
  "/verify-email",
  "/thank-you",
] as const;

/** Never crawled: private surfaces and anything carrying client evidence. */
export const DISALLOWED_PATH_PREFIXES: readonly string[] = [
  "/admin",
  "/api",
  "/projects",
  "/report",
] as const;

/** Public, indexable pages. The sitemap is exactly this list. */
export const INDEXABLE_PATHS: readonly string[] = [
  "/",
  "/about",
  "/method",
  "/scan",
  "/perplexity-content-change-test",
] as const;

const redirectByPath = new Map(
  LEGACY_REDIRECTS.map((entry) => [entry.from, entry.to])
);

const gonePaths = new Set(LEGACY_GONE);

/**
 * Normalizes a request path for lookup: lowercased, query/hash already
 * stripped by the caller, and a trailing slash removed so `/about/` and
 * `/about` cannot disagree. Root stays `/`.
 */
export function normalizeLegacyPath(pathname: string): string {
  const lowered = pathname.toLowerCase();
  if (lowered === "/") return "/";
  return lowered.replace(/\/+$/, "");
}

/** The 301 target for a legacy path, or null if it is not a redirect. */
export function legacyRedirectTarget(pathname: string): string | null {
  return redirectByPath.get(normalizeLegacyPath(pathname)) ?? null;
}

/** Whether a legacy path should answer 410 Gone. */
export function isLegacyGone(pathname: string): boolean {
  return gonePaths.has(normalizeLegacyPath(pathname));
}

/** Whether a path must be served with a noindex header. */
export function isNoindexPath(pathname: string): boolean {
  const path = normalizeLegacyPath(pathname);
  return NOINDEX_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  );
}

/**
 * Structural checks over the map itself.
 *
 * Returns every problem found rather than throwing on the first, so a bulk
 * paste from Search Console reports all of its mistakes at once.
 */
export function assertLegacyRouteMapIsSound(): string[] {
  const problems: string[] = [];

  const wellFormed = (path: string, label: string) => {
    if (!path.startsWith("/")) {
      problems.push(`${label} "${path}" must start with "/"`);
    }
    if (path !== "/" && path.endsWith("/")) {
      problems.push(`${label} "${path}" must not end with "/"`);
    }
    if (path !== path.toLowerCase()) {
      problems.push(`${label} "${path}" must be lowercase`);
    }
    if (path.includes("?") || path.includes("#")) {
      problems.push(`${label} "${path}" must not carry a query or hash`);
    }
  };

  for (const { from, to } of LEGACY_REDIRECTS) {
    wellFormed(from, "redirect source");
    wellFormed(to, "redirect target");

    if (from === to) {
      problems.push(`redirect "${from}" points at itself`);
    }
    if (gonePaths.has(from)) {
      problems.push(`"${from}" is both redirected and 410 gone`);
    }
    if (gonePaths.has(to)) {
      problems.push(`redirect "${from}" targets 410-gone "${to}"`);
    }
    if (redirectByPath.has(to)) {
      problems.push(
        `redirect "${from}" targets "${to}", which is itself redirected (chain)`
      );
    }
  }

  const seen = new Set<string>();
  for (const { from } of LEGACY_REDIRECTS) {
    if (seen.has(from)) problems.push(`duplicate redirect source "${from}"`);
    seen.add(from);
  }

  for (const path of LEGACY_GONE) {
    wellFormed(path, "gone path");
    if (INDEXABLE_PATHS.includes(path)) {
      problems.push(`"${path}" is both indexable and 410 gone`);
    }
  }

  for (const path of INDEXABLE_PATHS) {
    wellFormed(path, "indexable path");
    if (redirectByPath.has(path)) {
      problems.push(`indexable "${path}" is also redirected away`);
    }
    if (isNoindexPath(path)) {
      problems.push(`indexable "${path}" is also marked noindex`);
    }
    if (
      DISALLOWED_PATH_PREFIXES.some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`)
      )
    ) {
      problems.push(`indexable "${path}" is disallowed in robots.txt`);
    }
  }

  // A path blocked from crawling can never be read, so a noindex on it is a
  // contradiction: Google would keep the URL listed without ever seeing the
  // instruction to drop it.
  for (const prefix of NOINDEX_PATH_PREFIXES) {
    if (
      DISALLOWED_PATH_PREFIXES.some(
        (blocked) => prefix === blocked || prefix.startsWith(`${blocked}/`)
      )
    ) {
      problems.push(
        `"${prefix}" is noindex but also disallowed — the noindex can never be read`
      );
    }
  }

  return problems;
}
