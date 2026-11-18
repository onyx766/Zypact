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
  endedAfterReviewWords,
  engineNothingReadableWords,
  LABEL_WORDS,
  NO_READABLE_ANSWER_CELL,
  NO_READABLE_ANSWER_LINE,
  PILOT_REPORT_TITLE,
  PORTFOLIO_WEIGHTING_WORDS,
  PROVIDER_WORDS,
  RETIRED_ONE_OF_SEVERAL_WORDS,
  RETIRED_WORDS,
  retiredMeasurementWords,
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
import { NON_CAUSALITY_FOOTER } from "@/lib/reports/outcome-card-types";
import type {
  PilotAttemptCounts,
  PilotConditionValue,
  PilotEngineConditions,
  PilotEngineKey,
  PilotExecutionWindow,
  PilotOutcomeCard,
  PilotReportPayload,
  PilotReportRetest,
} from "@/lib/reports/pilot-report-types";
import {
  abandonedGroupWords,
  ACTION_TYPE_WORDS,
  approvedOnWords,
  cannotShowAnyChangeWords,
  changeWords,
  collectedAfterChangeWords,
  DIFFERENCE_HEADING,
  EVIDENCE_LINK_NOT_SHOWN_WORDS,
  evidenceWords,
  MEASURED_SAME_WAY_WORDS,
  measurementFieldWords,
  NO_CHANGE_SHOWABLE_REASONS,
  NO_CONTROLS_WORDS,
  NO_DEPARTURE_WORDS,
  NO_OTHER_CHANGES_WORDS,
  NOT_AS_REGISTERED_WORDS,
  NOT_FROM_SUGGESTED_ACTION_WORDS,
  NOTE_AFTER_FIRST_ANSWER_WORDS,
  notMeasuredSameWayWords,
  noteWords,
  OTHER_CHANGES_HEADING,
  outcomeCardHeading,
  outcomeReasonWords,
  outcomeRuleSentences,
  outcomeStatusWords,
  phaseWords,
  PILOT_RETEST_HEADING,
  PILOT_RETEST_LIMIT_SENTENCE,
  PILOT_RETEST_NOT_COMBINED,
  questionLineWords,
  reasonsWords,
  recordedLiveWords,
  registeredForWords,
  registeredOnWords,
  RETEST_FIELD_WORDS,
  RETEST_MEMBER_STATE_WORDS,
  shortRetestWords,
  SMALLEST_CHANGE_THAT_COUNTS,
  smallestDetectableWords,
  SOURCES_BEFORE_AFTER_HEADING,
  sourceActionWords,
  THRESHOLD_BELOW_LIMIT_WORDS,
  thresholdWords,
  waitingPeriodPlannedWords,
  waitingPeriodWords,
} from "@/lib/reports/pilot-retest-copy";
import { surfaceLimitation } from "@/lib/reports/surface-limitations";
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

/** D-062 — one Outcome Card: its blocks in §3.5's order, and the footer from the constant. */
export interface PilotPresentationCard {
  key: string;
  heading: string;
  blocks: { title: string | null; lines: string[] }[];
  /** Always NON_CAUSALITY_FOOTER, from the constant, never from the payload. */
  footer: string;
}

/** D-062 — one registered change that is not withdrawn: its registered text, its log, its members and cards. */
export interface PilotPresentationRetestGroup {
  key: string;
  heading: string;
  fields: { label: string; text: string }[];
  lines: string[];
  notesHeading: string;
  notes: string[];
  members: PilotPresentationTable;
  cards: PilotPresentationCard[];
}

export interface PilotPresentationRetests {
  heading: string;
  intro: string[];
  groups: PilotPresentationRetestGroup[];
  /** One line per withdrawn change (M6). */
  withdrawn: string[];
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
  /** D-062 — absent when the report shows no registered change (and on every revision built before D-062). */
  retests: PilotPresentationRetests | null;
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

/**
 * D-061 (review of phase B, engineer) — whether a stored payload was built
 * before D-061. Every revision built since carries `questionsNotMeasured` on
 * each engine (an empty list included); none built before does. The page
 * re-renders a stored payload with this code, while the stored Markdown
 * keeps the words it was saved with, so a revision built before D-061 keeps
 * the words of that time wherever D-061 changed them: "0 of 0 readable
 * answers" in a row and a question line, the hero's engines, the total line
 * and the empty other-brand and source notes. The page then still says what
 * its stored Markdown says (METHODOLOGY §16 gate 14).
 */
export function builtBeforeD061(payload: PilotReportPayload): boolean {
  return !payload.engines.some((e) => Array.isArray(e.questionsNotMeasured));
}

export function presentPilotReport(payload: PilotReportPayload): PilotPresentation {
  const { subject, window } = payload;
  const beforeD061 = builtBeforeD061(payload);
  const live = payload.questions.filter((q) => !q.retired);
  const retiredCount = payload.questions.length - live.length;
  const measured = payload.engines.filter((e) => e.measured);
  const notMeasured = payload.engines.filter((e) => !e.measured);
  // D-061 — the hero names only the engines that produced a readable answer
  // (a revision built before D-061 named every measured engine).
  const answered = beforeD061 ? measured : measured.filter((e) => e.questionsWithReadableAnswer > 0);
  const summaryOf = (engine: PilotEngineKey) => payload.engines.find((e) => e.engine === engine);
  // D-061 — an engine with no readable answer at all says why, in words:
  // still being measured on some live question, or nothing it returned was readable.
  const nothingReadable = (engine: PilotEngineKey): string | null => {
    if (beforeD061) return null;
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
    if (p && p.includedOrdinals.length === 0 && !beforeD061) {
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
                r.denominator === 0 && !beforeD061 ? NO_READABLE_ANSWER_CELL[r.state] : `${r.numerator} of ${r.denominator} readable answers`,
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
    // D-061 (review of phase B) — a question retired with more than one
    // measurement: retiring needed one of them to stop for good, and the
    // other may have finished, so each engine's line says how far it got.
    const severalRetired = q.retired && q.measurements.length > 1 && !beforeD061;
    for (const m of q.measurements) {
      const label = engineLabel(m.engine);
      if (q.retired) {
        lines.push(`${label} (${severalRetired ? retiredMeasurementWords(m.state) : "retired"}): ${attemptWords(m.counts)}.`);
        continue;
      }
      const o = m.report.observation;
      lines.push(
        o.denominator === 0 && !beforeD061
          ? // D-061 — no readable answer yet, or none at all: said in words, beside the counts below.
            `${label} (${STATE_WORDS[m.state]}): ${NO_READABLE_ANSWER_LINE[m.state]}`
          : `${label} (${STATE_WORDS[m.state]}): named in ${o.numerator} of ${o.denominator} readable answers; likely range ${rangeWords(o.interval?.low ?? null, o.interval?.high ?? null)}.`
      );
      // D-061 (review of phase B) — a review ended it: how many planned answers it completed, and that it is not in the total.
      if (m.state === "ended_after_review") lines.push(endedAfterReviewWords(m.counts.completed, m.counts.planned));
      lines.push(`Attempts: ${attemptWords(m.counts)}.`);
      if (m.report.competitorsObserved.length > 0) {
        lines.push(`Other brands named: ${m.report.competitorsObserved.map((c) => `${c.name} (${c.runsMentionedIn})`).join(", ")}.`);
      }
    }
    for (const e of payload.engines.filter((e) => !q.measurements.some((m) => m.engine === e.engine))) {
      lines.push(`${e.label}: not measured for this question.`);
    }
    // D-062 (M17) — answers collected after a registered change went live.
    for (const c of q.collectedAfterChange ?? []) lines.push(collectedAfterChangeWords(c.registeredOn, c.liveOn));
    return {
      key: q.pilotQuestionId,
      heading: `${q.ordinal}. ${q.text}`,
      meta: `${pilotProvenanceLabel(q.provenance)}. Approved by the customer on ${q.customerApprovedOn}.${
        q.retired ? ` ${severalRetired ? RETIRED_ONE_OF_SEVERAL_WORDS : RETIRED_WORDS}${q.retiredOn ? ` (${q.retiredOn})` : ""}` : ""
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

  const retests = presentRetests(payload);

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
    retests,
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
    ...(p.retests
      ? [
          p.retests.heading,
          ...p.retests.intro,
          ...p.retests.groups.flatMap((g) => [
            g.heading,
            ...g.fields.flatMap((f) => [f.label, f.text]),
            ...g.lines,
            g.notesHeading,
            ...g.notes,
            ...g.members.columns,
            ...g.members.rows.flat(),
            ...g.cards.flatMap(cardStrings),
          ]),
          ...p.retests.withdrawn,
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

/* ---------------------------------------------------------------- D-062: the retest section */

/** Every string one card shows, in order. */
export function cardStrings(c: PilotPresentationCard): string[] {
  return [c.heading, ...c.blocks.flatMap((b) => [...(b.title ? [b.title] : []), ...b.lines]), c.footer];
}

function datesWords(e: PilotExecutionWindow): string {
  if (!e.firstOn || !e.lastOn) return "No answer dates are recorded.";
  return e.firstOn === e.lastOn ? `Answers collected on ${e.firstOn}.` : `Answers collected from ${e.firstOn} to ${e.lastOn}.`;
}

function cardPresentation(
  card: PilotOutcomeCard,
  group: PilotReportRetest,
  company: string,
  dependenceNote: string
): PilotPresentationCard {
  const label = engineLabel(card.engine);
  const notesById = new Map(group.notes.map((n) => [n.id, n]));
  const after = new Set(card.noteIdsAfterFirstAnswer);
  const sc = card.sourceComparison;
  const c = card.comparison;
  const reasonWords = c.reasonCodes.map(outcomeReasonWords);
  const domains = sc ? [...sc.domains].sort((a, b) => b.baselineCitedInRuns + b.retestCitedInRuns - (a.baselineCitedInRuns + a.retestCitedInRuns) || a.domain.localeCompare(b.domain)) : [];
  const SHOWN = 10;
  return {
    key: card.memberId,
    heading: outcomeCardHeading(card.ordinal, label),
    blocks: [
      { title: null, lines: [outcomeStatusWords(card.status, company)] },
      { title: `What each result means (rule ${group.outcomeRule})`, lines: outcomeRuleSentences(card.status) },
      { title: "The question", lines: [questionLineWords(card.ordinal, card.question.versionNumber, card.question.hash)] },
      {
        title: "Before and after",
        lines: [
          phaseWords("Before", {
            numerator: card.baseline.numerator,
            denominator: card.baseline.denominator,
            rangeWords: rangeWords(card.baseline.interval?.low ?? null, card.baseline.interval?.high ?? null),
            attemptWords: attemptWords(card.baseline.counts),
            dates: datesWords(card.baseline.execution),
          }),
          phaseWords("After", {
            numerator: card.retest.numerator,
            denominator: card.retest.denominator,
            rangeWords: rangeWords(card.retest.interval?.low ?? null, card.retest.interval?.high ?? null),
            attemptWords: attemptWords(card.retest.counts),
            dates: datesWords(card.retest.execution),
          }),
        ],
      },
      { title: DIFFERENCE_HEADING, lines: [changeWords({ delta: c.delta, low: c.intervalLow, high: c.intervalHigh, reasons: reasonWords })] },
      {
        title: "The limits",
        lines: [
          SMALLEST_CHANGE_THAT_COUNTS,
          // (engineer, review C2 APP-1) A smallest change it could show only when the rule could give a status.
          c.smallestDetectableChange === null
            ? cannotShowAnyChangeWords(c.reasonCodes.filter((code) => NO_CHANGE_SHOWABLE_REASONS.includes(code)).map(outcomeReasonWords))
            : smallestDetectableWords(c.smallestDetectableChange),
          PILOT_RETEST_LIMIT_SENTENCE,
          ...(card.shortRetest ? [shortRetestWords(card.retest.denominator, card.retest.planned, c.smallestDetectableChange)] : []),
        ],
      },
      {
        title: "Your threshold",
        lines: [thresholdWords(group.text.decisionThreshold), ...(group.thresholdBelowLimit ? [THRESHOLD_BELOW_LIMIT_WORDS] : [])],
      },
      {
        title: "How it was measured",
        lines: [
          surfaceLimitation(card.engine),
          `Engine: ${PROVIDER_WORDS[card.conditions.provider] ?? UNKNOWN_PROVIDER_WORDS}. Answer format: ${SURFACE_WORDS[card.conditions.surface] ?? UNKNOWN_SURFACE_WORDS}. Model: ${card.conditions.model}.`,
          `Answers: ${card.conditions.answerModes.length > 0 ? card.conditions.answerModes.map((m) => ANSWER_MODE_WORDS[m] ?? UNKNOWN_ANSWER_MODE_WORDS).join("; ") : "not recorded"}. Methodology version ${card.conditions.methodologyVersion}; analysis version ${card.conditions.analyzerVersion ?? "not recorded"}.`,
          card.measurement.sameAsBaseline
            ? MEASURED_SAME_WAY_WORDS
            : notMeasuredSameWayWords([...new Set(card.measurement.differences.map(measurementFieldWords))]),
        ],
      },
      {
        title: SOURCES_BEFORE_AFTER_HEADING,
        lines: sc
          ? [
              `Answers with a usable source list: ${sc.baselineRunsWithSourceEvidence} before, ${sc.retestRunsWithSourceEvidence} after.`,
              `Answers citing your own website: ${sc.ownedCited.baseline} before, ${sc.ownedCited.retest} after.`,
              ...domains.slice(0, SHOWN).map((d) => `${d.domain} (${SOURCE_CATEGORY_LABEL[d.category]}): cited in ${d.baselineCitedInRuns} answers before, ${d.retestCitedInRuns} after.`),
              ...(domains.length > SHOWN ? [`${domains.length - SHOWN} further cited website(s) are not listed here.`] : []),
              ...sc.notes,
            ]
          : ["Cited sources are not compared here: one of the two measurements has no usable source list, or the two were read under different rules."],
      },
      {
        title: "Context",
        lines: [
          `${RETEST_FIELD_WORDS.confoundersToMonitor}: ${group.text.confoundersToMonitor}`,
          ...group.notes.map((n) => {
            const corrected = n.correctsNoteId ? notesById.get(n.correctsNoteId)?.notedOn ?? null : null;
            const line = noteWords({ kind: n.kind, notedOn: n.notedOn, writtenOn: n.writtenAt.slice(0, 10), text: n.text, correctsNotedOn: corrected });
            return after.has(n.id) ? `${line} (${NOTE_AFTER_FIRST_ANSWER_WORDS})` : line;
          }),
          NO_CONTROLS_WORDS,
          // (engineer, review C2 APP-4) Never "no departure" when the change was reported as not made as registered.
          group.implementation?.implementedAsRegistered === false ? NOT_AS_REGISTERED_WORDS : NO_DEPARTURE_WORDS,
        ],
      },
      { title: "The evidence", lines: [evidenceWords(card.baseline.answers, card.retest.answers)] },
      ...(reasonsWords(c.reasonCodes) ? [{ title: null, lines: [reasonsWords(c.reasonCodes)!] }] : []),
      { title: null, lines: [dependenceNote] },
    ],
    footer: NON_CAUSALITY_FOOTER,
  };
}

/**
 * D-062 — the retest section: each registered change in the customer's
 * words, its log of other changes, its members and its Outcome Cards. Each
 * card stands on its own; nothing is added up across cards (M11).
 */
/**
 * D-062 (engineer) — whether a stored payload was built before D-062: it has
 * no `retests` key (every revision built since carries one, an empty list
 * included). Such a revision renders exactly as it did: no retest section,
 * no M17 line (its questions carry no `collectedAfterChange`), and its
 * stored method notes, which never name the outcome rule.
 */
export function builtBeforeD062(payload: PilotReportPayload): boolean {
  return payload.retests === undefined;
}

export function presentRetests(payload: PilotReportPayload): PilotPresentationRetests | null {
  if (builtBeforeD062(payload)) return null;
  const groups = payload.retests ?? [];
  if (groups.length === 0) return null;
  const cards = payload.outcomeCards ?? [];
  const company = payload.subject.companyName;
  const live = groups.filter((g) => g.abandoned === null);
  const withdrawn = groups
    .filter((g) => g.abandoned !== null)
    .map((g) =>
      abandonedGroupWords({
        registeredOn: g.registeredOn,
        abandonedOn: g.abandoned!.abandonedOn,
        liveOn: g.abandoned!.wasLive && g.implementation ? g.implementation.recordedAt.slice(0, 10) : null,
      })
    );
  return {
    heading: PILOT_RETEST_HEADING,
    intro: [PILOT_RETEST_NOT_COMBINED],
    withdrawn,
    groups: live.map((g) => {
      const ordinals = [...new Set(g.members.map((m) => m.ordinal))].sort((a, b) => a - b);
      const lines = [
        registeredForWords(ordinals),
        approvedOnWords(g.customerApprovedOn),
        registeredOnWords(g.registeredOn, g.implementBy),
        ...(g.implementation
          ? [
              recordedLiveWords({
                recordedOn: g.implementation.recordedAt.slice(0, 10),
                wentLiveOn: g.implementation.wentLiveOn,
                // (engineer, review C2 APP-5) Left out when the build's lint found wording this report may not use.
                evidenceUrl: g.notShown?.evidenceUrl ? null : g.implementation.evidenceUrl,
                artifactSha256: g.implementation.artifactSha256,
              }),
              ...(g.notShown?.evidenceUrl && g.implementation.evidenceUrl ? [EVIDENCE_LINK_NOT_SHOWN_WORDS] : []),
            ]
          : []),
        g.windowOpensAt && g.windowClosesAt
          ? waitingPeriodWords(g.observationDays, g.windowOpensAt.slice(0, 10), g.windowClosesAt.slice(0, 10))
          : waitingPeriodPlannedWords(g.observationDays),
        ...(g.sourceActions.length > 0
          ? g.sourceActions.map((a) => sourceActionWords({ ...a, notShown: (g.notShown?.sourceActionVersionIds ?? []).includes(a.versionId) }))
          : [NOT_FROM_SUGGESTED_ACTION_WORDS]),
      ];
      const notesById = new Map(g.notes.map((n) => [n.id, n]));
      return {
        key: g.retestId,
        heading: `Change ${g.sequence}: ${g.text.changeTitle}`,
        fields: [
          { label: RETEST_FIELD_WORDS.changeDescription, text: g.text.changeDescription },
          { label: RETEST_FIELD_WORDS.changeTarget, text: g.text.changeTarget },
          { label: RETEST_FIELD_WORDS.changeOwner, text: g.text.changeOwner },
          { label: RETEST_FIELD_WORDS.actionType, text: ACTION_TYPE_WORDS[g.actionType] ?? ACTION_TYPE_WORDS.other },
          { label: RETEST_FIELD_WORDS.hypothesis, text: g.text.hypothesis },
          { label: RETEST_FIELD_WORDS.expectedMechanism, text: g.text.expectedMechanism },
          { label: RETEST_FIELD_WORDS.alternativeExplanations, text: g.text.alternativeExplanations },
          { label: RETEST_FIELD_WORDS.openQuestions, text: g.text.openQuestions },
          { label: RETEST_FIELD_WORDS.decisionThreshold, text: g.text.decisionThreshold },
          { label: RETEST_FIELD_WORDS.confoundersToMonitor, text: g.text.confoundersToMonitor },
        ],
        lines,
        notesHeading: OTHER_CHANGES_HEADING,
        notes:
          g.notes.length === 0
            ? [NO_OTHER_CHANGES_WORDS]
            : g.notes.map((n) =>
                noteWords({
                  kind: n.kind,
                  notedOn: n.notedOn,
                  writtenOn: n.writtenAt.slice(0, 10),
                  text: n.text,
                  correctsNotedOn: n.correctsNoteId ? notesById.get(n.correctsNoteId)?.notedOn ?? null : null,
                })
              ),
        members: {
          columns: ["Question", "Engine", "Where it stands", "Retest attempts"],
          rows: g.members.map((m) => [
            String(m.ordinal),
            engineLabel(m.engine),
            RETEST_MEMBER_STATE_WORDS[m.state] ?? "In a state this report does not recognise",
            m.counts ? attemptWords(m.counts) : "—",
          ]),
        },
        cards: cards
          .filter((c) => c.retestId === g.retestId)
          .sort((a, b) => a.ordinal - b.ordinal || (a.engine === b.engine ? 0 : a.engine === "perplexity_sonar" ? -1 : 1))
          .map((c) => cardPresentation(c, g, company, payload.dependenceNote)),
      };
    }),
  };
}
