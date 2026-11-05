/**
 * URL handling for W1: the customer's input, the same-site rule, and the
 * sanitised form every recorded URL takes.
 *
 * Pure module. The SSRF policy (lib/crawler/outbound-url-safety.ts) is
 * applied separately to every request; this module decides what W1 is
 * willing to ask for at all.
 */
import { isIP } from "node:net";

import { isNormalisedDomain, isSanitisedUrl } from "@/lib/site-diagnostic/contract";
import { W1_ASSET_PATH_RE, W1_EXCLUDED_PATH_SEGMENTS } from "@/lib/site-diagnostic/policy";

export type InputRefusal =
  | "empty"
  | "invalid_url"
  | "unsupported_protocol"
  | "embedded_credentials"
  | "non_default_port"
  | "ip_literal"
  | "reserved_hostname"
  | "invalid_domain";

export interface NormalizedInput {
  /** Homepage of the submitted host, always `<scheme>://<host>/`. */
  startUrl: string;
  /** Lowercase host as submitted (A-labels), no trailing dot. */
  host: string;
  /** The host with one leading "www." removed: the domain identity. */
  normalizedDomain: string;
  /** True when the input carried a path other than "/" (ignored). */
  pathIgnored: boolean;
  /** True when the input carried a query string (dropped, never sent). */
  queryPresent: boolean;
}

export type NormalizeResult =
  | { ok: true; value: NormalizedInput }
  | { ok: false; reason: InputRefusal };

/** Hostnames that resolve inside private networks by convention. */
const RESERVED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".arpa", ".intranet", ".corp"];

/**
 * The customer's URL to a W1 start URL. W1 v1 always starts at the
 * homepage of the submitted host (the handoff's "public homepage URL"); a
 * deeper path is accepted but ignored, and recorded as such.
 */
export function normalizeDiagnosticInput(raw: string): NormalizeResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "unsupported_protocol" };
  }
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "embedded_credentials" };
  if (url.port !== "") return { ok: false, reason: "non_default_port" };

  let host = url.hostname.toLowerCase();
  if (host.startsWith("[") || isIP(host) !== 0) return { ok: false, reason: "ip_literal" };
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "localhost" || RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { ok: false, reason: "reserved_hostname" };
  }
  if (!isNormalisedDomain(host)) return { ok: false, reason: "invalid_domain" };

  const stripped = host.startsWith("www.") ? host.slice(4) : host;
  const normalizedDomain = isNormalisedDomain(stripped) ? stripped : host;

  return {
    ok: true,
    value: {
      startUrl: `${url.protocol}//${host}/`,
      host,
      normalizedDomain,
      pathIgnored: url.pathname !== "/" && url.pathname !== "",
      queryPresent: url.search !== "",
    },
  };
}

/**
 * The hosts W1 treats as "the site": the submitted host and its www/apex
 * alternate. Other subdomains (docs.example.com) are out of scope in v1, so
 * buyer pages that live there are reported as not found within the crawl,
 * never as absent.
 */
export function siteHosts(host: string): ReadonlySet<string> {
  const hosts = new Set([host]);
  if (host.startsWith("www.")) {
    const apex = host.slice(4);
    if (apex.includes(".")) hosts.add(apex);
  } else if (host.split(".").length === 2) {
    hosts.add(`www.${host}`);
  }
  return hosts;
}

/** Same site, default port, http(s). Scheme changes (http to https) are allowed. */
export function isSameSite(url: URL, hosts: ReadonlySet<string>): boolean {
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.port !== "") return false;
  if (url.username !== "" || url.password !== "") return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return hosts.has(host);
}

export function isExcludedPath(pathname: string): boolean {
  const segments = pathname.toLowerCase().split("/").filter(Boolean);
  return segments.some((segment) => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // keep the raw segment
    }
    return W1_EXCLUDED_PATH_SEGMENTS.includes(decoded);
  });
}

export function isAssetPath(pathname: string): boolean {
  return W1_ASSET_PATH_RE.test(pathname);
}

/**
 * The stored form of a URL (`_q2p2_url_is_sanitised`): scheme, lowercase host,
 * optional non-default port, path. No userinfo, query or fragment; "@" in
 * the path percent-encoded; at least "/". Returns null when no such form
 * exists (IP literal, non-ASCII after serialisation, over 2048 characters).
 */
export function sanitizeEvidenceUrl(input: URL | string): { url: string; queryPresent: boolean } | null {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input) : new URL(input.toString());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  let host = url.hostname.toLowerCase();
  if (host.startsWith("[") || isIP(host) !== 0) return null;
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!/^[a-z0-9.-]+$/.test(host)) return null;

  let path = url.pathname || "/";
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/@/g, "%40").replace(/\s/g, (ch) => encodeURIComponent(ch));

  const port = url.port ? `:${url.port}` : "";
  const out = `${url.protocol}//${host}${port}${path}`;
  if (!isSanitisedUrl(out)) return null;
  return { url: out, queryPresent: url.search !== "" };
}
