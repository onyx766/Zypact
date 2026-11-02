import type { ReactNode } from "react";

import { SectionHeading } from "@/components/landing/section-heading";
import type { SectionCopy } from "@/components/landing/types";

/**
 * STUB — replaced by the chrome build. Keep the props interface.
 * The questions themselves are native <details> rendered in app/page.tsx,
 * where the guard test looks for them; this only frames them.
 */
export interface FaqSectionProps extends SectionCopy {
  children: ReactNode;
}

export function FaqSection({ id, eyebrow, title, lede, children }: FaqSectionProps) {
  return (
    <section id={id} className="py-24">
      <div className="shell grid gap-10 lg:grid-cols-[0.8fr_1.2fr]">
        <SectionHeading eyebrow={eyebrow} title={title} lede={lede} />
        <div>{children}</div>
      </div>
    </section>
  );
}
