/**
 * Shared W1 types. Pure declarations.
 *
 * Shape rule: everything in `CrawlCapture` is serialisable and safe to keep
 * (sanitised URLs, statuses, hashes, counts). Page bodies never enter it;
 * they travel separately in `PageBodies`, which only the rules read and
 * nothing serialises.
 */
import type { ParsedRobots, RobotsPolicyKind } from "@/lib/crawler/robots";
import type {
  Detail,
  FindingState,
  PageFetchError,
  RunOutcome,
  UnknownReason,
} from "@/lib/site-diagnostic/contract";
import type { NormalizedInput } from "@/lib/site-diagnostic/url";

export const BUYER_CATEGORIES = [
  "product",
  "pricing",
  "integrations",
  "security",
  "comparison",
  "docs",
  "faq",
  "customer_stories",
] as const;
export type BuyerCategory = (typeof BUYER_CATEGORIES)[number];

export type ResourceKind = "page" | "robots" | "sitemap" | "llms_txt";

export interface RedirectHop {
  /** Sanitised URL that answered with a redirect. */
  url: string;
  status: number;
}

/** One fetched (or deliberately not fetched) resource. */
export interface FetchRecord {
  kind: ResourceKind;
  /** 0-based fetch order among page rows; null for auxiliary files. */
  pageIndex: number | null;
  /** Sanitised URL the content belongs to (the final URL after redirects). */
  url: string;
  /** Sanitised URL that was first requested. */
  requestedUrl: string;
  /** A query was present on the URL and dropped (pages skip query URLs). */
  queryPresent: boolean;
  redirectChain: RedirectHop[];
  /** ISO time from the injected clock; null when no request was made. */
  fetchedAt: string | null;
  httpStatus: number | null;
  /** At most 200 characters (CONTENT_TYPE_MAX). */
  contentType: string | null;
  /** Byte length of the stored body hash basis (raw bytes received). */
  bytes: number;
  /** sha256 of the raw body bytes; null exactly when bytes is 0. */
  bodySha256: string | null;
  truncated: boolean;
  robotsAllowed: boolean;
  fetchError: PageFetchError | null;
  /** Pages only: buyer category from the URL path, if any. */
  category: BuyerCategory | null;
  discoveredVia: "start" | "link" | "sitemap" | "fixed_path";
}

/** Why the crawl stopped requesting pages. */
export type StopReason =
  | "frontier_exhausted"
  | "page_cap"
  | "request_budget"
  | "deadline"
  | "robots_unavailable"
  | "homepage_unavailable"
  | "cancelled";

/** A same-site link the crawl saw, whether or not it fetched it. */
export interface LinkCandidate {
  url: string;
  category: BuyerCategory | null;
  /** What became of it. */
  fate:
    | "fetched"
    | "not_fetched"
    | "blocked_by_robots"
    | "fetch_failed"
    | "timeout"
    | "size_cap"
    | "not_html"
    | "duplicate";
}

export interface SitemapSummary {
  format: "urlset" | "sitemapindex" | "invalid";
  urlCount: number;
  sameSiteUrlCount: number;
  source: "robots_directive" | "default_path";
}

export interface LlmsTxtSummary {
  startsWithHeading: boolean;
}

export interface CrawlCapture {
  input: NormalizedInput;
  startedAt: string;
  completedAt: string;
  outcome: RunOutcome;
  stopReason: StopReason;
  /** robots.txt of the start origin. */
  robots: {
    policyKind: RobotsPolicyKind;
    record: FetchRecord | null;
    /** Null unless policyKind is "parsed". Rules only, no free text kept. */
    parsed: ParsedRobots | null;
  };
  sitemap: { record: FetchRecord | null; summary: SitemapSummary | null };
  llmsTxt: { record: FetchRecord | null; summary: LlmsTxtSummary | null };
  pages: FetchRecord[];
  candidates: LinkCandidate[];
  requestCount: number;
  /** The page cap, request budget or deadline stopped the crawl. */
  capReached: boolean;
}

/** In-memory only. Keyed by pageIndex. Never serialised or persisted. */
export type PageBodies = ReadonlyMap<
  number,
  { bytes: Uint8Array; headers: Readonly<Record<string, string>> }
>;

export interface FindingExcerpt {
  /** At most 300 code points, screened for personal data. */
  text: string;
  /** UTF-8 byte offsets into the page's raw body bytes. */
  start: number;
  end: number;
  /** Equals the cited page's bodySha256. */
  bodySha256: string;
  piiScreenVersion: string;
}

export interface Finding {
  checkId: string;
  ruleVersion: string;
  state: FindingState;
  /** Present exactly when state is "unknown". */
  unknownReason: UnknownReason | null;
  /** Cited page row, or null for a run-level finding. */
  pageIndex: number | null;
  excerpt: FindingExcerpt | null;
  /** Validated against the check's spec; persisted as NULL until approved. */
  detail: Detail | null;
}
