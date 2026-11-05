/**
 * Facts read from one fetched HTML page, for the W1 checks.
 *
 * Reads the UNMODIFIED document (unlike crawl-site.ts, which strips nav,
 * header, footer and every script before reading, and so loses JSON-LD,
 * navigation links and the footer brand). No JavaScript runs: what is
 * reported is what the server returned.
 *
 * Pure module. The page body is decoded here and dropped; only the facts
 * below leave this module, and excerpts are capped and screened by
 * excerpt.ts before they are kept.
 */
import * as cheerio from "cheerio";

import { CATEGORY_ORDER } from "@/lib/site-diagnostic/buyer-pages";

export interface SourceSpan {
  /** Exact text of the span in the decoded source (entities not decoded). */
  text: string;
  /** UTF-8 byte offsets into the raw body; only when offsets are exact. */
  start: number;
  end: number;
}

export interface JsonLdFacts {
  blockCount: number;
  invalidBlockCount: number;
  /** Lowercased @type values found anywhere in each block, deduplicated. */
  types: string[];
  organization: {
    present: boolean;
    hasName: boolean;
    hasUrl: boolean;
    hasLogo: boolean;
    sameAsCount: number;
  };
  /** name values of Organization / Corporation / WebSite nodes. */
  entityNames: string[];
}

export interface PageLink {
  /** Absolute URL as resolved (not yet sanitised). */
  href: string;
  /** Collapsed anchor text, at most 120 characters. */
  text: string;
}

export interface PageFacts {
  decodedAs: string;
  /** Byte offsets are exact only when the bytes are valid UTF-8. */
  offsetsExact: boolean;
  lang: string | null;
  titles: SourceSpan[];
  metaDescriptions: SourceSpan[];
  h1s: SourceSpan[];
  /** Raw href values of every link rel=canonical. */
  canonicals: string[];
  /** Lowercased directive tokens from meta name=robots and X-Robots-Tag. */
  robotsDirectives: {
    metaGeneric: string[];
    metaScoped: string[];
    headerGeneric: string[];
    headerScoped: string[];
  };
  ogSiteName: string | null;
  jsonLd: JsonLdFacts;
  links: PageLink[];
  wordCount: number;
  hasPasswordInput: boolean;
  /** Collapsed text of footer / role=contentinfo, at most 2,000 characters. */
  footerText: string;
  /** Collapsed visible body text, at most 20,000 characters (in memory only). */
  bodyText: string;
}

/* ------------------------------------------------------------ Decoding */

function charsetFromContentType(contentType: string | undefined): string | null {
  const match = contentType?.match(/charset\s*=\s*"?([A-Za-z0-9._:-]+)/i);
  return match ? match[1].toLowerCase() : null;
}

function charsetFromMeta(bytes: Uint8Array): string | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  const match =
    head.match(/<meta[^>]+charset\s*=\s*["']?([A-Za-z0-9._:-]+)/i) ??
    head.match(/<meta[^>]+content\s*=\s*["'][^"']*charset=([A-Za-z0-9._:-]+)/i);
  return match ? match[1].toLowerCase() : null;
}

export function decodeHtml(
  bytes: Uint8Array,
  contentType: string | undefined
): { text: string; decodedAs: string; offsetsExact: boolean } {
  const label = charsetFromContentType(contentType) ?? charsetFromMeta(bytes) ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label, { fatal: false, ignoreBOM: true });
  } catch {
    decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  }
  const text = decoder.decode(bytes);
  const isUtf8 = decoder.encoding === "utf-8";
  // Exact iff re-encoding reproduces the received bytes (no invalid sequences).
  const offsetsExact = isUtf8 && Buffer.from(text, "utf8").equals(Buffer.from(bytes));
  return { text, decodedAs: decoder.encoding, offsetsExact };
}

/* ------------------------------------------------------------ Helpers */

const collapse = (value: string): string => value.replace(/\s+/g, " ").trim();

interface Located {
  sourceCodeLocation?: {
    startOffset: number;
    endOffset: number;
    attrs?: Record<string, { startOffset: number; endOffset: number }>;
  } | null;
}

function byteOffset(source: string, index: number): number {
  return Buffer.byteLength(source.slice(0, index), "utf8");
}

/** A span over source[start, end), trimmed of surrounding whitespace. */
function span(source: string, start: number, end: number, exact: boolean): SourceSpan {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(source[s])) s += 1;
  while (e > s && /\s/.test(source[e - 1])) e -= 1;
  const text = source.slice(s, e);
  return exact ? { text, start: byteOffset(source, s), end: byteOffset(source, e) } : { text, start: -1, end: -1 };
}

function elementTextSpan(source: string, element: unknown, exact: boolean): SourceSpan | null {
  const located = element as Located & { children?: Array<Located & { type?: string }> };
  const children = located.children ?? [];
  if (children.length === 0) return { text: "", start: -1, end: -1 };
  const first = children[0].sourceCodeLocation;
  const last = children[children.length - 1].sourceCodeLocation;
  if (!first || !last) return null;
  return span(source, first.startOffset, last.endOffset, exact);
}

function attributeValueSpan(source: string, element: unknown, name: string, exact: boolean): SourceSpan | null {
  const location = (element as Located).sourceCodeLocation?.attrs?.[name];
  if (!location) return null;
  const raw = source.slice(location.startOffset, location.endOffset);
  const match = raw.match(/^[^=]+=\s*(["']?)/);
  if (!match) return { text: "", start: -1, end: -1 };
  const quote = match[1];
  const valueStart = location.startOffset + match[0].length;
  const valueEnd = location.endOffset - (quote && raw.endsWith(quote) ? 1 : 0);
  return span(source, valueStart, Math.max(valueStart, valueEnd), exact);
}

const SCOPED_ROBOT_NAMES = /^(googlebot|googlebot-news|bingbot|slurp|duckduckbot|baiduspider|yandex|gptbot|oai-searchbot|chatgpt-user|claudebot|perplexitybot|applebot|ccbot)$/i;

function directiveTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

/** X-Robots-Tag values: "noindex", "googlebot: noindex, nofollow", repeated. */
function headerDirectives(header: string | undefined): { generic: string[]; scoped: string[] } {
  const generic: string[] = [];
  const scoped: string[] = [];
  if (!header) return { generic, scoped };
  for (const part of header.split(",")) {
    const value = part.trim();
    const scopedMatch = value.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (scopedMatch && !/^(unavailable_after|max-snippet|max-image-preview|max-video-preview)$/i.test(scopedMatch[1])) {
      scoped.push(...directiveTokens(scopedMatch[2]));
    } else {
      generic.push(...directiveTokens(value));
    }
  }
  return { generic, scoped };
}

/* ------------------------------------------------------------ JSON-LD */

function collectNodes(value: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (depth > 6 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) collectNodes(item, out, depth + 1);
    return;
  }
  const node = value as Record<string, unknown>;
  out.push(node);
  if (Array.isArray(node["@graph"])) collectNodes(node["@graph"], out, depth + 1);
}

function typesOf(node: Record<string, unknown>): string[] {
  const raw = node["@type"];
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return list
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/^https?:\/\/schema\.org\//i, "").toLowerCase());
}

const ORG_TYPES = new Set(["organization", "corporation", "localbusiness", "onlinebusiness", "ngo"]);

function readJsonLd($: cheerio.CheerioAPI): JsonLdFacts {
  const facts: JsonLdFacts = {
    blockCount: 0,
    invalidBlockCount: 0,
    types: [],
    organization: { present: false, hasName: false, hasUrl: false, hasLogo: false, sameAsCount: 0 },
    entityNames: [],
  };
  const types = new Set<string>();
  $('script[type]').each((_, element) => {
    const type = ($(element).attr("type") ?? "").toLowerCase().split(";")[0].trim();
    if (type !== "application/ld+json") return;
    facts.blockCount += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse($(element).text());
    } catch {
      facts.invalidBlockCount += 1;
      return;
    }
    const nodes: Record<string, unknown>[] = [];
    collectNodes(parsed, nodes);
    for (const node of nodes) {
      const nodeTypes = typesOf(node);
      nodeTypes.forEach((t) => types.add(t));
      const name = typeof node.name === "string" ? collapse(node.name) : "";
      if (nodeTypes.some((t) => ORG_TYPES.has(t))) {
        facts.organization.present = true;
        if (name) facts.organization.hasName = true;
        if (typeof node.url === "string" && node.url.trim()) facts.organization.hasUrl = true;
        if (node.logo !== undefined && node.logo !== null && node.logo !== "") facts.organization.hasLogo = true;
        const sameAs = node.sameAs;
        const count = Array.isArray(sameAs) ? sameAs.length : typeof sameAs === "string" ? 1 : 0;
        facts.organization.sameAsCount = Math.max(facts.organization.sameAsCount, count);
      }
      if (name && nodeTypes.some((t) => ORG_TYPES.has(t) || t === "website")) {
        facts.entityNames.push(name.slice(0, 200));
      }
    }
  });
  facts.types = [...types].sort();
  return facts;
}

/* ------------------------------------------------------------- Extract */

export function extractPageFacts(
  bytes: Uint8Array,
  headers: Readonly<Record<string, string>>,
  pageUrl: string,
  maxLinks: number
): PageFacts {
  const { text: source, decodedAs, offsetsExact } = decodeHtml(bytes, headers["content-type"]);
  const $ = cheerio.load(source, { sourceCodeLocationInfo: true } as never);

  const titleElements = $("title").filter((_, el) => $(el).parents("svg").length === 0).toArray();
  const titles = titleElements
    .map((el) => elementTextSpan(source, el, offsetsExact))
    .filter((value): value is SourceSpan => value !== null);

  const metaDescriptions = $("meta")
    .filter((_, el) => ($(el).attr("name") ?? "").toLowerCase() === "description")
    .toArray()
    .map((el) => attributeValueSpan(source, el, "content", offsetsExact) ?? { text: "", start: -1, end: -1 });

  const h1s = $("h1")
    .toArray()
    .map((el) => {
      const located = elementTextSpan(source, el, offsetsExact);
      // H1s often wrap markup; keep the readable text when the span is not plain.
      const plain = collapse($(el).text());
      if (located && located.text === plain) return located;
      return { text: plain, start: -1, end: -1 };
    });

  const canonicals = $("link")
    .filter((_, el) => (($(el).attr("rel") ?? "").toLowerCase().split(/\s+/)).includes("canonical"))
    .toArray()
    .map((el) => ($(el).attr("href") ?? "").trim());

  const metaGeneric: string[] = [];
  const metaScoped: string[] = [];
  $("meta[name]").each((_, el) => {
    const name = ($(el).attr("name") ?? "").toLowerCase();
    const content = $(el).attr("content") ?? "";
    if (name === "robots") metaGeneric.push(...directiveTokens(content));
    else if (SCOPED_ROBOT_NAMES.test(name)) metaScoped.push(...directiveTokens(content));
  });
  const header = headerDirectives(headers["x-robots-tag"]);

  const ogSiteNameRaw = $("meta")
    .filter((_, el) => ($(el).attr("property") ?? $(el).attr("name") ?? "").toLowerCase() === "og:site_name")
    .first()
    .attr("content");

  // Base for relative links: <base href> when valid, else the page URL.
  let base = pageUrl;
  const baseHref = $("base[href]").first().attr("href");
  if (baseHref) {
    try {
      base = new URL(baseHref, pageUrl).toString();
    } catch {
      base = pageUrl;
    }
  }
  const links: PageLink[] = [];
  $("a[href]").each((_, el) => {
    if (links.length >= maxLinks) return false;
    const href = ($(el).attr("href") ?? "").trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(href)) return undefined;
    try {
      const absolute = new URL(href, base);
      absolute.hash = "";
      links.push({ href: absolute.toString(), text: collapse($(el).text()).slice(0, 120) });
    } catch {
      // unparseable href: ignored
    }
    return undefined;
  });

  const footerText = collapse($("footer, [role=contentinfo]").first().text()).slice(0, 2_000);
  const hasPasswordInput = $('input[type="password" i]').length > 0;

  const body = $("body").clone();
  body.find("script, style, noscript, template, svg").remove();
  const bodyText = collapse(body.text()).slice(0, 20_000);
  const wordCount = bodyText === "" ? 0 : bodyText.split(" ").filter((word) => /[\p{L}\p{N}]/u.test(word)).length;

  return {
    decodedAs,
    offsetsExact,
    lang: ($("html").attr("lang") ?? "").trim().toLowerCase() || null,
    titles,
    metaDescriptions,
    h1s,
    canonicals,
    robotsDirectives: { metaGeneric, metaScoped, headerGeneric: header.generic, headerScoped: header.scoped },
    ogSiteName: ogSiteNameRaw ? collapse(ogSiteNameRaw).slice(0, 200) : null,
    jsonLd: readJsonLd($),
    links,
    wordCount,
    hasPasswordInput,
    footerText,
    bodyText,
  };
}

/** Exposed for tests and the crawler's discovery ordering. */
export const CATEGORY_DISCOVERY_ORDER = CATEGORY_ORDER;
