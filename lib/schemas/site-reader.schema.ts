import { z } from "zod";

/**
 * Zod schema for the Site Reader Agent output.
 * Mirrors the JSON shape in `zypact-agent-prompts.md` exactly.
 *
 * `.strict()` is intentionally NOT applied — the LLM occasionally adds
 * benign extra keys and we don't want to reject those. All REQUIRED keys are
 * enforced. If a downstream agent needs additional guarantees, tighten there.
 */

export const CategoryConfidence = z.enum(["high", "medium", "low"]);
export type CategoryConfidence = z.infer<typeof CategoryConfidence>;

export const ProofSignalType = z.enum([
  "customer",
  "case_study",
  "review",
  "award",
  "integration",
  "press",
]);
export type ProofSignalType = z.infer<typeof ProofSignalType>;

export const ClaimSchema = z.object({
  claim: z.string(),
  sourceUrl: z.string(),
  hasProof: z.boolean(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const ProofSignalSchema = z.object({
  type: ProofSignalType,
  detail: z.string(),
  sourceUrl: z.string(),
});
export type ProofSignal = z.infer<typeof ProofSignalSchema>;

export const MissingSignalSchema = z.object({
  signal: z.string(),
  whyItMatters: z.string(),
});
export type MissingSignal = z.infer<typeof MissingSignalSchema>;

export const SiteReaderOutputSchema = z.object({
  companyName: z.string(),
  website: z.string(),
  detectedCategory: z.string(),
  categoryConfidence: CategoryConfidence,
  targetAudience: z.array(z.string()),
  useCases: z.array(z.string()),
  features: z.array(z.string()),
  painPointsAddressed: z.array(z.string()),
  claims: z.array(ClaimSchema),
  proofSignals: z.array(ProofSignalSchema),
  competitorsMentioned: z.array(z.string()),
  // Canonical prompt rule: "missingSignals must contain at least 3 items
  // for any site; no site is perfect."
  missingSignals: z.array(MissingSignalSchema).min(3),
  buyerIntentAngles: z.array(z.string()),
  aiReadabilityNotes: z.string(),
});

export type SiteReaderOutput = z.infer<typeof SiteReaderOutputSchema>;
