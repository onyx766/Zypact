import { z } from "zod";

/**
 * Zod schema for the Evidence Bank.
 *
 * The Evidence Bank is NOT an LLM agent output — it is the user-editable
 * safety layer that constrains future Fix Agent and QA Agent output.
 *
 * Sprint 6 rules:
 *  - `productDescription` may start empty, but must be <= 2000 chars.
 *  - Simple string arrays: targetAudience, mainUseCases, competitors,
 *    allowedClaims, forbiddenClaims.
 *  - `features` is `[{ name, description }]` (description may be empty).
 *  - `proofItems` is a typed proof list.
 *  - `proofItems.sourceUrl` is optional; if present, must be a valid URL.
 *  - `forbiddenClaims` MUST contain at least 3 items — no Evidence Bank
 *    without an explicit list of things Zypact is not allowed to say.
 *  - `tone` is a single value from the tone enum below.
 */

export const PRODUCT_DESCRIPTION_MAX = 2000;

export const ProofType = z.enum([
  "testimonial",
  "case_study",
  "metric",
  "customer",
  "review",
  "award",
  "integration",
  "security",
  "press",
  "other",
]);
export type ProofType = z.infer<typeof ProofType>;

export const Tone = z.enum([
  "plain",
  "confident",
  "technical",
  "friendly",
  "executive",
]);
export type Tone = z.infer<typeof Tone>;

export const FeatureItemSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
});
export type FeatureItem = z.infer<typeof FeatureItemSchema>;

export const ProofItemSchema = z.object({
  type: ProofType,
  detail: z.string().min(1),
  // Optional, but if present must be a valid URL. `.optional()` accepts both
  // missing and undefined; empty strings are rejected because they would fail
  // `.url()` — the UI normalizes "" to undefined before sending.
  sourceUrl: z.string().url().optional(),
});
export type ProofItem = z.infer<typeof ProofItemSchema>;

/**
 * The default set of forbidden claims. Prefill seeds every new Evidence
 * Bank with these; the user can extend but not shrink below the minimum of 3.
 * Order preserved for UI display.
 */
export const DEFAULT_FORBIDDEN_CLAIMS: readonly string[] = [
  "guaranteed rankings",
  "guaranteed AI mentions",
  "guaranteed citations",
  "#1 platform",
  "trusted by thousands",
  "10x growth",
  "will rank in ChatGPT",
  "AI will recommend you",
  "proven revenue growth",
  "best in the market",
] as const;

/**
 * The user-editable payload — everything you can change through the UI or
 * the POST endpoint. The DB adds id / projectId / timestamps.
 */
/**
 * Sprint 12 — provenance of the current Evidence Bank row.
 * Defaults to `auto_filled_from_mirror_profile` when a bank is
 * auto-created; POST/UI writes set it to `user_edited`. `user_reviewed`
 * is reserved for a future review-and-approve UI.
 */
export const EvidenceBankProvenanceSchema = z.enum([
  "auto_filled_from_mirror_profile",
  "user_edited",
  "user_reviewed",
]);
export type EvidenceBankProvenance = z.infer<
  typeof EvidenceBankProvenanceSchema
>;

export const EvidenceBankInputSchema = z.object({
  productDescription: z.string().max(PRODUCT_DESCRIPTION_MAX),
  targetAudience: z.array(z.string().min(1)),
  mainUseCases: z.array(z.string().min(1)),
  features: z.array(FeatureItemSchema),
  proofItems: z.array(ProofItemSchema),
  competitors: z.array(z.string().min(1)),
  allowedClaims: z.array(z.string().min(1)),
  forbiddenClaims: z
    .array(z.string().min(1))
    .min(3, "forbiddenClaims must contain at least 3 items"),
  tone: Tone,
  notes: z.string(),
  // Sprint 12 — accept provenance from the caller. Default preserves
  // backwards compatibility: callers that don't pass a value get the
  // "auto-filled" answer, matching the migration's default.
  provenance: EvidenceBankProvenanceSchema.default("auto_filled_from_mirror_profile"),
});
export type EvidenceBankInput = z.infer<typeof EvidenceBankInputSchema>;

/** Stored shape — what `getEvidenceBankByProject` returns. */
export const EvidenceBankOutputSchema = EvidenceBankInputSchema.extend({
  id: z.string(),
  projectId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EvidenceBankOutput = z.infer<typeof EvidenceBankOutputSchema>;
