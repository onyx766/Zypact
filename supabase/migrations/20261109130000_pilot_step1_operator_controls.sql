-- Pilot Mode step 1 (D-051, D-052): the operator controls a paid pilot needs
-- before its first run.
--
-- Applies after 20261109120000 (S1), ahead of the unapplied account stack
-- (P1 to Q4), under the release order D-058 proposes. It was numbered
-- 20261114120000 until 2026-11-17; the SQL is unchanged. Depends only on
-- objects from 0047-0081.
--
-- Four changes. Each adds new objects, except item 4, which redefines one
-- function: a public-form approval behaves exactly as before, while a
-- founder-created approval now requires the new input (so the web app that
-- sends it must be deployed with this migration):
--
--   1. A Run names its job. `request_protocol_job_run` records which job an
--      operator start is for, and `claim_requested_protocol_execution_job`
--      claims that job or nothing. Before this, a start meant for one request
--      took the oldest claimable job of any project (CURRENT_STATUS.md §18.5
--      item 2). The global claim (`claim_protocol_execution_job`, 0054) and the
--      canary claim (`claim_protocol_execution_job_by_id`, 0059) are not
--      touched; the worker chooses which claim to call.
--   2. A failed measurement can be retried. `retry_failed_protocol_job`
--      reopens a `failed` job whose last run failed at the provider, and
--      authorises one retry of that run through `authorize_operator_retry`
--      (0051), the existing operator-retry path. Admission, reservation, the
--      run, retry and spend caps, the idempotency key and the operator-action
--      record are that path's own. A denied retry leaves the job `failed`.
--   3. A failed request can be closed. `close_failed_snapshot_request` moves
--      an `approved` request whose job ended `failed` or
--      `abandoned_exhausted` to the existing `failed` status, which the
--      active-domain rule does not count, and records who closed it and why.
--   4. Who wrote the question is recorded at approval.
--      `approve_and_launch_snapshot_baseline` (0069) gains
--      `p_question_provenance`. A founder-created request (0081) must say
--      whether the customer or Zypact wrote the question; a public-form
--      request keeps `customer_supplied` and its rationale, unchanged.
--
-- No existing row is updated, deleted or backfilled by this file. No
-- attempt, external call, receipt, request body, probe row or report is
-- written by any function here except through the existing private cores
-- that authorize_operator_retry already calls. Every function is SECURITY
-- DEFINER, pins its search_path and is executable by service_role only.
--
-- Rollback / forward recovery, in the reverse of the deploy order, so each
-- step fails closed:
--   1. Roll the web app back, and in the same window restore item 4:
--        drop function public.approve_and_launch_snapshot_baseline(uuid, uuid, jsonb, text, text);
--        then re-apply 0069's function body and grants.
--      The old console records no run request, so the new worker it starts
--      claims nothing.
--   2. Roll the worker image back. It returns to the global claim (0054),
--      the state before this migration.
--   3. Drop the rest:
--        drop function if exists public.request_protocol_job_run(uuid, uuid, text, uuid, integer);
--        drop function if exists public.cancel_protocol_job_run_request(uuid);
--        drop function if exists public.claim_requested_protocol_execution_job(text, integer);
--        drop function if exists public.retry_failed_protocol_job(uuid, uuid, uuid, text, uuid, text);
--        drop function if exists public.close_failed_snapshot_request(uuid, uuid, text);
--        drop table if exists public.protocol_job_run_requests;
--        drop table if exists public.snapshot_request_closures;
-- Dropping the two tables loses only run-request and closure history. A
-- retried attempt and a closed request stay: both are ordinary rows written
-- through existing paths and existing statuses.

-- =======================================================================
-- 1. Run requests: a start claims the job it was asked for, or nothing
-- =======================================================================

create table if not exists public.protocol_job_run_requests (
  id                  uuid primary key default gen_random_uuid(),
  job_id              uuid not null,
  project_id          uuid not null references public.projects (id) on delete cascade,
  requested_via       text not null
                      check (requested_via in (
                        'admin_run_pipeline', 'admin_run_retest',
                        'admin_founder_baseline', 'operator_cli'
                      )),
  requested_by        uuid null,
  requested_at        timestamptz not null default now(),
  expires_at          timestamptz not null,
  status              text not null default 'pending'
                      check (status in ('pending', 'consumed', 'expired', 'cancelled', 'refused')),
  resolved_at         timestamptz null,
  consumed_by_worker  text null,
  refusal_code        text null
                      check (refusal_code in ('JOB_NOT_FOUND', 'JOB_NOT_ELIGIBLE', 'JOB_LOCKED')),

  constraint protocol_job_run_requests_expiry_check check (expires_at > requested_at),
  -- Every console start names the founder who pressed Run.
  constraint protocol_job_run_requests_requester_check check (
    requested_via = 'operator_cli' or requested_by is not null
  ),
  constraint protocol_job_run_requests_resolution_check check (
    (status = 'pending') = (resolved_at is null)
    and (status = 'consumed') = (consumed_by_worker is not null)
    and (status = 'refused') = (refusal_code is not null)
  ),
  constraint protocol_job_run_requests_job_project_fk
    foreign key (job_id, project_id)
    references public.protocol_execution_jobs (id, project_id)
    on delete cascade
);

-- At most one pending request at any time: one machine runs one job per
-- start (D-034), so there is never a second job a start could be for.
create unique index if not exists protocol_job_run_requests_one_pending_key
  on public.protocol_job_run_requests ((true))
  where status = 'pending';

create index if not exists protocol_job_run_requests_job_idx
  on public.protocol_job_run_requests (job_id);

alter table public.protocol_job_run_requests enable row level security;
alter table public.protocol_job_run_requests no force row level security;

revoke all on table public.protocol_job_run_requests from public, anon, authenticated, service_role;
grant select on table public.protocol_job_run_requests to service_role;

comment on table public.protocol_job_run_requests is
  'D-052: the job an operator start is for. Written only by '
  'request_protocol_job_run, cancel_protocol_job_run_request and '
  'claim_requested_protocol_execution_job.';

-- Records the job the next worker start may claim. Refuses a job that is not
-- claimable now (the global claim's own predicate), and refuses while another
-- request is pending, so a start can never be redirected to a job nobody
-- pressed Run for.
create or replace function public.request_protocol_job_run(
    p_job_id uuid,
    p_project_id uuid,
    p_requested_via text,
    p_requested_by uuid,
    p_ttl_seconds integer
  )
returns table (
  outcome     text,
  request_id  uuid,
  expires_at  timestamptz
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  v_pending public.protocol_job_run_requests%rowtype;
  v_row public.protocol_job_run_requests%rowtype;
  v_found boolean := false;
  v_expires timestamptz;
begin
  if p_job_id is null or p_project_id is null
     or p_requested_via is null
     or p_requested_via not in (
       'admin_run_pipeline', 'admin_run_retest', 'admin_founder_baseline', 'operator_cli'
     )
     or (p_requested_via <> 'operator_cli' and p_requested_by is null)
     or p_ttl_seconds is null or p_ttl_seconds < 30 or p_ttl_seconds > 600 then
    raise exception using
      errcode = '22023',
      message = 'invalid_request_protocol_job_run_args';
  end if;

  -- One writer at a time, so the pending check and the insert cannot
  -- interleave with another request.
  perform pg_advisory_xact_lock(hashtextextended('protocol-job-run-request', 0));

  update public.protocol_job_run_requests r
     set status = 'expired',
         resolved_at = now()
   where r.status = 'pending'
     and r.expires_at <= now();

  select r.* into v_pending
    from public.protocol_job_run_requests r
   where r.status = 'pending';

  if found then
    if v_pending.job_id = p_job_id and v_pending.project_id = p_project_id then
      -- A repeated press for the same job keeps its request alive for a
      -- full TTL from now, so a late second start is not handed a request
      -- that lapses before its machine boots.
      update public.protocol_job_run_requests r
         set expires_at = greatest(r.expires_at, now() + make_interval(secs => p_ttl_seconds))
       where r.id = v_pending.id
      returning r.expires_at into v_expires;
      return query select 'ALREADY_REQUESTED'::text, v_pending.id, v_expires;
    else
      return query select 'ANOTHER_RUN_PENDING'::text, null::uuid, null::timestamptz;
    end if;
    return;
  end if;

  -- One machine runs one job per start (D-034). A job holding a live lease
  -- means that machine is busy: it stops after its own job and would never
  -- serve this request, so the founder is told now rather than left waiting.
  if exists (
    select 1 from public.protocol_execution_jobs j
     where j.status in ('claimed', 'running')
       and j.lease_expires_at > now()
  ) then
    return query select 'WORKER_BUSY'::text, null::uuid, null::timestamptz;
    return;
  end if;

  begin
    select j.* into v_job
      from public.protocol_execution_jobs j
     where j.id = p_job_id
       and j.project_id = p_project_id
     for update nowait;
    v_found := found;
  exception
    when lock_not_available then
      return query select 'JOB_LOCKED'::text, null::uuid, null::timestamptz;
      return;
  end;

  if not v_found then
    return query select 'JOB_NOT_FOUND'::text, null::uuid, null::timestamptz;
    return;
  end if;

  -- A dead lease with no claims left is what the global claim's sweep turns
  -- into abandoned_exhausted. Applied here to this one row, with the same
  -- alert, so the founder sees the honest state instead of "Resume run".
  if v_job.status in ('claimed', 'running')
     and v_job.lease_expires_at < now()
     and v_job.attempt_count >= v_job.max_attempts then
    with abandoned as (
      update public.protocol_execution_jobs j
         set status = 'abandoned_exhausted', updated_at = now()
       where j.id = v_job.id
      returning j.id, j.project_id
    ),
    inserted_alerts as (
      insert into public.protocol_execution_job_alerts (project_id, job_id, event_type, reason_code)
      select project_id, id, 'abandoned_exhausted', 'attempts_exhausted'
        from abandoned
      returning alert_event_id
    )
    insert into public.protocol_execution_job_alert_deliveries (alert_event_id)
    select alert_event_id from inserted_alerts;

    return query select 'JOB_ATTEMPTS_EXHAUSTED'::text, null::uuid, null::timestamptz;
    return;
  end if;

  if not (
    v_job.status = 'queued'
    or (v_job.status in ('claimed', 'running')
        and v_job.lease_expires_at < now()
        and v_job.attempt_count < v_job.max_attempts)
  ) then
    return query select 'JOB_NOT_RUNNABLE'::text, null::uuid, null::timestamptz;
    return;
  end if;

  insert into public.protocol_job_run_requests (
    job_id, project_id, requested_via, requested_by, expires_at
  ) values (
    p_job_id, p_project_id, p_requested_via, p_requested_by,
    now() + make_interval(secs => p_ttl_seconds)
  )
  returning * into v_row;

  return query select 'REQUESTED'::text, v_row.id, v_row.expires_at;
end;
$$;

-- Withdraws a pending request whose machine start failed, so no later start
-- can act on it.
create or replace function public.cancel_protocol_job_run_request(
    p_request_id uuid
  )
returns table (
  outcome text
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
begin
  if p_request_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_cancel_protocol_job_run_request_args';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('protocol-job-run-request', 0));

  update public.protocol_job_run_requests r
     set status = 'cancelled',
         resolved_at = now()
   where r.id = p_request_id
     and r.status = 'pending';

  if found then
    return query select 'CANCELLED'::text;
  else
    return query select 'NOT_PENDING'::text;
  end if;
end;
$$;

-- The requested claim. Claims the job named by the one pending, unexpired
-- run request, or nothing; never a different job. The argument guard, the
-- eligibility predicate, the claim mutation and the abandoned-job sweep are
-- those of claim_protocol_execution_job (0054), so a worker that switches to
-- this function keeps the same lease and housekeeping. The outcome column is
-- named `outcome`, never `status`, so it cannot be confused with the
-- returned job's own status (as in 0059).
create or replace function public.claim_requested_protocol_execution_job(
    p_worker_id text,
    p_lease_seconds integer
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
  v_request public.protocol_job_run_requests%rowtype;
  v_job public.protocol_execution_jobs%rowtype;
  v_found boolean := false;
  v_token uuid;
begin
  if p_worker_id is null or btrim(p_worker_id) = ''
     or p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception using
      errcode = '22023',
      message = 'invalid_claim_protocol_execution_job_args';
  end if;

  with abandoned as (
    update public.protocol_execution_jobs j
       set status = 'abandoned_exhausted', updated_at = now()
     where j.status in ('claimed', 'running')
       and j.lease_expires_at < now()
       and j.attempt_count >= j.max_attempts
    returning j.id, j.project_id
  ),
  inserted_alerts as (
    insert into public.protocol_execution_job_alerts (project_id, job_id, event_type, reason_code)
    select project_id, id, 'abandoned_exhausted', 'attempts_exhausted'
      from abandoned
    returning alert_event_id
  )
  insert into public.protocol_execution_job_alert_deliveries (alert_event_id)
  select alert_event_id from inserted_alerts;

  select r.* into v_request
    from public.protocol_job_run_requests r
   where r.status = 'pending'
   for update;

  if not found then
    return query select 'NO_RUN_REQUEST'::text, null::public.protocol_execution_jobs, null::uuid;
    return;
  end if;

  if v_request.expires_at <= now() then
    update public.protocol_job_run_requests r
       set status = 'expired', resolved_at = now()
     where r.id = v_request.id;
    return query select 'NO_RUN_REQUEST'::text, null::public.protocol_execution_jobs, null::uuid;
    return;
  end if;

  -- Lock the named row first, evaluate second, and never step over it.
  begin
    select j.* into v_job
      from public.protocol_execution_jobs j
     where j.id = v_request.job_id
       and j.project_id = v_request.project_id
     for update nowait;
    v_found := found;
  exception
    when lock_not_available then
      update public.protocol_job_run_requests r
         set status = 'refused', resolved_at = now(), refusal_code = 'JOB_LOCKED'
       where r.id = v_request.id;
      return query select 'JOB_LOCKED'::text, null::public.protocol_execution_jobs, null::uuid;
      return;
  end;

  if not v_found then
    update public.protocol_job_run_requests r
       set status = 'refused', resolved_at = now(), refusal_code = 'JOB_NOT_FOUND'
     where r.id = v_request.id;
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_execution_jobs, null::uuid;
    return;
  end if;

  if not (
    v_job.status = 'queued'
    or (v_job.status in ('claimed', 'running')
        and v_job.lease_expires_at < now()
        and v_job.attempt_count < v_job.max_attempts)
  ) then
    update public.protocol_job_run_requests r
       set status = 'refused', resolved_at = now(), refusal_code = 'JOB_NOT_ELIGIBLE'
     where r.id = v_request.id;
    return query select 'JOB_NOT_ELIGIBLE'::text, null::public.protocol_execution_jobs, null::uuid;
    return;
  end if;

  v_token := gen_random_uuid();

  update public.protocol_execution_jobs
     set status = 'claimed',
         worker_id = p_worker_id,
         claim_token = v_token,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempt_count = attempt_count + 1,
         updated_at = now()
   where id = v_job.id
  returning * into v_job;

  update public.protocol_job_run_requests r
     set status = 'consumed', resolved_at = now(), consumed_by_worker = p_worker_id
   where r.id = v_request.id;

  return query select 'CLAIMED'::text, v_job, v_token;
end;
$$;

-- =======================================================================
-- 2. Retry a run that failed at the provider
-- =======================================================================
--
-- Eligible only when the job is `failed` because its current run failed at
-- the provider: the run's own Perplexity call failed and holds a receipt, so
-- no answer was bought. That covers an HTTP error and a reply with no
-- readable answer, which the worker records the same way (execute-job.ts:
-- a `provider_error` receipt, then failure_reason `provider_error`). This is
-- retry_full_attempt_for_job's own rule (0051), which never retries a run
-- whose answer arrived: that would discard a paid answer and buy a second
-- one. Such runs, including an answer that arrived empty
-- (`empty_provider_answer`), and every other failure stay close-only.
--
-- The reservation is the failed run's own recorded amounts, never a caller
-- value. A retry that the run cap shows could not finish the plan is refused
-- before anything is reserved.

create or replace function public.retry_failed_protocol_job(
    p_job_id uuid,
    p_project_id uuid,
    p_actor uuid,
    p_reason text,
    p_source_attempt_id uuid,
    p_idempotency_key text
  )
returns table (
  outcome           text,
  denial_code       text,
  new_attempt_id    uuid
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  v_protocol public.protocols%rowtype;
  v_source public.protocol_attempts%rowtype;
  v_perplexity public.protocol_external_calls%rowtype;
  v_analysis public.protocol_external_calls%rowtype;
  v_request_status text;
  v_consumed integer;
  v_key text;
  v_result record;
  v_replay_perplexity numeric;
  v_replay_analysis numeric;
begin
  if p_job_id is null or p_project_id is null or p_actor is null
     or p_reason is null or char_length(btrim(p_reason)) not between 10 and 2000
     or p_source_attempt_id is null
     or p_idempotency_key is null or btrim(p_idempotency_key) = ''
     or char_length(p_idempotency_key) > 200 then
    raise exception using
      errcode = '22023',
      message = 'invalid_retry_failed_protocol_job_args';
  end if;

  -- Founder console retries share the operator-action key space with the
  -- worker's own operator retries, under their own prefix.
  v_key := 'failed-job-retry:' || p_idempotency_key;

  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id
   for update;

  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::text, null::uuid;
    return;
  end if;

  -- Replay first, whatever the job's status is now (the D-021 ordering). The
  -- recorded decision is answered by authorize_operator_retry itself, which
  -- compares the request's fingerprint (the source run and its reserved
  -- amounts): the same key for a different failed run is a conflict, never
  -- the first run's answer.
  if exists (
    select 1 from public.protocol_operator_actions a
     where a.project_id = p_project_id
       and a.job_id = p_job_id
       and a.idempotency_key = v_key
  ) then
    select ec.reserved_cost_usd into v_replay_perplexity
      from public.protocol_external_calls ec
     where ec.protocol_attempt_id = p_source_attempt_id
       and ec.call_kind = 'perplexity' and ec.generation = 1;
    select ec.reserved_cost_usd into v_replay_analysis
      from public.protocol_external_calls ec
     where ec.protocol_attempt_id = p_source_attempt_id
       and ec.call_kind = 'analysis' and ec.generation = 1;

    select * into v_result
      from public.authorize_operator_retry(
        p_job_id, p_project_id, p_actor::text, btrim(p_reason), 'retry_full_attempt',
        p_source_attempt_id, coalesce(v_replay_analysis, 0), v_key,
        null, coalesce(v_replay_perplexity, 0)
      );

    if v_result.status = 'APPROVED' then
      return query select 'APPROVED'::text, null::text, (v_result.new_attempt).id;
    elsif v_result.status = 'DENIED' then
      return query select 'DENIED'::text, v_result.denial_code::text, null::uuid;
    else
      return query select 'IDEMPOTENCY_KEY_CONFLICT'::text, null::text, null::uuid;
    end if;
    return;
  end if;

  if v_job.status <> 'failed' then
    return query select 'JOB_NOT_FAILED'::text, null::text, null::uuid;
    return;
  end if;

  -- A job the founder closed through review, a cap failure, or a job still
  -- pointing at a run is final here.
  if v_job.review_resolution is not null
     or v_job.current_attempt_id is not null
     or v_job.failure_reason is distinct from 'provider_error' then
    return query select 'JOB_NOT_RETRYABLE'::text, null::text, null::uuid;
    return;
  end if;

  -- A request that launched this job and has since been closed is final.
  -- A retest job has no snapshot request; its protocol status governs it.
  select r.status into v_request_status
    from public.snapshot_requests r
   where r.protocol_id = v_job.protocol_id;

  if found and v_request_status <> 'approved' then
    return query select 'REQUEST_NOT_OPEN'::text, null::text, null::uuid;
    return;
  end if;

  select pa.* into v_source
    from public.protocol_attempts pa
   where pa.id = p_source_attempt_id
     and pa.project_id = p_project_id
     and pa.job_id = p_job_id
   for update;

  if not found then
    return query select 'SOURCE_ATTEMPT_NOT_OWNED_BY_JOB'::text, null::text, null::uuid;
    return;
  end if;

  -- The newest run of the slot that failed: terminal `failed`, in the slot
  -- the job stopped at, never retried, with no completed run in its slot.
  if v_source.status <> 'failed'
     or v_source.terminalized_at is null
     or v_source.baseline_ordinal is distinct from v_job.next_baseline_ordinal
     or exists (
       select 1 from public.protocol_attempts pa
        where pa.retry_of_attempt_id = v_source.id
     )
     or exists (
       select 1 from public.protocol_attempts pa
        where pa.job_id = p_job_id
          and pa.baseline_ordinal = v_source.baseline_ordinal
          and pa.status = 'completed'
     ) then
    return query select 'SOURCE_ATTEMPT_NOT_RETRYABLE'::text, null::text, null::uuid;
    return;
  end if;

  -- No call of the run may be open or sent without a receipt.
  if exists (
    select 1 from public.protocol_external_calls ec
     where ec.protocol_attempt_id = v_source.id
       and (
         ec.status in ('reserved', 'in_progress')
         or (ec.request_sent_at is not null
             and not exists (select 1 from public.provider_call_receipts r where r.external_call_id = ec.id)
             and not exists (select 1 from public.analysis_call_receipts r where r.external_call_id = ec.id))
       )
  ) then
    return query select 'AMBIGUOUS_CALL_PRESENT'::text, null::text, null::uuid;
    return;
  end if;

  select ec.* into v_perplexity
    from public.protocol_external_calls ec
   where ec.protocol_attempt_id = v_source.id
     and ec.call_kind = 'perplexity'
     and ec.generation = 1;

  if not found
     or v_perplexity.status <> 'failed'
     or not exists (
       select 1 from public.provider_call_receipts r where r.external_call_id = v_perplexity.id
     ) then
    return query select 'NOT_A_PROVIDER_FAILURE'::text, null::text, null::uuid;
    return;
  end if;

  select ec.* into v_analysis
    from public.protocol_external_calls ec
   where ec.protocol_attempt_id = v_source.id
     and ec.call_kind = 'analysis'
     and ec.generation = 1;

  if not found then
    return query select 'NOT_A_PROVIDER_FAILURE'::text, null::text, null::uuid;
    return;
  end if;

  -- The retry must leave room in the run cap for the rest of the plan; a
  -- paid retry that cannot finish it is refused before anything is reserved.
  select p.* into v_protocol
    from public.protocols p
   where p.id = v_job.protocol_id and p.project_id = p_project_id;

  select count(*) into v_consumed
    from public.protocol_attempts pa
   where pa.protocol_id = v_job.protocol_id
     and pa.status <> 'cancelled';

  if v_consumed + 1
       + greatest(coalesce(v_protocol.planned_baseline_runs, 0) - v_job.next_baseline_ordinal, 0)
     > v_protocol.run_cap then
    return query select 'RUN_CAP_INSUFFICIENT_FOR_REMAINING_PLAN'::text, null::text, null::uuid;
    return;
  end if;

  -- Reopen for review, then authorise through the one operator-retry path.
  update public.protocol_execution_jobs
     set status = 'needs_review',
         needs_review_reason = 'operator_retry_of_failed_job',
         updated_at = now()
   where id = p_job_id;

  select * into v_result
    from public.authorize_operator_retry(
      p_job_id, p_project_id, p_actor::text, btrim(p_reason), 'retry_full_attempt',
      v_source.id, v_analysis.reserved_cost_usd, v_key,
      null, v_perplexity.reserved_cost_usd
    );

  if v_result.status = 'APPROVED' then
    -- Queued again with a fresh claim budget, as reactivate_abandoned_job
    -- does (D-024). The earlier failure stays on the failed run
    -- (termination_reason) and in the operator-action record.
    update public.protocol_execution_jobs
       set attempt_count = 0,
           worker_id = null,
           claim_token = null,
           lease_expires_at = null,
           failure_reason = null,
           updated_at = now()
     where id = p_job_id;

    return query select 'APPROVED'::text, null::text, (v_result.new_attempt).id;
    return;
  end if;

  -- A denied retry leaves the job exactly as it was. The denial stays
  -- recorded, so a replay of the same key answers the same way.
  update public.protocol_execution_jobs
     set status = 'failed',
         needs_review_reason = null,
         failure_reason = v_job.failure_reason,
         updated_at = now()
   where id = p_job_id;

  return query select 'DENIED'::text, v_result.denial_code::text, null::uuid;
end;
$$;

-- =======================================================================
-- 3. Close a failed request
-- =======================================================================

create table if not exists public.snapshot_request_closures (
  id                   uuid primary key default gen_random_uuid(),
  snapshot_request_id  uuid not null references public.snapshot_requests (id) on delete restrict,
  job_id               uuid not null references public.protocol_execution_jobs (id) on delete restrict,
  job_status           text not null check (job_status in ('failed', 'abandoned_exhausted')),
  closed_by            uuid not null,
  reason               text not null check (char_length(btrim(reason)) between 10 and 2000),
  closed_at            timestamptz not null default now(),

  constraint snapshot_request_closures_request_key unique (snapshot_request_id)
);

alter table public.snapshot_request_closures enable row level security;
alter table public.snapshot_request_closures no force row level security;

revoke all on table public.snapshot_request_closures from public, anon, authenticated, service_role;
grant select on table public.snapshot_request_closures to service_role;

comment on table public.snapshot_request_closures is
  'D-052: who closed a failed request and why. Written only by '
  'close_failed_snapshot_request; one row per request, never changed.';

create or replace function public.close_failed_snapshot_request(
    p_request_id uuid,
    p_closed_by uuid,
    p_reason text
  )
returns table (
  outcome text
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_request public.snapshot_requests%rowtype;
  v_job public.protocol_execution_jobs%rowtype;
begin
  if p_request_id is null or p_closed_by is null
     or p_reason is null or char_length(btrim(p_reason)) not between 10 and 2000 then
    raise exception using
      errcode = '22023',
      message = 'invalid_close_failed_snapshot_request_args';
  end if;

  select r.* into v_request
    from public.snapshot_requests r
   where r.id = p_request_id
   for update;

  if not found then
    return query select 'REQUEST_NOT_FOUND'::text;
    return;
  end if;

  if exists (
    select 1 from public.snapshot_request_closures c
     where c.snapshot_request_id = p_request_id
  ) then
    return query select 'ALREADY_CLOSED'::text;
    return;
  end if;

  if v_request.status <> 'approved' or v_request.protocol_id is null then
    return query select 'REQUEST_NOT_CLOSABLE'::text;
    return;
  end if;

  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.protocol_id = v_request.protocol_id
   for update;

  if not found or v_job.status not in ('failed', 'abandoned_exhausted') then
    return query select 'JOB_NOT_ENDED_IN_FAILURE'::text;
    return;
  end if;

  -- A failed job never builds a report. If one exists anyway, closing would
  -- strand it, so the request is left for a person to look at.
  if exists (
    select 1 from public.snapshot_report_artifacts a
     where a.snapshot_request_id = p_request_id
  ) then
    return query select 'REPORT_PRESENT'::text;
    return;
  end if;

  insert into public.snapshot_request_closures (
    snapshot_request_id, job_id, job_status, closed_by, reason
  ) values (
    p_request_id, v_job.id, v_job.status, p_closed_by, btrim(p_reason)
  );

  -- An abandoned job is ended with its request, so no later path
  -- (reactivate_abandoned_job, a run request) can revive it and spend for a
  -- closed request. A failed job is already final for every path but the
  -- founder retry, which refuses a closed request. The closure row keeps
  -- the job's status as it was.
  if v_job.status = 'abandoned_exhausted' then
    update public.protocol_execution_jobs
       set status = 'failed',
           failure_reason = 'request_closed',
           needs_review_reason = null,
           updated_at = now()
     where id = v_job.id;
  end if;

  update public.snapshot_requests
     set status = 'failed',
         progress_stage = null,
         progress_updated_at = null,
         updated_at = now()
   where id = p_request_id
     and status = 'approved';

  return query select 'CLOSED'::text;
end;
$$;

-- =======================================================================
-- Privileges for sections 1-3: service role only.
-- =======================================================================

revoke all on function public.request_protocol_job_run(uuid, uuid, text, uuid, integer) from public;
revoke all on function public.request_protocol_job_run(uuid, uuid, text, uuid, integer) from anon;
revoke all on function public.request_protocol_job_run(uuid, uuid, text, uuid, integer) from authenticated;
grant execute on function public.request_protocol_job_run(uuid, uuid, text, uuid, integer) to service_role;

revoke all on function public.cancel_protocol_job_run_request(uuid) from public;
revoke all on function public.cancel_protocol_job_run_request(uuid) from anon;
revoke all on function public.cancel_protocol_job_run_request(uuid) from authenticated;
grant execute on function public.cancel_protocol_job_run_request(uuid) to service_role;

revoke all on function public.claim_requested_protocol_execution_job(text, integer) from public;
revoke all on function public.claim_requested_protocol_execution_job(text, integer) from anon;
revoke all on function public.claim_requested_protocol_execution_job(text, integer) from authenticated;
grant execute on function public.claim_requested_protocol_execution_job(text, integer) to service_role;

revoke all on function public.retry_failed_protocol_job(uuid, uuid, uuid, text, uuid, text) from public;
revoke all on function public.retry_failed_protocol_job(uuid, uuid, uuid, text, uuid, text) from anon;
revoke all on function public.retry_failed_protocol_job(uuid, uuid, uuid, text, uuid, text) from authenticated;
grant execute on function public.retry_failed_protocol_job(uuid, uuid, uuid, text, uuid, text) to service_role;

revoke all on function public.close_failed_snapshot_request(uuid, uuid, text) from public;
revoke all on function public.close_failed_snapshot_request(uuid, uuid, text) from anon;
revoke all on function public.close_failed_snapshot_request(uuid, uuid, text) from authenticated;
grant execute on function public.close_failed_snapshot_request(uuid, uuid, text) to service_role;

-- =======================================================================
-- 4. Who wrote the question, recorded at approval
-- =======================================================================
--
-- 0069's function, unchanged except for one added parameter
-- (`p_question_provenance`, default null), two added variables, the
-- provenance block after the pending-approval check, and the rationale and
-- provenance written from those variables. The signature changes, so the
-- four-argument function is dropped first. No SQL function calls it, and a
-- caller that passes the four named arguments resolves to the new one.

drop function if exists public.approve_and_launch_snapshot_baseline(uuid, uuid, jsonb, text);

create or replace function
  public.approve_and_launch_snapshot_baseline(
    p_request_id uuid,
    p_approved_by uuid,
    p_competitors jsonb,
    p_prompt_hash text,
    p_question_provenance text default null
  )
returns setof public.snapshot_requests
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_request        public.snapshot_requests%rowtype;
  v_competitors    jsonb;
  v_count          integer;
  v_value          text;
  v_project_id     uuid;
  v_question_id    uuid;
  v_version_id     uuid;
  v_protocol_id    uuid;
  v_version_status text;
  v_protocol_status text;
  v_enqueue_status text;
  v_provenance     text;
  v_rationale      text;
begin
  if p_request_id is null or p_approved_by is null then
    return;
  end if;

  if p_prompt_hash is null or btrim(p_prompt_hash) = '' then
    raise exception using
      errcode = '22023',
      message = 'invalid_prompt_hash';
  end if;

  select request.*
    into v_request
    from public.snapshot_requests request
   where request.id = p_request_id
   for update;

  if not found then
    return;
  end if;

  -- Idempotent replay: a second click (or a retried request after an
  -- ambiguous response) returns the already-launched row untouched. Never
  -- re-validates competitors or creates a second question/protocol/job.
  if v_request.status = 'approved'
     and v_request.protocol_id is not null then
    return query
    select request.*
      from public.snapshot_requests request
     where request.id = p_request_id;

    return;
  end if;

  if v_request.status <> 'pending_approval' then
    return;
  end if;

  -- D-052: who wrote the question. A public-form request was written by the
  -- requester, exactly as before. A founder-created request (0081) was typed
  -- in by the founder, who must say whether the customer or Zypact wrote it,
  -- because the report shows that provenance to the customer.
  if v_request.origin = 'founder' then
    if p_question_provenance is null
       or p_question_provenance not in ('customer_supplied', 'founder_supplied') then
      raise exception using
        errcode = '22023',
        message = 'question_provenance_required';
    end if;

    v_provenance := p_question_provenance;
    v_rationale := case p_question_provenance
      when 'customer_supplied' then
        'Buyer question written by the customer and entered by the founder in the admin console; not independently scored.'
      else
        'Buyer question recommended or drafted by Zypact and entered by the founder in the admin console; not independently scored.'
    end;
  else
    if p_question_provenance is not null
       and p_question_provenance <> 'customer_supplied' then
      raise exception using
        errcode = '22023',
        message = 'question_provenance_not_allowed_for_public_form';
    end if;

    v_provenance := 'customer_supplied';
    v_rationale :=
      'Buyer question supplied directly by the requester via the public demo-request form; not independently scored.';
  end if;

  v_competitors := public._normalize_snapshot_competitors(p_competitors);

  if v_competitors is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_competitors_shape';
  end if;

  v_count := jsonb_array_length(v_competitors);

  if v_count < 2 then
    raise exception using
      errcode = '22023',
      message = 'competitors_below_minimum';
  end if;

  if v_count > 12 then
    raise exception using
      errcode = '22023',
      message = 'competitors_above_maximum';
  end if;

  for v_value in
    select value #>> '{}' from jsonb_array_elements(v_competitors) as value
  loop
    if char_length(v_value) > 200 then
      raise exception using
        errcode = '22023',
        message = 'competitor_too_long';
    end if;

    if lower(v_value) = lower(btrim(coalesce(v_request.company_name, '')))
       or lower(v_value) = lower(btrim(coalesce(v_request.normalized_domain, ''))) then
      raise exception using
        errcode = '22023',
        message = 'competitor_is_scanned_company';
    end if;
  end loop;

  v_project_id := public._ensure_snapshot_request_project(p_request_id);

  if v_project_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'snapshot_request_project_unavailable';
  end if;

  insert into public.buyer_questions (project_id)
  values (v_project_id)
  returning id into v_question_id;

  insert into public.buyer_question_versions (
    buyer_question_id, project_id, version_number,
    prompt_text, prompt_hash, intent_type,
    commercial_value, winnability, priority,
    rationale, provenance
  ) values (
    v_question_id, v_project_id, 1,
    v_request.buyer_category, p_prompt_hash, 'shortlist',
    3, 3, 13,
    v_rationale,
    v_provenance
  )
  returning id into v_version_id;

  select approval.status
    into v_version_status
    from public.approve_buyer_question_version(v_version_id, v_project_id, p_approved_by) as approval;

  if v_version_status <> 'APPROVED' then
    raise exception using
      errcode = 'P0001',
      message = format('unexpected_buyer_question_version_approval_status:%s', v_version_status);
  end if;

  insert into public.protocols (
    project_id, buyer_question_version_id, provider, surface, model_config,
    planned_baseline_runs, planned_retest_runs,
    unit_of_analysis, primary_metric, sample_planning_method,
    run_cap, spend_cap_usd, time_window_seconds,
    rate_limit_per_hour, concurrency_limit, retry_cap,
    paraphrase_plan
  ) values (
    v_project_id, v_version_id, 'perplexity_sonar', 'answer',
    jsonb_build_object('model', 'sonar'),
    -- D-032: 5 planned baseline runs for protocols created from here on.
    5, 0,
    'buyer_question_version', 'presence_rate', 'fixed_operator_default_pending_pilot_calibration',
    -- run_cap keeps two attempts of retry headroom above the plan.
    7, 2, 86400,
    10, 1, 2,
    -- The one approved question, from the same locked request row and the
    -- same hash written to buyer_question_versions above. With one entry,
    -- every planned run sends the identical approved question.
    jsonb_build_array(
      jsonb_build_object('text', v_request.buyer_category, 'hash', p_prompt_hash)
    )
  )
  returning id into v_protocol_id;

  select approval.status
    into v_protocol_status
    from public.approve_protocol(v_protocol_id, v_project_id, p_approved_by) as approval;

  if v_protocol_status <> 'APPROVED' then
    raise exception using
      errcode = 'P0001',
      message = format('unexpected_protocol_approval_status:%s', v_protocol_status);
  end if;

  select enqueue.status
    into v_enqueue_status
    from public.enqueue_protocol_execution_job(v_protocol_id, v_project_id) as enqueue;

  if v_enqueue_status <> 'QUEUED' then
    raise exception using
      errcode = 'P0001',
      message = format('unexpected_protocol_execution_job_enqueue_status:%s', v_enqueue_status);
  end if;

  return query
  update public.snapshot_requests
     set competitors = v_competitors,
         status = 'approved',
         approved_at = now(),
         approved_by = p_approved_by,
         project_id = v_project_id,
         protocol_id = v_protocol_id,
         updated_at = now()
   where id = p_request_id
     and status = 'pending_approval'
  returning *;
end;
$$;

revoke all on function
  public.approve_and_launch_snapshot_baseline(uuid, uuid, jsonb, text, text)
from public;
revoke all on function
  public.approve_and_launch_snapshot_baseline(uuid, uuid, jsonb, text, text)
from anon;
revoke all on function
  public.approve_and_launch_snapshot_baseline(uuid, uuid, jsonb, text, text)
from authenticated;

grant execute on function
  public.approve_and_launch_snapshot_baseline(uuid, uuid, jsonb, text, text)
to service_role;
