import type { CSSProperties } from "react";

import { RidgeCanvas } from "@/components/landing/canvas/ridge-canvas";
import { SectionHeading } from "@/components/landing/section-heading";
import type { IconCopy, SectionCopy } from "@/components/landing/types";
import { cn } from "@/lib/utils";

export interface WhyProps extends SectionCopy {
  cards: readonly IconCopy[];
}

/**
 * Tint and hover personality per card, by position. Each personality is a
 * generic treatment of the icon disc (story.css), not a drawing of a
 * particular glyph: "pulse" sends concentric rings out, "stack" fans layered
 * plates apart in depth, "glow" lights the disc amber.
 */
const CARD_STYLES = [
  { tone: "mint", effect: "pulse" },
  { tone: "slate", effect: "stack" },
  { tone: "amber", effect: "glow" },
] as const;

/*
 * Leaf geometry, in the 600 x 720 box shared with the CSS mask on
 * .lx-why-leaf__shape (story.css). The window's own silhouette is that mask;
 * these two paths are drawn over it and must be edited together with it.
 *
 * ECHO  the amber hairline, offset just outside the leaf's top-right edge.
 * VEIL  a lighter, translucent second petal overlapping the left of the leaf.
 */
const ECHO_PATH = "M300 40C420 20 520 4 606 -12C602 196 494 540 270 744";
const VEIL_PATH = "M0 96C160 150 300 280 304 430C308 560 230 650 120 720L0 720Z";

const echoTiming = {
  "--lx-draw-dur": "2600ms",
  "--lx-delay": "250ms",
} as CSSProperties;

export function Why({ id, eyebrow, title, lede, cards }: WhyProps) {
  return (
    <section
      id={id}
      className="lx-why relative pt-24 sm:pt-28 lg:pb-28 lg:pt-32"
    >
      <div className="shell relative z-[1]">
        <SectionHeading
          eyebrow={eyebrow}
          title={title}
          lede={lede}
          className="lg:ml-[38%] lg:max-w-[600px]"
        />

        <ul
          role="list"
          data-stagger="130"
          className="mt-12 grid gap-4 sm:gap-5 md:grid-cols-3 lg:ml-[28%] lg:mt-14"
        >
          {cards.map((card, index) => {
            const style = CARD_STYLES[index % CARD_STYLES.length];
            const Icon = card.icon;

            return (
              <li key={card.title} data-reveal="rotate" className="relative">
                <article
                  data-tilt="20"
                  data-tilt-glare
                  className={cn(
                    "lx-card lx-why-card flex h-full flex-col p-6 lg:p-7",
                    `lx-why-card--${style.tone}`
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "lx-why-icon lx-3d lx-z-2",
                      `lx-why-icon--${style.effect}`
                    )}
                  >
                    <span className="lx-why-icon__disc">
                      <Icon
                        aria-hidden="true"
                        strokeWidth={1.75}
                        className="lx-why-icon__glyph"
                      />
                    </span>
                  </span>
                  <h3 className="lx-why-card__title relative mt-6 text-[20px] leading-[1.25]">
                    {card.title}
                  </h3>
                  <p className="relative mt-4 text-[14px] leading-[1.6] text-muted-foreground">
                    {card.copy}
                  </p>
                </article>
              </li>
            );
          })}
        </ul>
      </div>

      {/*
        The leaf window. Below lg it closes the section, full-bleed on the
        left; from lg it fills the left of the band. Either way it runs into
        the section's bottom edge, where the dark How-it-works band takes
        over from its dark foreground ridges. `data-scroll` sits on this
        untransformed wrapper so the --p it measures never includes the
        parallax it drives.
      */}
      <div className="lx-why-leaf-wrap" data-scroll aria-hidden="true">
        <div className="lx-why-leaf">
          <div className="lx-why-leaf__breathe">
            <div className="lx-why-leaf__shape">
              <RidgeCanvas variant="dusk" />
              <svg
                className="lx-why-leaf__veil"
                viewBox="0 0 600 720"
                preserveAspectRatio="none"
                focusable="false"
              >
                <defs>
                  <linearGradient id="lx-why-veil-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" className="lx-why-stop" stopOpacity="0.34" />
                    <stop offset="1" className="lx-why-stop" stopOpacity="0.04" />
                  </linearGradient>
                </defs>
                <path d={VEIL_PATH} fill="url(#lx-why-veil-fill)" />
              </svg>
              <div className="lx-why-leaf__shade" />
            </div>
            <svg
              className="lx-why-leaf__line"
              viewBox="0 0 600 720"
              preserveAspectRatio="none"
              focusable="false"
            >
              <defs>
                <linearGradient id="lx-why-echo-fade" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" className="lx-why-stop--amber" stopOpacity="0" />
                  <stop offset="0.1" className="lx-why-stop--amber" stopOpacity="0.95" />
                  <stop offset="0.62" className="lx-why-stop--amber" stopOpacity="0.5" />
                  <stop offset="1" className="lx-why-stop--amber" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path
                d={ECHO_PATH}
                pathLength={1}
                data-draw
                stroke="url(#lx-why-echo-fade)"
                style={echoTiming}
              />
            </svg>
          </div>
        </div>
      </div>
    </section>
  );
}
