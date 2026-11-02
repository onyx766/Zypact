import { Fragment, type CSSProperties } from "react";
import { ArrowRight, type LucideIcon } from "lucide-react";

import { RidgeCanvas } from "@/components/landing/canvas/ridge-canvas";
import type { LandingLink } from "@/components/landing/types";
import { EvidenceDashboard } from "@/components/marketing/evidence-dashboard";

export interface HeroProps {
  eyebrow: string;
  /** Each entry is one masked display line; together they form the h1. */
  headlineLines: readonly string[];
  lede: string;
  primaryCta: LandingLink;
  secondaryCta: LandingLink;
  chips: readonly { label: string; icon: LucideIcon }[];
  scopeLine: string;
}

/** `--i` orders the CSS load choreography (`lx-intro`, `lx-line` in base.css). */
const order = (index: number) => ({ "--i": index }) as CSSProperties;

/**
 * The opening band: copy on the left, the synthetic evidence device on the
 * right over a procedural dawn range.
 *
 * Server component. The copy's entrance is pure CSS, so it plays before
 * hydration and without JavaScript; only the ridge canvas and the motion
 * driver's hooks inside the dashboard need the client. Every string arrives
 * from app/page.tsx and is rendered whole — each headline line is one text
 * run inside its mask, so the landing guard and screen readers both read the
 * copy exactly as written.
 *
 * The ridge layer is a child of the visual column so that below `lg` it is
 * positioned against the dashboard (behind and below it), while at `lg` the
 * column turns static and the layer is positioned against the section: the
 * right of the band, rising under the sticky header. hero.css owns both.
 */
export function Hero({
  eyebrow,
  headlineLines,
  lede,
  primaryCta,
  secondaryCta,
  chips,
  scopeLine,
}: HeroProps) {
  const lastLine = headlineLines.length - 1;
  // Intro order after the eyebrow (0) and the headline lines.
  const ledeAt = headlineLines.length + 1;
  const ctaAt = ledeAt + 1;
  const chipsAt = ctaAt + 1;
  const scopeAt = chipsAt + chips.length;

  return (
    <section
      className="lx-hero relative isolate pb-16 pt-10 sm:pb-20 sm:pt-14 lg:pb-28 lg:pt-16 xl:pt-20"
      aria-labelledby="hero-title"
    >
      <div className="shell grid grid-cols-1 gap-y-16 lg:grid-cols-[minmax(0,44fr)_minmax(0,56fr)] lg:items-center lg:gap-x-14">
        <div className="lx-hero-copy">
          <p className="lx-eyebrow lx-intro" style={order(0)}>
            {eyebrow}
          </p>

          <h1
            id="hero-title"
            className="lx-display lx-hero-title mt-5 text-[42px] sm:mt-6 sm:text-[56px] lg:text-[60px] xl:text-[70px] min-[1400px]:text-[72px]"
          >
            {headlineLines.map((line, index) => (
              <Fragment key={`${index}:${line}`}>
                {/* Keeps the accessible name spaced between the block lines. */}
                {index > 0 ? " " : null}
                <span className="lx-line">
                  <span style={order(index)}>
                    {index === lastLine ? (
                      <span className="lx-hero-mark">{line}</span>
                    ) : (
                      line
                    )}
                  </span>
                </span>
              </Fragment>
            ))}
          </h1>

          <p
            className="lx-lede lx-hero-lede lx-intro mt-6 max-w-[470px]"
            style={order(ledeAt)}
          >
            {lede}
          </p>

          <div
            className="lx-intro mt-9 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center"
            style={order(ctaAt)}
          >
            <a
              href={primaryCta.href}
              className="lx-btn lx-btn--primary w-full sm:w-auto"
              data-magnetic="8"
            >
              {primaryCta.label}
              <ArrowRight
                className="lx-btn__arrow"
                strokeWidth={2}
                aria-hidden="true"
              />
            </a>
            <a
              href={secondaryCta.href}
              className="lx-btn lx-btn--ghost w-full sm:w-auto"
            >
              {secondaryCta.label}
            </a>
          </div>

          <ul className="lx-hero-chips mt-10 sm:mt-11">
            {chips.map(({ label, icon: Icon }, index) => (
              <li
                key={label}
                className="lx-hero-chip lx-intro"
                style={order(chipsAt + index)}
              >
                <span className="lx-hero-chip__icon" aria-hidden="true">
                  <Icon strokeWidth={1.75} />
                </span>
                <span className="lx-hero-chip__label">{label}</span>
              </li>
            ))}
          </ul>

          <p
            className="lx-hero-scope lx-intro mt-7 max-w-[500px] text-[11px] font-medium uppercase leading-[1.75] tracking-[0.14em] text-muted-foreground"
            style={order(scopeAt)}
          >
            {scopeLine}
          </p>
        </div>

        <div className="lx-hero-visual">
          <div className="lx-hero-ridge" aria-hidden="true">
            <RidgeCanvas variant="dawn" />
          </div>
          <div className="lx-hero-stage">
            <span className="lx-hero-sun" aria-hidden="true" />
            <EvidenceDashboard />
          </div>
        </div>
      </div>
    </section>
  );
}
