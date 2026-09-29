import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full font-semibold uppercase tracking-[0.1em] transition-colors",
  {
    variants: {
      variant: {
        default: "bg-accent text-accent-foreground",
        outline: "border border-border bg-background text-muted-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        destructive: "bg-destructive text-destructive-foreground",
        /*
         * Token-driven rather than the former `text-brand-100`, a fixed pale
         * green that lost contrast against the dark-mode panel.
         */
        onDark: "bg-panel-foreground/10 text-panel-muted",
      },
      size: {
        default: "px-3 py-1.5 text-[11px]",
        sm: "px-2.5 py-1 text-[10px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, size, ...props }: BadgeProps) {
  return (
    <span
      className={cn(badgeVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
