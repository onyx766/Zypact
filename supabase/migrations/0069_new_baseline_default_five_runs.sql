-- Raise the default sample plan for NEW founder-approved baselines from 3
-- planned runs to 5.
--
-- Scope. This redefines `approve_and_launch_snapshot_baseline` (last defined
-- by 0063) and nothing else. It changes only the literal values the function
-- writes into a protocols row it is creating for the first time. It carries
-- no UPDATE, DELETE or backfill of any existing row, so every protocol that
-- already exists keeps exactly the plan it was approved with:
--   * a baseline that has started or completed keeps planned_baseline_runs = 3
--     and run_cap = 5, and its report keeps "N of 3 planned";
--   * a request already approved but not yet claimed is also untouched — its
--     protocol was frozen at approval, and approval is where the plan is fixed;
--   * the function's idempotent-replay branch returns an already-launched
--     request unchanged, so a repeated approval click can never swap an old
--     protocol for a new one.
-- Only a request still in `pending_approval` when this migration is applied
-- will, on approval, receive the new plan.
--
-- Why the plan cannot drift after approval. `protocols` has had every table
-- privilege revoked from public/anon/authenticated/service_role since 0047;
-- rows are written only through SECURITY DEFINER RPCs, and the only RPC
-- UPDATE on protocols (approve_protocol, 0047/0049) sets status and approval
-- fields, never a sampling field. The worker reads planned_baseline_runs from
-- the row on every slot (D-025), so each job executes the plan stored on its
-- own protocol.
--
-- Values:
--   planned_baseline_runs  3 -> 5
--   run_cap                5 -> 7. run_cap counts every non-cancelled attempt,
--                          retries included, and 0047's
--                          protocols_planned_le_run_cap CHECK requires it to be
--                          >= planned. Keeping the previous headroom of two
--                          attempts above the plan preserves the same room for
--                          bounded retries (retry_cap stays 2) instead of
--                          silently making a single failure unrecoverable.
--   spend_cap_usd          unchanged at 2. At the worker's default per-call
--                          reservations (0.02 USD Perplexity + 0.02 USD
--                          analysis, lib/protocol-worker/execution-mode.ts),
--                          seven attempts reserve 0.28 USD.
--   rate_limit_per_hour    unchanged at 10 (>= run_cap of 7).
--   everything else        unchanged, including sample_planning_method
--                          'fixed_operator_default_pending_pilot_calibration':
--                          5 is an operating default, not a claim of
--                          statistical sufficiency (METHODOLOGY.md section 7,
--                          D-001/D-002). See D-032.
--
-- Rollback / forward recovery. Re-applying 0063's function body restores the
-- 3/5 default for subsequent approvals. Neither direction touches existing
-- protocols, attempts, jobs, evidence or reports, so no data recovery is
-- ever needed.

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
