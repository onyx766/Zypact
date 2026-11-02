import type { CSSProperties } from "react";
import { ArrowUpRight } from "lucide-react";

import { SectionHeading } from "@/components/landing/section-heading";
import type { IconCopy, LandingLink, SectionCopy } from "@/components/landing/types";
import { cn } from "@/lib/utils";

export interface MethodProps extends SectionCopy {
  /** Guarded contextual link to /perplexity-content-change-test. */
  link: LandingLink;
  columns: readonly IconCopy[];
}

/**
 * Icon tint per column, by position, after the design: teal tints throughout
 * and one amber accent on the fourth column (the registered retest).
 */
const COLUMN_TONES = ["mint", "slate", "slate", "amber"] as const;

const dividerTiming = {
  "--lx-reveal-dur": "1400ms",
  "--lx-delay": "220ms",
} as CSSProperties;

/*
 * U+2060 WORD JOINER after the label: no line break may fall between the
 * last word and the arrow icon, so the arrow never wraps onto a line alone.
 * The label itself stays one contiguous text node (the landing guard reads it).
 */
const WORD_JOINER = "⁠";

export function Method({ id, eyebrow, title, lede, link, columns }: MethodProps) {
  return (
    <section id={id} className="lx-method relative py-24 lg:py-32">
      <div className="shell">
        <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)] lg:items-center lg:gap-14 xl:gap-16">
          <SectionHeading eyebrow={eyebrow} title={title} className="lg:max-w-[540px]" />

          <span
            aria-hidden="true"
            data-reveal="mask"
            className="lx-method-divider hidden min-h-[132px] self-stretch lg:block"
            style={dividerTiming}
          />

          <div data-stagger="120" data-stagger-base="160" className="max-w-xl">
            <p data-reveal className="lx-lede">
              {lede}
            </p>
            <p data-reveal className="mt-6">
              <a
                href={link.href}
                className="lx-method-link text-[15px] font-semibold leading-[1.75]"
              >
                {`${link.label}${WORD_JOINER}`}
                <ArrowUpRight
                  aria-hidden="true"
                  strokeWidth={2}
                  className="lx-method-link__arrow"
                />
              </a>
            </p>
          </div>
        </div>

        <ul
          role="list"
          data-stagger="120"
          className="lx-method-cols mt-14 grid sm:grid-cols-2 lg:mt-20 lg:grid-cols-4"
        >
          {columns.map((column, index) => {
            const Icon = column.icon;
            const tone = COLUMN_TONES[index % COLUMN_TONES.length];

            return (
              <li key={column.title} data-reveal="flip" className="lx-method-col">
                <article
                  data-tilt="18"
                  data-tilt-glare
                  className={cn(
                    "lx-method-card flex h-full flex-col px-6 pb-7 pt-6",
                    `lx-method-card--${tone}`
                  )}
                >
                  <span aria-hidden="true" className="lx-method-icon lx-3d lx-z-2">
                    <span className="lx-method-icon__coin">
                      <Icon aria-hidden="true" strokeWidth={1.75} />
                    </span>
                  </span>
                  <h3 className="relative mt-6 text-[15px] font-bold leading-[1.35] tracking-[-0.01em] text-foreground">
                    {column.title}
                  </h3>
                  <p className="relative mt-3 text-[13.5px] leading-[1.6] text-muted-foreground">
                    {column.copy}
                  </p>
                </article>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
