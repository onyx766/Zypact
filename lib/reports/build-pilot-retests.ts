/**
 * D-062 — the pilot retest inside the pilot report: every registered change
 * as stored, and one Outcome Card per question and engine whose retest is
 * final with at least one answer (M1).
 *
 * Pure: no database, network, provider or model. `buildPilotReport` calls it
 * with what read-pilot-evidence.ts read and the baseline reports it already
 * built, so a card's "before" is exactly the question section's figures.
 *
 * Each card compares one question on one engine (rule pilot-outcome-card/1,
 * METHODOLOGY §10): nothing here adds, averages or counts anything across
 * cards, questions or engines. Retest evidence never enters the brand,
 * competitor, source, conditions or engine sections (decision 8); it enters
 * only the manifest and the evidence index, marked `phase: "retest"`.
 *
 * Every registered text and note is linted again here (M4). A hit is never
 * shown: the value becomes PILOT_RETEST_WITHHELD_TEXT, the field is listed,
 * and the report needs review, naming the field.
 */
import type { PilotQuestionEngine } from "@/lib/db/types";
import { lintPilotActionText } from "@/lib/pilots/action-rules";
import {
  PILOT_OUTCOME_RULE,
  RETEST_PLANNED_RUNS,
  RETEST_TEXT_LABELS,
  retestGroupState,
  retestJobIsFinal,
  retestMemberState,
  type RetestGroupState,
  type RetestTextField,
} from "@/lib/pilots/retest-rules";
import { buildOutcomeCard } from "@/lib/reports/build-outcome-card";
import { buildProtocolReport } from "@/lib/reports/build-protocol-report";
import { smallestDetectableChange } from "@/lib/reports/compare-protocols";
import type { MeasurementCompatibility } from "@/lib/reports/measurement-fingerprint";
import { NON_CAUSALITY_FOOTER } from "@/lib/reports/outcome-card-types";
import type {
  PilotAttemptCounts,
  PilotEngineKey,
  PilotEvidenceEntry,
  PilotExecutionWindow,
  PilotOutcomeCard,
  PilotOutcomeCardPhase,
  PilotReportManifest,
  PilotReportRetest,
  PilotReportRetestMember,
  PilotRetestText,
} from "@/lib/reports/pilot-report-types";
import { OUTCOME_REASON_WORDS, pilotOutcomeRuleNote, PILOT_RETEST_WITHHELD_TEXT } from "@/lib/reports/pilot-retest-copy";
import type { BuildProtocolReportInput, ProtocolReportPayload } from "@/lib/reports/protocol-report-types";

/* ---------------------------------------------------------------- input (read-pilot-evidence.ts) */

export interface PilotRetestInterventionInput {
  status: string;
  protocolId: string;
  approvedAt: string | null;
  implementedAt: string | null;
  windowOpensAt: string | null;
  windowClosesAt: string | null;
  protocolDeviations: string | null;
  earlyRetestAuthorizedAt: string | null;
  hypothesis: string;
  expectedMechanism: string;
  actionType: string;
  actionTarget: string;
  owner: string;
  alternativeExplanations: string | null;
  confoundersToMonitor: string | null;
  decisionThresholdNote: string | null;
}

export interface PilotRetestAttemptInput {
  id: string;
  jobId: string;
  status: string;
  baselineOrdinal: number | null;
  terminalizedAt: string | null;
  retryOfAttemptId: string | null;
  reservedAt: string | null;
}

export interface PilotRetestSlotInput {
  protocolId: string;
  protocol: {
    provider: string;
    surface: string;
    plannedBaselineRuns: number | null;
    runCap: number;
    /** `minimum_useful_change.value`, null when absent or not a number. */
    minimumUsefulChange: number | null;
    detectableChangeAtPlan: number | null;
    baselineProtocolId: string | null;
    buyerQuestionVersionId: string;
  };
  job: {
    id: string;
    status: string;
    failureReason: string | null;
    reviewResolution: string | null;
    currentAttemptId: string | null;
    nextBaselineOrdinal: number;
  } | null;
  attempts: PilotRetestAttemptInput[];
  evidence: BuildProtocolReportInput;
  execution: PilotExecutionWindow;
  answerModes: string[];
  /** Both phases' measurement fingerprints compared; null when the retest has no attempt yet. */
  compatibility: MeasurementCompatibility | null;
}

export interface PilotRetestMemberInput {
  id: string;
  pilotQuestionId: string;
  engine: PilotEngineKey;
  baselineProtocolId: string;
  interventionId: string;
  /** The member's `requeue` steps. */
  requeueCount: number;
  /** The member baseline protocol's buyer_question_version_id. */
  baselineQuestionVersionId: string | null;
  intervention: PilotRetestInterventionInput | null;
  retest: PilotRetestSlotInput | null;
}

export interface PilotRetestNoteInput {
  id: string;
  notedOn: string;
  kind: string;
  text: string;
  correctsNoteId: string | null;
  writtenAt: string;
}

export interface PilotRetestGroupInput {
  id: string;
  sequence: number;
  registeredAt: string;
  customerApprovedOn: string;
  text: PilotRetestText;
  actionType: string;
  thresholdBelowLimit: boolean;
  outcomeRule: string;
  observationDays: number;
  implementBy: string;
  /** In stored order; the title is null once the action is withdrawn (M13). */
  sourceActions: { versionId: string; title: string | null; withdrawn: boolean }[];
  implementedAt: string | null;
  windowOpensAt: string | null;
  windowClosesAt: string | null;
  wentLiveOn: string | null;
  evidenceUrl: string | null;
  artifactSha256: string | null;
  implementedAsRegistered: boolean | null;
  retestsPreparedAt: string | null;
  abandonedAt: string | null;
  notes: PilotRetestNoteInput[];
  members: PilotRetestMemberInput[];
}

export interface PilotRetestsInput {
  groups: PilotRetestGroupInput[];
  /** Each baseline slot protocol's latest attempt `reserved_at` (M6b, M17), null when it has none. */
  baselineLatestReservedAt: Record<string, string | null>;
}

/** What buildPilotReport hands over: the questions with their built baseline reports. */
export interface PilotRetestBaselineQuestion {
  pilotQuestionId: string;
  ordinal: number;
  retired: boolean;
  /** Each baseline slot with its section's own report, counts and dates, so a card's "before" is the section's. */
  slots: {
    engine: PilotEngineKey;
    protocolId: string;
    report: ProtocolReportPayload;
    counts: PilotAttemptCounts;
    execution: PilotExecutionWindow;
  }[];
}

export interface BuildPilotRetestsArgs {
  retests: PilotRetestsInput;
  questions: PilotRetestBaselineQuestion[];
  pilot: { projectId: string; status: "active" | "closed"; startsOn: string; endsOn: string };
  subject: BuildProtocolReportInput["subject"];
  now: Date;
  /** The report's own attempt accounting (build-pilot-report.ts countAttempts), passed in to keep one rule. */
  countAttempts: (evidence: BuildProtocolReportInput, report: ProtocolReportPayload) => PilotAttemptCounts;
  /** The probe modes that are live answers (build-pilot-report.ts LIVE_ANSWER_MODES). */
  liveAnswerModes: ReadonlySet<string>;
}

/** One card's two built reports and facts, for the integrity rule (process-pilot-report.ts). */
export interface PilotCardBuild {
  memberId: string;
  ordinal: number;
  engine: PilotEngineKey;
  baselineReport: ProtocolReportPayload;
  retestReport: ProtocolReportPayload;
  interventionRegisteredAndImplemented: boolean;
  measurement: { comparable: boolean; detail: string };
}

export interface BuiltPilotRetests {
  retests: PilotReportRetest[];
  outcomeCards: PilotOutcomeCard[];
  /** The retest slots' protocols and attempts, and the four D-062 keys. */
  manifest: Required<Pick<PilotReportManifest, "retests" | "retestNotes" | "retestJobs" | "retestCards">> &
    Pick<PilotReportManifest, "protocols" | "attempts">;
  evidenceIndex: PilotEvidenceEntry[];
  structural: { status: "needs_review" | "blocked"; reason: string }[];
  /** Per question id (M17). */
  collectedAfterChange: Map<string, { registeredOn: string; liveOn: string }[]>;
  cardBuilds: PilotCardBuild[];
  /** The rule's method note, when any group is shown (M16). */
  methodNote: string | null;
}

/* ---------------------------------------------------------------- helpers */

const ENGINE_WORDS: Record<PilotEngineKey, string> = { perplexity_sonar: "Perplexity", openai_chatgpt: "ChatGPT" };
const ENGINE_ORDER: readonly PilotQuestionEngine[] = ["perplexity_sonar", "openai_chatgpt"];
const MIN_USEFUL_CHANGE = 0.6;

const iso = (instant: string) => new Date(instant).toISOString();
const dayOf = (instant: string) => iso(instant).slice(0, 10);
const ms = (instant: string | null) => (instant ? Date.parse(instant) : Number.NaN);

/** The instant a change went live for M6b and M17: least(implemented_at, went_live_on at 00:00 UTC). */
export function changeLiveAt(g: { implementedAt: string | null; wentLiveOn: string | null }): number | null {
  if (!g.implementedAt) return null;
  const recorded = ms(g.implementedAt);
  const reported = g.wentLiveOn ? Date.parse(`${g.wentLiveOn}T00:00:00Z`) : Number.NaN;
  return Number.isNaN(reported) ? recorded : Math.min(recorded, reported);
}

const MEMBER_STATE_REVIEW: Partial<Record<string, string>> = {
  retest_not_run: "has not been measured again yet",
  retest_collecting: "is still being measured again",
  retest_held_for_review: "is held for review",
  retest_stopped_retryable: "stopped before finishing and may still continue",
  retest_could_not_run: "could not be measured again",
};

/* ---------------------------------------------------------------- the builder */

export function buildPilotRetests(args: BuildPilotRetestsArgs): BuiltPilotRetests {
  const { now } = args;
  const today = now.toISOString().slice(0, 10);
  const structural: BuiltPilotRetests["structural"] = [];
  const manifest: BuiltPilotRetests["manifest"] = {
    protocols: [],
    attempts: [],
    retests: [],
    retestNotes: [],
    retestJobs: [],
    retestCards: [],
  };
  const evidenceIndex: PilotEvidenceEntry[] = [];
  const retests: PilotReportRetest[] = [];
  const outcomeCards: PilotOutcomeCard[] = [];
  const cardBuilds: PilotCardBuild[] = [];
  const collectedAfterChange = new Map<string, { registeredOn: string; liveOn: string }[]>();
  const questionById = new Map(args.questions.map((q) => [q.pilotQuestionId, q]));

  const groups = [...args.retests.groups].sort((a, b) => a.sequence - b.sequence);
  if (groups.length > 0) {
    structural.push({
      status: "needs_review",
      reason: "This revision shows a registered change and its retest. Sharing it is the recorded review of its Outcome Cards.",
    });
  }

  for (const g of groups) {
    const groupState: RetestGroupState = retestGroupState(g);
    const label = `Retest ${g.sequence}`;

    // M4 — the registered text, linted again at build: a hit is withheld.
    const text = { ...g.text };
    const withheldFields: string[] = [];
    for (const field of Object.keys(RETEST_TEXT_LABELS) as RetestTextField[]) {
      const hits = lintPilotActionText(g.text[field] ?? "");
      if (hits.length === 0) continue;
      text[field] = PILOT_RETEST_WITHHELD_TEXT;
      withheldFields.push(field);
      structural.push({
        status: "needs_review",
        reason: `${label}: "${RETEST_TEXT_LABELS[field]}" uses wording this report may not use (${hits.map((h) => `"${h}"`).join(", ")}), so it is withheld.`,
      });
    }
    const notes = [...g.notes]
      .sort((a, b) => ms(a.writtenAt) - ms(b.writtenAt) || a.id.localeCompare(b.id))
      .map((n) => {
        const hits = lintPilotActionText(n.text);
        if (hits.length > 0) {
          structural.push({
            status: "needs_review",
            reason: `${label}: a note of ${n.notedOn} uses wording this report may not use (${hits.map((h) => `"${h}"`).join(", ")}), so it is withheld.`,
          });
        }
        return {
          id: n.id,
          notedOn: n.notedOn,
          kind: n.kind,
          text: hits.length > 0 ? PILOT_RETEST_WITHHELD_TEXT : n.text,
          withheld: hits.length > 0,
          correctsNoteId: n.correctsNoteId,
          writtenAt: iso(n.writtenAt),
        };
      });
    manifest.retestNotes.push(...notes.map((n) => n.id));

    if (g.outcomeRule !== PILOT_OUTCOME_RULE) {
      structural.push({ status: "blocked", reason: `${label} follows an outcome rule this report does not know.` });
    }

    const members = [...g.members].sort((a, b) => {
      const qa = questionById.get(a.pilotQuestionId)?.ordinal ?? 0;
      const qb = questionById.get(b.pilotQuestionId)?.ordinal ?? 0;
      return qa - qb || ENGINE_ORDER.indexOf(a.engine) - ENGINE_ORDER.indexOf(b.engine);
    });
    const reportMembers: PilotReportRetestMember[] = [];

    for (const m of members) {
      const question = questionById.get(m.pilotQuestionId);
      const engineWords = ENGINE_WORDS[m.engine] ?? "Unknown engine";
      if (!question) {
        structural.push({ status: "blocked", reason: `${label}: a member's question is not one of this pilot's questions.` });
        continue;
      }
      const where = `Question ${question.ordinal} (${engineWords})`;
      const baselineSlot = question.slots.find((s) => s.engine === m.engine) ?? null;
      const live = groupState !== "abandoned";

      // The member's baseline is its slot's baseline (the members' foreign key says so; defence in depth).
      if (!baselineSlot || baselineSlot.protocolId !== m.baselineProtocolId) {
        structural.push({ status: "blocked", reason: `${where}: the retest's baseline is not this question's measurement on ${engineWords}.` });
      }
      const baselineReport = baselineSlot?.protocolId === m.baselineProtocolId ? baselineSlot.report : null;

      if (live) {
        // The member's intervention is the group's: its state and its eight registered texts.
        const iv = m.intervention;
        const expected = groupState === "registered" ? "approved" : "implemented";
        if (!iv || iv.status !== expected || iv.protocolId !== m.baselineProtocolId) {
          structural.push({ status: "blocked", reason: `${where}: its registered intervention is not in the state its change is in.` });
        } else if (
          iv.hypothesis !== g.text.hypothesis || iv.expectedMechanism !== g.text.expectedMechanism ||
          iv.actionType !== g.actionType || iv.actionTarget !== g.text.changeTarget || iv.owner !== g.text.changeOwner ||
          iv.alternativeExplanations !== g.text.alternativeExplanations || iv.confoundersToMonitor !== g.text.confoundersToMonitor ||
          iv.decisionThresholdNote !== g.text.decisionThreshold
        ) {
          structural.push({ status: "blocked", reason: `${where}: its registered intervention's text differs from the registered change.` });
        } else if (iv.protocolDeviations !== null || iv.earlyRetestAuthorizedAt !== null) {
          structural.push({ status: "blocked", reason: `${where}: its intervention records a deviation or an early retest, which a pilot retest never allows.` });
        }
        // M3: the baseline still has 5 readable answers.
        if (baselineReport && baselineReport.observation.denominator < RETEST_PLANNED_RUNS) {
          structural.push({ status: "blocked", reason: `${where}: its baseline no longer has ${RETEST_PLANNED_RUNS} readable answers.` });
        }
        // Risk 3: no baseline answer at or after the change was recorded as live.
        const latest = ms(args.retests.baselineLatestReservedAt[m.baselineProtocolId] ?? null);
        if (g.implementedAt && !Number.isNaN(latest) && latest >= ms(g.implementedAt)) {
          structural.push({ status: "blocked", reason: `${where}: a baseline answer was collected after the change was recorded as live.` });
        }
      }

      const slot = m.retest;
      let counts: PilotAttemptCounts | null = null;
      let execution: PilotExecutionWindow | null = null;
      let retestReport: ProtocolReportPayload | null = null;
      let final = false;
      if (slot) {
        const p = slot.protocol;
        if (
          p.baselineProtocolId !== m.baselineProtocolId || p.provider !== m.engine ||
          (baselineReport !== null && (p.provider !== baselineReport.protocol.provider || p.surface !== baselineReport.protocol.surface)) ||
          (m.baselineQuestionVersionId !== null && p.buyerQuestionVersionId !== m.baselineQuestionVersionId)
        ) {
          structural.push({ status: "blocked", reason: `${where}: its retest is not the same question, engine and answer format as its baseline.` });
        }
        if (p.plannedBaselineRuns !== RETEST_PLANNED_RUNS) {
          structural.push({ status: "blocked", reason: `${where}: its retest does not plan ${RETEST_PLANNED_RUNS} answers.` });
        }
        if (p.minimumUsefulChange === null || Math.abs(p.minimumUsefulChange - MIN_USEFUL_CHANGE) > 1e-9) {
          structural.push({ status: "blocked", reason: `${where}: its retest's smallest change that counts is not 60 points.` });
        }
        const closes = ms(g.windowClosesAt);
        if (slot.attempts.some((a) => !Number.isNaN(closes) && ms(a.reservedAt) < closes)) {
          structural.push({ status: "blocked", reason: `${where}: a retest answer was collected before the waiting period ended.` });
        }

        // The brand looked for is the evidence's own (the project's), as for a baseline section.
        retestReport = buildProtocolReport({
          ...slot.evidence,
          subject: { ...slot.evidence.subject, websiteUrl: args.subject.websiteUrl, normalizedDomain: args.subject.normalizedDomain },
          now,
        });
        counts = args.countAttempts(slot.evidence, retestReport);
        execution = slot.execution;
        if (slot.job) {
          final = retestJobIsFinal({
            job: slot.job,
            protocol: { plannedBaselineRuns: p.plannedBaselineRuns, runCap: p.runCap },
            attempts: slot.attempts,
            pilot: args.pilot,
            questionRetired: question.retired,
            requeueCount: m.requeueCount,
            today,
          });
          manifest.retestJobs.push({
            jobId: slot.job.id,
            protocolId: slot.protocolId,
            status: slot.job.status,
            reviewResolution: slot.job.reviewResolution,
          });
        }

        // Every retest protocol and attempt is in the manifest, card or not (the save requires them).
        manifest.protocols.push(slot.protocolId);
        const shaByProbeRun = new Map(slot.evidence.results.map((r) => [r.probeRunId, r.rawResponseSha256]));
        for (const a of slot.evidence.attempts) {
          const sha = a.probeRunId ? shaByProbeRun.get(a.probeRunId) ?? null : null;
          manifest.attempts.push({ id: a.id, protocolId: slot.protocolId, rawResponseSha256: sha });
          evidenceIndex.push({
            attemptId: a.id,
            pilotQuestionId: m.pilotQuestionId,
            ordinal: question.ordinal,
            engine: m.engine,
            protocolId: slot.protocolId,
            status: a.status,
            rawResponseSha256: sha,
            phase: "retest",
          });
        }

        // M8 — the D-055 item 10 checks, per retest slot with an answer.
        if (counts.completed > 0) {
          if (slot.answerModes.some((mode) => !args.liveAnswerModes.has(mode))) {
            structural.push({ status: "needs_review", reason: `${where}: some retest answers were not live answers from the provider.` });
          }
          if (slot.answerModes.length === 0) {
            structural.push({ status: "needs_review", reason: `${where}: some retest answers have no recorded answer mode.` });
          }
          if (retestReport.protocol.analyzerVersion === null) {
            structural.push({ status: "needs_review", reason: `${where}: some retest answers have no recorded analysis version.` });
          }
          if (!execution.firstOn || !execution.lastOn) {
            structural.push({ status: "needs_review", reason: `${where}: the retest answers have no recorded dates.` });
          }
        }
        if (!counts.reconciles) {
          structural.push({ status: "needs_review", reason: `${where}: its retest attempt counts do not reconcile.` });
        }
        if (counts.inProgress > 0) {
          structural.push({ status: "needs_review", reason: `${where}: retest answers are still being collected.` });
        }
      } else if (groupState === "prepared") {
        structural.push({ status: "blocked", reason: `${where}: its change was prepared but it has no retest.` });
      }

      const state = retestMemberState({
        groupState,
        windowClosesAt: g.windowClosesAt,
        nowMs: now.getTime(),
        retest: slot ? { jobStatus: slot.job?.status ?? null, attempts: slot.attempts.length, final } : null,
      });
      if (groupState === "prepared" && MEMBER_STATE_REVIEW[state]) {
        structural.push({ status: "needs_review", reason: `${where}: its retest ${MEMBER_STATE_REVIEW[state]}.` });
      }

      reportMembers.push({
        memberId: m.id,
        interventionId: m.interventionId,
        pilotQuestionId: m.pilotQuestionId,
        ordinal: question.ordinal,
        engine: m.engine,
        baselineProtocolId: m.baselineProtocolId,
        retestProtocolId: slot?.protocolId ?? null,
        state,
        counts,
        execution,
      });

      // M1 — a card exactly for a final retest with at least one answer.
      if (state !== "retest_measured" || !slot || !retestReport) continue;
      if (!baselineReport) continue; // blocked above; there is nothing to compare against.

      const iv = m.intervention;
      const compatibility: MeasurementCompatibility = slot.compatibility ?? {
        status: "unverifiable",
        version: "mf-1",
        detail: "The measurement configuration was not read.",
      };
      const oc = buildOutcomeCard({
        projectId: args.pilot.projectId,
        baseline: baselineReport,
        retest: retestReport,
        intervention: {
          hypothesis: iv?.hypothesis ?? g.text.hypothesis,
          expectedMechanism: iv?.expectedMechanism ?? g.text.expectedMechanism,
          actionType: g.actionType,
          actionTarget: g.text.changeTarget,
          owner: g.text.changeOwner,
          approvedAt: iv?.approvedAt ?? null,
          implementedAt: iv?.implementedAt ?? null,
          // A pilot retest never records a deviation or an early retest (the trigger refuses both).
          protocolDeviations: null,
          earlyRetestReason: null,
          observationWindowOpensAt: iv?.windowOpensAt ?? null,
          observationWindowClosesAt: iv?.windowClosesAt ?? null,
        },
        minimumUsefulChange: slot.protocol.minimumUsefulChange ?? MIN_USEFUL_CHANGE,
        measurementCompatibility: compatibility,
        questionVersionIds: {
          baseline: m.baselineQuestionVersionId ?? "",
          retest: slot.protocol.buyerQuestionVersionId,
        },
        detectableChangeAtPlan: slot.protocol.detectableChangeAtPlan,
        now,
      });

      // M15 — only each reason's prefix is kept, never the text after ": ".
      const reasonCodes = [...new Set(oc.comparison.reasons.map((r) => r.split(": ")[0]))];
      for (const code of reasonCodes) {
        if (!Object.hasOwn(OUTCOME_REASON_WORDS, code)) {
          structural.push({ status: "needs_review", reason: `${where} Outcome Card: a comparison reason this report does not know (${code}).` });
        }
      }
      if (compatibility.status !== "compatible") {
        structural.push({ status: "needs_review", reason: `${where} Outcome Card: the two measurements were not shown to be made the same way, so it is inconclusive.` });
      }

      const bd = baselineReport.observation.denominator;
      const rd = retestReport.observation.denominator;
      const sdc = oc.comparison.smallestDetectableChange ?? (bd > 0 && rd > 0 ? smallestDetectableChange(bd, rd) : null);
      const firstAnswer = Math.min(...slot.attempts.map((a) => ms(a.reservedAt)).filter((x) => !Number.isNaN(x)));
      const phase = (report: ProtocolReportPayload, phaseCounts: PilotAttemptCounts, exec: PilotExecutionWindow): PilotOutcomeCardPhase => ({
        protocolId: report.protocol.id,
        numerator: report.observation.numerator,
        denominator: report.observation.denominator,
        planned: report.protocol.plannedBaselineRuns,
        interval: report.observation.interval ? { low: report.observation.interval.low, high: report.observation.interval.high } : null,
        counts: phaseCounts,
        execution: exec,
        answers: report.runs
          .filter((r) => r.status === "completed" && typeof r.evidenceHash === "string" && r.evidenceHash.length > 0)
          .map((r) => ({ number: r.ordinal, sha12: (r.evidenceHash as string).slice(0, 12) })),
      });
      const card: PilotOutcomeCard = {
        memberId: m.id,
        interventionId: m.interventionId,
        retestId: g.id,
        pilotQuestionId: m.pilotQuestionId,
        ordinal: question.ordinal,
        engine: m.engine,
        baselineProtocolId: m.baselineProtocolId,
        retestProtocolId: slot.protocolId,
        status: oc.comparison.status,
        footer: NON_CAUSALITY_FOOTER,
        question: { versionNumber: baselineReport.question.versionNumber, hash: baselineReport.question.hash },
        baseline: phase(baselineReport, baselineSlot!.counts, baselineSlot!.execution),
        retest: phase(retestReport, counts!, slot.execution),
        comparison: {
          delta: oc.comparison.delta,
          intervalLow: oc.comparison.interval?.low ?? null,
          intervalHigh: oc.comparison.interval?.high ?? null,
          minimumUsefulChange: oc.comparison.minimumUsefulChange,
          smallestDetectableChange: sdc,
          reasonCodes,
        },
        detectableChangeAtPlan: oc.detectableChangeAtPlan,
        shortRetest: rd < (slot.protocol.plannedBaselineRuns ?? RETEST_PLANNED_RUNS),
        measurement: {
          verdict: compatibility.status,
          sameAsBaseline: compatibility.status === "compatible",
          differences: compatibility.status === "incompatible" ? [...compatibility.differingFields] : [],
        },
        conditions: {
          provider: retestReport.protocol.provider,
          surface: retestReport.protocol.surface,
          model: retestReport.protocol.model,
          answerModes: [...new Set(slot.answerModes)].sort(),
          methodologyVersion: retestReport.protocol.methodologyVersion,
          analyzerVersion: retestReport.protocol.analyzerVersion === null ? null : String(retestReport.protocol.analyzerVersion),
        },
        sourceComparison: oc.sourceComparison ?? null,
        noteIdsAfterFirstAnswer: Number.isFinite(firstAnswer)
          ? notes.filter((n) => ms(n.writtenAt) >= firstAnswer).map((n) => n.id)
          : [],
      };
      outcomeCards.push(card);
      manifest.retestCards.push({
        memberId: m.id,
        status: card.status,
        retestAttemptIds: slot.attempts.map((a) => a.id).sort(),
      });
      cardBuilds.push({
        memberId: m.id,
        ordinal: question.ordinal,
        engine: m.engine,
        baselineReport,
        retestReport,
        interventionRegisteredAndImplemented: iv?.status === "implemented" && iv.approvedAt !== null,
        measurement: {
          comparable: compatibility.status === "compatible",
          detail: compatibility.status === "compatible" ? "" : compatibility.detail,
        },
      });
    }

    manifest.retests.push({ id: g.id, state: groupState, memberIds: g.members.map((m) => m.id).sort() });
    retests.push({
      retestId: g.id,
      sequence: g.sequence,
      state: groupState,
      registeredOn: dayOf(g.registeredAt),
      customerApprovedOn: g.customerApprovedOn,
      text,
      withheldFields,
      actionType: g.actionType,
      thresholdBelowLimit: g.thresholdBelowLimit,
      outcomeRule: g.outcomeRule,
      observationDays: g.observationDays,
      implementBy: g.implementBy,
      sourceActions: g.sourceActions.map((s) => ({ versionId: s.versionId, title: s.withdrawn ? null : s.title, withdrawn: s.withdrawn })),
      implementation:
        g.implementedAt && g.wentLiveOn
          ? {
              recordedAt: iso(g.implementedAt),
              wentLiveOn: g.wentLiveOn,
              evidenceUrl: g.evidenceUrl,
              artifactSha256: g.artifactSha256,
              implementedAsRegistered: g.implementedAsRegistered === true,
            }
          : null,
      windowOpensAt: g.implementedAt && g.windowOpensAt ? iso(g.windowOpensAt) : null,
      windowClosesAt: g.implementedAt && g.windowClosesAt ? iso(g.windowClosesAt) : null,
      prepared: g.retestsPreparedAt !== null,
      abandoned: g.abandonedAt ? { abandonedOn: dayOf(g.abandonedAt), wasLive: g.implementedAt !== null } : null,
      notes,
      members: reportMembers,
    });

    // M17 — a live question's baseline answer collected at or after this change went live.
    const liveAt = changeLiveAt(g);
    if (liveAt !== null) {
      for (const q of args.questions) {
        if (q.retired) continue;
        for (const s of q.slots) {
          const latest = ms(args.retests.baselineLatestReservedAt[s.protocolId] ?? null);
          if (Number.isNaN(latest) || latest < liveAt) continue;
          structural.push({
            status: "needs_review",
            reason: `Question ${q.ordinal} (${ENGINE_WORDS[s.engine]}): some baseline answers were collected after the change registered on ${dayOf(g.registeredAt)} went live.`,
          });
          const list = collectedAfterChange.get(q.pilotQuestionId) ?? [];
          const entry = { registeredOn: dayOf(g.registeredAt), liveOn: new Date(liveAt).toISOString().slice(0, 10) };
          if (!list.some((e) => e.registeredOn === entry.registeredOn && e.liveOn === entry.liveOn)) list.push(entry);
          collectedAfterChange.set(q.pilotQuestionId, list);
        }
      }
    }
  }

  return {
    retests,
    outcomeCards,
    manifest,
    evidenceIndex,
    structural,
    collectedAfterChange,
    cardBuilds,
    methodNote: groups.length > 0 ? pilotOutcomeRuleNote(args.subject.companyName) : null,
  };
}
