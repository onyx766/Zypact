-- M7 step 2 — the registered intervention record.
--
-- What "registered" means, and why the schema is shaped by it. The V1 offer
-- is a *Registered* Retest: the hypothesis, the action and the threshold that
-- would change the customer's next decision are all fixed BEFORE the retest
-- runs. That is the entire methodological difference between this and reading
-- tea leaves afterwards. A record that could be edited once results were in
-- would let a disappointing outcome be reframed as a success for a hypothesis
-- nobody actually held, and nothing downstream could detect it.
--
-- So registration is enforced here, not in the UI: once `approved_at` is set,
-- a BEFORE UPDATE trigger rejects any change to the registered fields. The
-- lifecycle fields (implementation evidence, deviations, confounders observed
-- later) stay writable, because those are recorded as they happen and are not
-- the claim being registered.
--
-- Fields follow V1_SCOPE 4.11 and PILOT_RUNBOOK 12 directly.
--
-- Deliberately NOT in this migration:
--   * the observation window and retest eligibility (0072);
--   * retest protocol creation (0073);
--   * the retest execution job (0074);
--   * any comparison, status or Outcome Card logic.
--
-- One live intervention per baseline protocol. V1_SCOPE 4.10 says "one
-- intervention hypothesis", and a partial unique index enforces it for the
-- non-terminal statuses. Two simultaneous live interventions on one baseline
-- would make any observed movement unattributable to either, which is a
-- methodology failure the schema can simply prevent.
--
-- `supporting_evidence` holds the run ids the hypothesis rests on. D-009
-- requires prompt-scoped claims to use only supporting runs from that
-- prompt/version, so the column is required to be a non-empty JSON array on
-- approval: an intervention with no evidence behind it is not evidence-backed,
-- and `needs_evidence` is the honest state for it (status stays 'proposed').
--
-- Privileges follow 0047's protocols precedent exactly: RLS on, every
-- privilege revoked from every role including service_role, SELECT granted
-- back for reads, and no UPDATE grant at all — every transition is RPC-only.
--
-- Rollback:
--   drop function if exists public.confirm_intervention_implementation(
--     uuid, uuid, uuid, jsonb, text, text);
--   drop function if exists public.approve_intervention(uuid, uuid, uuid);
--   drop function if exists public.register_intervention(
--     uuid, uuid, uuid, text, text, text, text, text, jsonb, text, text,
--     text, integer);
--   drop trigger if exists interventions_registration_is_immutable
--     on public.interventions;
--   drop function if exists public._reject_registered_intervention_edit();
--   drop table if exists public.interventions;
--
-- The table is new and nothing else references it yet, so a rollback cannot
-- destroy evidence belonging to any other part of the system.

-- ---------------------------------------------------------------------
-- 1. interventions
-- ---------------------------------------------------------------------

create table if not exists public.interventions (
  id                          uuid primary key default gen_random_uuid(),
  project_id                  uuid not null references public.projects (id) on delete cascade,
  -- The baseline this intervention responds to. `restrict`: an intervention
  -- is evidence about a protocol and must not outlive it silently.
  protocol_id                 uuid not null references public.protocols (id) on delete restrict,
  buyer_question_version_id   uuid not null references public.buyer_question_versions (id) on delete restrict,

  status                      text not null default 'proposed'
                                check (status in ('proposed', 'approved', 'implemented', 'rejected', 'abandoned')),

  -- ---- registered claim: immutable once approved ----
  hypothesis                  text not null check (btrim(hypothesis) <> ''),
  expected_mechanism          text not null check (btrim(expected_mechanism) <> ''),
  action_type                 text not null
                                check (action_type in (
                                  'content_published',
                                  'content_updated',
                                  'page_created',
                                  'structured_data_added',
                                  'third_party_listing',
                                  'documentation_updated',
                                  'other'
                                )),
  action_target               text not null check (btrim(action_target) <> ''),
  owner                       text not null check (btrim(owner) <> ''),
  supporting_evidence         jsonb not null default '[]'::jsonb
                                check (jsonb_typeof(supporting_evidence) = 'array'),
  alternative_explanations    text null,
  confounders_to_monitor      text null,
  -- The threshold that would change the customer's next business decision.
  -- Recorded before the result exists, per PILOT_RUNBOOK 12.
  decision_threshold_note     text null,
  implementation_deadline     timestamptz null,
  expected_observation_days   integer null check (expected_observation_days is null or expected_observation_days > 0),

  -- ---- approval ----
  approved_by                 uuid null,
  approved_at                 timestamptz null,
  rejected_reason             text null,

  -- ---- implementation, recorded as it happens ----
  implemented_at              timestamptz null,
  implementation_evidence     jsonb null
                                check (implementation_evidence is null
                                       or jsonb_typeof(implementation_evidence) = 'object'),
  implementation_confirmed_by uuid null,
  -- SHA-256 of the approved asset or action, where one exists. Optional by
  -- design: not every intervention has a hashable artifact, and a fabricated
  -- hash would be worse than an honest null.
  artifact_sha256             text null
                                check (artifact_sha256 is null
                                       or artifact_sha256 ~ '^[0-9a-f]{64}$'),
  protocol_deviations         text null,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  constraint interventions_approval_pair_check check (
    (status in ('proposed', 'rejected') and approved_by is null and approved_at is null)
    or
    (status in ('approved', 'implemented') and approved_by is not null and approved_at is not null)
    or
    (status = 'abandoned')
  ),

  -- An implemented intervention must carry proof it happened. Without this,
  -- an observation window could open on an intervention nobody performed.
  constraint interventions_implementation_pair_check check (
    (status <> 'implemented')
    or
    (implemented_at is not null
     and implementation_evidence is not null
     and implementation_confirmed_by is not null)
  ),

  constraint interventions_rejection_pair_check check (
    (status <> 'rejected') or (rejected_reason is not null and btrim(rejected_reason) <> '')
  )
);

-- One live intervention per baseline protocol.
create unique index if not exists interventions_one_live_per_protocol
  on public.interventions (protocol_id)
  where status in ('proposed', 'approved', 'implemented');

create index if not exists interventions_project_idx
  on public.interventions (project_id);

create index if not exists interventions_protocol_idx
  on public.interventions (protocol_id);

comment on table public.interventions is
  'One registered intervention hypothesis per baseline protocol. The claim '
  'fields are frozen at approval; implementation facts are recorded as they '
  'occur. Writes are RPC-only.';

-- ---------------------------------------------------------------------
-- 2. Registration immutability
-- ---------------------------------------------------------------------

-- Enforced by trigger rather than by convention: the RPCs below are the only
-- writers today, but "the only writer today" is not a guarantee, and this is
-- the property the word *registered* is selling.
create or replace function public._reject_registered_intervention_edit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
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

drop trigger if exists interventions_registration_is_immutable on public.interventions;
create trigger interventions_registration_is_immutable
  before update on public.interventions
  for each row execute function public._reject_registered_intervention_edit();

-- ---------------------------------------------------------------------
-- 3. Privileges — 0047's protocols precedent
-- ---------------------------------------------------------------------

alter table public.interventions enable row level security;
alter table public.interventions no force row level security;

revoke all on table public.interventions from public, anon, authenticated, service_role;
grant select on table public.interventions to service_role;
-- No INSERT and no UPDATE grant: every write goes through the RPCs below.

-- ---------------------------------------------------------------------
-- 4. register_intervention — creates in 'proposed'
-- ---------------------------------------------------------------------

create or replace function public.register_intervention(
  p_project_id                uuid,
  p_protocol_id               uuid,
  p_hypothesis                text,
  p_expected_mechanism        text,
  p_action_type               text,
  p_action_target             text,
  p_owner                     text,
  p_supporting_evidence       jsonb,
  p_alternative_explanations  text default null,
  p_confounders_to_monitor    text default null,
  p_decision_threshold_note   text default null,
  p_implementation_deadline   timestamptz default null,
  p_expected_observation_days integer default null
)
returns setof public.interventions
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_protocol public.protocols%rowtype;
  v_result public.interventions%rowtype;
begin
  if p_project_id is null or p_protocol_id is null then
    raise exception using errcode = '22023', message = 'invalid_intervention_identity';
  end if;

  if p_supporting_evidence is null
     or jsonb_typeof(p_supporting_evidence) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_supporting_evidence_shape';
  end if;

  -- Lock the baseline: its identity is what this intervention is registered
  -- against, and it must not move underneath the insert.
  select p.* into v_protocol
    from public.protocols p
   where p.id = p_protocol_id
     and p.project_id = p_project_id
   for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'protocol_not_found';
  end if;

  -- An intervention responds to evidence. A protocol that has not been
  -- approved has produced none.
  if v_protocol.status not in ('approved', 'active', 'completed') then
    raise exception using errcode = 'P0001', message = 'protocol_not_executable';
  end if;

  insert into public.interventions (
    project_id, protocol_id, buyer_question_version_id,
    status,
    hypothesis, expected_mechanism, action_type, action_target, owner,
    supporting_evidence, alternative_explanations, confounders_to_monitor,
    decision_threshold_note, implementation_deadline, expected_observation_days
  ) values (
    p_project_id, p_protocol_id, v_protocol.buyer_question_version_id,
    'proposed',
    p_hypothesis, p_expected_mechanism, p_action_type, p_action_target, p_owner,
    p_supporting_evidence, p_alternative_explanations, p_confounders_to_monitor,
    p_decision_threshold_note, p_implementation_deadline, p_expected_observation_days
  )
  returning * into v_result;

  return next v_result;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. approve_intervention — freezes the registered claim
-- ---------------------------------------------------------------------

create or replace function public.approve_intervention(
  p_intervention_id uuid,
  p_project_id      uuid,
  p_approved_by     uuid
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
  if p_intervention_id is null or p_project_id is null or p_approved_by is null then
    raise exception using errcode = '22023', message = 'invalid_approve_intervention_args';
  end if;

  select i.* into v_intervention
    from public.interventions i
   where i.id = p_intervention_id
     and i.project_id = p_project_id
   for update;

  if not found then
    return;
  end if;

  -- Idempotent replay: a second approval returns the row untouched rather
  -- than re-stamping the approval timestamp, which would move the registered
  -- moment and is exactly what the trigger forbids.
  if v_intervention.status in ('approved', 'implemented') then
    return next v_intervention;
    return;
  end if;

  if v_intervention.status <> 'proposed' then
    return;
  end if;

  -- D-009: an evidence-backed intervention cites the runs it rests on.
  if jsonb_array_length(v_intervention.supporting_evidence) = 0 then
    raise exception using errcode = 'P0001', message = 'intervention_needs_evidence';
  end if;

  update public.interventions
     set status = 'approved',
         approved_by = p_approved_by,
         approved_at = now(),
         updated_at = now()
   where id = p_intervention_id
  returning * into v_result;

  return next v_result;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. confirm_intervention_implementation
-- ---------------------------------------------------------------------

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

  -- Implementation can only be confirmed for a claim that was registered
  -- first. Confirming an unapproved intervention would open an observation
  -- window on a hypothesis nobody committed to.
  if v_intervention.status <> 'approved' then
    return;
  end if;

  update public.interventions
     set status = 'implemented',
         implemented_at = now(),
         implementation_evidence = p_evidence,
         implementation_confirmed_by = p_confirmed_by,
         artifact_sha256 = coalesce(p_artifact_sha256, artifact_sha256),
         protocol_deviations = coalesce(p_deviations, protocol_deviations),
         updated_at = now()
   where id = p_intervention_id
  returning * into v_result;

  return next v_result;
end;
$$;

-- ---------------------------------------------------------------------
-- 7. ACL
-- ---------------------------------------------------------------------

revoke all on function public.register_intervention(
  uuid, uuid, text, text, text, text, text, jsonb, text, text, text, timestamptz, integer
) from public, anon, authenticated;
grant execute on function public.register_intervention(
  uuid, uuid, text, text, text, text, text, jsonb, text, text, text, timestamptz, integer
) to service_role;

revoke all on function public.approve_intervention(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.approve_intervention(uuid, uuid, uuid)
  to service_role;

revoke all on function public.confirm_intervention_implementation(
  uuid, uuid, uuid, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.confirm_intervention_implementation(
  uuid, uuid, uuid, jsonb, text, text
) to service_role;

revoke all on function public._reject_registered_intervention_edit()
  from public, anon, authenticated;
