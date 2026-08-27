/**
 * M1-A — the contractual joint between the D-027 two-phase transport and
 * the M5 analysis-call receipt.
 *
 * Before this module, `prepareCallModelRequest` produced the exact
 * outbound body (`rawRequestBody`) and its hash (`requestSha256`), and
 * `recordAnalysisCallReceiptForJob` accepted `rawRequestBody` /
 * `requestSha256` — but nothing connected the two. The producer was
 * reached only from a contract test; the consumer was reached from no
 * production code at all. A body was therefore produced, sent, and then
 * discarded, exactly as on the legacy Perplexity path before M1-A.
 *
 * This module is that missing link, and deliberately nothing more:
 *
 *   - it does NOT call a provider;
 *   - it does NOT claim, execute, or complete a job;
 *   - it does NOT open a route or start a worker;
 *   - it does NOT re-serialize anything.
 *
 * It takes the already-prepared request and returns the receipt fields
 * that carry it, passing the SAME string reference through. The identity
 * assertion below is the contract: if the caller ever hands over a
 * prepared request whose hash does not cover its own body, this throws
 * rather than writing unfalsifiable evidence.
 *
 * A future M5 worker calls `analysisCallReceiptRequestFields(prepared)`
 * and spreads the result into its `recordAnalysisCallReceiptForJob`
 * input. Nothing here needs to change for that to happen.
 */

import { sha256Hex } from "@/lib/evidence/hash";
import type { PreparedCallModelRequest } from "@/lib/llm/call-model";

/**
 * The request-side evidence fields of an analysis-call receipt.
 *
 * Both fields are always set together, or both are null for a mock call
 * — the SQL contract in migration 0053
 * (`analysis_call_receipts_request_mock_pairing_check`) enforces exactly
 * that pairing, and `used_mock` selects which side applies.
 */
export interface AnalysisCallReceiptRequestFields {
  readonly rawRequestBody: string | null;
  readonly requestSha256: string | null;
  readonly usedMock: boolean;
}

/**
 * Real-provider case: carry the prepared body through unchanged.
 *
 * `rawRequestBody` is the very string `prepareCallModelRequest`
 * serialized and that `callModel` writes to the wire — the same
 * reference, never a copy re-derived from a parsed object. Re-serializing
 * would be silently lossy: key order, spacing, and Unicode escaping are
 * all `JSON.stringify` implementation detail, and a second call is not
 * guaranteed to reproduce the first byte-for-byte once any value passes
 * through a parse cycle.
 */
export function analysisCallReceiptRequestFields(
  prepared: Pick<PreparedCallModelRequest, "rawRequestBody" | "requestSha256">
): AnalysisCallReceiptRequestFields {
  const { rawRequestBody, requestSha256 } = prepared;

  if (typeof rawRequestBody !== "string" || rawRequestBody.length === 0) {
    throw new Error(
      "analysisCallReceiptRequestFields: prepared.rawRequestBody must be a non-empty string"
    );
  }
  if (typeof requestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(requestSha256)) {
    throw new Error(
      "analysisCallReceiptRequestFields: prepared.requestSha256 must be a 64-char lowercase hex digest"
    );
  }

  // The whole point of the module. A hash that does not cover the body it
  // travels with is worse than no hash: it looks like verification.
  const recomputed = sha256Hex(rawRequestBody);
  if (recomputed !== requestSha256) {
    throw new Error(
      "analysisCallReceiptRequestFields: requestSha256 does not match sha256(rawRequestBody)"
    );
  }

  return { rawRequestBody, requestSha256, usedMock: false };
}

/**
 * Mock case: no outbound body exists, so none is invented.
 *
 * Returning empty strings or a hash of "" here would let a mock run look
 * like a captured one. The SQL contract rejects that shape outright; this
 * function refuses to construct it in the first place.
 */
export function mockAnalysisCallReceiptRequestFields(): AnalysisCallReceiptRequestFields {
  return { rawRequestBody: null, requestSha256: null, usedMock: true };
}
