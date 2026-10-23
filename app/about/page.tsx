import type { Metadata } from "next";

import { SiteHeader } from "@/components/marketing/site-header";
import { canonicalUrl } from "@/lib/seo/site";

export const metadata: Metadata = {
  title: "About Zypact | AI Answer Change Measurement for B2B SaaS",
  description:
    "Learn why Zypact helps B2B SaaS teams examine Perplexity Sonar answers before and after one documented content or positioning change.",
  alternates: { canonical: "/about" },
  openGraph: {
    title: "About Zypact | AI Answer Change Measurement for B2B SaaS",
    description:
      "One buyer question, one documented change, and an honest retest in Perplexity Sonar.",
    url: canonicalUrl("/about"),
    siteName: "Zypact",
    type: "website",
  },
};

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <main className="shell max-w-4xl py-16 sm:py-24">
        <p className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground">
          About Zypact
        </p>
        <h1 className="mt-5 text-balance text-4xl font-extrabold tracking-tightest sm:text-6xl">
          One buyer question. One documented change. An honest retest.
        </h1>
        <p className="mt-7 max-w-3xl text-lg leading-relaxed text-muted-foreground">
          Zypact helps B2B SaaS teams examine how Perplexity Sonar answers an important buyer question before and after a documented content or positioning change.
        </p>

        <div className="mt-16 grid gap-12 border-t border-border pt-12 md:grid-cols-2">
          <section>
            <h2 className="text-2xl font-bold">Why Zypact exists</h2>
            <p className="mt-4 leading-relaxed text-muted-foreground">
              After updating a comparison page, clarifying your positioning, or publishing new product evidence, you may notice a different AI answer. A different answer alone does not explain why it changed. Zypact brings structure through a recorded baseline, a registered intervention, and a planned retest.
            </p>
          </section>
          <section>
            <h2 className="text-2xl font-bold">Who we serve</h2>
            <p className="mt-4 leading-relaxed text-muted-foreground">
              Zypact is designed for B2B SaaS marketing and product marketing teams planning a content or positioning change. A suitable engagement starts with one commercially important buyer question, a documented change, a responsible owner, and an expected publication date.
            </p>
          </section>
          <section>
            <h2 className="text-2xl font-bold">How it works</h2>
            <p className="mt-4 leading-relaxed text-muted-foreground">
              We agree on the buyer question and measurement protocol, capture the baseline, register the intervention, and retest the same question after an agreed observation window. Provider responses, citations, and relevant metadata are preserved for review.
            </p>
          </section>
          <section>
            <h2 className="text-2xl font-bold">Our focus and limits</h2>
            <p className="mt-4 leading-relaxed text-muted-foreground">
              V1 measures Perplexity Sonar only. Sonar API answers and citations can differ from the Perplexity consumer app. Zypact does not guarantee AI recommendations, prove causation, or attribute revenue to an observed change.
            </p>
          </section>
        </div>

        <div className="mt-16 rounded-2xl border border-border bg-muted/40 p-6 sm:p-8">
          <h2 className="text-2xl font-bold">Planning a content or positioning change?</h2>
          <p className="mt-3 text-muted-foreground">Start with the buyer question you want to test—before the change goes live.</p>
          <a className="mt-6 inline-flex font-semibold text-primary underline-offset-4 hover:underline" href="/scan">Request a demo →</a>
        </div>
      </main>
    </div>
  );
}
