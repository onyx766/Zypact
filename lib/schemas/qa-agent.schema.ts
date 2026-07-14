import { z } from "zod";

/**
 * Zod schema for the QA Agent output (Sprint 9).
 *
 * Cross-field verdict rules — mirrored from the canonical prompt:
 *  - `safe_to_publish`  ⇒ `violations.length === 0`
 *  - `unsupported_claims` ⇒ `violations.length >= 1`
 *  - `needs_evidence`   ⇒ `placeholdersRemaining.length >= 1`
 *                          OR every violation is `type === "quality"`
 *                          (quality flags do not imply fabrication).
 *
 * Field-level rules:
 *  - `overallNotes` is non-decision prose: empty strings are normalized to a safe default.
 *  - Each violation's `quote`, `reason`, and `suggestedFix` must be
 *    non-empty. `quote` should be a verbatim slice of the asset so the UI
 *    can highlight it (we don't enforce that structurally — that's for the
 *    Fix workflow later).
 *
 * `[EVIDENCE NEEDED: …]` placeholders are legitimate and MUST land in
 * `placeholdersRemaining` — never in `violations`. This is enforced by the
 * pipeline runner and the mock; the schema only enforces shape.
 */

export const QaVerdictSchema = z.enum([
  "safe_to_publish",
  "needs_evidence",
  "unsupported_claims",
]);
export type QaVerdict = z.infer<typeof QaVerdictSchema>;

export const QaViolationType = z.enum([
  "fabrication",
  "forbidden_claim",
  "unsupported_number",
  "unsupported_claim",
  "competitor_risk",
  "implied_result",
  "quality",
]);
export type QaViolationType = z.infer<typeof QaViolationType>;

export const QaViolationSchema = z.object({
  type: QaViolationType,
  quote: z.string().min(1, "violation.quote must be non-empty"),
  reason: z.string().min(1, "violation.reason must be non-empty"),
  suggestedFix: z.string().min(1, "violation.suggestedFix must be non-empty"),
});
export type QaViolation = z.infer<typeof QaViolationSchema>;

export const QaAgentOutputSchema = z
  .object({
    verdict: QaVerdictSchema,
    violations: z.array(QaViolationSchema),
    placeholdersRemaining: z.array(z.string().min(1)),
    overallNotes: z.string().transform((s) =>
      s.trim().length > 0 ? s : "No additional notes."
    ),
  })
  .superRefine((val, ctx) => {
    if (val.verdict === "safe_to_publish" && val.violations.length !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["violations"],
        message: `verdict="safe_to_publish" requires violations.length === 0 (got ${val.violations.length})`,
      });
    }

    if (val.verdict === "unsupported_claims" && val.violations.length < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["violations"],
        message: `verdict="unsupported_claims" requires at least one violation`,
      });
    }

    if (val.verdict === "needs_evidence") {
      const hasPlaceholders = val.placeholdersRemaining.length > 0;
      const nonQualityViolations = val.violations.filter(
        (v) => v.type !== "quality"
      );
      // Needs-evidence is allowed if placeholders remain OR every violation
      // is only a quality concern (i.e. no fabrication / forbidden claim /
      // unsupported number / competitor risk / implied result).
      if (!hasPlaceholders && nonQualityViolations.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["verdict"],
          message: `verdict="needs_evidence" requires placeholdersRemaining or violations to be quality-only (got ${nonQualityViolations.length} non-quality violation${nonQualityViolations.length === 1 ? "" : "s"})`,
        });
      }
    }
  });

export type QaAgentOutput = z.infer<typeof QaAgentOutputSchema>;
