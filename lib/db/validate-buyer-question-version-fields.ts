/**
 * Shared runtime validation for `buyer_question_versions`' integer-scale
 * fields, enforced identically by the memory adapter and the Supabase
 * adapter's `createBuyerQuestionVersion` — the single source of truth
 * for this contract, never duplicated or re-derived per adapter.
 *
 * Canonical contract (matches the `integer` columns declared in
 * migration 0047, unchanged):
 *   - commercialValue: integer, 1..5
 *   - winnability: integer, 1..5
 *   - priority: integer, 1..25
 *
 * Found via a real staging incident: a `0.7`/`0.5` float fixture was
 * rejected by Postgres's `commercial_value integer`/`winnability
 * integer` columns (error 22P02), but only AFTER a `dataset_batches`
 * row and a `buyer_questions` row had already been created by the same
 * script — leaving two orphaned, harmless residue rows behind. This
 * validation must run before ANY of those earlier writes, not only
 * inside `createBuyerQuestionVersion` itself, so an invalid version
 * input is caught before a single row exists anywhere. Orchestration
 * code that plans to call `createBuyerQuestionVersion` must call this
 * function FIRST — before `createDatasetBatch`, before
 * `createBuyerQuestion`, before anything else.
 */

export interface BuyerQuestionVersionNumericFields {
  commercialValue: number;
  winnability: number;
  priority: number;
}

function isValidInteger(value: number, min: number, max: number): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/**
 * Throws with a specific, field-named message on the first violation
 * found (commercialValue, then winnability, then priority) — never
 * silently coerces (no rounding, no truncation) and never lets an
 * out-of-contract value reach a database write.
 */
export function validateBuyerQuestionVersionNumericFields(
  fields: BuyerQuestionVersionNumericFields
): void {
  if (!isValidInteger(fields.commercialValue, 1, 5)) {
    throw new Error(
      `invalid_commercial_value: must be an integer 1..5, got ${JSON.stringify(fields.commercialValue)}`
    );
  }
  if (!isValidInteger(fields.winnability, 1, 5)) {
    throw new Error(
      `invalid_winnability: must be an integer 1..5, got ${JSON.stringify(fields.winnability)}`
    );
  }
  if (!isValidInteger(fields.priority, 1, 25)) {
    throw new Error(
      `invalid_priority: must be an integer 1..25, got ${JSON.stringify(fields.priority)}`
    );
  }
}
