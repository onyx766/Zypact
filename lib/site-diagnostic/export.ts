/**
 * Safe exports of a W1 report: canonical JSON and Markdown.
 *
 * Both render only the frozen report object, so they cannot disagree with it
 * or with each other. Every value that came from the site (URLs, excerpts)
 * is escaped for Markdown and HTML, so a hostile page title cannot inject
 * links, images or markup into the export. Both carry the scope statement
 * and, when the domain is unverified, the ownership label.
 *
 * Pure module.
 */
import { STATE_LABELS } from "@/lib/site-diagnostic/copy";
import { canonicalJson, type DiagnosticReport, type ReportFinding } from "@/lib/site-diagnostic/report";

export function exportReportJson(report: DiagnosticReport): string {
  return `${canonicalJson(report)}\n`;
}

/** Escape text for Markdown and inline HTML. */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}[\]()#+!|~-])/g, "\\$1")
    .replace(/\r?\n/g, " ");
}

/** URLs are shown as code, never as live links. */
const code = (text: string) => "`" + text.replace(/`/g, "'") + "`";

function findingLine(finding: ReportFinding): string {
  const parts = [`**${STATE_LABELS[finding.state]}** — ${escapeMarkdown(finding.title)}`];
  if (finding.pageUrl) parts.push(`on ${code(finding.pageUrl)}`);
  if (finding.unknownReason) parts.push(`(${code(finding.unknownReason)}: ${escapeMarkdown(finding.unknownReasonText ?? "")})`);
  const lines = [`- ${parts.join(" ")}`];
  if (finding.excerpt) lines.push(`  - Evidence excerpt: "${escapeMarkdown(finding.excerpt.text)}" (bytes ${finding.excerpt.start}–${finding.excerpt.end} of page sha256 ${code(finding.excerpt.bodySha256)})`);
  lines.push(`  - Establishes: ${escapeMarkdown(finding.establishes)}`);
  lines.push(`  - Does not establish: ${escapeMarkdown(finding.doesNotEstablish)}`);
  return lines.join("\n");
}

export function exportReportMarkdown(report: DiagnosticReport): string {
  const out: string[] = [];
  out.push(`# Website Buyer-Readiness Diagnostic — ${escapeMarkdown(report.input.normalizedDomain)}`);
  out.push("");
  out.push(`> ${report.notices.scope}`);
  if (report.notices.ownership) out.push(`>`, `> ${report.notices.ownership}`);
  out.push("");
  out.push(report.notices.noScore);
  out.push("");
  out.push(report.notices.sampleLimit);
  out.push("");
  out.push("## Run");
  out.push("");
  out.push(`- Start URL: ${code(report.input.startUrl)}`);
  out.push(`- Outcome: ${code(report.run.outcome)} — ${report.run.outcomeText}`);
  out.push(`- Stopped because: ${code(report.run.stopReason)}`);
  out.push(`- Fetched: ${report.run.startedAt} to ${report.run.completedAt}; ${report.pages.length} page rows, ${report.run.requestCount} requests`);
  out.push(`- Rule set ${code(report.ruleSetVersion)}, crawler ${code(report.crawlerVersion)}, personal-data screen ${code(report.piiScreenVersion)}`);
  out.push(`- Report sha256 ${code(report.reportSha256)}`);
  out.push("");

  out.push("## Fix list");
  out.push("");
  if (report.fixList.length === 0) out.push("No fixes suggested by these checks.");
  for (const item of report.fixList) {
    const where = item.pageUrl ? ` (${code(item.pageUrl)})` : "";
    out.push(`- [${item.kind === "issue" ? "Issue" : "Suggestion"}, ${item.priority}] ${escapeMarkdown(item.title)}${where}: ${escapeMarkdown(item.text)}`);
  }
  out.push("");

  out.push("## Findings by area");
  for (const { area, label } of report.areas) {
    const inArea = report.findings.filter((finding) => finding.area === area);
    if (inArea.length === 0) continue;
    out.push("", `### ${label}`, "");
    for (const finding of inArea) out.push(findingLine(finding));
  }
  out.push("");

  out.push("## Pages fetched");
  out.push("");
  out.push("| # | URL | Status | Bytes | sha256 | Not fetched / error |");
  out.push("| --- | --- | --- | --- | --- | --- |");
  for (const page of report.pages) {
    out.push(
      `| ${page.pageIndex} | ${code(page.url)} | ${page.httpStatus ?? "—"} | ${page.bytes} | ${page.bodySha256 ? code(page.bodySha256.slice(0, 16) + "…") : "—"} | ${page.fetchError ? code(page.fetchError) : ""} |`
    );
  }
  out.push("");
  return out.join("\n");
}
