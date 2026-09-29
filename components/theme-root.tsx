import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Theme + Tailwind root for any surface built on the token system, and the
 * wrapper new UI copied in from the 21st.dev registry should be dropped inside.
 *
 * Two nested elements, and the nesting is load-bearing:
 *
 *  - The OUTER element carries `.v2-root`. That is the `important` selector in
 *    tailwind.config.ts, so Tailwind emits every utility as `.v2-root .foo` —
 *    a *descendant* selector. Utilities therefore do not apply to this element
 *    itself, which is why it takes no classes of its own and why the theme
 *    class and any caller styling go on the inner element.
 *  - The INNER element carries `.dark` (or not) plus the background/foreground
 *    utilities. Tokens cascade by custom-property inheritance, so everything
 *    below it resolves against the chosen palette.
 *
 * Deliberately NOT a client component: no state is involved, so server pages
 * such as app/page.tsx can wrap themselves without becoming client-rendered.
 * The founder console needs a runtime toggle and keeps its own AdminThemeRoot
 * in app/admin/theme.tsx, which follows this same two-element shape.
 *
 * Dark is the default. `:root` still holds the light values and `.dark` the
 * dark ones — the convention registry components and `dark:` variants rely on —
 * so dark-first is expressed by what this renders, not by inverting the tokens.
 */
export function ThemeRoot({
  children,
  theme = "dark",
  className,
}: {
  children: ReactNode;
  /** Defaults to `"dark"`. Pass `"light"` for a light-rendered surface. */
  theme?: "light" | "dark";
  /** Applied to the inner themed element, not the `.v2-root` wrapper. */
  className?: string;
}) {
  return (
    <div className="v2-root">
      <div
        className={cn(
          "bg-background text-foreground antialiased",
          theme === "dark" && "dark",
          className
        )}
        style={{ colorScheme: theme }}
      >
        {children}
      </div>
    </div>
  );
}
