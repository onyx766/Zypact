import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Standard shadcn/ui label.
 *
 * shadcn's own version wraps @radix-ui/react-label. That package is not a
 * dependency here and a plain `<label>` carries the same semantics for the
 * `htmlFor` association, so this stays dependency-free. If a pasted component
 * needs Radix's `Label` behaviour specifically, install
 * `@radix-ui/react-label` and swap the implementation — the export name and
 * props are already the ones such a component expects.
 */
const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(({ className, ...props }, ref) => (
  <label
    ref={ref}
    className={cn(
      "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
      className
    )}
    {...props}
  />
));
Label.displayName = "Label";

export { Label };
