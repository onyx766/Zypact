import type { Metadata } from "next";
import { PRICING_PLANS, PUBLIC_PLAN_ORDER } from "@/lib/pricing/plans";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://zypact.com";

const evidenceFormUrl =
  process.env.EVIDENCE_FORM_URL ||
  "mailto:hello@zypact.com?subject=Free%20AI%20visibility%20snapshot&body=Hi%20Zypact%2C%20I%27d%20like%20to%20run%20a%20free%20AI%20visibility%20snapshot.%0A%0ACompany%20domain%3A%0ACategory%3A%0AMain%20competitors%3A";

const stripeGrowthUrl = process.env.STRIPE_GROWTH_URL;
const stripeProUrl = process.env.STRIPE_PRO_URL;

export const metadata: Metadata = {
  title: "Zypact — AI visibility fixes for B2B SaaS teams",
  description:
    "Zypact helps B2B SaaS marketing teams see why AI assistants recommend competitors instead of them, then builds evidence-verified fixes.",
  alternates: {
    canonical: siteUrl,
  },
  openGraph: {
    title: "Zypact — AI visibility fixes for B2B SaaS teams",
    description:
      "See why AI assistants recommend your competitors instead of you. Live checks on real AI answers with evidence-verified fixes.",
    url: siteUrl,
    siteName: "Zypact",
    type: "website",
  },
};

function getCheckoutUrl(planKey: "free" | "growth" | "pro") {
  if (planKey === "free") return evidenceFormUrl;
  if (planKey === "growth") return stripeGrowthUrl || "#";
  return stripeProUrl || "#";
}

function getCheckoutTitle(planKey: "free" | "growth" | "pro") {
  if (planKey === "growth" && !stripeGrowthUrl) return "coming this week";
  if (planKey === "pro" && !stripeProUrl) return "coming this week";
  return undefined;
}

function getJsonLd() {
  const offers = PUBLIC_PLAN_ORDER.map((key) => {
    const plan = PRICING_PLANS[key];

    return {
      "@type": "Offer",
      name: plan.name,
      price: plan.priceMonthlyUsd,
      priceCurrency: "USD",
      url: `${siteUrl}/#pricing`,
      description: plan.positioning,
    };
  });

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        name: "Zypact",
        url: siteUrl,
      },
      {
        "@type": "SoftwareApplication",
        name: "Zypact",
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        url: siteUrl,
        description:
          "Zypact helps B2B SaaS marketing teams see why AI assistants recommend competitors instead of them, then builds evidence-verified fixes.",
        offers,
      },
    ],
  };
}

export default function LandingPage() {
  return (
    <main className="page">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(getJsonLd()) }}
      />

      <header className="header">
        <a href="#top" className="wordmark">
          Zypact
        </a>

        <nav className="nav" aria-label="Primary navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#pricing">Pricing</a>
          <a href={evidenceFormUrl} className="button button-primary">
            Run free snapshot
          </a>
        </nav>

        <a href={evidenceFormUrl} className="button button-primary mobile-cta">
          Run free snapshot
        </a>
      </header>

      <section id="top" className="hero">
        <div className="hero-inner">
          <p className="eyebrow">Built for B2B SaaS marketing teams</p>

          <h1>See why AI assistants recommend your competitors instead of you.</h1>

          <p className="hero-copy">
            Live checks on real AI answers. Every fix verified against your own evidence — we never invent claims. Built for B2B SaaS marketing teams.
          </p>

          <div className="hero-actions">
            <a href={evidenceFormUrl} className="button button-primary">
              Run your free snapshot
            </a>
          </div>

          <p className="small-note">
            No signup wall. Results in your inbox within 24 hours.
          </p>
        </div>
      </section>

      <section id="how-it-works" className="section section-muted">
        <div className="container">
          <p className="section-label">How it works</p>
          <h2>From real AI answers to evidence-checked fixes</h2>

          <div className="grid grid-3">
            <article className="card">
              <div className="step">01</div>
              <h3>We probe real AI answers</h3>
              <p>Live runs on the questions your buyers actually ask.</p>
            </article>

            <article className="card">
              <div className="step">02</div>
              <h3>You get the diagnosis</h3>
              <p>Which questions you lose, who wins them, delivered to your inbox.</p>
            </article>

            <article className="card">
              <div className="step">03</div>
              <h3>We build the fixes</h3>
              <p>
                Publish-ready pages and schema, fact-checked against evidence you approve. Nothing invented.
              </p>
            </article>
          </div>
        </div>
      </section>

      <section id="pricing" className="section">
        <div className="container">
          <p className="section-label">Pricing</p>
          <h2>Start with a snapshot, then move into recurring fixes</h2>
          <p className="section-copy">
            The public model stays simple while Zypact runs as a managed service.
          </p>

          <div className="grid grid-3">
            {PUBLIC_PLAN_ORDER.map((key) => {
              const plan = PRICING_PLANS[key];
              const isGrowth = key === "growth";
              const checkoutTitle = getCheckoutTitle(key);

              return (
                <article
                  key={plan.key}
                  className={`card pricing-card${isGrowth ? " featured" : ""}`}
                >
                  {isGrowth ? <div className="badge">Most popular</div> : null}

                  <h3>{plan.name}</h3>
                  <p>{plan.positioning}</p>

                  <div className="price">{plan.billingLabel}</div>

                  <ul className="features">
                    {plan.bullets.map((bullet) => (
                      <li key={bullet}>
                        <span className="dot" aria-hidden="true" />
                        <span>{bullet}</span>
                      </li>
                    ))}
                  </ul>

                  <div className="card-action">
                    <a
                      href={getCheckoutUrl(key)}
                      title={checkoutTitle}
                      className={`button ${isGrowth ? "button-primary" : "button-secondary"}`}
                    >
                      {plan.primaryCta}
                    </a>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <footer className="footer">
        <p>
          Zypact runs as a managed service today: your diagnostics, gaps, and fixes are delivered directly — nothing to install or configure.
        </p>
      </footer>
    </main>
  );
}
