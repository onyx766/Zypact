import type { ReactNode } from "react";
import {
  Activity,
  BookOpen,
  Box,
  Calendar,
  ChartNoAxesColumn,
  ExternalLink,
  Eye,
  FileText,
  Globe,
  Info,
  List,
  Lock,
  MessageSquareText,
  Search,
  ShieldCheck,
  TriangleAlert,
  Users,
} from "lucide-react";

import type {
  ProtocolReportPayload,
  ProtocolReportRun,
  ProtocolReportSourceInsights,
} from "@/lib/reports/protocol-report-types";
import { SOURCE_CATEGORY_LABEL } from "@/lib/source-insights/source-types";
import { CopyHashButton } from "./copy-hash-button";

import "./protocol-report.css";

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
 *
 * Every hint line under a metric is derived from the payload. None of them
 * adds a claim the payload does not already support.
 */

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function sentenceCase(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function presence(value: boolean | null): {
  label: string;
  tone: "green" | "muted";
} {
  if (value === null) return { label: "No readable result", tone: "muted" };
  return value
    ? { label: "Present", tone: "green" }
    : { label: "Not present", tone: "muted" };
}

function statusTone(status: string): "green" | "red" | "amber" | "neutral" {
  if (/fail|error/i.test(status)) return "red";
  if (/exclud/i.test(status)) return "amber";
  if (/complet|success/i.test(status)) return "green";
  return "neutral";
}

/** The Zypact Z mark from public/zypact-logo.svg, recoloured for a dark ground. */
export function Brand() {
  return (
    <span className="zpr-brand">
      <svg viewBox="30 36 128 128" aria-hidden="true">
        <g
          fill="none"
          stroke="#2dd4bf"
          strokeWidth="11"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M42 48 H142 L46 150 H146" />
          <circle cx="42" cy="48" r="12" fill="#081015" />
          <circle cx="94" cy="100" r="12" fill="#081015" />
          <circle cx="146" cy="150" r="12" fill="#081015" />
        </g>
      </svg>
      Zypact
    </span>
  );
}

export function MetricCard({
  icon,
  label,
  value,
  hint,
  lead = false,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  hint: string;
  lead?: boolean;
}) {
  return (
    <article className={`zpr-card zpr-metric${lead ? " is-lead" : ""}`}>
      {icon}
      <div>
        <p className="zpr-label">{label}</p>
        <p className="zpr-metric-value">{value}</p>
        <p className="zpr-metric-hint">{hint}</p>
      </div>
    </article>
  );
}

export function NoteCard({
  icon,
  title,
  items,
  tone,
}: {
  icon: ReactNode;
  title: string;
  items: string[];
  tone?: "purple" | "blue";
}) {
  return (
    <section className="zpr-card zpr-note">
      {icon}
      <div>
        <h3 className="zpr-note-title">{title}</h3>
        <ul className={`zpr-list${tone ? ` tone-${tone}` : ""}`}>
          {items.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function sourcesLabel(
  insights: ProtocolReportSourceInsights | undefined,
  run: ProtocolReportRun
): string {
  if (!insights) return String(run.citedSourceCount);
  const entry = insights.runs.find((r) => r.ordinal === run.ordinal);
  if (!entry) return "—";
  if (entry.status !== "ok") return "Unavailable";
  return `${entry.cited.length} cited · ${entry.retrievedOnly.length} retrieved`;
}

function SourcesSection({
  insights,
}: {
  insights: ProtocolReportSourceInsights;
}) {
  const n = insights.runsWithSourceEvidence;

  return (
    <section className="zpr-card zpr-section">
      <div className="zpr-section-head">
        <Globe size={22} strokeWidth={1.9} />
        <div>
          <h2 className="zpr-section-title">Sources the answers cited</h2>
          <p className="zpr-section-sub">
            {n === 0
              ? `None of the ${insights.readableRuns} readable runs had a usable stored source list, so no sources are shown. This is an empty result, not evidence that nothing was cited.`
              : `Your site was cited in ${insights.runsWithOwnedCitation} of ${n} run${
                  n === 1 ? "" : "s"
                } with a usable source list. Read from the provider's stored response for each run.`}
          </p>
        </div>
      </div>

      {n > 0 && insights.domains.length > 0 ? (
        <div className="zpr-table-wrap">
          <table className="zpr-table">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Type</th>
                <th>Cited in</th>
                <th>Retrieved only in</th>
                <th>Cited in runs</th>
              </tr>
            </thead>
            <tbody>
              {insights.domains.map((d) => (
                <tr key={d.domain}>
                  <td>
                    {d.domain}
                    {d.urls.length > 0 ? (
                      <span className="zpr-cell-sub">
                        {d.urls.length} page{d.urls.length === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </td>
                  <td>{SOURCE_CATEGORY_LABEL[d.category]}</td>
                  <td>
                    {d.citedInRuns} of {n}
                  </td>
                  <td>
                    {d.retrievedOnlyInRuns} of {n}
                  </td>
                  <td>
                    {d.citedRunOrdinals.length > 0
                      ? d.citedRunOrdinals.join(", ")
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <ul className="zpr-list zpr-footnote">
        {insights.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </section>
  );
}

function RunRow({
  run,
  insights,
}: {
  run: ProtocolReportRun;
  insights: ProtocolReportSourceInsights | undefined;
}) {
  const brand = presence(run.brandPresent);

  return (
    <tr>
      <td>
        {run.ordinal}
        {run.retryOfOrdinal !== null ? (
          <span className="zpr-cell-sub">
            retry of {run.retryOfOrdinal}
          </span>
        ) : null}
      </td>
      <td>
        <span className="zpr-status">
          <span className={`zpr-dot tone-${statusTone(run.status)}`} />
          <span>
            {sentenceCase(run.status)}
            {run.terminationReason ? (
              <span className="zpr-cell-sub">{run.terminationReason}</span>
            ) : null}
          </span>
        </span>
      </td>
      <td>
        <span className={`zpr-presence tone-${brand.tone}`}>
          {brand.label}
        </span>
      </td>
      <td>
        {run.competitors.length > 0 ? run.competitors.join(", ") : "None"}
      </td>
      <td>{sourcesLabel(insights, run)}</td>
      <td
        className="zpr-mono"
        style={{ fontSize: 12 }}
        title={run.evidenceHash ?? undefined}
      >
        {run.evidenceHash ? `${run.evidenceHash.slice(0, 12)}…` : "—"}
      </td>
    </tr>
  );
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

  const readableRuns = `${observation.denominator} readable run${
    observation.denominator === 1 ? "" : "s"
  }`;

  return (
    <main className="zpr-root">
      <header className="zpr-header">
        <a href="/" aria-label="Zypact home">
          <Brand />
        </a>
        <span className="zpr-private">
          <Lock size={14} strokeWidth={2} />
          Private snapshot
        </span>
      </header>

      <section className="zpr-hero">
        <div className="zpr-hero-art" aria-hidden="true">
          <span className="zpr-art-search">
            <Search size={16} strokeWidth={2.2} />
          </span>
          <div className="zpr-art-bubble">
            <span>{question.text}</span>
          </div>
          <span className="zpr-art-tile">
            {subject.companyName.trim().charAt(0) || "?"}
          </span>
        </div>

        <div className="zpr-hero-inner">
          <p className="zpr-eyebrow">AI answer snapshot</p>

          <h1 className="zpr-title">
            How one AI surface answered a buyer question about{" "}
            {subject.companyName}
          </h1>

          <a
            className="zpr-site"
            href={subject.websiteUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={15} strokeWidth={2} />
            {subject.websiteUrl}
          </a>

          <p className="zpr-hero-copy">
            This records what {protocol.provider} returned when asked the
            question below, {reconciliation.attempted} time
            {reconciliation.attempted === 1 ? "" : "s"}. It is a directional
            reading of one surface, <strong>not</strong> a measure of how all
            AI assistants describe you.
          </p>

          <div className="zpr-chips">
            <span className="zpr-chip">
              <Calendar size={14} strokeWidth={1.9} />
              Generated {generatedLabel}
            </span>
            <span className="zpr-chip">
              Surface: {protocol.provider} ({protocol.surface}), model{" "}
              {protocol.model}
            </span>
            <span className="zpr-chip">
              <Info size={14} strokeWidth={1.9} />
              Methodology v{protocol.methodologyVersion}
            </span>
          </div>
        </div>
      </section>

      <div className="zpr-shell">
        <section className="zpr-card zpr-question">
          <span className="zpr-icon">
            <MessageSquareText size={22} strokeWidth={1.9} />
          </span>

          <div>
            <p className="zpr-label">The question we asked</p>
            <p className="zpr-question-text">{question.text}</p>
            <p className="zpr-question-sub">
              Every figure on this page describes this question and nothing
              else. Version {question.versionNumber}, intent{" "}
              {question.intentType}, provenance{" "}
              <strong>{question.provenance}</strong>.
            </p>
          </div>

          <div className="zpr-hash">
            <p className="zpr-label">Prompt hash</p>
            <div className="zpr-hash-row">
              <span className="zpr-hash-value">{question.hash}</span>
              <CopyHashButton value={question.hash} />
            </div>
          </div>
        </section>

        <section className="zpr-metrics">
          <MetricCard
            lead
            icon={
              <span className="zpr-icon is-round">
                <Eye size={22} strokeWidth={1.9} />
              </span>
            }
            label="Times your brand appeared"
            value={
              observation.denominator === 0
                ? "No readable runs"
                : `${observation.numerator} of ${observation.denominator}`
            }
            hint="Readable runs that named your brand"
          />
          <MetricCard
            icon={
              <span className="zpr-icon is-round tone-blue">
                <ChartNoAxesColumn size={22} strokeWidth={2} />
              </span>
            }
            label={observation.metric.replace(/_/g, " ")}
            value={rateLabel}
            hint={
              observation.rate === null
                ? "No readable runs to rate"
                : `From ${observation.numerator} of ${readableRuns}`
            }
          />
          <MetricCard
            icon={
              <span className="zpr-icon is-round tone-purple">
                <Activity size={22} strokeWidth={1.9} />
              </span>
            }
            label="95% interval"
            value={intervalLabel}
            hint="Wilson, from this sample"
          />
          <MetricCard
            icon={
              <span className="zpr-icon is-round tone-indigo">
                <Box size={22} strokeWidth={1.9} />
              </span>
            }
            label="Runs planned"
            value={String(reconciliation.planned)}
            hint={`${reconciliation.completed} completed · ${
              reconciliation.excludedByReview + reconciliation.excludedNoResult
            } excluded · ${observation.denominator} readable`}
          />
        </section>

        <section className="zpr-card zpr-section">
          <div className="zpr-section-head">
            <List size={22} strokeWidth={1.9} />
            <div>
              <h2 className="zpr-section-title">Run by run</h2>
              <p className="zpr-section-sub">
                Each run shows whether your brand was mentioned, which other
                brands were named, and the hash of the stored provider
                response.
              </p>
            </div>
          </div>

          <div className="zpr-table-wrap">
            <table className="zpr-table">
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
                {payload.runs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="zpr-empty-row">
                      No runs recorded.
                    </td>
                  </tr>
                ) : (
                  payload.runs.map((run, index) => (
                    <RunRow
                      key={`${run.ordinal}-${index}`}
                      run={run}
                      insights={payload.sourceInsights}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div
            className={`zpr-recon${
              reconciliation.accountedFor ? "" : " is-alert"
            }`}
          >
            <span className="zpr-recon-icon">
              {reconciliation.accountedFor ? (
                <Info size={16} strokeWidth={2.4} />
              ) : (
                <TriangleAlert size={15} strokeWidth={2.4} />
              )}
            </span>
            <div>
              <p className="zpr-recon-title">
                Every attempt is accounted for.
              </p>
              <p className="zpr-recon-body">
                {reconciliation.planned} planned ·{" "}
                {reconciliation.attempted} attempted ·{" "}
                {reconciliation.completed} completed ·{" "}
                {reconciliation.failed} failed ·{" "}
                {reconciliation.excludedByReview} excluded after review ·{" "}
                {reconciliation.retried} retried ·{" "}
                {reconciliation.excludedNoResult} completed without a
                readable result · {readableRuns} counted in the rate.
                {reconciliation.accountedFor ? null : (
                  <strong className="zpr-recon-warning">
                    {" "}
                    These counts do not reconcile and this report requires
                    review.
                  </strong>
                )}
              </p>
            </div>
          </div>
        </section>

        {payload.competitorsObserved.length > 0 ? (
          <section className="zpr-card zpr-section">
            <div className="zpr-section-head">
              <Users size={22} strokeWidth={1.9} />
              <div>
                <h2 className="zpr-section-title">
                  Other brands named in these answers
                </h2>
              </div>
            </div>

            <ul className="zpr-competitors" style={{ padding: 0, listStyle: "none" }}>
              {payload.competitorsObserved.map((competitor) => (
                <li key={competitor.name} className="zpr-competitor">
                  <strong>{competitor.name}</strong>
                  <span>
                    named in {competitor.runsMentionedIn} of {readableRuns}
                  </span>
                </li>
              ))}
            </ul>

            <p className="zpr-footnote">
              These are brands the surface mentioned while answering this
              question. That they appear is not evidence that they displaced
              you or won a sale.
            </p>
          </section>
        ) : null}

        {payload.sourceInsights ? (
          <SourcesSection insights={payload.sourceInsights} />
        ) : null}

        <div className="zpr-notes">
          <NoteCard
            icon={
              <span className="zpr-icon">
                <ShieldCheck size={21} strokeWidth={1.9} />
              </span>
            }
            title="How certain this is"
            items={payload.uncertainty}
          />
          <NoteCard
            tone="purple"
            icon={
              <span className="zpr-icon tone-purple">
                <BookOpen size={21} strokeWidth={1.9} />
              </span>
            }
            title="What this does not tell you"
            items={payload.limitations}
          />
          <NoteCard
            tone="blue"
            icon={
              <span className="zpr-icon tone-blue">
                <FileText size={21} strokeWidth={1.9} />
              </span>
            }
            title="Integrity notes"
            items={payload.integrityNotes}
          />
        </div>
      </div>

      <footer className="zpr-footer">
        <Brand />
        <span>Prepared privately for {subject.companyName} by Zypact.</span>
      </footer>
    </main>
  );
}
