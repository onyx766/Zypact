#!/usr/bin/env tsx
/**
 * Diagnostic competitor evidence regressions.
 *
 * Locks the two properties the Gap Map handoff previously lost: evidence
 * comes only from products actually recommended in scored runs (never from
 * cited source domains), and it stays attached to the prompt that produced
 * it. Pure functions — no database, provider, or network.
 */

import {
  buildPromptCompetitorEvidence,
  buildScorecardCompetitorEvidence,
  evidencedCompetitorKeys,
  isRecoveryEligible,
} from "@/lib/pipeline/scorecard-competitors";
import type { PromptProbeAggregate } from "@/lib/probe-results/report-selection";

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ok   ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}`); }
}

/** Minimal group; only the fields the helper reads are meaningful. */
function group(opts: {
  prompt: string;
  verdict: PromptProbeAggregate["verdict"];
  runs: Array<{ recommended?: Array<{ name: string; position?: number }>; cited?: string[] }>;
}): PromptProbeAggregate {
  return {
    prompt: opts.prompt,
    verdict: opts.verdict,
    runs: opts.runs.length,
    rows: opts.runs.map((r) => ({
      prompt: opts.prompt,
      competitorsMentioned: (r.recommended ?? []).map((c) => ({
        name: c.name,
        position: c.position ?? null,
      })),
      sourcesCited: (r.cited ?? []).map((d) => ({ name: d, url: `https://${d}/x` })),
    })) as PromptProbeAggregate["rows"],
  } as PromptProbeAggregate;
}

const LOST = "How to compare B2B revenue intelligence platforms?";
const PARTIAL = "What are the best B2B marketing attribution tools for measuring campaign effectiveness?";
const WON = "Alternatives to Factors.ai for custom reporting in B2B?";

const lostGroup = group({
  prompt: LOST, verdict: "lost",
  runs: [
    { recommended: [{ name: "Clari", position: 1 }, { name: "Gong", position: 2 }], cited: ["improvado.io"] },
    { recommended: [{ name: "Clari", position: 1 }, { name: "Salesforce Revenue Intelligence", position: 3 }], cited: ["whatagraph.com"] },
    { recommended: [{ name: "Clari", position: 2 }, { name: "Gong", position: 1 }, { name: "People.ai", position: 4 }], cited: ["supermetrics.com"] },
  ],
});

const partialGroup = group({
  prompt: PARTIAL, verdict: "partial",
  runs: [
    { recommended: [{ name: "Dreamdata", position: 1 }], cited: ["improvado.io"] },
    { recommended: [{ name: "Dreamdata", position: 1 }, { name: "Ruler Analytics", position: 2 }], cited: ["whatagraph.com"] },
    { recommended: [{ name: "Ruler Analytics", position: 3 }], cited: ["supermetrics.com"] },
  ],
});

const wonGroup = group({
  prompt: WON, verdict: "won",
  runs: [
    { recommended: [{ name: "Dreamdata", position: 2 }] },
    { recommended: [{ name: "Fibbler", position: 3 }] },
    { recommended: [{ name: "LeadJourney", position: 4 }] },
  ],
});

console.log("test-scorecard-competitors");

// 1 / 3 — recommended products become evidence and aggregate deterministically
{
  const e = buildPromptCompetitorEvidence(lostGroup);
  const clari = e.competitors.find((c) => c.nameKey === "clari");
  check("1 recommended product becomes diagnostic evidence", clari !== undefined);
  check("3 repeated recommendations aggregate across runs", clari?.recommendationCount === 3);
  check("3b run total preserved", clari?.runs === 3);
  check("3c best position is the lowest observed", clari?.bestPosition === 1);
  check("3d evidence source is the recommendation channel",
    clari?.source === "probe_recommended_product");
  check("ordering puts the most-recommended product first",
    e.competitors[0]?.nameKey === "clari");
}

// 2 / 11 — cited source domains never become diagnostic competitors
{
  const e = buildPromptCompetitorEvidence(lostGroup);
  const names = e.competitors.map((c) => c.nameKey);
  for (const cited of ["improvado.io", "whatagraph.com", "supermetrics.com"]) {
    check(`2 cited source "${cited}" is not a diagnostic competitor`, !names.includes(cited));
  }
  check("11 a domain cited in every run still earns no competitor status",
    !names.some((n) => n.includes("supermetrics")));
}

// 4 / 5 / 6 — provenance retained, per prompt
{
  const lost = buildPromptCompetitorEvidence(lostGroup);
  const partial = buildPromptCompetitorEvidence(partialGroup);
  check("4 every record carries its prompt", lost.competitors.every((c) => c.prompt === LOST));
  check("4b every record carries the group outcome",
    lost.competitors.every((c) => c.promptOutcome === "lost"));
  check("5 lost prompt carries only its own competitors",
    lost.competitors.map((c) => c.nameKey).sort().join() ===
      ["clari", "gong", "people.ai", "salesforce revenue intelligence"].sort().join());
  check("6 partial prompt carries only its own competitors",
    partial.competitors.map((c) => c.nameKey).sort().join() ===
      ["dreamdata", "ruler analytics"].sort().join());
}

// 7 — Prompt B's competitors cannot describe Prompt A
{
  const all = buildScorecardCompetitorEvidence([lostGroup, partialGroup, wonGroup]);
  const lost = all.find((g) => g.outcome === "lost");
  const partial = all.find((g) => g.outcome === "partial");
  check("7 no attribution competitor appears under the revenue-intelligence prompt",
    !lost?.competitors.some((c) => ["dreamdata", "ruler analytics"].includes(c.nameKey)));
  check("7b no revenue-intelligence competitor appears under the attribution prompt",
    !partial?.competitors.some((c) => ["clari", "gong", "people.ai"].includes(c.nameKey)));
  check("7c groups stay separate rather than merging", all.length === 3);
}

// 8 — a won prompt is positive evidence, never a recovery gap
{
  check("8 won prompt is not recovery-eligible", isRecoveryEligible("won") === false);
  check("8b lost prompt is recovery-eligible", isRecoveryEligible("lost") === true);
  check("8c partial prompt is recovery-eligible", isRecoveryEligible("partial") === true);
  check("8d not_relevant is not recovery-eligible", isRecoveryEligible("not_relevant") === false);
  const won = buildPromptCompetitorEvidence(wonGroup);
  check("8e won prompt still records context competitors", won.competitors.length === 3);
  check("8f but is marked won so no recovery gap can be built from it",
    won.competitors.every((c) => c.promptOutcome === "won"));
}

// 9 — a project name with no scored recommendation is not evidenced
{
  const keys = evidencedCompetitorKeys(
    buildScorecardCompetitorEvidence([lostGroup, partialGroup, wonGroup])
  );
  for (const projectOnly of ["whatagraph", "supermetrics", "improvado", "dashthis", "cometly"]) {
    check(`9 project-only name "${projectOnly}" is not evidenced by any scored run`,
      !keys.has(projectOnly));
  }
  check("9b genuinely scored products are evidenced",
    keys.has("clari") && keys.has("gong") && keys.has("dreamdata"));
}

// 10 — same product named twice in one run counts once for that run
{
  const dup = group({
    prompt: LOST, verdict: "lost",
    runs: [{ recommended: [{ name: "Clari", position: 1 }, { name: "clari", position: 5 }] }],
  });
  const e = buildPromptCompetitorEvidence(dup);
  check("10 duplicate mention within a run counts once",
    e.competitors[0]?.recommendationCount === 1);
  check("10b but the better position is still kept", e.competitors[0]?.bestPosition === 1);
}

// malformed input must be skipped, not guessed at
{
  const bad = {
    prompt: LOST, verdict: "lost", runs: 1,
    rows: [{ prompt: LOST, competitorsMentioned: [{ position: 2 }, "Clari", null], sourcesCited: null }],
  } as unknown as PromptProbeAggregate;
  check("malformed mentions are skipped without throwing",
    buildPromptCompetitorEvidence(bad).competitors.length === 0);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
