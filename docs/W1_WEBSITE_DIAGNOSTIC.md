# W1 — Website Buyer-Readiness Diagnostic: offline engine and founder preview

Status: **implemented on `feat/w1-website-diagnostic`, not merged, not deployed, not customer-facing.**
Base: `main` @ `5851f3d` (PR #102). Scope chosen 2026-11-04 under the Technical Co-founder
handoff of 2026-11-03 (§7, §13: "start W1-A/W1-B now"): the offline W1 engine (W1-A, W1-B,
W1-C) plus a founder-only, stateless preview. W1-D (writer RPCs, run persistence, customer UI,
release controls) is **not** in this change and stays gated behind S1, G1 and the Q2′-2
production apply.

Canonical requirements: [`SELF_SERVICE_PRODUCT.md`](SELF_SERVICE_PRODUCT.md) §6 and §7, D-040
and D-043 in [`DECISIONS.md`](DECISIONS.md), and the merged Q2′-2 migration
`supabase/migrations/20261103173000_q2p2_domains_and_site_diagnostics.sql`. This note describes
how the code meets them and lists the **proposed values that need a founder decision**
(section 9).

## 1. What it is and is not

A bounded, deterministic check of a site's **public pages**. No model call, no paid call, no
third-party API, no database. Every report states, verbatim:

> This checks your website's public pages. It does not show how any AI system answers buyers.
>
> Domain ownership not verified.

There is **no composite score**: no total, grade, percentage or pass count. Each check reports
`pass`, `issue`, `info` or `unknown` with its evidence and what it does **not** establish. An
`unknown` always carries one of the nine D-040 §6.3 reasons and is never shown as pass or issue.
A buyer-relevant page not found is `info` only when the crawl explored every link it discovered
within its bounds. Otherwise it is `unknown`. It is never reported as absent from the site.

## 2. Data flow

```
input URL
  → normalizeDiagnosticInput    (url.ts: https default, A-labels, no IP / port / credentials /
                                 reserved names; start at the homepage)
  → validateOutboundUrl         (refuse non-public or unresolvable hosts before any request)
  → crawlForDiagnostic          (crawl.ts, W1-B)  → CrawlCapture (serialisable) + PageBodies (memory)
  → evaluateChecks              (checks.ts, W1-A) → Finding[]
  → buildDiagnosticReport       (report.ts, W1-C) → frozen DiagnosticReport + sha256
  → exportReportJson / exportReportMarkdown / toQ2p2Rows
```

Entry points: `runSiteDiagnostic()` (`lib/site-diagnostic/engine.ts`), `npm run w1:diagnose`, and
the founder preview at `/admin/site-diagnostics`.

## 3. Modules

| Path | Pure? | Role |
| --- | --- | --- |
| `lib/crawler/robots.ts` | yes | RFC 9309: parse (500 KiB, truncate on a line boundary), product-token groups (merged, case-insensitive, `*` fallback), longest match with Allow winning ties, `*` and `$`, percent-encoding normalisation, `/robots.txt` always allowed, status policy, 24 h bounded cache with an injected clock |
| `lib/crawler/safe-fetch.ts` | — | **Additive only**: optional `accept`, `acceptEncoding`, `maxBodyBytes`, `onOversize: "truncate"`, wall-clock `deadlineMs`; raw `bodyBytes` in the result; `RequestTimeoutError` (same message); new single-hop `safeFetchOnce` that returns a 3xx unfollowed. With no options, behaviour is byte-identical for `crawlSite` |
| `lib/crawler/outbound-url-safety.ts` | — | IPv6 is now an allow-list (`2000::/3` only, minus `2001::/23`, `2001:db8::/32`, `2002::/16`, `3fff::/20`); the dotted-tail branch is exact (`::ffff:` and `64:ff9b::` only); `192.88.99.0/24` added. Strictly tighter; no existing expectation changed |
| `lib/site-diagnostic/contract.ts` | yes | TS mirror of every Q2′-2 regex, enum and cap, plus a faithful port of `_q2p2_detail_matches_spec` and a worst-case jsonb size bound |
| `lib/site-diagnostic/policy.ts` | yes | Versioned fetch policy, user agent, excluded paths |
| `lib/site-diagnostic/url.ts` | yes | Input normalisation, same-site hosts, excluded/asset paths, the sanitised evidence URL (always matches `_q2p2_url_is_sanitised`) |
| `lib/site-diagnostic/buyer-pages.ts` | yes | Path and anchor-text classification into the eight buyer categories |
| `lib/site-diagnostic/crawl.ts` | I/O | The crawler (section 4) |
| `lib/site-diagnostic/html.ts` | yes | Facts from the **unmodified** HTML (cheerio, no JS); charset decoding; source offsets |
| `lib/site-diagnostic/catalog.ts` | yes | The 23-check catalogue (section 6) |
| `lib/site-diagnostic/checks.ts` | yes | The rules; each finding is validated against its catalogue entry |
| `lib/site-diagnostic/excerpt.ts` | yes | Excerpts of at most 300 code points as exact byte slices, with a personal-data screen that drops rather than redacts |
| `lib/site-diagnostic/report.ts`, `export.ts`, `copy.ts` | yes | Immutable report, canonical JSON and Markdown exports, single-source copy and forbidden-phrase list |
| `lib/site-diagnostic/persistence-shape.ts` | yes | The Q2′-2 rows the report would become, and a validator of every migration constraint. Writes nothing |
| `lib/site-diagnostic/preview-handler.ts`, `app/api/internal/site-diagnostics/preview/route.ts`, `app/admin/site-diagnostics/*` | — | Founder preview (section 8) |

`lib/crawler/crawl-site.ts` is **unchanged** and not used by W1. It still serves the founder
snapshot pipeline. Changing it (for example adding robots handling there) would change that
paid pipeline's output and is a separate decision.

## 4. Crawler behaviour (W1-B)

Order: `robots.txt` on the submitted origin, the homepage, `sitemap.xml` (a same-site robots
`Sitemap:` directive first, else `/sitemap.xml`), `llms.txt`, then up to 9 more pages. The
auxiliary files are requested on the host the homepage settled on (apex → www).

Before **every** request, including each redirect hop, the crawler checks: same site (the
submitted host and its www/apex alternate only); default port; robots.txt for that hop's origin
allows the path for the `zypactbot` token; request budget, run deadline and abort signal; then
the politeness delay. Only then does it call `safeFetchOnce`, which re-runs the SSRF policy with
fresh, bounded DNS and pins the socket to the validated addresses.

Robots outcomes: 2xx parsed; 4xx no restrictions; 5xx, network failure or timeout means a
complete disallow. Nothing else is fetched, the homepage row records `robots_unavailable`, and
every finding is `unknown/robots_unavailable`.

Page selection is deterministic. Uncovered buyer categories go first, in category order. Then
path matches before anchor-text matches, links before sitemap URLs, shallower paths first, then
URL order. Page rows count attempts, not successes (failures included), so a page full of broken
links cannot cause unbounded requests. A redirect onto an already-recorded page creates no
second row. URLs with a query string, asset extensions, excluded paths (login, account,
checkout, admin, …), off-site hosts and non-default ports are never requested.

Evidence per page row: sanitised final URL, the requested URL, the sanitised redirect chain,
`fetchedAt` from the injected clock, status, content type (≤ 200 chars), byte count and
SHA-256 of the **raw** bytes (null exactly when the body is empty), robots decision and a closed
`fetch_error`. Bodies stay in memory and never enter the capture or the report.
`Accept-Encoding: identity` is sent, and a compressed reply is a `fetch_failed`.

## 5. Determinism

Findings depend only on the fetched bytes, statuses, the headers read (Content-Type,
X-Robots-Tag) and the rule-set version. Timing never enters the rules. The tests prove that the
same fixtures at three different latencies produce identical captures (timestamps aside) and
identical findings, and that reordering a page's links does not change which pages are chosen.
The representative fixture's full report hash is pinned as a golden value.

## 6. Check catalogue — rule set `w1-2026.11`, per-check rule version `w1.1` (PROPOSED)

| Area | Check id | States |
| --- | --- | --- |
| Crawl access | `robots.agents` | pass / issue (a named token is disallowed from `/`) / unknown |
| Crawl access | `site.sitemap` | pass / issue (does not parse or is empty) / info (not found) / unknown |
| Crawl access | `site.llms_txt` | info (present or not; it is not a standard) / unknown |
| Crawl access | `page.http_status` | pass / info (3xx) / issue (4xx, 5xx) / unknown |
| Indexing | `page.noindex` | pass / issue (generic noindex) / info (crawler-scoped) / unknown |
| Indexing | `page.canonical` | pass (self) / info (missing, other URL, off-site) / issue (conflicting, invalid) / unknown |
| Page basics | `page.server_text` | pass (≥ 100 words) / info (1–99) / issue (0) / unknown |
| Page basics | `page.title`, `page.meta_description`, `page.h1` | pass (exactly one) / info (several) / issue (none or empty) / unknown |
| Page basics | `site.duplicate_titles` | pass / info / unknown (fewer than 2 pages) |
| Structured data | `page.json_ld` | pass / issue (a block does not parse) / info (none) / unknown |
| Structured data | `site.organization_markup` | pass (Organization with name and url) / info / unknown |
| Entity | `site.entity_consistency` | pass / issue (names disagree) / info (fewer than 2 signals) / unknown |
| Buyer pages | `buyer_page.{product, pricing, integrations, security, comparison, docs, faq, customer_stories}` | pass (found) / info (not found, crawl exhausted) / unknown (cap, robots, failure). **Never issue** |
| Your own wording | `site.seller_wording` | info only: count of `MARKETING_LEXICON_V1` phrases, never buyer evidence |

Each entry carries its area, title, "establishes" and "does not establish" text, a static
`priority` (orders the fix list only; it is never summed, averaged or shown as a grade), static
fix text, its allowed unknown reasons and a detail spec in the exact `_q2p2_finding_detail_spec`
grammar. `scripts/test-w1-contract.ts` proves every spec is well formed and fits 4,096 bytes in
the worst case, and that no id or version collides with the Level-2 QR2-19 probe pairs.

**Nothing is persisted with detail yet.** The database registry ships empty (D-043); findings map
to `detail = NULL` until the founder, with independent review, approves each
`(check_id, rule_version)` in a later migration (named without `_q2p2_`, dated after
`20261103173000`, updating QR2-19 and the SV1 migration count in the same PR).

## 7. Privacy

- No page body, header value, cookie, IP address or free-text error is kept, logged or returned.
- URLs are stored only in sanitised form: no query, fragment or userinfo; `@` encoded; IP
  literals have no stored form.
- Excerpts come only from titles, H1s and meta descriptions. Each is at most 300 code points, an
  exact byte slice of the page (verifiable against its SHA-256), and only taken when byte offsets
  are exact (valid UTF-8). It is dropped entirely if `w1-pii-screen.1` sees an email, phone
  number, card-length digit run, SSN or IBAN shape, or an encoded `@`.
- Logs (preview) carry closed fields only: event, founder user id, outcome, stop reason, page and
  request counts, duration.
- Rate-limit storage (`diagnostic_rate_limit_events`), its HMAC key and purge scheduling are W1-D
  work and remain gates before customer use (Q2-R2, Q2-R4).

## 8. Founder preview

`/admin/site-diagnostics` (page) → `POST /api/internal/site-diagnostics/preview` (route).

- **Off by default.** `ZYPACT_W1_PREVIEW_ENABLED` must be exactly `"true"`, else the route
  returns 503 before authentication.
- Then `requireFounderForRoute` (401 / 404 / 503 unchanged), and only then the body is read:
  JSON only (415 otherwise), at most 8 KiB (413), closed refusal codes (422).
- A per-domain 30 s cooldown applies per server instance. This is not the W1-D rate limiter.
- Stateless: runs the engine in memory and returns the frozen report plus Markdown; JSON and
  Markdown download in the browser. It writes nothing and names no Q2′ table.
- `runtime = "nodejs"`, `maxDuration = 60`, above the crawl's 45 s run deadline.
- It makes **live outbound requests** to the submitted site when enabled. Deploying the route
  with the switch off has no outbound effect.

The page and route reach `lib/auth/founder.ts` (the existing founder gate) and nothing else
outside W1. `scripts/test-w1-preview.ts` walks the import graph to prove that no W1 module
reaches `lib/llm`, `lib/probes`, `lib/db`, `lib/pipeline`, `lib/agents`, `lib/worker-control`,
`lib/protocol-worker` or the report service client.

## 9. Decisions needed (proposed values, all fail-closed or conservative)

| # | Question | Proposed in code |
| --- | --- | --- |
| W1-Q1 | Numeric bounds (D3 not started) | 10 page rows (attempts), 40 requests per run, 5 redirects, 8 s idle / 12 s wall clock per request, 5 s DNS, 45 s per run, 250 ms politeness, HTML 2 MB (reject → `size_cap`), robots 500 KiB (truncate), sitemap 1 MB, llms.txt 256 KiB |
| W1-Q2 | robots.txt 429 | Treated as unreachable (complete disallow). The docs say only "4xx: no restrictions" |
| W1-Q3 | robots.txt with more than 5 redirects, or redirecting off the site | Unreachable (complete disallow) |
| W1-Q4 | Same-site definition | Submitted host plus its www/apex alternate. Other subdomains (docs.example.com) are not crawled; their pages are reported as not found within the crawl, never absent |
| W1-Q5 | Start URL | Always the homepage of the submitted host; a deeper path is ignored and recorded (`pathIgnored`) |
| W1-Q6 | Named crawler tokens for `robots.agents` | 16 tokens: GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User, Google-Extended, Googlebot, Bingbot, Applebot, Applebot-Extended, CCBot, meta-externalagent, Amazonbot |
| W1-Q7 | User agent and robots token | `ZypactBot/1.0 (+https://www.zypact.com; website diagnostic)`, token `zypactbot`. A dedicated bot-information page would be a public-page change |
| W1-Q8 | Hash basis and excerpt offsets | SHA-256 over raw response bytes; excerpt offsets are UTF-8 byte offsets into those bytes |
| W1-Q9 | Where robots.txt / sitemap.xml / llms.txt evidence is stored | Report-only. The schema has no auxiliary table and page rows are capped at 10; recommend an additive table in W1-D |
| W1-Q10 | Priorities | Static per check (high / medium / low), ordering only, never aggregated |
| W1-Q11 | Catalogue vocabulary, detail fields and every count max | As in `catalog.ts`; requires founder approval and independent review before any registry migration |
| W1-Q12 | Claim-language review (D11) of every string in `copy.ts` and `catalog.ts` | Not done; required by the W1 exit criterion and before customer exposure |

Open items carried from the review, not solved here: the retention/deletion conflict (the
schema refuses DELETE on diagnostic rows, while §8.5 requires deletion); the account-versus-
workspace unit for cache and quotas; how Q3′ obtains site copy for the Q1 marketing signal once
bodies are discarded.

## 10. Tests

| Command | What it proves |
| --- | --- |
| `npm run test:w1-contract` | Mirror equals the migration text; detail validator; all 23 catalogue entries; URL handling; newly refused IPv6/IPv4 ranges |
| `npm run test:w1-robots` | RFC 9309 parsing, matching, status policy, 500 KiB limit, cache |
| `npm run test:w1-safe-fetch` | Additive transport options against a 127.0.0.1-only server; `safeFetchOnce`; `safeFetch` unchanged |
| `npm run test:w1-crawl` | Bounds, robots outcomes, SSRF and DNS rebinding refusals proved by the transport log, redirects, size and deadline limits, cancellation, determinism |
| `npm run test:w1-report` | Check states on defect fixtures, verifiable excerpts, PII screening, unknown never converted, frozen report and hash, exports and escaping, copy lint, Q2′-2 row validity, golden hash |
| `npm run test:w1-preview` | Kill switch → guard → body order, refusals, closed logs, cooldown, import boundary |
| `npm run test:w1` | All of the above plus the two pre-existing crawler suites, now registered |

All are offline (fixture transport, fake DNS, virtual clock; a throwing global `fetch` proves no
hidden call), except that `test:w1-safe-fetch` and `test:outbound-url-safety` bind 127.0.0.1.
None runs in CI; adding a W1 workflow is a founder decision.

What these tests do **not** establish: behaviour against the open web at scale, hosted Supabase
or Vercel behaviour, the real `maxDuration` limit on the deployment plan, or that any claim-
language review has happened.

## 11. Rollback / disable

No migration and no stored data. To disable, leave or set `ZYPACT_W1_PREVIEW_ENABLED` unset
(the route then refuses with 503 before authentication). To roll back, revert the PR. The shared
crawler changes are additive (defaults unchanged) or strictly tighter (IPv6 allow-list), and the
pre-existing crawler suites pass before and after.
