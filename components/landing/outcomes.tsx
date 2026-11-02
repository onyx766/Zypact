import { SectionHeading } from "@/components/landing/section-heading";
import type { OutcomeCopy, SectionCopy } from "@/components/landing/types";

/** STUB — replaced by the outcomes build. Keep the props interface. */
export interface OutcomesProps extends SectionCopy {
  outcomes: readonly OutcomeCopy[];
}

export function Outcomes({ id, eyebrow, title, lede, outcomes }: OutcomesProps) {
  return (
    <section id={id} className="py-24">
      <div className="shell grid gap-10 lg:grid-cols-2">
        <SectionHeading eyebrow={eyebrow} title={title} lede={lede} />
        <div className="grid gap-4 sm:grid-cols-2">
          {outcomes.map((outcome) => (
            <article key={outcome.code} className="lx-card p-6">
              <outcome.icon className="h-6 w-6" aria-hidden="true" />
              <h3 className="mt-3 text-[16px] font-semibold">{outcome.label}</h3>
              <p className="mt-2 text-[13px]">{outcome.copy}</p>
              <p className="mt-2 font-mono text-[11px]">{outcome.code}</p>
              <p className="mt-2 text-[12px]">{outcome.rule}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
