import type { GeneratedPrompt, GeneratedPromptInput } from "@/lib/db/types";
import type { GeneratedPromptItem } from "@/lib/schemas/prompt-mirror.schema";

export const CORE_COMMERCIAL_INTENTS = new Set([
  "best_tools",
  "alternatives",
  "comparison",
  "pricing_value",
  "migration",
  "buyer_role",
]);

export const REQUIRED_COMMERCIAL_INTENTS = [
  "best_tools",
  "alternatives",
  "comparison",
] as const;

export interface SelectionOptions {
  max?: number;
  minRequiredIntents?: number;
}

function normalizePrompt(prompt: string): string[] {
  const stop = new Set([
    "how",
    "can",
    "i",
    "my",
    "brand",
    "the",
    "a",
    "an",
    "to",
    "for",
    "in",
    "of",
    "and",
    "or",
    "is",
    "are",
    "be",
    "being",
    "not",
    "why",
    "what",
    "which",
    "with",
    "by",
    "systems",
    "answers",
    "visibility",
    "ai",
  ]);
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 3 && !stop.has(x));
}

function signature(prompt: string): string {
  const terms = Array.from(new Set(normalizePrompt(prompt))).sort();
  return terms.slice(0, 8).join("|");
}

export const PROMPT_SIMILARITY_THRESHOLD = 0.75;

/**
 * Token-overlap ratio between two prompts, relative to the smaller token set.
 * Exposed so selection can *report* why a candidate was rejected instead of
 * dropping it silently. The threshold itself is unchanged.
 */
export function promptOverlapRatio(a: string, b: string): number {
  const aa = new Set(normalizePrompt(a));
  const bb = new Set(normalizePrompt(b));
  if (aa.size === 0 || bb.size === 0) return 0;
  let overlap = 0;
  for (const t of aa) if (bb.has(t)) overlap += 1;
  return overlap / Math.min(aa.size, bb.size);
}

function tooSimilar(a: string, b: string): boolean {
  return promptOverlapRatio(a, b) >= PROMPT_SIMILARITY_THRESHOLD;
}

function sortPrompts<T extends { priority: number; commercialValue: number; winnability: number; id: string | number }>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      b.priority - a.priority ||
      b.commercialValue - a.commercialValue ||
      b.winnability - a.winnability ||
      String(a.id).localeCompare(String(b.id)),
  );
}

export function isCommercialPromptIntent(intentType: string): boolean {
  return CORE_COMMERCIAL_INTENTS.has(intentType);
}

export function selectCommercialProbePromptIds(
  prompts: GeneratedPromptItem[],
  modelRecommendedIds: number[],
  options: SelectionOptions = {},
): number[] {
  const max = Math.max(1, options.max ?? 20);
  const selected: GeneratedPromptItem[] = [];
  const usedIds = new Set<number>();
  const usedSignatures = new Set<string>();

  const add = (p: GeneratedPromptItem): boolean => {
    if (usedIds.has(p.id)) return false;
    const sig = signature(p.prompt);
    if (sig && usedSignatures.has(sig)) return false;
    if (selected.some((x) => tooSimilar(x.prompt, p.prompt))) return false;
    selected.push(p);
    usedIds.add(p.id);
    if (sig) usedSignatures.add(sig);
    return true;
  };

  const byIntent = new Map(prompts.map((p) => [p.id, p]));
  for (const intent of REQUIRED_COMMERCIAL_INTENTS) {
    const candidate = sortPrompts(prompts.filter((p) => p.intentType === intent))[0];
    if (candidate) add(candidate);
  }

  const modelRecommended = modelRecommendedIds
    .map((id) => byIntent.get(id))
    .filter((p): p is GeneratedPromptItem => Boolean(p));
  for (const p of sortPrompts(modelRecommended.filter((p) => isCommercialPromptIntent(p.intentType)))) {
    if (selected.length >= max) break;
    add(p);
  }
  for (const p of sortPrompts(prompts.filter((p) => isCommercialPromptIntent(p.intentType)))) {
    if (selected.length >= max) break;
    add(p);
  }
  for (const p of sortPrompts(modelRecommended)) {
    if (selected.length >= max) break;
    add(p);
  }
  for (const p of sortPrompts(prompts)) {
    if (selected.length >= max) break;
    add(p);
  }
  return selected.slice(0, max).map((p) => p.id);
}

export interface PromptSelectionRejection {
  promptId: string;
  priority: number;
  blockedByPromptId: string;
  blockedByPriority: number;
  overlapRatio: number;
}

export interface PromptSelectionResult {
  rows: GeneratedPrompt[];
  requested: number;
  candidates: number;
  selected: number;
  rejectedAsDuplicate: number;
  rejections: PromptSelectionRejection[];
  reachedTarget: boolean;
  shortfallReason:
    | "insufficient_candidates"
    | "duplicate_rejection"
    | null;
}

/**
 * Same selection algorithm as `chooseCommercialPromptRows`, but it reports
 * what it dropped. Near-duplicate rejection is legitimate; returning fewer
 * prompts than requested *without saying so* is not. Callers use this to
 * fail loudly instead of running a silently smaller scan.
 */
export function chooseCommercialPromptRowsWithDiagnostics(
  prompts: GeneratedPrompt[],
  count: number,
): PromptSelectionResult {
  const selected = prompts.filter((p) => p.selected);
  const candidates = selected.length > 0 ? selected : prompts;
  const out: GeneratedPrompt[] = [];
  const used = new Set<string>();
  const rejections: PromptSelectionRejection[] = [];
  const alreadyRejected = new Set<string>();

  const add = (p: GeneratedPrompt): boolean => {
    if (used.has(p.id)) return false;

    let blocker: GeneratedPrompt | null = null;
    let overlapRatio = 0;
    for (const x of out) {
      const ratio = promptOverlapRatio(x.prompt, p.prompt);
      if (ratio > overlapRatio) {
        overlapRatio = ratio;
        blocker = x;
      }
    }

    if (blocker && overlapRatio >= PROMPT_SIMILARITY_THRESHOLD) {
      if (!alreadyRejected.has(p.id)) {
        alreadyRejected.add(p.id);
        rejections.push({
          promptId: p.id,
          priority: p.priority,
          blockedByPromptId: blocker.id,
          blockedByPriority: blocker.priority,
          overlapRatio,
        });
      }
      return false;
    }

    out.push(p);
    used.add(p.id);
    return true;
  };

  for (const intent of REQUIRED_COMMERCIAL_INTENTS) {
    const candidate = sortPrompts(candidates.filter((p) => p.intentType === intent))[0];
    if (candidate) add(candidate);
  }
  for (const p of sortPrompts(candidates.filter((p) => isCommercialPromptIntent(p.intentType)))) {
    if (out.length >= count) break;
    add(p);
  }
  for (const p of sortPrompts(candidates)) {
    if (out.length >= count) break;
    add(p);
  }

  const rows = out.slice(0, count);
  const reachedTarget = rows.length >= count;

  return {
    rows,
    requested: count,
    candidates: candidates.length,
    selected: rows.length,
    rejectedAsDuplicate: rejections.length,
    rejections,
    reachedTarget,
    shortfallReason: reachedTarget
      ? null
      : candidates.length < count
        ? "insufficient_candidates"
        : "duplicate_rejection",
  };
}

export function chooseCommercialPromptRows(
  prompts: GeneratedPrompt[],
  count: number,
): GeneratedPrompt[] {
  return chooseCommercialPromptRowsWithDiagnostics(prompts, count).rows;
}

export const ZYPACT_COMMERCIAL_SANITY_PROMPTS: GeneratedPromptInput[] = [
  {
    prompt: "Affordable alternatives to Profound for small SaaS teams",
    intentType: "alternatives",
    commercialValue: 5,
    winnability: 3,
    priority: 25,
    rationale: "Fixed commercial sanity prompt for Zypact; tests alternatives intent where buyers evaluate direct vendors.",
    selected: true,
  },
  {
    prompt: "Tools to test if GPTBot and ClaudeBot can crawl my website",
    intentType: "best_tools",
    commercialValue: 5,
    winnability: 3,
    priority: 25,
    rationale: "Fixed commercial sanity prompt for Zypact; tests free-tool/crawler-audit buyer intent.",
    selected: true,
  },
  {
    prompt: "AI visibility tool under $100/month",
    intentType: "pricing_value",
    commercialValue: 5,
    winnability: 3,
    priority: 25,
    rationale: "Fixed commercial sanity prompt for Zypact; tests budget/pricing shortlist intent.",
    selected: true,
  },
];
