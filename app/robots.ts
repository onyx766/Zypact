import type { MetadataRoute } from "next";

import { CANONICAL_SITE_URL, canonicalUrl } from "@/lib/seo/site";
import { DISALLOWED_PATH_PREFIXES } from "@/lib/seo/legacy-routes";

/**
 * robots.txt, generated from the same route policy the app enforces.
 *
 * Only genuinely private surfaces are disallowed: the admin console, the API,
 * project workspaces, and `/report/*`, which serves a client's own evidence
 * behind a secret token and must never be fetched by a crawler.
 *
 * Thin public pages (`/login`, `/verify-email`, `/thank-you`) are deliberately
 * NOT disallowed here — they carry a `noindex` header instead (middleware.ts).
 * Disallowing them would stop Google from ever reading that header, leaving
 * the URLs listed in search forever.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: DISALLOWED_PATH_PREFIXES.map((prefix) => `${prefix}/`),
      },
    ],
    sitemap: canonicalUrl("/sitemap.xml"),
    host: CANONICAL_SITE_URL,
  };
}
