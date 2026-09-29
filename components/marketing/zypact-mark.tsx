import { cn } from "@/lib/utils";

/**
 * Inline version of public/zypact-logo.svg (symbol only) so the mark can inherit
 * currentColor for light and dark surfaces. The wordmark is set in type.
 *
 * `dotFill` paints the three joint circles so they read as punched out of the
 * surface behind the mark, which means it has to match that surface. It
 * defaults to the theme background token rather than a fixed white, so the
 * dots follow light and dark instead of staying a pale rectangle on a dark
 * page. A caller sitting on a different surface passes that surface's token —
 * see SiteHeader, which sits on `surface-subtle`.
 */
export function ZypactMark({
  className,
  dotFill = "hsl(var(--background))",
}: {
  className?: string;
  dotFill?: string;
}) {
  return (
    <svg
      viewBox="27 33 134 134"
      className={cn("h-7 w-7", className)}
      role="img"
      aria-label="Zypact"
      focusable="false"
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth={12}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M42 48 H142 L46 150 H146" />
        <circle cx="42" cy="48" r="13" fill={dotFill} />
        <circle cx="94" cy="100" r="13" fill={dotFill} />
        <circle cx="146" cy="150" r="13" fill={dotFill} />
      </g>
    </svg>
  );
}

export function ZypactWordmark({
  className,
  dotFill,
  href = "/",
}: {
  className?: string;
  dotFill?: string;
  href?: string;
}) {
  return (
    <a
      href={href}
      aria-label="Zypact home"
      className={cn(
        "inline-flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className
      )}
    >
      <ZypactMark dotFill={dotFill} />
      <span className="text-[19px] font-bold tracking-tightest">Zypact</span>
    </a>
  );
}
