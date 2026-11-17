/**
 * D-055 — builds the combined pilot report from stored evidence only.
 *
 * Pure: no database, no network, no model. Each question's result is the
 * payload `buildProtocolReport` produces for that question's protocol, and
 * every cross-question table is read from those payloads, so the question
 * sections and the tables cannot disagree. Rates stay per question
 * (METHODOLOGY §10, §11); the one portfolio line is a count beside them,
 * never a score, and nothing is combined across engines (D-053 item 3).
 */
import { buildProtocolReport } from "@/lib/reports/build-protocol-report";
import type { BuildProtocolReportInput, ProtocolReportPayload } from "@/lib/reports/protocol-report-types";
import {
  PILOT_COMPETITOR_RULE,
  PILOT_LABEL_RULE,
  PILOT_REPORT_VERSION,
  type PilotBrandRow,
  type PilotCompetitorRow,
  type PilotEngineBrandSection,
  type PilotEngineCompetitorSection,
  type PilotEngineKey,
  type PilotEngineSourceSection,
  type PilotEvidenceEntry,
  type PilotPortfolioLine,
  type PilotQuestionLabel,
  type PilotQuestionMeasurementState,
  type PilotReportEngineSummary,
  type PilotReportManifest,
  type PilotReportPayload,
  type PilotReportQuestion,
  type PilotSourceRow,
} from "@/lib/reports/pilot-report-types";
import { categorizeDomain, SOURCE_CATEGORY_LABEL, SOURCE_TYPE_LIST_VERSION, type SourceCategory } from "@/lib/source-insights/source-types";

export const PILOT_ENGINE_ORDER: readonly { key: PilotEngineKey; label: string }[] = [
  { key: "perplexity_sonar", label: "Perplexity" },
  { key: "openai_chatgpt", label: "ChatGPT" },
];

/** The words for an engine with no measurement in this pilot. Never a zero. */
export const ENGINE_NOT_MEASURED_NOTE = "Not measured in this pilot yet.";

export const MAX_COMPETITOR_ROWS = 30;

/** A label needs at least this many readable answers; fewer is insufficient evidence (pilot-question-labels/1). */
export const MIN_READABLE_FOR_LABEL = 3;

export const PILOT_LIMITATIONS: readonly string[] = [
  "Results show what these engines answered during the pilot. They don't represent every AI tool or every buyer.",
  "Each engine is a separate, directional measurement. Results from different engines are never added together.",
  "Each question is a different question. A result for one question says nothing about another.",
  "Answers vary from one request to the next, so a small number of answers per question gives a wide range of likely values.",
  "Zypact has not opened the cited pages. What they say has not been checked.",
];

export interface PilotReportSlotInput {
  engine: PilotEngineKey;
  protocolId: string;
  /** The protocol job's status, or null when no job exists. */
  jobStatus: string | null;
  evidence: BuildProtocolReportInput;
}

export interface PilotReportQuestionInput {
  pilotQuestionId: string;
  ordinal: number;
  provenance: string;
  customerApprovedOn: string;
  retiredAt: string | null;
  slots: PilotReportSlotInput[];
}

export interface PilotReportInput {
  pilot: {
    id: string;
    projectId: string;
    companyName: string;
    websiteUrl: string;
    normalizedDomain: string;
    startsOn: string;
    endsOn: string;
    status: "active" | "closed";
  };
  questions: PilotReportQuestionInput[];
  now?: Date;
}

export type PilotStructuralStatus = "needs_review" | "blocked";

export interface PilotStructuralReason {
  status: PilotStructuralStatus;
  reason: string;
}

export interface BuiltPilotReport {
  payload: PilotReportPayload;
  manifest: PilotReportManifest;
  /** Reasons found in the shape of the evidence itself; per-question integrity signals are added by the caller. */
  structural: PilotStructuralReason[];
}

function measurementState(jobStatus: string | null, attempted: number): PilotQuestionMeasurementState {
  switch (jobStatus) {
    case "succeeded":
      return "measured";
    case "claimed":
    case "running":
      return "not_finished";
    case "queued":
    case null:
      return attempted > 0 ? "not_finished" : "not_started";
    default:
      // failed, needs_review, abandoned_exhausted, or a state this code does not know.
      return "stopped";
  }
}

export function questionLabel(numerator: number, denominator: number): PilotQuestionLabel {
  if (denominator < MIN_READABLE_FOR_LABEL) return "insufficient_evidence";
  if (numerator === denominator) return "observed_consistently_in_sample";
  if (numerator === 0) return "not_observed_consistently_in_sample";
  return "mixed_in_sample";
}

const CATEGORIES = Object.keys(SOURCE_CATEGORY_LABEL) as SourceCategory[];

/** Readable runs: the runs a question's own rate counts (build-protocol-report.ts). */
function readableRuns(report: ProtocolReportPayload) {
  return report.runs.filter((run) => run.status === "completed" && run.brandPresent !== null);
}

const competitorKey = (name: string) => name.trim().toLowerCase();

function buildCompetitors(
  engine: PilotEngineKey,
  measured: { ordinal: number; report: ProtocolReportPayload }[]
): PilotEngineCompetitorSection {
  const byKey = new Map<string, { name: string; appearances: Map<number, number>; readable: Map<number, number> }>();
  for (const { ordinal, report } of measured) {
    const runs = readableRuns(report);
    for (const run of runs) {
      const seen = new Set<string>();
      for (const raw of run.competitors) {
        const key = competitorKey(raw);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        let e = byKey.get(key);
        if (!e) {
          e = { name: raw.trim(), appearances: new Map(), readable: new Map() };
          byKey.set(key, e);
        }
        e.appearances.set(ordinal, (e.appearances.get(ordinal) ?? 0) + 1);
        e.readable.set(ordinal, runs.length);
      }
    }
  }
  const rows: PilotCompetitorRow[] = [...byKey.values()]
    .map((e) => ({
      name: e.name,
      appearances: [...e.appearances.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([ordinal, runs]) => ({ ordinal, runs, readableRuns: e.readable.get(ordinal) ?? 0 })),
    }))
    .sort((a, b) => {
      const total = (r: PilotCompetitorRow) => r.appearances.reduce((s, x) => s + x.runs, 0);
      return b.appearances.length - a.appearances.length || total(b) - total(a) || a.name.localeCompare(b.name);
    });
  return {
    engine,
    rule: PILOT_COMPETITOR_RULE,
    rows: rows.slice(0, MAX_COMPETITOR_ROWS),
    rowsNotShown: Math.max(0, rows.length - MAX_COMPETITOR_ROWS),
  };
}

function buildSources(
  engine: PilotEngineKey,
  measured: { ordinal: number; report: ProtocolReportPayload }[],
  subjectDomain: string
): PilotEngineSourceSection {
  const counts = new Map<SourceCategory, Map<number, { cited: number; retrieved: number }>>();
  const coverage: PilotEngineSourceSection["coverage"] = [];
  for (const { ordinal, report } of measured) {
    const insights = report.sourceInsights;
    coverage.push({
      ordinal,
      readableRuns: insights ? insights.readableRuns : readableRuns(report).length,
      runsWithSourceEvidence: insights ? insights.runsWithSourceEvidence : 0,
    });
    if (!insights) continue;
    for (const run of insights.runs) {
      if (run.status !== "ok") continue;
      const citedDomains = new Set(run.cited.map((s) => s.domain));
      const cited = new Set(run.cited.map((s) => categorizeDomain(s.domain, subjectDomain)));
      const retrieved = new Set(
        run.retrievedOnly
          .filter((s) => !citedDomains.has(s.domain))
          .map((s) => categorizeDomain(s.domain, subjectDomain))
          .filter((c) => !cited.has(c))
      );
      for (const category of CATEGORIES) {
        if (!cited.has(category) && !retrieved.has(category)) continue;
        let perQuestion = counts.get(category);
        if (!perQuestion) {
          perQuestion = new Map();
          counts.set(category, perQuestion);
        }
        const cell = perQuestion.get(ordinal) ?? { cited: 0, retrieved: 0 };
        if (cited.has(category)) cell.cited += 1;
        else cell.retrieved += 1;
        perQuestion.set(ordinal, cell);
      }
    }
  }
  const rows: PilotSourceRow[] = CATEGORIES.filter((c) => counts.has(c)).map((category) => ({
    category,
    cells: [...counts.get(category)!.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ordinal, cell]) => ({ ordinal, citedInRuns: cell.cited, retrievedOnlyInRuns: cell.retrieved })),
  }));
  return { engine, rows, coverage };
}

function portfolioLine(rows: PilotBrandRow[]): PilotPortfolioLine | null {
  const live = rows.filter((r) => !r.retired);
  if (live.length === 0) return null;
  const included = live.filter((r) => r.state === "measured" && r.denominator > 0);
  const leftOut = rows.filter((r) => !included.includes(r)).map((r) => r.ordinal);
  const rates = included.map((r) => r.numerator / r.denominator);
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const heterogeneity =
    included.length === 0
      ? "No question has finished with a readable answer, so there is no total."
      : included.length === 1
        ? "Only one question is included, so the total is that question's own result."
        : `Per question, the brand was named in between ${pct(Math.min(...rates))} and ${pct(Math.max(...rates))} of readable answers. The questions are different questions, so this total is a count of answers, not a rate for the company, and no range of likely values is given for it.`;
  return {
    includedOrdinals: included.map((r) => r.ordinal),
    leftOutOrdinals: leftOut,
    numerator: included.reduce((s, r) => s + r.numerator, 0),
    denominator: included.reduce((s, r) => s + r.denominator, 0),
    weighting: "equal_per_readable_run",
    heterogeneity,
  };
}

export function buildPilotReport(input: PilotReportInput): BuiltPilotReport {
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const { pilot } = input;
  const structural: PilotStructuralReason[] = [];
  const subject = {
    companyName: pilot.companyName,
    websiteUrl: pilot.websiteUrl,
    normalizedDomain: pilot.normalizedDomain,
  };

  const ordered = [...input.questions].sort((a, b) => a.ordinal - b.ordinal);
  const questions: PilotReportQuestion[] = [];
  const evidenceIndex: PilotEvidenceEntry[] = [];
  const manifest: PilotReportManifest = { protocols: [], attempts: [] };
  const brandRows = new Map<PilotEngineKey, PilotBrandRow[]>();
  const measuredByEngine = new Map<PilotEngineKey, { ordinal: number; report: ProtocolReportPayload }[]>();

  if (ordered.length === 0) {
    structural.push({ status: "needs_review", reason: "The pilot has no questions, so there is nothing to report." });
  }

  for (const q of ordered) {
    const retired = q.retiredAt !== null;
    let text = "";
    const measurements: PilotReportQuestion["measurements"] = [];

    if (q.slots.length === 0) {
      structural.push({ status: "needs_review", reason: `Question ${q.ordinal} has no measurement on any engine.` });
    }

    for (const slot of q.slots) {
      const ev = slot.evidence;
      // Evidence outside the pilot: another project, or a protocol other than the slot's.
      if (ev.projectId !== pilot.projectId || ev.protocol.id !== slot.protocolId) {
        structural.push({
          status: "blocked",
          reason: `Question ${q.ordinal}: its evidence does not belong to this pilot's project and protocol.`,
        });
      }
      if (ev.subject.companyName.trim() !== pilot.companyName.trim()) {
        structural.push({
          status: "needs_review",
          reason: `Question ${q.ordinal}: the brand looked for in the answers differs from the pilot's company name.`,
        });
      }
      const report = buildProtocolReport({
        ...ev,
        subject: { ...ev.subject, websiteUrl: pilot.websiteUrl, normalizedDomain: pilot.normalizedDomain },
        now,
      });
      text = text || report.question.text;
      const state = measurementState(slot.jobStatus, report.reconciliation.attempted);
      measurements.push({ engine: slot.engine, protocolId: slot.protocolId, state, report });

      if (!retired && state !== "measured") {
        structural.push({
          status: "needs_review",
          reason:
            state === "stopped"
              ? `Question ${q.ordinal}: the ${engineLabel(slot.engine)} measurement stopped before it finished.`
              : `Question ${q.ordinal}: the ${engineLabel(slot.engine)} measurement has not finished.`,
        });
      }
      if (!report.reconciliation.accountedFor) {
        structural.push({
          status: "needs_review",
          reason: `Question ${q.ordinal}: its ${engineLabel(slot.engine)} attempt counts do not reconcile.`,
        });
      }

      const { observation: o, reconciliation: r } = report;
      const rows = brandRows.get(slot.engine) ?? [];
      rows.push({
        ordinal: q.ordinal,
        pilotQuestionId: q.pilotQuestionId,
        retired,
        state,
        numerator: o.numerator,
        denominator: o.denominator,
        planned: r.planned,
        attempted: r.attempted,
        failed: r.failed,
        excluded: r.excludedByReview + r.excludedNoResult,
        intervalLow: o.interval?.low ?? null,
        intervalHigh: o.interval?.high ?? null,
        label: questionLabel(o.numerator, o.denominator),
      });
      brandRows.set(slot.engine, rows);

      if (!retired && o.denominator > 0) {
        const list = measuredByEngine.get(slot.engine) ?? [];
        list.push({ ordinal: q.ordinal, report });
        measuredByEngine.set(slot.engine, list);
      }

      manifest.protocols.push(slot.protocolId);
      const resultByProbeRun = new Map(ev.results.map((res) => [res.probeRunId, res]));
      for (const attempt of ev.attempts) {
        const sha = attempt.probeRunId ? resultByProbeRun.get(attempt.probeRunId)?.rawResponseSha256 ?? null : null;
        manifest.attempts.push({ id: attempt.id, protocolId: slot.protocolId, rawResponseSha256: sha });
        evidenceIndex.push({
          attemptId: attempt.id,
          pilotQuestionId: q.pilotQuestionId,
          ordinal: q.ordinal,
          engine: slot.engine,
          protocolId: slot.protocolId,
          status: attempt.status,
          rawResponseSha256: sha,
        });
      }
    }

    questions.push({
      pilotQuestionId: q.pilotQuestionId,
      ordinal: q.ordinal,
      text,
      provenance: q.provenance,
      customerApprovedOn: q.customerApprovedOn,
      retired,
      retiredOn: q.retiredAt ? q.retiredAt.slice(0, 10) : null,
      measurements,
    });
  }

  const engines: PilotReportEngineSummary[] = PILOT_ENGINE_ORDER.map(({ key, label }) => {
    const measuredQuestions = questions.filter((q) => !q.retired && q.measurements.some((m) => m.engine === key)).length;
    return {
      engine: key,
      label,
      measured: measuredQuestions > 0,
      questionsMeasured: measuredQuestions,
      note: measuredQuestions > 0 ? `${measuredQuestions} question${measuredQuestions === 1 ? "" : "s"} measured.` : ENGINE_NOT_MEASURED_NOTE,
    };
  });

  const measuredEngines = engines.filter((e) => e.measured).map((e) => e.engine);
  const brand: PilotEngineBrandSection[] = measuredEngines.map((engine) => {
    const rows = brandRows.get(engine) ?? [];
    return { engine, rows, portfolio: portfolioLine(rows) };
  });
  const competitors = measuredEngines.map((engine) => buildCompetitors(engine, measuredByEngine.get(engine) ?? []));
  const sources = measuredEngines.map((engine) =>
    buildSources(engine, measuredByEngine.get(engine) ?? [], pilot.normalizedDomain)
  );

  const methodNotes = [
    `Each question's figures come from its own approved protocol and its own answers. The table rows are the question sections' figures, repeated.`,
    `Labels follow rule ${PILOT_LABEL_RULE}: with at least ${MIN_READABLE_FOR_LABEL} readable answers, "named in every answer", "named in no answer" or "named in some answers"; with fewer, "not enough answers". The counts are always shown beside the label.`,
    "The total line adds up readable answers over the questions that finished, each answer counting once. Questions that are retired or not finished are left out of it and named. It is not a score.",
    `Competitor names are grouped across questions by rule ${PILOT_COMPETITOR_RULE}: the same name apart from spacing and capital letters. Names were read from each answer by an analysis model, so different spellings of one company can appear separately. These are totals across questions, not results for any one question.`,
    `Source types come from the fixed list ${SOURCE_TYPE_LIST_VERSION}. A run counts once per type, whatever the number of pages of that type it cited.`,
    "Failed and excluded answers stay in each question's own count of attempts. They are never counted as an answer that did not name the brand.",
  ];

  const payload: PilotReportPayload = {
    reportVersion: PILOT_REPORT_VERSION,
    generatedAt,
    pilotId: pilot.id,
    projectId: pilot.projectId,
    subject,
    window: { startsOn: pilot.startsOn, endsOn: pilot.endsOn, status: pilot.status },
    engines,
    questions,
    brand,
    competitors,
    sources,
    evidenceIndex,
    limitations: [...PILOT_LIMITATIONS],
    methodNotes,
  };

  return { payload, manifest, structural: dedupe(structural) };
}

function dedupe(reasons: PilotStructuralReason[]): PilotStructuralReason[] {
  const seen = new Set<string>();
  return reasons.filter((r) => {
    const key = `${r.status}|${r.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function engineLabel(engine: PilotEngineKey): string {
  return PILOT_ENGINE_ORDER.find((e) => e.key === engine)?.label ?? "Unknown engine";
}
