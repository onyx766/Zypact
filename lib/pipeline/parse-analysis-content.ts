/**
 * D-027 (B0.2A-1) — network-free, single-attempt parse of an already
 * durable model answer (e.g. `analysis_call_receipts.raw_content`).
 *
 * This module imports NOTHING from `lib/llm/call-model.ts` or
 * `lib/llm/parse-json-or-retry.ts` — it cannot make an LLM call, and it
 * cannot trigger the legacy hidden repair round-trip, even by accident.
 * A future M5 worker must call this exactly once per raw_content and
 * must never treat a failure here as a reason to make a second LLM
 * call: repair goes through the SQL-fenced
 * mark_analysis_parse_failed_for_job / retry_analysis_generation_for_job
 * path (D-027), never a hidden re-parse-with-retry.
 *
 * The returned error is a bounded code only — no Zod message, no model
 * content, no raw excerpt — and nothing in this file logs anything.
 */

import type { ZodSchema } from "zod";
import { tryParseModelJson, type ModelJsonParseErrorCode } from "@/lib/llm/parse-model-json";

export type ParseAnalysisContentErrorCode = ModelJsonParseErrorCode;

export type ParseAnalysisContentResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ParseAnalysisContentErrorCode };

export function parseAnalysisContentOnce<T>(
  rawContent: string,
  schema: ZodSchema<T>,
  preNormalize?: (parsed: unknown) => unknown
): ParseAnalysisContentResult<T> {
  const result = tryParseModelJson(rawContent, schema, preNormalize);
  if (result.ok) {
    return { ok: true, data: result.data };
  }
  // result.detail (free-text JSON.parse/Zod message) is deliberately
  // discarded here — never returned, never logged.
  return { ok: false, code: result.code };
}
