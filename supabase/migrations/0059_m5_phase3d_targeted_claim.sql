-- M5 Phase 3D — targeted single-job claim (D-031).
--
-- `claim_protocol_execution_job(text, integer)` — canonical since 0054 —
-- takes neither a job id nor a project id: it claims the OLDEST claimable
-- job. A preflight assertion that "exactly one job is claimable" holds only
-- at read time, and nothing preserves it across a cold switch and a Machine
-- start: a lease can expire on its own, a job can be enqueued, and
-- its locking strategy steps over a locked row, so a concurrent claim
-- hands the canary a DIFFERENT job without anyone noticing.
--
-- D-031 therefore adds this function BESIDE the global one. The global
-- function is not modified, not dropped and not overloaded: ordinary
-- operation keeps its exact behaviour, and this surface exists only for a
-- supervised, separately authorized Phase 3D canary.
--
-- The whole guarantee is the lock ordering: the single addressed row is
-- locked by primary key with FOR UPDATE NOWAIT *before* eligibility is
-- evaluated. That is what makes the four outcomes distinguishable, and what
-- makes a lost race end the canary instead of silently claiming something
-- else. A locked row is never stepped over here — stepping over it is
-- precisely what must not happen — and there is no abandoned-job sweep:
-- the global sweep writes to other rows and to two alert tables, which a
-- supervised single-job run must never do.
--
-- No table, column, constraint, index, trigger or RLS policy is created or
-- altered. The transaction is short and makes no external call.

create or replace function
  public.claim_protocol_execution_job_by_id(
    p_worker_id text,
    p_lease_seconds integer,
    p_job_id uuid,
    p_project_id uuid
  )
returns table (
  outcome     text,
  job         public.protocol_execution_jobs,
  claim_token uuid
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  -- FOUND is global and is overwritten by the next statement, so the result
  -- of the locking SELECT is captured into a dedicated boolean immediately.
  v_found boolean := false;
  v_token uuid;
begin
  -- Argument guards: byte-for-byte the canonical function's, including the
  -- SQLSTATE and the message. Neither relaxed nor widened.
  if p_worker_id is null or btrim(p_worker_id) = ''
     or p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception using
      errcode = '22023',
      message = 'invalid_claim_protocol_execution_job_args';
  end if;

  -- A missing identifier addresses no row. Treated as absence, never as an
  -- invitation to look for something else.
  if p_job_id is null or p_project_id is null then
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_execution_jobs, null::uuid;
    return;
  end if;

  -- Lock first, evaluate second. NOWAIT rather than a wait, so a concurrent
  -- holder is reported as its own outcome instead of blocking the canary;
  -- and never a step-over strategy, which would silently report absence for
  -- a row that in fact exists.
  begin
    select j.* into v_job
      from public.protocol_execution_jobs j
     where j.id = p_job_id
       and j.project_id = p_project_id
     for update nowait;
    v_found := found;
  exception
    when lock_not_available then
      return query select 'JOB_LOCKED'::text, null::public.protocol_execution_jobs, null::uuid;
      return;
  end;

  if not v_found then
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_execution_jobs, null::uuid;
    return;
  end if;

  -- Atomic eligibility, evaluated on the locked row. All six conditions, no
  -- exception and no operator override. `max_attempts = 1` is what makes a
  -- failed canary un-reclaimable by ordinary operation.
  if not (
    v_job.status = 'queued'
    and v_job.attempt_count = 0
    and v_job.max_attempts = 1
    and v_job.worker_id is null
    and v_job.claim_token is null
    and v_job.lease_expires_at is null
  ) then
    return query select 'JOB_NOT_ELIGIBLE'::text, null::public.protocol_execution_jobs, null::uuid;
    return;
  end if;

  v_token := gen_random_uuid();

  -- The canonical claim mutation, applied to the targeted row and to no
  -- other. `attempt_count` moves by exactly one.
  update public.protocol_execution_jobs
     set status = 'claimed',
         worker_id = p_worker_id,
         claim_token = v_token,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempt_count = attempt_count + 1,
         updated_at = now()
   where id = v_job.id
  returning * into v_job;

  return query select 'CLAIMED'::text, v_job, v_token;
end;
$$;

revoke all on function
  public.claim_protocol_execution_job_by_id(text, integer, uuid, uuid) from public;
revoke all on function
  public.claim_protocol_execution_job_by_id(text, integer, uuid, uuid) from anon;
revoke all on function
  public.claim_protocol_execution_job_by_id(text, integer, uuid, uuid) from authenticated;
grant execute on function
  public.claim_protocol_execution_job_by_id(text, integer, uuid, uuid) to service_role;
