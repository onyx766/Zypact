import type { ZodSchema } from "zod";
import { callModel, type CallModelInput } from "./call-model";
import { tryParseModelJson, type ModelJsonParseErrorCode } from "./parse-model-json";

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
 *
 * This is the LEGACY path only (its own hidden repair call is the whole
 * point). The M5 path uses `lib/pipeline/parse-analysis-content.ts`
 * instead, which never imports this file or `./call-model`.
 */

export type ParseResult<T> =
  | { ok: true; data: T; usedRetry: boolean; usedMock: boolean }
  | {
      ok: false;
      error: string;
      /**
       * D-027 (B0.2A-1) — bounded code alongside the existing free-text
       * `error`, added purely additively so every pre-existing caller
       * reading `.error`/`.rawOutput` is unaffected. Reflects whichever
       * parse attempt (first or, if retried, the repair) ultimately
       * failed.
       */
      code: ModelJsonParseErrorCode;
      rawOutput: string;
      usedRetry: boolean;
      usedMock: boolean;
    };

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

  const first = tryParseModelJson(input.rawOutput, input.schema, input.preNormalize);
  if (first.ok) {
    return { ok: true, data: first.data, usedRetry: false, usedMock: false };
  }
  if (!allowRetry) {
    return {
      ok: false,
      error: first.detail,
      code: first.code,
      rawOutput: input.rawOutput,
      usedRetry: false,
      usedMock: false,
    };
  }

  logValidationRetry(first.code);

  const repairUser = [
    first.code === "schema_validation_failed"
      ? "Your previous output failed validation against the required schema."
      : "Your previous response could not be parsed as valid JSON matching the required schema.",
    "",
    "Error:",
    first.detail,
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

  const second = tryParseModelJson(retry.content, input.schema, input.preNormalize);
  if (second.ok) {
    return { ok: true, data: second.data, usedRetry: true, usedMock: retry.usedMock };
  }
  return {
    ok: false,
    error: second.detail,
    code: second.code,
    rawOutput: retry.content,
    usedRetry: true,
    usedMock: retry.usedMock,
  };
}

function logValidationRetry(code: ModelJsonParseErrorCode): void {
  // D-027 (B0.2A-1) — bounded code only. Never the free-text Zod/JSON
  // message (which could echo fragments of the received value for some
  // schemas) and never raw model output.
  console.warn(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "warn",
      event: "llm_output_validation_retry",
      code,
    })
  );
}
