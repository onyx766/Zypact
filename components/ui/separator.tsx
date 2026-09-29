import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Standard shadcn/ui separator, without the @radix-ui/react-separator
 * dependency. `role="none"` on a decorative separator is what Radix emits, and
 * it keeps a purely visual rule out of the accessibility tree.
 */
const Separator = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    orientation?: "horizontal" | "vertical";
    decorative?: boolean;
  }
>(
  (
    { className, orientation = "horizontal", decorative = true, ...props },
    ref
  ) => (
    <div
      ref={ref}
      role={decorative ? "none" : "separator"}
      aria-orientation={decorative ? undefined : orientation}
      className={cn(
        "shrink-0 bg-border",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className
      )}
      {...props}
    />
  )
);
Separator.displayName = "Separator";

export { Separator };
