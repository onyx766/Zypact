-- Record the approved buyer question in the protocol's paraphrase_plan.
--
-- Root cause this migration fixes. Migration 0062's
-- `approve_and_launch_snapshot_baseline` inserts into `public.protocols`
-- without naming `paraphrase_plan`, so every protocol it created took the
-- column default from 0047 (`'[]'::jsonb`). The M5 worker reads the prompt
-- it is about to send from exactly that column and nowhere else
-- (`promptForSlot` in lib/protocol-worker/worker.ts: an empty plan returns
-- null), so the job was claimed, admitted, reserved and started, and then
-- failed `NO_PROMPT_IN_PLAN` before the provider leg. Observed on the first
-- real claim this worker has ever made: no provider call was issued and no
-- money was spent, but the attempt was left `in_progress` and the job
-- `running` with an expired lease, to be reclaimed by a later pass.
--
-- The function already holds both values it needs. `v_request.buyer_category`
-- is the buyer-question text it writes into `buyer_question_versions`
-- (despite the column's legacy name), and `p_prompt_hash` is the
-- application-computed hash of that same text, which migration 0047 makes
-- the application layer's authority. Writing the plan from those two
-- variables cannot introduce a third version of the question: the plan
-- entry, the approved `buyer_question_versions` row and the hash the founder
-- approved all come from one read of one locked request row.
--
-- Shape is `[{"text": ..., "hash": ...}]` — one entry, matching
-- `planned_baseline_runs = 3` through `promptForSlot`'s modulo over the
-- plan, so all three baseline runs send the identical approved question
-- rather than paraphrases. Paraphrase generation is not in V1 scope and is
-- not introduced here. The key names and the `Array<{text, hash}>` shape
-- are the ones lib/db/supabase-adapter.ts already maps.
--
-- Nothing else about the function changes: same signature, same competitor
-- validation, same idempotent-replay branch, same statuses, same grants.

create or replace function
  public.approve_and_launch_snapshot_baseline(
    p_request_id uuid,
    p_approved_by uuid,
    p_competitors jsonb,
    p_prompt_hash text
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
    'Buyer question supplied directly by the requester via the public demo-request form; not independently scored.',
    'customer_supplied'
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
    3, 0,
    'buyer_question_version', 'presence_rate', 'fixed_operator_default_pending_pilot_calibration',
    5, 2, 86400,
    10, 1, 2,
    -- The one approved question, from the same locked request row and the
    -- same hash written to buyer_question_versions above.
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
  public.approve_and_launch_snapshot_baseline(uuid, uuid, jsonb, text)
from public;
revoke all on function
  public.approve_and_launch_snapshot_baseline(uuid, uuid, jsonb, text)
from anon;
revoke all on function
  public.approve_and_launch_snapshot_baseline(uuid, uuid, jsonb, text)
from authenticated;

grant execute on function
  public.approve_and_launch_snapshot_baseline(uuid, uuid, jsonb, text)
to service_role;

-- Repair of rows already created with the empty default.
--
-- Deliberately narrow. It touches only protocols that are (a) still exactly
-- `'[]'::jsonb`, so a protocol carrying any real plan is never rewritten,
-- and (b) reachable from a `snapshot_requests.protocol_id`, which is the
-- only way a row created by the function above can be reached — protocols
-- from the M4/mvp-scan path are not referenced that way and are left alone.
--
-- This does not change question identity or re-approve anything. The text
-- and hash are copied from the protocol's own already-approved
-- `buyer_question_versions` row, so each protocol ends up carrying the
-- question its founder approved — which is what the insert should have
-- written. `prompt_hash` is copied rather than recomputed: 0047 gives the
-- application layer sole authority over that value, and this migration does
-- not take it.
update public.protocols p
   set paraphrase_plan = jsonb_build_array(
         jsonb_build_object('text', bqv.prompt_text, 'hash', bqv.prompt_hash)
       )
  from public.buyer_question_versions bqv
 where bqv.id = p.buyer_question_version_id
   and p.paraphrase_plan = '[]'::jsonb
   and bqv.prompt_text is not null
   and btrim(bqv.prompt_text) <> ''
   and bqv.prompt_hash is not null
   and btrim(bqv.prompt_hash) <> ''
   and exists (
     select 1
       from public.snapshot_requests s
      where s.protocol_id = p.id
   );
