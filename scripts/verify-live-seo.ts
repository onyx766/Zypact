#!/usr/bin/env tsx
/**
 * Verifies the DEPLOYED site against the route policy this repo declares.
 *
 * `npm run test:seo` proves the app is configured correctly. This proves the
 * thing actually serving zypact.com agrees — the two diverge whenever a
 * deploy is stale, a platform-level redirect is missing, or a domain still
 * points at an older project.
 *
 * Read-only: issues GET/HEAD requests to public URLs and asserts status
 * codes, redirect targets, canonical tags and robots headers. It never
 * authenticates, never posts, and never touches a private route beyond
 * confirming robots.txt blocks it.
 *
 * Usage:
 *   npm run verify:live-seo                       (checks the canonical host)
 *   npm run verify:live-seo -- https://staging... (checks another origin)
 */

import { CANONICAL_SITE_URL } from "@/lib/seo/site";
import {
  INDEXABLE_PATHS,
  LEGACY_GONE,
  LEGACY_REDIRECTS,
  NOINDEX_PATH_PREFIXES,
} from "@/lib/seo/legacy-routes";

const TIMEOUT_MS = 20_000;

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

interface Probe {
  status: number;
  location: string | null;
  robotsTag: string | null;
  body: string;
  error: string | null;
}

async function probe(url: string, method: "GET" | "HEAD" = "GET"): Promise<Probe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method,
      redirect: "manual",
      signal: controller.signal,
      headers: { "User-Agent": "zypact-seo-verifier" },
    });

    return {
      status: res.status,
      location: res.headers.get("location"),
      robotsTag: res.headers.get("x-robots-tag"),
      body: method === "GET" ? await res.text() : "",
      error: null,
    };
  } catch (error) {
    return {
      status: 0,
      location: null,
      robotsTag: null,
      body: "",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function canonicalTagOf(html: string): string | null {
  const match = html.match(
    /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i
  );
  return match ? match[1] : null;
}

function titleOf(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].trim() : null;
}

async function main() {
  const base = (process.argv[2] ?? CANONICAL_SITE_URL).replace(/\/+$/, "");
  console.log(`Verifying ${base}\n`);

  console.log("the site is live");
  {
    const root = await probe(`${base}/`);
    check(
      "/ returns 200",
      root.status === 200,
      root.error ?? `status=${root.status}`
    );
    check("/ has a title", Boolean(titleOf(root.body)), titleOf(root.body) ?? "(none)");
    check(
      "/ declares a canonical",
      canonicalTagOf(root.body) !== null,
      canonicalTagOf(root.body) ?? "(none)"
    );
    check(
      "/ canonical points at the canonical host",
      (canonicalTagOf(root.body) ?? "").startsWith(CANONICAL_SITE_URL),
      canonicalTagOf(root.body) ?? "(none)"
    );
  }

  console.log("\npublic pages are indexable");
  for (const path of INDEXABLE_PATHS) {
    const res = await probe(`${base}${path === "/" ? "/" : path}`);
    check(`${path} returns 200`, res.status === 200, res.error ?? `status=${res.status}`);
    check(
      `${path} is not noindexed`,
      !(res.robotsTag ?? "").includes("noindex"),
      res.robotsTag ?? "(no header)"
    );
    if (res.status === 200) {
      check(
        `${path} declares a canonical`,
        canonicalTagOf(res.body) !== null,
        canonicalTagOf(res.body) ?? "(none)"
      );
    }
  }

  console.log("\ncrawl directives are served");
  {
    const robotsTxt = await probe(`${base}/robots.txt`);
    check("robots.txt returns 200", robotsTxt.status === 200, `status=${robotsTxt.status}`);
    check(
      "robots.txt advertises the sitemap",
      robotsTxt.body.toLowerCase().includes("sitemap:"),
    );

    const sitemapXml = await probe(`${base}/sitemap.xml`);
    check("sitemap.xml returns 200", sitemapXml.status === 200, `status=${sitemapXml.status}`);
    check(
      "sitemap.xml lists the homepage",
      sitemapXml.body.includes(`<loc>${CANONICAL_SITE_URL}</loc>`) ||
        sitemapXml.body.includes(`<loc>${CANONICAL_SITE_URL}/</loc>`)
    );
    for (const path of LEGACY_GONE) {
      check(
        `sitemap.xml omits retired ${path}`,
        !sitemapXml.body.includes(`${CANONICAL_SITE_URL}${path}<`)
      );
    }
  }

  console.log("\nlegacy URLs answer correctly");
  {
    for (const { from, to } of LEGACY_REDIRECTS) {
      const res = await probe(`${base}${from}`, "HEAD");
      const target = res.location ?? "";
      check(
        `${from} → 301 ${to}`,
        res.status === 301 && target.endsWith(to === "/" ? "/" : to),
        res.error ?? `status=${res.status} location=${target || "(none)"}`
      );
    }

    for (const path of LEGACY_GONE) {
      const res = await probe(`${base}${path}`, "HEAD");
      check(
        `${path} → 410 Gone`,
        res.status === 410,
        res.error ?? `status=${res.status}`
      );
    }
  }

  console.log("\nthin pages stay out of the index");
  for (const path of NOINDEX_PATH_PREFIXES) {
    const res = await probe(`${base}${path}`, "HEAD");
    check(
      `${path} carries a noindex header`,
      (res.robotsTag ?? "").includes("noindex"),
      res.error ?? res.robotsTag ?? "(no header)"
    );
  }

  console.log("\nthe apex host redirects to the canonical host");
  {
    // Platform-level (Vercel domain settings), not something this repo can
    // enforce — which is exactly why it is verified rather than assumed.
    const apex = CANONICAL_SITE_URL.replace("://www.", "://");
    if (base === CANONICAL_SITE_URL) {
      const res = await probe(`${apex}/`, "HEAD");
      check(
        "apex 301s to www",
        (res.status === 301 || res.status === 308) &&
          (res.location ?? "").startsWith(CANONICAL_SITE_URL),
        res.error ?? `status=${res.status} location=${res.location ?? "(none)"}`
      );
    } else {
      console.log("  skip  not checking the apex for a non-production origin");
    }
  }

  console.log(`\n${checks - failures}/${checks} live SEO checks passed.`);

  if (failures > 0) {
    console.error(`${failures} FAILED.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
