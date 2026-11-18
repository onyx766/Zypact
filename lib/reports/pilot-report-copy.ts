/**
 * D-055 — the words the combined pilot report uses for its stored codes.
 * Shared by the client page and the Markdown, so no stored code reaches a
 * reader and both say the same thing.
 */
import { STALE_REVISION_WORDS } from "@/lib/pilots/action-copy";
import type { PilotQuestionLabel, PilotQuestionMeasurementState } from "@/lib/reports/pilot-report-types";

export const PILOT_REPORT_TITLE = "Pilot report";

export const LABEL_WORDS: Record<PilotQuestionLabel, string> = {
  observed_consistently_in_sample: "Named in every answer",
  not_observed_consistently_in_sample: "Named in no answer",
  mixed_in_sample: "Named in some answers",
  insufficient_evidence: "Not enough answers",
};

export const STATE_WORDS: Record<PilotQuestionMeasurementState, string> = {
  measured: "Finished",
  not_finished: "Not finished",
  not_started: "Not started",
  stopped: "Stopped before finishing",
  // D-061 (review of phase B) — a review ended it: never "Finished".
  ended_after_review: "Ended after review",
};

export const PORTFOLIO_WEIGHTING_WORDS = "Each readable answer counts once (unweighted).";

/** A retired question with one measurement: retiring needs that measurement to have stopped for good. */
export const RETIRED_WORDS =
  "Retired: its measurement could not finish. Only its attempt counts are shown, and it is left out of every total.";

/**
 * D-061 (review of phase B) — a retired question measured on more than one
 * engine. Retiring needs only one of its measurements to have stopped for
 * good, and stops the question on every engine, so another may have
 * finished; each engine's line says which (retiredMeasurementWords).
 */
export const RETIRED_ONE_OF_SEVERAL_WORDS =
  "Retired: one of its measurements could not finish, so the question was retired on every engine. Only its attempt counts are shown, even for a measurement that had finished, and it is left out of every total.";

/**
 * D-061 (review of phase B) — how far one engine's measurement of a retired
 * question got before it was retired, after "<engine> (" in its line.
 */
export function retiredMeasurementWords(state: PilotQuestionMeasurementState): string {
  switch (state) {
    case "measured":
      return "retired after this measurement finished";
    case "ended_after_review":
      return "retired after this measurement ended after review";
    case "stopped":
      return "retired; this measurement could not finish";
    default:
      return "retired before this measurement finished";
  }
}

/**
 * D-061 (review of phase B) — a measurement a review ended: how many of its
 * planned answers were completed. It is never counted in a total.
 */
export function endedAfterReviewWords(completed: number, planned: number): string {
  return `Ended after review with ${completed} of ${planned} planned answer${planned === 1 ? "" : "s"} completed${
    completed < planned ? ", so this result rests on fewer answers than planned" : ""
  }; it is not counted in the total.`;
}

/** The page's words around a stored revision. */
export const PRIVATE_REPORT_WORDS = "Private report";
export const PREVIEW_BANNER_WORDS =
  "Preview for the founder. This revision has not been shared; the customer sees exactly this page once it is.";

/**
 * D-060 (engineer wording) — what an earlier link shows once a later revision
 * of the same report has been shared (D-059 item 9). The page shows nothing
 * else: no report content, revision, date, token or pointer to the new link.
 */
export const REPLACED_LINK_WORDS =
  "This link has been replaced by a newer version of this report. Please use the most recent link the Zypact team sent you.";

/** D-060 — the founder console's label for a shared revision whose link stopped working (D-059 item 9). */
export const REPLACED_REVISION_WORDS = "Replaced — its link no longer opens";

/** D-060 — the same, on that revision's preview. */
export const REPLACED_REVISION_PREVIEW_WORDS =
  "This revision was shared, and a later revision has been shared since, so its link no longer opens. The link that opens is the newest shared revision's, on the pilot page.";

/**
 * D-060 — the pilot page's note on the newest shared revision when it is
 * older than every revision listed above it, none of which has been shared;
 * the list reads it beside them so its link stays on the page.
 */
export const OLDER_SHARED_REVISION_WORDS =
  "Older than the revisions listed above, none of which has been shared. This is the link that opens.";

/** D-060 — the pilot page's report note: sharing a newer revision ends the earlier link (D-059 item 9). */
export const SHARING_ENDS_EARLIER_LINK_WORDS =
  "Once a newer revision is shared, the link to the one shared before it stops working.";

/** The preview's note above Share (D-055); its last sentence is D-060's (D-059 item 9). */
export const PREVIEW_SHARE_NOTE_WORDS =
  "Read the whole revision below first. Sharing creates the private link and the revision can no longer change. The link to any earlier revision you shared then stops working.";

/** The preview's status line when Share is not offered (D-055, D-057, D-060). */
export const SHARED_REVISION_PREVIEW_WORDS = "This revision has been shared. Its link is on the pilot page.";
export const BLOCKED_REVISION_PREVIEW_WORDS = "This revision failed its checks and can never be shared.";
export const NOT_LATEST_REVISION_PREVIEW_WORDS = "A newer revision exists. Only the newest revision can be shared.";

/**
 * The preview's status line, or null when Share is offered: a shared
 * revision says whether its link still opens (D-060); otherwise a blocked
 * revision, an older one and an out-of-date one (D-057) each say why they
 * cannot be shared.
 */
export function previewStatusWords(r: {
  sharedAt: string | null;
  replaced: boolean;
  integrityStatus: string;
  isLatest: boolean;
  stale: boolean;
}): string | null {
  if (r.sharedAt) return r.replaced ? REPLACED_REVISION_PREVIEW_WORDS : SHARED_REVISION_PREVIEW_WORDS;
  if (r.integrityStatus === "blocked") return BLOCKED_REVISION_PREVIEW_WORDS;
  if (!r.isLatest) return NOT_LATEST_REVISION_PREVIEW_WORDS;
  if (r.stale) return STALE_REVISION_WORDS;
  return null;
}

export function revisionChipWords(revision: number, generatedOn: string, sharedOn: string | null): string {
  return sharedOn
    ? `Revision ${revision}, built ${generatedOn}, shared ${sharedOn}`
    : `Revision ${revision}, built ${generatedOn}, not shared`;
}

/** METHODOLOGY §4: provider, surface and answer mode in words. Never the stored code. */
export const PROVIDER_WORDS: Record<string, string> = {
  perplexity_sonar: "Perplexity Sonar, through Perplexity's API",
  openai_chatgpt: "ChatGPT's model, through OpenAI's API (not the ChatGPT app)",
};
export const UNKNOWN_PROVIDER_WORDS = "an engine this report does not recognise";

export const SURFACE_WORDS: Record<string, string> = {
  answer: "a full written answer to the question",
};
export const UNKNOWN_SURFACE_WORDS = "an answer format this report does not recognise";

export const ANSWER_MODE_WORDS: Record<string, string> = {
  live_perplexity: "live answers from Perplexity's API",
  live_openai_chatgpt: "live answers from OpenAI's API",
  simulated: "simulated answers, not from the provider",
};
export const UNKNOWN_ANSWER_MODE_WORDS = "an answer mode this report does not recognise";

/*
 * D-061 — the setting a ChatGPT protocol records (`<family>:<search>:<model>`,
 * lib/probes/chatgpt.ts) and the rule each engine's sources are read under,
 * in words. Keyed by literal so this module keeps no runtime import (the
 * console's client code loads it); test-pilot-report pins the keys to the
 * adapter's setting families and search modes and to the source-rule
 * constants.
 */
export const SETTING_TIER_WORDS: Record<string, string> = {
  "openai-responses-websearch-v2": "OpenAI's standard tier",
  "openai-responses-websearch-v3": "OpenAI's standard tier",
  "openai-responses-websearch-v4":
    "OpenAI's flex tier, which serves the same model at a lower price and more slowly; a request it refuses for lack of capacity is counted as a failed attempt",
};
export const SETTING_SEARCH_WORDS: Record<string, string> = {
  auto: "available on every answer, and the model decides when to search",
  required: "required on every answer",
};
export const UNKNOWN_SETTING_WORDS = "a setting this report does not recognise";

/** A table's own entry, never an inherited property ("constructor"). */
const own = (table: Record<string, string>, key: string): string | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

/** The service tier a recorded setting version names, in words. */
export function settingTierWords(version: string): string {
  if (version === "") return "not recorded";
  const parts = version.split(":");
  return (parts.length === 3 ? own(SETTING_TIER_WORDS, parts[0]) : undefined) ?? UNKNOWN_SETTING_WORDS;
}

/** Whether a recorded setting version searches the web, in words. */
export function settingSearchWords(version: string): string {
  if (version === "") return "not recorded";
  const parts = version.split(":");
  return (parts.length === 3 ? own(SETTING_SEARCH_WORDS, parts[1]) : undefined) ?? UNKNOWN_SETTING_WORDS;
}

/** The rule a question's sources were read under, in words. */
export function sourceRuleWords(rule: string): string {
  return own(SOURCE_RULE_WORDS, rule) ?? UNKNOWN_SOURCE_RULE_WORDS;
}

export const SOURCE_RULE_WORDS: Record<string, string> = {
  "provider-sources/1":
    "read from each stored answer by fixed rule provider-sources/1. A source is cited when the answer points to it with a numbered reference, and returned but not cited when the engine returned it and the answer does not point to it",
  "openai-responses-sources/1":
    "read from each stored answer by fixed rule openai-responses-sources/1. A source is cited when the answer links to it, and returned but not cited when the engine's web search returned it and the answer does not link to it. A tracking tag OpenAI adds to some links is removed before links are compared",
};
export const UNKNOWN_SOURCE_RULE_WORDS = "read by a rule this report does not recognise";

/*
 * D-061 — a measurement with no readable answer yet, in words. Never "0 of
 * 0": a measurement still being collected, or one that produced nothing
 * readable, says so, beside its attempt counts.
 */

/** The brand table's "Named in" cell for a measurement with no readable answer. */
export const NO_READABLE_ANSWER_CELL: Record<PilotQuestionMeasurementState, string> = {
  not_started: "No answer yet",
  not_finished: "No readable answer yet",
  stopped: "No readable answer",
  measured: "No readable answer",
  ended_after_review: "No readable answer",
};

/** A question section's line for such a measurement, after "<engine> (<state>): ". */
export const NO_READABLE_ANSWER_LINE: Record<PilotQuestionMeasurementState, string> = {
  not_started: "no answer has been collected yet.",
  not_finished: "no readable answer yet; the measurement has not finished.",
  stopped: "it stopped before producing a readable answer.",
  measured: "it finished without a readable answer.",
  ended_after_review: "a review ended it before it produced a readable answer.",
};

/**
 * An engine's other-brands and source sections when no readable answer of it
 * is reported: still being measured, or nothing to report (no answer was
 * readable, or the questions with one are retired, which are never counted).
 */
export function engineNothingReadableWords(engineLabel: string, stillMeasuring: boolean): string {
  return stillMeasuring
    ? `There is no readable ${engineLabel} answer yet, so there is nothing to show here.`
    : `No readable ${engineLabel} answer is reported, so there is nothing to show here.`;
}

export function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function rangeWords(low: number | null, high: number | null): string {
  if (low === null || high === null) return "no range (no readable answer)";
  return `${pct(low)}–${pct(high)}`;
}

/** The founder console's words for a build the database refused. */
export const BUILD_PILOT_REPORT_REFUSAL: Record<
  | "PILOT_NOT_FOUND"
  | "EVIDENCE_OUTSIDE_PILOT"
  | "EVIDENCE_INCOMPLETE"
  | "EVIDENCE_MISMATCH"
  | "MEASUREMENT_IN_PROGRESS"
  | "ACTION_NOT_REVIEWED"
  | "ACTIONS_INCOMPLETE"
  | "ACTIONS_CONTENT_MISMATCH",
  string
> = {
  PILOT_NOT_FOUND: "This pilot no longer exists.",
  EVIDENCE_OUTSIDE_PILOT:
    "The report would have included evidence that does not belong to this pilot, so nothing was saved. Tell the engineer.",
  EVIDENCE_INCOMPLETE:
    "The report would have left out some of this pilot's recorded attempts, so nothing was saved. Try again; if it repeats, tell the engineer.",
  EVIDENCE_MISMATCH:
    "A stored answer changed between reading it and saving the report, usually because a measurement was still finishing, so nothing was saved. Build the report again; if it repeats, tell the engineer.",
  MEASUREMENT_IN_PROGRESS:
    "A measurement for this pilot is still running, waiting to run, or has an answer still being collected. Wait until it finishes, then build the report. If nothing is running, tell the engineer.",
  ACTION_NOT_REVIEWED:
    "A suggested action changed, or was withdrawn, while the report was being built, so nothing was saved. Build the report again.",
  ACTIONS_INCOMPLETE:
    "A suggested action was reviewed while the report was being built, so nothing was saved. Build the report again.",
  ACTIONS_CONTENT_MISMATCH:
    "What the report showed of a suggested action did not match the stored, reviewed action, so nothing was saved. Build the report again; if it repeats, tell the engineer.",
};

/** The founder console's words for a share the database refused. */
export const SHARE_PILOT_REPORT_REFUSAL: Record<
  "NOT_FOUND" | "BLOCKED" | "ACKNOWLEDGEMENT_REQUIRED" | "NOT_LATEST" | "ACTIONS_STALE",
  string
> = {
  ACTIONS_STALE: "An action changed after this revision was built. Build the report again.",
  NOT_FOUND: "This report revision no longer exists.",
  BLOCKED: "This revision failed its checks and can never be shared.",
  ACKNOWLEDGEMENT_REQUIRED:
    "This revision needs review. Read the whole revision and every reason, then confirm before sharing.",
  NOT_LATEST: "A newer revision of this report exists. Share the newest one.",
};

/**
 * The founder's confirmation before sharing a revision that needs review. Shown only on the preview.
 * D-060: both prompts say the link to an earlier shared revision stops working (D-059 item 9).
 */
export const SHARE_NEEDS_REVIEW_PROMPT =
  "I have read this revision in full on this page, and every reason it needs review. Share it? Sharing creates a private link that anyone holding it can open, and the revision can no longer change. Once it is shared, the link to any earlier revision of this report stops working.";

/** The founder's confirmation before sharing a revision that passed its checks. Shown only on the preview. */
export const SHARE_PASSED_PROMPT =
  "I have read this revision in full on this page. Share it? Sharing creates a private link that anyone holding it can open, and the revision can no longer change. Once it is shared, the link to any earlier revision of this report stops working.";

export const INTEGRITY_WORDS: Record<"integrity_passed" | "needs_review" | "blocked", string> = {
  integrity_passed: "Passed its checks",
  needs_review: "Needs review",
  blocked: "Blocked",
};

/* D-057 — suggested actions, in the report's own words. */
export const ACTIONS_HEADING = "Suggested actions";

/** The fixed note every suggested-actions section carries (D-057). */
export const ACTIONS_NOTE =
  "Suggested by the Zypact team from the answers above. These are hypotheses to test, not predictions; we can't say any change will alter what an AI engine answers.";

/** METHODOLOGY §12's remaining fields are taken when an action is tested, not here (D-057). */
export const ACTIONS_NOT_REGISTERED_NOTE =
  "A suggested action names no owner, timing or expected result here. If you choose to test one, the Zypact team registers it with you as a separate step, with its owner, its timing and what would count as a change, no change or an unclear result, before anything is measured again.";

export const ACTION_FIELD_WORDS = {
  observation: "What we observed",
  suggestedAction: "Suggested action",
  whyItMightMatter: "Why this might matter (a hypothesis)",
  alternativeExplanations: "What else could explain it",
  openQuestions: "What we don't know yet",
} as const;

export function actionReviewedWords(reviewedOn: string): string {
  return `Reviewed by the Zypact team on ${reviewedOn}.`;
}

export function actionEvidenceWords(e: {
  ordinal: number;
  engineLabel: string;
  answerNumber: number;
  rawResponseSha256: string;
  sourceUrl: string | null;
  sourceCited: boolean | null;
}): string {
  const base = `Question ${e.ordinal}, ${e.engineLabel} answer ${e.answerNumber} (stored response ${e.rawResponseSha256.slice(0, 12)})`;
  if (!e.sourceUrl) return `${base}.`;
  return `${base}; source ${e.sourceUrl}, ${e.sourceCited ? "cited in that answer" : "returned by the engine but not cited in that answer"}.`;
}
