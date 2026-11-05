/**
 * The rows a W1 report WOULD become in the Q2′-2 tables.
 *
 * Writes nothing and imports no database client. W1-D (writer RPCs, run
 * persistence) is separately gated behind S1, G1 and the production apply
 * of Q2′-2. This mapping exists so the engine's output is proven storable
 * now: scripts/test-w1-report.ts validates every row against the same
 * constraints the migration enforces.
 *
 * Not stored, by design of the merged schema: robots.txt, sitemap.xml and
 * llms.txt records (no auxiliary table, and page rows are capped at 10), the
 * redirect chain, catalogue text, priorities and fix text. They are
 * report-only and reproducible from the catalogue at ruleSetVersion.
 * Detail is NULL until the founder approves the registry (D-043).
 *
 * Pure module.
 */
import {
  CHECK_ID_RE,
  CONTENT_TYPE_MAX,
  EXCERPT_MAX_CODE_POINTS,
  PAGE_CAP_MAX,
  PAGE_FETCH_ERRORS,
  RUN_OUTCOMES,
  UNKNOWN_REASONS,
  USER_AGENT_MAX,
  codePointLength,
  isNormalisedDomain,
  isSanitisedUrl,
  isSha256Hex,
} from "@/lib/site-diagnostic/contract";
import type { DiagnosticReport } from "@/lib/site-diagnostic/report";

export interface RunRow {
  normalized_domain: string;
  start_url: string;
  rule_set_version: string;
  crawler_version: string;
  user_agent: string;
  page_cap: number;
  outcome: string;
}

export interface PageRow {
  page_index: number;
  url: string;
  query_present: boolean;
  fetched_at: string;
  http_status: number | null;
  content_type: string | null;
  bytes: number;
  body_sha256: string | null;
  robots_allowed: boolean;
  fetch_error: string | null;
}

export interface FindingRow {
  /** page_index of the cited page; the writer resolves it to page_id. */
  page_index: number | null;
  check_id: string;
  state: string;
  unknown_reason: string | null;
  excerpt: string | null;
  excerpt_start: number | null;
  excerpt_end: number | null;
  excerpt_body_sha256: string | null;
  pii_screen_version: string | null;
  detail: null;
  rule_version: string;
}

export interface Q2p2Rows {
  run: RunRow;
  pages: PageRow[];
  findings: FindingRow[];
}

export function toQ2p2Rows(report: DiagnosticReport): Q2p2Rows {
  return {
    run: {
      normalized_domain: report.input.normalizedDomain,
      start_url: report.input.startUrl,
      rule_set_version: report.ruleSetVersion,
      crawler_version: report.crawlerVersion,
      user_agent: report.userAgent,
      page_cap: report.run.pageCap,
      outcome: report.run.outcome,
    },
    pages: report.pages.map((page) => ({
      page_index: page.pageIndex ?? -1,
      url: page.url,
      query_present: page.queryPresent,
      // A page never requested (robots) is stamped with the decision time.
      fetched_at: page.fetchedAt ?? report.run.startedAt,
      http_status: page.httpStatus,
      content_type: page.contentType,
      bytes: page.bytes,
      body_sha256: page.bodySha256,
      robots_allowed: page.robotsAllowed,
      fetch_error: page.fetchError,
    })),
    findings: report.findings.map((finding) => ({
      page_index: finding.pageIndex,
      check_id: finding.checkId,
      state: finding.state,
      unknown_reason: finding.unknownReason,
      excerpt: finding.excerpt?.text ?? null,
      excerpt_start: finding.excerpt?.start ?? null,
      excerpt_end: finding.excerpt?.end ?? null,
      excerpt_body_sha256: finding.excerpt?.bodySha256 ?? null,
      pii_screen_version: finding.excerpt?.piiScreenVersion ?? null,
      detail: null,
      rule_version: finding.ruleVersion,
    })),
  };
}

/**
 * Every constraint the migration enforces on these rows, checked in
 * TypeScript. Returns the violations (empty when storable).
 */
export function validateQ2p2Rows(rows: Q2p2Rows): string[] {
  const problems: string[] = [];
  const { run, pages, findings } = rows;
  const nonBlank = (value: string) => value.trim() !== "";

  if (!isNormalisedDomain(run.normalized_domain)) problems.push("run.normalized_domain");
  if (!isSanitisedUrl(run.start_url)) problems.push("run.start_url");
  if (!nonBlank(run.rule_set_version)) problems.push("run.rule_set_version");
  if (!nonBlank(run.crawler_version)) problems.push("run.crawler_version");
  if (!nonBlank(run.user_agent) || run.user_agent.length > USER_AGENT_MAX) problems.push("run.user_agent");
  if (!Number.isInteger(run.page_cap) || run.page_cap < 1 || run.page_cap > PAGE_CAP_MAX) problems.push("run.page_cap");
  if (!(RUN_OUTCOMES as readonly string[]).includes(run.outcome)) problems.push("run.outcome");

  const indexes = new Set<number>();
  const urls = new Set<string>();
  const hashByIndex = new Map<number, string | null>();
  for (const page of pages) {
    const at = `page[${page.page_index}]`;
    if (!Number.isInteger(page.page_index) || page.page_index < 0 || page.page_index >= run.page_cap) problems.push(`${at}.page_index`);
    if (indexes.has(page.page_index)) problems.push(`${at}.page_index unique`);
    indexes.add(page.page_index);
    if (!isSanitisedUrl(page.url)) problems.push(`${at}.url`);
    if (urls.has(page.url)) problems.push(`${at}.url unique`);
    urls.add(page.url);
    if (Number.isNaN(Date.parse(page.fetched_at))) problems.push(`${at}.fetched_at`);
    if (page.http_status !== null && (page.http_status < 100 || page.http_status > 599)) problems.push(`${at}.http_status`);
    if (page.content_type !== null && page.content_type.length > CONTENT_TYPE_MAX) problems.push(`${at}.content_type`);
    if (!Number.isInteger(page.bytes) || page.bytes < 0) problems.push(`${at}.bytes`);
    if ((page.bytes > 0) !== (page.body_sha256 !== null)) problems.push(`${at}.bytes/body_sha256`);
    if (page.body_sha256 !== null && !isSha256Hex(page.body_sha256)) problems.push(`${at}.body_sha256`);
    if (page.fetch_error !== null && !(PAGE_FETCH_ERRORS as readonly string[]).includes(page.fetch_error)) problems.push(`${at}.fetch_error`);
    hashByIndex.set(page.page_index, page.body_sha256);
  }
  if (pages.length > run.page_cap) problems.push("pages exceed page_cap");

  findings.forEach((finding, i) => {
    const at = `finding[${i}] ${finding.check_id}`;
    if (!CHECK_ID_RE.test(finding.check_id)) problems.push(`${at}.check_id`);
    if (!["pass", "issue", "info", "unknown"].includes(finding.state)) problems.push(`${at}.state`);
    if ((finding.state === "unknown") !== (finding.unknown_reason !== null)) problems.push(`${at}.unknown_reason presence`);
    if (finding.unknown_reason !== null && !(UNKNOWN_REASONS as readonly string[]).includes(finding.unknown_reason)) problems.push(`${at}.unknown_reason`);
    if (finding.page_index !== null && !indexes.has(finding.page_index)) problems.push(`${at}.page_index`);
    const bundle = [finding.excerpt, finding.excerpt_start, finding.excerpt_end, finding.excerpt_body_sha256, finding.pii_screen_version];
    const set = bundle.filter((value) => value !== null).length;
    if (set !== 0 && set !== bundle.length) problems.push(`${at}.excerpt bundle`);
    if (finding.excerpt !== null) {
      const length = codePointLength(finding.excerpt);
      if (length < 1 || length > EXCERPT_MAX_CODE_POINTS) problems.push(`${at}.excerpt length`);
      if (finding.page_index === null) problems.push(`${at}.excerpt needs page`);
      if (finding.excerpt_start === null || finding.excerpt_end === null || finding.excerpt_start < 0 || finding.excerpt_end <= finding.excerpt_start) {
        problems.push(`${at}.excerpt offsets`);
      }
      if (finding.page_index !== null && hashByIndex.get(finding.page_index) !== finding.excerpt_body_sha256) {
        problems.push(`${at}.excerpt hash`);
      }
      if (!nonBlank(finding.pii_screen_version ?? "")) problems.push(`${at}.pii_screen_version`);
    }
    if (!nonBlank(finding.rule_version)) problems.push(`${at}.rule_version`);
  });
  return problems;
}
