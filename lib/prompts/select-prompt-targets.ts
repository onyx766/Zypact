/**
 * Prompt-target selection for the MVP scan runner.
 *
 * Extracted from scripts/mvp-scan.ts so it can be imported by tests — that
 * script invokes main() at module scope, so importing it would run a scan.
 *
 * POLICY-FREE: never throws, never decides whether a shortfall is acceptable.
 * throw/warn/silent lives in lib/prompts/prompt-selection-policy.ts.
 *
 * Diagnostics carry prompt IDs, priorities, and ratios only — never prompt
 * text, which may be confidential prospect data.
 */

import type { GeneratedPrompt } from "@/lib/db/types";
import {
  chooseCommercialPromptRowsWithDiagnostics,
  PROMPT_SIMILARITY_THRESHOLD,
  type PromptSelectionRejection,
} from "@/lib/prompts/commercial-selection";

/**
 * FACTORS, not causes. Several can apply at once, and they are reported
 * independently rather than as a single attributed cause. Brand-filter
 * involvement is measured counterfactually, so it is reported whenever
 * removing the filter would have yielded more prompts — including when the
 * filtered pool still met the requested count.
 */
export type PromptShortfallFactor =
  | "insufficient_input_candidates"
  | "brand_filter_removal"
  | "similarity_rejection";

export interface PromptTargetSelection {
  rows: GeneratedPrompt[];
  requested: number;

  // ---- Independent facts, always reported ----
  totalPrompts: number;
  inputShortfall: boolean;
  removedByBrandFilter: number;
  candidatesAfterBrandFilter: number;
  /** How many more prompts would have been selected without brand filtering. */
  brandFilterImpact: number;
  rejectedAsDuplicate: number;
  selected: number;
  reachedTarget: boolean;
  rejections: PromptSelectionRejection[];

  // ---- Interpretation ----
  shortfallFactors: PromptShortfallFactor[];
}

export const PROMPT_SHORTFALL_FACTOR_TEXT: Record<PromptShortfallFactor, string> = {
  insufficient_input_candidates:
    "the prompt pool was already smaller than the requested count",
  brand_filter_removal:
    "removing prompts containing the client brand reduced the final selection",
  similarity_rejection:
    "near-duplicate prompts were rejected at the similarity threshold",
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function promptContainsBrandTerm(
  prompt: string,
  terms: string[]
): boolean {
  return terms.some((rawTerm) => {
    const normalizedTerm = rawTerm
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/.*$/, "");

    const variants = new Set([
      normalizedTerm,
      normalizedTerm.split(".")[0] ?? "",
    ]);

    return [...variants].some((variant) => {
      if (variant.length < 3) return false;

      const pattern = new RegExp(
        `(^|[^a-z0-9])${escapeRegExp(variant)}([^a-z0-9]|$)`,
        "i"
      );

      return pattern.test(prompt);
    });
  });
}

/** Candidate pool rule, shared by the real run and the counterfactual. */
function poolFor(
  prompts: GeneratedPrompt[],
  wanted: number,
  keep: (row: GeneratedPrompt) => boolean
): GeneratedPrompt[] {
  const selectedKept = prompts.filter((row) => row.selected && keep(row));
  return selectedKept.length >= wanted ? selectedKept : prompts.filter(keep);
}

/**
 * Select prompt targets. NEVER throws.
 *
 * Runs selection twice: once for real, and once with brand filtering disabled
 * so brand-filter impact can be measured rather than inferred from a
 * condition that misses cases where the filtered pool still met the target.
 */
export function selectPromptTargets(
  prompts: GeneratedPrompt[],
  count: number,
  clientBrandTerms: string[]
): PromptTargetSelection {
  const wanted = Math.max(1, count);

  const isUnbranded = (row: GeneratedPrompt): boolean =>
    !promptContainsBrandTerm(row.prompt, clientBrandTerms);

  const candidates = poolFor(prompts, wanted, isUnbranded);
  const result = chooseCommercialPromptRowsWithDiagnostics(candidates, wanted);

  const counterfactual = chooseCommercialPromptRowsWithDiagnostics(
    poolFor(prompts, wanted, () => true),
    wanted
  );

  const reachedTarget = result.selected >= wanted;
  const removedByBrandFilter = prompts.length - prompts.filter(isUnbranded).length;
  const brandFilterImpact = Math.max(0, counterfactual.selected - result.selected);
  const inputShortfall = prompts.length < wanted;

  const shortfallFactors: PromptShortfallFactor[] = [];
  if (!reachedTarget) {
    if (inputShortfall) shortfallFactors.push("insufficient_input_candidates");
    if (brandFilterImpact > 0) shortfallFactors.push("brand_filter_removal");
    if (result.rejectedAsDuplicate > 0) shortfallFactors.push("similarity_rejection");
  }

  return {
    rows: result.rows,
    requested: wanted,
    totalPrompts: prompts.length,
    inputShortfall,
    removedByBrandFilter,
    candidatesAfterBrandFilter: candidates.length,
    brandFilterImpact,
    rejectedAsDuplicate: result.rejectedAsDuplicate,
    selected: result.selected,
    reachedTarget,
    rejections: result.rejections,
    shortfallFactors,
  };
}

export function describePromptShortfall(
  selection: PromptTargetSelection
): string {
  const threshold = `${(PROMPT_SIMILARITY_THRESHOLD * 100).toFixed(0)}%`;

  const lines = [
    `Prompt selection reached only ${selection.selected} of ${selection.requested} requested prompts.`,
    `  requested prompts          : ${selection.requested}`,
    `  actually selected          : ${selection.selected}`,
    `  prompts before filtering   : ${selection.totalPrompts}`,
    `  input already short        : ${selection.inputShortfall ? "yes" : "no"}`,
    `  removed by brand filter    : ${selection.removedByBrandFilter}`,
    `  candidates after filter    : ${selection.candidatesAfterBrandFilter}`,
    `  brand filter cost          : ${selection.brandFilterImpact} prompt(s)`,
    `  rejected as duplicates     : ${selection.rejectedAsDuplicate}`,
    `  contributing factors       : ${
      selection.shortfallFactors.length > 0
        ? selection.shortfallFactors.join(", ")
        : "none"
    }`,
  ];

  for (const factor of selection.shortfallFactors) {
    lines.push(`    - ${factor}: ${PROMPT_SHORTFALL_FACTOR_TEXT[factor]}`);
  }

  for (const rejection of selection.rejections) {
    lines.push(
      `  · prompt priority ${rejection.priority} rejected — ` +
      `${(rejection.overlapRatio * 100).toFixed(1)}% token overlap with ` +
      `selected priority ${rejection.blockedByPriority} (threshold ${threshold})`
    );
  }

  lines.push(
    "The candidate pool must exceed the requested count so brand-filtered " +
    "and near-duplicate prompts can be replaced. Add more distinct unbranded " +
    "buyer prompts, or re-run with --allow-fewer-prompts to accept a " +
    "deliberately smaller scan."
  );

  return lines.join("\n");
}
