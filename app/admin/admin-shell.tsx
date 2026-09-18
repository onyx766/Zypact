import type { ReactNode } from "react";
import {
  ChartColumn,
  FileText,
  FlaskConical,
  Settings,
  ScrollText,
} from "lucide-react";

import "./admin.css";

/**
 * Sidebar + topbar chrome for the founder console.
 *
 * Analytics, Reports and Settings have no routes yet, so they render as
 * disabled items rather than links: a nav entry that 404s is worse than one
 * that says plainly it does not exist.
 */

export type AdminNavKey = "requests" | "interventions";

interface NavEntry {
  key: string;
  label: string;
  href: string | null;
  icon: ReactNode;
}

const NAV: NavEntry[] = [
  {
    key: "requests",
    label: "Snapshot requests",
    href: "/admin/snapshot-requests",
    icon: <ScrollText size={17} strokeWidth={1.8} />,
  },
  {
    key: "interventions",
    label: "Interventions",
    href: "/admin/interventions",
    icon: <FlaskConical size={17} strokeWidth={1.8} />,
  },
  {
    key: "analytics",
    label: "Analytics",
    href: null,
    icon: <ChartColumn size={17} strokeWidth={1.8} />,
  },
  {
    key: "reports",
    label: "Reports",
    href: null,
    icon: <FileText size={17} strokeWidth={1.8} />,
  },
  {
    key: "settings",
    label: "Settings",
    href: null,
    icon: <Settings size={17} strokeWidth={1.8} />,
  },
];

export interface AdminHealth {
  /** Green when nothing needs a human; amber when a run is stuck or blocked. */
  ok: boolean;
  title: string;
  note: string;
}

export function AdminShell({
  email,
  active,
  health,
  children,
}: {
  email: string | null;
  active: AdminNavKey;
  health: AdminHealth;
  children: ReactNode;
}) {
  return (
    <div className="zpa-root">
      <aside className="zpa-sidebar">
        <div className="zpa-brand">
          <p className="zpa-brand-name">Zypact</p>
          <p className="zpa-brand-sub">Founder operations</p>
        </div>

        <nav className="zpa-nav">
          {NAV.map((entry) =>
            entry.href ? (
              <a
                key={entry.key}
                href={entry.href}
                className={`zpa-nav-item${
                  entry.key === active ? " is-active" : ""
                }`}
                aria-current={
                  entry.key === active ? "page" : undefined
                }
              >
                {entry.icon}
                {entry.label}
              </a>
            ) : (
              <span
                key={entry.key}
                className="zpa-nav-item is-disabled"
                aria-disabled="true"
              >
                {entry.icon}
                {entry.label}
                <span className="zpa-nav-soon">Soon</span>
              </span>
            )
          )}
        </nav>

        <div className="zpa-sidebar-foot">
          <div
            className={`zpa-health${health.ok ? "" : " is-warn"}`}
          >
            <span className="zpa-health-dot" />
            <div>
              <p className="zpa-health-title">{health.title}</p>
              <p className="zpa-health-note">{health.note}</p>
            </div>
          </div>
        </div>
      </aside>

      <div className="zpa-main">
        <header className="zpa-topbar">
          {email ? (
            <span className="zpa-topbar-email">{email}</span>
          ) : null}
          <a href="/auth/logout" className="zpa-btn zpa-btn-sm">
            Sign out
          </a>
        </header>

        <div className="zpa-content">{children}</div>
      </div>
    </div>
  );
}
