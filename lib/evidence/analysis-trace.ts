import { getDb } from "@/lib/db";
import type { AnalysisLlmCall, AnalysisLlmCallInput } from "@/lib/db/types";
import { sha256Hex } from "@/lib/evidence/hash";

/**
 * M1 evidence contract, third tranche — shared wiring for
 * `db.recordAnalysisLlmCall`, used by every pipeline stage that calls the
 * internal analysis model (Mirror Profile, Competitor Discovery, Gap Map,
 * Fix Brief, Generated Asset, QA). Kept in one place so every stage hashes
 * request/response the same way instead of six slightly different
 * inline implementations.
 */
export interface RecordAnalysisTraceInput {
  projectId: string;
  stage: string;
  provider: AnalysisLlmCallInput["provider"];
  model: string;
  usedMock: boolean;
  usedRetry: boolean;
  latencyMs: number;
  requestText: string;
  responseValue: unknown;
}

export async function recordAnalysisTrace(
  input: RecordAnalysisTraceInput
): Promise<AnalysisLlmCall> {
  return getDb().recordAnalysisLlmCall({
    projectId: input.projectId,
    stage: input.stage,
    provider: input.provider,
    model: input.model,
    usedMock: input.usedMock,
    usedRetry: input.usedRetry,
    latencyMs: input.latencyMs,
    requestSha256: sha256Hex(input.requestText),
    responseSha256: sha256Hex(JSON.stringify(input.responseValue)),
  });
}
