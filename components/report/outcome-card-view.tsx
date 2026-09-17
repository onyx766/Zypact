import {
  BookOpen,
  Calendar,
  ExternalLink,
  FileText,
  Info,
  Lock,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Minus,
  CircleHelp,
} from "lucide-react";

import type { OutcomeCardPayload } from "@/lib/reports/outcome-card-types";
import { NON_CAUSALITY_FOOTER } from "@/lib/reports/outcome-card-types";
import { Brand, NoteCard, percent } from "./protocol-report-view";
import { CopyHashButton } from "./copy-hash-button";

import "./protocol-report.css";

/**
 * Client view for the canonical Outcome Card. Same discipline as
 * ProtocolReportView: renders the stored payload directly, no parsing, no
 * re-derivation.
 *
 * The permanent non-causality footer (D-006) is written here as a LITERAL
 * string, exactly as render-outcome-card-markdown.ts already does — not
 * interpolated from `payload.nonCausalityFooter`. Belt and suspenders for
 * the one sentence this product cannot ship without: even a payload that
 * arrived corrupted, or a future refactor that dropped the field from the
 * type, still gets the footer from this file.
 */

const STATUS_COPY: Record<
  OutcomeCardPayload["comparison"]["status"],
  { label: string; tone: "green" | "red" | "amber" | "neutral"; icon: typeof TrendingUp }
> = {
  increase_observed: { label: "Increase observed", tone: "green", icon: TrendingUp },
  decrease_observed: { label: "Decrease observed", tone: "red", icon: TrendingDown },
  no_clear_change: { label: "No clear change", tone: "neutral", icon: Minus },
  inconclusive: { label: "Inconclusive", tone: "amber", icon: CircleHelp },
};

function signedPercent(value: number): string {
  const pct = Math.round(value * 100);
  return pct > 0 ? `+${pct}%` : `${pct}%`;
}

function PhaseCard({
  label,
  numerator,
  denominator,
  plannedRuns,
  interval,
}: {
  label: string;
  numerator: number;
  denominator: number;
  plannedRuns: number;
  interval: { low: number; high: number } | null;
}) {
  const rateLabel = denominator > 0 ? percent(numerator / denominator) : "Not measured";
  return (
    <article className="zpr-card zpr-phase-card">
      <p className="zpr-phase-title">{label}</p>
      <p className="zpr-metric-value">{rateLabel}</p>
      <p className="zpr-metric-hint">
        {numerator} of {denominator} readable run{denominator === 1 ? "" : "s"} · {plannedRuns} planned
      </p>
      {interval ? (
        <p className="zpr-metric-hint">
          95% Wilson interval: {percent(interval.low)}–{percent(interval.high)}
        </p>
      ) : null}
    </article>
  );
}

export function OutcomeCardView({ payload }: { payload: OutcomeCardPayload }) {
  const { subject, question, baseline, retest, intervention, comparison } = payload;
  const status = STATUS_COPY[comparison.status];
  const StatusIcon = status.icon;
  const generatedLabel = payload.generatedAt.slice(0, 10);

  return (
    <main className="zpr-root">
      <header className="zpr-header">
        <a href="/" aria-label="Zypact home">
          <Brand />
        </a>
        <span className="zpr-private">
          <Lock size={14} strokeWidth={2} />
          Private Outcome Card
        </span>
      </header>

      <section className="zpr-hero">
        <div className="zpr-hero-inner">
          <p className="zpr-eyebrow">Registered retest — Outcome Card</p>

          <h1 className="zpr-title">
            The registered retest for {subject.companyName}
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
            A baseline was recorded, an intervention was registered and
            implemented, and the same question was retested after an
            observation window. This card shows both phases, the observed
            change, and its uncertainty — <strong>not</strong> a causal
            claim.
          </p>

          <div className="zpr-chips">
            <span className="zpr-chip">
              <Calendar size={14} strokeWidth={1.9} />
              Generated {generatedLabel}
            </span>
            <span className="zpr-chip">
              <Info size={14} strokeWidth={1.9} />
              Same question, both phases — version {question.versionNumber}
            </span>
          </div>
        </div>
      </section>

      <div className="zpr-shell">
        <section className="zpr-card zpr-question">
          <div>
            <p className="zpr-label">The registered question</p>
            <p className="zpr-question-text">{question.text}</p>
            <p className="zpr-question-sub">
              The SAME question and version on both the baseline and the
              retest. Intent {question.intentType}, provenance{" "}
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

        <section className="zpr-card">
          <p className="zpr-label">The registered intervention</p>
          <p className="zpr-question-text" style={{ marginTop: 8 }}>
            {intervention.hypothesis}
          </p>
          <p className="zpr-question-sub">
            <strong>Expected mechanism:</strong> {intervention.expectedMechanism}
          </p>
          <p className="zpr-question-sub">
            <strong>Action:</strong> {intervention.actionType} — {intervention.actionTarget}
          </p>
          <p className="zpr-question-sub">
            <strong>Owner:</strong> {intervention.owner}
          </p>
          {intervention.observationWindowOpensAt && intervention.observationWindowClosesAt ? (
            <p className="zpr-question-sub">
              <strong>Observation window:</strong>{" "}
              {intervention.observationWindowOpensAt.slice(0, 10)} →{" "}
              {intervention.observationWindowClosesAt.slice(0, 10)}
            </p>
          ) : null}
          {intervention.earlyRetestReason ? (
            <p className="zpr-deviation-note">
              This retest ran before the observation window closed, under a
              recorded authorised deviation: {intervention.earlyRetestReason}
            </p>
          ) : null}
        </section>

        <section>
          <p className="zpr-label">What each phase observed</p>
          <div className="zpr-phase-row">
            <PhaseCard
              label="Baseline"
              numerator={baseline.numerator}
              denominator={baseline.denominator}
              plannedRuns={baseline.plannedRuns}
              interval={baseline.interval}
            />
            <PhaseCard
              label="Retest"
              numerator={retest.numerator}
              denominator={retest.denominator}
              plannedRuns={retest.plannedRuns}
              interval={retest.interval}
            />
          </div>
        </section>

        <section className="zpr-card" style={{ marginTop: 16 }}>
          <p className="zpr-label">Outcome</p>
          <div className={`zpr-outcome-badge tone-${status.tone}`} style={{ marginTop: 10 }}>
            <StatusIcon size={17} strokeWidth={2.2} />
            {status.label}
          </div>

          <div style={{ marginTop: 16, display: "grid", gap: 6 }}>
            {comparison.delta !== null ? (
              <p className="zpr-metric-hint">
                Observed change: {signedPercent(comparison.delta)} (retest minus baseline)
              </p>
            ) : null}
            {comparison.interval ? (
              <p className="zpr-metric-hint">
                95% interval on the difference (Newcombe): {signedPercent(comparison.interval.low)} to{" "}
                {signedPercent(comparison.interval.high)}
              </p>
            ) : null}
            <p className="zpr-metric-hint">
              Minimum useful change (Δ_min), declared before this retest ran:{" "}
              {percent(comparison.minimumUsefulChange)}
            </p>
            {comparison.smallestDetectableChange !== null ? (
              <p className="zpr-metric-hint">
                Smallest change this sample could have separated from zero:{" "}
                {percent(comparison.smallestDetectableChange)}
              </p>
            ) : null}
          </div>
        </section>

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
            title="Comparison method"
            items={[
              `Newcombe's hybrid-score 95% interval, built from a Wilson interval on each phase.`,
              `Every reason recorded with this comparison: ${
                comparison.reasons.length > 0 ? comparison.reasons.join("; ") : "none."
              }`,
            ]}
          />
        </div>

        {/* Literal text, not payload.nonCausalityFooter — see the file header. */}
        <p className="zpr-permanent-footer">{NON_CAUSALITY_FOOTER}</p>
      </div>

      <footer className="zpr-footer">
        <Brand />
        <span>Prepared privately for {subject.companyName} by Zypact.</span>
      </footer>
    </main>
  );
}
