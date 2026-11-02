import {
  ExampleAnswer,
  RetestComparison,
} from "@/components/marketing/answer-evidence";
import { SectionHeading } from "@/components/landing/section-heading";
import type { SectionCopy } from "@/components/landing/types";

/** STUB — replaced by the evidence build. Keep the props interface. */
export type EvidenceProps = SectionCopy;

export function Evidence({ id, eyebrow, title, lede }: EvidenceProps) {
  return (
    <section id={id} className="py-24">
      <div className="shell">
        <SectionHeading eyebrow={eyebrow} title={title} lede={lede} />
        <div className="mt-10 grid gap-6 lg:grid-cols-2">
          <ExampleAnswer />
          <RetestComparison />
        </div>
      </div>
    </section>
  );
}
