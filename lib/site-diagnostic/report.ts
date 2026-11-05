/**
 * The immutable W1 report object (W1-C).
 *
 * One canonical snapshot drives every view and export: the preview page, the
 * JSON export and the Markdown export all render this object and nothing
 * else. It is deep-frozen and carries a SHA-256 over its canonical JSON, so
 * any copy can be checked against the original.
 *
 * Contents: sanitised URLs, statuses, hashes, timestamps, versions,
 * findings with their catalogue text, and screened excerpts of at most 300
 * code points. Never a page body, header value, IP address or free-text
 * error. No composite score, grade, percentage or pass count: each finding
 * stands alone (D-040).
 *
 * Pure module.
 */
import { createHash } from "node:crypto";

import { AREA_LABELS, CHECK_AREAS, W1_RULE_SET_VERSION, checkDefinition, type CheckArea, type Priority } from "@/lib/site-diagnostic/catalog";
import type { RunOutcome } from "@/lib/site-diagnostic/contract";
import {
  NO_SCORE_STATEMENT,
  OUTCOME_TEXT,
  OWNERSHIP_NOT_VERIFIED,
  SAMPLE_LIMIT_STATEMENT,
  SCOPE_STATEMENT,
  UNKNOWN_REASON_TEXT,
} from "@/lib/site-diagnostic/copy";
import { W1_PII_SCREEN_VERSION } from "@/lib/site-diagnostic/excerpt";
import { W1_CRAWLER_VERSION, W1_FETCH_POLICY, W1_USER_AGENT } from "@/lib/site-diagnostic/policy";
import type { CrawlCapture, FetchRecord, Finding, StopReason } from "@/lib/site-diagnostic/types";

export const W1_REPORT_SCHEMA = "zypact.w1.report.v1";

export interface ReportFinding extends Finding {
  area: CheckArea;
  title: string;
  establishes: string;
  doesNotEstablish: string;
  /** Sanitised URL of the cited page, when the finding cites one. */
  pageUrl: string | null;
  /** Plain-language reason, present exactly when state is "unknown". */
  unknownReasonText: string | null;
  /** Static suggestion for this check and state, if it has one. */
  fix: string | null;
}

export interface FixItem {
  kind: "issue" | "suggestion";
  priority: Priority;
  area: CheckArea;
  checkId: string;
  title: string;
  pageIndex: number | null;
  pageUrl: string | null;
  text: string;
}

export interface DiagnosticReport {
  schema: typeof W1_REPORT_SCHEMA;
  ruleSetVersion: string;
  crawlerVersion: string;
  userAgent: string;
  piiScreenVersion: string;
  notices: {
    scope: string;
    ownership: string | null;
    noScore: string;
    sampleLimit: string;
  };
  domainVerification: "not_verified";
  input: CrawlCapture["input"];
  run: {
    outcome: RunOutcome;
    outcomeText: string;
    stopReason: StopReason;
    startedAt: string;
    completedAt: string;
    pageCap: number;
    capReached: boolean;
    requestCount: number;
  };
  robots: { policyKind: CrawlCapture["robots"]["policyKind"]; record: FetchRecord | null };
  sitemap: FetchRecord | null;
  llmsTxt: FetchRecord | null;
  pages: FetchRecord[];
  areas: Array<{ area: CheckArea; label: string }>;
  findings: ReportFinding[];
  fixList: FixItem[];
  /** sha256 of canonicalJson(report without this field). */
  reportSha256: string;
}

const PRIORITY_ORDER: Readonly<Record<Priority, number>> = { high: 0, medium: 1, low: 2 };

/** JSON with object keys sorted at every level; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner !== undefined) out[key] = sortKeys(inner);
    }
    return out;
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as object)) deepFreeze(inner);
  }
  return value;
}

export function reportHash(report: Omit<DiagnosticReport, "reportSha256"> | DiagnosticReport): string {
  const { reportSha256: _omit, ...rest } = report as DiagnosticReport;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

export function buildDiagnosticReport(capture: CrawlCapture, findings: readonly Finding[]): DiagnosticReport {
  const pageUrl = new Map(capture.pages.map((page) => [page.pageIndex, page.url]));
  const areaIndex = (area: CheckArea) => CHECK_AREAS.indexOf(area);

  const reportFindings: ReportFinding[] = findings.map((finding) => {
    const definition = checkDefinition(finding.checkId);
    const fix =
      finding.state === "issue" ? definition.fix.issue ?? null : finding.state === "info" ? definition.fix.info ?? null : null;
    return {
      ...finding,
      area: definition.area,
      title: definition.title,
      establishes: definition.establishes,
      doesNotEstablish: definition.doesNotEstablish,
      pageUrl: finding.pageIndex === null ? null : pageUrl.get(finding.pageIndex) ?? null,
      unknownReasonText: finding.unknownReason ? UNKNOWN_REASON_TEXT[finding.unknownReason] : null,
      fix,
    };
  });

  // A buyer page "info" suggestion only makes sense when the page was not found.
  const fixList: FixItem[] = reportFindings
    .filter((finding) => finding.fix !== null)
    .map((finding) => {
      const definition = checkDefinition(finding.checkId);
      return {
        kind: finding.state === "issue" ? ("issue" as const) : ("suggestion" as const),
        priority: definition.priority,
        area: definition.area,
        checkId: finding.checkId,
        title: definition.title,
        pageIndex: finding.pageIndex,
        pageUrl: finding.pageUrl,
        text: finding.fix as string,
      };
    })
    .sort(
      (a, b) =>
        (a.kind === b.kind ? 0 : a.kind === "issue" ? -1 : 1) ||
        PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
        areaIndex(a.area) - areaIndex(b.area) ||
        (a.checkId < b.checkId ? -1 : a.checkId > b.checkId ? 1 : 0) ||
        (a.pageIndex ?? -1) - (b.pageIndex ?? -1)
    );

  const withoutHash: Omit<DiagnosticReport, "reportSha256"> = {
    schema: W1_REPORT_SCHEMA,
    ruleSetVersion: W1_RULE_SET_VERSION,
    crawlerVersion: W1_CRAWLER_VERSION,
    userAgent: W1_USER_AGENT,
    piiScreenVersion: W1_PII_SCREEN_VERSION,
    notices: {
      scope: SCOPE_STATEMENT,
      // W1 offline has no domain verification yet, so the label always shows.
      ownership: OWNERSHIP_NOT_VERIFIED,
      noScore: NO_SCORE_STATEMENT,
      sampleLimit: SAMPLE_LIMIT_STATEMENT,
    },
    domainVerification: "not_verified",
    input: capture.input,
    run: {
      outcome: capture.outcome,
      outcomeText: OUTCOME_TEXT[capture.outcome],
      stopReason: capture.stopReason,
      startedAt: capture.startedAt,
      completedAt: capture.completedAt,
      pageCap: W1_FETCH_POLICY.pageCap,
      capReached: capture.capReached,
      requestCount: capture.requestCount,
    },
    robots: { policyKind: capture.robots.policyKind, record: capture.robots.record },
    sitemap: capture.sitemap.record,
    llmsTxt: capture.llmsTxt.record,
    pages: capture.pages,
    areas: CHECK_AREAS.map((area) => ({ area, label: AREA_LABELS[area] })),
    findings: reportFindings,
    fixList,
  };
  // Detach from the caller's objects before freezing.
  const detached = JSON.parse(JSON.stringify(withoutHash)) as Omit<DiagnosticReport, "reportSha256">;
  return deepFreeze({ ...detached, reportSha256: reportHash(detached) });
}

/** Recompute and compare the hash of a report (e.g. after an export round trip). */
export function verifyReportHash(report: DiagnosticReport): boolean {
  return reportHash(report) === report.reportSha256;
}
