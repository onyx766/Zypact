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
} from "@/lib/reports/protocol-report-types";

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
    `Question version ${question.versionNumber} · intent ${question.intentType} · provenance ${question.provenance}`
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
        run.competitors.length > 0
          ? cell(run.competitors.join(", "))
          : "none"
      } | ${run.citedSourceCount} | ${
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

  lines.push("## 4. How certain this is");
  lines.push("");
  for (const note of payload.uncertainty) lines.push(`- ${note}`);
  lines.push("");

  lines.push("## 5. What this does not tell you");
  lines.push("");
  for (const note of payload.limitations) lines.push(`- ${note}`);
  lines.push("");

  lines.push("## 6. Integrity notes");
  lines.push("");
  for (const note of payload.integrityNotes) lines.push(`- ${note}`);
  lines.push("");

  return lines.join("\n");
}
