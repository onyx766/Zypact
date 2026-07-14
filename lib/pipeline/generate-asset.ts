import { runGenerateAssetAgent } from "@/lib/agents/fix-agent";
import { getDb } from "@/lib/db";
import type { GeneratedAssetRow, GeneratedAssetRowInput } from "@/lib/db/types";
import { hasUsableEvidenceBank } from "@/lib/evidence-bank/has-usable-evidence-bank";
import {
  EvidenceBankOutputSchema,
  type EvidenceBankOutput,
} from "@/lib/schemas/evidence-bank.schema";
import {
  SiteReaderOutputSchema,
  type SiteReaderOutput,
} from "@/lib/schemas/site-reader.schema";
import {
  AssetTypeSchema,
  type AssetTypeValue,
  type GeneratedAssetOutput,
} from "@/lib/schemas/generated-asset.schema";
import { withPipelineStep } from "./save-pipeline-step";

/**
 * Sprint 8 pipeline runner — Generated Asset (`generate_asset` mode only).
 *
 * Guard messages (exported so the API route can promote them to HTTP 409
 * and the UI can print the exact string):
 *  - EVIDENCE_BANK_REQUIRED_MESSAGE
 *  - FIX_BRIEF_REQUIRED_MESSAGE
 */

export const EVIDENCE_BANK_REQUIRED_MESSAGE =
  "Prepare the Evidence Bank before generating assets.";

export const FIX_BRIEF_REQUIRED_MESSAGE =
  "Generate a Fix Brief before generating assets.";

export interface GenerateAssetInput {
  projectId: string;
  fixBriefId: string;
  assetType: AssetTypeValue | string;
}

export type GenerateAssetResult =
  | {
      ok: true;
      projectId: string;
      asset: GeneratedAssetRow;
      output: GeneratedAssetOutput;
      usedMock: boolean;
      usedRetry: boolean;
    }
  | { ok: false; error: string; status?: number };

export async function generateAsset(
  input: GenerateAssetInput
): Promise<GenerateAssetResult> {
  const db = getDb();

  const project = await db.getProject(input.projectId);
  if (!project) return { ok: false, error: "Project not found", status: 404 };

  // Validate the requested asset type up front so a bad payload never causes
  // us to fetch prerequisites unnecessarily.
  const parsedAssetType = AssetTypeSchema.safeParse(input.assetType);
  if (!parsedAssetType.success) {
    return {
      ok: false,
      error: `Invalid assetType. Expected one of: ${AssetTypeSchema.options.join(", ")}`,
      status: 400,
    };
  }
  const assetType: AssetTypeValue = parsedAssetType.data;

  const fixBrief = await db.getFixBrief(input.fixBriefId);
  if (!fixBrief || fixBrief.projectId !== input.projectId) {
    return {
      ok: false,
      error: FIX_BRIEF_REQUIRED_MESSAGE,
      status: 409,
    };
  }

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

  try {
    const agent = await withPipelineStep(
      {
        projectId: input.projectId,
        agent: "generate-asset",
        meta: { fixBriefId: fixBrief.id, assetType },
      },
      () =>
        runGenerateAssetAgent({
          fixBrief,
          evidenceBank,
          mirrorProfile,
          assetType,
        })
    );

    // Sprint 8 always saves with pending_qa. The QA Agent (out of scope)
    // will move it to safe_to_publish / needs_evidence / unsupported_claims.
    const rowInput: GeneratedAssetRowInput = {
      fixBriefId: fixBrief.id,
      assetType: agent.output.assetType,
      title: agent.output.title,
      content: agent.output.content,
      placeholders: [...agent.output.placeholders],
      claimsUsed: agent.output.claimsUsed.map((c) => ({
        claim: c.claim,
        source: c.source,
      })),
      qaStatus: "pending_qa",
      generationProvider: agent.generationProvider,
      generationModel: agent.generationModel,
    };
    const saved = await db.saveGeneratedAsset(input.projectId, rowInput);

    return {
      ok: true,
      projectId: input.projectId,
      asset: saved,
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
