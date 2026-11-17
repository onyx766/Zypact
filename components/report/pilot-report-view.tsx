import { Calendar, ExternalLink, Info, Lock } from "lucide-react";

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
import { Brand } from "./protocol-report-view";

import "./protocol-report.css";

/**
 * D-055 — the customer's view of a combined pilot report. It renders the
 * stored payload as it is, in the same words as the Markdown
 * (render-pilot-report-markdown.ts), and re-derives nothing. Each engine is
 * its own section; an engine with no measurement says so in words and is
 * never shown as zero.
 */
export function PilotReportView({
  payload,
  revision,
  sharedAt,
  newerSharedRevision,
}: {
  payload: PilotReportPayload;
  revision: number;
  sharedAt: string;
  newerSharedRevision: boolean;
}) {
  const { subject, window } = payload;
  const live = payload.questions.filter((q) => !q.retired);
  const retired = payload.questions.length - live.length;

  return (
    <main className="zpr-root">
      <header className="zpr-header">
        <a href="/" aria-label="Zypact home">
          <Brand />
        </a>
        <span className="zpr-private">
          <Lock size={14} strokeWidth={2} />
          Private report
        </span>
      </header>

      <section className="zpr-hero">
        <div className="zpr-hero-inner">
          <p className="zpr-eyebrow">{PILOT_REPORT_TITLE}</p>
          <h1 className="zpr-title">How AI answer engines answered {live.length} buyer questions about {subject.companyName}</h1>
          <a className="zpr-site" href={subject.websiteUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={15} strokeWidth={2} />
            {subject.websiteUrl}
          </a>
          <p className="zpr-hero-copy">
            Each question was asked several times on each engine during the pilot. Every figure belongs to one
            question on one engine. Results show what these engines answered during the pilot; they don&apos;t
            represent every AI tool or every buyer.
          </p>
          <div className="zpr-chips">
            <span className="zpr-chip">
              <Calendar size={14} strokeWidth={1.9} />
              Pilot {window.startsOn} to {window.endsOn}
            </span>
            <span className="zpr-chip">
              <Info size={14} strokeWidth={1.9} />
              Revision {revision}, built {payload.generatedAt.slice(0, 10)}, shared {sharedAt.slice(0, 10)}
            </span>
            <span className="zpr-chip">
              {live.length} question{live.length === 1 ? "" : "s"}
              {retired > 0 ? ` (and ${retired} retired)` : ""}
            </span>
          </div>
          {newerSharedRevision ? (
            <p className="zpr-hero-copy">
              <strong>A newer revision of this report has been shared with you.</strong> This page shows an earlier one.
            </p>
          ) : null}
        </div>
      </section>

      <div className="zpr-shell">
        <section className="zpr-card zpr-section">
          <h2 className="zpr-section-title">Engines</h2>
          <ul className="zpr-list">
            {payload.engines.map((e) => (
              <li key={e.engine}>
                <strong>{e.label}:</strong> {e.note}
              </li>
            ))}
          </ul>
        </section>

        {payload.brand.map((section) => (
          <section key={`brand-${section.engine}`} className="zpr-card zpr-section">
            <h2 className="zpr-section-title">
              {engineLabel(section.engine)}: was {subject.companyName} named?
            </h2>
            <div className="zpr-table-wrap">
              <table className="zpr-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Status</th>
                    <th>Named in</th>
                    <th>Likely range</th>
                    <th>Attempts</th>
                    <th>Reading</th>
                  </tr>
                </thead>
                <tbody>
                  {section.rows.map((r) => (
                    <tr key={r.pilotQuestionId}>
                      <td>{r.ordinal}</td>
                      <td>{r.retired ? "Retired" : STATE_WORDS[r.state]}</td>
                      <td>
                        {r.numerator} of {r.denominator} readable answers
                      </td>
                      <td>{rangeWords(r.intervalLow, r.intervalHigh)}</td>
                      <td>
                        {r.attempted} attempted of {r.planned} planned, {r.failed} failed, {r.excluded} without a readable
                        result
                      </td>
                      <td>{LABEL_WORDS[r.label]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {section.portfolio ? (
              <p className="zpr-section-sub">
                <strong>
                  Total across {section.portfolio.includedOrdinals.length} finished question
                  {section.portfolio.includedOrdinals.length === 1 ? "" : "s"}:
                </strong>{" "}
                named in {section.portfolio.numerator} of {section.portfolio.denominator} readable answers.{" "}
                {PORTFOLIO_WEIGHTING_WORDS} {section.portfolio.heterogeneity}
                {section.portfolio.leftOutOrdinals.length > 0
                  ? ` Left out of the total: question${section.portfolio.leftOutOrdinals.length === 1 ? "" : "s"} ${section.portfolio.leftOutOrdinals.join(", ")}.`
                  : ""}
              </p>
            ) : null}
          </section>
        ))}

        {payload.competitors.map((section) => (
          <section key={`comp-${section.engine}`} className="zpr-card zpr-section">
            <h2 className="zpr-section-title">{engineLabel(section.engine)}: other brands named, across questions</h2>
            <p className="zpr-section-sub">
              These are totals across different questions, not a result for any one question.
            </p>
            {section.rows.length === 0 ? (
              <p>No other brand was named in a readable answer.</p>
            ) : (
              <div className="zpr-table-wrap">
                <table className="zpr-table">
                  <thead>
                    <tr>
                      <th>Brand</th>
                      <th>Questions</th>
                      <th>Where (answers naming it, of readable answers)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {section.rows.map((r) => (
                      <tr key={r.name}>
                        <td>{r.name}</td>
                        <td>{r.appearances.length}</td>
                        <td>{r.appearances.map((a) => `Q${a.ordinal}: ${a.runs} of ${a.readableRuns}`).join("; ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {section.rowsNotShown > 0 ? (
              <p className="zpr-section-sub">{section.rowsNotShown} further name(s) are in the question sections below.</p>
            ) : null}
          </section>
        ))}

        {payload.sources.map((section) => (
          <section key={`src-${section.engine}`} className="zpr-card zpr-section">
            <h2 className="zpr-section-title">{engineLabel(section.engine)}: types of source cited, by question</h2>
            {section.rows.length === 0 ? (
              <p>No readable answer had a usable source list.</p>
            ) : (
              <div className="zpr-table-wrap">
                <table className="zpr-table">
                  <thead>
                    <tr>
                      <th>Source type</th>
                      <th>Cited in (answers per question)</th>
                      <th>Returned but not cited</th>
                    </tr>
                  </thead>
                  <tbody>
                    {section.rows.map((r) => (
                      <tr key={r.category}>
                        <td>{SOURCE_CATEGORY_LABEL[r.category]}</td>
                        <td>
                          {r.cells.filter((c) => c.citedInRuns > 0).map((c) => `Q${c.ordinal}: ${c.citedInRuns}`).join("; ") ||
                            "none"}
                        </td>
                        <td>
                          {r.cells
                            .filter((c) => c.retrievedOnlyInRuns > 0)
                            .map((c) => `Q${c.ordinal}: ${c.retrievedOnlyInRuns}`)
                            .join("; ") || "none"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ))}

        <section className="zpr-card zpr-section">
          <h2 className="zpr-section-title">The questions</h2>
          {payload.questions.map((q) => (
            <article key={q.pilotQuestionId} className="zpr-section">
              <h3 className="zpr-note-title">
                {q.ordinal}. {q.text}
              </h3>
              <p className="zpr-section-sub">
                {pilotProvenanceLabel(q.provenance)}. Approved by you on {q.customerApprovedOn}.
                {q.retired ? ` ${RETIRED_WORDS}` : ""}
              </p>
              <ul className="zpr-list">
                {q.measurements.map((m) => (
                  <li key={m.protocolId}>
                    <strong>{engineLabel(m.engine)}</strong> ({STATE_WORDS[m.state]}): named in {m.report.observation.numerator}{" "}
                    of {m.report.observation.denominator} readable answers; likely range{" "}
                    {rangeWords(m.report.observation.interval?.low ?? null, m.report.observation.interval?.high ?? null)}.{" "}
                    {m.report.reconciliation.attempted} attempted, {m.report.reconciliation.failed} failed.
                    {m.report.competitorsObserved.length > 0
                      ? ` Other brands named: ${m.report.competitorsObserved.map((c) => `${c.name} (${c.runsMentionedIn})`).join(", ")}.`
                      : ""}
                  </li>
                ))}
                {payload.engines
                  .filter((e) => !q.measurements.some((m) => m.engine === e.engine))
                  .map((e) => (
                    <li key={e.engine}>
                      <strong>{e.label}</strong>: not measured for this question.
                    </li>
                  ))}
              </ul>
            </article>
          ))}
        </section>

        <section className="zpr-card zpr-section">
          <h2 className="zpr-section-title">Limits of this report</h2>
          <ul className="zpr-list">
            {payload.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <h2 className="zpr-section-title">How the figures were produced</h2>
          <ul className="zpr-list zpr-footnote">
            {payload.methodNotes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
