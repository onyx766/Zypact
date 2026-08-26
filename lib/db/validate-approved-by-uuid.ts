/**
 * Shared runtime validation for `approved_by` — enforced identically by
 * the memory adapter and the Supabase adapter's `approveBuyerQuestionVersion`
 * and `approveProtocol`, the single source of truth for this contract.
 *
 * `buyer_question_versions.approved_by` and `protocols.approved_by` are
 * both bare `uuid null` columns (migration 0047) with NO foreign key to
 * `auth.users`, `projects.user_id`, or any other table — confirmed by
 * reading both the migration text and the live staging schema
 * (pg_constraint has zero `contype = 'f'` rows touching either
 * column). Nothing in the schema itself can catch a non-UUID
 * `approvedBy`; only Postgres's bare `uuid` type check does, and only
 * AFTER a write has already been attempted.
 *
 * Found via a real staging incident: a synthetic test fixture passed
 * `"staging-smoke-test@zypact.test"` (an email) as `approvedBy`. It was
 * rejected by Postgres (error 22P02, invalid input syntax for type
 * uuid) — but only after a `dataset_batches` row, a `buyer_questions`
 * row, and a `buyer_question_versions` row had already been created by
 * the same script, leaving three orphaned residue rows behind. This
 * validation must run before ANY of those earlier writes — orchestration
 * code that plans to call `approveBuyerQuestionVersion`/`approveProtocol`
 * must validate the `approvedBy` value FIRST, before `createDatasetBatch`,
 * before `createBuyerQuestion`, before anything else — exactly the same
 * discipline as `validateBuyerQuestionVersionNumericFields`.
 *
 * This never invents a fake approver for a production path: it only
 * validates the SHAPE of whatever `approvedBy` the caller already
 * decided to use. Picking which UUID to use — a real user id where one
 * genuinely exists, or a fixed, explicitly-named synthetic test-actor
 * UUID for a synthetic fixture that has none — remains the caller's
 * decision.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string): boolean {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

/**
 * Throws with a clear message (never leaking the rejected value's
 * shape beyond what's needed to diagnose it) when `approvedBy` is not
 * a well-formed UUID string. Never silently coerces, truncates, or
 * generates a substitute value.
 */
export function validateApprovedByUuid(approvedBy: string): void {
  if (!isValidUuid(approvedBy)) {
    throw new Error(
      `invalid_approved_by: must be a UUID string, got ${JSON.stringify(approvedBy)}`
    );
  }
}
