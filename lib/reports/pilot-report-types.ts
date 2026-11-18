/**
 * D-055 — the combined pilot report: one document for all of a pilot's
 * questions (D-053, D-054).
 *
 * The report never re-derives a question's result. Each measured question
 * embeds the exact payload `buildProtocolReport` produces for its protocol,
 * and every cross-question table below is read from those embedded payloads.
 * Rates are kept per question (METHODOLOGY §10): the one portfolio line is
 * an equal-weight aggregate shown beside every per-question result, never in
 * place of them, and never combined across engines.
 */
import type { ProtocolReportPayload } from "@/lib/reports/protocol-report-types";
import type { SourceCategory } from "@/lib/source-insights/source-types";

export const PILOT_REPORT_VERSION = 1 as const;

/** The rule that groups competitor names across questions (§11): trim and case only. */
export const PILOT_COMPETITOR_RULE = "pilot-competitor-names/1" as const;

export type PilotEngineKey = "perplexity_sonar" | "openai_chatgpt";

export interface PilotReportSubject {
  companyName: string;
  websiteUrl: string;
  normalizedDomain: string;
}

/**
 * How far a question's measurement got, in the report's own words.
 *
 * D-061 (review of phase B) — `ended_after_review`: the job succeeded only
 * because a review ended it (resolve_protocol_job_review with
 * `excluded_and_completed`), so fewer planned answers may have been made
 * than planned. Never "finished", never in a total. Absent on revisions
 * built before it.
 */
export type PilotQuestionMeasurementState =
  | "measured"
  | "not_finished"
  | "not_started"
  | "stopped"
  | "ended_after_review";

/**
 * The pilot's own count of a question's attempts on one engine, by stored
 * attempt status (0047): every attempt lands in exactly one bucket, or is
 * counted as `unrecognised`, which makes the counts not reconcile.
 */
export interface PilotAttemptCounts {
  planned: number;
  attempted: number;
  completed: number;
  /** failed, timed_out or cancelled. */
  failed: number;
  /** Excluded after review. */
  excludedByReview: number;
  /** Completed with no readable result. */
  noReadableResult: number;
  /** reserved or in_progress: still being collected. Never counted as failed. */
  inProgress: number;
  /** A status this report does not know. */
  unrecognised: number;
  reconciles: boolean;
}

/** When a question's attempts on one engine were made (protocol_attempts.reserved_at / terminalized_at). */
export interface PilotExecutionWindow {
  firstOn: string | null;
  lastOn: string | null;
}

export interface PilotReportQuestionEngine {
  engine: PilotEngineKey;
  protocolId: string;
  state: PilotQuestionMeasurementState;
  counts: PilotAttemptCounts;
  execution: PilotExecutionWindow;
  /** How each answer was obtained (probe_runs.probe_mode), deduplicated. */
  answerModes: string[];
  /**
   * D-061 — the protocol's recorded setting (`model_config.setting_version`):
   * a ChatGPT protocol's names its model, search mode and service tier; null
   * when the protocol records none (a Perplexity protocol). Absent on
   * revisions built before D-061.
   */
  settingVersion?: string | null;
  /** The question's own report, exactly as `buildProtocolReport` built it. */
  report: ProtocolReportPayload;
}

export interface PilotReportQuestion {
  pilotQuestionId: string;
  ordinal: number;
  text: string;
  provenance: string;
  customerApprovedOn: string;
  retired: boolean;
  retiredOn: string | null;
  /** One entry per engine with a protocol; an engine without one is listed in `engines` as not measured. */
  measurements: PilotReportQuestionEngine[];
}

export interface PilotReportEngineSummary {
  engine: PilotEngineKey;
  label: string;
  /** True when any question of the pilot has a protocol on this engine. */
  measured: boolean;
  /** Questions that are not retired. */
  questionsLive: number;
  /** Live questions with at least one readable answer on this engine. */
  questionsWithReadableAnswer: number;
  /** Live questions on this engine with no attempt yet. */
  questionsNotStarted: number;
  questionsRetired: number;
  /**
   * D-061 — when the engine is measured on some questions: the live questions
   * with no measurement on it, by ordinal. They are in none of this engine's
   * figures, and are named instead. Absent on revisions built before D-061.
   */
  questionsNotMeasured?: number[];
  note: string;
}

/**
 * METHODOLOGY §4 and §16 gate 5, per measured engine: the provider, surface,
 * model and answer mode, the dates, and the method versions. A value is
 * listed once when every question agrees; when questions differ, each value
 * is listed with its questions and the report needs review.
 */
export interface PilotEngineConditions {
  engine: PilotEngineKey;
  /** METHODOLOGY §4's required sentence for this engine, verbatim. */
  surfaceLimitation: string;
  provider: PilotConditionValue[];
  surface: PilotConditionValue[];
  model: PilotConditionValue[];
  answerMode: PilotConditionValue[];
  methodologyVersion: PilotConditionValue[];
  analyzerVersion: PilotConditionValue[];
  /**
   * D-061 — the recorded setting versions ("" for a question that records
   * none); empty when no question of the engine records one, as for
   * Perplexity. Absent on revisions built before D-061.
   */
  settingVersion?: PilotConditionValue[];
  /**
   * D-061 — the rule each question's stored answers were read under for
   * sources (its report's `sourceInsights.extractionVersion`). Absent on
   * revisions built before D-061.
   */
  sourceRule?: PilotConditionValue[];
  executedFrom: string | null;
  executedTo: string | null;
}

export interface PilotConditionValue {
  value: string;
  ordinals: number[];
}

export interface PilotBrandRow {
  ordinal: number;
  pilotQuestionId: string;
  retired: boolean;
  state: PilotQuestionMeasurementState;
  /** Null for a retired question: it shows its attempt counts only. */
  numerator: number | null;
  denominator: number | null;
  counts: PilotAttemptCounts;
  intervalLow: number | null;
  intervalHigh: number | null;
  label: PilotQuestionLabel | null;
}

/** METHODOLOGY §10's descriptive labels, under a disclosed, versioned threshold. */
export type PilotQuestionLabel =
  | "observed_consistently_in_sample"
  | "not_observed_consistently_in_sample"
  | "mixed_in_sample"
  | "insufficient_evidence";

export const PILOT_LABEL_RULE = "pilot-question-labels/1" as const;

export interface PilotPortfolioLine {
  /** Questions whose readable runs are summed. Retired and unfinished questions are left out and named. */
  includedOrdinals: number[];
  leftOutOrdinals: number[];
  numerator: number;
  denominator: number;
  weighting: "equal_per_readable_run";
  heterogeneity: string;
}

export interface PilotEngineBrandSection {
  engine: PilotEngineKey;
  rows: PilotBrandRow[];
  portfolio: PilotPortfolioLine | null;
}

export interface PilotCompetitorRow {
  name: string;
  /** Question ordinals the name appeared in, each with the readable runs naming it there. */
  appearances: { ordinal: number; runs: number; readableRuns: number }[];
}

export interface PilotEngineCompetitorSection {
  engine: PilotEngineKey;
  rule: typeof PILOT_COMPETITOR_RULE;
  rows: PilotCompetitorRow[];
  rowsNotShown: number;
}

export interface PilotSourceCell {
  ordinal: number;
  citedInRuns: number;
  retrievedOnlyInRuns: number;
}

export interface PilotSourceRow {
  category: SourceCategory;
  cells: PilotSourceCell[];
}

export interface PilotEngineSourceSection {
  engine: PilotEngineKey;
  rows: PilotSourceRow[];
  /** Per question: readable runs, and runs whose stored response gave no readable source list. */
  coverage: { ordinal: number; readableRuns: number; runsWithSourceEvidence: number }[];
}

export interface PilotEvidenceEntry {
  attemptId: string;
  pilotQuestionId: string;
  ordinal: number;
  engine: PilotEngineKey;
  protocolId: string;
  status: string;
  rawResponseSha256: string | null;
}

/**
 * D-057 — one stored answer a suggested action rests on, re-checked at this
 * build: a completed answer of this pilot whose stored response re-hashes to
 * its recorded SHA-256, and, when a source is named, that source re-found in
 * the answer's own extracted sources.
 */
export interface PilotReportActionEvidence {
  attemptId: string;
  pilotQuestionId: string;
  /** The question's ordinal. */
  ordinal: number;
  engine: PilotEngineKey;
  /** The answer's run number in that question's report. */
  answerNumber: number;
  rawResponseSha256: string;
  sourceUrl: string | null;
  sourceDomain: string | null;
  /** Whether the answer cites the source (true) or the engine only returned it (false); null without a source. */
  sourceCited: boolean | null;
}

/** D-057 — a suggested action written by the Zypact team: its latest reviewed version. */
export interface PilotReportAction {
  actionId: string;
  versionId: string;
  versionNumber: number;
  title: string;
  observation: string;
  suggestedAction: string;
  whyItMightMatter: string;
  alternativeExplanations: string;
  openQuestions: string;
  /** The day the team reviewed this version (YYYY-MM-DD). */
  reviewedOn: string;
  evidence: PilotReportActionEvidence[];
}

export interface PilotReportPayload {
  reportVersion: typeof PILOT_REPORT_VERSION;
  generatedAt: string;
  pilotId: string;
  projectId: string;
  subject: PilotReportSubject;
  window: { startsOn: string; endsOn: string; status: "active" | "closed" };
  engines: PilotReportEngineSummary[];
  conditions: PilotEngineConditions[];
  questions: PilotReportQuestion[];
  brand: PilotEngineBrandSection[];
  competitors: PilotEngineCompetitorSection[];
  sources: PilotEngineSourceSection[];
  evidenceIndex: PilotEvidenceEntry[];
  limitations: string[];
  /** METHODOLOGY §7, shown wherever a range is shown. */
  dependenceNote: string;
  /** METHODOLOGY §16 gate 12. */
  causalLimit: string;
  methodNotes: string[];
  /**
   * D-057 — the team's reviewed suggested actions. Absent on revisions built
   * before D-057, which had none.
   */
  actions?: PilotReportAction[];
}

/** What the database checks the payload against before saving it. */
export interface PilotReportManifest {
  protocols: string[];
  attempts: { id: string; protocolId: string; rawResponseSha256: string | null }[];
  /** D-057 — the action versions the payload shows; the database checks each is its action's latest reviewed one. */
  actionVersions: string[];
}

export function isPilotReportPayload(value: unknown): value is PilotReportPayload {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  if (c.reportVersion !== PILOT_REPORT_VERSION) return false;
  if (typeof c.pilotId !== "string" || typeof c.generatedAt !== "string") return false;
  for (const key of ["subject", "window"]) {
    if (typeof c[key] !== "object" || c[key] === null) return false;
  }
  if (typeof c.dependenceNote !== "string" || typeof c.causalLimit !== "string") return false;
  if (c.actions !== undefined && !Array.isArray(c.actions)) return false;
  return ["engines", "conditions", "questions", "brand", "competitors", "sources", "evidenceIndex", "limitations", "methodNotes"].every(
    (key) => Array.isArray(c[key])
  );
}
