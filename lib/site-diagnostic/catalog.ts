/**
 * The W1 check catalogue, rule set "w1-2026.11".
 *
 * PROPOSED VOCABULARY, NOT APPROVED. The database registry
 * (`_q2p2_finding_detail_spec`) ships empty and stays empty until the founder,
 * with independent review, approves each (check_id, rule_version) and its
 * fields (D-043). Until then every finding is persisted with detail = NULL;
 * the specs below exist so that approval needs no remapping, and
 * scripts/test-w1-contract.ts proves every spec is well formed, fits the
 * 4,096-byte cap in the worst case, and validates every detail the engine
 * emits.
 *
 * Naming avoids the Level-2 probe pairs ('html.title', 'html.meta',
 * 'robots.txt' x 'r1' | 'r2' | 'v1') that QR2-19 asserts are unregistered.
 *
 * Text rules (D-040, SELF_SERVICE_PRODUCT.md §6.1/§6.3, METHODOLOGY §19):
 * every check states what it does NOT establish; no composite score; no claim
 * about AI readability, visibility, rankings or answers; no causal promise in
 * fix text. `priority` orders the fix list only. It is never summed,
 * averaged or shown as a grade. All of this text is subject to the D11
 * claim-language review before any customer sees it.
 *
 * Pure module.
 */
import { UNKNOWN_REASONS, type DetailSpec, type UnknownReason } from "@/lib/site-diagnostic/contract";
import { BUYER_CATEGORIES, type BuyerCategory } from "@/lib/site-diagnostic/types";

export const W1_RULE_SET_VERSION = "w1-2026.11";
/** Per-check rule version. A change to one check's logic bumps its own. */
export const W1_CHECK_RULE_VERSION = "w1.1";

export const CHECK_AREAS = [
  "crawl_access",
  "indexing",
  "page_basics",
  "structured_data",
  "entity",
  "buyer_pages",
  "seller_wording",
] as const;
export type CheckArea = (typeof CHECK_AREAS)[number];

export const AREA_LABELS: Readonly<Record<CheckArea, string>> = {
  crawl_access: "Crawl access",
  indexing: "Indexing directives",
  page_basics: "Page basics",
  structured_data: "Structured data",
  entity: "Brand and entity",
  buyer_pages: "Buyer-relevant pages",
  seller_wording: "Your own wording",
};

export type Priority = "high" | "medium" | "low";

export interface CheckDefinition {
  checkId: string;
  ruleVersion: string;
  area: CheckArea;
  scope: "run" | "page";
  title: string;
  establishes: string;
  doesNotEstablish: string;
  /** Orders the fix list for `issue` findings. Never aggregated. */
  priority: Priority;
  /** Shown for `issue`, and for `info` where a change may help. */
  fix: { issue?: string; info?: string };
  detailSpec: DetailSpec;
  /** Unknown reasons this check may report; anything else is a bug. */
  unknownReasons: readonly UnknownReason[];
}

/** robots.txt tokens the robots check reports on (lowercase identifier → product token). */
export const NAMED_CRAWLERS: ReadonlyArray<{ id: string; token: string }> = [
  { id: "gptbot", token: "GPTBot" },
  { id: "oai_searchbot", token: "OAI-SearchBot" },
  { id: "chatgpt_user", token: "ChatGPT-User" },
  { id: "claudebot", token: "ClaudeBot" },
  { id: "claude_searchbot", token: "Claude-SearchBot" },
  { id: "claude_user", token: "Claude-User" },
  { id: "perplexitybot", token: "PerplexityBot" },
  { id: "perplexity_user", token: "Perplexity-User" },
  { id: "google_extended", token: "Google-Extended" },
  { id: "googlebot", token: "Googlebot" },
  { id: "bingbot", token: "Bingbot" },
  { id: "applebot", token: "Applebot" },
  { id: "applebot_extended", token: "Applebot-Extended" },
  { id: "ccbot", token: "CCBot" },
  { id: "meta_externalagent", token: "meta-externalagent" },
  { id: "amazonbot", token: "Amazonbot" },
];

/** JSON-LD types reported by name; anything else is "other". */
export const JSON_LD_TYPE_TOKENS: ReadonlyArray<{ id: string; type: string }> = [
  { id: "organization", type: "organization" },
  { id: "corporation", type: "corporation" },
  { id: "website", type: "website" },
  { id: "web_page", type: "webpage" },
  { id: "product", type: "product" },
  { id: "software_application", type: "softwareapplication" },
  { id: "offer", type: "offer" },
  { id: "faq_page", type: "faqpage" },
  { id: "breadcrumb_list", type: "breadcrumblist" },
  { id: "article", type: "article" },
  { id: "blog_posting", type: "blogposting" },
  { id: "how_to", type: "howto" },
  { id: "review", type: "review" },
  { id: "aggregate_rating", type: "aggregaterating" },
  { id: "local_business", type: "localbusiness" },
  { id: "other", type: "" },
];

const PAGE_UNKNOWNS: readonly UnknownReason[] = [
  "fetch_failed",
  "timeout",
  "size_cap",
  "parse_error",
  "blocked_by_robots",
  "robots_unavailable",
  "not_html",
];

/** Run-level checks can be cut short by any bound, so any of the nine. */
const RUN_UNKNOWNS: readonly UnknownReason[] = UNKNOWN_REASONS;

const BUYER_UNKNOWNS: readonly UnknownReason[] = [
  "fetch_failed",
  "timeout",
  "size_cap",
  "parse_error",
  "blocked_by_robots",
  "robots_unavailable",
  "not_html",
  "page_cap_reached",
];

const flag = { type: "boolean" } as const;

const BUYER_LABELS: Readonly<Record<BuyerCategory, { title: string; noun: string; fix: string }>> = {
  product: {
    title: "Product page",
    noun: "a product or features page",
    fix: "If you have a product or features page, link to it from the homepage navigation so it can be reached in one step.",
  },
  pricing: {
    title: "Pricing page",
    noun: "a pricing page",
    fix: "If you publish pricing, link the pricing page from the homepage navigation. If you do not, a page explaining how pricing works answers the same buyer question.",
  },
  integrations: {
    title: "Integrations page",
    noun: "an integrations page",
    fix: "If you integrate with other tools, a page listing them, linked from the homepage, makes that information reachable.",
  },
  security: {
    title: "Security page",
    noun: "a security or trust page",
    fix: "A security or trust page covering certifications, data handling and contacts, linked from the footer, makes that information reachable.",
  },
  comparison: {
    title: "Comparison page",
    noun: "a comparison or alternatives page",
    fix: "If buyers compare you with other options, a factual comparison page states your own position in your own words.",
  },
  docs: {
    title: "Documentation",
    noun: "documentation on this site",
    fix: "If your documentation lives on another subdomain, this crawl does not reach it; link it from the homepage. If you have none, consider publishing setup or API documentation.",
  },
  faq: {
    title: "FAQ page",
    noun: "an FAQ page",
    fix: "An FAQ page answering common pre-purchase questions, linked from the homepage, makes those answers reachable.",
  },
  customer_stories: {
    title: "Customer stories",
    noun: "customer stories or case studies",
    fix: "If you have customer stories you are permitted to publish, a page collecting them, linked from the homepage, makes them reachable.",
  },
};

function buyerCheck(category: BuyerCategory): CheckDefinition {
  const label = BUYER_LABELS[category];
  return {
    checkId: `buyer_page.${category}`,
    ruleVersion: W1_CHECK_RULE_VERSION,
    area: "buyer_pages",
    scope: "run",
    title: label.title,
    establishes: `Whether ${label.noun} was found among the pages this crawl fetched (at most 10, on this host and its www/apex alternate).`,
    doesNotEstablish:
      "That such a page is absent from the site. Pages beyond the 10-page cap, on other subdomains, or reachable only through scripts are not seen.",
    priority: category === "pricing" || category === "product" ? "medium" : "low",
    fix: { info: label.fix },
    detailSpec: { keys: { link_discovered: flag, fetched: flag } },
    unknownReasons: BUYER_UNKNOWNS,
  };
}

export const W1_CATALOG: readonly CheckDefinition[] = [
  /* ------------------------------------------------------- run level */
  {
    checkId: "robots.agents",
    ruleVersion: W1_CHECK_RULE_VERSION,
    area: "crawl_access",
    scope: "run",
    title: "robots.txt rules for named crawlers",
    establishes:
      "What this site's robots.txt says about the homepage for each listed crawler user-agent token, read under RFC 9309.",
    doesNotEstablish:
      "That any crawler visits the site, follows the file, or uses the content it fetches.",
    priority: "medium",
    fix: {
      issue:
        "Review the Disallow rules for the listed tokens. If you want those crawlers to fetch your homepage, remove or narrow the rule; if the block is intended, no change is needed.",
    },
    detailSpec: {
      keys: {
        file_status: { type: "enum", values: ["parsed", "not_found"] },
        blocked_agents: { type: "enum_list", values: NAMED_CRAWLERS.map((c) => c.id), max_items: 16 },
        blocked_count: { type: "count", max: 16 },
        zypactbot_allowed: flag,
      },
    },
    unknownReasons: ["robots_unavailable", "timeout", "fetch_failed"],
  },
  {
    checkId: "site.sitemap",
    ruleVersion: W1_CHECK_RULE_VERSION,
    area: "crawl_access",
    scope: "run",
    title: "XML sitemap",
    establishes:
      "Whether a sitemap was returned at the robots.txt Sitemap: location or /sitemap.xml, whether it parsed, and how many URLs it lists.",
    doesNotEstablish:
      "That any system reads the sitemap, or that the listed URLs are complete or current. Sitemap index files are not followed in this version.",
    priority: "low",
    fix: {
      issue: "The sitemap did not parse as a urlset or sitemap index. Validate it against the sitemaps.org schema.",
      info: "Publishing a sitemap at /sitemap.xml, or naming one in robots.txt, lists your pages in a standard form.",
    },
    detailSpec: {
      keys: {
        format: { type: "enum", values: ["urlset", "sitemapindex", "invalid", "not_found"] },
        url_count: { type: "count", max: 10_000 },
        same_site_url_count: { type: "count", max: 10_000 },
        source: { type: "enum", values: ["robots_directive", "default_path"] },
      },
    },
    unknownReasons: RUN_UNKNOWNS,
  },
  {
    checkId: "site.llms_txt",
    ruleVersion: W1_CHECK_RULE_VERSION,
    area: "crawl_access",
    scope: "run",
    title: "llms.txt file",
    establishes: "Whether /llms.txt returned a text file, and whether it starts with a Markdown heading.",
    doesNotEstablish:
      "That any AI system reads or uses llms.txt. It is an informal proposal, not a standard, so its absence is not a problem.",
    priority: "low",
    fix: {},
    detailSpec: { keys: { present: flag, starts_with_heading: flag } },
    unknownReasons: RUN_UNKNOWNS,
  },
  {
    checkId: "site.organization_markup",
    ruleVersion: W1_CHECK_RULE_VERSION,
    area: "structured_data",
    scope: "run",
    title: "Organization markup on the homepage",
    establishes:
      "Whether the homepage HTML contains JSON-LD describing an Organization, and which of name, url, logo and sameAs it includes.",
    doesNotEstablish: "That any search or AI system reads the markup or uses it to describe the company.",
    priority: "low",
    fix: {
      info: "Add JSON-LD of type Organization to the homepage with your name, url, logo and sameAs links to your official profiles.",
    },
    detailSpec: {
      keys: {
        org_present: flag,
        has_name: flag,
        has_url: flag,
        has_logo: flag,
        same_as_count: { type: "count", max: 50 },
      },
    },
    unknownReasons: RUN_UNKNOWNS,
  },
  {
    checkId: "site.entity_consistency",
    ruleVersion: W1_CHECK_RULE_VERSION,
    area: "entity",
    scope: "run",
    title: "Brand name consistency",
    establishes:
      "Whether the brand name agrees across the homepage title, og:site_name, JSON-LD name and footer copyright line, where present.",
    doesNotEstablish: "How any search or AI system resolves the company as an entity.",
    priority: "medium",
    fix: {
      issue:
        "Use one form of the company name in the homepage title, og:site_name, the Organization markup and the footer copyright line.",
      info: "Fewer than two brand signals were found to compare. An og:site_name tag and Organization markup add two.",
    },
    detailSpec: {
      keys: {
        sources_present: { type: "enum_list", values: ["title", "og_site_name", "json_ld_name", "footer"], max_items: 4 },
        consistency: { type: "enum", values: ["consistent", "inconsistent", "insufficient"] },
      },
    },
    unknownReasons: RUN_UNKNOWNS,
  },
  {
    checkId: "site.duplicate_titles",
    ruleVersion: W1_CHECK_RULE_VERSION,
    area: "page_basics",
    scope: "run",
    title: "Distinct page titles",
    establishes: "Whether two or more of the fetched pages share an identical title.",
    doesNotEstablish: "Anything about pages this crawl did not fetch.",
    priority: "low",
    fix: { info: "Give each page a title that names what that page is about." },
    detailSpec: {
      keys: {
        pages_compared: { type: "count", max: 10 },
        pages_with_shared_title: { type: "count", max: 10 },
      },
    },
    unknownReasons: RUN_UNKNOWNS,
  },
  {
    checkId: "site.seller_wording",
    ruleVersion: W1_CHECK_RULE_VERSION,
    area: "seller_wording",
    scope: "run",
    title: "Your homepage's marketing phrases",
    establishes:
      "How many phrases from Zypact's marketing-language list (MARKETING_LEXICON_V1) appear in the homepage text. This is your own wording, kept as context for buyer-question review.",
    doesNotEstablish: "How buyers word their questions. A seller's own copy is never evidence of buyer wording.",
    priority: "low",
    fix: {},
    detailSpec: { keys: { lexicon_phrase_count: { type: "count", max: 1_000 } } },
    unknownReasons: RUN_UNKNOWNS,
  },
  ...BUYER_CATEGORIES.map(buyerCheck),

  /* ------------------------------------------------------ page level */
  {
    checkId: "page.http_status",
    ruleVersion: W1_CHECK_RULE_VERSION,
    area: "crawl_access",
    scope: "page",
    title: "HTTP status",
    establishes: "The HTTP status this page returned to Zypact's request.",
    doesNotEstablish: "The status other clients receive, or that the page is broken for every visitor.",
    priority: "high",
    fix: { issue: "A linked page returned an error status. Fix the page or update the link that points to it." },
    detailSpec: {
      keys: { status_class: { type: "enum", values: ["success", "redirect", "client_error", "server_error"] } },
    },
    unknownReasons: PAGE_UNKNOWNS,
  },
  {
    checkId: "page.noindex",
    ruleVersion: W1_CHECK_RULE_VERSION,
    area: "indexing",
    scope: "page",
    title: "noindex directives",
    establishes:
      "Whether the fetched page carries a noindex or none directive in a robots meta tag or the X-Robots-Tag header.",
    doesNotEstablish: "Whether any system indexes or excludes the page.",
    priority: "high",
    fix: {
      issue: "This page asks not to be indexed. If that is not intended, remove noindex from the robots meta tag and the X-Robots-Tag header.",
      info: "A noindex directive applies to a specific crawler only. Check that this is intended.",
    },
    detailSpec: { keys: { meta_noindex: flag, header_noindex: flag, scoped_noindex: flag, nofollow: flag } },
    unknownReasons: PAGE_UNKNOWNS,
  },
  {
    checkId: "page.server_text",
    ruleVersion: W1_CHECK_RULE_VERSION,
    area: "page_basics",
    scope: "page",
    title: "Text in the server response",
    establishes: "How many words of text the HTML Zypact received contained, without running any script.",
    doesNotEstablish: "What a script-executing browser, crawler or AI system reads on the page.",
    priority: "high",
    fix: {
      issue:
        "The HTML returned by the server contained no text; the content may depend on JavaScript, which this check does not run. Rendering the main content on the server makes it present in the response.",
      info: "Little text was present in the server response.",
    },
    detailSpec: { keys: { word_count: { type: "count", max: 10_000 } } },
    unknownReasons: PAGE_UNKNOWNS,
  },
  {
    checkId: "page.title",
    ruleVersion: W1_CHECK_RULE_VERSION,
    area: "page_basics",
    scope: "page",
    title: "Title element",
    establishes: "Whether the fetched HTML has exactly one non-empty <title>.",
    doesNotEstablish: "How any search or AI system displays or ranks the page.",
    priority: "medium",
    fix: {
      issue: "Add a <title> element that names the page and the company.",
      info: "The page has more than one <title> element; keep one.",
    },
    detailSpec: { keys: { title_count: { type: "count", max: 50 }, empty: flag } },
    unknownReasons: PAGE_UNKNOWNS,
  },
  {
    checkId: "page.meta_description",
    ruleVersion: W1_CHECK_RULE_VERSION,
    area: "page_basics",
    scope: "page",
    title: "Meta description",
    establishes: "Whether the fetched HTML has exactly one non-empty meta description.",
    doesNotEstablish: "How any search or AI system summarises the page.",
    priority: "low",
    fix: {
      issue: "Add a meta description that summarises the page in a sentence or two.",
      info: "The page has more than one meta description; keep one.",
    },
    detailSpec: { keys: { description_count: { type: "count", max: 50 }, empty: flag } },
    unknownReasons: PAGE_UNKNOWNS,
  },
  {
    checkId: "page.h1",
    ruleVersion: W1_CHECK_RULE_VERSION,
    area: "page_basics",
    scope: "page",
    title: "H1 heading",
    establishes: "Whether the fetched HTML has exactly one non-empty <h1>.",
    doesNotEstablish: "How the page reads to any system, or how it ranks.",
    priority: "medium",
    fix: {
      issue: "Add one <h1> that states what the page is about.",
      info: "The page has more than one <h1>. One main heading makes the page's subject unambiguous.",
    },
    detailSpec: { keys: { h1_count: { type: "count", max: 50 }, empty: flag } },
    unknownReasons: PAGE_UNKNOWNS,
  },
  {
    checkId: "page.canonical",
    ruleVersion: W1_CHECK_RULE_VERSION,
    area: "indexing",
    scope: "page",
    title: "Canonical link",
    establishes: "Whether the fetched HTML declares a canonical URL, and where it points.",
    doesNotEstablish: "Which URL any search or AI system treats as canonical.",
    priority: "medium",
    fix: {
      issue: "Keep a single, valid absolute canonical link per page.",
      info: "Check that the canonical link points where you intend; a page usually names itself.",
    },
    detailSpec: {
      keys: {
        canonical_status: {
          type: "enum",
          values: ["self", "missing", "other_same_site", "off_site", "conflicting", "invalid"],
        },
        canonical_count: { type: "count", max: 50 },
      },
    },
    unknownReasons: PAGE_UNKNOWNS,
  },
  {
    checkId: "page.json_ld",
    ruleVersion: W1_CHECK_RULE_VERSION,
    area: "structured_data",
    scope: "page",
    title: "JSON-LD blocks",
    establishes: "Whether the fetched HTML contains JSON-LD, whether each block parses, and which types it declares.",
    doesNotEstablish: "That any system reads the markup or that it is complete or accurate.",
    priority: "medium",
    fix: {
      issue: "A JSON-LD block did not parse as JSON. Fix the syntax; a validator such as validator.schema.org shows the error.",
    },
    detailSpec: {
      keys: {
        block_count: { type: "count", max: 50 },
        invalid_block_count: { type: "count", max: 50 },
        types: { type: "enum_list", values: JSON_LD_TYPE_TOKENS.map((t) => t.id), max_items: 16 },
      },
    },
    unknownReasons: PAGE_UNKNOWNS,
  },
];

const BY_ID = new Map(W1_CATALOG.map((check) => [check.checkId, check]));

export function checkDefinition(checkId: string): CheckDefinition {
  const found = BY_ID.get(checkId);
  if (!found) throw new Error(`unknown W1 check: ${checkId}`);
  return found;
}

export const PAGE_CHECK_IDS = W1_CATALOG.filter((c) => c.scope === "page").map((c) => c.checkId);
export const RUN_CHECK_IDS = W1_CATALOG.filter((c) => c.scope === "run").map((c) => c.checkId);
