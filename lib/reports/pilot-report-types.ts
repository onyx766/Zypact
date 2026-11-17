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

/** How far a question's measurement got, in the report's own words. */
export type PilotQuestionMeasurementState =
  | "measured"
  | "not_finished"
  | "not_started"
  | "stopped";

export interface PilotReportQuestionEngine {
  engine: PilotEngineKey;
  protocolId: string;
  state: PilotQuestionMeasurementState;
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
  measured: boolean;
  /** Present only for a measured engine. */
  questionsMeasured: number;
  note: string;
}

export interface PilotBrandRow {
  ordinal: number;
  pilotQuestionId: string;
  retired: boolean;
  state: PilotQuestionMeasurementState;
  numerator: number;
  denominator: number;
  planned: number;
  attempted: number;
  failed: number;
  excluded: number;
  intervalLow: number | null;
  intervalHigh: number | null;
  label: PilotQuestionLabel;
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

export interface PilotReportPayload {
  reportVersion: typeof PILOT_REPORT_VERSION;
  generatedAt: string;
  pilotId: string;
  projectId: string;
  subject: PilotReportSubject;
  window: { startsOn: string; endsOn: string; status: "active" | "closed" };
  engines: PilotReportEngineSummary[];
  questions: PilotReportQuestion[];
  brand: PilotEngineBrandSection[];
  competitors: PilotEngineCompetitorSection[];
  sources: PilotEngineSourceSection[];
  evidenceIndex: PilotEvidenceEntry[];
  limitations: string[];
  methodNotes: string[];
}

/** What the database checks the payload against before saving it. */
export interface PilotReportManifest {
  protocols: string[];
  attempts: { id: string; protocolId: string; rawResponseSha256: string | null }[];
}

export function isPilotReportPayload(value: unknown): value is PilotReportPayload {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  if (c.reportVersion !== PILOT_REPORT_VERSION) return false;
  if (typeof c.pilotId !== "string" || typeof c.generatedAt !== "string") return false;
  for (const key of ["subject", "window"]) {
    if (typeof c[key] !== "object" || c[key] === null) return false;
  }
  return ["engines", "questions", "brand", "competitors", "sources", "evidenceIndex", "limitations", "methodNotes"].every(
    (key) => Array.isArray(c[key])
  );
}
