/**
 * D-057 — the suggested-action words and limits the founder console uses,
 * in a module with no imports so the console's client components can load
 * it. The rules that use them are in action-rules.ts.
 */

export const PILOT_ACTION_TEXT_FIELDS = [
  { key: "title", label: "Title", min: 3, max: 120 },
  { key: "observation", label: "What we observed", min: 10, max: 2000 },
  { key: "suggestedAction", label: "Suggested action", min: 10, max: 2000 },
  { key: "whyItMightMatter", label: "Why this might matter (a hypothesis)", min: 10, max: 2000 },
  { key: "alternativeExplanations", label: "What else could explain it", min: 10, max: 2000 },
  { key: "openQuestions", label: "What we don't know yet", min: 10, max: 2000 },
] as const;

export const MIN_ACTION_EVIDENCE = 1;
export const MAX_ACTION_EVIDENCE = 10;

/** The founder console's words for a save, review or withdrawal the database refused. */
export const SAVE_PILOT_ACTION_REFUSAL: Record<string, string> = {
  PILOT_NOT_FOUND: "This pilot no longer exists.",
  CONFLICT: "This form was already used for different wording. Close it and open it again.",
  LIMIT_REACHED: "This pilot has reached the number of suggested actions, or this action its number of edits.",
  ACTION_NOT_FOUND: "This suggested action no longer exists.",
  ACTION_WITHDRAWN: "This suggested action was withdrawn and can no longer be edited. Write a new one.",
  VERSION_CONFLICT: "Someone saved a newer version of this action. Reload the page and edit the newest one.",
  EVIDENCE_OUTSIDE_PILOT: "One of the linked answers is not one of this pilot's answers.",
  EVIDENCE_NOT_AN_ANSWER: "One of the linked answers did not complete with a stored answer.",
  QUESTION_RETIRED: "One of the linked answers belongs to a retired question.",
  SOURCE_NOT_IN_ANSWER: "One of the linked sources is not among that answer's own sources. Pick it again from the list.",
};

export const REVIEW_PILOT_ACTION_REFUSAL: Record<string, string> = {
  PILOT_NOT_FOUND: "This pilot no longer exists.",
  ACTION_NOT_FOUND: "This suggested action no longer exists.",
  ACTION_WITHDRAWN: "This suggested action was withdrawn.",
  VERSION_NOT_FOUND: "This version no longer exists. Reload the page.",
  NOT_LATEST: "A newer version of this action exists. Reload the page and review the newest one.",
  ALREADY_REVIEWED: "This version is already reviewed.",
  CONFIRMATION_REQUIRED: "Confirm that you have read the action and the answers it rests on.",
};

export const WITHDRAW_PILOT_ACTION_REFUSAL: Record<string, string> = {
  PILOT_NOT_FOUND: "This pilot no longer exists.",
  ACTION_NOT_FOUND: "This suggested action no longer exists.",
  ALREADY_WITHDRAWN: "This suggested action is already withdrawn.",
};

/**
 * The founder's confirmation before a review. The console shows each linked
 * answer's stored text and its source beside the action, so the claim that
 * they were read can be true.
 */
export const REVIEW_PILOT_ACTION_PROMPT =
  "I have read this suggested action, the stored answers it links to (shown under each link) and the sources it names, and it says nothing they do not show. Mark it reviewed? Only reviewed actions appear in a report: a report built before this review can no longer be shared, so build the report again. Any later edit needs a new review.";

/** The founder's prompt before a withdrawal (D-057). */
export const WITHDRAW_PILOT_ACTION_PROMPT =
  "Why withdraw this suggested action? (10-2000 characters)\n\nIt is kept with its history and can no longer be edited. A report built while it was shown can no longer be shared: build the report again. A report already shared keeps what it showed.";

/** Shown with the Edit button and on the edit form (D-057). */
export const EDIT_PILOT_ACTION_NOTE =
  "An edit is saved as a new draft version. Until you review it, the action is in no report, and a report built with the earlier version can no longer be shared: review the edit, then build the report again.";

/** A revision whose listed actions are no longer the pilot's reviewed, current ones (D-057). */
export const STALE_REVISION_WORDS =
  "Out of date: a suggested action was reviewed, edited or withdrawn after this revision was built. It cannot be shared. Build the report again.";

export type PilotActionStatus = "draft" | "reviewed" | "withdrawn";

export const PILOT_ACTION_STATUS_WORDS: Record<PilotActionStatus, string> = {
  draft: "Draft: not in reports until reviewed",
  reviewed: "Reviewed: appears in the next report built",
  withdrawn: "Withdrawn",
};
