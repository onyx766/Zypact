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
            Request access to the V1 workflow for
            one commercially important buyer
            question. This form does not approve a
            protocol or start an AI call. If you
            proceed, the question, limits, sampling
            plan, and observation window are approved
            first. The controlled baseline then runs
            automatically.
          </p>

          <ul className="scan-summary">
            <li>
              One commercially meaningful buyer
              question and an approved protocol
            </li>
            <li>
              Automated Perplexity baseline with
              exact evidence and integrity checks
            </li>
            <li>
              One registered intervention and a
              controlled, automatic same-question retest
            </li>
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
