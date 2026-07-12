import type { Metadata } from "next";

const evidenceFormUrl =
  process.env.EVIDENCE_FORM_URL ||
  "https://tally.so/r/2EyA7p";

export const metadata: Metadata = {
  title: "Payment received — Zypact",
  description:
    "Payment received. Zypact will collect your company details and deliver your AI recommendation diagnosis by email.",
};

export default function ThankYouPage() {
  return (
    <main className="page">
      <header className="header">
        <a href="/" className="wordmark">
          Zypact
        </a>
      </header>

      <section className="hero">
        <div className="hero-inner">
          <p className="eyebrow">Payment received</p>

          <h1>We’ll prepare your diagnosis next.</h1>

          <p className="hero-copy">
            If you already submitted your company details, you’re all set. If not, complete the short form so we can run the right checks and deliver your results by email.
          </p>

          <div className="hero-actions">
            <a href={evidenceFormUrl} className="button button-primary">
              Complete company details
            </a>
          </div>

          <p className="small-note">
            Zypact runs as a managed service today. Your results will be delivered directly by email.
          </p>
        </div>
      </section>
    </main>
  );
}
