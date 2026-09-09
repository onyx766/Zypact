import {
  ArrowRight,
  BarChart3,
  Check,
  ClipboardList,
  Database,
  Play,
  Repeat,
  Search,
  ShieldCheck,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EvidenceDashboard } from "@/components/v2/evidence-dashboard";
import { SiteHeader } from "@/components/v2/site-header";
import { ZypactWordmark } from "@/components/v2/zypact-mark";

const DEMO_URL = "/scan";

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
      { label: "Full methodology", href: "/" },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "Current site", href: "/" },
      { label: "Sign in", href: "/login" },
    ],
  },
] as const;

export default function V2LandingPage() {
  return (
    <div className="min-h-screen bg-surface-subtle">
      <SiteHeader />

      {/* ---------------------------------------------------------------- Hero */}
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
              buyer question, preserves the exact evidence, and checks the same
              question again after one registered change.
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
          </div>

          <div id="evidence" className="scroll-mt-24 lg:translate-x-6">
            <EvidenceDashboard />
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ Guarantee strip */}
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

      {/* -------------------------------------------------------- How it works */}
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
              Zypact fixes the protocol before any paid call, then runs it the
              same way every time.
            </p>
            <Button asChild variant="outline" className="mt-8 h-11 px-5">
              <a href="/">
                <Play className="h-3.5 w-3.5 fill-current" strokeWidth={0} />
                See the full method
              </a>
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

      {/* ------------------------------------------------------------ Features */}
      <section id="features" className="scroll-mt-20 bg-background py-20 lg:py-24">
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
            className="mt-16 scroll-mt-20 grid gap-10 rounded-xl border border-border bg-surface-muted p-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:p-10"
          >
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Scope and limits
              </p>
              <h3 className="mt-4 text-[22px] font-bold leading-snug tracking-tight">
                What V1 does not claim
              </h3>
              <p className="mt-4 text-[13px] leading-relaxed text-muted-foreground">
                Perplexity Sonar is the only live surface, and it is presented
                as a directional proxy rather than the whole AI-search market.
                V1 produces no market-wide score, no multi-model coverage, no
                guaranteed recommendation, and no causal or revenue attribution.
                Observed movement is never presented as proof that an
                intervention caused a change.
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
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------- Final CTA */}
      <section className="bg-brand-800">
        <div className="shell flex flex-col gap-8 py-16 lg:flex-row lg:items-center lg:justify-between lg:py-20">
          <div>
            <Badge variant="onDark">Ready to get started?</Badge>
            <h2 className="mt-6 max-w-2xl text-[30px] font-extrabold leading-[1.15] tracking-tightest text-white sm:text-[36px]">
              Bring one buyer question worth examining.
            </h2>
          </div>
          <Button asChild size="lg" variant="onDark">
            <a href={DEMO_URL}>
              Request demo
              <ArrowRight className="h-4 w-4" strokeWidth={2.25} />
            </a>
          </Button>
        </div>
      </section>

      {/* -------------------------------------------------------------- Footer */}
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
  );
}
