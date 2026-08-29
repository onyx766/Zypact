-- M5-A — Transport evidence on the analysis receipt (TK-R-1 .. TK-R-4).
--
-- `analysis_call_receipts` already proves WHAT was sent (raw_request_body,
-- request_sha256 since 0053) and WHAT came back (raw_content,
-- response_sha256). It does not prove HOW the exchange went. Three
-- transport facts the runtime already holds are discarded before they
-- reach durable evidence:
--
--   TK-R-1  the model the provider ACTUALLY served. `model` records the
--           model we ASKED for. A provider is free to serve another one --
--           that is precisely what a floating alias does. Recording only
--           the request makes an unverifiable claim about the response.
--           The two are therefore stored separately and never merged:
--           `model` stays the requested model, `model_returned` carries
--           the provider's own echo (OpenAI: the top-level `model` of the
--           completion body) and is NULL whenever the provider said
--           nothing. There is no backfill: the four historical rows
--           predate the capture and genuinely do not know.
--
--   TK-R-2  `provider_request_id` -- the provider-side correlation id the
--           transport already extracts. Without it a disputed charge
--           cannot be tied to a provider-side record.
--
--   TK-R-3  `http_status` -- already extracted, already stored for probe
--           calls since 0050, absent here. NULL means no HTTP response was
--           received at all (DNS failure, abort, connect error); it is
--           never synthesised into a 0 or a 599.
--
-- TK-R-4 adds no column: `latency_ms` has existed since 0050 but the
-- success path never passed it. That is a caller fix, not a schema one.
--
-- All three columns are nullable, and stay nullable. The four rows
-- already in the table were written before any of this was captured, and
-- inventing values for them would fabricate evidence -- exactly what this
-- table exists to make impossible.
--
-- The columns join the receipt's identity comparison in
-- `record_analysis_call_receipt_for_job`. They are evidentiary: a replay
-- of the same RPC after a lost reply reproduces them exactly, while a
-- second provider call cannot reproduce a provider_request_id. Treating
-- them as identity is what makes the second case conflict instead of
-- silently overwriting -- the same reasoning 0056 applied to latency.

-- =======================================================================
-- 1. Columns.
-- =======================================================================

alter table public.analysis_call_receipts
  add column if not exists provider_request_id text null,
  add column if not exists http_status integer null,
  add column if not exists model_returned text null;

-- Domain guard for http_status, following the nullable-guarded CHECK
-- convention this table already uses for latency_ms (0050). The bound is
-- the RFC 9110 status-code range: a value outside 100..599 is not a
-- status the transport could have observed, so it is a bug, not evidence.
do $$
declare
  v_bad_count integer;
begin
  select count(*) into v_bad_count
    from public.analysis_call_receipts
   where http_status is not null
     and http_status not between 100 and 599;

  if v_bad_count > 0 then
    raise exception 'TK-R-3 preflight failed: % analysis_call_receipts rows have http_status outside 100..599', v_bad_count;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'analysis_call_receipts_http_status_range_check'
  ) then
    alter table public.analysis_call_receipts
      add constraint analysis_call_receipts_http_status_range_check
      check (http_status is null or http_status between 100 and 599);
  end if;
end $$;

-- =======================================================================
-- 2. record_analysis_call_receipt_for_job -- 16-arg form (0056) dropped
--    and recreated with three appended default-null parameters.
--
--    DROP then CREATE, not CREATE OR REPLACE: appending parameters
--    changes the signature, so a bare replace would leave the 16-arg
--    function in place as a second overload and make every call
--    ambiguous. Same discipline as 0052 and 0053.
--
--    The body below is 0056's, unchanged except for the three new
--    parameters in the identity comparison and the INSERT.
-- =======================================================================

drop function if exists public.record_analysis_call_receipt_for_job(
  uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text, text, text
);

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
    p_raw_request_body text default null,
    p_provider_request_id text default null,
    p_http_status integer default null,
    p_model_returned text default null
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

  -- Rejected at the door rather than by the CHECK, so a caller bug
  -- surfaces as an argument error and never as a constraint violation
  -- mid-transaction.
  if p_http_status is not null and p_http_status not between 100 and 599 then
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
       and v_existing.model_returned is not distinct from p_model_returned
       and v_existing.used_mock is not distinct from coalesce(p_used_mock, false)
       and v_existing.request_sha256 is not distinct from p_request_sha256
       and v_existing.raw_request_body is not distinct from p_raw_request_body
       and v_existing.response_sha256 is not distinct from p_response_sha256
       and v_existing.raw_content is not distinct from p_raw_content
       and v_existing.latency_ms is not distinct from p_latency_ms
       and v_existing.provider_request_id is not distinct from p_provider_request_id
       and v_existing.http_status is not distinct from p_http_status
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
    raw_request_body, provider_request_id, http_status, model_returned
  ) values (
    p_project_id, p_external_call_id, p_probe_run_id, p_outcome, p_provider,
    p_model, coalesce(p_used_mock, false), p_request_sha256, p_response_sha256, p_latency_ms, p_raw_content,
    p_raw_request_body, p_provider_request_id, p_http_status, p_model_returned
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
  uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text, text, text, text, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.record_analysis_call_receipt_for_job(
  uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text, text, text, text, integer, text
) to service_role;
