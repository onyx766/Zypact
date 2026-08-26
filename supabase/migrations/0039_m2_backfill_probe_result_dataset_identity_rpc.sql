-- M2 tranche 2 — append-only backfill write path for probe_results
-- (D-015, approved commit b97e6629d9d308c29b2422d3dfd990ba5663051b).
--
-- Adds exactly one SECURITY DEFINER RPC. No table, column, or
-- constraint is created or altered by this migration. No data is
-- written by this migration itself — this is a schema-only addition
-- of a controlled write path, not a backfill.
--
-- probe_results has had UPDATE/DELETE/TRUNCATE revoked from
-- service_role since migration 0036 (append-only). This RPC is the
-- only path capable of writing dataset_id, dataset_source_type,
-- run_position, negative_claim_detected, and observation_schema_version
-- onto an existing probe_results row. service_role receives EXECUTE on
-- this function only — never UPDATE on the table itself. New rows
-- still set these five columns at INSERT time via the application's
-- normal saveProbeResult path, which is unaffected by the 0036 revoke
-- (INSERT was never revoked).
--
-- Return contract (D-015): always exactly one row, never an empty
-- set, so NOT_FOUND and CONFLICT stay distinguishable. status is one
-- of exactly four literal values:
--   APPLIED         — the five columns were all NULL and are now
--                      written to the requested values.
--   ALREADY_APPLIED — the five columns already matched the request
--                      exactly; no write performed.
--   NOT_FOUND       — no probe_results row for (id, project_id).
--   CONFLICT        — the row is neither all-NULL nor an exact match
--                      (including a partially-populated row); no
--                      write performed, no preexisting value is ever
--                      overwritten.
--
-- This migration is idempotent (CREATE OR REPLACE) — safe to re-run.
-- Does not touch the auth schema, does not change RLS, does not
-- modify migrations 0036, 0037, or 0038 in any way. Does not run any
-- backfill and does not write any row.

create or replace function
  public.backfill_probe_result_dataset_identity(
    p_probe_result_id uuid,
    p_project_id uuid,
    p_dataset_id uuid,
    p_dataset_source_type text,
    p_run_position text,
    p_negative_claim_detected boolean,
    p_observation_schema_version integer
  )
returns table (
  status text,          -- 'APPLIED' | 'ALREADY_APPLIED' | 'NOT_FOUND' | 'CONFLICT'
  probe_result public.probe_results
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_row public.probe_results%rowtype;
  v_batch public.dataset_batches%rowtype;
  v_matches boolean;
  v_all_null boolean;
begin
  if p_dataset_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_backfill_dataset_id';
  end if;

  if p_dataset_source_type is null
     or p_dataset_source_type not in (
       'snapshot_request', 'manual_scan', 'legacy_unresolved'
     ) then
    raise exception using
      errcode = '22023',
      message = 'invalid_backfill_dataset_source_type';
  end if;

  -- 1. lock the target probe_results row
  select pr.*
    into v_row
    from public.probe_results pr
   where pr.id = p_probe_result_id
     and pr.project_id = p_project_id
   for update;

  if not found then
    return query select 'NOT_FOUND'::text, null::public.probe_results;
    return;
  end if;

  -- 2. lock and validate the referenced dataset_batches row. A
  -- mismatch here is a programming error in the backfill script's
  -- classification, not a legitimate row state — it raises rather
  -- than returning one of the four statuses.
  select db.*
    into v_batch
    from public.dataset_batches db
   where db.id = p_dataset_id
   for update;

  if not found
     or v_batch.project_id <> p_project_id
     or v_batch.dataset_source_type <> p_dataset_source_type then
    raise exception using
      errcode = '22023',
      message = 'invalid_backfill_dataset_batch';
  end if;

  -- 3. compare the five target columns to the requested values. The
  -- probe_results row remains locked from step 1, so this comparison
  -- cannot be invalidated by a concurrent writer before the UPDATE
  -- below.
  v_matches :=
    v_row.dataset_id = p_dataset_id
    and v_row.dataset_source_type = p_dataset_source_type
    and v_row.run_position is not distinct from p_run_position
    and v_row.negative_claim_detected is not distinct from p_negative_claim_detected
    and v_row.observation_schema_version is not distinct from p_observation_schema_version;

  if v_matches then
    return query select 'ALREADY_APPLIED'::text, v_row;
    return;
  end if;

  v_all_null :=
    v_row.dataset_id is null
    and v_row.dataset_source_type is null
    and v_row.run_position is null
    and v_row.negative_claim_detected is null
    and v_row.observation_schema_version is null;

  if not v_all_null then
    -- Partially populated, or populated with different values.
    -- Never overwrite a preexisting value, whole or partial.
    return query select 'CONFLICT'::text, v_row;
    return;
  end if;

  -- 4. apply — the five columns were all NULL. The WHERE clause
  -- repeats the all-NULL precondition as a second, redundant guard.
  update public.probe_results
     set dataset_id = p_dataset_id,
         dataset_source_type = p_dataset_source_type,
         run_position = p_run_position,
         negative_claim_detected = p_negative_claim_detected,
         observation_schema_version = p_observation_schema_version
   where id = p_probe_result_id
     and project_id = p_project_id
     and dataset_id is null
     and dataset_source_type is null
     and run_position is null
     and negative_claim_detected is null
     and observation_schema_version is null
  returning * into v_row;

  return query select 'APPLIED'::text, v_row;
end;
$$;

revoke all on function
  public.backfill_probe_result_dataset_identity(
    uuid, uuid, uuid, text, text, boolean, integer
  )
from public;
revoke all on function
  public.backfill_probe_result_dataset_identity(
    uuid, uuid, uuid, text, text, boolean, integer
  )
from anon;
revoke all on function
  public.backfill_probe_result_dataset_identity(
    uuid, uuid, uuid, text, text, boolean, integer
  )
from authenticated;
grant execute on function
  public.backfill_probe_result_dataset_identity(
    uuid, uuid, uuid, text, text, boolean, integer
  )
to service_role;
