import type { Metadata } from "next";
import { ScanForm } from "./scan-form";

export const metadata: Metadata = {
  title:
    "Request a Zypact V1 demo",
  description:
    "Request access to Zypact's controlled, automated buyer-question diagnostic and registered retest on Perplexity Sonar.",
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
            Zypact V1 · Controlled automation
          </p>

          <h1>
            Request a Zypact V1 demo.
          </h1>

          <p className="scan-intro-copy">
            Bring one commercially important buyer
            question. Zypact reviews the question
            and protocol first. After approval, the
            controlled Perplexity Sonar baseline
            runs automatically and preserves the
            evidence.
          </p>

          <p className="scan-intro-note">
            Submitting this form does not start an
            AI call.
          </p>

          <ul className="scan-summary">
            <li>
              One commercially meaningful buyer
              question
            </li>
            <li>Approved Perplexity Sonar protocol</li>
            <li>
              Exact evidence and integrity checks
            </li>
            <li>One registered intervention</li>
            <li>Controlled same-question retest</li>
          </ul>

          <p className="scan-caveat">
            V1 surface: Perplexity Sonar only.
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
