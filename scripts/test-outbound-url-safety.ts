#!/usr/bin/env tsx
/**
 * Outbound URL / SSRF policy tests for the crawler.
 *
 * Everything here runs against injected DNS and an injected transport.
 * No socket is opened, no name is really resolved, and no internet is
 * touched. Each test records exactly which destinations the transport was
 * asked to connect to, so "it failed somehow" cannot be mistaken for "it
 * refused to connect".
 */

import {
  UnsafeOutboundUrlError,
  isPublicAddress,
  validateOutboundUrl,
  type DnsLookup,
} from "@/lib/crawler/outbound-url-safety";
import { pinnedTransport, safeFetch, type Transport } from "@/lib/crawler/safe-fetch";
import { UNSAFE_DESTINATION_ERROR, crawlSite } from "@/lib/crawler/crawl-site";

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ok   ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}`); }
}

const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_V6 = "2606:2800:220:1:248:1893:25c8:1946";

function dnsOf(map: Record<string, string[]>): DnsLookup {
  return async (hostname) => {
    const addrs = map[hostname.toLowerCase()];
    if (!addrs) throw new Error("ENOTFOUND");
    return addrs.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
}

/** Records every connection the policy actually authorised. */
function recordingTransport(
  responses: Array<{ status: number; headers?: Record<string, string>; body?: string }>
): { transport: Transport; connections: Array<{ host: string; addresses: string[] }> } {
  const connections: Array<{ host: string; addresses: string[] }> = [];
  let i = 0;
  const transport: Transport = async ({ url, addresses }) => {
    connections.push({ host: url.hostname, addresses: [...addresses] });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      status: r.status,
      headers: { "content-type": "text/html", ...(r.headers ?? {}) },
      body: r.body ?? "<html><head><title>t</title></head><body>ok</body></html>",
    };
  };
  return { transport, connections };
}

const OPTS = { timeoutMs: 1000, userAgent: "test" };

async function expectRejected(label: string, fn: () => Promise<unknown>, reason?: string): Promise<void> {
  try {
    await fn();
    check(label, false);
  } catch (err) {
    const isPolicy = err instanceof UnsafeOutboundUrlError;
    check(label, isPolicy && (!reason || (err as UnsafeOutboundUrlError).reason === reason));
  }
}

async function main(): Promise<void> {
  console.log("test-outbound-url-safety");

  // ---------- address classifier ----------
  console.log("\n [address classification]");
  for (const [addr, expected] of [
    [PUBLIC_V4, true], [PUBLIC_V6, true], ["8.8.8.8", true],
    ["0.0.0.0", false], ["127.0.0.1", false], ["127.255.255.254", false],
    ["10.0.0.1", false], ["172.16.5.4", false], ["172.31.255.255", false],
    ["192.168.1.1", false], ["169.254.169.254", false], ["100.64.0.1", false],
    ["192.0.2.5", false], ["198.51.100.5", false], ["203.0.113.5", false],
    ["198.18.0.1", false], ["224.0.0.1", false], ["240.0.0.1", false],
    ["255.255.255.255", false], ["192.0.0.1", false],
    ["::1", false], ["::", false], ["fe80::1", false], ["fc00::1", false],
    ["fd12:3456::1", false], ["ff02::1", false], ["2001:db8::1", false],
    ["::ffff:10.0.0.1", false], ["::ffff:127.0.0.1", false],
    ["::ffff:169.254.169.254", false], [`::ffff:${PUBLIC_V4}`, true],
    ["64:ff9b::10.0.0.1", false], ["100::1", false], ["2002::1", false],
    ["172.15.0.1", true], ["172.32.0.1", true], ["100.63.255.255", true],
  ] as Array<[string, boolean]>) {
    check(`${addr.padEnd(34)} public=${expected}`, isPublicAddress(addr) === expected);
  }

  // ---------- A/B public allowed ----------
  console.log("\n [A/B public destinations allowed]");
  {
    const { transport, connections } = recordingTransport([{ status: 200 }]);
    const r = await safeFetch("https://example.com/", {
      ...OPTS, dnsLookup: dnsOf({ "example.com": [PUBLIC_V4] }), transport,
    });
    check("A public IPv4 host allowed", r.ok && connections.length === 1);
    check("A connection pinned to validated address", connections[0].addresses.join() === PUBLIC_V4);
  }
  {
    const { transport, connections } = recordingTransport([{ status: 200 }]);
    const r = await safeFetch("https://v6.example.com/", {
      ...OPTS, dnsLookup: dnsOf({ "v6.example.com": [PUBLIC_V6] }), transport,
    });
    check("B public IPv6 host allowed", r.ok && connections[0].addresses.join() === PUBLIC_V6);
  }

  // ---------- F–Q direct blocked targets ----------
  console.log("\n [F-Q direct blocked destinations]");
  const blocked: Array<[string, string]> = [
    ["F  localhost", "http://localhost/"],
    ["G  foo.localhost", "http://foo.localhost/"],
    ["H  127.0.0.1", "http://127.0.0.1/"],
    ["I  10.0.0.1", "http://10.0.0.1/"],
    ["J  172.16.0.1", "http://172.16.0.1/"],
    ["K  192.168.1.1", "http://192.168.1.1/"],
    ["L  169.254.169.254", "http://169.254.169.254/"],
    ["M  100.64.0.1", "http://100.64.0.1/"],
    ["N  ::1", "http://[::1]/"],
    ["O  fe80::1", "http://[fe80::1]/"],
    ["P  fd00::1", "http://[fd00::1]/"],
    ["Q  ::ffff:10.0.0.1", "http://[::ffff:10.0.0.1]/"],
  ];
  for (const [label, url] of blocked) {
    const { transport, connections } = recordingTransport([{ status: 200 }]);
    await expectRejected(`${label} blocked`, () =>
      safeFetch(url, { ...OPTS, dnsLookup: dnsOf({}), transport }));
    check(`${label} no connection attempted`, connections.length === 0);
  }

  // ---------- R-U DNS-based ----------
  console.log("\n [R-U DNS resolution policy]");
  for (const [label, addrs] of [
    ["R private-only", ["10.1.2.3"]],
    ["S loopback", ["127.0.0.1"]],
    ["T link-local", ["169.254.169.254"]],
    ["U mixed public+private", [PUBLIC_V4, "10.1.2.3"]],
  ] as Array<[string, string[]]>) {
    const { transport, connections } = recordingTransport([{ status: 200 }]);
    await expectRejected(`${label} rejected`, () =>
      safeFetch("https://evil.example/", {
        ...OPTS, dnsLookup: dnsOf({ "evil.example": addrs }), transport,
      }), "non_public_address");
    check(`${label} never connected`, connections.length === 0);
  }

  // ---------- C + V-Z redirects ----------
  console.log("\n [C, V-Z redirect handling]");
  {
    const { transport, connections } = recordingTransport([
      { status: 301, headers: { location: "https://example.com/secure" } },
      { status: 200 },
    ]);
    const r = await safeFetch("http://example.com/", {
      ...OPTS, dnsLookup: dnsOf({ "example.com": [PUBLIC_V4] }), transport,
    });
    check("C http->https public redirect allowed", r.ok && connections.length === 2);
  }
  const redirectCases: Array<[string, string]> = [
    ["V  -> localhost", "http://localhost/"],
    ["W  -> RFC1918 host", "http://internal.example/"],
    ["X  -> metadata IP", "http://169.254.169.254/latest/meta-data/"],
    ["Y  -> file scheme", "file:///etc/passwd"],
    ["Y2 -> data scheme", "data:text/html,<h1>x</h1>"],
    ["AF -> credentials", "https://user:pw@example.com/"],
  ];
  for (const [label, target] of redirectCases) {
    const { transport, connections } = recordingTransport([
      { status: 302, headers: { location: target } },
      { status: 200 },
    ]);
    await expectRejected(`${label} blocked`, () =>
      safeFetch("https://example.com/", {
        ...OPTS,
        dnsLookup: dnsOf({ "example.com": [PUBLIC_V4], "internal.example": ["10.0.0.9"] }),
        transport,
      }));
    check(`${label} second connection never made`, connections.length === 1);
  }
  {
    const { transport, connections } = recordingTransport([
      { status: 302, headers: { location: "https://example.com/loop" } },
    ]);
    let bounded = false;
    try {
      await safeFetch("https://example.com/", {
        ...OPTS, dnsLookup: dnsOf({ "example.com": [PUBLIC_V4] }), transport, maxRedirects: 3,
      });
    } catch (err) {
      bounded = err instanceof Error && err.message.includes("Too many redirects");
    }
    check("Z redirect loop bounded", bounded);
    check("Z connections capped at limit+1", connections.length === 4);
  }

  // ---------- AA/AB rebinding ----------
  console.log("\n [AA/AB DNS rebinding]");
  {
    let call = 0;
    const rebinding: DnsLookup = async () => {
      call += 1;
      return call === 1
        ? [{ address: PUBLIC_V4, family: 4 }]      // validation sees public
        : [{ address: "127.0.0.1", family: 4 }];   // later answers are hostile
    };
    const { transport, connections } = recordingTransport([{ status: 200 }]);
    const r = await safeFetch("https://rebind.example/", { ...OPTS, dnsLookup: rebinding, transport });
    check("AA connection used only the validated address", connections[0].addresses.join() === PUBLIC_V4);
    check("AA no private address ever offered to transport",
      !connections.some((c) => c.addresses.some((a) => a.startsWith("127."))));
    check("AA request still succeeded on the public address", r.ok);
    check("AB transport receives the exact validated set", connections[0].addresses.length === 1);
  }
  {
    // The socket-level pin refuses to connect when it has no validated
    // address to connect to, instead of falling back to resolving the
    // hostname itself. No DNS query and no packet leave the process: the
    // custom lookup errors before any connection is attempted.
    let refused = false;
    try {
      await pinnedTransport({
        url: new URL("https://example.com/"),
        addresses: [],
        timeoutMs: 500,
        userAgent: "test",
      });
    } catch {
      refused = true;
    }
    check("AB pinned transport refuses to connect without a validated address", refused);
  }

  // ---------- AC/AD/AE apex-www under policy ----------
  console.log("\n [AC-AE apex/www stays inside the policy]");
  for (const [label, host] of [["AC corp.local", "corp.local"], ["AD foo.localhost", "foo.localhost"]] as Array<[string, string]>) {
    const { transport, connections } = recordingTransport([{ status: 200 }]);
    const r = await crawlSite({
      websiteUrl: `https://${host}/`, maxPages: 1,
      dnsLookup: dnsOf({ [host]: ["10.0.0.4"], [`www.${host}`]: ["10.0.0.5"] }),
      transport,
    });
    check(`${label} crawl refused`, r.ok === false);
    check(`${label} no internal connection made`, connections.length === 0);
    check(`${label} reports the safe security error`,
      !r.ok && r.error === UNSAFE_DESTINATION_ERROR);
  }
  {
    const { transport, connections } = recordingTransport([{ status: 500 }]);
    const r = await crawlSite({
      websiteUrl: "https://example.com/", maxPages: 1,
      dnsLookup: dnsOf({ "example.com": [PUBLIC_V4], "www.example.com": [PUBLIC_V4] }),
      transport,
    });
    check("AE security rejection never becomes extra probing", r.ok === false);
    check("AE bounded connections", connections.length <= 2);
  }

  // ---------- D/E public apex-www fallback still works ----------
  console.log("\n [D/E bounded fallback preserved]");
  {
    const connections: string[] = [];
    const transport: Transport = async ({ url }) => {
      connections.push(url.hostname);
      if (url.hostname !== "www.example.com") throw new Error("fetch failed");
      return { status: 200, headers: { "content-type": "text/html" }, body: "<html><title>t</title><body>hi</body></html>" };
    };
    const r = await crawlSite({
      websiteUrl: "https://example.com/", maxPages: 1,
      dnsLookup: dnsOf({ "example.com": [PUBLIC_V4], "www.example.com": [PUBLIC_V4] }),
      transport,
    });
    check("D apex fails, public www succeeds", r.ok === true);
    check("D exactly two hosts, in order", connections.join() === "example.com,www.example.com");
  }
  {
    const connections: string[] = [];
    const transport: Transport = async ({ url }) => {
      connections.push(url.hostname);
      if (url.hostname !== "example.com") throw new Error("fetch failed");
      return { status: 200, headers: { "content-type": "text/html" }, body: "<html><title>t</title><body>hi</body></html>" };
    };
    const r = await crawlSite({
      websiteUrl: "https://www.example.com/", maxPages: 1,
      dnsLookup: dnsOf({ "example.com": [PUBLIC_V4], "www.example.com": [PUBLIC_V4] }),
      transport,
    });
    check("E www fails, public apex succeeds", r.ok === true);
    check("E exactly one alternate attempt", connections.length === 2);
  }

  // ---------- AF-AH credentials and protocols ----------
  console.log("\n [AF-AH credentials and protocols]");
  await expectRejected("AF user:pass@ rejected", () =>
    validateOutboundUrl("https://user:pw@example.com/", dnsOf({ "example.com": [PUBLIC_V4] })), "embedded_credentials");
  await expectRejected("AG file:// rejected", () =>
    validateOutboundUrl("file:///etc/passwd", dnsOf({})), "unsupported_protocol");
  await expectRejected("AH data: rejected", () =>
    validateOutboundUrl("data:text/html,<h1>x</h1>", dnsOf({})), "unsupported_protocol");
  await expectRejected("   ftp:// rejected", () =>
    validateOutboundUrl("ftp://example.com/", dnsOf({})), "unsupported_protocol");
  await expectRejected("   garbage URL rejected", () =>
    validateOutboundUrl("not a url", dnsOf({})), "invalid_url");
  await expectRejected("   DNS failure rejected", () =>
    validateOutboundUrl("https://nope.example/", dnsOf({})), "dns_resolution_failed");

  // ---------- discovered pages ----------
  console.log("\n [discovered page fetches use the same policy]");
  {
    const connections: Array<{ host: string; addresses: string[] }> = [];
    const transport: Transport = async ({ url, addresses }) => {
      connections.push({ host: url.hostname, addresses: [...addresses] });
      return {
        status: 200,
        headers: { "content-type": "text/html" },
        body: '<html><title>t</title><body><a href="/pricing">p</a></body></html>',
      };
    };
    await crawlSite({
      websiteUrl: "https://example.com/", maxPages: 2,
      dnsLookup: dnsOf({ "example.com": [PUBLIC_V4] }), transport,
    });
    check("discovered pages also pinned to validated addresses",
      connections.length >= 2 && connections.every((c) => c.addresses.join() === PUBLIC_V4));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
