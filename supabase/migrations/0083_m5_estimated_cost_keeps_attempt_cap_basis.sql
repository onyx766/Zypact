-- 0083 — An estimated call cost must not lower the per-protocol spend cap.
--
-- PR #2 records the cost of analysis (LLM) calls as cost_basis 'estimated'
-- (token counts x a price list), beside Perplexity's 'measured' cost. The
-- external-call ledger keeps the two apart. The attempt does not:
-- reconcile_attempt_for_job (0050) sets protocol_attempts.actual_cost_usd
-- to the sum of its calls' actual costs whenever none is null. Until PR #2
-- every analysis call was null, so every attempt stayed null, and the cap
-- in admit/reserve (0047, 0050, 0051) — sum(coalesce(pa.actual_cost_usd,
-- pa.reserved_cost_usd)) — counted each attempt at its RESERVATION. Once
-- estimates are written, an attempt would carry measured + estimated (about
-- $0.011 against a $0.04 reservation), and the cap would count that instead:
-- an estimate would lower the protected amount.
--
-- The change is one predicate. An attempt's actual_cost_usd is now set only
-- when EVERY terminal call's cost is MEASURED; a call that is unknown,
-- estimated, or carries any other basis leaves the attempt null, exactly as
-- an unknown cost already did. Consequences, each by construction:
--
--   * protocol_attempts.actual_cost_usd keeps its meaning — a provider-
--     measured total — and never holds an estimate or a reservation;
--   * the cap counts such an attempt at its reservation, its basis before
--     PR #2, so estimates cannot reduce it;
--   * the call-level ledger is untouched: measured, estimated and reserved
--     stay distinct in protocol_external_calls;
--   * failed, timed-out, cancelled and retried calls are handled exactly as
--     before (a null actual is still unknown), and the function's fencing,
--     terminal-state checks and idempotent ALREADY_RECONCILED path are
--     copied verbatim from 0050.
--
-- Everything below is 0050's definition and grants, character for
-- character, except that single bool_or(...) line;
-- scripts/test-m5-0083-schema-contract.ts asserts it.
--
-- Not changed: the cap functions themselves, any table, column, constraint
-- or row. Attempts already terminalized keep their stored value (all null
-- today, since no estimate has been written).
--
-- Order of release: apply this migration BEFORE any worker carrying PR #2
-- is deployed. A worker that writes estimates against 0050's roll-up would
-- produce exactly the attempts this migration exists to prevent.
--
-- Rollback: re-run section 12 of 0050 (reconcile_attempt_for_job and its
-- grants) verbatim. Safe only while no worker writes estimated costs.

create or replace function
  public.reconcile_attempt_for_job(
    p_job_id uuid,
    p_claim_token uuid,
    p_project_id uuid,
    p_attempt_id uuid,
    p_status text,
    p_termination_reason text default null
  )
returns table (
  status  text,
  attempt public.protocol_attempts
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  v_row public.protocol_attempts%rowtype;
  v_open_calls integer;
  v_has_unknown boolean;
  v_known_sum numeric;
  v_actual_cost_usd numeric;
begin
  if p_job_id is null or p_claim_token is null or p_project_id is null
     or p_attempt_id is null or p_status is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_reconcile_attempt_for_job_args';
  end if;

  if p_status not in ('completed', 'failed', 'timed_out', 'cancelled', 'excluded') then
    return query select 'INVALID_STATUS'::text, null::public.protocol_attempts;
    return;
  end if;

  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id
   for update;

  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_attempts;
    return;
  end if;

  if v_job.claim_token is distinct from p_claim_token
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= now()
     or v_job.status not in ('claimed', 'running') then
    return query select 'JOB_NOT_OWNED'::text, null::public.protocol_attempts;
    return;
  end if;

  select pa.* into v_row
    from public.protocol_attempts pa
   where pa.id = p_attempt_id and pa.project_id = p_project_id and pa.job_id = p_job_id
   for update;

  if not found then
    return query select 'ATTEMPT_NOT_OWNED_BY_JOB'::text, null::public.protocol_attempts;
    return;
  end if;

  if v_row.terminalized_at is not null then
    if v_row.status = p_status then
      return query select 'ALREADY_RECONCILED'::text, v_row;
    else
      return query select 'CONFLICT'::text, v_row;
    end if;
    return;
  end if;

  select count(*) into v_open_calls
    from public.protocol_external_calls ec
   where ec.protocol_attempt_id = p_attempt_id
     and ec.status in ('reserved', 'in_progress');

  if v_open_calls > 0 then
    return query select 'EXTERNAL_CALLS_NOT_TERMINAL'::text, v_row;
    return;
  end if;

  select
    bool_or(actual_cost_usd is null or cost_basis is distinct from 'measured'),
    coalesce(sum(actual_cost_usd) filter (where actual_cost_usd is not null), 0)
    into v_has_unknown, v_known_sum
    from public.protocol_external_calls ec
   where ec.protocol_attempt_id = p_attempt_id
     and ec.status in ('completed', 'failed', 'timed_out', 'cancelled');

  if coalesce(v_has_unknown, false) then
    v_actual_cost_usd := null;
  else
    v_actual_cost_usd := v_known_sum;
  end if;

  update public.protocol_attempts
     set status = p_status,
         actual_cost_usd = v_actual_cost_usd,
         termination_reason = p_termination_reason,
         terminalized_at = now(),
         last_activity_at = now()
   where id = p_attempt_id
     and project_id = p_project_id
     and terminalized_at is null
  returning * into v_row;

  return query select 'RECONCILED'::text, v_row;
end;
$$;

revoke all on function
  public.reconcile_attempt_for_job(uuid, uuid, uuid, uuid, text, text) from public;
revoke all on function
  public.reconcile_attempt_for_job(uuid, uuid, uuid, uuid, text, text) from anon;
revoke all on function
  public.reconcile_attempt_for_job(uuid, uuid, uuid, uuid, text, text) from authenticated;
grant execute on function
  public.reconcile_attempt_for_job(uuid, uuid, uuid, uuid, text, text) to service_role;
