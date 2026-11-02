import type { ReactNode } from "react";
import { Check } from "lucide-react";

import { SectionHeading } from "@/components/landing/section-heading";
import type { IconCopy, SectionCopy } from "@/components/landing/types";
import { ZypactMark } from "@/components/marketing/zypact-mark";
import { cn } from "@/lib/utils";

export interface ReportProps extends SectionCopy {
  /** Title of the synthetic report preview card, e.g. "AI answer snapshot". */
  cardTitle: string;
  /** Small label on the preview card, e.g. "Synthetic preview". */
  cardLabel: string;
  items: readonly IconCopy[];
  /** The delivery-gate block, rendered in app/page.tsx (guarded there). */
  children: ReactNode;
}

export function Report({
  id,
  eyebrow,
  title,
  lede,
  cardTitle,
  cardLabel,
  items,
  children,
}: ReportProps) {
  const last = items.length - 1;

  return (
    <section id={id} className="lx-report relative py-24 lg:py-28">
      <div className="shell">
        <div className="grid gap-14 lg:grid-cols-[minmax(0,0.42fr)_minmax(0,0.58fr)] lg:items-center lg:gap-16">
          <div className="lx-report-visual" data-reveal="rotate">
            <span className="lx-report-plate" aria-hidden="true" />
            <div className="lx-report-card" data-tilt="18" data-tilt-glare>
              <div className="lx-report-card__head">
                <span className="lx-report-card__brand">
                  <ZypactMark
                    className="h-[16px] w-[16px]"
                    dotFill="hsl(var(--card))"
                  />
                  Zypact
                </span>
                <span className="lx-synthetic">{cardLabel}</span>
              </div>
              <p className="lx-report-card__title">{cardTitle}</p>
              {/* The list beside this card carries the same items as text. */}
              <ul className="lx-report-rows" aria-hidden="true">
                {items.map((item, index) => {
                  const Icon = item.icon;
                  return (
                    <li
                      key={item.title}
                      className={cn(
                        "lx-report-row",
                        index === last && "lx-report-row--accent"
                      )}
                    >
                      <Icon strokeWidth={1.9} />
                      {item.title}
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>

          <div>
            <SectionHeading
              eyebrow={eyebrow}
              title={title}
              lede={lede}
              className="max-w-none lg:max-w-[620px]"
            />
            <ul role="list" data-stagger="80" className="lx-report-list mt-8">
              {items.map((item) => (
                <li key={item.title} data-reveal className="lx-report-item">
                  <Check aria-hidden="true" strokeWidth={2.4} />
                  <span className="lx-report-item__title">{item.title}</span>
                  <span className="lx-report-item__copy">{item.copy}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-14 lg:mt-16">{children}</div>
      </div>
    </section>
  );
}
