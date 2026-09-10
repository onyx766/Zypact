import { ZypactLogo } from "@/components/zypact-logo";
import type {
  ProtocolReportPayload,
} from "@/lib/reports/protocol-report-types";

/**
 * Client view for the canonical V1 protocol report.
 *
 * Renders the stored payload directly. There is no parsing step and no
 * re-derivation: what a client reads here is exactly what was written when
 * the report was generated, which is what makes a delivered number auditable
 * against the evidence hashes shown beside it.
 *
 * Nothing here states a verdict, a universal score, or a cause. The observed
 * rate never appears without its interval, and the attempt reconciliation is
 * part of the page rather than a footnote, because a rate whose denominator
 * is hidden is the failure mode this report exists to avoid.
 */

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <article className="report-metric-card">
      <p>{label}</p>
      <strong>{value}</strong>
      {hint ? (
        <p style={{ marginTop: "0.4rem", opacity: 0.75 }}>
          {hint}
        </p>
      ) : null}
    </article>
  );
}

function presenceLabel(value: boolean | null): string {
  if (value === null) return "No readable result";
  return value ? "Present" : "Not present";
}

export function ProtocolReportView({
  payload,
}: {
  payload: ProtocolReportPayload;
}) {
  const {
    subject,
    question,
    protocol,
    observation,
    reconciliation,
  } = payload;

  const rateLabel =
    observation.rate === null
      ? "Not measured"
      : percent(observation.rate);

  const intervalLabel = observation.interval
    ? `${percent(observation.interval.low)} – ${percent(
        observation.interval.high
      )}`
    : "Not available";

  const generatedLabel = payload.generatedAt.slice(0, 10);

  return (
    <main className="report-page">
      <header className="report-header">
        <ZypactLogo priority />
        <span className="report-private-label">
          Private snapshot
        </span>
      </header>

      <section className="report-hero">
        <p className="report-eyebrow">
          AI answer snapshot
        </p>

        <h1>
          How one AI surface answered a buyer question
          about {subject.companyName}
        </h1>

        <p className="report-domain">{subject.websiteUrl}</p>

        <p className="report-hero-copy">
          This records what {protocol.provider} returned when
          asked the question below, {reconciliation.attempted}{" "}
          time{reconciliation.attempted === 1 ? "" : "s"}. It is
          a directional reading of one surface, not a measure of
          how all AI assistants describe you.
        </p>

        <div className="report-meta">
          <span>Generated {generatedLabel}</span>
          <span>
            Surface: {protocol.provider} ({protocol.surface}),
            model {protocol.model}
          </span>
          <span>
            Methodology v{protocol.methodologyVersion}
          </span>
        </div>
      </section>

      <section className="report-section">
        <h2>The question we asked</h2>

        <blockquote
          style={{
            margin: "0 0 1rem",
            paddingLeft: "1rem",
            borderLeft: "3px solid currentColor",
            whiteSpace: "pre-wrap",
          }}
        >
          {question.text}
        </blockquote>

        <p>
          Every figure on this page describes this question and
          nothing else. Version {question.versionNumber}, intent{" "}
          {question.intentType}, provenance {question.provenance}.
        </p>

        <p style={{ fontFamily: "monospace", fontSize: "0.8rem", opacity: 0.75 }}>
          Prompt hash: {question.hash}
        </p>
      </section>

      <section className="report-metrics">
        <MetricCard
          label="Times your brand appeared"
          value={
            observation.denominator === 0
              ? "No readable runs"
              : `${observation.numerator} of ${observation.denominator}`
          }
        />
        <MetricCard
          label={observation.metric.replace(/_/g, " ")}
          value={rateLabel}
        />
        <MetricCard
          label="95% interval"
          value={intervalLabel}
          hint="Wilson, from this sample"
        />
        <MetricCard
          label="Runs planned"
          value={String(reconciliation.planned)}
        />
      </section>

      <section className="report-section">
        <h2>Run by run</h2>

        <div className="report-table-wrap">
          <table className="report-table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Status</th>
                <th>Your brand</th>
                <th>Other brands named</th>
                <th>Sources</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {payload.runs.map((run, index) => (
                <tr key={`${run.ordinal}-${index}`}>
                  <td>
                    {run.ordinal}
                    {run.retryOfOrdinal !== null
                      ? ` (retry of ${run.retryOfOrdinal})`
                      : ""}
                  </td>
                  <td>
                    {run.status}
                    {run.terminationReason
                      ? ` — ${run.terminationReason}`
                      : ""}
                  </td>
                  <td>{presenceLabel(run.brandPresent)}</td>
                  <td>
                    {run.competitors.length > 0
                      ? run.competitors.join(", ")
                      : "None"}
                  </td>
                  <td>{run.citedSourceCount}</td>
                  <td
                    style={{
                      fontFamily: "monospace",
                      fontSize: "0.75rem",
                    }}
                  >
                    {run.evidenceHash
                      ? `${run.evidenceHash.slice(0, 12)}…`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="report-note">
          <strong>Every attempt is accounted for.</strong>
          <p>
            {reconciliation.attempted} attempted ·{" "}
            {reconciliation.completed} completed ·{" "}
            {reconciliation.failed} failed ·{" "}
            {reconciliation.excludedByReview} excluded after
            review · {reconciliation.retried} retried ·{" "}
            {reconciliation.excludedNoResult} completed without a
            readable result.
            {reconciliation.accountedFor
              ? ""
              : " These counts do not reconcile and this report requires review."}
          </p>
        </div>
      </section>

      {payload.competitorsObserved.length > 0 ? (
        <section className="report-section">
          <h2>Other brands named in these answers</h2>

          <ul>
            {payload.competitorsObserved.map((competitor) => (
              <li key={competitor.name}>
                {competitor.name} — named in{" "}
                {competitor.runsMentionedIn} of{" "}
                {observation.denominator} readable run
                {observation.denominator === 1 ? "" : "s"}
              </li>
            ))}
          </ul>

          <p>
            These are brands the surface mentioned while answering
            this question. That they appear is not evidence that
            they displaced you or won a sale.
          </p>
        </section>
      ) : null}

      <section className="report-section">
        <h2>How certain this is</h2>
        <ul>
          {payload.uncertainty.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </section>

      <section className="report-section">
        <h2>What this does not tell you</h2>
        <ul>
          {payload.limitations.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </section>

      <section className="report-section">
        <h2>Integrity notes</h2>
        <ul>
          {payload.integrityNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
