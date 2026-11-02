import type { ReactNode } from "react";

import { SectionHeading } from "@/components/landing/section-heading";
import type { IconCopy, SectionCopy } from "@/components/landing/types";

/** STUB — replaced by the evidence build. Keep the props interface. */
export interface ReportProps extends SectionCopy {
  /** Title of the synthetic report preview card, e.g. "AI answer snapshot". */
  cardTitle: string;
  /** Small label on the preview card, e.g. "Synthetic preview". */
  cardLabel: string;
  items: readonly IconCopy[];
  /** The delivery-gate block, rendered in app/page.tsx (guarded there). */
  children: ReactNode;
}

export function Report({ id, eyebrow, title, lede, cardTitle, cardLabel, items, children }: ReportProps) {
  return (
    <section id={id} className="py-24">
      <div className="shell grid gap-10 lg:grid-cols-2">
        <div className="lx-card p-6">
          <p>{cardTitle}</p>
          <span className="lx-synthetic">{cardLabel}</span>
          <ul className="mt-4 grid gap-2">
            {items.map((item) => (
              <li key={item.title}>{item.title}</li>
            ))}
          </ul>
        </div>
        <div>
          <SectionHeading eyebrow={eyebrow} title={title} lede={lede} />
          <ul className="mt-8 grid gap-4">
            {items.map((item) => (
              <li key={item.title}>
                <strong>{item.title}</strong> {item.copy}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="shell mt-12">{children}</div>
    </section>
  );
}
