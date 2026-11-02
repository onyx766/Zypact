import {
  ExampleAnswer,
  RetestComparison,
} from "@/components/marketing/answer-evidence";
import { SectionHeading } from "@/components/landing/section-heading";
import type { SectionCopy } from "@/components/landing/types";

export type EvidenceProps = SectionCopy;

export function Evidence({ id, eyebrow, title, lede }: EvidenceProps) {
  return (
    <section id={id} className="lx-evidence relative py-24 lg:py-28">
      <div className="shell">
        <SectionHeading
          eyebrow={eyebrow}
          title={title}
          lede={lede}
          className="lg:max-w-[640px]"
        />
        <div
          data-stagger="160"
          className="mt-12 grid items-start gap-6 lg:mt-14 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:gap-7"
        >
          <div data-reveal="left">
            <div data-tilt="8">
              <ExampleAnswer />
            </div>
          </div>
          <div data-reveal="right">
            <div data-tilt="8">
              <RetestComparison />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
