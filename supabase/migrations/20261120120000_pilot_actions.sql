-- Pilot suggested actions (D-053 item 4, D-057): actions written by the
-- team, each linked to the stored answers and sources it rests on, reviewed
-- before they reach a report.
--
-- Applies after 20261119120000 (pilot report artifacts). Depends only on
-- objects from 0047-0081 and the three pilot migrations; nothing from the
-- account stack (Q2'-1 to Q4).
--
-- What this adds:
--   1. `pilot_actions`: one row per suggested action of a pilot.
--   2. `pilot_action_versions`: its wording, append-only. Every edit is a
--      new version, which is a draft until it is reviewed again. A version
--      carries what METHODOLOGY section 12 needs at this stage: what was
--      observed, the suggested action, why it might matter (a hypothesis),
--      what else could explain it, and what is not known yet. Target,
--      owner, observation window and outcome definitions are taken when the
--      customer chooses to test an action as a registered intervention (M7).
--   3. `pilot_action_evidence`: the stored answers a version rests on, each
--      a completed attempt of one of this pilot's measurements with a stored
--      response hash, optionally with one source URL from that answer. A
--      trigger refuses any other attempt, even for the database owner; the
--      composite foreign key keeps it in the pilot's project.
--   4. `pilot_action_events`: `reviewed` (one version) and `withdrawn` (the
--      whole action), append-only.
--   5. `save_pilot_action`, `review_pilot_action`, `withdraw_pilot_action`.
--   6. `save_pilot_report_artifact` is redefined with one added block (marked
--      D-057 begin/end; otherwise byte for byte 20261119120000's body): the
--      manifest lists the action versions the payload shows; each must be its
--      action's latest version, reviewed, of an action of this pilot that is
--      not withdrawn, and every such action must be listed. A revision with
--      any action is never saved as integrity_passed, so the founder's
--      preview and acknowledgement path is always used.
--
-- Nothing here calls a provider or a model, sends anything, or writes an
-- attempt, receipt, probe row, protocol, job or report. No existing row is
-- updated, deleted or backfilled. Every function pins its search_path and is
-- executable by service_role only (the trigger functions by no role). The
-- four tables have RLS on with no policy, and service_role may only read
-- them.
--
-- Rollback / forward recovery (the web app first, then the database):
--   1. Roll the web app back. Report builds stop listing actions.
--   2. Restore save_pilot_report_artifact from 20261119120000 (re-run its
--      section 3), then:
--      drop function if exists public.withdraw_pilot_action(uuid, uuid, uuid, text);
--      drop function if exists public.review_pilot_action(uuid, uuid, integer, uuid, boolean);
--      drop function if exists public.save_pilot_action(uuid, uuid, integer, uuid, text, text, text, text, text, text, jsonb, uuid);
--      drop table if exists public.pilot_action_events;
--      drop table if exists public.pilot_action_evidence;
--      drop table if exists public.pilot_action_versions;
--      drop table if exists public.pilot_actions;
--      drop function if exists public.pilot_action_evidence_check();
--      drop function if exists public.pilot_actions_append_only();
--   Dropping the tables loses only the team's action wording and review
--   history. Shared report revisions keep the actions they were built with
--   in their stored payload; no evidence, protocol, pilot or question row
--   references these tables.

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------

create table if not exists public.pilot_actions (
  id          uuid primary key default gen_random_uuid(),
  pilot_id    uuid not null,
  project_id  uuid not null,
  created_by  uuid not null,
  created_at  timestamptz not null default now(),

  constraint pilot_actions_pilot_fk
    foreign key (pilot_id, project_id)
    references public.pilots (id, project_id)
    on delete restrict,
  constraint pilot_actions_scope_key unique (id, pilot_id, project_id)
);

create index if not exists pilot_actions_pilot_idx on public.pilot_actions (pilot_id, created_at);

create table if not exists public.pilot_action_versions (
  id                        uuid primary key default gen_random_uuid(),
  action_id                 uuid not null,
  pilot_id                  uuid not null,
  project_id                uuid not null,
  version_number            integer not null check (version_number between 1 and 50),
  title                     text not null
                            check (char_length(title) between 3 and 120 and title = btrim(title)),
  observation               text not null
                            check (char_length(observation) between 10 and 2000 and observation = btrim(observation)),
  suggested_action          text not null
                            check (char_length(suggested_action) between 10 and 2000 and suggested_action = btrim(suggested_action)),
  why_it_might_matter       text not null
                            check (char_length(why_it_might_matter) between 10 and 2000 and why_it_might_matter = btrim(why_it_might_matter)),
  alternative_explanations  text not null
                            check (char_length(alternative_explanations) between 10 and 2000 and alternative_explanations = btrim(alternative_explanations)),
  open_questions            text not null
                            check (char_length(open_questions) between 10 and 2000 and open_questions = btrim(open_questions)),
  written_by                uuid not null,
  written_at                timestamptz not null default now(),
  idempotency_key           uuid not null,
  request_fingerprint       text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),

  constraint pilot_action_versions_action_fk
    foreign key (action_id, pilot_id, project_id)
    references public.pilot_actions (id, pilot_id, project_id)
    on delete restrict,
  constraint pilot_action_versions_number_key unique (action_id, version_number),
  constraint pilot_action_versions_scope_key unique (id, pilot_id, project_id),
  constraint pilot_action_versions_action_key unique (id, action_id),
  constraint pilot_action_versions_idempotency_key unique (pilot_id, idempotency_key)
);

create table if not exists public.pilot_action_evidence (
  id                 uuid primary key default gen_random_uuid(),
  action_version_id  uuid not null,
  pilot_id           uuid not null,
  project_id         uuid not null,
  position           integer not null check (position between 1 and 10),
  attempt_id         uuid not null,
  -- One source of that answer, as the founder picked it from the answer's
  -- own extracted sources. The report re-finds it in the stored answer at
  -- every build; a URL it cannot re-find blocks the report.
  source_url         text null
                     check (source_url is null or (char_length(source_url) between 10 and 2048 and source_url ~ '^https?://')),

  constraint pilot_action_evidence_version_fk
    foreign key (action_version_id, pilot_id, project_id)
    references public.pilot_action_versions (id, pilot_id, project_id)
    on delete restrict,
  constraint pilot_action_evidence_attempt_fk
    foreign key (attempt_id, project_id)
    references public.protocol_attempts (id, project_id)
    on delete restrict,
  constraint pilot_action_evidence_position_key unique (action_version_id, position),
  constraint pilot_action_evidence_link_key unique nulls not distinct (action_version_id, attempt_id, source_url)
);

create table if not exists public.pilot_action_events (
  id                 uuid primary key default gen_random_uuid(),
  action_id          uuid not null,
  action_version_id  uuid null,
  pilot_id           uuid not null,
  project_id         uuid not null,
  event              text not null check (event in ('reviewed', 'withdrawn')),
  actor              uuid not null,
  created_at         timestamptz not null default now(),
  reason             text null,

  constraint pilot_action_events_action_fk
    foreign key (action_id, pilot_id, project_id)
    references public.pilot_actions (id, pilot_id, project_id)
    on delete restrict,
  constraint pilot_action_events_version_fk
    foreign key (action_version_id, action_id)
    references public.pilot_action_versions (id, action_id)
    on delete restrict,
  constraint pilot_action_events_shape_check check (
    (event = 'reviewed' and action_version_id is not null and reason is null)
    or (event = 'withdrawn' and action_version_id is null
        and reason is not null and char_length(btrim(reason)) between 10 and 2000)
  )
);

-- One review per version, one withdrawal per action.
create unique index if not exists pilot_action_events_one_review
  on public.pilot_action_events (action_version_id) where event = 'reviewed';
create unique index if not exists pilot_action_events_one_withdrawal
  on public.pilot_action_events (action_id) where event = 'withdrawn';

comment on table public.pilot_actions is
  'D-057: a suggested action of a pilot, written by the team. Append-only; written only by save_pilot_action.';
comment on table public.pilot_action_versions is
  'D-057: the wording of each version of a suggested action. Append-only; an edit is a new version, a draft until reviewed.';
comment on table public.pilot_action_evidence is
  'D-057: the stored answers (and optional source) a suggested action version rests on. Append-only; only completed answers of this pilot''s measurements.';
comment on table public.pilot_action_events is
  'D-057: reviews of a version and withdrawals of an action. Append-only.';

alter table public.pilot_actions enable row level security;
alter table public.pilot_action_versions enable row level security;
alter table public.pilot_action_evidence enable row level security;
alter table public.pilot_action_events enable row level security;

revoke all on table public.pilot_actions from public, anon, authenticated, service_role;
revoke all on table public.pilot_action_versions from public, anon, authenticated, service_role;
revoke all on table public.pilot_action_evidence from public, anon, authenticated, service_role;
revoke all on table public.pilot_action_events from public, anon, authenticated, service_role;
grant select on table public.pilot_actions to service_role;
grant select on table public.pilot_action_versions to service_role;
grant select on table public.pilot_action_evidence to service_role;
grant select on table public.pilot_action_events to service_role;

-- ---------------------------------------------------------------------
-- 2. Guards
-- ---------------------------------------------------------------------

create or replace function public.pilot_actions_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception using errcode = 'P0001', message = 'pilot_actions_are_append_only';
end;
$$;

revoke all on function public.pilot_actions_append_only() from public, anon, authenticated, service_role;

drop trigger if exists pilot_actions_append_only on public.pilot_actions;
create trigger pilot_actions_append_only
  before update or delete on public.pilot_actions
  for each row execute function public.pilot_actions_append_only();
drop trigger if exists pilot_action_versions_append_only on public.pilot_action_versions;
create trigger pilot_action_versions_append_only
  before update or delete on public.pilot_action_versions
  for each row execute function public.pilot_actions_append_only();
drop trigger if exists pilot_action_evidence_append_only on public.pilot_action_evidence;
create trigger pilot_action_evidence_append_only
  before update or delete on public.pilot_action_evidence
  for each row execute function public.pilot_actions_append_only();
drop trigger if exists pilot_action_events_append_only on public.pilot_action_events;
create trigger pilot_action_events_append_only
  before update or delete on public.pilot_action_events
  for each row execute function public.pilot_actions_append_only();

-- The evidence an action rests on: a completed attempt of one of this
-- pilot's measurements, with a stored response hash. Checked for every row,
-- whoever inserts it.
create or replace function public.pilot_action_evidence_check()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
      from public.protocol_attempts a
      join public.pilot_question_protocols pqp on pqp.protocol_id = a.protocol_id
      join public.pilot_questions pq on pq.id = pqp.pilot_question_id
      join public.probe_results r on r.probe_run_id = a.probe_run_id
     where a.id = new.attempt_id
       and a.project_id = new.project_id
       and pq.pilot_id = new.pilot_id
       and a.status = 'completed'
       and r.raw_response_sha256 is not null
  ) then
    raise exception using errcode = 'P0001', message = 'pilot_action_evidence_is_not_a_pilot_answer';
  end if;
  return new;
end;
$$;

revoke all on function public.pilot_action_evidence_check() from public, anon, authenticated, service_role;

drop trigger if exists pilot_action_evidence_check on public.pilot_action_evidence;
create trigger pilot_action_evidence_check
  before insert on public.pilot_action_evidence
  for each row execute function public.pilot_action_evidence_check();

-- ---------------------------------------------------------------------
-- 3. save_pilot_action
-- ---------------------------------------------------------------------

create or replace function public.save_pilot_action(
  p_pilot_id                  uuid,
  p_action_id                 uuid,
  p_expected_version          integer,
  p_written_by                uuid,
  p_title                     text,
  p_observation               text,
  p_suggested_action          text,
  p_why_it_might_matter       text,
  p_alternative_explanations  text,
  p_open_questions            text,
  p_evidence                  jsonb,
  p_idempotency_key           uuid
)
returns table (outcome text, saved_action_id uuid, saved_version_id uuid, saved_version_number integer)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_pilot public.pilots%rowtype;
  v_fingerprint text;
  v_existing public.pilot_action_versions%rowtype;
  v_action uuid;
  v_latest integer;
  v_number integer;
  v_version uuid;
begin
  if p_pilot_id is null or p_written_by is null or p_idempotency_key is null
     or p_title is null or p_observation is null or p_suggested_action is null
     or p_why_it_might_matter is null or p_alternative_explanations is null or p_open_questions is null
     or p_evidence is null or jsonb_typeof(p_evidence) <> 'array'
     or (p_action_id is null) <> (p_expected_version is null) then
    raise exception using errcode = '22023', message = 'invalid_save_pilot_action_args';
  end if;

  if char_length(btrim(p_title)) not between 3 and 120
     or char_length(btrim(p_observation)) not between 10 and 2000
     or char_length(btrim(p_suggested_action)) not between 10 and 2000
     or char_length(btrim(p_why_it_might_matter)) not between 10 and 2000
     or char_length(btrim(p_alternative_explanations)) not between 10 and 2000
     or char_length(btrim(p_open_questions)) not between 10 and 2000 then
    raise exception using errcode = '22023', message = 'invalid_save_pilot_action_args';
  end if;

  -- 1 to 10 links, each an attempt id and an optional http(s) source, none twice.
  if jsonb_array_length(p_evidence) not between 1 and 10 then
    raise exception using errcode = '22023', message = 'invalid_save_pilot_action_args';
  end if;
  if exists (
       select 1 from jsonb_array_elements(p_evidence) e
        where jsonb_typeof(e) <> 'object'
           or jsonb_typeof(e -> 'attemptId') is distinct from 'string'
           or (e ->> 'attemptId') !~ v_uuid
           or coalesce(jsonb_typeof(e -> 'sourceUrl'), 'null') not in ('null', 'string'))
     or exists (
       select 1 from jsonb_array_elements(p_evidence) e
        where jsonb_typeof(e -> 'sourceUrl') = 'string'
          and ((e ->> 'sourceUrl') !~ '^https?://' or char_length(e ->> 'sourceUrl') not between 10 and 2048))
     or (select count(*) from jsonb_array_elements(p_evidence))
        <> (select count(distinct (e ->> 'attemptId') || '|' || coalesce(e ->> 'sourceUrl', ''))
              from jsonb_array_elements(p_evidence) e) then
    raise exception using errcode = '22023', message = 'invalid_save_pilot_action_args';
  end if;

  v_fingerprint := md5(jsonb_build_object(
    'action', p_action_id, 'expected', p_expected_version,
    'title', btrim(p_title), 'observation', btrim(p_observation),
    'suggested', btrim(p_suggested_action), 'why', btrim(p_why_it_might_matter),
    'alternatives', btrim(p_alternative_explanations), 'open', btrim(p_open_questions),
    'evidence', p_evidence)::text);

  -- Serialises versions per pilot, and with report saves and reviews.
  select * into v_pilot from public.pilots where id = p_pilot_id for update;
  if not found then
    return query select 'PILOT_NOT_FOUND'::text, null::uuid, null::uuid, null::integer;
    return;
  end if;

  -- A replay answers the first result; the same key for another body is a conflict.
  select * into v_existing
    from public.pilot_action_versions pav
   where pav.pilot_id = p_pilot_id and pav.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.request_fingerprint = v_fingerprint then
      return query select 'SAVED'::text, v_existing.action_id, v_existing.id, v_existing.version_number;
    else
      return query select 'CONFLICT'::text, null::uuid, null::uuid, null::integer;
    end if;
    return;
  end if;

  if p_action_id is null then
    -- At most 30 actions in use per pilot.
    if (select count(*) from public.pilot_actions pa
         where pa.pilot_id = p_pilot_id
           and not exists (
             select 1 from public.pilot_action_events ev
              where ev.action_id = pa.id and ev.event = 'withdrawn')) >= 30 then
      return query select 'LIMIT_REACHED'::text, null::uuid, null::uuid, null::integer;
      return;
    end if;
    v_number := 1;
  else
    if not exists (
      select 1 from public.pilot_actions pa where pa.id = p_action_id and pa.pilot_id = p_pilot_id) then
      return query select 'ACTION_NOT_FOUND'::text, null::uuid, null::uuid, null::integer;
      return;
    end if;
    if exists (
      select 1 from public.pilot_action_events ev where ev.action_id = p_action_id and ev.event = 'withdrawn') then
      return query select 'ACTION_WITHDRAWN'::text, null::uuid, null::uuid, null::integer;
      return;
    end if;
    select max(pav.version_number) into v_latest
      from public.pilot_action_versions pav where pav.action_id = p_action_id;
    if v_latest is distinct from p_expected_version then
      return query select 'VERSION_CONFLICT'::text, null::uuid, null::uuid, null::integer;
      return;
    end if;
    if v_latest >= 50 then
      return query select 'LIMIT_REACHED'::text, null::uuid, null::uuid, null::integer;
      return;
    end if;
    v_number := v_latest + 1;
  end if;

  -- Every link: an attempt of one of this pilot's measurements...
  if exists (
    select 1
      from jsonb_array_elements(p_evidence) e
      left join public.protocol_attempts a on a.id = (e ->> 'attemptId')::uuid
     where a.id is null
        or a.project_id <> v_pilot.project_id
        or not exists (
          select 1
            from public.pilot_question_protocols pqp
            join public.pilot_questions pq on pq.id = pqp.pilot_question_id
           where pq.pilot_id = p_pilot_id and pqp.protocol_id = a.protocol_id)) then
    return query select 'EVIDENCE_OUTSIDE_PILOT'::text, null::uuid, null::uuid, null::integer;
    return;
  end if;

  -- ...that completed with a stored answer...
  if exists (
    select 1
      from jsonb_array_elements(p_evidence) e
      join public.protocol_attempts a on a.id = (e ->> 'attemptId')::uuid
      left join public.probe_results r on r.probe_run_id = a.probe_run_id
     where a.status <> 'completed' or r.raw_response_sha256 is null) then
    return query select 'EVIDENCE_NOT_AN_ANSWER'::text, null::uuid, null::uuid, null::integer;
    return;
  end if;

  -- ...to a question that is not retired.
  if exists (
    select 1
      from jsonb_array_elements(p_evidence) e
      join public.protocol_attempts a on a.id = (e ->> 'attemptId')::uuid
      join public.pilot_question_protocols pqp on pqp.protocol_id = a.protocol_id
      join public.pilot_questions pq on pq.id = pqp.pilot_question_id
     where pq.retired_at is not null) then
    return query select 'QUESTION_RETIRED'::text, null::uuid, null::uuid, null::integer;
    return;
  end if;

  if p_action_id is null then
    insert into public.pilot_actions (pilot_id, project_id, created_by)
    values (p_pilot_id, v_pilot.project_id, p_written_by)
    returning id into v_action;
  else
    v_action := p_action_id;
  end if;

  insert into public.pilot_action_versions (
    action_id, pilot_id, project_id, version_number, title, observation, suggested_action,
    why_it_might_matter, alternative_explanations, open_questions, written_by,
    idempotency_key, request_fingerprint
  ) values (
    v_action, p_pilot_id, v_pilot.project_id, v_number, btrim(p_title), btrim(p_observation),
    btrim(p_suggested_action), btrim(p_why_it_might_matter), btrim(p_alternative_explanations),
    btrim(p_open_questions), p_written_by, p_idempotency_key, v_fingerprint
  )
  returning id into v_version;

  insert into public.pilot_action_evidence (action_version_id, pilot_id, project_id, position, attempt_id, source_url)
  select v_version, p_pilot_id, v_pilot.project_id, t.ord::integer, (t.e ->> 'attemptId')::uuid, t.e ->> 'sourceUrl'
    from jsonb_array_elements(p_evidence) with ordinality as t(e, ord);

  return query select 'SAVED'::text, v_action, v_version, v_number;
end;
$$;

revoke all on function public.save_pilot_action(uuid, uuid, integer, uuid, text, text, text, text, text, text, jsonb, uuid) from public;
revoke all on function public.save_pilot_action(uuid, uuid, integer, uuid, text, text, text, text, text, text, jsonb, uuid) from anon;
revoke all on function public.save_pilot_action(uuid, uuid, integer, uuid, text, text, text, text, text, text, jsonb, uuid) from authenticated;
grant execute on function public.save_pilot_action(uuid, uuid, integer, uuid, text, text, text, text, text, text, jsonb, uuid) to service_role;

-- ---------------------------------------------------------------------
-- 4. review_pilot_action
-- ---------------------------------------------------------------------

create or replace function public.review_pilot_action(
  p_pilot_id        uuid,
  p_action_id       uuid,
  p_version_number  integer,
  p_reviewed_by     uuid,
  p_confirmed       boolean
)
returns table (outcome text)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_pilot public.pilots%rowtype;
  v_version uuid;
begin
  if p_pilot_id is null or p_action_id is null or p_version_number is null
     or p_reviewed_by is null or p_confirmed is null then
    raise exception using errcode = '22023', message = 'invalid_review_pilot_action_args';
  end if;

  -- The lock a report save takes for update: a review and a save never interleave.
  select * into v_pilot from public.pilots where id = p_pilot_id for share;
  if not found then
    return query select 'PILOT_NOT_FOUND'::text;
    return;
  end if;

  if not exists (select 1 from public.pilot_actions pa where pa.id = p_action_id and pa.pilot_id = p_pilot_id) then
    return query select 'ACTION_NOT_FOUND'::text;
    return;
  end if;

  if exists (select 1 from public.pilot_action_events ev where ev.action_id = p_action_id and ev.event = 'withdrawn') then
    return query select 'ACTION_WITHDRAWN'::text;
    return;
  end if;

  select pav.id into v_version
    from public.pilot_action_versions pav
   where pav.action_id = p_action_id and pav.version_number = p_version_number;
  if not found then
    return query select 'VERSION_NOT_FOUND'::text;
    return;
  end if;

  if p_version_number <> (select max(pav.version_number) from public.pilot_action_versions pav where pav.action_id = p_action_id) then
    return query select 'NOT_LATEST'::text;
    return;
  end if;

  if exists (select 1 from public.pilot_action_events ev where ev.action_version_id = v_version and ev.event = 'reviewed') then
    return query select 'ALREADY_REVIEWED'::text;
    return;
  end if;

  if not p_confirmed then
    return query select 'CONFIRMATION_REQUIRED'::text;
    return;
  end if;

  insert into public.pilot_action_events (action_id, action_version_id, pilot_id, project_id, event, actor)
  values (p_action_id, v_version, p_pilot_id, v_pilot.project_id, 'reviewed', p_reviewed_by);

  return query select 'REVIEWED'::text;
end;
$$;

revoke all on function public.review_pilot_action(uuid, uuid, integer, uuid, boolean) from public;
revoke all on function public.review_pilot_action(uuid, uuid, integer, uuid, boolean) from anon;
revoke all on function public.review_pilot_action(uuid, uuid, integer, uuid, boolean) from authenticated;
grant execute on function public.review_pilot_action(uuid, uuid, integer, uuid, boolean) to service_role;

-- ---------------------------------------------------------------------
-- 5. withdraw_pilot_action
-- ---------------------------------------------------------------------

create or replace function public.withdraw_pilot_action(
  p_pilot_id      uuid,
  p_action_id     uuid,
  p_withdrawn_by  uuid,
  p_reason        text
)
returns table (outcome text)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_pilot public.pilots%rowtype;
begin
  if p_pilot_id is null or p_action_id is null or p_withdrawn_by is null
     or p_reason is null or char_length(btrim(p_reason)) not between 10 and 2000 then
    raise exception using errcode = '22023', message = 'invalid_withdraw_pilot_action_args';
  end if;

  select * into v_pilot from public.pilots where id = p_pilot_id for share;
  if not found then
    return query select 'PILOT_NOT_FOUND'::text;
    return;
  end if;

  if not exists (select 1 from public.pilot_actions pa where pa.id = p_action_id and pa.pilot_id = p_pilot_id) then
    return query select 'ACTION_NOT_FOUND'::text;
    return;
  end if;

  if exists (select 1 from public.pilot_action_events ev where ev.action_id = p_action_id and ev.event = 'withdrawn') then
    return query select 'ALREADY_WITHDRAWN'::text;
    return;
  end if;

  insert into public.pilot_action_events (action_id, action_version_id, pilot_id, project_id, event, actor, reason)
  values (p_action_id, null, p_pilot_id, v_pilot.project_id, 'withdrawn', p_withdrawn_by, btrim(p_reason));

  return query select 'WITHDRAWN'::text;
end;
$$;

revoke all on function public.withdraw_pilot_action(uuid, uuid, uuid, text) from public;
revoke all on function public.withdraw_pilot_action(uuid, uuid, uuid, text) from anon;
revoke all on function public.withdraw_pilot_action(uuid, uuid, uuid, text) from authenticated;
grant execute on function public.withdraw_pilot_action(uuid, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------
-- 6. save_pilot_report_artifact, redefined: 20261119120000's body, byte for
--    byte, with the D-057 block added before the revision is numbered.
-- ---------------------------------------------------------------------

create or replace function public.save_pilot_report_artifact(
  p_pilot_id           uuid,
  p_created_by         uuid,
  p_markdown           text,
  p_payload            jsonb,
  p_manifest           jsonb,
  p_integrity_status   text,
  p_integrity_reasons  jsonb,
  p_generated_at       timestamptz
)
returns table (outcome text, artifact_id uuid, revision integer)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_pilot public.pilots%rowtype;
  v_manifest_protocols uuid[];
  v_pilot_protocols uuid[];
  v_revision integer;
  v_id uuid;
begin
  if p_pilot_id is null or p_created_by is null
     or p_markdown is null or char_length(btrim(p_markdown)) = 0
     or p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or (p_payload ->> 'pilotId') is distinct from p_pilot_id::text
     or p_manifest is null or jsonb_typeof(p_manifest) <> 'object'
     or jsonb_typeof(p_manifest -> 'protocols') is distinct from 'array'
     or jsonb_typeof(p_manifest -> 'attempts') is distinct from 'array'
     or p_generated_at is null
     or p_integrity_status is null
     or p_integrity_status not in ('integrity_passed', 'needs_review', 'blocked')
     or p_integrity_reasons is null or jsonb_typeof(p_integrity_reasons) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_save_pilot_report_args';
  end if;

  if (p_integrity_status = 'integrity_passed') <> (jsonb_array_length(p_integrity_reasons) = 0) then
    raise exception using errcode = '22023', message = 'invalid_save_pilot_report_args';
  end if;

  -- Every manifest entry is well formed, and nothing is listed twice.
  if exists (
       select 1 from jsonb_array_elements(p_manifest -> 'protocols') e
        where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ v_uuid)
     or exists (
       select 1 from jsonb_array_elements(p_manifest -> 'attempts') e
        where jsonb_typeof(e) <> 'object'
           or jsonb_typeof(e -> 'id') is distinct from 'string' or (e ->> 'id') !~ v_uuid
           or jsonb_typeof(e -> 'protocolId') is distinct from 'string' or (e ->> 'protocolId') !~ v_uuid
           or not (jsonb_typeof(e -> 'rawResponseSha256') in ('null', 'string'))
           or (jsonb_typeof(e -> 'rawResponseSha256') = 'string' and (e ->> 'rawResponseSha256') !~ '^[0-9a-f]{64}$'))
     or (select count(*) from jsonb_array_elements(p_manifest -> 'protocols'))
        <> (select count(distinct e #>> '{}') from jsonb_array_elements(p_manifest -> 'protocols') e)
     or (select count(*) from jsonb_array_elements(p_manifest -> 'attempts'))
        <> (select count(distinct e ->> 'id') from jsonb_array_elements(p_manifest -> 'attempts') e) then
    raise exception using errcode = '22023', message = 'invalid_save_pilot_report_args';
  end if;

  -- Serialises revision numbers per pilot.
  select * into v_pilot from public.pilots where id = p_pilot_id for update;
  if not found then
    return query select 'PILOT_NOT_FOUND'::text, null::uuid, null::integer;
    return;
  end if;

  if (p_payload ->> 'projectId') is distinct from v_pilot.project_id::text then
    return query select 'EVIDENCE_OUTSIDE_PILOT'::text, null::uuid, null::integer;
    return;
  end if;

  -- A measurement still running: answers may still be written, so the
  -- report would read a moving target. Checked before the evidence, so a
  -- build that raced a run is refused for what it is. The pilot row lock
  -- above is the one request_protocol_job_run takes for share, so no new Run
  -- can be requested for this pilot while the save runs.
  if exists (
    select 1
      from public.pilot_questions pq
      join public.pilot_question_protocols pqp on pqp.pilot_question_id = pq.id
      join public.protocols pr
        on pr.id = pqp.protocol_id or pr.baseline_protocol_id = pqp.protocol_id
      left join public.protocol_execution_jobs j on j.protocol_id = pr.id
     where pq.pilot_id = p_pilot_id
       and (
         (j.status in ('claimed', 'running') and j.lease_expires_at > now())
         or exists (
           select 1
             from public.protocol_job_run_requests r
            where r.job_id = j.id
              and r.status = 'pending'
              and r.expires_at > now())
         or exists (
           select 1
             from public.protocol_attempts a
            where a.protocol_id = pr.id
              and a.status in ('reserved', 'in_progress'))
       )
  ) then
    return query select 'MEASUREMENT_IN_PROGRESS'::text, null::uuid, null::integer;
    return;
  end if;

  v_manifest_protocols := array(
    select (e #>> '{}')::uuid from jsonb_array_elements(p_manifest -> 'protocols') e);
  v_pilot_protocols := array(
    select pqp.protocol_id
      from public.pilot_question_protocols pqp
      join public.pilot_questions pq on pq.id = pqp.pilot_question_id
     where pq.pilot_id = p_pilot_id);

  -- A protocol that is not one of this pilot's.
  if exists (select unnest(v_manifest_protocols) except select unnest(v_pilot_protocols)) then
    return query select 'EVIDENCE_OUTSIDE_PILOT'::text, null::uuid, null::integer;
    return;
  end if;

  -- An attempt that does not exist, belongs to another protocol or project,
  -- or is listed under a protocol the manifest does not name.
  if exists (
    select 1
      from jsonb_array_elements(p_manifest -> 'attempts') e
      left join public.protocol_attempts a on a.id = (e ->> 'id')::uuid
     where a.id is null
        or a.protocol_id <> (e ->> 'protocolId')::uuid
        or a.project_id <> v_pilot.project_id
        or not ((e ->> 'protocolId')::uuid = any (v_manifest_protocols))) then
    return query select 'EVIDENCE_OUTSIDE_PILOT'::text, null::uuid, null::integer;
    return;
  end if;

  -- A pilot protocol, retired questions' included, or one of its attempts,
  -- left out: the report would hide failed or excluded attempts.
  if exists (select unnest(v_pilot_protocols) except select unnest(v_manifest_protocols))
     or exists (
       select 1 from public.protocol_attempts a
        where a.protocol_id = any (v_pilot_protocols)
          and not exists (
            select 1 from jsonb_array_elements(p_manifest -> 'attempts') e
             where (e ->> 'id')::uuid = a.id)) then
    return query select 'EVIDENCE_INCOMPLETE'::text, null::uuid, null::integer;
    return;
  end if;

  -- Each listed response hash is the stored one (none where no result exists).
  if exists (
    select 1
      from jsonb_array_elements(p_manifest -> 'attempts') e
      join public.protocol_attempts a on a.id = (e ->> 'id')::uuid
      left join public.probe_results r on r.probe_run_id = a.probe_run_id
     where (e ->> 'rawResponseSha256') is distinct from r.raw_response_sha256) then
    return query select 'EVIDENCE_MISMATCH'::text, null::uuid, null::integer;
    return;
  end if;

  -- D-057 begin: suggested actions. The manifest lists the action versions
  -- the payload shows (none when the key is absent). Each must be its
  -- action's latest version, reviewed, of an action of this pilot that is
  -- not withdrawn, and every such action must be listed, so a revision
  -- shows exactly the reviewed actions. A revision with any action is never
  -- integrity_passed: the founder reads it before sharing (D-057).
  if (p_manifest ? 'actionVersions' and jsonb_typeof(p_manifest -> 'actionVersions') <> 'array')
     or (p_payload ? 'actions' and jsonb_typeof(p_payload -> 'actions') <> 'array') then
    raise exception using errcode = '22023', message = 'invalid_save_pilot_report_args';
  end if;
  if exists (
       select 1 from jsonb_array_elements(coalesce(p_manifest -> 'actionVersions', '[]'::jsonb)) e
        where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ v_uuid)
     or exists (
       select 1 from jsonb_array_elements(coalesce(p_payload -> 'actions', '[]'::jsonb)) a
        where jsonb_typeof(a) <> 'object' or jsonb_typeof(a -> 'versionId') is distinct from 'string')
     or (select count(*) from jsonb_array_elements(coalesce(p_manifest -> 'actionVersions', '[]'::jsonb)))
        <> (select count(distinct e #>> '{}') from jsonb_array_elements(coalesce(p_manifest -> 'actionVersions', '[]'::jsonb)) e)
     or (select count(*) from jsonb_array_elements(coalesce(p_payload -> 'actions', '[]'::jsonb)))
        <> (select count(distinct a ->> 'versionId') from jsonb_array_elements(coalesce(p_payload -> 'actions', '[]'::jsonb)) a)
     or exists (
       select e #>> '{}' from jsonb_array_elements(coalesce(p_manifest -> 'actionVersions', '[]'::jsonb)) e
       except
       select a ->> 'versionId' from jsonb_array_elements(coalesce(p_payload -> 'actions', '[]'::jsonb)) a)
     or exists (
       select a ->> 'versionId' from jsonb_array_elements(coalesce(p_payload -> 'actions', '[]'::jsonb)) a
       except
       select e #>> '{}' from jsonb_array_elements(coalesce(p_manifest -> 'actionVersions', '[]'::jsonb)) e)
     or (jsonb_array_length(coalesce(p_manifest -> 'actionVersions', '[]'::jsonb)) > 0
         and p_integrity_status = 'integrity_passed') then
    raise exception using errcode = '22023', message = 'invalid_save_pilot_report_args';
  end if;

  -- A listed version that is not its action's latest, reviewed version of
  -- an action of this pilot that is not withdrawn.
  if exists (
    select 1
      from jsonb_array_elements(coalesce(p_manifest -> 'actionVersions', '[]'::jsonb)) e
      left join public.pilot_action_versions pav
        on pav.id = (e #>> '{}')::uuid and pav.pilot_id = p_pilot_id
     where pav.id is null
        or pav.version_number <> (
             select max(pav2.version_number) from public.pilot_action_versions pav2 where pav2.action_id = pav.action_id)
        or not exists (
             select 1 from public.pilot_action_events ev where ev.action_version_id = pav.id and ev.event = 'reviewed')
        or exists (
             select 1 from public.pilot_action_events ev where ev.action_id = pav.action_id and ev.event = 'withdrawn')) then
    return query select 'ACTION_NOT_REVIEWED'::text, null::uuid, null::integer;
    return;
  end if;

  -- A reviewed, current action of this pilot left out.
  if exists (
    select 1
      from public.pilot_action_versions pav
     where pav.pilot_id = p_pilot_id
       and pav.version_number = (
             select max(pav2.version_number) from public.pilot_action_versions pav2 where pav2.action_id = pav.action_id)
       and exists (
             select 1 from public.pilot_action_events ev where ev.action_version_id = pav.id and ev.event = 'reviewed')
       and not exists (
             select 1 from public.pilot_action_events ev where ev.action_id = pav.action_id and ev.event = 'withdrawn')
       and not exists (
             select 1 from jsonb_array_elements(coalesce(p_manifest -> 'actionVersions', '[]'::jsonb)) e
              where (e #>> '{}')::uuid = pav.id)) then
    return query select 'ACTIONS_INCOMPLETE'::text, null::uuid, null::integer;
    return;
  end if;
  -- D-057 end

  select coalesce(max(pra.revision), 0) + 1 into v_revision
    from public.pilot_report_artifacts pra
   where pra.pilot_id = p_pilot_id;

  insert into public.pilot_report_artifacts (
    pilot_id, project_id, revision, markdown, payload, manifest, content_sha256,
    generated_at, integrity_status, integrity_reasons, public_token, created_by
  ) values (
    p_pilot_id, v_pilot.project_id, v_revision, p_markdown, p_payload, p_manifest,
    encode(sha256(sha256(convert_to(p_markdown, 'UTF8')) || sha256(convert_to(p_payload::text, 'UTF8'))), 'hex'),
    p_generated_at, p_integrity_status, p_integrity_reasons,
    replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
    p_created_by
  )
  returning id into v_id;

  return query select 'SAVED'::text, v_id, v_revision;
end;
$$;

revoke all on function public.save_pilot_report_artifact(uuid, uuid, text, jsonb, jsonb, text, jsonb, timestamptz) from public;
revoke all on function public.save_pilot_report_artifact(uuid, uuid, text, jsonb, jsonb, text, jsonb, timestamptz) from anon;
revoke all on function public.save_pilot_report_artifact(uuid, uuid, text, jsonb, jsonb, text, jsonb, timestamptz) from authenticated;
grant execute on function public.save_pilot_report_artifact(uuid, uuid, text, jsonb, jsonb, text, jsonb, timestamptz) to service_role;
