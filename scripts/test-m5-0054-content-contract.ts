#!/usr/bin/env tsx
/**
 * M5 — content-contract test for D-028's Zod schemas
 * (lib/schemas/probe-analysis-m5.schema.ts). No database, no Docker, no
 * staging/Production — pure in-process Zod validation, positive and
 * negative cases, mirroring persist_probe_result_for_job's own SQL-side
 * validation (migration 0054) so both layers agree on what "valid
 * content" means.
 */

import {
  ProbeAnalysisM5OutputSchema,
  PersistProbeResultForJobContentSchema,
} from "@/lib/schemas/probe-analysis-m5.schema";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function validBaseContent() {
  return {
    productMentioned: true,
    productPosition: "primary" as const,
    competitorsMentioned: [{ name: "Acme", position: 1, context: "listed first" }],
    sourcesCited: [{ source: "acme-reviews.com", type: "review_site" as const }],
    answerSummary: "Acme is recommended as the top choice.",
    citedAsSource: false,
    clientSourceCount: 0,
    platformsReferenced: [] as string[],
    negativeClaimDetected: false,
  };
}

function main(): void {
  console.log("=== M5 0054 — content contract (Zod schemas, no database) ===\n");

  // ------------------------------------------------------------------
  // [1] ProbeAnalysisM5OutputSchema — the LLM's own output shape. No
  //     verdict, no whyClientLost, no clientMentioned: those are never
  //     asked of the model.
  // ------------------------------------------------------------------
  console.log("[1] ProbeAnalysisM5OutputSchema — LLM output shape, no legacy verdict fields");

  const validLlmOutput = {
    clientPosition: "listed",
    competitorsMentioned: [{ name: "Rival", position: 1, context: "top pick" }],
    sourcesCited: [{ source: "example.com", type: "blog" }],
    answerSummary: "A short summary.",
  };
  check("valid LLM output parses", ProbeAnalysisM5OutputSchema.safeParse(validLlmOutput).success);
  check(
    "a 'verdict' key is silently ignored, never required (schema has no such field)",
    !("verdict" in ProbeAnalysisM5OutputSchema.shape)
  );
  check(
    "clientPosition rejects a value outside primary/listed/negative/absent",
    !ProbeAnalysisM5OutputSchema.safeParse({ ...validLlmOutput, clientPosition: "won" }).success
  );
  check(
    "competitorsMentioned rejects position < 1",
    !ProbeAnalysisM5OutputSchema.safeParse({
      ...validLlmOutput,
      competitorsMentioned: [{ name: "Rival", position: 0, context: "x" }],
    }).success
  );
  check(
    "competitorsMentioned caps at 50 elements",
    !ProbeAnalysisM5OutputSchema.safeParse({
      ...validLlmOutput,
      competitorsMentioned: Array.from({ length: 51 }, (_, i) => ({ name: `C${i}`, position: i + 1, context: "" })),
    }).success
  );
  check(
    "answerSummary caps at 4000 characters",
    !ProbeAnalysisM5OutputSchema.safeParse({ ...validLlmOutput, answerSummary: "x".repeat(4001) }).success
  );

  // ------------------------------------------------------------------
  // [2] PersistProbeResultForJobContentSchema — the full nine-key shape,
  //     client-side defense in depth mirroring the RPC's own validation.
  // ------------------------------------------------------------------
  console.log("\n[2] PersistProbeResultForJobContentSchema — nine keys, exact, strict, cross-invariants");

  check("a fully valid content object parses", PersistProbeResultForJobContentSchema.safeParse(validBaseContent()).success);

  check(
    "an extra, unrecognized key is rejected (.strict())",
    !PersistProbeResultForJobContentSchema.safeParse({ ...validBaseContent(), extraKey: "nope" }).success
  );
  check(
    "a missing required key is rejected",
    (() => {
      const { answerSummary: _drop, ...rest } = validBaseContent();
      return !PersistProbeResultForJobContentSchema.safeParse(rest).success;
    })()
  );
  check(
    "an explicit JSON null on a required key is rejected, not silently coerced",
    !PersistProbeResultForJobContentSchema.safeParse({ ...validBaseContent(), answerSummary: null }).success
  );

  // Cross invariants — each mirrors persist_probe_result_for_job's own
  // four INVALID_CONTENT_INVARIANT checks (migration 0054).
  check(
    "invariant: productPosition='absent' requires productMentioned=false",
    !PersistProbeResultForJobContentSchema.safeParse({
      ...validBaseContent(),
      productPosition: "absent",
      productMentioned: true,
    }).success
  );
  check(
    "invariant: productPosition in {primary,listed,negative} requires productMentioned=true",
    !PersistProbeResultForJobContentSchema.safeParse({
      ...validBaseContent(),
      productPosition: "listed",
      productMentioned: false,
    }).success
  );
  check(
    "invariant: negativeClaimDetected must equal (productPosition === 'negative')",
    !PersistProbeResultForJobContentSchema.safeParse({
      ...validBaseContent(),
      productPosition: "negative",
      productMentioned: true,
      negativeClaimDetected: false,
    }).success
  );
  check(
    "invariant: negativeClaimDetected=true is rejected when productPosition is not 'negative'",
    !PersistProbeResultForJobContentSchema.safeParse({ ...validBaseContent(), negativeClaimDetected: true }).success
  );
  check(
    "invariant: citedAsSource must equal (clientSourceCount > 0)",
    !PersistProbeResultForJobContentSchema.safeParse({
      ...validBaseContent(),
      citedAsSource: true,
      clientSourceCount: 0,
    }).success
  );
  check(
    "invariant: every platformsReferenced entry must correspond to a sourcesCited entry",
    !PersistProbeResultForJobContentSchema.safeParse({
      ...validBaseContent(),
      platformsReferenced: ["unrelated-platform"],
    }).success
  );
  check(
    "a platformsReferenced entry that DOES match a sourcesCited entry (case-insensitive substring) is accepted",
    PersistProbeResultForJobContentSchema.safeParse({
      ...validBaseContent(),
      sourcesCited: [{ source: "Acme-Reviews.com", type: "review_site" }],
      platformsReferenced: ["acme-reviews"],
    }).success
  );

  // Bounds mirroring the RPC's own INVALID_CONTENT_VALUE checks.
  check(
    "clientSourceCount rejects a negative value",
    !PersistProbeResultForJobContentSchema.safeParse({ ...validBaseContent(), clientSourceCount: -1 }).success
  );
  check(
    "clientSourceCount caps at 50",
    !PersistProbeResultForJobContentSchema.safeParse({
      ...validBaseContent(),
      clientSourceCount: 51,
      citedAsSource: true,
    }).success
  );

  // DEFECT_01 corrective tests: 1.5 (fractional), -1 (negative, already
  // covered above), 2147483648 (int4-overflow boundary + 1), and the
  // valid maximum (50) -- proving the fix rejects each invalid case
  // cleanly (INVALID_CONTENT_VALUE on the SQL side, a Zod parse failure
  // here) and accepts the true boundary.
  check(
    "DEFECT_01: clientSourceCount=1.5 (fractional) is rejected, never silently truncated",
    !PersistProbeResultForJobContentSchema.safeParse({ ...validBaseContent(), clientSourceCount: 1.5 }).success
  );
  check(
    "DEFECT_01: clientSourceCount=2147483648 (int4-overflow boundary + 1) is rejected",
    !PersistProbeResultForJobContentSchema.safeParse({
      ...validBaseContent(),
      clientSourceCount: 2147483648,
      citedAsSource: true,
    }).success
  );
  check(
    "DEFECT_01: clientSourceCount=50 (the true valid maximum) is accepted",
    PersistProbeResultForJobContentSchema.safeParse({
      ...validBaseContent(),
      clientSourceCount: 50,
      citedAsSource: true,
    }).success
  );

  // DEFECT_03 corrective tests: the identical discipline for
  // competitorsMentioned[].position (range 1-500, integer only).
  check(
    "DEFECT_03: competitors_mentioned[].position=1.5 (fractional) is rejected",
    !PersistProbeResultForJobContentSchema.safeParse({
      ...validBaseContent(),
      competitorsMentioned: [{ name: "Acme", position: 1.5, context: "" }],
    }).success
  );
  check(
    "DEFECT_03: competitors_mentioned[].position=-1 (negative) is rejected",
    !PersistProbeResultForJobContentSchema.safeParse({
      ...validBaseContent(),
      competitorsMentioned: [{ name: "Acme", position: -1, context: "" }],
    }).success
  );
  check(
    "DEFECT_03: competitors_mentioned[].position=501 (out of range) is rejected",
    !PersistProbeResultForJobContentSchema.safeParse({
      ...validBaseContent(),
      competitorsMentioned: [{ name: "Acme", position: 501, context: "" }],
    }).success
  );
  check(
    "DEFECT_03: competitors_mentioned[].position=500 (the true valid maximum) is accepted",
    PersistProbeResultForJobContentSchema.safeParse({
      ...validBaseContent(),
      competitorsMentioned: [{ name: "Acme", position: 500, context: "" }],
    }).success
  );

  check(
    "competitorsMentioned element name caps at 200 characters",
    !PersistProbeResultForJobContentSchema.safeParse({
      ...validBaseContent(),
      competitorsMentioned: [{ name: "x".repeat(201), position: 1, context: "" }],
    }).success
  );
  check(
    "competitorsMentioned element rejects an unrecognized extra key (exact structure)",
    !PersistProbeResultForJobContentSchema.safeParse({
      ...validBaseContent(),
      competitorsMentioned: [{ name: "Acme", position: 1, context: "x", extra: "nope" }],
    }).success
  );
  check(
    "sourcesCited element type is bounded to the six known values",
    !PersistProbeResultForJobContentSchema.safeParse({
      ...validBaseContent(),
      sourcesCited: [{ source: "x.com", type: "social_media" }],
    }).success
  );
  check(
    "platformsReferenced caps at 20 elements",
    !PersistProbeResultForJobContentSchema.safeParse({
      ...validBaseContent(),
      sourcesCited: Array.from({ length: 21 }, (_, i) => ({ source: `platform${i}.com`, type: "other" as const })),
      platformsReferenced: Array.from({ length: 21 }, (_, i) => `platform${i}`),
    }).success
  );
  check(
    "answerSummary caps at 4000 characters",
    !PersistProbeResultForJobContentSchema.safeParse({ ...validBaseContent(), answerSummary: "x".repeat(4001) }).success
  );

  // ------------------------------------------------------------------
  // [3] Never a won/partial/lost value anywhere reachable through this
  //     schema — the whole point of keeping it separate from
  //     ProbeAnalysisOutputSchema/Verdict.
  // ------------------------------------------------------------------
  console.log("\n[3] no won/partial/lost vocabulary reachable through the M5 content schema");

  const shapeKeys = Object.keys(validBaseContent());
  check(
    "the documented content shape has exactly the nine keys, no 'verdict' key",
    shapeKeys.length === 9 && !shapeKeys.includes("verdict") && !shapeKeys.includes("whyClientLost")
  );
  check(
    "a 'verdict' key present alongside valid content is rejected as an unrecognized extra key",
    !PersistProbeResultForJobContentSchema.safeParse({ ...validBaseContent(), verdict: "won" }).success
  );
  check(
    "no schema field accepts the literal 'won'/'partial'/'lost' as a valid value",
    !PersistProbeResultForJobContentSchema.safeParse({ ...validBaseContent(), productPosition: "won" as never }).success
  );

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "M5 0054 content contract PASSED." : "M5 0054 content contract FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
