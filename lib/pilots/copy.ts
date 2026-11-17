/**
 * D-054 — the fixed words the pilot console shows. No stored code reaches
 * the founder or a customer as text; every outcome has a sentence here.
 */
import type {
  AddPilotQuestionOutcome,
  ClosePilotOutcome,
  CreatePilotOutcome,
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
  QUESTION_JOB_ACTIVE: "This question's measurement is running or about to start. Wait for it to finish.",
  QUESTION_NOT_STOPPED: "Only a question whose measurement stopped and cannot go on can be retired.",
  QUESTION_RETRYABLE: "This measurement stopped at the AI provider and can still be retried. Retry it instead.",
  RETIRE_LIMIT_REACHED: "This pilot already has 5 retired questions, the most it may have.",
};

/** The pilot console's words for a Run of a measurement abandoned after too many worker stops. */
export const PILOT_JOB_ABANDONED_TEXT =
  "This measurement's worker stopped too many times, so it is now marked abandoned. Retire the question from the pilot page; you can then add it again.";

/** The close prompt. It says what closing does and does not do. */
export const CLOSE_PILOT_PROMPT =
  "Why close this pilot? (10-2000 characters)\n\nA pilot cannot be closed while one of its measurements is running or about to start. Once closed, none of its questions can be run or retried, and the evidence already collected is kept.";

/** A retired question, in words. */
export const PILOT_QUESTION_RETIRED_LABEL = "Retired";

/**
 * The engines a pilot is measured on (D-053). Only Perplexity is connected;
 * ChatGPT is shown as not measured, never as zero.
 */
export const PILOT_ENGINES = [
  { key: "perplexity_sonar", label: "Perplexity", connected: true },
  { key: "openai_chatgpt", label: "ChatGPT", connected: false },
] as const;

export const ENGINE_NOT_MEASURED = "Not measured";

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
 */
export function pilotRunConfirmationText(plan: {
  plannedRuns: number | null;
  runCap: number | null;
  spendCapUsd: number | null;
  stale: boolean;
}): string {
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
