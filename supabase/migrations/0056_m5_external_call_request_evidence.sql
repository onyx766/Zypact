-- M5-A — Request evidence before the wire, and closed failure transitions.
--
-- Gap closed. `mark_external_call_sent_for_job` (0050) records THAT a
-- request left -- status 'in_progress', probe_run_id, request_sent_at --
-- but never WHAT left. The exact bytes appear only afterwards, in the
-- receipt. A crash between the wire and the receipt therefore leaves a
-- frontier that says "we may have paid" without saying what for.
--
-- This migration adds `external_call_requests`: one immutable row per
-- external call, carrying the exact outbound body and its SHA-256,
-- inserted in the SAME transaction as the status transition and BEFORE
-- it, so a failed insert provably prevents the marker -- and therefore
-- the network call.
--
-- It also closes three holes the M5-A runtime exposed:
--
--   1. `mark_external_call_sent_for_job` had no way to distinguish a
--      genuine replay from a second send. Its old CONFLICT branch fired
--      before any evidence was read, so an idempotent replay was
--      indistinguishable from a divergent one. The rewritten RPC reads
--      the evidence first and returns SENT / ALREADY_SENT_SAME_EVIDENCE /
--      REQUEST_EVIDENCE_CONFLICT. Only SENT authorises the wire.
--
--   2. Both receipt RPCs returned a bare CONFLICT and a null receipt, so
--      a caller could not tell "the same RPC was replayed after its reply
--      was lost" from "a second provider call happened". They now compare
--      EVERY evidentiary field -- latency and cost included, deliberately:
--      idempotence means replaying the same call with the same
--      parameters, and a second provider call cannot reproduce a latency.
--      A second call must conflict. The existing durable receipt is
--      returned either way, so replay reads from the ledger, never from
--      the response in hand.
--
--   3. `provider_outcome_unknown` moved the job to needs_review but left
--      the analysis leg 'reserved' and the attempt open, so
--      `reconcile_attempt_for_job` could only answer
--      EXTERNAL_CALLS_NOT_TERMINAL for ever. `_close_unknown_outcome_core`
--      now runs INSIDE the receipt RPC's own transaction: cancel the
--      unsent legs, terminalise the attempt, move the job, emit the
--      outbox row. One transaction, no second application call.
--
-- Two further closed transitions land here, because a caller had no way
-- to close a job at all:
--
--   * `fail_job_without_attempt_for_job` -- caps refused BEFORE any
--     attempt exists. The target status is decided server-side from the
--     reason; TypeScript never supplies one.
--   * `abort_attempt_and_fail_job_for_job` -- everything after an attempt
--     exists. Refuses while any call is still 'in_progress': a sent call
--     must receive its receipt first, or cancelling it would erase the
--     very frontier that prevents double spend.
--
-- Lock order is preserved throughout:
--   protocol_execution_jobs -> protocol_external_calls -> external_call_requests
-- matching every existing multi-table RPC, so no new deadlock class is
-- introduced.
--
-- Idempotence outranks fencing for an ALREADY-APPLIED transition: the
-- terminal-state check runs BEFORE the claim-token check, so a replay
-- after a lost commit -- whose lease has since lapsed -- reports
-- ALREADY_CLOSED rather than JOB_NOT_OWNED. A partially applied state
-- reports STATE_CONFLICT and is never silently completed.

-- ---------------------------------------------------------------------
-- 1. external_call_requests — append-only request evidence.
-- ---------------------------------------------------------------------

create table if not exists public.external_call_requests (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null,
  external_call_id      uuid not null unique,
  call_kind             text not null check (call_kind in ('perplexity', 'analysis')),
  request_body          text not null,
  request_body_sha256   text not null,
  recorded_at           timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'external_call_requests_sha256_format_check'
  ) then
    alter table public.external_call_requests
      add constraint external_call_requests_sha256_format_check
      check (request_body_sha256 ~ '^[0-9a-f]{64}$');
  end if;
end $$;

-- The hash is verified server-side against the stored body. A row whose
-- declared hash does not cover its own body is not evidence.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'external_call_requests_sha256_matches_body_check'
  ) then
    alter table public.external_call_requests
      add constraint external_call_requests_sha256_matches_body_check
      check (request_body_sha256 = public._sha256_hex(request_body));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'external_call_requests_call_project_fk'
  ) then
    alter table public.external_call_requests
      add constraint external_call_requests_call_project_fk
      foreign key (external_call_id, project_id)
      references public.protocol_external_calls (id, project_id);
  end if;
end $$;

create index if not exists external_call_requests_project_idx
  on public.external_call_requests (project_id, recorded_at);

alter table public.external_call_requests enable row level security;

-- Append-only by privilege, exactly as provider_call_receipts (0050) and
-- probe_results (0036): service_role may read and nothing else. Every
-- insert goes through a SECURITY DEFINER RPC, which runs as the owner.
revoke all on table public.external_call_requests from public, anon, authenticated, service_role;
grant select on table public.external_call_requests to service_role;

-- ---------------------------------------------------------------------
-- 2. Outbox reason codes — the closed set gains this migration's causes.
-- ---------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'protocol_execution_job_alerts_reason_code_check'
  ) then
    alter table public.protocol_execution_job_alerts
      drop constraint protocol_execution_job_alerts_reason_code_check;
  end if;

  alter table public.protocol_execution_job_alerts
    add constraint protocol_execution_job_alerts_reason_code_check
    check (
      (event_type = 'needs_review' and reason_code in (
        'perplexity_outcome_unknown',
        'analysis_outcome_unknown',
        'ambiguous_external_call_sent_without_receipt',
        'request_evidence_conflict',
        'receipt_evidence_conflict',
        'throttled_retries_exhausted',
        'slot_budget_exhausted'
      ))
      or
      (event_type = 'abandoned_exhausted' and reason_code = 'attempts_exhausted')
    );
end $$;

-- ---------------------------------------------------------------------
-- 3. Private helpers.
-- ---------------------------------------------------------------------

-- Moves a job to needs_review and emits one outbox row plus its delivery.
-- Idempotent by construction: the UPDATE only matches a live job, and the
-- alert is inserted only for a row the UPDATE actually transitioned.
create or replace function public._move_job_to_needs_review(
  p_job_id uuid,
  p_project_id uuid,
  p_reason_code text,
  p_attempt_id uuid,
  p_external_call_id uuid
)
returns void
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
begin
  with transitioned as (
    update public.protocol_execution_jobs j
       set status = 'needs_review',
           needs_review_reason = p_reason_code,
           updated_at = now()
     where j.id = p_job_id
       and j.project_id = p_project_id
       and j.status in ('claimed', 'running')
    returning j.id, j.project_id
  ),
  inserted_alert as (
    insert into public.protocol_execution_job_alerts (
      project_id, job_id, event_type, reason_code, source_attempt_id, source_external_call_id
    )
    select t.project_id, t.id, 'needs_review', p_reason_code, p_attempt_id, p_external_call_id
      from transitioned t
    returning alert_event_id
  )
  insert into public.protocol_execution_job_alert_deliveries (alert_event_id)
  select alert_event_id from inserted_alert;
end;
$$;

revoke all on function public._move_job_to_needs_review(uuid, uuid, text, uuid, uuid)
  from public, anon, authenticated, service_role;

-- T1 — the whole unknown-outcome closure, running inside the caller's
-- transaction. The caller has already inserted the receipt and
-- terminalised the call it sent; this closes everything else.
create or replace function public._close_unknown_outcome_core(
  p_job_id uuid,
  p_project_id uuid,
  p_attempt_id uuid,
  p_external_call_id uuid,
  p_reason_code text
)
returns void
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
begin
  -- Legs that never went on the wire cost nothing and are cancelled.
  -- A leg still 'in_progress' is deliberately left alone: it was sent,
  -- and only its own receipt may terminalise it.
  update public.protocol_external_calls
     set status = 'cancelled',
         terminalized_at = now()
   where protocol_attempt_id = p_attempt_id
     and project_id = p_project_id
     and status = 'reserved';

  -- The attempt is inconclusive, not failed: we do not know whether the
  -- provider did the work. 'timed_out' is the honest terminal label.
  update public.protocol_attempts
     set status = 'timed_out',
         termination_reason = p_reason_code,
         terminalized_at = now(),
         last_activity_at = now()
   where id = p_attempt_id
     and project_id = p_project_id
     and terminalized_at is null;

  perform public._move_job_to_needs_review(
    p_job_id, p_project_id, p_reason_code, p_attempt_id, p_external_call_id
  );
end;
$$;

revoke all on function public._close_unknown_outcome_core(uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. mark_external_call_sent_for_job — eight arguments, evidence first.
-- ---------------------------------------------------------------------

-- The five-argument form cannot carry the body, so it is dropped rather
-- than overloaded: an overload would leave a signature that still allows
-- marking a call without recording what is about to be sent.
drop function if exists public.mark_external_call_sent_for_job(uuid, uuid, uuid, uuid, uuid);

create or replace function
  public.mark_external_call_sent_for_job(
    p_job_id uuid,
    p_claim_token uuid,
    p_project_id uuid,
    p_external_call_id uuid,
    p_probe_run_id uuid,
    p_call_kind text,
    p_request_body text,
    p_request_body_sha256 text
  )
returns table (
  status        text,
  external_call public.protocol_external_calls
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  v_call public.protocol_external_calls%rowtype;
  v_evidence public.external_call_requests%rowtype;
begin
  if p_job_id is null or p_claim_token is null or p_project_id is null
     or p_external_call_id is null or p_probe_run_id is null
     or p_call_kind is null or p_request_body is null or p_request_body_sha256 is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_mark_external_call_sent_for_job_args';
  end if;

  if p_call_kind not in ('perplexity', 'analysis') then
    raise exception using
      errcode = '22023',
      message = 'invalid_mark_external_call_sent_for_job_args';
  end if;

  -- The declared hash must cover the declared body. Checked here as well
  -- as by the table CHECK, so a divergent pair is refused before it can
  -- be compared against stored evidence.
  if p_request_body_sha256 <> public._sha256_hex(p_request_body) then
    raise exception using
      errcode = '22023',
      message = 'invalid_mark_external_call_sent_for_job_args';
  end if;

  -- Lock order, unchanged from every other multi-table RPC:
  -- jobs -> external_calls -> external_call_requests.
  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id
   for update;

  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_external_calls;
    return;
  end if;

  if v_job.claim_token is distinct from p_claim_token
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= now()
     or v_job.status not in ('claimed', 'running') then
    return query select 'JOB_NOT_OWNED'::text, null::public.protocol_external_calls;
    return;
  end if;

  select ec.* into v_call
    from public.protocol_external_calls ec
   where ec.id = p_external_call_id and ec.project_id = p_project_id
   for update;

  if not found then
    return query select 'NOT_FOUND'::text, null::public.protocol_external_calls;
    return;
  end if;

  if not exists (
    select 1 from public.protocol_attempts pa
     where pa.id = v_call.protocol_attempt_id
       and pa.job_id = p_job_id
       and pa.project_id = p_project_id
  ) then
    return query select 'CALL_NOT_OWNED_BY_JOB'::text, null::public.protocol_external_calls;
    return;
  end if;

  if v_call.call_kind <> p_call_kind then
    return query select 'WRONG_CALL_KIND'::text, v_call;
    return;
  end if;

  -- Evidence is read BEFORE any status decision: that is what makes a
  -- genuine replay distinguishable from a second send.
  select r.* into v_evidence
    from public.external_call_requests r
   where r.external_call_id = p_external_call_id
   for update;

  if v_call.status = 'reserved' and not found then
    insert into public.external_call_requests (
      project_id, external_call_id, call_kind, request_body, request_body_sha256
    ) values (
      p_project_id, p_external_call_id, p_call_kind, p_request_body, p_request_body_sha256
    );

    update public.protocol_external_calls ec
       set status = 'in_progress',
           probe_run_id = p_probe_run_id,
           request_sent_at = now()
     where ec.id = p_external_call_id
       and ec.project_id = p_project_id
       and ec.status = 'reserved'
    returning * into v_call;

    return query select 'SENT'::text, v_call;
    return;
  end if;

  if found
     and v_call.status <> 'reserved'
     and v_evidence.call_kind = p_call_kind
     and v_evidence.request_body_sha256 = p_request_body_sha256
     and v_evidence.request_body = p_request_body then
    -- The call left 'reserved' and this exact request is on record: it
    -- was sent once. The caller replays from its receipt, never the wire.
    return query select 'ALREADY_SENT_SAME_EVIDENCE'::text, v_call;
    return;
  end if;

  -- Everything else is unresolvable without a human, including the
  -- structurally impossible "still reserved but evidence already on
  -- record": the insert and the status transition share one transaction,
  -- so that pair cannot arise from this RPC. Seeing it means the ledger
  -- was written by something else, and guessing would be worse than
  -- stopping.

  perform public._move_job_to_needs_review(
    p_job_id, p_project_id, 'request_evidence_conflict',
    v_call.protocol_attempt_id, p_external_call_id
  );
  return query select 'REQUEST_EVIDENCE_CONFLICT'::text, v_call;
end;
$$;

revoke all on function
  public.mark_external_call_sent_for_job(uuid, uuid, uuid, uuid, uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function
  public.mark_external_call_sent_for_job(uuid, uuid, uuid, uuid, uuid, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------
-- 5. record_provider_call_receipt_for_job — full-field identity, T1 inline.
-- ---------------------------------------------------------------------

create or replace function
  public.record_provider_call_receipt_for_job(
    p_job_id uuid,
    p_claim_token uuid,
    p_project_id uuid,
    p_external_call_id uuid,
    p_probe_run_id uuid,
    p_outcome text,
    p_http_status integer default null,
    p_provider_request_id text default null,
    p_raw_response_sha256 text default null,
    p_latency_ms integer default null,
    p_actual_cost_usd numeric default null,
    p_cost_basis text default null,
    p_raw_response_body text default null
  )
returns table (
  status        text,
  external_call public.protocol_external_calls,
  receipt       public.provider_call_receipts
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  v_call public.protocol_external_calls%rowtype;
  v_receipt public.provider_call_receipts%rowtype;
  v_existing public.provider_call_receipts%rowtype;
  v_new_status text;
begin
  if p_job_id is null or p_claim_token is null or p_project_id is null
     or p_external_call_id is null or p_probe_run_id is null or p_outcome is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_record_provider_call_receipt_for_job_args';
  end if;

  if p_outcome not in ('success', 'provider_error', 'provider_outcome_unknown') then
    raise exception using
      errcode = '22023',
      message = 'invalid_record_provider_call_receipt_for_job_args';
  end if;

  if (p_actual_cost_usd is null) <> (p_cost_basis is null) then
    raise exception using
      errcode = '22023',
      message = 'invalid_record_provider_call_receipt_for_job_args';
  end if;

  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id
   for update;

  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_external_calls, null::public.provider_call_receipts;
    return;
  end if;

  if v_job.claim_token is distinct from p_claim_token
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= now()
     or v_job.status not in ('claimed', 'running') then
    return query select 'JOB_NOT_OWNED'::text, null::public.protocol_external_calls, null::public.provider_call_receipts;
    return;
  end if;

  select ec.* into v_call
    from public.protocol_external_calls ec
   where ec.id = p_external_call_id and ec.project_id = p_project_id
   for update;

  if not found then
    return query select 'NOT_FOUND'::text, null::public.protocol_external_calls, null::public.provider_call_receipts;
    return;
  end if;

  if v_call.call_kind <> 'perplexity' then
    return query select 'WRONG_CALL_KIND'::text, v_call, null::public.provider_call_receipts;
    return;
  end if;

  if not exists (
    select 1 from public.protocol_attempts pa
     where pa.id = v_call.protocol_attempt_id
       and pa.job_id = p_job_id
       and pa.project_id = p_project_id
  ) then
    return query select 'CALL_NOT_OWNED_BY_JOB'::text, null::public.protocol_external_calls, null::public.provider_call_receipts;
    return;
  end if;

  -- A receipt already on record decides everything. Idempotence here
  -- means "this same RPC was replayed after its reply was lost", so the
  -- comparison covers EVERY evidentiary field, latency and cost
  -- included: a second provider call cannot reproduce a latency, and it
  -- must therefore conflict rather than pass as a replay.
  select r.* into v_existing
    from public.provider_call_receipts r
   where r.external_call_id = p_external_call_id;

  if found then
    if v_existing.probe_run_id is not distinct from p_probe_run_id
       and v_existing.outcome is not distinct from p_outcome
       and v_existing.http_status is not distinct from p_http_status
       and v_existing.provider_request_id is not distinct from p_provider_request_id
       and v_existing.raw_response_sha256 is not distinct from p_raw_response_sha256
       and v_existing.raw_response_body is not distinct from p_raw_response_body
       and v_existing.latency_ms is not distinct from p_latency_ms
       and v_call.actual_cost_usd is not distinct from p_actual_cost_usd
       and v_call.cost_basis is not distinct from p_cost_basis then
      return query select 'ALREADY_RECEIPTED_IDENTICAL'::text, v_call, v_existing;
      return;
    end if;

    perform public._move_job_to_needs_review(
      p_job_id, p_project_id, 'receipt_evidence_conflict',
      v_call.protocol_attempt_id, p_external_call_id
    );
    return query select 'RECEIPT_EVIDENCE_CONFLICT'::text, v_call, v_existing;
    return;
  end if;

  if v_call.status <> 'in_progress' or v_call.probe_run_id is distinct from p_probe_run_id then
    return query select 'CONFLICT'::text, v_call, null::public.provider_call_receipts;
    return;
  end if;

  insert into public.provider_call_receipts (
    project_id, external_call_id, probe_run_id, outcome, http_status,
    provider_request_id, raw_response_sha256, latency_ms, raw_response_body
  ) values (
    p_project_id, p_external_call_id, p_probe_run_id, p_outcome, p_http_status,
    p_provider_request_id, p_raw_response_sha256, p_latency_ms, p_raw_response_body
  )
  returning * into v_receipt;

  v_new_status := case p_outcome
    when 'success' then 'completed'
    when 'provider_error' then 'failed'
    else 'timed_out'
  end;

  update public.protocol_external_calls
     set status = v_new_status,
         actual_cost_usd = p_actual_cost_usd,
         cost_basis = p_cost_basis,
         terminalized_at = now()
   where id = p_external_call_id and project_id = p_project_id
  returning * into v_call;

  -- T1, in this same transaction: the unsent legs are cancelled, the
  -- attempt is terminalised and the job moves, so reconcile can never be
  -- left answering EXTERNAL_CALLS_NOT_TERMINAL for ever.
  if p_outcome = 'provider_outcome_unknown' then
    perform public._close_unknown_outcome_core(
      p_job_id, p_project_id, v_call.protocol_attempt_id,
      p_external_call_id, 'perplexity_outcome_unknown'
    );
  end if;

  return query select 'RECEIPTED'::text, v_call, v_receipt;
end;
$$;

revoke all on function public.record_provider_call_receipt_for_job(
  uuid, uuid, uuid, uuid, uuid, text, integer, text, text, integer, numeric, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_provider_call_receipt_for_job(
  uuid, uuid, uuid, uuid, uuid, text, integer, text, text, integer, numeric, text, text
) to service_role;

-- ---------------------------------------------------------------------
-- 6. record_analysis_call_receipt_for_job — identity, request cross-check, T1.
-- ---------------------------------------------------------------------

create or replace function
  public.record_analysis_call_receipt_for_job(
    p_job_id uuid,
    p_claim_token uuid,
    p_project_id uuid,
    p_external_call_id uuid,
    p_probe_run_id uuid,
    p_outcome text,
    p_provider text default null,
    p_model text default null,
    p_used_mock boolean default false,
    p_request_sha256 text default null,
    p_response_sha256 text default null,
    p_latency_ms integer default null,
    p_actual_cost_usd numeric default null,
    p_cost_basis text default null,
    p_raw_content text default null,
    p_raw_request_body text default null
  )
returns table (
  status        text,
  external_call public.protocol_external_calls,
  receipt       public.analysis_call_receipts
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  v_call public.protocol_external_calls%rowtype;
  v_receipt public.analysis_call_receipts%rowtype;
  v_existing public.analysis_call_receipts%rowtype;
  v_evidence public.external_call_requests%rowtype;
  v_new_status text;
begin
  if p_job_id is null or p_claim_token is null or p_project_id is null
     or p_external_call_id is null or p_probe_run_id is null or p_outcome is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_record_analysis_call_receipt_for_job_args';
  end if;

  if p_outcome not in ('success', 'provider_error', 'provider_outcome_unknown') then
    raise exception using
      errcode = '22023',
      message = 'invalid_record_analysis_call_receipt_for_job_args';
  end if;

  if (p_actual_cost_usd is null) <> (p_cost_basis is null) then
    raise exception using
      errcode = '22023',
      message = 'invalid_record_analysis_call_receipt_for_job_args';
  end if;

  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id
   for update;

  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_external_calls, null::public.analysis_call_receipts;
    return;
  end if;

  if v_job.claim_token is distinct from p_claim_token
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= now()
     or v_job.status not in ('claimed', 'running') then
    return query select 'JOB_NOT_OWNED'::text, null::public.protocol_external_calls, null::public.analysis_call_receipts;
    return;
  end if;

  select ec.* into v_call
    from public.protocol_external_calls ec
   where ec.id = p_external_call_id and ec.project_id = p_project_id
   for update;

  if not found then
    return query select 'NOT_FOUND'::text, null::public.protocol_external_calls, null::public.analysis_call_receipts;
    return;
  end if;

  if v_call.call_kind <> 'analysis' then
    return query select 'WRONG_CALL_KIND'::text, v_call, null::public.analysis_call_receipts;
    return;
  end if;

  if not exists (
    select 1 from public.protocol_attempts pa
     where pa.id = v_call.protocol_attempt_id
       and pa.job_id = p_job_id
       and pa.project_id = p_project_id
  ) then
    return query select 'CALL_NOT_OWNED_BY_JOB'::text, null::public.protocol_external_calls, null::public.analysis_call_receipts;
    return;
  end if;

  select r.* into v_existing
    from public.analysis_call_receipts r
   where r.external_call_id = p_external_call_id;

  if found then
    if v_existing.probe_run_id is not distinct from p_probe_run_id
       and v_existing.outcome is not distinct from p_outcome
       and v_existing.provider is not distinct from p_provider
       and v_existing.model is not distinct from p_model
       and v_existing.used_mock is not distinct from coalesce(p_used_mock, false)
       and v_existing.request_sha256 is not distinct from p_request_sha256
       and v_existing.raw_request_body is not distinct from p_raw_request_body
       and v_existing.response_sha256 is not distinct from p_response_sha256
       and v_existing.raw_content is not distinct from p_raw_content
       and v_existing.latency_ms is not distinct from p_latency_ms
       and v_call.actual_cost_usd is not distinct from p_actual_cost_usd
       and v_call.cost_basis is not distinct from p_cost_basis then
      return query select 'ALREADY_RECEIPTED_IDENTICAL'::text, v_call, v_existing;
      return;
    end if;

    perform public._move_job_to_needs_review(
      p_job_id, p_project_id, 'receipt_evidence_conflict',
      v_call.protocol_attempt_id, p_external_call_id
    );
    return query select 'RECEIPT_EVIDENCE_CONFLICT'::text, v_call, v_existing;
    return;
  end if;

  -- Two durable proofs of the same request may never contradict each
  -- other. `external_call_requests` recorded what was about to be sent;
  -- the receipt claims what was sent. If they disagree, one of them is
  -- wrong and neither can be trusted.
  select r.* into v_evidence
    from public.external_call_requests r
   where r.external_call_id = p_external_call_id;

  -- D-027's mock policy mandates BOTH request fields null when used_mock
  -- is true, so there is nothing to compare for a simulated call.
  if found
     and coalesce(p_used_mock, false) = false
     and (v_evidence.request_body is distinct from p_raw_request_body
          or v_evidence.request_body_sha256 is distinct from p_request_sha256) then
    perform public._move_job_to_needs_review(
      p_job_id, p_project_id, 'request_evidence_conflict',
      v_call.protocol_attempt_id, p_external_call_id
    );
    return query select 'REQUEST_EVIDENCE_CONFLICT'::text, v_call, null::public.analysis_call_receipts;
    return;
  end if;

  if v_call.status <> 'in_progress' or v_call.probe_run_id is distinct from p_probe_run_id then
    return query select 'CONFLICT'::text, v_call, null::public.analysis_call_receipts;
    return;
  end if;

  insert into public.analysis_call_receipts (
    project_id, external_call_id, probe_run_id, outcome, provider,
    model, used_mock, request_sha256, response_sha256, latency_ms, raw_content,
    raw_request_body
  ) values (
    p_project_id, p_external_call_id, p_probe_run_id, p_outcome, p_provider,
    p_model, coalesce(p_used_mock, false), p_request_sha256, p_response_sha256, p_latency_ms, p_raw_content,
    p_raw_request_body
  )
  returning * into v_receipt;

  v_new_status := case p_outcome
    when 'success' then 'completed'
    when 'provider_error' then 'failed'
    else 'timed_out'
  end;

  update public.protocol_external_calls
     set status = v_new_status,
         actual_cost_usd = p_actual_cost_usd,
         cost_basis = p_cost_basis,
         terminalized_at = now()
   where id = p_external_call_id and project_id = p_project_id
  returning * into v_call;

  if p_outcome = 'provider_outcome_unknown' then
    perform public._close_unknown_outcome_core(
      p_job_id, p_project_id, v_call.protocol_attempt_id,
      p_external_call_id, 'analysis_outcome_unknown'
    );
  end if;

  return query select 'RECEIPTED'::text, v_call, v_receipt;
end;
$$;

revoke all on function public.record_analysis_call_receipt_for_job(
  uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_analysis_call_receipt_for_job(
  uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text, text, text
) to service_role;

-- ---------------------------------------------------------------------
-- 7. T2 — job-only closure, for refusals that happen before an attempt.
-- ---------------------------------------------------------------------

-- A cap can be refused before `admit_and_reserve_attempt_for_job` creates
-- anything, so there is no attempt id to pass and nothing to terminalise.
-- The target status is derived from the reason, server-side: a caller
-- never supplies one, so TypeScript cannot invent a destination.
--
--   run_cap_exceeded / spend_cap_exceeded / retry_cap_exceeded  -> failed
--   throttled_retries_exhausted / slot_budget_exhausted         -> needs_review + outbox
create or replace function
  public.fail_job_without_attempt_for_job(
    p_job_id uuid,
    p_claim_token uuid,
    p_project_id uuid,
    p_reason text
  )
returns table (
  status text,
  job    public.protocol_execution_jobs
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  v_target text;
  v_open_attempts integer;
begin
  if p_job_id is null or p_claim_token is null or p_project_id is null or p_reason is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_fail_job_without_attempt_for_job_args';
  end if;

  if p_reason in ('run_cap_exceeded', 'spend_cap_exceeded', 'retry_cap_exceeded') then
    v_target := 'failed';
  elsif p_reason in ('throttled_retries_exhausted', 'slot_budget_exhausted') then
    v_target := 'needs_review';
  else
    raise exception using
      errcode = '22023',
      message = 'invalid_fail_job_without_attempt_for_job_args';
  end if;

  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id
   for update;

  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_execution_jobs;
    return;
  end if;

  -- Idempotence outranks fencing for a transition that already landed:
  -- a replay after a lost commit must not be told JOB_NOT_OWNED simply
  -- because its lease lapsed in the meantime.
  if v_job.status = v_target
     and coalesce(v_job.failure_reason, v_job.needs_review_reason) is not distinct from p_reason then
    if v_job.current_attempt_id is null then
      return query select 'ALREADY_CLOSED'::text, v_job;
    else
      return query select 'STATE_CONFLICT'::text, v_job;
    end if;
    return;
  end if;

  if v_job.status in ('failed', 'needs_review', 'succeeded', 'abandoned_exhausted') then
    return query select 'STATE_CONFLICT'::text, v_job;
    return;
  end if;

  if v_job.claim_token is distinct from p_claim_token
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= now()
     or v_job.status not in ('claimed', 'running') then
    return query select 'JOB_NOT_OWNED'::text, v_job;
    return;
  end if;

  -- This transition closes a job that has nothing open. An attempt that
  -- exists must be closed by T3, which knows how to terminalise it.
  select count(*) into v_open_attempts
    from public.protocol_attempts pa
   where pa.job_id = p_job_id
     and pa.project_id = p_project_id
     and pa.terminalized_at is null;

  if v_open_attempts > 0 or v_job.current_attempt_id is not null then
    return query select 'ATTEMPT_STILL_OPEN'::text, v_job;
    return;
  end if;

  if v_target = 'failed' then
    update public.protocol_execution_jobs j
       set status = 'failed', failure_reason = p_reason, updated_at = now()
     where j.id = p_job_id and j.project_id = p_project_id
    returning * into v_job;
  else
    perform public._move_job_to_needs_review(p_job_id, p_project_id, p_reason, null, null);
    select j.* into v_job
      from public.protocol_execution_jobs j
     where j.id = p_job_id and j.project_id = p_project_id;
  end if;

  return query select 'CLOSED'::text, v_job;
end;
$$;

revoke all on function public.fail_job_without_attempt_for_job(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.fail_job_without_attempt_for_job(uuid, uuid, uuid, text)
  to service_role;

-- ---------------------------------------------------------------------
-- 8. T3 — attempt + job closure, for everything after an attempt exists.
-- ---------------------------------------------------------------------

create or replace function
  public.abort_attempt_and_fail_job_for_job(
    p_job_id uuid,
    p_claim_token uuid,
    p_project_id uuid,
    p_attempt_id uuid,
    p_attempt_status text,
    p_termination_reason text,
    p_failure_reason text
  )
returns table (
  status  text,
  attempt public.protocol_attempts,
  job     public.protocol_execution_jobs
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  v_attempt public.protocol_attempts%rowtype;
  v_in_progress integer;
  v_open integer;
begin
  if p_job_id is null or p_claim_token is null or p_project_id is null
     or p_attempt_id is null or p_attempt_status is null or p_failure_reason is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_abort_attempt_and_fail_job_for_job_args';
  end if;

  if p_attempt_status not in ('failed', 'timed_out', 'cancelled', 'excluded') then
    raise exception using
      errcode = '22023',
      message = 'invalid_abort_attempt_and_fail_job_for_job_args';
  end if;

  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id
   for update;

  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_attempts, null::public.protocol_execution_jobs;
    return;
  end if;

  select pa.* into v_attempt
    from public.protocol_attempts pa
   where pa.id = p_attempt_id and pa.project_id = p_project_id and pa.job_id = p_job_id
   for update;

  if not found then
    return query select 'ATTEMPT_NOT_OWNED_BY_JOB'::text, null::public.protocol_attempts, v_job;
    return;
  end if;

  -- Full idempotence, evaluated before fencing. ALREADY_ABORTED requires
  -- the WHOLE transition to be on record: the job's status and reason,
  -- the attempt terminal at the requested status, and no call left
  -- un-cancelled. Anything partial is STATE_CONFLICT -- never silently
  -- completed, because a half-applied close is a fact worth surfacing.
  select count(*) into v_open
    from public.protocol_external_calls ec
   where ec.protocol_attempt_id = p_attempt_id
     and ec.project_id = p_project_id
     and ec.status in ('reserved', 'in_progress');

  if v_job.status = 'failed'
     or v_attempt.terminalized_at is not null then
    if v_job.status = 'failed'
       and v_job.failure_reason is not distinct from p_failure_reason
       and v_attempt.terminalized_at is not null
       and v_attempt.status = p_attempt_status
       and v_attempt.termination_reason is not distinct from p_termination_reason
       and v_open = 0 then
      return query select 'ALREADY_ABORTED'::text, v_attempt, v_job;
    else
      return query select 'STATE_CONFLICT'::text, v_attempt, v_job;
    end if;
    return;
  end if;

  if v_job.claim_token is distinct from p_claim_token
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= now()
     or v_job.status not in ('claimed', 'running') then
    return query select 'JOB_NOT_OWNED'::text, v_attempt, v_job;
    return;
  end if;

  -- A call that is still 'in_progress' was actually sent. Cancelling it
  -- would erase the one frontier that stops a replay from paying twice,
  -- so it must receive its receipt first.
  select count(*) into v_in_progress
    from public.protocol_external_calls ec
   where ec.protocol_attempt_id = p_attempt_id
     and ec.project_id = p_project_id
     and ec.status = 'in_progress';

  if v_in_progress > 0 then
    return query select 'CALL_STILL_IN_PROGRESS'::text, v_attempt, v_job;
    return;
  end if;

  update public.protocol_external_calls
     set status = 'cancelled',
         terminalized_at = now()
   where protocol_attempt_id = p_attempt_id
     and project_id = p_project_id
     and status = 'reserved';

  update public.protocol_attempts
     set status = p_attempt_status,
         termination_reason = p_termination_reason,
         terminalized_at = now(),
         last_activity_at = now()
   where id = p_attempt_id
     and project_id = p_project_id
     and terminalized_at is null
  returning * into v_attempt;

  update public.protocol_execution_jobs j
     set status = 'failed',
         failure_reason = p_failure_reason,
         current_attempt_id = null,
         updated_at = now()
   where j.id = p_job_id and j.project_id = p_project_id
  returning * into v_job;

  return query select 'ABORTED'::text, v_attempt, v_job;
end;
$$;

revoke all on function public.abort_attempt_and_fail_job_for_job(uuid, uuid, uuid, uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.abort_attempt_and_fail_job_for_job(uuid, uuid, uuid, uuid, text, text, text)
  to service_role;
