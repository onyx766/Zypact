import type { Metadata } from "next";

import { SiteHeader } from "@/components/marketing/site-header";
import { canonicalUrl } from "@/lib/seo/site";

export const metadata: Metadata = {
  title: "Methodology | How Zypact Measures AI Answer Changes",
  description:
    "Zypact’s V1 process: one approved buyer question, a preserved baseline, one registered intervention and a same-question retest in Perplexity Sonar.",
  alternates: { canonical: "/method" },
  openGraph: {
    title: "Methodology | How Zypact Measures AI Answer Changes",
    description:
      "One approved question, preserved evidence, one registered change, and an honest retest.",
    url: canonicalUrl("/method"),
    siteName: "Zypact",
    type: "website",
  },
};

const steps = [
  ["1. Approve the buyer question", "Agree on the question, measurement configuration, sampling plan, observation window, and evaluation protocol."],
  ["2. Capture the baseline", "Record Perplexity Sonar responses, citations, timestamps, model settings, sample sizes, and relevant metadata. Failed and excluded attempts remain visible."],
  ["3. Register the intervention", "Document what content or positioning change is being made and when it is expected to go live before its outcome is known."],
  ["4. Observe and retest", "Ask the same approved buyer question again after the agreed observation window under the approved protocol."],
  ["5. Review the Outcome Card", "Review the observed differences, supporting evidence, and remaining uncertainty."],
] as const;

export default function MethodPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <main className="shell max-w-4xl py-16 sm:py-24">
        <p className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">Methodology</p>
        <h1 className="mt-5 text-balance text-4xl font-extrabold tracking-tightest sm:text-6xl">How Zypact Measures AI Answer Changes</h1>
        <p className="mt-7 max-w-3xl text-lg leading-relaxed text-muted-foreground">One buyer question. One documented change. An honest retest. Our approach prioritizes a consistent measurement protocol, preserved evidence, and honest reporting of uncertainty.</p>

        <div className="mt-16 grid gap-6">
          {steps.map(([title, copy]) => (
            <section key={title} className="rounded-2xl border border-border p-6 sm:p-8">
              <h2 className="text-xl font-bold">{title}</h2>
              <p className="mt-3 leading-relaxed text-muted-foreground">{copy}</p>
            </section>
          ))}
        </div>

        <section className="mt-16 border-t border-border pt-12">
          <h2 className="text-2xl font-bold">Four possible outcomes</h2>
          <p className="mt-4 leading-relaxed text-muted-foreground">Increase observed, decrease observed, no clear change, or inconclusive. An inconclusive result is valid; insufficient evidence is not turned into a positive claim.</p>
          <h2 className="mt-12 text-2xl font-bold">Statistical method</h2>
          <p className="mt-4 leading-relaxed text-muted-foreground">For sample-proportion comparisons, V1 uses a Newcombe 95% confidence interval built from Wilson score intervals. Counts, observed differences, and uncertainty must be interpreted together. The homepage’s 0.27 figure is synthetic demonstration data for equal 15-run samples—not customer impact and not a universal detection threshold.</p>
          <h2 className="mt-12 text-2xl font-bold">Measurement limitations</h2>
          <p className="mt-4 leading-relaxed text-muted-foreground">V1 measures Perplexity Sonar only. API responses may differ from the consumer application. An observed difference does not prove the registered intervention caused it, and Zypact does not measure the entire AI-search market or attribute revenue to an observed change.</p>
        </section>

        <div className="mt-16 rounded-2xl border border-border bg-muted/40 p-6 sm:p-8">
          <h2 className="text-2xl font-bold">Planning an important change?</h2>
          <p className="mt-3 text-muted-foreground">Start with the buyer question you want to test, ideally before the change goes live.</p>
          <a className="mt-6 inline-flex font-semibold text-primary underline-offset-4 hover:underline" href="/scan">Request a demo →</a>
        </div>
      </main>
    </div>
  );
}
