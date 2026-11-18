/**
 * D-055 — the one presentation of a stored pilot report payload.
 *
 * The client page (components/report/pilot-report-view.tsx) and the Markdown
 * (render-pilot-report-markdown.ts) both render this model and add no words
 * of their own beyond the page frame in pilot-report-copy.ts, so the two
 * cannot drift (METHODOLOGY §16 gate 14), and the integrity text scan reads
 * every string the page shows (`presentationStrings`).
 *
 * Pure: no database, network, provider or model.
 */
import { pilotProvenanceLabel } from "@/lib/pilots/copy";
import { engineLabel, questionOrdinalsWords } from "@/lib/reports/build-pilot-report";
import {
  ACTION_FIELD_WORDS,
  ACTIONS_HEADING,
  ACTIONS_NOT_REGISTERED_NOTE,
  ACTIONS_NOTE,
  actionEvidenceWords,
  actionReviewedWords,
  ANSWER_MODE_WORDS,
  engineNothingReadableWords,
  LABEL_WORDS,
  NO_READABLE_ANSWER_CELL,
  NO_READABLE_ANSWER_LINE,
  PILOT_REPORT_TITLE,
  PORTFOLIO_WEIGHTING_WORDS,
  PROVIDER_WORDS,
  RETIRED_WORDS,
  settingSearchWords,
  settingTierWords,
  sourceRuleWords,
  STATE_WORDS,
  SURFACE_WORDS,
  UNKNOWN_ANSWER_MODE_WORDS,
  UNKNOWN_PROVIDER_WORDS,
  UNKNOWN_SURFACE_WORDS,
  rangeWords,
} from "@/lib/reports/pilot-report-copy";
import type {
  PilotAttemptCounts,
  PilotConditionValue,
  PilotEngineConditions,
  PilotEngineKey,
  PilotReportPayload,
} from "@/lib/reports/pilot-report-types";
import { SOURCE_CATEGORY_LABEL } from "@/lib/source-insights/source-types";

export interface PilotPresentationTable {
  columns: string[];
  rows: string[][];
}

export interface PilotPresentationSection {
  key: string;
  heading: string;
  /** Before the table. */
  paragraphs: string[];
  table: PilotPresentationTable | null;
  /** After the table. */
  notes: string[];
}

export interface PilotPresentationQuestion {
  key: string;
  heading: string;
  meta: string;
  lines: string[];
}

/** D-057 — one suggested action: its fields in words and the answers it rests on. */
export interface PilotPresentationAction {
  key: string;
  heading: string;
  fields: { label: string; text: string }[];
  reviewed: string;
  basedOnHeading: string;
  basedOn: string[];
}

export interface PilotPresentationActions {
  heading: string;
  intro: string[];
  actions: PilotPresentationAction[];
  notes: string[];
}

export interface PilotPresentation {
  eyebrow: string;
  title: string;
  websiteUrl: string;
  heroCopy: string[];
  chips: string[];
  enginesHeading: string;
  engines: string[];
  conditions: PilotPresentationSection[];
  sections: PilotPresentationSection[];
  questionsHeading: string;
  questionsIntro: string[];
  questions: PilotPresentationQuestion[];
  /** D-057 — absent when no reviewed action exists: no section at all. */
  actions: PilotPresentationActions | null;
  limitsHeading: string;
  limitations: string[];
  methodHeading: string;
  methodNotes: string[];
  evidenceLine: string;
  causalLimit: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function attemptWords(c: PilotAttemptCounts): string {
  const parts = [
    `${c.completed} completed`,
    `${c.failed} failed`,
    `${c.excludedByReview} excluded after review`,
    `${c.noReadableResult} without a readable result`,
  ];
  if (c.inProgress > 0) parts.push(`${c.inProgress} still being collected`);
  if (c.unrecognised > 0) parts.push(`${c.unrecognised} in a state this report does not recognise`);
  return `${c.attempted} attempted of ${c.planned} planned: ${parts.join(", ")}`;
}

function valueWords(values: PilotConditionValue[], words: (v: string) => string): string {
  if (values.length === 0) return "not recorded";
  if (values.length === 1) return words(values[0].value);
  return values
    .map((v) => `${words(v.value)} (question${v.ordinals.length === 1 ? "" : "s"} ${v.ordinals.join(", ")})`)
    .join("; ");
}

function conditionsSection(c: PilotEngineConditions): PilotPresentationSection {
  const label = engineLabel(c.engine);
  const dates =
    c.executedFrom && c.executedTo
      ? c.executedFrom === c.executedTo
        ? `Answers collected on ${c.executedFrom}.`
        : `Answers collected from ${c.executedFrom} to ${c.executedTo}.`
      : "No answer has been collected yet.";
  // D-061 — present only on revisions built since D-061, and the setting
  // only for an engine whose protocols record one (ChatGPT).
  const settings = c.settingVersion ?? [];
  const rules = c.sourceRule ?? [];
  return {
    key: `conditions-${c.engine}`,
    heading: `${label}: how it was measured`,
    paragraphs: [c.surfaceLimitation],
    table: null,
    notes: [
      `Engine: ${valueWords(c.provider, (v) => PROVIDER_WORDS[v] ?? UNKNOWN_PROVIDER_WORDS)}.`,
      `Answer format: ${valueWords(c.surface, (v) => SURFACE_WORDS[v] ?? UNKNOWN_SURFACE_WORDS)}.`,
      `Model: ${valueWords(c.model, (v) => v)}.`,
      ...(settings.length > 0
        ? [
            `Setting version: ${valueWords(settings, (v) => (v === "" ? "not recorded" : v))}.`,
            `Service tier: ${valueWords(settings, settingTierWords)}.`,
            `Web search: ${valueWords(settings, settingSearchWords)}.`,
          ]
        : []),
      `Answers: ${valueWords(c.answerMode, (v) => ANSWER_MODE_WORDS[v] ?? UNKNOWN_ANSWER_MODE_WORDS)}.`,
      dates,
      `Methodology version ${valueWords(c.methodologyVersion, (v) => v)}; analysis version ${valueWords(c.analyzerVersion, (v) => (v === "" ? "not recorded" : v))}.`,
      ...(rules.length > 0 ? [`Sources: ${valueWords(rules, sourceRuleWords)}.`] : []),
    ],
  };
}

export function presentPilotReport(payload: PilotReportPayload): PilotPresentation {
  const { subject, window } = payload;
  const live = payload.questions.filter((q) => !q.retired);
  const retiredCount = payload.questions.length - live.length;
  const measured = payload.engines.filter((e) => e.measured);
  const notMeasured = payload.engines.filter((e) => !e.measured);
  // D-061 — the hero names only the engines that produced a readable answer.
  const answered = measured.filter((e) => e.questionsWithReadableAnswer > 0);
  const summaryOf = (engine: PilotEngineKey) => payload.engines.find((e) => e.engine === engine);
  // D-061 — an engine with no readable answer at all says why, in words:
  // still being measured on some live question, or nothing it returned was readable.
  const nothingReadable = (engine: PilotEngineKey): string | null => {
    if ((summaryOf(engine)?.questionsWithReadableAnswer ?? 0) > 0) return null;
    const stillMeasuring = live.some((q) =>
      q.measurements.some((m) => m.engine === engine && (m.state === "not_started" || m.state === "not_finished"))
    );
    return engineNothingReadableWords(engineLabel(engine), stillMeasuring);
  };

  const heroCopy = [
    ...measured.map((e) => `${e.label}: ${e.note}`),
    ...notMeasured.map((e) => `${e.label} has not been measured in this pilot yet.`),
    `Every figure belongs to one question on one engine. Results show what ${
      answered.length > 0 ? answered.map((e) => e.label).join(" and ") : "the engines"
    } answered during the pilot; they don't represent every AI tool or every buyer.`,
  ];

  const sections: PilotPresentationSection[] = [];

  for (const section of payload.brand) {
    const label = engineLabel(section.engine);
    const p = section.portfolio;
    const notes: string[] = [];
    if (p && p.includedOrdinals.length === 0) {
      // D-061 — no question has finished with a readable answer: no total,
      // and never "named in 0 of 0".
      notes.push(p.heterogeneity);
    } else if (p) {
      notes.push(
        `Total across ${plural(p.includedOrdinals.length, "finished question")}: named in ${p.numerator} of ${p.denominator} readable answers. ${PORTFOLIO_WEIGHTING_WORDS} ${p.heterogeneity}`
      );
      if (p.leftOutOrdinals.length > 0) {
        notes.push(`Left out of the total: question${p.leftOutOrdinals.length === 1 ? "" : "s"} ${p.leftOutOrdinals.join(", ")}.`);
      }
    }
    // D-061 — live questions with no measurement on this engine are named, never counted.
    const unmeasured = summaryOf(section.engine)?.questionsNotMeasured ?? [];
    if (unmeasured.length > 0) {
      notes.push(`Not measured on ${label}, so not in this table or its total: ${questionOrdinalsWords(unmeasured)}.`);
    }
    notes.push(payload.dependenceNote);
    sections.push({
      key: `brand-${section.engine}`,
      heading: `${label}: was ${subject.companyName} named?`,
      paragraphs: [],
      table: {
        columns: ["#", "Status", "Named in", "Likely range", "Attempts", "Reading"],
        rows: section.rows.map((r) =>
          r.retired || r.numerator === null || r.denominator === null || r.label === null
            ? [String(r.ordinal), "Retired", "Not reported (retired)", "—", attemptWords(r.counts), "—"]
            : [
                String(r.ordinal),
                STATE_WORDS[r.state],
                r.denominator === 0 ? NO_READABLE_ANSWER_CELL[r.state] : `${r.numerator} of ${r.denominator} readable answers`,
                rangeWords(r.intervalLow, r.intervalHigh),
                attemptWords(r.counts),
                LABEL_WORDS[r.label],
              ]
        ),
      },
      notes,
    });
  }

  for (const section of payload.competitors) {
    const empty = nothingReadable(section.engine);
    sections.push({
      key: `competitors-${section.engine}`,
      heading: `${engineLabel(section.engine)}: other brands named, across questions`,
      paragraphs: ["These are totals across different questions, not a result for any one question."],
      table:
        section.rows.length === 0
          ? null
          : {
              columns: ["Brand", "Questions", "Where (answers naming it, of readable answers)"],
              rows: section.rows.map((r) => [
                r.name,
                String(r.appearances.length),
                r.appearances.map((a) => `Q${a.ordinal}: ${a.runs} of ${a.readableRuns}`).join("; "),
              ]),
            },
      notes: [
        ...(section.rows.length === 0 ? [empty ?? "No other brand was named in a readable answer."] : []),
        ...(section.rowsNotShown > 0 ? [`${section.rowsNotShown} further name(s) are in the question sections below.`] : []),
      ],
    });
  }

  for (const section of payload.sources) {
    const empty = nothingReadable(section.engine);
    const withList = new Map(section.coverage.map((c) => [c.ordinal, c.runsWithSourceEvidence]));
    const cellWords = (ordinal: number, k: number) => `Q${ordinal}: ${k} of ${withList.get(ordinal) ?? 0}`;
    const thin = section.coverage.filter((c) => c.runsWithSourceEvidence < c.readableRuns);
    sections.push({
      key: `sources-${section.engine}`,
      heading: `${engineLabel(section.engine)}: types of source cited, by question`,
      paragraphs: [
        "Each figure is answers citing that type of source, of the question's answers with a usable source list. An answer counts once per type.",
      ],
      table:
        section.rows.length === 0
          ? null
          : {
              columns: ["Source type", "Cited in", "Returned but not cited"],
              rows: section.rows.map((r) => [
                SOURCE_CATEGORY_LABEL[r.category],
                r.cells.filter((c) => c.citedInRuns > 0).map((c) => cellWords(c.ordinal, c.citedInRuns)).join("; ") || "none",
                r.cells.filter((c) => c.retrievedOnlyInRuns > 0).map((c) => cellWords(c.ordinal, c.retrievedOnlyInRuns)).join("; ") || "none",
              ]),
            },
      notes: [
        ...(section.rows.length === 0 ? [empty ?? "No readable answer had a usable source list."] : []),
        ...(thin.length > 0
          ? [
              `Some readable answers had no usable source list and are not counted here: ${thin
                .map((c) => `Q${c.ordinal} (${c.readableRuns - c.runsWithSourceEvidence} of ${c.readableRuns})`)
                .join(", ")}.`,
            ]
          : []),
      ],
    });
  }

  const questions: PilotPresentationQuestion[] = payload.questions.map((q) => {
    const lines: string[] = [];
    for (const m of q.measurements) {
      const label = engineLabel(m.engine);
      if (q.retired) {
        lines.push(`${label} (retired): ${attemptWords(m.counts)}.`);
        continue;
      }
      const o = m.report.observation;
      lines.push(
        o.denominator === 0
          ? // D-061 — no readable answer yet, or none at all: said in words, beside the counts below.
            `${label} (${STATE_WORDS[m.state]}): ${NO_READABLE_ANSWER_LINE[m.state]}`
          : `${label} (${STATE_WORDS[m.state]}): named in ${o.numerator} of ${o.denominator} readable answers; likely range ${rangeWords(o.interval?.low ?? null, o.interval?.high ?? null)}.`
      );
      lines.push(`Attempts: ${attemptWords(m.counts)}.`);
      if (m.report.competitorsObserved.length > 0) {
        lines.push(`Other brands named: ${m.report.competitorsObserved.map((c) => `${c.name} (${c.runsMentionedIn})`).join(", ")}.`);
      }
    }
    for (const e of payload.engines.filter((e) => !q.measurements.some((m) => m.engine === e.engine))) {
      lines.push(`${e.label}: not measured for this question.`);
    }
    return {
      key: q.pilotQuestionId,
      heading: `${q.ordinal}. ${q.text}`,
      meta: `${pilotProvenanceLabel(q.provenance)}. Approved by the customer on ${q.customerApprovedOn}.${
        q.retired ? ` ${RETIRED_WORDS}${q.retiredOn ? ` (${q.retiredOn})` : ""}` : ""
      }`,
      lines,
    };
  });

  const reportActions = payload.actions ?? [];
  const actions: PilotPresentationActions | null =
    reportActions.length === 0
      ? null
      : {
          heading: ACTIONS_HEADING,
          intro: [ACTIONS_NOTE],
          actions: reportActions.map((a, i) => ({
            key: a.versionId,
            heading: `${i + 1}. ${a.title}`,
            fields: [
              { label: ACTION_FIELD_WORDS.observation, text: a.observation },
              { label: ACTION_FIELD_WORDS.suggestedAction, text: a.suggestedAction },
              { label: ACTION_FIELD_WORDS.whyItMightMatter, text: a.whyItMightMatter },
              { label: ACTION_FIELD_WORDS.alternativeExplanations, text: a.alternativeExplanations },
              { label: ACTION_FIELD_WORDS.openQuestions, text: a.openQuestions },
            ],
            reviewed: actionReviewedWords(a.reviewedOn),
            basedOnHeading: "Based on",
            basedOn: a.evidence.map((e) =>
              actionEvidenceWords({
                ordinal: e.ordinal,
                engineLabel: engineLabel(e.engine),
                answerNumber: e.answerNumber,
                rawResponseSha256: e.rawResponseSha256,
                sourceUrl: e.sourceUrl,
                sourceCited: e.sourceCited,
              })
            ),
          })),
          notes: [ACTIONS_NOT_REGISTERED_NOTE],
        };

  return {
    eyebrow: PILOT_REPORT_TITLE,
    title: `${subject.companyName}: ${plural(live.length, "buyer question")}`,
    websiteUrl: subject.websiteUrl,
    heroCopy,
    chips: [
      `Pilot ${window.startsOn} to ${window.endsOn}`,
      `${plural(live.length, "question")}${retiredCount > 0 ? ` (and ${retiredCount} retired)` : ""}`,
    ],
    enginesHeading: "Engines",
    engines: payload.engines.map((e) => `${e.label}: ${e.note}`),
    conditions: payload.conditions.map(conditionsSection),
    sections,
    questionsHeading: "The questions",
    questionsIntro: [payload.dependenceNote],
    questions,
    actions,
    limitsHeading: "Limits of this report",
    limitations: [...payload.limitations, payload.dependenceNote],
    methodHeading: "How the figures were produced",
    methodNotes: payload.methodNotes,
    evidenceLine: `Evidence: ${plural(payload.evidenceIndex.length, "recorded attempt")}, each linked to the SHA-256 of its stored provider response where one exists.`,
    causalLimit: payload.causalLimit,
  };
}

/** Every string the page and the Markdown show, for the integrity text scan and the wording tests. */
export function presentationStrings(p: PilotPresentation): string[] {
  const section = (s: PilotPresentationSection) => [
    s.heading,
    ...s.paragraphs,
    ...(s.table ? [...s.table.columns, ...s.table.rows.flat()] : []),
    ...s.notes,
  ];
  return [
    p.eyebrow,
    p.title,
    p.websiteUrl,
    ...p.heroCopy,
    ...p.chips,
    p.enginesHeading,
    ...p.engines,
    ...p.conditions.flatMap(section),
    ...p.sections.flatMap(section),
    p.questionsHeading,
    ...p.questionsIntro,
    ...p.questions.flatMap((q) => [q.heading, q.meta, ...q.lines]),
    ...(p.actions
      ? [
          p.actions.heading,
          ...p.actions.intro,
          ...p.actions.actions.flatMap((a) => [
            a.heading,
            ...a.fields.flatMap((f) => [f.label, f.text]),
            a.reviewed,
            a.basedOnHeading,
            ...a.basedOn,
          ]),
          ...p.actions.notes,
        ]
      : []),
    p.limitsHeading,
    ...p.limitations,
    p.methodHeading,
    ...p.methodNotes,
    p.evidenceLine,
    p.causalLimit,
  ];
}
