import type { Metadata } from "next";
import {
  ArrowRight,
  BarChart3,
  Check,
  ClipboardList,
  Database,
  Repeat,
  Search,
  ShieldCheck,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EvidenceDashboard } from "@/components/marketing/evidence-dashboard";
import { SiteHeader } from "@/components/marketing/site-header";
import { ZypactWordmark } from "@/components/marketing/zypact-mark";
import { CANONICAL_SITE_URL } from "@/lib/seo/site";

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

const heroProof = [
  "Approved protocol",
  "Exact evidence",
  "Honest outcomes",
] as const;

const guarantees = [
  { label: "Approved protocol", icon: ShieldCheck },
  { label: "Bounded sampling", icon: BarChart3 },
  { label: "Exact evidence", icon: Database },
  { label: "Prompt-scoped", icon: Search },
  { label: "Registered retest", icon: Repeat },
  { label: "Honest outcomes", icon: ClipboardList },
] as const;

const steps = [
  {
    number: "1",
    title: "Approve",
    icon: ClipboardList,
    copy: "Fix the question, surface, sampling plan, limits and decision rule before any paid provider call.",
  },
  {
    number: "2",
    title: "Observe",
    icon: Search,
    copy: "Run the bounded Perplexity baseline and preserve every request, response and source exactly.",
  },
  {
    number: "3",
    title: "Retest",
    icon: Repeat,
    copy: "Register one change, wait out the observation window, then ask the same question again.",
  },
] as const;

const features = [
  {
    title: "Approved protocol",
    icon: ShieldCheck,
    copy: "Surface, sampling, limits and the decision rule are fixed and versioned before a single paid call.",
  },
  {
    title: "Exact evidence",
    icon: Database,
    copy: "Every request, response, source and integrity check is preserved insert-only and stays inspectable.",
  },
  {
    title: "Prompt-scoped observation",
    icon: BarChart3,
    copy: "Competitors and positions for that one question. No universal score, no market-wide claim.",
  },
  {
    title: "Registered retest",
    icon: Repeat,
    copy: "One recorded intervention, an explicit observation window, and the same question asked again.",
  },
] as const;

const outcomes = [
  "Increase observed",
  "Decrease observed",
  "No clear change",
  "Inconclusive",
] as const;

/** Canonical V1 delivery gates. `blocked` never delivers. */
const deliveryGates = [
  {
    status: "integrity_passed",
    tone: "bg-brand-600",
    copy: "Outcome Card and report delivered automatically.",
  },
  {
    status: "needs_review",
    tone: "bg-[#E0A33C]",
    copy: "Exception held for founder review before delivery.",
  },
  {
    status: "blocked",
    tone: "bg-[#CF4B3B]",
    copy: "No conclusion or report delivered as certainty.",
  },
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

const footerColumns = [
  {
    heading: "Product",
    links: [
      { label: "How it works", href: "#how-it-works" },
      { label: "What you get", href: "#features" },
      { label: "Evidence", href: "#evidence" },
      { label: "Request demo", href: DEMO_URL },
    ],
  },
  {
    heading: "Method",
    links: [
      { label: "Scope and limits", href: "#scope" },
      { label: "Outcome statuses", href: "#outcomes" },
      { label: "FAQ", href: "#faq" },
    ],
  },
  {
    heading: "Account",
    links: [
      { label: "Sign in", href: "/login" },
      { label: "Request demo", href: DEMO_URL },
    ],
  },
] as const;

export default function LandingPage() {
  return (
    <div className="v2-root">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(getJsonLd()) }}
      />

      <div className="min-h-screen bg-surface-subtle">
        <SiteHeader />

        {/* -------------------------------------------------------------- Hero */}
        <section className="relative overflow-hidden bg-surface-subtle">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 hidden w-[30%] bg-brand-900 lg:block"
          >
            <div className="absolute inset-0 bg-[radial-gradient(120%_80%_at_20%_0%,rgba(47,132,103,0.55),transparent_60%),radial-gradient(90%_70%_at_90%_100%,rgba(4,27,20,0.9),transparent_55%)]" />
          </div>

          <div className="shell relative grid items-center gap-14 pb-24 pt-16 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:gap-10 lg:pb-28 lg:pt-20">
            <div className="max-w-xl">
              <Badge>Evidence-backed diagnostic</Badge>

              <h1 className="mt-6 text-[44px] font-extrabold leading-[1.04] tracking-tightest sm:text-[56px]">
                Turn AI answers
                <br />
                into evidence
              </h1>

              <p className="mt-6 max-w-md text-[15px] leading-relaxed text-muted-foreground">
                Zypact records how Perplexity answers one commercially important
                buyer question, preserves the exact evidence, and checks the
                same question again after one registered change.
              </p>

              <div className="mt-9 flex flex-wrap items-center gap-3">
                <Button asChild size="lg">
                  <a href={DEMO_URL}>
                    Request demo
                    <ArrowRight className="h-4 w-4" strokeWidth={2.25} />
                  </a>
                </Button>
                <Button asChild size="lg" variant="outline">
                  <a href="#how-it-works">See the method</a>
                </Button>
              </div>

              <ul className="mt-9 flex flex-wrap items-center gap-x-7 gap-y-3">
                {heroProof.map((item) => (
                  <li key={item} className="flex items-center gap-2">
                    <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
                    </span>
                    <span className="text-[13px] font-medium">{item}</span>
                  </li>
                ))}
              </ul>

              <p className="mt-7 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                Perplexity Sonar only · One approved question · Automated after
                approval · No guaranteed outcome
              </p>
            </div>

            <div id="evidence" className="scroll-mt-24 lg:translate-x-6">
              <EvidenceDashboard />
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------- Guarantee strip */}
        <section className="border-y border-border bg-background">
          <div className="shell flex flex-col gap-8 py-10 lg:flex-row lg:items-center lg:gap-14">
            <p className="shrink-0 text-[11px] font-semibold uppercase leading-[1.5] tracking-[0.12em] text-muted-foreground">
              What every V1
              <br className="hidden lg:block" /> engagement fixes
            </p>
            <ul className="flex flex-1 flex-wrap items-center justify-between gap-x-6 gap-y-5">
              {guarantees.map((item) => (
                <li
                  key={item.label}
                  className="flex items-center gap-2 whitespace-nowrap text-[14px] font-semibold tracking-tight text-foreground/80"
                >
                  <item.icon
                    className="h-[17px] w-[17px] shrink-0 text-primary"
                    strokeWidth={1.9}
                  />
                  {item.label}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ------------------------------------------------------ How it works */}
        <section
          id="how-it-works"
          className="scroll-mt-20 bg-surface-subtle py-20 lg:py-24"
        >
          <div className="shell grid gap-14 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16">
            <div className="max-w-sm">
              <Badge>How it works</Badge>
              <h2 className="mt-6 text-[34px] font-extrabold leading-[1.1] tracking-tightest sm:text-[38px]">
                From one question
                <br />
                to an honest outcome
              </h2>
              <p className="mt-5 text-[15px] leading-relaxed text-muted-foreground">
                Nothing runs until the question, limits, sampling plan and
                observation window are approved. After that the controlled
                baseline runs automatically.
              </p>
              <Button asChild variant="outline" className="mt-8 h-11 px-5">
                <a href="#scope">Scope and limits</a>
              </Button>
            </div>

            <div className="relative grid gap-10 sm:grid-cols-3 sm:gap-6">
              <div
                aria-hidden="true"
                className="absolute left-[16.6%] right-[16.6%] top-[21px] hidden h-px bg-border sm:block"
              />
              {steps.map((step) => (
                <div key={step.title} className="sm:text-center">
                  <span className="relative z-10 flex h-[42px] w-[42px] items-center justify-center rounded-full bg-accent text-[13px] font-bold text-accent-foreground sm:mx-auto">
                    {step.number}
                  </span>
                  <step.icon
                    className="mt-7 h-6 w-6 text-primary sm:mx-auto"
                    strokeWidth={1.6}
                  />
                  <h3 className="mt-4 text-[17px] font-bold tracking-tight">
                    {step.title}
                  </h3>
                  <p className="mt-2.5 text-[13px] leading-relaxed text-muted-foreground">
                    {step.copy}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------- Features */}
        <section
          id="features"
          className="scroll-mt-20 bg-background py-20 lg:py-24"
        >
          <div className="shell">
            <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
              <div className="max-w-lg">
                <Badge>What you get</Badge>
                <h2 className="mt-6 text-[34px] font-extrabold leading-[1.1] tracking-tightest sm:text-[38px]">
                  Everything you need
                  <br />
                  for one defensible decision
                </h2>
                <p className="mt-5 text-[15px] leading-relaxed text-muted-foreground">
                  Narrow by design, and auditable end to end.
                </p>
              </div>
              <Button
                asChild
                variant="outline"
                className="h-11 shrink-0 px-5 sm:mt-11"
              >
                <a href="#scope">Read the scope</a>
              </Button>
            </div>

            <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {features.map((feature) => (
                <Card key={feature.title} className="bg-card">
                  <CardContent className="p-6 pt-6">
                    <feature.icon
                      className="h-[22px] w-[22px] text-primary"
                      strokeWidth={1.7}
                    />
                    <h3 className="mt-6 text-[15px] font-bold tracking-tight">
                      {feature.title}
                    </h3>
                    <p className="mt-2.5 text-[13px] leading-relaxed text-muted-foreground">
                      {feature.copy}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Methodology boundary — required on any client-facing surface. */}
            <div
              id="scope"
              className="mt-16 grid scroll-mt-20 gap-10 rounded-xl border border-border bg-surface-muted p-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:p-10"
            >
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Scope and limits
                </p>
                <h3 className="mt-4 text-[22px] font-bold leading-snug tracking-tight">
                  What V1 does not claim
                </h3>
                <p className="mt-4 text-[13px] leading-relaxed text-muted-foreground">
                  Perplexity Sonar is the only live V1 surface, and it is
                  presented as a directional proxy rather than the whole
                  AI-search market. V1 produces no market-wide score, no
                  multi-model coverage, no guaranteed recommendation, and no
                  causal or revenue attribution. Observed movement is not proof
                  of causality or revenue impact.
                </p>
              </div>
              <div id="outcomes" className="scroll-mt-20">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Every retest ends in one of four statuses
                </p>
                <ul className="mt-4 grid gap-2.5 sm:grid-cols-2">
                  {outcomes.map((outcome) => (
                    <li
                      key={outcome}
                      className="flex items-center gap-2.5 rounded-lg border border-border bg-background px-3.5 py-3 text-[13px] font-semibold tracking-tight"
                    >
                      <span
                        className="h-1.5 w-1.5 rounded-full bg-primary"
                        aria-hidden="true"
                      />
                      {outcome}
                    </li>
                  ))}
                </ul>
                <p className="mt-4 text-[12px] leading-relaxed text-muted-foreground">
                  Incomplete or inconsistent evidence fails closed. Nothing is
                  delivered as certainty it cannot support.
                </p>
              </div>

              {/* Delivery gates decide what reaches the client, and when. */}
              <div className="lg:col-span-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  What reaches you, and when
                </p>
                <dl className="mt-4 grid gap-4 sm:grid-cols-3">
                  {deliveryGates.map((gate) => (
                    <div
                      key={gate.status}
                      className="rounded-lg border border-border bg-background p-4"
                    >
                      <dt className="flex items-center gap-2 font-mono text-[12px] font-semibold tracking-tight">
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${gate.tone}`}
                          aria-hidden="true"
                        />
                        {gate.status}
                      </dt>
                      <dd className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
                        {gate.copy}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          </div>
        </section>

        {/* --------------------------------------------------------------- FAQ */}
        <section
          id="faq"
          className="scroll-mt-20 bg-surface-subtle py-20 lg:py-24"
        >
          <div className="shell grid gap-12 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)] lg:gap-16">
            <div className="max-w-sm">
              <Badge>Due diligence</Badge>
              <h2 className="mt-6 text-[34px] font-extrabold leading-[1.1] tracking-tightest sm:text-[38px]">
                What V1 does
                <br />
                and does not claim
              </h2>
              <p className="mt-5 text-[15px] leading-relaxed text-muted-foreground">
                Clear boundaries are part of the product. A partial or unsafe
                result is reviewed or blocked, not delivered as certainty.
              </p>
            </div>

            <div className="divide-y divide-border border-y border-border">
              {faqs.map((faq, index) => (
                <details key={faq.question} className="group py-4">
                  <summary className="flex cursor-pointer list-none items-center gap-4 text-[15px] font-semibold tracking-tight">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="flex-1">{faq.question}</span>
                    <span
                      aria-hidden="true"
                      className="text-[18px] font-normal text-muted-foreground transition-transform group-open:rotate-45"
                    >
                      +
                    </span>
                  </summary>
                  <p className="mt-3 pl-[calc(0.75rem+1rem)] text-[13px] leading-relaxed text-muted-foreground">
                    {faq.answer}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* --------------------------------------------------------- Final CTA */}
        <section className="bg-brand-800">
          <div className="shell flex flex-col gap-8 py-16 lg:flex-row lg:items-center lg:justify-between lg:py-20">
            <div>
              <Badge variant="onDark">Ready to get started?</Badge>
              <h2 className="mt-6 max-w-2xl text-[30px] font-extrabold leading-[1.15] tracking-tightest text-white sm:text-[36px]">
                Bring one buyer question worth examining.
              </h2>
              <p className="mt-4 max-w-xl text-[14px] leading-relaxed text-brand-200">
                Requesting a demo does not approve a protocol or start an AI
                call.
              </p>
            </div>
            <Button asChild size="lg" variant="onDark">
              <a href={DEMO_URL}>
                Request demo
                <ArrowRight className="h-4 w-4" strokeWidth={2.25} />
              </a>
            </Button>
          </div>
        </section>

        {/* ------------------------------------------------------------ Footer */}
        <footer className="bg-background">
          <div className="shell grid gap-12 py-16 lg:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))]">
            <div>
              <ZypactWordmark className="text-primary" dotFill="#FFFFFF" />
              <p className="mt-4 text-[13px] text-muted-foreground">
                Evidence, not estimates.
              </p>
            </div>

            {footerColumns.map((column) => (
              <nav key={column.heading} aria-label={column.heading}>
                <p className="text-[13px] font-bold tracking-tight">
                  {column.heading}
                </p>
                <ul className="mt-4 space-y-2.5">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <a
                        href={link.href}
                        className="text-[13px] text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>

          <div className="shell flex flex-col gap-2 border-t border-border py-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[12px] text-muted-foreground">
              Perplexity Sonar V1 · Automated after approval · No guaranteed
              outcome
            </p>
            <p className="text-[12px] text-muted-foreground">© 2026 Zypact</p>
          </div>
        </footer>
      </div>
    </div>
  );
}
