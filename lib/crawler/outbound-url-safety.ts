/**
 * Outbound URL safety policy for the site crawler.
 *
 * The crawler accepts a website URL supplied by whoever requested a
 * snapshot. Before this module the only outbound check anywhere in the
 * crawl path was `protocol === http|https`: any hostname or IP literal was
 * fetched, redirects were followed automatically to unvalidated
 * destinations, and nothing rejected loopback, RFC1918, or cloud metadata
 * addresses. That is a server-side request forgery surface, and it had to
 * be closed before the worker runs continuously against publicly supplied
 * input.
 *
 * The policy is written as an allow-list of *publicly routable unicast*
 * destinations rather than a blacklist of known-bad addresses. Maintaining
 * a list of metadata IPs is a losing game; asserting "this address is on
 * the public internet" is a property we can actually check.
 *
 * This module is pure policy plus DNS. It performs no HTTP. The transport
 * that enforces the decision at the socket lives in `safe-fetch.ts`.
 */

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

/** Reason codes are deliberately coarse: they are safe to log and to surface. */
export type OutboundRejectionReason =
  | "invalid_url"
  | "unsupported_protocol"
  | "embedded_credentials"
  | "non_public_address"
  | "dns_resolution_failed"
  | "no_public_address";

export class UnsafeOutboundUrlError extends Error {
  readonly reason: OutboundRejectionReason;

  constructor(reason: OutboundRejectionReason, detail?: string) {
    // Never embeds a resolved address, credential, or internal hostname —
    // this message reaches crawler output and, through it, reports.
    super(
      detail
        ? `Unsafe outbound destination (${reason}): ${detail}`
        : `Unsafe outbound destination (${reason})`
    );
    this.name = "UnsafeOutboundUrlError";
    this.reason = reason;
  }
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Human-readable form of the allowed set, for reports and tests. */
export const ALLOWED_PROTOCOL_LIST = "http:, https:";

/** Maximum redirects any single crawler request may follow. */
export const MAX_REDIRECTS = 5;

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function inCidr(value: number, base: string, prefix: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (baseInt & mask) >>> 0;
}

/**
 * Every IPv4 block that is not ordinary public unicast.
 *
 * Sources are the IANA special-purpose registry and RFC 1918/6598/5737/
 * 2544. Documentation, benchmark, and reserved space are included because
 * a public-web crawler has no legitimate reason to reach them, and they
 * are exactly the ranges an attacker probes for.
 */
const BLOCKED_IPV4: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network" / unspecified
  ["10.0.0.0", 8], // RFC1918 private
  ["100.64.0.0", 10], // RFC6598 carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. 169.254.169.254 metadata
  ["172.16.0.0", 12], // RFC1918 private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1 documentation
  ["192.168.0.0", 16], // RFC1918 private
  ["198.18.0.0", 15], // benchmark
  ["198.51.100.0", 24], // TEST-NET-2 documentation
  ["203.0.113.0", 24], // TEST-NET-3 documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. 255.255.255.255 broadcast
];

function isPublicIpv4(address: string): boolean {
  const value = ipv4ToInt(address);
  if (value === null) return false;
  return !BLOCKED_IPV4.some(([base, prefix]) => inCidr(value, base, prefix));
}

/** Expands an IPv6 address to its 8 hextets, or null if unparseable. */
function ipv6Hextets(address: string): number[] | null {
  let text = address.split("%")[0]; // strip zone id
  // An IPv4-mapped/embedded tail is handled by the caller; normalise here.
  const halves = text.split("::");
  if (halves.length > 2) return null;

  const parse = (segment: string): number[] | null => {
    if (segment === "") return [];
    const out: number[] = [];
    for (const part of segment.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      out.push(parseInt(part, 16));
    }
    return out;
  };

  if (halves.length === 2) {
    const head = parse(halves[0]);
    const tail = parse(halves[1]);
    if (head === null || tail === null) return null;
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    return [...head, ...Array<number>(fill).fill(0), ...tail];
  }
  const flat = parse(text);
  return flat && flat.length === 8 ? flat : null;
}

/**
 * Extracts the embedded IPv4 address from IPv4-mapped (`::ffff:a.b.c.d`)
 * and NAT64 (`64:ff9b::a.b.c.d`) forms, which are the standard ways to
 * smuggle a private IPv4 destination past a naive IPv6 check.
 */
function embeddedIpv4(address: string): string | null {
  const dotted = address.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted && /^(::ffff:|::|64:ff9b::)/i.test(address)) return dotted[1];

  const hextets = ipv6Hextets(address);
  if (!hextets) return null;

  const isMapped =
    hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff;
  const isNat64 =
    hextets[0] === 0x0064 && hextets[1] === 0xff9b &&
    hextets.slice(2, 6).every((h) => h === 0);

  if (!isMapped && !isNat64) return null;
  const high = hextets[6];
  const low = hextets[7];
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

function isPublicIpv6(address: string): boolean {
  const mapped = embeddedIpv4(address);
  // An IPv6 wrapper is only as public as the IPv4 address it carries.
  if (mapped !== null) return isPublicIpv4(mapped);

  const hextets = ipv6Hextets(address);
  if (!hextets) return false;

  if (hextets.every((h) => h === 0)) return false; // :: unspecified
  if (hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1) {
    return false; // ::1 loopback
  }

  const first = hextets[0];
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique-local
  if ((first & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (first === 0x2001 && hextets[1] === 0x0db8) return false; // 2001:db8::/32 docs
  if (first === 0x0100 && hextets.slice(1, 4).every((h) => h === 0)) {
    return false; // 100::/64 discard-only
  }
  if (first === 0x2002) return false; // 6to4, deprecated; embeds arbitrary v4

  return true;
}

/**
 * Strips the surrounding brackets WHATWG keeps on IPv6 hosts.
 *
 * `new URL("http://[::1]/").hostname` is `"[::1]"`, brackets included, and
 * `net.isIP("[::1]")` is 0. Without this, no IPv6 literal was ever
 * recognised as an address: they all fell through to the DNS branch and
 * were rejected as `dns_resolution_failed`. That failed closed, but it
 * meant the entire IPv6 classifier — including the IPv4-mapped and NAT64
 * decoding — was dead code for URL input, and legitimate public IPv6
 * literals were refused.
 *
 * Only an exact leading `[` with matching trailing `]` is removed, so
 * ordinary hostnames pass through untouched.
 */
export function canonicalHost(hostname: string): string {
  if (hostname.length >= 2 && hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/** True only for ordinary, globally routable unicast addresses. */
export function isPublicAddress(address: string): boolean {
  const host = canonicalHost(address);
  const family = isIP(host);
  if (family === 4) return isPublicIpv4(host);
  if (family === 6) return isPublicIpv6(host);
  return false;
}

/**
 * Hostnames that must never reach the network regardless of what DNS says.
 *
 * DNS validation already covers these in practice; this is defence in
 * depth for the case where a resolver is misconfigured or is itself the
 * attacker's input. RFC 6761 reserves `localhost` and any `*.localhost`
 * for loopback.
 */
function isForbiddenHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost");
}

export interface ValidatedDestination {
  /** The URL, unchanged apart from parsing. */
  url: URL;
  /** Hostname to present in Host header and TLS SNI. */
  hostname: string;
  /**
   * The addresses the connection is permitted to use. The transport must
   * not resolve the hostname again — it connects only to these.
   */
  addresses: string[];
}

/**
 * Structural checks that need no network: protocol, credentials, and
 * hostnames that are forbidden by name. Exported so a caller can reject
 * an obviously unusable URL before spending a DNS query.
 */
export function assertUrlShapeIsSafe(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeOutboundUrlError("invalid_url");
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new UnsafeOutboundUrlError("unsupported_protocol", url.protocol);
  }

  // Credentials in a crawl target are never legitimate and would be sent
  // to whatever the destination turns out to be.
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeOutboundUrlError("embedded_credentials");
  }

  if (isForbiddenHostname(url.hostname)) {
    throw new UnsafeOutboundUrlError("non_public_address");
  }

  return url;
}

export type DnsLookup = (
  hostname: string
) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: DnsLookup = async (hostname) => {
  const result = await lookup(hostname, { all: true, verbatim: true });
  return result.map((entry) => ({ address: entry.address, family: entry.family }));
};

/**
 * Full policy: shape, then resolution, then address classification.
 *
 * Mixed-resolution policy — deliberately strict. If a hostname resolves to
 * *any* non-public address, the destination is rejected outright rather
 * than connecting to the public subset. Connecting to the "good" subset
 * would still let an attacker who controls DNS decide which record the
 * crawler sees, and a host legitimately serving the public web has no
 * reason to publish a loopback or RFC1918 record. Strictness here costs a
 * rare false negative and removes a whole class of ambiguity.
 *
 * The returned `addresses` are the *only* addresses the transport may
 * connect to; that is what makes the check binding rather than advisory.
 */
export async function validateOutboundUrl(
  raw: string,
  dnsLookup: DnsLookup = defaultLookup
): Promise<ValidatedDestination> {
  const url = assertUrlShapeIsSafe(raw);

  // An IP literal needs no resolution; it is already the destination.
  // Brackets are removed first so IPv6 literals reach the IPv6 policy
  // instead of being mistaken for a hostname.
  const literal = canonicalHost(url.hostname);
  if (isIP(literal) !== 0) {
    if (!isPublicAddress(literal)) {
      throw new UnsafeOutboundUrlError("non_public_address");
    }
    // The socket is pinned to the bare address, never the bracketed form.
    return { url, hostname: url.hostname, addresses: [literal] };
  }

  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await dnsLookup(url.hostname);
  } catch {
    throw new UnsafeOutboundUrlError("dns_resolution_failed");
  }

  if (resolved.length === 0) {
    throw new UnsafeOutboundUrlError("no_public_address");
  }

  // Strict: one non-public answer disqualifies the destination.
  if (resolved.some((entry) => !isPublicAddress(entry.address))) {
    throw new UnsafeOutboundUrlError("non_public_address");
  }

  return {
    url,
    hostname: url.hostname,
    addresses: resolved.map((entry) => entry.address),
  };
}
