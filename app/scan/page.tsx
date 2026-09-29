import type { Metadata } from "next";
import {
  ArrowLeft,
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

import { Badge } from "@/components/ui/badge";
import {
  CheckItem,
  IconTile,
  PanelCard,
  SectionHeading,
  StepItem,
  toneAt,
} from "@/components/marketing/section-kit";
import { ZypactWordmark } from "@/components/marketing/zypact-mark";
import { ThemeRoot } from "@/components/theme-root";

import { ScanForm } from "./scan-form";

export const metadata: Metadata = {
  title: "Request a Zypact V1 demo",
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
  },
  {
    title: "Reviewed before any AI call",
    desc: "We review your question and protocol first.",
    icon: ShieldCheck,
  },
  {
    title: "Evidence-backed result",
    desc: "A controlled run with exact evidence and integrity checks.",
    icon: Database,
  },
] as const;

/**
 * The three stages between a request and a result.
 *
 * The approved design shows a product preview beside this with a cross-platform
 * comparison and a single "overall visibility" percentage. Neither is built:
 * Perplexity Sonar is the only live V1 surface, and a universal visibility
 * number is exactly the claim the methodology forbids. These stages describe
 * what actually happens instead.
 */
const STAGES = [
  {
    number: 1,
    title: "Submit a buyer question",
    icon: ClipboardList,
    copy: "Share one real question a prospective customer might ask when comparing products like yours.",
  },
  {
    number: 2,
    title: "Run a controlled baseline",
    icon: Search,
    copy: "After the question and protocol are approved, the bounded Perplexity Sonar baseline runs automatically.",
  },
  {
    number: 3,
    title: "Review evidence and results",
    icon: BarChart3,
    copy: "Read the prompt-scoped observations with the exact provider evidence behind every one of them.",
  },
] as const;

export default function ScanPage() {
  const enabled = process.env.SNAPSHOT_PUBLIC_FORM_ENABLED === "true";

  return (
    <ThemeRoot>
      <div className="min-h-screen bg-background">
        <header className="border-b border-border/60">
          <div className="shell flex h-[64px] items-center justify-between gap-6 sm:h-[68px]">
            <ZypactWordmark
              className="text-primary"
              dotFill="hsl(var(--background))"
            />

            <a
              href="/"
              className="inline-flex items-center gap-2 rounded-md text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:text-[14px]"
            >
              <ArrowLeft className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              Back to website
            </a>
          </div>
        </header>

        <main>
          {/* ------------------------------------------------------------ Hero */}
          <section className="relative isolate overflow-hidden">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 -top-40 -z-10 h-[520px] bg-[radial-gradient(60%_60%_at_50%_0%,hsl(var(--primary)/0.14),transparent_70%)]"
            />

            <div className="shell grid gap-10 py-12 sm:py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.92fr)] lg:gap-14 lg:py-20">
              {/* -------------------------------------------------- Left column */}
              <div className="max-w-xl">
                <Badge>See Zypact in action</Badge>

                <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                  Zypact V1 · Controlled automation
                </p>

                <h1 className="mt-4 text-balance text-[32px] font-extrabold leading-[1.07] tracking-tightest sm:text-[42px] lg:text-[48px]">
                  Request a Zypact demo
                </h1>

                <p className="mt-5 text-pretty text-[15px] leading-relaxed text-muted-foreground sm:text-[16px]">
                  See how your company appears in an AI buyer answer. Bring one
                  commercially important buyer question. Zypact reviews the
                  question and protocol first. After approval, the controlled
                  Perplexity Sonar baseline runs automatically and preserves the
                  evidence.
                </p>

                <ul className="mt-7 grid gap-3.5">
                  {HIGHLIGHTS.map((point) => (
                    <CheckItem key={point} icon={Check}>
                      {point}
                    </CheckItem>
                  ))}
                </ul>

                <p className="mt-7 flex items-start gap-2.5 rounded-xl border border-info/30 bg-info/10 px-4 py-3 text-[13px] font-semibold leading-relaxed text-foreground">
                  <Info
                    className="mt-0.5 h-4 w-4 shrink-0 text-info"
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                  <span>Submitting this form does not start an AI call.</span>
                </p>

                <ul className="mt-8 grid gap-4 border-t border-border pt-7 sm:grid-cols-3 lg:grid-cols-1 lg:gap-3.5">
                  {SUMMARY.map((item, index) => (
                    <li key={item.title} className="flex items-start gap-3">
                      <IconTile
                        icon={item.icon}
                        tone={toneAt(index)}
                        className="h-9 w-9 rounded-lg"
                      />
                      <span className="min-w-0">
                        <span className="block text-[13.5px] font-bold tracking-tight">
                          {item.title}
                        </span>
                        <span className="mt-0.5 block text-[12.5px] leading-relaxed text-muted-foreground">
                          {item.desc}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>

                <p className="mt-7 border-t border-border pt-5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  V1 surface: Perplexity Sonar only. No market-wide score,
                  causal promise, or revenue attribution.
                </p>
              </div>

              {/* ------------------------------------------------- Right column */}
              <div className="lg:sticky lg:top-8 lg:self-start">
                <PanelCard className="p-5 sm:p-7 lg:p-8">
                  <ScanForm enabled={enabled} />
                </PanelCard>
              </div>
            </div>
          </section>

          {/* ---------------------------------------------------- How it works */}
          <section className="border-t border-border bg-surface-subtle py-16 sm:py-20">
            <div className="shell">
              <SectionHeading
                label="How it works"
                title="From question to insights in three steps"
                lede="Nothing runs until the question and protocol are approved. After that, the controlled baseline runs automatically."
              />

              <div className="mt-12 grid gap-8 sm:grid-cols-3 sm:gap-6">
                {STAGES.map((stage, index) => (
                  <PanelCard key={stage.title}>
                    <StepItem
                      number={stage.number}
                      icon={stage.icon}
                      tone={toneAt(index)}
                      title={stage.title}
                      copy={stage.copy}
                    />
                  </PanelCard>
                ))}
              </div>

              {/*
                The approved design closes this page with client logos and a
                named testimonial. Both are left out until there are real ones
                to show — a pre-pilot product cannot borrow credibility it has
                not earned. The scope boundary does that work honestly instead.
              */}
              <PanelCard className="mt-12 flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
                <IconTile icon={Repeat} tone="teal" />
                <p className="text-pretty text-[13.5px] leading-relaxed text-muted-foreground">
                  Every retest ends in one of four statuses — increase observed,
                  decrease observed, no clear change, or inconclusive. Zypact
                  guarantees the agreed process and evidence contract, not a
                  favorable model response.
                </p>
              </PanelCard>
            </div>
          </section>
        </main>

        <footer className="border-t border-border bg-background">
          <div className="shell flex flex-col gap-2 py-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[12px] text-muted-foreground">
              Perplexity Sonar V1 · Automated after approval · No guaranteed
              outcome
            </p>
            <p className="text-[12px] text-muted-foreground">© 2026 Zypact</p>
          </div>
        </footer>
      </div>
    </ThemeRoot>
  );
}
