/**
 * D-054 — the fixed words the pilot console shows. No stored code reaches
 * the founder or a customer as text; every outcome has a sentence here.
 *
 * D-061 — and the words for two engines: a ChatGPT measurement per
 * question, its own Run confirmation, adding it, the web gate's refusal, and
 * resolving a measurement held for review. Imports types only, so the
 * console's client code can load it.
 */
import type {
  AddPilotQuestionEngineOutcome,
  AddPilotQuestionOutcome,
  ClosePilotOutcome,
  CreatePilotOutcome,
  PilotQuestionEngine,
  RetirePilotQuestionOutcome,
} from "@/lib/db/types";

export const CREATE_PILOT_REFUSAL: Record<Exclude<CreatePilotOutcome, "CREATED" | "ALREADY_CREATED">, string> = {
  IDEMPOTENCY_KEY_CONFLICT: "This form was already used for a different pilot. Reload the page and try again.",
  DOMAIN_HAS_LIVE_REQUEST:
    "That website already has an audit in progress. Finish or close it before starting a pilot for it.",
  DOMAIN_HAS_LIVE_PILOT: "That website already has an open pilot.",
  START_DATE_OUT_OF_RANGE: "The start date must be between yesterday and 60 days from today.",
};

export const ADD_QUESTION_REFUSAL: Record<Exclude<AddPilotQuestionOutcome, "ADDED" | "ALREADY_ADDED">, string> = {
  IDEMPOTENCY_KEY_CONFLICT: "This form was already used for a different question. Reload the page and try again.",
  PILOT_NOT_FOUND: "This pilot no longer exists.",
  PILOT_CLOSED: "This pilot is closed, so no question can be added.",
  PILOT_ENDED: "This pilot is past its end date, so no question can be added.",
  HASH_MISMATCH: "The question changed while it was being saved. Reload the page and try again.",
  DUPLICATE_QUESTION: "This pilot already has exactly this question.",
  LIMIT_REACHED: "This pilot already has as many questions as its limit allows.",
};

export const CLOSE_PILOT_REFUSAL: Record<Exclude<ClosePilotOutcome, "CLOSED">, string> = {
  ALREADY_CLOSED: "This pilot is already closed.",
  PILOT_NOT_FOUND: "This pilot no longer exists.",
  PILOT_JOB_ACTIVE:
    "One of this pilot's measurements is running or about to start. Wait for it to finish, then close the pilot.",
};

export const RETIRE_QUESTION_REFUSAL: Record<Exclude<RetirePilotQuestionOutcome, "RETIRED">, string> = {
  ALREADY_RETIRED: "This question is already retired.",
  PILOT_NOT_FOUND: "This pilot no longer exists.",
  QUESTION_NOT_FOUND: "This question is not part of this pilot.",
  PILOT_CLOSED: "This pilot is closed, so its questions are final.",
  // D-061 — the database now looks at every engine's measurement of the question.
  QUESTION_JOB_ACTIVE:
    "One of this question's measurements, on Perplexity or on ChatGPT, is running or about to start. Wait for it to finish.",
  QUESTION_NOT_STOPPED: "Only a question with a measurement that stopped and cannot go on can be retired.",
  QUESTION_RETRYABLE:
    "This question's stopped measurement failed at the AI provider and can still be retried. Retry it instead.",
  RETIRE_LIMIT_REACHED: "This pilot already has 5 retired questions, the most it may have.",
};

/**
 * D-061 — the retire prompt. There is no per-engine retirement: retiring
 * stops the question on both engines, and one engine's measurement that
 * stopped for good is enough, even while the other could still go on.
 */
export const RETIRE_PILOT_QUESTION_PROMPT =
  "Why retire this question? (10-2000 characters)\n\nRetiring stops this question on both engines, Perplexity and ChatGPT, even if one of its measurements could still go on. It is allowed once one of them has stopped and cannot go on. The question and its evidence are kept, it no longer counts toward the limit, it can never be run again on either engine, and you can add the same approved question again.";

/** D-061 — shown beside Retire: there is no per-engine retirement. */
export const RETIRE_BOTH_ENGINES_NOTE = "Retiring stops this question on Perplexity and ChatGPT alike.";

/** The pilot console's words for a Run of a measurement abandoned after too many worker stops. */
export const PILOT_JOB_ABANDONED_TEXT =
  "This measurement's worker stopped too many times, so it is now marked abandoned. Retire the question from the pilot page; you can then add it again.";

/** The close prompt. It says what closing does and does not do. */
export const CLOSE_PILOT_PROMPT =
  "Why close this pilot? (10-2000 characters)\n\nA pilot cannot be closed while one of its measurements is running or about to start. Once closed, none of its questions can be run or retried, and the evidence already collected is kept.";

/** A retired question, in words. */
export const PILOT_QUESTION_RETIRED_LABEL = "Retired";

/**
 * The engines a pilot is measured on (D-053). Perplexity is always
 * connected. D-061 — whether ChatGPT is comes from the web host's gate
 * (ZYPACT_PILOT_CHATGPT_ENABLED, lib/pilots/engines.ts), which the page
 * reads at request time and passes in: never a constant. An engine with no
 * measurement on a question is shown as not measured, never as zero.
 */
export function pilotEngines(chatgptConnected: boolean): ReadonlyArray<{
  key: PilotQuestionEngine;
  label: string;
  connected: boolean;
}> {
  return [
    { key: "perplexity_sonar", label: "Perplexity", connected: true },
    { key: "openai_chatgpt", label: "ChatGPT", connected: chatgptConnected },
  ];
}

/** An engine's name in the console's words. */
export function pilotEngineLabel(engine: PilotQuestionEngine): string {
  return engine === "openai_chatgpt" ? "ChatGPT" : "Perplexity";
}

export const ENGINE_NOT_MEASURED = "Not measured";

/** D-061 — ChatGPT while the web gate is off. */
export const ENGINE_NOT_CONNECTED = "Not connected";

/** D-061 — a ChatGPT Run, Retry or add refused because the web gate is off. Nothing is read or written. */
export const PILOT_CHATGPT_NOT_CONNECTED =
  "ChatGPT is not connected for pilots yet, so nothing was started, reserved or added.";

/** D-061 — the same, after a question was added with "also on ChatGPT" while the gate is off. */
export const PILOT_CHATGPT_NOT_CONNECTED_YET = "ChatGPT is not connected for pilots yet.";

/** D-061 — ChatGPT's Run and Retry while the web gate is off, under a measurement that exists. */
export const ENGINE_NOT_CONNECTED_CONTROLS_NOTE = "Not connected: Run and Retry on ChatGPT are off.";

/** D-061 — the pilot list's line about the engines. */
export function pilotEnginesSubtitle(chatgptConnected: boolean): string {
  return chatgptConnected
    ? "One project per customer, up to 20 approved buyer questions, 90 days. Measured on Perplexity, and on ChatGPT for each question it is added to."
    : "One project per customer, up to 20 approved buyer questions, 90 days. Measured on Perplexity; ChatGPT is not connected yet.";
}

/** D-061 — the add-question panel's note, which names ChatGPT only when the gate is on. */
export function addQuestionPanelNote(chatgptConnected: boolean): string {
  return chatgptConnected
    ? "Only a question the customer has approved in writing. Adding it queues its Perplexity measurement, and its ChatGPT measurement too if you tick the box; nothing runs or is charged until you press Run for each."
    : "Only a question the customer has approved in writing. Adding it queues its Perplexity measurement; ChatGPT is not connected yet. Nothing runs or is charged until you press Run for it.";
}

/** D-061 — the add-question panel's ChatGPT box, shown only when the gate is on. */
export const ADD_QUESTION_ALSO_CHATGPT_LABEL =
  "Also measure it on ChatGPT: 5 answers on ChatGPT (OpenAI's API with web search), at most 7 runs, a 4.00 USD cap. Nothing runs until you press Run for it on ChatGPT.";

/** D-061 — a Run, Retry or review naming an engine the question has no measurement on. */
export function pilotEngineNotOnQuestionText(engine: PilotQuestionEngine): string {
  return engine === "openai_chatgpt"
    ? "This question is not measured on ChatGPT. Add ChatGPT to it first."
    : "This question has no Perplexity measurement.";
}

/** D-061 — the founder's words for an add the database refused (add_pilot_question_engine). */
export const ADD_ENGINE_REFUSAL: Record<Exclude<AddPilotQuestionEngineOutcome, "ADDED" | "ALREADY_ADDED">, string> = {
  PILOT_NOT_FOUND: "This pilot no longer exists.",
  QUESTION_NOT_FOUND: "This question is not part of this pilot.",
  PILOT_CLOSED: "This pilot is closed, so ChatGPT cannot be added to its questions.",
  PILOT_ENDED: "This pilot is past its end date, so ChatGPT cannot be added to its questions.",
  QUESTION_RETIRED: "This question was retired, so it is no longer measured.",
  VERSION_NOT_APPROVED: "This question's approved text could not be found, so ChatGPT was not added. Tell the engineer.",
  HASH_MISMATCH: "This question's stored text does not match its approved text, so ChatGPT was not added. Tell the engineer.",
};

/** D-061 — ChatGPT was added (or had been already). */
export const ADD_CHATGPT_DONE_TEXT =
  "ChatGPT added to this question and its measurement queued. Nothing runs until you press Run for it on ChatGPT.";

/** D-061 — an add that failed for a reason the database did not name. */
export const ADD_CHATGPT_FAILED_TEXT =
  "The ChatGPT measurement could not be queued, so nothing was added for it. Try Add ChatGPT on the question again.";

/** D-061 — the confirmation before ChatGPT is added to one question. Nothing runs. */
export const ADD_CHATGPT_PROMPT =
  "Add ChatGPT to this question?\n\nIt queues a ChatGPT measurement of the same approved question: 5 answers on ChatGPT (OpenAI's API with web search), at most 7 runs, a 4.00 USD cap. Nothing runs or is charged until you press Run for it on ChatGPT.";

/** D-061 — the console's two add buttons. */
export const ADD_CHATGPT_BUTTON_LABEL = "Add ChatGPT";
export const ADD_CHATGPT_TO_ALL_BUTTON_LABEL = "Add ChatGPT to every question without it";

/** D-061 — the note a Retry asks for, naming the engine whose run is retried. */
export function pilotRetryPrompt(engine: PilotQuestionEngine): string {
  return `Why retry this run on ${pilotEngineLabel(engine)}? (10-2000 characters, kept with the retry)`;
}

/** D-061 — the confirmation before ChatGPT is added to every live question without it, one after another. */
export function addChatGptToAllPrompt(count: number): string {
  return (
    `Add ChatGPT to ${count} question${count === 1 ? "" : "s"}?\n\n` +
    "Each gets a ChatGPT measurement of its own approved question: 5 answers on ChatGPT (OpenAI's API with web search), at most 7 runs, a 4.00 USD cap per question. Nothing runs or is charged until you press Run for each on ChatGPT."
  );
}

/** D-061 — after adding ChatGPT to several questions in turn. */
export function addChatGptToAllSummary(added: number, tried: number, firstRefusal: string | null): string {
  const head = `ChatGPT added to ${added} of ${tried} question${tried === 1 ? "" : "s"}.`;
  return firstRefusal && added < tried ? `${head} The first refusal: ${firstRefusal}` : head;
}

/**
 * D-061 — resolving a measurement held for review, as the request page does
 * (resolve_protocol_job_review): the two resolutions in words. Either one
 * ends this measurement; nothing is run or spent. The unconfirmed run is
 * never counted: the resolution marks a still-open run excluded, and a run
 * already closed (a ChatGPT call that timed out is recorded as timed out)
 * stays as it is.
 */
export const PILOT_REVIEW_RESOLUTION_PROMPT: Record<"excluded_and_completed" | "failed", string> = {
  excluded_and_completed:
    "Leave out the unconfirmed run and finish this measurement? (Write why, 10-2000 characters, kept with the review.)\n\nThe run whose answer was never confirmed is never counted as completed, and no result is assumed for it. The measurement then ends with the answers it has: its remaining planned runs are not made.",
  failed:
    "Close this measurement as stopped? (Write why, 10-2000 characters, kept with the review.)\n\nThe run whose answer was never confirmed is never counted as completed. The measurement ends as stopped and cannot be retried; retire the question if it cannot go on, which stops it on both engines.",
};

/** D-061 — the two review buttons. */
export const PILOT_REVIEW_BUTTON_LABEL: Record<"excluded_and_completed" | "failed", string> = {
  excluded_and_completed: "Finish without the unconfirmed run",
  failed: "Close as stopped",
};

/**
 * D-061 — why a measurement is held, in words. The stored reason names the
 * provider leg `perplexity_outcome_unknown` on every engine (the call kind
 * is the provider leg's label, D-061 item 1), so the words name the slot's
 * own engine instead; the stored code is never shown.
 */
export function pilotHeldReasonText(reason: string | null, engine: PilotQuestionEngine): string {
  switch (reason) {
    case "perplexity_outcome_unknown":
      return `Held for review: a ${pilotEngineLabel(engine)} call may have been made, but no answer is on record (for example, it timed out).`;
    case "analysis_outcome_unknown":
      return "Held for review: an analysis call may have been made, but no reply is on record.";
    case "ambiguous_external_call_sent_without_receipt":
      return "Held for review: a call may have been made with no reply on record.";
    default:
      return "Held for review.";
  }
}

/** D-061 — after a review is recorded. */
export const PILOT_REVIEW_DONE_TEXT: Record<"excluded_and_completed" | "failed", string> = {
  excluded_and_completed: "Review recorded: the unconfirmed run is left out and the measurement is finished with the answers it has.",
  failed: "Review recorded: the measurement is closed as stopped.",
};

/** D-061 — the measurement is not held for review (any more). */
export const PILOT_REVIEW_NOT_HELD_TEXT = "This measurement is not held for review. Refresh the page.";

/** D-061 — the database did not record the review. */
export const PILOT_REVIEW_REFUSED_TEXT =
  "The review could not be recorded, usually because the measurement changed meanwhile. Refresh the page and try again.";

/**
 * Who supplied a pilot question, in words. The report's own labels
 * (lib/reports/question-provenance.ts) say "the requester"; a pilot's
 * customer never filled in a request form.
 */
export function pilotProvenanceLabel(code: string): string {
  if (code === "customer_supplied") return "Supplied by the customer";
  if (code === "founder_supplied") return "Supplied by Zypact";
  return "Supplier not recorded";
}

/** A protocol job's status, in words for the founder. */
export function pilotJobStatusLabel(status: string | null, stale: boolean): string {
  if (status === null) return "No measurement";
  if ((status === "claimed" || status === "running") && stale) return "Stopped mid-run (lease lapsed)";
  switch (status) {
    case "queued":
      return "Waiting for Run";
    case "claimed":
    case "running":
      return "Running";
    case "succeeded":
      return "Finished";
    case "failed":
      return "Stopped";
    case "needs_review":
      return "Held for review";
    case "abandoned_exhausted":
      return "Abandoned";
    default:
      return "Unknown state";
  }
}

/**
 * D-052 — the text the founder confirms before a pilot question's Run
 * spends money, from the protocol's own plan and caps. Measured on
 * production evidence (D-036): a run takes about 20 seconds.
 *
 * D-061 — per engine. Perplexity's words are unchanged (and are what an
 * absent engine gets). ChatGPT's come from its own plan and caps, with the
 * timing of the 2026-11-17 confirmation run (most answers 30-60 seconds,
 * the slowest about 2.5 minutes), and never promise the measurement
 * finishes today: under the daily spending limit a Run may wait for room.
 */
export function pilotRunConfirmationText(plan: {
  plannedRuns: number | null;
  runCap: number | null;
  spendCapUsd: number | null;
  stale: boolean;
  engine?: PilotQuestionEngine;
}): string {
  if (plan.engine === "openai_chatgpt") return chatGptRunConfirmationText(plan);
  const verb = plan.stale ? "Resume this pilot question's measurement now?" : "Run this pilot question now?";
  const { plannedRuns, runCap, spendCapUsd } = plan;
  if (plannedRuns === null || runCap === null || spendCapUsd === null || plannedRuns < 1) {
    return (
      verb +
      "\n\nOnly this question's measurement runs, on Perplexity. Every run makes two real, paid provider " +
      "calls (one AI answer and one analysis), within the limits fixed when the question was added."
    );
  }
  const minutes = Math.max(1, Math.round((plannedRuns * 20) / 60));
  return (
    verb +
    "\n\nOnly this question's measurement runs, on Perplexity: " +
    plannedRuns + " planned run" + (plannedRuns === 1 ? "" : "s") +
    ", each making two real, paid provider calls (one AI answer and one analysis), so " +
    plannedRuns * 2 + " calls if nothing fails. Retries can raise that to at most " +
    runCap * 2 + " calls, and this measurement can never spend more than $" +
    spendCapUsd.toFixed(2) + ". It usually takes about " +
    minutes + " minute" + (minutes === 1 ? "" : "s") + "."
  );
}

function chatGptRunConfirmationText(plan: {
  plannedRuns: number | null;
  runCap: number | null;
  spendCapUsd: number | null;
  stale: boolean;
}): string {
  const verb = plan.stale
    ? "Resume this pilot question's ChatGPT measurement now?"
    : "Run this pilot question on ChatGPT now?";
  const { plannedRuns, runCap, spendCapUsd } = plan;
  if (plannedRuns === null || runCap === null || spendCapUsd === null || plannedRuns < 1) {
    return (
      verb +
      "\n\nOnly this question's ChatGPT measurement runs, on ChatGPT (OpenAI's API with web search). Every run makes " +
      "two real, paid calls (one ChatGPT answer and one analysis), within the limits fixed when ChatGPT was added. " +
      "ChatGPT answers take longer than Perplexity's, and under the daily spending limit a run may wait for room."
    );
  }
  return (
    verb +
    "\n\nOnly this question's ChatGPT measurement runs: " +
    plannedRuns + " answer" + (plannedRuns === 1 ? "" : "s") +
    " on ChatGPT (OpenAI's API with web search), at most " +
    runCap + " run" + (runCap === 1 ? "" : "s") + ", a " +
    spendCapUsd.toFixed(2) + " USD cap for this question. Every run makes two real, paid calls " +
    "(one ChatGPT answer and one analysis). Most answers take 30-60 seconds and the slowest about 2.5 minutes; " +
    "under the daily spending limit a run may wait for room."
  );
}

/** D-061 — the Run route's reply once the worker was started for one engine's measurement. */
export function pilotRunStartedText(engine: PilotQuestionEngine, plannedRuns: number | null): string {
  if (typeof plannedRuns !== "number" || plannedRuns <= 0) return "Measurement started for this question only.";
  const runs = `${plannedRuns} planned run${plannedRuns === 1 ? "" : "s"}`;
  return engine === "openai_chatgpt"
    ? `Measurement started for this question only: ${runs} on ChatGPT. Most answers take 30-60 seconds and the slowest about 2.5 minutes.`
    : `Measurement started for this question only: ${runs} on Perplexity, about 20 seconds each.`;
}
