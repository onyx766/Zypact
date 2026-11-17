/**
 * D-055 — the words the combined pilot report uses for its stored codes.
 * Shared by the client page and the Markdown, so no stored code reaches a
 * reader and both say the same thing.
 */
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
};

export const PORTFOLIO_WEIGHTING_WORDS = "Each readable answer counts once (unweighted).";

export const RETIRED_WORDS =
  "Retired: its measurement could not finish. Only its attempt counts are shown, and it is left out of every total.";

/** The page's words around a stored revision. */
export const PRIVATE_REPORT_WORDS = "Private report";
export const PREVIEW_BANNER_WORDS =
  "Preview for the founder. This revision has not been shared; the customer sees exactly this page once it is.";
export const NEWER_REVISION_WORDS =
  "A newer revision of this report has been shared with you. This page shows an earlier one.";

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

export function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function rangeWords(low: number | null, high: number | null): string {
  if (low === null || high === null) return "no range (no readable answer)";
  return `${pct(low)}–${pct(high)}`;
}

/** The founder console's words for a build the database refused. */
export const BUILD_PILOT_REPORT_REFUSAL: Record<
  "PILOT_NOT_FOUND" | "EVIDENCE_OUTSIDE_PILOT" | "EVIDENCE_INCOMPLETE" | "EVIDENCE_MISMATCH" | "MEASUREMENT_IN_PROGRESS",
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
};

/** The founder console's words for a share the database refused. */
export const SHARE_PILOT_REPORT_REFUSAL: Record<
  "NOT_FOUND" | "BLOCKED" | "ACKNOWLEDGEMENT_REQUIRED" | "NOT_LATEST",
  string
> = {
  NOT_FOUND: "This report revision no longer exists.",
  BLOCKED: "This revision failed its checks and can never be shared.",
  ACKNOWLEDGEMENT_REQUIRED:
    "This revision needs review. Read the whole revision and every reason, then confirm before sharing.",
  NOT_LATEST: "A newer revision of this report exists. Share the newest one.",
};

/** The founder's confirmation before sharing a revision that needs review. Shown only on the preview. */
export const SHARE_NEEDS_REVIEW_PROMPT =
  "I have read this revision in full on this page, and every reason it needs review. Share it? Sharing creates a private link that anyone holding it can open, and the revision can no longer change.";

/** The founder's confirmation before sharing a revision that passed its checks. Shown only on the preview. */
export const SHARE_PASSED_PROMPT =
  "I have read this revision in full on this page. Share it? Sharing creates a private link that anyone holding it can open, and the revision can no longer change.";

export const INTEGRITY_WORDS: Record<"integrity_passed" | "needs_review" | "blocked", string> = {
  integrity_passed: "Passed its checks",
  needs_review: "Needs review",
  blocked: "Blocked",
};
