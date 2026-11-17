/**
 * Renders the canonical payload as human-readable markdown.
 *
 * This is the auditable form of a delivered report: a founder, a client, or
 * a reviewer can read it without the application. It is a *projection* of
 * the payload, never a second source of truth — the client page renders the
 * payload itself, so markdown drift cannot change what a client is shown.
 *
 * Pure string rendering: no database, no network.
 */

import type {
  ProtocolReportPayload,
  ProtocolReportSourceInsights,
} from "@/lib/reports/protocol-report-types";
import { questionProvenanceLabel } from "@/lib/reports/question-provenance";
import { SOURCE_CATEGORY_LABEL } from "@/lib/source-insights/source-types";

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

function presenceLabel(value: boolean | null): string {
  if (value === null) return "no readable result";
  return value ? "present" : "not present";
}

function runList(ordinals: number[]): string {
  return ordinals.length > 0 ? ordinals.join(", ") : "—";
}

/**
 * Per-run source cell: provider counts when available, else the stored count.
 * Insights exist for readable runs only, keyed by slot, so a failed run that
 * shares its slot with its retry is never given the retry's sources.
 */
function sourcesCell(payload: ProtocolReportPayload, row: ProtocolReportPayload["runs"][number]): string {
  if (!payload.sourceInsights) return String(row.citedSourceCount);
  if (row.status !== "completed" || row.brandPresent === null) return "—";
  const ordinal = row.ordinal;
  const run = payload.sourceInsights.runs.find((r) => r.ordinal === ordinal);
  if (!run) return "—";
  if (run.status !== "ok") return "unavailable";
  return `${run.cited.length} cited · ${run.retrievedOnly.length} retrieved only`;
}

function renderSourceSection(insights: ProtocolReportSourceInsights): string[] {
  const lines: string[] = [];
  const n = insights.runsWithSourceEvidence;

  lines.push("## 4. Sources the answers cited");
  lines.push("");

  if (n === 0) {
    lines.push(
      `None of the ${insights.readableRuns} readable run(s) had a usable stored source list, so no sources are reported. This is an empty result, not evidence that nothing was cited.`
    );
  } else {
    lines.push(
      `Your site was cited in ${insights.runsWithOwnedCitation} of ${n} run(s) with a usable source list.`
    );
    lines.push("");
    if (insights.domains.length > 0) {
      lines.push("| Domain | Type | Cited in | Retrieved only in | Cited in runs |");
      lines.push("| --- | --- | --- | --- | --- |");
      for (const d of insights.domains) {
        lines.push(
          `| ${cell(d.domain)} | ${SOURCE_CATEGORY_LABEL[d.category]} | ${d.citedInRuns} of ${n} | ${d.retrievedOnlyInRuns} of ${n} | ${runList(d.citedRunOrdinals)} |`
        );
      }
    } else {
      lines.push("The provider returned no usable source URLs in these runs.");
    }
  }
  lines.push("");
  for (const note of insights.notes) lines.push(`- ${note}`);
  lines.push("");
  return lines;
}

export function renderProtocolReportMarkdown(
  payload: ProtocolReportPayload
): string {
  const {
    subject,
    question,
    protocol,
    reconciliation,
    observation,
  } = payload;

  const lines: string[] = [];

  lines.push(`# AI Answer Snapshot — ${subject.companyName}`);
  lines.push("");
  lines.push(`Website: ${subject.websiteUrl}`);
  lines.push(`Generated: ${payload.generatedAt}`);
  lines.push(
    `Surface: ${protocol.provider} (${protocol.surface}), model ${protocol.model}`
  );
  lines.push(`Methodology version: ${protocol.methodologyVersion}`);
  lines.push("");

  lines.push("## 1. What was asked");
  lines.push("");
  lines.push("> " + question.text.split("\n").join("\n> "));
  lines.push("");
  lines.push(
    `Question version ${question.versionNumber} · intent ${question.intentType} · provenance: ${questionProvenanceLabel(question.provenance)}`
  );
  lines.push(`Prompt hash: \`${question.hash}\``);
  lines.push("");
  lines.push(
    "This is the exact text that was sent. Every number below is scoped to this question and nothing else."
  );
  lines.push("");

  lines.push("## 2. What was observed");
  lines.push("");

  if (observation.rate === null) {
    lines.push(
      "No run produced a readable provider result, so no rate is reported. This is an empty result, not a zero."
    );
  } else {
    lines.push(
      `**${protocol.primaryMetric}:** ${observation.numerator} of ${observation.denominator} readable runs (${percent(
        observation.rate
      )}).`
    );
    if (observation.interval) {
      lines.push("");
      lines.push(
        `**95% interval (Wilson):** ${percent(
          observation.interval.low
        )} to ${percent(observation.interval.high)}`
      );
    }
  }
  lines.push("");

  lines.push("### Run-by-run");
  lines.push("");
  lines.push(
    "| Run | Status | Brand | Position | Competitors named | Sources | Evidence (SHA-256) |"
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");

  for (const run of payload.runs) {
    const label =
      run.retryOfOrdinal !== null
        ? `${run.ordinal} (retry of ${run.retryOfOrdinal})`
        : String(run.ordinal);

    // The reason travels with the status. Without it the artifact says a run
    // failed but not why, and the markdown is the copy a reviewer reads when
    // reconciling a short sample against the evidence.
    const status = run.terminationReason
      ? `${run.status} — ${run.terminationReason}`
      : run.status;

    lines.push(
      `| ${label} | ${cell(status)} | ${presenceLabel(
        run.brandPresent
      )} | ${cell(run.position ?? "—")} | ${
        run.status !== "completed" || run.brandPresent === null
          ? "—"
          : run.competitors.length > 0
            ? cell(run.competitors.join(", "))
            : "none"
      } | ${sourcesCell(payload, run)} | ${
        run.evidenceHash ? `\`${run.evidenceHash.slice(0, 16)}…\`` : "—"
      } |`
    );
  }
  lines.push("");

  lines.push("### Attempt reconciliation");
  lines.push("");
  lines.push(`- Planned runs: ${reconciliation.planned}`);
  lines.push(`- Attempted: ${reconciliation.attempted}`);
  lines.push(`- Completed: ${reconciliation.completed}`);
  lines.push(`- Failed: ${reconciliation.failed}`);
  lines.push(
    `- Excluded after review: ${reconciliation.excludedByReview}`
  );
  lines.push(`- Retries: ${reconciliation.retried}`);
  lines.push(
    `- Completed without a readable result: ${reconciliation.excludedNoResult}`
  );
  lines.push(
    `- Readable (counted in the rate): ${observation.denominator}`
  );
  lines.push(
    `- Counts reconcile: ${reconciliation.accountedFor ? "yes" : "NO — review required"}`
  );
  lines.push("");

  if (payload.competitorsObserved.length > 0) {
    lines.push("## 3. Other brands named in these answers");
    lines.push("");
    for (const competitor of payload.competitorsObserved) {
      lines.push(
        `- ${competitor.name} — named in ${competitor.runsMentionedIn} of ${observation.denominator} readable run(s)`
      );
    }
    lines.push("");
    lines.push(
      "These are brands the surface named while answering this question. Their presence is not evidence that they displaced you or won a sale."
    );
    lines.push("");
  }

  if (payload.sourceInsights) {
    lines.push(...renderSourceSection(payload.sourceInsights));
  }

  lines.push("## 5. How certain this is");
  lines.push("");
  for (const note of payload.uncertainty) lines.push(`- ${note}`);
  lines.push("");

  lines.push("## 6. What this does not tell you");
  lines.push("");
  for (const note of payload.limitations) lines.push(`- ${note}`);
  lines.push("");

  lines.push("## 7. Integrity notes");
  lines.push("");
  for (const note of payload.integrityNotes) lines.push(`- ${note}`);
  lines.push("");

  return lines.join("\n");
}

/** Brands listed in the short report before deferring to the full one. */
const SHORT_REPORT_COMPETITOR_LIMIT = 3;

/**
 * The short projection of the same payload.
 *
 * Every figure is read from the payload the full report renders, so the two
 * can differ in detail but never in a number. What is dropped is audit
 * detail: the run-by-run table, evidence hashes, question metadata, and the
 * integrity notes. What is kept is everything a reader needs to not
 * over-read the result — the exact question, the rate with its interval,
 * the failed and excluded attempts behind it, and every uncertainty and
 * limitation note.
 */
export function renderProtocolShortReportMarkdown(
  payload: ProtocolReportPayload
): string {
  const { subject, question, protocol, reconciliation, observation } =
    payload;

  const lines: string[] = [];

  lines.push(`# AI Answer Snapshot (summary) — ${subject.companyName}`);
  lines.push("");
  lines.push(`Website: ${subject.websiteUrl}`);
  lines.push(`Generated: ${payload.generatedAt}`);
  lines.push(
    `Surface: ${protocol.provider} (${protocol.surface}), model ${protocol.model}`
  );
  lines.push("");

  lines.push("## The question");
  lines.push("");
  lines.push("> " + question.text.split("\n").join("\n> "));
  lines.push("");

  lines.push("## What was observed");
  lines.push("");

  if (observation.rate === null) {
    lines.push(
      "No run produced a readable provider result, so no rate is reported. This is an empty result, not a zero."
    );
  } else {
    const interval = observation.interval
      ? ` (95% interval ${percent(observation.interval.low)} to ${percent(
          observation.interval.high
        )})`
      : "";
    lines.push(
      `**${protocol.primaryMetric}:** ${observation.numerator} of ${observation.denominator} readable runs, ${percent(
        observation.rate
      )}${interval}.`
    );
  }
  lines.push("");

  // One line in place of the reconciliation list. Failed and excluded
  // attempts stay visible, because a short report that showed only the
  // readable runs would quietly shrink the denominator.
  lines.push(
    `Runs: ${reconciliation.planned} planned, ${reconciliation.attempted} attempted, ${reconciliation.failed} failed, ${reconciliation.excludedByReview} excluded after review, ${reconciliation.excludedNoResult} without a readable result, ${observation.denominator} counted in the rate.`
  );
  if (!reconciliation.accountedFor) {
    lines.push("");
    lines.push(
      "Attempt counts do not reconcile. This report is incomplete and must not be delivered without review."
    );
  }
  lines.push("");

  if (payload.competitorsObserved.length > 0) {
    const shown = payload.competitorsObserved.slice(
      0,
      SHORT_REPORT_COMPETITOR_LIMIT
    );
    const remaining =
      payload.competitorsObserved.length - shown.length;

    lines.push("## Other brands named");
    lines.push("");
    for (const competitor of shown) {
      lines.push(
        `- ${competitor.name} — ${competitor.runsMentionedIn} of ${observation.denominator} readable run(s)`
      );
    }
    if (remaining > 0) {
      lines.push(`- and ${remaining} more, listed in the full report`);
    }
    lines.push("");
    lines.push(
      "Being named is not evidence that a brand displaced you or won a sale."
    );
    lines.push("");
  }

  const insights = payload.sourceInsights;
  if (insights && insights.runsWithSourceEvidence > 0) {
    const n = insights.runsWithSourceEvidence;
    const external = insights.domains
      .filter((d) => d.category !== "owned" && d.citedInRuns > 0)
      .slice(0, SHORT_REPORT_COMPETITOR_LIMIT);
    lines.push("## Sources cited");
    lines.push("");
    lines.push(
      `- Your site was cited in ${insights.runsWithOwnedCitation} of ${n} run(s) with a usable source list.`
    );
    for (const d of external) {
      lines.push(`- ${d.domain} (${SOURCE_CATEGORY_LABEL[d.category].toLowerCase()}) — cited in ${d.citedInRuns} of ${n}`);
    }
    lines.push("");
    lines.push(
      "Zypact has not opened these pages, and whether a source is cited does not show that changing a page would change the answer. The full report lists every source."
    );
    lines.push("");
  }

  lines.push("## Read this with care");
  lines.push("");
  for (const note of payload.uncertainty) lines.push(`- ${note}`);
  for (const note of payload.limitations) lines.push(`- ${note}`);
  lines.push("");

  lines.push(
    "The full report has the run-by-run results, the evidence hash for each run, and the complete attempt reconciliation."
  );
  lines.push("");

  return lines.join("\n");
}
