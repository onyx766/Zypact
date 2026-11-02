import type { LandingLink } from "@/components/landing/types";

/** STUB — replaced by the chrome build. Keep the props interface. */
export interface CtaBandProps {
  title: string;
  copy: string;
  cta: LandingLink;
}

export function CtaBand({ title, copy, cta }: CtaBandProps) {
  return (
    <section className="py-16">
      <div className="shell">
        <div className="lx-on-dark rounded-3xl bg-[hsl(var(--panel))] p-10">
          <h2 className="lx-display text-[36px]">{title}</h2>
          <p className="lx-lede mt-4">{copy}</p>
          <a className="lx-btn lx-btn--light mt-6" href={cta.href}>
            {cta.label}
          </a>
        </div>
      </div>
    </section>
  );
}
