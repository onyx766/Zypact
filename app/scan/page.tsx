import type { CSSProperties } from "react";
import type { Metadata } from "next";
import {
  BarChart3,
  Check,
  ClipboardList,
  Database,
  FileSearch,
  Info,
  Repeat,
  Search,
  ShieldCheck,
} from "lucide-react";

import { AtmosphereCanvas } from "@/components/landing/canvas/atmosphere-canvas";
import { HowItWorks } from "@/components/landing/how-it-works";
import { LandingMotion } from "@/components/landing/landing-motion";
import { SiteFooter } from "@/components/landing/site-footer";
import { SiteHeader } from "@/components/marketing/site-header";
import { ThemeRoot } from "@/components/theme-root";

import { ScanForm } from "./scan-form";

export const metadata: Metadata = {
  // Absolute: the title already names Zypact, so the root "%s — Zypact"
  // template must not add it a second time.
  title: { absolute: "Request a Zypact V1 demo" },
  description:
    "Request access to Zypact's controlled, automated buyer-question diagnostic and registered retest on Perplexity Sonar.",
  alternates: {
    canonical: "/scan",
  },
};

/** What the engagement delivers. Process commitments, never outcomes. */
const HIGHLIGHTS = [
  "One commercially important buyer question, agreed before anything runs",
  "Exact provider evidence, preserved insert-only and inspectable",
  "A registered retest of the same question after one recorded change",
  "An auditable report where every number links to its supporting evidence",
] as const;

const SUMMARY = [
  {
    title: "One buyer question",
    desc: "Focus on one commercially meaningful question.",
    icon: FileSearch,
    tone: "is-teal",
  },
  {
    title: "Reviewed before any AI call",
    desc: "We review your question and protocol first.",
    icon: ShieldCheck,
    tone: "is-amber",
  },
  {
    title: "Evidence-backed result",
    desc: "A controlled run with exact evidence and integrity checks.",
    icon: Database,
    tone: "is-slate",
  },
] as const;

/**
 * The three stages between a request and a result, drawn with the landing's
 * How it works band.
 *
 * The approved design shows a product preview beside this with a cross-platform
 * comparison and a single "overall visibility" percentage. Neither is built:
 * Perplexity Sonar is the only live V1 surface, and a universal visibility
 * number is exactly the claim the methodology forbids. These stages describe
 * what actually happens instead.
 */
const STAGES = [
  {
    title: "Submit a buyer question",
    icon: ClipboardList,
    copy: "Share one real question a prospective customer might ask when comparing products like yours.",
  },
  {
    title: "Run a controlled baseline",
    icon: Search,
    copy: "After the question and protocol are approved, Zypact launches the bounded Perplexity Sonar baseline.",
  },
  {
    title: "Review evidence and results",
    icon: BarChart3,
    copy: "Read the prompt-scoped observations with the exact provider evidence behind every one of them.",
  },
] as const;

/** Footer uses only live links on the latest Reflex V3 homepage. */
const FOOTER = {
  tagline: "AI answer measurement for B2B SaaS.",
  columns: [
    {
      heading: "Explore",
      links: [
        { label: "Product", href: "/#product" },
        { label: "How it works", href: "/#how-it-works" },
        { label: "Use cases", href: "/#use-cases" },
      ],
    },
    {
      heading: "Learn",
      links: [
        { label: "Methodology", href: "/#methodology" },
        { label: "Founding pilots", href: "/#beta" },
        { label: "FAQ", href: "/#faq" },
      ],
    },
    {
      heading: "Get in touch",
      links: [
        { label: "Request a walkthrough", href: "#request-form" },
        { label: "contact@zypact.com", href: "mailto:contact@zypact.com" },
        { label: "Back to homepage", href: "/" },
      ],
    },
  ],
  bottomLine:
    "Directional API observations · Launched by Zypact after approval · No guaranteed outcome",
  copyright: "© 2026 Zypact, Inc. All rights reserved.",
} as const;

/** Match the sections on the new Reflex homepage, not the retired one. */
const REFLEX_NAV = [
  { label: "Product", href: "/#product" },
  { label: "How it works", href: "/#how-it-works" },
  { label: "Use cases", href: "/#use-cases" },
  { label: "Methodology", href: "/#methodology" },
  { label: "Founding pilots", href: "/#beta" },
] as const;

/** `--i` orders the CSS load choreography (`lx-intro` in base.css). */
const order = (index: number) => ({ "--i": index }) as CSSProperties;

export default function ScanPage() {
  const enabled = process.env.SNAPSHOT_PUBLIC_FORM_ENABLED === "true";

  return (
    // The landing's `.lx` scope, so every CTA arrives on the same design. The
    // form itself uses only the CSS-only `lx-intro` entrance — never
    // data-reveal — so it is visible before hydration and without JavaScript.
    <ThemeRoot theme="light" className="lx scan-reflex">
      <LandingMotion />
      <AtmosphereCanvas />
      <div className="lx-grain" aria-hidden="true" />

      <SiteHeader cta={{ label: "Request demo", href: "#request-form" }} links={REFLEX_NAV} />

      <main className="relative z-[1]">
        {/* -------------------------------------------------------------- Hero */}
        <section
          className="lx-request-hero pb-20 pt-10 sm:pb-24 sm:pt-14 lg:pb-28 lg:pt-16"
          aria-labelledby="request-title"
        >
          <div className="shell grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.94fr)] lg:gap-14">
            {/* ------------------------------------------------ Left column */}
            <div className="max-w-xl">
              <p className="lx-eyebrow lx-eyebrow--rule lx-intro" style={order(0)}>
                Zypact V1 · Controlled execution
              </p>

              <h1
                id="request-title"
                className="lx-display lx-intro mt-5 text-[40px] sm:mt-6 sm:text-[52px] lg:text-[58px]"
                style={order(1)}
              >
                Request a Zypact demo
              </h1>

              <p className="lx-lede lx-intro mt-6" style={order(2)}>
                See how your company appears in an AI buyer answer. Bring one
                commercially important buyer question. Zypact reviews the
                question and protocol first. After approval, the controlled
                Perplexity Sonar baseline is launched by Zypact and preserves the
                evidence.
              </p>

              <ul className="lx-request-points lx-intro mt-8" style={order(3)}>
                {HIGHLIGHTS.map((point) => (
                  <li key={point} className="lx-request-point">
                    <span className="lx-request-coin" aria-hidden="true">
                      <Check strokeWidth={2.5} />
                    </span>
                    <span>{point}</span>
                  </li>
                ))}
              </ul>

              <p className="lx-request-note lx-intro mt-8" style={order(4)}>
                <Info strokeWidth={2} aria-hidden="true" />
                <span>Submitting this form does not start an AI call.</span>
              </p>

              <ul className="lx-request-summary lx-intro mt-8" style={order(5)}>
                {SUMMARY.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.title} className="lx-request-summary__item">
                      <span
                        className={`lx-request-summary__icon ${item.tone}`}
                        aria-hidden="true"
                      >
                        <Icon strokeWidth={1.9} />
                      </span>
                      <span className="min-w-0">
                        <span className="lx-request-summary__title">
                          {item.title}
                        </span>
                        <span className="lx-request-summary__desc">
                          {item.desc}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>

              <p
                className="lx-intro mt-8 border-t border-border pt-5 text-[11px] font-medium uppercase leading-[1.75] tracking-[0.14em] text-muted-foreground"
                style={order(6)}
              >
                V1 surface: Perplexity Sonar only. No market-wide score,
                causal promise, or revenue attribution.
              </p>
            </div>

            {/* ----------------------------------------------- Right column */}
            {/* top-[108px] clears the sticky 64–68px header with room to spare. */}
            <div className="lg:sticky lg:top-[108px] lg:self-start">
              <div
                id="request-form"
                className="lx-card lx-request-card lx-intro"
                style={order(2)}
              >
                <ScanForm enabled={enabled} />
              </div>
            </div>
          </div>
        </section>

        {/* ----------------------------------------------------- How it works */}
        {/* Not "how-it-works": that id drives the header scrollspy on / only. */}
        <HowItWorks
          id="request-steps"
          eyebrow="How it works"
          title="From question to insights in three steps"
          lede="Nothing runs until the question and protocol are approved. After that, Zypact launches the controlled baseline."
          steps={STAGES}
          layout="three"
        />

        {/* Reflex V3 trust / limits: no legacy dark status band or dead links. */}
        <section
          className="lx-scan-clarity py-16 sm:py-20"
          aria-labelledby="scan-clarity-heading"
        >
          <div className="shell">
            <div className="lx-scan-clarity-layout">
              <div className="lx-scan-clarity-copy">
                <span className="lx-scan-clarity-eyebrow">CLEAR BY DESIGN</span>
                <h2 id="scan-clarity-heading">
                  Know what the evidence can—and cannot—tell you.
                </h2>
                <p>
                  Your pilot starts with an agreed buyer question and documented
                  measurement conditions. We explain competitor observations and
                  cited sources alongside the uncertainty, instead of promising
                  a universal visibility score.
                </p>
                <a href="mailto:contact@zypact.com" className="lx-scan-clarity-contact">
                  Questions? Contact our team
                </a>
              </div>
              <div className="lx-scan-clarity-card">
                <p className="lx-scan-clarity-card__eyebrow">MEASUREMENT LIMITS</p>
                <h3>Evidence, not a guaranteed outcome.</h3>
                <p>
                  Every retest ends in one of four statuses — increase observed,
                  decrease observed, no clear change, or inconclusive. Zypact
                  guarantees the agreed process and evidence contract, not a
                  favorable model response.
                </p>
                <div className="lx-scan-clarity-rule" />
                <p>
                  OpenAI API responses with web search can differ from what
                  people see in the ChatGPT app. Pilot engine availability,
                  question count, duration and retesting are confirmed with
                  Zypact before any measurement.
                </p>
                <p className="lx-scan-clarity-footnote">
                  A form submission is only a request. No paid AI call starts
                  until the question and protocol are approved.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter {...FOOTER} />
    </ThemeRoot>
  );
}
