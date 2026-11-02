import { SectionHeading } from "@/components/landing/section-heading";
import type { ContactPerson } from "@/components/landing/types";

/** STUB — replaced by the chrome build. Keep the props interface. */
export interface ContactProps {
  id: string;
  eyebrow: string;
  title: string;
  copy: string;
  people: readonly ContactPerson[];
}

export function Contact({ id, eyebrow, title, copy, people }: ContactProps) {
  return (
    <section id={id} className="py-24">
      <div className="shell grid gap-10 lg:grid-cols-2">
        <SectionHeading eyebrow={eyebrow} title={title} lede={copy} />
        <div className="grid gap-4 sm:grid-cols-2">
          {people.map((person) => (
            <div key={person.email} className="lx-card p-6">
              <p className="lx-display text-[22px]">{person.name}</p>
              <p className="text-[13px]">{person.role}</p>
              <a href={`mailto:${person.email}`}>{person.email}</a>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
