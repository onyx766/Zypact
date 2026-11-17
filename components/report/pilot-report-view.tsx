import { Calendar, ExternalLink, Info, Lock } from "lucide-react";

import {
  NEWER_REVISION_WORDS,
  PREVIEW_BANNER_WORDS,
  PRIVATE_REPORT_WORDS,
  revisionChipWords,
} from "@/lib/reports/pilot-report-copy";
import {
  presentPilotReport,
  type PilotPresentationSection,
} from "@/lib/reports/pilot-report-presentation";
import type { PilotReportPayload } from "@/lib/reports/pilot-report-types";
import { Brand } from "./protocol-report-view";

import "./protocol-report.css";

/**
 * D-055 — a stored pilot report revision, as the customer sees it and as the
 * founder previews it before sharing. Every word comes from the shared
 * presentation model (pilot-report-presentation.ts), the same one the
 * Markdown renders, or from the page frame in pilot-report-copy.ts; nothing
 * is re-derived here. An engine with no measurement says so in words and is
 * never shown as zero.
 */
export function PilotReportView({
  payload,
  revision,
  sharedAt,
  newerSharedRevision,
  preview = false,
}: {
  payload: PilotReportPayload;
  revision: number;
  sharedAt: string | null;
  newerSharedRevision: boolean;
  preview?: boolean;
}) {
  const v = presentPilotReport(payload);

  return (
    <main className="zpr-root">
      <header className="zpr-header">
        <a href="/" aria-label="Zypact home">
          <Brand />
        </a>
        <span className="zpr-private">
          <Lock size={14} strokeWidth={2} />
          {PRIVATE_REPORT_WORDS}
        </span>
      </header>

      {preview ? (
        <p className="zpr-hero-copy" role="note">
          <strong>{PREVIEW_BANNER_WORDS}</strong>
        </p>
      ) : null}

      <section className="zpr-hero">
        <div className="zpr-hero-inner">
          <p className="zpr-eyebrow">{v.eyebrow}</p>
          <h1 className="zpr-title">{v.title}</h1>
          <a className="zpr-site" href={v.websiteUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={15} strokeWidth={2} />
            {v.websiteUrl}
          </a>
          {v.heroCopy.map((line) => (
            <p key={line} className="zpr-hero-copy">
              {line}
            </p>
          ))}
          <div className="zpr-chips">
            <span className="zpr-chip">
              <Calendar size={14} strokeWidth={1.9} />
              {v.chips[0]}
            </span>
            <span className="zpr-chip">
              <Info size={14} strokeWidth={1.9} />
              {revisionChipWords(revision, payload.generatedAt.slice(0, 10), sharedAt ? sharedAt.slice(0, 10) : null)}
            </span>
            {v.chips.slice(1).map((chip) => (
              <span key={chip} className="zpr-chip">
                {chip}
              </span>
            ))}
          </div>
          {newerSharedRevision ? (
            <p className="zpr-hero-copy">
              <strong>{NEWER_REVISION_WORDS}</strong>
            </p>
          ) : null}
        </div>
      </section>

      <div className="zpr-shell">
        <section className="zpr-card zpr-section">
          <h2 className="zpr-section-title">{v.enginesHeading}</h2>
          <ul className="zpr-list">
            {v.engines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>

        {v.conditions.map((s) => (
          <Section key={s.key} section={s} />
        ))}

        {v.sections.map((s) => (
          <Section key={s.key} section={s} />
        ))}

        <section className="zpr-card zpr-section">
          <h2 className="zpr-section-title">{v.questionsHeading}</h2>
          {v.questionsIntro.map((p) => (
            <p key={p} className="zpr-section-sub">
              {p}
            </p>
          ))}
          {v.questions.map((q) => (
            <article key={q.key} className="zpr-section">
              <h3 className="zpr-note-title">{q.heading}</h3>
              <p className="zpr-section-sub">{q.meta}</p>
              <ul className="zpr-list">
                {q.lines.map((line, i) => (
                  <li key={`${q.key}-${i}`}>{line}</li>
                ))}
              </ul>
            </article>
          ))}
        </section>

        {v.actions ? (
          <section className="zpr-card zpr-section">
            <h2 className="zpr-section-title">{v.actions.heading}</h2>
            {v.actions.intro.map((p) => (
              <p key={p} className="zpr-section-sub">
                {p}
              </p>
            ))}
            {v.actions.actions.map((a) => (
              <article key={a.key} className="zpr-section">
                <h3 className="zpr-note-title">{a.heading}</h3>
                <ul className="zpr-list">
                  {a.fields.map((f) => (
                    <li key={`${a.key}-${f.label}`}>
                      <strong>{f.label}:</strong> {f.text}
                    </li>
                  ))}
                </ul>
                <p className="zpr-section-sub">{a.basedOnHeading}:</p>
                <ul className="zpr-list">
                  {a.basedOn.map((line, i) => (
                    <li key={`${a.key}-evidence-${i}`}>{line}</li>
                  ))}
                </ul>
                <p className="zpr-footnote">{a.reviewed}</p>
              </article>
            ))}
            {v.actions.notes.map((n) => (
              <p key={n} className="zpr-section-sub">
                {n}
              </p>
            ))}
          </section>
        ) : null}

        <section className="zpr-card zpr-section">
          <h2 className="zpr-section-title">{v.limitsHeading}</h2>
          <ul className="zpr-list">
            {v.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <h2 className="zpr-section-title">{v.methodHeading}</h2>
          <ul className="zpr-list zpr-footnote">
            {v.methodNotes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <p className="zpr-footnote">{v.evidenceLine}</p>
          <p className="zpr-footnote">
            <em>{v.causalLimit}</em>
          </p>
        </section>
      </div>
    </main>
  );
}

function Section({ section }: { section: PilotPresentationSection }) {
  return (
    <section className="zpr-card zpr-section">
      <h2 className="zpr-section-title">{section.heading}</h2>
      {section.paragraphs.map((p) => (
        <p key={p} className="zpr-section-sub">
          {p}
        </p>
      ))}
      {section.table ? (
        <div className="zpr-table-wrap">
          <table className="zpr-table">
            <thead>
              <tr>
                {section.table.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {section.table.rows.map((row, i) => (
                <tr key={`${section.key}-${i}`}>
                  {row.map((value, j) => (
                    <td key={`${section.key}-${i}-${j}`}>{value}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {section.notes.map((n) => (
        <p key={n} className="zpr-section-sub">
          {n}
        </p>
      ))}
    </section>
  );
}
