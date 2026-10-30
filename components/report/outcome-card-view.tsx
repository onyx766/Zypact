import {
  BarChart3,
  BookOpen,
  Calendar,
  CircleHelp,
  ClipboardCheck,
  ExternalLink,
  FileText,
  Hash,
  Info,
  Lock,
  MessageSquare,
  Scale,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type { OutcomeCardPayload, OutcomeCardPhase } from "@/lib/reports/outcome-card-types";
import { NON_CAUSALITY_FOOTER } from "@/lib/reports/outcome-card-types";
import { Brand, NoteCard, percent } from "./protocol-report-view";
import { CopyHashButton } from "./copy-hash-button";

import "./protocol-report.css";
import "./outcome-card.css";

/**
 * Client view for the canonical Outcome Card. Same discipline as
 * ProtocolReportView: renders the stored payload directly, no parsing, no
 * re-derivation.
 *
 * Every picture here is drawn from numbers the payload already states in
 * words beside it. The payload carries counts per phase, not per-run rows, so
 * the run markers are a count ("k of n"), deliberately unnumbered: numbering
 * them would present independent samples as an ordered series.
 *
 * The permanent non-causality footer (D-006) is written here as a LITERAL
 * string, exactly as render-outcome-card-markdown.ts already does — not
 * interpolated from `payload.nonCausalityFooter`. Belt and suspenders for
 * the one sentence this product cannot ship without: even a payload that
 * arrived corrupted, or a future refactor that dropped the field from the
 * type, still gets the footer from this file.
 */

type Tone = "green" | "red" | "amber" | "neutral";

/**
 * `reading` restates the comparison rule that produced the status and nothing
 * more. It must stay true for every input that can yield that status, which
 * is why none of these sentences mentions the intervention.
 */
const STATUS_COPY: Record<
  OutcomeCardPayload["comparison"]["status"],
  { label: string; tone: Tone; icon: LucideIcon; reading: string }
> = {
  increase_observed: {
    label: "Increase observed",
    tone: "green",
    icon: TrendingUp,
    reading:
      "The retest rate is above the baseline rate by at least the minimum useful change, and the interval on the difference stays above zero.",
  },
  decrease_observed: {
    label: "Decrease observed",
    tone: "red",
    icon: TrendingDown,
    reading:
      "The retest rate is below the baseline rate by at least the minimum useful change, and the interval on the difference stays below zero.",
  },
  no_clear_change: {
    label: "No clear change",
    tone: "neutral",
    icon: Scale,
    reading:
      "The interval on the difference stays within the minimum useful change in both directions, so a change of that size is ruled out for these runs.",
  },
  inconclusive: {
    label: "Inconclusive",
    tone: "amber",
    icon: CircleHelp,
    reading:
      "The evidence cannot support a direction. The recorded reasons are listed under the comparison method below.",
  },
};

function signedPercent(value: number): string {
  const pct = Math.round(value * 100);
  return pct > 0 ? `+${pct}%` : `${pct}%`;
}

/** `page_created` -> `Page created`. Stored codes stay stored; only the display changes. */
function sentenceCase(value: string): string {
  const spaced = value.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Normalised to UTC before formatting, so an offset timestamp is never mislabelled. */
function utcMinute(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const normalised = date.toISOString();
  return `${normalised.slice(0, 10)} ${normalised.slice(11, 16)} UTC`;
}

/** Position on a 0..1 track, as a CSS percentage. */
function at(value: number): string {
  return `${Math.min(100, Math.max(0, value * 100))}%`;
}

/** Position on a -1..+1 track, as a CSS percentage. */
function atSigned(value: number): string {
  return at((value + 1) / 2);
}

function SectionHead({
  step,
  icon: Icon,
  title,
  aside,
}: {
  step: number;
  icon: LucideIcon;
  title: string;
  aside?: ReactNode;
}) {
  return (
    <div className="zoc-head">
      <div className="zoc-head-main">
        <span className="zoc-head-icon" aria-hidden="true">
          <Icon size={18} strokeWidth={1.9} />
        </span>
        <h2 className="zoc-head-title">
          {step}. {title}
        </h2>
      </div>
      {aside}
    </div>
  );
}

function Fact({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={wide ? "zoc-fact is-wide" : "zoc-fact"}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * The attempts behind a phase's rate that did not produce a readable run.
 * A rate over readable runs is only honest next to what was left out
 * (METHODOLOGY section 8), so failed and excluded attempts are listed rather
 * than silently dropped from the denominator. Cards saved before this field
 * existed say so instead of implying that nothing failed.
 */
function AttemptAccounting({ phase }: { phase: OutcomeCardPhase }) {
  const r = phase.reconciliation;
  if (!r) {
    return (
      <p className="zoc-phase-attempts">
        Attempt accounting was not recorded on this card.
      </p>
    );
  }
  return (
    <p className="zoc-phase-attempts">
      {r.attempted} attempted of {r.planned} planned: {r.completed} completed
      {" · "}
      {r.failed} failed
      {" · "}
      {r.excludedByReview} excluded by review
      {" · "}
      {r.excludedNoResult} with no readable result
      {r.accountedFor ? "" : " · does not fully reconcile"}
    </p>
  );
}

function PhaseCard({
  label,
  tone,
  phase,
  companyName,
}: {
  label: string;
  tone: "baseline" | "retest";
  phase: OutcomeCardPhase;
  companyName: string;
}) {
  const { numerator, denominator, plannedRuns, interval } = phase;
  const measured = denominator > 0;
  const notNamed = Math.max(0, denominator - numerator);
  const notReadable = Math.max(0, plannedRuns - denominator);

  return (
    <article className={`zoc-phase tone-${tone}`}>
      <p className="zoc-phase-top">
        <span className="zoc-phase-key" aria-hidden="true" />
        {label}
      </p>

      <p className="zoc-rate">{measured ? percent(numerator / denominator) : "Not measured"}</p>
      <p className="zoc-phase-count">
        {numerator} of {denominator} readable run{denominator === 1 ? "" : "s"} named {companyName}
        {" · "}
        {plannedRuns} planned
      </p>

      {/* The sentence above is the accessible statement; the markers repeat it. */}
      <div className="zoc-dots" aria-hidden="true">
        {Array.from({ length: numerator }, (_, i) => (
          <span key={`named-${i}`} className="zoc-dot is-named" />
        ))}
        {Array.from({ length: notNamed }, (_, i) => (
          <span key={`absent-${i}`} className="zoc-dot is-absent" />
        ))}
        {Array.from({ length: notReadable }, (_, i) => (
          <span key={`unreadable-${i}`} className="zoc-dot is-unreadable" />
        ))}
      </div>

      <AttemptAccounting phase={phase} />

      {measured && interval ? (
        <>
          <div className="zoc-track" aria-hidden="true">
            <span
              className="zoc-range"
              style={{ left: at(interval.low), width: at(interval.high - interval.low) }}
            />
            <span className="zoc-point" style={{ left: at(numerator / denominator) }} />
          </div>
          <div className="zoc-scale" aria-hidden="true">
            <span>0%</span>
            <span>50%</span>
            <span>100%</span>
          </div>
          <p className="zoc-phase-interval">
            95% Wilson interval: {percent(interval.low)}–{percent(interval.high)}
          </p>
        </>
      ) : null}
    </article>
  );
}

export function OutcomeCardView({ payload }: { payload: OutcomeCardPayload }) {
  const { subject, question, baseline, retest, intervention, comparison } = payload;
  const status = STATUS_COPY[comparison.status];
  const StatusIcon = status.icon;
  const generatedLabel = payload.generatedAt.slice(0, 10);

  const frozenAt = utcMinute(intervention.approvedAt);
  const implementedAt = utcMinute(intervention.implementedAt);
  const windowOpens = utcMinute(intervention.observationWindowOpensAt);
  const windowCloses = utcMinute(intervention.observationWindowClosesAt);
  const hasDeviation = Boolean(intervention.protocolDeviations || intervention.earlyRetestReason);
  const anyUnreadable =
    baseline.plannedRuns > baseline.denominator || retest.plannedRuns > retest.denominator;

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
        <div className="zoc-sheet">
          {/* ------------------------------------------------ 1. Question */}
          <section className="zoc-section">
            <SectionHead step={1} icon={MessageSquare} title="Registered question" />

            <div className="zoc-question-grid">
              <div>
                <p className="zoc-question-text">{question.text}</p>
                <p className="zoc-sub">
                  The same question and version on both the baseline and the
                  retest. Intent: {sentenceCase(question.intentType).toLowerCase()}.
                  Provenance: {sentenceCase(question.provenance).toLowerCase()}.
                </p>
              </div>

              <div className="zoc-hash">
                <div className="zoc-hash-top">
                  <p className="zpr-label">
                    <Hash size={12} strokeWidth={2.2} aria-hidden="true" /> Prompt hash
                  </p>
                  <CopyHashButton value={question.hash} />
                </div>
                {/* The full value, never truncated: it is the identity both phases are checked against. */}
                <p className="zoc-hash-value">{question.hash}</p>
              </div>
            </div>
          </section>

          {/* -------------------------------------------- 2. Intervention */}
          <section className="zoc-section">
            <SectionHead step={2} icon={FileText} title="Registered intervention" />

            <p className="zoc-hypothesis">{intervention.hypothesis}</p>

            <dl className="zoc-facts">
              <Fact label="Expected mechanism" wide>
                {intervention.expectedMechanism}
              </Fact>
              <Fact label="Action" wide>
                {sentenceCase(intervention.actionType)} —{" "}
                <span className="zoc-target">{intervention.actionTarget}</span>
              </Fact>
              <Fact label="Owner">{intervention.owner}</Fact>
              {frozenAt ? <Fact label="Claim frozen">{frozenAt}</Fact> : null}
              {implementedAt ? <Fact label="Implemented">{implementedAt}</Fact> : null}
              {windowOpens && windowCloses ? (
                <Fact label="Observation window">
                  {windowOpens} → {windowCloses}
                </Fact>
              ) : null}
            </dl>

            {hasDeviation ? (
              <div className="zoc-callout" role="note">
                <TriangleAlert size={18} strokeWidth={2} aria-hidden="true" />
                <div>
                  <p className="zoc-callout-title">Recorded deviations</p>
                  {intervention.protocolDeviations ? (
                    <p className="zoc-callout-body">{intervention.protocolDeviations}</p>
                  ) : null}
                  {intervention.earlyRetestReason ? (
                    <p className="zoc-callout-body">
                      This retest ran before the observation window closed,
                      under a recorded authorised deviation:{" "}
                      {intervention.earlyRetestReason}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
          </section>

          {/* -------------------------------------------------- 3. Phases */}
          <section className="zoc-section">
            <SectionHead
              step={3}
              icon={BarChart3}
              title="What each phase observed"
              aside={
                <ul className="zoc-legend">
                  <li>
                    <span className="zoc-dot is-named" aria-hidden="true" /> Named
                  </li>
                  <li>
                    <span className="zoc-dot is-absent" aria-hidden="true" /> Not named
                  </li>
                  {anyUnreadable ? (
                    <li>
                      <span className="zoc-dot is-unreadable" aria-hidden="true" /> Planned, not
                      readable
                    </li>
                  ) : null}
                </ul>
              }
            />

            <div className="zoc-phases">
              <PhaseCard
                label="Baseline"
                tone="baseline"
                phase={baseline}
                companyName={subject.companyName}
              />
              <PhaseCard
                label="Retest"
                tone="retest"
                phase={retest}
                companyName={subject.companyName}
              />
            </div>
          </section>

          {/* ------------------------------------------------- 4. Outcome */}
          <section className="zoc-section">
            <SectionHead step={4} icon={ClipboardCheck} title="Outcome" />

            <div className={`zoc-outcome tone-${status.tone}`}>
              <div className="zoc-outcome-main">
                <span className="zoc-outcome-icon" aria-hidden="true">
                  <StatusIcon size={30} strokeWidth={1.8} />
                </span>
                <div>
                  <p className="zoc-outcome-label">{status.label}</p>
                  <p className="zoc-outcome-reading">{status.reading}</p>
                </div>
              </div>

              <dl className="zoc-stats">
                {comparison.delta !== null ? (
                  <div>
                    <dt>Observed change (retest minus baseline)</dt>
                    <dd>{signedPercent(comparison.delta)}</dd>
                  </div>
                ) : null}
                {comparison.interval ? (
                  <div>
                    <dt>95% interval on the difference (Newcombe)</dt>
                    <dd>
                      {signedPercent(comparison.interval.low)} to{" "}
                      {signedPercent(comparison.interval.high)}
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt>Minimum useful change, declared before the retest ran</dt>
                  <dd>{percent(comparison.minimumUsefulChange)}</dd>
                </div>
                {comparison.smallestDetectableChange !== null ? (
                  <div>
                    <dt>Smallest change this sample could separate from zero</dt>
                    <dd>{percent(comparison.smallestDetectableChange)}</dd>
                  </div>
                ) : null}
                {payload.detectableChangeAtPlan !== null ? (
                  <div>
                    <dt>Detectable change disclosed at approval</dt>
                    <dd>{percent(payload.detectableChangeAtPlan)}</dd>
                  </div>
                ) : null}
              </dl>

              {comparison.delta !== null && comparison.interval ? (
                <div className="zoc-diff" aria-hidden="true">
                  <div className="zoc-track">
                    <span
                      className="zoc-range"
                      style={{
                        left: atSigned(comparison.interval.low),
                        width: at((comparison.interval.high - comparison.interval.low) / 2),
                      }}
                    />
                    <span
                      className="zoc-min"
                      style={{ left: atSigned(-comparison.minimumUsefulChange) }}
                    />
                    <span
                      className="zoc-min"
                      style={{ left: atSigned(comparison.minimumUsefulChange) }}
                    />
                    <span className="zoc-zero" />
                    <span className="zoc-point" style={{ left: atSigned(comparison.delta) }} />
                  </div>
                  <div className="zoc-scale">
                    <span>−100%</span>
                    <span>0</span>
                    <span>+100%</span>
                  </div>
                  <p className="zoc-diff-key">
                    Point: observed change. Band: 95% interval. Vertical
                    marks: minimum useful change (±
                    {percent(comparison.minimumUsefulChange)}).
                  </p>
                </div>
              ) : null}
            </div>
          </section>

          {/* ------------------------------------------------- 5. Context */}
          <section className="zoc-section">
            <SectionHead step={5} icon={BookOpen} title="How to read this" />

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
          </section>
        </div>
      </div>

      <footer className="zpr-footer">
        <Brand />
        <span>Prepared privately for {subject.companyName} by Zypact.</span>
      </footer>
    </main>
  );
}
