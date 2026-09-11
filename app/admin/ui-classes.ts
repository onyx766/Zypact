import { cn } from "@/lib/utils";

/**
 * Shared Tailwind class sets for the founder console.
 *
 * They only take effect inside AdminThemeRoot (`.v2-root`), where the
 * Tailwind build is scoped. Every colour resolves through the theme tokens in
 * admin-theme.css, so one class list serves light and dark. A plain module on
 * purpose: server pages and client components both import it.
 */

const button =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export const ui = {
  btnPrimary: cn(
    button,
    "h-10 px-4 bg-primary text-primary-foreground hover:bg-primary/90"
  ),
  btnOutline: cn(
    button,
    "h-10 px-4 border border-border bg-card text-foreground hover:bg-muted"
  ),
  btnDanger: cn(
    button,
    "h-10 px-4 border border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15"
  ),
  btnSm: "h-8 px-3 text-xs",
  panel: "rounded-2xl border border-border bg-card text-card-foreground",
  subPanel: "rounded-xl border border-border bg-background/60",
  input:
    "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
  label:
    "text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground",
  code: "rounded bg-muted px-1.5 py-0.5 font-mono text-[12px] text-foreground",
  pill: "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em]",
  chip: "inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/60 px-2.5 py-1 text-xs text-muted-foreground",
};

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

export const toneClass: Record<Tone, string> = {
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning",
  danger: "border-destructive/30 bg-destructive/10 text-destructive",
  info: "border-info/30 bg-info/10 text-info",
  neutral: "border-border bg-muted text-muted-foreground",
};

export const dotClass: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  info: "bg-info",
  neutral: "bg-muted-foreground",
};

export function humanize(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function requestStatusTone(status: string): Tone {
  switch (status) {
    case "approved":
    case "report_ready":
      return "success";
    case "pending_verification":
    case "pending_approval":
    case "quality_review":
    case "needs_founder_review":
      return "warning";
    case "verified":
    case "queued":
    case "running":
      return "info";
    case "qa_failed":
    case "failed":
    case "rejected":
      return "danger";
    default:
      return "neutral";
  }
}

/** Presentation for the canonical integrity decision on a report artifact. */
export const INTEGRITY_PRESENTATION: Record<
  string,
  { label: string; tone: Tone }
> = {
  integrity_passed: { label: "Integrity passed", tone: "success" },
  needs_review: { label: "Needs review", tone: "warning" },
  blocked: { label: "Blocked", tone: "danger" },
};
