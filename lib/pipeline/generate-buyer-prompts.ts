import { runPromptMirrorAgent } from "@/lib/agents/prompt-mirror";
import { recordAnalysisTrace } from "@/lib/evidence/analysis-trace";
import { getDb } from "@/lib/db";
import type { GeneratedPrompt, GeneratedPromptInput } from "@/lib/db/types";
import {
  SiteReaderOutputSchema,
  type SiteReaderOutput,
} from "@/lib/schemas/site-reader.schema";
import type { PromptMirrorOutput } from "@/lib/schemas/prompt-mirror.schema";
import { selectCommercialProbePromptIds } from "@/lib/prompts/commercial-selection";
import { withPipelineStep } from "./save-pipeline-step";

/**
 * Sprint 2 pipeline runner.
 *
 * 1. Load the latest Mirror Profile for the project.
 * 2. Run Prompt Mirror Agent (mock branch if no LLM key).
 * 3. Persist the 50 generated prompts, marking those in `recommendedForProbe`
 *    as `selected = true`.
 *
 * Any prior generated prompts for the project are replaced.
 */

export interface GenerateBuyerPromptsInput {
  projectId: string;
  userInputs?: {
    category?: string;
    competitors?: string[];
    audience?: string[];
  };
}

export type GenerateBuyerPromptsResult =
  | {
      ok: true;
      projectId: string;
      stored: GeneratedPrompt[];
      output: PromptMirrorOutput;
      usedMock: boolean;
      usedRetry: boolean;
    }
  | { ok: false; error: string };

export async function generateBuyerPrompts(
  input: GenerateBuyerPromptsInput
): Promise<GenerateBuyerPromptsResult> {
  const db = getDb();
  const project = await db.getProject(input.projectId);
  if (!project) return { ok: false, error: "Project not found" };

  const mirrorRow = await db.getMirrorProfile(input.projectId);
  if (!mirrorRow) {
    return {
      ok: false,
      error: "No Mirror Profile found for this project. Run a Mirror Scan first.",
    };
  }
  const mirrorParse = SiteReaderOutputSchema.safeParse(mirrorRow.json);
  if (!mirrorParse.success) {
    return {
      ok: false,
      error: `Stored Mirror Profile failed schema validation: ${mirrorParse.error.message}`,
    };
  }
  const mirrorProfile: SiteReaderOutput = mirrorParse.data;

  try {
    const agent = await withPipelineStep(
      { projectId: input.projectId, agent: "prompt-mirror" },
      () =>
        runPromptMirrorAgent({
          mirrorProfile,
          userInputs: input.userInputs,
        })
    );

    // M1 evidence contract, third-tranche correction — prompt-mirror was
    // discovered during the call-site audit but missed in the initial
    // wiring pass. Now traced like the other five stages.
    await recordAnalysisTrace({
      projectId: input.projectId,
      stage: "prompt-mirror",
      provider: agent.provider,
      model: agent.model,
      usedMock: agent.usedMock,
      usedRetry: agent.usedRetry,
      latencyMs: agent.latencyMs,
      requestText: agent.requestText,
      responseValue: agent.output,
    });

    // Sprint 13C: do not let the model optimize only for winnability.
    // Probe sets must include commercial shortlist intents and de-duplicate
    // near-identical how-to prompts before anything can be scored.
    const guardedRecommendedIds = selectCommercialProbePromptIds(
      agent.output.prompts,
      agent.output.recommendedForProbe,
      { max: 20 },
    );
    const recommended = new Set(guardedRecommendedIds);
    const rows: GeneratedPromptInput[] = agent.output.prompts.map((p) => ({
      prompt: p.prompt,
      intentType: p.intentType,
      commercialValue: p.commercialValue,
      winnability: p.winnability,
      priority: p.priority,
      rationale: p.rationale,
      selected: recommended.has(p.id),
    }));

    const stored = await db.replaceGeneratedPrompts(input.projectId, rows);

    return {
      ok: true,
      projectId: input.projectId,
      stored,
      output: { ...agent.output, recommendedForProbe: guardedRecommendedIds },
      usedMock: agent.usedMock,
      usedRetry: agent.usedRetry,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
