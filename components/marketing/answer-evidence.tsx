import { ArrowRight, Quote, Sparkles } from "lucide-react";

import {
  DETECTABLE_CHANGE_AT_15,
  SYNTHETIC_BASELINE_NAMED,
  SYNTHETIC_QUESTION,
  SYNTHETIC_RETEST_NAMED,
  SYNTHETIC_RUNS,
  syntheticComparison,
} from "@/components/marketing/synthetic-retest";

/**
 * The two concrete-evidence panels from the approved design: one AI answer with
 * its citations, and a baseline/retest pair for the same question.
 *
 * Every value is synthetic and labelled as such in the rendered output. Three
 * constraints shape what these may show, and all three come from the
 * methodology rather than from taste:
 *
 *  - Cited domains use the reserved `.example` TLD. The design mocks these
 *    slots with real third-party domains, but a fabricated citation attributed
 *    to a real publisher is a false evidence claim, not a placeholder.
 *  - The retest pair reports counts against a stated denominator and the
 *    smallest change that sample size can detect. A bare percentage lift would
 *    hide both.
 *  - Neither panel attributes movement to the registered change. METHODOLOGY
 *    §19 forbids "this fix caused the lift", so the copy states the opposite
 *    explicitly rather than staying silent and letting the layout imply it.
 */

const citedSources = [
  {
    rank: 1,
    domain: "your-domain.example",
    note: "Product overview page",
    tag: "Your site",
  },
  {
    rank: 2,
    domain: "category-guide.example",
    note: "Category comparison article",
    tag: "Third party",
  },
  {
    rank: 3,
    domain: "another-vendor.example",
    note: "Competitor product page",
    tag: "Competitor",
  },
] as const;

/** Superscript citation marker, matching the way the provider returns them. */
function Cite({ n }: { n: number }) {
  return (
    <sup className="ml-0.5 inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-[3px] bg-primary/10 px-1 text-[9px] font-bold text-primary">
      {n}
    </sup>
  );
}

function SyntheticBadge() {
  return (
    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
      Synthetic
    </span>
  );
}

/**
 * One captured provider answer with the sources it cited — the panel the
 * approved design pairs with the protocol section.
 */
export function ExampleAnswer() {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-float">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-surface-subtle px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Sparkles className="h-4 w-4" strokeWidth={1.9} aria-hidden="true" />
          </span>
          <span className="truncate text-[13px] font-bold tracking-tight">
            Perplexity Sonar
          </span>
        </div>
        <SyntheticBadge />
      </div>

      <div className="space-y-4 p-4 sm:p-5">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Approved question
          </p>
          <p className="mt-2 text-pretty text-[13px] font-semibold leading-relaxed tracking-tight">
            {SYNTHETIC_QUESTION}
          </p>
        </div>

        <div className="rounded-xl border border-border bg-surface-subtle p-4">
          <Quote
            className="h-3.5 w-3.5 text-muted-foreground"
            strokeWidth={2}
            aria-hidden="true"
          />
          <p className="mt-2.5 text-pretty text-[12.5px] leading-relaxed text-foreground/85">
            Mid-market manufacturers usually weigh how well a system handles
            shop-floor planning
            <Cite n={1} /> against how long its rollout takes
            <Cite n={2} />. Several vendors publish implementation timelines
            for plants of this size
            <Cite n={3} />.
          </p>
        </div>

        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Sources cited in this answer
          </p>
          <ul className="mt-3 space-y-2">
            {citedSources.map((source) => (
              <li
                key={source.rank}
                className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5"
              >
                <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-bold text-muted-foreground">
                  {source.rank}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-semibold tracking-tight text-primary">
                    {source.domain}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {source.note}
                  </span>
                </span>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[9px] font-semibold tracking-tight text-muted-foreground">
                  {source.tag}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <p className="border-t border-border bg-surface-subtle px-4 py-3 text-[10px] leading-relaxed text-muted-foreground sm:px-5">
        Synthetic example — not customer data and not a live Perplexity probe.
        Real runs preserve the exact request, response and sources returned.
      </p>
    </div>
  );
}

const retestPair = [
  {
    phase: "Baseline",
    meta: "Before the registered change",
    excerpt:
      "Mid-market manufacturers usually weigh how well a system handles shop-floor planning against how long its rollout takes.",
    named: SYNTHETIC_BASELINE_NAMED,
    accent: false,
  },
  {
    phase: "Retest",
    meta: "After the observation window",
    excerpt:
      "Several vendors publish implementation timelines for plants of this size, so a buyer can compare rollouts before speaking to sales.",
    named: SYNTHETIC_RETEST_NAMED,
    accent: true,
  },
] as const;

/**
 * The same approved question asked twice, either side of one registered change.
 */
export function RetestComparison() {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-card">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-surface-subtle px-4 py-3 sm:px-5">
        <p className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Same question · Same protocol
        </p>
        <SyntheticBadge />
      </div>

      {/*
        Both cells must be opaque. The grid draws its dividers as a 1px `gap`
        over a `bg-border` parent, so a translucent tint on either cell reads as
        grey showback rather than as the colour it was meant to be.
      */}
      <div className="grid gap-px bg-border sm:grid-cols-2">
        {retestPair.map((side) => (
          <div
            key={side.phase}
            className={`flex flex-col p-4 sm:p-5 ${
              side.accent ? "bg-surface-muted" : "bg-card"
            }`}
          >
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-[13px] font-bold tracking-tight">
                {side.phase}
              </p>
              <p className="shrink-0 text-[10px] text-muted-foreground">
                {side.meta}
              </p>
            </div>

            {/* `flex-1` absorbs the difference when the two excerpts wrap to
                different heights, so the count boxes below them stay aligned. */}
            <p className="mt-3 flex-1 text-pretty text-[12px] leading-relaxed text-muted-foreground">
              {side.excerpt}
            </p>

            <div className="mt-4 rounded-lg border border-border bg-background px-3 py-2.5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                Your brand named in
              </p>
              <p className="mt-1 text-[15px] font-bold tracking-tight tabular-nums">
                {side.named}{" "}
                <span className="text-[12px] font-medium text-muted-foreground">
                  of {SYNTHETIC_RUNS} preserved runs
                </span>
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-3 border-t border-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <span className="inline-flex items-center gap-2 self-start rounded-full bg-success/10 px-3 py-1.5 font-mono text-[11px] font-semibold text-success">
          <ArrowRight className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
          {syntheticComparison.status}
        </span>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Synthetic illustration. Smallest change {SYNTHETIC_RUNS} runs can
          detect, at equal phases: {DETECTABLE_CHANGE_AT_15}
        </p>
      </div>

      <p className="border-t border-border bg-surface-subtle px-4 py-3 text-[10px] leading-relaxed text-muted-foreground sm:px-5">
        Synthetic example. Zypact records that the change was made and that the
        observation moved. It does not claim the change caused the movement.
      </p>
    </div>
  );
}
