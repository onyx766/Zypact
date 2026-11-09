/**
 * Source categories for domains a provider returned, decided only by exact
 * domain match against a fixed, versioned list. Anything not on the list is
 * `unclassified`: a guess from a word in the URL ("blog", "news") is not
 * evidence of what a site is, so none is made.
 *
 * Changing the list changes what a customer reads, so it bumps
 * SOURCE_TYPE_LIST_VERSION and is reviewed like any other methodology rule.
 */

export const SOURCE_TYPE_LIST_VERSION = "source-types/1";

export type SourceCategory =
  | "owned"
  | "review_platform"
  | "community"
  | "publication"
  | "video"
  | "reference"
  | "unclassified";

const LISTED_DOMAINS: ReadonlyArray<readonly [string, Exclude<SourceCategory, "owned" | "unclassified">]> = [
  ["g2.com", "review_platform"],
  ["capterra.com", "review_platform"],
  ["trustradius.com", "review_platform"],
  ["trustpilot.com", "review_platform"],
  ["getapp.com", "review_platform"],
  ["softwareadvice.com", "review_platform"],
  ["producthunt.com", "review_platform"],
  ["reddit.com", "community"],
  ["news.ycombinator.com", "community"],
  ["quora.com", "community"],
  ["stackoverflow.com", "community"],
  ["stackexchange.com", "community"],
  ["techcrunch.com", "publication"],
  ["forbes.com", "publication"],
  ["wsj.com", "publication"],
  ["nytimes.com", "publication"],
  ["bloomberg.com", "publication"],
  ["wired.com", "publication"],
  ["theverge.com", "publication"],
  ["businessinsider.com", "publication"],
  ["zdnet.com", "publication"],
  ["venturebeat.com", "publication"],
  ["techradar.com", "publication"],
  ["youtube.com", "video"],
  ["wikipedia.org", "reference"],
];

export const SOURCE_CATEGORY_LABEL: Record<SourceCategory, string> = {
  owned: "Your site",
  review_platform: "Review platform",
  community: "Community",
  publication: "Publication",
  video: "Video",
  reference: "Reference",
  unclassified: "Unclassified",
};

/** `domain` is the host itself or one of its subdomains. */
export function domainIsWithin(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith(`.${parent}`);
}

/** A bare lowercase host with any leading `www.` removed; "" when unusable. */
export function bareDomain(value: string): string {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  return host.startsWith("www.") ? host.slice(4) : host;
}

export function categorizeDomain(domain: string, ownedDomain: string): SourceCategory {
  const owned = bareDomain(ownedDomain);
  if (owned && domainIsWithin(domain, owned)) return "owned";
  for (const [listed, category] of LISTED_DOMAINS) {
    if (domainIsWithin(domain, listed)) return category;
  }
  return "unclassified";
}
