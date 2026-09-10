# SEO relaunch cleanup — legacy index, redirects, and reindex

- **Status:** Operational runbook for the deploy-cleanup stage
- **Owner:** Founder/CEO
- **Applies to:** `www.zypact.com`

The previous Zypact site is gone, but Google still indexes its URLs. They
currently answer `404`, which keeps dead pages listed for months and shows
stale positioning in search results. This runbook makes Google's picture of
the site match what actually exists.

## Canonical host

`https://www.zypact.com` — the host Google has indexed and the host the
deployment answers on. It is declared once, in
[`lib/seo/site.ts`](../lib/seo/site.ts), and every canonical tag, Open Graph
URL, JSON-LD reference, sitemap entry and robots.txt line is derived from it.
Preview and staging deployments override it with `NEXT_PUBLIC_SITE_URL` so a
preview never emits production canonicals.

The apex (`zypact.com`) must `301` to `www` — that is a Vercel domain
setting, not something this repository can enforce, so
`npm run verify:live-seo` checks it instead of assuming it.

## What the repository now does

| Requirement | Where | Notes |
| --- | --- | --- |
| Homepage returns 200 with the current MVP | deploy + `verify:live-seo` | Verified live, not assumed |
| Legacy route inventory | [`lib/seo/legacy-routes.ts`](../lib/seo/legacy-routes.ts) | One source of truth for every old URL |
| 301 where a successor exists | `middleware.ts` via `LEGACY_REDIRECTS` | Passes ranking signal to the new page |
| 410 where nothing replaced it | `middleware.ts` via `LEGACY_GONE` | Google drops these faster than a 404 |
| Obsolete routes out of the sitemap | [`app/sitemap.ts`](../app/sitemap.ts) | Derived from `INDEXABLE_PATHS`, not hand-written |
| Canonical URLs | `app/layout.tsx`, `app/page.tsx`, `app/scan/page.tsx` | `metadataBase` + per-page canonical |
| Titles / meta / structured data | `app/layout.tsx`, `app/page.tsx` | Current V1 positioning |
| `/scan` kept as the demo route | `app/page.tsx` (`DEMO_URL`) | Confirmed: it is the Request Demo route |
| Reindex / removal preparation | this document | Steps below |

Two rules are enforced by [`scripts/test-seo-contract.ts`](../scripts/test-seo-contract.ts)
so they cannot regress silently:

- a private path (`/admin`, `/api`, `/projects`, `/report`) can never appear
  in the sitemap, and `/report` — which serves a client's own evidence behind
  a secret token — is blocked from crawling outright;
- a page that must not be indexed is served `X-Robots-Tag: noindex` and is
  **not** disallowed in robots.txt. A disallowed URL is never crawled, so a
  `noindex` Google cannot read is a `noindex` Google cannot obey.

## Adding the Search Console export

The map currently covers the URLs visible in Google's sitelinks plus likely
demo aliases. To make it complete:

1. Search Console → **Indexing → Pages** → open **Not found (404)**, and also
   review **Indexed** for pages that should no longer be public.
2. Export the URL list.
3. For each URL, add its **path** to exactly one list in
   [`lib/seo/legacy-routes.ts`](../lib/seo/legacy-routes.ts):
   - `LEGACY_REDIRECTS` — only when a current page genuinely replaces it.
     Redirecting an unrelated page to `/` is treated by Google as a soft 404
     and helps nothing.
   - `LEGACY_GONE` — everything else.
4. Run `npm run test:seo`. The contract rejects a path in both lists, a
   redirect chain, a redirect to a 410'd page, and any non-normalized path.

Delete any of the `/demo`, `/request-demo`, `/request-a-demo` aliases the
export shows never existed.

## Deploy and verify

```bash
npm run test:seo          # route policy, no network
npm run typecheck
NEXT_TELEMETRY_DISABLED=1 npm run build
# after deploying:
npm run verify:live-seo   # the deployed site, against the same policy
```

`verify:live-seo` fails loudly if the homepage is not 200, a canonical points
at the wrong host, a legacy URL still answers 404, robots.txt or sitemap.xml
is missing, or the apex does not redirect to `www`.

## Search Console, after the deploy is verified

1. **Sitemaps** → submit `https://www.zypact.com/sitemap.xml`.
2. **URL Inspection** → inspect `https://www.zypact.com/` and `/scan` →
   **Request indexing**, so the new titles and descriptions are picked up
   rather than waiting for a natural recrawl.
3. **Removals** → use **Temporary removal** only for anything urgent. It
   hides a URL for about six months; the `410` is what removes it
   permanently. Do not rely on removals instead of the status codes.
4. Re-check **Pages → Not found (404)** after two to three weeks. The legacy
   URLs should have moved to *Not found (410)* or *Page with redirect*. Any
   URL still reporting 404 is one missing from the map — add it and redeploy.

## Positioning note

Google still shows a sitelink reading "How it works — 5 metrics, 4 AI …".
That is legacy positioning and it contradicts the V1 methodology, which is a
single directional surface with no fixed multi-metric score (D-001, D-004,
`docs/V1_SCOPE.md`). The URL is answered with `410` rather than redirected to
the homepage, because the homepage is not its replacement — the page it
described no longer exists, and saying so is the honest answer. Until Google
recrawls, that text may persist in results; requesting indexing for `/`
(step 2 above) is what shortens the window.
