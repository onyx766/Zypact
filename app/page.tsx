import type { Metadata } from "next";
import { ZypactLogo } from "@/components/zypact-logo";
import { HeroProcessViz, HowItWorks, LandingNav, ProtocolDemo } from "@/components/landing-interactions";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://zypact.com";
const demoRequestUrl = "/scan";

export const metadata: Metadata = {
  title: "Zypact — Evidence-backed AI visibility diagnostic and registered retest",
  description:
    "Bring one commercially important buyer question. Zypact preserves the exact Perplexity evidence, helps register one intervention, and retests the same question after an explicit observation window.",
  alternates: { canonical: siteUrl },
  openGraph: {
    title: "Zypact — Evidence-backed diagnostic and registered retest",
    description:
      "Inspect exact Perplexity evidence for one important buyer question, register one intervention, and retest the same question after the observation window.",
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
        name: "Zypact Evidence-Backed Shortlist Diagnostic + Registered Retest",
        serviceType: "Founder-led AI visibility diagnostic and registered retest for B2B SaaS",
        url: siteUrl,
        provider: { "@type": "Organization", name: "Zypact", url: siteUrl },
        description:
          "Zypact runs an approved, bounded protocol on Perplexity Sonar, preserves exact evidence, supports one registered intervention, and retests the same buyer question after an explicit observation window.",
        audience: {
          "@type": "BusinessAudience",
          audienceType: "English-language B2B SaaS marketing and product-marketing teams",
        },
      },
    ],
  };
}

const deliverables = [
  ["01", "Approved buyer question", "Start with one commercially meaningful question, its purpose, context, and an immutable approved version."],
  ["02", "Bounded protocol", "Agree on the Perplexity surface, sampling plan, limits, decision threshold, and observation window before paid calls."],
  ["03", "Exact evidence", "Preserve the outbound request, raw response, sources, metadata, and integrity hash behind every observation."],
  ["04", "Observed competitor frame", "Inspect prompt-scoped positions, competitors, claims, and sources without converting an observation into a causal explanation."],
  ["05", "Registered intervention", "Choose one evidence-backed hypothesis, record the owner and implementation proof, and open the observation window."],
  ["06", "Auditable Outcome Card", "Retest the same question after eligibility and report increase observed, decrease observed, no clear change, or an inconclusive result."],
] as const;

const faqs = [
  {
    question: "What does the V1 pilot include?",
    answer:
      "One approved buyer question, a bounded Perplexity protocol, exact evidence, prompt-scoped observations, one registered intervention, an explicit observation window, a same-question retest, and an auditable Outcome Card.",
  },
  {
    question: "Which AI platform do you test?",
    answer:
      "Perplexity Sonar is the initial live V1 surface. The pilot does not claim automated coverage of ChatGPT, Gemini, Claude, or the entire AI-search market.",
  },
  {
    question: "Why is there no fixed number of runs?",
    answer:
      "AI answers vary. Sampling is an approved protocol parameter based on the question, uncertainty, decision threshold, limits, and budget. Zypact does not silently treat three runs—or any universal number—as a reliable external measurement.",
  },
  {
    question: "Is this an SEO audit?",
    answer:
      "No. Zypact records what one defined AI surface returns for an approved buyer question. The resulting intervention may involve positioning, content, evidence, reviews, PR, or no action at all.",
  },
  {
    question: "Do you guarantee ranking, recommendation, or revenue improvement?",
    answer:
      "No. Zypact guarantees the agreed process and evidence contract, not a favorable model response. The report never converts observed movement into causal or revenue attribution.",
  },
  {
    question: "What if nothing clearly changes?",
    answer:
      "That is a valid result. The Outcome Card reports increase observed, decrease observed, no clear change, or inconclusive evidence, preserves the limitations and confounders, and supports a decision to continue, revise, or stop.",
  },
  {
    question: "What happens after I request a demo?",
    answer:
      "No AI scan starts from the form. Zypact first reviews fit with you. If you proceed, the buyer question, protocol, limits, intervention responsibilities, and observation window are approved before execution.",
  },
  {
    question: "Do I need a subscription?",
    answer:
      "No self-serve subscription is required for the initial founder-led pilot. Scope, timing, price, and responsibilities are agreed for the bounded engagement before work begins.",
  },
];

export default function LandingPage() {
  return (
    <main id="top" className="di-page">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(getJsonLd()) }} />
      <LandingNav demoRequestUrl={demoRequestUrl} />

      <section className="di-hero" aria-labelledby="hero-heading">
        <div className="di-grid-bg" aria-hidden="true" />
        <div className="di-hero-glow" aria-hidden="true" />
        <div className="di-shell di-hero-inner">
          <div className="di-hero-copy">
            <div className="di-pulse-badge"><span aria-hidden="true" /> Evidence-backed diagnostic · Registered retest</div>
            <h1 id="hero-heading">See which competitors appear for one critical buyer question. <em>Choose what to test next.</em></h1>
            <p className="di-hero-subtitle">
              Bring one commercially important buyer question. Zypact records how Perplexity answers it, shows the competitors and sources observed, helps register one evidence-backed intervention, and checks the same question again after the observation window.
            </p>
            <div className="di-hero-actions">
              <a href={demoRequestUrl} className="di-button di-button-primary di-button-large">Request Demo</a>
              <a href="#how-it-works" className="di-text-link">See the V1 method <span aria-hidden="true">↘</span></a>
            </div>
            <div className="di-trust-strip" aria-label="V1 trust signals">
              <span>APPROVED PROTOCOL</span><span>EXACT EVIDENCE</span><span>HONEST OUTCOMES</span>
            </div>
            <p className="di-scope-note">Current V1 surface: Perplexity Sonar. No market-wide score, causal promise, or revenue attribution.</p>
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
              <span className="di-kicker">— synthetic V1 example</span>
              <h2>From one approved question to an auditable next decision.</h2>
            </div>
            <p>Explore a simulated protocol view. Brands, evidence states, and outcomes are synthetic—not customer data or live probe results.</p>
          </div>
          <ProtocolDemo />
        </div>
      </section>

      <section id="what-you-get" className="di-section di-section-deep">
        <div className="di-shell">
          <div className="di-section-heading di-section-heading-split">
            <div>
              <span className="di-kicker">— what the pilot delivers</span>
              <h2>Six parts. One bounded learning loop.</h2>
            </div>
            <p>V1 moves from an approved buyer question to exact evidence, one registered intervention, and an honest same-question retest.</p>
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
            <span className="di-kicker">— how V1 works</span>
            <h2>Approve the question. Preserve the evidence. Retest after the window.</h2>
            <p>Every visible conclusion stays tied to a versioned protocol and exact evidence. A partial or unsafe result is reviewed or blocked—not delivered as certainty.</p>
          </div>
          <HowItWorks />
        </div>
      </section>

      <section className="di-section di-proof-section">
        <div className="di-shell di-proof-grid">
          <div>
            <span className="di-kicker">— why the protocol matters</span>
            <h2>One answer is an observation—not a strategy.</h2>
          </div>
          <div className="di-proof-copy">
            <p>AI answers vary. V1 therefore approves sampling, limits, and a decision threshold before paid calls, preserves every attempt, and makes uncertainty visible.</p>
            <blockquote>What did we observe, what are we changing, and what will we check again?</blockquote>
            <div className="di-proof-tags">
              <span>B2B SaaS</span><span>Exact evidence</span><span>Registered intervention</span><span>Honest retest</span>
            </div>
          </div>
        </div>
      </section>

      <section id="faq" className="di-section di-section-deep">
        <div className="di-shell di-faq-layout">
          <div className="di-faq-intro">
            <span className="di-kicker">— FAQ</span>
            <h2>What the V1 pilot does—and does not claim.</h2>
            <p>Clear boundaries are part of the product. V1 reports what the approved evidence supports, including when the result is inconclusive.</p>
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
          <span className="di-kicker">— request a founder-led demo</span>
          <h2>Request a Zypact V1 demo.</h2>
          <p>We&apos;ll review your category and discuss one commercially important buyer question. No AI scan starts from the form.</p>
          <a href={demoRequestUrl} className="di-button di-button-primary di-button-large">Request Demo</a>
          <span className="di-final-note">FOUNDER-LED PILOT · NO AUTOMATIC SCAN</span>
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
