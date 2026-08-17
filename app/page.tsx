import type { Metadata } from "next";
import { ZypactLogo } from "@/components/zypact-logo";
import { AutomationFlow, EvidenceOrbit, LandingNav } from "@/components/landing-interactions";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://zypact.com";
const demoRequestUrl = "/scan";

export const metadata: Metadata = {
  title: "Zypact — Evidence-backed buyer-question diagnostic for B2B SaaS",
  description:
    "See which competitors appear for one commercially important buyer question in Perplexity, preserve the evidence, register one change, and check the same question again.",
  alternates: { canonical: siteUrl },
  openGraph: {
    title: "Zypact — One buyer question. Exact evidence. An honest retest.",
    description:
      "A controlled, automated V1 workflow for one approved buyer question on Perplexity Sonar.",
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
        name: "Zypact Evidence-Backed Buyer-Question Diagnostic",
        serviceType: "Controlled automated diagnostic and registered retest for B2B SaaS",
        url: siteUrl,
        provider: { "@type": "Organization", name: "Zypact", url: siteUrl },
        description:
          "After the buyer question and protocol are approved, Zypact runs a bounded Perplexity baseline, preserves exact evidence, supports one registered intervention, and retests the same question after the observation window.",
        audience: {
          "@type": "BusinessAudience",
          audienceType: "English-language B2B SaaS marketing and product-marketing teams",
        },
      },
    ],
  };
}

const deliverables = [
  ["01", "Approved buyer question", "One commercially meaningful question with purpose, context and an immutable approved version."],
  ["02", "Bounded protocol", "The Perplexity surface, sampling plan, limits, decision threshold and observation window approved before paid calls."],
  ["03", "Exact evidence", "Every outbound request, raw response, source, metadata record and integrity check preserved."],
  ["04", "Observed competitor frame", "Prompt-scoped positions, competitor claims and sources without turning observation into a causal explanation."],
  ["05", "Registered intervention", "One evidence-backed hypothesis with an owner, date, implementation proof and explicit observation window."],
  ["06", "Auditable Outcome Card", "The same-question retest, one of four honest outcomes, limitations, confounders and the next decision."],
] as const;

const faqs = [
  {
    question: "What does Zypact V1 include?",
    answer:
      "One approved buyer question, a bounded Perplexity protocol, exact baseline evidence, prompt-scoped competitor observations, one registered intervention, an explicit observation window, an automated same-question retest, and an auditable Outcome Card.",
  },
  {
    question: "Which AI platform does V1 test?",
    answer:
      "Perplexity Sonar is the only live V1 surface. Zypact does not claim automated coverage of ChatGPT, Gemini, Claude, Copilot, or the entire AI-search market.",
  },
  {
    question: "Why is there no fixed number of runs?",
    answer:
      "AI answers vary. Sampling is an approved protocol parameter based on the question, uncertainty, decision threshold, limits and budget. Zypact does not silently treat three runs—or any universal number—as reliable external truth.",
  },
  {
    question: "Is this an SEO audit?",
    answer:
      "No. Zypact records what one defined AI surface returns for one approved buyer question. The intervention may involve positioning, content, evidence, reviews, PR, or no action at all.",
  },
  {
    question: "Do you guarantee ranking, recommendation or revenue improvement?",
    answer:
      "No. Zypact guarantees the agreed process and evidence contract, not a favorable model response. Observed movement is never converted into causal or revenue attribution.",
  },
  {
    question: "What if nothing clearly changes?",
    answer:
      "That is a valid result. The Outcome Card reports increase observed, decrease observed, no clear change, or inconclusive evidence and preserves the limitations and confounders behind the next decision.",
  },
  {
    question: "What happens after I request a demo?",
    answer:
      "The form requests access; it does not approve a protocol or start an AI call. If you proceed, the question and protocol are approved first. V1 then runs the baseline automatically. Integrity-passed records continue to automatic delivery, exceptions are held for review, and blocked evidence is not delivered.",
  },
  {
    question: "Do I need a subscription?",
    answer:
      "No subscription or account is created by requesting a demo. Scope, timing, price and responsibilities are agreed before the approved V1 workflow begins.",
  },
] as const;

const outcomes = [
  ["Increase observed", "The approved observation increased within the retest frame."],
  ["Decrease observed", "The approved observation decreased within the retest frame."],
  ["No clear change", "The evidence does not support a clear directional change."],
  ["Inconclusive", "The protocol cannot support a reliable conclusion."],
] as const;

export default function LandingPage() {
  return (
    <main id="top" className="ev-page">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(getJsonLd()) }} />
      <LandingNav demoRequestUrl={demoRequestUrl} />

      <section className="ev-hero" aria-labelledby="hero-heading">
        <div className="ev-shell ev-hero-grid">
          <div className="ev-hero-copy">
            <p className="ev-eyebrow"><span aria-hidden="true" /> Evidence-backed diagnostic · Automated after approval</p>
            <h1 id="hero-heading">
              See which competitors appear for one critical buyer question.
              <em>Choose what to test next.</em>
            </h1>
            <p className="ev-hero-lede">
              Bring one commercially important buyer question. Zypact records how Perplexity answers it, preserves the competitors and sources observed, helps register one evidence-backed intervention, and checks the same question again after the observation window.
            </p>
            <div className="ev-hero-actions">
              <a href={demoRequestUrl} className="ev-button ev-button-primary ev-button-large">Request Demo</a>
              <a href="#evidence" className="ev-button ev-button-secondary ev-button-large">See the evidence trail</a>
            </div>
            <div className="ev-trust-row" aria-label="V1 trust signals">
              <span>Approved protocol</span>
              <span>Exact evidence</span>
              <span>Controlled automation</span>
              <span>Honest outcomes</span>
            </div>
            <p className="ev-scope-note">
              Perplexity Sonar only · One approved question · Automated after approval · No guaranteed outcome
            </p>
          </div>

          <EvidenceOrbit />
        </div>
      </section>

      <section className="ev-trigger" aria-labelledby="trigger-heading">
        <div className="ev-shell ev-trigger-grid">
          <div>
            <span className="ev-chapter">01 · UNDERSTAND</span>
            <h2 id="trigger-heading">An AI answer can shape which vendors a buyer investigates.</h2>
          </div>
          <div>
            <p>B2B buyers use AI to explore categories and compare options. AI does not decide every purchase, but one answer can introduce a competitor before your sales team enters the conversation.</p>
            <blockquote>
              <span>Example buyer question</span>
              “Which AI visibility platforms are suitable for a B2B SaaS team that needs auditable evidence?”
            </blockquote>
          </div>
        </div>
      </section>

      <section id="evidence" className="ev-section ev-section-inspect" aria-labelledby="evidence-heading">
        <div className="ev-shell">
          <div className="ev-heading-split">
            <div>
              <span className="ev-chapter">02 · INSPECT</span>
              <h2 id="evidence-heading">The answer behind the observation stays inspectable.</h2>
            </div>
            <p>The Question Record is the core V1 object: one approved question, its exact evidence, one registered change and a later check. This example is synthetic and does not represent a customer or live probe.</p>
          </div>

          <article className="ev-question-record" aria-label="Synthetic Question Record example">
            <header className="ev-record-header">
              <div>
                <span className="ev-mono">QUESTION RECORD · QR-EXAMPLE-001</span>
                <span className="ev-synthetic-label">SYNTHETIC EXAMPLE — NOT CUSTOMER DATA</span>
              </div>
              <span className="ev-record-state"><i aria-hidden="true" /> Protocol approved</span>
            </header>

            <div className="ev-record-question">
              <span className="ev-field-label">Approved buyer question</span>
              <h3>Which AI visibility platforms are suitable for a B2B SaaS team that needs auditable evidence?</h3>
              <p>Selected for commercial relevance · Approved version V1</p>
            </div>

            <dl className="ev-protocol-strip">
              <div><dt>Surface</dt><dd>Perplexity Sonar</dd></div>
              <div><dt>Sampling</dt><dd>Approved parameter</dd></div>
              <div><dt>Decision rule</dt><dd>Approved before calls</dd></div>
              <div><dt>Automation</dt><dd>Eligible after approval</dd></div>
            </dl>

            <div className="ev-evidence-grid">
              <div className="ev-answer-panel">
                <div className="ev-panel-heading">
                  <span className="ev-field-label">Synthetic answer excerpt</span>
                  <span className="ev-mono">PRESERVED</span>
                </div>
                <blockquote>
                  “[Synthetic excerpt] Competitor A is presented as a primary option for teams seeking documented evidence. Competitor B is also listed. The answer uses an independent category guide and first-party proof as supporting sources.”
                </blockquote>
                <p>This text demonstrates the evidence layout only. It is not a Perplexity response.</p>
              </div>

              <div className="ev-source-panel">
                <span className="ev-field-label">Source rows</span>
                <div className="ev-source-row">
                  <span>01</span><div><strong>example.org/category-guide</strong><small>Independent comparison · synthetic</small></div>
                </div>
                <div className="ev-source-row">
                  <span>02</span><div><strong>competitor-a.example/proof</strong><small>First-party evidence · synthetic</small></div>
                </div>
                <div className="ev-source-row">
                  <span>03</span><div><strong>example.org/buyer-method</strong><small>Method reference · synthetic</small></div>
                </div>
              </div>
            </div>

            <div className="ev-observation-block">
              <div className="ev-panel-heading">
                <span className="ev-field-label">Prompt-scoped observation</span>
                <span className="ev-mono">NO UNIVERSAL SCORE</span>
              </div>
              <div className="ev-brand-rows">
                <div><strong>Competitor A</strong><span className="ev-status ev-status-primary">Primary</span></div>
                <div><strong>Competitor B</strong><span className="ev-status ev-status-listed">Listed</span></div>
                <div><strong>Your Brand</strong><span className="ev-status ev-status-not-observed">Not observed</span></div>
                <div><strong>Competitor C</strong><span className="ev-status ev-status-ambiguous">Ambiguous</span></div>
              </div>
            </div>

            <div className="ev-intervention-row">
              <div>
                <span className="ev-field-label">Registered intervention</span>
                <strong>Strengthen one approved category-proof claim and preserve the implementation evidence.</strong>
                <small>Owner: Product Marketing · Confounders recorded · Observation window opens after proof</small>
              </div>
              <span className="ev-registration-stamp" aria-label="Registered before retest">REGISTERED<br />BEFORE RETEST</span>
            </div>

            <ol className="ev-retest-rail" aria-label="Retest sequence">
              <li className="is-complete"><span>Baseline</span><strong>Evidence preserved</strong></li>
              <li className="is-complete"><span>Registered</span><strong>Intervention frozen</strong></li>
              <li className="is-current"><span>Window</span><strong>Eligibility tracked</strong></li>
              <li><span>Retest</span><strong>Pending</strong></li>
            </ol>
          </article>
        </div>
      </section>

      <section className="ev-section ev-section-decide" aria-labelledby="decide-heading">
        <div className="ev-shell">
          <div className="ev-heading-split">
            <div>
              <span className="ev-chapter">03 · DECIDE</span>
              <h2 id="decide-heading">One bounded decision—not another visibility dashboard.</h2>
            </div>
            <p>The value is not the number of prompts or charts. It is the ability to inspect one commercially important observation and commit to one test before seeing the result.</p>
          </div>

          <div className="ev-decision-grid">
            <article><span>01</span><h3>Inspect</h3><p>See the exact answer, sources and prompt-scoped competitor frame.</p></article>
            <article><span>02</span><h3>Register</h3><p>Record one hypothesis, its owner and implementation evidence before retesting.</p></article>
            <article><span>03</span><h3>Retest</h3><p>Check the same approved question and preserve an honest outcome.</p></article>
          </div>

          <div className="ev-monitor-compare">
            <div>
              <span className="ev-field-label">Category monitoring</span>
              <h3>Shows what appeared across a broader prompt set.</h3>
              <p>Useful when the job is ongoing market observation.</p>
            </div>
            <div>
              <span className="ev-field-label">Zypact V1</span>
              <h3>Gives one question a record, an owner and a later check.</h3>
              <p>Useful when the team needs one defensible next decision.</p>
            </div>
          </div>

          <div className="ev-precision-callout">
            <span className="ev-mono">SELECTED FOR COMMERCIAL RELEVANCE</span>
            <p>“Which solution would a buyer evaluate for this exact need?”</p>
            <strong>One question is not a quota. It is the controlled unit of evidence.</strong>
          </div>
        </div>
      </section>

      <section id="method" className="ev-section ev-section-verify" aria-labelledby="method-heading">
        <div className="ev-shell">
          <div className="ev-heading-split">
            <div>
              <span className="ev-chapter">04 · VERIFY</span>
              <h2 id="method-heading">Approved first. Automated next. Checked before delivery.</h2>
            </div>
            <p>Automation is controlled by approval and integrity gates. Human review is an exception path for `needs_review`, not the normal V1 workflow.</p>
          </div>

          <AutomationFlow />

          <div className="ev-gate-grid" aria-label="V1 integrity delivery gates">
            <div><span className="ev-gate-dot ev-gate-pass" /><strong>integrity_passed</strong><p>Outcome Card and report delivered automatically.</p></div>
            <div><span className="ev-gate-dot ev-gate-review" /><strong>needs_review</strong><p>Exception held for human review before delivery.</p></div>
            <div><span className="ev-gate-dot ev-gate-blocked" /><strong>blocked</strong><p>No conclusion or report delivered as certainty.</p></div>
          </div>

          <div className="ev-outcome-card">
            <div className="ev-outcome-header">
              <div>
                <span className="ev-mono">OUTCOME CARD · SYNTHETIC STRUCTURE</span>
                <h3>The result does not decide whether the method “won.”</h3>
              </div>
              <span className="ev-record-state">Same question · versioned protocol</span>
            </div>

            <dl className="ev-outcome-summary">
              <div><dt>Baseline</dt><dd>Not observed</dd></div>
              <div><dt>Registered change</dt><dd>Approved proof strengthened</dd></div>
              <div><dt>Retest</dt><dd>Evidence preserved</dd></div>
            </dl>

            <div className="ev-outcome-options">
              {outcomes.map(([name, copy]) => (
                <div key={name}><strong>{name}</strong><p>{copy}</p></div>
              ))}
            </div>

            <div className="ev-limitations">
              <span className="ev-field-label">Limitations remain on the primary card</span>
              <p>Single surface. Prompt-scoped observation. Model and third-party source changes may affect the retest. Observed movement is not proof of causality or revenue impact.</p>
            </div>
          </div>

          <div className="ev-method-disclosures">
            <details>
              <summary>What the protocol fixes before execution <span aria-hidden="true">+</span></summary>
              <p>The approved question, Perplexity configuration, sampling plan, limits, decision threshold, estimated paid-call boundary and observation-window rule.</p>
            </details>
            <details>
              <summary>What evidence is preserved <span aria-hidden="true">+</span></summary>
              <p>Outbound requests, raw responses, sources, metadata, failures, canonical observations, integrity hashes and the versioned protocol behind them.</p>
            </details>
            <details>
              <summary>What V1 does not claim <span aria-hidden="true">+</span></summary>
              <p>No market-wide score, multi-model coverage, guaranteed recommendation, proven causality, automatic revenue attribution or certainty when the evidence is insufficient.</p>
            </details>
          </div>
        </div>
      </section>

      <section id="fit" className="ev-section ev-section-act" aria-labelledby="fit-heading">
        <div className="ev-shell">
          <div className="ev-heading-split">
            <div>
              <span className="ev-chapter">05 · ACT</span>
              <h2 id="fit-heading">Built for a team that can act on one important question.</h2>
            </div>
            <p>Zypact V1 is intentionally narrow. It is strongest when a B2B SaaS team has a comparison-heavy buying motion and can implement one documented evidence change.</p>
          </div>

          <div className="ev-fit-grid">
            <div>
              <span className="ev-field-label">A strong fit</span>
              <ul>
                <li>High-consideration B2B SaaS</li>
                <li>One commercially important buyer question</li>
                <li>A team able to implement one evidence change</li>
                <li>A need for inspectable evidence and an honest retest</li>
              </ul>
            </div>
            <div>
              <span className="ev-field-label">Not a fit yet</span>
              <ul>
                <li>Broad multi-model monitoring</li>
                <li>A universal AI visibility score</li>
                <li>Guaranteed rankings or recommendations</li>
                <li>Pipeline or revenue attribution from one observation</li>
              </ul>
            </div>
          </div>

          <div className="ev-deliverables">
            <div className="ev-subheading">
              <span className="ev-field-label">What V1 delivers</span>
              <h3>Six parts. One auditable learning loop.</h3>
            </div>
            <ol>
              {deliverables.map(([number, title, copy]) => (
                <li key={number}>
                  <span>{number}</span>
                  <div><strong>{title}</strong><p>{copy}</p></div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      <section id="faq" className="ev-section ev-faq" aria-labelledby="faq-heading">
        <div className="ev-shell ev-faq-grid">
          <div className="ev-faq-intro">
            <span className="ev-chapter">DUE DILIGENCE · FAQ</span>
            <h2 id="faq-heading">What V1 does—and does not claim.</h2>
            <p>Clear boundaries are part of the product. A partial or unsafe result is reviewed or blocked, not delivered as certainty.</p>
          </div>
          <div className="ev-faq-list">
            {faqs.map((faq, index) => (
              <details key={faq.question}>
                <summary><span>{String(index + 1).padStart(2, "0")}</span>{faq.question}<i aria-hidden="true">+</i></summary>
                <p>{faq.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="ev-final-cta" aria-labelledby="final-cta-heading">
        <div className="ev-shell ev-final-panel">
          <span className="ev-chapter">START WITH ONE QUESTION</span>
          <h2 id="final-cta-heading">Bring one buyer question worth examining.</h2>
          <p>Request access to the V1 workflow. The form does not approve a protocol or start an AI call. After the question and protocol are approved, the controlled baseline runs automatically.</p>
          <a href={demoRequestUrl} className="ev-button ev-button-primary ev-button-large">Request Demo</a>
          <span className="ev-final-note">PERPLEXITY SONAR V1 · AUTOMATED AFTER APPROVAL · HONEST OUTCOME</span>
        </div>
      </section>

      <footer className="ev-footer">
        <div className="ev-shell ev-footer-grid">
          <ZypactLogo href="#top" className="ev-wordmark" />
          <nav aria-label="Footer navigation">
            <a href="#evidence">Evidence</a>
            <a href="#method">Method</a>
            <a href="#faq">FAQ</a>
          </nav>
          <span>Perplexity Sonar V1 · © 2026 Zypact</span>
        </div>
      </footer>
    </main>
  );
}
