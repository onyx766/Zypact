-- Give `needs_review` an exit.
--
-- Root cause this migration fixes:
--
-- A job that lands on `needs_review` (0051/0054/0056) is terminal in
-- practice. `claim_next_protocol_execution_job` selects only claimable
-- statuses, and every recovery RPC — reconcile_attempt_for_job,
-- retry_full_attempt_for_job, abort_attempt_and_fail_job_for_job — requires
-- a `p_claim_token`, which can only be obtained by claiming. So a job moved
-- to needs_review can never be claimed, can never be reconciled, and its
-- non-terminal attempts stay `in_progress` forever. The paid evidence
-- already collected under that job becomes permanently unreportable.
--
-- This is not theoretical: it happened on the first real live run. A worker
-- crashed mid-call, the resumption path correctly detected an external call
-- sent without a recorded receipt, and moved the job to needs_review with
-- `ambiguous_external_call_sent_without_receipt`. Two completed runs with
-- real provider evidence were stranded behind one ambiguous third attempt.
--
-- What this adds: a review resolution that a human — not a worker — applies.
-- It takes no claim token, because the reviewer is the authority here and no
-- worker can hold a lease on a job nothing can claim.
--
-- What it deliberately does NOT do:
--
--   * It never fabricates a result. An ambiguous attempt is moved to
--     `excluded`, a status the attempt constraint already allows, with a
--     termination reason naming the review. It is never marked `completed`,
--     because whether that call was answered is genuinely unknown.
--   * It never marks an attempt that already reached a terminal state. Only
--     `reserved` and `in_progress` attempts are touched, so completed
--     evidence is immutable through this path.
--   * It never delivers. Resolution sets job status only; producing and
--     sending a report stay separate, reviewable steps.
--
-- Spend note: excluding an ambiguous attempt does not reclaim its
-- reservation, and the money may or may not have been spent. That is why the
-- resolution is recorded with a reviewer and a note — the ambiguity is
-- resolved administratively and audibly, not erased.
--
-- Rollback:
--   drop function if exists public.resolve_protocol_job_review(
--     uuid, uuid, uuid, text, text);
--   alter table public.protocol_execution_jobs
--     drop constraint if exists protocol_execution_jobs_review_resolution_check,
--     drop column if exists review_resolution,
--     drop column if exists review_note,
--     drop column if exists reviewed_by,
--     drop column if exists reviewed_at;
--
-- All four columns are nullable and additive; rolling back cannot destroy
-- job or attempt evidence.

alter table public.protocol_execution_jobs
  add column if not exists review_resolution text null,
  add column if not exists review_note text null,
  add column if not exists reviewed_by uuid null,
  add column if not exists reviewed_at timestamptz null;

alter table public.protocol_execution_jobs
  drop constraint if exists protocol_execution_jobs_review_resolution_check;

alter table public.protocol_execution_jobs
  add constraint protocol_execution_jobs_review_resolution_check
  check (
    review_resolution is null
    or review_resolution in ('excluded_and_completed', 'failed')
  );

comment on column public.protocol_execution_jobs.review_resolution is
  'How a founder resolved needs_review. Null while unreviewed.';

create or replace function
  public.resolve_protocol_job_review(
    p_job_id uuid,
    p_project_id uuid,
    p_reviewed_by uuid,
    p_resolution text,
    p_note text
  )
returns setof public.protocol_execution_jobs
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  v_result public.protocol_execution_jobs%rowtype;
begin
  if p_resolution not in ('excluded_and_completed', 'failed') then
    raise exception
      'resolve_protocol_job_review: p_resolution must be excluded_and_completed or failed';
  end if;

  if p_note is null or btrim(p_note) = '' then
    raise exception
      'resolve_protocol_job_review: a review note is required';
  end if;

  if p_reviewed_by is null then
    raise exception
      'resolve_protocol_job_review: p_reviewed_by is required';
  end if;

  select job.*
    into v_job
    from public.protocol_execution_jobs job
   where job.id = p_job_id
     and job.project_id = p_project_id
   for update;

  if not found then
    return;
  end if;

  -- Only a job actually awaiting review can be resolved. This is what keeps
  -- the function from becoming a general-purpose status override: a running
  -- or already-resolved job is refused outright.
  if v_job.status <> 'needs_review' then
    return;
  end if;

  -- Non-terminal attempts become `excluded`, never `completed`. The reason
  -- names the review so the run table can say why the run is not counted.
  update public.protocol_attempts
     set status = 'excluded',
         termination_reason = coalesce(
           termination_reason,
           'excluded_by_review:' || p_resolution
         ),
         terminalized_at = coalesce(terminalized_at, now()),
         last_activity_at = now()
   where protocol_id = v_job.protocol_id
     and status in ('reserved', 'in_progress');

  update public.protocol_execution_jobs
     set status = case
           when p_resolution = 'excluded_and_completed' then 'succeeded'
           else 'failed'
         end,
         review_resolution = p_resolution,
         review_note = p_note,
         reviewed_by = p_reviewed_by,
         reviewed_at = now(),
         -- Kept, not cleared: why the job needed review stays on the record
         -- next to how it was resolved.
         failure_reason = case
           when p_resolution = 'failed'
             then coalesce(failure_reason, 'resolved_by_review')
           else failure_reason
         end,
         -- The lease is released so no stale claim can reappear against a
         -- job that is now terminal.
         claim_token = null,
         lease_expires_at = null,
         updated_at = now()
   where id = p_job_id
  returning * into v_result;

  return next v_result;
end;
$$;

revoke all on function
  public.resolve_protocol_job_review(uuid, uuid, uuid, text, text)
from public;

revoke all on function
  public.resolve_protocol_job_review(uuid, uuid, uuid, text, text)
from anon;

revoke all on function
  public.resolve_protocol_job_review(uuid, uuid, uuid, text, text)
from authenticated;

grant execute on function
  public.resolve_protocol_job_review(uuid, uuid, uuid, text, text)
to service_role;
