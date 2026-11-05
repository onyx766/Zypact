/**
 * The W1 diagnostic crawler (W1-B).
 *
 * Bounded, robots-aware and SSRF-safe. It composes the existing outbound
 * policy (lib/crawler/outbound-url-safety.ts) and pinned transport
 * (lib/crawler/safe-fetch.ts) one request at a time, so it can apply W1's
 * own rules to every redirect hop BEFORE connecting: same site only, default
 * ports only, robots.txt allows the path, request budget and deadline left.
 * It does not use crawlSite, which serves the founder snapshot pipeline and
 * must not change behaviour (docs/W1_WEBSITE_DIAGNOSTIC.md).
 *
 * Order: robots.txt, homepage, sitemap.xml, llms.txt, then up to 9 more
 * pages chosen for buyer relevance. Bounds come from W1_FETCH_POLICY.
 *
 * Deterministic given the transport's answers: no randomness, the clock is
 * injected, and the link order is fully specified. Page bodies are returned
 * separately (PageBodies) and never enter the serialisable capture.
 *
 * Logging: none. Callers log closed fields only.
 */
import { createHash } from "node:crypto";

import * as cheerio from "cheerio";

import {
  RobotsCache,
  ROBOTS_MAX_BYTES,
  isAllowedByPolicy,
  robotsPolicyFromFetch,
  type RobotsPolicy,
} from "@/lib/crawler/robots";
import {
  UnsafeOutboundUrlError,
  type DnsLookup,
} from "@/lib/crawler/outbound-url-safety";
import {
  RequestTimeoutError,
  ResponseTooLargeError,
  safeFetchOnce,
  type Transport,
} from "@/lib/crawler/safe-fetch";
import { CATEGORY_ORDER, categoryFromAnchor, categoryFromPath } from "@/lib/site-diagnostic/buyer-pages";
import { CONTENT_TYPE_MAX, type PageFetchError, type RunOutcome } from "@/lib/site-diagnostic/contract";
import { extractPageFacts } from "@/lib/site-diagnostic/html";
import {
  W1_FETCH_POLICY,
  W1_ROBOTS_PRODUCT_TOKEN,
  W1_USER_AGENT,
  type W1FetchPolicy,
} from "@/lib/site-diagnostic/policy";
import type {
  BuyerCategory,
  CrawlCapture,
  FetchRecord,
  LinkCandidate,
  LlmsTxtSummary,
  PageBodies,
  RedirectHop,
  ResourceKind,
  SitemapSummary,
  StopReason,
} from "@/lib/site-diagnostic/types";
import {
  isAssetPath,
  isExcludedPath,
  isSameSite,
  sanitizeEvidenceUrl,
  siteHosts,
  type NormalizedInput,
} from "@/lib/site-diagnostic/url";

export interface CrawlDeps {
  transport?: Transport;
  dnsLookup?: DnsLookup;
  /** Milliseconds since epoch. Injected for deterministic tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** Override for tests only. */
  policy?: W1FetchPolicy;
  userAgent?: string;
}

export interface CrawlResult {
  capture: CrawlCapture;
  bodies: PageBodies;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const isHtmlType = (contentType: string | undefined): boolean => {
  const media = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return media === "text/html" || media === "application/xhtml+xml";
};

const iso = (ms: number): string => new Date(ms).toISOString();

/** Errors mapped to the closed page fetch_error values. Never err.message. */
function classifyError(error: unknown): PageFetchError {
  if (error instanceof RequestTimeoutError) return "timeout";
  if (error instanceof ResponseTooLargeError) return "size_cap";
  if (error instanceof UnsafeOutboundUrlError) return "fetch_failed";
  return "fetch_failed";
}

/** Bounded DNS: the system lookup has no timeout of its own. */
function withTimeout(lookup: DnsLookup | undefined, ms: number): DnsLookup | undefined {
  if (!lookup) return undefined;
  return (hostname) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new RequestTimeoutError()), ms);
      lookup(hostname).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
}

async function systemLookup(hostname: string) {
  const { lookup } = await import("node:dns/promises");
  return lookup(hostname, { all: true, verbatim: true });
}

interface FrontierEntry {
  url: string;
  pathCategory: BuyerCategory | null;
  anchorCategory: BuyerCategory | null;
  via: "link" | "sitemap";
  depth: number;
  seq: number;
}

class Stop extends Error {
  constructor(readonly reason: StopReason) {
    super(reason);
  }
}

export async function crawlForDiagnostic(input: NormalizedInput, deps: CrawlDeps = {}): Promise<CrawlResult> {
  const policy = deps.policy ?? W1_FETCH_POLICY;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const userAgent = deps.userAgent ?? W1_USER_AGENT;
  const dnsLookup = withTimeout(deps.dnsLookup ?? systemLookup, policy.dnsTimeoutMs);
  const hosts = siteHosts(input.host);
  const startedMs = now();
  const robotsCache = new RobotsCache(now);

  let requestCount = 0;
  let lastRequestMs: number | null = null;
  let stopReason: StopReason | null = null;

  /** Gate before every request: abort, budget, deadline, politeness. */
  async function beforeRequest(): Promise<number> {
    if (deps.signal?.aborted) throw new Stop("cancelled");
    if (requestCount >= policy.maxRequestsPerRun) throw new Stop("request_budget");
    if (lastRequestMs !== null && policy.politenessDelayMs > 0) await sleep(policy.politenessDelayMs);
    const remaining = policy.runDeadlineMs - (now() - startedMs);
    if (remaining <= 0) throw new Stop("deadline");
    requestCount += 1;
    lastRequestMs = now();
    return Math.min(policy.requestDeadlineMs, remaining);
  }

  async function request(url: string, accept: string, maxBodyBytes: number, onOversize: "reject" | "truncate") {
    const deadlineMs = await beforeRequest();
    return safeFetchOnce(url, {
      transport: deps.transport,
      dnsLookup,
      timeoutMs: Math.min(policy.requestIdleTimeoutMs, deadlineMs),
      deadlineMs,
      userAgent,
      accept,
      acceptEncoding: "identity",
      maxBodyBytes,
      onOversize,
    });
  }

  function emptyRecord(kind: ResourceKind, requestedUrl: string, via: FetchRecord["discoveredVia"]): FetchRecord {
    const sanitized = sanitizeEvidenceUrl(requestedUrl);
    return {
      kind,
      pageIndex: null,
      url: sanitized?.url ?? requestedUrl,
      requestedUrl: sanitized?.url ?? requestedUrl,
      queryPresent: sanitized?.queryPresent ?? false,
      redirectChain: [],
      fetchedAt: null,
      httpStatus: null,
      contentType: null,
      bytes: 0,
      bodySha256: null,
      truncated: false,
      robotsAllowed: true,
      fetchError: null,
      category: null,
      discoveredVia: via,
    };
  }

  /* ------------------------------------------------------ robots.txt */

  /** Origin whose robots.txt answered after redirects, when not the asked one. */
  let robotsAnsweredBy: string | null = null;

  async function robotsFor(origin: string): Promise<{ policy: RobotsPolicy; record: FetchRecord }> {
    robotsAnsweredBy = null;
    const record = emptyRecord("robots", `${origin}/robots.txt`, "fixed_path");
    let current = `${origin}/robots.txt`;
    for (let hop = 0; hop <= policy.maxRedirects; hop += 1) {
      let target: URL;
      try {
        target = new URL(current);
      } catch {
        break;
      }
      // A robots.txt that redirects off the site is treated as unreachable.
      if (!isSameSite(target, hosts)) break;
      let response;
      try {
        response = await request(target.toString(), "text/plain, */*;q=0.1", ROBOTS_MAX_BYTES, "truncate");
      } catch (error) {
        if (error instanceof Stop) throw error;
        record.fetchedAt = iso(now());
        record.fetchError = "robots_unavailable";
        return { policy: { kind: "unreachable", parsed: null }, record };
      }
      record.fetchedAt = iso(now());
      const location = response.headers["location"];
      if (REDIRECT_STATUSES.has(response.status) && location) {
        record.redirectChain.push({ url: sanitizeEvidenceUrl(target)?.url ?? "", status: response.status });
        try {
          current = new URL(location, target).toString();
        } catch {
          break;
        }
        continue;
      }
      record.url = sanitizeEvidenceUrl(target)?.url ?? record.url;
      if (target.origin !== origin) robotsAnsweredBy = target.origin;
      record.httpStatus = response.status >= 100 && response.status <= 599 ? response.status : null;
      record.contentType = (response.headers["content-type"] ?? "").slice(0, CONTENT_TYPE_MAX) || null;
      record.bytes = response.bodyBytes.length;
      record.bodySha256 = record.bytes > 0 ? sha256Hex(response.bodyBytes) : null;
      record.truncated = response.truncated;
      const robotsPolicy = robotsPolicyFromFetch({ kind: "status", status: response.status, bodyBytes: response.bodyBytes });
      if (robotsPolicy.kind === "unreachable") record.fetchError = "robots_unavailable";
      return { policy: robotsPolicy, record };
    }
    // Too many redirects, an off-site hop or a broken Location: fail closed.
    record.fetchedAt = record.fetchedAt ?? iso(now());
    record.fetchError = "robots_unavailable";
    return { policy: { kind: "unreachable", parsed: null }, record };
  }

  async function policyForOrigin(origin: string): Promise<RobotsPolicy> {
    const cached = robotsCache.get(origin);
    if (cached) return cached;
    const { policy: robotsPolicy } = await robotsFor(origin);
    robotsCache.set(origin, robotsPolicy);
    return robotsPolicy;
  }

  /* ------------------------------------------ one resource, with hops */

  interface Fetched {
    record: FetchRecord;
    bytes: Uint8Array | null;
    headers: Record<string, string> | null;
    finalUrl: string | null;
  }

  async function fetchResource(
    kind: ResourceKind,
    startUrl: string,
    via: FetchRecord["discoveredVia"],
    accept: string,
    maxBodyBytes: number,
    onOversize: "reject" | "truncate"
  ): Promise<Fetched> {
    const record = emptyRecord(kind, startUrl, via);
    let current = startUrl;
    for (let hop = 0; hop <= policy.maxRedirects; hop += 1) {
      let target: URL;
      try {
        target = new URL(current);
      } catch {
        record.fetchError = "fetch_failed";
        return { record, bytes: null, headers: null, finalUrl: null };
      }
      if (!isSameSite(target, hosts)) {
        // Off-site redirect: never connected to; recorded as a failed fetch.
        record.fetchError = "fetch_failed";
        return { record, bytes: null, headers: null, finalUrl: null };
      }
      const origin = `${target.protocol}//${target.host}`;
      const robotsPolicy = await policyForOrigin(origin);
      if (robotsPolicy.kind === "unreachable") {
        record.robotsAllowed = false;
        record.fetchError = "robots_unavailable";
        return { record, bytes: null, headers: null, finalUrl: null };
      }
      if (!isAllowedByPolicy(robotsPolicy, W1_ROBOTS_PRODUCT_TOKEN, target.pathname + target.search)) {
        record.robotsAllowed = false;
        record.fetchError = "blocked_by_robots";
        return { record, bytes: null, headers: null, finalUrl: null };
      }

      let response;
      try {
        response = await request(target.toString(), accept, maxBodyBytes, onOversize);
      } catch (error) {
        if (error instanceof Stop) throw error;
        record.fetchedAt = iso(now());
        record.fetchError = classifyError(error);
        return { record, bytes: null, headers: null, finalUrl: null };
      }
      record.fetchedAt = iso(now());
      const location = response.headers["location"];
      if (REDIRECT_STATUSES.has(response.status) && location) {
        record.redirectChain.push({ url: sanitizeEvidenceUrl(target)?.url ?? "", status: response.status });
        try {
          current = new URL(location, target).toString();
        } catch {
          record.fetchError = "fetch_failed";
          return { record, bytes: null, headers: null, finalUrl: null };
        }
        continue;
      }

      const final = sanitizeEvidenceUrl(target);
      record.url = final?.url ?? record.url;
      record.httpStatus = response.status >= 100 && response.status <= 599 ? response.status : null;
      record.contentType = (response.headers["content-type"] ?? "").slice(0, CONTENT_TYPE_MAX) || null;
      record.bytes = response.bodyBytes.length;
      record.bodySha256 = record.bytes > 0 ? sha256Hex(response.bodyBytes) : null;
      record.truncated = response.truncated;
      const encoding = (response.headers["content-encoding"] ?? "identity").trim().toLowerCase();
      if (encoding !== "" && encoding !== "identity") {
        // Asked for identity; a compressed body cannot be read safely here.
        record.fetchError = "fetch_failed";
        return { record, bytes: null, headers: null, finalUrl: target.toString() };
      }
      return { record, bytes: response.bodyBytes, headers: response.headers, finalUrl: target.toString() };
    }
    record.fetchError = "fetch_failed"; // more than maxRedirects hops
    return { record, bytes: null, headers: null, finalUrl: null };
  }

  /* --------------------------------------------------------- the run */

  const pages: FetchRecord[] = [];
  const bodies = new Map<number, { bytes: Uint8Array; headers: Readonly<Record<string, string>> }>();
  const candidates = new Map<string, LinkCandidate>();
  const frontier = new Map<string, FrontierEntry>();
  const seenPageUrls = new Set<string>();
  let seq = 0;

  let robots: CrawlCapture["robots"] = { policyKind: "unreachable", record: null, parsed: null };
  let sitemap: CrawlCapture["sitemap"] = { record: null, summary: null };
  let llmsTxt: CrawlCapture["llmsTxt"] = { record: null, summary: null };
  const startOrigin = new URL(input.startUrl).origin;

  function enqueue(rawUrl: string, anchorText: string, via: "link" | "sitemap"): void {
    if (frontier.size >= policy.maxFrontier) return;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return;
    }
    if (!isSameSite(url, hosts)) return;
    if (url.search !== "") return; // query URLs are never fetched
    if (isAssetPath(url.pathname) || isExcludedPath(url.pathname)) return;
    const sanitized = sanitizeEvidenceUrl(url);
    if (!sanitized) return;
    if (seenPageUrls.has(sanitized.url) || frontier.has(sanitized.url)) {
      const existing = frontier.get(sanitized.url);
      if (existing && !existing.anchorCategory) existing.anchorCategory = categoryFromAnchor(anchorText);
      return;
    }
    const pathCategory = categoryFromPath(url.pathname);
    frontier.set(sanitized.url, {
      url: sanitized.url,
      pathCategory,
      anchorCategory: categoryFromAnchor(anchorText),
      via,
      depth: url.pathname.split("/").filter(Boolean).length,
      seq: seq++,
    });
    if (!candidates.has(sanitized.url)) {
      candidates.set(sanitized.url, { url: sanitized.url, category: pathCategory, fate: "not_fetched" });
    }
  }

  /** Deterministic choice of the next page to fetch. */
  function nextFromFrontier(): FrontierEntry | null {
    const covered = new Set(pages.map((page) => page.category).filter(Boolean));
    let best: FrontierEntry | null = null;
    let bestKey: Array<number | string> = [];
    for (const entry of frontier.values()) {
      const category = entry.pathCategory ?? entry.anchorCategory;
      const rank = category === null ? 2 : covered.has(category) ? 1 : 0;
      const key: Array<number | string> = [
        rank,
        category === null ? 99 : CATEGORY_ORDER.indexOf(category),
        entry.pathCategory ? 0 : 1,
        entry.via === "link" ? 0 : 1,
        entry.depth,
        entry.url,
      ];
      if (best === null || compareKeys(key, bestKey) < 0) {
        best = entry;
        bestKey = key;
      }
    }
    return best;
  }

  async function fetchPage(url: string, via: FetchRecord["discoveredVia"]): Promise<void> {
    const fetched = await fetchResource("page", url, via, "text/html,application/xhtml+xml", policy.htmlMaxBytes, "reject");
    const { record } = fetched;
    const candidate = candidates.get(record.requestedUrl);
    if (seenPageUrls.has(record.url) && record.url !== record.requestedUrl) {
      // Redirected onto a page already recorded: no second row.
      if (candidate) candidate.fate = "duplicate";
      return;
    }
    if (record.fetchError === "blocked_by_robots" && via !== "start") {
      if (candidate) candidate.fate = "blocked_by_robots";
      return;
    }
    record.pageIndex = pages.length;
    record.category = categoryFromPath(new URL(record.url).pathname);
    if (record.fetchError === null && record.httpStatus !== null && record.httpStatus >= 200 && record.httpStatus < 300) {
      if (!isHtmlType(record.contentType ?? undefined)) record.fetchError = "not_html";
    }
    pages.push(record);
    seenPageUrls.add(record.url);
    seenPageUrls.add(record.requestedUrl);
    if (candidate) {
      candidate.fate =
        record.fetchError === null
          ? "fetched"
          : record.fetchError === "robots_unavailable"
            ? "blocked_by_robots"
            : (record.fetchError as LinkCandidate["fate"]);
      if (candidate.fate === "fetched" && candidate.category === null) candidate.category = record.category;
    }
    const ok = record.fetchError === null && fetched.bytes !== null && record.httpStatus !== null && record.httpStatus >= 200 && record.httpStatus < 300;
    if (ok && fetched.bytes && fetched.headers && fetched.finalUrl) {
      bodies.set(record.pageIndex, { bytes: fetched.bytes, headers: fetched.headers });
      const facts = extractPageFacts(fetched.bytes, fetched.headers, fetched.finalUrl, policy.maxLinksPerPage);
      for (const link of facts.links) enqueue(link.href, link.text, "link");
    }
  }

  try {
    const robotsResult = await robotsFor(startOrigin);
    robotsCache.set(startOrigin, robotsResult.policy);
    // apex/robots.txt -> www/robots.txt: the same file governs the www host.
    if (robotsAnsweredBy) robotsCache.set(robotsAnsweredBy, robotsResult.policy);
    robots = { policyKind: robotsResult.policy.kind, record: robotsResult.record, parsed: robotsResult.policy.parsed };

    if (robotsResult.policy.kind === "unreachable") {
      // Complete disallow: the homepage gets a row saying why it was not fetched.
      const home = emptyRecord("page", input.startUrl, "start");
      home.pageIndex = 0;
      home.robotsAllowed = false;
      home.fetchError = "robots_unavailable";
      home.fetchedAt = robotsResult.record.fetchedAt;
      pages.push(home);
      throw new Stop("robots_unavailable");
    }

    await fetchPage(input.startUrl, "start");
    // Auxiliary files live on the host the homepage settled on (apex -> www).
    const siteOrigin = pages[0]?.httpStatus !== null && pages[0]?.url ? new URL(pages[0].url).origin : startOrigin;

    // sitemap.xml: a same-site Sitemap: directive first, else the default path.
    const directive = (robotsResult.policy.parsed?.sitemaps ?? [])
      .map((value) => {
        try {
          const url = new URL(value);
          return isSameSite(url, hosts) && url.search === "" ? url.toString() : null;
        } catch {
          return null;
        }
      })
      .find((value): value is string => value !== null);
    const sitemapUrl = directive ?? `${siteOrigin}/sitemap.xml`;
    const sitemapFetched = await fetchResource(
      "sitemap",
      sitemapUrl,
      "fixed_path",
      "application/xml,text/xml;q=0.9,*/*;q=0.1",
      policy.sitemapMaxBytes,
      "reject"
    );
    sitemap = { record: sitemapFetched.record, summary: null };
    if (sitemapFetched.bytes && sitemapFetched.record.httpStatus !== null && sitemapFetched.record.httpStatus < 300) {
      const parsed = parseSitemap(sitemapFetched.bytes, policy.maxSitemapUrls);
      const sameSite = parsed.locs.filter((loc) => {
        try {
          return isSameSite(new URL(loc), hosts);
        } catch {
          return false;
        }
      });
      sitemap.summary = {
        format: parsed.format,
        urlCount: parsed.locs.length,
        sameSiteUrlCount: sameSite.length,
        source: directive ? "robots_directive" : "default_path",
      };
      if (parsed.format === "urlset") for (const loc of sameSite) enqueue(loc, "", "sitemap");
    }

    const llmsFetched = await fetchResource(
      "llms_txt",
      `${siteOrigin}/llms.txt`,
      "fixed_path",
      "text/plain,text/markdown;q=0.9,*/*;q=0.1",
      policy.llmsTxtMaxBytes,
      "truncate"
    );
    llmsTxt = { record: llmsFetched.record, summary: null };
    if (llmsFetched.bytes && llmsFetched.record.httpStatus !== null && llmsFetched.record.httpStatus >= 200 && llmsFetched.record.httpStatus < 300) {
      if (isHtmlType(llmsFetched.record.contentType ?? undefined)) {
        llmsFetched.record.fetchError = "not_html"; // an HTML page, not a text file
      } else {
        llmsTxt.summary = summarizeLlmsTxt(llmsFetched.bytes);
      }
    }

    // Remaining pages, buyer-relevant first, until a bound stops the crawl.
    while (true) {
      if (pages.length >= policy.pageCap) {
        if (frontier.size > 0) throw new Stop("page_cap");
        break;
      }
      const next = nextFromFrontier();
      if (!next) break;
      frontier.delete(next.url);
      await fetchPage(next.url, next.via);
    }
    stopReason = "frontier_exhausted";
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    stopReason = error.reason;
  }

  const responded = pages.some((page) => page.httpStatus !== null);
  let outcome: RunOutcome;
  if (stopReason === "cancelled") outcome = "cancelled";
  else if (stopReason === "robots_unavailable") outcome = "robots_unavailable";
  else if (!responded && pages.every((page) => page.fetchError !== "blocked_by_robots")) {
    outcome = "failed";
    if (stopReason === "frontier_exhausted") stopReason = "homepage_unavailable";
  } else outcome = "completed";

  const capture: CrawlCapture = {
    input,
    startedAt: iso(startedMs),
    completedAt: iso(now()),
    outcome,
    stopReason: stopReason ?? "frontier_exhausted",
    robots,
    sitemap,
    llmsTxt,
    pages,
    candidates: [...candidates.values()].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)),
    requestCount,
    capReached: stopReason === "page_cap" || stopReason === "request_budget" || stopReason === "deadline",
  };
  return { capture, bodies };
}

function compareKeys(a: Array<number | string>, b: Array<number | string>): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === b[i]) continue;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/* ------------------------------------------------- auxiliary parsers */

export function parseSitemap(bytes: Uint8Array, maxUrls: number): { format: SitemapSummary["format"]; locs: string[] } {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(text, { xmlMode: true } as never);
  } catch {
    return { format: "invalid", locs: [] };
  }
  const root = $.root().children().first();
  const name = (root.prop("tagName") ?? root.get(0)?.tagName ?? "").toString().toLowerCase().replace(/^.*:/, "");
  const format: SitemapSummary["format"] = name === "urlset" ? "urlset" : name === "sitemapindex" ? "sitemapindex" : "invalid";
  if (format === "invalid") return { format, locs: [] };
  const locs: string[] = [];
  $(format === "urlset" ? "url > loc" : "sitemap > loc").each((_, el) => {
    if (locs.length >= maxUrls) return false;
    const value = $(el).text().trim();
    if (value) locs.push(value);
    return undefined;
  });
  return { format, locs };
}

export function summarizeLlmsTxt(bytes: Uint8Array): LlmsTxtSummary {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const firstLine = text.split(/\r\n|\r|\n/).find((line) => line.trim() !== "") ?? "";
  return { startsWithHeading: /^#\s+\S/.test(firstLine.trim()) };
}

export type { RedirectHop };
