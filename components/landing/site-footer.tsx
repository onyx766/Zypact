import { ZypactWordmark } from "@/components/marketing/zypact-mark";
import type { FooterColumn } from "@/components/landing/types";

export interface SiteFooterProps {
  tagline: string;
  columns: readonly FooterColumn[];
  /** Guarded: "… Launched by Zypact after approval …". */
  bottomLine: string;
  copyright: string;
}

export function SiteFooter({ tagline, columns, bottomLine, copyright }: SiteFooterProps) {
  return (
    <footer className="lx-on-dark lx-footer relative z-[1]">
      <div className="shell grid gap-10 pb-12 pt-14 lg:grid-cols-[minmax(0,0.36fr)_minmax(0,0.64fr)] lg:gap-14">
        <div className="lx-footer__brand">
          <ZypactWordmark dotFill="hsl(var(--panel))" />
          <p className="mt-4 max-w-[300px] text-[13.5px] leading-[1.6]">
            {tagline}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
          {columns.map((column) => (
            <nav key={column.heading} aria-label={column.heading}>
              <p className="text-[13px] font-semibold">{column.heading}</p>
              <ul role="list" className="mt-3.5 grid gap-2.5">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <a href={link.href} className="lx-footer__link">
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
      </div>

      <div className="lx-footer__rule">
        <div className="shell flex flex-wrap justify-between gap-x-6 gap-y-2 py-5 text-[12px]">
          <p>{bottomLine}</p>
          <p>{copyright}</p>
        </div>
      </div>
    </footer>
  );
}
