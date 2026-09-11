-- One-off repair: record the measured Perplexity cost for calls made
-- before the worker started sending it.
--
-- Context. `record_provider_call_receipt_for_job` (0050, amended 0052) has
-- always accepted `p_actual_cost_usd` / `p_cost_basis`, and the adapter has
-- always forwarded them, but lib/protocol-worker/execute-job.ts never
-- supplied either. Every Perplexity call therefore terminalised with
-- `actual_cost_usd = NULL` and `cost_basis = NULL` — the legal `unknown`
-- state 0050 describes, not a corrupt one. The worker now reads
-- `usage.cost.total_cost` from the same body it persists as the receipt
-- and sends it as `measured`; this repairs the rows that predate that.
--
-- Why `measured` is the correct basis, and why this is not an estimate:
-- the number is Perplexity's own accounting of what it charged, carried in
-- the response body. Nothing here multiplies tokens by a rate, so there is
-- no price table in play and no way for this value to drift from the
-- invoice. `estimated` would be the wrong label and would misrepresent a
-- reported figure as a derived one.
--
-- The reservation is never used as a substitute. Rows whose receipt does
-- not yield a usable number are left exactly as they are — still `unknown`
-- — because 0050 forbids copying `reserved_cost_usd` into
-- `actual_cost_usd`, and an honest unknown is the state the schema models
-- for precisely this case.
--
-- Scope, deliberately narrow. Only rows that are all of:
--   * call_kind = 'perplexity' — the analysis leg is untouched. OpenAI
--     reports no cost and `analysis_call_receipts` stores only
--     `raw_content`, not the response envelope, so its token usage was
--     never captured and no honest figure can be reconstructed. Those rows
--     stay `unknown` by decision, not by oversight.
--   * actual_cost_usd is null — a row that already carries a cost is never
--     rewritten, so re-running this is a no-op.
--   * backed by a provider_call_receipts row with outcome = 'success' — a
--     failed or unknown-outcome call has no reported cost to read, and an
--     error body carries none.
--   * whose raw_response_body is valid JSON exposing a non-negative
--     numeric usage.cost.total_cost. `pg_input_is_valid` (PG16+) guards
--     the cast so a non-JSON body cannot raise and abort the migration.
--
-- The guards mirror lib/protocol-worker/worker.ts
-- `measuredCostUsdFromRawResponseBody` one for one, so a row repaired here
-- carries the same value the worker would now write for that same body.
-- Its totality is covered by scripts/test-measured-perplexity-cost.ts.
--
-- Recovery. Forward-only and idempotent. To undo, null both columns back
-- out for the affected rows; the pair constraint
-- `protocol_external_calls_cost_basis_pair_check` requires they move
-- together in either direction.

update public.protocol_external_calls c
   set actual_cost_usd = (
         (r.raw_response_body::jsonb) -> 'usage' -> 'cost' ->> 'total_cost'
       )::numeric,
       cost_basis = 'measured'
  from public.provider_call_receipts r
 where r.external_call_id = c.id
   and c.call_kind = 'perplexity'
   and c.actual_cost_usd is null
   and r.outcome = 'success'
   and r.raw_response_body is not null
   and pg_input_is_valid(r.raw_response_body, 'jsonb')
   and jsonb_typeof((r.raw_response_body::jsonb) -> 'usage' -> 'cost' -> 'total_cost') = 'number'
   and (
         (r.raw_response_body::jsonb) -> 'usage' -> 'cost' ->> 'total_cost'
       )::numeric >= 0;
