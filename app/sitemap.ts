import type { MetadataRoute } from "next";

import { canonicalUrl } from "@/lib/seo/site";
import { INDEXABLE_PATHS } from "@/lib/seo/legacy-routes";

/**
 * The sitemap is exactly the public, indexable surface — nothing else.
 *
 * It is derived from `INDEXABLE_PATHS` rather than written out by hand, so a
 * route cannot be added to the sitemap without also passing the contract
 * checks that keep private, redirected, and 410-gone paths out of it.
 *
 * Obsolete routes from the previous site are absent by construction: they are
 * not in that list, and `assertLegacyRouteMapIsSound` fails if a path is ever
 * both indexable and retired.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return INDEXABLE_PATHS.map((path) => ({
    url: canonicalUrl(path),
    lastModified,
    changeFrequency: path === "/" ? ("weekly" as const) : ("monthly" as const),
    priority: path === "/" ? 1 : 0.8,
  }));
}
