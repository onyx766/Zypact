import type { Metadata } from "next";
import type { ReactNode } from "react";
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

const FEATURES: Array<{
  title: string;
  desc: string;
  icon: ReactNode;
}> = [
  {
    title: "One buyer question",
    desc: "Focus on one commercially meaningful question.",
    icon: (
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
    ),
  },
  {
    title: "Reviewed before any AI call",
    desc: "We review your question and protocol first.",
    icon: <path d="M12 2 4 5v6c0 5 3.4 9 8 11 4.6-2 8-6 8-11V5l-8-3Z" />,
  },
  {
    title: "Evidence-backed result",
    desc: "A controlled run with exact evidence and integrity checks.",
    icon: (
      <>
        <path d="M7 3h7l4 4v14H7Z" />
        <path d="M14 3v4h4" />
        <path d="M9.5 13h5" />
        <path d="M9.5 16.5h5" />
      </>
    ),
  },
];

export default function ScanPage() {
  const enabled =
    process.env
      .SNAPSHOT_PUBLIC_FORM_ENABLED ===
    "true";

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
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M5 12h14" />
            <path d="m13 6 6 6-6 6" />
          </svg>
        </a>
      </header>

      <section className="scan-shell">
        <div className="scan-intro">
          <p className="eyebrow scan-eyebrow">
            Zypact V1 · Controlled automation
          </p>

          <h1>
            See how your company appears in
            an AI buyer answer.
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
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 16v-5" />
              <path d="M12 8h.01" />
            </svg>
            <span>
              Submitting this form does not start
              an AI call.
            </span>
          </p>

          <ul className="scan-summary">
            {FEATURES.map((feature) => (
              <li key={feature.title}>
                <span className="scan-summary-icon">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    {feature.icon}
                  </svg>
                </span>
                <span>
                  <span className="scan-summary-title">
                    {feature.title}
                  </span>
                  <span className="scan-summary-desc">
                    {feature.desc}
                  </span>
                </span>
              </li>
            ))}
          </ul>

          <p className="scan-caveat">
            V1 surface: Perplexity Sonar only.
            No market-wide score, causal promise,
            or revenue attribution.
          </p>
        </div>

        <div className="scan-card">
          <ScanForm enabled={enabled} />
        </div>
      </section>
    </main>
  );
}
