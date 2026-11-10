import type { ReactNode } from "react";

import { ZypactLogo } from "@/components/zypact-logo";

import { SignOutButton } from "./account-form";
import "./workspace.css";

export type WorkspaceSection = "overview" | "website" | "profile" | "questions" | "sources" | "actions" | "reports";

const NAV: Array<{ id: WorkspaceSection; label: string; href: string; later?: boolean }> = [
  { id: "overview", label: "Overview", href: "/account" },
  { id: "website", label: "Website", href: "/account/website" },
  { id: "profile", label: "Brand profile", href: "/account/profile" },
  { id: "questions", label: "Questions", href: "/account/questions" },
  { id: "sources", label: "Sources", href: "/account/sources", later: true },
  { id: "actions", label: "Actions", href: "/account/actions" },
  { id: "reports", label: "Reports", href: "/account/reports" },
];

export function WorkspaceShell({
  active,
  workspaceName,
  email,
  children,
}: {
  active: WorkspaceSection;
  workspaceName: string;
  email: string;
  children: ReactNode;
}) {
  return (
    <div className="zw-root">
      <header className="zw-top">
        <div className="zw-top-left">
          <a href="/account" aria-label="Workspace overview">
            <ZypactLogo className="founder-login-logo" />
          </a>
          <span className="zw-workspace">{workspaceName}</span>
        </div>
        <div className="zw-top-left">
          <span className="zw-email">{email}</span>
          <div style={{ width: 110 }}>
            <SignOutButton />
          </div>
        </div>
      </header>
      <div className="zw-body">
        <nav className="zw-nav" aria-label="Workspace">
          {NAV.map((item) => (
            <a key={item.id} href={item.href} aria-current={item.id === active ? "page" : undefined}>
              <span>{item.label}</span>
              {item.later ? <span className="zw-nav-later">soon</span> : null}
            </a>
          ))}
        </nav>
        <main className="zw-main">{children}</main>
      </div>
    </div>
  );
}

/** A section that arrives in a later phase: says what it will hold, shows nothing invented. */
export function LaterSection({ title, lede, points }: { title: string; lede: string; points: string[] }) {
  return (
    <>
      <h1 className="zw-h1">{title}</h1>
      <p className="zw-lede">{lede}</p>
      <section className="zw-card zw-later">
        <h2>Coming in a later phase</h2>
        <p>This section fills once your buyer questions are approved and measured. Until then it stays empty rather than showing sample data.</p>
        <ul>
          {points.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </section>
    </>
  );
}
