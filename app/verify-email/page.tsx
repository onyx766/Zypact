import type { Metadata } from "next";
import { VerifyEmailClient } from "./verify-email-client";

export const metadata: Metadata = {
  title: "Verify your email — Zypact",
  description:
    "Verify the email address associated with your Zypact AI visibility snapshot request.",
  robots: {
    index: false,
    follow: false,
    noarchive: true,
  },
};

export default function VerifyEmailPage() {
  return (
    <main className="verification-page">
      <header className="header">
        <a href="/" className="wordmark">
          Zypact
        </a>
      </header>

      <section className="verification-shell">
        <div className="verification-card">
          <VerifyEmailClient />
        </div>
      </section>
    </main>
  );
}
