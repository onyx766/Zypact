#!/usr/bin/env tsx
/**
 * W1-A + W1-C end to end: checks, the immutable report, exports, copy and
 * the Q2′-2 row shape, on synthetic fixture sites.
 *
 * G*  golden: the representative site's report hash is pinned. A change to
 *     the crawler, rules, catalogue or copy changes it; update GOLDEN only
 *     after reviewing the new report (run with W1_PRINT_GOLDEN=1).
 */
import * as copy from "@/lib/site-diagnostic/copy";
import { W1_CATALOG } from "@/lib/site-diagnostic/catalog";
import { runSiteDiagnostic, type DiagnosticResult } from "@/lib/site-diagnostic/engine";
import { escapeMarkdown, exportReportJson, exportReportMarkdown } from "@/lib/site-diagnostic/export";
import { toQ2p2Rows, validateQ2p2Rows } from "@/lib/site-diagnostic/persistence-shape";
import { verifyReportHash, type DiagnosticReport, type ReportFinding } from "@/lib/site-diagnostic/report";

import { acmeSite, fixtureNet, html, text, type FixtureRoutes } from "./fixtures/w1/fixture-net";

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

/** Reviewed golden hash of the acme fixture report (see header). */
const GOLDEN_ACME_REPORT_SHA256 = "b7e23f9a31dbd75dbccc71ce21edd91fb5c75d33f1509fe7cb1bc9269cec22fb";

async function run(routes: FixtureRoutes, url: string): Promise<{ result: DiagnosticResult; routes: FixtureRoutes }> {
  const net = fixtureNet(routes);
  const result = await runSiteDiagnostic(url, { transport: net.transport, dnsLookup: net.dnsLookup, now: net.clock.now, sleep: net.clock.sleep });
  return { result, routes };
}

function reportOf(result: DiagnosticResult): DiagnosticReport {
  if (!result.ok) throw new Error(`fixture refused: ${result.refusal}`);
  return result.report;
}

/** Page-level checks need a pageIndex; run-level ones may cite a page, so match by id. */
const find = (report: DiagnosticReport, checkId: string, pageIndex?: number): ReportFinding | undefined =>
  report.findings.find((f) => f.checkId === checkId && (pageIndex === undefined || f.pageIndex === pageIndex));

const robots = text("User-agent: *\nAllow: /\n");

async function main(): Promise<void> {
  console.log("test-w1-report");

  /* A: the representative site ------------------------------------- */
  const acmeRoutes = acmeSite();
  const acme = reportOf((await run(acmeRoutes, "https://acme-analytics.example")).result);
  check("A1 robots.agents is an issue naming the blocked tokens", find(acme, "robots.agents")?.state === "issue" && JSON.stringify(find(acme, "robots.agents")?.detail?.blocked_agents) === '["ccbot","gptbot"]');
  check("A2 ZypactBot is allowed", find(acme, "robots.agents")?.detail?.zypactbot_allowed === true);
  check("A3 brand name is consistent across four sources", find(acme, "site.entity_consistency")?.state === "pass" && (find(acme, "site.entity_consistency")?.detail?.sources_present as string[]).length === 4);
  check("A4 Organization markup passes", find(acme, "site.organization_markup")?.state === "pass");
  check("A5 sitemap passes from the robots directive", find(acme, "site.sitemap")?.state === "pass" && find(acme, "site.sitemap")?.detail?.source === "robots_directive");
  check("A6 llms.txt is info, present", find(acme, "site.llms_txt")?.state === "info" && find(acme, "site.llms_txt")?.detail?.present === true);
  for (const category of ["product", "pricing", "integrations", "security", "comparison", "faq", "customer_stories"]) {
    const finding = find(acme, `buyer_page.${category}`);
    check(`A7 buyer_page.${category} passes and cites its page`, finding?.state === "pass" && finding.pageIndex !== null && finding.pageUrl !== null);
  }
  check("A8 docs on another subdomain is unknown (cap reached), never absent", find(acme, "buyer_page.docs")?.state === "unknown" && find(acme, "buyer_page.docs")?.unknownReason === "page_cap_reached");
  check("A9 seller wording is info only", find(acme, "site.seller_wording")?.state === "info");
  check("A10 every page gets all eight page checks", acme.pages.every((p) => W1_CATALOG.filter((c) => c.scope === "page").every((c) => find(acme, c.checkId, p.pageIndex ?? -1) !== undefined)));
  check("A11 the fix list starts with the issue", acme.fixList[0]?.kind === "issue" && acme.fixList[0]?.checkId === "robots.agents");

  // Excerpts are verifiable against the bytes the page served.
  const excerpts = acme.findings.filter((f) => f.excerpt !== null);
  check("A12 title, H1 and description excerpts are present", ["page.title", "page.h1", "page.meta_description"].every((id) => excerpts.some((f) => f.checkId === id)));
  const homeBody = new TextEncoder().encode(String(acmeRoutes["https://www.acme-analytics.example/"].body));
  const homeTitle = find(acme, "page.title", 0)?.excerpt;
  check(
    "A13 an excerpt is the exact byte slice its offsets name",
    homeTitle !== null && homeTitle !== undefined && new TextDecoder().decode(homeBody.subarray(homeTitle.start, homeTitle.end)) === homeTitle.text
  );
  check("A14 every excerpt hash is its page's body hash", excerpts.every((f) => acme.pages.find((p) => p.pageIndex === f.pageIndex)?.bodySha256 === f.excerpt?.bodySha256));
  check("A15 every excerpt is at most 300 code points", excerpts.every((f) => Array.from(f.excerpt?.text ?? "").length <= 300));

  /* B: defects, one per check -------------------------------------- */
  const shell = "https://defects.example";
  const defects: FixtureRoutes = {
    [`${shell}/robots.txt`]: robots,
    [`${shell}/`]: html(
      `<div id="root"></div><script>render()</script>
       <a href="/noindex"></a><a href="/header-noindex"></a><a href="/messy"></a><a href="/latin"></a><a href="/pii"></a><a href="/bad-canonical"></a>`,
      `<title>Defects Inc</title><meta property="og:site_name" content="Totally Different Name"><script type="application/ld+json">{"@type":"Organization", oops}</script>`
    ),
    [`${shell}/noindex`]: html("<h1>Hidden</h1><p>words here</p>", `<title>Hidden</title><meta name="robots" content="noindex, nofollow">`),
    [`${shell}/header-noindex`]: { status: 200, headers: { "content-type": "text/html", "x-robots-tag": "googlebot: noindex" }, body: "<title>Scoped</title><h1>Scoped</h1>" },
    [`${shell}/messy`]: html("<h1>One<h1>Two</h1><p>unclosed <div>tags", `<link rel="canonical" href="https://defects.example/a"><link rel="canonical" href="https://defects.example/b">`),
    [`${shell}/latin`]: { status: 200, headers: { "content-type": "text/html; charset=windows-1252" }, body: new Uint8Array([...new TextEncoder().encode("<title>Caf"), 0xe9, ...new TextEncoder().encode(" menu</title><h1>Caf"), 0xe9, ...new TextEncoder().encode("</h1>")]) },
    [`${shell}/pii`]: html("<h1>Contact jane.doe@example.com today</h1>", "<title>Call +1 (555) 010-9999 now</title>"),
    [`${shell}/bad-canonical`]: html("<h1>Canonical</h1>", `<title>Canonical</title><link rel="canonical" href="javascript:alert(1)">`),
  };
  const d = reportOf((await run(defects, "defects.example")).result);
  check("B1 no server text is an issue", find(d, "page.server_text", 0)?.state === "issue" && find(d, "page.server_text", 0)?.detail?.word_count === 0);
  check("B2 no H1 is an issue", find(d, "page.h1", 0)?.state === "issue");
  check("B3 invalid JSON-LD is an issue", find(d, "page.json_ld", 0)?.state === "issue" && find(d, "page.json_ld", 0)?.detail?.invalid_block_count === 1);
  check("B4 no meta description is an issue", find(d, "page.meta_description", 0)?.state === "issue");
  check("B5 missing canonical is info, not an issue", find(d, "page.canonical", 0)?.state === "info" && find(d, "page.canonical", 0)?.detail?.canonical_status === "missing");
  check("B6 disagreeing brand names are an issue", find(d, "site.entity_consistency")?.state === "issue");
  const idx = (path: string) => d.pages.find((p) => p.url.endsWith(path))?.pageIndex ?? -1;
  check("B7 meta noindex is an issue, nofollow recorded", find(d, "page.noindex", idx("/noindex"))?.state === "issue" && find(d, "page.noindex", idx("/noindex"))?.detail?.nofollow === true);
  check("B8 crawler-scoped X-Robots-Tag noindex is info", find(d, "page.noindex", idx("/header-noindex"))?.state === "info" && find(d, "page.noindex", idx("/header-noindex"))?.detail?.scoped_noindex === true);
  check("B9 malformed HTML still parses; two H1s are info", find(d, "page.h1", idx("/messy"))?.state === "info" && find(d, "page.h1", idx("/messy"))?.detail?.h1_count === 2);
  check("B10 conflicting canonicals are an issue", find(d, "page.canonical", idx("/messy"))?.detail?.canonical_status === "conflicting" && find(d, "page.canonical", idx("/messy"))?.state === "issue");
  check("B11 a javascript: canonical is invalid", find(d, "page.canonical", idx("/bad-canonical"))?.detail?.canonical_status === "invalid");
  check("B12 windows-1252 page is still checked", find(d, "page.title", idx("/latin"))?.state === "pass");
  check("B13 ...but carries no excerpt (offsets would not be exact)", find(d, "page.title", idx("/latin"))?.excerpt === null);
  check("B14 a title with a phone number keeps no excerpt", find(d, "page.title", idx("/pii"))?.state === "pass" && find(d, "page.title", idx("/pii"))?.excerpt === null);
  check("B15 an H1 with an email keeps no excerpt", find(d, "page.h1", idx("/pii"))?.excerpt === null);
  check("B16 no personal data anywhere in the report", !/jane\.doe|555\) 010/.test(JSON.stringify(d)));

  /* C: small site, crawl exhausted --------------------------------- */
  const small = reportOf(
    (
      await run(
        {
          "https://tiny.example/robots.txt": robots,
          "https://tiny.example/": html('<h1>Tiny</h1><p>hello world</p><a href="/about">About</a>', "<title>Tiny</title>"),
          "https://tiny.example/about": html("<h1>About</h1>", "<title>About Tiny</title>"),
        },
        "tiny.example"
      )
    ).result
  );
  check("C1 the crawl was exhausted, not capped", small.run.stopReason === "frontier_exhausted" && !small.run.capReached);
  check("C2 a buyer page not found in an exhausted crawl is info", find(small, "buyer_page.pricing")?.state === "info");
  check("C3 no buyer page finding is ever an issue", [acme, d, small].every((r) => r.findings.filter((f) => f.checkId.startsWith("buyer_page.")).every((f) => f.state !== "issue")));
  check("C4 a sitemap 404 is info", find(small, "site.sitemap")?.state === "info" && find(small, "site.sitemap")?.detail?.format === "not_found");
  check("C5 little text is info, not an issue", find(small, "page.server_text", 0)?.state === "info");

  /* D: unknown is never pass or issue ------------------------------ */
  const blocked = reportOf((await run({ "https://closed.example/robots.txt": text("User-agent: *\nDisallow: /\n") }, "closed.example")).result);
  check("D1 a robots-blocked homepage: its checks are unknown/blocked_by_robots", blocked.findings.filter((f) => f.pageIndex === 0).every((f) => f.state === "unknown" && f.unknownReason === "blocked_by_robots"));
  check("D2 unknown findings carry a reason and its text, never detail or excerpt", [acme, d, small, blocked].every((r) => r.findings.filter((f) => f.state === "unknown").every((f) => f.unknownReason !== null && f.unknownReasonText !== null && f.detail === null && f.excerpt === null)));
  check("D3 known findings never carry an unknown reason", [acme, d, small, blocked].every((r) => r.findings.filter((f) => f.state !== "unknown").every((f) => f.unknownReason === null)));

  /* E: report object ----------------------------------------------- */
  check("E1 the report is deep-frozen", Object.isFrozen(acme) && Object.isFrozen(acme.findings) && Object.isFrozen(acme.findings[0]) && Object.isFrozen(acme.pages[0]));
  const before = acme.findings[0].state;
  let threw = false;
  try {
    (acme.findings[0] as { state: string }).state = before === "pass" ? "issue" : "pass";
  } catch {
    threw = true;
  }
  check("E2 a finding cannot be changed", threw && acme.findings[0].state === before);
  check("E3 the hash verifies", verifyReportHash(acme));
  const tampered = JSON.parse(exportReportJson(acme)) as DiagnosticReport;
  check("E4 the JSON export round-trips with the same hash", verifyReportHash(tampered));
  (tampered.findings[0] as { state: string }).state = tampered.findings[0].state === "pass" ? "issue" : "pass";
  check("E5 any change to the content breaks the hash", !verifyReportHash(tampered));
  const json = exportReportJson(acme);
  check("E6 no page body in the report", !json.includes("evidence0 evidence1") && !json.includes("<main>"));
  check("E7 no composite score, grade or percentage anywhere", !/"(score|grade|rating|percent|passRate|total_score)"/i.test(json));
  check("E8 the scope statement and ownership label are in the report", acme.notices.scope === copy.SCOPE_STATEMENT && acme.notices.ownership === copy.OWNERSHIP_NOT_VERIFIED);
  const again = reportOf((await run(acmeSite(), "https://acme-analytics.example")).result);
  check("E9 the same fixture gives the same report hash", again.reportSha256 === acme.reportSha256);
  if (process.env.W1_PRINT_GOLDEN) console.log("GOLDEN", acme.reportSha256);
  check("G1 the representative report matches the reviewed golden hash", acme.reportSha256 === GOLDEN_ACME_REPORT_SHA256);

  /* F: exports ----------------------------------------------------- */
  const md = exportReportMarkdown(acme);
  check("F1 Markdown leads with the scope statement and ownership label", md.includes(copy.SCOPE_STATEMENT) && md.includes(copy.OWNERSHIP_NOT_VERIFIED));
  check("F2 Markdown states that there is no score", md.includes(copy.NO_SCORE_STATEMENT));
  check("F3 Markdown lists what each check does not establish", (md.match(/Does not establish:/g) ?? []).length === acme.findings.length);
  const hostile = escapeMarkdown("[click](javascript:alert(1)) <img src=x onerror=alert(1)> **bold**");
  check("F4 site text cannot inject links or markup", !hostile.includes("](") && !hostile.includes("<img") && !hostile.includes("**"));
  check("F5 URLs render as code, not links", !/\]\(https?:/.test(md));

  /* H: storable in the Q2′-2 tables -------------------------------- */
  for (const [name, report] of [["acme", acme], ["defects", d], ["tiny", small], ["blocked", blocked]] as const) {
    const rows = toQ2p2Rows(report);
    const problems = validateQ2p2Rows(rows);
    check(`H1 ${name}: every row satisfies the migration's constraints${problems.length ? " — " + problems.join("; ") : ""}`, problems.length === 0);
    check(`H2 ${name}: detail is persisted as NULL until the registry is approved`, rows.findings.every((f) => f.detail === null));
  }

  /* K: copy lint --------------------------------------------------- */
  const lintable = [copy.SCOPE_STATEMENT, copy.OWNERSHIP_NOT_VERIFIED, copy.NO_SCORE_STATEMENT, copy.SAMPLE_LIMIT_STATEMENT, copy.INTERNAL_PREVIEW_LABEL, ...Object.values(copy.UNKNOWN_REASON_TEXT), ...Object.values(copy.OUTCOME_TEXT)].join(" ").toLowerCase();
  const hit = copy.FORBIDDEN_W1_PHRASES.find((phrase) => lintable.includes(phrase));
  check(`K1 report copy uses no forbidden phrase${hit ? ` (found "${hit}")` : ""}`, hit === undefined);
  check("K2 the scope statement is the docs' sentence, verbatim", copy.SCOPE_STATEMENT === "This checks your website's public pages. It does not show how any AI system answers buyers.");

  check("no global fetch call", fetchCalls === 0);
  console.log(`\n${total - failures}/${total} checks passed.`);
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
