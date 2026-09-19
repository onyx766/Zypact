-- Scope review resolution to the job being resolved.
--
-- Root cause this migration fixes. `resolve_protocol_job_review` (0066,
-- carried unchanged through 0067) terminalises non-terminal attempts with
--
--   where protocol_id = v_job.protocol_id
--     and status in ('reserved', 'in_progress')
--
-- which is scoped to the PROTOCOL, not to the job being resolved.
-- `protocol_attempts.job_id` exists (0050) and is not consulted.
--
-- Today the two coincide: D-025 gives a protocol one job that advances
-- through every planned baseline slot, so "every non-terminal attempt on the
-- protocol" and "every non-terminal attempt of this job" name the same rows.
--
-- They stop coinciding the moment a protocol carries a second job, which is
-- exactly what the M7 retest introduces. A reviewer resolving a stale
-- baseline review would then mark a live retest's in-flight attempts
-- `excluded` — silently, with no error, no lease violation and no fencing
-- complaint, because the write is legal in every respect except intent. The
-- retest's denominator would be wrong and its evidence unrecoverable, and the
-- only visible symptom would be a retest that mysteriously excluded itself.
--
-- This lands before any retest job can exist, so the window in which the bug
-- is reachable never opens.
--
-- Why `or job_id is null` rather than a bare equality. `job_id` is nullable
-- and was deliberately never backfilled (0050 section 6: the four real
-- staging rows from smoke4 stay null indefinitely, and no NOT NULL
-- constraint was added). More importantly the M4 raw RPCs
-- (`admit_and_reserve_attempt`, `start_attempt`, `reconcile_attempt`) delegate
-- with `job_id := null` and REMAIN GRANTED to service_role — the cutover
-- migration that revokes them has still not shipped (CURRENT_STATUS 13.4).
-- So an attempt on a job-bearing protocol can still legitimately carry a null
-- job_id today, and a bare `job_id = v_job.id` would quietly stop covering
-- exactly the rows most likely to be stuck.
--
-- A null job_id belongs to no job, so it can never belong to a DIFFERENT
-- one: including it cannot resurrect the cross-job defect. A retest job's
-- attempts always carry their own non-null job_id and are therefore never
-- touched by a baseline job's resolution, which is the whole point.
--
-- When the M4 cutover finally ships, this clause should be revisited and the
-- `or job_id is null` arm dropped.
--
-- Nothing else about the function changes: same signature (so `create or
-- replace` preserves its privileges), same guards, same statuses, same
-- ordering, same reviewer fields, same `prior_needs_review_reason` carry from
-- 0067.
--
-- Rollback:
--   re-apply 0067's function body verbatim. This migration adds no column,
--   no constraint and no table, and mutates no row, so there is nothing to
--   recover in either direction.

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
  --
  -- Scoped to this job, plus the job-less attempts the still-granted M4 raw
  -- RPCs can produce on the same protocol. Another job's attempts are never
  -- this resolution's to terminalise.
  update public.protocol_attempts
     set status = 'excluded',
         termination_reason = coalesce(
           termination_reason,
           'excluded_by_review:' || p_resolution
         ),
         terminalized_at = coalesce(terminalized_at, now()),
         last_activity_at = now()
   where protocol_id = v_job.protocol_id
     and (job_id = v_job.id or job_id is null)
     and status in ('reserved', 'in_progress');

  update public.protocol_execution_jobs
     set status = case
           when p_resolution = 'excluded_and_completed' then 'succeeded'
           else 'failed'
         end,
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
