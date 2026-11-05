#!/usr/bin/env tsx
/**
 * W1-B: RFC 9309 robots.txt handling (lib/crawler/robots.ts).
 *
 * Offline and pure: parsing, group matching, path matching, the fetch-status
 * policy (including the docs' robots_unavailable naming trap), truncation at
 * 500 KiB, and the 24-hour bounded cache under an injected clock.
 */
import {
  ROBOTS_MAX_BYTES,
  ROBOTS_MAX_CACHE_MS,
  RobotsCache,
  evaluateRobots,
  isAllowedByPolicy,
  parseRobotsTxt,
  robotsPolicyFromFetch,
} from "@/lib/crawler/robots";

let failures = 0;
let total = 0;
function check(label: string, condition: boolean): void {
  total += 1;
  if (condition) console.log("  ✓ " + label);
  else {
    failures += 1;
    console.error("  ✗ " + label);
  }
}

let fetchCalls = 0;
(globalThis as unknown as { fetch: unknown }).fetch = () => {
  fetchCalls += 1;
  throw new Error("network disabled");
};

const allowed = (file: string, token: string, path: string) => evaluateRobots(parseRobotsTxt(file), token, path).allowed;
const bytes = (text: string) => new TextEncoder().encode(text);

console.log("test-w1-robots");

// --- R1 fetch-status policy (SELF_SERVICE_PRODUCT.md §6.2)
check("R1a 2xx is parsed", robotsPolicyFromFetch({ kind: "status", status: 200, bodyBytes: bytes("User-agent: *\nDisallow: /x") }).kind === "parsed");
check("R1b 404 means no restrictions (RFC 'unavailable')", robotsPolicyFromFetch({ kind: "status", status: 404, bodyBytes: bytes("") }).kind === "not_found");
check("R1c 410 means no restrictions", robotsPolicyFromFetch({ kind: "status", status: 410, bodyBytes: bytes("") }).kind === "not_found");
check("R1d 500 is complete disallow (docs' robots_unavailable)", robotsPolicyFromFetch({ kind: "status", status: 500, bodyBytes: bytes("") }).kind === "unreachable");
check("R1e 503 is complete disallow", robotsPolicyFromFetch({ kind: "status", status: 503, bodyBytes: bytes("") }).kind === "unreachable");
check("R1f unreachable host is complete disallow", robotsPolicyFromFetch({ kind: "unreachable" }).kind === "unreachable");
check("R1g 429 fails closed (proposed)", robotsPolicyFromFetch({ kind: "status", status: 429, bodyBytes: bytes("") }).kind === "unreachable");
check("R1h an unfollowed 3xx fails closed", robotsPolicyFromFetch({ kind: "status", status: 302, bodyBytes: bytes("") }).kind === "unreachable");

const notFound = robotsPolicyFromFetch({ kind: "status", status: 404, bodyBytes: bytes("") });
const down = robotsPolicyFromFetch({ kind: "status", status: 503, bodyBytes: bytes("") });
check("R1i not_found allows everything", isAllowedByPolicy(notFound, "zypactbot", "/anything"));
check("R1j unreachable allows nothing", !isAllowedByPolicy(down, "zypactbot", "/"));
check("R1k /robots.txt itself is always allowed", isAllowedByPolicy(down, "zypactbot", "/robots.txt"));

// --- R2 groups and product tokens (§2.2.1)
const groups = "User-agent: *\nDisallow: /private\n\nUser-agent: ZypactBot\nDisallow: /zyp-only\n";
check("R2a specific group replaces the * group", allowed(groups, "zypactbot", "/private") && !allowed(groups, "zypactbot", "/zyp-only"));
check("R2b token match is case-insensitive", !allowed(groups, "ZYPACTBOT", "/zyp-only"));
check("R2c other agents fall back to *", !allowed(groups, "otherbot", "/private") && allowed(groups, "otherbot", "/zyp-only"));
check("R2d version suffix on the UA line still matches the token", !allowed("User-agent: GPTBot/1.1\nDisallow: /", "gptbot", "/"));
const merged = "User-agent: GPTBot\nDisallow: /a\n\nUser-agent: GPTBot\nDisallow: /b\n";
check("R2e repeated groups for one token are merged", !allowed(merged, "gptbot", "/a") && !allowed(merged, "gptbot", "/b"));
const shared = "User-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\n";
check("R2f consecutive user-agent lines share one group", !allowed(shared, "gptbot", "/") && !allowed(shared, "ccbot", "/"));
check("R2g no matching group and no * means no rules", allowed("User-agent: GPTBot\nDisallow: /", "zypactbot", "/"));
check("R2h rules before any user-agent are ignored", allowed("Disallow: /\nUser-agent: *\nAllow: /", "zypactbot", "/x"));
check("R2i Sitemap lines do not break a group", !allowed("User-agent: *\nSitemap: https://a.example/s.xml\nDisallow: /x", "zypactbot", "/x"));

// --- R3 path matching (§2.2.2)
check("R3a empty Disallow is no rule", allowed("User-agent: *\nDisallow:", "zypactbot", "/"));
check("R3b prefix match", !allowed("User-agent: *\nDisallow: /fish", "zypactbot", "/fish.html") && allowed("User-agent: *\nDisallow: /fish", "zypactbot", "/Fish"));
check("R3c longest match wins", allowed("User-agent: *\nDisallow: /a\nAllow: /a/b", "zypactbot", "/a/b/c") && !allowed("User-agent: *\nDisallow: /a\nAllow: /a/b", "zypactbot", "/a/c"));
check("R3d Allow wins a tie", allowed("User-agent: *\nDisallow: /page\nAllow: /page", "zypactbot", "/page"));
check("R3e * wildcard", !allowed("User-agent: *\nDisallow: /*.pdf", "zypactbot", "/docs/a.pdf") && allowed("User-agent: *\nDisallow: /*.pdf$", "zypactbot", "/a.pdf?x=1"));
check("R3f $ anchors the end", !allowed("User-agent: *\nDisallow: /exact$", "zypactbot", "/exact") && allowed("User-agent: *\nDisallow: /exact$", "zypactbot", "/exact/more"));
check("R3g percent-encoded unreserved chars are equivalent", !allowed("User-agent: *\nDisallow: /%7Euser", "zypactbot", "/~user") && !allowed("User-agent: *\nDisallow: /~user", "zypactbot", "/%7euser"));
check("R3h non-ASCII rule matches its UTF-8 percent form", !allowed("User-agent: *\nDisallow: /preise", "zypactbot", "/preise") && !allowed("User-agent: *\nDisallow: /bücher", "zypactbot", "/b%C3%BCcher"));
check("R3i regex metacharacters in rules are literal", allowed("User-agent: *\nDisallow: /a.b", "zypactbot", "/axb") && !allowed("User-agent: *\nDisallow: /a.b", "zypactbot", "/a.b"));
check("R3j Disallow: / blocks the homepage", !allowed("User-agent: *\nDisallow: /", "zypactbot", "/"));
check("R3k query string participates in matching", !allowed("User-agent: *\nDisallow: /*?session=", "zypactbot", "/p?session=1"));

// --- R4 robustness
const crlf = "User-agent: *\r\nDisallow: /crlf\r\n";
check("R4a CRLF line endings", !allowed(crlf, "zypactbot", "/crlf"));
check("R4b comments and case-insensitive keys", !allowed("USER-AGENT: * # all\nDISALLOW: /x # no", "zypactbot", "/x"));
check("R4c BOM is ignored", !allowed("﻿User-agent: *\nDisallow: /bom", "zypactbot", "/bom"));
const parsedInvalid = parseRobotsTxt("User-agent: *\nthis is not a directive\nDisallow: /x\n");
check("R4d junk lines are counted, not fatal", parsedInvalid.invalidLineCount === 1 && parsedInvalid.groups[0].rules.length === 1);
check("R4e sitemaps are collected", parseRobotsTxt("Sitemap: https://a.example/s.xml\nUser-agent: *").sitemaps.length === 1);

// --- R5 500 KiB limit (§2.5): parse stops, later rules ignored, no partial rule
const padding = "# " + "x".repeat(ROBOTS_MAX_BYTES) + "\n";
const big = parseRobotsTxt(`User-agent: *\nDisallow: /early\n${padding}Disallow: /late\n`);
check("R5a oversized file is marked truncated", big.truncated);
check("R5b rules before the limit apply", !evaluateRobots(big, "zypactbot", "/early").allowed);
check("R5c rules after the limit are ignored", evaluateRobots(big, "zypactbot", "/late").allowed);
const cutMidLine = parseRobotsTxt("User-agent: *\nDisallow: /" + "a".repeat(ROBOTS_MAX_BYTES));
check("R5d a rule cut mid-line is dropped, not shortened", cutMidLine.groups[0]?.rules.length === 0);

// --- R6 cache (§2.4)
let clock = 1_000_000;
const cache = new RobotsCache(() => clock, 2);
cache.set("https://a.example", notFound);
check("R6a fresh entry is served", cache.get("https://a.example") === notFound);
clock += ROBOTS_MAX_CACHE_MS - 1;
check("R6b served until 24 h", cache.get("https://a.example") === notFound);
clock += 1;
check("R6c expired at 24 h", cache.get("https://a.example") === null);
cache.set("https://a.example", notFound);
cache.set("https://b.example", notFound);
cache.set("https://c.example", notFound);
check("R6d bounded size evicts the oldest", cache.size === 2 && cache.get("https://a.example") === null);
let threw = false;
try {
  new RobotsCache(() => 0, 10, ROBOTS_MAX_CACHE_MS + 1);
} catch {
  threw = true;
}
check("R6e a TTL above 24 h is refused", threw);

check("no network call", fetchCalls === 0);
console.log(`\n${total - failures}/${total} checks passed.`);
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
