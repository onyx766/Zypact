/**
 * D-062 — the database side of the pilot retest for the founder console:
 * the six group steps through their adapter methods (one transaction each
 * in the database, 20261109190000), mapped to the founder's words, and the
 * reads the pilot page and the report staleness checks need.
 *
 * (engineer) The writes go through C1's adapter methods
 * (lib/db/supabase-adapter.ts), which already check each reply against its
 * closed contract, rather than a second rpc() call site. A raised guard or
 * step failure is mapped through PILOT_GUARD_RPC_ERRORS; nothing a database
 * error says is ever echoed.
 *
 * Service-role client, so callers must have passed the founder guard. These
 * reads return registered text to founder pages only; nothing here is logged.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { DbAdapter, PilotQuestionEngine } from "@/lib/db/types";
import { mapPilotGuardError } from "@/lib/interventions/rpc-errors";
import { readReportableActions } from "@/lib/pilots/action-store";
import type { PilotQuestionRow } from "@/lib/pilots/reads";
import {
  ABANDON_RETEST_DONE_TEXT,
  ABANDON_RETEST_REFUSAL,
  CONFIRM_RETEST_REFUSAL,
  confirmRetestDoneText,
  NOTE_RETEST_DONE_TEXT,
  NOTE_RETEST_REFUSAL,
  PILOT_RETEST_STEP_FAILED_TEXT,
  PREPARE_RETEST_REFUSAL,
  prepareRetestDoneText,
  REGISTER_RETEST_DONE_TEXT,
  registerRefusalText,
  REQUEUE_RETEST_REFUSAL,
  requeueRetestDoneText,
  retestQuestionRefusalWords,
} from "@/lib/pilots/retest-copy";
import {
  MAX_REQUEUES,
  retestGroupState,
  retestJobIsFinal,
  retestMemberState,
  retestQuestionRefusal,
  type AbandonRetestFields,
  type ConfirmRetestFields,
  type RegisterRetestFields,
  type RequeueRetestFields,
  type RetestBaselineFacts,
  type RetestGroupState,
  type RetestMemberState,
  type RetestNoteFields,
  type RetestTextField,
} from "@/lib/pilots/retest-rules";
import { changeLiveAt } from "@/lib/reports/build-pilot-retests";
import type { RevisionRetestManifest } from "@/lib/reports/process-pilot-report";

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function rows(q: PromiseLike<{ data: unknown; error: unknown }>): Promise<Row[]> {
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Row[];
}

/* ---------------------------------------------------------------- the six steps */

/** What a step route answers: its status, the outcome and the founder's words. */
export interface RetestStepResult {
  ok: boolean;
  status: number;
  outcome: string;
  detail: string;
  extra?: Record<string, unknown>;
}

type OnUnmapped = (d: { code: string | null; message: string | null }) => void;

/** A raised error: a guard in words (409), a step failure (500), malformed input (400). Never the database text. */
function raised(error: unknown, onUnmapped?: OnUnmapped): RetestStepResult {
  const e = (error ?? {}) as { message?: string | null; code?: string | null };
  const mapped = mapPilotGuardError({ message: e.message ?? null, code: e.code ?? null }, onUnmapped);
  return {
    ok: false,
    status: mapped.status,
    outcome: mapped.error === "pilot_retest_step_failed" ? "STEP_FAILED" : "REFUSED",
    detail: mapped.status === 500 ? PILOT_RETEST_STEP_FAILED_TEXT : mapped.message,
  };
}

const done = (status: number, outcome: string, detail: string, extra?: Record<string, unknown>): RetestStepResult => ({
  ok: true,
  status,
  outcome,
  detail,
  extra,
});
const refused = (outcome: string, detail: string, notFound: boolean): RetestStepResult => ({
  ok: false,
  status: notFound ? 404 : 409,
  outcome,
  detail,
});
const NOT_FOUND = new Set(["PILOT_NOT_FOUND", "RETEST_NOT_FOUND"]);

export async function registerRetestStep(
  db: Pick<DbAdapter, "registerPilotRetest">,
  input: { pilotId: string; registeredBy: string; fields: RegisterRetestFields; ordinalOf: (pilotQuestionId: string) => Promise<number | null> },
  onUnmapped?: OnUnmapped
): Promise<RetestStepResult> {
  const f = input.fields;
  let r: Awaited<ReturnType<DbAdapter["registerPilotRetest"]>>;
  try {
    r = await db.registerPilotRetest({ pilotId: input.pilotId, registeredBy: input.registeredBy, ...f });
  } catch (error) {
    return raised(error, onUnmapped);
  }
  if (r.outcome === "REGISTERED" || r.outcome === "ALREADY_REGISTERED") {
    return done(r.outcome === "REGISTERED" ? 201 : 200, r.outcome, REGISTER_RETEST_DONE_TEXT, { pilotRetestId: r.pilotRetestId });
  }
  const ordinal = r.pilotQuestionId ? await input.ordinalOf(r.pilotQuestionId).catch(() => null) : null;
  return refused(r.outcome, registerRefusalText(r.outcome, { ordinal, engine: r.engine }), r.outcome === "PILOT_NOT_FOUND");
}

export async function confirmRetestStep(
  db: Pick<DbAdapter, "confirmPilotRetestImplementation">,
  input: { pilotId: string; pilotRetestId: string; confirmedBy: string; fields: ConfirmRetestFields },
  onUnmapped?: OnUnmapped
): Promise<RetestStepResult> {
  let r: Awaited<ReturnType<DbAdapter["confirmPilotRetestImplementation"]>>;
  try {
    r = await db.confirmPilotRetestImplementation({
      pilotId: input.pilotId,
      pilotRetestId: input.pilotRetestId,
      confirmedBy: input.confirmedBy,
      ...input.fields,
    });
  } catch (error) {
    return raised(error, onUnmapped);
  }
  if (r.outcome === "IMPLEMENTED" || r.outcome === "ALREADY_IMPLEMENTED") {
    return done(200, r.outcome, confirmRetestDoneText(r.windowClosesAt ?? ""), { windowClosesAt: r.windowClosesAt });
  }
  return refused(r.outcome, CONFIRM_RETEST_REFUSAL[r.outcome], NOT_FOUND.has(r.outcome));
}

export async function prepareRetestStep(
  db: Pick<DbAdapter, "preparePilotRetests">,
  input: { pilotId: string; pilotRetestId: string; preparedBy: string },
  onUnmapped?: OnUnmapped
): Promise<RetestStepResult> {
  let r: Awaited<ReturnType<DbAdapter["preparePilotRetests"]>>;
  try {
    r = await db.preparePilotRetests(input);
  } catch (error) {
    return raised(error, onUnmapped);
  }
  if (r.outcome === "PREPARED" || r.outcome === "ALREADY_PREPARED") {
    return done(200, r.outcome, prepareRetestDoneText(r.prepared ?? 0), { prepared: r.prepared });
  }
  return refused(r.outcome, PREPARE_RETEST_REFUSAL[r.outcome], NOT_FOUND.has(r.outcome));
}

export async function abandonRetestStep(
  db: Pick<DbAdapter, "abandonPilotRetest">,
  input: { pilotId: string; pilotRetestId: string; abandonedBy: string; fields: AbandonRetestFields },
  onUnmapped?: OnUnmapped
): Promise<RetestStepResult> {
  let outcome: Awaited<ReturnType<DbAdapter["abandonPilotRetest"]>>;
  try {
    outcome = await db.abandonPilotRetest({
      pilotId: input.pilotId,
      pilotRetestId: input.pilotRetestId,
      abandonedBy: input.abandonedBy,
      reason: input.fields.reason,
      confirmed: input.fields.confirmed,
    });
  } catch (error) {
    return raised(error, onUnmapped);
  }
  if (outcome === "ABANDONED" || outcome === "ALREADY_ABANDONED") return done(200, outcome, ABANDON_RETEST_DONE_TEXT);
  return refused(outcome, ABANDON_RETEST_REFUSAL[outcome], NOT_FOUND.has(outcome));
}

export async function requeueRetestStep(
  db: Pick<DbAdapter, "requeuePilotRetestJob">,
  input: { pilotId: string; pilotRetestId: string; requeuedBy: string; fields: RequeueRetestFields },
  onUnmapped?: OnUnmapped
): Promise<RetestStepResult> {
  let r: Awaited<ReturnType<DbAdapter["requeuePilotRetestJob"]>>;
  try {
    r = await db.requeuePilotRetestJob({
      pilotId: input.pilotId,
      pilotRetestId: input.pilotRetestId,
      pilotQuestionId: input.fields.pilotQuestionId,
      engine: input.fields.engine,
      requeuedBy: input.requeuedBy,
      reason: input.fields.reason,
    });
  } catch (error) {
    return raised(error, onUnmapped);
  }
  if (r.outcome === "REQUEUED" || r.outcome === "ALREADY_QUEUED") {
    return done(200, r.outcome, requeueRetestDoneText(input.fields.engine), { jobId: r.jobId });
  }
  return refused(r.outcome, REQUEUE_RETEST_REFUSAL[r.outcome], NOT_FOUND.has(r.outcome) || r.outcome === "MEMBER_NOT_FOUND");
}

export async function addRetestNoteStep(
  db: Pick<DbAdapter, "addPilotRetestNote">,
  input: { pilotId: string; pilotRetestId: string; writtenBy: string; fields: RetestNoteFields },
  onUnmapped?: OnUnmapped
): Promise<RetestStepResult> {
  let r: Awaited<ReturnType<DbAdapter["addPilotRetestNote"]>>;
  try {
    r = await db.addPilotRetestNote({
      pilotId: input.pilotId,
      pilotRetestId: input.pilotRetestId,
      writtenBy: input.writtenBy,
      ...input.fields,
    });
  } catch (error) {
    return raised(error, onUnmapped);
  }
  if (r.outcome === "ADDED" || r.outcome === "ALREADY_ADDED") {
    return done(r.outcome === "ADDED" ? 201 : 200, r.outcome, NOTE_RETEST_DONE_TEXT, { noteId: r.noteId });
  }
  return refused(r.outcome, NOTE_RETEST_REFUSAL[r.outcome], NOT_FOUND.has(r.outcome));
}

/* ---------------------------------------------------------------- the stored rows */

interface RetestRows {
  groups: Row[];
  members: Row[];
  notes: Row[];
  requeues: Map<string, number>;
  /** Retest slots of the pilot's questions, by member id. */
  slotByMember: Map<string, Row>;
  protocols: Map<string, Row>;
  jobs: Map<string, Row>;
  /** By retest protocol id. */
  attempts: Map<string, Row[]>;
  pendingJobIds: Set<string>;
}

async function readRetestRows(client: SupabaseClient, pilotId: string, questionIds: string[]): Promise<RetestRows> {
  const groups = await rows(client.from("pilot_retests").select("*").eq("pilot_id", pilotId));
  const empty: RetestRows = {
    groups,
    members: [],
    notes: [],
    requeues: new Map(),
    slotByMember: new Map(),
    protocols: new Map(),
    jobs: new Map(),
    attempts: new Map(),
    pendingJobIds: new Set(),
  };
  if (groups.length === 0) return empty;
  const [members, notes, steps, slots] = await Promise.all([
    rows(client.from("pilot_retest_members").select("*").eq("pilot_id", pilotId)),
    rows(client.from("pilot_retest_notes").select("*").eq("pilot_id", pilotId)),
    rows(client.from("pilot_retest_steps").select("member_id,step").eq("pilot_id", pilotId).eq("step", "requeue")),
    questionIds.length > 0
      ? rows(
          client
            .from("pilot_question_protocols")
            .select("pilot_question_id,engine,phase,protocol_id,pilot_retest_member_id")
            .in("pilot_question_id", questionIds)
            .eq("phase", "retest")
        )
      : Promise.resolve([] as Row[]),
  ]);
  const retestIds = slots.map((s) => String(s.protocol_id));
  const [protocols, jobs, attempts] = retestIds.length
    ? await Promise.all([
        rows(client.from("protocols").select("id,planned_baseline_runs,run_cap,spend_cap_usd").in("id", retestIds)),
        rows(
          client
            .from("protocol_execution_jobs")
            .select("id,protocol_id,status,failure_reason,review_resolution,current_attempt_id,next_baseline_ordinal,lease_expires_at,needs_review_reason")
            .in("protocol_id", retestIds)
        ),
        rows(
          client
            .from("protocol_attempts")
            .select("id,protocol_id,job_id,status,baseline_ordinal,terminalized_at,retry_of_attempt_id,reserved_at")
            .in("protocol_id", retestIds)
        ),
      ])
    : [[], [], []];
  const pending =
    jobs.length > 0
      ? await rows(
          client
            .from("protocol_job_run_requests")
            .select("job_id,status,expires_at")
            .in("job_id", jobs.map((j) => String(j.id)))
            .eq("status", "pending")
        )
      : [];
  const requeues = new Map<string, number>();
  for (const st of steps) if (st.member_id) requeues.set(String(st.member_id), (requeues.get(String(st.member_id)) ?? 0) + 1);
  const byProtocol = new Map<string, Row[]>();
  for (const a of attempts) {
    const list = byProtocol.get(String(a.protocol_id)) ?? [];
    list.push(a);
    byProtocol.set(String(a.protocol_id), list);
  }
  return {
    groups,
    members,
    notes,
    requeues,
    slotByMember: new Map(slots.filter((s) => s.pilot_retest_member_id).map((s) => [String(s.pilot_retest_member_id), s])),
    protocols: new Map(protocols.map((p) => [String(p.id), p])),
    jobs: new Map(jobs.map((j) => [String(j.protocol_id), j])),
    attempts: byProtocol,
    pendingJobIds: new Set(
      pending.filter((r) => typeof r.expires_at === "string" && Date.parse(r.expires_at) > Date.now()).map((r) => String(r.job_id))
    ),
  };
}

function finalityOf(
  r: RetestRows,
  member: Row,
  pilot: { status: string; startsOn: string; endsOn: string },
  questionRetired: boolean,
  today: string
): { slot: Row | null; job: Row | null; attempts: Row[]; final: boolean } {
  const slot = r.slotByMember.get(String(member.id)) ?? null;
  if (!slot) return { slot: null, job: null, attempts: [], final: false };
  const protocolId = String(slot.protocol_id);
  const job = r.jobs.get(protocolId) ?? null;
  const attempts = r.attempts.get(protocolId) ?? [];
  const protocol = r.protocols.get(protocolId);
  const final = job
    ? retestJobIsFinal({
        job: {
          id: String(job.id),
          status: String(job.status),
          reviewResolution: str(job.review_resolution),
          currentAttemptId: str(job.current_attempt_id),
          failureReason: str(job.failure_reason),
          nextBaselineOrdinal: num(job.next_baseline_ordinal) ?? 0,
        },
        protocol: { plannedBaselineRuns: num(protocol?.planned_baseline_runs), runCap: num(protocol?.run_cap) ?? 0 },
        attempts: attempts.map((a) => ({
          id: String(a.id),
          jobId: String(a.job_id),
          status: String(a.status),
          terminalizedAt: str(a.terminalized_at),
          baselineOrdinal: num(a.baseline_ordinal),
          retryOfAttemptId: str(a.retry_of_attempt_id),
        })),
        pilot,
        questionRetired,
        requeueCount: r.requeues.get(String(member.id)) ?? 0,
        today,
      })
    : false;
  return { slot, job, attempts, final };
}

const groupStateOf = (g: Row): RetestGroupState =>
  retestGroupState({ implementedAt: str(g.implemented_at), retestsPreparedAt: str(g.retests_prepared_at), abandonedAt: str(g.abandoned_at) });

/* ---------------------------------------------------------------- the console's read */

export interface ConsoleRetestCell {
  memberId: string;
  engine: PilotQuestionEngine;
  state: RetestMemberState;
  /** The retest slot's measurement, once prepared, in the console's PilotMeasurement shape. */
  jobStatus: string | null;
  stale: boolean;
  needsReviewReason: string | null;
  plannedRuns: number | null;
  runCap: number | null;
  spendCapUsd: number | null;
  completedRuns: number;
  failedRuns: number;
  excludedRuns: number;
  attempts: number;
  requeues: number;
  /** Failed with no attempt, not reviewed, no current attempt, no pending Run, under the requeue limit. */
  canRequeue: boolean;
}

export interface ConsoleRetestGroup {
  id: string;
  sequence: number;
  state: RetestGroupState;
  text: Record<RetestTextField, string>;
  actionType: string;
  thresholdBelowLimit: boolean;
  observationDays: number;
  implementBy: string;
  customerApprovalRef: string;
  customerApprovedOn: string;
  registeredAt: string;
  wentLiveOn: string | null;
  implementedAt: string | null;
  windowClosesAt: string | null;
  abandonedAt: string | null;
  /** True until the first retest answer exists (abandonment's own rule). */
  canAbandon: boolean;
  /** The window has closed and the group is implemented, not prepared. */
  canPrepare: boolean;
  questions: { pilotQuestionId: string; ordinal: number; cells: ConsoleRetestCell[] }[];
  notes: { id: string; notedOn: string; kind: string; text: string; correctsNoteId: string | null; writtenAt: string }[];
}

export interface ConsoleRetestQuestion {
  pilotQuestionId: string;
  ordinal: number;
  text: string;
  /** Null when it can be chosen; otherwise the first reason register_pilot_retest would give, in words. */
  refusal: string | null;
}

export interface ConsoleRetests {
  groups: ConsoleRetestGroup[];
  liveGroup: ConsoleRetestGroup | null;
  /** No live group, fewer than 2 groups, and the pilot open (§3.4). */
  canRegister: boolean;
  questions: ConsoleRetestQuestion[];
  sourceActions: { versionId: string; title: string }[];
  /** Member ids of questions in a group that is not withdrawn (Retire is hidden for them). */
  questionsInLiveGroup: string[];
  preparedNotRun: number;
}

const FAILED = new Set(["failed", "timed_out", "cancelled"]);

/**
 * The pilot page's Retest card: every group with its members' states and
 * counts, the notes, the questions that may be registered (with the reason
 * for each that may not, computed on the same facts and in the same order as
 * register_pilot_retest), and the reviewed source actions.
 */
export async function loadPilotRetests(
  client: SupabaseClient,
  pilot: { id: string; status: "active" | "closed"; startsOn: string; endsOn: string },
  questions: PilotQuestionRow[],
  today: string,
  nowMs: number = Date.now()
): Promise<ConsoleRetests> {
  const r = await readRetestRows(client, pilot.id, questions.map((q) => q.id));
  const questionById = new Map(questions.map((q) => [q.id, q]));
  const groups: ConsoleRetestGroup[] = [...r.groups]
    .sort((a, b) => Number(a.sequence) - Number(b.sequence))
    .map((g) => {
      const state = groupStateOf(g);
      const own = r.members.filter((m) => String(m.pilot_retest_id) === String(g.id));
      let anyAttempt = false;
      const byQuestion = new Map<string, ConsoleRetestCell[]>();
      for (const m of own) {
        const q = questionById.get(String(m.pilot_question_id));
        const f = finalityOf(r, m, pilot, q?.retiredAt !== null && q?.retiredAt !== undefined, today);
        if (f.attempts.length > 0) anyAttempt = true;
        const job = f.job;
        const lease = job?.lease_expires_at ? Date.parse(String(job.lease_expires_at)) : Number.NaN;
        const status = job ? String(job.status) : null;
        const protocol = f.slot ? r.protocols.get(String(f.slot.protocol_id)) : undefined;
        const requeues = r.requeues.get(String(m.id)) ?? 0;
        const cell: ConsoleRetestCell = {
          memberId: String(m.id),
          engine: String(m.engine) as PilotQuestionEngine,
          state: retestMemberState({
            groupState: state,
            windowClosesAt: str(g.window_closes_at),
            nowMs,
            retest: f.slot ? { jobStatus: status, attempts: f.attempts.length, final: f.final } : null,
          }),
          jobStatus: status,
          stale: (status === "claimed" || status === "running") && !Number.isNaN(lease) && lease <= nowMs,
          needsReviewReason: job ? str(job.needs_review_reason) : null,
          plannedRuns: num(protocol?.planned_baseline_runs),
          runCap: num(protocol?.run_cap),
          spendCapUsd: protocol?.spend_cap_usd === null || protocol?.spend_cap_usd === undefined ? null : Number(protocol.spend_cap_usd),
          completedRuns: f.attempts.filter((a) => a.status === "completed").length,
          failedRuns: f.attempts.filter((a) => FAILED.has(String(a.status))).length,
          excludedRuns: f.attempts.filter((a) => a.status === "excluded").length,
          attempts: f.attempts.length,
          requeues,
          canRequeue:
            state === "prepared" &&
            status === "failed" &&
            f.attempts.length === 0 &&
            job !== null &&
            job.review_resolution === null &&
            job.current_attempt_id === null &&
            !r.pendingJobIds.has(String(job.id)) &&
            requeues < MAX_REQUEUES,
        };
        const list = byQuestion.get(String(m.pilot_question_id)) ?? [];
        list.push(cell);
        byQuestion.set(String(m.pilot_question_id), list);
      }
      const notes = r.notes
        .filter((n) => String(n.pilot_retest_id) === String(g.id))
        .sort((a, b) => Date.parse(String(a.written_at)) - Date.parse(String(b.written_at)))
        .map((n) => ({
          id: String(n.id),
          notedOn: String(n.noted_on),
          kind: String(n.kind),
          text: String(n.text),
          correctsNoteId: str(n.corrects_note_id),
          writtenAt: String(n.written_at),
        }));
      const closes = str(g.window_closes_at);
      return {
        id: String(g.id),
        sequence: Number(g.sequence),
        state,
        text: {
          changeTitle: String(g.change_title),
          changeDescription: String(g.change_description),
          changeTarget: String(g.change_target),
          changeOwner: String(g.change_owner),
          hypothesis: String(g.hypothesis),
          expectedMechanism: String(g.expected_mechanism),
          alternativeExplanations: String(g.alternative_explanations),
          openQuestions: String(g.open_questions),
          decisionThreshold: String(g.decision_threshold),
          confoundersToMonitor: String(g.confounders_to_monitor),
        },
        actionType: String(g.action_type),
        thresholdBelowLimit: g.threshold_below_limit === true,
        observationDays: Number(g.observation_days),
        implementBy: String(g.implement_by),
        customerApprovalRef: String(g.customer_approval_ref),
        customerApprovedOn: String(g.customer_approved_on),
        registeredAt: String(g.registered_at),
        wentLiveOn: str(g.went_live_on),
        implementedAt: str(g.implemented_at),
        windowClosesAt: closes,
        abandonedAt: str(g.abandoned_at),
        canAbandon: state !== "abandoned" && !anyAttempt,
        canPrepare: state === "implemented" && closes !== null && Date.parse(closes) <= nowMs,
        questions: [...byQuestion.entries()]
          .map(([pilotQuestionId, cells]) => ({
            pilotQuestionId,
            ordinal: questionById.get(pilotQuestionId)?.ordinal ?? 0,
            cells: cells.sort((a, b) => (a.engine === b.engine ? 0 : a.engine === "perplexity_sonar" ? -1 : 1)),
          }))
          .sort((a, b) => a.ordinal - b.ordinal),
        notes,
      };
    });

  const liveGroup = groups.find((g) => g.state !== "abandoned") ?? null;
  const pilotOpen = pilot.status === "active" && today <= pilot.endsOn;

  // The questions that may be registered: §2.6 step 7's facts, read for every live question.
  const live = questions.filter((q) => q.retiredAt === null);
  const baselineIds = live.flatMap((q) => Object.values(q.engines).flatMap((m) => (m ? [m.protocolId] : [])));
  const [baselineAttempts, holders] = baselineIds.length
    ? await Promise.all([
        rows(client.from("protocol_attempts").select("protocol_id,attempt_kind,status,probe_run_id,reserved_at").in("protocol_id", baselineIds)),
        rows(client.from("interventions").select("protocol_id,status").in("protocol_id", baselineIds).in("status", ["proposed", "approved", "implemented"])),
      ])
    : [[], []];
  const probeRunIds = baselineAttempts.map((a) => a.probe_run_id).filter((x): x is string => typeof x === "string");
  const readableRuns = new Set(
    probeRunIds.length
      ? (await rows(client.from("probe_results").select("probe_run_id,client_mentioned").in("probe_run_id", probeRunIds)))
          .filter((p) => p.client_mentioned !== null && p.client_mentioned !== undefined)
          .map((p) => String(p.probe_run_id))
      : []
  );
  const liveAts = r.groups.map((g) => changeLiveAt({ implementedAt: str(g.implemented_at), wentLiveOn: str(g.went_live_on) })).filter((x): x is number => x !== null);
  const inEarlierLive = new Set(
    r.members
      .filter((m) => r.groups.some((g) => String(g.id) === String(m.pilot_retest_id) && g.implemented_at))
      .map((m) => String(m.pilot_question_id))
  );
  const held = new Set(holders.map((h) => String(h.protocol_id)));
  const factsOf = (protocolId: string | null, plannedRuns: number | null, jobStatus: string | null): RetestBaselineFacts => {
    if (!protocolId) {
      return { exists: false, plannedRuns: null, jobStatus: null, attemptsInFlight: 0, readable: 0, reservedBeforeEarlierChange: false, alreadyRegistered: false };
    }
    const own = baselineAttempts.filter((a) => String(a.protocol_id) === protocolId);
    return {
      exists: true,
      plannedRuns,
      jobStatus,
      attemptsInFlight: own.filter((a) => a.status === "reserved" || a.status === "in_progress").length,
      readable: own.filter((a) => a.attempt_kind === "baseline" && a.status === "completed" && typeof a.probe_run_id === "string" && readableRuns.has(a.probe_run_id)).length,
      reservedBeforeEarlierChange: own.some((a) => typeof a.reserved_at === "string" && liveAts.some((t) => Date.parse(a.reserved_at as string) < t)),
      alreadyRegistered: held.has(protocolId),
    };
  };
  const consoleQuestions: ConsoleRetestQuestion[] = live.map((q) => {
    const refusal = retestQuestionRefusal({
      retired: false,
      inEarlierLiveChange: inEarlierLive.has(q.id),
      engines: {
        perplexity_sonar: factsOf(q.engines.perplexity_sonar?.protocolId ?? null, q.engines.perplexity_sonar?.plannedRuns ?? null, q.engines.perplexity_sonar?.jobStatus ?? null),
        openai_chatgpt: factsOf(q.engines.openai_chatgpt?.protocolId ?? null, q.engines.openai_chatgpt?.plannedRuns ?? null, q.engines.openai_chatgpt?.jobStatus ?? null),
      },
    });
    return {
      pilotQuestionId: q.id,
      ordinal: q.ordinal,
      text: q.questionText,
      refusal: refusal ? retestQuestionRefusalWords(refusal.refusal, refusal.engine) : null,
    };
  });

  const sourceActions = (await readReportableActions(client, pilot.id)).map((a) => ({ versionId: a.versionId, title: a.title }));
  return {
    groups,
    liveGroup,
    canRegister: liveGroup === null && groups.length < 2 && pilotOpen,
    questions: consoleQuestions,
    sourceActions,
    questionsInLiveGroup: liveGroup ? liveGroup.questions.map((q) => q.pilotQuestionId) : [],
    preparedNotRun: liveGroup
      ? liveGroup.questions.flatMap((q) => q.cells).filter((c) => c.state === "retest_not_run" && liveGroup.state === "prepared").length
      : 0,
  };
}

/** Whether a question is in a registered change that is not withdrawn (its Retire is hidden; the RPC refuses anyway). */
export async function questionInLiveRetest(client: SupabaseClient, pilotQuestionId: string): Promise<boolean> {
  const members = await rows(client.from("pilot_retest_members").select("pilot_retest_id").eq("pilot_question_id", pilotQuestionId));
  if (members.length === 0) return false;
  const groups = await rows(
    client.from("pilot_retests").select("id,abandoned_at").in("id", [...new Set(members.map((m) => String(m.pilot_retest_id)))])
  );
  return groups.some((g) => g.abandoned_at === null || g.abandoned_at === undefined);
}

/* ---------------------------------------------------------------- staleness and shared cards */

/** What the share block compares a revision's manifest with (20261109190000, share check). */
export interface CurrentRetestState {
  groups: { id: string; state: RetestGroupState; memberIds: string[] }[];
  noteIds: string[];
  jobs: { jobId: string; protocolId: string; status: string; reviewResolution: string | null }[];
  attemptIds: string[];
  /** A retest job with a live lease or an unexpired pending Run, or a retest attempt reserved or in progress. */
  inProgress: boolean;
}

export async function currentRetestState(client: SupabaseClient, pilotId: string, questionIds: string[]): Promise<CurrentRetestState> {
  const r = await readRetestRows(client, pilotId, questionIds);
  const now = Date.now();
  const jobs = [...r.jobs.values()];
  const attempts = [...r.attempts.values()].flat();
  return {
    groups: r.groups.map((g) => ({
      id: String(g.id),
      state: groupStateOf(g),
      memberIds: r.members.filter((m) => String(m.pilot_retest_id) === String(g.id)).map((m) => String(m.id)),
    })),
    noteIds: r.notes.map((n) => String(n.id)),
    jobs: jobs.map((j) => ({
      jobId: String(j.id),
      protocolId: String(j.protocol_id),
      status: String(j.status),
      reviewResolution: str(j.review_resolution),
    })),
    attemptIds: attempts.map((a) => String(a.id)),
    inProgress:
      jobs.some((j) => (j.status === "claimed" || j.status === "running") && typeof j.lease_expires_at === "string" && Date.parse(j.lease_expires_at) > now) ||
      jobs.some((j) => r.pendingJobIds.has(String(j.id))) ||
      attempts.some((a) => a.status === "reserved" || a.status === "in_progress"),
  };
}

const setKey = (xs: string[]) => [...xs].sort().join(",");

/**
 * The share block's two checks in TypeScript (RETEST_IN_PROGRESS and
 * RETESTS_STALE), for the pilot page's and the preview's "stale": the
 * revision's manifest must still describe the pilot's retests as they are,
 * and nothing of a retest may be running or about to. A revision built
 * before D-062 lists none, so it is current until a group exists.
 */
export function revisionRetestsCurrent(manifest: RevisionRetestManifest, current: CurrentRetestState): boolean {
  if (current.inProgress) return false;
  const groupKey = (g: { id: string; state: string; memberIds: string[] }) => `${g.id}|${g.state}|${setKey(g.memberIds)}`;
  if (setKey(manifest.retests.map(groupKey)) !== setKey(current.groups.map(groupKey))) return false;
  if (setKey(manifest.retestNotes) !== setKey(current.noteIds)) return false;
  const jobKey = (j: { jobId: string; protocolId: string; status: string; reviewResolution: string | null }) =>
    `${j.jobId}|${j.protocolId}|${j.status}|${j.reviewResolution ?? "-"}`;
  if (setKey(manifest.retestJobs.map(jobKey)) !== setKey(current.jobs.map(jobKey))) return false;
  const listed = new Set(manifest.attemptIds);
  return current.attemptIds.every((id) => listed.has(id));
}

/**
 * M19 — the members whose retest is card-eligible now (final, with at least
 * one answer, in a change that is not withdrawn) that no shared revision's
 * manifest lists among its cards.
 */
export async function cardsNotYetShared(
  client: SupabaseClient,
  pilot: { id: string; status: "active" | "closed"; startsOn: string; endsOn: string },
  questions: PilotQuestionRow[],
  today: string
): Promise<string[]> {
  const r = await readRetestRows(client, pilot.id, questions.map((q) => q.id));
  if (r.groups.length === 0) return [];
  const retired = new Map(questions.map((q) => [q.id, q.retiredAt !== null]));
  const eligible = r.members
    .filter((m) => r.groups.some((g) => String(g.id) === String(m.pilot_retest_id) && !g.abandoned_at))
    .filter((m) => {
      const f = finalityOf(r, m, pilot, retired.get(String(m.pilot_question_id)) ?? false, today);
      return f.final && f.attempts.length > 0;
    })
    .map((m) => String(m.id));
  if (eligible.length === 0) return [];
  const shared = await rows(
    client.from("pilot_report_artifacts").select("manifest,shared_at").eq("pilot_id", pilot.id).not("shared_at", "is", null)
  );
  const listed = new Set(
    shared.flatMap((a) => {
      const cards = a.manifest && typeof a.manifest === "object" ? (a.manifest as Row).retestCards : undefined;
      return Array.isArray(cards) ? cards.map((c) => String((c as Row).memberId)) : [];
    })
  );
  return eligible.filter((id) => !listed.has(id));
}
