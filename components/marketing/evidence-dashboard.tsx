import type { CSSProperties } from "react";
import {
  Database,
  FileText,
  Lock,
  MessageSquareText,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

import { ZypactMark } from "@/components/marketing/zypact-mark";
import {
  OUTCOME_STATUS_LABEL,
  SYNTHETIC_BASELINE_NAMED,
  SYNTHETIC_QUESTION,
  SYNTHETIC_RETEST_NAMED,
  SYNTHETIC_RUNS,
  V1_MINIMUM_USEFUL_CHANGE,
  percent,
  percentRange,
  signedPoints,
  syntheticAttempts,
  syntheticBaselineInterval,
  syntheticBaselineRate,
  syntheticComparison,
  syntheticRetestInterval,
  syntheticRetestRate,
} from "@/components/marketing/synthetic-retest";
import type { OutcomeStatus } from "@/lib/reports/compare-protocols";
import type { ProtocolReportInterval } from "@/lib/reports/protocol-report-types";
import { cn } from "@/lib/utils";

/**
 * The hero's synthetic product preview: one approved question, its baseline
 * and its retest, and the outcome the comparison engine returns for them.
 *
 * Honest by construction, because the design mock it replaces was not:
 *
 *  - Every number comes from synthetic-retest.ts, which runs the same engine
 *    that builds real Outcome Cards. Nothing here is typed in, so the preview
 *    cannot show a status the method would not return for its counts.
 *  - The chart puts each phase's 95% interval and point estimate on its own
 *    row. There is no line joining baseline to retest: two phases are two
 *    samples, not a trajectory, and V1 never measures what happened between.
 *  - The change is stated in points, with its own interval and the minimum
 *    useful change agreed before the retest; never as a signed lift badge.
 *  - Failed and excluded attempts are listed beside the preserved runs.
 *  - The synthetic disclosure is part of the device and always visible.
 *
 * 3D, outside in (styles in components/landing/styles/hero.css):
 *
 *   .lx-dash-stage   perspective; data-scroll feeds --p to the next layer
 *   .lx-dash-scroll  straightens and rises as the hero scrolls away (lg)
 *   .lx-dash-pose    resting pose, and the load swing in from deep space
 *   .lx-float        idle float (base.css)
 *   .lx-dash-device  data-tilt pointer tilt + glare; never overflow:hidden
 *     .lx-z-1/2/4    depth layers: chart, stat tiles, overhanging chips
 *
 * Every layer down to the depth layers keeps `preserve-3d` (.lx-3d) and none
 * of them sets a grouping property (overflow, opacity, filter), which would
 * flatten the layers into the screen. The screen's rounded corners come from
 * its own radius and its children's matching radii, not from clipping.
 *
 * Server component: motion is CSS plus the declarative hooks driven by
 * components/landing/landing-motion.tsx (data-reveal, data-draw,
 * data-count-to, data-tilt, data-scroll).
 */

const DISCLOSURE =
  "Synthetic example — not customer data and not a live Perplexity probe. Failed and excluded attempts stay visible in the denominator. Observed change, not proof the change caused it.";

const SUMMARY =
  "In the retest, Perplexity named your product in more runs of the same approved question.";

interface Phase {
  key: "baseline" | "retest";
  label: string;
  named: number;
  rate: number;
  interval: ProtocolReportInterval;
}

const PHASES: readonly Phase[] = [
  {
    key: "baseline",
    label: "Baseline",
    named: SYNTHETIC_BASELINE_NAMED,
    rate: syntheticBaselineRate,
    interval: syntheticBaselineInterval,
  },
  {
    key: "retest",
    label: "Retest",
    named: SYNTHETIC_RETEST_NAMED,
    rate: syntheticRetestRate,
    interval: syntheticRetestInterval,
  },
];

/**
 * The status picks its tone from the landing's outcome tints, so a change to
 * the synthetic counts can never leave a mint "success" look on a status that
 * is not an increase. Meaning is carried by the label and code, not the tint.
 */
const STATUS_TONE: Record<
  OutcomeStatus,
  { tint: string; ink: string; pulse: string }
> = {
  increase_observed: {
    tint: "var(--lx-mint)",
    ink: "var(--lx-mint-ink)",
    pulse: "var(--success)",
  },
  decrease_observed: {
    tint: "var(--lx-rose)",
    ink: "var(--lx-rose-ink)",
    pulse: "var(--destructive)",
  },
  no_clear_change: {
    tint: "var(--lx-slate)",
    ink: "var(--lx-slate-ink)",
    pulse: "var(--info)",
  },
  inconclusive: {
    tint: "var(--lx-sand)",
    ink: "var(--lx-sand-ink)",
    pulse: "var(--warning)",
  },
};

/** Attempt dispositions use the shared status tokens; the label carries the meaning too. */
const ATTEMPT_TONE: Record<(typeof syntheticAttempts)[number]["label"], string> = {
  Preserved: "bg-success",
  Retried: "bg-warning",
  Excluded: "bg-destructive",
};

const SIDEBAR = [
  { label: "Questions", icon: MessageSquareText, active: true },
  { label: "Evidence", icon: Database, active: false },
  { label: "Retests", icon: RefreshCw, active: false },
  { label: "Reports", icon: FileText, active: false },
] as const;

/* Interval plot. The bar SVG's user space is VIEW_W x VIEW_H and is stretched
   horizontally only (preserveAspectRatio="none"), so a horizontal bar keeps
   its exact thickness at every width. */
const VIEW_W = 300;
const VIEW_H = 20;
const BAR_THICKNESS = 8;
const TICKS = [0, 0.25, 0.5, 0.75, 1] as const;

/*
 * Reveal timing, in ms after the motion driver marks the element in view
 * (shortly after hydration in the hero), so the numbers and bars arrive as
 * the device settles from its CSS swing-in.
 */
const VALUE_DELAY = 950;
const VALUE_STEP = 180;
const BAR_DELAY = 1150;
const BAR_STEP = 260;
const BAR_DRAW = 1100;

const cssVars = (vars: Record<`--${string}`, string | number>) =>
  vars as CSSProperties;

/** 0.1333 → "13.33%", a CSS offset along the 0–100% axis. */
const along = (fraction: number) => `${(fraction * 100).toFixed(2)}%`;

/** The integer the stat tile counts to, rounded exactly as `percent` rounds it. */
const wholePercent = (value: number) => Number.parseInt(percent(value), 10);

/**
 * The interval bar as a horizontal path. Round caps reach half the stroke
 * width past each end, so the ends are pulled in by that much and the drawn
 * bar spans exactly low..high.
 */
function barPath({ low, high }: ProtocolReportInterval): string {
  const cap = BAR_THICKNESS / 2;
  const mid = ((low + high) / 2) * VIEW_W;
  const start = Math.min(low * VIEW_W + cap, mid);
  const end = Math.max(high * VIEW_W - cap, mid);
  const y = VIEW_H / 2;
  return `M${start.toFixed(2)} ${y}H${end.toFixed(2)}`;
}

const comparison = syntheticComparison;
const statusLabel = OUTCOME_STATUS_LABEL[comparison.status];
const tone = STATUS_TONE[comparison.status];
const minimumPoints = Math.round(V1_MINIMUM_USEFUL_CHANGE * 100);

const differenceParts = [
  comparison.delta === null
    ? null
    : `Observed change ${signedPoints(comparison.delta)} points`,
  comparison.interval === null
    ? null
    : `95% interval ${signedPoints(comparison.interval.low)} to ${signedPoints(
        comparison.interval.high
      )} points`,
  `minimum useful change ${minimumPoints} points`,
].filter((part): part is string => part !== null);

/** The text equivalent of the interval plot, which is hidden from assistive tech. */
const plotSummary = PHASES.map(
  (phase) =>
    `${phase.label} ${percent(phase.rate)}, 95% interval ${percentRange(phase.interval)}.`
).join(" ");

function Sidebar() {
  return (
    <div className="lx-dash-side" aria-hidden="true">
      <div className="lx-dash-brand">
        <ZypactMark
          className="h-[18px] w-[18px]"
          dotFill="hsl(var(--surface-subtle))"
        />
        <span>Zypact</span>
      </div>
      <ul className="lx-dash-nav">
        {SIDEBAR.map(({ label, icon: Icon, active }) => (
          <li
            key={label}
            className={cn("lx-dash-nav__item", active && "is-active")}
          >
            <Icon className="lx-dash-nav__icon" strokeWidth={1.75} />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function IntervalPlot() {
  return (
    <div className="lx-dash-chart lx-z-1">
      <p className="lx-dash-chart__title">95% intervals per phase</p>

      <div className="lx-dash-plot" aria-hidden="true">
        <div className="lx-dash-plot__rows">
          <span className="lx-dash-plot__grid">
            {TICKS.map((tick) => (
              <span key={tick} style={{ left: along(tick) }} />
            ))}
          </span>

          {PHASES.map((phase, index) => {
            const barDelay = BAR_DELAY + index * BAR_STEP;
            return (
              <div
                key={phase.key}
                className={`lx-dash-plot__row lx-dash-plot__row--${phase.key}`}
              >
                <span className="lx-dash-plot__label">{phase.label}</span>
                <span className="lx-dash-plot__track">
                  <svg
                    className="lx-dash-plot__svg"
                    viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
                    preserveAspectRatio="none"
                    focusable="false"
                  >
                    <path
                      className={`lx-dash-bar lx-dash-bar--${phase.key}`}
                      d={barPath(phase.interval)}
                      pathLength={1}
                      data-draw=""
                      style={cssVars({
                        "--lx-delay": `${barDelay}ms`,
                        "--lx-draw-dur": `${BAR_DRAW}ms`,
                      })}
                    />
                  </svg>
                  <span
                    className={`lx-dash-dot lx-dash-dot--${phase.key}`}
                    data-reveal="scale"
                    style={{
                      left: along(phase.rate),
                      ...cssVars({
                        "--lx-delay": `${barDelay + Math.round(BAR_DRAW * 0.7)}ms`,
                      }),
                    }}
                  />
                </span>
              </div>
            );
          })}
        </div>

        <div className="lx-dash-plot__axis">
          {TICKS.map((tick) => (
            <span key={tick} style={{ left: along(tick) }}>
              {percent(tick)}
            </span>
          ))}
        </div>
      </div>

      <p className="lx-sr">{plotSummary}</p>

      <p className="lx-dash-diff">
        {differenceParts.map((part, index) => (
          <span
            key={part}
            className={index === 0 ? "lx-dash-diff__lead" : undefined}
          >
            {index > 0 ? " · " : null}
            {part}
          </span>
        ))}
      </p>
    </div>
  );
}

export function EvidenceDashboard() {
  const retestNamedMore = SYNTHETIC_RETEST_NAMED > SYNTHETIC_BASELINE_NAMED;

  return (
    <figure className="lx-dash" aria-label="Synthetic product preview">
      <div className="lx-dash-stage" data-scroll="">
        <div className="lx-dash-scroll lx-3d">
          <div className="lx-dash-pose lx-3d">
            <div className="lx-float lx-float--slow lx-3d">
              <div
                className="lx-dash-device"
                data-tilt="7"
                data-tilt-glare=""
              >
                <div className="lx-dash-screen lx-3d">
                  <Sidebar />

                  <div
                    className="lx-dash-main lx-3d"
                    style={cssVars({
                      "--lx-dash-tone": tone.tint,
                      "--lx-dash-tone-ink": tone.ink,
                    })}
                  >
                    <div className="lx-dash-head">
                      <div className="lx-dash-head__row">
                        <p className="lx-dash-eyebrow">Approved question</p>
                        <span className="lx-synthetic">Synthetic</span>
                      </div>
                      <p className="lx-dash-question">
                        “{SYNTHETIC_QUESTION}”
                      </p>
                    </div>

                    <div className="lx-dash-outcome">
                      <p className="lx-dash-outcome__title">
                        <span className="lx-dash-outcome__lead">Outcome:</span>{" "}
                        <span className="lx-dash-outcome__status">
                          {statusLabel}
                        </span>
                      </p>
                      <span className="lx-dash-code">
                        <span
                          className="lx-dash-code__dot lx-pulse-dot"
                          style={cssVars({ "--pulse": tone.pulse })}
                          aria-hidden="true"
                        />
                        {comparison.status}
                      </span>
                    </div>
                    {retestNamedMore ? (
                      <p className="lx-dash-summary">{SUMMARY}</p>
                    ) : null}

                    <div className="lx-dash-tiles lx-3d">
                      {PHASES.map((phase, index) => {
                        const whole = wholePercent(phase.rate);
                        const delay = VALUE_DELAY + index * VALUE_STEP;
                        return (
                          <div
                            key={phase.key}
                            className={`lx-dash-tile lx-dash-tile--${phase.key} lx-z-2`}
                          >
                            <p className="lx-dash-tile__label">
                              <span
                                className={`lx-dash-key lx-dash-key--${phase.key}`}
                                aria-hidden="true"
                              />
                              {phase.label}
                            </p>
                            <p
                              className="lx-dash-tile__value"
                              data-reveal=""
                              style={cssVars({ "--lx-delay": `${delay}ms` })}
                            >
                              <span
                                data-count-to={whole}
                                data-count-delay={delay}
                                data-count-duration={1300}
                              >
                                {whole}
                              </span>
                              %
                            </p>
                            <p className="lx-dash-tile__meta">
                              {`named in ${phase.named} of ${SYNTHETIC_RUNS} runs`}
                            </p>
                            <p className="lx-dash-tile__range">
                              {`95% interval ${percentRange(phase.interval)}`}
                            </p>
                          </div>
                        );
                      })}
                    </div>

                    <IntervalPlot />

                    <div className="lx-dash-attempts">
                      <p className="lx-dash-attempts__title">Retest attempts</p>
                      <ul className="lx-dash-attempts__list">
                        {syntheticAttempts.map((attempt) => (
                          <li key={attempt.label} className="lx-dash-attempt">
                            <span
                              className={cn(
                                "lx-dash-attempt__dot",
                                ATTEMPT_TONE[attempt.label]
                              )}
                              aria-hidden="true"
                            />
                            {attempt.label}{" "}
                            <span className="lx-dash-attempt__count">
                              {attempt.value}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  <p className="lx-dash-foot">{DISCLOSURE}</p>
                </div>

                <span className="lx-dash-sheen" aria-hidden="true" />

                <div className="lx-dash-flt lx-dash-flt--protocol lx-z-4">
                  <div className="lx-dash-flt__anim">
                    <p className="lx-dash-flt__body">
                      <ShieldCheck
                        className="lx-dash-flt__icon"
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                      Same question · Same protocol
                    </p>
                  </div>
                </div>

                <div
                  className="lx-dash-flt lx-dash-flt--hash lx-z-4"
                  aria-hidden="true"
                >
                  <div className="lx-dash-flt__anim">
                    <p className="lx-dash-flt__body">
                      <Lock className="lx-dash-flt__icon" strokeWidth={2} />
                      sha256 9f3c…e1a7 · preserved
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </figure>
  );
}
