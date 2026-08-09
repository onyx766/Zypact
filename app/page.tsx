import type { Metadata } from "next";
import { ZypactLogo } from "@/components/zypact-logo";
import { HeroProcessViz, HowItWorks, LandingNav, SyntheticDemo } from "@/components/landing-interactions";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://zypact.com";
const snapshotFormUrl = "/scan";

export const metadata: Metadata = {
  title: "Zypact — See why AI recommends competitors instead of you",
  description:
    "Zypact helps B2B SaaS marketing teams see which buyer questions they lose in AI, which competitors appear instead, and the first evidence-backed fix worth testing.",
  alternates: { canonical: siteUrl },
  openGraph: {
    title: "Zypact — AI visibility intelligence for B2B SaaS",
    description:
      "Test buyer questions, see where competitors appear instead, identify the evidence gap, and get the first fix worth testing.",
    url: siteUrl,
    siteName: "Zypact",
    type: "website",
  },
};

function getJsonLd() {
  return {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Organization", name: "Zypact", url: siteUrl },
      {
        "@type": "Service",
        name: "Zypact AI visibility snapshot",
        serviceType: "AI visibility diagnostic for B2B SaaS marketing teams",
        url: siteUrl,
        provider: { "@type": "Organization", name: "Zypact", url: siteUrl },
        description:
          "Zypact tests buyer-style questions using live Perplexity Sonar answers, shows where a brand is recommended, cited, mentioned, or absent, and identifies the first evidence-backed fix worth testing.",
        audience: { "@type": "BusinessAudience", audienceType: "B2B SaaS marketing teams" },
      },
    ],
  };
}

const deliverables = [
  ["01", "Buyer questions won or lost", "Know exactly which tested questions put you on a shortlist — and which hand the opportunity elsewhere."],
  ["02", "Competitors in your buying frame", "See which brands appear in the specific buyer questions being tested instead of relying on a generic competitor list."],
  ["03", "Recommended vs. cited status", "Separate being absent, mentioned, cited, and recommended so the signal is easy to interpret."],
  ["04", "Evidence gap behind the loss", "See what evidence appears missing before making a fix, without turning an observed outcome into a causal claim."],
  ["05", "First fix worth making", "Get one prioritized, evidence-backed action instead of a generic 40-item audit."],
  ["06", "What to re-test afterward", "Know which buyer question should be checked again after the intervention so you can observe what changed."],
] as const;

const faqs = [
  {
    question: "What does the free snapshot include?",
    answer:
      "A focused set of buyer-style questions, repeated live checks where appropriate, prompt-level recommendation and citation evidence, the competitors or sources that appeared, and the first evidence-backed fix worth testing.",
  },
  {
    question: "Which AI platform do you test?",
    answer:
      "Perplexity Sonar only right now. The current snapshot does not represent automated coverage of ChatGPT, Gemini, Claude, or the entire AI search market.",
  },
  {
    question: "Is this an SEO audit?",
    answer:
      "No. Zypact focuses on what live AI answers recommend or cite when buyers ask category, comparison, alternative, and product-choice questions. It can complement SEO, but it is not a traditional technical SEO audit.",
  },
  {
    question: "Is this a full market audit?",
    answer:
      "No. It is a focused diagnostic snapshot using a small set of commercially relevant buyer questions. It is designed to surface evidence and a useful next action, not to claim market-wide coverage.",
  },
  {
    question: "Do you guarantee ranking or recommendation improvements?",
    answer:
      "No. AI answers vary. Zypact records what happened, identifies evidence-backed opportunities, and gives you something specific to test rather than promising rankings, citations, recommendations, or visibility lift.",
  },
  {
    question: "What if my brand is not mentioned at all?",
    answer:
      "That is still useful evidence. We show the exact buyer frame where your brand was absent, what brands or sources appeared when available, and the first evidence gap worth investigating.",
  },
  {
    question: "What happens after the snapshot?",
    answer:
      "A founder reviews the snapshot before delivery. If the finding is useful, deeper diagnostic or implementation work is optional — the free snapshot does not lock you into anything.",
  },
  {
    question: "Do I need a subscription?",
    answer:
      "No subscription is required to request the free snapshot. The current launch is founder-led rather than a fully self-serve subscription checkout.",
  },
];

export default function LandingPage() {
  return (
    <main id="top" className="di-page">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(getJsonLd()) }} />
      <LandingNav snapshotFormUrl={snapshotFormUrl} />

      <section className="di-hero" aria-labelledby="hero-heading">
        <div className="di-grid-bg" aria-hidden="true" />
        <div className="di-hero-glow" aria-hidden="true" />
        <div className="di-shell di-hero-inner">
          <div className="di-hero-copy">
            <div className="di-pulse-badge"><span aria-hidden="true" /> AI visibility intelligence · Perplexity Sonar</div>
            <h1 id="hero-heading">See why AI assistants <em>recommend your competitors</em> instead of you.</h1>
            <p className="di-hero-subtitle">
              Zypact tests real buyer questions, shows where your brand loses, identifies the evidence gaps, and surfaces the first fix worth testing.
            </p>
            <div className="di-hero-actions">
              <a href={snapshotFormUrl} className="di-button di-button-primary di-button-large">Request free snapshot</a>
              <a href="#demo" className="di-text-link">See how the snapshot works <span aria-hidden="true">↘</span></a>
            </div>
            <div className="di-trust-strip" aria-label="Snapshot trust signals">
              <span>FOUNDER-REVIEWED</span><span>LIVE PERPLEXITY ANSWERS</span><span>NO INVENTED CLAIMS</span>
            </div>
            <p className="di-scope-note">Small Perplexity snapshot. Not a market-wide benchmark and not ChatGPT, Gemini, or Claude coverage.</p>
          </div>

          <div className="di-hero-orbit">
            <HeroProcessViz />
          </div>
        </div>
      </section>

      <section id="demo" className="di-section di-demo-section">
        <div className="di-shell">
          <div className="di-section-heading di-section-heading-split">
            <div>
              <span className="di-kicker">— synthetic demo</span>
              <h2>Where your brand shows up — or doesn&apos;t.</h2>
            </div>
            <p>Explore a simulated snapshot interface. The brands and results below are synthetic and are not customer data or live probe results.</p>
          </div>
          <SyntheticDemo />
        </div>
      </section>

      <section id="what-you-get" className="di-section di-section-deep">
        <div className="di-shell">
          <div className="di-section-heading di-section-heading-split">
            <div>
              <span className="di-kicker">— what you get</span>
              <h2>Six outputs. One buying frame to act on first.</h2>
            </div>
            <p>The free snapshot is intentionally focused: it moves from an observed buyer-question loss to the evidence and intervention worth testing next.</p>
          </div>

          <div className="di-deliverables-grid">
            {deliverables.map(([number, title, copy]) => (
              <article className="di-deliverable-card" key={number}>
                <span className="di-deliverable-number">{number}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{copy}</p>
                </div>
                <span className="di-card-arrow" aria-hidden="true">↗</span>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="how-it-works" className="di-section">
        <div className="di-shell">
          <div className="di-section-heading">
            <span className="di-kicker">— how it works</span>
            <h2>From buyer question to the first fix worth testing.</h2>
            <p>The current real snapshot uses Perplexity Sonar. Every recommendation stays tied to stored answers and evidence you can verify.</p>
          </div>
          <HowItWorks />
        </div>
      </section>

      <section className="di-section di-proof-section">
        <div className="di-shell di-proof-grid">
          <div>
            <span className="di-kicker">— why this matters</span>
            <h2>The AI answer can become the shortlist before the click.</h2>
          </div>
          <div className="di-proof-copy">
            <p>When a buyer asks which product to use, compare, or consider, the answer can shape which brands make the first cut.</p>
            <blockquote>Which buyer question are we losing, what evidence is missing, and what should we test first?</blockquote>
            <div className="di-proof-tags"><span>B2B SaaS</span><span>Marketing</span><span>Growth</span><span>Content</span></div>
          </div>
        </div>
      </section>

      <section id="faq" className="di-section di-section-deep">
        <div className="di-shell di-faq-layout">
          <div className="di-faq-intro">
            <span className="di-kicker">— FAQ</span>
            <h2>What the current snapshot does — and does not — claim.</h2>
            <p>Clear scope is part of the product. The snapshot is useful because it stays narrow about what the evidence actually shows.</p>
          </div>
          <div className="di-faq-list">
            {faqs.map((faq, index) => (
              <details className="di-faq-item" key={faq.question}>
                <summary><span className="di-faq-number">0{index + 1}</span>{faq.question}<span className="di-faq-plus" aria-hidden="true">+</span></summary>
                <p>{faq.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="di-final-cta">
        <div className="di-final-glow" aria-hidden="true" />
        <div className="di-shell di-final-inner">
          <span className="di-kicker">— start with evidence</span>
          <h2>Start with a free AI visibility snapshot.</h2>
          <p>We&apos;ll test real buyer-style questions, show where competitors appear instead of your company, and identify the first fix worth testing.</p>
          <a href={snapshotFormUrl} className="di-button di-button-primary di-button-large">Request free snapshot</a>
          <span className="di-final-note">NO CARD REQUIRED · FOUNDER REVIEWED</span>
        </div>
      </section>

      <footer className="di-footer">
        <div className="di-shell di-footer-inner">
          <ZypactLogo href="#top" className="di-wordmark" />
          <span>© 2026 Zypact</span>
        </div>
      </footer>
    </main>
  );
}
