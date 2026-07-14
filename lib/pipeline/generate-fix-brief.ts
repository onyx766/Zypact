import { runFixBriefAgent } from "@/lib/agents/fix-agent";
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

export const GAP_NOT_FOUND_MESSAGE =
  "Gap not found for this project.";

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

/**
 * Prefer a ProbeResult whose generatedPromptId is in `gap.affectedPrompts`,
 * with a lost/partial verdict when available. Falls back to the latest
 * lost/partial ProbeResult on the project. Returns `null` when nothing on
 * the project qualifies (the pipeline surfaces this as NO_LOST_PROBE).
 */
function findProbeResultForGap(
  affectedPrompts: string[],
  probeResults: ProbeResult[]
): ProbeResult | null {
  const affected = new Set(affectedPrompts);
  const sorted = [...probeResults].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );

  const matchesGap = sorted.filter(
    (r) => r.generatedPromptId && affected.has(r.generatedPromptId)
  );
  const lostFirst = (list: ProbeResult[]) => [
    ...list.filter((r) => r.verdict === "lost" || r.verdict === "partial"),
    ...list.filter((r) => r.verdict !== "lost" && r.verdict !== "partial"),
  ];

  const bestGapMatch = lostFirst(matchesGap)[0];
  if (bestGapMatch) return bestGapMatch;

  // Fallback: latest lost/partial anywhere on the project.
  const anyLost = sorted.find(
    (r) => r.verdict === "lost" || r.verdict === "partial"
  );
  return anyLost ?? null;
}

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
  const probeResult = findProbeResultForGap(gap.affectedPrompts, probeResults);
  if (!probeResult) {
    return { ok: false, error: NO_LOST_PROBE_MESSAGE, status: 409 };
  }

  try {
    const agent = await withPipelineStep(
      { projectId: input.projectId, agent: "fix-brief" },
      () =>
        runFixBriefAgent({
          gap,
          probeResult,
          mirrorProfile,
          evidenceBank,
        })
    );

    const status = statusFromOutput(agent.output);

    const rowInput: FixBriefRowInput = {
      gapId: gap.id,
      probeResultId: probeResult.id,
      lostPrompt: agent.output.lostPrompt,
      competitorRecommended: agent.output.competitorRecommended,
      rootCause: agent.output.rootCause,
      recommendedFix: agent.output.recommendedFix,
      fixType: agent.output.fixType,
      assetsToGenerate: [...agent.output.assetsToGenerate],
      evidenceNeeded: [...agent.output.evidenceNeeded],
      evidenceAvailable: [...agent.output.evidenceAvailable],
      priority: agent.output.priority,
      expectedImpact: agent.output.expectedImpact,
      status,
    };

    const saved = await db.saveFixBrief(input.projectId, rowInput);

    return {
      ok: true,
      projectId: input.projectId,
      fixBrief: saved,
      output: agent.output,
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
