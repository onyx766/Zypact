import { z } from "zod";

/**
 * Zod schema for the Gap Map Agent output.
 *
 * Structural rules (from Sprint 5 brief):
 *  - `competitorDistances` must contain at least 1 item.
 *    (Pipeline runner already refuses to call the agent when there are no
 *    competitors, so an empty output signals a bug — fail loudly.)
 *  - Each gap sub-score is an integer 0..10.
 *  - `recommendationDistance` is an integer 0..60 and equals the sum of the
 *    six sub-scores. This is enforced here AND additionally normalized by
 *    the pipeline runner before saving.
 *  - `topReasons` contains 1..4 strings.
 *  - `prioritizedGaps` is at most 5 items.
 *  - Node ids are unique.
 *  - Edge weights are integers >= 0.
 *  - Every edge references either an existing node id or the client id.
 */

export const GAP_SCORE_MIN = 0;
export const GAP_SCORE_MAX = 10;
export const DISTANCE_MIN = 0;
export const DISTANCE_MAX = 60;

export const GapScoresSchema = z.object({
  prompt_loss: z.number().int().min(GAP_SCORE_MIN).max(GAP_SCORE_MAX),
  citation: z.number().int().min(GAP_SCORE_MIN).max(GAP_SCORE_MAX),
  review: z.number().int().min(GAP_SCORE_MIN).max(GAP_SCORE_MAX),
  comparison_content: z.number().int().min(GAP_SCORE_MIN).max(GAP_SCORE_MAX),
  proof: z.number().int().min(GAP_SCORE_MIN).max(GAP_SCORE_MAX),
  entity_clarity: z.number().int().min(GAP_SCORE_MIN).max(GAP_SCORE_MAX),
});
export type GapScores = z.infer<typeof GapScoresSchema>;

export const EvidenceStrength = z.enum(["strong", "moderate", "thin"]);
export type EvidenceStrength = z.infer<typeof EvidenceStrength>;

export const NodeType = z.enum([
  "competitor",
  "external_source",
  "prompt",
  "gap",
]);
export type NodeType = z.infer<typeof NodeType>;

export const EdgeType = z.enum([
  "recommended_in",
  "cited_by",
  "gap",
  "competes_with",
]);
export type EdgeType = z.infer<typeof EdgeType>;

export const Severity = z.enum(["high", "medium", "low"]);
export type Severity = z.infer<typeof Severity>;

export const CLIENT_NODE_ID = "client";

export const ClientNodeSchema = z.object({
  id: z.literal(CLIENT_NODE_ID),
  label: z.string().min(1),
  type: z.literal("brand"),
});
export type ClientNode = z.infer<typeof ClientNodeSchema>;

export const GraphNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  type: NodeType,
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: EdgeType,
  weight: z.number().int().min(0),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const CompetitorDistanceSchema = z.object({
  competitor: z.string().min(1),
  recommendationDistance: z.number().int().min(DISTANCE_MIN).max(DISTANCE_MAX),
  gapScores: GapScoresSchema,
  topReasons: z.array(z.string().min(1)).min(1).max(4),
  evidenceStrength: EvidenceStrength,
});
export type CompetitorDistance = z.infer<typeof CompetitorDistanceSchema>;

export const PrioritizedGapSchema = z.object({
  type: z.string().min(1),
  severity: Severity,
  explanation: z.string().min(1),
  affectedPrompts: z.array(z.string()),
  suggestedFixDirection: z.string().min(1),
});
export type PrioritizedGap = z.infer<typeof PrioritizedGapSchema>;

export const GapMapOutputSchema = z
  .object({
    clientNode: ClientNodeSchema,
    nodes: z.array(GraphNodeSchema),
    edges: z.array(GraphEdgeSchema),
    competitorDistances: z.array(CompetitorDistanceSchema).min(1),
    prioritizedGaps: z.array(PrioritizedGapSchema).max(5),
  })
  .superRefine((val, ctx) => {
    // Rule: recommendationDistance = sum of the six sub-scores.
    val.competitorDistances.forEach((d, i) => {
      const sum =
        d.gapScores.prompt_loss +
        d.gapScores.citation +
        d.gapScores.review +
        d.gapScores.comparison_content +
        d.gapScores.proof +
        d.gapScores.entity_clarity;
      if (sum !== d.recommendationDistance) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["competitorDistances", i, "recommendationDistance"],
          message: `competitorDistances[${i}]: recommendationDistance (${d.recommendationDistance}) must equal the sum of the six gap sub-scores (${sum})`,
        });
      }
    });

    // Rule: node ids must be unique across nodes (client id is separate).
    const nodeIds = new Set<string>();
    for (let i = 0; i < val.nodes.length; i++) {
      const n = val.nodes[i];
      if (n.id === val.clientNode.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", i, "id"],
          message: `nodes[${i}].id collides with clientNode.id "${val.clientNode.id}"`,
        });
      }
      if (nodeIds.has(n.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", i, "id"],
          message: `duplicate node id "${n.id}"`,
        });
      }
      nodeIds.add(n.id);
    }

    // Rule: edges reference known node ids or the client id.
    const known = new Set<string>([val.clientNode.id, ...nodeIds]);
    val.edges.forEach((e, i) => {
      if (!known.has(e.from)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges", i, "from"],
          message: `edges[${i}].from references unknown node id "${e.from}"`,
        });
      }
      if (!known.has(e.to)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges", i, "to"],
          message: `edges[${i}].to references unknown node id "${e.to}"`,
        });
      }
    });
  });

export type GapMapOutput = z.infer<typeof GapMapOutputSchema>;

/** Ordered list of the six numeric gap dimensions. */
export const GAP_DIMENSIONS = [
  "prompt_loss",
  "citation",
  "review",
  "comparison_content",
  "proof",
  "entity_clarity",
] as const;
export type GapDimension = (typeof GAP_DIMENSIONS)[number];
