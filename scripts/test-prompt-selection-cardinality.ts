#!/usr/bin/env tsx
/**
 * Prompt-selection cardinality regression tests.
 *
 * Pure functions only — no network, Supabase, or LLM calls. Structural
 * assertions read scripts/mvp-scan.ts as TEXT because that script invokes
 * main() at module scope and cannot be imported safely.
 */

delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.LLM_PROVIDER;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
process.env.ZYPACT_MOCK_MODE = "on";

import { readFileSync } from "node:fs";
import type { GeneratedPrompt } from "@/lib/db/types";
import {
  chooseCommercialPromptRows,
  chooseCommercialPromptRowsWithDiagnostics,
  promptOverlapRatio,
  PROMPT_SIMILARITY_THRESHOLD,
} from "@/lib/prompts/commercial-selection";
import {
  describePromptShortfall,
  selectPromptTargets,
} from "@/lib/prompts/select-prompt-targets";
import {
  applyPromptShortfallPolicy,
  PromptShortfallError,
} from "@/lib/prompts/prompt-selection-policy";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`✅ ${name}`);
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Topics chosen so distinct prompts share only the word "best". */
const TOPICS = [
  "alpha analytics workflow",
  "bravo billing reconciliation",
  "charlie deployment pipeline",
  "delta inventory forecasting",
  "echo payroll compliance",
  "foxtrot shipping logistics",
  "golf recruiting onboarding",
  "hotel warehouse robotics",
  "india telemetry dashboards",
  "juliet contract redlining",
  "kilo procurement sourcing",
  "lima translation localisation",
  "mike scheduling rostering",
];

function row(
  id: string,
  text: string,
  priority: number,
  intentType = "manual"
): GeneratedPrompt {
  return {
    id,
    projectId: "test",
    prompt: text,
    intentType,
    commercialValue: 5,
    winnability: 3,
    priority,
    rationale: "",
    selected: true,
    createdAt: new Date(0).toISOString(),
  };
}

/**
 * Build distinct prompts with EXPLICIT priorities. Selection walks candidates
 * in descending priority, so these values fix the processing order that each
 * fixture depends on. No implicit priority is hidden in a shared helper.
 */
function distinctExplicit(priorities: number[], idPrefix: string): GeneratedPrompt[] {
  if (priorities.length > TOPICS.length) {
    throw new Error("fixture requests more distinct topics than are available");
  }
  return priorities.map((priority, i) => row(`${idPrefix}${i}`, `best ${TOPICS[i]}`, priority));
}

/** Near-duplicate of the FIRST distinct topic; priority is set per fixture. */
function nearDuplicateOfFirst(id: string, priority: number): GeneratedPrompt {
  return row(id, "best alpha analytics workflow review", priority);
}

/** Distinct from every topic, but carries the client brand term. */
function brandedRow(id: string, priority: number): GeneratedPrompt {
  return row(id, "best acme zulu escrow settlement", priority);
}

const BRAND_TERMS = ["Acme", "acme.com"];

// ---- exact 0.75 boundary fixture: 6 shared tokens, min set size 8 ----
const BOUNDARY_A = row("bA", "alpha bravo charlie delta echo foxtrot golf hotel", 30);
const BOUNDARY_B = row("bB", "alpha bravo charlie delta echo foxtrot india juliet kilo", 20);
{
  const ratio = promptOverlapRatio(BOUNDARY_A.prompt, BOUNDARY_B.prompt);
  check("threshold constant is 0.75", PROMPT_SIMILARITY_THRESHOLD === 0.75);
  check("boundary fixture overlap is exactly 0.75", Math.abs(ratio - 0.75) < 1e-12, String(ratio));

  const s = selectPromptTargets([BOUNDARY_A, BOUNDARY_B], 2, []);
  check(
    "candidate at exactly 0.75 is rejected (inclusive threshold)",
    s.selected === 1 && s.rejectedAsDuplicate === 1 && s.rows[0]!.id === "bA"
  );
}

// ---- 1. enough distinct candidates return exactly the requested count ----
{
  const s = selectPromptTargets(
    distinctExplicit([100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45], "d"),
    12,
    []
  );
  check("12 distinct candidates return exactly 12", s.selected === 12 && s.reachedTarget, String(s.selected));
  check("no shortfall factors when target reached", s.shortfallFactors.length === 0);
}

// ---- 2. threshold rejection is backfilled when slack exists ----
//
// Processing order by priority:
//   d0(100) … d10(50)  -> 11 selected
//   dupA(47)           -> REJECTED as a duplicate of d0
//   d11(45)            -> backfills the 12th slot
// The duplicate is deliberately ranked ABOVE the final valid candidate, so
// the selector must survive a rejection and keep going to reach 12.
{
  const distinct12 = distinctExplicit([100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45], "d");
  const dupA = nearDuplicateOfFirst("dupA", 47);
  const s = selectPromptTargets([...distinct12, dupA], 12, []);

  check("exactly 12 prompts are selected", s.selected === 12 && s.reachedTarget, String(s.selected));
  check(
    "the duplicate fixture is the rejected prompt",
    s.rejections.length === 1 && s.rejections[0]!.promptId === "dupA",
    s.rejections.map((r) => r.promptId).join(",")
  );
  check(
    "the duplicate was blocked by the first distinct prompt",
    s.rejections[0]?.blockedByPromptId === "d0"
  );
  check(
    "the lower-priority backfill candidate is in the selection",
    s.rows.some((r) => r.id === "d11")
  );
  check("no shortfall factors when backfill succeeds", s.shortfallFactors.length === 0);
}

// ---- 3. similarity-only shortfall (no slack to backfill from) ----
{
  const distinct11 = distinctExplicit([100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50], "d");
  const s = selectPromptTargets([...distinct11, nearDuplicateOfFirst("dupA", 47)], 12, []);
  check("similarity shortfall selects 11 of 12", s.selected === 11 && !s.reachedTarget, String(s.selected));
  check("factor is similarity_rejection only", s.shortfallFactors.join(",") === "similarity_rejection");
  check(
    "the duplicate fixture is the rejected prompt",
    s.rejections.length === 1 && s.rejections[0]!.promptId === "dupA"
  );
}

// ---- 4. brand filtering reduces 12 candidates to 11 ----
{
  const distinct11 = distinctExplicit([100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50], "d");
  const s = selectPromptTargets([...distinct11, brandedRow("brandRow", 48)], 12, BRAND_TERMS);
  check("brand filter reduces 12 to 11", s.selected === 11 && !s.reachedTarget, String(s.selected));
  check("brand removal counted separately", s.removedByBrandFilter === 1);
  check("brand impact measured counterfactually", s.brandFilterImpact === 1);
  check("factor is brand_filter_removal only", s.shortfallFactors.join(",") === "brand_filter_removal");
}

// ---- 5. combined factors: 12 input -> brand 11 -> similarity 10 ----
{
  const distinct10 = distinctExplicit([100, 95, 90, 85, 80, 75, 70, 65, 60, 55], "d");
  const s = selectPromptTargets(
    [...distinct10, brandedRow("brandRow", 52), nearDuplicateOfFirst("dupA", 50)],
    12,
    BRAND_TERMS
  );
  check("combined brand + similarity selects 10", s.selected === 10, String(s.selected));
  check(
    "both factors reported, not collapsed",
    s.shortfallFactors.includes("brand_filter_removal") &&
      s.shortfallFactors.includes("similarity_rejection")
  );
  check("input shortfall not falsely claimed", !s.shortfallFactors.includes("insufficient_input_candidates"));
}

// ---- 5b. counterexample: 13 input -> brand filter 12 -> similarity 11 ----
//
// Processing order by priority:
//   d0(100) … d10(50)  -> 11 selected
//   brandRow(48)       -> REMOVED by the brand filter before selection runs;
//                         in the counterfactual it is selected as the 12th
//   dupA(46)           -> REJECTED as a duplicate of d0
// brandRow is deliberately ranked ABOVE dupA so both mechanisms are
// encountered in the intended order. The filtered pool is 12 — it MET the
// requested count — so a condition keyed on "pool < requested" would miss the
// brand factor entirely. Counterfactual attribution must still report it.
{
  const distinct11 = distinctExplicit([100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50], "d");
  const brandRow = brandedRow("brandRow", 48);
  const dupA = nearDuplicateOfFirst("dupA", 46);
  const s = selectPromptTargets([...distinct11, brandRow, dupA], 12, BRAND_TERMS);

  check("input pool is 13", s.totalPrompts === 13);
  check("brand filter leaves exactly 12 candidates", s.candidatesAfterBrandFilter === 12);
  check("filtered pool met the requested count", s.candidatesAfterBrandFilter >= s.requested);
  check("final selection is 11", s.selected === 11 && !s.reachedTarget, String(s.selected));
  check("brand row was the only brand removal", s.removedByBrandFilter === 1);
  check("brand impact is measured counterfactually as 1", s.brandFilterImpact === 1);
  check(
    "the duplicate fixture is the rejected prompt",
    s.rejections.length === 1 && s.rejections[0]!.promptId === "dupA"
  );
  check(
    "both factors reported even though the pool met the count",
    s.shortfallFactors.includes("brand_filter_removal") &&
      s.shortfallFactors.includes("similarity_rejection")
  );
  check("input shortfall not falsely claimed", !s.shortfallFactors.includes("insufficient_input_candidates"));
}

// ---- 6. input shortfall does not imply brand causality ----
{
  const s = selectPromptTargets(distinctExplicit([100, 95, 90, 85, 80, 75, 70, 65, 60, 55], "d"), 12, []);
  check(
    "factor is insufficient_input_candidates only",
    s.shortfallFactors.join(",") === "insufficient_input_candidates"
  );
  check(
    "brand filter not blamed when it removed nothing",
    s.removedByBrandFilter === 0 && s.brandFilterImpact === 0
  );
}

// ---- 7. selectPromptTargets never throws ----
{
  let threw = false;
  try {
    selectPromptTargets([], 12, BRAND_TERMS);
    selectPromptTargets(distinctExplicit([10], "d"), 12, ["best"]);
  } catch {
    threw = true;
  }
  check("selectPromptTargets never throws", !threw);
}

// ---- 8. shortfall policy: behavioral throw / warn / silent ----
{
  const distinct11 = distinctExplicit([100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50], "d");
  const s = selectPromptTargets([...distinct11, nearDuplicateOfFirst("dupA", 47)], 12, []);
  check("policy fixture is 11 of 12", s.selected === 11 && !s.reachedTarget);

  let threwTyped = false;
  let messageHasCounts = false;
  try {
    applyPromptShortfallPolicy(s, "throw");
  } catch (error) {
    threwTyped = error instanceof PromptShortfallError;
    messageHasCounts = (error as Error).message.includes("11 of 12");
  }
  check("default throw mode throws on 11 of 12", threwTyped);
  check("thrown diagnostic states requested and selected counts", messageHasCounts);

  const warned = applyPromptShortfallPolicy(s, "warn");
  check("warn mode returns 11 rows", warned.rows.length === 11);
  check("warn mode produces a warning", (warned.warning ?? "").includes("--allow-fewer-prompts"));

  const silent = applyPromptShortfallPolicy(s, "silent");
  check(
    "silent mode returns 11 rows without throwing or warning",
    silent.rows.length === 11 && silent.warning === null
  );

  const ok = selectPromptTargets(
    distinctExplicit([100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45], "d"),
    12,
    []
  );
  check("policy is inert when the target is reached", applyPromptShortfallPolicy(ok, "throw").warning === null);
}

// ---- 9. plan vs execution equivalence (replaces a tautological bound) ----
{
  // Same texts, priorities, and brand terms; only the ids differ, exactly as
  // synthetic planning rows differ from stored rows.
  const distinct11 = distinctExplicit([100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50], "d");
  const source = [...distinct11, brandedRow("brandRow", 48), nearDuplicateOfFirst("dupA", 46)];
  const planned = source.map((p, i) => row(`planned-${i}`, p.prompt, p.priority));
  const stored = source.map((p, i) => row(`stored-uuid-${i}`, p.prompt, p.priority));

  const planSel = selectPromptTargets(planned, 12, BRAND_TERMS);
  const execSel = selectPromptTargets(stored, 12, BRAND_TERMS);

  check(
    "plan and execution select the same count",
    planSel.selected === execSel.selected,
    `${planSel.selected} vs ${execSel.selected}`
  );
  check(
    "plan and execution select the same prompts in the same order",
    planSel.rows.map((r) => r.prompt).join("|") === execSel.rows.map((r) => r.prompt).join("|")
  );
  check("plan never claims more than execution", planSel.selected <= execSel.selected);
}

// ---- 10. diagnostics never expose prompt text ----
{
  const distinct11 = distinctExplicit([100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50], "d");
  const rows = [...distinct11, nearDuplicateOfFirst("dupA", 47)];
  const text = describePromptShortfall(selectPromptTargets(rows, 12, []));
  check("shortfall diagnostic exposes no prompt text", !rows.some((p) => text.includes(p.prompt)));
  check("shortfall diagnostic lists contributing factors", text.includes("contributing factors"));
}

// ---- 11. commercial-intent ordering unchanged ----
{
  const rows = [
    row("i1", "best alpha analytics workflow", 1, "best_tools"),
    row("i2", "best bravo billing reconciliation", 2, "alternatives"),
    row("i3", "best charlie deployment pipeline", 3, "comparison"),
    row("m1", "best delta inventory forecasting", 99),
    row("m2", "best echo payroll compliance", 98),
  ];
  const s = selectPromptTargets(rows, 3, []);
  check(
    "required commercial intents seed first despite lower priority",
    s.rows.map((r) => r.id).join(",") === "i1,i2,i3",
    s.rows.map((r) => r.id).join(",")
  );
}

// ---- 12. wrapper equivalence ----
{
  const distinct12 = distinctExplicit([100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 50, 45], "d");
  const rows = [...distinct12, nearDuplicateOfFirst("dupA", 47)];
  const legacy = chooseCommercialPromptRows(rows, 12);
  const diag = chooseCommercialPromptRowsWithDiagnostics(rows, 12);
  check(
    "chooseCommercialPromptRows equals diagnostics rows",
    legacy.length === diag.rows.length && legacy.every((r, i) => r.id === diag.rows[i]!.id)
  );
}

// ---- structural assertions on the runner ----
const script = readFileSync("scripts/mvp-scan.ts", "utf-8");

// The early guard condition spans multiple lines, so assert each required
// clause independently. A single concatenated substring would break on any
// reformatting without the guard itself changing.
check(
  "early budget guard requires a non-blocked plan",
  script.includes("!dry.shortfallBlocksExecution")
);
check(
  "early budget guard requires an exact spend estimate",
  script.includes('dry.spend.kind === "exact"')
);
check(
  "early budget guard compares estimated spend against the budget",
  script.includes("dry.spend.estimatedSpend > args.budgetUsd")
);
check("blocked plan suppresses the early budget decision", script.includes("!dry.shortfallBlocksExecution"));
check(
  "blocked plan prints a not-applicable spend",
  script.includes("not applicable — execution is blocked by prompt shortfall")
);

{
  const guardIdx = script.indexOf("if (exactSpend > args.budgetUsd)");
  const callIdx = script.indexOf("const probeRun = await runMissingProbes(");
  check("exact budget guard marker exists", guardIdx !== -1);
  check("runMissingProbes call-site marker exists", callIdx !== -1);
  check(
    "exact budget guard precedes the probe call site",
    guardIdx !== -1 && callIdx !== -1 && guardIdx < callIdx,
    `guard=${guardIdx} call=${callIdx}`
  );
  check(
    "call-site marker is unique",
    script.split("const probeRun = await runMissingProbes(").length === 2
  );
}

check(
  "plan can report blocked and pending, not just run/skip",
  script.includes('"blocked"') && script.includes('"pending"')
);
check(
  "shortfall without override blocks the probe stage",
  script.includes("shortfallBlocksExecution") && script.includes('? "blocked"')
);
check(
  "unknown selection prints no numeric count",
  script.includes("not yet known — exact selection occurs before probes")
);
check(
  "plan states execution will stop without the override",
  script.includes("execution will stop unless --allow-fewer-prompts is enabled")
);
check("--allow-fewer-prompts is a registered flag", script.includes('"allow-fewer-prompts"'));
check("speculative upper_bound variant is absent", !script.includes("upper_bound"));
check("unused brand-term import removed", !script.includes("promptContainsBrandTerm"));
check(
  "newly-probed counter increments only after a save",
  script.includes("if (savedForPrompt > 0) promptsWithSavedRuns += 1;")
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
