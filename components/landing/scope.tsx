import type { ScopeNote } from "@/components/landing/types";

export interface ScopeProps {
  id: string;
  notes: readonly ScopeNote[];
}

export function Scope({ id, notes }: ScopeProps) {
  return (
    <section id={id} className="lx-scope relative py-16 lg:py-20">
      <div
        data-stagger="140"
        className="shell grid gap-5 lg:grid-cols-2 lg:gap-6"
      >
        {notes.map((note) => (
          <div key={note.title} data-reveal="rotate">
            <article
              data-tilt="10"
              className="lx-card lx-card--soft lx-scope-note p-7 lg:p-9"
            >
              <p className="lx-eyebrow">{note.label}</p>
              <h2 className="lx-display mt-4 text-[26px] leading-[1.15] lg:text-[28px]">
                {note.title}
              </h2>
              <p className="mt-4 text-[14px] leading-[1.65] text-muted-foreground">
                {note.copy}
              </p>
            </article>
          </div>
        ))}
      </div>
    </section>
  );
}
