import { runQaAgent } from "@/lib/agents/qa-agent";
import { recordAnalysisTrace } from "@/lib/evidence/analysis-trace";
import { getDb } from "@/lib/db";
import type { GeneratedAssetRow, QaReportRow } from "@/lib/db/types";
import { hasUsableEvidenceBank } from "@/lib/evidence-bank/has-usable-evidence-bank";
import {
  buildAllowedUrlSet,
  detectAssetTypeConformity,
  detectEvidenceBankProvenanceCeiling,
  detectFabricatedUrls,
  detectUnsupportedCompetitorClaims,
  mergeQaViolations,
} from "@/lib/qa/deterministic-checks";
import {
  EvidenceBankOutputSchema,
  type EvidenceBankOutput,
} from "@/lib/schemas/evidence-bank.schema";
import {
  SiteReaderOutputSchema,
  type SiteReaderOutput,
} from "@/lib/schemas/site-reader.schema";
import type { QaAgentOutput, QaVerdict } from "@/lib/schemas/qa-agent.schema";
import { withPipelineStep } from "./save-pipeline-step";

/**
 * Sprint 9 pipeline runner — QA Agent.
 *
 * Loads the target asset, the latest Mirror Profile, and the Evidence
 * Bank (with the standard usability guard), runs the QA Agent, saves a
 * `QaReport` row, and updates `GeneratedAsset.qa_status` from the verdict.
 *
 * Guard messages (exported so the API route can promote them to HTTP 409
 * and the UI can print the exact string):
 *  - EVIDENCE_BANK_REQUIRED_MESSAGE
 *  - ASSET_NOT_FOUND_MESSAGE
 *  - ASSET_NOT_IN_PROJECT_MESSAGE
 */

export const EVIDENCE_BANK_REQUIRED_MESSAGE =
  "Prepare the Evidence Bank before running QA.";

export const ASSET_NOT_FOUND_MESSAGE = "Generated asset not found.";

export const ASSET_NOT_IN_PROJECT_MESSAGE =
  "The requested asset does not belong to this project.";

const VERDICT_TO_QA_STATUS: Record<QaVerdict, string> = {
  safe_to_publish: "safe_to_publish",
  needs_evidence: "needs_evidence",
  unsupported_claims: "unsupported_claims",
};

const QA_FAILED_STATUS = "qa_failed";

export interface RunQaInput {
  projectId: string;
  assetId: string;
}

export type RunQaResult =
  | {
      ok: true;
      projectId: string;
      qaReport: QaReportRow;
      updatedAsset: GeneratedAssetRow;
      output: QaAgentOutput;
      usedMock: boolean;
      usedRetry: boolean;
    }
  | { ok: false; error: string; status?: number };

export async function runQa(input: RunQaInput): Promise<RunQaResult> {
  const db = getDb();

  const project = await db.getProject(input.projectId);
  if (!project) return { ok: false, error: "Project not found", status: 404 };

  const asset = await db.getGeneratedAsset(input.assetId);
  if (!asset) {
    return { ok: false, error: ASSET_NOT_FOUND_MESSAGE, status: 404 };
  }
  if (asset.projectId !== input.projectId) {
    return {
      ok: false,
      error: ASSET_NOT_IN_PROJECT_MESSAGE,
      status: 400,
    };
  }

  const mirrorRow = await db.getMirrorProfile(input.projectId);
  if (!mirrorRow) {
    return {
      ok: false,
      error:
        "No Mirror Profile found for this project. Run a Mirror Scan first.",
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
        agent: "qa",
        meta: { assetId: asset.id, assetType: asset.assetType },
      },
      () =>
        runQaAgent({
          asset,
          evidenceBank,
          mirrorProfile,
        }),
    );

    // M1 evidence contract, third tranche. Traces the model's raw
    // accepted output, before the deterministic QA layers below merge in.
    await recordAnalysisTrace({
      projectId: input.projectId,
      stage: "qa",
      provider: agent.provider,
      model: agent.model,
      usedMock: agent.usedMock,
      usedRetry: agent.usedRetry,
      latencyMs: agent.latencyMs,
      requestText: agent.requestText,
      responseValue: agent.output,
    });

    // Sprint 12 — merge deterministic QA findings before we persist.
    //
    // These layers do NOT overwrite LLM findings; they are appended
    // (deduplicated by `(type, quote)`) and the verdict is recomputed
    // from the combined set. Both layers use the schema-approved
    // `QaViolation` shape so the persisted `QaReport` still passes
    // `QaViolationSchema`.
    const fixBriefs = await db.getFixBriefsByProject(input.projectId);
    const competitors = await db.getCompetitorsByProject(input.projectId);
    const probeResults = await db.getProbeResultsByProject(input.projectId);
    const allowedUrls = buildAllowedUrlSet({
      evidenceBank: bankRow,
      mirrorProfile: mirrorRow,
      fixBriefs,
      projectDomain: project.domain,
    });
    const fabricatedUrlViolations = detectFabricatedUrls(asset, allowedUrls);
    const conformityViolations = detectAssetTypeConformity({
      asset,
      evidenceBank: bankRow,
    });
    const competitorClaimViolations = detectUnsupportedCompetitorClaims({
      asset,
      evidenceBank: bankRow,
      competitors,
      fixBriefs,
      probeResults,
    });
    const provenanceViolations = detectEvidenceBankProvenanceCeiling(bankRow);
    const deterministic = [
      ...fabricatedUrlViolations,
      ...conformityViolations,
      ...competitorClaimViolations,
      ...provenanceViolations,
    ];
    const mergedOutput = mergeQaViolations(agent.output, deterministic, {
      evidenceBank: bankRow,
      mirrorProfile: mirrorRow,
    });

    const qaReport = await db.saveQaReport(input.projectId, {
      generatedAssetId: asset.id,
      verdict: mergedOutput.verdict,
      violations: mergedOutput.violations.map((v) => ({
        type: v.type,
        quote: v.quote,
        reason: v.reason,
        suggestedFix: v.suggestedFix,
      })),
      placeholdersRemaining: [...mergedOutput.placeholdersRemaining],
      overallNotes: mergedOutput.overallNotes,
    });

    const nextStatus = VERDICT_TO_QA_STATUS[mergedOutput.verdict];
    const updatedAsset = (await db.updateGeneratedAssetQaStatus(
      asset.id,
      nextStatus,
    )) ?? {
      ...asset,
      qaStatus: nextStatus,
    };

    return {
      ok: true,
      projectId: input.projectId,
      qaReport,
      updatedAsset,
      output: mergedOutput,
      usedMock: agent.usedMock,
      usedRetry: agent.usedRetry,
    };
  } catch (err) {
    // Sprint 12.1 — fail closed but not silently. If QA cannot complete
    // even after retry/normalization, the asset becomes explicitly
    // non-publishable instead of lingering as `pending_qa`.
    try {
      await db.updateGeneratedAssetQaStatus(asset.id, QA_FAILED_STATUS);
    } catch {
      // Preserve the original failure; a status-update failure should not
      // hide the model/validation error that caused QA to fail.
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      status: 500,
    };
  }
}
