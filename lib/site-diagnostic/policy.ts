/**
 * The W1 fetch policy: every bound the diagnostic crawler works within.
 *
 * Canonical (docs/SELF_SERVICE_PRODUCT.md §6.2): at most 10 same-site pages
 * plus robots.txt, sitemap.xml and llms.txt; at most 5 redirects for
 * robots.txt; robots parsing stops at 500 KiB; robots cached at most 24 h; a
 * per-page timeout, a total time cap and a response-size cap; no login,
 * forms, JavaScript or paywalls; an identifiable user agent with a contact
 * URL.
 *
 * PROPOSED, pending founder approval (the docs give no numbers; D3 "fetch-
 * limit and rate-limit specification" is Not started): every numeric value
 * below other than those, the excluded-path list and the user-agent string.
 * They are versioned through W1_CRAWLER_VERSION so a stored run records which
 * policy produced it.
 *
 * Pure module.
 */
import { PAGE_CAP_MAX } from "@/lib/site-diagnostic/contract";

/** Bump whenever any value in W1_FETCH_POLICY or the crawler logic changes. */
export const W1_CRAWLER_VERSION = "zypact-w1-crawler/1.0.0";

/** robots.txt product token Zypact obeys (case-insensitive). */
export const W1_ROBOTS_PRODUCT_TOKEN = "zypactbot";

/** Identifiable, with a contact URL (§6.2). At most 300 characters. */
export const W1_USER_AGENT = "ZypactBot/1.0 (+https://www.zypact.com; website diagnostic)";

export const W1_FETCH_POLICY = Object.freeze({
  /** Page rows per run, failures included. Canonical: 10. */
  pageCap: PAGE_CAP_MAX,
  /** Redirect hops per resource. Canonical for robots.txt: 5. */
  maxRedirects: 5,
  /** Every HTTP request in a run, redirect hops and auxiliary files included. */
  maxRequestsPerRun: 40,
  /** Socket inactivity timeout per request. */
  requestIdleTimeoutMs: 8_000,
  /** Wall clock per request, DNS included. */
  requestDeadlineMs: 12_000,
  /** DNS lookup bound (default lookup has none). */
  dnsTimeoutMs: 5_000,
  /** Whole run. Below the preview route's maxDuration (60 s). */
  runDeadlineMs: 45_000,
  /** Pause between consecutive requests to the same site. */
  politenessDelayMs: 250,
  /** HTML page body cap; above it the page is recorded as size_cap. */
  htmlMaxBytes: 2_000_000,
  /** Canonical: robots parsing stops at 500 KiB (truncate, not reject). */
  robotsMaxBytes: 512_000,
  sitemapMaxBytes: 1_000_000,
  llmsTxtMaxBytes: 256_000,
  /** Links read from one page; the rest are ignored. */
  maxLinksPerPage: 1_000,
  /** Candidate URLs kept waiting to be fetched. */
  maxFrontier: 500,
  /** <loc> entries read from sitemap.xml. */
  maxSitemapUrls: 1_000,
});

export type W1FetchPolicy = typeof W1_FETCH_POLICY;

/**
 * Paths the crawler never requests (§6.2: no login, form submission or
 * paywalled content). Matched against each path segment, case-insensitive.
 */
export const W1_EXCLUDED_PATH_SEGMENTS: readonly string[] = [
  "login",
  "log-in",
  "signin",
  "sign-in",
  "signup",
  "sign-up",
  "register",
  "logout",
  "log-out",
  "signout",
  "sign-out",
  "account",
  "accounts",
  "my-account",
  "profile",
  "settings",
  "dashboard",
  "admin",
  "wp-admin",
  "wp-login.php",
  "auth",
  "oauth",
  "sso",
  "session",
  "password",
  "reset-password",
  "forgot-password",
  "cart",
  "basket",
  "checkout",
  "billing",
  "subscribe",
  "unsubscribe",
  "members",
  "member",
];

/** Asset extensions that are never HTML pages (copied from crawl-site.ts). */
export const W1_ASSET_PATH_RE =
  /\.(pdf|zip|rar|gz|tgz|dmg|exe|msi|png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|mp3|mp4|m4a|mov|avi|webm|wav|css|js|mjs|json|xml|txt|csv|xlsx?|docx?|pptx?|woff2?|ttf|otf|eot|rss|atom)$/i;
