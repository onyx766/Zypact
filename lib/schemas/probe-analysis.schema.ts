import { z } from "zod";

/**
 * Zod schema for the Probe Analysis Agent output.
 *
 * Cross-field rules (from Sprint 3 brief):
 *  1. If clientMentioned === false, clientPosition MUST be "absent".
 *  2. If verdict === "won", clientPosition MUST be "primary".
 *  3. If verdict === "lost", clientMentioned MUST be false.
 *  4. competitorsMentioned[].position MUST be integer >= 1.
 *  5. whyClientLost can be empty ONLY if verdict is "won" or "not_relevant".
 */

export const Platform = z.enum(["perplexity", "chatgpt", "gemini"]);
export type Platform = z.infer<typeof Platform>;

export const ClientPosition = z.enum(["primary", "listed", "negative", "absent"]);
export type ClientPosition = z.infer<typeof ClientPosition>;

export const Verdict = z.enum(["won", "partial", "lost", "not_relevant"]);
export type Verdict = z.infer<typeof Verdict>;

export const SourceType = z.enum([
  "review_site",
  "blog",
  "forum",
  "vendor_site",
  "news",
  "other",
]);
export type SourceType = z.infer<typeof SourceType>;

function normalizeSourceType(value: unknown): unknown {
  if (typeof value !== "string") return value;

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  const map: Record<string, SourceType> = {
    review_site: "review_site",
    review: "review_site",
    reviews: "review_site",
    blog: "blog",
    article: "blog",
    articles: "blog",
    forum: "forum",
    community: "forum",
    vendor_site: "vendor_site",
    vendor: "vendor_site",
    vendor_website: "vendor_site",
    website: "vendor_site",
    news: "news",
    press: "news",
    other: "other",

    // LLMs often emit these even though the strict enum does not allow them.
    video: "other",
    youtube: "other",
    social: "other",
    social_media: "other",
    linkedin: "other",
    twitter: "other",
    x: "other",
    pdf: "other",
    document: "other",
    docs: "other",
  };

  return map[normalized] ?? "other";
}

export const CompetitorMentionSchema = z.object({
  name: z.string().min(1),
  position: z.number().int().min(1),
  context: z.string(),
});
export type CompetitorMention = z.infer<typeof CompetitorMentionSchema>;

export const SourceCitationSchema = z.object({
  source: z.string().min(1),
  type: z.preprocess(normalizeSourceType, SourceType),
});
export type SourceCitation = z.infer<typeof SourceCitationSchema>;

export const ProbeAnalysisOutputSchema = z
  .object({
    prompt: z.string().min(1),
    platform: Platform,
    clientMentioned: z.boolean(),
    clientPosition: ClientPosition,
    competitorsMentioned: z.array(CompetitorMentionSchema),
    sourcesCited: z.array(SourceCitationSchema),
    answerSummary: z.string(),
    verdict: Verdict,
    whyClientLost: z.string(),
  })
  .transform((val) => {
    let clientMentioned = val.clientMentioned;
    let clientPosition = val.clientPosition;
    let verdict = val.verdict;

    // If the agent says the client position is absent, treat the client as not mentioned.
    // This fixes common LLM drift: clientMentioned=true + clientPosition="absent" + verdict="lost".
    if (clientPosition === "absent") {
      clientMentioned = false;
    }

    // Keep the inverse consistent too.
    if (!clientMentioned) {
      clientPosition = "absent";
    }

    // Canonicalize verdict from the authoritative client position.
    // This prevents contradictory LLM output from stopping the whole scan.
    if (verdict !== "not_relevant") {
      if (clientPosition === "primary") {
        clientMentioned = true;
        verdict = "won";
      } else if (
        clientPosition === "listed" ||
        clientPosition === "negative"
      ) {
        clientMentioned = true;
        verdict = "partial";
      } else {
        clientMentioned = false;
        clientPosition = "absent";
        verdict = "lost";
      }
    }

    return {
      ...val,
      clientMentioned,
      clientPosition,
      verdict,
      whyClientLost:
        val.whyClientLost.trim().length > 0 ||
        val.verdict === "won" ||
        val.verdict === "not_relevant"
          ? val.whyClientLost
          : "The client was not clearly recommended in the AI answer.",
    };
  })
  .superRefine((val, ctx) => {
    // Rule 1: not mentioned => position must be "absent".
    if (!val.clientMentioned && val.clientPosition !== "absent") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clientPosition"],
        message: `clientMentioned=false requires clientPosition="absent", got "${val.clientPosition}"`,
      });
    }
    // Rule 2: won => position must be "primary".
    if (val.verdict === "won" && val.clientPosition !== "primary") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clientPosition"],
        message: `verdict="won" requires clientPosition="primary", got "${val.clientPosition}"`,
      });
    }
    // Rule 3: lost => client MUST be absent.
    if (val.verdict === "lost" && val.clientMentioned) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clientMentioned"],
        message: `verdict="lost" requires clientMentioned=false`,
      });
    }
    // Rule 5: whyClientLost empty only allowed when verdict ∈ {won, not_relevant}.
    if (
      val.whyClientLost.trim().length === 0 &&
      val.verdict !== "won" &&
      val.verdict !== "not_relevant"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["whyClientLost"],
        message: `whyClientLost is required when verdict is "${val.verdict}"`,
      });
    }
  });

export type ProbeAnalysisOutput = z.infer<typeof ProbeAnalysisOutputSchema>;

/** Handy type for the client-name payload passed to the agent. */
export interface ClientIdentity {
  name: string;
  domain?: string;
  aliases?: string[];
}
