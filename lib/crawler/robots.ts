/**
 * robots.txt handling per RFC 9309, as docs/SELF_SERVICE_PRODUCT.md §6.2
 * requires for the W1 Website Diagnostic.
 *
 * Pure: no network, no clock of its own. The W1 crawler fetches the file
 * through the SSRF-safe transport and hands the outcome here.
 *
 * What the docs fix, and how it maps:
 *   - 2xx: the body is parsed (at most 500 KiB; anything after is ignored).
 *   - 4xx: "unavailable" in RFC terms: no restrictions.
 *   - 5xx, or an unreachable host: "unreachable": complete disallow. The docs
 *     call this `robots_unavailable`; note the naming trap, RFC "unavailable"
 *     is the 4xx case and means the opposite.
 *   - Groups match by product token; the longest path match wins and Allow
 *     wins a tie; /robots.txt itself is always allowed.
 *   - The file is cached for at most 24 hours.
 *
 * Choices the docs leave open, made fail-closed and listed in
 * docs/W1_WEBSITE_DIAGNOSTIC.md for founder review: 429 is treated as
 * unreachable (disallow), and so is a redirect chain longer than 5 or one
 * that leaves the site.
 *
 * Not used by the legacy crawler (lib/crawler/crawl-site.ts): adding robots
 * handling there would change the founder snapshot pipeline, which is a
 * separate decision.
 */

/** RFC 9309 §2.5: crawlers MUST parse at least 500 kibibytes. */
export const ROBOTS_MAX_BYTES = 512_000;

/** RFC 9309 §2.4: SHOULD NOT use a cached copy for more than 24 hours. */
export const ROBOTS_MAX_CACHE_MS = 24 * 60 * 60 * 1000;

export interface RobotsRule {
  allow: boolean;
  /** The path pattern exactly as normalised for matching. */
  pattern: string;
}

export interface RobotsGroup {
  /** Lowercased product tokens from the group's user-agent lines. */
  agents: string[];
  rules: RobotsRule[];
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  /** Absolute Sitemap: values, in file order (not validated here). */
  sitemaps: string[];
  /** Non-empty, non-comment lines that are not a recognised directive. */
  invalidLineCount: number;
  /** True when the input exceeded ROBOTS_MAX_BYTES and was cut. */
  truncated: boolean;
}

/** How a robots.txt fetch ended, before any parsing. */
export type RobotsFetchOutcome =
  | { kind: "status"; status: number; bodyBytes: Uint8Array }
  | { kind: "unreachable" };

export type RobotsPolicyKind = "parsed" | "not_found" | "unreachable";

export interface RobotsPolicy {
  kind: RobotsPolicyKind;
  /** Present only for "parsed". */
  parsed: ParsedRobots | null;
}

/** Map a fetch outcome to the RFC 9309 policy. */
export function robotsPolicyFromFetch(outcome: RobotsFetchOutcome): RobotsPolicy {
  if (outcome.kind === "unreachable") return { kind: "unreachable", parsed: null };
  const { status } = outcome;
  if (status >= 200 && status < 300) {
    return { kind: "parsed", parsed: parseRobotsTxt(outcome.bodyBytes) };
  }
  // 429 is a server asking to be left alone; fail closed (proposed choice).
  if (status === 429) return { kind: "unreachable", parsed: null };
  if (status >= 400 && status < 500) return { kind: "not_found", parsed: null };
  // 5xx and anything unexpected (1xx, an unfollowed 3xx): fail closed.
  return { kind: "unreachable", parsed: null };
}

/* ------------------------------------------------------------- Parsing */

/** Product token of a user-agent line value: the leading [A-Za-z_-] run. */
function productToken(value: string): string {
  const match = value.trim().match(/^[A-Za-z_-]+|^\*/);
  return match ? match[0].toLowerCase() : "";
}

export function parseRobotsTxt(input: Uint8Array | string): ParsedRobots {
  let bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let truncated = false;
  if (bytes.length > ROBOTS_MAX_BYTES) {
    bytes = bytes.subarray(0, ROBOTS_MAX_BYTES);
    truncated = true;
  }
  // RFC 9309 §2.3: the file is UTF-8. Invalid sequences become U+FFFD and
  // the line they are on simply fails to match a directive.
  let text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
  if (truncated) {
    // A cut mid-line would turn a rule into a different, shorter rule.
    const lastBreak = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
    text = lastBreak >= 0 ? text.slice(0, lastBreak) : "";
  }

  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let invalidLineCount = 0;
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon <= 0) {
      invalidLineCount += 1;
      continue;
    }
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "user-agent") {
      const token = productToken(value);
      if (!lastWasAgent || current === null) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      if (token) current.agents.push(token);
      lastWasAgent = true;
      continue;
    }

    if (key === "allow" || key === "disallow") {
      lastWasAgent = false;
      // Rules before any user-agent line belong to no group (RFC 9309 §2.1).
      if (current === null) continue;
      // An empty Disallow means "no rule"; an empty Allow is equally inert.
      if (value === "") continue;
      current.rules.push({ allow: key === "allow", pattern: normalisePattern(value) });
      continue;
    }

    if (key === "sitemap") {
      // Sitemap lines are not part of any group and do not end one.
      if (value) sitemaps.push(value);
      continue;
    }

    // Other records (crawl-delay, host, ...) are legal but not used here;
    // like a rule line, they end the run of user-agent lines.
    lastWasAgent = false;
    if (!/^[a-z-]+$/.test(key)) invalidLineCount += 1;
  }

  return { groups, sitemaps, invalidLineCount, truncated };
}

/* ------------------------------------------------------------ Matching */

const UNRESERVED = /[A-Za-z0-9\-._~]/;

/**
 * RFC 9309 §2.2.2 normalisation, applied to both the rule pattern and the
 * request path: percent-decode octets that are unreserved characters,
 * upper-case the hex of the rest, and percent-encode non-ASCII as UTF-8.
 * `*` and `$` in patterns are left as operators.
 */
function normaliseOctets(value: string): string {
  let out = "";
  const encoder = new TextEncoder();
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "%" && /^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))) {
      const decoded = String.fromCharCode(parseInt(value.slice(i + 1, i + 3), 16));
      out += UNRESERVED.test(decoded) ? decoded : "%" + value.slice(i + 1, i + 3).toUpperCase();
      i += 2;
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x7e || code < 0x21) {
      const full = String.fromCodePoint(code);
      for (const byte of encoder.encode(full)) {
        out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
      }
      if (code > 0xffff) i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function normalisePattern(pattern: string): string {
  const withSlash = pattern.startsWith("/") || pattern.startsWith("*") ? pattern : "/" + pattern;
  return normaliseOctets(withSlash);
}

/** Normalise a URL path (+ optional query) for matching. */
export function normaliseRequestPath(pathAndQuery: string): string {
  return normaliseOctets(pathAndQuery === "" ? "/" : pathAndQuery);
}

const patternCache = new Map<string, RegExp>();

/** `*` matches any sequence; a trailing `$` anchors the end; else prefix. */
function patternMatches(pattern: string, path: string): boolean {
  let regex = patternCache.get(pattern);
  if (!regex) {
    const anchored = pattern.endsWith("$");
    const body = anchored ? pattern.slice(0, -1) : pattern;
    const source = body
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    regex = new RegExp("^" + source + (anchored ? "$" : ""));
    if (patternCache.size < 4096) patternCache.set(pattern, regex);
  }
  return regex.test(path);
}

export interface RobotsDecision {
  allowed: boolean;
  /** Which group applied: the token's own, the "*" group, or none. */
  groupSource: "specific" | "star" | "none";
  matchedRule: RobotsRule | null;
}

/** The merged rules that apply to `token` (RFC 9309 §2.2.1). */
export function rulesForToken(
  parsed: ParsedRobots,
  token: string
): { rules: RobotsRule[]; groupSource: RobotsDecision["groupSource"] } {
  const wanted = token.toLowerCase();
  const specific = parsed.groups.filter((group) => group.agents.includes(wanted));
  if (specific.length > 0) {
    return { rules: specific.flatMap((group) => group.rules), groupSource: "specific" };
  }
  const star = parsed.groups.filter((group) => group.agents.includes("*"));
  if (star.length > 0) {
    return { rules: star.flatMap((group) => group.rules), groupSource: "star" };
  }
  return { rules: [], groupSource: "none" };
}

/**
 * Is `pathAndQuery` allowed for `token` under a parsed file?
 * Longest matching pattern wins; Allow wins a tie (RFC 9309 §2.2.2).
 */
export function evaluateRobots(
  parsed: ParsedRobots,
  token: string,
  pathAndQuery: string
): RobotsDecision {
  const path = normaliseRequestPath(pathAndQuery);
  const { rules, groupSource } = rulesForToken(parsed, token);
  if (path === "/robots.txt") return { allowed: true, groupSource, matchedRule: null };

  let best: RobotsRule | null = null;
  for (const rule of rules) {
    if (!patternMatches(rule.pattern, path)) continue;
    if (
      best === null ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return { allowed: best === null ? true : best.allow, groupSource, matchedRule: best };
}

/** Decision under a whole policy, including the not_found/unreachable cases. */
export function isAllowedByPolicy(policy: RobotsPolicy, token: string, pathAndQuery: string): boolean {
  if (normaliseRequestPath(pathAndQuery) === "/robots.txt") return true;
  if (policy.kind === "not_found") return true;
  if (policy.kind === "unreachable" || policy.parsed === null) return false;
  return evaluateRobots(policy.parsed, token, pathAndQuery).allowed;
}

/* --------------------------------------------------------------- Cache */

/**
 * In-process cache keyed by origin, with an injected clock and a bounded
 * size. Entries expire after at most 24 hours.
 */
export class RobotsCache {
  private readonly entries = new Map<string, { policy: RobotsPolicy; storedAt: number }>();

  constructor(
    private readonly now: () => number,
    private readonly maxEntries = 256,
    private readonly ttlMs = ROBOTS_MAX_CACHE_MS
  ) {
    if (ttlMs > ROBOTS_MAX_CACHE_MS) throw new Error("robots cache TTL exceeds 24 hours");
  }

  get(origin: string): RobotsPolicy | null {
    const entry = this.entries.get(origin);
    if (!entry) return null;
    if (this.now() - entry.storedAt >= this.ttlMs) {
      this.entries.delete(origin);
      return null;
    }
    return entry.policy;
  }

  set(origin: string, policy: RobotsPolicy): void {
    this.entries.delete(origin);
    this.entries.set(origin, { policy, storedAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
