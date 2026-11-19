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
  title: { absolute: "Request a Zypact walkthrough" },
  description:
    "Discuss a guided Zypact measurement pilot for B2B SaaS buyer questions, competitor observations, and cited-source evidence. Scope is confirmed before execution.",
  alternates: {
    canonical: "/scan",
  },
};

/** What the engagement delivers. Process commitments, never outcomes. */
const HIGHLIGHTS = [
  "Start with one real buyer question; discuss the wider pilot scope",
  "Review recorded AI answers, competitor observations, and cited-source evidence",
  "Agree on engines, sampling, and deliverables before execution",
  "Discuss follow-up measurements when included in the agreed pilot",
] as const;

const SUMMARY = [
  {
    title: "Start with one buyer question",
    desc: "Tell us what a potential customer might ask.",
    icon: FileSearch,
    tone: "is-teal",
  },
  {
    title: "Scope confirmed first",
    desc: "Our team confirms available engines and the measurement protocol.",
    icon: ShieldCheck,
    tone: "is-amber",
  },
  {
    title: "Evidence with limitations",
    desc: "Understand what was observed and what remains uncertain.",
    icon: Database,
    tone: "is-slate",
  },
] as const;

/**
 * Three stages of a walkthrough request, not the product's full five-step
 * measurement workflow. Provider availability and paid-pilot scope are always
 * confirmed by the team before execution. Never imply a market-wide score.
 */
const STAGES = [
  {
    title: "Share a buyer question",
    icon: ClipboardList,
    copy: "Share one real question a prospective customer might ask when comparing products like yours.",
  },
  {
    title: "Agree on pilot scope",
    icon: Search,
    copy: "We review the question and confirm the available engines, sampling conditions, and any follow-up measurement.",
  },
  {
    title: "Examine findings together",
    icon: BarChart3,
    copy: "When a pilot is approved and completed, review recorded answers, competitor appearances, cited sources, and limitations.",
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

      <SiteHeader cta={{ label: "Request a walkthrough", href: "#request-form" }} links={REFLEX_NAV} />

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
                Zypact · Guided founding pilots
              </p>

              <h1
                id="request-title"
                className="lx-display lx-intro mt-5 text-[40px] sm:mt-6 sm:text-[52px] lg:text-[58px]"
                style={order(1)}
              >
                Request a Zypact walkthrough
              </h1>

              <p className="lx-lede lx-intro mt-6" style={order(2)}>
                Explore how Zypact examines AI answers about your brand,
                competitors, and cited sources. Start with one commercially
                important buyer question. Our team confirms which API engines,
                measurement conditions, and deliverables are available for your
                guided pilot before any execution.
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
                API-based observations under recorded conditions. OpenAI API
                responses may differ from the consumer ChatGPT app. No
                market-wide score, causal promise, or revenue attribution.
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
          title="From walkthrough request to reviewed evidence"
          lede="Start with a buyer question. We confirm the pilot scope and protocol first; any measurements and retests take place only after approval."
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
                  An agreed pilot uses approved buyer questions and documented
                  measurement conditions. We review brand and competitor
                  observations and available citations alongside uncertainty,
                  instead of promising a universal visibility score.
                </p>
                <a href="mailto:contact@zypact.com" className="lx-scan-clarity-contact">
                  Questions? Contact our team
                </a>
              </div>
              <div className="lx-scan-clarity-card">
                <p className="lx-scan-clarity-card__eyebrow">MEASUREMENT LIMITS</p>
                <h3>Evidence, not a guaranteed outcome.</h3>
                <p>
                  When a documented retest is included in the agreed scope,
                  it may show an increase, a decrease, no clear change, or an
                  inconclusive result. Zypact commits to the agreed process and
                  evidence, not a favorable model response.
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
