import { z } from "zod";
import { ClientPosition, CompetitorMentionSchema, SourceCitationSchema } from "./probe-analysis.schema";

/**
 * D-028 — M5's own analysis-output and persist-content schemas.
 *
 * Deliberately separate from `ProbeAnalysisOutputSchema`
 * (`probe-analysis.schema.ts`): that schema's cross-field rules are
 * built entirely around `verdict` (`won`/`partial`/`lost`/
 * `not_relevant`), a vocabulary M5 never computes (D-028). This file
 * reuses only the non-legacy, reusable pieces of that schema verbatim
 * (`ClientPosition`, `CompetitorMentionSchema`, `SourceCitationSchema`)
 * and never imports `Verdict`/`ProbeAnalysisOutputSchema`.
 *
 * Two distinct schemas:
 *   1. `ProbeAnalysisM5OutputSchema` — what the LLM itself is asked to
 *      produce (validated by `parseAnalysisContentOnce`, D-027). The
 *      model decides only `clientPosition`/`competitorsMentioned`/
 *      `sourcesCited`/`answerSummary` — never a verdict, never the
 *      deterministic fields below.
 *   2. `PersistProbeResultForJobContentSchema` — the full nine-key
 *      shape `persist_probe_result_for_job` (0054) validates
 *      server-side. `productMentioned`/`citedAsSource`/
 *      `clientSourceCount`/`platformsReferenced`/`negativeClaimDetected`
 *      are deterministic derivations (via
 *      `lib/probe-analysis/product-recommendation.ts`'s
 *      `classifyProductRecommendation`/`mapProductPositionToRunPosition`),
 *      never asked of the LLM directly. Client-side validation here is
 *      defense in depth — the RPC re-validates everything server-side
 *      regardless, never trusting this schema alone.
 */

export const ProbeAnalysisM5OutputSchema = z.object({
  clientPosition: ClientPosition,
  competitorsMentioned: z.array(CompetitorMentionSchema).max(50),
  sourcesCited: z.array(SourceCitationSchema).max(50),
  answerSummary: z.string().max(4000),
});
export type ProbeAnalysisM5Output = z.infer<typeof ProbeAnalysisM5OutputSchema>;

const CompetitorMentionM5Schema = z
  .object({
    name: z.string().min(1).max(200),
    // DEFECT_03: bounded 1-500, matching persist_probe_result_for_job's
    // own SQL-side bound exactly -- a fractional value is already
    // rejected by `.int()`, never reaching a cast on the SQL side either
    // (both layers validate integer-ness before any numeric comparison).
    position: z.number().int().min(1).max(500),
    context: z.string().max(500),
  })
  .strict();

const SourceCitationM5Schema = z
  .object({
    source: z.string().min(1).max(500),
    type: z.enum(["review_site", "blog", "forum", "vendor_site", "news", "other"]),
  })
  .strict();

export const PersistProbeResultForJobContentSchema = z
  .object({
    productMentioned: z.boolean(),
    productPosition: ClientPosition,
    competitorsMentioned: z.array(CompetitorMentionM5Schema).max(50),
    sourcesCited: z.array(SourceCitationM5Schema).max(50),
    answerSummary: z.string().max(4000),
    citedAsSource: z.boolean(),
    clientSourceCount: z.number().int().min(0).max(50),
    platformsReferenced: z.array(z.string().min(1).max(100)).max(20),
    negativeClaimDetected: z.boolean(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const positionOk =
      (val.productPosition === "absent" && val.productMentioned === false) ||
      (["primary", "listed", "negative"].includes(val.productPosition) && val.productMentioned === true);
    if (!positionOk) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["productMentioned"],
        message: `productPosition="${val.productPosition}" is inconsistent with productMentioned=${val.productMentioned}`,
      });
    }
    if (val.negativeClaimDetected !== (val.productPosition === "negative")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["negativeClaimDetected"],
        message: `negativeClaimDetected must equal (productPosition === "negative")`,
      });
    }
    if (val.citedAsSource !== val.clientSourceCount > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["citedAsSource"],
        message: `citedAsSource must equal (clientSourceCount > 0)`,
      });
    }
    const covered = val.platformsReferenced.every((plat) =>
      val.sourcesCited.some((src) => src.source.toLowerCase().includes(plat.toLowerCase()))
    );
    if (!covered) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["platformsReferenced"],
        message: "every platformsReferenced entry must correspond to at least one sourcesCited entry",
      });
    }
  });
export type PersistProbeResultForJobContent = z.infer<typeof PersistProbeResultForJobContentSchema>;
