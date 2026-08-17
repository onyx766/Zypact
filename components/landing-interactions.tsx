"use client";

import {
  useEffect,
  useState,
} from "react";
import { ZypactLogo } from "@/components/zypact-logo";

const demoQuestions = [
  {
    question:
      "Which AI visibility platforms are suitable for a B2B SaaS team that needs auditable evidence?",
    intent: "Category evaluation",
    protocol: "Approved",
    evidenceState: "Preserved",
    observedCompetitor: "Competitor A",
    retestState: "Scheduled",
    intervention:
      "Strengthen one approved category-proof claim and record the implementation evidence.",
    brands: [
      [
        "Competitor A",
        "Primary",
        "recommended",
      ],
      ["Competitor B", "Listed", "cited"],
      [
        "Your Brand",
        "Not observed",
        "absent",
      ],
      [
        "Competitor C",
        "Ambiguous",
        "mentioned",
      ],
    ],
  },
  {
    question:
      "What should a product-marketing team use to inspect competitor evidence in AI answers?",
    intent: "Use-case fit",
    protocol: "Approved",
    evidenceState: "Preserved",
    observedCompetitor: "Competitor B",
    retestState: "Window open",
    intervention:
      "Publish the approved use-case evidence and wait through the recorded observation window.",
    brands: [
      [
        "Competitor B",
        "Primary",
        "recommended",
      ],
      ["Your Brand", "Listed", "cited"],
      [
        "Competitor A",
        "Ambiguous",
        "mentioned",
      ],
      [
        "Competitor C",
        "Not observed",
        "absent",
      ],
    ],
  },
  {
    question:
      "Which tools help B2B SaaS teams connect an AI-answer observation to one testable intervention?",
    intent: "Workflow fit",
    protocol: "Approved",
    evidenceState: "Preserved",
    observedCompetitor: "Competitor C",
    retestState: "Not yet eligible",
    intervention:
      "Register one comparison-page hypothesis before implementation and preserve the exact baseline.",
    brands: [
      ["Your Brand", "Primary", "recommended"],
      ["Competitor C", "Listed", "cited"],
      [
        "Competitor A",
        "Ambiguous",
        "mentioned",
      ],
      [
        "Competitor B",
        "Not observed",
        "absent",
      ],
    ],
  },
] as const;

const heroProcess = [
  {
    number: "01",
    tag: "QUESTION",
    title: "Approved question",
    detail: "Commercial context recorded",
  },
  {
    number: "02",
    tag: "PROTOCOL",
    title: "Bounded protocol",
    detail: "Sampling + limits approved",
  },
  {
    number: "03",
    tag: "EVIDENCE",
    title: "Exact baseline",
    detail: "Attempts preserved immutably",
  },
  {
    number: "04",
    tag: "INTERVENTION",
    title: "One hypothesis",
    detail: "Owner + implementation recorded",
  },
  {
    number: "05",
    tag: "RETEST",
    title: "Outcome Card",
    detail: "Retest after the window",
  },
] as const;

function useReducedMotion(): boolean {
  const [reduced, setReduced] =
    useState(false);

  useEffect(() => {
    const media = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    );
    const update = () =>
      setReduced(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () =>
      media.removeEventListener?.(
        "change",
        update
      );
  }, []);

  return reduced;
}

export function HeroProcessViz() {
  const [active, setActive] = useState(0);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (reducedMotion) return;

    const timer = window.setInterval(() => {
      setActive(
        (current) =>
          (current + 1) % heroProcess.length
      );
    }, 2200);

    return () =>
      window.clearInterval(timer);
  }, [reducedMotion]);

  return (
    <div
      className="di-process-card"
      aria-label="Illustration of the bounded Zypact V1 pilot workflow"
    >
      <div className="di-process-head">
        <span className="di-mono-label">
          V1 PILOT FLOW
        </span>
        <span className="di-process-auto">
          BOUNDED · EXAMPLE
        </span>
      </div>

      <div className="di-process-track">
        {heroProcess.map((step, index) => (
          <div
            key={step.number}
            className={
              `di-process-step ${
                index === active
                  ? "is-active"
                  : ""
              } ${
                index < active ? "is-done" : ""
              }`
            }
          >
            <span className="di-process-number">
              {step.number}
            </span>
            <span className="di-process-copy">
              <strong>{step.title}</strong>
              <small>{step.detail}</small>
            </span>
            <span className="di-process-tag">
              {step.tag}
            </span>
          </div>
        ))}
      </div>

      <div className="di-process-foot">
        <span>Auditable evidence</span>
        <span aria-hidden="true">→</span>
        <strong>honest next decision</strong>
      </div>
    </div>
  );
}

const workflow = [
  {
    number: "01",
    title: "Approve the buyer question",
    tag: "QUESTION",
    copy:
      "Record one commercially meaningful buyer question, its source, context, intent, and immutable approved version.",
  },
  {
    number: "02",
    title: "Approve the protocol",
    tag: "PROTOCOL",
    copy:
      "Agree on the Perplexity configuration, sampling plan, limits, decision threshold, estimated cost, and observation-window rule before paid calls.",
  },
  {
    number: "03",
    title: "Preserve baseline evidence",
    tag: "EVIDENCE",
    copy:
      "Run the bounded baseline asynchronously and preserve every exact request, raw response, source, failure, and canonical observation.",
  },
  {
    number: "04",
    title: "Register one intervention",
    tag: "INTERVENTION",
    copy:
      "Choose one evidence-backed hypothesis, record the owner and implementation proof, note confounders, and open the observation window.",
  },
  {
    number: "05",
    title: "Retest after eligibility",
    tag: "RETEST",
    copy:
      "Check the same question under the preserved or explicitly versioned protocol and issue an Outcome Card with limitations and uncertainty.",
  },
] as const;

export function LandingNav({
  demoRequestUrl,
}: {
  demoRequestUrl: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <header className="di-nav-shell">
      <div className="di-nav">
        <ZypactLogo
          href="#top"
          priority
          className="di-wordmark"
        />

        <nav
          className="di-nav-links"
          aria-label="Primary navigation"
        >
          <a href="#what-you-get">
            What you get
          </a>
          <a href="#how-it-works">
            How it works
          </a>
          <a href="#faq">FAQ</a>
        </nav>

        <a
          href={demoRequestUrl}
          className="di-button di-button-primary di-nav-cta"
        >
          Request Demo
        </a>

        <button
          type="button"
          className="di-menu-button"
          aria-label="Toggle navigation menu"
          aria-expanded={open}
          aria-controls="di-mobile-menu"
          onClick={() =>
            setOpen((value) => !value)
          }
        >
          <span />
          <span />
        </button>
      </div>

      <div
        id="di-mobile-menu"
        className={
          `di-mobile-menu ${
            open ? "is-open" : ""
          }`
        }
        hidden={!open}
      >
        <a
          href="#what-you-get"
          onClick={() => setOpen(false)}
        >
          What you get
        </a>
        <a
          href="#how-it-works"
          onClick={() => setOpen(false)}
        >
          How it works
        </a>
        <a
          href="#faq"
          onClick={() => setOpen(false)}
        >
          FAQ
        </a>
        <a
          href={demoRequestUrl}
          className="di-button di-button-primary"
          onClick={() => setOpen(false)}
        >
          Request Demo
        </a>
      </div>
    </header>
  );
}

export function ProtocolDemo() {
  const [selected, setSelected] = useState(0);
  const [manual, setManual] = useState(false);
  const reducedMotion = useReducedMotion();
  const demo = demoQuestions[selected];

  useEffect(() => {
    if (manual || reducedMotion) return;

    const timer = window.setInterval(() => {
      setSelected(
        (current) =>
          (current + 1) % demoQuestions.length
      );
    }, 5200);

    return () =>
      window.clearInterval(timer);
  }, [manual, reducedMotion]);

  return (
    <div className="di-demo-layout">
      <div
        className="di-demo-auto-bar"
        aria-hidden="true"
      >
        <span>
          {manual ? "MANUAL" : "V1 EXAMPLE"}
        </span>
        <div>
          {demoQuestions.map((query, index) => (
            <i
              key={query.question}
              className={
                index === selected
                  ? "is-active"
                  : ""
              }
            />
          ))}
        </div>
      </div>

      <div
        className="di-query-picker"
        role="tablist"
        aria-label="Synthetic approved buyer question examples"
      >
        {demoQuestions.map((query, index) => (
          <button
            key={query.question}
            type="button"
            role="tab"
            aria-selected={selected === index}
            className={
              `di-query-button ${
                selected === index
                  ? "is-active"
                  : ""
              }`
            }
            onClick={() => {
              setManual(true);
              setSelected(index);
            }}
          >
            <span className="di-query-index">
              0{index + 1}
            </span>
            <span>{query.question}</span>
          </button>
        ))}
      </div>

      <div
        className="di-signal-panel"
        role="tabpanel"
      >
        <div className="di-panel-topline">
          <div>
            <span className="di-mono-label">
              BOUNDED PROTOCOL EXAMPLE
            </span>
            <p>{demo.question}</p>
          </div>
          <span className="di-simulation-badge">
            SIMULATION
          </span>
        </div>

        <div className="di-brand-list">
          {demo.brands.map(
            ([brand, status, tone]) => (
              <div
                className="di-brand-row"
                key={brand}
              >
                <span
                  className={
                    brand === "Your Brand"
                      ? "di-your-brand"
                      : ""
                  }
                >
                  {brand}
                </span>
                <span
                  className={
                    `di-status di-status-${tone}`
                  }
                >
                  {status}
                </span>
              </div>
            )
          )}
        </div>

        <div className="di-demo-metrics">
          <div>
            <span>Protocol</span>
            <strong>{demo.protocol}</strong>
          </div>
          <div>
            <span>Evidence</span>
            <strong>{demo.evidenceState}</strong>
          </div>
          <div>
            <span>Observed competitor</span>
            <strong>
              {demo.observedCompetitor}
            </strong>
          </div>
          <div>
            <span>Retest</span>
            <strong>{demo.retestState}</strong>
          </div>
        </div>

        <div className="di-first-fix">
          <span className="di-mono-label">
            REGISTERED INTERVENTION HYPOTHESIS
          </span>
          <strong>{demo.intervention}</strong>
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
      <div
        className="di-step-selector"
        role="tablist"
        aria-label="How the Zypact V1 pilot works"
      >
        {workflow.map((item, index) => (
          <button
            key={item.number}
            type="button"
            role="tab"
            aria-selected={active === index}
            className={
              `di-step-button ${
                active === index
                  ? "is-active"
                  : ""
              }`
            }
            onClick={() => setActive(index)}
          >
            <span className="di-step-number">
              {item.number}
            </span>
            <span>{item.title}</span>
            <span
              className="di-step-dot"
              aria-hidden="true"
            />
          </button>
        ))}
      </div>

      <div
        className="di-step-detail"
        role="tabpanel"
      >
        <div
          className="di-step-progress"
          aria-hidden="true"
        >
          {workflow.map((item, index) => (
            <span
              key={item.number}
              className={
                index <= active
                  ? "is-active"
                  : ""
              }
            />
          ))}
        </div>

        <span className="di-mono-label">
          {step.tag} · STEP {step.number}
        </span>
        <h3>{step.title}</h3>
        <p>{step.copy}</p>
        <div
          className="di-step-terminal"
          aria-hidden="true"
        >
          <span>
            $ zypact / {step.tag.toLowerCase()}
          </span>
          <span className="di-terminal-cursor" />
        </div>
      </div>
    </div>
  );
}
