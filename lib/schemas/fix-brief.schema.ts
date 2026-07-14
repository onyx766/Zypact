import { z } from "zod";

/**
 * Zod schema for the Fix Brief Agent output (`fix_brief` mode only).
 *
 * Sprint 7 rules:
 *  - `lostPrompt`, `competitorRecommended`, `recommendedFix` non-empty.
 *  - `rootCause` non-empty, max 1000 characters.
 *  - `fixType` ∈ { comparison_page, faq_block, proof_block,
 *    comparison_table, schema }.
 *  - `assetsToGenerate` items ∈ { comparison_page_outline, faq_block,
 *    proof_block, comparison_table, json_ld_schema }; at least 1 item.
 *  - `evidenceNeeded`, `evidenceAvailable` are string arrays.
 *  - `priority` is an integer 1..5.
 *  - `expectedImpact` is a non-empty string.
 *  - A `superRefine` rejects the payload if `expectedImpact`, `rootCause`,
 *    or `recommendedFix` contains any Sprint 7 banned phrase. This is a
 *    safety floor, not a substitute for the future QA Agent.
 */

export const FixType = z.enum([
  "comparison_page",
  "faq_block",
  "proof_block",
  "comparison_table",
  "schema",
]);
export type FixType = z.infer<typeof FixType>;

export const AssetType = z.enum([
  "comparison_page_outline",
  "faq_block",
  "proof_block",
  "comparison_table",
  "json_ld_schema",
]);
export type AssetType = z.infer<typeof AssetType>;

function normalizeAssetType(value: unknown): unknown {
  if (typeof value !== "string") return value;

  const normalized = value.trim().toLowerCase();

  const map: Record<string, AssetType> = {
    comparison_page: "comparison_page_outline",
    comparison_page_outline: "comparison_page_outline",
    faq: "faq_block",
    faq_block: "faq_block",
    proof: "proof_block",
    proof_block: "proof_block",
    comparison_table: "comparison_table",
    schema: "json_ld_schema",
    json_ld: "json_ld_schema",
    jsonld_schema: "json_ld_schema",
    json_ld_schema: "json_ld_schema",
  };

  return map[normalized] ?? normalized;
}

function assetTypeFromFixType(fixType: FixType): AssetType {
  switch (fixType) {
    case "comparison_page":
      return "comparison_page_outline";
    case "faq_block":
      return "faq_block";
    case "proof_block":
      return "proof_block";
    case "comparison_table":
      return "comparison_table";
    case "schema":
      return "json_ld_schema";
  }
}

export const FixBriefStatus = z.enum([
  "draft",
  "needs_evidence",
  "ready_for_assets",
]);
export type FixBriefStatus = z.infer<typeof FixBriefStatus>;

export const ROOT_CAUSE_MAX = 1000;

/**
 * Phrases the Fix Brief Agent is NEVER allowed to emit in `rootCause`,
 * `recommendedFix`, or `expectedImpact`. Match is case-insensitive against
 * a normalized version of each string (whitespace + punctuation collapsed).
 * This mirrors the default forbiddenClaims list in the Evidence Bank plus
 * the two extra "will rank in ChatGPT" and "AI will recommend you" phrases
 * called out in the Sprint 7 brief.
 */
export const SPRINT_7_BANNED_PHRASES: readonly string[] = [
  "guaranteed AI mentions",
  "guaranteed rankings",
  "guaranteed citations",
  "will rank in ChatGPT",
  "AI will recommend you",
  "10x growth",
  "#1 platform",
  "best in the market",
  "proven revenue growth",
] as const;

function normalizeForBanCheck(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s\-_,.;:!?"']+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find every banned phrase present in `text`. Returns the ORIGINAL phrase
 * strings (from `SPRINT_7_BANNED_PHRASES`) so error messages match the
 * canonical spelling. Exported for reuse in tests.
 */
export function findBannedPhrases(text: string): string[] {
  const normalized = normalizeForBanCheck(text);
  return SPRINT_7_BANNED_PHRASES.filter((p) =>
    normalized.includes(normalizeForBanCheck(p))
  );
}

export const FixBriefOutputSchema = z
  .object({
    lostPrompt: z.string().min(1),
    competitorRecommended: z.string().min(1),
    rootCause: z.string().min(1).max(ROOT_CAUSE_MAX),
    recommendedFix: z.string().min(1),
    fixType: FixType,
    assetsToGenerate: z.preprocess(
      (value) => Array.isArray(value) ? value.map(normalizeAssetType) : value,
      z.array(AssetType)
    ),
    evidenceNeeded: z.array(z.string().min(1)),
    evidenceAvailable: z.array(z.string().min(1)),
    priority: z.number().int().min(1).max(5),
    expectedImpact: z.string().min(1),
  })
  .transform((val) => ({
    ...val,
    assetsToGenerate:
      val.assetsToGenerate.length > 0
        ? val.assetsToGenerate
        : [assetTypeFromFixType(val.fixType)],
  }))
  .superRefine((val, ctx) => {
    const check = (
      field: "rootCause" | "recommendedFix" | "expectedImpact"
    ) => {
      const hits = findBannedPhrases(val[field]);
      if (hits.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} contains banned guarantee language: ${hits.map((h) => `"${h}"`).join(", ")}`,
        });
      }
    };
    check("rootCause");
    check("recommendedFix");
    check("expectedImpact");
  });

export type FixBriefOutput = z.infer<typeof FixBriefOutputSchema>;
