-- M7 step 3 — the observation window and the retest eligibility gate.
--
-- The acceptance test this exists to satisfy (ENGINEERING_PLAN M7): "retest
-- cannot run before eligibility without a recorded authorized deviation."
-- Enforced here in SQL. A gate that lives in a React component or in the
-- worker's own judgement is not a gate — the pressure to retest early is
-- commercial (a demo, a call, a customer asking), and commercial pressure is
-- exactly what this must be immune to.
--
-- The window opens when the intervention is CONFIRMED IMPLEMENTED, never at
-- approval. An approved-but-unimplemented intervention has changed nothing
-- for a model to observe, so a window started at approval would be measuring
-- an intervention that did not exist yet. `confirm_intervention_implementation`
-- therefore opens the window in the same statement that records the
-- implementation: the two cannot come apart, and there is no code path that
-- produces an implemented intervention with no window.
--
-- ── The bypass this closes ───────────────────────────────────────────────
--
-- Storing only `expected_observation_days` and computing eligibility as
-- `implemented_at + expected_observation_days <= now()` would leave the gate
-- trivially bypassable: shorten the declared window after implementing, and
-- the retest becomes "eligible" with no deviation recorded anywhere. The
-- deviation is the thing the methodology cares about, and it would simply
-- vanish.
--
-- So the window's closing instant is COMPUTED ONCE at implementation, stored
-- as an absolute timestamp, and frozen by the 0071 trigger (extended below).
-- After that, `expected_observation_days` is a historical note; changing it
-- moves nothing. The only way to retest early is `authorize_early_retest`,
-- which demands an identity and a reason and leaves a permanent record.
--
-- ── Eligibility is one function, not a rule written twice ────────────────
--
-- `retest_eligibility` is the single authority. 0073's retest creation calls
-- it internally and the UI reads the same function, so the screen and the
-- database can never disagree about whether a retest may run — a
-- disagreement that would otherwise be discovered by a customer.
--
-- Deliberately NOT in this migration: retest protocol creation (0073), the
-- retest execution job (0074), and every comparison or Outcome Card concern.
--
-- Rollback:
--   drop function if exists public.retest_eligibility(uuid, uuid);
--   drop function if exists public.authorize_early_retest(uuid, uuid, uuid, text);
--   -- then re-apply 0071's confirm_intervention_implementation and
--   -- _reject_registered_intervention_edit bodies verbatim.
--   alter table public.interventions
--     drop constraint if exists interventions_observation_window_pair_check,
--     drop constraint if exists interventions_window_order_check,
--     drop constraint if exists interventions_implemented_has_window_check,
--     drop constraint if exists interventions_early_retest_pair_check,
--     drop column if exists early_retest_reason,
--     drop column if exists early_retest_authorized_at,
--     drop column if exists early_retest_authorized_by,
--     drop column if exists observation_window_closes_at,
--     drop column if exists observation_window_opens_at;
--
-- The interventions table is new in 0071 and carries no rows in any
-- environment, so every constraint below can be added unconditionally and a
-- rollback cannot destroy anything.

-- ---------------------------------------------------------------------
-- 1. Window and deviation columns
-- ---------------------------------------------------------------------

alter table public.interventions
  add column if not exists observation_window_opens_at  timestamptz null,
  add column if not exists observation_window_closes_at timestamptz null,
  add column if not exists early_retest_authorized_by   uuid null,
  add column if not exists early_retest_authorized_at   timestamptz null,
  add column if not exists early_retest_reason          text null;

comment on column public.interventions.observation_window_closes_at is
  'Absolute instant the observation window closes, computed once at '
  'implementation and frozen. Deliberately not derived from '
  'expected_observation_days at read time: a derived window could be '
  'shortened after the fact, bypassing the deviation record.';

comment on column public.interventions.early_retest_reason is
  'Why a retest was authorised before the window closed. Required whenever '
  'an early authorisation exists; this is the recorded deviation.';

alter table public.interventions
  drop constraint if exists interventions_observation_window_pair_check;
alter table public.interventions
  add constraint interventions_observation_window_pair_check check (
    (observation_window_opens_at is null) = (observation_window_closes_at is null)
  );

alter table public.interventions
  drop constraint if exists interventions_window_order_check;
alter table public.interventions
  add constraint interventions_window_order_check check (
    observation_window_closes_at is null
    or observation_window_closes_at > observation_window_opens_at
  );

-- An implemented intervention always has a window. Without this, an
-- implementation recorded through some future path could leave the gate with
-- nothing to check.
alter table public.interventions
  drop constraint if exists interventions_implemented_has_window_check;
alter table public.interventions
  add constraint interventions_implemented_has_window_check check (
    status <> 'implemented' or observation_window_closes_at is not null
  );

-- An early authorisation is an identity, an instant and a reason, or none of
-- the three. A deviation with no stated reason is not a record of anything.
alter table public.interventions
  drop constraint if exists interventions_early_retest_pair_check;
alter table public.interventions
  add constraint interventions_early_retest_pair_check check (
    (early_retest_authorized_by is null
     and early_retest_authorized_at is null
     and early_retest_reason is null)
    or
    (early_retest_authorized_by is not null
     and early_retest_authorized_at is not null
     and early_retest_reason is not null
     and btrim(early_retest_reason) <> '')
  );

create index if not exists interventions_window_closes_idx
  on public.interventions (observation_window_closes_at)
  where status = 'implemented';

-- ---------------------------------------------------------------------
-- 2. Freeze the window once it exists (extends 0071's trigger)
-- ---------------------------------------------------------------------

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
-- 3. Implementation opens the window, atomically
-- ---------------------------------------------------------------------

-- Same signature as 0071, so `create or replace` preserves its privileges.
create or replace function public.confirm_intervention_implementation(
  p_intervention_id  uuid,
  p_project_id       uuid,
  p_confirmed_by     uuid,
  p_evidence         jsonb,
  p_artifact_sha256  text default null,
  p_deviations       text default null
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
  v_now timestamptz := now();
begin
  if p_intervention_id is null or p_project_id is null or p_confirmed_by is null then
    raise exception using errcode = '22023', message = 'invalid_confirm_implementation_args';
  end if;

  if p_evidence is null or jsonb_typeof(p_evidence) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_implementation_evidence';
  end if;

  if p_artifact_sha256 is not null and p_artifact_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_artifact_sha256';
  end if;

  select i.* into v_intervention
    from public.interventions i
   where i.id = p_intervention_id
     and i.project_id = p_project_id
   for update;

  if not found then
    return;
  end if;

  if v_intervention.status = 'implemented' then
    return next v_intervention;
    return;
  end if;

  if v_intervention.status <> 'approved' then
    return;
  end if;

  -- The window length must have been declared before implementation. Without
  -- it there is no defensible instant at which a retest becomes eligible, and
  -- inventing one here would be the engine choosing the methodology.
  if v_intervention.expected_observation_days is null then
    raise exception using
      errcode = 'P0001',
      message = 'observation_window_not_declared';
  end if;

  update public.interventions
     set status = 'implemented',
         implemented_at = v_now,
         implementation_evidence = p_evidence,
         implementation_confirmed_by = p_confirmed_by,
         artifact_sha256 = coalesce(p_artifact_sha256, artifact_sha256),
         protocol_deviations = coalesce(p_deviations, protocol_deviations),
         observation_window_opens_at = v_now,
         observation_window_closes_at =
           v_now + make_interval(days => v_intervention.expected_observation_days),
         updated_at = v_now
   where id = p_intervention_id
  returning * into v_result;

  return next v_result;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. authorize_early_retest — the only way past a closed window
-- ---------------------------------------------------------------------

create or replace function public.authorize_early_retest(
  p_intervention_id uuid,
  p_project_id      uuid,
  p_authorized_by   uuid,
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
  if p_intervention_id is null or p_project_id is null or p_authorized_by is null then
    raise exception using errcode = '22023', message = 'invalid_authorize_early_retest_args';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception using errcode = '22023', message = 'early_retest_reason_required';
  end if;

  select i.* into v_intervention
    from public.interventions i
   where i.id = p_intervention_id
     and i.project_id = p_project_id
   for update;

  if not found then
    return;
  end if;

  -- Idempotent replay, and a refusal to overwrite. The first authorisation
  -- stands: a second one with a tidier reason would rewrite history, and the
  -- trigger above rejects it anyway.
  if v_intervention.early_retest_authorized_at is not null then
    return next v_intervention;
    return;
  end if;

  -- There is nothing to cut short before the window exists.
  if v_intervention.status <> 'implemented' then
    return;
  end if;

  update public.interventions
     set early_retest_authorized_by = p_authorized_by,
         early_retest_authorized_at = now(),
         early_retest_reason = p_reason,
         updated_at = now()
   where id = p_intervention_id
  returning * into v_result;

  return next v_result;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. retest_eligibility — the single authority
-- ---------------------------------------------------------------------

create or replace function public.retest_eligibility(
  p_intervention_id uuid,
  p_project_id      uuid
)
returns table (
  eligible          boolean,
  reason            text,
  window_closes_at  timestamptz,
  authorized_early  boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v public.interventions%rowtype;
begin
  select i.* into v
    from public.interventions i
   where i.id = p_intervention_id
     and i.project_id = p_project_id;

  if not found then
    return query select false, 'INTERVENTION_NOT_FOUND'::text, null::timestamptz, false;
    return;
  end if;

  if v.status <> 'implemented' then
    return query select false, 'INTERVENTION_NOT_IMPLEMENTED'::text,
                        v.observation_window_closes_at, false;
    return;
  end if;

  if v.early_retest_authorized_at is not null then
    return query select true, 'AUTHORIZED_DEVIATION'::text,
                        v.observation_window_closes_at, true;
    return;
  end if;

  if now() < v.observation_window_closes_at then
    return query select false, 'OBSERVATION_WINDOW_OPEN'::text,
                        v.observation_window_closes_at, false;
    return;
  end if;

  return query select true, 'WINDOW_ELAPSED'::text,
                      v.observation_window_closes_at, false;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. ACL
-- ---------------------------------------------------------------------

revoke all on function public.authorize_early_retest(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.authorize_early_retest(uuid, uuid, uuid, text)
  to service_role;

revoke all on function public.retest_eligibility(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.retest_eligibility(uuid, uuid)
  to service_role;

revoke all on function public.confirm_intervention_implementation(
  uuid, uuid, uuid, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.confirm_intervention_implementation(
  uuid, uuid, uuid, jsonb, text, text
) to service_role;

revoke all on function public._reject_registered_intervention_edit()
  from public, anon, authenticated;
