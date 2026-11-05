/**
 * The Q2′-2 database contract for W1, mirrored in TypeScript.
 *
 * Source of truth: supabase/migrations/20261103173000_q2p2_domains_and_site_diagnostics.sql
 * (merged in #102, not applied to any hosted database). Every regex, enum and
 * cap below is copied from that file by hand; scripts/test-w1-contract.ts
 * reads the migration text and fails if they drift.
 *
 * Nothing here talks to a database. The engine uses these to make sure that
 * what it produces could be stored later (W1-D) without remapping, and that
 * it never produces a value the database would refuse.
 *
 * Pure module.
 */

export const FINDING_STATES = ["pass", "issue", "info", "unknown"] as const;
export type FindingState = (typeof FINDING_STATES)[number];

/** D-040 §6.3, exactly nine. */
export const UNKNOWN_REASONS = [
  "fetch_failed",
  "timeout",
  "size_cap",
  "parse_error",
  "blocked_by_robots",
  "robots_unavailable",
  "not_html",
  "page_cap_reached",
  "not_applicable",
] as const;
export type UnknownReason = (typeof UNKNOWN_REASONS)[number];

/** site_diagnostic_pages.fetch_error. No parse_error / cap / n/a here. */
export const PAGE_FETCH_ERRORS = [
  "fetch_failed",
  "timeout",
  "size_cap",
  "not_html",
  "blocked_by_robots",
  "robots_unavailable",
] as const;
export type PageFetchError = (typeof PAGE_FETCH_ERRORS)[number];

export const RUN_OUTCOMES = ["completed", "failed", "robots_unavailable", "cancelled"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** runs.page_cap between 1 and 10; pages.page_index between 0 and 9. */
export const PAGE_CAP_MAX = 10;
/** findings.excerpt length between 1 and 300, counted in code points. */
export const EXCERPT_MAX_CODE_POINTS = 300;
/** runs.user_agent length <= 300. */
export const USER_AGENT_MAX = 300;
/** pages.content_type length <= 200. */
export const CONTENT_TYPE_MAX = 200;
/** _q2p2_url_is_sanitised: length <= 2048. */
export const URL_MAX = 2048;

export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
export const CHECK_ID_RE = /^[a-z][a-z0-9_.]{2,63}$/;
export const DETAIL_TOKEN_RE = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * `^https?://[a-z0-9.-]+(:[0-9]{1,5})?(/[^?#@[:space:]]*)?$`. JS `\s` is a
 * superset of POSIX [:space:], so this mirror is stricter, which is safe.
 */
export const SANITISED_URL_RE = /^https?:\/\/[a-z0-9.-]+(:[0-9]{1,5})?(\/[^?#@\s]*)?$/;

const DOMAIN_SHAPE_RE =
  /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9]([a-z0-9-]{0,57}[a-z0-9])?)$/;
const DOMAIN_BAD_HYPHENS_RE = /(^|\.)(?!xn--)[a-z0-9]{2}--/;

export function codePointLength(text: string): number {
  return Array.from(text).length;
}

export function isSanitisedUrl(url: string): boolean {
  return codePointLength(url) <= URL_MAX && SANITISED_URL_RE.test(url);
}

export function isNormalisedDomain(domain: string): boolean {
  return (
    domain.length >= 4 &&
    domain.length <= 253 &&
    DOMAIN_SHAPE_RE.test(domain) &&
    !DOMAIN_BAD_HYPHENS_RE.test(domain)
  );
}

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX_RE.test(value);
}

/* ----------------------------------------------- Per-check detail specs */

/** `_q2p2_detail_matches_spec` field grammar (D-043). */
export type DetailField =
  | { type: "boolean" }
  | { type: "count"; max: number }
  | { type: "ratio" }
  | { type: "enum"; values: readonly string[] }
  | { type: "enum_list"; values: readonly string[]; max_items: number };

export interface DetailSpec {
  keys: Readonly<Record<string, DetailField>>;
}

export type DetailValue = boolean | number | string | readonly string[];
export type Detail = Readonly<Record<string, DetailValue>>;

/** Number of decimal places as written, like PostgreSQL numeric scale. */
function scaleOf(value: number): number {
  const text = String(value);
  if (/e/i.test(text)) return Number.POSITIVE_INFINITY;
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

function fieldIsWellFormed(field: DetailField): boolean {
  switch (field.type) {
    case "boolean":
    case "ratio":
      return true;
    case "count":
      return Number.isInteger(field.max) && field.max >= 1 && field.max <= 10_000;
    case "enum":
    case "enum_list": {
      const ok =
        Array.isArray(field.values) &&
        field.values.length >= 1 &&
        field.values.length <= 64 &&
        field.values.every((token) => typeof token === "string" && DETAIL_TOKEN_RE.test(token));
      if (!ok) return false;
      if (field.type === "enum_list") {
        return Number.isInteger(field.max_items) && field.max_items >= 1 && field.max_items <= 16;
      }
      return true;
    }
    default:
      return false;
  }
}

/** Every field of a spec is well formed (SQL checks fields lazily; we don't). */
export function specIsWellFormed(spec: DetailSpec): boolean {
  const keys = Object.keys(spec.keys);
  return (
    keys.length >= 1 &&
    keys.length <= 16 &&
    keys.every((key) => DETAIL_TOKEN_RE.test(key) && fieldIsWellFormed(spec.keys[key]))
  );
}

/** Faithful port of `_q2p2_detail_matches_spec(spec, detail)`. */
export function detailMatchesSpec(spec: DetailSpec | null, detail: unknown): boolean {
  if (spec === null || typeof spec !== "object" || typeof spec.keys !== "object") return false;
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return false;
  const entries = Object.entries(detail as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 16) return false;

  for (const [key, value] of entries) {
    if (!DETAIL_TOKEN_RE.test(key)) return false;
    const field = (spec.keys as Record<string, DetailField | undefined>)[key];
    if (!field || typeof field !== "object" || Array.isArray(field)) return false;
    if (!fieldIsWellFormed(field)) return false;
    switch (field.type) {
      case "boolean":
        if (typeof value !== "boolean") return false;
        break;
      case "count":
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > field.max) {
          return false;
        }
        break;
      case "ratio":
        if (typeof value !== "number" || value < 0 || value > 1 || scaleOf(value) > 4) return false;
        break;
      case "enum":
        if (typeof value !== "string" || !field.values.includes(value)) return false;
        break;
      case "enum_list":
        if (
          !Array.isArray(value) ||
          value.length > field.max_items ||
          !value.every((item) => typeof item === "string" && field.values.includes(item))
        ) {
          return false;
        }
        break;
      default:
        return false;
    }
  }
  return true;
}

/**
 * Upper bound on `pg_column_size(detail)` for the worst detail a spec
 * allows. Conservative over-estimate of jsonb's binary layout: a 4-byte
 * varlena header, a 4-byte container header, 8 bytes of entries per pair
 * (4 per array element), key and string bytes, and 16 bytes plus 3 of
 * alignment per numeric. A spec whose bound is <= 4096 can never produce a
 * detail the CHECK refuses on size; a larger bound needs a narrower spec.
 */
export function worstCaseDetailBytes(spec: DetailSpec): number {
  let total = 4 + 4;
  for (const [key, field] of Object.entries(spec.keys)) {
    total += 8 + new TextEncoder().encode(key).length;
    switch (field.type) {
      case "boolean":
        total += 0;
        break;
      case "count":
      case "ratio":
        total += 16 + 3;
        break;
      case "enum":
        total += Math.max(...field.values.map((token) => token.length)) + 3;
        break;
      case "enum_list":
        total +=
          4 + 3 +
          field.max_items * (4 + Math.max(...field.values.map((token) => token.length)));
        break;
    }
  }
  return total;
}
