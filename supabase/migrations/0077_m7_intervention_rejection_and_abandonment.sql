-- Reject and abandon a registered intervention.
--
-- 0071 gave `interventions.status` five legal values and wrote a constraint
-- requiring a non-empty `rejected_reason` whenever status is 'rejected'. It
-- then granted `service_role` SELECT only — no UPDATE — and shipped exactly
-- three RPCs: register, approve, confirm_implementation. Nothing could write
-- 'rejected' or 'abandoned'. Both states were structurally unreachable, and
-- any UI offering a Reject button would have failed against the grant.
--
-- This migration supplies the two missing transitions, and takes a deliberate
-- position on when abandonment is allowed at all.
--
-- ---------------------------------------------------------------------
-- The abandonment rule, and why it is drawn here
-- ---------------------------------------------------------------------
--
-- An intervention may be abandoned while it has observed nothing. Once its
-- retest has produced even one attempt, abandonment is refused.
--
-- The line is "an attempt exists", not "a retest protocol exists". A retest
-- protocol that was created but never run has measured nothing, so taking it
-- down is administrative. The moment a single attempt lands, stopping becomes
-- a decision that could be informed by what that attempt returned — and an
-- abandonment available at that point is the hole through which every
-- unwelcome result quietly leaves. That is precisely what registering an
-- intervention in advance exists to prevent.
--
-- This is deliberately stricter than `authorize_early_retest` (0072), which
-- permits its deviation and records it permanently. The asymmetry is the
-- point: shortening an observation window happens BEFORE any retest data
-- exists, so it cannot be steered by the result. Abandoning mid-retest
-- happens after, and can be.
--
-- Refusing costs very little. A V1 retest plans five runs; letting a dead
-- experiment finish spends a handful of provider calls and yields an honest
-- 'inconclusive', which is already a canonical outcome. `protocol_deviations`
-- already records why an intervention stopped being valid. Nothing is lost
-- except the ability to make an unwanted measurement disappear.
--
-- ---------------------------------------------------------------------
-- Stopping the job
-- ---------------------------------------------------------------------
--
-- Abandonment must not leave a queued retest job behind: the worker would
-- keep buying provider calls for a measurement nobody will read.
--
-- `protocol_execution_jobs.status` had no value for a deliberate stop. Its
-- vocabulary is queued/claimed/running/succeeded/failed/needs_review/
-- abandoned_exhausted, and 'abandoned_exhausted' means retries ran out —
-- reusing it here would put a false statement in the audit trail. Section 3
-- adds 'cancelled'.
--
-- Adding it is inert to every existing code path. The claim predicate in 0050
-- selects `status = 'queued'` or an expired lease on claimed/running, so a
-- cancelled job is never picked up. The terminal-status guards in 0051/0056
-- are reachable only by a worker holding a lease, and this migration only
-- ever cancels a job that has never been claimed: no worker, no claim token,
-- no lease, no attempt. A claimed or running job is refused outright by the
-- same rule that refuses an existing attempt.
--
-- ---------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------
--   drop function if exists public.abandon_intervention(uuid, uuid, uuid, text);
--   drop function if exists public.reject_intervention(uuid, uuid, uuid, text);
--   -- restore 0072's trigger body, then:
--   alter table public.interventions
--     drop constraint if exists interventions_abandonment_pair_check,
--     drop constraint if exists interventions_rejection_identity_check,
--     drop column if exists abandoned_reason,
--     drop column if exists abandoned_at,
--     drop column if exists abandoned_by,
--     drop column if exists rejected_at,
--     drop column if exists rejected_by;
--   alter table public.protocol_execution_jobs
--     drop constraint if exists protocol_execution_jobs_status_check;
--   alter table public.protocol_execution_jobs
--     add constraint protocol_execution_jobs_status_check check (status in (
--       'queued', 'claimed', 'running', 'succeeded',
--       'failed', 'needs_review', 'abandoned_exhausted'));
--   -- the last step fails if any job is already 'cancelled'; resolve those
--   -- rows first rather than widening the constraint back silently.


-- ---------------------------------------------------------------------
-- 1. Who rejected, who abandoned, and why
-- ---------------------------------------------------------------------

-- 0071 stored `rejected_reason` but not who recorded it. A rejection is a
-- founder decision about a registered claim; it carries an author like every
-- other decision in this table.
alter table public.interventions
  add column if not exists rejected_by      uuid null,
  add column if not exists rejected_at      timestamptz null,
  add column if not exists abandoned_by     uuid null,
  add column if not exists abandoned_at     timestamptz null,
  add column if not exists abandoned_reason text null;

comment on column public.interventions.abandoned_reason is
  'Why this intervention was abandoned. Required whenever status is '
  'abandoned. Abandonment is only reachable before any retest attempt '
  'exists, so this is never a record of a measurement being discarded.';

-- Identity and instant travel together with the rejection, or none of them
-- exist. Same shape as 0072's early-retest pair check.
alter table public.interventions
  drop constraint if exists interventions_rejection_identity_check;
alter table public.interventions
  add constraint interventions_rejection_identity_check check (
    (rejected_by is null and rejected_at is null)
    or
    (rejected_by is not null and rejected_at is not null)
  );

alter table public.interventions
  drop constraint if exists interventions_abandonment_pair_check;
alter table public.interventions
  add constraint interventions_abandonment_pair_check check (
    (status <> 'abandoned')
    or
    (abandoned_by is not null
     and abandoned_at is not null
     and abandoned_reason is not null
     and btrim(abandoned_reason) <> '')
  );


-- ---------------------------------------------------------------------
-- 2. The abandonment record is permanent
-- ---------------------------------------------------------------------

-- Same signature and same trigger as 0072, so `create or replace` keeps the
-- existing privileges and the existing trigger binding. The two guards 0072
-- installed are carried forward verbatim; only the third is new.
create or replace function public._reject_registered_intervention_edit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- The window is frozen independently of approval: once it exists, the
  -- instant the retest becomes eligible is a fact about this experiment, not
  -- a setting. Moving it is precisely the bypass authorize_early_retest is
  -- there to make visible.
  if old.observation_window_closes_at is not null
     and (new.observation_window_closes_at is distinct from old.observation_window_closes_at
          or new.observation_window_opens_at is distinct from old.observation_window_opens_at) then
    raise exception using
      errcode = 'P0001',
      message = 'observation_window_is_immutable';
  end if;

  -- A recorded deviation is permanent. Erasing it would erase the only
  -- evidence that the window was cut short.
  if old.early_retest_authorized_at is not null
     and (new.early_retest_authorized_at is distinct from old.early_retest_authorized_at
          or new.early_retest_authorized_by is distinct from old.early_retest_authorized_by
          or new.early_retest_reason is distinct from old.early_retest_reason) then
    raise exception using
      errcode = 'P0001',
      message = 'early_retest_authorization_is_immutable';
  end if;

  -- An abandonment cannot be rewritten or reversed. Allowing a return to
  -- 'implemented' would let an intervention be parked while its retest is
  -- inconvenient and revived when it is not, which is the same manipulation
  -- the abandonment rule itself refuses.
  if old.abandoned_at is not null
     and (new.abandoned_at is distinct from old.abandoned_at
          or new.abandoned_by is distinct from old.abandoned_by
          or new.abandoned_reason is distinct from old.abandoned_reason
          or new.status is distinct from old.status) then
    raise exception using
      errcode = 'P0001',
      message = 'abandonment_is_immutable';
  end if;

  if old.approved_at is null then
    return new;
  end if;

  if new.hypothesis is distinct from old.hypothesis
     or new.expected_mechanism is distinct from old.expected_mechanism
     or new.action_type is distinct from old.action_type
     or new.action_target is distinct from old.action_target
     or new.supporting_evidence is distinct from old.supporting_evidence
     or new.decision_threshold_note is distinct from old.decision_threshold_note
     or new.protocol_id is distinct from old.protocol_id
     or new.buyer_question_version_id is distinct from old.buyer_question_version_id
     or new.project_id is distinct from old.project_id
     or new.approved_at is distinct from old.approved_at
     or new.approved_by is distinct from old.approved_by then
    raise exception using
      errcode = 'P0001',
      message = 'intervention_registration_is_immutable';
  end if;

  return new;
end;
$$;


-- ---------------------------------------------------------------------
-- 3. A job can be cancelled
-- ---------------------------------------------------------------------

-- 0050 wrote this as an unnamed column-level check, which Postgres named
-- protocol_execution_jobs_status_check. Dropping by that name and re-adding
-- it explicitly makes the name stable for any future migration.
alter table public.protocol_execution_jobs
  drop constraint if exists protocol_execution_jobs_status_check;
alter table public.protocol_execution_jobs
  add constraint protocol_execution_jobs_status_check check (
    status in (
      'queued', 'claimed', 'running', 'succeeded',
      'failed', 'needs_review', 'abandoned_exhausted', 'cancelled'
    )
  );

comment on constraint protocol_execution_jobs_status_check
  on public.protocol_execution_jobs is
  'cancelled (0077) is a deliberate stop of a job that was never claimed, '
  'distinct from abandoned_exhausted, which means retries ran out.';


-- ---------------------------------------------------------------------
-- 4. reject_intervention
-- ---------------------------------------------------------------------

create or replace function public.reject_intervention(
  p_intervention_id uuid,
  p_project_id      uuid,
  p_rejected_by     uuid,
  p_reason          text
)
returns setof public.interventions
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_intervention public.interventions%rowtype;
  v_result public.interventions%rowtype;
begin
  if p_intervention_id is null or p_project_id is null or p_rejected_by is null then
    raise exception using errcode = '22023', message = 'invalid_reject_intervention_args';
  end if;

  -- The constraint would catch this, but a named error is more useful than a
  -- constraint violation surfacing through an API route.
  if p_reason is null or btrim(p_reason) = '' then
    raise exception using errcode = '22023', message = 'rejection_needs_reason';
  end if;

  select i.* into v_intervention
    from public.interventions i
   where i.id = p_intervention_id
     and i.project_id = p_project_id
   for update;

  if not found then
    return;
  end if;

  -- Idempotent replay returns the row untouched rather than re-stamping the
  -- instant, matching approve_intervention's contract.
  if v_intervention.status = 'rejected' then
    return next v_intervention;
    return;
  end if;

  -- Only a proposal can be rejected. Once approved, the registered claim is
  -- frozen and the honest exit is abandonment, which records its own reason.
  if v_intervention.status <> 'proposed' then
    return;
  end if;

  -- interventions_approval_pair_check requires approved_by/approved_at to
  -- stay null for a rejected row, so they are deliberately not written here.
  update public.interventions
     set status = 'rejected',
         rejected_reason = p_reason,
         rejected_by = p_rejected_by,
         rejected_at = now(),
         updated_at = now()
   where id = p_intervention_id
  returning * into v_result;

  return next v_result;
end;
$$;


-- ---------------------------------------------------------------------
-- 5. abandon_intervention
-- ---------------------------------------------------------------------

create or replace function public.abandon_intervention(
  p_intervention_id uuid,
  p_project_id      uuid,
  p_abandoned_by    uuid,
  p_reason          text
)
returns setof public.interventions
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_intervention public.interventions%rowtype;
  v_retest public.protocols%rowtype;
  v_attempts bigint;
  v_active_jobs bigint;
  v_result public.interventions%rowtype;
begin
  if p_intervention_id is null or p_project_id is null or p_abandoned_by is null then
    raise exception using errcode = '22023', message = 'invalid_abandon_intervention_args';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception using errcode = '22023', message = 'abandonment_needs_reason';
  end if;

  select i.* into v_intervention
    from public.interventions i
   where i.id = p_intervention_id
     and i.project_id = p_project_id
   for update;

  if not found then
    return;
  end if;

  if v_intervention.status = 'abandoned' then
    return next v_intervention;
    return;
  end if;

  if v_intervention.status not in ('proposed', 'approved', 'implemented') then
    return;
  end if;

  -- The live retest protocol for this intervention's baseline, if one was
  -- created. protocols_one_live_retest_per_baseline (0073) guarantees at most
  -- one row matches, so this cannot silently take down the wrong protocol.
  -- A 'completed' retest from an earlier intervention is deliberately not
  -- matched: it is finished evidence, not something to take down.
  select p.* into v_retest
    from public.protocols p
   where p.baseline_protocol_id = v_intervention.protocol_id
     and p.project_id = p_project_id
     and p.status in ('approved', 'active')
   for update;

  if found then
    -- Lock every job row for this retest protocol BEFORE deciding anything.
    -- Locking the intervention does not lock the worker, and without this a
    -- queued job could be claimed between the check below and the cancel.
    --
    -- 0050's claim predicate uses `for update skip locked`, so a worker does
    -- not block on these rows — it skips them and takes a different job.
    -- That makes the window genuinely closed rather than merely narrow.
    perform 1
       from public.protocol_execution_jobs j
      where j.protocol_id = v_retest.id
      for update;

    -- A claimed or running job may be producing an attempt at this instant,
    -- so it is refused rather than cancelled: stopping a job mid-flight is
    -- the fencing contract's business, not this function's.
    select count(*) into v_active_jobs
      from public.protocol_execution_jobs j
     where j.protocol_id = v_retest.id
       and j.status in ('claimed', 'running');

    if v_active_jobs > 0 then
      raise exception using
        errcode = 'P0001',
        message = 'retest_already_started';
    end if;

    -- Any attempt at all — including a cancelled one — means admission and
    -- reservation already happened for this retest. The experiment has begun
    -- observing, and the header explains why that closes abandonment.
    select count(*) into v_attempts
      from public.protocol_attempts pa
     where pa.protocol_id = v_retest.id;

    if v_attempts > 0 then
      raise exception using
        errcode = 'P0001',
        message = 'retest_already_started';
    end if;

    -- Only jobs that were never claimed. These have no worker, no claim
    -- token and no lease, so no fencing contract is being broken here.
    update public.protocol_execution_jobs
       set status = 'cancelled',
           failure_reason = 'intervention_abandoned',
           updated_at = now()
     where protocol_id = v_retest.id
       and status = 'queued';

    -- Releases protocols_one_live_retest_per_baseline, so a later
    -- intervention on the same baseline can register and retest normally.
    update public.protocols
       set status = 'abandoned',
           updated_at = now()
     where id = v_retest.id;
  end if;

  update public.interventions
     set status = 'abandoned',
         abandoned_by = p_abandoned_by,
         abandoned_at = now(),
         abandoned_reason = p_reason,
         updated_at = now()
   where id = p_intervention_id
  returning * into v_result;

  return next v_result;
end;
$$;


-- ---------------------------------------------------------------------
-- 6. ACL
-- ---------------------------------------------------------------------

revoke all on function public.reject_intervention(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.reject_intervention(uuid, uuid, uuid, text)
  to service_role;

revoke all on function public.abandon_intervention(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.abandon_intervention(uuid, uuid, uuid, text)
  to service_role;

revoke all on function public._reject_registered_intervention_edit()
  from public, anon, authenticated;
