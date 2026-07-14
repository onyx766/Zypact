import { z } from "zod";

/**
 * Zod schema for the Competitor Discovery Agent output.
 *
 * Rules enforced here (from Sprint 4 brief):
 *  - `competitors` must contain at least 1 item.
 *    The pipeline runner requires ProbeResults to exist, so an empty set
 *    signals a bug or a starved run — fail loudly.
 *  - `name` non-empty.
 *  - `mentionCount` integer >= 0.
 *  - `promptIds` string array (may be empty).
 *  - `website` nullable — the model must NOT invent websites.
 *  - If `discoverySource === "model_knowledge"`, `confidence` MUST be
 *    "unverified".
 *  - If `discoverySource === "ai_answer"`, `mentionCount` MUST be >= 1.
 */

export const DiscoverySource = z.enum([
  "user",
  "client_site",
  "ai_answer",
  "model_knowledge",
]);
export type DiscoverySource = z.infer<typeof DiscoverySource>;

export const ThreatLevel = z.enum(["high", "medium", "low"]);
export type ThreatLevel = z.infer<typeof ThreatLevel>;

export const Confidence = z.enum(["verified", "unverified"]);
export type Confidence = z.infer<typeof Confidence>;

export const CompetitorItemSchema = z.object({
  name: z.string().min(1),
  website: z.string().nullable(),
  discoverySource: DiscoverySource,
  mentionCount: z.number().int().min(0),
  promptIds: z.array(z.string()),
  threatLevel: ThreatLevel,
  confidence: Confidence,
});
export type CompetitorItem = z.infer<typeof CompetitorItemSchema>;

export const CompetitorDiscoveryOutputSchema = z
  .object({
    competitors: z.array(CompetitorItemSchema).min(1),
    phantomCompetitors: z.array(z.string().min(1)),
    blindSpots: z.array(z.string().min(1)),
    summary: z.string(),
  })
  .superRefine((val, ctx) => {
    val.competitors.forEach((c, i) => {
      if (c.discoverySource === "model_knowledge" && c.confidence !== "unverified") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["competitors", i, "confidence"],
          message:
            `competitors[${i}]: discoverySource="model_knowledge" requires confidence="unverified", got "${c.confidence}"`,
        });
      }
      if (c.discoverySource === "ai_answer" && c.mentionCount < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["competitors", i, "mentionCount"],
          message:
            `competitors[${i}]: discoverySource="ai_answer" requires mentionCount >= 1, got ${c.mentionCount}`,
        });
      }
    });
  });

export type CompetitorDiscoveryOutput = z.infer<
  typeof CompetitorDiscoveryOutputSchema
>;
