import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Standard shadcn/ui input. Added because registry form components import
 * `@/components/ui/input` by name, so a paste fails without it.
 *
 * Placeholder colour comes from the scoped preflight in app/tailwind.css rather
 * than a utility here, so a caller's own `placeholder:` class still wins.
 */
const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, ...props }, ref) => (
  <input
    type={type}
    ref={ref}
    className={cn(
      "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
      "file:border-0 file:bg-transparent file:text-sm file:font-medium",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive",
      className
    )}
    {...props}
  />
));
Input.displayName = "Input";

export { Input };
