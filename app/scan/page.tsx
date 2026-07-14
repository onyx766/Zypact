import type { Metadata } from "next";
import { ScanForm } from "./scan-form";

export const metadata: Metadata = {
  title:
    "Free AI visibility snapshot — Zypact",
  description:
    "Request a free Zypact snapshot to see which competitors AI recommends instead of your company.",
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
            Free AI visibility snapshot
          </p>

          <h1>
            See which competitors AI recommends
            instead of your company.
          </h1>

          <p className="scan-intro-copy">
            We test five unbranded buyer
            questions three times in Perplexity:
            15 real recommendation checks.
          </p>

          <ul className="scan-summary">
            <li>Recommendation and citation rate</li>
            <li>Buyer questions your company loses</li>
            <li>Top competitor, sources, and first fix</li>
          </ul>

          <p className="scan-caveat">
            This is a small Perplexity snapshot.
            It does not represent ChatGPT,
            Gemini, Claude, or the entire market.
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
