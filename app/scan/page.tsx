import type { Metadata } from "next";
import { ScanForm } from "./scan-form";

export const metadata: Metadata = {
  title:
    "Request a Zypact V1 demo",
  description:
    "Request a conversation about Zypact's evidence-backed diagnostic and registered retest for one commercially important buyer question.",
  alternates: {
    canonical: "/scan",
  },
};

export default function ScanPage() {
  const siteKey =
    process.env
      .NEXT_PUBLIC_TURNSTILE_SITE_KEY
      ?.trim() || null;

  const enabled =
    process.env
      .SNAPSHOT_PUBLIC_FORM_ENABLED ===
      "true" && Boolean(siteKey);

  return (
    <main className="scan-page">
      <header className="header">
        <a href="/" className="wordmark">
          Zypact
        </a>

        <a
          href="/"
          className="scan-back-link"
        >
          Back to website
        </a>
      </header>

      <section className="scan-shell">
        <div className="scan-intro">
          <p className="eyebrow">
            Evidence-backed diagnostic + registered retest
          </p>

          <h1>
            Bring one buyer question worth testing.
          </h1>

          <p className="scan-intro-copy">
            Request a conversation about a
            founder-led V1 pilot. No AI call starts
            from this form. If the fit is right,
            Zypact and your team approve the
            question, protocol, limits, and
            observation window before execution.
          </p>

          <ul className="scan-summary">
            <li>
              One commercially meaningful buyer
              question
            </li>
            <li>
              Exact Perplexity evidence, observed
              competitors, and sources
            </li>
            <li>
              One registered intervention and a
              same-question retest
            </li>
          </ul>

          <p className="scan-caveat">
            Initial V1 surface: Perplexity Sonar.
            No market-wide score, causal promise,
            or revenue attribution.
          </p>
        </div>

        <div className="scan-card">
          <ScanForm
            enabled={enabled}
            siteKey={siteKey}
          />
        </div>
      </section>
    </main>
  );
}
