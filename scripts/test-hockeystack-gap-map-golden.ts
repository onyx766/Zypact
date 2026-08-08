#!/usr/bin/env tsx
/**
 * HockeyStack golden regression — the first real post-worker commercial
 * snapshot, replayed from stored evidence.
 *
 * That scan produced correct probe scores but a Gap Map full of reporting
 * vendors and zero prioritized gaps. This fixture reproduces its 15 stored
 * runs and drives the real production path — no provider, no database:
 *
 *   fixture rows -> buildProbeSetSummary -> scorecardPromptGroups
 *                -> buildScorecardCompetitorEvidence
 *                -> computeGapScores -> buildMockGapMap
 *
 * Scoring is untouched; this measures what the existing >= 6 threshold does
 * once competitor provenance is correct.
 */

import { buildProbeSetSummary } from "@/lib/probe-results/report-selection";
import {
  buildScorecardCompetitorEvidence,
  isRecoveryEligible,
  normalizeCompetitorKey,
} from "@/lib/pipeline/scorecard-competitors";
import { computeGapScores } from "@/lib/gap-map/compute-gap-scores";
import { buildMockGapMap } from "@/lib/agents/gap-map";
import type { RunGapMapInput } from "@/lib/agents/gap-map";
import type { Competitor, ProbeResult } from "@/lib/db/types";

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ok   ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}`); }
}

const PROJECT = "f6289780-b502-4e04-b67b-bd2e88733c38";

const P_LOST_MANUAL = "How to switch from manual reporting to automated marketing insights?";
const P_LOST_MIGRATE = "How to migrate from traditional marketing analytics to AI solutions?";
const P_LOST_REVINT = "How to compare B2B revenue intelligence platforms?";
const P_WON_FACTORS = "Alternatives to Factors.ai for custom reporting in B2B?";
const P_PARTIAL_ATTR = "What are the best B2B marketing attribution tools for measuring campaign effectiveness?";

const REVINT = ["Clari", "Gong", "Salesforce Revenue Intelligence", "People.ai"];
const ATTR = ["Dreamdata", "Ruler Analytics", "Adobe Marketo Measure"];
const WON_PRODUCTS = ["Dreamdata", "Ruler Analytics", "LeadJourney", "Fibbler"];
/** Cited in answers; never recommended as products. */
const SOURCE_ONLY = ["Improvado", "Whatagraph", "Supermetrics", "Cometly"];

let seq = 0;
function run(opts: {
  prompt: string;
  promptId: string;
  clientPosition: "absent" | "listed" | "primary";
  citedAsSource: boolean;
  competitors: string[];
  sources: string[];
}): ProbeResult {
  seq += 1;
  return {
    id: `probe-${seq}`,
    probeRunId: "run-1",
    projectId: PROJECT,
    generatedPromptId: opts.promptId,
    prompt: opts.prompt,
    platform: "perplexity",
    probeMode: "live_perplexity",
    rawResponse: "stored",
    productPosition: opts.clientPosition,
    citedAsSource: opts.citedAsSource,
    clientMentioned: opts.clientPosition !== "absent",
    clientPosition: opts.clientPosition,
    competitorsMentioned: opts.competitors.map((name, i) => ({ name, position: i + 1 })),
    sourcesCited: opts.sources.map((name) => ({
      name, url: `https://${name.toLowerCase()}.com/x`, type: "vendor_site",
    })),
    answerSummary: "stored",
    verdict: opts.clientPosition === "absent" ? "lost" : "partial",
    whyClientLost: "stored",
    createdAt: `2026-08-01T00:00:${String(seq).padStart(2, "0")}Z`,
  } as ProbeResult;
}

/** The 15 stored runs, 3 per prompt group. */
const probeResults: ProbeResult[] = [
  // LOST 1 — generic how-to; stored runs named no products.
  ...[0, 1, 2].map(() => run({
    prompt: P_LOST_MANUAL, promptId: "p1", clientPosition: "absent",
    citedAsSource: false, competitors: [], sources: [SOURCE_ONLY[0], SOURCE_ONLY[1]],
  })),
  // LOST 2 — generic migration; stored runs named no products.
  ...[0, 1, 2].map(() => run({
    prompt: P_LOST_MIGRATE, promptId: "p2", clientPosition: "absent",
    citedAsSource: false, competitors: [], sources: [SOURCE_ONLY[2]],
  })),
  // LOST 3 — revenue intelligence; a real shortlist, client absent.
  run({ prompt: P_LOST_REVINT, promptId: "p3", clientPosition: "absent", citedAsSource: false,
        competitors: ["Clari", "Gong"], sources: [SOURCE_ONLY[3]] }),
  run({ prompt: P_LOST_REVINT, promptId: "p3", clientPosition: "absent", citedAsSource: false,
        competitors: ["Clari", "Salesforce Revenue Intelligence"], sources: [SOURCE_ONLY[0]] }),
  run({ prompt: P_LOST_REVINT, promptId: "p3", clientPosition: "absent", citedAsSource: false,
        competitors: ["Clari", "Gong", "People.ai"], sources: [SOURCE_ONLY[1]] }),
  // WON — client is the primary recommendation in all three runs.
  ...[0, 1, 2].map(() => run({
    prompt: P_WON_FACTORS, promptId: "p4", clientPosition: "primary",
    citedAsSource: false, competitors: WON_PRODUCTS, sources: [],
  })),
  // PARTIAL — client listed but not primary, and cited, in all three runs.
  ...[0, 1, 2].map(() => run({
    prompt: P_PARTIAL_ATTR, promptId: "p5", clientPosition: "listed",
    citedAsSource: true, competitors: ATTR, sources: [SOURCE_ONLY[2], SOURCE_ONLY[3]],
  })),
];

const mirrorProfile = {
  companyName: "HockeyStack", website: "hockeystack.com",
  detectedCategory: "B2B marketing attribution",
  // Fields the deterministic scorer reads; empty mirrors a thin site profile.
  missingSignals: [],
  proofSignals: [],
} as unknown as RunGapMapInput["mirrorProfile"];

console.log("test-hockeystack-gap-map-golden");

const summary = buildProbeSetSummary(probeResults, null, {
  brandTerms: ["HockeyStack", "hockeystack.com"],
});
const groups = summary.scorecardPromptGroups;

// ---------- Gate 1: historical scorecard must be exact ----------
console.log("\n [Gate 1 — historical scorecard]");
const totalRuns = groups.reduce((n, g) => n + g.runs, 0);
const recommended = groups.reduce((n, g) => n + g.productMentionedRuns, 0);
const cited = groups.reduce((n, g) => n + g.citedAsSourceRuns, 0);
const won = groups.filter((g) => g.verdict === "won").length;
const partial = groups.filter((g) => g.verdict === "partial").length;
const lost = groups.filter((g) => g.verdict === "lost").length;

console.log(`    runs=${totalRuns} recommended=${recommended} cited=${cited} won=${won} partial=${partial} lost=${lost}`);
check("TOTAL_RUNS=15", totalRuns === 15);
check("RECOMMENDED_COUNT=6 (40%)", recommended === 6);
check("CITED_COUNT=3 (20%)", cited === 3);
check("WON_PROMPTS=1", won === 1);
check("PARTIAL_PROMPTS=1", partial === 1);
check("LOST_PROMPTS=3", lost === 3);

if (failures > 0) {
  console.error("\nScorecard gate failed — not proceeding to Gap Map.");
  process.exit(1);
}

// ---------- Gate 2: prompt-scoped diagnostic competitor evidence ----------
console.log("\n [Gate 2 — diagnostic competitor evidence]");
const evidence = buildScorecardCompetitorEvidence(groups);
for (const e of evidence) {
  console.log(`    [${e.outcome}] ${e.prompt.slice(0, 52)}… -> ${e.competitors.map((c) => `${c.name}(${c.recommendationCount}/${c.runs})`).join(", ") || "(none)"}`);
}
const revint = evidence.find((e) => e.prompt === P_LOST_REVINT);
const attr = evidence.find((e) => e.prompt === P_PARTIAL_ATTR);
const wonEv = evidence.find((e) => e.prompt === P_WON_FACTORS);

check("REVENUE_INTELLIGENCE_COMPETITOR_COUNT_GT_ZERO", (revint?.competitors.length ?? 0) > 0);
check("ATTRIBUTION_COMPETITOR_COUNT_GT_ZERO", (attr?.competitors.length ?? 0) > 0);
check("revenue-intelligence set holds its real products",
  REVINT.every((n) => revint?.competitors.some((c) => c.name === n)));
check("attribution set holds its real products",
  ATTR.every((n) => attr?.competitors.some((c) => c.name === n)));
check("COMPETITOR_SETS_DISTINCT",
  !revint?.competitors.some((c) => attr?.competitors.some((d) => d.nameKey === c.nameKey)));
check("won prompt is not recovery-eligible", !isRecoveryEligible(wonEv?.outcome ?? "won"));
check("SOURCE_ONLY_DOMAIN_AS_DIAGNOSTIC_COMPETITOR=NO",
  !evidence.some((e) => e.competitors.some((c) => SOURCE_ONLY.includes(c.name))));

// ---------- Gate 3: real deterministic Gap Map ----------
console.log("\n [Gate 3 — real deterministic Gap Map, scoring untouched]");
const recoveryEvidence = evidence.filter((e) => isRecoveryEligible(e.outcome));
const evidencedKeys = new Set(
  recoveryEvidence.flatMap((e) => e.competitors.map((c) => c.nameKey))
);
const competitors: Competitor[] = Array.from(evidencedKeys).map((key) => {
  const strongest = recoveryEvidence
    .flatMap((e) => e.competitors)
    .filter((c) => c.nameKey === key)
    .reduce((best, c) => (c.recommendationCount > best.recommendationCount ? c : best));
  return {
    id: `scorecard:${key}`, projectId: PROJECT, name: strongest.name, website: null,
    discoverySource: "ai_answer", mentionCount: strongest.recommendationCount, promptIds: [],
    threatLevel: "medium", confidence: "unverified", isPhantom: false, isBlindSpot: false,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  };
});
console.log(`    gap map competitor input: ${competitors.map((c) => c.name).join(", ")}`);
check("no source-only domain entered the Gap Map competitor input",
  !competitors.some((c) => SOURCE_ONLY.includes(c.name)));

const input = {
  mirrorProfile, probeResults, competitors, competitorEvidence: evidence,
} as unknown as RunGapMapInput;

const baseline = computeGapScores({ mirrorProfile, probeResults, competitors } as never);
console.log("\n    dimension scores per competitor:");
for (const c of competitors) {
  const s = baseline[c.name];
  if (!s) { console.log(`      ${c.name}: (no baseline)`); continue; }
  const dims = Object.entries(s).map(([k, v]) => `${k}=${v}`).join(" ");
  const over = Object.entries(s).filter(([, v]) => (v as number) >= 6).map(([k]) => k);
  console.log(`      ${c.name.padEnd(34)} ${dims}`);
  console.log(`      ${" ".repeat(34)} dimensions_at_or_above_6=[${over.join(", ") || "none"}]`);
}

const output = buildMockGapMap(input, baseline);
const gaps = output.prioritizedGaps;

console.log(`\n    HOCKEYSTACK_PRIORITIZED_GAPS_AFTER=${gaps.length}`);
for (const g of gaps) {
  console.log(`      dimension=${g.type} severity=${g.severity}`);
  for (const e of g.promptEvidence ?? []) {
    console.log(`        prompt=${e.prompt.slice(0, 56)}… verdict=${e.verdict} competitors=[${e.competitors.join(", ")}]`);
  }
  console.log(`        affectedPrompts=${JSON.stringify(g.affectedPrompts)}`);
}

// provenance assertions on whatever was produced
const allEvidence = gaps.flatMap((g) => g.promptEvidence ?? []);
check("HOCKEYSTACK_WON_PROMPT_IN_RECOVERY_EVIDENCE=NO",
  !allEvidence.some((e) => e.prompt === P_WON_FACTORS));
check("HOCKEYSTACK_SOURCE_DOMAIN_IN_RECOVERY_EVIDENCE=NO",
  !allEvidence.some((e) => e.competitors.some((c) => SOURCE_ONLY.includes(c))));
check("HOCKEYSTACK_CROSS_PROMPT_LEAKAGE=NO",
  allEvidence.every((e) => {
    const own = e.prompt === P_LOST_REVINT ? REVINT
      : e.prompt === P_PARTIAL_ATTR ? ATTR : [];
    return e.competitors.every((c) => own.some((n) => normalizeCompetitorKey(n) === normalizeCompetitorKey(c)));
  }));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
