/**
 * P2 draft buyer questions (D-047). Pure.
 *
 * Suggestions are fixed wording rules filled from the customer's own Brand
 * Profile: no model call, no web research, nothing paid. They are suggested
 * wording only — the `hypothesis` class of D-040 — never evidence that
 * buyers ask them, and the page says so wherever they appear.
 *
 * Overlap warnings reuse the Q1 duplicate rules (lib/buyer-questions):
 * the same duplicate key is "the same question", and a content-token
 * Jaccard of at least 0.8 is "very similar". A warning never blocks; the
 * customer decides.
 */
import { findDuplicates } from "@/lib/buyer-questions/duplicates";
import type { Candidate, SiteContext } from "@/lib/buyer-questions/types";
import type { Objective } from "@/lib/workspace/store";
import { DRAFT_CATEGORIES, type BrandProfile, type DraftCategory, type DraftStatus, type QuestionDraft } from "@/lib/workspace/store";

export const DRAFT_TEXT_MIN = 8;
export const DRAFT_TEXT_MAX = 300;
export const LIVE_DRAFT_LIMIT = 50;
/** Fewer, specific suggestions beat a full quota of generic ones. */
export const MAX_SUGGESTIONS = 8;

export const CATEGORY_LABELS: Readonly<Record<DraftCategory, string>> = {
  discovery: "Discovery",
  comparison: "Comparison",
  evaluation: "Evaluation",
  use_case: "Use cases",
};

export const CATEGORY_HINTS: Readonly<Record<DraftCategory, string>> = {
  discovery: "A buyer looking for options in your category.",
  comparison: "A buyer weighing you against a named alternative.",
  evaluation: "A buyer checking whether you fit, cost or can be trusted.",
  use_case: "A buyer asking what you are used for.",
};

export const SUGGESTION_LABEL = "Suggested wording";
export const SUGGESTION_DISCLAIMER =
  "Suggestions are wording Zypact built from your Brand Profile with fixed rules. They are not taken from real buyer searches or conversations, and they are not evidence of what real buyers want to know.";
export const DRAFT_STATUS_NOTE =
  "Drafts are your working list. They use no question allowance and start no measurement. Approve a draft to make it an active question; approving starts no measurement either.";

export interface Suggestion {
  rule: string;
  category: DraftCategory;
  text: string;
}

/** Lowercases a leading capital unless the word looks like a name or acronym ("CRM", "HubSpot"). */
function inSentence(phrase: string): string {
  const first = phrase.split(/\s+/)[0] ?? "";
  const rest = first.slice(1);
  return rest === rest.toLowerCase() ? phrase.charAt(0).toLowerCase() + phrase.slice(1) : phrase;
}

const RULE_VERSION = "v1";
const rule = (name: string) => `p2.suggest.${name}.${RULE_VERSION}`;

/** Category order per objective; the objective only orders, never adds. */
const OBJECTIVE_ORDER: Readonly<Record<Objective, readonly DraftCategory[]>> = {
  describe_product: ["evaluation", "use_case", "discovery", "comparison"],
  compare_competitors: ["comparison", "discovery", "evaluation", "use_case"],
  investigate_sources: ["discovery", "comparison", "evaluation", "use_case"],
  review_after_change: ["evaluation", "discovery", "comparison", "use_case"],
};

/**
 * Suggestions from the saved Brand Profile. A rule whose inputs the profile
 * does not have is skipped rather than filled with something generic.
 * Suggestions whose duplicate key matches a live draft are left out.
 */
export function suggestQuestions(profile: BrandProfile | null, drafts: readonly QuestionDraft[]): Suggestion[] {
  if (!profile) return [];
  const company = profile.companyName;
  const category = profile.category ? inSentence(profile.category) : null;
  const audience = profile.audience ? inSentence(profile.audience) : null;
  const forAudience = audience ? ` for ${audience}` : "";
  const out: Suggestion[] = [];

  if (category) {
    out.push({ rule: rule("category_best"), category: "discovery", text: `What are the best ${category} options${forAudience}?` });
    out.push({ rule: rule("category_choose"), category: "discovery", text: `How should I choose a ${category} provider?` });
  }
  for (const competitor of profile.competitors.slice(0, 3)) {
    out.push({ rule: rule("vs_competitor"), category: "comparison", text: `${company} vs ${competitor}: which is better${forAudience}?` });
  }
  if (profile.competitors[0]) {
    out.push({ rule: rule("competitor_alternatives"), category: "comparison", text: `What are the alternatives to ${profile.competitors[0]}?` });
  }
  if (audience) out.push({ rule: rule("brand_fit"), category: "evaluation", text: `Is ${company} a good choice for ${audience}?` });
  out.push({ rule: rule("brand_pricing"), category: "evaluation", text: `How much does ${company} cost?` });
  out.push({ rule: rule("brand_use"), category: "use_case", text: `What is ${company} used for?` });

  const order = OBJECTIVE_ORDER[profile.objective ?? "investigate_sources"];
  const site = siteContext(profile);
  const taken = new Set(
    drafts.filter((d) => d.status === "draft").map((d) => findDuplicates([asCandidate("x", d.text)], site).keys.get("x"))
  );
  return out
    .filter((s) => s.text.length >= DRAFT_TEXT_MIN && s.text.length <= DRAFT_TEXT_MAX)
    .filter((s) => !taken.has(findDuplicates([asCandidate("x", s.text)], site).keys.get("x")))
    .map((s, i) => ({ s, i }))
    .sort((a, b) => order.indexOf(a.s.category) - order.indexOf(b.s.category) || a.i - b.i)
    .map(({ s }) => s)
    .slice(0, MAX_SUGGESTIONS);
}

function siteContext(profile: BrandProfile | null): SiteContext {
  return {
    brandNames: profile ? [{ name: profile.companyName }] : [],
    productNames: [],
    siteCopy: "",
  };
}

/** findDuplicates reads only `id` and `text`. */
function asCandidate(id: string, text: string): Candidate {
  return { id, text } as unknown as Candidate;
}

export interface OverlapWarning {
  kind: "same" | "similar";
  otherId: string;
  otherText: string;
}

/** Overlap warnings among the live drafts, keyed by draft id. */
export function draftOverlaps(drafts: readonly QuestionDraft[], profile: BrandProfile | null): Map<string, OverlapWarning[]> {
  const live = drafts.filter((d) => d.status === "draft");
  const analysis = findDuplicates(live.map((d) => asCandidate(d.id, d.text)), siteContext(profile));
  const textOf = new Map(live.map((d) => [d.id, d.text]));
  const out = new Map<string, OverlapWarning[]>();
  const push = (id: string, w: OverlapWarning) => out.set(id, [...(out.get(id) ?? []), w]);

  for (const group of analysis.exactGroups) {
    for (const id of group) {
      for (const other of group) if (other !== id) push(id, { kind: "same", otherId: other, otherText: textOf.get(other) ?? "" });
    }
  }
  for (const [id, near] of analysis.nearOf) {
    for (const other of near) {
      if (analysis.keys.get(id) === analysis.keys.get(other)) continue;
      push(id, { kind: "similar", otherId: other, otherText: textOf.get(other) ?? "" });
    }
  }
  return out;
}

/** Overlap of one proposed text (a suggestion or a new draft) with the live drafts. */
export function overlapWithDrafts(text: string, drafts: readonly QuestionDraft[], profile: BrandProfile | null): OverlapWarning[] {
  const probe = { id: "\u0000probe", text, version: 0, category: "discovery", origin: "customer_written", suggestionRule: null, status: "draft", createdAt: "", updatedAt: "" } as QuestionDraft;
  return draftOverlaps([...drafts, probe], profile).get(probe.id) ?? [];
}

/* ------------------------------------------------------------------ */
/* Input                                                                */
/* ------------------------------------------------------------------ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUGGESTION_RULE_RE = /^p2\.suggest\.[a-z_]{3,40}\.v[0-9]{1,3}$/;

export function cleanQuestionText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length >= DRAFT_TEXT_MIN && text.length <= DRAFT_TEXT_MAX ? text : null;
}

const TEXT_MESSAGE = `Write the question in ${DRAFT_TEXT_MIN} to ${DRAFT_TEXT_MAX} characters.`;

export function parseNewDraft(input: Record<string, unknown>):
  | { ok: true; text: string; category: DraftCategory; suggestionRule: string | null }
  | { ok: false; field: string; message: string } {
  const text = cleanQuestionText(input.text);
  if (!text) return { ok: false, field: "text", message: TEXT_MESSAGE };
  if (!DRAFT_CATEGORIES.includes(input.category as DraftCategory)) return { ok: false, field: "category", message: "Choose a question type." };
  const rule = input.suggestionRule === undefined || input.suggestionRule === null || input.suggestionRule === "" ? null : input.suggestionRule;
  if (rule !== null && (typeof rule !== "string" || !SUGGESTION_RULE_RE.test(rule))) {
    return { ok: false, field: "suggestionRule", message: "Reload the page and try again." };
  }
  return { ok: true, text, category: input.category as DraftCategory, suggestionRule: rule as string | null };
}

export function parseDraftRevision(input: Record<string, unknown>):
  | { ok: true; draftId: string; expectedVersion: number; text: string; category: DraftCategory; status: DraftStatus }
  | { ok: false; field: string; message: string } {
  if (typeof input.draftId !== "string" || !UUID_RE.test(input.draftId)) return { ok: false, field: "draftId", message: "Reload the page and try again." };
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return { ok: false, field: "expectedVersion", message: "Reload the page and try again." };
  const text = cleanQuestionText(input.text);
  if (!text) return { ok: false, field: "text", message: TEXT_MESSAGE };
  if (!DRAFT_CATEGORIES.includes(input.category as DraftCategory)) return { ok: false, field: "category", message: "Choose a question type." };
  if (input.status !== "draft" && input.status !== "archived") return { ok: false, field: "status", message: "Reload the page and try again." };
  return { ok: true, draftId: input.draftId, expectedVersion, text, category: input.category as DraftCategory, status: input.status };
}

export const ORIGIN_LABELS: Readonly<Record<QuestionDraft["origin"], string>> = {
  customer_written: "Written by your team",
  suggested: SUGGESTION_LABEL,
  suggestion_edited: "Suggested wording, edited by your team",
};
