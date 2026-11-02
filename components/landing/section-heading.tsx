import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The eyebrow / display title / lede stack that opens every landing section.
 *
 * Presentational only — copy arrives from app/page.tsx. The three lines
 * reveal in sequence (`data-stagger`), the title sharpening out of a blur.
 * `as` exists because heading rank is a document-structure decision: the page
 * has one h1 (the hero), so sections pass h2.
 */
export function SectionHeading({
  eyebrow,
  title,
  lede,
  align = "left",
  as: Tag = "h2",
  className,
  titleClassName,
  children,
}: {
  eyebrow?: string;
  title: ReactNode;
  lede?: ReactNode;
  align?: "left" | "center";
  as?: "h2" | "h3";
  className?: string;
  /** Overrides the default display size, e.g. for a narrower column. */
  titleClassName?: string;
  /** Rendered after the lede, inside the same stagger group. */
  children?: ReactNode;
}) {
  const centered = align === "center";

  return (
    <div
      data-stagger="110"
      className={cn(
        centered ? "mx-auto max-w-2xl text-center" : "max-w-xl",
        className
      )}
    >
      {eyebrow ? (
        <p className="lx-eyebrow" data-reveal>
          {eyebrow}
        </p>
      ) : null}
      <Tag
        data-reveal="blur"
        className={cn(
          "lx-display text-[34px] leading-[1.06] sm:text-[42px] lg:text-[48px]",
          eyebrow && "mt-5",
          titleClassName
        )}
      >
        {title}
      </Tag>
      {lede ? (
        <p
          data-reveal
          className={cn("lx-lede mt-5", centered && "mx-auto max-w-xl")}
        >
          {lede}
        </p>
      ) : null}
      {children}
    </div>
  );
}
