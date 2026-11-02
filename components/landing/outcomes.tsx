import { SectionHeading } from "@/components/landing/section-heading";
import type { OutcomeCopy, SectionCopy } from "@/components/landing/types";
import type { OutcomeStatus } from "@/lib/reports/compare-protocols";
import { cn } from "@/lib/utils";

export interface OutcomesProps extends SectionCopy {
  outcomes: readonly OutcomeCopy[];
}

/** The same tint per status as the hero preview's STATUS_TONE. */
const OUTCOME_TONE: Record<OutcomeStatus, string> = {
  increase_observed: "mint",
  decrease_observed: "rose",
  no_clear_change: "slate",
  inconclusive: "sand",
};

export function Outcomes({ id, eyebrow, title, lede, outcomes }: OutcomesProps) {
  return (
    <section id={id} className="lx-outcomes relative py-24 lg:py-28">
      <div className="shell grid gap-12 lg:grid-cols-[minmax(0,0.38fr)_minmax(0,0.62fr)] lg:items-center lg:gap-14">
        <SectionHeading
          eyebrow={eyebrow}
          title={title}
          lede={lede}
          titleClassName="lg:text-[42px]"
        />

        <ul role="list" data-stagger="110" className="grid gap-4 sm:grid-cols-2">
          {outcomes.map((outcome) => {
            const Icon = outcome.icon;

            return (
              <li key={outcome.code} data-reveal="rotate">
                <article
                  data-flip
                  tabIndex={0}
                  className={cn(
                    "lx-flip lx-outcome h-full",
                    `lx-outcome--${OUTCOME_TONE[outcome.code]}`
                  )}
                >
                  <div className="lx-flip__inner">
                    <div className="lx-flip__face lx-outcome__face">
                      <span className="lx-outcome__icon" aria-hidden="true">
                        <Icon strokeWidth={2} />
                      </span>
                      <div className="min-w-0">
                        <h3 className="text-[16px] font-bold leading-[1.3] tracking-[-0.01em] text-foreground">
                          {outcome.label}
                        </h3>
                        <p className="mt-2 text-[13px] leading-[1.55] text-muted-foreground">
                          {outcome.copy}
                        </p>
                      </div>
                    </div>

                    <div className="lx-flip__face lx-flip__face--back lx-outcome__face lx-outcome__face--back">
                      <p className="lx-outcome__code">{outcome.code}</p>
                      <p className="mt-2 text-[13px] leading-[1.55] text-foreground">
                        {outcome.rule}
                      </p>
                    </div>
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
