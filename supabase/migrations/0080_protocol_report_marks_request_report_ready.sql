-- A saved protocol report makes its request deliverable.
--
-- THE DEFECT. Since 0062 a founder-approved request lands on status
-- 'approved' and stays there: approval launches the protocol baseline, and
-- nothing on the protocol path ever writes another request status. Two
-- functions then disagree about what that status must be:
--
--   save_protocol_report_artifact  (0068)  returns no row unless 'approved'
--   begin_snapshot_report_delivery (0035)  raises  unless 'report_ready'
--
-- The only writer of 'report_ready' is the pre-V1 snapshot engine
-- (finalize_snapshot_request, 0026/0031), which 0062 deliberately routes
-- around. So every protocol-path report could be built and none could be
-- delivered, by any route: the founder's "Send report" answered 409 "the
-- report changed or delivery became locked", which reads as a stale page, and
-- "Send to requester" answered 500 with the raw Postgres message. No test
-- noticed because the delivery-fencing fixtures are seeded directly at
-- 'report_ready' instead of being driven through approval.
--
-- THE FIX makes the status say what it has always been read to mean. Saving
-- a protocol report now sets the request's status from the integrity
-- decision of the artifact just saved:
--
--   integrity_passed or needs_review  ->  'report_ready'
--   blocked                           ->  'approved'
--
-- and the build gate accepts either state, because a report must remain
-- regenerable after its first save.
--
-- WHY BLOCKED STAYS 'approved'. The delivery RPC in 0035 never consults
-- integrity; only application code refuses a blocked artifact. Leaving a
-- blocked report's request short of 'report_ready' means the database itself
-- now refuses to begin delivering it, whatever the caller does. And because
-- the status is recomputed on every save, a report regenerated from passing
-- to blocked moves its request BACK to 'approved' — the refusal follows the
-- current artifact, not the first one. "blocked never delivers" is thereby
-- enforced at the layer that holds the evidence, not only in the UI.
--
-- WHAT IS DELIBERATELY UNTOUCHED.
--   * The delivery fencing in 0035 — begin, finalize, release and replace —
--     is byte-identical. Its claim-token and revision guards are the part of
--     this system with the most careful proofs, and none of them needed to
--     move for delivery to become reachable.
--   * A delivered artifact still returns early, before any status write: a
--     delivered report is final, and its request keeps whatever status it
--     was delivered under.
--   * Pre-V1 requests are unreachable here. The function still requires a
--     non-null protocol_id and at least one succeeded protocol job, which no
--     legacy request has, so no 'report_ready' written by the old engine can
--     be moved by this function.
--   * progress_stage is not written. The protocol path never set it, and a
--     status change is the whole of the contract this migration repairs.
--
-- SIGNATURE. Same ten arguments as 0068, so `create or replace` replaces
-- the one function in place and cannot leave an overload behind — the
-- failure 0068's header warns about. The grants are restated anyway so this
-- file states its own ACL rather than inheriting it.
--
-- Rollback:
--   re-apply the function body from 0068 (build gate `status <> 'approved'`,
--   no status write). Requests already moved to 'report_ready' stay there
--   and remain deliverable, which is the intended state; to also restore the
--   prior (undeliverable) state for undelivered protocol-path reports:
--     update public.snapshot_requests r
--        set status = 'approved', updated_at = now()
--      where r.status = 'report_ready'
--        and r.protocol_id is not null
--        and not exists (
--          select 1 from public.snapshot_report_artifacts a
--           where a.snapshot_request_id = r.id and a.delivered_at is not null);
--   That update is the only row mutation a rollback needs, and it is never
--   required for safety — only to reproduce the defect.

create or replace function
  public.save_protocol_report_artifact(
    p_request_id uuid,
    p_project_id uuid,
    p_full_markdown text,
    p_short_markdown text,
    p_full_filename text,
    p_short_filename text,
    p_generated_at timestamptz,
    p_payload jsonb,
    p_integrity_status text,
    p_integrity_reasons jsonb
  )
returns setof public.snapshot_report_artifacts
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_request public.snapshot_requests%rowtype;
  v_artifact public.snapshot_report_artifacts%rowtype;
  v_result public.snapshot_report_artifacts%rowtype;
  v_succeeded_jobs integer;
  v_next_status text;
begin
  perform public._assert_snapshot_artifact_input(
    p_full_markdown,
    p_short_markdown,
    p_full_filename,
    p_short_filename,
    p_generated_at
  );

  if p_payload is null
     or jsonb_typeof(p_payload) <> 'object' then
    raise exception
      'save_protocol_report_artifact requires a JSON object payload';
  end if;

  -- No default and no null: an artifact without a decision could be picked up
  -- by a delivery worker that treats "unknown" as "fine".
  if p_integrity_status is null
     or p_integrity_status not in
        ('integrity_passed', 'needs_review', 'blocked') then
    raise exception
      'save_protocol_report_artifact requires an integrity status';
  end if;

  if p_integrity_reasons is null
     or jsonb_typeof(p_integrity_reasons) <> 'array' then
    raise exception
      'save_protocol_report_artifact requires integrity reasons as a JSON array';
  end if;

  -- A passing decision with reasons attached is contradictory, and the
  -- contradiction would be invisible once stored.
  if p_integrity_status = 'integrity_passed'
     and jsonb_array_length(p_integrity_reasons) <> 0 then
    raise exception
      'integrity_passed must carry no reasons';
  end if;

  if p_integrity_status <> 'integrity_passed'
     and jsonb_array_length(p_integrity_reasons) = 0 then
    raise exception
      'a non-passing integrity status must carry at least one reason';
  end if;

  select request.*
    into v_request
    from public.snapshot_requests request
   where request.id = p_request_id
     and request.project_id = p_project_id
   for update;

  if not found then
    return;
  end if;

  if v_request.protocol_id is null then
    return;
  end if;

  -- 0068 accepted 'approved' only. 'report_ready' is now also a building
  -- state, because this function is what moves a request there: without it,
  -- the first save would make every later regeneration impossible.
  if v_request.status not in ('approved', 'report_ready') then
    return;
  end if;

  select count(*)
    into v_succeeded_jobs
    from public.protocol_execution_jobs job
   where job.protocol_id = v_request.protocol_id
     and job.status = 'succeeded';

  if v_succeeded_jobs = 0 then
    return;
  end if;

  select artifact.*
    into v_artifact
    from public.snapshot_report_artifacts artifact
   where artifact.snapshot_request_id = p_request_id
   for update;

  if found
     and v_artifact.delivered_at is not null then
    return;
  end if;

  if not found then
    insert into public.snapshot_report_artifacts (
      snapshot_request_id,
      project_id,
      full_report_markdown,
      short_report_markdown,
      full_report_filename,
      short_report_filename,
      generated_at,
      report_payload,
      integrity_status,
      integrity_reasons,
      public_token
    )
    values (
      p_request_id,
      p_project_id,
      p_full_markdown,
      p_short_markdown,
      p_full_filename,
      p_short_filename,
      p_generated_at,
      p_payload,
      p_integrity_status,
      p_integrity_reasons,
      public._generate_snapshot_public_token()
    )
    returning * into v_result;
  else
    update public.snapshot_report_artifacts
       set full_report_markdown = p_full_markdown,
           short_report_markdown = p_short_markdown,
           full_report_filename = p_full_filename,
           short_report_filename = p_short_filename,
           generated_at = p_generated_at,
           report_payload = p_payload,
           integrity_status = p_integrity_status,
           integrity_reasons = p_integrity_reasons,
           updated_at = now()
     where snapshot_request_id = p_request_id
    returning * into v_result;
  end if;

  -- The request's status follows the artifact just saved, in the same
  -- transaction and under the same row lock, so no reader can observe a
  -- deliverable status paired with a blocked artifact or the reverse.
  v_next_status := case
    when p_integrity_status = 'blocked' then 'approved'
    else 'report_ready'
  end;

  if v_request.status is distinct from v_next_status then
    update public.snapshot_requests
       set status = v_next_status,
           updated_at = now()
     where id = p_request_id;
  end if;

  return next v_result;
end;
$$;

revoke all on function
  public.save_protocol_report_artifact(
    uuid, uuid, text, text, text, text, timestamptz, jsonb, text, jsonb
  )
from public;

revoke all on function
  public.save_protocol_report_artifact(
    uuid, uuid, text, text, text, text, timestamptz, jsonb, text, jsonb
  )
from anon;

revoke all on function
  public.save_protocol_report_artifact(
    uuid, uuid, text, text, text, text, timestamptz, jsonb, text, jsonb
  )
from authenticated;

grant execute on function
  public.save_protocol_report_artifact(
    uuid, uuid, text, text, text, text, timestamptz, jsonb, text, jsonb
  )
to service_role;
