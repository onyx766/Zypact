#!/usr/bin/env tsx
/**
 * Contract for the relaunch SEO surface.
 *
 * The failure this guards against is silent: a wrong canonical host, a
 * private path leaking into the sitemap, or a legacy URL answering 404
 * instead of 410 costs nothing at build time and is only discovered weeks
 * later in Search Console. So the route policy is asserted here as data.
 *
 * Pure: no network, no database, no provider. The live deployment is checked
 * separately by `npm run verify:live-seo`, which needs a real origin.
 */

import { NextRequest } from "next/server";

import { middleware } from "@/middleware";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { CANONICAL_SITE_URL, canonicalUrl } from "@/lib/seo/site";
import {
  assertLegacyRouteMapIsSound,
  DISALLOWED_PATH_PREFIXES,
  INDEXABLE_PATHS,
  LEGACY_GONE,
  LEGACY_REDIRECTS,
  NOINDEX_PATH_PREFIXES,
} from "@/lib/seo/legacy-routes";

let checks = 0;
let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function request(path: string): NextRequest {
  return new NextRequest(new URL(path, CANONICAL_SITE_URL));
}

async function main() {
  console.log("route map is internally consistent");
  {
    const problems = assertLegacyRouteMapIsSound();
    check(
      "no contradictions between redirect, gone, noindex and indexable lists",
      problems.length === 0,
      problems.join("; ")
    );
    check("there is at least one legacy URL handled", LEGACY_REDIRECTS.length + LEGACY_GONE.length > 0);
  }

  console.log("\ncanonical host");
  {
    check(
      "canonical origin is the indexed www host",
      CANONICAL_SITE_URL === "https://www.zypact.com" ||
        process.env.NEXT_PUBLIC_SITE_URL !== undefined,
      CANONICAL_SITE_URL
    );
    check("canonical origin carries no trailing slash", !CANONICAL_SITE_URL.endsWith("/"));
    check("canonical origin is https", CANONICAL_SITE_URL.startsWith("https://"));
    check("root canonical has no trailing slash", canonicalUrl("/") === CANONICAL_SITE_URL);
    check("path canonical joins correctly", canonicalUrl("/scan") === `${CANONICAL_SITE_URL}/scan`);
  }

  console.log("\nsitemap lists exactly the public surface");
  {
    const entries = sitemap();
    const urls = entries.map((e) => e.url);

    check(
      "every indexable path is present",
      INDEXABLE_PATHS.every((p) => urls.includes(canonicalUrl(p))),
      urls.join(", ")
    );
    check("nothing else is present", urls.length === INDEXABLE_PATHS.length);
    check(
      "every URL is absolute on the canonical host",
      urls.every((u) => u.startsWith(`${CANONICAL_SITE_URL}/`) || u === CANONICAL_SITE_URL)
    );
    check(
      "no obsolete route is listed",
      LEGACY_GONE.every((p) => !urls.includes(canonicalUrl(p))) &&
        LEGACY_REDIRECTS.every((r) => !urls.includes(canonicalUrl(r.from)))
    );
    check(
      "no private route is listed",
      urls.every(
        (u) =>
          !DISALLOWED_PATH_PREFIXES.some((prefix) =>
            u.startsWith(`${CANONICAL_SITE_URL}${prefix}`)
          )
      )
    );
    check(
      "no noindex route is listed",
      urls.every(
        (u) =>
          !NOINDEX_PATH_PREFIXES.some((prefix) =>
            u.startsWith(`${CANONICAL_SITE_URL}${prefix}`)
          )
      )
    );
  }

  console.log("\nrobots.txt blocks only what must never be crawled");
  {
    const r = robots();
    const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    const disallow = ([] as string[]).concat(
      (rule?.disallow as string[] | string | undefined) ?? []
    );

    check(
      "every private prefix is disallowed",
      DISALLOWED_PATH_PREFIXES.every((prefix) =>
        disallow.some((d) => d.startsWith(prefix))
      ),
      disallow.join(", ")
    );
    check(
      "client evidence at /report is never crawlable",
      disallow.some((d) => d.startsWith("/report"))
    );
    check(
      "noindex pages are NOT disallowed, so the header can be read",
      NOINDEX_PATH_PREFIXES.every(
        (prefix) => !disallow.some((d) => d.startsWith(prefix))
      )
    );
    check("sitemap is advertised", r.sitemap === canonicalUrl("/sitemap.xml"));
    check("host is the canonical origin", r.host === CANONICAL_SITE_URL);
  }

  console.log("\nlegacy URLs answer 301 or 410, never 404");
  {
    for (const { from, to } of LEGACY_REDIRECTS) {
      const res = await middleware(request(from));
      const location = res.headers.get("location");
      // Compared as a parsed URL, not a string: the root target is emitted
      // as "https://host/" while canonicalUrl("/") has no trailing slash,
      // and they are the same destination.
      const parsed = location ? new URL(location) : null;
      check(
        `${from} is a permanent redirect to ${to}`,
        res.status === 301 &&
          parsed !== null &&
          parsed.origin === CANONICAL_SITE_URL &&
          parsed.pathname === to,
        `status=${res.status} location=${location}`
      );
    }

    for (const path of LEGACY_GONE) {
      const res = await middleware(request(path));
      check(
        `${path} answers 410 Gone`,
        res.status === 410,
        `status=${res.status}`
      );
      check(
        `${path} is not offered to the index`,
        (res.headers.get("x-robots-tag") ?? "").includes("noindex")
      );
    }

    // A trailing slash and mixed case are the same URL to a crawler, and
    // Google has both forms in its index for old sites.
    const slashed = await middleware(request("/about/"));
    check("a trailing slash still answers 410", slashed.status === 410);

    const uppercased = await middleware(request("/About"));
    check("mixed case still answers 410", uppercased.status === 410);

    const withQuery = await middleware(
      request("/v2?utm_source=google")
    );
    check(
      "a redirect preserves the query string",
      withQuery.status === 301 &&
        (withQuery.headers.get("location") ?? "").includes("utm_source=google"),
      withQuery.headers.get("location") ?? ""
    );
  }

  console.log("\nnoindex headers");
  {
    for (const path of NOINDEX_PATH_PREFIXES) {
      const res = await middleware(request(path));
      check(
        `${path} is served with a noindex header`,
        (res.headers.get("x-robots-tag") ?? "").includes("noindex"),
        res.headers.get("x-robots-tag") ?? "(none)"
      );
      check(`${path} still answers normally`, res.status === 200);
    }

    for (const path of INDEXABLE_PATHS) {
      const res = await middleware(request(path));
      check(
        `${path} is NOT noindexed`,
        !(res.headers.get("x-robots-tag") ?? "").includes("noindex")
      );
    }
  }

  console.log(
    `\n${checks - failures}/${checks} SEO contract checks passed.`
  );

  if (failures > 0) {
    console.error(`${failures} FAILED.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
