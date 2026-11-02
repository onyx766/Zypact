import { ZypactWordmark } from "@/components/marketing/zypact-mark";
import type { FooterColumn } from "@/components/landing/types";

/** STUB — replaced by the chrome build. Keep the props interface. */
export interface SiteFooterProps {
  tagline: string;
  columns: readonly FooterColumn[];
  /** Guarded: "… Launched by Zypact after approval …". */
  bottomLine: string;
  copyright: string;
}

export function SiteFooter({ tagline, columns, bottomLine, copyright }: SiteFooterProps) {
  return (
    <footer className="lx-on-dark relative z-[1] bg-[hsl(var(--panel))]">
      <div className="shell grid gap-10 py-14 md:grid-cols-4">
        <div>
          <ZypactWordmark dotFill="hsl(var(--panel))" />
          <p className="mt-4 text-[13px]">{tagline}</p>
        </div>
        {columns.map((column) => (
          <nav key={column.heading} aria-label={column.heading}>
            <p className="text-[13px] font-semibold">{column.heading}</p>
            <ul className="mt-3 grid gap-2">
              {column.links.map((link) => (
                <li key={link.label}>
                  <a href={link.href}>{link.label}</a>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="shell flex flex-wrap justify-between gap-2 py-6 text-[12px]">
        <p>{bottomLine}</p>
        <p>{copyright}</p>
      </div>
    </footer>
  );
}
