#!/usr/bin/env tsx
/**
 * Fix Brief grounding regressions.
 *
 * Reproduces the real defect from the first commercial snapshot: one
 * prioritized gap spanned a lost revenue-intelligence question and a partial
 * attribution question, and the brief named the attribution competitors as
 * the products that beat the brand on the revenue-intelligence comparison —
 * products that appear in none of that question's stored runs.
 *
 * Pure functions — no database, provider, or network.
 */

import {
  buildDeterministicRootCause,
  buildFixBriefGroundingContext,
  formatCompetitorRecommended,
  hasUnsupportedQuantifiedClaim,
  buildGroundedFixBriefOutput,
  matchGapRowToPrioritizedGap,
  selectGroundedProbeResult,
} from "@/lib/pipeline/fix-brief-grounding";
import type { PrioritizedGap } from "@/lib/schemas/gap-map.schema";
import type { Gap, ProbeResult } from "@/lib/db/types";

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ok   ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}`); }
}

const PROMPT_A = "How to compare B2B revenue intelligence platforms?";
const PROMPT_B =
  "What are the best B2B marketing attribution tools for measuring campaign effectiveness?";
const PROMPT_WON = "Alternatives to Factors.ai for custom reporting in B2B?";

const A_COMPETITORS = ["Clari", "Gong", "Salesforce Revenue Intelligence", "People.ai"];
const B_COMPETITORS = [
  "Dreamdata", "Ruler Analytics", "Adobe Marketo Measure", "SegmentStream", "Fibbler",
];

/** The persisted row: global union in prose, both prompts, no provenance. */
const GAP_ROW: Gap = {
  id: "gap-1",
  projectId: "proj",
  competitorName: null,
  type: "prompt_loss",
  severity: "high",
  explanation:
    `9 competitors (${[...A_COMPETITORS, ...B_COMPETITORS].join(", ")}) show a ` +
    `material gap on "Prompt loss" in the selected probe set.`,
  affectedPrompts: [PROMPT_A, PROMPT_B],
  suggestedFixDirection: "Publish a grounded comparison surface.",
  createdAt: "2026-08-08T00:00:00.000Z",
};

const PRIORITIZED: PrioritizedGap = {
  type: "prompt_loss",
  severity: "high",
  explanation: GAP_ROW.explanation,
  affectedPrompts: [PROMPT_A, PROMPT_B],
  suggestedFixDirection: GAP_ROW.suggestedFixDirection,
  promptEvidence: [
    { prompt: PROMPT_A, promptKey: PROMPT_A.toLowerCase(), verdict: "lost", competitors: A_COMPETITORS },
    { prompt: PROMPT_B, promptKey: PROMPT_B.toLowerCase(), verdict: "partial", competitors: B_COMPETITORS },
  ],
};

function probe(opts: { id: string; prompt: string; verdict: string; createdAt: string }): ProbeResult {
  return {
    id: opts.id,
    projectId: "proj",
    prompt: opts.prompt,
    verdict: opts.verdict,
    createdAt: opts.createdAt,
    generatedPromptId: null,
    competitorsMentioned: [],
    sourcesCited: [],
  } as unknown as ProbeResult;
}

const PROBE_A = probe({ id: "probe-a", prompt: PROMPT_A, verdict: "lost", createdAt: "2026-08-01T00:00:00Z" });
const PROBE_B = probe({ id: "probe-b", prompt: PROMPT_B, verdict: "partial", createdAt: "2026-08-02T00:00:00Z" });
/** Unrelated to this gap — the old project-wide fallback would have used it. */
const PROBE_UNRELATED = probe({
  id: "probe-x", prompt: "How to switch from manual reporting to automated marketing insights?",
  verdict: "lost", createdAt: "2026-08-09T00:00:00Z",
});

console.log("test-fix-brief-grounding");

// 1 — gap row resolves to exactly one prioritized gap
{
  const m = matchGapRowToPrioritizedGap(GAP_ROW, [PRIORITIZED]);
  check("1 gap row matches exactly one prioritized gap", m.ok);
}

// 2 / 3 — fail closed on zero and on ambiguous matches
{
  const none = matchGapRowToPrioritizedGap(GAP_ROW, [{ ...PRIORITIZED, type: "citation" }]);
  check("2 no matching prioritized gap fails closed", !none.ok);

  const twin = { ...PRIORITIZED, suggestedFixDirection: "Another direction." };
  const many = matchGapRowToPrioritizedGap(GAP_ROW, [PRIORITIZED, twin]);
  check("3 duplicate matches fail closed as ambiguous", !many.ok);
  check("3b ambiguity is named as such", !many.ok && /[Aa]mbiguous/.test(many.reason));
}

// 4 — selected prompt A receives ONLY A's competitors  (the real defect)
{
  const r = buildFixBriefGroundingContext({
    gapRow: GAP_ROW, prioritizedGaps: [PRIORITIZED], probeResults: [PROBE_A],
  });
  check("4 grounding succeeds for prompt A", r.ok);
  if (r.ok) {
    const c = r.context;
    check("4b selected prompt is A", c.selectedPrompt === PROMPT_A);
    check("4c verdict is lost", c.selectedVerdict === "lost");
    check("4d competitor set is non-empty", c.promptLocalCompetitors.length > 0);
    check("4e all of A's competitors present",
      A_COMPETITORS.every((n) => c.promptLocalCompetitors.includes(n)));
    for (const foreign of B_COMPETITORS) {
      check(`4f attribution competitor "${foreign}" absent from prompt A`,
        !c.promptLocalCompetitors.includes(foreign));
    }
    const formatted = formatCompetitorRecommended(c.promptLocalCompetitors);
    for (const foreign of B_COMPETITORS) {
      check(`4g "${foreign}" absent from persisted competitorRecommended`,
        !formatted.includes(foreign));
    }
    check("4h grounded explanation carries no foreign competitor",
      !B_COMPETITORS.some((n) => c.groundedExplanation.includes(n)));
    check("4i global-union prose is not reused as the explanation",
      c.groundedExplanation !== GAP_ROW.explanation);
  }
}

// 5 — the inverse isolation holds for prompt B
{
  const r = buildFixBriefGroundingContext({
    gapRow: GAP_ROW, prioritizedGaps: [PRIORITIZED], probeResults: [PROBE_B],
  });
  check("5 grounding succeeds for prompt B", r.ok);
  if (r.ok) {
    check("5b selected prompt is B", r.context.selectedPrompt === PROMPT_B);
    check("5c B's competitors present",
      B_COMPETITORS.every((n) => r.context.promptLocalCompetitors.includes(n)));
    for (const foreign of A_COMPETITORS) {
      check(`5d revenue competitor "${foreign}" absent from prompt B`,
        !r.context.promptLocalCompetitors.includes(foreign));
    }
  }
}

// 6 — an unrelated project probe must NOT be used (no project-wide fallback)
{
  const r = buildFixBriefGroundingContext({
    gapRow: GAP_ROW, prioritizedGaps: [PRIORITIZED], probeResults: [PROBE_UNRELATED],
  });
  check("6 unrelated project probe fails closed rather than being used", !r.ok);
}

// 6b — assert at the selection layer itself, so a fallback reintroduced
// there is caught even though buildFixBriefGroundingContext would also
// reject the result downstream.
{
  const picked = selectGroundedProbeResult(PRIORITIZED, [PROBE_UNRELATED]);
  check("6b selection layer refuses an unrelated probe outright", !picked.ok);
  check("6b2 refusal names the missing correspondence",
    !picked.ok && /no stored probe run corresponds/i.test(picked.reason));
}

// 9b — and at the selection layer for absent provenance, so a synthetic
// placeholder substituted for missing promptEvidence is caught here.
{
  const picked = selectGroundedProbeResult(
    { ...PRIORITIZED, promptEvidence: undefined },
    [PROBE_A]
  );
  check("9b selection layer refuses a gap with no promptEvidence", !picked.ok);
  check("9b2 refusal names the missing promptEvidence",
    !picked.ok && /carries no promptEvidence/i.test(picked.reason));
}

// 7 / 8 — won and not_relevant are not recovery bases
{
  for (const verdict of ["won", "not_relevant"]) {
    const gapRow: Gap = { ...GAP_ROW, affectedPrompts: [PROMPT_WON] };
    const pg: PrioritizedGap = {
      ...PRIORITIZED, affectedPrompts: [PROMPT_WON],
      promptEvidence: [{
        prompt: PROMPT_WON, promptKey: PROMPT_WON.toLowerCase(),
        verdict: verdict as never, competitors: ["ExampleCompetitor"],
      }],
    };
    const r = buildFixBriefGroundingContext({
      gapRow, prioritizedGaps: [pg],
      probeResults: [probe({ id: "p", prompt: PROMPT_WON, verdict, createdAt: "2026-08-03T00:00:00Z" })],
    });
    check(`7/8 verdict "${verdict}" fails closed`, !r.ok);
  }
}

// 9 — no promptEvidence at all: no invented or global competitors
{
  const pg: PrioritizedGap = { ...PRIORITIZED, promptEvidence: undefined };
  const r = buildFixBriefGroundingContext({
    gapRow: GAP_ROW, prioritizedGaps: [pg], probeResults: [PROBE_A],
  });
  check("9 missing promptEvidence fails closed, no global fallback", !r.ok);
}

// 10 — lost is preferred over partial when both are eligible
{
  const picked = selectGroundedProbeResult(PRIORITIZED, [PROBE_B, PROBE_A]);
  check("10 lost outranks partial even though partial is newer",
    picked.ok && picked.probeResult.id === "probe-a");
}

// 11 — rootCause states the observation and disclaims the cause
{
  const r = buildFixBriefGroundingContext({
    gapRow: GAP_ROW, prioritizedGaps: [PRIORITIZED], probeResults: [PROBE_A],
  });
  if (r.ok) {
    const rc = buildDeterministicRootCause(r.context);
    check("11 rootCause is marked as an observation", /^Observed:/.test(rc));
    check("11b rootCause names the selected prompt", rc.includes(PROMPT_A));
    check("11c rootCause states the cause is not established",
      /does not establish why/i.test(rc));
    for (const claim of [
      "had no basis", "could not find", "did not find", "because it",
      "ignored", "did not trust", "chose",
    ]) {
      check(`11d rootCause makes no causal claim ("${claim}")`, !rc.toLowerCase().includes(claim));
    }
    check("11e rootCause carries no foreign competitor",
      !B_COMPETITORS.some((n) => rc.includes(n)));
  }
}

// 12 — model causal prose cannot reach the persisted field. The persisted
// rootCause is a pure function of grounding, so a hostile model string has
// no path in: buildDeterministicRootCause does not accept model output.
{
  const hostile =
    "The AI had no basis to recommend HockeyStack because it could not find relevant content.";
  const r = buildFixBriefGroundingContext({
    gapRow: GAP_ROW, prioritizedGaps: [PRIORITIZED], probeResults: [PROBE_A],
  });
  if (r.ok) {
    const persisted = buildDeterministicRootCause(r.context);
    check("12 hostile model causality cannot reach persisted rootCause",
      !persisted.includes(hostile) && !persisted.includes("could not find"));
    check("12b buildDeterministicRootCause takes only grounding, not model output",
      buildDeterministicRootCause.length === 1);
  }
}

// 13 — unsupported quantified impact claims are detected
{
  for (const bad of [
    "Expect a 30% increase in AI mentions.",
    "This should deliver 3x more citations.",
    "Visibility improves within 30 days.",
    "Moves the brand to #1 in recommendations.",
  ]) {
    check(`13 quantified claim rejected: "${bad.slice(0, 34)}…"`,
      hasUnsupportedQuantifiedClaim(bad));
  }
  for (const good of [
    "Creates a clearer evidence surface for this buyer question, which can be re-tested.",
    "Gives the answer a comparison source it currently lacks.",
  ]) {
    check("13b qualitative impact passes", !hasUnsupportedQuantifiedClaim(good));
  }
}

// 14 — empty competitor list is stated plainly, never backfilled
{
  const pg: PrioritizedGap = {
    ...PRIORITIZED,
    promptEvidence: [{
      prompt: PROMPT_A, promptKey: PROMPT_A.toLowerCase(), verdict: "lost", competitors: [],
    }],
    affectedPrompts: [PROMPT_A],
  };
  const r = buildFixBriefGroundingContext({
    gapRow: { ...GAP_ROW, affectedPrompts: [PROMPT_A] },
    prioritizedGaps: [pg], probeResults: [PROBE_A],
  });
  check("14 empty competitor evidence still grounds", r.ok);
  if (r.ok) {
    check("14b no competitor is invented", r.context.promptLocalCompetitors.length === 0);
    const formatted = formatCompetitorRecommended([]);
    check("14c persisted field says so plainly, naming nobody",
      /No competing product/.test(formatted) &&
        ![...A_COMPETITORS, ...B_COMPETITORS].some((n) => formatted.includes(n)));
  }
}

// 15 — the overlay discards model-controlled fields outright
{
  const r = buildFixBriefGroundingContext({
    gapRow: GAP_ROW, prioritizedGaps: [PRIORITIZED], probeResults: [PROBE_A],
  });
  if (r.ok) {
    const hostile = {
      lostPrompt: PROMPT_B,
      competitorRecommended: B_COMPETITORS.join(", "),
      rootCause:
        "The AI had no basis to recommend HockeyStack because it could not find relevant content.",
      expectedImpact: "Expect a 40% lift in AI mentions within 30 days.",
      recommendedFix: "Publish a comparison page.",
    };
    const out = buildGroundedFixBriefOutput({
      agentOutput: hostile, context: r.context, genericImpact: "GENERIC",
    });
    check("15 model lostPrompt is discarded", out.lostPrompt === PROMPT_A);
    for (const foreign of B_COMPETITORS) {
      check(`15b model-supplied "${foreign}" is discarded`,
        !out.competitorRecommended.includes(foreign));
    }
    check("15c model causal prose is discarded",
      !out.rootCause.includes("could not find") && !out.rootCause.includes("had no basis"));
    check("15d quantified impact claim is replaced", out.expectedImpact === "GENERIC");
    check("15e genuinely generative field is preserved",
      out.recommendedFix === "Publish a comparison page.");
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
