/**
 * D-062 — the pilot retest's fixed rules: one registered customer change
 * across 1-5 pilot questions, each measured again on both engines, with its
 * Outcome Cards inside the pilot report.
 *
 * Every constant and code here is the one supabase/migrations/
 * 20261109190000_pilot_retest.sql enforces; scripts/test-pilot-retest-schema.ts
 * pins the two equal, and scripts/test-pilot-retest-db.ts proves that
 * `retestJobIsFinal` gives what pilot_retest_job_is_final gives on the same
 * rows.
 *
 * Pure: no database, network, provider or model. The caller passes `today`.
 *
 * Also the route parsers (§3.1): each checks the bounds the database
 * checks, and runs the suggested-action lint (lintPilotActionText) on every
 * text a customer can read, refusing with the field and the words it hit.
 */
import type { PilotQuestionEngine } from "@/lib/db/types";
import { ACTION_TYPES, type ActionType } from "@/lib/interventions/types";
import { lintPilotActionText } from "@/lib/pilots/action-rules";
import { addDaysIso, isIsoDay, UUID_PATTERN, type Issues, type Parsed } from "@/lib/pilots/validate";

/** At most 5 questions in one registered change; each is retested on both engines. */
export const MAX_RETEST_QUESTIONS = 5;
/** At most 2 registrations per pilot (the second only after the first was abandoned). */
export const MAX_RETESTS_PER_PILOT = 2;
/** (engineer) The waiting period after the change goes live, in days. */
export const MIN_OBSERVATION_DAYS = 7;
export const MAX_OBSERVATION_DAYS = 60;
/** (engineer) The window must close at least this many days before the pilot ends. */
export const PILOT_END_MARGIN_DAYS = 7;
/** (engineer) Notes per registered change. */
export const MAX_RETEST_NOTES = 20;
/** (engineer) How often one retest that stopped before any answer may be queued again. */
export const MAX_REQUEUES = 3;
/** Each phase plans 5 answers; a baseline needs 5 readable ones to be registered. */
export const RETEST_PLANNED_RUNS = 5;
/** The outcome rule every pilot Outcome Card follows (pilot_retests.outcome_rule). */
export const PILOT_OUTCOME_RULE = "pilot-outcome-card/1" as const;

/** pilot_retest_notes_kind_check, in METHODOLOGY §14's order (M12, M14). */
export const RETEST_NOTE_KINDS = [
  "engine_change",
  "measurement_change",
  "competitor_activity",
  "customer_change",
  "source_change",
  "news_or_market_event",
  "implementation_issue",
  "other_change",
] as const;
export type RetestNoteKind = (typeof RETEST_NOTE_KINDS)[number];

/** pilot_retest_steps_step_check: the writer record's step kinds. */
export const RETEST_STEP_KINDS = ["register", "confirm", "prepare", "abandon", "requeue"] as const;
export type RetestStepKind = (typeof RETEST_STEP_KINDS)[number];

/** A group's state, derived from its lifecycle tuples exactly as the report save derives it. */
export const RETEST_GROUP_STATES = ["registered", "implemented", "prepared", "abandoned"] as const;
export type RetestGroupState = (typeof RETEST_GROUP_STATES)[number];

/** The state of one member (a question on one engine) as the console and the report name it. */
export const RETEST_MEMBER_STATES = [
  "retest_awaiting_change",
  "retest_window_open",
  "retest_awaiting_preparation",
  "retest_not_run",
  "retest_collecting",
  "retest_held_for_review",
  "retest_stopped_retryable",
  /** Final, with no attempt: shown as could not be measured again. */
  "retest_could_not_run",
  /** Final, with at least one attempt: it has an Outcome Card. */
  "retest_measured",
  "retest_withdrawn",
] as const;
export type RetestMemberState = (typeof RETEST_MEMBER_STATES)[number];

/** The registered text's bounds (pilot_retests CHECKs); each value is stored trimmed. */
export const RETEST_TEXT_BOUNDS = {
  changeTitle: [3, 120],
  changeDescription: [10, 2000],
  changeTarget: [3, 500],
  changeOwner: [3, 200],
  hypothesis: [10, 2000],
  expectedMechanism: [10, 2000],
  alternativeExplanations: [10, 2000],
  openQuestions: [10, 2000],
  decisionThreshold: [10, 2000],
  confoundersToMonitor: [10, 2000],
} as const;
export type RetestTextField = keyof typeof RETEST_TEXT_BOUNDS;
/** The other bounded texts: the approval reference, notes and reasons, the evidence URL. */
export const RETEST_APPROVAL_REF_BOUNDS = [3, 300] as const;
export const RETEST_NOTE_TEXT_BOUNDS = [10, 2000] as const;
export const RETEST_EVIDENCE_URL_BOUNDS = [10, 2048] as const;

/** A group's state from its lifecycle (abandoned first, then prepared, then implemented). */
export function retestGroupState(group: {
  implementedAt: string | null;
  retestsPreparedAt: string | null;
  abandonedAt: string | null;
}): RetestGroupState {
  if (group.abandonedAt !== null) return "abandoned";
  if (group.retestsPreparedAt !== null) return "prepared";
  if (group.implementedAt !== null) return "implemented";
  return "registered";
}

/**
 * The last day the change may go live (pilot_retests.implement_by): the
 * pilot's end, less the margin, less the waiting period. Registration is
 * refused (WINDOW_PAST_PILOT_END) once today is after it.
 */
export function implementByDay(endsOn: string, observationDays: number): string {
  return addDaysIso(endsOn, -(PILOT_END_MARGIN_DAYS + observationDays));
}

/** What retestJobIsFinal reads: the retest slot's job, its protocol and attempts, the pilot, the question. */
export interface RetestFinalityInput {
  job: {
    id: string;
    status: string;
    reviewResolution: string | null;
    currentAttemptId: string | null;
    failureReason: string | null;
    nextBaselineOrdinal: number;
  };
  protocol: { plannedBaselineRuns: number | null; runCap: number };
  /** Every attempt of the retest protocol. */
  attempts: ReadonlyArray<{
    id: string;
    jobId: string;
    status: string;
    terminalizedAt: string | null;
    baselineOrdinal: number | null;
    retryOfAttemptId: string | null;
  }>;
  pilot: { status: string; startsOn: string; endsOn: string };
  questionRetired: boolean;
  /** The member's `requeue` steps. */
  requeueCount: number;
  /** YYYY-MM-DD, the database's current_date (UTC). */
  today: string;
}

/**
 * The exact mirror of pilot_retest_job_is_final (20261109190000): true when
 * no path in the product can still add or change an answer of this retest.
 *
 *   runnable    = the pilot is active, today is inside its dates, the
 *                 question is not retired;
 *   retryable   = failed at the provider, not reviewed, no current attempt,
 *                 and 20261109180000's per-slot retry predicate holds;
 *   requeueable = failed, not reviewed, no current attempt, no attempt at
 *                 all, and fewer than MAX_REQUEUES requeues;
 *   final       = succeeded, abandoned_exhausted or cancelled; never while
 *                 held for review; queued, claimed or running only when not
 *                 runnable; failed unless runnable and retryable or
 *                 requeueable; an unknown status is never final.
 */
export function retestJobIsFinal(input: RetestFinalityInput): boolean {
  const { job, protocol, attempts, pilot } = input;
  const runnable = pilot.status === "active"
    && input.today >= pilot.startsOn && input.today <= pilot.endsOn
    && !input.questionRetired;

  let retryable = false;
  let requeueable = false;
  if (job.status === "failed" && job.reviewResolution === null && job.currentAttemptId === null) {
    if (job.failureReason === "provider_error") {
      const consumed = attempts.filter((a) => a.status !== "cancelled").length;
      const source = attempts.some((a) =>
        a.jobId === job.id
        && a.status === "failed"
        && a.terminalizedAt !== null
        && a.baselineOrdinal === job.nextBaselineOrdinal
        && !attempts.some((r) => r.retryOfAttemptId === a.id)
        && !attempts.some((c) => c.jobId === job.id && c.baselineOrdinal === a.baselineOrdinal && c.status === "completed"));
      retryable = source
        && consumed + 1 + Math.max((protocol.plannedBaselineRuns ?? 0) - job.nextBaselineOrdinal, 0) <= protocol.runCap;
    }
    requeueable = attempts.length === 0 && input.requeueCount < MAX_REQUEUES;
  }

  switch (job.status) {
    case "succeeded":
    case "abandoned_exhausted":
    case "cancelled":
      return true;
    case "needs_review":
      return false;
    case "queued":
    case "claimed":
    case "running":
      return !runnable;
    case "failed":
      return !(runnable && (retryable || requeueable));
    default:
      return false;
  }
}

/* ---------------------------------------------------------------- a member's state */

/**
 * The state of one member (a question on one engine) from its group and its
 * retest slot, as the console and the report name it. A card exists exactly
 * for `retest_measured`: final (retestJobIsFinal) with at least one attempt
 * (M1). A final retest with no attempt could not be measured again and is
 * shown, never hidden.
 */
export function retestMemberState(m: {
  groupState: RetestGroupState;
  windowClosesAt: string | null;
  /** Milliseconds since the epoch: the instant the state is read at. */
  nowMs: number;
  /** The member's retest slot, once prepared: its job's status, its attempts and finality. */
  retest: { jobStatus: string | null; attempts: number; final: boolean } | null;
}): RetestMemberState {
  switch (m.groupState) {
    case "abandoned":
      return "retest_withdrawn";
    case "registered":
      return "retest_awaiting_change";
    case "implemented": {
      const closes = m.windowClosesAt ? Date.parse(m.windowClosesAt) : Number.NaN;
      return !Number.isNaN(closes) && m.nowMs < closes ? "retest_window_open" : "retest_awaiting_preparation";
    }
    default: {
      const r = m.retest;
      // (engineer) A prepared group always has a slot and a job; a missing one is read as not run.
      if (!r || r.jobStatus === null) return "retest_not_run";
      if (r.final) return r.attempts > 0 ? "retest_measured" : "retest_could_not_run";
      if (r.jobStatus === "needs_review") return "retest_held_for_review";
      if (r.jobStatus === "failed") return "retest_stopped_retryable";
      if (r.jobStatus === "queued" && r.attempts === 0) return "retest_not_run";
      return "retest_collecting";
    }
  }
}

/* ---------------------------------------------------------------- which questions may be registered */

/** register_pilot_retest's per-question refusals (§2.6 step 7), in the order it checks them. */
export type RetestQuestionRefusal =
  | "QUESTION_NOT_LIVE"
  | "QUESTION_IN_EARLIER_LIVE_CHANGE"
  | "BASELINE_MISSING"
  | "BASELINE_PLAN_NOT_FIVE_RUNS"
  | "BASELINE_NOT_FINISHED"
  | "BASELINE_NOT_FIVE_READABLE"
  | "BASELINE_BEFORE_EARLIER_CHANGE"
  | "BASELINE_ALREADY_REGISTERED";

export interface RetestBaselineFacts {
  /** False when the question has no baseline slot on this engine. */
  exists: boolean;
  plannedRuns: number | null;
  jobStatus: string | null;
  /** Attempts still reserved or in progress. */
  attemptsInFlight: number;
  /** Completed baseline attempts whose stored result says whether the company was named (M3). */
  readable: number;
  /** Some attempt was reserved before an earlier change went live (M6b). */
  reservedBeforeEarlierChange: boolean;
  /** A proposed, approved or implemented intervention holds this baseline. */
  alreadyRegistered: boolean;
}

/**
 * The console's copy of register_pilot_retest's per-question rule (§2.6
 * step 7), on the same facts and in the same order: the first refusal, or
 * null when the question can be registered. The database decides; this only
 * lets the console list the questions it would refuse, with the reason.
 */
export function retestQuestionRefusal(q: {
  retired: boolean;
  inEarlierLiveChange: boolean;
  engines: Record<PilotQuestionEngine, RetestBaselineFacts>;
}): { refusal: RetestQuestionRefusal; engine: PilotQuestionEngine | null } | null {
  if (q.retired) return { refusal: "QUESTION_NOT_LIVE", engine: null };
  if (q.inEarlierLiveChange) return { refusal: "QUESTION_IN_EARLIER_LIVE_CHANGE", engine: null };
  for (const engine of ["perplexity_sonar", "openai_chatgpt"] as const) {
    const b = q.engines[engine];
    if (!b.exists) return { refusal: "BASELINE_MISSING", engine };
    if (b.plannedRuns !== RETEST_PLANNED_RUNS) return { refusal: "BASELINE_PLAN_NOT_FIVE_RUNS", engine };
    if (b.jobStatus !== "succeeded" || b.attemptsInFlight > 0) return { refusal: "BASELINE_NOT_FINISHED", engine };
    if (b.readable < RETEST_PLANNED_RUNS) return { refusal: "BASELINE_NOT_FIVE_READABLE", engine };
    if (b.reservedBeforeEarlierChange) return { refusal: "BASELINE_BEFORE_EARLIER_CHANGE", engine };
    if (b.alreadyRegistered) return { refusal: "BASELINE_ALREADY_REGISTERED", engine };
  }
  return null;
}

/* ---------------------------------------------------------------- route parsers */

/** The customer-visible labels of the registered text (M18), used in refusals and on the console. */
export const RETEST_TEXT_LABELS: Record<RetestTextField, string> = {
  changeTitle: "What the change is (title)",
  changeDescription: "What the change is",
  changeTarget: "Where it is made",
  changeOwner: "Who makes it",
  hypothesis: "Why we expect it might matter (a hypothesis)",
  expectedMechanism: "Expected mechanism (a hypothesis)",
  alternativeExplanations: "What else could explain a change",
  openQuestions: "What we don't know yet",
  decisionThreshold: "What would change your next decision (the customer's words)",
  confoundersToMonitor: "What we are watching for",
};

export const RETEST_TEXT_FIELDS = Object.keys(RETEST_TEXT_BOUNDS) as RetestTextField[];

/** The parsed register body: everything register_pilot_retest takes but the pilot and the actor. */
export interface RegisterRetestFields extends Record<RetestTextField, string> {
  pilotQuestionIds: string[];
  actionType: ActionType;
  thresholdBelowLimit: boolean;
  observationDays: number;
  customerApprovalRef: string;
  customerApprovedOn: string;
  sourceActionVersionIds: string[];
  confirmed: true;
  idempotencyKey: string;
}

export interface ConfirmRetestFields {
  wentLiveOn: string;
  evidenceUrl: string | null;
  artifactSha256: string | null;
  note: string;
  implementedAsRegistered: boolean;
  deviationNote: string | null;
  confirmed: true;
}

export interface AbandonRetestFields {
  reason: string;
  confirmed: true;
}

export interface RetestNoteFields {
  notedOn: string;
  kind: RetestNoteKind;
  text: string;
  correctsNoteId: string | null;
  idempotencyKey: string;
}

export interface RequeueRetestFields {
  pilotQuestionId: string;
  engine: PilotQuestionEngine;
  reason: string;
}

type Body = Record<string, unknown>;
const asBody = (raw: unknown): Body => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Body) : {});
const trimmed = (body: Body, key: string) => (typeof body[key] === "string" ? (body[key] as string).trim() : "");
const blank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

function collector() {
  const issues: Issues = {};
  return {
    issues,
    add(key: string, message: string) {
      (issues[key] ??= []).push(message);
    },
  };
}

/** The lint refusal, naming the field and the words it hit. */
export function retestLintIssue(label: string, hits: string[]): string {
  return `${label}: reword without ${hits.map((h) => `"${h}"`).join(", ")}. A customer reads this text, and it may not predict, promise or claim a cause.`;
}

function bounded(add: (k: string, m: string) => void, key: string, label: string, value: string, [min, max]: readonly [number, number]) {
  if (value.length < min || value.length > max) add(key, `${label}: ${min}-${max} characters.`);
}

function lintInto(add: (k: string, m: string) => void, key: string, label: string, value: string) {
  const hits = value ? lintPilotActionText(value) : [];
  if (hits.length > 0) add(key, retestLintIssue(label, hits));
}

/** POST …/retests (register). `today` is the database's current_date (UTC). */
export function parseRegisterRetest(raw: unknown, today: string): Parsed<RegisterRetestFields> {
  const body = asBody(raw);
  const { issues, add } = collector();

  const ids = Array.isArray(body.pilotQuestionIds) ? body.pilotQuestionIds : null;
  const questionIds: string[] = [];
  if (!ids || ids.length < 1 || ids.length > MAX_RETEST_QUESTIONS) {
    add("pilotQuestionIds", `Pick 1 to ${MAX_RETEST_QUESTIONS} questions.`);
  } else {
    for (const id of ids) {
      if (typeof id !== "string" || !UUID_PATTERN.test(id)) add("pilotQuestionIds", "Pick each question from the list.");
      else if (questionIds.includes(id.toLowerCase())) add("pilotQuestionIds", "A question is picked twice.");
      else questionIds.push(id.toLowerCase());
    }
  }

  const text = {} as Record<RetestTextField, string>;
  for (const field of RETEST_TEXT_FIELDS) {
    text[field] = trimmed(body, field);
    bounded(add, field, RETEST_TEXT_LABELS[field], text[field], RETEST_TEXT_BOUNDS[field]);
  }

  const actionType = body.actionType;
  if (typeof actionType !== "string" || !(ACTION_TYPES as readonly string[]).includes(actionType)) {
    add("actionType", "Pick the kind of change.");
  }
  if (typeof body.thresholdBelowLimit !== "boolean") {
    add("thresholdBelowLimit", "Say whether the change the customer said would matter is smaller than 60 points.");
  }
  const days = typeof body.observationDays === "string" && body.observationDays.trim() !== "" ? Number(body.observationDays) : body.observationDays;
  if (typeof days !== "number" || !Number.isInteger(days) || days < MIN_OBSERVATION_DAYS || days > MAX_OBSERVATION_DAYS) {
    add("observationDays", `Waiting period: a whole number of days from ${MIN_OBSERVATION_DAYS} to ${MAX_OBSERVATION_DAYS}.`);
  }
  const customerApprovalRef = trimmed(body, "customerApprovalRef");
  bounded(add, "customerApprovalRef", "Where the customer's written approval is kept", customerApprovalRef, RETEST_APPROVAL_REF_BOUNDS);
  const approvedOn = body.customerApprovedOn;
  if (!isIsoDay(approvedOn) || approvedOn > today) add("customerApprovedOn", "The approval date: a real day, not in the future.");

  const sources = body.sourceActionVersionIds === undefined || body.sourceActionVersionIds === null ? [] : body.sourceActionVersionIds;
  const sourceIds: string[] = [];
  if (!Array.isArray(sources) || sources.length > 5) {
    add("sourceActionVersionIds", "Pick at most 5 reviewed suggested actions.");
  } else {
    for (const id of sources) {
      if (typeof id !== "string" || !UUID_PATTERN.test(id)) add("sourceActionVersionIds", "Pick each suggested action from the list.");
      else if (sourceIds.includes(id.toLowerCase())) add("sourceActionVersionIds", "A suggested action is picked twice.");
      else sourceIds.push(id.toLowerCase());
    }
  }
  if (body.confirmed !== true) add("confirmed", "Confirm the customer's written approval first.");
  const idempotencyKey = trimmed(body, "idempotencyKey");
  if (!UUID_PATTERN.test(idempotencyKey)) add("idempotencyKey", "Reload the page and try again.");

  if (Object.keys(issues).length > 0) return { ok: false, issues };
  // Every registered text field reaches the customer on every card (M4, M20).
  const lint = collector();
  for (const field of RETEST_TEXT_FIELDS) lintInto(lint.add, field, RETEST_TEXT_LABELS[field], text[field]);
  if (Object.keys(lint.issues).length > 0) return { ok: false, issues: lint.issues };

  return {
    ok: true,
    value: {
      ...text,
      pilotQuestionIds: questionIds,
      actionType: actionType as ActionType,
      thresholdBelowLimit: body.thresholdBelowLimit as boolean,
      observationDays: days as number,
      customerApprovalRef,
      customerApprovedOn: approvedOn as string,
      sourceActionVersionIds: sourceIds,
      confirmed: true,
      idempotencyKey,
    },
  };
}

const SHA256 = /^[0-9a-f]{64}$/;

/** POST …/retests/[retestId]/implementation. */
export function parseConfirmRetest(raw: unknown, today: string): Parsed<ConfirmRetestFields> {
  const body = asBody(raw);
  const { issues, add } = collector();
  const wentLiveOn = body.wentLiveOn;
  if (!isIsoDay(wentLiveOn) || wentLiveOn > today) add("wentLiveOn", "The go-live date the customer reports: a real day, not in the future.");

  const evidenceUrl = blank(body.evidenceUrl) ? null : trimmed(body, "evidenceUrl");
  if (body.evidenceUrl !== undefined && body.evidenceUrl !== null && typeof body.evidenceUrl !== "string") add("evidenceUrl", "The link must be text.");
  if (evidenceUrl !== null) {
    const [min, max] = RETEST_EVIDENCE_URL_BOUNDS;
    if (!/^https?:\/\//.test(evidenceUrl) || evidenceUrl.length < min || evidenceUrl.length > max) {
      add("evidenceUrl", `The link: an http(s) address of ${min}-${max} characters.`);
    }
  }
  // (engineer) A fingerprint is accepted in either case and stored lower-case, as the database requires.
  const sha = blank(body.artifactSha256) ? null : trimmed(body, "artifactSha256").toLowerCase();
  if (sha !== null && !SHA256.test(sha)) add("artifactSha256", "The fingerprint: 64 hexadecimal characters (a SHA-256).");
  if (evidenceUrl === null && sha === null) add("evidenceUrl", "Give a link to the live change, its SHA-256 fingerprint, or both.");

  const note = trimmed(body, "note");
  bounded(add, "note", "Internal note", note, RETEST_NOTE_TEXT_BOUNDS);
  if (typeof body.implementedAsRegistered !== "boolean") add("implementedAsRegistered", "Say whether the change was made as registered.");
  const asRegistered = body.implementedAsRegistered === true;
  let deviationNote: string | null = null;
  if (body.implementedAsRegistered === false) {
    deviationNote = trimmed(body, "deviationNote");
    bounded(add, "deviationNote", "How the change differs from the registered one", deviationNote, RETEST_NOTE_TEXT_BOUNDS);
  } else if (!blank(body.deviationNote)) {
    add("deviationNote", "Describe a difference only when the change was not made as registered.");
  }
  if (body.confirmed !== true) add("confirmed", "Confirm first.");

  if (Object.keys(issues).length > 0) return { ok: false, issues };
  // The link and a deviation note reach the customer (§3.5, "Other changes we recorded").
  const lint = collector();
  if (evidenceUrl) lintInto(lint.add, "evidenceUrl", "The link", evidenceUrl);
  if (deviationNote) lintInto(lint.add, "deviationNote", "How the change differs from the registered one", deviationNote);
  if (Object.keys(lint.issues).length > 0) return { ok: false, issues: lint.issues };
  return {
    ok: true,
    value: { wentLiveOn: wentLiveOn as string, evidenceUrl, artifactSha256: sha, note, implementedAsRegistered: asRegistered, deviationNote, confirmed: true },
  };
}

/** POST …/retests/[retestId]/abandon. The reason is internal: the report never shows it (engineer). */
export function parseAbandonRetest(raw: unknown): Parsed<AbandonRetestFields> {
  const body = asBody(raw);
  const { issues, add } = collector();
  const reason = trimmed(body, "reason");
  bounded(add, "reason", "Why the change is abandoned", reason, RETEST_NOTE_TEXT_BOUNDS);
  if (body.confirmed !== true) add("confirmed", "Confirm first.");
  if (Object.keys(issues).length > 0) return { ok: false, issues };
  return { ok: true, value: { reason, confirmed: true } };
}

/** POST …/retests/[retestId]/notes. */
export function parseRetestNote(raw: unknown, today: string): Parsed<RetestNoteFields> {
  const body = asBody(raw);
  const { issues, add } = collector();
  const notedOn = body.notedOn;
  if (!isIsoDay(notedOn) || notedOn > today) add("notedOn", "The day of the change: a real day, not in the future.");
  const kind = body.kind;
  if (typeof kind !== "string" || !(RETEST_NOTE_KINDS as readonly string[]).includes(kind)) add("kind", "Pick the kind of change.");
  const text = trimmed(body, "text");
  bounded(add, "text", "What changed", text, RETEST_NOTE_TEXT_BOUNDS);
  const corrects = blank(body.correctsNoteId) ? null : body.correctsNoteId;
  if (corrects !== null && (typeof corrects !== "string" || !UUID_PATTERN.test(corrects))) add("correctsNoteId", "Pick the note this corrects from the list.");
  const idempotencyKey = trimmed(body, "idempotencyKey");
  if (!UUID_PATTERN.test(idempotencyKey)) add("idempotencyKey", "Reload the page and try again.");
  if (Object.keys(issues).length > 0) return { ok: false, issues };
  const lint = collector();
  lintInto(lint.add, "text", "What changed", text);
  if (Object.keys(lint.issues).length > 0) return { ok: false, issues: lint.issues };
  return {
    ok: true,
    value: { notedOn: notedOn as string, kind: kind as RetestNoteKind, text, correctsNoteId: corrects as string | null, idempotencyKey },
  };
}

/** POST …/retests/[retestId]/requeue. The reason is internal (the requeue step's note). */
export function parseRequeueRetest(raw: unknown): Parsed<RequeueRetestFields> {
  const body = asBody(raw);
  const { issues, add } = collector();
  const id = body.pilotQuestionId;
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) add("pilotQuestionId", "Reload the page and try again.");
  const engine = body.engine;
  if (engine !== "perplexity_sonar" && engine !== "openai_chatgpt") add("engine", "invalid_engine");
  const reason = trimmed(body, "reason");
  bounded(add, "reason", "Why it is queued again", reason, RETEST_NOTE_TEXT_BOUNDS);
  if (Object.keys(issues).length > 0) return { ok: false, issues };
  return { ok: true, value: { pilotQuestionId: (id as string).toLowerCase(), engine: engine as PilotQuestionEngine, reason } };
}
