import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Shared presentational pieces for the marketing pages.
 *
 * These carry the visual language of the approved design — pill section
 * labels, tinted icon tiles, bordered cards, numbered step markers — so the
 * landing page and the demo request page stay consistent and a section can be
 * reordered without re-deriving its styling.
 *
 * Everything here is purely presentational and holds no product copy. Claims
 * live in the pages, where the landing-page contract test can see them.
 *
 * All of it renders inside `ThemeRoot`, so it follows the active theme rather
 * than assuming light or dark.
 */

/**
 * Tinted icon tiles. The approved design uses four pastel tones to tell
 * adjacent cards apart at a glance; these map onto the chart tokens, which are
 * the palette defined for exactly this "several distinguishable accents"
 * purpose and are already tuned per theme.
 *
 * Written as complete class strings, not composed at runtime, because Tailwind
 * scans source text and would not emit a class it never sees spelled out.
 */
const TILE_TONES = {
  teal: "bg-chart-1/15 text-chart-1",
  green: "bg-chart-2/15 text-chart-2",
  amber: "bg-chart-3/15 text-chart-3",
  violet: "bg-chart-4/15 text-chart-4",
} as const;

export type TileTone = keyof typeof TILE_TONES;

/** Rotates tones across a list so neighbouring cards never share one. */
export function toneAt(index: number): TileTone {
  const order: TileTone[] = ["teal", "green", "violet", "amber"];
  return order[index % order.length];
}

export function IconTile({
  icon: Icon,
  tone = "teal",
  className,
}: {
  icon: LucideIcon;
  tone?: TileTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
        TILE_TONES[tone],
        className
      )}
    >
      <Icon className="h-[21px] w-[21px]" strokeWidth={1.8} aria-hidden="true" />
    </span>
  );
}

/** The small uppercase pill that opens each section. */
export function SectionLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full bg-accent px-3 py-1.5",
        "text-[10px] font-bold uppercase tracking-[0.14em] text-accent-foreground",
        className
      )}
    >
      {children}
    </span>
  );
}

/**
 * Centred section heading — label, title, optional lede.
 *
 * `as` exists because heading rank is a document-structure decision, not a
 * styling one: the page has exactly one `h1`, so sections pass `h2` and
 * sub-sections `h3` without the type size changing.
 */
export function SectionHeading({
  label,
  title,
  lede,
  align = "center",
  as: Tag = "h2",
  className,
}: {
  label?: string;
  title: ReactNode;
  lede?: ReactNode;
  align?: "center" | "left";
  as?: "h2" | "h3";
  className?: string;
}) {
  const centered = align === "center";

  return (
    <div
      className={cn(
        centered ? "mx-auto max-w-2xl text-center" : "max-w-xl",
        className
      )}
    >
      {label ? <SectionLabel>{label}</SectionLabel> : null}
      <Tag
        className={cn(
          "text-balance font-extrabold tracking-tightest",
          "text-[27px] leading-[1.15] sm:text-[33px] lg:text-[38px]",
          label && "mt-5"
        )}
      >
        {title}
      </Tag>
      {lede ? (
        <p
          className={cn(
            "mt-4 text-pretty text-[14px] leading-relaxed text-muted-foreground sm:text-[15px]",
            centered && "mx-auto max-w-xl"
          )}
        >
          {lede}
        </p>
      ) : null}
    </div>
  );
}

/** Bordered surface card used for features, steps and testimonial slots. */
export function PanelCard({
  children,
  className,
  interactive = false,
}: {
  children: ReactNode;
  className?: string;
  /** Adds hover affordance. Only for cards that are actually a link. */
  interactive?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-border bg-card p-5 sm:p-6",
        interactive && "transition-colors hover:border-primary/40 hover:bg-muted/40",
        className
      )}
    >
      {children}
    </div>
  );
}

/**
 * A single numbered step. The connector arrow between steps is drawn by the
 * parent grid, not here, so it can be hidden when the steps stack on mobile.
 */
export function StepItem({
  number,
  icon,
  tone,
  title,
  copy,
}: {
  number: number;
  icon: LucideIcon;
  tone: TileTone;
  title: string;
  copy: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <IconTile icon={icon} tone={tone} />
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">
          {number}
        </span>
      </div>
      <div>
        <h3 className="text-[15px] font-bold tracking-tight">{title}</h3>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          {copy}
        </p>
      </div>
    </div>
  );
}

/**
 * Checked list item. `CheckIcon` is passed in rather than imported so this file
 * stays free of a lucide dependency it would otherwise only need once.
 */
export function CheckItem({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-chart-2/15 text-chart-2">
        <Icon className="h-3 w-3" strokeWidth={3} aria-hidden="true" />
      </span>
      <span className="text-[14px] leading-relaxed text-foreground/85">
        {children}
      </span>
    </li>
  );
}
