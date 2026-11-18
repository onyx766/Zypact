/**
 * D-061 — the engines a pilot question is measured on, and the web host's
 * ChatGPT gate.
 *
 * The web app cannot see the worker's WORKER_CHATGPT_ENABLED switch, so it
 * has its own: ZYPACT_PILOT_CHATGPT_ENABLED, on only when it is exactly
 * "true", read at request time and never cached. It gates every ChatGPT
 * action in the pilot console that can lead to spending: adding ChatGPT to a
 * question, and Run and Retry of a ChatGPT measurement. Off, ChatGPT shows
 * as not connected and those routes refuse before reading anything. It is
 * set on the web host only after the worker's switch is on, and unset
 * before the worker's switch goes off (a production step, in that order).
 * Resolving a measurement held for review and retiring a question spend
 * nothing and start nothing, so they stay open with the gate off: a ChatGPT
 * measurement held for review can still be resolved, and one that stopped
 * for good is retired with its question. Not every ChatGPT measurement can
 * be closed out that way: one only waiting for Run, one that failed at the
 * provider and could still be retried, or one with a run that has not
 * finished (a Retry approved but not yet Run, a run whose worker stopped
 * part-way) can be neither run nor retried with the gate off, and on its
 * own it does not let its question be retired; it waits until the gate is
 * on again. The retire route says so in words (retireRefusalWords).
 *
 * Pure apart from the one environment read, which callers may inject.
 */
import type { PilotQuestionEngine } from "@/lib/db/types";
import { PILOT_CHATGPT_NOT_CONNECTED } from "@/lib/pilots/copy";

/** The closed set of a slot's engine (pilot_question_protocols_engine_check, 20261109180000). */
export const PILOT_QUESTION_ENGINES: readonly PilotQuestionEngine[] = ["perplexity_sonar", "openai_chatgpt"];

/** True only when ZYPACT_PILOT_CHATGPT_ENABLED is exactly "true". */
export function pilotChatGptEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.ZYPACT_PILOT_CHATGPT_ENABLED === "true";
}

export function isPilotQuestionEngine(value: unknown): value is PilotQuestionEngine {
  return typeof value === "string" && (PILOT_QUESTION_ENGINES as readonly string[]).includes(value);
}

export type PilotEngineChoice =
  | { ok: true; engine: PilotQuestionEngine }
  | { ok: false; status: 400 | 409; error: string };

/**
 * The engine a pilot route's JSON body names.
 *
 *   - absent or null: Perplexity, the only engine before D-061, so a page
 *     still posting `{}` keeps working; unless `required`, then refused;
 *   - anything outside the closed set: refused (400);
 *   - ChatGPT on a `gated` route while the gate is off: refused (409) in
 *     words, before anything is read, reserved or started.
 */
export function pilotEngineFromBody(
  body: unknown,
  opts: { chatgptEnabled: boolean; gated: boolean; required?: boolean }
): PilotEngineChoice {
  const raw = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).engine : undefined;
  if (raw === undefined || raw === null) {
    return opts.required ? { ok: false, status: 400, error: "invalid_engine" } : { ok: true, engine: "perplexity_sonar" };
  }
  if (!isPilotQuestionEngine(raw)) return { ok: false, status: 400, error: "invalid_engine" };
  if (raw === "openai_chatgpt" && opts.gated && !opts.chatgptEnabled) {
    return { ok: false, status: 409, error: PILOT_CHATGPT_NOT_CONNECTED };
  }
  return { ok: true, engine: raw };
}

/* ---------------------------------------------------------------- D-062: the retest phase */

/** The phase of a pilot question's slot (pilot_question_protocols_phase_check, 20261109190000). */
export type PilotSlotPhase = "baseline" | "retest";
export const PILOT_SLOT_PHASES: readonly PilotSlotPhase[] = ["baseline", "retest"];

/**
 * D-062 (engineer) — the web host's retest gate, ZYPACT_PILOT_RETEST_ENABLED,
 * on only when it is exactly "true", read at request time. It ships unset
 * (dark) until the founder confirms D-062. It gates every retest step that
 * can lead to spending: register, record as live, prepare, queue again, and
 * Run and Retry of a retest. Withdrawing a change, logging another change
 * and resolving a retest held for review spend nothing, so they stay open
 * with the gate off (forward recovery), as B leaves review resolution open.
 */
export function pilotRetestEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.ZYPACT_PILOT_RETEST_ENABLED === "true";
}

export type PilotPhaseChoice = { ok: true; phase: PilotSlotPhase } | { ok: false; status: 400 | 409; error: string };

/**
 * The phase a Run, Retry or review body names: absent or null is the
 * baseline, as before D-062; anything outside the closed set is refused
 * (400 `invalid_phase`); a retest on a `gated` route while the retest gate is
 * off is refused (409) in words, before anything is read or started.
 */
export function pilotPhaseFromBody(
  body: unknown,
  opts: { retestEnabled: boolean; gated: boolean; notEnabledText: string }
): PilotPhaseChoice {
  const raw = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).phase : undefined;
  if (raw === undefined || raw === null) return { ok: true, phase: "baseline" };
  if (raw !== "baseline" && raw !== "retest") return { ok: false, status: 400, error: "invalid_phase" };
  if (raw === "retest" && opts.gated && !opts.retestEnabled) return { ok: false, status: 409, error: opts.notEnabledText };
  return { ok: true, phase: raw };
}
