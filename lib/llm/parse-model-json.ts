/**
 * Pure JSON/Zod parsing helpers shared by the legacy repair-retry path
 * (lib/llm/parse-json-or-retry.ts) and the M5 network-free parser
 * (lib/pipeline/parse-analysis-content.ts).
 *
 * Zero imports of ./call-model or any networking module, anywhere in
 * this file — it cannot reach a provider even by accident. No logging
 * either: every function here is a pure, synchronous transform from a
 * string to a typed result.
 */

import type { ZodSchema } from "zod";

export type ModelJsonParseErrorCode =
  | "invalid_json"
  | "schema_validation_failed"
  | "normalization_failed";

export type ModelJsonParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ModelJsonParseErrorCode; detail: string };

/**
 * `detail` carries the free-text JSON.parse/Zod message for callers that
 * still need it (the legacy repair-prompt builder in
 * parse-json-or-retry.ts). The M5 parser (parse-analysis-content.ts)
 * deliberately discards `detail` and exposes only `code`.
 */
export function tryParseModelJson<T>(
  raw: string,
  schema: ZodSchema<T>,
  preNormalize?: (parsed: unknown) => unknown
): ModelJsonParseResult<T> {
  const cleaned = stripFences(raw);
  const candidate = extractJsonBlock(cleaned) ?? cleaned;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, code: "invalid_json", detail: `JSON.parse failed: ${msg}` };
  }

  let normalized: unknown;
  if (preNormalize) {
    try {
      normalized = preNormalize(parsed);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, code: "normalization_failed", detail: `preNormalize threw: ${msg}` };
    }
  } else {
    normalized = parsed;
  }

  const result = schema.safeParse(normalized);
  if (!result.success) {
    return {
      ok: false,
      code: "schema_validation_failed",
      detail: `Zod validation failed: ${result.error.message}`,
    };
  }
  return { ok: true, data: result.data };
}

export function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenceRegex = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
  const match = trimmed.match(fenceRegex);
  return match ? match[1].trim() : trimmed;
}

export function extractJsonBlock(raw: string): string | null {
  const firstBrace = raw.indexOf("{");
  const firstBracket = raw.indexOf("[");
  const start =
    firstBrace === -1
      ? firstBracket
      : firstBracket === -1
        ? firstBrace
        : Math.min(firstBrace, firstBracket);
  if (start === -1) return null;
  const openChar = raw[start];
  const closeChar = openChar === "{" ? "}" : "]";
  const end = raw.lastIndexOf(closeChar);
  if (end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}
