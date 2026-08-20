import { runFixBriefAgent } from "@/lib/agents/fix-agent";
import { recordAnalysisTrace } from "@/lib/evidence/analysis-trace";
import { getDb } from "@/lib/db";
import type { FixBriefRow, FixBriefRowInput, ProbeResult } from "@/lib/db/types";
import { hasUsableEvidenceBank } from "@/lib/evidence-bank/has-usable-evidence-bank";
import {
  EvidenceBankOutputSchema,
  type EvidenceBankOutput,
} from "@/lib/schemas/evidence-bank.schema";
import {
  SiteReaderOutputSchema,
  type SiteReaderOutput,
} from "@/lib/schemas/site-reader.schema";
import type { FixBriefOutput, FixBriefStatus } from "@/lib/schemas/fix-brief.schema";
import {
  buildDeterministicRootCause,
  buildFixBriefGroundingContext,
  buildGroundedFixBriefOutput,
  formatCompetitorRecommended,
  hasUnsupportedQuantifiedClaim,
} from "./fix-brief-grounding";
import { GapMapOutputSchema } from "@/lib/schemas/gap-map.schema";
import { withPipelineStep } from "./save-pipeline-step";

/**
 * Sprint 7 pipeline runner — Fix Brief generation (`fix_brief` mode only).
 *
 * Guard messages (kept as exported constants so the API route can promote
 * them to HTTP 409s and the UI can display the exact same string):
 *  - EVIDENCE_BANK_REQUIRED_MESSAGE
 *  - NO_LOST_PROBE_MESSAGE
 */

export const EVIDENCE_BANK_REQUIRED_MESSAGE =
  "Prepare the Evidence Bank before generating fix briefs.";

export const NO_LOST_PROBE_MESSAGE =
  "Run at least one lost or partial probe analysis before generating fix briefs.";

/**
 * Raised when a gap cannot be tied to one buyer question and that question's
 * own competitors. Generation stops rather than falling back to project-wide
 * evidence — see `fix-brief-grounding`.
 */
/**
 * Replaces generated impact text that asserts a magnitude or timeline. A
 * snapshot measures no uplift, so any such number is invention.
 */
export const GENERIC_EXPECTED_IMPACT =
  "Addressing this gap creates a clearer evidence surface for this buyer " +
  "question, which can be re-tested in a later scan.";

export const UNGROUNDED_GAP_MESSAGE =
  "This gap cannot be grounded to a single buyer question with its own competitor evidence.";

export const GAP_NOT_FOUND_MESSAGE =
  "Gap not found for this project.";

/**
 * M3 — source unique: raised when grounding resolved zero competitors
 * for this gap's buyer question (`context.promptLocalCompetitors` is
 * empty). Generation stops explicitly here rather than falling back to
 * a raw legacy probe mention or a generic placeholder competitor name
 * — no unresolved data is ever presented as a reliable competitor
 * identity. This is a transient generation-time rejection, not a new
 * persistent status: nothing is written to any table.
 */
export const NO_RESOLVED_COMPETITOR_MESSAGE =
  "No resolved competitor evidence is available for this gap's buyer question. Re-run Gap Map generation or verify entity resolution completed for the grounding probe result.";

export interface GenerateFixBriefInput {
  projectId: string;
  gapId: string;
}

export type GenerateFixBriefResult =
  | {
      ok: true;
      projectId: string;
      fixBrief: FixBriefRow;
      output: FixBriefOutput;
      usedMock: boolean;
      usedRetry: boolean;
    }
  | { ok: false; error: string; status?: number };

function statusFromOutput(output: FixBriefOutput): FixBriefStatus {
  return output.evidenceNeeded.length > 0 ? "needs_evidence" : "ready_for_assets";
}

export async function generateFixBrief(
  input: GenerateFixBriefInput
): Promise<GenerateFixBriefResult> {
  const db = getDb();

  const project = await db.getProject(input.projectId);
  if (!project) return { ok: false, error: "Project not found", status: 404 };

  const mirrorRow = await db.getMirrorProfile(input.projectId);
  if (!mirrorRow) {
    return {
      ok: false,
      error: "No Mirror Profile found for this project. Run a Mirror Scan first.",
      status: 404,
    };
  }
  const mirrorParsed = SiteReaderOutputSchema.safeParse(mirrorRow.json);
  if (!mirrorParsed.success) {
    return {
      ok: false,
      error: `Stored Mirror Profile failed schema validation: ${mirrorParsed.error.message}`,
      status: 500,
    };
  }
  const mirrorProfile: SiteReaderOutput = mirrorParsed.data;

  const bankRow = await db.getEvidenceBankByProject(input.projectId);
  if (!bankRow) {
    return {
      ok: false,
      error: EVIDENCE_BANK_REQUIRED_MESSAGE,
      status: 409,
    };
  }
  const bankParsed = EvidenceBankOutputSchema.safeParse(bankRow);
  if (!bankParsed.success) {
    return {
      ok: false,
      error: `Stored Evidence Bank failed schema validation: ${bankParsed.error.message}`,
      status: 500,
    };
  }
  const evidenceBank: EvidenceBankOutput = bankParsed.data;
  if (!hasUsableEvidenceBank(evidenceBank)) {
    return {
      ok: false,
      error: EVIDENCE_BANK_REQUIRED_MESSAGE,
      status: 409,
    };
  }

  const gaps = await db.getGapsByProject(input.projectId);
  const gap = gaps.find((g) => g.id === input.gapId);
  if (!gap) {
    return { ok: false, error: GAP_NOT_FOUND_MESSAGE, status: 404 };
  }

  const probeResults = await db.getProbeResultsByProject(input.projectId);

  // Provenance lives in the Gap Map JSON, not on the gap row: PR #23 records
  // `prioritizedGaps[].promptEvidence` there, and `replaceGapsForProject`
  // does not carry it onto individual rows. Re-read it rather than duplicate
  // it into the schema.
  const gapMapRow = await db.getLatestGapMap(input.projectId);
  if (!gapMapRow) {
    return { ok: false, error: UNGROUNDED_GAP_MESSAGE, status: 409 };
  }
  const gapMapParsed = GapMapOutputSchema.safeParse(gapMapRow.json);
  if (!gapMapParsed.success) {
    return {
      ok: false,
      error: `${UNGROUNDED_GAP_MESSAGE} Stored Gap Map failed schema validation.`,
      status: 409,
    };
  }

  const grounding = buildFixBriefGroundingContext({
    gapRow: gap,
    prioritizedGaps: gapMapParsed.data.prioritizedGaps,
    probeResults,
  });
  if (!grounding.ok) {
    return {
      ok: false,
      error: `${UNGROUNDED_GAP_MESSAGE} ${grounding.reason}`,
      status: 409,
    };
  }
  const context = grounding.context;

  const probeResult = probeResults.find((r) => r.id === context.probeResultId);
  if (!probeResult) {
    return { ok: false, error: NO_LOST_PROBE_MESSAGE, status: 409 };
  }

  // M3 — source unique: `context.promptLocalCompetitors` is already
  // resolved, canonical, prompt-scoped evidence (sourced via
  // lib/pipeline/scorecard-competitors.ts's canonicalEntityId-grouped
  // output, through the Gap Map's promptEvidence). If grounding
  // genuinely resolved no competitor for this gap, generation stops
  // explicitly here — never a fallback to a raw legacy probe mention
  // or a generic placeholder name.
  if (context.promptLocalCompetitors.length === 0) {
    return { ok: false, error: NO_RESOLVED_COMPETITOR_MESSAGE, status: 409 };
  }

  try {
    const agent = await withPipelineStep(
      { projectId: input.projectId, agent: "fix-brief" },
      () =>
        runFixBriefAgent({
          grounding: context,
          probeResult,
          mirrorProfile,
          evidenceBank,
        })
    );

    // M1 evidence contract, third tranche. Traces the model's raw
    // accepted output, before the grounding rewrite below — the trace
    // records what the model actually said, not what we corrected it to.
    await recordAnalysisTrace({
      projectId: input.projectId,
      stage: "fix-brief",
      provider: agent.provider,
      model: agent.model,
      usedMock: agent.usedMock,
      usedRetry: agent.usedRetry,
      latencyMs: agent.latencyMs,
      requestText: agent.requestText,
      responseValue: agent.output,
    });

    // The grounded values replace the model's on the returned output too:
    // a caller rendering `result.output` must not see causal prose or a
    // competitor list the stored evidence does not support.
    const groundedOutput = buildGroundedFixBriefOutput<FixBriefOutput>({
      agentOutput: agent.output,
      context,
      genericImpact: GENERIC_EXPECTED_IMPACT,
    });

    const status = statusFromOutput(agent.output);

    const rowInput: FixBriefRowInput = {
      gapId: gap.id,
      probeResultId: probeResult.id,
      // Assembled from stored evidence, never from model output. The model
      // has no way to introduce a competitor from another buyer question or
      // to assert a cause the scan did not observe.
      lostPrompt: groundedOutput.lostPrompt,
      competitorRecommended: groundedOutput.competitorRecommended,
      rootCause: groundedOutput.rootCause,
      recommendedFix: agent.output.recommendedFix,
      fixType: agent.output.fixType,
      assetsToGenerate: [...agent.output.assetsToGenerate],
      evidenceNeeded: [...agent.output.evidenceNeeded],
      evidenceAvailable: [...agent.output.evidenceAvailable],
      priority: agent.output.priority,
      expectedImpact: groundedOutput.expectedImpact,
      status,
    };

    const saved = await db.saveFixBrief(input.projectId, rowInput);

    return {
      ok: true,
      projectId: input.projectId,
      fixBrief: saved,
      output: groundedOutput,
      usedMock: agent.usedMock,
      usedRetry: agent.usedRetry,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      status: 500,
    };
  }
}
