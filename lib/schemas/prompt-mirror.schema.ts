import { z } from "zod";

/**
 * Zod schema for the Prompt Mirror Agent output.
 *
 * Contract:
 *  - exactly 50 prompts
 *  - each score is 1..5 integer
 *  - priority is 1..25 integer (== commercialValue * winnability)
 *  - recommendedForProbe has at most 20 ids
 *  - every id in recommendedForProbe MUST refer to a prompt.id in `prompts`
 *
 * We deliberately do NOT enforce `priority === commercialValue * winnability`
 * as a hard invariant — the canonical prompt asks the model to compute it,
 * and enforcing exact arithmetic would fail runs where the model
 * scores validly but off by one. The bounds check (1..25) is enough.
 */

export const IntentType = z.enum([
  "best_tools",
  "alternatives",
  "comparison",
  "use_case",
  "problem_aware",
  "industry_specific",
  "pricing_value",
  "migration",
  "buyer_role",
]);
export type IntentType = z.infer<typeof IntentType>;

export const GeneratedPromptSchema = z.object({
  id: z.number().int().positive(),
  prompt: z.string().min(1),
  intentType: IntentType,
  commercialValue: z.number().int().min(1).max(5),
  winnability: z.number().int().min(1).max(5),
  priority: z.number().int().min(1).max(25),
  rationale: z.string(),
});
export type GeneratedPromptItem = z.infer<typeof GeneratedPromptSchema>;

export const PromptMirrorOutputSchema = z
  .object({
    prompts: z.array(GeneratedPromptSchema).length(50),
    recommendedForProbe: z.array(z.number().int().positive()).max(20),
  })
  .superRefine((val, ctx) => {
    // Every recommended id must exist in prompts.
    const promptIds = new Set(val.prompts.map((p) => p.id));
    for (let i = 0; i < val.recommendedForProbe.length; i++) {
      const id = val.recommendedForProbe[i];
      if (!promptIds.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["recommendedForProbe", i],
          message: `recommendedForProbe[${i}] = ${id} does not match any prompt.id`,
        });
      }
    }
    // Prompt ids must be unique so `selected` mapping is unambiguous.
    if (promptIds.size !== val.prompts.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prompts"],
        message: "prompt ids must be unique",
      });
    }
  });

export type PromptMirrorOutput = z.infer<typeof PromptMirrorOutputSchema>;
