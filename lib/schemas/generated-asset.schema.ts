import { z } from "zod";
import {
  SPRINT_7_BANNED_PHRASES,
  findBannedPhrases,
} from "./fix-brief.schema";

/**
 * Zod schema for the Fix Agent output in `generate_asset` mode (Sprint 8).
 *
 * This is a *structural* guard, not the QA Agent. It rejects the most
 * obvious guarantee language, enforces JSON-parseability for JSON-LD
 * output, and keeps the `[EVIDENCE NEEDED: …]` placeholder list in
 * bidirectional sync with the placeholders that actually appear in the
 * asset content.
 */

export const AssetTypeSchema = z.enum([
  "comparison_page_outline",
  "faq_block",
  "proof_block",
  "comparison_table",
  "json_ld_schema",
]);
export type AssetTypeValue = z.infer<typeof AssetTypeSchema>;

export const ClaimSourceSchema = z.enum(["evidence_bank", "mirror_profile"]);
export type ClaimSource = z.infer<typeof ClaimSourceSchema>;

export const ClaimUsedSchema = z.object({
  claim: z.string().min(1),
  source: ClaimSourceSchema,
});
export type ClaimUsed = z.infer<typeof ClaimUsedSchema>;

/**
 * Sprint 8 QA status enum. New assets are always saved with `pending_qa` —
 * the QA Agent (out of scope) will mutate this later.
 */
export const GeneratedAssetQaStatus = z.enum([
  "pending_qa",
  "needs_evidence",
  "safe_to_publish",
  "unsupported_claims",
  "qa_failed",
]);
export type GeneratedAssetQaStatus = z.infer<typeof GeneratedAssetQaStatus>;

/**
 * Extract every `[EVIDENCE NEEDED: …]` placeholder from a piece of asset
 * content. Returns the full literal substring (including brackets) — this
 * matches the canonical `[EVIDENCE NEEDED: description]` shape declared in
 * the Fix Agent system prompt.
 *
 * Whitespace at the top of the description is normalized so callers can
 * write `[EVIDENCE NEEDED:  pricing evidence]` or
 * `[EVIDENCE NEEDED: pricing evidence]` and get the same canonical string
 * back.
 */
export function extractEvidencePlaceholders(content: string): string[] {
  const raw = content.match(/\[EVIDENCE NEEDED:[^\]]*\]/g) ?? [];
  return raw.map((p) => p.replace(/\s+/g, " ").trim());
}

/**
 * Are the two arrays equal *as sets*? Used to check that the `placeholders`
 * array declared by the agent matches every placeholder actually present in
 * the asset content. Duplicates on either side are treated as one — the
 * canonical prompt just says "list of every [EVIDENCE NEEDED] inserted".
 */
function normalize(list: string[]): string[] {
  return list.map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s.length > 0);
}

function symmetricSetDiff(
  a: string[],
  b: string[]
): { onlyInA: string[]; onlyInB: string[] } {
  const setA = new Set(normalize(a));
  const setB = new Set(normalize(b));
  const onlyInA = [...setA].filter((x) => !setB.has(x));
  const onlyInB = [...setB].filter((x) => !setA.has(x));
  return { onlyInA, onlyInB };
}

/**
 * Re-export the canonical Sprint 7 phrase list so callers importing the
 * asset schema don't have to reach into the fix-brief module.
 */
export const GENERATED_ASSET_BANNED_PHRASES = SPRINT_7_BANNED_PHRASES;

export const GeneratedAssetOutputSchema = z
  .object({
    assetType: AssetTypeSchema,
    title: z.string().min(1),
    content: z.string().min(1),
    placeholders: z.array(z.string().min(1)),
    claimsUsed: z.array(ClaimUsedSchema),
  })
  .superRefine((val, ctx) => {
    // 1. JSON-LD content must actually parse as JSON.
    if (val.assetType === "json_ld_schema") {
      try {
        JSON.parse(val.content);
      } catch (e) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["content"],
          message: `json_ld_schema content must parse as JSON: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    // 2. Banned guarantee language in title / content / claim strings.
    const banTitle = findBannedPhrases(val.title);
    if (banTitle.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["title"],
        message: `title contains banned guarantee language: ${banTitle.map((h) => `"${h}"`).join(", ")}`,
      });
    }
    const banContent = findBannedPhrases(val.content);
    if (banContent.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["content"],
        message: `content contains banned guarantee language: ${banContent.map((h) => `"${h}"`).join(", ")}`,
      });
    }
    val.claimsUsed.forEach((c, i) => {
      const hits = findBannedPhrases(c.claim);
      if (hits.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["claimsUsed", i, "claim"],
          message: `claim contains banned guarantee language: ${hits.map((h) => `"${h}"`).join(", ")}`,
        });
      }
    });

    // 3. Placeholder round-trip: every `[EVIDENCE NEEDED: …]` in content
    //    must be declared in `placeholders`, and every declared
    //    placeholder must appear in content.
    const found = extractEvidencePlaceholders(val.content);
    const { onlyInA: inContentMissingFromList, onlyInB: inListMissingFromContent } =
      symmetricSetDiff(found, val.placeholders);
    if (inContentMissingFromList.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["placeholders"],
        message: `Content includes placeholders not declared in "placeholders": ${inContentMissingFromList
          .map((p) => `"${p}"`)
          .join(", ")}`,
      });
    }
    if (inListMissingFromContent.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["placeholders"],
        message: `"placeholders" declares entries not present in content: ${inListMissingFromContent
          .map((p) => `"${p}"`)
          .join(", ")}`,
      });
    }
  });

export type GeneratedAssetOutput = z.infer<typeof GeneratedAssetOutputSchema>;
