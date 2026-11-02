import { ArrowRight } from "lucide-react";

import { RidgeCanvas } from "@/components/landing/canvas/ridge-canvas";
import type { LandingLink } from "@/components/landing/types";

export interface CtaBandProps {
  title: string;
  copy: string;
  cta: LandingLink;
}

export function CtaBand({ title, copy, cta }: CtaBandProps) {
  return (
    <section className="relative pb-6 pt-4 lg:pb-10">
      <div className="shell">
        <div className="lx-on-dark lx-cta" data-reveal="scale" data-spotlight>
          <div className="lx-cta__ridge" aria-hidden="true">
            <RidgeCanvas variant="night" />
          </div>
          <div className="lx-cta__body">
            <div className="max-w-[640px]">
              <h2 className="lx-display text-[30px] leading-[1.1] sm:text-[38px] lg:text-[42px]">
                {title}
              </h2>
              <p className="lx-lede mt-4">{copy}</p>
            </div>
            <a
              href={cta.href}
              className="lx-btn lx-btn--light w-full shrink-0 sm:w-auto"
              data-magnetic="8"
            >
              {cta.label}
              <ArrowRight
                className="lx-btn__arrow"
                strokeWidth={2}
                aria-hidden="true"
              />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
