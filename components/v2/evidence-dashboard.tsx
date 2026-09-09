import {
  Database,
  FileSearch,
  FileText,
  LayoutDashboard,
  Settings,
  CircleCheck,
} from "lucide-react";

import { ZypactMark } from "@/components/v2/zypact-mark";

/**
 * Synthetic product preview for the hero. Every value here is illustrative and
 * labelled as such — it is not a customer record and not a live probe result.
 *
 * The chart deliberately shows attempt reconciliation (preserved / retried /
 * excluded runs) rather than a headline score: V1 reports prompt-scoped
 * observations and must keep failed and excluded attempts visible in the
 * denominator. It must never present a single universal visibility number.
 */

const TOTAL_RUNS = 14;

const segments = [
  { label: "Preserved", value: 12, color: "#0E4A38" },
  { label: "Retried", value: 1, color: "#E0A33C" },
  { label: "Excluded", value: 1, color: "#CF4B3B" },
] as const;

const RADIUS = 42;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const GAP = 3;

const sidebarItems = [
  { label: "Overview", icon: LayoutDashboard, active: true },
  { label: "Questions", icon: FileSearch, active: false },
  { label: "Evidence", icon: Database, active: false },
  { label: "Outcomes", icon: FileText, active: false },
  { label: "Settings", icon: Settings, active: false },
] as const;

const activity = [
  { label: "Baseline evidence preserved", time: "2 hours ago", icon: Database },
  { label: "Intervention registered", time: "5 hours ago", icon: FileText },
  { label: "Observation window opened", time: "1 day ago", icon: CircleCheck },
] as const;

function Donut() {
  let cursor = 0;

  return (
    <div className="relative h-[124px] w-[124px] shrink-0">
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
        <circle
          cx="50"
          cy="50"
          r={RADIUS}
          fill="none"
          stroke="#EDF2EF"
          strokeWidth="11"
        />
        {segments.map((segment) => {
          const length = (segment.value / TOTAL_RUNS) * CIRCUMFERENCE;
          const offset = cursor;
          cursor += length;

          return (
            <circle
              key={segment.label}
              cx="50"
              cy="50"
              r={RADIUS}
              fill="none"
              stroke={segment.color}
              strokeWidth="11"
              strokeLinecap="round"
              strokeDasharray={`${Math.max(length - GAP, 0.5)} ${CIRCUMFERENCE}`}
              strokeDashoffset={-offset}
            />
          );
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[22px] font-bold leading-none tracking-tightest text-primary">
          {TOTAL_RUNS}
        </span>
        <span className="mt-1 text-[10px] font-medium text-muted-foreground">
          runs
        </span>
      </div>
    </div>
  );
}

export function EvidenceDashboard() {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-float">
      <div className="grid grid-cols-[112px_minmax(0,1fr)] sm:grid-cols-[136px_minmax(0,1fr)]">
        {/* Sidebar */}
        <div className="border-r border-border bg-surface-subtle p-3 sm:p-4">
          <div className="mb-5 flex items-center gap-2 px-1.5 pt-1 text-primary">
            <ZypactMark className="h-5 w-5" dotFill="#FAFBFA" />
            <span className="text-[13px] font-bold tracking-tightest">
              Zypact
            </span>
          </div>
          <nav className="space-y-0.5">
            {sidebarItems.map((item) => (
              <div
                key={item.label}
                className={
                  item.active
                    ? "flex items-center gap-2 rounded-md bg-accent px-2 py-1.5 text-[11px] font-semibold text-accent-foreground"
                    : "flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px] font-medium text-muted-foreground"
                }
              >
                <item.icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                <span className="truncate">{item.label}</span>
              </div>
            ))}
          </nav>
        </div>

        {/* Main panel */}
        <div className="space-y-3 bg-card p-3.5 sm:p-5">
          <div className="rounded-lg border border-border p-4">
            <div className="mb-1 flex items-center justify-between gap-3">
              <h3 className="text-[13px] font-semibold tracking-tight">
                Baseline evidence
              </h3>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[8px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Synthetic
              </span>
            </div>
            <div className="flex items-center gap-4">
              <Donut />
              <dl className="min-w-0 flex-1 space-y-2.5">
                {segments.map((segment) => (
                  <div
                    key={segment.label}
                    className="flex items-center gap-2 text-[11px]"
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: segment.color }}
                      aria-hidden="true"
                    />
                    <dt className="truncate text-muted-foreground">
                      {segment.label}
                    </dt>
                    <dd className="ml-auto font-semibold tabular-nums">
                      {segment.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>

          <div className="rounded-lg border border-border p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-[13px] font-semibold tracking-tight">
                Recent activity
              </h3>
              <span className="text-[10px] font-medium text-primary">
                View all
              </span>
            </div>
            <ul className="space-y-2.5">
              {activity.map((item) => (
                <li key={item.label} className="flex items-center gap-2.5">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-primary">
                    <item.icon className="h-3 w-3" strokeWidth={1.75} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
                    {item.label}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {item.time}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/*
        The synthetic disclosure lives inside the card: in the hero it would
        otherwise render dark-on-dark over the green panel behind the card.
      */}
      <p className="border-t border-border bg-surface-subtle px-4 py-3 text-[10px] leading-relaxed text-muted-foreground">
        Synthetic example — not customer data and not a live Perplexity probe.
        Failed and excluded attempts stay visible in the denominator.
      </p>
    </div>
  );
}
