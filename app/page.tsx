import type { Metadata } from "next";
import {
  ArrowRight,
  BarChart3,
  Check,
  ChevronDown,
  ClipboardList,
  Database,
  FileCheck,
  MinusCircle,
  Repeat,
  Search,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ExampleAnswer,
  RetestComparison,
} from "@/components/marketing/answer-evidence";
import { EvidenceDashboard } from "@/components/marketing/evidence-dashboard";
import {
  CheckItem,
  IconTile,
  PanelCard,
  SectionHeading,
  SectionLabel,
  StepItem,
  toneAt,
} from "@/components/marketing/section-kit";
import { SiteHeader } from "@/components/marketing/site-header";
import { ZypactWordmark } from "@/components/marketing/zypact-mark";
import { ThemeRoot } from "@/components/theme-root";
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

/** Hero chips. Short enough to stay on one line each at phone width. */
const heroChips = [
  { label: "Approved protocol", icon: ShieldCheck },
  { label: "Exact evidence", icon: Database },
  { label: "Prompt-scoped", icon: Search },
  { label: "Registered retest", icon: Repeat },
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
    number: 1,
    title: "Approve",
    icon: ClipboardList,
    copy: "Fix the question, surface, sampling plan, limits and decision rule before any paid provider call.",
  },
  {
    number: 2,
    title: "Observe",
    icon: Search,
    copy: "Run the bounded Perplexity baseline and preserve every request, response and source exactly.",
  },
  {
    number: 3,
    title: "Retest",
    icon: Repeat,
    copy: "Register one change, wait out the observation window, then ask the same question again.",
  },
  {
    number: 4,
    title: "Review outcome",
    icon: FileCheck,
    copy: "Read the Outcome Card: what moved, what the evidence supports, and what it cannot.",
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

/**
 * The four outcome statuses, shown with equal visual weight.
 *
 * This occupies the band the approved design gives to headline metrics. It
 * deliberately carries no adoption or performance numbers: V1 is pre-pilot, so
 * any such figure would be invented. These are the real, auditable results a
 * retest can produce, and presenting them evenly is itself the claim — none is
 * the "good" outcome the product is steering toward.
 */
const outcomes = [
  {
    label: "Increase observed",
    icon: TrendingUp,
    copy: "The retest shows more presence for the same question.",
  },
  {
    label: "Decrease observed",
    icon: TrendingDown,
    copy: "The retest shows less presence for the same question.",
  },
  {
    label: "No clear change",
    icon: MinusCircle,
    copy: "Movement stays inside the uncertainty the protocol allows.",
  },
  {
    label: "Inconclusive",
    icon: ClipboardList,
    copy: "Evidence cannot support a direction, and says so plainly.",
  },
] as const;

/** What the approved protocol fixes before any paid call. */
const protocolPoints = [
  "Prompt-scoped measurement, never a market-wide score",
  "Exact provider evidence, with the sources the answer cited",
  "Controlled, registered retests of the same approved question",
  "Honest outcomes, including the uncertainty the sample allows",
] as const;

/** What the engagement actually fixes. Process commitments, not outcomes. */
const impactPoints = [
  "One commercially important buyer question, agreed before anything runs",
  "Exact provider evidence, preserved insert-only and inspectable",
  "Failed and excluded attempts kept visible in the denominator",
  "An honest outcome, including when nothing clearly changed",
] as const;

/**
 * Canonical V1 delivery gates. `blocked` never delivers.
 *
 * Tones are the shared status tokens rather than fixed hexes, so the three
 * gates keep their contrast in both themes and match the status colours the
 * founder console already uses for the same three states.
 */
const deliveryGates = [
  {
    status: "integrity_passed",
    tone: "bg-success",
    copy: "Outcome Card and report delivered automatically.",
  },
  {
    status: "needs_review",
    tone: "bg-warning",
    copy: "Exception held for founder review before delivery.",
  },
  {
    status: "blocked",
    tone: "bg-destructive",
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
      "The form requests access; it does not approve a protocol or start an AI call. If you proceed, the question and protocol are approved first. Zypact then launches the baseline. Integrity-passed records continue to automatic delivery, exceptions are held for review, and blocked evidence is not delivered.",
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
      { label: "About Zypact", href: "/about" },
      { label: "Methodology", href: "/method" },
      { label: "How it works", href: "#how-it-works" },
      { label: "What you get", href: "#features" },
      { label: "Evidence", href: "#evidence" },
      { label: "Request demo", href: DEMO_URL },
    ],
  },
  {
    heading: "Method",
    links: [
      { label: "About Zypact", href: "/about" },
      { label: "Methodology", href: "/method" },
      { label: "Scope and limits", href: "#scope" },
      { label: "Outcome statuses", href: "#outcomes" },
      { label: "FAQ", href: "#faq" },
    ],
  },
  {
    heading: "Get started",
    links: [
      { label: "Request demo", href: DEMO_URL },
      { label: "See the method", href: "/method" },
    ],
  },
] as const;

export default function LandingPage() {
  return (
    <ThemeRoot theme="light">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(getJsonLd()) }}
      />

      <div className="min-h-screen bg-background">
        <SiteHeader />

        {/* -------------------------------------------------------------- Hero */}
        <section className="relative isolate overflow-hidden">
          {/*
            Ambient glow behind the hero. `isolate` on the section keeps the
            negative z-index from escaping behind the page background.
          */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 -top-40 -z-10 h-[520px] bg-[radial-gradient(60%_60%_at_50%_0%,hsl(var(--primary)/0.16),transparent_70%)]"
          />

          <div className="shell grid items-center gap-12 pb-16 pt-12 sm:pb-20 sm:pt-16 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:gap-14 lg:pb-28 lg:pt-20">
            <div className="max-w-xl">
              <Badge>Evidence-backed diagnostic</Badge>

              <h1 className="mt-5 text-balance text-[34px] font-extrabold leading-[1.06] tracking-tightest sm:text-[46px] lg:text-[56px]">
                Turn AI answers
                <br />
                <span className="text-primary">into evidence</span>
              </h1>

              <p className="mt-5 max-w-md text-pretty text-[15px] leading-relaxed text-muted-foreground sm:text-[16px]">
                Zypact records how Perplexity answers one commercially important
                buyer question, preserves the exact evidence, and checks the
                same question again after one registered change.
              </p>

              {/* Buttons go full-width on phones so neither becomes a tap target
                  narrower than the thumb that has to hit it. */}
              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                <Button asChild size="lg" className="w-full sm:w-auto">
                  <a href={DEMO_URL}>
                    Request demo
                    <ArrowRight className="h-4 w-4" strokeWidth={2.25} />
                  </a>
                </Button>
                <Button
                  asChild
                  size="lg"
                  variant="outline"
                  className="w-full sm:w-auto"
                >
                  <a href="#how-it-works">See the method</a>
                </Button>
              </div>

              <ul className="mt-8 flex flex-wrap gap-2">
                {heroChips.map((chip) => (
                  <li
                    key={chip.label}
                    className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-2 text-[12px] font-semibold tracking-tight text-foreground/80"
                  >
                    <chip.icon
                      className="h-3.5 w-3.5 shrink-0 text-primary"
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                    {chip.label}
                  </li>
                ))}
              </ul>

              <p className="mt-6 text-[11px] font-semibold uppercase leading-relaxed tracking-[0.1em] text-muted-foreground">
                Perplexity Sonar only · One approved question · Automated after
                approval · No guaranteed outcome
              </p>
            </div>

            <div id="evidence" className="scroll-mt-24">
              <EvidenceDashboard />
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------- Guarantee strip */}
        <section className="border-y border-border bg-surface-subtle">
          <div className="shell flex flex-col gap-6 py-8 lg:flex-row lg:items-center lg:gap-12">
            <p className="shrink-0 text-[11px] font-semibold uppercase leading-[1.5] tracking-[0.12em] text-muted-foreground">
              What every V1
              <br className="hidden lg:block" /> engagement fixes
            </p>
            <ul className="grid flex-1 grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:flex lg:flex-wrap lg:items-center lg:justify-between">
              {guarantees.map((item) => (
                <li
                  key={item.label}
                  className="flex items-center gap-2 text-[13px] font-semibold tracking-tight text-foreground/80 sm:text-[14px] lg:whitespace-nowrap"
                >
                  <item.icon
                    className="h-[17px] w-[17px] shrink-0 text-primary"
                    strokeWidth={1.9}
                    aria-hidden="true"
                  />
                  {item.label}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ------------------------------------------------- Approved protocol */}
        <section className="bg-background py-16 sm:py-20 lg:py-24">
          <div className="shell grid gap-10 lg:grid-cols-2 lg:items-center lg:gap-16">
            <div>
              <SectionLabel>An approved protocol</SectionLabel>
              <h2 className="mt-5 text-balance text-[27px] font-extrabold leading-[1.15] tracking-tightest sm:text-[33px] lg:text-[38px]">
                A repeatable way to observe
                <br className="hidden sm:block" /> what one AI surface answers
              </h2>
              <p className="mt-4 text-pretty text-[14px] leading-relaxed text-muted-foreground sm:text-[15px]">
                The question, the surface, the sampling plan and the decision
                rule are fixed and versioned before anything runs — so the
                baseline and the retest are comparable rather than merely
                sequential.
              </p>

              <p className="mt-5 text-[14px] leading-relaxed">
                <a
                  href="/perplexity-content-change-test"
                  className="font-semibold text-primary underline-offset-4 hover:underline"
                >
                  See how Zypact tests whether a content change moved the same
                  Perplexity buyer question
                </a>
              </p>

              <ul className="mt-7 grid gap-3.5">
                {protocolPoints.map((point) => (
                  <CheckItem key={point} icon={Check}>
                    {point}
                  </CheckItem>
                ))}
              </ul>
            </div>

            <ExampleAnswer />
          </div>
        </section>

        {/* ---------------------------------------------------------- Features */}
        <section
          id="features"
          className="scroll-mt-20 bg-background py-16 sm:py-20 lg:py-24"
        >
          <div className="shell">
            <SectionHeading
              label="Why Zypact"
              title={
                <>
                  Everything you need for
                  <br className="hidden sm:block" /> one defensible decision
                </>
              }
              lede="Narrow by design, and auditable end to end."
            />

            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:mt-14 lg:grid-cols-4">
              {features.map((feature, index) => (
                <PanelCard key={feature.title} className="flex flex-col">
                  <IconTile icon={feature.icon} tone={toneAt(index)} />
                  <h3 className="mt-5 text-[15px] font-bold tracking-tight">
                    {feature.title}
                  </h3>
                  <p className="mt-2.5 text-[13px] leading-relaxed text-muted-foreground">
                    {feature.copy}
                  </p>
                </PanelCard>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------- Real impact */}
        <section className="border-y border-border bg-surface-subtle py-16 sm:py-20 lg:py-24">
          <div className="shell grid gap-10 lg:grid-cols-2 lg:items-center lg:gap-16">
            <div>
              <SectionLabel>What you actually get</SectionLabel>
              <h2 className="mt-5 text-balance text-[27px] font-extrabold leading-[1.15] tracking-tightest sm:text-[33px] lg:text-[38px]">
                A result you can put
                <br className="hidden sm:block" /> in front of anyone
              </h2>
              <p className="mt-4 text-pretty text-[14px] leading-relaxed text-muted-foreground sm:text-[15px]">
                Every number on the report links back to the provider evidence
                that produced it, so a sceptical reader can follow the whole
                chain rather than take the conclusion on trust.
              </p>

              <ul className="mt-7 grid gap-3.5">
                {impactPoints.map((point) => (
                  <CheckItem key={point} icon={Check}>
                    {point}
                  </CheckItem>
                ))}
              </ul>
            </div>

            {/*
              The approved design puts a lifestyle photo and a "+32% engagement"
              stat card here. Both are replaced: the figure would be an invented
              causal claim, which the methodology forbids outright. The delivery
              gates are the honest equivalent — they tell a prospect what will
              and will not reach them, which is the reassurance the slot is for.
            */}
            <PanelCard className="bg-card/60 p-5 sm:p-7">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                What reaches you, and when
              </p>
              <dl className="mt-5 grid gap-3">
                {deliveryGates.map((gate) => (
                  <div
                    key={gate.status}
                    className="rounded-xl border border-border bg-background p-4"
                  >
                    <dt className="flex items-center gap-2.5 font-mono text-[12px] font-semibold tracking-tight">
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${gate.tone}`}
                        aria-hidden="true"
                      />
                      {gate.status}
                    </dt>
                    <dd className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground">
                      {gate.copy}
                    </dd>
                  </div>
                ))}
              </dl>
            </PanelCard>
          </div>
        </section>

        {/* ------------------------------------------------- Outcome band */}
        <section
          id="outcomes"
          className="scroll-mt-20 bg-background py-16 sm:py-20 lg:py-24"
        >
          <div className="shell">
            <SectionHeading
              label="Outcome statuses"
              title="Every retest ends in one of four results"
              lede="Presented with equal weight. Incomplete or inconsistent evidence fails closed, and nothing is delivered as certainty it cannot support."
            />

            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {outcomes.map((outcome, index) => (
                <PanelCard key={outcome.label}>
                  <IconTile icon={outcome.icon} tone={toneAt(index)} />
                  <p className="mt-5 text-[15px] font-bold tracking-tight">
                    {outcome.label}
                  </p>
                  <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
                    {outcome.copy}
                  </p>
                </PanelCard>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------ How it works */}
        <section
          id="how-it-works"
          className="scroll-mt-20 border-y border-border bg-surface-subtle py-16 sm:py-20 lg:py-24"
        >
          <div className="shell">
            <SectionHeading
              label="How it works"
              title="From one question to an honest outcome"
              lede="Nothing runs until the question, limits, sampling plan and observation window are approved. After that Zypact launches the controlled baseline."
            />

            <div className="mt-12 grid gap-8 sm:grid-cols-2 sm:gap-6 lg:mt-14 lg:grid-cols-4">
              {steps.map((step, index) => (
                <div key={step.title} className="relative">
                  <StepItem
                    number={step.number}
                    icon={step.icon}
                    tone={toneAt(index)}
                    title={step.title}
                    copy={step.copy}
                  />
                  {/* Connector, drawn only between steps and only once they sit
                      side by side. */}
                  {index < steps.length - 1 ? (
                    <ArrowRight
                      aria-hidden="true"
                      className="absolute -right-3 top-4 hidden h-4 w-4 text-muted-foreground/50 lg:block"
                      strokeWidth={2}
                    />
                  ) : null}
                </div>
              ))}
            </div>

            <div className="mt-12 flex justify-center">
              <Button asChild variant="outline" className="w-full sm:w-auto">
                <a href="#scope">Scope and limits</a>
              </Button>
            </div>
          </div>
        </section>

        {/* --------------------------------------------------- Retest comparison */}
        <section className="bg-background py-16 sm:py-20 lg:py-24">
          <div className="shell grid gap-10 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:items-center lg:gap-16">
            <div>
              <SectionLabel>Registered retest</SectionLabel>
              <h2 className="mt-5 text-balance text-[27px] font-extrabold leading-[1.15] tracking-tightest sm:text-[33px] lg:text-[38px]">
                The same question,
                <br className="hidden sm:block" /> asked again on purpose
              </h2>
              <p className="mt-4 text-pretty text-[14px] leading-relaxed text-muted-foreground sm:text-[15px]">
                A retest is only meaningful if nothing else moved. Zypact holds
                the question and protocol identical, records the one change that
                was made, waits out the observation window, then reports what
                the evidence will and will not support.
              </p>

              <div className="mt-8">
                <Button asChild size="lg" className="w-full sm:w-auto">
                  <a href={DEMO_URL}>
                    Request demo
                    <ArrowRight className="h-4 w-4" strokeWidth={2.25} />
                  </a>
                </Button>
              </div>
            </div>

            <RetestComparison />
          </div>
        </section>

        {/* ---------------------------------------------------- Scope and limits */}
        <section
          id="scope"
          className="scroll-mt-20 bg-background py-16 sm:py-20 lg:py-24"
        >
          <div className="shell">
            <div className="rounded-2xl border border-border bg-surface-muted p-6 sm:p-8 lg:p-12">
              <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
                <div>
                  <SectionLabel>Scope and limits</SectionLabel>
                  <h2 className="mt-5 text-[22px] font-bold leading-snug tracking-tight sm:text-[26px]">
                    What V1 does not claim
                  </h2>
                  <p className="mt-4 text-pretty text-[13.5px] leading-relaxed text-muted-foreground sm:text-[14px]">
                    Perplexity Sonar is the only live V1 surface, and it is
                    presented as a directional proxy rather than the whole
                    AI-search market. V1 produces no market-wide score, no
                    multi-model coverage, no guaranteed recommendation, and no
                    causal or revenue attribution. Observed movement is not proof
                    of causality or revenue impact.
                  </p>
                </div>

                <div>
                  <SectionLabel>Fails closed</SectionLabel>
                  <h3 className="mt-5 text-[22px] font-bold leading-snug tracking-tight sm:text-[26px]">
                    When the evidence will not support a conclusion
                  </h3>
                  <p className="mt-4 text-pretty text-[13.5px] leading-relaxed text-muted-foreground sm:text-[14px]">
                    Incomplete or inconsistent evidence fails closed. A partial
                    or unsafe result is reviewed or blocked, not delivered as
                    certainty. Failed and excluded attempts stay visible in the
                    denominator rather than being quietly dropped to make a
                    cleaner number.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* --------------------------------------------------------------- FAQ */}
        <section
          id="faq"
          className="scroll-mt-20 border-t border-border bg-surface-subtle py-16 sm:py-20 lg:py-24"
        >
          <div className="shell grid gap-10 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)] lg:gap-16">
            <div className="lg:sticky lg:top-24 lg:self-start">
              <SectionHeading
                align="left"
                label="FAQ"
                title={
                  <>
                    Frequently asked
                    <br className="hidden sm:block" /> questions
                  </>
                }
                lede="Clear boundaries are part of the product. A partial or unsafe result is reviewed or blocked, not delivered as certainty."
              />
            </div>

            {/*
              One bordered card per question, as the approved design shows,
              rather than the hairline-divided rows this previously used. Still
              a native <details>, so it opens with no JavaScript and keeps the
              built-in disclosure semantics for assistive technology.
            */}
            <div className="grid gap-3">
              {faqs.map((faq) => (
                <details
                  key={faq.question}
                  className="group rounded-xl border border-border bg-card px-4 transition-colors hover:border-primary/30 sm:px-5"
                >
                  {/* `list-none` alone leaves Safari's disclosure triangle, so
                      the marker is hidden explicitly, as the admin accordions
                      and every legacy stylesheet here already do. */}
                  <summary className="flex cursor-pointer list-none items-center gap-4 py-4 text-[14px] font-semibold tracking-tight [&::-webkit-details-marker]:hidden sm:text-[15px]">
                    <span className="flex-1 text-pretty">{faq.question}</span>
                    <ChevronDown
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
                      strokeWidth={2}
                    />
                  </summary>
                  <p className="pb-4 pr-8 text-[13px] leading-relaxed text-muted-foreground sm:text-[13.5px]">
                    {faq.answer}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* --------------------------------------------------------- Final CTA */}
        <section className="bg-background px-4 py-16 sm:px-6 sm:py-20">
          <div className="mx-auto max-w-[1200px]">
            {/*
              The approved design uses a blue-to-purple gradient banner. Rebuilt
              on the theme tokens so it holds its contrast on a dark page, with
              the copy sitting on `panel` rather than on the gradient itself.
            */}
            <div className="relative isolate overflow-hidden rounded-3xl border border-border bg-panel px-6 py-12 sm:px-10 sm:py-14 lg:px-14">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(90%_140%_at_0%_0%,hsl(var(--primary)/0.35),transparent_60%),radial-gradient(80%_140%_at_100%_100%,hsl(var(--chart-4)/0.32),transparent_60%)]"
              />

              <div className="flex flex-col gap-8 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <Badge variant="onDark">Ready to get started?</Badge>
                  <h2 className="mt-5 max-w-2xl text-balance text-[26px] font-extrabold leading-[1.15] tracking-tightest text-panel-foreground sm:text-[32px] lg:text-[36px]">
                    Bring one buyer question worth examining.
                  </h2>
                  <p className="mt-4 max-w-xl text-pretty text-[14px] leading-relaxed text-panel-muted">
                    Requesting a demo does not approve a protocol or start an AI
                    call.
                  </p>
                </div>
                <Button
                  asChild
                  size="lg"
                  variant="onDark"
                  className="w-full shrink-0 sm:w-auto"
                >
                  <a href={DEMO_URL}>
                    Request demo
                    <ArrowRight className="h-4 w-4" strokeWidth={2.25} />
                  </a>
                </Button>
              </div>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------ Footer */}
        <footer className="border-t border-border bg-background">
          <div className="shell grid gap-10 py-14 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))]">
            <div>
              <ZypactWordmark className="text-primary" />
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
              Perplexity Sonar V1 · Launched by Zypact after approval · No guaranteed
              outcome
            </p>
            <p className="text-[12px] text-muted-foreground">© 2026 Zypact</p>
          </div>
        </footer>
      </div>
    </ThemeRoot>
  );
}
