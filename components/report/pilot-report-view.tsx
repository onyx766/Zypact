import { Calendar, ExternalLink, Info, Lock } from "lucide-react";

import {
  PILOT_REPORT_TITLE,
  PREVIEW_BANNER_WORDS,
  PRIVATE_REPORT_WORDS,
  REPLACED_LINK_WORDS,
  revisionChipWords,
} from "@/lib/reports/pilot-report-copy";
import {
  presentPilotReport,
  type PilotPresentationSection,
} from "@/lib/reports/pilot-report-presentation";
import { NON_CAUSALITY_FOOTER } from "@/lib/reports/outcome-card-types";
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
 *
 * D-060: the customer's page renders it only for the newest shared revision
 * of a pilot; an earlier link shows PilotReportReplacedNotice instead, so no
 * page says that a newer revision exists.
 */
export function PilotReportView({
  payload,
  revision,
  sharedAt,
  preview = false,
}: {
  payload: PilotReportPayload;
  revision: number;
  sharedAt: string | null;
  preview?: boolean;
}) {
  const v = presentPilotReport(payload);

  // How each engine was measured: first on a revision built before the
  // summary, below the results (beside the limits and the method) after it.
  const measurement = (
    <>
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
    </>
  );

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
          {v.practiceNotice ? (
            <p className="zpr-hero-copy" role="note">
              <strong>{v.practiceNotice}</strong>
            </p>
          ) : null}
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
        </div>
      </section>

      <div className="zpr-shell">
        {v.summary ? (
          <section className="zpr-card zpr-section">
            <h2 className="zpr-section-title">{v.summary.heading}</h2>
            {v.summary.intro.map((p) => (
              <p key={p} className="zpr-section-sub">
                {p}
              </p>
            ))}
            {v.summary.blocks.map((b) => (
              <article key={b.title} className="zpr-section">
                <h3 className="zpr-note-title">{b.title}</h3>
                <ul className="zpr-list">
                  {b.lines.map((line, i) => (
                    <li key={`${b.title}-${i}`}>{line}</li>
                  ))}
                </ul>
              </article>
            ))}
            <article className="zpr-section">
              <h3 className="zpr-note-title">{v.summary.closerLookHeading}</h3>
              <p className="zpr-section-sub">{v.summary.closerLookIntro}</p>
              <ul className="zpr-list">
                {v.summary.closerLook.map((line, i) => (
                  <li key={`closer-${i}`}>{line}</li>
                ))}
              </ul>
            </article>
          </section>
        ) : null}

        {v.layout === "classic" ? measurement : null}

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

        {v.retests ? (
          <section className="zpr-card zpr-section">
            <h2 className="zpr-section-title">{v.retests.heading}</h2>
            {v.retests.intro.map((p) => (
              <p key={p} className="zpr-section-sub">
                {p}
              </p>
            ))}
            {v.retests.groups.map((g) => (
              <article key={g.key} className="zpr-section">
                <h3 className="zpr-note-title">{g.heading}</h3>
                <ul className="zpr-list">
                  {g.fields.map((f) => (
                    <li key={`${g.key}-${f.label}`}>
                      <strong>{f.label}:</strong> {f.text}
                    </li>
                  ))}
                </ul>
                <ul className="zpr-list">
                  {g.lines.map((line, i) => (
                    <li key={`${g.key}-line-${i}`}>{line}</li>
                  ))}
                </ul>
                <p className="zpr-section-sub">{g.notesHeading}:</p>
                <ul className="zpr-list">
                  {g.notes.map((n, i) => (
                    <li key={`${g.key}-note-${i}`}>{n}</li>
                  ))}
                </ul>
                <div className="zpr-table-wrap">
                  <table className="zpr-table">
                    <thead>
                      <tr>
                        {g.members.columns.map((c) => (
                          <th key={c}>{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {g.members.rows.map((row, i) => (
                        <tr key={`${g.key}-member-${i}`}>
                          {row.map((value, j) => (
                            <td key={`${g.key}-member-${i}-${j}`}>{value}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {g.cards.map((c) => (
                  <article key={c.key} className="zpr-section">
                    <h3 className="zpr-note-title">{c.heading}</h3>
                    {c.blocks.map((b, i) => (
                      <div key={`${c.key}-block-${i}`}>
                        {b.title ? <p className="zpr-section-sub">{b.title}:</p> : null}
                        <ul className="zpr-list">
                          {b.lines.map((line, j) => (
                            <li key={`${c.key}-block-${i}-${j}`}>{line}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                    {/* The footer from the constant, never from the payload. */}
                    <p className="zpr-footnote">
                      <em>{NON_CAUSALITY_FOOTER}</em>
                    </p>
                  </article>
                ))}
              </article>
            ))}
            {v.retests.withdrawn.map((w) => (
              <p key={w} className="zpr-section-sub">
                {w}
              </p>
            ))}
          </section>
        ) : null}

        {v.layout === "summary_first" ? measurement : null}

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

/**
 * D-060 — what an earlier link shows once a later revision of the same report
 * has been shared (D-059 item 9). It takes no props on purpose: no report
 * content, revision, date or token can reach it, and it gives no pointer to
 * the newer link. The page around it is noindex.
 */
export function PilotReportReplacedNotice() {
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

      <section className="zpr-hero">
        <div className="zpr-hero-inner">
          <h1 className="zpr-title">{PILOT_REPORT_TITLE}</h1>
          <p className="zpr-hero-copy" role="status">
            {REPLACED_LINK_WORDS}
          </p>
        </div>
      </section>
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
