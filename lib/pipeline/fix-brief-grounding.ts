/**
 * Deterministic grounding for the Fix Brief.
 *
 * A prioritized dimension gap legitimately spans several buyer questions.
 * The `gaps` table row that carries it does not: it keeps `explanation` —
 * which PR #23 builds from the *global union* of every competitor across
 * every affected prompt — and `affectedPrompts`, but no per-prompt
 * provenance. Handing that row to the Fix Brief agent let competitors from
 * one buyer question explain a loss on another. On the first real snapshot
 * that produced a brief naming Dreamdata and Ruler Analytics — attribution
 * competitors — as the products that beat the client on a revenue
 * intelligence comparison they never appeared in.
 *
 * PR #23 already stores the provenance, inside `gap_maps.json` as
 * `prioritizedGaps[].promptEvidence`. This module re-reads it and narrows a
 * gap down to exactly one buyer question and that question's own
 * competitors, before any model sees anything. It never consults the
 * persisted global-union `explanation`.
 *
 * Every ambiguity fails closed. A Fix Brief that cannot be grounded is not
 * generated at all — there is no fallback to project-wide evidence, because
 * a plausible-looking ungrounded brief is worse than no brief.
 *
 * Pure: no database, no provider, no network.
 */

import { normalizePromptKey } from "@/lib/pipeline/scorecard-competitors";
import type { PrioritizedGap } from "@/lib/schemas/gap-map.schema";
import type { Gap, ProbeResult } from "@/lib/db/types";

/** Verdicts a recovery Fix Brief may be built from. */
export type RecoveryVerdict = "lost" | "partial";

export interface FixBriefGroundingContext {
  gapId: string;
  gapType: string;
  severity: string;
  suggestedFixDirection: string;
  /** The single buyer question this brief addresses. */
  selectedPrompt: string;
  selectedVerdict: RecoveryVerdict;
  /** Competitors evidenced for `selectedPrompt` only. */
  promptLocalCompetitors: string[];
  /** The probe run backing the selection. */
  probeResultId: string;
  /** Grounded, prompt-scoped replacement for the global-union explanation. */
  groundedExplanation: string;
}

export type FixBriefGroundingResult =
  | { ok: true; context: FixBriefGroundingContext }
  | { ok: false; reason: string };

/** Canonical set key for an affected-prompt list, order-independent. */
function promptSetKey(prompts: readonly string[]): string {
  return Array.from(new Set(prompts.map(normalizePromptKey))).sort().join("|");
}

function isRecoveryVerdict(v: string): v is RecoveryVerdict {
  return v === "lost" || v === "partial";
}

/**
 * Locates the `PrioritizedGap` a persisted `gaps` row came from.
 *
 * Matching uses structured fields only — dimension, then the canonical
 * affected-prompt set, then severity to disambiguate. `explanation` is
 * deliberately not used: it is the contaminated free text this repair
 * exists to stop trusting, and matching on prose would reintroduce it as a
 * load-bearing input.
 *
 * Requires exactly one match. Zero and many both fail closed.
 */
export function matchGapRowToPrioritizedGap(
  gapRow: Pick<Gap, "type" | "severity" | "affectedPrompts">,
  prioritizedGaps: readonly PrioritizedGap[]
): { ok: true; gap: PrioritizedGap } | { ok: false; reason: string } {
  const rowPrompts = promptSetKey(gapRow.affectedPrompts);

  let candidates = prioritizedGaps.filter(
    (g) => g.type === gapRow.type && promptSetKey(g.affectedPrompts) === rowPrompts
  );

  if (candidates.length > 1) {
    // Severity only ever narrows; it never rescues a zero-match.
    const bySeverity = candidates.filter((g) => g.severity === gapRow.severity);
    if (bySeverity.length > 0) candidates = bySeverity;
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      reason:
        `No prioritized gap in the latest Gap Map matches gap type "${gapRow.type}" ` +
        `with the same affected-prompt set. The Gap Map may be older than this gap row.`,
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      reason:
        `Ambiguous provenance: ${candidates.length} prioritized gaps match gap type ` +
        `"${gapRow.type}" with the same affected-prompt set and severity.`,
    };
  }
  return { ok: true, gap: candidates[0] };
}

/**
 * Chooses the probe run the brief will be written about.
 *
 * Only runs whose prompt matches one of this gap's `promptEvidence` entries
 * are eligible, and only entries with a recovery verdict. There is no
 * project-wide fallback: the previous implementation would reach for "the
 * latest lost probe anywhere on the project" when nothing matched, which is
 * how a brief could end up describing a buyer question the gap says nothing
 * about.
 *
 * Preference among eligible runs mirrors the prior ordering — `lost` before
 * `partial`, newest first — so selection stays stable for gaps that were
 * already resolving correctly.
 */
export function selectGroundedProbeResult(
  prioritizedGap: PrioritizedGap,
  probeResults: readonly ProbeResult[]
): { ok: true; probeResult: ProbeResult } | { ok: false; reason: string } {
  const evidence = prioritizedGap.promptEvidence ?? [];
  if (evidence.length === 0) {
    return {
      ok: false,
      reason:
        "The matched prioritized gap carries no promptEvidence, so no competitor " +
        "can be attributed to a specific buyer question.",
    };
  }

  const eligibleKeys = new Map<string, RecoveryVerdict>();
  for (const entry of evidence) {
    if (!isRecoveryVerdict(entry.verdict)) continue;
    eligibleKeys.set(normalizePromptKey(entry.prompt), entry.verdict);
  }
  if (eligibleKeys.size === 0) {
    return {
      ok: false,
      reason:
        "No promptEvidence entry has a recovery-eligible verdict (lost or partial); " +
        "a won or not_relevant question is not a basis for a Fix Brief.",
    };
  }

  const eligible = probeResults.filter((r) =>
    eligibleKeys.has(normalizePromptKey(r.prompt))
  );
  if (eligible.length === 0) {
    return {
      ok: false,
      reason:
        "No stored probe run corresponds to any recovery-eligible buyer question " +
        "in this gap's promptEvidence.",
    };
  }

  const sorted = [...eligible].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const lostFirst = [
    ...sorted.filter((r) => eligibleKeys.get(normalizePromptKey(r.prompt)) === "lost"),
    ...sorted.filter((r) => eligibleKeys.get(normalizePromptKey(r.prompt)) === "partial"),
  ];
  return { ok: true, probeResult: lostFirst[0] };
}

/**
 * Narrows a gap to one buyer question and that question's own competitors.
 *
 * The returned context is everything downstream is allowed to know. Note
 * what is absent: `gapRow.explanation`. It is never read here and must not
 * be forwarded separately — sanitizing the union out of that prose would be
 * a string-matching guess, where simply not using it is a guarantee.
 */
export function buildFixBriefGroundingContext(params: {
  gapRow: Gap;
  prioritizedGaps: readonly PrioritizedGap[];
  probeResults: readonly ProbeResult[];
}): FixBriefGroundingResult {
  const { gapRow, prioritizedGaps, probeResults } = params;

  const matched = matchGapRowToPrioritizedGap(gapRow, prioritizedGaps);
  if (!matched.ok) return { ok: false, reason: matched.reason };

  const picked = selectGroundedProbeResult(matched.gap, probeResults);
  if (!picked.ok) return { ok: false, reason: picked.reason };

  const probeKey = normalizePromptKey(picked.probeResult.prompt);
  const entries = (matched.gap.promptEvidence ?? []).filter(
    (e) => normalizePromptKey(e.prompt) === probeKey
  );

  if (entries.length === 0) {
    return {
      ok: false,
      reason: "The selected probe run has no matching promptEvidence entry.",
    };
  }
  if (entries.length > 1) {
    return {
      ok: false,
      reason:
        `Ambiguous provenance: ${entries.length} promptEvidence entries normalize to ` +
        "the same buyer question.",
    };
  }

  const entry = entries[0];
  if (!isRecoveryVerdict(entry.verdict)) {
    return {
      ok: false,
      reason: `Buyer question verdict "${entry.verdict}" is not recovery-eligible.`,
    };
  }

  // Deduplicate but keep the stored order — it reflects recommendation
  // strength from the Gap Map, and re-sorting would discard that.
  const promptLocalCompetitors = Array.from(new Set(entry.competitors)).filter(
    (n) => n.trim() !== ""
  );

  return {
    ok: true,
    context: {
      gapId: gapRow.id,
      gapType: gapRow.type,
      severity: gapRow.severity,
      suggestedFixDirection: gapRow.suggestedFixDirection,
      selectedPrompt: entry.prompt,
      selectedVerdict: entry.verdict,
      promptLocalCompetitors,
      probeResultId: picked.probeResult.id,
      groundedExplanation: buildGroundedExplanation(entry.prompt, entry.verdict, promptLocalCompetitors),
    },
  };
}

/** Prompt-scoped replacement for the persisted global-union explanation. */
export function buildGroundedExplanation(
  prompt: string,
  verdict: RecoveryVerdict,
  competitors: readonly string[]
): string {
  const outcome =
    verdict === "lost"
      ? "was absent from the recommendations"
      : "appeared but was not prioritized";
  const named =
    competitors.length > 0
      ? ` Products recommended for this question in those runs: ${competitors.join(", ")}.`
      : " No competing product was recorded for this question in those runs.";
  return `For the buyer question "${prompt}", the brand ${outcome} in the stored runs examined.${named}`;
}

/** DB stores `competitorRecommended` as one string; format it deterministically. */
export function formatCompetitorRecommended(competitors: readonly string[]): string {
  return competitors.length === 0
    ? "No competing product was recorded for this buyer question in the stored runs."
    : competitors.join(", ");
}

/**
 * The persisted `rootCause`, built from stored evidence rather than model prose.
 *
 * A scan proves an outcome, not a mechanism. The model previously wrote
 * things like "the AI had no basis to recommend HockeyStack because it did
 * not find relevant content" — a causal claim about a system's internal
 * reasoning that no stored artifact supports. Rather than trying to detect
 * such phrasing after the fact, the field is simply not the model's to
 * write: this states what was observed and says plainly that the cause is
 * not established.
 */
export function buildDeterministicRootCause(context: FixBriefGroundingContext): string {
  const outcome =
    context.selectedVerdict === "lost"
      ? "was not recommended"
      : "was mentioned but not prioritized";
  const rivals =
    context.promptLocalCompetitors.length > 0
      ? ` The runs recommended ${context.promptLocalCompetitors.join(", ")} for this question.`
      : "";
  return (
    `Observed: for the buyer question "${context.selectedPrompt}", the brand ${outcome} ` +
    `in the stored runs examined.${rivals} The stored evidence records this outcome ` +
    `but does not establish why the AI system produced it.`
  );
}

/** Numeric-claim shapes that stored evidence cannot support. */
const UNSUPPORTED_NUMERIC = /\b\d+(?:\.\d+)?\s*(?:%|percent|x\b|×)|\b(?:\d+\s*(?:days?|weeks?|months?)\b)|#\s?\d+\b/i;

/**
 * Rejects generated impact text that asserts a magnitude or timeline.
 *
 * Nothing in a snapshot measures uplift, so a number here is invention
 * regardless of how plausible it reads. Qualitative claims pass.
 */
export function hasUnsupportedQuantifiedClaim(text: string): boolean {
  return UNSUPPORTED_NUMERIC.test(text);
}

/**
 * Overlays the deterministic fields onto model output.
 *
 * Kept here, pure, rather than inline in the pipeline so the guarantee is
 * directly testable: whatever the model returns for `lostPrompt`,
 * `competitorRecommended` and `rootCause` is discarded, and quantified
 * impact claims are replaced.
 */
export function buildGroundedFixBriefOutput<
  T extends {
    lostPrompt: string;
    competitorRecommended: string;
    rootCause: string;
    expectedImpact: string;
  },
>(params: { agentOutput: T; context: FixBriefGroundingContext; genericImpact: string }): T {
  const { agentOutput, context, genericImpact } = params;
  return {
    ...agentOutput,
    lostPrompt: context.selectedPrompt,
    competitorRecommended: formatCompetitorRecommended(context.promptLocalCompetitors),
    rootCause: buildDeterministicRootCause(context),
    expectedImpact: hasUnsupportedQuantifiedClaim(agentOutput.expectedImpact)
      ? genericImpact
      : agentOutput.expectedImpact,
  };
}
