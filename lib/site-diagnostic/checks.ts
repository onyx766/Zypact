/**
 * The W1 rules (W1-A): crawl capture + in-memory page bodies → findings.
 *
 * Pure and deterministic. The same capture and bytes always give the same
 * findings, in the same order, independent of fetch timing (timestamps are
 * never read here). Every finding is checked against its catalogue entry:
 * its unknown reason must be one the check declares, and its detail must
 * match the check's spec. A mismatch throws, because it is a bug in this
 * file, not a property of the site.
 *
 * Unknown is never converted into pass or issue. A buyer-relevant page not
 * found is `info` only when the crawl explored every link it discovered
 * within its bounds; otherwise it is `unknown`, and never "absent".
 */
import { evaluateRobots } from "@/lib/crawler/robots";
import { MARKETING_LEXICON_V1 } from "@/lib/buyer-questions/marketing-signal";
import { normalizeEntityTextV1 } from "@/lib/evidence/normalize-entity-text";
import {
  JSON_LD_TYPE_TOKENS,
  NAMED_CRAWLERS,
  W1_CATALOG,
  checkDefinition,
} from "@/lib/site-diagnostic/catalog";
import {
  detailMatchesSpec,
  type Detail,
  type FindingState,
  type UnknownReason,
} from "@/lib/site-diagnostic/contract";
import { buildExcerpt } from "@/lib/site-diagnostic/excerpt";
import { extractPageFacts, type PageFacts, type SourceSpan } from "@/lib/site-diagnostic/html";
import { W1_FETCH_POLICY, W1_ROBOTS_PRODUCT_TOKEN } from "@/lib/site-diagnostic/policy";
import {
  BUYER_CATEGORIES,
  type BuyerCategory,
  type CrawlCapture,
  type FetchRecord,
  type Finding,
  type FindingExcerpt,
  type PageBodies,
  type StopReason,
} from "@/lib/site-diagnostic/types";
import { sanitizeEvidenceUrl } from "@/lib/site-diagnostic/url";

type Analysable = { ok: true; facts: PageFacts } | { ok: false; reason: UnknownReason };

const SERVER_TEXT_PASS_WORDS = 100;

function make(
  checkId: string,
  state: FindingState,
  options: { reason?: UnknownReason; pageIndex?: number | null; detail?: Detail | null; excerpt?: FindingExcerpt | null } = {}
): Finding {
  const definition = checkDefinition(checkId);
  const unknownReason = state === "unknown" ? options.reason ?? null : null;
  if (state === "unknown" && (unknownReason === null || !definition.unknownReasons.includes(unknownReason))) {
    throw new Error(`W1 bug: ${checkId} cannot report unknown/${String(unknownReason)}`);
  }
  const detail = options.detail ?? null;
  if (detail !== null && !detailMatchesSpec(definition.detailSpec, detail)) {
    throw new Error(`W1 bug: ${checkId} detail does not match its spec`);
  }
  return {
    checkId,
    ruleVersion: definition.ruleVersion,
    state,
    unknownReason,
    pageIndex: options.pageIndex ?? null,
    excerpt: state === "unknown" ? null : options.excerpt ?? null,
    detail: state === "unknown" ? null : detail,
  };
}

function stopToUnknown(stop: StopReason): UnknownReason {
  switch (stop) {
    case "robots_unavailable":
      return "robots_unavailable";
    case "deadline":
      return "timeout";
    case "page_cap":
    case "request_budget":
      return "page_cap_reached";
    default:
      return "fetch_failed";
  }
}

const decodeEntities = (text: string): string =>
  text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

function safeCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

const plain = (span: SourceSpan | undefined): string => (span ? decodeEntities(span.text).replace(/\s+/g, " ").trim() : "");

/* ------------------------------------------------------------ helpers */

function analyse(page: FetchRecord, bodies: PageBodies): Analysable {
  if (page.fetchError) return { ok: false, reason: page.fetchError };
  if (page.httpStatus === null || page.httpStatus < 200 || page.httpStatus >= 300) return { ok: false, reason: "fetch_failed" };
  const body = bodies.get(page.pageIndex ?? -1);
  if (!body) return { ok: false, reason: "fetch_failed" };
  try {
    return { ok: true, facts: extractPageFacts(body.bytes, body.headers, page.url, W1_FETCH_POLICY.maxLinksPerPage) };
  } catch {
    return { ok: false, reason: "parse_error" };
  }
}

function countOccurrences(text: string, phrase: string): number {
  const escaped = phrase.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = text.toLowerCase().match(new RegExp(`(^|[^\\p{L}\\p{N}-])${escaped}(?=$|[^\\p{L}\\p{N}-])`, "gu"));
  return matches ? matches.length : 0;
}

/** Brand-name candidates from one homepage signal, normalised (D-019). */
function nameForms(value: string, splitSeparators: boolean): Set<string> {
  const forms = new Set<string>();
  const add = (raw: string) => {
    const normalized = normalizeEntityTextV1(raw);
    if (normalized.length >= 2) forms.add(normalized);
  };
  if (!value.trim()) return forms;
  add(value);
  if (splitSeparators) for (const part of value.split(/\s+[|–—:·•-]\s+|\s*\|\s*/)) add(part);
  return forms;
}

function footerName(footer: string): string | null {
  const match = footer.match(/(?:©|\(c\)|copyright)\s*(?:(?:19|20)\d{2}(?:\s*[-–—]\s*(?:19|20)\d{2})?)?\s*([^|·•©]{2,80}?)(?=\.?\s*(?:all rights reserved|$|\||·|•))/i);
  return match ? match[1].trim().replace(/[.,;]$/, "") : null;
}

/* -------------------------------------------------------------- rules */

export function evaluateChecks(capture: CrawlCapture, bodies: PageBodies): Finding[] {
  const findings: Finding[] = [];
  const analysed = new Map<number, Analysable>();
  for (const page of capture.pages) {
    if (page.pageIndex !== null) analysed.set(page.pageIndex, analyse(page, bodies));
  }
  const home = capture.pages.find((page) => page.pageIndex === 0) ?? null;
  const homeAnalysis: Analysable = home
    ? analysed.get(0) ?? { ok: false, reason: "fetch_failed" }
    : { ok: false, reason: stopToUnknown(capture.stopReason) };
  const robotsDown = capture.outcome === "robots_unavailable";

  /* robots.agents */
  if (capture.robots.policyKind === "unreachable") {
    findings.push(make("robots.agents", "unknown", { reason: "robots_unavailable" }));
  } else {
    const parsed = capture.robots.parsed;
    const blocked = parsed
      ? NAMED_CRAWLERS.filter((crawler) => !evaluateRobots(parsed, crawler.token, "/").allowed).map((c) => c.id)
      : [];
    const zypactAllowed = parsed ? evaluateRobots(parsed, W1_ROBOTS_PRODUCT_TOKEN, "/").allowed : true;
    findings.push(
      make("robots.agents", blocked.length > 0 ? "issue" : "pass", {
        detail: {
          file_status: capture.robots.policyKind === "parsed" ? "parsed" : "not_found",
          blocked_agents: [...blocked].sort(),
          blocked_count: blocked.length,
          zypactbot_allowed: zypactAllowed,
        },
      })
    );
  }

  /* site.sitemap */
  {
    const { record, summary } = capture.sitemap;
    if (robotsDown) findings.push(make("site.sitemap", "unknown", { reason: "robots_unavailable" }));
    else if (!record) findings.push(make("site.sitemap", "unknown", { reason: stopToUnknown(capture.stopReason) }));
    else if (record.fetchError) findings.push(make("site.sitemap", "unknown", { reason: record.fetchError }));
    else if (record.httpStatus !== null && record.httpStatus >= 400 && record.httpStatus < 500) {
      findings.push(make("site.sitemap", "info", { detail: { format: "not_found" } }));
    } else if (summary) {
      const valid = summary.format !== "invalid" && summary.urlCount > 0;
      findings.push(
        make("site.sitemap", valid ? "pass" : "issue", {
          detail: {
            format: summary.format,
            url_count: Math.min(summary.urlCount, 10_000),
            same_site_url_count: Math.min(summary.sameSiteUrlCount, 10_000),
            source: summary.source,
          },
        })
      );
    } else findings.push(make("site.sitemap", "unknown", { reason: "fetch_failed" }));
  }

  /* site.llms_txt */
  {
    const { record, summary } = capture.llmsTxt;
    if (robotsDown) findings.push(make("site.llms_txt", "unknown", { reason: "robots_unavailable" }));
    else if (!record) findings.push(make("site.llms_txt", "unknown", { reason: stopToUnknown(capture.stopReason) }));
    else if (summary) {
      findings.push(make("site.llms_txt", "info", { detail: { present: true, starts_with_heading: summary.startsWithHeading } }));
    } else if (record.fetchError === "not_html" || (record.httpStatus !== null && record.httpStatus >= 400 && record.httpStatus < 500)) {
      findings.push(make("site.llms_txt", "info", { detail: { present: false } }));
    } else findings.push(make("site.llms_txt", "unknown", { reason: record.fetchError ?? "fetch_failed" }));
  }

  /* homepage-level checks */
  if (!homeAnalysis.ok) {
    for (const id of ["site.organization_markup", "site.entity_consistency", "site.seller_wording"]) {
      findings.push(make(id, "unknown", { reason: homeAnalysis.reason }));
    }
  } else {
    const facts = homeAnalysis.facts;
    const org = facts.jsonLd.organization;
    findings.push(
      make("site.organization_markup", org.present && org.hasName && org.hasUrl ? "pass" : "info", {
        pageIndex: 0,
        detail: {
          org_present: org.present,
          has_name: org.hasName,
          has_url: org.hasUrl,
          has_logo: org.hasLogo,
          same_as_count: Math.min(org.sameAsCount, 50),
        },
      })
    );

    const sources: Array<[string, Set<string>]> = [];
    const titleForms = nameForms(plain(facts.titles[0]), true);
    if (titleForms.size) sources.push(["title", titleForms]);
    const ogForms = nameForms(facts.ogSiteName ?? "", false);
    if (ogForms.size) sources.push(["og_site_name", ogForms]);
    const ldForms = new Set<string>();
    for (const name of facts.jsonLd.entityNames) nameForms(name, false).forEach((form) => ldForms.add(form));
    if (ldForms.size) sources.push(["json_ld_name", ldForms]);
    const footer = footerName(facts.footerText);
    const footerForms = nameForms(footer ?? "", false);
    if (footerForms.size) sources.push(["footer", footerForms]);

    let consistency: "consistent" | "inconsistent" | "insufficient" = "insufficient";
    if (sources.length >= 2) {
      // Title forms include each segment, so one shared form across every
      // present source is agreement; single-value sources must all hold it.
      const [, first] = sources[0];
      const shared = [...first].some((form) => sources.every(([, set]) => set.has(form)));
      consistency = shared ? "consistent" : "inconsistent";
    }
    findings.push(
      make("site.entity_consistency", consistency === "consistent" ? "pass" : consistency === "inconsistent" ? "issue" : "info", {
        pageIndex: 0,
        detail: { sources_present: sources.map(([name]) => name).sort(), consistency },
      })
    );

    const phrases = MARKETING_LEXICON_V1.reduce((sum, phrase) => sum + countOccurrences(facts.bodyText, phrase), 0);
    findings.push(make("site.seller_wording", "info", { pageIndex: 0, detail: { lexicon_phrase_count: Math.min(phrases, 1_000) } }));
  }

  /* site.duplicate_titles */
  {
    const titled = capture.pages
      .map((page) => ({ page, analysis: analysed.get(page.pageIndex ?? -1) }))
      .filter((entry): entry is { page: FetchRecord; analysis: { ok: true; facts: PageFacts } } => entry.analysis?.ok === true);
    if (robotsDown) {
      findings.push(make("site.duplicate_titles", "unknown", { reason: "robots_unavailable" }));
    } else if (titled.length < 2) {
      findings.push(make("site.duplicate_titles", "unknown", { reason: "not_applicable" }));
    } else {
      const groups = new Map<string, number>();
      for (const { analysis } of titled) {
        const key = plain(analysis.facts.titles[0]).toLowerCase();
        if (key) groups.set(key, (groups.get(key) ?? 0) + 1);
      }
      const shared = [...groups.values()].filter((n) => n >= 2).reduce((a, b) => a + b, 0);
      findings.push(
        make("site.duplicate_titles", shared > 0 ? "info" : "pass", {
          detail: { pages_compared: titled.length, pages_with_shared_title: shared },
        })
      );
    }
  }

  /* buyer_page.* */
  for (const category of BUYER_CATEGORIES) findings.push(buyerFinding(category, capture, analysed));

  /* page-level checks, one set per page row */
  for (const page of capture.pages) {
    if (page.pageIndex === null) continue;
    findings.push(...pageFindings(page, analysed.get(page.pageIndex) ?? { ok: false, reason: "fetch_failed" }));
  }

  return findings.sort(
    (a, b) =>
      (a.checkId < b.checkId ? -1 : a.checkId > b.checkId ? 1 : 0) ||
      (a.pageIndex ?? -1) - (b.pageIndex ?? -1)
  );
}

function buyerFinding(
  category: BuyerCategory,
  capture: CrawlCapture,
  analysed: ReadonlyMap<number, Analysable>
): Finding {
  const checkId = `buyer_page.${category}`;
  if (capture.outcome === "robots_unavailable") return make(checkId, "unknown", { reason: "robots_unavailable" });

  const matching = capture.pages.filter((page) => {
    if (page.category === category) return true;
    if (category !== "faq" || page.pageIndex === null) return false;
    const analysis = analysed.get(page.pageIndex);
    return analysis?.ok === true && analysis.facts.jsonLd.types.includes("faqpage");
  });
  const found = matching.find((page) => analysed.get(page.pageIndex ?? -1)?.ok === true);
  if (found) {
    return make(checkId, "pass", { pageIndex: found.pageIndex, detail: { link_discovered: true, fetched: true } });
  }
  if (matching.length > 0) {
    const analysis = analysed.get(matching[0].pageIndex ?? -1);
    return make(checkId, "unknown", { reason: analysis && !analysis.ok ? analysis.reason : "fetch_failed", pageIndex: matching[0].pageIndex });
  }

  const linked = capture.candidates.filter((candidate) => candidate.category === category);
  const blocked = linked.find((candidate) => candidate.fate === "blocked_by_robots");
  if (blocked) return make(checkId, "unknown", { reason: "blocked_by_robots" });
  const failed = linked.find((candidate) => ["fetch_failed", "timeout", "size_cap", "not_html"].includes(candidate.fate));
  if (failed) return make(checkId, "unknown", { reason: failed.fate as UnknownReason });
  if (linked.some((candidate) => candidate.fate === "not_fetched")) {
    return make(checkId, "unknown", { reason: stopToUnknown(capture.stopReason === "frontier_exhausted" ? "page_cap" : capture.stopReason) });
  }
  // Nothing discovered. Only an exhausted crawl may say "not found".
  if (capture.capReached || capture.stopReason !== "frontier_exhausted") {
    return make(checkId, "unknown", { reason: stopToUnknown(capture.stopReason) });
  }
  return make(checkId, "info", { detail: { link_discovered: false, fetched: false } });
}

function pageFindings(page: FetchRecord, analysis: Analysable): Finding[] {
  const pageIndex = page.pageIndex;
  const out: Finding[] = [];

  /* page.http_status: judged on the status alone */
  if (page.httpStatus === null) {
    out.push(make("page.http_status", "unknown", { pageIndex, reason: page.fetchError ?? "fetch_failed" }));
  } else {
    const status = page.httpStatus;
    const statusClass = status < 300 ? "success" : status < 400 ? "redirect" : status < 500 ? "client_error" : "server_error";
    const state: FindingState = status < 300 ? "pass" : status < 400 ? "info" : "issue";
    out.push(make("page.http_status", state, { pageIndex, detail: { status_class: statusClass } }));
  }

  const contentChecks = ["page.noindex", "page.server_text", "page.title", "page.meta_description", "page.h1", "page.canonical", "page.json_ld"];
  if (!analysis.ok) {
    for (const id of contentChecks) out.push(make(id, "unknown", { pageIndex, reason: analysis.reason }));
    return out;
  }
  const facts = analysis.facts;
  const excerptOf = (span: SourceSpan | undefined) => buildExcerpt(span, page.bodySha256);

  /* page.noindex */
  {
    const { metaGeneric, metaScoped, headerGeneric, headerScoped } = facts.robotsDirectives;
    const isNoindex = (tokens: string[]) => tokens.includes("noindex") || tokens.includes("none");
    const metaNoindex = isNoindex(metaGeneric);
    const headerNoindex = isNoindex(headerGeneric);
    const scopedNoindex = isNoindex(metaScoped) || isNoindex(headerScoped);
    const nofollow = [...metaGeneric, ...headerGeneric].some((t) => t === "nofollow" || t === "none");
    const state: FindingState = metaNoindex || headerNoindex ? "issue" : scopedNoindex ? "info" : "pass";
    out.push(make("page.noindex", state, { pageIndex, detail: { meta_noindex: metaNoindex, header_noindex: headerNoindex, scoped_noindex: scopedNoindex, nofollow } }));
  }

  /* page.server_text */
  {
    const words = facts.wordCount;
    const state: FindingState = words === 0 ? "issue" : words < SERVER_TEXT_PASS_WORDS ? "info" : "pass";
    out.push(make("page.server_text", state, { pageIndex, detail: { word_count: Math.min(words, 10_000) } }));
  }

  /* page.title, page.meta_description, page.h1: exactly one non-empty */
  const single = (checkId: string, spans: SourceSpan[], countKey: string) => {
    const nonEmpty = spans.filter((span) => plain(span) !== "");
    const empty = spans.length > 0 && nonEmpty.length === 0;
    const state: FindingState = nonEmpty.length === 0 ? "issue" : spans.length > 1 ? "info" : "pass";
    out.push(
      make(checkId, state, {
        pageIndex,
        detail: { [countKey]: Math.min(spans.length, 50), empty },
        excerpt: state === "issue" ? null : excerptOf(nonEmpty[0]),
      })
    );
  };
  single("page.title", facts.titles, "title_count");
  single("page.meta_description", facts.metaDescriptions, "description_count");
  single("page.h1", facts.h1s, "h1_count");

  /* page.canonical */
  {
    const values = facts.canonicals;
    const distinct = [...new Set(values.filter(Boolean))];
    let status: "self" | "missing" | "other_same_site" | "off_site" | "conflicting" | "invalid";
    if (values.length === 0) status = "missing";
    else if (distinct.length > 1) status = "conflicting";
    else if (distinct.length === 0) status = "invalid";
    else {
      let target: URL | null = null;
      try {
        target = new URL(distinct[0], page.url);
      } catch {
        target = null;
      }
      const sanitized = target && (target.protocol === "https:" || target.protocol === "http:") ? sanitizeEvidenceUrl(target) : null;
      if (!sanitized) status = "invalid";
      else if (sanitized.url === page.url) status = "self";
      else {
        const pageHost = new URL(page.url).hostname.replace(/^www\./, "");
        const targetHost = new URL(sanitized.url).hostname.replace(/^www\./, "");
        status = pageHost === targetHost ? "other_same_site" : "off_site";
      }
    }
    const state: FindingState = status === "self" ? "pass" : status === "conflicting" || status === "invalid" ? "issue" : "info";
    out.push(make("page.canonical", state, { pageIndex, detail: { canonical_status: status, canonical_count: Math.min(values.length, 50) } }));
  }

  /* page.json_ld */
  {
    const { blockCount, invalidBlockCount, types } = facts.jsonLd;
    const tokens = new Set<string>();
    for (const type of types) {
      const known = JSON_LD_TYPE_TOKENS.find((entry) => entry.type !== "" && entry.type === type);
      tokens.add(known ? known.id : "other");
    }
    const list = [...tokens].sort().slice(0, 16);
    const state: FindingState = blockCount === 0 ? "info" : invalidBlockCount > 0 ? "issue" : "pass";
    out.push(
      make("page.json_ld", state, {
        pageIndex,
        detail: { block_count: Math.min(blockCount, 50), invalid_block_count: Math.min(invalidBlockCount, 50), types: list },
      })
    );
  }

  return out;
}

/** Every catalogue check id, for tests that want full coverage. */
export const ALL_CHECK_IDS = W1_CATALOG.map((check) => check.checkId);
