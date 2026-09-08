-- Connects founder approval of a snapshot_request to the canonical M4/M5
-- question/protocol/job contract.
--
-- Root cause this migration fixes (see docs/CURRENT_STATUS.md 5.3/6-2 and
-- ENGINEERING_PLAN.md M4): `approve_and_queue_snapshot_request` (0034) is a
-- single-statement status flip on `snapshot_requests` itself — it never
-- creates a `buyer_questions`/`buyer_question_versions` row, never creates
-- or approves a `protocols` row, and never enqueues a
-- `protocol_execution_jobs` row. The request it "queues" is picked up by
-- the legacy `claim_next_snapshot_request` worker path, which executes a
-- hardcoded, unapproved 5-prompt x 3-run sample
-- (lib/snapshot-worker/execution-options.ts) with no question/protocol
-- identity at all — exactly the fixed-sample pattern D-001/D-002 and
-- METHODOLOGY.md section 7 prohibit for anything but an internal smoke
-- test. The M4 buyer_question/protocol contract (migration 0047) and the
-- M5 protocol_execution_jobs contract (migration 0050, amended by
-- D-025/D-026 in 0051/0052) already fully exist and are already covered
-- by their own schema/runtime tests, but nothing outside test scripts and
-- adapter plumbing ever calls approve_buyer_question_version,
-- approve_protocol, or enqueue_protocol_execution_job — this migration is
-- the first real caller.
--
-- Why a new function rather than editing approve_and_queue_snapshot_request
-- (0034) in place: seven existing test scripts
-- (test-snapshot-request-competitors.ts, test-snapshot-progress.ts,
-- test-snapshot-project-reservation.ts, test-snapshot-completion.ts,
-- test-founder-report-review-ui.ts, test-approved-snapshot-dry-run.ts, and
-- their memory-adapter mirror) exercise the legacy 'queued' + worker-claim
-- behavior end to end through that exact function. Changing its behavior
-- or its resulting status would break all of them for no benefit — they
-- remain valid regression coverage of the legacy path, which is left
-- completely untouched here. Instead, this migration adds a new function,
-- and a later application-layer change (not this migration) points the
-- founder-facing approve route at it instead.
--
-- Why the new function's terminal status is 'approved', not 'queued':
-- claim_next_snapshot_request (0030) only ever selects
-- `status = 'queued' and approved_at is not null and approved_by is not
-- null`. Landing on 'approved' instead — a status value the
-- snapshot_requests_status_check constraint (0017) already allows, and
-- which the legacy claim query has never matched — is sufficient by
-- itself to keep the legacy worker from ever claiming a request approved
-- through this new path. No change to lib/snapshot-worker/ or migration
-- 0030 is needed or made.
--
-- Why one nullable column (protocol_id) is added rather than reusing
-- existing schema: no existing table has any path from snapshot_requests
-- to buyer_questions/buyer_question_versions/protocols. Without a durable
-- link back on the request row itself, a second approval click (or a
-- retried request after an ambiguous network response) would have no way
-- to detect that a buyer_question/version/protocol/job were already
-- created for this request, and would create duplicates of all four.
-- Storing protocol_id is sufficient: buyer_question_version_id is always
-- reachable via protocols.buyer_question_version_id, and buyer_question_id
-- via buyer_question_versions.buyer_question_id, so no second column is
-- needed for that chain.
--
-- Why this is safe as one atomic function rather than a sequence of
-- application-layer calls: buyer_questions/buyer_question_versions/
-- protocols inserts have no idempotency key of their own (unlike
-- protocol_attempts/protocol_execution_jobs). A crash between two
-- sequential round trips followed by a naive retry-from-scratch would
-- create duplicate rows. Doing every insert and every RPC call inside one
-- PL/pgSQL function body keeps it inside one implicit transaction: if
-- anything here raises, the entire attempt rolls back and leaves no
-- partial state to duplicate on retry, matching every other multi-step
-- write in this schema (migrations 0025b/0047/0050/0051/0052).
--
-- Sampling defaults (planned_baseline_runs=3, spend_cap_usd=2, and the
-- other caps below) are a starting operator-configured protocol, chosen to
-- match the legacy per-prompt run count (WORKER_RUNS=3) and estimated
-- budget guard (WORKER_BUDGET_USD=2) as a like-for-like starting point,
-- not a claim of statistical sufficiency (METHODOLOGY.md section 7: "The
-- production values are operating configuration, not claims of
-- statistical sufficiency"). planned_retest_runs is 0: retest (M7) is out
-- of scope for this connection and is not fabricated here. The
-- commercial_value/winnability/priority scores on the created
-- buyer_question_version are neutral placeholders (3/3/13 — the midpoints
-- of their 1..5/1..5/1..25 ranges), not a real prioritization judgment;
-- nothing downstream currently reads them for this path.
--
-- prompt_hash is supplied by the caller (p_prompt_hash), computed by the
-- TypeScript application layer from the same buyer-question text it will
-- see echoed back — this function never computes or verifies a hash
-- itself, mirroring migration 0047's stated rule that prompt_hash
-- authority belongs exclusively to the application layer. prompt_text
-- itself is never a parameter: it is always read directly from the locked
-- snapshot_requests row (buyer_category — despite its name, this column
-- holds the full buyer-question text; see migration 0061 / lib/db/types.ts
-- SnapshotRequest.buyerCategory), so the stored question can never diverge
-- from what the founder actually approved.
--
-- What this migration does NOT do:
--   * Does not modify approve_and_queue_snapshot_request, reject_snapshot_
--     request, claim_next_snapshot_request, or any other existing function.
--   * Does not touch lib/snapshot-worker/ or its hardcoded sampling.
--   * Does not create a second job/queue system: it calls the existing
--     enqueue_protocol_execution_job (0050/0051/0052) exactly as
--     app/api/projects/[projectId]/protocol-runs/route.ts already does.
--   * Does not implement retest, observation windows, or Outcome Cards.
--   * Does not apply to any staging or production database by itself.

alter table public.snapshot_requests
  add column if not exists protocol_id uuid null
    references public.protocols (id) on delete restrict;

create index if not exists snapshot_requests_protocol_idx
  on public.snapshot_requests (protocol_id)
  where protocol_id is not null;

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
    rate_limit_per_hour, concurrency_limit, retry_cap
  ) values (
    v_project_id, v_version_id, 'perplexity_sonar', 'answer',
    jsonb_build_object('model', 'sonar'),
    3, 0,
    'buyer_question_version', 'presence_rate', 'fixed_operator_default_pending_pilot_calibration',
    5, 2, 86400,
    10, 1, 2
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
