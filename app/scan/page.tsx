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
  title: { absolute: "Zypact — Request a Demo" },
  description:
    "Request a Zypact demo to explore AI Answer Measurement & Intelligence for B2B SaaS: brand visibility, competitors, cited sources, potential marketing actions, and documented follow-up observations. Pilot availability is confirmed with the team.",
  alternates: {
    canonical: "/scan",
  },
};

/** What the engagement delivers. Process commitments, never outcomes. */
const HIGHLIGHTS = [
  "See how Zypact examines brand mentions in sampled AI answers",
  "Understand which competitors appear in relevant buyer questions",
  "Explore cited sources and evidence-informed marketing opportunities",
  "See how documented follow-up measurement can inform decisions",
] as const;

const SUMMARY = [
  {
    title: "Brand & competitor intelligence",
    desc: "Investigate how AI answers describe your product and its alternatives.",
    icon: FileSearch,
    tone: "is-teal",
  },
  {
    title: "Source analysis",
    desc: "Examine cited websites and the evidence behind sampled answers.",
    icon: ShieldCheck,
    tone: "is-amber",
  },
  {
    title: "Actions & follow-up",
    desc: "Investigate opportunities and understand what a documented retest can show.",
    icon: Database,
    tone: "is-slate",
  },
] as const;

/**
 * The three steps explain the demo-request process, not the full product
 * workflow. No AI measurement is started by submitting the form.
 */
const STAGES = [
  {
    title: "Tell us about your company",
    icon: ClipboardList,
    copy: "Share your website and one example buyer question so we can understand what matters to your team.",
  },
  {
    title: "Explore Zypact",
    icon: Search,
    copy: "Review how measurements, competitor observations, cited sources, and potential actions fit your use case.",
  },
  {
    title: "Discuss next steps",
    icon: BarChart3,
    copy: "Ask about current capabilities and, if relevant, a scoped founding paid pilot with the Zypact team.",
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
    "Directional API observations · Provider availability confirmed by Zypact · No guaranteed outcomes",
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
                Zypact · AI Answer Measurement & Intelligence
              </p>

              <h1
                id="request-title"
                className="lx-display lx-intro mt-5 text-[40px] sm:mt-6 sm:text-[52px] lg:text-[58px]"
                style={order(1)}
              >
                Request a Zypact demo
              </h1>

              <p className="lx-lede lx-intro mt-6" style={order(2)}>
                Zypact is developing an AI Answer Measurement & Intelligence
                platform for B2B SaaS teams. Explore how it examines AI
                answers about your brand, which competitors appear, and
                what external sources are cited. See how these observations
                can inform marketing actions and documented follow-up
                measurements. The demo is a conversation about the
                product and its current capabilities.
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
          title="From demo request to a clearer picture"
          lede="Tell us about your company, explore the measurement workflow with our team, and discuss the next steps that make sense for your goals."
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
                  Know what the evidence can and cannot tell you.
                </h2>
                <p>
                  Zypact is designed to connect buyer questions with sampled AI
                  answers, competitor observations, and cited sources.
                  These can guide marketing investigations, but do not
                  represent all buyers or all AI systems.
                </p>
                <a href="mailto:contact@zypact.com" className="lx-scan-clarity-contact">
                  Questions? Contact our team
                </a>
              </div>
              <div className="lx-scan-clarity-card">
                <p className="lx-scan-clarity-card__eyebrow">MEASUREMENT LIMITS</p>
                <h3>Evidence, not a guaranteed outcome.</h3>
                <p>
                  When a documented retest is part of an approved engagement,
                  results may show an increase, a decrease, no clear change,
                  or an inconclusive result. A difference in AI answers does
                  not prove that a marketing action caused it.
                </p>
                <div className="lx-scan-clarity-rule" />
                <p>
                  OpenAI API responses with web search may differ from answers
                  people see in the ChatGPT app. Zypact V1 remains in
                  development, and the team confirms which measurements
                  and features are available for each engagement.
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
