-- M5 Phase 3D — post-claim verification (D-031).
--
-- D-031 requires that, after CLAIMED and before `admitAndReserveAttemptForJob`,
-- any reservation, any spend or any provider transport, a read-only check
-- confirm that the claimed job carries no prior external call, reservation,
-- probe run or receipt, that it still belongs to the returned claim token and
-- worker, and that its project, protocol and admissibility still match.
--
-- `get_protocol_execution_job_context` cannot serve as that proof. It loads
-- `current_attempt` only when `job.current_attempt_id` is not null, and scopes
-- external calls and receipts to that one attempt. A job whose earlier attempt
-- was closed — leaving `current_attempt_id` null while the attempt, its calls
-- and its receipts remain on record — reads as pristine through that context
-- and is not. A canary that trusted it could spend on a job that already has
-- paid history.
--
-- This function therefore walks the WHOLE history of the job, by
-- `protocol_attempts.job_id`, never by the current attempt:
--
--   attempts        protocol_attempts        by job_id
--   external calls  protocol_external_calls  by protocol_attempt_id
--   receipts        provider_call_receipts / analysis_call_receipts
--                                            by external_call_id
--   probe runs      protocol_attempts.probe_run_id
--   probe results   probe_results            by probe_run_id
--
-- Said precisely: the attempt row is the gate. Every other source above is
-- reachable only through it — calls reference an attempt, receipts reference a
-- call, and probe runs and results hang off the attempt's probe_run_id — so a
-- job with any of them necessarily has an attempt. Counting all six is
-- therefore defence in depth against evidence that outlived its attempt row, a
-- state ordinary operation cannot produce, and it costs one query.
--
-- It is STABLE and strictly read-only: no INSERT, UPDATE, DELETE or MERGE, no
-- call to any other routine, no lock, and no sweep of any other job.
--
-- STABLE carries part of that, but not all of it, and the difference matters.
-- PostgreSQL does refuse a data-modifying statement written directly inside a
-- non-VOLATILE function; that much the engine enforces. What it does not do is
-- stop a STABLE function from CALLING a VOLATILE function that writes — the
-- restriction is checked at the statement, not across the call graph. STABLE
-- therefore closes the direct door only, and the closed call list this body
-- keeps — btrim, count and now, and nothing else — is what closes the other
-- one. Both are asserted mechanically by scripts/test-m5-0060-schema-
-- contract.ts, which reads this body and refuses any further call, qualified
-- or not, as well as PERFORM, CALL and EXECUTE.
--
-- It returns one closed label and nothing else. No job row, no identifier, no
-- token, no counter and no free-text detail leaves this function: a verifier
-- that leaked what it inspected would become a way to read a tenant's state
-- through an outcome string.
--
-- No table, column, constraint, index, trigger or RLS policy is created or
-- altered, and no existing function is modified, dropped or overloaded.

create or replace function
  public.verify_phase3d_canary_post_claim(
    p_worker_id text,
    p_job_id uuid,
    p_project_id uuid,
    p_claim_token uuid
  )
returns table (
  outcome text
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  v_found boolean := false;
  v_protocol_ok boolean := false;
  v_history integer := 0;
begin
  -- Argument guards, in the shape this ledger already uses. The message names
  -- the function and nothing else: no argument value is ever echoed.
  if p_worker_id is null or btrim(p_worker_id) = ''
     or p_job_id is null or p_project_id is null or p_claim_token is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_verify_phase3d_canary_post_claim_args';
  end if;

  -- 1. Addressing. A row under another project is absence, not a near miss.
  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id
     and j.project_id = p_project_id;
  v_found := found;

  if not v_found then
    return query select 'JOB_NOT_FOUND'::text;
    return;
  end if;

  -- 2. Ownership: the fencing triple, plus a lease that has not lapsed.
  if v_job.status <> 'claimed'
     or v_job.worker_id is distinct from p_worker_id
     or v_job.claim_token is distinct from p_claim_token
     or v_job.lease_expires_at is null
     or v_job.lease_expires_at <= now() then
    return query select 'JOB_NOT_OWNED'::text;
    return;
  end if;

  -- 3. Pristine state, then pristine history. The job must look exactly like
  --    a single-attempt candidate that has just been claimed and has done
  --    nothing yet.
  if v_job.attempt_count <> 1
     or v_job.max_attempts <> 1
     or v_job.current_attempt_id is not null
     or v_job.next_baseline_ordinal <> 1
     or v_job.needs_review_reason is not null
     or v_job.failure_reason is not null then
    return query select 'JOB_NOT_CLEAN'::text;
    return;
  end if;

  -- The whole history of the job, by job_id — never by current_attempt_id,
  -- which is exactly the blind spot this function exists to close.
  with attempts as (
    select a.id, a.probe_run_id
      from public.protocol_attempts a
     where a.job_id = v_job.id
  ),
  calls as (
    select c.id
      from public.protocol_external_calls c
     where c.protocol_attempt_id in (select id from attempts)
  ),
  runs as (
    select a.probe_run_id as id
      from attempts a
     where a.probe_run_id is not null
  )
  select
    (select count(*) from attempts)
    + (select count(*) from calls)
    + (select count(*) from public.provider_call_receipts r
        where r.external_call_id in (select id from calls))
    + (select count(*) from public.analysis_call_receipts r
        where r.external_call_id in (select id from calls))
    + (select count(*) from public.probe_runs pr
        where pr.id in (select id from runs))
    + (select count(*) from public.probe_results pres
        where pres.probe_run_id in (select id from runs))
    into v_history;

  if v_history <> 0 then
    return query select 'JOB_NOT_CLEAN'::text;
    return;
  end if;

  -- 4. The protocol must still be the job's own, in the same project, and
  --    still admissible under the vocabulary admission itself accepts.
  select true into v_protocol_ok
    from public.protocols p
   where p.id = v_job.protocol_id
     and p.project_id = v_job.project_id
     and p.status in ('approved', 'active');

  if not found then
    return query select 'PROTOCOL_NOT_ELIGIBLE'::text;
    return;
  end if;

  return query select 'VERIFIED'::text;
end;
$$;

revoke all on function
  public.verify_phase3d_canary_post_claim(text, uuid, uuid, uuid) from public;
revoke all on function
  public.verify_phase3d_canary_post_claim(text, uuid, uuid, uuid) from anon;
revoke all on function
  public.verify_phase3d_canary_post_claim(text, uuid, uuid, uuid) from authenticated;
grant execute on function
  public.verify_phase3d_canary_post_claim(text, uuid, uuid, uuid) to service_role;
