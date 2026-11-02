import type { ReactNode } from "react";

import { SectionHeading } from "@/components/landing/section-heading";
import type { SectionCopy } from "@/components/landing/types";

/**
 * The questions themselves are native <details> rendered in app/page.tsx,
 * where the guard test looks for them; this only frames them.
 */
export interface FaqSectionProps extends SectionCopy {
  children: ReactNode;
}

export function FaqSection({ id, eyebrow, title, lede, children }: FaqSectionProps) {
  return (
    <section id={id} className="lx-faq-section relative py-20 lg:py-24">
      <div className="shell grid gap-10 lg:grid-cols-[minmax(0,0.42fr)_minmax(0,0.58fr)] lg:items-start lg:gap-14">
        <SectionHeading
          eyebrow={eyebrow}
          title={title}
          lede={lede}
          className="lg:sticky lg:top-[108px]"
          titleClassName="lg:text-[42px]"
        />
        <div>{children}</div>
      </div>
    </section>
  );
}
