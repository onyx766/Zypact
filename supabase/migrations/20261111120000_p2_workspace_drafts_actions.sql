-- P2 — customer workspace: draft buyer questions and tracked actions
-- (D-047, proposed). Applies after P1 (20261110120000).
--
-- Draft questions are the customer's working list before any approval. A
-- draft is not an approved buyer question version (D-039, Q2′-1), takes no
-- active-question slot, and nothing here starts, authorises or reserves a
-- measurement. Approval stays with Q4′ and execution with X1.
--
-- Actions are the customer's own investigation log. Each action's evidence
-- is fixed when the action is created: one stored site-diagnostic finding of
-- the same workspace, or a customer note. Later versions change only the
-- wording, owner and status. An action is not a registered intervention
-- (M7); it never feeds a retest or an Outcome Card.
--
-- Every customer function takes the account session token and the account
-- id the server read from a verified Auth user, re-checks the session in the
-- database through P1's _p1_session, and takes the workspace from the
-- session, never from an argument. Writes serialise on P1's per-workspace
-- advisory lock, so the caps below hold under concurrency.
--
-- Closed, as Q2′ and P1: RLS on with no policy, no table privilege for any
-- API role, public functions executable by service_role only, `_p2_`
-- helpers by no role. Rows are append-only (no UPDATE, DELETE or TRUNCATE).
-- No paid call and no model call.
--
-- Recovery: nothing outside this file references these tables. Forward
-- recovery is a later migration; a full rollback drops the six public
-- functions, the three helpers and the four tables (versions first), which
-- loses only P2 drafts and actions and no evidence row.

-- ════════════════════════════════════════════════════════════════════════
-- 1. Helpers (no role may execute them)
-- ════════════════════════════════════════════════════════════════════════

-- Trimmed, single-line-safe text within [min, max] characters.
create or replace function public._p2_text_ok(p_text text, p_min integer, p_max integer)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select p_text is not null
     and p_text = btrim(p_text)
     and length(p_text) between p_min and p_max
     and p_text !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]';
$$;

create or replace function public._p2_append_only()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception using errcode = '55000', message = 'p2_append_only: ' || tg_table_name;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 2. Draft buyer questions
-- ════════════════════════════════════════════════════════════════════════

create table public.workspace_question_drafts (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id),
  created_at    timestamptz not null default clock_timestamp(),
  constraint workspace_question_drafts_id_workspace_key unique (id, workspace_id)
);

create table public.workspace_question_draft_versions (
  id                   uuid primary key default gen_random_uuid(),
  draft_id             uuid not null,
  workspace_id         uuid not null,
  version              integer not null check (version >= 1),
  question_text        text not null check (public._p2_text_ok(question_text, 8, 300)),
  text_sha256          text not null,
  category             text not null check (category in ('discovery', 'comparison', 'evaluation', 'use_case')),
  -- customer_written: typed by the customer. suggested: Zypact's suggested
  -- wording, unchanged. suggestion_edited: suggested wording the customer
  -- has since changed. Suggestions are wording only, never buyer evidence.
  origin               text not null check (origin in ('customer_written', 'suggested', 'suggestion_edited')),
  suggestion_rule      text check (suggestion_rule is null or suggestion_rule ~ '^p2\.suggest\.[a-z_]{3,40}\.v[0-9]{1,3}$'),
  status               text not null check (status in ('draft', 'archived')),
  actor_type           text not null check (actor_type = 'customer_account'),
  actor_account_id     uuid not null,
  actor_membership_id  uuid not null,
  created_at           timestamptz not null default clock_timestamp(),
  constraint workspace_question_draft_versions_version_key unique (draft_id, version),
  constraint workspace_question_draft_versions_draft_fk foreign key (draft_id, workspace_id)
    references public.workspace_question_drafts(id, workspace_id),
  constraint workspace_question_draft_versions_actor_membership_fk
    foreign key (actor_membership_id, actor_account_id, workspace_id)
    references public.workspace_members(id, account_id, workspace_id),
  constraint workspace_question_draft_versions_text_hash check (text_sha256 = public._q2p_sha256_hex(question_text)),
  constraint workspace_question_draft_versions_origin_rule check ((origin = 'customer_written') = (suggestion_rule is null))
);

-- ════════════════════════════════════════════════════════════════════════
-- 3. Actions (customer investigation log)
-- ════════════════════════════════════════════════════════════════════════

create table public.workspace_actions (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces(id),
  evidence_kind        text not null check (evidence_kind in ('site_diagnostic_finding', 'customer_note')),
  evidence_finding_id  uuid references public.site_diagnostic_findings(id),
  evidence_note        text check (evidence_note is null or public._p2_text_ok(evidence_note, 1, 1000)),
  created_at           timestamptz not null default clock_timestamp(),
  constraint workspace_actions_id_workspace_key unique (id, workspace_id),
  constraint workspace_actions_evidence_shape check (
    (evidence_kind = 'site_diagnostic_finding' and evidence_finding_id is not null and evidence_note is null)
    or (evidence_kind = 'customer_note' and evidence_finding_id is null and evidence_note is not null))
);

-- The evidence finding belongs to the action's workspace.
create or replace function public._p2_action_evidence_check()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.evidence_finding_id is not null and not exists (
       select 1 from public.site_diagnostic_findings f
        where f.id = new.evidence_finding_id and f.workspace_id = new.workspace_id) then
    raise exception using errcode = '23514', message = 'p2_evidence_not_in_workspace';
  end if;
  return new;
end;
$$;

create trigger workspace_actions_evidence
  before insert on public.workspace_actions
  for each row execute function public._p2_action_evidence_check();

create table public.workspace_action_versions (
  id                   uuid primary key default gen_random_uuid(),
  action_id            uuid not null,
  workspace_id         uuid not null,
  version              integer not null check (version >= 1),
  title                text not null check (public._p2_text_ok(title, 3, 160)),
  observation          text not null check (public._p2_text_ok(observation, 1, 1000)),
  why_it_matters       text check (why_it_matters is null or public._p2_text_ok(why_it_matters, 1, 1000)),
  next_step            text not null check (public._p2_text_ok(next_step, 1, 1000)),
  owner_name           text check (owner_name is null or public._p2_text_ok(owner_name, 1, 120)),
  status               text not null check (status in ('open', 'in_progress', 'done', 'dismissed')),
  decision_note        text check (decision_note is null or public._p2_text_ok(decision_note, 1, 1000)),
  actor_type           text not null check (actor_type = 'customer_account'),
  actor_account_id     uuid not null,
  actor_membership_id  uuid not null,
  created_at           timestamptz not null default clock_timestamp(),
  constraint workspace_action_versions_version_key unique (action_id, version),
  constraint workspace_action_versions_action_fk foreign key (action_id, workspace_id)
    references public.workspace_actions(id, workspace_id),
  constraint workspace_action_versions_actor_membership_fk
    foreign key (actor_membership_id, actor_account_id, workspace_id)
    references public.workspace_members(id, account_id, workspace_id)
);

-- ════════════════════════════════════════════════════════════════════════
-- 4. Append-only and closed
-- ════════════════════════════════════════════════════════════════════════

create trigger workspace_question_drafts_append_only
  before update or delete on public.workspace_question_drafts
  for each row execute function public._p2_append_only();
create trigger workspace_question_drafts_no_truncate
  before truncate on public.workspace_question_drafts
  for each statement execute function public._p2_append_only();
create trigger workspace_question_draft_versions_append_only
  before update or delete on public.workspace_question_draft_versions
  for each row execute function public._p2_append_only();
create trigger workspace_question_draft_versions_no_truncate
  before truncate on public.workspace_question_draft_versions
  for each statement execute function public._p2_append_only();
create trigger workspace_actions_append_only
  before update or delete on public.workspace_actions
  for each row execute function public._p2_append_only();
create trigger workspace_actions_no_truncate
  before truncate on public.workspace_actions
  for each statement execute function public._p2_append_only();
create trigger workspace_action_versions_append_only
  before update or delete on public.workspace_action_versions
  for each row execute function public._p2_append_only();
create trigger workspace_action_versions_no_truncate
  before truncate on public.workspace_action_versions
  for each statement execute function public._p2_append_only();

alter table public.workspace_question_drafts enable row level security;
alter table public.workspace_question_draft_versions enable row level security;
alter table public.workspace_actions enable row level security;
alter table public.workspace_action_versions enable row level security;
revoke all on table public.workspace_question_drafts, public.workspace_question_draft_versions,
  public.workspace_actions, public.workspace_action_versions
  from public, anon, authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- 5. Draft question functions
-- ════════════════════════════════════════════════════════════════════════

-- At most 50 live (non-archived) drafts per workspace. Archived drafts are
-- kept and do not count.

-- P2-F1: adds a draft. A live draft with the same text is DUPLICATE (this is
-- also what makes a double submit harmless). A suggested draft names the
-- suggestion rule that produced its wording.
create or replace function public.add_question_draft(
  p_token text,
  p_account_id uuid,
  p_text text,
  p_category text,
  p_suggestion_rule text
) returns table (status text, draft_id uuid)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  s record;
  v_hash text;
  v_existing uuid;
  v_live integer;
  v_id uuid;
begin
  select * into s from public._p1_session(p_token, p_account_id);
  if s.status <> 'ACTIVE' then
    return query select 'NOT_SIGNED_IN'::text, null::uuid;
    return;
  end if;
  if not public._p2_text_ok(p_text, 8, 300) then
    raise exception using errcode = '22023', message = 'p2_invalid_draft_args';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('zypact.p1.workspace:' || s.workspace_id::text, 0));

  v_hash := public._q2p_sha256_hex(p_text);
  select l.draft_id into v_existing
    from (select distinct on (v.draft_id) v.draft_id, v.status, v.text_sha256
            from public.workspace_question_draft_versions v
           where v.workspace_id = s.workspace_id
           order by v.draft_id, v.version desc) l
   where l.status = 'draft' and l.text_sha256 = v_hash
   limit 1;
  if v_existing is not null then
    return query select 'DUPLICATE'::text, v_existing;
    return;
  end if;

  select count(*) into v_live
    from (select distinct on (v.draft_id) v.status
            from public.workspace_question_draft_versions v
           where v.workspace_id = s.workspace_id
           order by v.draft_id, v.version desc) l
   where l.status = 'draft';
  if v_live >= 50 then
    return query select 'LIMIT_REACHED'::text, null::uuid;
    return;
  end if;

  insert into public.workspace_question_drafts (workspace_id) values (s.workspace_id) returning id into v_id;
  insert into public.workspace_question_draft_versions (
    draft_id, workspace_id, version, question_text, text_sha256, category, origin, suggestion_rule, status,
    actor_type, actor_account_id, actor_membership_id)
  values (
    v_id, s.workspace_id, 1, p_text, v_hash, p_category,
    case when p_suggestion_rule is null then 'customer_written' else 'suggested' end,
    p_suggestion_rule, 'draft', 'customer_account', p_account_id, s.membership_id);

  return query select 'ADDED'::text, v_id;
end;
$$;

-- P2-F2: saves a new version of a draft: its text, category or status.
-- p_expected_version is the version the customer edited; anything else is
-- VERSION_CONFLICT. Editing suggested wording records suggestion_edited, so
-- the origin is never overstated. Restoring an archived draft obeys the cap
-- and the duplicate rule.
create or replace function public.revise_question_draft(
  p_token text,
  p_account_id uuid,
  p_draft_id uuid,
  p_expected_version integer,
  p_text text,
  p_category text,
  p_status text
) returns table (status text, version integer)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  s record;
  v_prev public.workspace_question_draft_versions%rowtype;
  v_hash text;
  v_origin text;
  v_live integer;
begin
  select * into s from public._p1_session(p_token, p_account_id);
  if s.status <> 'ACTIVE' then
    return query select 'NOT_SIGNED_IN'::text, null::integer;
    return;
  end if;
  if not public._p2_text_ok(p_text, 8, 300) or p_status not in ('draft', 'archived') then
    raise exception using errcode = '22023', message = 'p2_invalid_draft_args';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('zypact.p1.workspace:' || s.workspace_id::text, 0));

  select v.* into v_prev from public.workspace_question_draft_versions v
   where v.draft_id = p_draft_id and v.workspace_id = s.workspace_id
   order by v.version desc limit 1;
  if v_prev.id is null then
    return query select 'NOT_FOUND'::text, null::integer;
    return;
  end if;
  if p_expected_version is distinct from v_prev.version then
    return query select 'VERSION_CONFLICT'::text, v_prev.version;
    return;
  end if;

  v_hash := public._q2p_sha256_hex(p_text);
  if v_hash = v_prev.text_sha256 and p_category = v_prev.category and p_status = v_prev.status then
    return query select 'UNCHANGED'::text, v_prev.version;
    return;
  end if;

  if p_status = 'draft' then
    if exists (
         select 1 from (select distinct on (v.draft_id) v.draft_id, v.status, v.text_sha256
                          from public.workspace_question_draft_versions v
                         where v.workspace_id = s.workspace_id
                         order by v.draft_id, v.version desc) l
          where l.status = 'draft' and l.text_sha256 = v_hash and l.draft_id <> p_draft_id) then
      return query select 'DUPLICATE'::text, v_prev.version;
      return;
    end if;
    if v_prev.status = 'archived' then
      select count(*) into v_live
        from (select distinct on (v.draft_id) v.status
                from public.workspace_question_draft_versions v
               where v.workspace_id = s.workspace_id
               order by v.draft_id, v.version desc) l
       where l.status = 'draft';
      if v_live >= 50 then
        return query select 'LIMIT_REACHED'::text, v_prev.version;
        return;
      end if;
    end if;
  end if;

  v_origin := case
    when v_prev.origin = 'suggested' and v_hash <> v_prev.text_sha256 then 'suggestion_edited'
    else v_prev.origin end;

  insert into public.workspace_question_draft_versions (
    draft_id, workspace_id, version, question_text, text_sha256, category, origin, suggestion_rule, status,
    actor_type, actor_account_id, actor_membership_id)
  values (
    p_draft_id, s.workspace_id, v_prev.version + 1, p_text, v_hash, p_category, v_origin, v_prev.suggestion_rule,
    p_status, 'customer_account', p_account_id, s.membership_id);

  return query select 'SAVED'::text, v_prev.version + 1;
end;
$$;

-- P2-F3: the workspace's drafts, latest version of each, oldest first.
create or replace function public.list_question_drafts(
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
begin
  select * into s from public._p1_session(p_token, p_account_id);
  if s.status <> 'ACTIVE' then
    return jsonb_build_object('status', 'NOT_SIGNED_IN');
  end if;
  return jsonb_build_object('status', 'OK', 'drafts', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', l.draft_id, 'version', l.version, 'text', l.question_text, 'category', l.category,
             'origin', l.origin, 'suggestion_rule', l.suggestion_rule, 'status', l.status,
             'created_at', d.created_at, 'updated_at', l.created_at)
           order by d.created_at, d.id)
      from (select distinct on (v.draft_id) v.*
              from public.workspace_question_draft_versions v
             where v.workspace_id = s.workspace_id
             order by v.draft_id, v.version desc) l
      join public.workspace_question_drafts d on d.id = l.draft_id), '[]'::jsonb));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 6. Action functions
-- ════════════════════════════════════════════════════════════════════════

-- At most 100 live (open or in_progress) actions per workspace.

-- P2-F4: creates an action. Evidence is either one stored finding of this
-- workspace — named by run, check and page, resolved here so the caller
-- never supplies a row id — or a customer note. A finding that already has
-- a live action is ALREADY_TRACKED.
create or replace function public.create_workspace_action(
  p_token text,
  p_account_id uuid,
  p_evidence_run_id uuid,
  p_evidence_check_id text,
  p_evidence_page_url text,
  p_evidence_note text,
  p_title text,
  p_observation text,
  p_why_it_matters text,
  p_next_step text,
  p_owner_name text
) returns table (status text, action_id uuid)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  s record;
  v_finding uuid;
  v_matches integer;
  v_existing uuid;
  v_live integer;
  v_id uuid;
begin
  select * into s from public._p1_session(p_token, p_account_id);
  if s.status <> 'ACTIVE' then
    return query select 'NOT_SIGNED_IN'::text, null::uuid;
    return;
  end if;
  if (p_evidence_run_id is null) = (p_evidence_note is null)
     or (p_evidence_run_id is not null and p_evidence_check_id is null) then
    raise exception using errcode = '22023', message = 'p2_invalid_action_args';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('zypact.p1.workspace:' || s.workspace_id::text, 0));

  if p_evidence_run_id is not null then
    select min(f.id::text)::uuid, count(*) into v_finding, v_matches
      from public.site_diagnostic_findings f
      left join public.site_diagnostic_pages p on p.id = f.page_id
     where f.run_id = p_evidence_run_id
       and f.workspace_id = s.workspace_id
       and f.check_id = p_evidence_check_id
       and p.url is not distinct from p_evidence_page_url;
    if v_matches <> 1 then
      return query select 'EVIDENCE_NOT_FOUND'::text, null::uuid;
      return;
    end if;

    select a.id into v_existing
      from public.workspace_actions a
      join lateral (select v.status from public.workspace_action_versions v
                     where v.action_id = a.id order by v.version desc limit 1) l on true
     where a.workspace_id = s.workspace_id and a.evidence_finding_id = v_finding
       and l.status in ('open', 'in_progress')
     limit 1;
    if v_existing is not null then
      return query select 'ALREADY_TRACKED'::text, v_existing;
      return;
    end if;
  end if;

  select count(*) into v_live
    from public.workspace_actions a
    join lateral (select v.status from public.workspace_action_versions v
                   where v.action_id = a.id order by v.version desc limit 1) l on true
   where a.workspace_id = s.workspace_id and l.status in ('open', 'in_progress');
  if v_live >= 100 then
    return query select 'LIMIT_REACHED'::text, null::uuid;
    return;
  end if;

  insert into public.workspace_actions (workspace_id, evidence_kind, evidence_finding_id, evidence_note)
  values (s.workspace_id,
          case when v_finding is null then 'customer_note' else 'site_diagnostic_finding' end,
          v_finding, p_evidence_note)
  returning id into v_id;

  insert into public.workspace_action_versions (
    action_id, workspace_id, version, title, observation, why_it_matters, next_step, owner_name, status,
    decision_note, actor_type, actor_account_id, actor_membership_id)
  values (
    v_id, s.workspace_id, 1, p_title, p_observation, p_why_it_matters, p_next_step, p_owner_name, 'open',
    null, 'customer_account', p_account_id, s.membership_id);

  return query select 'CREATED'::text, v_id;
end;
$$;

-- P2-F5: saves a new version of an action. The evidence never changes.
create or replace function public.revise_workspace_action(
  p_token text,
  p_account_id uuid,
  p_action_id uuid,
  p_expected_version integer,
  p_title text,
  p_observation text,
  p_why_it_matters text,
  p_next_step text,
  p_owner_name text,
  p_status text,
  p_decision_note text
) returns table (status text, version integer)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  s record;
  v_prev public.workspace_action_versions%rowtype;
  v_live integer;
begin
  select * into s from public._p1_session(p_token, p_account_id);
  if s.status <> 'ACTIVE' then
    return query select 'NOT_SIGNED_IN'::text, null::integer;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('zypact.p1.workspace:' || s.workspace_id::text, 0));

  select v.* into v_prev from public.workspace_action_versions v
   where v.action_id = p_action_id and v.workspace_id = s.workspace_id
   order by v.version desc limit 1;
  if v_prev.id is null then
    return query select 'NOT_FOUND'::text, null::integer;
    return;
  end if;
  if p_expected_version is distinct from v_prev.version then
    return query select 'VERSION_CONFLICT'::text, v_prev.version;
    return;
  end if;
  if p_title is not distinct from v_prev.title and p_observation is not distinct from v_prev.observation
     and p_why_it_matters is not distinct from v_prev.why_it_matters and p_next_step is not distinct from v_prev.next_step
     and p_owner_name is not distinct from v_prev.owner_name and p_status is not distinct from v_prev.status
     and p_decision_note is not distinct from v_prev.decision_note then
    return query select 'UNCHANGED'::text, v_prev.version;
    return;
  end if;

  if p_status in ('open', 'in_progress') and v_prev.status not in ('open', 'in_progress') then
    select count(*) into v_live
      from public.workspace_actions a
      join lateral (select v.status from public.workspace_action_versions v
                     where v.action_id = a.id order by v.version desc limit 1) l on true
     where a.workspace_id = s.workspace_id and l.status in ('open', 'in_progress');
    if v_live >= 100 then
      return query select 'LIMIT_REACHED'::text, v_prev.version;
      return;
    end if;
  end if;

  insert into public.workspace_action_versions (
    action_id, workspace_id, version, title, observation, why_it_matters, next_step, owner_name, status,
    decision_note, actor_type, actor_account_id, actor_membership_id)
  values (
    p_action_id, s.workspace_id, v_prev.version + 1, p_title, p_observation, p_why_it_matters, p_next_step,
    p_owner_name, p_status, p_decision_note, 'customer_account', p_account_id, s.membership_id);

  return query select 'SAVED'::text, v_prev.version + 1;
end;
$$;

-- P2-F6: the workspace's actions, latest version of each, newest first, with
-- the stored evidence each one points to.
create or replace function public.list_workspace_actions(
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
begin
  select * into s from public._p1_session(p_token, p_account_id);
  if s.status <> 'ACTIVE' then
    return jsonb_build_object('status', 'NOT_SIGNED_IN');
  end if;
  return jsonb_build_object('status', 'OK', 'actions', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', a.id, 'version', l.version, 'title', l.title, 'observation', l.observation,
             'why_it_matters', l.why_it_matters, 'next_step', l.next_step, 'owner_name', l.owner_name,
             'status', l.status, 'decision_note', l.decision_note,
             'created_at', a.created_at, 'updated_at', l.created_at,
             'evidence', case when a.evidence_kind = 'customer_note'
               then jsonb_build_object('kind', 'customer_note', 'note', a.evidence_note)
               else (select jsonb_build_object(
                       'kind', 'site_diagnostic_finding', 'run_id', f.run_id, 'check_id', f.check_id,
                       'state', f.state, 'excerpt', f.excerpt, 'page_url', p.url,
                       'rule_version', f.rule_version, 'run_completed_at', r.completed_at)
                     from public.site_diagnostic_findings f
                     join public.site_diagnostic_runs r on r.id = f.run_id
                     left join public.site_diagnostic_pages p on p.id = f.page_id
                    where f.id = a.evidence_finding_id) end)
           order by a.created_at desc, a.id)
      from public.workspace_actions a
      join lateral (select v.* from public.workspace_action_versions v
                     where v.action_id = a.id order by v.version desc limit 1) l on true
     where a.workspace_id = s.workspace_id), '[]'::jsonb));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 7. Function privileges
-- ════════════════════════════════════════════════════════════════════════

revoke all on function public._p2_text_ok(text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public._p2_append_only() from public, anon, authenticated, service_role;
revoke all on function public._p2_action_evidence_check() from public, anon, authenticated, service_role;

revoke all on function public.add_question_draft(text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.revise_question_draft(text, uuid, uuid, integer, text, text, text) from public, anon, authenticated;
revoke all on function public.list_question_drafts(text, uuid) from public, anon, authenticated;
revoke all on function public.create_workspace_action(text, uuid, uuid, text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.revise_workspace_action(text, uuid, uuid, integer, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.list_workspace_actions(text, uuid) from public, anon, authenticated;

grant execute on function public.add_question_draft(text, uuid, text, text, text) to service_role;
grant execute on function public.revise_question_draft(text, uuid, uuid, integer, text, text, text) to service_role;
grant execute on function public.list_question_drafts(text, uuid) to service_role;
grant execute on function public.create_workspace_action(text, uuid, uuid, text, text, text, text, text, text, text, text) to service_role;
grant execute on function public.revise_workspace_action(text, uuid, uuid, integer, text, text, text, text, text, text, text) to service_role;
grant execute on function public.list_workspace_actions(text, uuid) to service_role;
