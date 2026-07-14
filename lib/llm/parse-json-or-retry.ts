import type { ZodSchema } from "zod";
import { callModel, type CallModelInput } from "./call-model";

/**
 * Parse a model response as JSON and validate it with a Zod schema.
 *
 * Behavior:
 *  1. Strips ```json ... ``` fences if present.
 *  2. Extracts the first {...} or [...] block as a last resort.
 *  3. JSON.parse.
 *  4. Validates with the given Zod schema.
 *  5. If any step fails, calls the model ONCE more with a repair prompt
 *     that includes the previous output and the error, then re-validates.
 *  6. Returns a discriminated union — success or failed.
 */

export type ParseResult<T> =
  | { ok: true; data: T; usedRetry: boolean; usedMock: boolean }
  | { ok: false; error: string; rawOutput: string; usedRetry: boolean; usedMock: boolean };

export interface ParseJsonOrRetryInput<T> {
  schema: ZodSchema<T>;
  rawOutput: string;
  /** Original call inputs — used to build the repair call if we retry. */
  originalCall: CallModelInput;
  /** True by default. Set false to skip the repair round-trip. */
  allowRetry?: boolean;
  /**
   * Optional post-JSON.parse, pre-Zod hook. Use for cross-field
   * arithmetic identities that LLMs get wrong (e.g. "distance = sum of
   * sub-scores") — where the shape is right but a derived number is
   * mis-added. The hook must be idempotent and defensive: if the parsed
   * value isn't the expected shape, return it unchanged and let Zod
   * produce the real error. This does not weaken schemas — Zod still
   * validates every field after this runs.
   */
  preNormalize?: (parsed: unknown) => unknown;
}

export async function parseJsonOrRetry<T>(
  input: ParseJsonOrRetryInput<T>
): Promise<ParseResult<T>> {
  const allowRetry = input.allowRetry ?? true;

  const first = tryParse(input.rawOutput, input.schema, input.preNormalize);
  if (first.ok) {
    return { ok: true, data: first.data, usedRetry: false, usedMock: false };
  }
  if (!allowRetry) {
    return {
      ok: false,
      error: first.error,
      rawOutput: input.rawOutput,
      usedRetry: false,
      usedMock: false,
    };
  }

  logValidationRetry(first.error);

  const repairUser = [
    first.error.startsWith("Zod validation failed:")
      ? "Your previous output failed validation against the required schema."
      : "Your previous response could not be parsed as valid JSON matching the required schema.",
    "",
    "Error:",
    first.error,
    "",
    "Previous output:",
    "```",
    input.rawOutput,
    "```",
    "",
    "Return ONLY the corrected JSON. No prose. No markdown fences.",
  ].join("\n");

  const retry = await callModel({
    ...input.originalCall,
    user: `${input.originalCall.user}\n\n---\n${repairUser}`,
    // if we're in mock mode the repair call would loop; the mock branch
    // returns the same mockResponse — retry is still safe.
  });

  const second = tryParse(retry.content, input.schema, input.preNormalize);
  if (second.ok) {
    return { ok: true, data: second.data, usedRetry: true, usedMock: retry.usedMock };
  }
  return {
    ok: false,
    error: second.error,
    rawOutput: retry.content,
    usedRetry: true,
    usedMock: retry.usedMock,
  };
}

function logValidationRetry(error: string): void {
  // Never log raw model output or secrets here. The error summary is capped
  // and contains only parser/Zod messages.
  const safeError = error.replace(/\s+/g, " ").slice(0, 500);
  console.warn(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "warn",
      event: "llm_output_validation_retry",
      error: safeError,
    })
  );
}

function tryParse<T>(
  raw: string,
  schema: ZodSchema<T>,
  preNormalize?: (parsed: unknown) => unknown
): { ok: true; data: T } | { ok: false; error: string } {
  const cleaned = stripFences(raw);
  const candidate = extractJsonBlock(cleaned) ?? cleaned;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `JSON.parse failed: ${msg}` };
  }
  const normalized = preNormalize ? preNormalize(parsed) : parsed;
  const result = schema.safeParse(normalized);
  if (!result.success) {
    return { ok: false, error: `Zod validation failed: ${result.error.message}` };
  }
  return { ok: true, data: result.data };
}

function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenceRegex = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
  const match = trimmed.match(fenceRegex);
  return match ? match[1].trim() : trimmed;
}

function extractJsonBlock(raw: string): string | null {
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
