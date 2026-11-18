/**
 * D-062 — the founder's words for the pilot retest: every outcome and
 * refusal of the six group steps (20261109190000 §2.6), the confirmation
 * prompts, and the console's labels and warnings. Nothing from a request is
 * ever echoed. No stored code reaches the console except through these maps.
 *
 * Pure, with type-only imports, so the console's client code can load it.
 */
import type {
  AbandonPilotRetestOutcome,
  AddPilotRetestNoteOutcome,
  ConfirmPilotRetestImplementationOutcome,
  PilotQuestionEngine,
  PreparePilotRetestsOutcome,
  RegisterPilotRetestOutcome,
  RequeuePilotRetestJobOutcome,
} from "@/lib/db/types";

const ENGINE: Record<PilotQuestionEngine, string> = { perplexity_sonar: "Perplexity", openai_chatgpt: "ChatGPT" };

/** The gate's refusal (ZYPACT_PILOT_RETEST_ENABLED unset): retests ship switched off until D-062 is confirmed. */
export const PILOT_RETEST_NOT_ENABLED =
  "Pilot retests are switched off on this server. Withdrawing a change, logging another change and resolving a held retest stay available.";

export const PILOT_RETEST_UNAVAILABLE = "Pilot retests are temporarily unavailable.";

export const PILOT_RETEST_STEP_FAILED_TEXT =
  "The step could not finish and nothing was changed. Try again; if it repeats, tell the engineer.";

/* ---------------------------------------------------------------- register */

export const REGISTER_RETEST_DONE_TEXT =
  "Change registered: one approved intervention per question and engine. Nothing runs until the change is recorded as live, its waiting period ends and you press Run.";

export const REGISTER_RETEST_REFUSAL: Record<Exclude<RegisterPilotRetestOutcome, "REGISTERED" | "ALREADY_REGISTERED">, string> = {
  IDEMPOTENCY_KEY_CONFLICT: "This form already registered a different change. Reload the page before registering again.",
  PILOT_NOT_FOUND: "This pilot no longer exists.",
  CONFIRMATION_REQUIRED: "Confirm the customer's written approval first.",
  PILOT_CLOSED: "This pilot is closed or past its end date, so no change can be registered.",
  RETEST_ALREADY_REGISTERED: "A change is already registered for this pilot. Withdraw it before registering another.",
  RETEST_LIMIT_REACHED: "This pilot already had two registered changes, the most it can have.",
  WINDOW_PAST_PILOT_END:
    "Too late for this waiting period: the change could not go live, wait and be measured again at least 7 days before the pilot ends. Choose a shorter waiting period, or none can fit.",
  QUESTION_NOT_LIVE: "A chosen question is not one of this pilot's live questions.",
  QUESTION_IN_EARLIER_LIVE_CHANGE:
    "A chosen question was in an earlier change that went live. Its answers can never be measured again for another change.",
  BASELINE_MISSING: "A chosen question is not measured on both Perplexity and ChatGPT.",
  BASELINE_PLAN_NOT_FIVE_RUNS: "A chosen question's measurement does not plan 5 answers.",
  BASELINE_NOT_FINISHED: "A chosen question's measurement has not finished on both engines.",
  BASELINE_NOT_FIVE_READABLE: "A chosen question does not have 5 readable answers on both engines.",
  BASELINE_BEFORE_EARLIER_CHANGE:
    "A chosen question's answers were collected before an earlier change went live, so they cannot be the before-measurement of a new change.",
  BASELINE_ALREADY_REGISTERED: "A chosen question's measurement already has a live intervention.",
  SOURCE_ACTION_NOT_CURRENT:
    "A chosen suggested action changed, was withdrawn, or is not reviewed any more. Reload the page and pick again.",
};

/** A per-question refusal, naming the question and, where it is about one measurement, the engine. */
export function registerRefusalText(
  outcome: Exclude<RegisterPilotRetestOutcome, "REGISTERED" | "ALREADY_REGISTERED">,
  where: { ordinal: number | null; engine: PilotQuestionEngine | null }
): string {
  const base = REGISTER_RETEST_REFUSAL[outcome];
  if (where.ordinal === null) return base;
  return `Question ${where.ordinal}${where.engine ? ` (${ENGINE[where.engine]})` : ""}: ${base}`;
}

/** Why a question cannot be chosen now, beside it in the register panel (§2.6 step 7, in words). */
export const RETEST_QUESTION_REFUSAL_WORDS: Record<string, string> = {
  QUESTION_NOT_LIVE: "Retired.",
  QUESTION_IN_EARLIER_LIVE_CHANGE: "In an earlier change that went live; never measured again for another change.",
  BASELINE_MISSING: "Not measured on this engine.",
  BASELINE_PLAN_NOT_FIVE_RUNS: "Its measurement does not plan 5 answers on this engine.",
  BASELINE_NOT_FINISHED: "Its measurement has not finished on this engine.",
  BASELINE_NOT_FIVE_READABLE: "Fewer than 5 readable answers on this engine.",
  BASELINE_BEFORE_EARLIER_CHANGE: "Its answers on this engine were collected before an earlier change went live.",
  BASELINE_ALREADY_REGISTERED: "Its measurement on this engine already has a live intervention.",
};

export function retestQuestionRefusalWords(refusal: string, engine: PilotQuestionEngine | null): string {
  const words = RETEST_QUESTION_REFUSAL_WORDS[refusal] ?? "Cannot be chosen.";
  return engine ? `${ENGINE[engine]}: ${words}` : words;
}

/** The hint under the hypothesis (M20). */
export const RETEST_HYPOTHESIS_HINT =
  "It is shown on every card of this change; do not quote one question's or engine's figures in it.";

/** The yes/no that sets thresholdBelowLimit (M2). */
export const RETEST_THRESHOLD_QUESTION = "Is the change the customer said would matter smaller than 60 points?";

/** The register tickbox (§3.4). */
export const RETEST_REGISTER_CONFIRMATION =
  "The customer approved this change in writing on the date above, chose these questions, and was told before paying that a retest can show only a change of 60 points or more.";
export const RETEST_REGISTER_BELOW_LIMIT_CONFIRMATION = "They know this retest cannot settle the change they named.";

/* ---------------------------------------------------------------- record as live */

export function confirmRetestDoneText(windowClosesAt: string): string {
  return `Recorded as live. The waiting period ends ${windowClosesAt.slice(0, 16).replace("T", " ")} UTC; prepare the retests after that.`;
}

export const CONFIRM_RETEST_REFUSAL: Record<Exclude<ConfirmPilotRetestImplementationOutcome, "IMPLEMENTED" | "ALREADY_IMPLEMENTED">, string> = {
  PILOT_NOT_FOUND: "This pilot no longer exists.",
  RETEST_NOT_FOUND: "This registered change no longer exists. Reload the page.",
  RETEST_ABANDONED: "This change was withdrawn.",
  CONFIRMATION_REQUIRED: "Confirm first.",
  PILOT_CLOSED: "This pilot is closed or past its end date.",
  WENT_LIVE_BEFORE_REGISTRATION:
    "The change went live before it was registered, so the answers before it are not a clean before-measurement. Withdraw this change.",
  WINDOW_PAST_PILOT_END:
    "Too late: the waiting period would end less than 7 days before the pilot ends. Withdraw this change.",
  NOTE_LIMIT_REACHED: "This change already has 20 notes, so the difference could not be logged.",
};

/** The prompt before recording the change as live: its window and its rules (§3.4). */
export function confirmRetestPrompt(observationDays: number, closesOn: string): string {
  return `Record the change as live now? The waiting period starts now, lasts ${observationDays} days and ends on ${closesOn}; it can never be moved. The change must not have gone live before it was registered. This applies to every question and engine of the change.`;
}

/* ---------------------------------------------------------------- prepare */

export function prepareRetestDoneText(prepared: number): string {
  return `${prepared} retests prepared and waiting for Run. Nothing has run or been spent. Run each one from its cell below, Perplexity first.`;
}

export const PREPARE_RETEST_REFUSAL: Record<Exclude<PreparePilotRetestsOutcome, "PREPARED" | "ALREADY_PREPARED">, string> = {
  PILOT_NOT_FOUND: "This pilot no longer exists.",
  RETEST_NOT_FOUND: "This registered change no longer exists. Reload the page.",
  RETEST_ABANDONED: "This change was withdrawn.",
  NOT_IMPLEMENTED: "Record the change as live first.",
  PILOT_CLOSED: "This pilot is closed or past its end date.",
  WINDOW_OPEN: "The waiting period has not ended yet. A pilot retest never starts early.",
  MEMBER_NOT_ELIGIBLE: "A question's retest is not ready yet. Reload the page; if it repeats, tell the engineer.",
};

/** The prepare prompt (§3.4, S9). */
export const PREPARE_RETEST_PROMPT =
  "Prepare the retests? Preparing spends nothing: it queues one retest per question and engine, and each Run is pressed separately. Under a $10 daily limit about 3 ChatGPT retests fit in 24 hours, and all 5 fit at $20. Run the Perplexity retests first.";

/* ---------------------------------------------------------------- abandon */

export const ABANDON_RETEST_DONE_TEXT = "The change was withdrawn, with every question and engine in it.";

export const ABANDON_RETEST_REFUSAL: Record<Exclude<AbandonPilotRetestOutcome, "ABANDONED" | "ALREADY_ABANDONED">, string> = {
  PILOT_NOT_FOUND: "This pilot no longer exists.",
  RETEST_NOT_FOUND: "This registered change no longer exists. Reload the page.",
  CONFIRMATION_REQUIRED: "Confirm first.",
  RETEST_JOB_BUSY: "A retest is being started or claimed right now. Wait a moment and try again.",
  RETEST_STARTED: "A retest has already collected an answer, so the change can no longer be withdrawn.",
  RETEST_RUN_PENDING: "A Run of a retest is waiting for the worker. Wait until it has started or expired.",
};

/** The abandon prompt (§3.4, M6). */
export const ABANDON_RETEST_PROMPT =
  "Why withdraw this change? (10-2000 characters)\n\nEvery question and engine of the change is withdrawn together, and this is final. If the change went live, its questions can never be measured again for another change. The customer's report says the change was withdrawn, without this reason.";

/* ---------------------------------------------------------------- requeue */

export function requeueRetestDoneText(engine: PilotQuestionEngine): string {
  return `Queued again. Press Run for this retest on ${ENGINE[engine]}.`;
}

export const REQUEUE_RETEST_REFUSAL: Record<Exclude<RequeuePilotRetestJobOutcome, "REQUEUED" | "ALREADY_QUEUED">, string> = {
  PILOT_NOT_FOUND: "This pilot no longer exists.",
  RETEST_NOT_FOUND: "This registered change no longer exists. Reload the page.",
  RETEST_ABANDONED: "This change was withdrawn.",
  NOT_PREPARED: "The retests are not prepared yet.",
  MEMBER_NOT_FOUND: "This question is not measured again on that engine in this change.",
  PILOT_CLOSED: "This pilot is closed or outside its dates.",
  RETEST_JOB_BUSY: "This retest is being started or claimed right now. Wait a moment and try again.",
  JOB_NOT_STOPPED_BEFORE_ANSWERS:
    "Only a retest that stopped before any answer can be queued again. Retry it, or resolve its review, instead.",
  REQUEUE_LIMIT_REACHED: "This retest was already queued again 3 times, the most allowed.",
};

/** The "Queue again" confirmation (§3.4). */
export const REQUEUE_RETEST_PROMPT =
  "This retest stopped before any answer, so nothing was spent. Queue it again? (Say why, 10-2000 characters.)";

/* ---------------------------------------------------------------- notes */

export const NOTE_RETEST_DONE_TEXT = "Note added to the log of other changes.";

export const NOTE_RETEST_REFUSAL: Record<Exclude<AddPilotRetestNoteOutcome, "ADDED" | "ALREADY_ADDED">, string> = {
  IDEMPOTENCY_KEY_CONFLICT: "This form already added a different note. Reload the page before adding another.",
  PILOT_NOT_FOUND: "This pilot no longer exists.",
  RETEST_NOT_FOUND: "This registered change no longer exists. Reload the page.",
  RETEST_ABANDONED: "This change was withdrawn, so its log is closed.",
  NOTED_BEFORE_PILOT: "The date is before the pilot started.",
  CORRECTED_NOTE_NOT_FOUND: "The note being corrected is not one of this change's notes.",
  NOTE_LIMIT_REACHED: "This change already has 20 notes, the most allowed.",
};

/* ---------------------------------------------------------------- Run of a retest, and warnings */

/** Added to a retest's Run confirmation (§3.4). */
export function retestRunConfirmationAddition(ordinal: number, engine: PilotQuestionEngine): string {
  const label = ENGINE[engine];
  return `This measures question ${ordinal} again on ${label} after the change. If the worker is not set up for ${label}, it stops before any answer, spends nothing, and can be queued again here.`;
}

/** M19 — cards that no shared revision shows yet. */
export function cardsNotSharedWarning(count: number): string {
  return `${count} Outcome Card${count === 1 ? "" : "s"} exist${count === 1 ? "s" : ""} in no shared report revision. Build the report and share a revision with every card before the engagement ends.`;
}

/** The close prompt's warning about prepared retests not yet run. */
export function preparedNotRunWarning(count: number): string {
  return `${count} prepared retest${count === 1 ? " has" : "s have"} not been run. Once the pilot is closed, they never will be.`;
}

/** The retest phase's refusals in the Run, Retry and review routes. */
export const RETEST_SLOT_MISSING_TEXT = "This question has no prepared retest on that engine.";
export const RETEST_RUN_FAILED_TEXT =
  "This retest stopped before it finished. Retry it from the pilot page, or queue it again there if it stopped before any answer.";

/** A retest abandoned after too many worker stops: final, shown as could not be measured again. */
export const RETEST_JOB_ABANDONED_TEXT =
  "This retest was abandoned after too many worker stops. It is final and the report shows it as could not be measured again.";

/** A revision whose retests changed since it was built, or built while a retest runs: it cannot be shared. */
export const RETEST_OUT_OF_DATE_WORDS =
  "Out of date: a retest changed after this revision was built, or one is running now. It cannot be shared. Build the report again once nothing is running.";
