/**
 * Every sentence the W1 report shows that is not check-specific, in one
 * place for the D11 claim-language review (docs/SELF_SERVICE_PRODUCT.md
 * §6.1, D-040). Check-specific text lives in catalog.ts.
 *
 * scripts/test-w1-report.ts lints this module and the catalogue against
 * FORBIDDEN_W1_PHRASES.
 *
 * Pure module.
 */
import type { FindingState, RunOutcome, UnknownReason } from "@/lib/site-diagnostic/contract";

/** §6.1, verbatim. Shown at the top of every report and export. */
export const SCOPE_STATEMENT =
  "This checks your website's public pages. It does not show how any AI system answers buyers.";

/** §6.1, verbatim. Shown whenever the run cites no current domain verification. */
export const OWNERSHIP_NOT_VERIFIED = "Domain ownership not verified.";

export const INTERNAL_PREVIEW_LABEL = "Internal preview — not customer-facing.";

export const NO_SCORE_STATEMENT =
  "Results are not combined into a score. Each check stands on its own, with its evidence and what it does not establish.";

export const SAMPLE_LIMIT_STATEMENT =
  "At most 10 pages are fetched, on the submitted host and its www/apex alternate, without running scripts. A page not found within that limit may still exist.";

export const STATE_LABELS: Readonly<Record<FindingState, string>> = {
  pass: "Pass",
  issue: "Issue",
  info: "Info",
  unknown: "Unknown",
};

export const UNKNOWN_REASON_TEXT: Readonly<Record<UnknownReason, string>> = {
  fetch_failed: "The page could not be fetched, or returned an error status.",
  timeout: "The request, or the crawl's overall time limit, ran out.",
  size_cap: "The response was larger than the size limit, so it was not read.",
  parse_error: "The response could not be parsed.",
  blocked_by_robots: "robots.txt asks crawlers like Zypact's not to fetch this URL, so it was not fetched.",
  robots_unavailable: "robots.txt could not be retrieved (server error or unreachable), so no page was fetched.",
  not_html: "The response was not an HTML page.",
  page_cap_reached: "The crawl's page or request limit was reached before this could be checked.",
  not_applicable: "This check needs more fetched pages than were available.",
};

export const OUTCOME_TEXT: Readonly<Record<RunOutcome, string>> = {
  completed: "The crawl finished within its limits.",
  failed: "No page on this site could be fetched.",
  robots_unavailable:
    "robots.txt could not be retrieved, which RFC 9309 treats as a complete disallow. No page was fetched.",
  cancelled: "The run was cancelled before it finished.",
};

/**
 * Phrases no W1 copy may use (METHODOLOGY §19, D-040, SELF_SERVICE_PRODUCT
 * §6.1). The lint skips "does not establish" text, which must be able to
 * name what it disclaims.
 */
export const FORBIDDEN_W1_PHRASES: readonly string[] = [
  "ai visibility",
  "ai-readable",
  "ai readable",
  "readable by ai",
  "visibility score",
  "overall score",
  "your score",
  "buyers ask",
  "buyers search for",
  "will rank",
  "rank higher",
  "improve your ranking",
  "get recommended",
  "ai will recommend",
  "guaranteed",
  "caused",
  "this fix will",
  "ai buyers cannot find you",
];
