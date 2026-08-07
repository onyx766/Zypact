#!/usr/bin/env tsx
/**
 * Defect B regression: a bounded apex/www homepage fallback.
 *
 * A real Production snapshot failed with `Failed to fetch homepage: fetch
 * failed` because the customer-style URL was the apex `https://zypact.com`,
 * which is unreachable, while `https://www.zypact.com` serves fine. The
 * rerun with the www host completed the whole pipeline.
 *
 * These tests drive an injected transport, so no network, provider, or
 * database is involved. Every assertion also counts the requests made, so
 * "it eventually worked" cannot hide an unbounded retry.
 */

import { alternateHostCandidate, crawlSite } from "@/lib/crawler/crawl-site";
import type { DnsLookup } from "@/lib/crawler/outbound-url-safety";
import type { Transport } from "@/lib/crawler/safe-fetch";

/**
 * Outbound safety (see test-outbound-url-safety.ts) now validates and pins
 * every connection, so these tests drive the injected transport/DNS seams
 * instead of monkey-patching global fetch. The assertions are unchanged:
 * this suite still owns the *bounded fallback* behaviour, and every host
 * below resolves to a public address so the bound is what is under test,
 * not the security policy.
 */
const TEST_PUBLIC_IP = "93.184.216.34";
const testDns: DnsLookup = async () => [{ address: TEST_PUBLIC_IP, family: 4 }];

let failures = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}`);
  }
}

/**
 * Upper bound on homepage requests any single `crawlSite` call may make.
 * The correct implementation makes at most two (original + one alternate);
 * this cap exists purely so a recursive-fallback regression is reported as
 * a failed assertion instead of an out-of-memory crash.
 */
const CALL_CAP = 8;

const HTML =
  "<html><head><title>T</title></head><body><p>hello world</p></body></html>";

/**
 * Installs a transport stub that serves only the listed hosts and records
 * every requested URL. Any other host throws the same way a real DNS or
 * connection failure surfaces at the socket.
 */
function withFetch(
  servableHosts: string[],
  fn: (calls: string[]) => Promise<void>
): Promise<void> {
  const calls: string[] = [];
  currentTransport = async ({ url }) => {
    calls.push(url.toString());
    // Hard cap so an unbounded-fallback regression fails a *bound
    // assertion* rather than exhausting memory or hanging the run. Past
    // the cap we answer successfully, which terminates any retry loop and
    // lets the recorded call count expose it. The legitimate path never
    // exceeds two homepage requests.
    if (calls.length > CALL_CAP) return okResponse();
    if (!servableHosts.includes(url.hostname)) throw new TypeError("fetch failed");
    return okResponse();
  };
  return fn(calls).finally(() => {
    currentTransport = null;
  });
}

let currentTransport: Transport | null = null;

function okResponse(): { status: number; headers: Record<string, string>; body: string } {
  return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: HTML };
}

/** Injects the active transport plus public DNS into a crawl call. */
function crawl(websiteUrl: string, maxPages = 1) {
  return crawlSite({
    websiteUrl,
    maxPages,
    dnsLookup: testDns,
    transport: currentTransport ?? undefined,
  });
}

function hostsOf(calls: string[]): string[] {
  return [...new Set(calls.map((c) => new URL(c).hostname))];
}

async function main(): Promise<void> {
  console.log("test-crawl-apex-www-fallback");

  // A — submitted apex works: no fallback, no extra host contacted.
  await withFetch(["example.com"], async (calls) => {
    const r = await crawl("https://example.com", 1);
    check("A1 crawl succeeds", r.ok === true);
    check("A2 only the submitted host contacted", hostsOf(calls).join() === "example.com");
    if (r.ok) check("A3 resolved startUrl stays apex", new URL(r.startUrl).hostname === "example.com");
  });

  // B — apex unreachable, www serves: exactly one fallback.
  await withFetch(["www.example.com"], async (calls) => {
    const r = await crawl("https://example.com", 1);
    check("B1 crawl succeeds via fallback", r.ok === true);
    check("B2 both hosts tried, in order", hostsOf(calls).join() === "example.com,www.example.com");
    if (r.ok) {
      check("B3 resolved website is the www host", new URL(r.startUrl).hostname === "www.example.com");
      check("B4 domain reported as www host", r.domain === "www.example.com");
    }
    check("B5 exactly one apex attempt", calls.filter((c) => new URL(c).hostname === "example.com").length === 1);
  });

  // C — submitted www unreachable, apex serves.
  await withFetch(["example.com"], async (calls) => {
    const r = await crawl("https://www.example.com", 1);
    check("C1 crawl succeeds via apex fallback", r.ok === true);
    check("C2 both hosts tried, in order", hostsOf(calls).join() === "www.example.com,example.com");
    if (r.ok) check("C3 resolved website is apex", new URL(r.startUrl).hostname === "example.com");
  });

  // D — both fail: original failure semantics preserved, bounded attempts.
  await withFetch([], async (calls) => {
    const r = await crawl("https://example.com", 1);
    check("D1 crawl still fails", r.ok === false);
    if (!r.ok) check("D2 original homepage error preserved", r.error.startsWith("Failed to fetch homepage:"));
    check("D3 exactly two hosts attempted, no more", hostsOf(calls).length === 2);
    check("D4 no third request", calls.length === 2);
  });

  // E/F — unrelated subdomains are never rewritten.
  for (const sub of ["app", "docs", "foo"]) {
    await withFetch([`${sub}.example.com`, "www.example.com", "example.com"], async () => {
      // Serve nothing for the subdomain itself by using a fresh stub below.
    });
    await withFetch(["www.example.com", "example.com"], async (calls) => {
      const r = await crawl(`https://${sub}.example.com`, 1);
      check(`E/F ${sub}: crawl fails without rewrite`, r.ok === false);
      check(`E/F ${sub}: only the submitted host contacted`, hostsOf(calls).join() === `${sub}.example.com`);
    });
  }

  // G — no www.www can ever be produced.
  check("G1 www host maps to apex, not www.www", alternateHostCandidate(new URL("https://www.example.com"))?.hostname === "example.com");
  const doubled = alternateHostCandidate(new URL("https://www.example.com"));
  check("G2 candidate never starts www.www", !(doubled?.hostname ?? "").startsWith("www.www"));
  await withFetch([], async (calls) => {
    await crawl("https://www.example.com", 1);
    check("G3 no www.www requested at runtime", !calls.some((c) => new URL(c).hostname.startsWith("www.www")));
  });

  // H — redirects still handled by fetch as before (stub returns HTML for
  //     the final host; the crawler does not intercept redirect handling).
  await withFetch(["example.com"], async (calls) => {
    const r = await crawl("https://example.com/", 1);
    check("H1 normal path still crawls", r.ok === true);
    check("H2 no fallback triggered on success", calls.length >= 1 && hostsOf(calls).join() === "example.com");
  });

  // I — safety: the fallback cannot escalate scope.
  check("I1 localhost gets no alternate", alternateHostCandidate(new URL("http://localhost:3000/")) === null);
  check("I2 IPv4 literal gets no alternate", alternateHostCandidate(new URL("http://127.0.0.1/")) === null);
  check("I3 private IPv4 gets no alternate", alternateHostCandidate(new URL("http://10.0.0.5/")) === null);
  check("I4 link-local gets no alternate", alternateHostCandidate(new URL("http://169.254.169.254/")) === null);
  check("I5 IPv6 literal gets no alternate", alternateHostCandidate(new URL("http://[::1]/")) === null);
  check("I6 credentials in URL get no alternate", alternateHostCandidate(new URL("https://user:pw@example.com/")) === null);
  check("I7 non-http protocol gets no alternate", alternateHostCandidate(new URL("ftp://example.com/")) === null);
  check("I8 https is never downgraded", alternateHostCandidate(new URL("https://example.com/"))?.protocol === "https:");
  check("I9 http stays http", alternateHostCandidate(new URL("http://example.com/"))?.protocol === "http:");
  check("I10 port preserved", alternateHostCandidate(new URL("https://example.com:8443/"))?.port === "8443");
  check("I11 path and query preserved", alternateHostCandidate(new URL("https://example.com/a?b=1"))?.pathname === "/a");
  check("I12 multi-label registrable name gets no www added", alternateHostCandidate(new URL("https://example.co.uk/")) === null);
  check("I13 www strip still allowed on multi-label", alternateHostCandidate(new URL("https://www.example.co.uk/"))?.hostname === "example.co.uk");
  check("I14 bare single-label host gets no alternate", alternateHostCandidate(new URL("http://intranet/")) === null);

  // I15 — the alternate goes through the same protocol validation: a
  //       non-http(s) URL is rejected before any fallback is considered.
  await withFetch([], async (calls) => {
    const r = await crawl("ftp://example.com", 1);
    check("I15 unsupported protocol rejected, no fetch at all", r.ok === false && calls.length === 0);
  });

  // J — MUTATION GUARD: only a genuine network failure earns the retry.
  //     An HTTP status answer must NOT trigger a fallback.
  {
    const calls: string[] = [];
    currentTransport = async ({ url }) => {
      calls.push(url.toString());
      return { status: 500, headers: { "content-type": "text/html" }, body: "nope" };
    };
    try {
      const r = await crawl("https://example.com", 1);
      check("J1 HTTP-status failure preserved", r.ok === false);
      check("J2 no fallback on an HTTP answer", hostsOf(calls).join() === "example.com");
    } finally {
      currentTransport = null;
    }
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
