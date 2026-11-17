/**
 * D-055 — the combined pilot report as Markdown, rendered from the stored
 * payload only. Same sections and same words as the client page.
 */
import { pilotProvenanceLabel } from "@/lib/pilots/copy";
import { engineLabel } from "@/lib/reports/build-pilot-report";
import {
  LABEL_WORDS,
  PILOT_REPORT_TITLE,
  PORTFOLIO_WEIGHTING_WORDS,
  RETIRED_WORDS,
  STATE_WORDS,
  rangeWords,
} from "@/lib/reports/pilot-report-copy";
import type { PilotReportPayload } from "@/lib/reports/pilot-report-types";
import { SOURCE_CATEGORY_LABEL } from "@/lib/source-insights/source-types";

const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

export function renderPilotReportMarkdown(payload: PilotReportPayload): string {
  const out: string[] = [];
  const { subject, window } = payload;

  out.push(`# ${PILOT_REPORT_TITLE}: ${cell(subject.companyName)}`);
  out.push("");
  out.push(`- Website: ${subject.websiteUrl}`);
  out.push(`- Pilot period: ${window.startsOn} to ${window.endsOn}`);
  out.push(`- Generated: ${payload.generatedAt.slice(0, 10)}`);
  out.push(`- Questions: ${payload.questions.filter((q) => !q.retired).length}${payload.questions.some((q) => q.retired) ? ` (and ${payload.questions.filter((q) => q.retired).length} retired)` : ""}`);
  out.push("");

  out.push("## Engines");
  out.push("");
  for (const e of payload.engines) out.push(`- ${e.label}: ${e.note}`);
  out.push("");

  for (const section of payload.brand) {
    out.push(`## ${engineLabel(section.engine)}: was ${cell(subject.companyName)} named?`);
    out.push("");
    out.push("| # | Status | Named in | Likely range | Attempts | Reading |");
    out.push("|---|---|---|---|---|---|");
    for (const r of section.rows) {
      out.push(
        `| ${r.ordinal} | ${r.retired ? "Retired" : STATE_WORDS[r.state]} | ${r.numerator} of ${r.denominator} readable answers | ${rangeWords(r.intervalLow, r.intervalHigh)} | ${r.attempted} attempted of ${r.planned} planned, ${r.failed} failed, ${r.excluded} without a readable result | ${LABEL_WORDS[r.label]} |`
      );
    }
    out.push("");
    const p = section.portfolio;
    if (p) {
      out.push(
        `**Total across ${p.includedOrdinals.length} finished question${p.includedOrdinals.length === 1 ? "" : "s"}:** named in ${p.numerator} of ${p.denominator} readable answers. ${PORTFOLIO_WEIGHTING_WORDS} ${p.heterogeneity}`
      );
      if (p.leftOutOrdinals.length > 0) out.push(`Left out of the total: question${p.leftOutOrdinals.length === 1 ? "" : "s"} ${p.leftOutOrdinals.join(", ")}.`);
      out.push("");
    }
  }

  for (const section of payload.competitors) {
    out.push(`## ${engineLabel(section.engine)}: other brands named, across questions`);
    out.push("");
    out.push("These are totals across different questions, not a result for any one question.");
    out.push("");
    if (section.rows.length === 0) {
      out.push("No other brand was named in a readable answer.");
    } else {
      out.push("| Brand | Questions | Where |");
      out.push("|---|---|---|");
      for (const r of section.rows) {
        out.push(
          `| ${cell(r.name)} | ${r.appearances.length} | ${r.appearances.map((a) => `Q${a.ordinal}: ${a.runs} of ${a.readableRuns}`).join("; ")} |`
        );
      }
      if (section.rowsNotShown > 0) out.push(`\n${section.rowsNotShown} further name(s) are in the question sections below.`);
    }
    out.push("");
  }

  for (const section of payload.sources) {
    out.push(`## ${engineLabel(section.engine)}: types of source cited, by question`);
    out.push("");
    if (section.rows.length === 0) {
      out.push("No readable answer had a usable source list.");
    } else {
      out.push("| Source type | Cited in (answers per question) | Returned but not cited |");
      out.push("|---|---|---|");
      for (const r of section.rows) {
        const cited = r.cells.filter((c) => c.citedInRuns > 0).map((c) => `Q${c.ordinal}: ${c.citedInRuns}`).join("; ") || "none";
        const retrieved = r.cells.filter((c) => c.retrievedOnlyInRuns > 0).map((c) => `Q${c.ordinal}: ${c.retrievedOnlyInRuns}`).join("; ") || "none";
        out.push(`| ${SOURCE_CATEGORY_LABEL[r.category]} | ${cited} | ${retrieved} |`);
      }
    }
    const thin = section.coverage.filter((c) => c.runsWithSourceEvidence < c.readableRuns);
    if (thin.length > 0) {
      out.push("");
      out.push(`Some answers had no usable source list and are not counted here: ${thin.map((c) => `Q${c.ordinal} (${c.readableRuns - c.runsWithSourceEvidence} of ${c.readableRuns})`).join(", ")}.`);
    }
    out.push("");
  }

  out.push("## The questions");
  out.push("");
  for (const q of payload.questions) {
    out.push(`### ${q.ordinal}. ${cell(q.text)}`);
    out.push("");
    out.push(`${pilotProvenanceLabel(q.provenance)}. Approved by the customer on ${q.customerApprovedOn}.`);
    if (q.retired) out.push(`${RETIRED_WORDS}${q.retiredOn ? ` (${q.retiredOn})` : ""}`);
    for (const m of q.measurements) {
      const { report } = m;
      const o = report.observation;
      const r = report.reconciliation;
      out.push("");
      out.push(`**${engineLabel(m.engine)}** (${STATE_WORDS[m.state]}): named in ${o.numerator} of ${o.denominator} readable answers; likely range ${rangeWords(o.interval?.low ?? null, o.interval?.high ?? null)}.`);
      out.push(`Attempts: ${r.planned} planned, ${r.attempted} attempted, ${r.completed} completed, ${r.failed} failed, ${r.excludedByReview} excluded after review, ${r.excludedNoResult} completed without a readable result.`);
      if (report.competitorsObserved.length > 0) {
        out.push(`Other brands named: ${report.competitorsObserved.map((c) => `${cell(c.name)} (${c.runsMentionedIn})`).join(", ")}.`);
      }
    }
    for (const e of payload.engines.filter((e) => !q.measurements.some((m) => m.engine === e.engine))) {
      out.push("");
      out.push(`**${e.label}**: not measured for this question.`);
    }
    out.push("");
  }

  out.push("## Limits of this report");
  out.push("");
  for (const l of payload.limitations) out.push(`- ${l}`);
  out.push("");
  out.push("## How the figures were produced");
  out.push("");
  for (const n of payload.methodNotes) out.push(`- ${n}`);
  out.push("");
  out.push(`Evidence: ${payload.evidenceIndex.length} recorded attempt${payload.evidenceIndex.length === 1 ? "" : "s"}, each linked to the SHA-256 of its stored provider response where one exists.`);
  out.push("");
  return out.join("\n");
}
