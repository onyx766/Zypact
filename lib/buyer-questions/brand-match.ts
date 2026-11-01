/**
 * Brand and product name matching for Buyer Question Intelligence (Q1,
 * provisional v1; plan section 4.4).
 *
 * This is the only file in lib/buyer-questions/ that calls the D-019
 * entity normaliser, and it does so only for entity semantics: the brand
 * and product names from the site context, and the words of a question
 * compared with them. D-019 itself is reused unchanged.
 *
 * Rules:
 *   - A name is kept exactly as entered. Its full forms normalise each
 *     whitespace-separated word on its own, so a single word never loses a
 *     legal suffix (D-019 never strips a suffix that is its whole input).
 *     Full-form and domain matches are definitive.
 *   - D-019 applied to the complete name may strip a trailing legal
 *     suffix ("Acme Inc." -> "acme", "Day Spa" -> "day"). That stripped
 *     alias is lossy, so it counts only when the curator resolved it as
 *     `accept`. Unresolved, a match through it raises
 *     `brand_alias_unresolved` and decides nothing; `reject` ignores it.
 *   - Keys are compared whole, never as substrings.
 */

import {
  NORMALIZER_V1_LEGAL_SUFFIXES,
  normalizeEntityTextV1,
} from "@/lib/evidence/normalize-entity-text";
import { codePointLength, isStopWord, plainWord } from "./normalize";
import type { AliasResolution, Signal, SiteContext, SiteName } from "./types";

const PUNCTUATION_OR_SYMBOL_RUN = /[\p{P}\p{S}]+/u;
const EDGE_PUNCTUATION = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;
const DOMAIN_SHAPE = /^[a-z0-9.-]+\.[a-z]{2,}$/;

const LEGAL_SUFFIX_TOKENS: ReadonlySet<string> = new Set(
  NORMALIZER_V1_LEGAL_SUFFIXES.flatMap((suffix) =>
    suffix.replace(/[\p{P}\p{S}]/gu, "").split(/\s+/).filter((t) => t.length > 0)
  )
);

export type NameRole = "brand" | "product";

export interface NameForms {
  original: string;
  role: NameRole;
  usable: boolean;
  /** Set when D-019 on the complete name yields a domain; then the only form. */
  domain: string | null;
  joined: string[];
  split: string[];
  /** The stripped alias, when D-019 on the complete name removed a suffix. */
  alias: string[] | null;
  aliasResolution: AliasResolution | null;
  ambiguous: boolean;
}

function nonEmpty(values: string[]): string[] {
  return values.filter((v) => v.length > 0);
}

export function buildNameForms(siteName: SiteName, role: NameRole): NameForms {
  const original = siteName.name;
  const aliasResolution = siteName.aliasResolution ?? null;
  const complete = normalizeEntityTextV1(original);
  const words = original.split(/\s+/).filter((w) => w.length > 0);
  const joined = nonEmpty(words.map((w) => normalizeEntityTextV1(w)));
  const split = nonEmpty(
    words.flatMap((w) => w.split(PUNCTUATION_OR_SYMBOL_RUN)).map((p) => normalizeEntityTextV1(p))
  );

  if (complete.length === 0 || joined.length === 0 || joined.every((t) => LEGAL_SUFFIX_TOKENS.has(t))) {
    return { original, role, usable: false, domain: null, joined: [], split: [], alias: null, aliasResolution, ambiguous: false };
  }

  if (DOMAIN_SHAPE.test(complete)) {
    return { original, role, usable: true, domain: complete, joined: [], split: [], alias: null, aliasResolution, ambiguous: false };
  }

  const completeTokens = complete.split(" ").filter((t) => t.length > 0);
  const alias =
    complete !== joined.join(" ") && completeTokens.length > 0 && completeTokens.length < joined.length
      ? completeTokens
      : null;
  const joinedText = joined.join(" ");
  const ambiguous = codePointLength(joinedText) <= 2 || (joined.length === 1 && isStopWord(joined[0]));

  return { original, role, usable: true, domain: null, joined, split, alias, aliasResolution, ambiguous };
}

export interface QuestionWord {
  raw: string;
  trimmed: string;
  wordKey: string;
  partKeys: string[];
}

/** Words split on whitespace only; edge punctuation trimmed; empty words dropped. */
export function tokenizeQuestion(text: string): QuestionWord[] {
  const words: QuestionWord[] = [];
  for (const raw of text.split(/\s+/)) {
    const trimmed = raw.replace(EDGE_PUNCTUATION, "");
    if (trimmed.length === 0) continue;
    words.push({
      raw,
      trimmed,
      wordKey: normalizeEntityTextV1(trimmed),
      partKeys: nonEmpty(trimmed.split(PUNCTUATION_OR_SYMBOL_RUN).map((p) => normalizeEntityTextV1(p))),
    });
  }
  return words;
}

export type MatchVia = "full" | "domain" | "alias_accepted" | "alias_unresolved";

export interface NameMatch {
  name: string;
  role: NameRole;
  via: MatchVia;
  alias?: string;
  /** Word span [start, end); a within-word match spans one word. */
  start: number;
  end: number;
}

function equalSeq(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function spansFor(tokens: readonly string[], words: readonly QuestionWord[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  if (tokens.length === 0) return spans;
  const keys = words.map((w) => w.wordKey);
  for (let i = 0; i + tokens.length <= keys.length; i += 1) {
    if (equalSeq(keys.slice(i, i + tokens.length), tokens)) spans.push([i, i + tokens.length]);
  }
  words.forEach((w, i) => {
    for (let j = 0; j + tokens.length <= w.partKeys.length; j += 1) {
      if (equalSeq(w.partKeys.slice(j, j + tokens.length), tokens)) {
        spans.push([i, i + 1]);
        break;
      }
    }
  });
  return spans;
}

export interface NameMatchResult {
  matches: NameMatch[];
  signals: Signal[];
}

export function siteNameForms(site: SiteContext): NameForms[] {
  return [
    ...site.brandNames.map((n) => buildNameForms(n, "brand")),
    ...site.productNames.map((n) => buildNameForms(n, "product")),
  ];
}

export function findNameMatches(text: string, site: SiteContext): NameMatchResult {
  const words = tokenizeQuestion(text);
  const matches: NameMatch[] = [];
  const signals: Signal[] = [];

  for (const forms of siteNameForms(site)) {
    if (!forms.usable) {
      signals.push({ code: "brand_name_unusable", name: forms.original });
      continue;
    }
    const definitive: Array<[number, number, MatchVia]> = [];
    if (forms.domain !== null) {
      words.forEach((w, i) => {
        if (w.wordKey === forms.domain) definitive.push([i, i + 1, "domain"]);
      });
    } else {
      for (const tokens of [forms.joined, forms.split]) {
        for (const [s, e] of spansFor(tokens, words)) definitive.push([s, e, "full"]);
      }
      if (forms.alias !== null && forms.aliasResolution === "accept") {
        for (const [s, e] of spansFor(forms.alias, words)) definitive.push([s, e, "alias_accepted"]);
      }
    }
    for (const [start, end, via] of definitive) {
      matches.push({ name: forms.original, role: forms.role, via, start, end });
    }
    if (definitive.length > 0 && forms.ambiguous) {
      signals.push({ code: "brand_match_ambiguous", name: forms.original });
    }
    if (forms.alias !== null && forms.aliasResolution == null) {
      const aliasText = forms.alias.join(" ");
      for (const [start, end] of spansFor(forms.alias, words)) {
        const covered = definitive.some(([s, e]) => start >= s && end <= e);
        if (covered) continue;
        matches.push({ name: forms.original, role: forms.role, via: "alias_unresolved", alias: aliasText, start, end });
        signals.push({ code: "brand_alias_unresolved", name: forms.original, alias: aliasText });
      }
    }
  }
  return { matches, signals };
}

export interface BrandPresence {
  brandDefinitive: boolean;
  anyNameDefinitive: boolean;
  brandAliasUnresolved: boolean;
  anyNameAliasUnresolved: boolean;
  matches: NameMatch[];
  signals: Signal[];
}

export function brandPresence(text: string, site: SiteContext): BrandPresence {
  const { matches, signals } = findNameMatches(text, site);
  const definitive = matches.filter((m) => m.via !== "alias_unresolved");
  const unresolved = matches.filter((m) => m.via === "alias_unresolved");
  return {
    brandDefinitive: definitive.some((m) => m.role === "brand"),
    anyNameDefinitive: definitive.length > 0,
    brandAliasUnresolved: unresolved.some((m) => m.role === "brand"),
    anyNameAliasUnresolved: unresolved.length > 0,
    matches,
    signals,
  };
}

/**
 * Exact-duplicate key (provisional v1): definitive brand and product
 * matches become `{brand}` (longest match first); every other word is
 * NFC, lowercased, with punctuation and symbols removed.
 */
export function duplicateKey(text: string, site: SiteContext): string {
  const words = tokenizeQuestion(text);
  const definitive = findNameMatches(text, site).matches.filter((m) => m.via !== "alias_unresolved");
  const tokens: string[] = [];
  let i = 0;
  while (i < words.length) {
    const starting = definitive.filter((m) => m.start === i);
    if (starting.length > 0) {
      tokens.push("{brand}");
      i = Math.max(...starting.map((m) => m.end));
      continue;
    }
    const plain = plainWord(words[i].raw);
    if (plain.length > 0) tokens.push(plain);
    i += 1;
  }
  return tokens.join(" ");
}
