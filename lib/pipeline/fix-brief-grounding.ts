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

import {
  normalizeCompetitorKey,
  normalizePromptKey,
} from "@/lib/pipeline/scorecard-competitors";
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
  /**
   * Every competitor named anywhere in the matched gap's evidence, across
   * all of its buyer questions. Generated prose may mention those in
   * `promptLocalCompetitors`; naming any other known competitor is
   * cross-prompt contamination and is rejected.
   */
  knownCompetitors: string[];
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
      knownCompetitors: Array.from(
        new Set((matched.gap.promptEvidence ?? []).flatMap((e) => e.competitors))
      ).filter((n) => n.trim() !== ""),
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
const UNSUPPORTED_NUMERIC =
  /\b\d+(?:\.\d+)?\s*(?:%|percent|x\b|×)|\b\d+\s*(?:days?|weeks?|months?)\b|#\s?\d+\b|\b\d+\s*(?:ranking|rank|position|place|spot)s?\b/i;

/**
 * Rejects generated impact text that asserts a magnitude or timeline.
 *
 * Nothing in a snapshot measures uplift, so a number here is invention
 * regardless of how plausible it reads. Qualitative claims pass.
 */
/** Outcome nouns a magnitude claim would attach to. */
const OUTCOME_NOUN =
  "(?:visibility|share of voice|share|recommendation rate|recommendations?|mention rate|" +
  "mentions?|traffic|revenue|rankings?|rank|positions?|conversions?|citations?|leads?|pipeline)";
/**
 * Word-form multipliers ("double AI visibility"). The negative lookahead
 * keeps "double-check the comparison table" — an implementation
 * instruction — out of the claim class.
 */
const UNSUPPORTED_MULTIPLIER = new RegExp(
  `\\b(?:doubl|tripl|quadrupl|halv)(?:e|es|ed|ing)\\b(?!-)[^.]{0,40}\\b${OUTCOME_NOUN}\\b`,
  "i"
);

export function hasUnsupportedQuantifiedClaim(text: string): boolean {
  return UNSUPPORTED_NUMERIC.test(text) || UNSUPPORTED_MULTIPLIER.test(text);
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

/* -------------------------------------------------------------------------- */
/*  Generated free-text validation                                            */
/* -------------------------------------------------------------------------- */

/**
 * Whether `text` names `competitor` as an entity.
 *
 * Matched on normalized word boundaries rather than raw substring, so
 * "Salesforce" does not match inside "Salesforce Revenue Intelligence" when
 * only the longer name is known, and "People.ai" survives its punctuation.
 */
function mentionsCompetitor(text: string, competitor: string): boolean {
  const needle = normalizeCompetitorKey(competitor);
  if (needle === "") return false;
  const hay = ` ${normalizeCompetitorKey(text).replace(/[^a-z0-9. ]+/g, " ").replace(/\s+/g, " ")} `;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Allow sentence punctuation to follow the entity ("…against Dreamdata.").
  return new RegExp(`(^| )${esc}[.,;:!?]?( |$)`).test(hay);
}

/**
 * Known competitors named in `text` that the selected buyer question does
 * not license.
 *
 * Scope note: this detects contamination from the *stored* competitor
 * universe — the products the Gap Map recorded for this gap's other buyer
 * questions. That is exactly the production defect. It is not named-entity
 * recognition and makes no claim about brands absent from stored evidence.
 */
export function foreignCompetitorsMentioned(
  text: string,
  allowed: readonly string[],
  known: readonly string[]
): string[] {
  const allowedKeys = new Set(allowed.map(normalizeCompetitorKey));
  return known.filter(
    (name) => !allowedKeys.has(normalizeCompetitorKey(name)) && mentionsCompetitor(text, name)
  );
}

/**
 * Assertions about *why* an AI system produced a recommendation, or promises
 * about how it will behave.
 *
 * Deliberately narrow: it targets a subject (the AI/model/assistant, or a
 * competitor winning) bound to a reason or a trust/recommend promise. A scan
 * records an outcome and never a mechanism, so these are unsupported
 * regardless of how they are phrased.
 */
const AI_SUBJECT =
  "(?:ai|a\\.i\\.|llm|model|assistant|assistants|chatgpt|perplexity|gemini|claude|search engines?)";
/** Verbs describing a recommendation outcome an AI system produced. */
const OUTCOME_VERB =
  "(?:favou?r(?:s|ed|ing)?|prefer(?:s|red|ring)?|choos(?:e|es|ing)|chose|overlook(?:s|ed|ing)?|" +
  "surfac(?:e|es|ed|ing)|rank(?:s|ed|ing)?|recommend(?:s|ed|ing)?|trust(?:s|ed|ing)?|" +
  "ignor(?:e|es|ed|ing)|omit(?:s|ted|ting)?|prioriti[sz]e[sd]?|list(?:s|ed)?)";
/** Connectives that bind an outcome to an asserted reason. */
const CAUSAL_CONNECTIVE =
  "(?:because|due to|since|as|thanks to|owing to|on account of)";

/**
 * Assertions about *why* an AI system produced a recommendation, or promises
 * about how it will behave.
 *
 * Deliberately scoped: each pattern requires an AI/model subject (or a
 * passive recommendation outcome) bound to a reason or a future promise. A
 * causal sentence with no AI recommendation in it — "Create a page because
 * the sales team needs one" — is not this class and stays allowed.
 *
 * A scan records an outcome, never a mechanism, so these are unsupported
 * however they are phrased.
 */
const AI_CAUSAL_PATTERNS: RegExp[] = [
  // "AI favors Clari due to stronger content" / "The model prefers Gong since …"
  new RegExp(`${AI_SUBJECT}\\b[^.]{0,60}\\b${OUTCOME_VERB}\\b[^.]{0,60}\\b${CAUSAL_CONNECTIVE}\\b`, "i"),
  // Fronted cause: "Because <brand> lacks proof, AI recommends alternatives."
  new RegExp(`\\b${CAUSAL_CONNECTIVE}\\b[^.]{0,120}?\\b${AI_SUBJECT}\\b[^.]{0,40}\\b${OUTCOME_VERB}\\b`, "i"),
  // Passive outcome + reason: "<brand> is overlooked because its site …"
  new RegExp(`\\b(?:is|was|are|were|isn't|is not|aren't)\\b[^.]{0,40}\\b(?:${OUTCOME_VERB})\\b[^.]{0,60}\\b${CAUSAL_CONNECTIVE}\\b`, "i"),
  // Noun cause: "The lack of third-party proof is why <brand> isn't recommended."
  new RegExp(`\\bis (?:the reason )?why\\b[^.]{0,80}\\b${OUTCOME_VERB}\\b`, "i"),
  new RegExp(`\\bthe reason\\b[^.]{0,60}\\b${OUTCOME_VERB}\\b`, "i"),
  // Forward promise: "will cause AI systems to recommend …" / "make AI trust …"
  new RegExp(`\\b(?:will|would|should|can|could)\\b[^.]{0,40}\\b(?:cause|make|lead|get|drive|push)\\b[^.]{0,40}${AI_SUBJECT}\\b`, "i"),
  new RegExp(`${AI_SUBJECT}\\b[^.]{0,60}\\b(?:will|would|should)\\b[^.]{0,40}\\b(?:start|begin)?\\s*\\b${OUTCOME_VERB}\\b`, "i"),
  // "AI could not find / had no basis / did not trust"
  new RegExp(`${AI_SUBJECT}\\b[^.]{0,80}\\b(?:could not|couldn't|cannot|can't|did not|didn't|does not|doesn't|has no|had no)\\b[^.]{0,40}\\b(?:find|see|trust|basis|reason|recogni[sz]e|understand)\\b`, "i"),
  // "Clari wins because AI sees it as more authoritative."
  /\b(?:wins?|won|outranks?|beats?)\b[^.]{0,60}\bbecause\b/i,
];

/** Sentences asserting an unproven AI causal mechanism. */
export function assertsAiCausalClaim(text: string): boolean {
  return AI_CAUSAL_PATTERNS.some((re) => re.test(text));
}

export interface FixBriefFieldIssue {
  field: "recommendedFix" | "expectedImpact";
  kind: "foreign_competitor" | "unsupported_quantified_claim" | "unsupported_causal_claim";
  detail: string;
}

/**
 * Validates the fields the model still writes.
 *
 * Runs before persistence and before the pipeline returns, and is wired
 * through the schema so a violation re-enters the existing single repair
 * retry rather than adding a provider call.
 */
export function validateFixBriefGeneratedFields(params: {
  recommendedFix: string;
  expectedImpact: string;
  allowedCompetitors: readonly string[];
  knownCompetitors: readonly string[];
}): FixBriefFieldIssue[] {
  const { allowedCompetitors, knownCompetitors } = params;
  const issues: FixBriefFieldIssue[] = [];

  for (const field of ["recommendedFix", "expectedImpact"] as const) {
    const text = params[field];
    const foreign = foreignCompetitorsMentioned(text, allowedCompetitors, knownCompetitors);
    if (foreign.length > 0) {
      issues.push({
        field, kind: "foreign_competitor",
        detail: `names ${foreign.join(", ")}, evidenced for a different buyer question`,
      });
    }
    if (hasUnsupportedQuantifiedClaim(text)) {
      issues.push({
        field, kind: "unsupported_quantified_claim",
        detail: "asserts a magnitude or timeline the stored evidence does not measure",
      });
    }
    if (assertsAiCausalClaim(text)) {
      issues.push({
        field, kind: "unsupported_causal_claim",
        detail: "asserts why an AI system produced its recommendation",
      });
    }
  }
  return issues;
}
