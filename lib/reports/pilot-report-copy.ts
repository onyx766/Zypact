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

export const RETIRED_WORDS = "Retired: its measurement could not finish, so it is left out of the totals.";

export function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function rangeWords(low: number | null, high: number | null): string {
  if (low === null || high === null) return "no range (no readable answer)";
  return `${pct(low)}–${pct(high)}`;
}

/** The founder console's words for a build the database refused. */
export const BUILD_PILOT_REPORT_REFUSAL: Record<
  "PILOT_NOT_FOUND" | "EVIDENCE_OUTSIDE_PILOT" | "EVIDENCE_INCOMPLETE" | "EVIDENCE_MISMATCH",
  string
> = {
  PILOT_NOT_FOUND: "This pilot no longer exists.",
  EVIDENCE_OUTSIDE_PILOT:
    "The report would have included evidence that does not belong to this pilot, so nothing was saved. Tell the engineer.",
  EVIDENCE_INCOMPLETE:
    "The report would have left out some of this pilot's recorded attempts, so nothing was saved. Try again; if it repeats, tell the engineer.",
  EVIDENCE_MISMATCH:
    "A stored answer did not match its recorded fingerprint, so nothing was saved. Tell the engineer.",
};

/** The founder console's words for a share the database refused. */
export const SHARE_PILOT_REPORT_REFUSAL: Record<
  "NOT_FOUND" | "BLOCKED" | "ACKNOWLEDGEMENT_REQUIRED" | "NOT_LATEST",
  string
> = {
  NOT_FOUND: "This report revision no longer exists.",
  BLOCKED: "This revision failed its checks and can never be shared.",
  ACKNOWLEDGEMENT_REQUIRED:
    "This revision needs review. Read the reasons, then confirm you have reviewed them before sharing.",
  NOT_LATEST: "A newer revision of this report exists. Share the newest one.",
};

/** The founder's confirmation before sharing a revision that needs review. */
export const SHARE_NEEDS_REVIEW_PROMPT =
  "This revision needs review. Have you read every reason listed and checked the report? Sharing creates a private link that anyone holding it can open.";

/** The founder's confirmation before sharing a revision that passed its checks. */
export const SHARE_PASSED_PROMPT =
  "Share this revision? It creates a private link that anyone holding it can open. The revision can no longer change.";

export const INTEGRITY_WORDS: Record<"integrity_passed" | "needs_review" | "blocked", string> = {
  integrity_passed: "Passed its checks",
  needs_review: "Needs review",
  blocked: "Blocked",
};
