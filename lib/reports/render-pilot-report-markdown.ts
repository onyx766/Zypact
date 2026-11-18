/**
 * D-055 — the combined pilot report as Markdown. It renders the shared
 * presentation model (pilot-report-presentation.ts), the same one the client
 * page renders, so the two say the same thing and add no words of their own.
 */
import { NON_CAUSALITY_FOOTER } from "@/lib/reports/outcome-card-types";
import {
  presentPilotReport,
  type PilotPresentationSection,
} from "@/lib/reports/pilot-report-presentation";
import type { PilotReportPayload } from "@/lib/reports/pilot-report-types";

const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

function section(out: string[], s: PilotPresentationSection): void {
  out.push(`## ${cell(s.heading)}`);
  out.push("");
  for (const p of s.paragraphs) {
    out.push(p);
    out.push("");
  }
  if (s.table) {
    out.push(`| ${s.table.columns.map(cell).join(" | ")} |`);
    out.push(`|${s.table.columns.map(() => "---").join("|")}|`);
    for (const row of s.table.rows) out.push(`| ${row.map(cell).join(" | ")} |`);
    out.push("");
  }
  for (const n of s.notes) {
    out.push(n);
    out.push("");
  }
}

export function renderPilotReportMarkdown(payload: PilotReportPayload): string {
  const v = presentPilotReport(payload);
  const out: string[] = [];

  out.push(`# ${v.eyebrow}: ${cell(v.title)}`);
  out.push("");
  out.push(`- Website: ${v.websiteUrl}`);
  for (const chip of v.chips) out.push(`- ${chip}`);
  out.push(`- Generated: ${payload.generatedAt.slice(0, 10)}`);
  out.push("");
  for (const line of v.heroCopy) out.push(line);
  out.push("");

  out.push(`## ${v.enginesHeading}`);
  out.push("");
  for (const e of v.engines) out.push(`- ${e}`);
  out.push("");

  for (const s of v.conditions) section(out, s);
  for (const s of v.sections) section(out, s);

  out.push(`## ${v.questionsHeading}`);
  out.push("");
  for (const p of v.questionsIntro) {
    out.push(p);
    out.push("");
  }
  for (const q of v.questions) {
    out.push(`### ${cell(q.heading)}`);
    out.push("");
    out.push(q.meta);
    out.push("");
    for (const line of q.lines) out.push(`- ${line}`);
    out.push("");
  }

  if (v.actions) {
    out.push(`## ${v.actions.heading}`);
    out.push("");
    for (const p of v.actions.intro) {
      out.push(p);
      out.push("");
    }
    for (const a of v.actions.actions) {
      out.push(`### ${cell(a.heading)}`);
      out.push("");
      for (const f of a.fields) out.push(`- **${f.label}:** ${f.text.replace(/\s+/g, " ").trim()}`);
      out.push("");
      out.push(`${a.basedOnHeading}:`);
      out.push("");
      for (const line of a.basedOn) out.push(`- ${line}`);
      out.push("");
      out.push(a.reviewed);
      out.push("");
    }
    for (const n of v.actions.notes) {
      out.push(n);
      out.push("");
    }
  }

  // D-062 — the retest section: each change, its log, its members, its cards.
  if (v.retests) {
    out.push(`## ${v.retests.heading}`);
    out.push("");
    for (const p of v.retests.intro) {
      out.push(p);
      out.push("");
    }
    for (const g of v.retests.groups) {
      out.push(`### ${cell(g.heading)}`);
      out.push("");
      for (const f of g.fields) out.push(`- **${f.label}:** ${f.text.replace(/\s+/g, " ").trim()}`);
      out.push("");
      for (const line of g.lines) out.push(`- ${line}`);
      out.push("");
      out.push(`${g.notesHeading}:`);
      out.push("");
      for (const n of g.notes) out.push(`- ${n}`);
      out.push("");
      out.push(`| ${g.members.columns.map(cell).join(" | ")} |`);
      out.push(`|${g.members.columns.map(() => "---").join("|")}|`);
      for (const row of g.members.rows) out.push(`| ${row.map(cell).join(" | ")} |`);
      out.push("");
      for (const c of g.cards) {
        out.push(`#### ${cell(c.heading)}`);
        out.push("");
        for (const b of c.blocks) {
          if (b.title) {
            out.push(`${b.title}:`);
            out.push("");
          }
          for (const line of b.lines) out.push(`- ${line}`);
          out.push("");
        }
        // The footer from the constant, never from the payload.
        out.push(`_${NON_CAUSALITY_FOOTER}_`);
        out.push("");
      }
    }
    for (const w of v.retests.withdrawn) {
      out.push(w);
      out.push("");
    }
  }

  out.push(`## ${v.limitsHeading}`);
  out.push("");
  for (const l of v.limitations) out.push(`- ${l}`);
  out.push("");
  out.push(`## ${v.methodHeading}`);
  out.push("");
  for (const n of v.methodNotes) out.push(`- ${n}`);
  out.push("");
  out.push(v.evidenceLine);
  out.push("");
  out.push(`_${v.causalLimit}_`);
  out.push("");
  return out.join("\n");
}
