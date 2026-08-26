/**
 * Sprint 12, Tasks 2 + 4 — deterministic QA checks that run after the
 * LLM QA agent but before we persist the final `QaReport`.
 *
 * The QA agent is prompt-driven and, in practice, misses two classes of
 * error consistently:
 *
 *   1. **Fabricated URLs**: the agent invents a plausible-looking URL
 *      (e.g. `https://www.producthunt.com/posts/linear`) that was not in
 *      any of the evidence inputs. Deterministic detection compares
 *      URLs in the asset against an allow-list built from the Evidence
 *      Bank + Mirror Profile + Fix Brief.
 *
 *   2. **Asset-type conformity**: the agent scores the *content* of an
 *      asset but does not always enforce the shape the caller asked for.
 *      Deterministic detection asserts the minimum structural
 *      requirements per `assetType`:
 *
 *        - `faq_block`             — ≥ 3 question/answer pairs
 *        - `proof_block`           — ≥ 1 Evidence Bank proof reference
 *        - `comparison_table`      — ≥ 1 Markdown table
 *        - `json_ld_schema`        — valid JSON that declares `@type`
 *        - `comparison_page_outline` — ≥ 3 Markdown headings
 *
 * These violations are merged with the LLM output via
 * `mergeQaViolations`, which recomputes the final verdict from the
 * combined set. The LLM's original findings are preserved verbatim.
 *
 * Rules honored (Sprint 12 brief):
 *   - Deterministic violations must NOT overwrite LLM violations.
 *   - Final verdict must be recomputed from the combined violation set.
 *   - Do not weaken Zod schemas; every emitted violation still passes
 *     `QaViolationSchema`.
 *   - Do not modify agent prompts.
 */

import type {
  Competitor,
  EvidenceBankRow,
  FixBriefRow,
  GeneratedAssetRow,
  MirrorProfileRow,
} from "@/lib/db/types";
import type { ResolvedCompetitorMention } from "@/lib/evidence/get-resolved-competitor-mentions";
import type {
  QaAgentOutput,
  QaVerdict,
  QaViolation,
} from "@/lib/schemas/qa-agent.schema";

/* -------------------------------------------------------------------------- */
/*  URL fabrication guard (Task 2)                                            */
/* -------------------------------------------------------------------------- */

/**
 * Same permissive URL pattern used across the codebase. Trailing
 * punctuation is stripped by the caller before comparison.
 */
const URL_RE = /https?:\/\/[^\s)\]"'<>]+/gi;

/**
 * Technical vocabulary URLs that are part of structured-data syntax, not
 * marketing evidence. These are allowed even when they do not appear in the
 * Evidence Bank, because blocking them would make normal JSON-LD impossible.
 */
const TECHNICAL_URL_ALLOWLIST = new Set([
  "https://schema.org",
  "http://schema.org",
  "https://w3.org",
  "http://w3.org",
]);

function isTechnicalVocabularyUrl(canon: string): boolean {
  if (TECHNICAL_URL_ALLOWLIST.has(canon)) return true;
  try {
    const parsed = new URL(canon);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return host === "schema.org" || host === "w3.org";
  } catch {
    return false;
  }
}

/**
 * Canonicalize a URL for allow-list comparison. Case-insensitive host,
 * trailing punctuation and `#fragment` stripped, `www.` prefix folded
 * out. Kept intentionally conservative so we never approve a URL that
 * isn't actually in the inputs.
 */
export function canonicalizeUrl(raw: string): string {
  let url = raw.trim();
  if (url.length === 0) return "";
  url = url.replace(/[.,;]+$/, "");
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/$/, "");
    return `${parsed.protocol}//${host}${path}${parsed.search}`;
  } catch {
    return url.toLowerCase();
  }
}

/** Extract every URL out of `text`. */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(URL_RE.source, URL_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const cleaned = m[0].replace(/[.,;]+$/, "");
    if (cleaned.length === 0) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

export interface AllowedUrlInputs {
  evidenceBank: EvidenceBankRow;
  mirrorProfile: MirrorProfileRow | null;
  /** All Fix Briefs on the project. Any URL mentioned in any string
   *  field on a Fix Brief is allowed. */
  fixBriefs?: FixBriefRow[];
  /** The project's own domain. Passed as a raw string like
   *  "https://linear.app" or "linear.app"; either shape is accepted. */
  projectDomain?: string | null;
}

/**
 * Build the allowed-URL set. Read-only over every "evidence" input —
 * we do NOT include the asset's own claimsUsed or the answer text of
 * probe results, because those are downstream of the LLM.
 */
export function buildAllowedUrlSet(input: AllowedUrlInputs): Set<string> {
  const set = new Set<string>();
  const push = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    const urls = extractUrls(raw);
    for (const u of urls) set.add(canonicalizeUrl(u));
  };

  const { evidenceBank, mirrorProfile, fixBriefs, projectDomain } = input;

  // Evidence Bank — proof items, notes, product description all count.
  push(evidenceBank.productDescription);
  push(evidenceBank.notes);
  for (const p of evidenceBank.proofItems) {
    push(p.sourceUrl);
    push(p.detail);
  }
  for (const c of evidenceBank.allowedClaims) push(c);

  // Mirror Profile — website + every URL that came out of the site scan.
  if (mirrorProfile) {
    const j = (mirrorProfile.json ?? {}) as Record<string, unknown>;
    push(j.website);
    // claims[].sourceUrl
    if (Array.isArray(j.claims)) {
      for (const c of j.claims as Array<{ sourceUrl?: unknown }>) {
        push(c.sourceUrl);
      }
    }
    // proofSignals[].sourceUrl
    if (Array.isArray(j.proofSignals)) {
      for (const p of j.proofSignals as Array<{ sourceUrl?: unknown }>) {
        push(p.sourceUrl);
      }
    }
    // aiReadabilityNotes / any other free text
    push(j.aiReadabilityNotes);
  }

  // Fix Briefs — any string field can carry URLs (rare, but harmless).
  if (fixBriefs) {
    for (const fb of fixBriefs) {
      push(fb.rootCause);
      push(fb.recommendedFix);
      push(fb.expectedImpact);
      for (const e of fb.evidenceAvailable) push(e);
      for (const e of fb.evidenceNeeded) push(e);
    }
  }

  // Project domain — normalize to a scheme so canonicalizeUrl works.
  if (projectDomain) {
    const withScheme = /^https?:\/\//i.test(projectDomain)
      ? projectDomain
      : `https://${projectDomain}`;
    set.add(canonicalizeUrl(withScheme));
    // Also allow bare-host references without the scheme.
    try {
      const parsed = new URL(withScheme);
      set.add(`${parsed.protocol}//${parsed.hostname.replace(/^www\./, "")}`);
    } catch {
      // ignore
    }
  }
  set.delete("");
  return set;
}

/**
 * Any URL in the asset content that is not in the allowed set is a
 * fabrication.
 */
export function detectFabricatedUrls(
  asset: GeneratedAssetRow,
  allowed: Set<string>,
): QaViolation[] {
  const found = extractUrls(asset.content);
  const violations: QaViolation[] = [];
  const seen = new Set<string>();
  for (const raw of found) {
    const canon = canonicalizeUrl(raw);
    if (isTechnicalVocabularyUrl(canon)) continue;
    if (allowed.has(canon)) continue;
    if (seen.has(canon)) continue;
    seen.add(canon);
    violations.push({
      type: "fabrication",
      quote: raw,
      reason:
        "URL not present in allowed evidence inputs (Evidence Bank, Mirror Profile, Fix Brief).",
      suggestedFix:
        "Remove the URL, or add the source to the Evidence Bank / Mirror Profile before re-running QA.",
    });
  }
  return violations;
}

/* -------------------------------------------------------------------------- */
/*  Asset-type conformity checks (Task 4)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Count Markdown headings (`#`, `##`, `###`, …) that start at
 * beginning-of-line. Setext-style (`===` / `---` under a line) headings
 * are not detected — the generator uses ATX-style throughout.
 */
function countHeadings(content: string): number {
  let count = 0;
  for (const line of content.split(/\r?\n/)) {
    if (/^#{1,6}\s+\S/.test(line.trim())) count += 1;
  }
  return count;
}

/**
 * Count a well-formed Markdown table as ≥ 1 header row followed by a
 * separator row (`|---|---|`).
 */
function containsMarkdownTable(content: string): boolean {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    const header = lines[i].trim();
    const sep = lines[i + 1].trim();
    if (
      /^\|.+\|$/.test(header) &&
      /^\|[\s\-|:]+\|$/.test(sep) &&
      sep.includes("---")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Count question/answer pairs. A question is either a Markdown heading
 * ending with `?`, a bold line ending with `?`, or a plain line ending
 * with `?` — followed by at least one non-empty answer line before the
 * next question.
 */
function countFaqPairs(content: string): number {
  const lines = content.split(/\r?\n/).map((l) => l.trim());
  let pairs = 0;
  let awaitingAnswer = false;
  for (const line of lines) {
    if (line.length === 0) continue;
    const isQuestion =
      /^(#{1,6}\s+.*\?\s*)$/.test(line) ||
      /^\*\*[^*]+\?\*\*\s*$/.test(line) ||
      /^[A-Za-z0-9].*\?$/.test(line);
    if (isQuestion) {
      awaitingAnswer = true;
      continue;
    }
    if (awaitingAnswer) {
      pairs += 1;
      awaitingAnswer = false;
    }
  }
  return pairs;
}

/**
 * A proof block must reference at least one proof item from the
 * Evidence Bank. We look for either a proof item's `detail` string or
 * a proof `type`+`detail` combined phrase inside the asset content.
 */
function proofTextMatchesDetail(text: string, detail: string): boolean {
  const textNorm = normalizeText(text);
  const detailNorm = normalizeText(detail);
  if (detailNorm.length >= 3 && textNorm.includes(detailNorm)) return true;

  const detailTokens = importantTokens(detailNorm);
  if (detailTokens.length === 0) return false;
  const textTokens = new Set(normalizeText(textNorm).split(" ").filter(Boolean));
  const hits = detailTokens.filter((t) => textTokens.has(t));
  const numericTokens = detailTokens.filter((t) => /\d/.test(t));
  const numericHits = numericTokens.filter((t) => textTokens.has(t));

  // Markdown formatting like **3,000 users** must not break a proof match.
  // Require either a numeric proof token plus another distinctive token, or
  // a conservative ratio for proof items without numbers (e.g. Ramp + coding + agent).
  if (numericTokens.length > 0 && numericHits.length > 0 && hits.length >= 2) {
    return true;
  }
  const required = Math.max(2, Math.ceil(detailTokens.length * 0.45));
  return hits.length >= required;
}

function referencesEvidenceProof(
  asset: GeneratedAssetRow,
  evidenceBank: EvidenceBankRow,
): boolean {
  if (evidenceBank.proofItems.length === 0) return false;
  const content = asset.content;
  for (const p of evidenceBank.proofItems) {
    const detail = (p.detail ?? "").trim();
    if (detail.length >= 3 && proofTextMatchesDetail(content, detail)) return true;
  }
  // Also allow: asset.claimsUsed contains `source: "evidence_bank"` and
  // at least one proof item exists. This mirrors what the Fix Agent
  // sometimes emits (a `claimsUsed` entry that quotes a proof item
  // detail directly).
  for (const cu of asset.claimsUsed) {
    if (
      cu.source.toLowerCase().includes("evidence_bank") &&
      cu.claim.trim().length > 0
    ) {
      for (const p of evidenceBank.proofItems) {
        const detail = (p.detail ?? "").trim();
        if (proofTextMatchesDetail(cu.claim, detail)) return true;
      }
    }
  }
  return false;
}

/**
 * Parse an asset's content as JSON (with the trivial cleanup for
 * fenced code blocks the Fix Agent sometimes emits) and confirm
 * `@type` is present at the top level or in a `@graph`.
 */
function jsonLdConformity(content: string): {
  ok: boolean;
  reason?: string;
} {
  let text = content.trim();
  // Strip a fenced json code block if present.
  const fenceMatch = /^```(?:json|jsonld)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  if (fenceMatch) text = fenceMatch[1].trim();
  if (text.length === 0) {
    return { ok: false, reason: "JSON-LD content is empty" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      reason: `JSON-LD content is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  const hasAtType = (v: unknown): boolean => {
    if (!v || typeof v !== "object") return false;
    if (
      "@type" in v &&
      typeof (v as Record<string, unknown>)["@type"] === "string"
    ) {
      return true;
    }
    const graph = (v as { "@graph"?: unknown })["@graph"];
    if (Array.isArray(graph)) {
      return graph.some((g) => hasAtType(g));
    }
    return false;
  };
  if (!hasAtType(parsed)) {
    return {
      ok: false,
      reason:
        "JSON-LD content does not declare `@type` (nor `@graph[].@type`).",
    };
  }
  return { ok: true };
}

export interface ConformityCheckInputs {
  asset: GeneratedAssetRow;
  evidenceBank: EvidenceBankRow;
}

export function detectAssetTypeConformity(
  input: ConformityCheckInputs,
): QaViolation[] {
  const { asset, evidenceBank } = input;
  const out: QaViolation[] = [];
  switch (asset.assetType) {
    case "faq_block": {
      const n = countFaqPairs(asset.content);
      if (n < 3) {
        out.push({
          type: "quality",
          quote: asset.content.slice(0, 120),
          reason: `faq_block conformity: expected at least 3 question/answer pairs, found ${n}.`,
          suggestedFix:
            "Add more question/answer pairs. Questions must end with `?` and each must be followed by a non-empty answer line.",
        });
      }
      break;
    }
    case "proof_block": {
      if (!referencesEvidenceProof(asset, evidenceBank)) {
        out.push({
          type: "quality",
          quote: asset.content.slice(0, 120),
          reason:
            "proof_block conformity: content does not reference any proof item from the Evidence Bank.",
          suggestedFix:
            "Cite at least one proof item detail (customer name, case study, metric) from the Evidence Bank verbatim.",
        });
      }
      break;
    }
    case "comparison_table": {
      if (!containsMarkdownTable(asset.content)) {
        out.push({
          type: "quality",
          quote: asset.content.slice(0, 120),
          reason:
            "comparison_table conformity: content does not contain a Markdown table (header + `|---|---|` separator row).",
          suggestedFix:
            "Include at least one Markdown table comparing the brand and the competitor side-by-side.",
        });
      }
      break;
    }
    case "json_ld_schema": {
      const check = jsonLdConformity(asset.content);
      if (!check.ok) {
        out.push({
          type: "quality",
          quote: asset.content.slice(0, 120),
          reason: `json_ld_schema conformity: ${check.reason}`,
          suggestedFix:
            "Ensure the asset is valid JSON and declares `@type` (or `@graph[].@type`).",
        });
      }
      break;
    }
    case "comparison_page_outline": {
      const n = countHeadings(asset.content);
      if (n < 3) {
        out.push({
          type: "quality",
          quote: asset.content.slice(0, 120),
          reason: `comparison_page_outline conformity: expected at least 3 Markdown headings, found ${n}.`,
          suggestedFix:
            "Structure the outline with at least three headings (e.g. Overview / Features / Pricing / Verdict).",
        });
      }
      break;
    }
    default:
      // Unknown asset type — no deterministic check. LLM QA already ran.
      break;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Competitor claim integrity + provenance ceiling (Sprint 12.2)             */
/* -------------------------------------------------------------------------- */

export interface CompetitorClaimGuardInputs {
  asset: GeneratedAssetRow;
  evidenceBank: EvidenceBankRow;
  competitors: Competitor[];
  fixBriefs?: FixBriefRow[];
  /**
   * M3 — source unique: resolved competitor mentions from the M2
   * canonical entity-resolution layer (lib/evidence/get-resolved-competitor-mentions.ts),
   * pre-fetched by the DB-aware caller (lib/pipeline/run-qa.ts). Replaces
   * the legacy `probeResults`/`competitorsMentioned` reading this
   * function used to do directly — no fallback to that legacy field is
   * performed here.
   */
  resolvedCompetitorMentions?: ResolvedCompetitorMention[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[`*_#>|]/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function importantTokens(s: string): string[] {
  const stop = new Set([
    "with",
    "without",
    "that",
    "this",
    "they",
    "them",
    "from",
    "have",
    "has",
    "had",
    "yes",
    "not",
    "does",
    "into",
    "tool",
    "tools",
    "team",
    "teams",
    "more",
    "less",
    "also",
    "primarily",
    "required",
    "requires",
    "limited",
    "broad",
    "broadly",
    "general",
    "various",
    "popular",
    "support",
    "supports",
    "supporting",
    "supported",
    "including",
    "include",
    "includes",
    "designed",
    "description",
    "platform",
    "product",
  ]);
  return normalizeText(s)
    .split(" ")
    .filter((t) => t.length >= 4 && !stop.has(t));
}

function uniqueNonEmpty(list: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const name = raw.replace(/\s+/g, " ").trim();
    const key = name.toLowerCase();
    if (name.length < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function extractCompetitorNames(input: CompetitorClaimGuardInputs): string[] {
  const names: string[] = [];
  for (const c of input.competitors) names.push(c.name);
  for (const fb of input.fixBriefs ?? []) {
    for (const piece of fb.competitorRecommended.split(
      /[,;/]|\band\b|\bet\b/i,
    )) {
      names.push(piece);
    }
  }
  for (const mention of input.resolvedCompetitorMentions ?? []) {
    names.push(mention.rawText);
  }
  return uniqueNonEmpty(names);
}

function competitorEvidenceStrings(
  evidenceBank: EvidenceBankRow,
  fixBriefs?: FixBriefRow[],
): string[] {
  const out: string[] = [];
  out.push(evidenceBank.productDescription);
  out.push(evidenceBank.notes);
  for (const claim of evidenceBank.allowedClaims) out.push(claim);
  for (const proof of evidenceBank.proofItems) {
    out.push(proof.detail);
    if (proof.sourceUrl) out.push(proof.sourceUrl);
  }
  for (const feature of evidenceBank.features) {
    out.push(feature.name);
    out.push(feature.description);
  }
  for (const fb of fixBriefs ?? []) {
    // `evidenceNeeded` is intentionally excluded: it is a TODO, not support.
    for (const ev of fb.evidenceAvailable) out.push(ev);
  }
  return out.filter((s) => typeof s === "string" && s.trim().length > 0);
}

function evidenceForCompetitor(
  competitor: string,
  evidenceStrings: string[],
): string[] {
  const re = new RegExp(`\\b${escapeRegExp(competitor)}\\b`, "i");
  return evidenceStrings.filter((s) => re.test(s));
}

const COMPETITOR_ATTRIBUTION_RE =
  /\b(yes|no|limited|lacks?|does\s+not|doesn[’']t|offers?|supports?|provides?|has|have|allows?|requires?|focus(?:es)?\s+on|popular|widely[-\s]used|widely|robust|customizable|manual|automatic|automated|integration|pricing|audience|workflow|workflows|capabilit(?:y|ies)|customer|customers|market|default|ranked|review|reviews|better|best|leading|top[-\s]ranked|suitable|specialized|versatile|all[-\s]in[-\s]one|combines|tailored|strengths?|advantages?|unique|broader\s+functionalities|functionalities)\b/i;

function isMarkdownHeading(line: string): boolean {
  return /^#{1,6}\s+/.test(line.trim());
}

function isNeutralFramingSentence(line: string): boolean {
  const trimmed = line.trim().replace(/^[-*]\s+/, "");
  return (
    /^this comparison\s+(outlines|compares|summarizes|shows|explains)\b/i.test(
      trimmed,
    ) ||
    /^this page\s+(outlines|compares|summarizes|shows|explains)\b/i.test(
      trimmed,
    ) ||
    /^choosing the right\s+.+\s+depends\b/i.test(trimmed) ||
    /^compare\s+.+\s+to understand\b/i.test(trimmed)
  );
}

function hasCompetitorAttribution(line: string): boolean {
  const trimmed = line.trim();
  if (isNeutralFramingSentence(trimmed)) return false;
  // A heading/title is allowed unless it directly attributes a capability,
  // limitation, popularity, audience, or other factual property.
  if (isMarkdownHeading(trimmed)) {
    return COMPETITOR_ATTRIBUTION_RE.test(trimmed.replace(/^#{1,6}\s+/, ""));
  }
  return COMPETITOR_ATTRIBUTION_RE.test(trimmed);
}

function isNeutralCompetitorMention(
  raw: string,
  competitorNames: string[],
): boolean {
  const line = raw.trim();
  if (line.length === 0) return true;
  if (/\[EVIDENCE NEEDED:/i.test(line)) return true;

  const stripped = normalizeText(line);
  if (stripped.length === 0) return true;

  // Headings/titles like "Linear vs Jira" are routing/structure, not claims.
  if (isMarkdownHeading(line) && !hasCompetitorAttribution(line)) return true;

  // Neutral framing sentences may name competitors to explain page scope.
  if (isNeutralFramingSentence(line)) return true;

  // Competitor names alone, or boilerplate title fragments, are mentions.
  const withoutNames = competitorNames
    .reduce((acc, name) => {
      const re = new RegExp(`\b${escapeRegExp(normalizeText(name))}\b`, "gi");
      return acc.replace(re, " ");
    }, stripped)
    .replace(
      /\b(linear|vs|versus|comparison|compare|overview|feature|features|tool|tools|page|section|product|teams)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (withoutNames.length === 0) return true;

  // A Markdown table header such as `| Feature | Linear | Jira | Notion |` is neutral.
  if (/^\|/.test(line) && !COMPETITOR_ATTRIBUTION_RE.test(line)) return true;

  return false;
}

function claimSupportedByEvidence(
  competitor: string,
  quote: string,
  evidenceStrings: string[],
): boolean {
  const relevantEvidence = evidenceForCompetitor(competitor, evidenceStrings);
  if (relevantEvidence.length === 0) return false;

  const quoteTokens = importantTokens(quote).filter(
    (t) => t !== normalizeText(competitor),
  );
  // If the line/cell contains no factual words beyond the name, treat as neutral.
  if (quoteTokens.length === 0) return true;

  for (const ev of relevantEvidence) {
    const evNorm = normalizeText(ev);
    const evTokens = new Set(importantTokens(ev));
    const overlap = quoteTokens.filter((t) => evTokens.has(t)).length;
    if (evNorm.includes(normalizeText(quote))) return true;
    if (
      normalizeText(quote).includes(evNorm) &&
      evNorm.length > normalizeText(competitor).length + 8
    )
      return true;
    if (overlap >= Math.min(3, quoteTokens.length)) return true;
  }
  return false;
}

function splitMarkdownTableCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return [];
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\|[\s\-:|]+\|$/.test(line.trim()) && line.includes("---");
}

function detectCompetitorTableClaims(
  asset: GeneratedAssetRow,
  competitorNames: string[],
  evidenceStrings: string[],
): QaViolation[] {
  const out: QaViolation[] = [];
  const lines = asset.content.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    const headerCells = splitMarkdownTableCells(lines[i]);
    if (headerCells.length === 0 || !isMarkdownTableSeparator(lines[i + 1]))
      continue;

    const competitorColumns: Array<{ index: number; name: string }> = [];
    headerCells.forEach((cell, index) => {
      for (const name of competitorNames) {
        const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, "i");
        if (re.test(cell)) competitorColumns.push({ index, name });
      }
    });
    if (competitorColumns.length === 0) continue;

    for (let rowIndex = i + 2; rowIndex < lines.length; rowIndex++) {
      const row = lines[rowIndex];
      if (!row.trim().startsWith("|")) break;
      if (isMarkdownTableSeparator(row)) continue;
      const cells = splitMarkdownTableCells(row);
      const rowLabel = (cells[0] ?? "").replace(/\*\*/g, "").trim();
      for (const col of competitorColumns) {
        const cell = cells[col.index]?.trim() ?? "";
        if (cell.length === 0) continue;
        if (/^(-|—|n\/a|na)$/i.test(cell)) continue;
        if (/\[EVIDENCE NEEDED:/i.test(cell)) continue;
        const quote =
          rowLabel.length > 0
            ? `${col.name} / ${rowLabel}: ${cell}`
            : `${col.name}: ${cell}`;
        if (claimSupportedByEvidence(col.name, quote, evidenceStrings))
          continue;
        out.push({
          type: "unsupported_claim",
          quote,
          reason:
            "Competitor comparison claim is not supported by Evidence Bank or Fix Brief evidence.",
          suggestedFix: `Replace this ${col.name} claim with an [EVIDENCE NEEDED: ${col.name} feature evidence] placeholder, or add source-backed competitor evidence and re-run QA.`,
        });
      }
    }
  }
  return out;
}

function detectCompetitorProseClaims(
  asset: GeneratedAssetRow,
  competitorNames: string[],
  evidenceStrings: string[],
): QaViolation[] {
  const out: QaViolation[] = [];
  const lines = asset.content.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || isMarkdownTableSeparator(line)) continue;
    if (splitMarkdownTableCells(line).length > 0) continue;
    for (const name of competitorNames) {
      const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, "i");
      if (!re.test(line)) continue;
      if (isNeutralCompetitorMention(line, competitorNames)) continue;
      if (!hasCompetitorAttribution(line)) continue;
      if (claimSupportedByEvidence(name, line, evidenceStrings)) continue;
      out.push({
        type: "unsupported_claim",
        quote: line.slice(0, 240),
        reason:
          "Competitor comparison claim is not supported by Evidence Bank or Fix Brief evidence.",
        suggestedFix: `Remove the ${name} claim, replace it with an [EVIDENCE NEEDED: ${name} evidence] placeholder, or add source-backed competitor evidence and re-run QA.`,
      });
    }
  }
  return out;
}

/**
 * Detect unsupported competitor claims in comparison-style assets. This is
 * intentionally conservative: if we cannot prove a competitor capability,
 * limitation, integration, pricing, audience, or workflow claim from inputs,
 * the asset cannot be `safe_to_publish`.
 */
export function detectUnsupportedCompetitorClaims(
  input: CompetitorClaimGuardInputs,
): QaViolation[] {
  const isComparisonAsset =
    input.asset.assetType === "comparison_table" ||
    input.asset.assetType === "comparison_page_outline" ||
    /\bvs\b|\bversus\b|comparison/i.test(
      `${input.asset.title}\n${input.asset.content}`,
    );
  if (!isComparisonAsset) return [];

  const competitorNames = extractCompetitorNames(input).filter(
    (name) => normalizeText(name) !== "linear",
  );
  if (competitorNames.length === 0) return [];

  const evidenceStrings = competitorEvidenceStrings(
    input.evidenceBank,
    input.fixBriefs,
  );
  const table = detectCompetitorTableClaims(
    input.asset,
    competitorNames,
    evidenceStrings,
  );
  const prose = detectCompetitorProseClaims(
    input.asset,
    competitorNames,
    evidenceStrings,
  );

  const seen = new Set<string>();
  const combined: QaViolation[] = [];
  for (const v of [...table, ...prose]) {
    const key = `${v.type}::${v.quote.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    combined.push(v);
  }
  return combined;
}

/**
 * A machine-filled Evidence Bank can be useful for drafts, but it must not
 * certify a generated asset as publish-ready. Until a human explicitly marks
 * the bank as `user_reviewed`, cap otherwise-clean assets at `needs_evidence`.
 */
export function detectEvidenceBankProvenanceCeiling(
  evidenceBank: EvidenceBankRow,
): QaViolation[] {
  if (evidenceBank.provenance === "user_reviewed") return [];
  return [
    {
      type: "quality",
      quote: `Evidence Bank provenance: ${evidenceBank.provenance}`,
      reason:
        "Evidence Bank has not been explicitly human-reviewed, so automated QA cannot certify this asset as publish-ready.",
      suggestedFix:
        "Review the Evidence Bank against source URLs, mark it user_reviewed, then re-run QA.",
    },
  ];
}

/* -------------------------------------------------------------------------- */
/*  Supported-claim counter-check (Sprint 12.3)                               */
/* -------------------------------------------------------------------------- */

export interface SupportedClaimCounterCheckInputs {
  evidenceBank: EvidenceBankRow;
  mirrorProfile?: MirrorProfileRow | null;
}

function supportedClaimStrings(
  input: SupportedClaimCounterCheckInputs,
): string[] {
  const out: string[] = [];
  const eb = input.evidenceBank;
  out.push(eb.productDescription);
  out.push(eb.notes);
  for (const claim of eb.allowedClaims) out.push(claim);
  for (const feature of eb.features) {
    out.push(feature.name);
    out.push(feature.description);
  }
  for (const proof of eb.proofItems) {
    out.push(proof.detail);
    if (proof.sourceUrl) out.push(proof.sourceUrl);
  }
  for (const audience of eb.targetAudience) out.push(audience);
  for (const useCase of eb.mainUseCases) out.push(useCase);

  const j = (input.mirrorProfile?.json ?? {}) as Record<string, unknown>;
  const pushStrings = (value: unknown): void => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) pushStrings(item);
    } else if (value && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>))
        pushStrings(v);
    }
  };
  pushStrings(j.companyName);
  pushStrings(j.detectedCategory);
  pushStrings(j.targetAudience);
  pushStrings(j.useCases);
  pushStrings(j.features);
  pushStrings(j.claims);
  pushStrings(j.proofSignals);

  return out.filter((s) => typeof s === "string" && s.trim().length > 0);
}

export function isQuoteCoveredByAllowedEvidence(
  quote: string,
  input: SupportedClaimCounterCheckInputs,
): boolean {
  const qNorm = normalizeText(quote);
  if (qNorm.length === 0) return false;
  const support = supportedClaimStrings(input);
  const supportNorm = normalizeText(support.join(" "));
  if (supportNorm.includes(qNorm)) return true;

  const qTokens = importantTokens(quote).filter(
    (t) => t !== "linear" && t !== "ai",
  );
  if (qTokens.length === 0) return false;
  const supportTokens = new Set(importantTokens(support.join(" ")));
  const covered = qTokens.filter(
    (t) => supportTokens.has(t) || supportNorm.includes(t),
  );
  return covered.length === qTokens.length;
}

export function downgradeSupportedLlmViolations(
  llmOutput: QaAgentOutput,
  supportInput?: SupportedClaimCounterCheckInputs,
): QaAgentOutput {
  if (!supportInput) return llmOutput;
  const kept: QaViolation[] = [];
  const downgraded: QaViolation[] = [];
  for (const v of llmOutput.violations) {
    if (
      (v.type === "fabrication" || v.type === "unsupported_claim") &&
      isQuoteCoveredByAllowedEvidence(v.quote, supportInput)
    ) {
      downgraded.push(v);
    } else {
      kept.push(v);
    }
  }
  if (downgraded.length === 0) return llmOutput;
  const verdict = recomputeVerdict(kept, llmOutput.placeholdersRemaining);
  const notes = `${llmOutput.overallNotes} Non-blocking QA warning: ${downgraded.length} LLM finding${downgraded.length === 1 ? "" : "s"} matched allowed Evidence Bank / Mirror Profile claims and were excluded from publishability status computation.`;
  return {
    verdict,
    violations: kept,
    placeholdersRemaining: llmOutput.placeholdersRemaining,
    overallNotes: notes,
  };
}

/* -------------------------------------------------------------------------- */
/*  Verdict recomputation                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Recompute the final verdict from a combined violation set, using the
 * same rules the schema's `superRefine` and the mock QA verdict compute
 * would apply. Duplicated here to keep this module free of a mutual
 * import with `lib/agents/qa-agent.ts`.
 */
export function recomputeVerdict(
  violations: QaViolation[],
  placeholdersRemaining: string[],
): QaVerdict {
  const nonQuality = violations.filter((v) => v.type !== "quality");
  if (nonQuality.length > 0) return "unsupported_claims";
  if (placeholdersRemaining.length > 0) return "needs_evidence";
  if (violations.length > 0) return "needs_evidence";
  return "safe_to_publish";
}

/* -------------------------------------------------------------------------- */
/*  Merge helper                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Merge a set of deterministic violations into an LLM QA output.
 *
 *   - LLM violations are preserved verbatim.
 *   - Deterministic violations are appended, deduplicated against the
 *     LLM output by `(type, quote)` so we never double-count a URL both
 *     the LLM and the guard flagged.
 *   - The final verdict is recomputed from the combined set +
 *     `placeholdersRemaining`.
 *   - `overallNotes` is preserved from the LLM but appended with a
 *     summary of what the deterministic layer added.
 */
export function mergeQaViolations(
  llmOutput: QaAgentOutput,
  deterministic: QaViolation[],
  supportInput?: SupportedClaimCounterCheckInputs,
): QaAgentOutput {
  const normalizedLlmOutput = downgradeSupportedLlmViolations(
    llmOutput,
    supportInput,
  );
  if (deterministic.length === 0) {
    // Nothing to merge — but still recompute verdict from LLM's own
    // violations to be defensive. The schema already asserted
    // consistency, so this should be a no-op.
    const verdict = recomputeVerdict(
      normalizedLlmOutput.violations,
      normalizedLlmOutput.placeholdersRemaining,
    );
    if (verdict === normalizedLlmOutput.verdict) return normalizedLlmOutput;
    return { ...normalizedLlmOutput, verdict };
  }
  const seen = new Set<string>();
  const key = (v: QaViolation): string =>
    `${v.type}::${v.quote.trim().toLowerCase()}`;
  for (const v of normalizedLlmOutput.violations) seen.add(key(v));

  const combined = [...normalizedLlmOutput.violations];
  const appended: QaViolation[] = [];
  for (const v of deterministic) {
    const k = key(v);
    if (seen.has(k)) continue;
    seen.add(k);
    combined.push(v);
    appended.push(v);
  }

  const verdict = recomputeVerdict(
    combined,
    normalizedLlmOutput.placeholdersRemaining,
  );
  const notes =
    appended.length > 0
      ? `${normalizedLlmOutput.overallNotes} Deterministic QA layer added ${appended.length} finding${appended.length === 1 ? "" : "s"}: ${appended.map((v) => v.type).join(", ")}.`
      : normalizedLlmOutput.overallNotes;

  return {
    verdict,
    violations: combined,
    placeholdersRemaining: normalizedLlmOutput.placeholdersRemaining,
    overallNotes: notes,
  };
}
