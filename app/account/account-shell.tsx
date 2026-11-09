import type { ReactNode } from "react";

import { ZypactLogo } from "@/components/zypact-logo";

/** The account pages' frame, on the existing sign-in page styles. */
export function AccountShell({
  eyebrow,
  title,
  copy,
  notice,
  children,
  footer,
}: {
  eyebrow: string;
  title: string;
  copy: string;
  notice?: { tone: "success" | "error"; text: string } | null;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="founder-login-page">
      <header className="founder-login-topbar">
        <ZypactLogo className="founder-login-logo" />
        <a className="founder-login-back" href="/">
          Back to website
        </a>
      </header>

      <div className="founder-login-shell">
        <section className="founder-login-intro">
          <p className="founder-login-kicker">Zypact pilot</p>
          <h1 className="founder-login-headline">
            Your Zypact
            <br />
            <span className="founder-login-headline-accent">workspace</span>
          </h1>
          <p className="founder-login-lede">
            Start with your website, then the buyer questions that matter. Nothing runs or costs anything
            without your approval.
          </p>
        </section>

        <section className="founder-login-card">
          <p className="founder-login-eyebrow">{eyebrow}</p>
          <h2 className="founder-login-title">{title}</h2>
          <p className="founder-login-copy">{copy}</p>

          {notice ? (
            <div
              className={`founder-login-alert founder-login-alert-${notice.tone}`}
              role={notice.tone === "error" ? "alert" : "status"}
            >
              <p className="founder-login-alert-title">{notice.text}</p>
            </div>
          ) : null}

          {children}

          {footer ? <div className="founder-login-footnote">{footer}</div> : null}
        </section>
      </div>
    </main>
  );
}
