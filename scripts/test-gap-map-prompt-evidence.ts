#!/usr/bin/env tsx
/**
 * Prompt-scoped gap attribution, tested against the REAL deterministic
 * builder rather than the helper alone.
 *
 * A dimension gap used to describe itself with the global union of every
 * competitor that cleared the threshold, and with a prompt set collected
 * independently. Nothing tied a competitor to the buyer question that
 * actually recommended it, so a gap could imply that a product recommended
 * for one prompt explained a loss on another. These tests exercise
 * `buildDeterministicPrioritizedGaps` directly and assert the association
 * survives.
 *
 * Pure functions — no provider, database, or network.
 */

import {
  buildDeterministicPrioritizedGaps,
  buildPrioritizedGapsFromEvidence,
} from "@/lib/agents/gap-map";
import type { RunGapMapInput } from "@/lib/agents/gap-map";
import type { CompetitorDistance, GapScores } from "@/lib/schemas/gap-map.schema";
import type { PromptCompetitorEvidence } from "@/lib/pipeline/scorecard-competitors";

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ok   ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}`); }
}

const PROMPT_A = "How to compare B2B revenue intelligence platforms?";
const PROMPT_B = "What are the best B2B marketing attribution tools for measuring campaign effectiveness?";
const PROMPT_C = "Alternatives to Factors.ai for custom reporting in B2B?";

const A_COMPETITORS = ["Clari", "Gong"];
const B_COMPETITORS = ["Dreamdata", "Ruler Analytics"];
const C_COMPETITORS = ["ExampleWonCompetitor"];
/** Cited only as sources; never recommended as products. */
const SOURCE_ONLY = ["Improvado", "Whatagraph"];

function evidence(
  prompt: string,
  outcome: PromptCompetitorEvidence["outcome"],
  names: string[]
): PromptCompetitorEvidence {
  return {
    prompt,
    promptKey: prompt.toLowerCase(),
    outcome,
    runs: 3,
    competitors: names.map((name, i) => ({
      name,
      nameKey: name.trim().toLowerCase(),
      canonicalEntityId: `canonical:${name.trim().toLowerCase()}`,
      prompt,
      promptKey: prompt.toLowerCase(),
      promptOutcome: outcome,
      recommendationCount: 3,
      runs: 3,
      bestPosition: i + 1,
      source: "probe_recommended_product" as const,
    })),
  };
}

const competitorEvidence: PromptCompetitorEvidence[] = [
  evidence(PROMPT_A, "lost", A_COMPETITORS),
  evidence(PROMPT_B, "partial", B_COMPETITORS),
  evidence(PROMPT_C, "won", C_COMPETITORS),
];

/** Every product clears the threshold on comparison_content. */
function distance(name: string): CompetitorDistance {
  const scores: GapScores = {
    prompt_loss: 8,
    citation: 0,
    review: 0,
    comparison_content: 8,
    proof: 0,
    entity_clarity: 0,
  };
  return {
    competitor: name,
    recommendationDistance: 50,
    gapScores: scores,
    topReasons: ["test"],
    evidenceStrength: "moderate",
  };
}

const input = {
  mirrorProfile: { companyName: "HockeyStack", website: "hockeystack.com" },
  probeResults: [],
  competitors: [],
  competitorEvidence,
} as unknown as RunGapMapInput;

// Source-only names are offered as threshold-clearing distances too: if they
// ever appear in a gap, it means attribution came from somewhere other than
// the recommendation evidence.
const distances = [
  ...A_COMPETITORS, ...B_COMPETITORS, ...C_COMPETITORS, ...SOURCE_ONLY,
].map(distance);

console.log("test-gap-map-prompt-evidence");

// fixture preconditions
{
  const a = competitorEvidence[0], b = competitorEvidence[1];
  check("PROMPT_A_COMPETITOR_COUNT_GT_ZERO", a.competitors.length > 0);
  check("PROMPT_B_COMPETITOR_COUNT_GT_ZERO", b.competitors.length > 0);
  check("PROMPT_COMPETITOR_SETS_DISTINCT",
    !a.competitors.some((c) => b.competitors.some((d) => d.nameKey === c.nameKey)));
}

const gaps = buildDeterministicPrioritizedGaps(input, distances);
check("real builder produced at least one gap", gaps.length > 0);

// The provider-free mock path builds gaps too. It used to own a second copy of
// this logic and kept global attribution; both now delegate to the same helper,
// so the assertions below run against whichever path produced `gaps`.
const emptyFallback = {
  prompt_loss: new Set<string>(), citation: new Set<string>(), review: new Set<string>(),
  comparison_content: new Set<string>(), proof: new Set<string>(), entity_clarity: new Set<string>(),
};
const mockPathGaps = buildPrioritizedGapsFromEvidence({
  competitorDistances: distances,
  competitorEvidence,
  fallbackAffectedPrompts: emptyFallback,
  explanationSuffix: ".",
});
check("MOCK_PATH_PROMPT_SCOPING produced gaps", mockPathGaps.length > 0);
check("MOCK_PATH_PROMPT_SCOPING has structured promptEvidence",
  mockPathGaps.every((g) => (g.promptEvidence ?? []).length > 0));
check("MOCK_PATH prompt A holds only its own competitors",
  mockPathGaps.every((g) => {
    const a = (g.promptEvidence ?? []).find((e) => e.prompt === PROMPT_A);
    return a !== undefined &&
      A_COMPETITORS.every((n) => a.competitors.includes(n)) &&
      !B_COMPETITORS.some((n) => a.competitors.includes(n));
  }));
check("MOCK_PATH excludes won prompt and source-only names",
  mockPathGaps.every((g) => {
    const ev = g.promptEvidence ?? [];
    return !ev.some((e) => e.prompt === PROMPT_C) &&
      !ev.some((e) => e.competitors.some((c) => SOURCE_ONLY.includes(c)));
  }));

// NORMAL_MOCK_ATTRIBUTION_PARITY: identical attribution from both paths.
check("NORMAL_MOCK_ATTRIBUTION_PARITY",
  JSON.stringify(gaps.map((g) => [g.type, g.promptEvidence, g.affectedPrompts])) ===
  JSON.stringify(mockPathGaps.map((g) => [g.type, g.promptEvidence, g.affectedPrompts])));

for (const gap of gaps) {
  const ev = gap.promptEvidence ?? [];
  check(`[${gap.type}] promptEvidence is structured`, ev.length > 0);

  const a = ev.find((e) => e.prompt === PROMPT_A);
  const b = ev.find((e) => e.prompt === PROMPT_B);

  check(`[${gap.type}] Prompt A entry present`, a !== undefined);
  check(`[${gap.type}] Prompt A holds its own competitors`,
    A_COMPETITORS.every((n) => a?.competitors.includes(n)));
  check(`[${gap.type}] Prompt A does NOT hold Prompt B competitors`,
    !B_COMPETITORS.some((n) => a?.competitors.includes(n)));

  check(`[${gap.type}] Prompt B entry present`, b !== undefined);
  check(`[${gap.type}] Prompt B holds its own competitors`,
    B_COMPETITORS.every((n) => b?.competitors.includes(n)));
  check(`[${gap.type}] Prompt B does NOT hold Prompt A competitors`,
    !A_COMPETITORS.some((n) => b?.competitors.includes(n)));

  check(`[${gap.type}] won prompt absent from recovery evidence`,
    !ev.some((e) => e.prompt === PROMPT_C));
  check(`[${gap.type}] won-prompt competitor never attributed`,
    !ev.some((e) => e.competitors.some((c) => C_COMPETITORS.includes(c))));

  check(`[${gap.type}] source-only names never attributed`,
    !ev.some((e) => e.competitors.some((c) => SOURCE_ONLY.includes(c))));

  check(`[${gap.type}] every entry is lost or partial`,
    ev.every((e) => e.verdict === "lost" || e.verdict === "partial"));

  // derived views
  const evPrompts = Array.from(new Set(ev.map((e) => e.prompt))).sort();
  check(`[${gap.type}] AFFECTED_PROMPTS_DERIVED_FROM_PROMPT_EVIDENCE`,
    [...gap.affectedPrompts].sort().join("|") === evPrompts.join("|"));

  const evCompetitors = Array.from(new Set(ev.flatMap((e) => e.competitors))).sort();
  const explained = evCompetitors.every((n) => gap.explanation.includes(n));
  check(`[${gap.type}] COMPETITORS_HIT_DERIVED_FROM_PROMPT_EVIDENCE`, explained);
  check(`[${gap.type}] explanation names no source-only domain`,
    !SOURCE_ONLY.some((n) => gap.explanation.includes(n)));
  check(`[${gap.type}] explanation names no won-only competitor`,
    !C_COMPETITORS.some((n) => gap.explanation.includes(n)));
}

// Backward compatibility: without evidence the prior behaviour is retained.
{
  const legacy = buildDeterministicPrioritizedGaps(
    { ...input, competitorEvidence: undefined } as RunGapMapInput,
    distances
  );
  check("legacy input still produces gaps", legacy.length > 0);
  check("legacy gaps carry no promptEvidence",
    legacy.every((g) => g.promptEvidence === undefined));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
