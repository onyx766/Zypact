"use client";

import { useEffect, useState } from "react";
import { ZypactLogo } from "@/components/zypact-logo";

const orbitSteps = [
  { short: "Approve", label: "Question + protocol" },
  { short: "Perplexity", label: "Perplexity Sonar" },
  { short: "Evidence", label: "Exact answer + sources" },
  { short: "Observe", label: "Competitor frame" },
  { short: "Register", label: "One intervention" },
  { short: "Retest", label: "Same-question retest" },
] as const;

const workflow = [
  {
    number: "01",
    title: "Approve the question and protocol",
    tag: "APPROVAL",
    copy: "Zypact prepares one commercially important buyer question and a bounded Perplexity protocol. Nothing runs until the question, limits, sampling plan and observation window are approved.",
  },
  {
    number: "02",
    title: "Run the baseline automatically",
    tag: "AUTOMATION",
    copy: "After approval, V1 queues the controlled Perplexity calls automatically. Every attempt, response, source and failure remains attached to the approved protocol.",
  },
  {
    number: "03",
    title: "Preserve and check the evidence",
    tag: "INTEGRITY",
    copy: "Zypact stores the exact evidence, builds the prompt-scoped competitor frame and checks the record before any conclusion can be delivered.",
  },
  {
    number: "04",
    title: "Register one intervention",
    tag: "INTERVENTION",
    copy: "Your team approves one evidence-backed hypothesis, records its owner and implementation proof, and opens the explicit observation window.",
  },
  {
    number: "05",
    title: "Retest and deliver automatically",
    tag: "OUTCOME",
    copy: "When eligible, V1 checks the same question again. An integrity-passed record produces the Outcome Card automatically; exceptions are held for review and blocked evidence is not delivered.",
  },
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

export function LandingNav({ demoRequestUrl }: { demoRequestUrl: string }) {
  const [open, setOpen] = useState(false);

  return (
    <header className="ev-nav-shell">
      <div className="ev-shell ev-nav">
        <ZypactLogo href="#top" priority className="ev-wordmark" />

        <nav className="ev-nav-links" aria-label="Primary navigation">
          <a href="#evidence">Evidence</a>
          <a href="#method">Method</a>
          <a href="#fit">Who it&apos;s for</a>
          <a href="#faq">FAQ</a>
        </nav>

        <a href={demoRequestUrl} className="ev-button ev-button-primary ev-nav-cta">
          Request Demo
        </a>

        <button
          type="button"
          className="ev-menu-button"
          aria-label="Toggle navigation menu"
          aria-expanded={open}
          aria-controls="ev-mobile-menu"
          onClick={() => setOpen((value) => !value)}
        >
          <span />
          <span />
        </button>
      </div>

      <nav
        id="ev-mobile-menu"
        className={"ev-mobile-menu " + (open ? "is-open" : "")}
        aria-label="Mobile navigation"
        hidden={!open}
      >
        <a href="#evidence" onClick={() => setOpen(false)}>Evidence</a>
        <a href="#method" onClick={() => setOpen(false)}>Method</a>
        <a href="#fit" onClick={() => setOpen(false)}>Who it&apos;s for</a>
        <a href="#faq" onClick={() => setOpen(false)}>FAQ</a>
        <a href={demoRequestUrl} className="ev-button ev-button-primary" onClick={() => setOpen(false)}>
          Request Demo
        </a>
      </nav>
    </header>
  );
}

export function EvidenceOrbit() {
  const [active, setActive] = useState(0);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (reducedMotion) return;
    const timer = window.setInterval(() => {
      setActive((current) => (current + 1) % orbitSteps.length);
    }, 1700);
    return () => window.clearInterval(timer);
  }, [reducedMotion]);

  return (
    <figure className="ev-orbit-card" aria-labelledby="orbit-title orbit-caption">
      <div className="ev-orbit-header">
        <span className="ev-mono">CONTROLLED V1 WORKFLOW</span>
        <span className="ev-live-status"><i aria-hidden="true" /> AUTOMATED AFTER APPROVAL</span>
      </div>

      <div className="ev-orbit-stage">
        <svg className="ev-orbit-lines" viewBox="0 0 520 430" aria-hidden="true">
          <defs>
            <marker id="orbit-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" />
            </marker>
          </defs>
          <path d="M260 214 L260 70" />
          <path d="M260 214 L425 139" />
          <path d="M260 214 L425 311" />
          <path d="M260 214 L260 372" />
          <path d="M260 214 L95 311" />
          <path d="M260 214 L95 139" />
          <circle cx="260" cy="214" r="158" />
        </svg>

        <div className="ev-orbit-center">
          <span className="ev-mono">UNIT OF EVIDENCE</span>
          <strong id="orbit-title">Buyer question</strong>
          <small>approved · versioned · preserved</small>
        </div>

        {orbitSteps.map((step, index) => (
          <div
            key={step.short}
            className={"ev-orbit-node ev-orbit-node--" + (index + 1) + (index === active ? " is-active" : "")}
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{step.short}</strong>
            <small>{step.label}</small>
          </div>
        ))}
      </div>

      <figcaption id="orbit-caption">
        One approved question moves through one bounded Perplexity evidence loop. Other AI surfaces are not represented because they are not part of V1.
      </figcaption>
    </figure>
  );
}

export function AutomationFlow() {
  const [active, setActive] = useState(0);
  const step = workflow[active];

  return (
    <div className="ev-workflow">
      <div className="ev-workflow-tabs" role="tablist" aria-label="Automated Zypact V1 workflow">
        {workflow.map((item, index) => (
          <button
            key={item.number}
            type="button"
            role="tab"
            aria-selected={active === index}
            aria-controls="ev-workflow-panel"
            className={active === index ? "is-active" : ""}
            onClick={() => setActive(index)}
          >
            <span>{item.number}</span>
            <strong>{item.title}</strong>
          </button>
        ))}
      </div>

      <div id="ev-workflow-panel" className="ev-workflow-panel" role="tabpanel">
        <div className="ev-workflow-progress" aria-hidden="true">
          {workflow.map((item, index) => (
            <i key={item.number} className={index <= active ? "is-active" : ""} />
          ))}
        </div>
        <span className="ev-mono">{step.tag} · STEP {step.number}</span>
        <h3>{step.title}</h3>
        <p>{step.copy}</p>
        <div className="ev-workflow-state">
          <span>Normal path</span>
          <strong>{active < 4 ? "Controlled automation" : "integrity_passed → automatic delivery"}</strong>
        </div>
      </div>
    </div>
  );
}
