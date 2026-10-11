-- Record a deviation found after implementation was confirmed.
--
-- 0071 gave `interventions.protocol_deviations` exactly one writer:
-- `confirm_intervention_implementation`, which acts only while the status is
-- 'approved'. From the moment an observation window opens, nothing in the
-- product can record a deviation. That is backwards. The registered claim's
-- own "confounders to monitor" are things that can only be observed DURING
-- the window, after implementation is already confirmed.
--
-- The first registered intervention run for real showed the gap. The claim
-- named homepage changes as a confounder; the homepage was rebuilt three
-- times inside the window; and the Outcome Card stated "Every reason recorded
-- with this comparison: none", because there was nowhere to put them.
--
-- ---------------------------------------------------------------------
-- Why a ledger, and not an edit to `protocol_deviations`
-- ---------------------------------------------------------------------
--
-- `protocol_deviations` stays what it has always been: the note recorded at
-- implementation, before any retest data exists. Two things depend on that.
--
-- First, `compareProtocols` treats a non-empty `protocol_deviations` as the
-- "recorded authorised deviation" that lets a comparison proceed past a
-- protocol identity mismatch. If a note written after a retest could land in
-- that column, an `inconclusive` card could be turned into a directional one
-- by typing a sentence. A late note must be able to add disclosure and
-- nothing else, so it lives where the comparison engine never reads.
--
-- Second, a late note carries facts the old column has no room for: who
-- recorded it, when, and whether the retest had already produced attempts or
-- the card had already been delivered at that moment. Those are computed
-- here, in the same transaction as the insert, never supplied by the caller.
-- A reader of the Outcome Card is entitled to know that a confounder was
-- written down after the result was visible.
--
-- ---------------------------------------------------------------------
-- What is allowed, and when
-- ---------------------------------------------------------------------
--
-- A deviation may be recorded while the intervention is 'implemented', and at
-- no other time. Before that, `confirm_intervention_implementation` is the
-- writer. After rejection or abandonment there is no measurement to qualify.
--
-- Recording is deliberately NOT refused once the retest has run, nor once the
-- Outcome Card has been delivered. Refusing would mean the system could be
-- made unable to accept a disclosure, which is the wrong direction for an
-- evidence product to fail. Instead the row records the state it was written
-- in. A delivered card is still immutable (0076): a note recorded after
-- delivery is in the ledger and visible to the operator, and is not on the
-- artifact the customer already holds. `card_delivered_at_record` exists so
-- that difference can never be silent.
--
-- The ledger is insert-only at the database layer. No role holds UPDATE or
-- DELETE, and a trigger refuses both regardless of privilege, because a
-- deviation that can be withdrawn is not a record.
--
-- A second submit of the same note for the same intervention returns the
-- intervention without inserting, so a double click cannot duplicate it.
--
-- ---------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------
--   drop function if exists public.record_intervention_deviation(uuid, uuid, uuid, text);
--   drop table if exists public.intervention_deviations;
--   drop function if exists public._reject_intervention_deviation_change();
--
-- Dropping the table destroys recorded deviations. Once a single row exists,
-- prefer forward recovery: revoke execute on the function and leave the
-- ledger in place.

-- ---------------------------------------------------------------------
-- 1. The ledger
-- ---------------------------------------------------------------------

create table if not exists public.intervention_deviations (
  id                         uuid primary key default gen_random_uuid(),
  intervention_id            uuid not null references public.interventions (id),
  project_id                 uuid not null,
  note                       text not null
                               check (btrim(note) <> '' and char_length(note) <= 4000),
  recorded_by                uuid not null,
  recorded_at                timestamptz not null default now(),
  -- Attempts already held by this intervention's non-abandoned retest
  -- protocols at the instant of recording. Zero means the note predates any
  -- retest observation.
  retest_attempts_at_record  integer not null check (retest_attempts_at_record >= 0),
  -- True when an Outcome Card for this intervention had already been
  -- delivered, so the delivered artifact cannot contain this note.
  card_delivered_at_record   boolean not null
);

create index if not exists intervention_deviations_intervention_idx
  on public.intervention_deviations (intervention_id, recorded_at);

comment on table public.intervention_deviations is
  'Deviations and confounders recorded after implementation was confirmed. '
  'Insert-only, written solely by record_intervention_deviation. Never read '
  'by the comparison engine: a row here adds disclosure and cannot change an '
  'outcome status.';

alter table public.intervention_deviations enable row level security;
alter table public.intervention_deviations no force row level security;

revoke all on table public.intervention_deviations from public, anon, authenticated, service_role;
grant select on table public.intervention_deviations to service_role;
-- No INSERT, UPDATE or DELETE grant: the only write is the RPC below.

-- ---------------------------------------------------------------------
-- 2. Insert-only, enforced below the privilege system
-- ---------------------------------------------------------------------

create or replace function public._reject_intervention_deviation_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception using
    errcode = 'P0001',
    message = 'intervention_deviation_is_immutable';
end;
$$;

revoke all on function public._reject_intervention_deviation_change()
  from public, anon, authenticated, service_role;

drop trigger if exists intervention_deviations_no_update_or_delete
  on public.intervention_deviations;
create trigger intervention_deviations_no_update_or_delete
  before update or delete on public.intervention_deviations
  for each row execute function public._reject_intervention_deviation_change();

drop trigger if exists intervention_deviations_no_truncate
  on public.intervention_deviations;
create trigger intervention_deviations_no_truncate
  before truncate on public.intervention_deviations
  for each statement execute function public._reject_intervention_deviation_change();

-- ---------------------------------------------------------------------
-- 3. record_intervention_deviation
-- ---------------------------------------------------------------------

create or replace function public.record_intervention_deviation(
  p_intervention_id uuid,
  p_project_id      uuid,
  p_recorded_by     uuid,
  p_note            text
)
returns setof public.interventions
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_intervention public.interventions%rowtype;
  v_note text;
  v_attempts bigint;
  v_delivered boolean;
begin
  if p_intervention_id is null or p_project_id is null or p_recorded_by is null then
    raise exception using errcode = '22023', message = 'invalid_record_intervention_deviation_args';
  end if;

  v_note := btrim(coalesce(p_note, ''));

  if v_note = '' then
    raise exception using errcode = '22023', message = 'deviation_needs_note';
  end if;

  if char_length(v_note) > 4000 then
    raise exception using errcode = '22023', message = 'deviation_note_too_long';
  end if;

  -- Locking the intervention serialises concurrent submits, which is what
  -- makes the replay check below sound.
  select i.* into v_intervention
    from public.interventions i
   where i.id = p_intervention_id
     and i.project_id = p_project_id
   for update;

  if not found then
    return;
  end if;

  if v_intervention.status <> 'implemented' then
    return;
  end if;

  if exists (
    select 1
      from public.intervention_deviations d
     where d.intervention_id = p_intervention_id
       and d.note = v_note
  ) then
    return next v_intervention;
    return;
  end if;

  select count(*) into v_attempts
    from public.protocol_attempts pa
    join public.protocols p on p.id = pa.protocol_id
   where p.baseline_protocol_id = v_intervention.protocol_id
     and p.project_id = p_project_id
     and p.status <> 'abandoned';

  select exists (
    select 1
      from public.outcome_card_artifacts a
     where a.intervention_id = p_intervention_id
       and a.delivered_at is not null
  ) into v_delivered;

  insert into public.intervention_deviations (
    intervention_id, project_id, note, recorded_by,
    retest_attempts_at_record, card_delivered_at_record
  )
  values (
    p_intervention_id, p_project_id, v_note, p_recorded_by,
    v_attempts::integer, v_delivered
  );

  return next v_intervention;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. ACL
-- ---------------------------------------------------------------------

revoke all on function public.record_intervention_deviation(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_intervention_deviation(uuid, uuid, uuid, text)
  to service_role;
