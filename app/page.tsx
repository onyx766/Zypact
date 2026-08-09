import type { Metadata } from "next";
import { ZypactLogo } from "@/components/zypact-logo";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://zypact.com";
const snapshotFormUrl = "/scan";

export const metadata: Metadata = {
  title: "Zypact — AI visibility diagnostics for B2B SaaS teams",
  description:
    "See why AI answers recommend competitors instead of your B2B SaaS brand, then get the first evidence-backed fix worth testing.",
  alternates: {
    canonical: siteUrl,
  },
  openGraph: {
    title: "Zypact — AI visibility diagnostics for B2B SaaS teams",
    description:
      "Test real buyer questions, see where competitors win, identify the evidence gap, and get the first fix worth testing.",
    url: siteUrl,
    siteName: "Zypact",
    type: "website",
  },
};

function getJsonLd() {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        name: "Zypact",
        url: siteUrl,
      },
      {
        "@type": "Service",
        name: "Zypact AI visibility snapshot",
        serviceType: "AI visibility diagnostic for B2B SaaS marketing teams",
        url: siteUrl,
        provider: {
          "@type": "Organization",
          name: "Zypact",
          url: siteUrl,
        },
        description:
          "Zypact tests buyer-style questions in live AI answers, shows where a brand is recommended, cited, or absent, and identifies the first evidence-backed fix worth testing.",
        audience: {
          "@type": "BusinessAudience",
          audienceType: "B2B SaaS marketing teams",
        },
      },
    ],
  };
}

const snapshotItems = [
  "Buyer questions your brand wins or loses",
  "Competitors that appear in the same buying frame",
  "Whether your brand is recommended or cited",
  "The evidence gap behind the loss",
  "The first fix worth making",
  "What to re-test after the change",
];

const workflow = [
  ["01", "Buyer question", "Start with the category, comparison, alternative, and buying-intent questions that matter."],
  ["02", "Live AI runs", "Run the questions repeatedly in the current live snapshot engine: Perplexity Sonar."],
  ["03", "Evidence", "Separate what the answers actually showed from assumptions, then inspect the competing sources and proof."],
  ["04", "First fix", "Prioritize one evidence-backed intervention instead of handing you a long generic checklist."],
  ["05", "Re-test", "Run the same buyer question again after the change and compare what actually moved."],
];

const faqs = [
  {
    question: "What does Zypact actually test?",
    answer:
      "Zypact tests buyer-style questions around categories, comparisons, alternatives, and product choice using live AI answers. The goal is to see whether your brand is recommended, cited, mentioned, or absent in the buying frames that matter.",
  },
  {
    question: "Is Zypact an SEO audit?",
    answer:
      "No. Zypact focuses on what AI answers recommend or cite when buyers ask product, category, and comparison questions. It can complement SEO, but it is not a traditional technical SEO audit.",
  },
  {
    question: "Which AI platform does the snapshot test today?",
    answer:
      "The current live snapshot uses Perplexity Sonar. Zypact does not present the snapshot as equivalent coverage of ChatGPT, Gemini, Claude, or the entire AI search market.",
  },
  {
    question: "How many questions are tested?",
    answer:
      "The free snapshot uses a focused sample of buyer questions and repeats runs where appropriate. It is a diagnostic snapshot designed to surface useful evidence, not a market-wide benchmark.",
  },
  {
    question: "What happens if my brand is missing?",
    answer:
      "Zypact identifies the buying frame, the competing brands or sources that appeared, and the evidence gap behind the result. Then it recommends the first evidence-backed fix worth testing.",
  },
  {
    question: "Can Zypact guarantee that AI will recommend my company?",
    answer:
      "No. AI answers vary. Zypact measures the evidence, records what happened, recommends a grounded intervention, and re-tests what changes rather than promising a ranking or recommendation.",
  },
  {
    question: "What happens after the free snapshot?",
    answer:
      "The snapshot is founder-reviewed before delivery. If the finding is useful, we can walk through the lost buyer question, decide whether deeper work makes sense, apply an evidence-backed fix, and re-test the same buying frame.",
  },
];

export default function LandingPage() {
  return (
    <main className="page landing-page">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(getJsonLd()) }}
      />

      <header className="header landing-header">
        <ZypactLogo href="#top" priority className="wordmark" />

        <nav className="nav" aria-label="Primary navigation">
          <a href="#snapshot">What you get</a>
          <a href="#how-it-works">How it works</a>
          <a href="#faq">FAQ</a>
          <a href={snapshotFormUrl} className="button button-primary">
            Run free snapshot
          </a>
        </nav>

        <a href={snapshotFormUrl} className="button button-primary mobile-cta">
          Run free snapshot
        </a>
      </header>

      <section id="top" className="landing-hero">
        <div className="landing-hero-copy">
          <p className="eyebrow">AI visibility for B2B SaaS marketing teams</p>
          <h1>See why AI assistants recommend your competitors instead of you.</h1>
          <p className="hero-copy landing-hero-description">
            Zypact tests real buyer questions, shows where your brand loses, identifies the evidence gap, and gives you the first fix worth testing.
          </p>

          <div className="hero-actions landing-hero-actions">
            <a href={snapshotFormUrl} className="button button-primary button-large">
              Run your free AI visibility snapshot
            </a>
          </div>

          <div className="trust-row" aria-label="Snapshot trust signals">
            <span>Founder-reviewed</span>
            <span>Live Perplexity Sonar answers</span>
            <span>No invented claims</span>
          </div>
        </div>

        <div className="snapshot-visual" aria-label="Synthetic example of a Zypact AI visibility snapshot">
          <div className="snapshot-visual-topline">
            <div>
              <p className="snapshot-kicker">Buyer question</p>
              <h2>How do buyers compare platforms in this category?</h2>
            </div>
            <span className="snapshot-live">Live answer</span>
          </div>

          <div className="snapshot-status-grid">
            <div className="snapshot-status-card">
              <span className="snapshot-kicker">Your brand</span>
              <strong>Absent</strong>
            </div>
            <div className="snapshot-status-card">
              <span className="snapshot-kicker">AI recommended</span>
              <div className="competitor-pills">
                <span>Competitor A</span>
                <span>Competitor B</span>
                <span>Competitor C</span>
              </div>
            </div>
          </div>

          <div className="snapshot-diagnosis">
            <div>
              <span className="snapshot-kicker">Evidence gap</span>
              <strong>Missing comparison proof</strong>
            </div>
            <div>
              <span className="snapshot-kicker">First fix</span>
              <strong>Build an evidence-backed comparison page</strong>
            </div>
          </div>

          <div className="progression" aria-label="Visibility progression from absent to recommended">
            <span className="progression-step is-current">Absent</span>
            <span className="progression-line" aria-hidden="true" />
            <span className="progression-step">Mentioned</span>
            <span className="progression-line" aria-hidden="true" />
            <span className="progression-step">Cited</span>
            <span className="progression-line" aria-hidden="true" />
            <span className="progression-step">Recommended</span>
          </div>

          <p className="snapshot-example-note">Synthetic example — no customer data or performance claim.</p>
        </div>
      </section>

      <section id="snapshot" className="section landing-section">
        <div className="container landing-container">
          <div className="section-heading-row">
            <div>
              <p className="section-label">What your snapshot shows</p>
              <h2>Move from “AI visibility” to a specific buyer question you can act on.</h2>
            </div>
            <p className="section-copy">
              You get a focused diagnosis of where your brand appears, where it disappears, and which evidence-backed intervention is worth testing first.
            </p>
          </div>

          <div className="snapshot-item-grid">
            {snapshotItems.map((item, index) => (
              <article className="snapshot-item" key={item}>
                <span className="snapshot-item-number">0{index + 1}</span>
                <h3>{item}</h3>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="how-it-works" className="section section-muted landing-section">
        <div className="container landing-container">
          <p className="section-label">How it works</p>
          <h2>Buyer question → live AI runs → evidence → first fix → re-test.</h2>
          <p className="section-copy">
            The current live snapshot uses Perplexity Sonar. Every step stays tied to the stored answers and the evidence you can verify.
          </p>

          <div className="workflow-grid">
            {workflow.map(([number, title, description]) => (
              <article className="workflow-card" key={number}>
                <span className="workflow-number">{number}</span>
                <h3>{title}</h3>
                <p>{description}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section landing-section">
        <div className="container landing-container why-grid">
          <div>
            <p className="section-label">Why it matters</p>
            <h2>AI answers can become the shortlist before a buyer ever reaches your website.</h2>
          </div>
          <div className="why-copy">
            <p>
              When a buyer asks which product to use, compare, or consider, the answer can shape which brands make the first cut. If your company is absent, the useful question is not just “what is our score?”
            </p>
            <p className="why-emphasis">It is: which buyer question are we losing, what evidence is missing, and what should we test first?</p>
          </div>
        </div>
      </section>

      <section className="section section-muted landing-section">
        <div className="container landing-container audience-grid">
          <div>
            <p className="section-label">Who it is for</p>
            <h2>Built for B2B SaaS marketing teams.</h2>
            <p className="section-copy">
              Especially teams already investing in visibility and category positioning who want to understand what happens when buyers ask AI which product to choose.
            </p>
          </div>
          <div className="audience-card">
            <p className="audience-card-label">Useful when your team already invests in</p>
            <div className="audience-tags">
              <span>Content</span>
              <span>SEO</span>
              <span>Category positioning</span>
              <span>Demand generation</span>
            </div>
            <p>
              Zypact adds the buyer-question layer: what the AI answer actually says, who appears, and which proof is worth strengthening next.
            </p>
          </div>
        </div>
      </section>

      <section id="faq" className="section landing-section">
        <div className="container landing-container faq-layout">
          <div className="faq-intro">
            <p className="section-label">FAQ</p>
            <h2>What the current snapshot does — and does not — claim.</h2>
            <p className="section-copy">
              Zypact is deliberately narrow about the evidence it has today. The free snapshot is a starting diagnostic, not a promise of market-wide coverage.
            </p>
          </div>

          <div className="faq-list">
            {faqs.map((faq) => (
              <details className="faq-item" key={faq.question}>
                <summary>{faq.question}</summary>
                <p>{faq.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="final-cta-section">
        <div className="final-cta-card">
          <p className="section-label">Private founder-reviewed snapshot</p>
          <h2>See what AI recommends when your buyers ask.</h2>
          <p>
            Run a private snapshot of the buyer questions that matter to your category, then get the first evidence-backed fix worth testing.
          </p>
          <a href={snapshotFormUrl} className="button button-primary button-large">
            Run your free AI visibility snapshot
          </a>
          <span className="final-cta-note">Current live snapshot uses Perplexity Sonar.</span>
        </div>
      </section>

      <footer className="footer landing-footer">
        <p>
          Zypact currently runs as a founder-reviewed AI visibility diagnostic for B2B SaaS teams. No guaranteed rankings, recommendations, or visibility lift.
        </p>
      </footer>
    </main>
  );
}
