import * as cheerio from "cheerio";

/**
 * Minimal Sprint 1 crawler.
 *
 * - Starts at the homepage.
 * - Collects internal links.
 * - Prioritizes high-value page types (pricing, features, use-cases,
 *   customers, case studies, blog, faq, comparison, about).
 * - Stops at `maxPages`.
 * - Strips scripts, styles, nav/header/footer noise before extracting text.
 * - Returns a clear error object on failure — do not throw.
 *
 * Do not overbuild. We need enough for the Site Reader Agent, no more.
 */

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
  pageType: PageType;
}

export type PageType =
  | "homepage"
  | "pricing"
  | "features"
  | "use_cases"
  | "customers"
  | "case_studies"
  | "blog"
  | "faq"
  | "comparison"
  | "about"
  | "other";

export interface CrawlSiteInput {
  websiteUrl: string;
  maxPages: number;
  /** Fetch timeout per page, in ms. Defaults to 15s. */
  timeoutMs?: number;
  /** Fetch user-agent. */
  userAgent?: string;
}

export type CrawlSiteResult =
  | { ok: true; pages: CrawledPage[]; startUrl: string; domain: string }
  | { ok: false; error: string };

const DEFAULT_UA = "ZypactBot/0.1 (+https://zypact.com)";

const PAGE_TYPE_PATTERNS: Array<{ type: PageType; re: RegExp; priority: number }> = [
  { type: "pricing", re: /\/(pricing|plans?)(\/|$)/i, priority: 100 },
  { type: "features", re: /\/(features?|product|platform|capabilities)(\/|$)/i, priority: 90 },
  { type: "use_cases", re: /\/(use[-_]?cases?|solutions?|for[-_]|industries)(\/|$)/i, priority: 85 },
  { type: "customers", re: /\/(customers?|clients?)(\/|$)/i, priority: 80 },
  { type: "case_studies", re: /\/(case[-_]?stud(y|ies)|stories|success)(\/|$)/i, priority: 78 },
  { type: "comparison", re: /\/(compare|comparison|vs)(\/|$)/i, priority: 70 },
  { type: "faq", re: /\/(faqs?|help|support)(\/|$)/i, priority: 60 },
  { type: "about", re: /\/(about|company|team)(\/|$)/i, priority: 50 },
  { type: "blog", re: /\/(blog|resources?|articles?|posts?)(\/|$)/i, priority: 40 },
];

function classifyUrl(u: URL, isRoot: boolean): { type: PageType; priority: number } {
  if (isRoot) return { type: "homepage", priority: 200 };
  for (const p of PAGE_TYPE_PATTERNS) {
    if (p.re.test(u.pathname)) return { type: p.type, priority: p.priority };
  }
  return { type: "other", priority: 10 };
}

function normalizeUrl(raw: string, base: URL): URL | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    // Strip common tracking params.
    for (const key of Array.from(u.searchParams.keys())) {
      if (/^utm_|^gclid$|^fbclid$|^ref$/i.test(key)) u.searchParams.delete(key);
    }
    return u;
  } catch {
    return null;
  }
}

const NON_CONTENT_EXT =
  /\.(pdf|zip|rar|dmg|exe|png|jpe?g|gif|webp|svg|ico|mp3|mp4|mov|css|js|json|xml|txt|woff2?|ttf|eot)(\?|$)/i;

function looksLikeAsset(u: URL): boolean {
  return NON_CONTENT_EXT.test(u.pathname);
}

async function fetchWithTimeout(url: string, timeoutMs: number, userAgent: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": userAgent,
        accept: "text/html,application/xhtml+xml",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function extractPageContent($: cheerio.CheerioAPI): { title: string; text: string; links: string[] } {
  // Strip obvious noise before extracting text.
  $(
    "script,style,noscript,template,svg,iframe,form,button,nav,header,footer,aside,[role='navigation'],[role='banner'],[role='contentinfo'],.nav,.navbar,.menu,.footer,.header,.cookie,.cookies,.consent"
  ).remove();

  const title = ($("title").first().text() || $("h1").first().text() || "").trim();

  const root = $("main").length ? $("main") : $("body");
  const raw = root.text().replace(/\s+/g, " ").trim();

  const links: string[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (href) links.push(href);
  });

  return { title, text: raw, links };
}

export async function crawlSite(input: CrawlSiteInput): Promise<CrawlSiteResult> {
  const maxPages = Math.max(1, Math.floor(input.maxPages));
  const timeoutMs = input.timeoutMs ?? 15_000;
  const userAgent = input.userAgent ?? DEFAULT_UA;

  let startUrl: URL;
  try {
    startUrl = new URL(input.websiteUrl);
    if (startUrl.protocol !== "http:" && startUrl.protocol !== "https:") {
      return { ok: false, error: "URL must use http or https" };
    }
  } catch {
    return { ok: false, error: `Invalid URL: ${input.websiteUrl}` };
  }

  const domain = startUrl.hostname;
  const visited = new Set<string>();
  const results: CrawledPage[] = [];

  interface QueueItem {
    url: URL;
    priority: number;
    isRoot: boolean;
  }
  const queue: QueueItem[] = [{ url: startUrl, priority: 200, isRoot: true }];

  while (queue.length > 0 && results.length < maxPages) {
    // Highest priority first.
    queue.sort((a, b) => b.priority - a.priority);
    const next = queue.shift()!;
    const key = next.url.toString();
    if (visited.has(key)) continue;
    visited.add(key);

    if (looksLikeAsset(next.url)) continue;
    if (next.url.hostname !== domain) continue;

    let html: string;
    try {
      const res = await fetchWithTimeout(key, timeoutMs, userAgent);
      if (!res.ok) {
        if (next.isRoot) {
          return { ok: false, error: `Homepage returned HTTP ${res.status}` };
        }
        continue;
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
        if (next.isRoot) {
          return { ok: false, error: `Homepage is not HTML (${contentType})` };
        }
        continue;
      }
      html = await res.text();
    } catch (err) {
      if (next.isRoot) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `Failed to fetch homepage: ${msg}` };
      }
      continue;
    }

    const $ = cheerio.load(html);
    const { title, text, links } = extractPageContent($);
    const classification = classifyUrl(next.url, next.isRoot);

    results.push({
      url: key,
      title,
      text: text.slice(0, 20_000), // cap per-page to keep prompts manageable
      pageType: classification.type,
    });

    // Enqueue internal links.
    for (const href of links) {
      const linked = normalizeUrl(href, next.url);
      if (!linked) continue;
      if (linked.hostname !== domain) continue;
      const linkedKey = linked.toString();
      if (visited.has(linkedKey)) continue;
      if (queue.some((q) => q.url.toString() === linkedKey)) continue;
      if (looksLikeAsset(linked)) continue;
      const linkClass = classifyUrl(linked, false);
      queue.push({ url: linked, priority: linkClass.priority, isRoot: false });
    }
  }

  if (results.length === 0) {
    return { ok: false, error: "Crawler produced 0 pages" };
  }

  return { ok: true, pages: results, startUrl: startUrl.toString(), domain };
}
