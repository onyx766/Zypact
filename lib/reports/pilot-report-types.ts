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
import type { OutcomeStatus } from "@/lib/reports/compare-protocols";
import { NON_CAUSALITY_FOOTER } from "@/lib/reports/outcome-card-types";
import type { ProtocolReportPayload } from "@/lib/reports/protocol-report-types";
import type { OutcomeCardSourceComparison } from "@/lib/source-insights/build-source-insights";
import type { SourceCategory } from "@/lib/source-insights/source-types";

export const PILOT_REPORT_VERSION = 1 as const;

/**
 * The rule that groups competitor names across questions (§11).
 * pilot-competitor-names/1: trim and case only. pilot-competitor-names/2: the
 * same, plus spellings listed as one company in the reviewed alias list
 * (lib/reports/competitor-aliases.ts), and a name joining several brands
 * counted as each brand only when every part is known.
 */
export const PILOT_COMPETITOR_RULE = "pilot-competitor-names/2" as const;

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
  /**
   * D-062 (M17) — the registered changes that went live before some of this
   * question's baseline answers were collected: those answers describe the
   * engines after the change. Absent on revisions built before D-062.
   */
  collectedAfterChange?: { registeredOn: string; liveOn: string }[];
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
  /**
   * pilot-competitor-names/2 — every other original spelling grouped into this
   * row, exactly as the analysis read it. Absent on revisions built under /1.
   */
  alsoWrittenAs?: string[];
  /**
   * pilot-competitor-names/2 — original names that joined this brand with
   * others ("A and B"), each counted here as this brand. Absent on revisions
   * built under /1.
   */
  namedWithOthersAs?: string[];
}

export interface PilotEngineCompetitorSection {
  engine: PilotEngineKey;
  /** The rule the rows were grouped under (a revision keeps the one it was built with). */
  rule: string;
  /** pilot-competitor-names/2 — the alias list version. Absent on revisions built under /1. */
  aliasListVersion?: string;
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

/**
 * One website cited or returned in a question's answers on one engine. The
 * category comes only from the fixed list (source-types.ts); a domain not on
 * it is "unclassified", never guessed.
 */
export interface PilotDomainRow {
  domain: string;
  category: SourceCategory;
  /** Per question: answers citing a page of this domain, and answers that only returned one. */
  cells: { ordinal: number; citedInRuns: number; retrievedOnlyInRuns: number }[];
  /** Up to MAX_EXAMPLE_URLS of its pages, cited ones first. */
  exampleUrls: string[];
  /** Further distinct pages of it, not listed. */
  urlsNotShown: number;
}

export interface PilotEngineDomainSection {
  engine: PilotEngineKey;
  rows: PilotDomainRow[];
  rowsNotShown: number;
  /** Per question: readable answers, and those with a usable source list (the denominator). */
  coverage: { ordinal: number; readableRuns: number; runsWithSourceEvidence: number }[];
}

export const PILOT_SUMMARY_RULE = "pilot-summary/1" as const;

/** At most this many competitors and websites per engine in the summary. */
export const SUMMARY_TOP = 5;

/**
 * The summary at the top of a report: read from the sections below it, never
 * a figure of its own. Every item is one question on one engine, or a count
 * across one engine's questions; nothing combines engines.
 */
export interface PilotReportSummary {
  rule: typeof PILOT_SUMMARY_RULE;
  engines: PilotSummaryEngine[];
  /** Items for a closer look, each from one fixed rule (PilotSummaryFlag). */
  flags: PilotSummaryFlag[];
}

export interface PilotSummaryEngine {
  engine: PilotEngineKey;
  /** First and last day an answer on this engine was collected, across its questions; null before any. */
  collectedFrom: string | null;
  collectedTo: string | null;
  /** The competitor table's first rows (its own order), with their answer totals across questions. */
  topCompetitors: { name: string; questions: number; answers: number }[];
  /** The websites cited in the most answers, summed over questions (a count, not a rate). */
  topDomains: { domain: string; category: SourceCategory; questions: number; answers: number }[];
}

/**
 * pilot-summary/1's rules, each for one live question on one engine:
 *  - `brand_absent_competitors_named`: named in none of at least one readable
 *    answer, while some of those answers named another brand;
 *  - `own_site_not_cited`: answers with a usable source list, none citing a
 *    page on the company's own domain;
 *  - `not_finished`: the measurement is not finished (any state but finished);
 *  - `few_readable_answers`: finished with fewer readable answers than the
 *    label needs.
 */
export type PilotSummaryFlag =
  | { kind: "brand_absent_competitors_named"; engine: PilotEngineKey; ordinal: number; readable: number; answersNamingOthers: number }
  | { kind: "own_site_not_cited"; engine: PilotEngineKey; ordinal: number; withSourceList: number }
  | { kind: "not_finished"; engine: PilotEngineKey; ordinal: number; state: PilotQuestionMeasurementState }
  | { kind: "few_readable_answers"; engine: PilotEngineKey; ordinal: number; readable: number; floor: number };

/** Who a pilot is for (pilots.purpose, 20261109200000). */
export type PilotPurpose = "customer" | "internal_practice";

export interface PilotEvidenceEntry {
  attemptId: string;
  pilotQuestionId: string;
  ordinal: number;
  engine: PilotEngineKey;
  protocolId: string;
  status: string;
  rawResponseSha256: string | null;
  /** D-062 — "retest" for an attempt of a retest slot; absent for a baseline attempt. */
  phase?: "baseline" | "retest";
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
  /**
   * Who the pilot is for (20261109200000): an internal practice run says so at
   * the top of its report. Null when it could not be read (the report then
   * needs review). Absent on revisions built before it.
   */
  purpose?: PilotPurpose | null;
  /** pilot-summary/1 — the summary at the top. Absent on revisions built before it, which keep their layout. */
  summary?: PilotReportSummary;
  /** The websites behind the source types, per engine. Absent on revisions built before it. */
  domains?: PilotEngineDomainSection[];
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
  /**
   * D-062 — every registered change of the pilot (abandoned ones included),
   * as stored. Absent on revisions built before D-062.
   */
  retests?: PilotReportRetest[];
  /**
   * D-062 — one Outcome Card per member whose retest is final with at least
   * one answer (M1). Absent on revisions built before D-062.
   */
  outcomeCards?: PilotOutcomeCard[];
}

/* ---------------------------------------------------------------- D-062: the retest */

/** A member's state (lib/pilots/retest-rules.ts RETEST_MEMBER_STATES). */
export type PilotRetestMemberState =
  | "retest_awaiting_change"
  | "retest_window_open"
  | "retest_awaiting_preparation"
  | "retest_not_run"
  | "retest_collecting"
  | "retest_held_for_review"
  | "retest_stopped_retryable"
  | "retest_could_not_run"
  | "retest_measured"
  | "retest_withdrawn";

export type PilotRetestText = Record<
  | "changeTitle"
  | "changeDescription"
  | "changeTarget"
  | "changeOwner"
  | "hypothesis"
  | "expectedMechanism"
  | "alternativeExplanations"
  | "openQuestions"
  | "decisionThreshold"
  | "confoundersToMonitor",
  string
>;

export interface PilotReportRetestMember {
  memberId: string;
  interventionId: string;
  pilotQuestionId: string;
  ordinal: number;
  engine: PilotEngineKey;
  baselineProtocolId: string;
  retestProtocolId: string | null;
  state: PilotRetestMemberState;
  counts: PilotAttemptCounts | null;
  execution: PilotExecutionWindow | null;
}

export interface PilotReportRetestNote {
  id: string;
  notedOn: string;
  kind: string;
  /** The stored text, or PILOT_RETEST_WITHHELD_TEXT when `withheld`. */
  text: string;
  withheld: boolean;
  correctsNoteId: string | null;
  writtenAt: string;
}

/**
 * One registered change (a pilot_retests row), exactly as stored: the save
 * compares every field below with the stored group (20261109190000, check 6).
 * The customer's approval reference is never here (M10).
 */
export interface PilotReportRetest {
  retestId: string;
  sequence: number;
  state: "registered" | "implemented" | "prepared" | "abandoned";
  registeredOn: string;
  customerApprovedOn: string;
  /** Each value as stored, or PILOT_RETEST_WITHHELD_TEXT for a field in `withheldFields` (M4). */
  text: PilotRetestText;
  withheldFields: string[];
  actionType: string;
  thresholdBelowLimit: boolean;
  outcomeRule: string;
  observationDays: number;
  implementBy: string;
  sourceActions: { versionId: string; title: string | null; withdrawn: boolean }[];
  /**
   * D-062 (engineer) — values above kept exactly as stored, because the save
   * compares them, but left out of the page and the Markdown: the build's
   * lint found wording this report may not use in the evidence link or in a
   * source action's title (each also a needs-review reason). The save does
   * not read this key. Absent means nothing is left out.
   */
  notShown?: { evidenceUrl: boolean; sourceActionVersionIds: string[] };
  implementation: {
    recordedAt: string;
    wentLiveOn: string;
    evidenceUrl: string | null;
    artifactSha256: string | null;
    implementedAsRegistered: boolean;
  } | null;
  windowOpensAt: string | null;
  windowClosesAt: string | null;
  prepared: boolean;
  abandoned: { abandonedOn: string; wasLive: boolean } | null;
  notes: PilotReportRetestNote[];
  members: PilotReportRetestMember[];
}

/** One phase of a pilot Outcome Card. */
export interface PilotOutcomeCardPhase {
  protocolId: string;
  numerator: number;
  denominator: number;
  planned: number;
  interval: { low: number; high: number } | null;
  counts: PilotAttemptCounts;
  execution: PilotExecutionWindow;
  /** Each completed answer with a stored response: its run number and the first 12 of its SHA-256. */
  answers: { number: number; sha12: string }[];
}

/**
 * D-062 — one question on one engine, before and after one registered
 * change. Built only from a final retest with at least one answer (M1). It
 * carries no free text from the comparison, only reason codes (M15), and
 * nothing in it is ever added to another card (METHODOLOGY §10).
 */
export interface PilotOutcomeCard {
  memberId: string;
  interventionId: string;
  retestId: string;
  pilotQuestionId: string;
  ordinal: number;
  engine: PilotEngineKey;
  baselineProtocolId: string;
  retestProtocolId: string;
  status: OutcomeStatus;
  footer: typeof NON_CAUSALITY_FOOTER;
  question: { versionNumber: number; hash: string };
  baseline: PilotOutcomeCardPhase;
  retest: PilotOutcomeCardPhase;
  comparison: {
    delta: number | null;
    intervalLow: number | null;
    intervalHigh: number | null;
    minimumUsefulChange: number;
    /**
     * From the two phases' actual readable answers (M5). Null when the rule
     * can give this card no status from them (engineer): a phase below the
     * readable-answer floor, or a comparison that stopped early (another
     * question or setup, not measured the same way). The card then says it
     * cannot show any change.
     */
    smallestDetectableChange: number | null;
    /** Each reason's prefix before ": ", never the text after it (M15). */
    reasonCodes: string[];
  };
  detectableChangeAtPlan: number | null;
  /** Fewer readable retest answers than planned (M3). */
  shortRetest: boolean;
  measurement: {
    verdict: "compatible" | "incompatible" | "unverifiable";
    sameAsBaseline: boolean;
    /** A closed set of fingerprint field names (measurement-fingerprint.ts), put into words on the page. */
    differences: string[];
  };
  conditions: {
    provider: string;
    surface: string;
    model: string;
    answerModes: string[];
    methodologyVersion: string;
    analyzerVersion: string | null;
  };
  sourceComparison: OutcomeCardSourceComparison | null;
  /** Notes of the group written at or after this retest's first answer (M14). */
  noteIdsAfterFirstAnswer: string[];
}

/** What the database checks the payload against before saving it. */
export interface PilotReportManifest {
  protocols: string[];
  attempts: { id: string; protocolId: string; rawResponseSha256: string | null }[];
  /** D-057 — the action versions the payload shows; the database checks each is its action's latest reviewed one. */
  actionVersions: string[];
  /** D-062 — every group of the pilot, with its state and members (20261109190000). Absent before D-062. */
  retests?: { id: string; state: "registered" | "implemented" | "prepared" | "abandoned"; memberIds: string[] }[];
  /** D-062 — every note id of the pilot's groups. */
  retestNotes?: string[];
  /** D-062 — the job of every retest slot, as read. */
  retestJobs?: { jobId: string; protocolId: string; status: string; reviewResolution: string | null }[];
  /** D-062 — the cards the payload shows, with every attempt of each retest. */
  retestCards?: { memberId: string; status: OutcomeStatus; retestAttemptIds: string[] }[];
}

const OUTCOME_STATUSES: readonly string[] = ["increase_observed", "decrease_observed", "no_clear_change", "inconclusive"];

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
  // Absent on revisions built before the summary; when present, well formed.
  if (c.domains !== undefined && !Array.isArray(c.domains)) return false;
  if (c.summary !== undefined) {
    const s = c.summary as Record<string, unknown> | null;
    if (typeof s !== "object" || s === null || !Array.isArray(s.engines) || !Array.isArray(s.flags)) return false;
  }
  if (c.purpose !== undefined && c.purpose !== null && c.purpose !== "customer" && c.purpose !== "internal_practice") return false;
  // D-062 — absent on revisions built before it; when present, lists, and
  // every card carries the footer constant and one of the four statuses (M15).
  if (c.retests !== undefined && !Array.isArray(c.retests)) return false;
  if (c.outcomeCards !== undefined) {
    if (!Array.isArray(c.outcomeCards)) return false;
    for (const card of c.outcomeCards as unknown[]) {
      if (typeof card !== "object" || card === null) return false;
      const k = card as Record<string, unknown>;
      if (k.footer !== NON_CAUSALITY_FOOTER || typeof k.status !== "string" || !OUTCOME_STATUSES.includes(k.status)) return false;
    }
  }
  return ["engines", "conditions", "questions", "brand", "competitors", "sources", "evidenceIndex", "limitations", "methodNotes"].every(
    (key) => Array.isArray(c[key])
  );
}
