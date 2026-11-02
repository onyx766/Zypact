import { Mail } from "lucide-react";

import { SectionHeading } from "@/components/landing/section-heading";
import type { ContactPerson } from "@/components/landing/types";
import { cn } from "@/lib/utils";

export interface ContactProps {
  id: string;
  eyebrow: string;
  title: string;
  copy: string;
  people: readonly ContactPerson[];
}

const CARD_TONES = ["teal", "amber"] as const;

export function Contact({ id, eyebrow, title, copy, people }: ContactProps) {
  return (
    <section id={id} className="lx-contact relative py-20 lg:py-24">
      <div className="shell grid gap-10 lg:grid-cols-[minmax(0,0.9fr)_1px_minmax(0,1.1fr)] lg:items-center lg:gap-14">
        <SectionHeading
          eyebrow={eyebrow}
          title={title}
          lede={copy}
          titleClassName="lg:text-[42px]"
        />

        <span
          aria-hidden="true"
          data-reveal="mask"
          className="lx-method-divider hidden min-h-[132px] self-stretch lg:block"
        />

        <ul role="list" data-stagger="130" className="grid gap-4 sm:grid-cols-2">
          {people.map((person, index) => (
            <li key={person.email} data-reveal="rotate">
              <article
                data-tilt="16"
                className={cn(
                  "lx-card lx-contact-card h-full p-6",
                  `lx-contact-card--${CARD_TONES[index % CARD_TONES.length]}`
                )}
              >
                <h3 className="lx-display text-[24px] leading-[1.2]">
                  {person.name}
                </h3>
                <p className="mt-1.5 text-[13px] text-muted-foreground">
                  {person.role}
                </p>
                <a href={`mailto:${person.email}`} className="lx-contact-mail">
                  <Mail aria-hidden="true" strokeWidth={1.75} />
                  {person.email}
                </a>
              </article>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
