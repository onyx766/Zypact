import type { Metadata } from "next";
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  CircleCheck,
  CircleHelp,
  Crosshair,
  Database,
  Equal,
  FlaskConical,
  Gauge,
  Layers,
  Lightbulb,
  MessageSquareText,
  PenLine,
  RefreshCw,
  Repeat,
  Search,
  ShieldCheck,
  Target,
  Trophy,
} from "lucide-react";

import { AtmosphereCanvas } from "@/components/landing/canvas/atmosphere-canvas";
import { Contact } from "@/components/landing/contact";
import { CtaBand } from "@/components/landing/cta-band";
import { Evidence } from "@/components/landing/evidence";
import { FaqSection } from "@/components/landing/faq-section";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { LandingMotion } from "@/components/landing/landing-motion";
import { Method } from "@/components/landing/method";
import { Outcomes } from "@/components/landing/outcomes";
import { Report } from "@/components/landing/report";
import { Scope } from "@/components/landing/scope";
import { SiteFooter } from "@/components/landing/site-footer";
import { Why } from "@/components/landing/why";
import { SiteHeader } from "@/components/marketing/site-header";
import { ThemeRoot } from "@/components/theme-root";
import { CANONICAL_SITE_URL } from "@/lib/seo/site";

/*
 * Copy lives here, where scripts/test-landing-page.ts can see it; the landing
 * components only lay it out. Every statement below was checked against
 * docs/METHODOLOGY.md and docs/V1_SCOPE.md when the page moved to the
 * mountain/teal design: where the design mock said more than V1 can stand
 * behind (plural questions, "AI visibility", "over time", "improve results",
 * a lift badge, "a clear result, every time"), the slot carries the honest
 * statement instead. Metadata and JSON-LD are untouched: they are frozen
 * while the Perplexity self-test retest is outstanding.
 */

// One canonical origin for the whole site, so the homepage cannot advertise
// a different host than the sitemap, robots.txt and every other canonical.
const siteUrl = CANONICAL_SITE_URL;
const DEMO_URL = "/scan";

export const metadata: Metadata = {
  // Absolute: the root layout's "%s — Zypact" template would otherwise
  // append the brand to a title that already leads with it.
  title: {
    absolute:
      "Zypact — Evidence-backed buyer-question diagnostic for B2B SaaS",
  },
  description:
    "See which competitors appear for one commercially important buyer question in Perplexity, preserve the evidence, register one change, and check the same question again.",
  alternates: { canonical: "/" },
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
        serviceType:
          "Controlled automated diagnostic and registered retest for B2B SaaS",
        url: siteUrl,
        provider: { "@type": "Organization", name: "Zypact", url: siteUrl },
        description:
          "After the buyer question and protocol are approved, Zypact runs a bounded Perplexity baseline, preserves exact evidence, supports one registered intervention, and retests the same question after the observation window.",
        audience: {
          "@type": "BusinessAudience",
          audienceType:
            "English-language B2B SaaS marketing and product-marketing teams",
        },
      },
    ],
  };
}

/* ------------------------------------------------------------------ Hero */

const hero = {
  eyebrow: "Evidence-backed diagnostic",
  headlineLines: ["Turn AI answers", "into evidence."],
  lede: "Zypact records how Perplexity answers one commercially important buyer question, preserves the exact evidence, and checks the same question again after one registered change.",
  primaryCta: { label: "Request demo", href: DEMO_URL },
  // There is no public sample report (client reports are token-protected),
  // so this opens the labelled synthetic preview further down the page.
  secondaryCta: { label: "See an example report", href: "#reports" },
  chips: [
    { label: "Approved protocol", icon: ShieldCheck },
    { label: "Exact evidence", icon: Database },
    { label: "Registered retest", icon: Repeat },
  ],
  scopeLine:
    "Perplexity Sonar only, a directional proxy · One approved question · Launched by Zypact after approval · No guaranteed outcome",
} as const;

/* ------------------------------------------------------------------- Why */

const why = {
  id: "features",
  eyebrow: "Why Zypact",
  title: "One buyer question. Exact evidence. An honest retest.",
  lede: "A structured, evidence-based way to see how Perplexity answers one buyer question, and whether that answer moves after one registered change.",
  cards: [
    {
      title: "See whether it moved",
      copy: "Compare the same approved question before and after one registered change.",
      icon: Target,
    },
    {
      title: "Trust the evidence",
      copy: "Keep exact answers, sources, and context for every test.",
      icon: Layers,
    },
    {
      title: "Decide what to test next",
      copy: "One evidence-backed change to try, with its limits stated.",
      icon: Lightbulb,
    },
  ],
} as const;

/* ---------------------------------------------------------- How it works */

const howItWorks = {
  id: "how-it-works",
  eyebrow: "How it works",
  title: "From one question to an honest outcome.",
  lede: "Nothing runs until the question, limits, sampling plan and observation window are approved. After that Zypact launches the controlled baseline.",
  steps: [
    {
      title: "Approve",
      copy: "Fix the question, sampling plan and limits before any paid call.",
      icon: CircleCheck,
    },
    {
      title: "Observe",
      copy: "Record a bounded Perplexity baseline, with every answer preserved.",
      icon: Search,
    },
    {
      title: "Register change",
      copy: "Make one change, such as new content or sharper positioning. Zypact records it and when it went live.",
      icon: PenLine,
    },
    {
      title: "Retest",
      copy: "Ask the same question again once the observation window closes.",
      icon: RefreshCw,
    },
    {
      title: "Review outcome",
      copy: "See the observed difference, the evidence behind it, and the uncertainty that remains.",
      icon: BarChart3,
    },
  ],
} as const;

/* ---------------------------------------------------------------- Method */

const method = {
  id: "method",
  eyebrow: "The method",
  title: "A repeatable, transparent method.",
  lede: "The question, surface, sampling plan and decision rule are fixed before anything runs, so the baseline and the retest are comparable rather than merely sequential.",
  link: {
    label:
      "See how Zypact tests whether a content change moved the same Perplexity buyer question",
    href: "/perplexity-content-change-test",
  },
  columns: [
    {
      title: "Approved protocol",
      copy: "Surface, sampling, limits and the decision rule are fixed and versioned before a single paid call.",
      icon: ShieldCheck,
    },
    {
      title: "Preserved evidence",
      copy: "Exact answers, sources, and metadata are saved for every run.",
      icon: Layers,
    },
    {
      title: "Prompt-scoped observation",
      copy: "Competitors and positions for that one question. No universal score, no market-wide claim.",
      icon: Crosshair,
    },
    {
      title: "Registered retest",
      copy: "One recorded change, an explicit observation window, and the same question asked again.",
      icon: RefreshCw,
    },
  ],
} as const;

/* -------------------------------------------------------------- Evidence */

const evidence = {
  id: "evidence",
  eyebrow: "The evidence",
  title: "Exact answers, preserved.",
  lede: "Every run keeps the exact request, the response and the sources the answer cited, stored insert-only. The same approved question is asked again after one registered change.",
} as const;

/* -------------------------------------------------------------- Outcomes */

/**
 * The four Outcome Card results, with equal size, tone and motion: none is the
 * "good" outcome the product steers toward. Each front states what the result
 * requires, not just its direction: `increase_observed` needs the interval to
 * clear zero AND the move to reach Δ_min, so "more presence" alone would also
 * describe pairs the engine calls `no_clear_change`. The back states the
 * implemented rule (lib/reports/compare-protocols.ts, D-038); it is detail
 * only, so nothing a reader must see lives there. Δ_min is fixed for every V1
 * protocol, hence "set", never "agreed" or "you said".
 */
const outcomes = {
  id: "outcomes",
  eyebrow: "The outcome",
  title: "Every retest ends in one of four results.",
  lede: "None of the four is the result we steer toward, and each states its evidence and limits. Incomplete or inconsistent evidence fails closed, and nothing is delivered as certainty it cannot support.",
  outcomes: [
    {
      label: "Increase observed",
      code: "increase_observed",
      copy: "More presence for the same question, beyond both the sample's uncertainty and the minimum change set before the retest.",
      rule: "Mentions rose by at least the minimum change set before the retest, and the 95% interval on the change stays above zero.",
      icon: ArrowUp,
    },
    {
      label: "Decrease observed",
      code: "decrease_observed",
      copy: "Less presence for the same question, beyond both the sample's uncertainty and the minimum change set before the retest.",
      rule: "Mentions fell by at least the minimum change set before the retest, and the 95% interval on the change stays below zero.",
      icon: ArrowDown,
    },
    {
      label: "No clear change",
      code: "no_clear_change",
      copy: "The evidence rules out a move as large as the minimum change set before the retest.",
      rule: "The 95% interval on the change sits inside the minimum change in both directions. Smaller shifts may still exist.",
      icon: Equal,
    },
    {
      label: "Inconclusive",
      code: "inconclusive",
      copy: "The evidence cannot settle whether a move of the minimum size happened, for example too few readable runs or too wide an interval.",
      rule: "The interval on the change still reaches the minimum change, or a phase falls below the readable-run floor or is not comparable, so a move of that size can be neither confirmed nor ruled out.",
      icon: CircleHelp,
    },
  ],
} as const;

/* ---------------------------------------------------------------- Report */

const report = {
  id: "reports",
  eyebrow: "The report",
  title: "From answers to action.",
  lede: "No score. What the evidence shows for one question: whether Perplexity named you, who else it named, how uncertain that is, and one change worth testing.",
  cardTitle: "AI answer snapshot",
  cardLabel: "Synthetic preview",
  items: [
    {
      title: "Answers",
      copy: "Every run of your approved question, named or not, with its exact answer preserved.",
      icon: MessageSquareText,
    },
    {
      title: "Sources",
      copy: "The sources each answer cited, preserved with the run.",
      icon: Layers,
    },
    {
      title: "Competitors",
      copy: "Which other brands are named for that question, and in how many runs.",
      icon: Trophy,
    },
    {
      // "Uncertainty", not "Certainty": the method reports how unsure a
      // sample leaves you; it never delivers certainty.
      title: "Uncertainty",
      copy: "How sure the sample lets us be, and what it cannot tell you.",
      icon: Gauge,
    },
    {
      title: "Change to test",
      copy: "One evidence-backed change to try, and what would count as a result.",
      icon: FlaskConical,
    },
  ],
} as const;

/**
 * Canonical V1 delivery gates. `blocked` never delivers.
 *
 * `integrity_passed` says "may": automatic sending also depends on the
 * deployment's auto-delivery switch, so the page promises the gate, not the
 * send. Tones are the shared status tokens, re-pointed at the landing palette
 * inside `.lx`, so the three gates keep their contrast and their meaning is
 * also carried by the status text, never by colour alone.
 */
const deliveryGates = [
  {
    status: "integrity_passed",
    tone: "bg-success",
    copy: "Report and Outcome Card may be delivered automatically.",
  },
  {
    status: "needs_review",
    tone: "bg-warning",
    copy: "Held for founder review before delivery.",
  },
  {
    status: "blocked",
    tone: "bg-destructive",
    copy: "Never delivered. No conclusion or report delivered as certainty.",
  },
] as const;

/* ----------------------------------------------------------------- Scope */

const scopeNotes = [
  {
    label: "Scope and limits",
    title: "What V1 does not claim",
    copy: "Perplexity Sonar is the only live V1 surface, and it is presented as a directional proxy rather than the whole AI-search market. V1 produces no market-wide score, no multi-model coverage, no guaranteed recommendation, and no causal or revenue attribution. Observed movement is not proof of causality or revenue impact.",
  },
  {
    label: "Fails closed",
    title: "When the evidence will not support a conclusion",
    copy: "Incomplete or inconsistent evidence fails closed. A partial or unsafe result is reviewed or blocked, not delivered as certainty. Failed and excluded attempts stay visible in the denominator rather than being quietly dropped to make a cleaner number.",
  },
] as const;

/* ------------------------------------------------------------------- FAQ */

const faq = {
  id: "faq",
  eyebrow: "FAQ",
  title: "Common questions.",
  lede: "Quick answers about how Zypact works, what it measures, and how to get started.",
} as const;

const faqs = [
  {
    question: "What does Zypact V1 include?",
    answer:
      "One approved buyer question, a bounded Perplexity protocol, exact baseline evidence, prompt-scoped competitor observations, one registered intervention, an explicit observation window, a same-question retest, and an auditable Outcome Card.",
  },
  {
    question: "Which AI platform does V1 test?",
    answer:
      "Perplexity Sonar is the only live V1 surface. Zypact does not claim automated coverage of ChatGPT, Gemini, Claude, Copilot, or the entire AI-search market.",
  },
  {
    question: "How is the evidence captured and kept?",
    answer:
      "Each run's exact provider request and response are stored insert-only with a SHA-256 hash, together with the sources the answer cited and the question and protocol version they belong to. Authorization headers and secrets are never stored.",
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
      "The form requests access; it does not approve a protocol or start an AI call. If you proceed, the question and protocol are approved first. Zypact then launches the baseline. Integrity-passed records continue to automatic delivery, exceptions are held for review, and blocked evidence is not delivered.",
  },
  {
    question: "Do I need a subscription?",
    answer:
      "No subscription or account is created by requesting a demo. Scope, timing, price and responsibilities are agreed before the approved V1 workflow begins.",
  },
] as const;

/* ------------------------------------------------------- CTA and contact */

const cta = {
  title: "See how Perplexity answers your buyer question — with evidence.",
  copy: "Get a walkthrough of the method and what a report contains. No AI call runs until the question and protocol are approved.",
  cta: { label: "Request demo", href: DEMO_URL },
} as const;

const contact = {
  id: "contact",
  eyebrow: "Get in touch",
  title: "Talk to the Zypact team.",
  copy: "Request a demo or reach out directly. We're happy to answer your questions, walk through the method, and explore your use case.",
  people: [
    {
      name: "Kevin",
      role: "Technical Co-founder / CTO",
      email: "kevin@zypact.com",
    },
    { name: "Nathalie", role: "CEO", email: "nathalie@zypact.com" },
  ],
} as const;

/* ---------------------------------------------------------------- Footer */

const footer = {
  tagline:
    "Record, preserve and retest how Perplexity answers one buyer question.",
  columns: [
    {
      heading: "Product",
      links: [
        { label: "How it works", href: "#how-it-works" },
        { label: "Reports", href: "#reports" },
        { label: "About Zypact", href: "/about" },
      ],
    },
    {
      heading: "Method",
      links: [
        { label: "Evidence", href: "#evidence" },
        { label: "Outcome statuses", href: "#outcomes" },
        { label: "Scope and limits", href: "#scope" },
      ],
    },
    {
      heading: "Contact",
      links: [
        { label: "Request demo", href: DEMO_URL },
        { label: "Contact us", href: "#contact" },
        { label: "FAQ", href: "#faq" },
      ],
    },
  ],
  bottomLine:
    "Perplexity Sonar V1 · Launched by Zypact after approval · No guaranteed outcome",
  copyright: "© 2026 Zypact",
} as const;

export default function LandingPage() {
  return (
    <ThemeRoot theme="light" className="lx">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(getJsonLd()) }}
      />
      <LandingMotion />
      <AtmosphereCanvas />
      <div className="lx-grain" aria-hidden="true" />

      <SiteHeader />

      <main className="relative z-[1]">
        <Hero {...hero} />
        <Why {...why} />
        <HowItWorks {...howItWorks} />
        <Method {...method} />
        <Evidence {...evidence} />
        <Outcomes {...outcomes} />

        <Report {...report}>
          <div className="lx-gates" data-reveal>
            <p className="lx-gates__title">What reaches you, and when</p>
            <dl className="lx-gates__list" data-stagger="120">
              {deliveryGates.map((gate) => (
                <div key={gate.status} className="lx-gate" data-reveal>
                  <dt className="lx-gate__status">
                    <span
                      className={`lx-gate__dot ${gate.tone}`}
                      aria-hidden="true"
                    />
                    {gate.status}
                  </dt>
                  <dd className="lx-gate__copy">{gate.copy}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Report>

        <Scope id="scope" notes={scopeNotes} />

        <FaqSection {...faq}>
          {/*
            Native <details>, so every answer opens with no JavaScript and
            keeps the built-in disclosure semantics. `list-none` alone leaves
            Safari's marker, so it is hidden explicitly in chrome.css.
          */}
          <div className="lx-faq" data-stagger="70">
            {faqs.map((item) => (
              <details key={item.question} className="lx-faq__item" data-reveal>
                <summary className="lx-faq__summary">
                  <span className="lx-faq__q">{item.question}</span>
                  <span className="lx-faq__icon" aria-hidden="true" />
                </summary>
                <div className="lx-faq__answer">
                  <p>{item.answer}</p>
                </div>
              </details>
            ))}
          </div>
        </FaqSection>

        <CtaBand {...cta} />
        <Contact {...contact} />
      </main>

      <SiteFooter {...footer} />
    </ThemeRoot>
  );
}
