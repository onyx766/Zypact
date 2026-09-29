import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ZypactWordmark } from "@/components/marketing/zypact-mark";
import { ThemeRoot } from "@/components/theme-root";
import { canonicalUrl } from "@/lib/seo/site";

// Registered intervention: this page's copy is frozen by the client. Any edit
// here changes the experiment under observation, not just the page.

const PATH = "/perplexity-content-change-test";
const SCAN_URL = "/scan";

const TITLE = "Did Your Content Change Move the Perplexity Answer? | Zypact";
const DESCRIPTION =
  "AI answers can change even when your website does not. Zypact tests one approved buyer question before and after one documented intervention using the same controlled protocol.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: PATH },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: canonicalUrl(PATH),
    siteName: "Zypact",
    type: "article",
  },
};

const steps = [
  {
    title: "Baseline",
    copy: "run the same approved buyer question and preserve the answers, sources, and metadata.",
  },
  {
    title: "Register one change",
    copy: "record one content or positioning intervention before it is implemented.",
  },
  {
    title: "Implement",
    copy: "publish the documented change and preserve implementation evidence.",
  },
  {
    title: "Wait",
    copy: "use the predefined observation window rather than immediately checking for a favorable answer.",
  },
  {
    title: "Retest",
    copy: "ask the exact same buyer question again under the registered protocol and compare the evidence.",
  },
] as const;

const lookFor = [
  "Was the company named?",
  "Did its position in the answer change?",
  "Did the cited evidence change?",
  "Did competitors appear differently?",
  "Did the result pass the predefined decision threshold?",
] as const;

export default function PerplexityContentChangeTestPage() {
  return (
    // Light is pinned, not inherited. This page IS a registered intervention
    // ("Page created"), and its observation window is open — Sep 24 to Oct 9,
    // 2026. Rendering it dark with the rest of the marketing site would change
    // the artifact under observation partway through the measurement. Adopt
    // the site theme only once the window has closed and the retest is done.
    <ThemeRoot theme="light">
      <div className="min-h-screen bg-surface-subtle">
        <header className="border-b border-border bg-surface-subtle">
          <div className="shell flex h-[68px] items-center justify-between gap-8">
            <ZypactWordmark
              className="text-primary"
              dotFill="hsl(var(--surface-subtle))"
            />
            <Button asChild>
              <a href={SCAN_URL}>Test one buyer question</a>
            </Button>
          </div>
        </header>

        <main>
          <article>
            <section className="bg-surface-subtle">
              <div className="shell max-w-3xl pb-16 pt-16 lg:pb-20 lg:pt-20">
                <Badge>Controlled before/after testing</Badge>
                <h1 className="mt-6 text-[38px] font-extrabold leading-[1.08] tracking-tightest sm:text-[48px]">
                  Test whether a content change changed the Perplexity answer
                </h1>
                <p className="mt-6 text-[16px] leading-relaxed text-muted-foreground">
                  AI answers can change even when your website does not. That
                  makes it difficult to know whether a new comparison page,
                  positioning update, proof point, or content change actually
                  moved the answer.
                </p>
                <p className="mt-4 text-[16px] leading-relaxed text-muted-foreground">
                  Zypact tests one approved buyer question before and after one
                  documented intervention using the same controlled protocol.
                </p>
              </div>
            </section>

            <section className="border-y border-border bg-background py-16 lg:py-20">
              <div className="shell max-w-3xl">
                <h2 className="text-[28px] font-extrabold leading-[1.15] tracking-tightest sm:text-[32px]">
                  The problem with checking once
                </h2>
                <p className="mt-5 text-[15px] leading-relaxed text-muted-foreground">
                  Asking Perplexity once before a change and once afterward is
                  not enough to distinguish meaningful movement from normal
                  model and retrieval variation.
                </p>
                <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
                  A controlled test keeps the buyer question fixed, preserves
                  the baseline evidence, records the intervention before the
                  result exists, waits through the observation window, and
                  retests the same question.
                </p>
              </div>
            </section>

            <section className="bg-surface-subtle py-16 lg:py-20">
              <div className="shell max-w-3xl">
                <h2 className="text-[28px] font-extrabold leading-[1.15] tracking-tightest sm:text-[32px]">
                  How Zypact tests a change
                </h2>
                <ol className="mt-8 space-y-4">
                  {steps.map((step, index) => (
                    <li
                      key={step.title}
                      className="flex gap-4 rounded-xl border border-border bg-background p-5"
                    >
                      <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-accent text-[13px] font-bold text-accent-foreground">
                        {index + 1}
                      </span>
                      <p className="pt-1.5 text-[15px] leading-relaxed text-muted-foreground">
                        <strong className="font-bold text-foreground">
                          {step.title}
                        </strong>{" "}
                        — {step.copy}
                      </p>
                    </li>
                  ))}
                </ol>
              </div>
            </section>

            <section className="border-y border-border bg-background py-16 lg:py-20">
              <div className="shell max-w-3xl">
                <h2 className="text-[28px] font-extrabold leading-[1.15] tracking-tightest sm:text-[32px]">
                  What Zypact looks for
                </h2>
                <p className="mt-5 text-[15px] leading-relaxed text-muted-foreground">
                  The retest does not ask whether your SEO “improved.” It asks
                  whether the observed buyer answer changed within the
                  registered experiment.
                </p>
                <ul className="mt-8 grid gap-3 sm:grid-cols-2">
                  {lookFor.map((question) => (
                    <li
                      key={question}
                      className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-subtle px-4 py-3.5 text-[14px] font-semibold tracking-tight"
                    >
                      <span
                        className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                        aria-hidden="true"
                      />
                      {question}
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            <section className="bg-surface-subtle py-16 lg:py-20">
              <div className="shell max-w-3xl">
                <div className="rounded-xl border border-border bg-surface-muted p-8 lg:p-10">
                  <h2 className="text-[22px] font-bold leading-snug tracking-tight">
                    What this does not prove
                  </h2>
                  <p className="mt-4 text-[14px] leading-relaxed text-muted-foreground">
                    An observed change is not proof that one page caused the
                    model response. Perplexity, retrieved sources, competitor
                    content, and other external factors can change during the
                    observation window. Zypact preserves those limitations
                    rather than turning one experiment into a causal or revenue
                    claim.
                  </p>
                </div>
              </div>
            </section>
          </article>

          <section className="bg-panel">
            <div className="shell flex flex-col gap-8 py-16 lg:flex-row lg:items-center lg:justify-between lg:py-20">
              <h2 className="max-w-2xl text-[30px] font-extrabold leading-[1.15] tracking-tightest text-panel-foreground sm:text-[36px]">
                Test one buyer question
              </h2>
              <Button asChild size="lg" variant="onDark">
                <a href={SCAN_URL}>
                  Test one buyer question
                  <ArrowRight className="h-4 w-4" strokeWidth={2.25} />
                </a>
              </Button>
            </div>
          </section>
        </main>

        <footer className="bg-background">
          <div className="shell flex flex-col gap-2 py-6 sm:flex-row sm:items-center sm:justify-between">
            <ZypactWordmark className="text-primary" />
            <p className="text-[12px] text-muted-foreground">© 2026 Zypact</p>
          </div>
        </footer>
      </div>
    </ThemeRoot>
  );
}
