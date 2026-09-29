import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Standard shadcn/ui skeleton.
 *
 * The pulse is suppressed for visitors who ask their OS to reduce motion by the
 * `prefers-reduced-motion` block in app/tailwind.css, which zeroes animation
 * duration across `.v2-root`.
 */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
