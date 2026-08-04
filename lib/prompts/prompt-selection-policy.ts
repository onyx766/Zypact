/**
 * Shortfall policy for prompt selection.
 *
 * Separate from selectPromptTargets so the policy can be tested behaviorally
 * without importing scripts/mvp-scan.ts, which runs main() on import.
 *
 * The helper RETURNS a warning string rather than logging, so callers own all
 * output and tests can assert without capturing console.
 */

import type { GeneratedPrompt } from "@/lib/db/types";
import {
  describePromptShortfall,
  type PromptTargetSelection,
} from "@/lib/prompts/select-prompt-targets";

export type PromptShortfallPolicy = "throw" | "warn" | "silent";

export class PromptShortfallError extends Error {
  readonly selection: PromptTargetSelection;

  constructor(selection: PromptTargetSelection) {
    super(describePromptShortfall(selection));
    this.name = "PromptShortfallError";
    this.selection = selection;
  }
}

export interface PromptShortfallPolicyResult {
  rows: GeneratedPrompt[];
  /** Non-null only in "warn" mode with an actual shortfall. */
  warning: string | null;
}

export function applyPromptShortfallPolicy(
  selection: PromptTargetSelection,
  policy: PromptShortfallPolicy
): PromptShortfallPolicyResult {
  if (selection.reachedTarget) {
    return { rows: selection.rows, warning: null };
  }

  if (policy === "throw") {
    throw new PromptShortfallError(selection);
  }

  if (policy === "warn") {
    return {
      rows: selection.rows,
      warning:
        "WARNING: continuing with fewer prompts (--allow-fewer-prompts).\n" +
        describePromptShortfall(selection),
    };
  }

  return { rows: selection.rows, warning: null };
}
