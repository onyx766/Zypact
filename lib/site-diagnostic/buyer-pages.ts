/**
 * Buyer-relevant page classification (rule set w1, version 1).
 *
 * Deterministic and URL-based: a page's category comes from its path
 * segments, a link's priority from its path and its anchor text. Content is
 * not read here except for one signal the checks add (JSON-LD FAQPage).
 *
 * The categories are the eight in docs/SELF_SERVICE_PRODUCT.md §6.3 check 7.
 * A category not found within the 10-page cap is never reported as absent.
 *
 * Pure module.
 */
import { BUYER_CATEGORIES, type BuyerCategory } from "@/lib/site-diagnostic/types";

/** Exact path segments per category, lowercase. First listed category wins a tie. */
const SEGMENTS: Readonly<Record<BuyerCategory, readonly string[]>> = {
  pricing: ["pricing", "prices", "price", "plans", "plan", "plans-and-pricing", "pricing-plans"],
  product: ["product", "products", "features", "feature", "platform", "capabilities", "tour", "overview", "how-it-works"],
  integrations: ["integrations", "integration", "apps", "app-marketplace", "marketplace", "connectors", "connector", "extensions", "plugins"],
  security: ["security", "trust", "trust-center", "trustcenter", "compliance", "soc2", "soc-2", "gdpr", "iso-27001"],
  comparison: ["compare", "comparison", "comparisons", "vs", "versus", "alternatives", "alternative"],
  docs: ["docs", "doc", "documentation", "developers", "developer", "api", "api-docs", "reference", "guides", "knowledge-base", "kb", "manual"],
  faq: ["faq", "faqs", "frequently-asked-questions", "questions", "help"],
  customer_stories: ["customers", "customer-stories", "case-studies", "case-study", "success-stories", "stories", "testimonials", "clients"],
};

/** Order used to break ties and to prioritise discovery. */
export const CATEGORY_ORDER: readonly BuyerCategory[] = [
  "pricing",
  "product",
  "integrations",
  "security",
  "comparison",
  "docs",
  "faq",
  "customer_stories",
];

/** Anchor-text cues for prioritising links (English, whole words). */
const ANCHOR_CUES: Readonly<Record<BuyerCategory, RegExp>> = {
  pricing: /\b(pricing|prices|plans)\b/i,
  product: /\b(product|features|platform|how it works)\b/i,
  integrations: /\b(integrations?|apps|marketplace|connectors)\b/i,
  security: /\b(security|trust( center)?|compliance)\b/i,
  comparison: /\b(compare|comparison|vs\.?|alternatives?)\b/i,
  docs: /\b(docs|documentation|developers?|api)\b/i,
  faq: /\b(faqs?|frequently asked questions)\b/i,
  customer_stories: /\b(customers|customer stories|case stud(y|ies)|success stories)\b/i,
};

/** `/en/`, `/en-us/`, `/de-DE/` style locale prefixes are skipped. */
const LOCALE_SEGMENT = /^[a-z]{2}([-_][a-z]{2,4})?$/i;

function segmentsOf(pathname: string): string[] {
  const segments = pathname
    .toLowerCase()
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  if (segments.length > 1 && LOCALE_SEGMENT.test(segments[0]) && !Object.values(SEGMENTS).some((list) => list.includes(segments[0]))) {
    return segments.slice(1);
  }
  return segments;
}

/** Category from a URL path, or null. The homepage has none. */
export function categoryFromPath(pathname: string): BuyerCategory | null {
  const segments = segmentsOf(pathname);
  for (const segment of segments) {
    for (const category of CATEGORY_ORDER) {
      if (SEGMENTS[category].includes(segment)) return category;
    }
    // "acme-vs-rival", "rival-alternative(s)" comparison slugs.
    if (/(^|-)vs(-|$)/.test(segment) || /-alternatives?$/.test(segment)) return "comparison";
  }
  return null;
}

/** Category cue from anchor text, or null. */
export function categoryFromAnchor(text: string): BuyerCategory | null {
  const value = text.trim().slice(0, 120);
  if (value === "") return null;
  for (const category of CATEGORY_ORDER) {
    if (ANCHOR_CUES[category].test(value)) return category;
  }
  return null;
}

export function isBuyerCategory(value: string): value is BuyerCategory {
  return (BUYER_CATEGORIES as readonly string[]).includes(value);
}
