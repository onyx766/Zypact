-- Q4 — customer approval and activation of buyer questions (D-049).
-- Applies after E1 (20261112120000).
--
-- D-047 Part B item 6 (founder-approved 2026-11-10): a signed-in customer
-- approves a draft question (P2) and it becomes an active buyer question of
-- the workspace's project, within the plan's active-question limit (E1).
--
-- What approval creates, in one transaction:
--   * a buyer_questions row (first approval of that draft) and a
--     buyer_question_versions row whose prompt_text is the draft's exact
--     text and whose prompt_hash is its SHA-256, approved through M4's own
--     approve_buyer_question_version with approved_by = the approval record;
--   * an immutable approval record (D-040 §5.1): account, membership,
--     workspace, project, session, the session's step-up instant, the draft
--     version and text hash, the consent text version and hash, and the
--     database timestamp;
--   * an append-only activation event.
--
-- Rules:
--   * approval needs a step-up within the last 10 minutes on the session
--     (D-040: step-up before any approval), checked in the database;
--   * activating a question that is not active counts against the plan's
--     active-question limit; approving a changed wording of an active
--     question adds a version and counts nothing new;
--   * a material edit never alters a measured version: it is a new
--     buyer_question_versions row (version_number + 1), and earlier versions
--     and their evidence stay as they are;
--   * archiving ends the question's active state only. It never touches the
--     usage ledger, so runs already consumed are never given back;
--   * question approval never authorises execution (D-040). Nothing here
--     reserves, admits or starts a measurement.
--
-- Closed, as Q2′, P1, P2 and E1. Recovery: rollback drops the two new
-- tables and the functions; buyer_questions and buyer_question_versions rows
-- created by Q4 stay (append-only by design, as every M4 version) and are
-- found through their approved_by.

-- ════════════════════════════════════════════════════════════════════════
-- 1. Tables
-- ════════════════════════════════════════════════════════════════════════

create table public.workspace_question_approvals (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null references public.workspaces(id),
  project_id             uuid not null,
  draft_id               uuid not null,
  draft_version          integer not null check (draft_version >= 1),
  approved_text_sha256   text not null check (approved_text_sha256 ~ '^[0-9a-f]{64}$'),
  draft_origin           text not null check (draft_origin in ('customer_written', 'suggested', 'suggestion_edited')),
  buyer_question_id      uuid not null,
  buyer_question_version_id uuid not null,
  action                 text not null check (action in ('activate', 'new_version', 'reactivate')),
  session_id             uuid not null,
  step_up_at             timestamptz not null,
  consent_text_version   text not null check (consent_text_version ~ '^q4\.[a-z_]{3,40}\.v[0-9]{1,3}$'),
  consent_text_sha256    text not null check (consent_text_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key        text not null check (btrim(idempotency_key) <> '' and length(idempotency_key) <= 200),
  actor_type             text not null check (actor_type = 'customer_account'),
  actor_account_id       uuid not null,
  actor_membership_id    uuid not null,
  approved_at            timestamptz not null default clock_timestamp(),
  constraint workspace_question_approvals_key unique (workspace_id, idempotency_key),
  constraint workspace_question_approvals_project_fk foreign key (project_id, workspace_id)
    references public.workspace_projects(project_id, workspace_id),
  constraint workspace_question_approvals_draft_fk foreign key (draft_id, workspace_id)
    references public.workspace_question_drafts(id, workspace_id),
  constraint workspace_question_approvals_question_fk foreign key (buyer_question_id, project_id)
    references public.buyer_questions(id, project_id),
  constraint workspace_question_approvals_version_fk foreign key (buyer_question_version_id, project_id)
    references public.buyer_question_versions(id, project_id),
  constraint workspace_question_approvals_actor_membership_fk
    foreign key (actor_membership_id, actor_account_id, workspace_id)
    references public.workspace_members(id, account_id, workspace_id),
  constraint workspace_question_approvals_step_up_fresh check (
    step_up_at <= approved_at and step_up_at > approved_at - interval '10 minutes')
);

-- One draft maps to one buyer question, for life: only its first approval
-- activates; later approvals add versions to, or reactivate, that question.
create unique index workspace_question_approvals_one_question_per_draft
  on public.workspace_question_approvals (draft_id) where action = 'activate';

create table public.workspace_active_question_events (
  id                         uuid primary key default gen_random_uuid(),
  workspace_id               uuid not null references public.workspaces(id),
  project_id                 uuid not null,
  buyer_question_id          uuid not null,
  event                      text not null check (event in ('activated', 'version_added', 'archived')),
  buyer_question_version_id  uuid,
  approval_id                uuid references public.workspace_question_approvals(id),
  actor_type                 text not null check (actor_type = 'customer_account'),
  actor_account_id           uuid not null,
  actor_membership_id        uuid not null,
  created_at                 timestamptz not null default clock_timestamp(),
  constraint workspace_active_question_events_question_fk foreign key (buyer_question_id, project_id)
    references public.buyer_questions(id, project_id),
  constraint workspace_active_question_events_project_fk foreign key (project_id, workspace_id)
    references public.workspace_projects(project_id, workspace_id),
  constraint workspace_active_question_events_actor_membership_fk
    foreign key (actor_membership_id, actor_account_id, workspace_id)
    references public.workspace_members(id, account_id, workspace_id),
  constraint workspace_active_question_events_shape check (
    (event = 'archived' and approval_id is null and buyer_question_version_id is null)
    or (event <> 'archived' and approval_id is not null and buyer_question_version_id is not null))
);

create index workspace_active_question_events_question
  on public.workspace_active_question_events (buyer_question_id, created_at);

create or replace function public._q4_append_only()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception using errcode = '55000', message = 'q4_append_only: ' || tg_table_name;
end;
$$;

create trigger workspace_question_approvals_append_only
  before update or delete on public.workspace_question_approvals
  for each row execute function public._q4_append_only();
create trigger workspace_question_approvals_no_truncate
  before truncate on public.workspace_question_approvals
  for each statement execute function public._q4_append_only();
create trigger workspace_active_question_events_append_only
  before update or delete on public.workspace_active_question_events
  for each row execute function public._q4_append_only();
create trigger workspace_active_question_events_no_truncate
  before truncate on public.workspace_active_question_events
  for each statement execute function public._q4_append_only();

alter table public.workspace_question_approvals enable row level security;
alter table public.workspace_active_question_events enable row level security;
revoke all on table public.workspace_question_approvals, public.workspace_active_question_events
  from public, anon, authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- 2. Helpers (no role may execute them)
-- ════════════════════════════════════════════════════════════════════════

-- Is the question currently active (its latest event is not 'archived')?
create or replace function public._q4_is_active(p_buyer_question_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select coalesce((select e.event <> 'archived' from public.workspace_active_question_events e
                    where e.buyer_question_id = p_buyer_question_id
                    order by e.created_at desc, e.id desc limit 1), false);
$$;

create or replace function public._q4_active_count(p_workspace_id uuid)
returns integer
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select count(*)::integer from (
    select distinct on (e.buyer_question_id) e.event
      from public.workspace_active_question_events e
     where e.workspace_id = p_workspace_id
     order by e.buyer_question_id, e.created_at desc, e.id desc) l
   where l.event <> 'archived';
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 3. Functions
-- ════════════════════════════════════════════════════════════════════════

-- Q4-F1: approves the draft's current wording. First approval activates a
-- new buyer question; an approval of changed wording adds a version; an
-- approval of an archived question's draft reactivates it. Idempotent on
-- the key: a replay returns the first result.
create or replace function public.approve_question_draft(
  p_token text,
  p_account_id uuid,
  p_draft_id uuid,
  p_expected_draft_version integer,
  p_idempotency_key text,
  p_consent_text_version text,
  p_consent_text_sha256 text
) returns table (status text, buyer_question_id uuid, buyer_question_version_id uuid)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_session record;
  v_now timestamptz;
  site record;
  v_prior public.workspace_question_approvals%rowtype;
  v_draft public.workspace_question_draft_versions%rowtype;
  v_link public.workspace_question_approvals%rowtype;
  v_current_version public.buyer_question_versions%rowtype;
  v_question uuid;
  v_version uuid := gen_random_uuid();
  v_version_number integer;
  v_action text;
  v_active boolean;
  v_plan record;
  v_approval uuid := gen_random_uuid();
  v_status text;
begin
  if p_draft_id is null or p_expected_draft_version is null
     or coalesce(btrim(p_idempotency_key), '') = '' or length(p_idempotency_key) > 200
     or coalesce(p_consent_text_version, '') !~ '^q4\.[a-z_]{3,40}\.v[0-9]{1,3}$'
     or coalesce(p_consent_text_sha256, '') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'q4_invalid_approval_args';
  end if;

  select c.status, c.session_id, c.workspace_id, c.membership_id, c.step_up_at into v_session
    from public.check_account_session(p_token, p_account_id) c;
  if coalesce(v_session.status, 'NOT_FOUND') <> 'ACTIVE' then
    return query select 'NOT_SIGNED_IN'::text, null::uuid, null::uuid;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('zypact.p1.workspace:' || v_session.workspace_id::text, 0));

  -- Replay.
  select a.* into v_prior from public.workspace_question_approvals a
   where a.workspace_id = v_session.workspace_id and a.idempotency_key = p_idempotency_key;
  if v_prior.id is not null then
    if v_prior.draft_id = p_draft_id and v_prior.draft_version = p_expected_draft_version then
      return query select 'ALREADY_APPROVED'::text, v_prior.buyer_question_id, v_prior.buyer_question_version_id;
    else
      return query select 'IDEMPOTENCY_KEY_CONFLICT'::text, null::uuid, null::uuid;
    end if;
    return;
  end if;

  -- The authorisation instant: after the locks, one clock reading.
  v_now := clock_timestamp();
  if v_session.step_up_at is null or v_session.step_up_at > v_now
     or v_session.step_up_at <= v_now - interval '10 minutes' then
    return query select 'STEP_UP_REQUIRED'::text, null::uuid, null::uuid;
    return;
  end if;

  select * into site from public._p1_site(v_session.workspace_id);
  if site.project_id is null then
    return query select 'NO_WEBSITE'::text, null::uuid, null::uuid;
    return;
  end if;

  select v.* into v_draft from public.workspace_question_draft_versions v
   where v.draft_id = p_draft_id and v.workspace_id = v_session.workspace_id
   order by v.version desc limit 1;
  if v_draft.id is null then
    return query select 'NOT_FOUND'::text, null::uuid, null::uuid;
    return;
  end if;
  if v_draft.version <> p_expected_draft_version then
    return query select 'VERSION_CONFLICT'::text, null::uuid, null::uuid;
    return;
  end if;
  if v_draft.status <> 'draft' then
    return query select 'DRAFT_ARCHIVED'::text, null::uuid, null::uuid;
    return;
  end if;

  select a.* into v_link from public.workspace_question_approvals a
   where a.draft_id = p_draft_id and a.action = 'activate';

  if v_link.id is null then
    -- A first activation. The same wording must not already be an active
    -- question of this workspace.
    if exists (
         select 1 from public.workspace_question_approvals a
          where a.workspace_id = v_session.workspace_id and a.approved_text_sha256 = v_draft.text_sha256
            and public._q4_is_active(a.buyer_question_id)) then
      return query select 'ALREADY_ACTIVE_WORDING'::text, null::uuid, null::uuid;
      return;
    end if;
    v_action := 'activate';
    v_active := false;
  else
    v_question := v_link.buyer_question_id;
    v_active := public._q4_is_active(v_question);
    select bqv.* into v_current_version from public.buyer_question_versions bqv
     where bqv.buyer_question_id = v_question order by bqv.version_number desc limit 1;
    if v_active and v_current_version.prompt_hash = v_draft.text_sha256 then
      return query select 'UNCHANGED'::text, v_question, v_current_version.id;
      return;
    end if;
    v_action := case when v_active then 'new_version' else 'reactivate' end;
  end if;

  if not v_active then
    select * into v_plan from public._e1_current_plan(v_session.workspace_id);
    if public._q4_active_count(v_session.workspace_id) >= public._e1_active_question_limit(v_plan.plan) then
      return query select 'LIMIT_REACHED'::text, null::uuid, null::uuid;
      return;
    end if;
  end if;

  if v_action = 'activate' then
    insert into public.buyer_questions (project_id) values (site.project_id) returning id into v_question;
    v_version_number := 1;
  elsif v_current_version.prompt_hash = v_draft.text_sha256 then
    -- Reactivating unchanged wording reuses the existing version.
    v_version := v_current_version.id;
    v_version_number := null;
  else
    v_version_number := v_current_version.version_number + 1;
  end if;

  if v_version_number is not null then
    insert into public.buyer_question_versions (
      id, buyer_question_id, project_id, version_number, prompt_text, prompt_hash, intent_type,
      commercial_value, winnability, priority, rationale, provenance)
    values (
      v_version, v_question, site.project_id, v_version_number, v_draft.question_text, v_draft.text_sha256,
      v_draft.category, 1, 1, 1,
      'Approved by the customer from a workspace draft (Q4 v1). No sort ratings: every value is the neutral 1.',
      'customer_supplied');
  end if;

  insert into public.workspace_question_approvals (
    id, workspace_id, project_id, draft_id, draft_version, approved_text_sha256, draft_origin,
    buyer_question_id, buyer_question_version_id, action, session_id, step_up_at,
    consent_text_version, consent_text_sha256, idempotency_key,
    actor_type, actor_account_id, actor_membership_id, approved_at)
  values (
    v_approval, v_session.workspace_id, site.project_id, p_draft_id, v_draft.version, v_draft.text_sha256,
    v_draft.origin, v_question, v_version, v_action, v_session.session_id, v_session.step_up_at,
    p_consent_text_version, p_consent_text_sha256, p_idempotency_key,
    'customer_account', p_account_id, v_session.membership_id, v_now);

  if v_version_number is not null then
    select a.status into v_status
      from public.approve_buyer_question_version(v_version, site.project_id, v_approval) a;
    if v_status is distinct from 'APPROVED' then
      raise exception using errcode = '55000', message = 'q4_version_approval_failed';
    end if;
  end if;

  insert into public.workspace_active_question_events (
    workspace_id, project_id, buyer_question_id, event, buyer_question_version_id, approval_id,
    actor_type, actor_account_id, actor_membership_id)
  values (
    v_session.workspace_id, site.project_id, v_question,
    case when v_action = 'new_version' then 'version_added' else 'activated' end,
    v_version, v_approval, 'customer_account', p_account_id, v_session.membership_id);

  return query select
    case v_action when 'activate' then 'ACTIVATED' when 'new_version' then 'VERSION_ADDED' else 'REACTIVATED' end,
    v_question, v_version;
end;
$$;

-- Q4-F2: archives an active question. No step-up: it narrows what may be
-- measured and authorises nothing. Runs already used are not given back.
create or replace function public.archive_active_question(
  p_token text,
  p_account_id uuid,
  p_buyer_question_id uuid
) returns table (status text)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  s record;
  v_project uuid;
begin
  select * into s from public._p1_session(p_token, p_account_id);
  if s.status <> 'ACTIVE' then
    return query select 'NOT_SIGNED_IN'::text;
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('zypact.p1.workspace:' || s.workspace_id::text, 0));

  select e.project_id into v_project from public.workspace_active_question_events e
   where e.buyer_question_id = p_buyer_question_id and e.workspace_id = s.workspace_id
   limit 1;
  if v_project is null then
    return query select 'NOT_FOUND'::text;
    return;
  end if;
  if not public._q4_is_active(p_buyer_question_id) then
    return query select 'ALREADY_ARCHIVED'::text;
    return;
  end if;

  insert into public.workspace_active_question_events (
    workspace_id, project_id, buyer_question_id, event, actor_type, actor_account_id, actor_membership_id)
  values (s.workspace_id, v_project, p_buyer_question_id, 'archived', 'customer_account', p_account_id, s.membership_id);
  return query select 'ARCHIVED'::text;
end;
$$;

-- Q4-F3: the workspace's buyer questions with every version, and the
-- active-question limit.
create or replace function public.list_active_questions(
  p_token text,
  p_account_id uuid
) returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  s record;
  v_plan record;
begin
  select * into s from public._p1_session(p_token, p_account_id);
  if s.status <> 'ACTIVE' then
    return jsonb_build_object('status', 'NOT_SIGNED_IN');
  end if;
  select * into v_plan from public._e1_current_plan(s.workspace_id);
  return jsonb_build_object(
    'status', 'OK',
    'limit', public._e1_active_question_limit(v_plan.plan),
    'active_count', public._q4_active_count(s.workspace_id),
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'buyer_question_id', q.buyer_question_id,
               'draft_id', q.draft_id,
               'active', public._q4_is_active(q.buyer_question_id),
               'since', (select max(e.created_at) from public.workspace_active_question_events e
                          where e.buyer_question_id = q.buyer_question_id),
               'versions', (select jsonb_agg(jsonb_build_object(
                                     'id', v.id, 'number', v.version_number, 'text', v.prompt_text,
                                     'category', v.intent_type, 'approved_at', v.approved_at)
                                   order by v.version_number)
                              from public.buyer_question_versions v
                             where v.buyer_question_id = q.buyer_question_id))
             order by q.first_at)
        from (select a.buyer_question_id, a.draft_id, min(a.approved_at) as first_at
                from public.workspace_question_approvals a
               where a.workspace_id = s.workspace_id
               group by a.buyer_question_id, a.draft_id) q), '[]'::jsonb));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 4. Function privileges
-- ════════════════════════════════════════════════════════════════════════

revoke all on function public._q4_append_only() from public, anon, authenticated, service_role;
revoke all on function public._q4_is_active(uuid) from public, anon, authenticated, service_role;
revoke all on function public._q4_active_count(uuid) from public, anon, authenticated, service_role;

revoke all on function public.approve_question_draft(text, uuid, uuid, integer, text, text, text) from public, anon, authenticated;
revoke all on function public.archive_active_question(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.list_active_questions(text, uuid) from public, anon, authenticated;

grant execute on function public.approve_question_draft(text, uuid, uuid, integer, text, text, text) to service_role;
grant execute on function public.archive_active_question(text, uuid, uuid) to service_role;
grant execute on function public.list_active_questions(text, uuid) to service_role;
