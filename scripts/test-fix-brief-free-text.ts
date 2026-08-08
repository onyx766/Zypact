#!/usr/bin/env tsx
/**
 * Generated free-text grounding regressions.
 *
 * PR #24 made `lostPrompt`, `competitorRecommended` and `rootCause`
 * deterministic. `recommendedFix` and `expectedImpact` stayed raw model
 * prose, so a brief could still name a competitor evidenced for a different
 * buyer question, promise a number nothing measured, or assert why an AI
 * system made a recommendation. These lock all three shut.
 *
 * Pure functions — no database, provider, or network.
 */

import {
  assertsAiCausalClaim,
  foreignCompetitorsMentioned,
  hasUnsupportedQuantifiedClaim,
  validateFixBriefGeneratedFields,
} from "@/lib/pipeline/fix-brief-grounding";
import { buildValidatedFixBriefSchema } from "@/lib/agents/fix-agent";
import type { FixBriefGroundingContext } from "@/lib/pipeline/fix-brief-grounding";

let failures = 0;
function check(label: string, condition: boolean): void {
  if (condition) console.log(`  ok   ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}`); }
}

/** The revenue-intelligence question licenses these. */
const ALLOWED = ["Clari", "Gong", "Salesforce Revenue Intelligence", "People.ai"];
/** Everything the gap knows about, across both questions. */
const KNOWN = [
  ...ALLOWED,
  "Dreamdata", "Ruler Analytics", "Adobe Marketo Measure", "SegmentStream", "Fibbler",
];
const FOREIGN = ["Dreamdata", "Ruler Analytics", "Adobe Marketo Measure", "SegmentStream", "Fibbler"];

function validate(recommendedFix: string, expectedImpact = "Creates a clearer comparison surface.") {
  return validateFixBriefGeneratedFields({
    recommendedFix, expectedImpact, allowedCompetitors: ALLOWED, knownCompetitors: KNOWN,
  });
}
function validateImpact(expectedImpact: string) {
  return validateFixBriefGeneratedFields({
    recommendedFix: "Create a comparison asset for this buyer question.",
    expectedImpact, allowedCompetitors: ALLOWED, knownCompetitors: KNOWN,
  });
}
const kinds = (issues: ReturnType<typeof validate>) => issues.map((i) => i.kind);

console.log("test-fix-brief-free-text");

// 1 — the production defect: a foreign competitor in recommendedFix
{
  const issues = validate("Build a comparison page against Dreamdata and Ruler Analytics.");
  check("1 foreign competitor in recommendedFix is rejected",
    kinds(issues).includes("foreign_competitor"));
  check("1b the offending field is named", issues.some((i) => i.field === "recommendedFix"));
  check("1c the offending competitor is named",
    issues.some((i) => i.detail.includes("Dreamdata")));
}

// 2 — and in expectedImpact
{
  const issues = validateImpact("Dreamdata will stop outranking the brand.");
  check("2 foreign competitor in expectedImpact is rejected",
    issues.some((i) => i.field === "expectedImpact" && i.kind === "foreign_competitor"));
}

// 3 — every foreign competitor is caught individually, in both fields
{
  for (const name of FOREIGN) {
    check(`3 "${name}" rejected in recommendedFix`,
      validate(`Create a comparison page against ${name}.`).some(
        (i) => i.kind === "foreign_competitor"));
    check(`3b "${name}" rejected in expectedImpact`,
      validateImpact(`The brand will be considered alongside ${name}.`).some(
        (i) => i.kind === "foreign_competitor"));
  }
}

// 4 — allowed competitors are NOT false positives
{
  for (const name of ALLOWED) {
    check(`4 allowed competitor "${name}" passes`,
      !validate(`Create a comparison page covering ${name}.`).some(
        (i) => i.kind === "foreign_competitor"));
  }
}

// 5 — substring safety. "Salesforce" alone must not trip the longer known
// name, and a longer name must not be missed because a prefix is allowed.
{
  check("5 bare 'Salesforce' does not match 'Salesforce Revenue Intelligence'",
    foreignCompetitorsMentioned("Compare against Salesforce.", ALLOWED, KNOWN).length === 0);
  check("5b 'Adobe Marketo Measure' is caught in full",
    foreignCompetitorsMentioned("Compare against Adobe Marketo Measure.", ALLOWED, KNOWN)
      .includes("Adobe Marketo Measure"));
  check("5c 'People.ai' survives its punctuation as allowed",
    foreignCompetitorsMentioned("Mention People.ai here.", ALLOWED, KNOWN).length === 0);
  check("5d case and spacing are normalized",
    foreignCompetitorsMentioned("beat   RULER   analytics today", ALLOWED, KNOWN)
      .includes("Ruler Analytics"));
  check("5e a competitor named inside a longer word is not matched",
    foreignCompetitorsMentioned("Use Fibblerish tooling.", ALLOWED, KNOWN).length === 0);
}

// 6 — unsupported quantified outcome claims, both fields
{
  for (const bad of [
    "Increase AI visibility by 20%.",
    "Gain 3 ranking positions.",
    "Drive 25% more revenue.",
    "Reach 50% recommendation share in 30 days.",
  ]) {
    check(`6 quantified claim rejected in recommendedFix: "${bad.slice(0, 30)}…"`,
      validate(bad).some((i) => i.kind === "unsupported_quantified_claim"));
    check(`6b quantified claim rejected in expectedImpact: "${bad.slice(0, 30)}…"`,
      validateImpact(bad).some((i) => i.kind === "unsupported_quantified_claim"));
  }
}

// 7 — implementation counts are NOT outcome claims
{
  for (const good of [
    "Add three clearly labeled comparison sections.",
    "Add 3 comparison sections and a pricing table.",
    "Cover the 4 evaluation criteria buyers ask about.",
  ]) {
    check(`7 implementation count allowed: "${good.slice(0, 34)}…"`,
      !validate(good).some((i) => i.kind === "unsupported_quantified_claim"));
  }
}

// 8 — unsupported AI causal attribution, both fields
{
  for (const bad of [
    "AI could not find relevant content for the brand.",
    "AI ignored the brand because it lacks comparison pages.",
    "This will make AI trust the brand.",
    "Clari wins because AI considers it more authoritative.",
    "The assistant had no basis to recommend the brand.",
    "AI did not trust the brand's positioning.",
    "AI recommends competitors because the category page is thin.",
  ]) {
    check(`8 causal claim rejected in recommendedFix: "${bad.slice(0, 32)}…"`,
      validate(bad).some((i) => i.kind === "unsupported_causal_claim"));
    check(`8b causal claim rejected in expectedImpact: "${bad.slice(0, 32)}…"`,
      validateImpact(bad).some((i) => i.kind === "unsupported_causal_claim"));
  }
}

// 9 — legitimate action and qualitative impact text passes cleanly
{
  for (const good of [
    "Create an evidence-backed comparison page for the selected revenue-intelligence buyer question.",
    "Publish a comparison asset for this buyer question and re-test it in future visibility runs.",
    "Document how the product handles the evaluation criteria named in the question.",
  ]) {
    check(`9 valid recommendedFix passes: "${good.slice(0, 40)}…"`, validate(good).length === 0);
  }
  for (const good of [
    "Gives future visibility runs a clearer comparison surface to re-test.",
    "Creates an evidence surface for this buyer question that can be measured later.",
  ]) {
    check(`9b valid expectedImpact passes: "${good.slice(0, 40)}…"`,
      validateImpact(good).length === 0);
  }
}

// 10 — a "because" that is not an AI causal claim is not blocked
{
  check("10 non-AI 'because' is allowed",
    !assertsAiCausalClaim("Buyers shortlist tools because they compare pricing openly."));
  check("10b plain observation is allowed",
    !assertsAiCausalClaim("The brand was not recommended in the stored runs for this question."));
}

// 11 — several violations in one field are all reported
{
  const issues = validate(
    "Build a page against Dreamdata to increase visibility by 20% because AI could not find the brand."
  );
  check("11 all three violation kinds reported together",
    ["foreign_competitor", "unsupported_quantified_claim", "unsupported_causal_claim"]
      .every((k) => kinds(issues).includes(k as never)));
}

// 12 — clean output produces no issues at all
{
  check("12 fully grounded output validates clean",
    validateFixBriefGeneratedFields({
      recommendedFix: "Create an evidence-backed comparison page covering Clari and Gong.",
      expectedImpact: "Gives future runs a clearer comparison surface to re-test.",
      allowedCompetitors: ALLOWED, knownCompetitors: KNOWN,
    }).length === 0);
}

// 13 — the shared quantitative predicate is the one both fields use
{
  check("13 predicate rejects an outcome percentage",
    hasUnsupportedQuantifiedClaim("Improve share by 15%"));
  check("13b predicate allows a plain count", !hasUnsupportedQuantifiedClaim("Add 3 sections"));
}

// 14 — the agent's schema is what carries the rules into the retry path.
// A violation must make the parse fail, which is how the existing single
// repair attempt fires and how a still-invalid retry fails closed.
{
  const context = {
    gapId: "g", gapType: "prompt_loss", severity: "high",
    suggestedFixDirection: "d", selectedPrompt: "p", selectedVerdict: "lost",
    promptLocalCompetitors: ALLOWED, probeResultId: "r",
    groundedExplanation: "e", knownCompetitors: KNOWN,
  } as FixBriefGroundingContext;
  const schema = buildValidatedFixBriefSchema(context);
  const base = {
    lostPrompt: "p", competitorRecommended: "Clari", rootCause: "Observed: x.",
    fixType: "comparison_page", assetsToGenerate: ["comparison_page_outline"],
    evidenceNeeded: [], evidenceAvailable: ["a"], priority: 1,
  };
  const bad = schema.safeParse({
    ...base,
    recommendedFix: "Build a page against Dreamdata.",
    expectedImpact: "Lifts visibility by 20%.",
  });
  check("14 schema rejects ungrounded generated prose", !bad.success);
  check("14b rejection reaches the retry path as a parse failure",
    !bad.success && bad.error.issues.length > 0);

  const good = schema.safeParse({
    ...base,
    recommendedFix: "Create an evidence-backed comparison page covering Clari and Gong.",
    expectedImpact: "Gives future runs a clearer comparison surface to re-test.",
  });
  check("14c schema accepts grounded output", good.success);
}

// 15 — the nine bypasses the independent review of PR #25 proved. These are
// normal customer-facing sentences, not adversarial constructions: the first
// pattern set only recognised a literal "because" bound to a fixed verb list.
// Checked against BOTH generated fields.
{
  const REVIEW_BYPASSES = [
    "AI favors Dreamdata due to stronger content.",
    "AI favors Clari due to stronger comparison content.",
    "The model prefers Gong since it has stronger authority signals.",
    "HockeyStack is overlooked because its site does not explain revenue intelligence clearly.",
    "AI is choosing competitors as HockeyStack lacks enough proof.",
    "Because HockeyStack has limited comparison content, AI recommends alternatives.",
    "The lack of third-party proof is why HockeyStack isn't recommended.",
    "Adding this page will cause AI systems to recommend HockeyStack.",
    "AI assistants should start trusting HockeyStack once this content exists.",
  ];
  for (const bad of REVIEW_BYPASSES) {
    check(`15 causal bypass closed (predicate): "${bad.slice(0, 38)}…"`,
      assertsAiCausalClaim(bad));
    check(`15b rejected in recommendedFix: "${bad.slice(0, 30)}…"`,
      validate(bad).some((i) => i.kind === "unsupported_causal_claim"));
    check(`15c rejected in expectedImpact: "${bad.slice(0, 30)}…"`,
      validateImpact(bad).some((i) => i.kind === "unsupported_causal_claim"));
  }
}

// 16 — word-form multipliers, both fields
{
  for (const bad of [
    "Double AI visibility.",
    "Triple the mention rate.",
    "Halve the gap in citations.",
    "Quadruple recommendation share.",
  ]) {
    check(`16 multiplier rejected in recommendedFix: "${bad}"`,
      validate(bad).some((i) => i.kind === "unsupported_quantified_claim"));
    check(`16b multiplier rejected in expectedImpact: "${bad}"`,
      validateImpact(bad).some((i) => i.kind === "unsupported_quantified_claim"));
  }
  // Implementation usage of the same words must survive.
  for (const good of ["Double-check the comparison table.", "Use a two-column layout."]) {
    check(`16c implementation usage allowed: "${good}"`,
      !validate(good).some((i) => i.kind === "unsupported_quantified_claim"));
  }
}

// 17 — broadened causal patterns must not swallow non-AI causal prose
{
  for (const good of [
    "Create a page because the sales team needs one.",
    "Document the evaluation criteria buyers ask about.",
    "Publish a comparison asset and re-test it in future visibility runs.",
  ]) {
    check(`17 non-AI causal prose allowed: "${good.slice(0, 40)}…"`,
      validate(good).length === 0);
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
