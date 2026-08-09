"use client";

import { useEffect, useState } from "react";
import { ZypactLogo } from "@/components/zypact-logo";

const demoQueries = [
  {
    question: "What are the best AI visibility tools for B2B SaaS?",
    signal: "Competitive discovery",
    recommendationRate: "20%",
    citationRate: "0%",
    topCompetitor: "Competitor A",
    firstFix: "Add an evidence-led category comparison page",
    brands: [
      ["Competitor A", "Recommended"],
      ["Competitor B", "Cited"],
      ["Your Brand", "Absent"],
      ["Competitor C", "Mentioned"],
    ],
  },
  {
    question: "What should a growth team use for AI visibility diagnostics?",
    signal: "Category association",
    recommendationRate: "40%",
    citationRate: "20%",
    topCompetitor: "Competitor B",
    firstFix: "Strengthen proof around the buyer use case",
    brands: [
      ["Competitor B", "Recommended"],
      ["Your Brand", "Mentioned"],
      ["Competitor A", "Cited"],
      ["Competitor C", "Absent"],
    ],
  },
  {
    question: "What tools help B2B SaaS teams understand why AI recommends competitors?",
    signal: "Proof gap",
    recommendationRate: "60%",
    citationRate: "20%",
    topCompetitor: "Competitor C",
    firstFix: "Publish specific proof for the losing buying frame",
    brands: [
      ["Your Brand", "Cited"],
      ["Competitor C", "Recommended"],
      ["Competitor A", "Mentioned"],
      ["Competitor B", "Absent"],
    ],
  },
] as const;


const heroProcess = [
  { number: "01", tag: "INPUT", title: "Buyer question", detail: "Commercial prompt selected" },
  { number: "02", tag: "PROBE", title: "AI run", detail: "Perplexity answer captured" },
  { number: "03", tag: "MAP", title: "Evidence map", detail: "Brands + sources observed" },
  { number: "04", tag: "FIX", title: "First fix", detail: "One action prioritized" },
  { number: "05", tag: "RETEST", title: "Re-test", detail: "Same buyer frame checked again" },
] as const;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  return reduced;
}

export function HeroProcessViz() {
  const [active, setActive] = useState(0);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (reducedMotion) return;
    const timer = window.setInterval(() => {
      setActive((current) => (current + 1) % heroProcess.length);
    }, 2200);
    return () => window.clearInterval(timer);
  }, [reducedMotion]);

  return (
    <div className="di-process-card" aria-label="Illustration of the Zypact snapshot workflow">
      <div className="di-process-head">
        <span className="di-mono-label">SNAPSHOT FLOW</span>
        <span className="di-process-auto">AUTO · EXAMPLE</span>
      </div>
      <div className="di-process-track">
        {heroProcess.map((step, index) => (
          <div
            key={step.number}
            className={`di-process-step ${index === active ? "is-active" : ""} ${index < active ? "is-done" : ""}`}
          >
            <span className="di-process-number">{step.number}</span>
            <span className="di-process-copy">
              <strong>{step.title}</strong>
              <small>{step.detail}</small>
            </span>
            <span className="di-process-tag">{step.tag}</span>
          </div>
        ))}
      </div>
      <div className="di-process-foot">
        <span>Observed evidence</span>
        <span aria-hidden="true">→</span>
        <strong>one testable next step</strong>
      </div>
    </div>
  );
}

const workflow = [
  {
    number: "01",
    title: "Buyer question",
    tag: "INPUT",
    copy: "We start from a real question a buyer could ask when evaluating your category, alternatives, or product options.",
  },
  {
    number: "02",
    title: "Live AI runs",
    tag: "PROBE",
    copy: "The question is tested through Perplexity Sonar in real time — no cached or synthetic answers in the real snapshot.",
  },
  {
    number: "03",
    title: "Evidence mapping",
    tag: "ANALYZE",
    copy: "We map the competitors, sources, and observable evidence around the result without pretending to know the model's hidden causal reasoning.",
  },
  {
    number: "04",
    title: "First fix",
    tag: "FIX",
    copy: "We surface one specific, evidence-backed action worth testing instead of a generic audit checklist.",
  },
  {
    number: "05",
    title: "Re-test path",
    tag: "RETEST",
    copy: "You know which buyer question to check again after the intervention so progress can be observed against the same frame.",
  },
] as const;

export function LandingNav({ snapshotFormUrl }: { snapshotFormUrl: string }) {
  const [open, setOpen] = useState(false);

  return (
    <header className="di-nav-shell">
      <div className="di-nav">
        <ZypactLogo href="#top" priority className="di-wordmark" />

        <nav className="di-nav-links" aria-label="Primary navigation">
          <a href="#what-you-get">What you get</a>
          <a href="#how-it-works">How it works</a>
          <a href="#faq">FAQ</a>
        </nav>

        <a href={snapshotFormUrl} className="di-button di-button-primary di-nav-cta">
          Request free snapshot
        </a>

        <button
          type="button"
          className="di-menu-button"
          aria-label="Toggle navigation menu"
          aria-expanded={open}
          aria-controls="di-mobile-menu"
          onClick={() => setOpen((value) => !value)}
        >
          <span />
          <span />
        </button>
      </div>

      <div id="di-mobile-menu" className={`di-mobile-menu ${open ? "is-open" : ""}`} hidden={!open}>
        <a href="#what-you-get" onClick={() => setOpen(false)}>What you get</a>
        <a href="#how-it-works" onClick={() => setOpen(false)}>How it works</a>
        <a href="#faq" onClick={() => setOpen(false)}>FAQ</a>
        <a href={snapshotFormUrl} className="di-button di-button-primary" onClick={() => setOpen(false)}>
          Request free snapshot
        </a>
      </div>
    </header>
  );
}

export function SyntheticDemo() {
  const [selected, setSelected] = useState(0);
  const [manual, setManual] = useState(false);
  const reducedMotion = useReducedMotion();
  const demo = demoQueries[selected];

  useEffect(() => {
    if (manual || reducedMotion) return;
    const timer = window.setInterval(() => {
      setSelected((current) => (current + 1) % demoQueries.length);
    }, 5200);
    return () => window.clearInterval(timer);
  }, [manual, reducedMotion]);

  return (
    <div className="di-demo-layout">
      <div className="di-demo-auto-bar" aria-hidden="true">
        <span>{manual ? "MANUAL" : "AUTO DEMO"}</span>
        <div>{demoQueries.map((query, index) => <i key={query.question} className={index === selected ? "is-active" : ""} />)}</div>
      </div>
      <div className="di-query-picker" role="tablist" aria-label="Synthetic buyer question examples">
        {demoQueries.map((query, index) => (
          <button
            key={query.question}
            type="button"
            role="tab"
            aria-selected={selected === index}
            className={`di-query-button ${selected === index ? "is-active" : ""}`}
            onClick={() => { setManual(true); setSelected(index); }}
          >
            <span className="di-query-index">0{index + 1}</span>
            <span>{query.question}</span>
          </button>
        ))}
      </div>

      <div className="di-signal-panel" role="tabpanel">
        <div className="di-panel-topline">
          <div>
            <span className="di-mono-label">AI VISIBILITY EXAMPLE</span>
            <p>{demo.question}</p>
          </div>
          <span className="di-simulation-badge">SIMULATION</span>
        </div>

        <div className="di-brand-list">
          {demo.brands.map(([brand, status]) => (
            <div className="di-brand-row" key={brand}>
              <span className={brand === "Your Brand" ? "di-your-brand" : ""}>{brand}</span>
              <span className={`di-status di-status-${status.toLowerCase()}`}>{status}</span>
            </div>
          ))}
        </div>

        <div className="di-demo-metrics">
          <div><span>Recommendation rate</span><strong>{demo.recommendationRate}</strong></div>
          <div><span>Citation rate</span><strong>{demo.citationRate}</strong></div>
          <div><span>Top competitor</span><strong>{demo.topCompetitor}</strong></div>
          <div><span>Signal</span><strong>{demo.signal}</strong></div>
        </div>

        <div className="di-first-fix">
          <span className="di-mono-label">FIRST FIX WORTH TESTING</span>
          <strong>{demo.firstFix}</strong>
        </div>
      </div>
    </div>
  );
}

export function HowItWorks() {
  const [active, setActive] = useState(0);
  const step = workflow[active];

  return (
    <div className="di-workflow-layout">
      <div className="di-step-selector" role="tablist" aria-label="How Zypact works">
        {workflow.map((item, index) => (
          <button
            key={item.number}
            type="button"
            role="tab"
            aria-selected={active === index}
            className={`di-step-button ${active === index ? "is-active" : ""}`}
            onClick={() => setActive(index)}
          >
            <span className="di-step-number">{item.number}</span>
            <span>{item.title}</span>
            <span className="di-step-dot" aria-hidden="true" />
          </button>
        ))}
      </div>

      <div className="di-step-detail" role="tabpanel">
        <div className="di-step-progress" aria-hidden="true">
          {workflow.map((item, index) => (
            <span key={item.number} className={index <= active ? "is-active" : ""} />
          ))}
        </div>
        <span className="di-mono-label">{step.tag} · STEP {step.number}</span>
        <h3>{step.title}</h3>
        <p>{step.copy}</p>
        <div className="di-step-terminal" aria-hidden="true">
          <span>$ zypact / {step.tag.toLowerCase()}</span>
          <span className="di-terminal-cursor" />
        </div>
      </div>
    </div>
  );
}
