/**
 * Renders the canonical Outcome Card payload as human-readable markdown.
 *
 * Same discipline as render-protocol-report-markdown.ts: a projection of the
 * payload, never a second source of truth, and pure string rendering — no
 * database, no network.
 *
 * The permanent non-causality footer (D-006) is written as a LITERAL
 * string here, not interpolated from `payload.nonCausalityFooter`. That is
 * deliberate belt-and-suspenders: the builder already stamps the field
 * unconditionally, and this renderer does not trust that field alone to
 * carry the one sentence this product cannot ship without. Even a payload
 * that arrived here corrupted, or a future refactor that dropped the field
 * from the type, still gets the footer from this file.
 */

import type { OutcomeCardPayload } from "@/lib/reports/outcome-card-types";

const STATUS_LABEL: Record<OutcomeCardPayload["comparison"]["status"], string> = {
  increase_observed: "Increase observed",
  decrease_observed: "Decrease observed",
  no_clear_change: "No clear change",
  inconclusive: "Inconclusive",
};

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function signedPercent(value: number): string {
  const pct = Math.round(value * 100);
  return pct > 0 ? `+${pct}%` : `${pct}%`;
}

function phaseLine(label: string, phase: OutcomeCardPayload["baseline"]): string {
  const rate = phase.rate === null ? "no readable result" : percent(phase.rate);
  const interval = phase.interval
    ? ` (95% Wilson interval ${percent(phase.interval.low)}–${percent(phase.interval.high)})`
    : "";
  return `**${label}:** ${phase.numerator} of ${phase.denominator} readable runs — ${rate}${interval}. Planned: ${phase.plannedRuns}.`;
}

export function renderOutcomeCardMarkdown(payload: OutcomeCardPayload): string {
  const { subject, question, baseline, retest, intervention, comparison } = payload;
  const lines: string[] = [];

  lines.push(`# Outcome Card — ${subject.companyName}`);
  lines.push("");
  lines.push(`Website: ${subject.websiteUrl}`);
  lines.push(`Generated: ${payload.generatedAt}`);
  lines.push("");

  lines.push("## 1. The registered question");
  lines.push("");
  lines.push("> " + question.text.split("\n").join("\n> "));
  lines.push("");
  lines.push(
    `Question version ${question.versionNumber} · prompt hash \`${question.hash}\` — the SAME question and version on both the baseline and the retest.`
  );
  lines.push("");

  lines.push("## 2. The registered intervention");
  lines.push("");
  lines.push(`**Hypothesis:** ${intervention.hypothesis}`);
  lines.push(`**Expected mechanism:** ${intervention.expectedMechanism}`);
  lines.push(`**Action:** ${intervention.actionType} — ${intervention.actionTarget}`);
  lines.push(`**Owner:** ${intervention.owner}`);
  if (intervention.approvedAt) lines.push(`**Approved:** ${intervention.approvedAt}`);
  if (intervention.implementedAt) lines.push(`**Implemented:** ${intervention.implementedAt}`);
  if (intervention.observationWindowOpensAt && intervention.observationWindowClosesAt) {
    lines.push(
      `**Observation window:** ${intervention.observationWindowOpensAt} → ${intervention.observationWindowClosesAt}`
    );
  }
  if (intervention.earlyRetestReason) {
    lines.push("");
    lines.push(
      `⚠ **Retested before the observation window closed**, under a recorded deviation: ${intervention.earlyRetestReason}`
    );
  }
  lines.push("");

  lines.push("## 3. What each phase observed");
  lines.push("");
  lines.push(phaseLine("Baseline", baseline));
  lines.push(phaseLine("Retest", retest));
  lines.push("");

  lines.push("## 4. Outcome");
  lines.push("");
  lines.push(`### ${STATUS_LABEL[comparison.status]}`);
  lines.push("");
  if (comparison.delta !== null) {
    lines.push(`Observed change: ${signedPercent(comparison.delta)} (retest minus baseline).`);
  }
  if (comparison.interval) {
    lines.push(
      `95% interval on the difference (Newcombe): ${signedPercent(comparison.interval.low)} to ${signedPercent(
        comparison.interval.high
      )}.`
    );
  }
  lines.push(`Minimum useful change (Δ_min), declared before this retest ran: ${percent(comparison.minimumUsefulChange)}.`);
  if (comparison.smallestDetectableChange !== null) {
    lines.push(
      `Smallest change this sample could have separated from zero: ${percent(comparison.smallestDetectableChange)}.`
    );
  }
  lines.push("");

  lines.push("## 5. How certain this is");
  lines.push("");
  for (const note of payload.uncertainty) lines.push(`- ${note}`);
  lines.push("");

  lines.push("## 6. What this does not tell you");
  lines.push("");
  for (const note of payload.limitations) lines.push(`- ${note}`);
  lines.push("");

  lines.push("---");
  lines.push("");
  // Literal, not `payload.nonCausalityFooter` — see the file header.
  lines.push(
    "**This Outcome Card documents an observed change under the recorded conditions. It does not establish that the intervention caused the change.**"
  );
  lines.push("");

  return lines.join("\n");
}
