/**
 * Builds the canonical V1 protocol report from stored evidence.
 *
 * Pure: no database, no provider, no clock except the injectable `now`. The
 * caller reads evidence; this decides only what the client is told.
 *
 * Two rules drive the shape:
 *
 *   1. Every attempt the protocol reserved must remain visible. A run that
 *      failed, or completed without a readable provider result, is counted
 *      and shown rather than dropped from the denominator — otherwise a
 *      partial scan reads as a clean one.
 *   2. Nothing is stated more precisely than the sample supports. At V1
 *      baseline sizes (a handful of runs, read from each protocol's own
 *      plannedBaselineRuns) a presence rate carries a Wilson interval so
 *      wide that it is only ever directional, and the report says so in
 *      words rather than leaving the reader to infer it from a number.
 */

import { DEPENDENCE_LIMITATION, surfaceLimitation } from "@/lib/reports/surface-limitations";
import { buildSourceInsights } from "@/lib/source-insights/build-source-insights";
import { extractProviderSources } from "@/lib/source-insights/extract-provider-sources";
import {
  PROTOCOL_REPORT_VERSION,
  type BuildProtocolReportInput,
  type EvidenceResultInput,
  type ProtocolReportCompetitor,
  type ProtocolReportInterval,
  type ProtocolReportObservation,
  type ProtocolReportPayload,
  type ProtocolReportReconciliation,
  type ProtocolReportRun,
} from "@/lib/reports/protocol-report-types";

/** z for a two-sided 95% interval. Shared with lib/reports/compare-protocols.ts. */
export const WILSON_Z = 1.959963984540054;

/**
 * Wilson score interval, unrounded.
 *
 * Chosen over the normal approximation because V1 baselines are tiny and
 * frequently land on p = 0 or p = 1, where the normal interval collapses to
 * zero width and would present "0%" as if it were certain.
 *
 * Exported unrounded so `compare-protocols.ts` can build the Newcombe
 * interval for a baseline/retest difference from these exact bounds rather
 * than from `wilsonInterval`'s display-rounded ones — the comparison decides
 * an outcome status, and compounding two roundings into that decision is a
 * needless (if small) source of drift from what the underlying data says.
 */
export function wilsonBounds(
  successes: number,
  trials: number
): ProtocolReportInterval | null {
  if (trials <= 0) return null;

  const p = successes / trials;
  const z2 = WILSON_Z * WILSON_Z;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;

  const margin =
    (WILSON_Z / denominator) *
    Math.sqrt(
      (p * (1 - p)) / trials + z2 / (4 * trials * trials)
    );

  const clamp = (v: number) => Math.min(1, Math.max(0, v));

  return {
    low: clamp(center - margin),
    high: clamp(center + margin),
  };
}

/** Wilson score interval, rounded to 3 decimals for display. */
export function wilsonInterval(
  successes: number,
  trials: number
): ProtocolReportInterval | null {
  const bounds = wilsonBounds(successes, trials);
  if (bounds === null) return null;

  const round = (v: number) => Math.round(v * 1000) / 1000;

  return {
    low: round(bounds.low),
    high: round(bounds.high),
  };
}

function countSources(value: unknown[]): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Tokens that carry no identity. Stripping them lets "Fathom" match "Fathom
 * Analytics" without letting a competitor literally named "Analytics" match
 * every company whose name ends in it.
 */
const GENERIC_NAME_TOKENS = new Set([
  "analytics",
  "app",
  "co",
  "company",
  "corp",
  "inc",
  "io",
  "labs",
  "llc",
  "ltd",
  "software",
  "technologies",
  "the",
]);

function identityTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token && !GENERIC_NAME_TOKENS.has(token))
  );
}

/**
 * The surface frequently names the client inside its own list of options —
 * an answer to "best alternatives" reasonably includes the brand being asked
 * about. Listing the client under "other brands named" would tell a reader
 * they compete with themselves, so a self-match is dropped wherever the
 * report lists other brands: the per-run lists and the summary built from
 * them. Whether the client was named is reported separately, as the run's
 * brand presence. The run's raw evidence is untouched.
 */
function isSameBrand(candidate: string, company: string): boolean {
  const a = identityTokens(candidate);
  const b = identityTokens(company);

  if (a.size === 0 || b.size === 0) return false;

  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) {
    if (!large.has(token)) return false;
  }
  return true;
}

/**
 * Attempts are ordered by their baseline ordinal when they have one; an
 * attempt without one sorts after the planned runs. A retry keeps the slot
 * of the run it retried (D-025), so within a slot attempts are ordered by
 * how many retries deep they are: the failed run, then its retry, then the
 * retry of that retry. Only then does the id break a tie.
 */
function orderAttempts(
  attempts: BuildProtocolReportInput["attempts"]
): BuildProtocolReportInput["attempts"] {
  const byId = new Map(attempts.map((a) => [a.id, a]));
  const depth = (attempt: (typeof attempts)[number]): number => {
    let d = 0;
    let parent = attempt.retryOfAttemptId;
    const seen = new Set<string>([attempt.id]);
    while (parent && byId.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      d += 1;
      parent = byId.get(parent)!.retryOfAttemptId;
    }
    return d;
  };
  return [...attempts].sort((a, b) => {
    const ao = a.baselineOrdinal ?? Number.MAX_SAFE_INTEGER;
    const bo = b.baselineOrdinal ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    const ad = depth(a);
    const bd = depth(b);
    if (ad !== bd) return ad - bd;
    return a.id.localeCompare(b.id);
  });
}

export function buildProtocolReport(
  input: BuildProtocolReportInput
): ProtocolReportPayload {
  const generatedAt = (input.now ?? new Date()).toISOString();

  const resultByProbeRun = new Map<string, EvidenceResultInput>();
  for (const result of input.results) {
    resultByProbeRun.set(result.probeRunId, result);
  }

  const ordered = orderAttempts(input.attempts);

  const ordinalByAttemptId = new Map<string, number>();
  ordered.forEach((attempt, index) => {
    ordinalByAttemptId.set(
      attempt.id,
      attempt.baselineOrdinal ?? index + 1
    );
  });

  const resultByRun = new Map<ProtocolReportRun, EvidenceResultInput | undefined>();

  const runs: ProtocolReportRun[] = ordered.map(
    (attempt, index) => {
      const result = attempt.probeRunId
        ? resultByProbeRun.get(attempt.probeRunId)
        : undefined;

      const run: ProtocolReportRun = {
        ordinal: attempt.baselineOrdinal ?? index + 1,
        status: attempt.status,
        brandPresent: result
          ? result.clientMentioned ?? null
          : null,
        position: result?.clientPosition ?? null,
        competitors: (result?.competitorsMentioned ?? []).filter(
          (name) => !isSameBrand(name, input.subject.companyName)
        ),
        citedSourceCount: countSources(
          result?.sourcesCited ?? []
        ),
        answerSummary: result?.answerSummary ?? "",
        evidenceHash: result?.rawResponseSha256 ?? null,
        providerModel: result?.providerModel ?? null,
        latencyMs: result?.providerLatencyMs ?? null,
        retryOfOrdinal: attempt.retryOfAttemptId
          ? ordinalByAttemptId.get(
              attempt.retryOfAttemptId
            ) ?? null
          : null,
        terminationReason: attempt.terminationReason,
      };
      resultByRun.set(run, result);
      return run;
    }
  );

  const completedRuns = runs.filter(
    (run) => run.status === "completed"
  );

  const measurable = completedRuns.filter(
    (run) => run.brandPresent !== null
  );

  const excludedByReview = runs.filter(
    (run) => run.status === "excluded"
  ).length;

  const failed = runs.filter(
    (run) =>
      run.status !== "completed" &&
      run.status !== "excluded"
  ).length;

  const excludedNoResult =
    completedRuns.length - measurable.length;

  const retried = runs.filter(
    (run) => run.retryOfOrdinal !== null
  ).length;

  const reconciliation: ProtocolReportReconciliation = {
    planned: input.protocol.plannedBaselineRuns,
    attempted: runs.length,
    completed: completedRuns.length,
    failed,
    excludedByReview,
    retried,
    excludedNoResult,
    accountedFor:
      completedRuns.length +
        failed +
        excludedByReview ===
      runs.length,
  };

  const numerator = measurable.filter(
    (run) => run.brandPresent === true
  ).length;

  const denominator = measurable.length;

  const observation: ProtocolReportObservation = {
    metric: input.protocol.primaryMetric,
    numerator,
    denominator,
    rate:
      denominator > 0 ? numerator / denominator : null,
    interval: wilsonInterval(numerator, denominator),
    intervalMethod: "wilson_95",
  };

  const competitorCounts = new Map<string, number>();
  for (const run of measurable) {
    for (const name of new Set(run.competitors)) {
      const key = name.trim();
      if (!key) continue;
      if (isSameBrand(key, input.subject.companyName)) continue;
      competitorCounts.set(
        key,
        (competitorCounts.get(key) ?? 0) + 1
      );
    }
  }

  const competitorsObserved: ProtocolReportCompetitor[] =
    [...competitorCounts.entries()]
      .map(([name, runsMentionedIn]) => ({
        name,
        runsMentionedIn,
      }))
      .sort(
        (a, b) =>
          b.runsMentionedIn - a.runsMentionedIn ||
          a.name.localeCompare(b.name)
      );

  const sourceInsights = buildSourceInsights(
    measurable.map((run) => {
      const result = resultByRun.get(run);
      return {
        ordinal: run.ordinal,
        ...extractProviderSources(result?.rawResponse, result?.rawResponseSha256),
      };
    }),
    input.subject.normalizedDomain
  );

  return {
    reportVersion: PROTOCOL_REPORT_VERSION,
    generatedAt,
    snapshotRequestId: input.snapshotRequestId,
    projectId: input.projectId,
    subject: input.subject,
    question: input.question,
    protocol: input.protocol,
    reconciliation,
    observation,
    runs,
    competitorsObserved,
    sourceInsights,
    uncertainty: buildUncertainty(
      observation,
      reconciliation
    ),
    integrityNotes: buildIntegrityNotes(
      input,
      reconciliation,
      observation
    ),
    limitations: buildLimitations(input),
  };
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function buildUncertainty(
  observation: ProtocolReportObservation,
  reconciliation: ProtocolReportReconciliation
): string[] {
  const notes: string[] = [];

  if (observation.denominator === 0) {
    notes.push(
      "No run produced a readable provider result, so no rate is reported. This is an empty result, not a zero."
    );
    return notes;
  }

  const { interval } = observation;

  if (interval) {
    notes.push(
      `Observed on ${observation.numerator} of ${observation.denominator} readable runs. The 95% Wilson interval spans ${formatPercent(
        interval.low
      )} to ${formatPercent(
        interval.high
      )}, which is wide because the sample is ${observation.denominator} runs.`
    );
  }

  notes.push(
    "Treat this as directional. It is not a precise measurement and does not support a ranking claim."
  );

  // Compared against the readable denominator, not the completed count. A
  // run can complete and still yield nothing usable, so completed-vs-planned
  // would report "3 of 3" while the rate quietly rests on two runs.
  if (observation.denominator < reconciliation.planned) {
    notes.push(
      `${observation.denominator} of ${reconciliation.planned} planned runs produced a readable result. The shortfall is shown in the run table rather than absorbed into the rate.`
    );
  }

  return notes;
}

function buildIntegrityNotes(
  input: BuildProtocolReportInput,
  reconciliation: ProtocolReportReconciliation,
  observation: ProtocolReportObservation
): string[] {
  const readableRuns = observation.denominator;

  const notes: string[] = [
    `Every number here is scoped to one buyer question version (hash ${input.question.hash.slice(
      0,
      12
    )}…) executed under approved protocol ${input.protocol.id}.`,
    `Attempt reconciliation: ${reconciliation.planned} planned, ${reconciliation.attempted} attempted, ${reconciliation.completed} completed, ${reconciliation.failed} failed, ${reconciliation.excludedByReview} excluded after review, ${reconciliation.excludedNoResult} completed without a readable result, ${readableRuns} readable and counted in the rate.`,
  ];

  if (reconciliation.excludedByReview > 0) {
    notes.push(
      `${reconciliation.excludedByReview} attempt(s) were excluded by a reviewer because the provider call could not be confirmed. They are not counted as observations, and no result was assumed for them.`
    );
  }

  if (!reconciliation.accountedFor) {
    notes.push(
      "Attempt counts do not reconcile. This report is incomplete and must not be delivered without review."
    );
  }

  if (reconciliation.retried > 0) {
    notes.push(
      `${reconciliation.retried} attempt(s) were retries of an earlier attempt. Both the original and the retry remain in the record.`
    );
  }

  notes.push(
    "Each run links to the SHA-256 of its stored raw provider response, which is insert-only and independently auditable."
  );

  return notes;
}

function buildLimitations(
  input: BuildProtocolReportInput
): string[] {
  return [
    `Single surface: ${input.protocol.provider} (${input.protocol.surface}), model ${input.protocol.model}.`,
    surfaceLimitation(input.protocol.provider),
    DEPENDENCE_LIMITATION,
    "Prompt-scoped: results describe this question only and do not generalize to other buyer questions.",
    "Observational: this records what the surface answered. It does not establish that any answer caused a sale to be won or lost.",
    `Point-in-time: captured under methodology version ${input.protocol.methodologyVersion}. Answers on this surface change over time; a registered retest is the only way to observe change.`,
  ];
}
