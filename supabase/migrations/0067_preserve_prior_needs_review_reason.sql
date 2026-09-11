-- Preserve why a job needed review after it has been resolved.
--
-- 0066 kept `needs_review_reason` on the row when it moved a job out of
-- needs_review, intending the record to show both what was wrong and how it
-- was resolved. That is impossible as written: 0050's
-- `protocol_execution_jobs_needs_review_reason_pair_check` enforces
--
--   (status = 'needs_review') = (needs_review_reason is not null)
--
-- so any resolution that leaves the reason in place is rejected. The
-- constraint is right — a job not awaiting review must not claim a pending
-- review reason — and 0066's function was wrong. It was caught on the first
-- real resolution attempt rather than by silently dropping the field.
--
-- Rather than discard the reason (the only durable statement of why a paid
-- run was interrupted), it moves to a column of its own. A reviewer, or a
-- later audit, can still ask "what was ambiguous here?" after resolution.
--
-- Rollback:
--   drop function if exists public.resolve_protocol_job_review(
--     uuid, uuid, uuid, text, text);
--   alter table public.protocol_execution_jobs
--     drop column if exists prior_needs_review_reason;
--   -- then re-apply 0066's function body if the old behavior is wanted.

alter table public.protocol_execution_jobs
  add column if not exists prior_needs_review_reason text null;

comment on column public.protocol_execution_jobs.prior_needs_review_reason is
  'The needs_review_reason this job carried before a reviewer resolved it. '
  'Null for jobs that never needed review.';

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

  if v_job.status <> 'needs_review' then
    return;
  end if;

  -- Non-terminal attempts become `excluded`, never `completed`. Whether those
  -- calls were answered is genuinely unknown, and a report must not assume.
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
         -- Moved, not dropped: the pair constraint requires the reason to be
         -- null once the job is no longer awaiting review, so it is carried
         -- to a column that survives resolution.
         prior_needs_review_reason = coalesce(
           v_job.prior_needs_review_reason,
           v_job.needs_review_reason
         ),
         needs_review_reason = null,
         review_resolution = p_resolution,
         review_note = p_note,
         reviewed_by = p_reviewed_by,
         reviewed_at = now(),
         failure_reason = case
           when p_resolution = 'failed'
             then coalesce(failure_reason, 'resolved_by_review')
           else failure_reason
         end,
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
