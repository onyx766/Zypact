import type { ScopeNote } from "@/components/landing/types";

/** STUB — replaced by the outcomes build. Keep the props interface. */
export interface ScopeProps {
  id: string;
  notes: readonly ScopeNote[];
}

export function Scope({ id, notes }: ScopeProps) {
  return (
    <section id={id} className="py-24">
      <div className="shell grid gap-6 lg:grid-cols-2">
        {notes.map((note) => (
          <div key={note.title} className="lx-card p-8">
            <p className="lx-eyebrow">{note.label}</p>
            <h2 className="lx-display mt-4 text-[26px]">{note.title}</h2>
            <p className="lx-lede mt-4">{note.copy}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
