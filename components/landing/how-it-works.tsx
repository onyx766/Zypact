import type { CSSProperties } from "react";

import { SectionHeading } from "@/components/landing/section-heading";
import type { IconCopy, SectionCopy } from "@/components/landing/types";
import { cn } from "@/lib/utils";

export interface HowItWorksProps extends SectionCopy {
  steps: readonly IconCopy[];
  /**
   * "default" lays five steps across at lg (the landing). "three" is the
   * three-step band on /scan, which would otherwise leave two empty columns.
   */
  layout?: "default" | "three";
}

/* ------------------------------------------------------------ Contours */

type Point = readonly [number, number];

/**
 * One closed topographic contour: a squashed circle whose radius wanders by
 * a few low-frequency harmonics, smoothed into quadratic curves through the
 * midpoints of its samples. Integer coordinates keep the markup small.
 */
function contourRing(
  cx: number,
  cy: number,
  radius: number,
  squash: number,
  wobble: number,
  phase: number,
  samples: number
): string {
  const points: Point[] = [];
  for (let i = 0; i < samples; i += 1) {
    const angle = (i / samples) * Math.PI * 2;
    const swell =
      1 +
      wobble *
        (0.55 * Math.sin(2 * angle + phase) +
          0.3 * Math.sin(3 * angle - phase * 1.3) +
          0.15 * Math.sin(5 * angle + phase * 0.7));
    points.push([
      cx + Math.cos(angle) * radius * swell,
      cy + Math.sin(angle) * radius * swell * squash,
    ]);
  }

  const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const r = Math.round;
  const start = mid(points[samples - 1], points[0]);
  let d = `M${r(start[0])} ${r(start[1])}`;
  for (let i = 0; i < samples; i += 1) {
    const control = points[i];
    const end = mid(control, points[(i + 1) % samples]);
    d += `Q${r(control[0])} ${r(control[1])} ${r(end[0])} ${r(end[1])}`;
  }
  return `${d}Z`;
}

/** Nested contours around one summit; outer rings wobble more, like terrain. */
function contourCluster(
  cx: number,
  cy: number,
  from: number,
  to: number,
  step: number,
  squash: number,
  seed: number
): string {
  let d = "";
  for (let radius = from, ring = 0; radius <= to; radius += step, ring += 1) {
    d += contourRing(cx, cy, radius, squash, 0.05 + radius / 2400, seed + ring * 0.21, 18);
  }
  return d;
}

/** Computed once per server process; deterministic, so every render matches. */
const CONTOURS =
  contourCluster(1150, 150, 44, 600, 46, 0.62, 0.8) +
  contourCluster(120, 640, 40, 330, 46, 0.7, 2.6);

/* --------------------------------------------------------------- Steps */

/** Inline custom properties, typed once. Values never carry a sign or %. */
const vars = (values: Record<`--${string}`, string | number>) =>
  values as CSSProperties;

export function HowItWorks({
  id,
  eyebrow,
  title,
  lede,
  steps,
  layout = "default",
}: HowItWorksProps) {
  const last = steps.length - 1;

  return (
    <section
      id={id}
      data-spotlight
      className="lx-on-dark lx-how relative isolate overflow-hidden bg-[hsl(var(--panel))] py-24 lg:py-28"
    >
      <div className="lx-how__depth" aria-hidden="true" />
      <svg
        className="lx-how__contours"
        viewBox="0 0 1440 640"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
        focusable="false"
      >
        <path d={CONTOURS} />
      </svg>

      <div className="shell relative z-[1] grid gap-14 xl:grid-cols-[minmax(0,0.34fr)_minmax(0,0.66fr)] xl:items-center xl:gap-12">
        <SectionHeading
          eyebrow={eyebrow}
          title={title}
          lede={lede}
          titleClassName="xl:text-[44px]"
        />

        <ol
          role="list"
          data-stagger="140"
          className={cn("lx-how-steps", layout === "three" && "lx-how-steps--three")}
        >
          {steps.map((step, index) => {
            const Icon = step.icon;
            const isLast = index === last;
            // The connector draws in just after its own step has turned in.
            const drawAt = 420 + index * 140;

            return (
              <li
                key={step.title}
                data-reveal="flip"
                className={cn("lx-how-step", isLast && "lx-how-step--last")}
                style={vars({ "--i": index })}
              >
                <div className="lx-how-step__body" data-tilt="24">
                  <span className="lx-how-node" aria-hidden="true">
                    <span className="lx-how-node__glow" />
                    <svg
                      className="lx-how-node__orbit"
                      viewBox="0 0 76 76"
                      focusable="false"
                    >
                      <circle className="lx-how-node__ring" cx="38" cy="38" r="37" />
                      <circle className="lx-how-node__moon" cx="38" cy="1" r="2.25" />
                    </svg>
                    <span className="lx-how-node__core">
                      <Icon aria-hidden="true" strokeWidth={1.9} />
                    </span>
                  </span>
                  <span className="lx-how-step__num" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <h3 className="lx-how-step__title text-[16px] font-semibold leading-[1.3] tracking-[-0.01em]">
                    {step.title}
                  </h3>
                  <p className="lx-how-step__copy text-[13px] leading-[1.6]">
                    {step.copy}
                  </p>
                </div>

                {isLast ? null : (
                  <span className="lx-how-wire" aria-hidden="true">
                    <svg
                      className="lx-how-wire__line lx-how-wire__line--x"
                      viewBox="0 0 100 2"
                      preserveAspectRatio="none"
                      focusable="false"
                    >
                      <path
                        d="M0 1H100"
                        pathLength={1}
                        data-draw
                        style={vars({ "--lx-delay": `${drawAt}ms`, "--lx-draw-dur": "900ms" })}
                      />
                    </svg>
                    <svg
                      className="lx-how-wire__line lx-how-wire__line--y"
                      viewBox="0 0 2 100"
                      preserveAspectRatio="none"
                      focusable="false"
                    >
                      <path
                        d="M1 0V100"
                        pathLength={1}
                        data-draw
                        style={vars({ "--lx-delay": `${drawAt}ms`, "--lx-draw-dur": "900ms" })}
                      />
                    </svg>
                    <svg className="lx-how-wire__head" viewBox="0 0 12 12" focusable="false">
                      <path
                        d="M4 2.5L8 6L4 9.5"
                        pathLength={1}
                        data-draw
                        style={vars({ "--lx-delay": `${drawAt + 620}ms`, "--lx-draw-dur": "500ms" })}
                      />
                    </svg>
                    <span className="lx-how-wire__track">
                      <span className="lx-how-wire__spark" />
                    </span>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
