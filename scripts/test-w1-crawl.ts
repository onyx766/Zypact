#!/usr/bin/env tsx
/**
 * W1-B: the bounded, robots-aware, SSRF-safe diagnostic crawler.
 *
 * Offline: a fixture transport, fake DNS and a virtual clock
 * (scripts/fixtures/w1/fixture-net.ts). Every security refusal is proved by
 * what the transport was (not) asked for, not by an error string.
 */
import { evaluateChecks } from "@/lib/site-diagnostic/checks";
import { crawlForDiagnostic } from "@/lib/site-diagnostic/crawl";
import { runSiteDiagnostic } from "@/lib/site-diagnostic/engine";
import { W1_FETCH_POLICY, W1_USER_AGENT } from "@/lib/site-diagnostic/policy";
import { normalizeDiagnosticInput, type NormalizedInput } from "@/lib/site-diagnostic/url";

import { acmeSite, fixtureNet, html, redirect, text, type FixtureRoutes, type FixtureNet } from "./fixtures/w1/fixture-net";

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

function input(raw: string): NormalizedInput {
  const result = normalizeDiagnosticInput(raw);
  if (!result.ok) throw new Error(`bad fixture input ${raw}`);
  return result.value;
}

function deps(net: FixtureNet, extra: Record<string, unknown> = {}) {
  return { transport: net.transport, dnsLookup: net.dnsLookup, now: net.clock.now, sleep: net.clock.sleep, ...extra };
}

const robotsAllowAll = text("User-agent: *\nAllow: /\n");

async function main(): Promise<void> {
  console.log("test-w1-crawl");

  /* A: the representative site ------------------------------------- */
  {
    const net = fixtureNet(acmeSite());
    const { capture } = await crawlForDiagnostic(input("acme-analytics.example"), deps(net));
    check("A1 robots.txt is the first request", net.requests[0] === "https://acme-analytics.example/robots.txt");
    check("A2 at most 10 page rows", capture.pages.length === W1_FETCH_POLICY.pageCap);
    check("A3 page indexes are 0..n-1 in fetch order", capture.pages.every((page, i) => page.pageIndex === i));
    check("A4 the homepage is page 0 at its final URL", capture.pages[0].url === "https://www.acme-analytics.example/" && capture.pages[0].requestedUrl === "https://acme-analytics.example/");
    check("A5 the apex→www redirect is recorded", capture.pages[0].redirectChain.length === 1 && capture.pages[0].redirectChain[0].status === 301);
    check("A6 every buyer category on the site is fetched before other pages", ["pricing", "product", "integrations", "security", "comparison", "faq", "customer_stories"].every((c) => capture.pages.slice(0, 8).some((p) => p.category === c)));
    check("A7 no excluded path is requested (login)", !net.requests.some((url) => url.includes("/login")));
    check("A8 no asset is requested (pdf)", !net.requests.some((url) => url.endsWith(".pdf")));
    check("A9 no URL with a query is requested", !net.requests.some((url) => url.includes("?")));
    check("A10 no other host is requested", net.requests.every((url) => /^https:\/\/(www\.)?acme-analytics\.example\//.test(url)));
    check("A11 the www robots.txt is fetched once", net.requests.filter((url) => url === "https://www.acme-analytics.example/robots.txt").length === 1);
    check("A12 total requests stay within the budget", capture.requestCount <= W1_FETCH_POLICY.maxRequestsPerRun && capture.requestCount === net.requests.length);
    check("A13 every request asks for identity encoding", net.inputs.every((i) => i.acceptEncoding === "identity"));
    check("A14 every request carries the W1 user agent", net.inputs.every((i) => i.userAgent === W1_USER_AGENT));
    check("A15 every request has a wall-clock deadline", net.inputs.every((i) => typeof i.deadlineMs === "number" && i.deadlineMs <= W1_FETCH_POLICY.requestDeadlineMs));
    check("A16 robots.txt is read with the 500 KiB truncate cap", net.inputs[0].maxBodyBytes === 512_000 && net.inputs[0].onOversize === "truncate");
    check("A17 sitemap and llms.txt come from the settled host", capture.sitemap.record?.url === "https://www.acme-analytics.example/sitemap.xml" && capture.llmsTxt.record?.url === "https://www.acme-analytics.example/llms.txt");
    check("A18 the cap stopped the crawl with links left", capture.stopReason === "page_cap" && capture.capReached);
    check("A19 bodies are hashed from raw bytes", capture.pages.every((p) => (p.bytes > 0) === (p.bodySha256 !== null) && (p.bodySha256 === null || /^[0-9a-f]{64}$/.test(p.bodySha256))));
    check("A20 capture holds no page body", !JSON.stringify(capture).includes("evidence0 evidence1"));
    check("A21 politeness delay between requests", net.clock.ms - Date.parse(capture.startedAt) >= (net.requests.length - 1) * W1_FETCH_POLICY.politenessDelayMs);
  }

  /* B: robots.txt outcomes ----------------------------------------- */
  {
    const routes: FixtureRoutes = {
      "https://down.example/robots.txt": { status: 503, headers: {}, body: "" },
      "https://down.example/": html("<h1>Home</h1>"),
    };
    const net = fixtureNet(routes);
    const { capture, bodies } = await crawlForDiagnostic(input("down.example"), deps(net));
    check("B1 robots 503: outcome robots_unavailable", capture.outcome === "robots_unavailable");
    check("B2 robots 503: nothing but robots.txt is requested", net.requests.length === 1);
    check("B3 robots 503: the homepage row says why", capture.pages.length === 1 && capture.pages[0].fetchError === "robots_unavailable" && !capture.pages[0].robotsAllowed && capture.pages[0].bytes === 0);
    const findings = evaluateChecks(capture, bodies);
    check("B4 robots 503: every finding is unknown/robots_unavailable", findings.every((f) => f.state === "unknown" && f.unknownReason === "robots_unavailable"));
  }
  {
    const net = fixtureNet({
      "https://nofile.example/robots.txt": { status: 404, headers: {}, body: "" },
      "https://nofile.example/": html("<h1>Home</h1><p>hello</p>", "<title>Home</title>"),
    });
    const { capture } = await crawlForDiagnostic(input("nofile.example"), deps(net));
    check("B5 robots 404: crawl proceeds (no restrictions)", capture.outcome === "completed" && capture.pages[0].httpStatus === 200 && capture.robots.policyKind === "not_found");
  }
  {
    const net = fixtureNet({ "https://slowrobots.example/robots.txt": { status: 200, fail: "timeout" } });
    const { capture } = await crawlForDiagnostic(input("slowrobots.example"), deps(net));
    check("B6 robots timeout: complete disallow", capture.outcome === "robots_unavailable" && net.requests.length === 1);
  }
  {
    const net = fixtureNet({
      "https://hop.example/robots.txt": redirect("https://evil.example/robots.txt"),
      "https://evil.example/robots.txt": robotsAllowAll,
    });
    const { capture } = await crawlForDiagnostic(input("hop.example"), deps(net));
    check("B7 robots redirect off the site: unreachable, never requested", capture.outcome === "robots_unavailable" && !net.requests.some((u) => u.includes("evil.example")));
  }
  {
    const routes: FixtureRoutes = {};
    for (let i = 0; i < 7; i += 1) routes[`https://loop.example/r${i}`] = redirect(`https://loop.example/r${i + 1}`);
    routes["https://loop.example/robots.txt"] = redirect("https://loop.example/r0");
    const net = fixtureNet(routes);
    const { capture } = await crawlForDiagnostic(input("loop.example"), deps(net));
    check("B8 robots with more than 5 redirects fails closed", capture.outcome === "robots_unavailable" && net.requests.length === 6);
  }
  {
    const net = fixtureNet({
      "https://private-site.example/robots.txt": text("User-agent: ZypactBot\nDisallow: /\n"),
      "https://private-site.example/sitemap.xml": text("<urlset><url><loc>https://private-site.example/pricing</loc></url></urlset>", "application/xml"),
    });
    const { capture } = await crawlForDiagnostic(input("private-site.example"), deps(net));
    check("B9 ZypactBot disallowed: the homepage is never requested", !net.requests.includes("https://private-site.example/"));
    check("B10 the homepage row is blocked_by_robots", capture.pages[0].fetchError === "blocked_by_robots" && !capture.pages[0].robotsAllowed);
    check("B11 disallowed sitemap and pages are never requested", net.requests.length === 1);
  }

  /* C: SSRF and DNS ------------------------------------------------ */
  {
    const net = fixtureNet({}, { "internal.example": ["10.0.0.5"] });
    const result = await runSiteDiagnostic("internal.example", deps(net));
    check("C1 a host resolving to a private address is refused", !result.ok && result.refusal === "blocked_destination");
    check("C2 ...with zero requests", net.requests.length === 0);
  }
  {
    const net = fixtureNet({}, { "mixed.example": ["93.184.216.34", "127.0.0.1"] });
    const result = await runSiteDiagnostic("mixed.example", deps(net));
    check("C3 one private answer among public ones refuses the host", !result.ok && result.refusal === "blocked_destination" && net.requests.length === 0);
  }
  {
    const net = fixtureNet({});
    const result = await runSiteDiagnostic("nowhere.example", deps(net));
    check("C4 an unresolvable host is refused without a request", !result.ok && result.refusal === "host_unresolvable" && net.requests.length === 0);
  }
  {
    const net = fixtureNet({}, { "metadata.example": ["169.254.169.254"] });
    const result = await runSiteDiagnostic("metadata.example", deps(net));
    check("C5 the cloud metadata address is refused", !result.ok && result.refusal === "blocked_destination" && net.requests.length === 0);
  }
  {
    // DNS rebinding: public for the pre-check and robots, private afterwards.
    let lookups = 0;
    const net = fixtureNet({
      "https://rebind.example/robots.txt": robotsAllowAll,
      "https://rebind.example/": html("<h1>Home</h1>"),
    });
    const rebinding = async (hostname: string) => {
      lookups += 1;
      if (hostname === "rebind.example" && lookups > 2) return [{ address: "192.168.1.1", family: 4 }];
      return net.dnsLookup(hostname);
    };
    const result = await runSiteDiagnostic("rebind.example", { ...deps(net), dnsLookup: rebinding });
    check("C6 DNS rebinding: the transport is never given a private address", net.inputs.every((i) => i.addresses.every((a) => !a.startsWith("192.168."))));
    check("C7 DNS rebinding: the homepage is a failed fetch, not a crawl", result.ok && result.report.pages[0].fetchError === "fetch_failed" && !net.requests.includes("https://rebind.example/"));
  }
  {
    const net = fixtureNet({
      "https://redir.example/robots.txt": robotsAllowAll,
      "https://redir.example/": redirect("http://127.0.0.1/admin"),
    });
    const { capture } = await crawlForDiagnostic(input("redir.example"), deps(net));
    check("C8 redirect to a loopback address is never followed", !net.requests.some((u) => u.includes("127.0.0.1")) && capture.pages[0].fetchError === "fetch_failed");
  }
  {
    const net = fixtureNet({
      "https://offsite.example/robots.txt": robotsAllowAll,
      "https://offsite.example/": redirect("https://elsewhere.example/"),
      "https://elsewhere.example/": html("<h1>Other site</h1>"),
    });
    const { capture } = await crawlForDiagnostic(input("offsite.example"), deps(net));
    check("C9 redirect to another site is never followed", !net.requests.some((u) => u.includes("elsewhere.example")));
    check("C10 ...and no content is attributed to the submitted site", capture.pages[0].fetchError === "fetch_failed" && capture.pages[0].bytes === 0);
  }
  {
    const net = fixtureNet({
      "https://ports.example/robots.txt": robotsAllowAll,
      "https://ports.example/": html('<a href="https://ports.example:6379/x">x</a><a href="http://ports.example:22/">y</a>'),
    });
    await crawlForDiagnostic(input("ports.example"), deps(net));
    check("C11 links on non-default ports are never requested", !net.requests.some((u) => /:\d+\//.test(u.replace(/^https?:\/\//, "x/"))));
  }

  /* D: bounds ------------------------------------------------------ */
  {
    const links = Array.from({ length: 300 }, (_, i) => `<a href="/broken-${i}">b${i}</a>`).join("");
    const net = fixtureNet({
      "https://broken.example/robots.txt": robotsAllowAll,
      "https://broken.example/": html(`<h1>Home</h1>${links}`),
    });
    const { capture } = await crawlForDiagnostic(input("broken.example"), deps(net));
    check("D1 300 broken links: failures count toward the 10-page cap", capture.pages.length === 10);
    check("D2 300 broken links: requests stay bounded", net.requests.length <= W1_FETCH_POLICY.maxRequestsPerRun && net.requests.length === 1 + 1 + 2 + 9);
    check("D3 broken pages keep their status as evidence", capture.pages.slice(1).every((p) => p.httpStatus === 404 && p.fetchError === null));
  }
  {
    const routes: FixtureRoutes = { "https://redirs.example/robots.txt": robotsAllowAll };
    const links = Array.from({ length: 20 }, (_, i) => `<a href="/loop-${i}">l</a>`).join("");
    routes["https://redirs.example/"] = html(`<h1>Home</h1>${links}`);
    for (let i = 0; i < 20; i += 1) routes[`https://redirs.example/loop-${i}`] = redirect(`https://redirs.example/loop-${i}`);
    const net = fixtureNet(routes);
    const { capture } = await crawlForDiagnostic(input("redirs.example"), deps(net));
    check("D4 redirect loops: every hop counts against the request budget", capture.requestCount <= W1_FETCH_POLICY.maxRequestsPerRun && capture.stopReason === "request_budget");
  }
  {
    const net = fixtureNet({
      "https://big.example/robots.txt": robotsAllowAll,
      "https://big.example/": html('<h1>Home</h1><a href="/huge">huge</a>'),
      "https://big.example/huge": { status: 200, headers: { "content-type": "text/html" }, body: "x".repeat(W1_FETCH_POLICY.htmlMaxBytes + 1) },
    });
    const { capture } = await crawlForDiagnostic(input("big.example"), deps(net));
    const huge = capture.pages.find((p) => p.url.endsWith("/huge"));
    check("D5 an oversized page is size_cap with no body kept", huge?.fetchError === "size_cap" && huge.bytes === 0 && huge.bodySha256 === null);
  }
  {
    const net = fixtureNet(
      {
        "https://slow.example/robots.txt": { ...robotsAllowAll, latencyMs: 100 },
        "https://slow.example/": html(Array.from({ length: 30 }, (_, i) => `<a href="/p${i}">p</a>`).join("")),
      },
      {},
      { defaultLatencyMs: 9_000 }
    );
    const { capture } = await crawlForDiagnostic(input("slow.example"), deps(net));
    check("D6 the run deadline stops a slow site", capture.stopReason === "deadline" && capture.capReached);
    check("D7 the run never runs past its deadline plus one request", net.clock.ms - Date.parse(capture.startedAt) <= W1_FETCH_POLICY.runDeadlineMs + W1_FETCH_POLICY.requestDeadlineMs);
  }
  {
    const net = fixtureNet({
      "https://drip.example/robots.txt": robotsAllowAll,
      "https://drip.example/": { ...html("<h1>Home</h1>"), latencyMs: 60_000 },
    });
    const { capture } = await crawlForDiagnostic(input("drip.example"), deps(net));
    check("D8 a response slower than the request deadline is a timeout", capture.pages[0].fetchError === "timeout");
  }
  {
    const net = fixtureNet({
      "https://types.example/robots.txt": robotsAllowAll,
      "https://types.example/": html('<a href="/pricing">Pricing</a><a href="/gz">gz</a><a href="/upper">u</a>'),
      "https://types.example/upper": { status: 200, headers: { "content-type": "Text/HTML; Charset=UTF-8" }, body: "<h1>Upper</h1>" },
      "https://types.example/pricing": { status: 200, headers: { "content-type": "application/pdf" }, body: "%PDF-1.4" },
      "https://types.example/gz": { status: 200, headers: { "content-type": "text/html", "content-encoding": "gzip" }, body: "\u001f\u008b" },
    });
    const { capture } = await crawlForDiagnostic(input("types.example"), deps(net));
    check("D9 a non-HTML response is not_html", capture.pages.find((p) => p.url.endsWith("/pricing"))?.fetchError === "not_html");
    check("D10 a compressed response despite identity is fetch_failed", capture.pages.find((p) => p.url.endsWith("/gz"))?.fetchError === "fetch_failed");
    const upper = capture.pages.find((p) => p.url.endsWith("/upper"));
    check("D11 media type comparison is case-insensitive", upper !== undefined && upper.fetchError === null && upper.httpStatus === 200);
  }
  {
    const controller = new AbortController();
    controller.abort();
    const net = fixtureNet(acmeSite());
    const { capture } = await crawlForDiagnostic(input("acme-analytics.example"), deps(net, { signal: controller.signal }));
    check("D12 a cancelled run makes no request and says cancelled", capture.outcome === "cancelled" && net.requests.length === 0);
  }

  /* E: determinism ------------------------------------------------- */
  {
    const runs = [] as string[];
    const findingSets = [] as string[];
    for (const latency of [5, 40, 400]) {
      const net = fixtureNet(acmeSite(), {}, { defaultLatencyMs: latency });
      const { capture, bodies } = await crawlForDiagnostic(input("acme-analytics.example"), deps(net));
      const timeless = JSON.stringify({ ...capture, startedAt: "", completedAt: "", pages: capture.pages.map((p) => ({ ...p, fetchedAt: "" })), robots: { ...capture.robots, record: capture.robots.record && { ...capture.robots.record, fetchedAt: "" } }, sitemap: { ...capture.sitemap, record: capture.sitemap.record && { ...capture.sitemap.record, fetchedAt: "" } }, llmsTxt: { ...capture.llmsTxt, record: capture.llmsTxt.record && { ...capture.llmsTxt.record, fetchedAt: "" } } });
      runs.push(timeless);
      findingSets.push(JSON.stringify(evaluateChecks(capture, bodies)));
    }
    check("E1 identical fixtures give an identical capture at any latency", runs.every((r) => r === runs[0]));
    check("E2 identical fixtures give identical findings at any latency", findingSets.every((f) => f === findingSets[0]));
  }
  {
    // Link order on the page must not change which pages are chosen.
    const base = acmeSite();
    const shuffled = { ...base };
    const home = "https://www.acme-analytics.example/";
    const body = String(base[home].body);
    const navStart = body.indexOf("<nav>") + 5;
    const navEnd = body.indexOf("</nav>");
    const anchors = body.slice(navStart, navEnd).trim().split(/\s*\n\s*/).reverse().join("\n");
    shuffled[home] = { ...base[home], body: body.slice(0, navStart) + anchors + body.slice(navEnd) };
    const a = await crawlForDiagnostic(input("acme-analytics.example"), deps(fixtureNet(base)));
    const b = await crawlForDiagnostic(input("acme-analytics.example"), deps(fixtureNet(shuffled)));
    check("E3 reordering links does not change the pages chosen", JSON.stringify(a.capture.pages.slice(1).map((p) => p.url)) === JSON.stringify(b.capture.pages.slice(1).map((p) => p.url)));
  }

  check("no global fetch call", fetchCalls === 0);
  console.log(`\n${total - failures}/${total} checks passed.`);
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
