/**
 * D-062 — the customer's words for the pilot retest and its Outcome Cards.
 *
 * The constants below are fixed sentences. PILOT_RETEST_WITHHELD_TEXT is
 * also written into 20261109190000's report save, which accepts it in place
 * of a registered text only for a field the build withheld (M4);
 * scripts/test-pilot-retest-schema.ts pins the two equal.
 *
 * Pure: no database, network, provider or model.
 */
import type { OutcomeStatus } from "@/lib/reports/compare-protocols";

/** The 60-point limit, shown at registration and on every card (M2, M5). */
export const PILOT_RETEST_LIMIT_SENTENCE =
  "With 5 answers on each engine before and after the change, a retest can show only a change of 60 points or more.";

/** What a registered text field or note shows when the build withheld it for its wording (M4). */
export const PILOT_RETEST_WITHHELD_TEXT =
  "This text is not shown because it uses wording this report may not use.";

/** The retest section's opening sentence (M11). */
export const PILOT_RETEST_NOT_COMBINED =
  "Each question and engine is compared on its own. Results are never added up or counted across questions or engines.";

/*
 * The rest of the customer's words (§3.5). Every stored code reaches a
 * reader only through one of these maps (M12): an outcome status, a
 * member's state, a group's state, a note's kind, a change's kind and a
 * comparison's reason. Keyed by literal, with type-only imports, so this
 * module has no runtime dependency.
 */

export const PILOT_RETEST_HEADING = "Retest: one change, measured again";

/** The four statuses, in the order the rule lists them. */
export const OUTCOME_STATUS_ORDER: readonly OutcomeStatus[] = [
  "increase_observed",
  "decrease_observed",
  "no_clear_change",
  "inconclusive",
];

/** The status names, as they open each status sentence. */
export const OUTCOME_STATUS_NAME: Record<OutcomeStatus, string> = {
  increase_observed: "Increase observed",
  decrease_observed: "Decrease observed",
  no_clear_change: "No clear change",
  inconclusive: "Inconclusive",
};

/** A card's own status, first on the card (§3.5 item 1). */
export function outcomeStatusWords(status: OutcomeStatus, company: string): string {
  switch (status) {
    case "increase_observed":
      return `Increase observed in how often ${company} was named.`;
    case "decrease_observed":
      return `Decrease observed in how often ${company} was named.`;
    case "no_clear_change":
      return `No clear change in how often ${company} was named.`;
    default:
      return `Inconclusive: this retest cannot say whether how often ${company} was named changed.`;
  }
}

/**
 * What each status means under rule pilot-outcome-card/1 (M2, M5). Fixed
 * sentences. (engineer, review C2 APP-2) The measured quantity is called the
 * "difference" (after minus before), never "the change", so no sentence reads
 * as if the customer's change produced it.
 */
export const OUTCOME_RULE_SENTENCES: Record<OutcomeStatus, string> = {
  increase_observed:
    "Increase observed: the 95% range for the difference is entirely above zero, and the difference is at least 60 points.",
  decrease_observed:
    "Decrease observed: the 95% range for the difference is entirely below zero, and the difference is at least 60 points.",
  no_clear_change:
    "No clear change: the 95% range stays within 60 points either way. A difference of 60 points or more is ruled out; a smaller difference may still exist and would not be visible here.",
  inconclusive:
    "Inconclusive: any other result, for example a range that still includes a difference of 60 points, or too few readable answers. This is a limit of the number of answers, not evidence that nothing changed.",
};

/** The card's rule sentences, its own status first (§3.5 item 2). */
export function outcomeRuleSentences(own: OutcomeStatus): string[] {
  return [own, ...OUTCOME_STATUS_ORDER.filter((s) => s !== own)].map((s) => OUTCOME_RULE_SENTENCES[s]);
}

/** The labels of the registered text, as the customer reads them (M18). */
export const RETEST_FIELD_WORDS = {
  changeTitle: "What the change is",
  changeDescription: "What the change is",
  changeTarget: "Where it is made",
  changeOwner: "Who makes it",
  actionType: "Kind of change",
  hypothesis: "Why we expect it might matter (a hypothesis)",
  expectedMechanism: "Expected mechanism (a hypothesis)",
  alternativeExplanations: "What else could explain a change",
  openQuestions: "What we don't know yet",
  decisionThreshold: "What would change your next decision (your words)",
  confoundersToMonitor: "What we are watching for",
} as const;

/** 0071's action types (lib/interventions/types.ts ACTION_TYPES), in words. */
export const ACTION_TYPE_WORDS: Record<string, string> = {
  content_published: "New content published",
  content_updated: "Existing content updated",
  page_created: "A new page",
  structured_data_added: "Structured data added to a page",
  third_party_listing: "A listing on another website",
  documentation_updated: "Documentation updated",
  other: "Another kind of change",
};

/** pilot_retest_notes.kind, in words (METHODOLOGY §14, M12, M14). */
export const RETEST_NOTE_KIND_WORDS: Record<string, string> = {
  engine_change: "A change in an AI engine",
  measurement_change: "A change in how Zypact measures",
  competitor_activity: "Something a competitor did",
  customer_change: "Another change on your side",
  source_change: "A change in a source the engines cite",
  news_or_market_event: "News or a market event",
  implementation_issue: "A difference in how the change was made",
  other_change: "Another change",
};

/** A member's state (lib/pilots/retest-rules.ts RETEST_MEMBER_STATES), in words. */
export const RETEST_MEMBER_STATE_WORDS: Record<string, string> = {
  retest_awaiting_change: "Waiting for the change to go live",
  retest_window_open: "Waiting period running",
  retest_awaiting_preparation: "Waiting period over; not yet measured again",
  retest_not_run: "Not yet measured again",
  retest_collecting: "Being measured again",
  retest_held_for_review: "Measured again, but held for review",
  retest_stopped_retryable: "Stopped before finishing; it may still continue",
  retest_could_not_run: "Could not be measured again",
  retest_measured: "Measured again: see its Outcome Card",
  retest_withdrawn: "Withdrawn",
};

/** A group's state (RETEST_GROUP_STATES), in words. */
export const RETEST_GROUP_STATE_WORDS: Record<string, string> = {
  registered: "Registered; not yet live",
  implemented: "Live; waiting period",
  prepared: "Being measured again",
  abandoned: "Withdrawn",
};

/**
 * A comparison's reason codes (lib/reports/compare-protocols.ts), by the
 * prefix before ": " (M15). The free text after a prefix is never stored.
 * A prefix this map does not know reads "another recorded reason".
 */
export const OUTCOME_REASON_WORDS: Record<string, string> = {
  BUYER_QUESTION_MISMATCH: "the two measurements were not of the same approved question",
  PROTOCOL_IDENTITY_MISMATCH_UNDISCLOSED: "the two measurements were not set up the same way",
  CONFIGURATION_DEVIATION_DISCLOSED: "a recorded difference in how the two measurements were set up",
  MEASUREMENT_CAVEAT: "a limit of what the stored evidence can confirm about how both measurements were made",
  MEASUREMENT_INCOMPATIBLE: "the two measurements were not made the same way",
  MEASUREMENT_UNVERIFIABLE: "it could not be confirmed that the two measurements were made the same way",
  BASELINE_BELOW_READABLE_RUN_FLOOR: "too few readable answers before the change",
  RETEST_BELOW_READABLE_RUN_FLOOR: "too few readable answers after the change",
  INTERVAL_COULD_NOT_BE_COMPUTED: "the range could not be computed",
  PLAN_UNDERPOWERED_FOR_MINIMUM_USEFUL_CHANGE: "with this many answers, a change of 60 points could not be told apart from no change",
  INTERVAL_INCLUDES_MINIMUM_USEFUL_CHANGE: "the range still includes a change of 60 points",
};
export const UNKNOWN_OUTCOME_REASON_WORDS = "another recorded reason";

/**
 * (engineer, review C2 APP-1) The reason prefixes with which the rule gives a
 * card no status from its readable answers: the comparison stopped before
 * any range was computed. A card with one of them shows no smallest change it
 * could show, only cannotShowAnyChangeWords.
 */
export const NO_CHANGE_SHOWABLE_REASONS: readonly string[] = [
  "BUYER_QUESTION_MISMATCH",
  "PROTOCOL_IDENTITY_MISMATCH_UNDISCLOSED",
  "MEASUREMENT_INCOMPATIBLE",
  "MEASUREMENT_UNVERIFIABLE",
  "BASELINE_BELOW_READABLE_RUN_FLOOR",
  "RETEST_BELOW_READABLE_RUN_FLOOR",
  "INTERVAL_COULD_NOT_BE_COMPUTED",
];

/** A reason prefix, in words; an unknown one never shows its code. */
export function outcomeReasonWords(code: string): string {
  return Object.hasOwn(OUTCOME_REASON_WORDS, code) ? OUTCOME_REASON_WORDS[code] : UNKNOWN_OUTCOME_REASON_WORDS;
}

/** The fields a measurement fingerprint (mf-1) compares, in words. */
export const MEASUREMENT_FIELD_WORDS: Record<string, string> = {
  version: "the fingerprint version",
  probeRequest: "the request sent to the engine",
  probeServed: "the model the engine reported serving",
  analysisRequest: "the request sent to the analysis model",
  analysisServed: "the analysis model served",
  endpoint: "the engine's address",
  "protocol.provider": "the engine",
  "protocol.surface": "the answer format",
  "protocol.analyzerVersion": "the analysis version",
  "protocol.entityResolutionVersion": "the name-matching version",
  "protocol.methodologyVersion": "the method version",
};
export const UNKNOWN_MEASUREMENT_FIELD_WORDS = "another recorded setting";

export function measurementFieldWords(field: string): string {
  return Object.hasOwn(MEASUREMENT_FIELD_WORDS, field) ? MEASUREMENT_FIELD_WORDS[field] : UNKNOWN_MEASUREMENT_FIELD_WORDS;
}

/** Signed whole points from a share difference: +60, -20, 0. */
export function pointsWords(value: number): string {
  const p = Math.round(value * 100);
  return p > 0 ? `+${p}` : `${p}`;
}

export const SMALLEST_CHANGE_THAT_COUNTS = "The smallest change that counts, set before the retest: 60 points.";

export function smallestDetectableWords(points: number): string {
  return `The smallest change this retest could show: ${Math.round(points * 100)} points.`;
}

/**
 * (engineer, review C2 APP-1) In place of the smallest change a retest could
 * show, when the rule can give it no status from its readable answers.
 * `reasons` are the stopping reasons already in words.
 */
export function cannotShowAnyChangeWords(reasons: string[]): string {
  return `This retest cannot show any change: ${reasons.length > 0 ? [...new Set(reasons)].join("; ") : UNKNOWN_OUTCOME_REASON_WORDS}.`;
}

export function shortRetestWords(readable: number, planned: number, sdc: number | null): string {
  return sdc === null
    ? `The retest has fewer than ${planned} readable answers (${readable} of ${planned}).`
    : `The retest has fewer than ${planned} readable answers (${readable} of ${planned}): the smallest change it could show is ${Math.round(sdc * 100)} points, and 'no clear change' cannot be shown.`;
}

export function thresholdWords(text: string): string {
  return `${RETEST_FIELD_WORDS.decisionThreshold}: ${text}`;
}
export const THRESHOLD_BELOW_LIMIT_WORDS =
  "The change you said would matter is smaller than 60 points, so this retest cannot settle it.";

export const MEASURED_SAME_WAY_WORDS = "Measured the same way as before.";
export function notMeasuredSameWayWords(differences: string[]): string {
  return `Not measured the same way as before: ${differences.length > 0 ? differences.join(", ") : "it could not be confirmed"}. The result is therefore inconclusive.`;
}

export const NO_CONTROLS_WORDS =
  "No control questions were measured, so wider changes in the engines cannot be told apart from this change.";
export const NO_DEPARTURE_WORDS = "No departure from the registered retest was recorded.";
/**
 * (engineer, review C2 APP-4) In place of NO_DEPARTURE_WORDS when the change
 * was recorded as not made exactly as registered (its departure is an
 * implementation_issue note in the log).
 */
export const NOT_AS_REGISTERED_WORDS =
  "You reported that the change was not made exactly as registered; see the log of other changes.";
export const NOTE_AFTER_FIRST_ANSWER_WORDS = "recorded after this retest's first answer";
export const NO_OTHER_CHANGES_WORDS = "No other change was recorded.";
export const OTHER_CHANGES_HEADING = "Other changes we recorded";

export function noteWords(n: { kind: string; notedOn: string; writtenOn: string; text: string; correctsNotedOn: string | null }): string {
  const kind = Object.hasOwn(RETEST_NOTE_KIND_WORDS, n.kind) ? RETEST_NOTE_KIND_WORDS[n.kind] : "Another change";
  const body = n.correctsNotedOn ? `Correction to the note of ${n.correctsNotedOn}: ${n.text}` : n.text;
  return `${kind} (on ${n.notedOn}, recorded ${n.writtenOn}): ${body}`;
}

export function registeredForWords(ordinals: number[]): string {
  return `Registered once for question${ordinals.length === 1 ? "" : "s"} ${ordinals.join(", ")}, each on both engines.`;
}
export function approvedOnWords(day: string): string {
  return `You approved this change on ${day}.`;
}
export function registeredOnWords(registeredOn: string, implementBy: string): string {
  return `Registered on ${registeredOn}. To go live by ${implementBy}.`;
}
/** `evidenceUrl` is null when there is none or when it is not shown (EVIDENCE_LINK_NOT_SHOWN_WORDS follows then). */
export function recordedLiveWords(i: { recordedOn: string; wentLiveOn: string; evidenceUrl: string | null; artifactSha256: string | null }): string {
  const evidence = [i.evidenceUrl, i.artifactSha256 ? `fingerprint ${i.artifactSha256.slice(0, 12)}` : null].filter(Boolean).join("; ");
  return `Recorded as live by the Zypact team on ${i.recordedOn}. You reported that the change went live on ${i.wentLiveOn}.${evidence ? ` Evidence: ${evidence}.` : ""}`;
}
/** (engineer, review C2 APP-5) The evidence link left out after the build's lint. */
export const EVIDENCE_LINK_NOT_SHOWN_WORDS =
  "The link to the live change is not shown because it uses wording this report may not use.";
export function waitingPeriodWords(days: number, from: string, to: string): string {
  return `Waiting period: ${days} days, from ${from} to ${to}.`;
}
export function waitingPeriodPlannedWords(days: number): string {
  return `Waiting period: ${days} days, from the day the change is recorded as live.`;
}
/** `notShown` (engineer, review C2 APP-5): the title was left out after the build's lint. */
export function sourceActionWords(s: { title: string | null; withdrawn: boolean; notShown?: boolean }): string {
  if (s.withdrawn || s.title === null) return "From a suggested action since withdrawn.";
  if (s.notShown) return "From a suggested action whose title is not shown because it uses wording this report may not use.";
  return `From the suggested action "${s.title}".`;
}
export const NOT_FROM_SUGGESTED_ACTION_WORDS = "Not from a suggested action in this report.";

/** An abandoned group, in one line (M6). (engineer) The reason is not shown. */
export function abandonedGroupWords(a: { registeredOn: string; abandonedOn: string; liveOn: string | null }): string {
  return a.liveOn
    ? `A change registered on ${a.registeredOn} and recorded as live on ${a.liveOn} was withdrawn on ${a.abandonedOn}, before it was measured again.`
    : `A change registered on ${a.registeredOn} was withdrawn on ${a.abandonedOn}, before it was measured again.`;
}

/**
 * A question whose baseline answers may have been collected after a change
 * went live (M17). (engineer, review C2 APP-7) "May": the go-live instant is
 * the earlier of the recorded moment and the reported day at 00:00 UTC, so an
 * answer later than it is not shown to be later than the change itself.
 */
export function collectedAfterChangeWords(registeredOn: string, liveOn: string): string {
  return `Some of these answers may have been collected after the change registered on ${registeredOn} went live (${liveOn}); those would describe the engines after that change.`;
}

export function outcomeCardHeading(ordinal: number, engineLabel: string): string {
  return `Outcome Card: Question ${ordinal}, ${engineLabel}`;
}

export function questionLineWords(ordinal: number, versionNumber: number, hash: string): string {
  return `Question ${ordinal}, version ${versionNumber} (fingerprint ${hash.slice(0, 12)}), the same on both measurements.`;
}

export function phaseWords(phase: "Before" | "After", p: {
  numerator: number;
  denominator: number;
  rangeWords: string;
  attemptWords: string;
  dates: string;
}): string {
  return `${phase} the change: named in ${p.numerator} of ${p.denominator} readable answers; likely range ${p.rangeWords}. Attempts: ${p.attemptWords}. ${p.dates}`;
}

/** (engineer, review C2 APP-2) The card's block title for the measured difference. */
export const DIFFERENCE_HEADING = "The difference";

export function changeWords(c: { delta: number | null; low: number | null; high: number | null; reasons: string[] }): string {
  if (c.delta === null || c.low === null || c.high === null) {
    return `No difference could be computed: ${c.reasons.length > 0 ? c.reasons.join("; ") : UNKNOWN_OUTCOME_REASON_WORDS}.`;
  }
  return `Difference (after minus before): ${pointsWords(c.delta)} points (95% range ${pointsWords(c.low)} to ${pointsWords(c.high)} points).`;
}

export function evidenceWords(before: { number: number; sha12: string }[], after: { number: number; sha12: string }[]): string {
  const list = (xs: { number: number; sha12: string }[]) => (xs.length === 0 ? "none" : xs.map((a) => `${a.number} (${a.sha12})`).join(", "));
  return `Answers before: ${list(before)}; after: ${list(after)}.`;
}

export function reasonsWords(codes: string[]): string | null {
  if (codes.length === 0) return null;
  return `Recorded reasons: ${[...new Set(codes.map(outcomeReasonWords))].join("; ")}.`;
}

export const SOURCES_BEFORE_AFTER_HEADING = "Sources cited before and after";

/**
 * The method note for rule pilot-outcome-card/1 (M16). (engineer) The spec's
 * "hybrid score interval" is written "hybrid interval (his method 10)": no
 * customer-visible text says "score" (common rules, W2). (engineer, review C2)
 * No decision number appears in customer text (APP-3), and the measured
 * quantity is "the difference" (APP-2).
 */
export function pilotOutcomeRuleNote(company: string): string {
  return `Outcome Cards follow rule pilot-outcome-card/1. Each compares one question on one engine, before and after the change, using readable answers only. The difference is the share of readable answers naming ${company} after the change minus the share before; its 95% range is Newcombe's hybrid interval (his method 10) built from each phase's Wilson range. The smallest change that counts is 60 points, set before the retest, and 'no clear change' needs the whole range within 60 points. A phase needs at least 3 readable answers and at least 60% of its planned answers. Both phases must be measured the same way (measurement fingerprint mf-1). Sources are read by rule provider-sources/1 for Perplexity and openai-responses-sources/1 for ChatGPT and are compared without any status.`;
}
