-- P1 — customer workspace setup (D-046): the workspace website, customer-run
-- site diagnostics written into Q2′-2's tables, and a versioned Brand Profile.
--
-- Builds on Q2′-1 (workspaces, members, projects mapping), Q2′-2 (domains,
-- site diagnostic runs, pages, findings, diagnostic rate limits) and S1
-- (account sessions). Applies after S1 (20261109120000).
--
-- Every customer function takes the account session token and the account id
-- the server read from a verified Auth user, and re-checks that session in the
-- database (S1's check_account_session) before acting. The workspace always
-- comes from the session, never from an argument, so no call can reach
-- another workspace. Each returns NOT_SIGNED_IN instead of acting otherwise.
--
-- Closed, as Q2′: RLS on with no policy, no table privilege for any API role,
-- public functions executable by service_role only, `_p1_` helpers by no role.
-- No paid call, no model call; nothing here starts a measurement.

-- ════════════════════════════════════════════════════════════════════════
-- 1. Brand Profile (versioned, append-only)
-- ════════════════════════════════════════════════════════════════════════

-- Competitor names: 1–80 characters after trimming, no blank, no duplicate
-- (case-insensitive).
create or replace function public._p1_names_ok(p_names text[])
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(bool_and(btrim(n) <> '' and length(n) <= 80 and n = btrim(n)), true)
         and count(*) = count(distinct lower(n))
    from unnest(p_names) n;
$$;

create table public.workspace_brand_profiles (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces(id),
  version              integer not null check (version >= 1),
  company_name         text not null check (btrim(company_name) <> '' and length(company_name) <= 120),
  description          text check (description is null or (btrim(description) <> '' and length(description) <= 1000)),
  category             text check (category is null or (btrim(category) <> '' and length(category) <= 120)),
  audience             text check (audience is null or (btrim(audience) <> '' and length(audience) <= 300)),
  competitors          text[] not null default '{}'
                         check (cardinality(competitors) <= 10 and public._p1_names_ok(competitors)),
  objective            text check (objective is null or objective in (
                         'describe_product', 'compare_competitors', 'investigate_sources', 'review_after_change')),
  based_on_run_id      uuid references public.site_diagnostic_runs(id),
  actor_type           text not null check (actor_type = 'customer_account'),
  actor_account_id     uuid not null,
  actor_membership_id  uuid not null,
  created_at           timestamptz not null default clock_timestamp(),
  constraint workspace_brand_profiles_version_key unique (workspace_id, version),
  constraint workspace_brand_profiles_actor_membership_fk foreign key (actor_membership_id, actor_account_id, workspace_id)
    references public.workspace_members(id, account_id, workspace_id)
);

create or replace function public._p1_append_only()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception using errcode = '55000', message = 'p1_append_only: ' || tg_table_name;
end;
$$;

create trigger workspace_brand_profiles_append_only
  before update or delete on public.workspace_brand_profiles
  for each row execute function public._p1_append_only();
create trigger workspace_brand_profiles_no_truncate
  before truncate on public.workspace_brand_profiles
  for each statement execute function public._p1_append_only();

alter table public.workspace_brand_profiles enable row level security;
revoke all on table public.workspace_brand_profiles from public, anon, authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- 2. Helpers (no role may execute them)
-- ════════════════════════════════════════════════════════════════════════

-- The session's workspace and membership, or a non-ACTIVE status. Never
-- raises for an inactive session, so S1's own side effects (activity,
-- revocation on removal) commit with the caller's transaction.
create or replace function public._p1_session(p_token text, p_account_id uuid,
  out status text, out workspace_id uuid, out membership_id uuid)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v record;
begin
  select c.status, c.workspace_id, c.membership_id into v
    from public.check_account_session(p_token, p_account_id) c;
  status := coalesce(v.status, 'NOT_FOUND');
  if status = 'ACTIVE' then
    workspace_id := v.workspace_id;
    membership_id := v.membership_id;
  end if;
end;
$$;

-- The workspace's website: its one domain (Phase 1 allows one) and the
-- project P1 created for it.
create or replace function public._p1_site(p_workspace_id uuid,
  out domain_id uuid, out normalized_domain text, out project_id uuid)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  select d.id, d.normalized_domain into domain_id, normalized_domain
    from public.workspace_domains d
   where d.workspace_id = p_workspace_id
   order by d.created_at, d.id
   limit 1;
  select wp.project_id into project_id
    from public.workspace_projects wp
   where wp.workspace_id = p_workspace_id and wp.rule_id = 'p1.workspace_setup'
   order by wp.created_at
   limit 1;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 3. Website
-- ════════════════════════════════════════════════════════════════════════

-- P1-F1: sets the workspace's website once. The same domain again is
-- ALREADY_SET; a different one is DIFFERENT_WEBSITE_SET (changing the
-- website is a support action in Phase 1, so the diagnostic cannot be used
-- to crawl arbitrary sites).
create or replace function public.set_workspace_website(
  p_token text,
  p_account_id uuid,
  p_domain text,
  p_company_name text
) returns table (status text, domain_id uuid, project_id uuid)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  s record;
  site record;
  v_project uuid;
  v_domain uuid;
begin
  select * into s from public._p1_session(p_token, p_account_id);
  if s.status <> 'ACTIVE' then
    return query select 'NOT_SIGNED_IN'::text, null::uuid, null::uuid;
    return;
  end if;
  if p_domain is null or not public._q2p2_domain_is_normalised(p_domain)
     or p_company_name is null or btrim(p_company_name) = '' or length(p_company_name) > 120 then
    raise exception using errcode = '22023', message = 'p1_invalid_website_args';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('zypact.p1.workspace:' || s.workspace_id::text, 0));

  select * into site from public._p1_site(s.workspace_id);
  if site.domain_id is not null then
    if site.normalized_domain = p_domain then
      return query select 'ALREADY_SET'::text, site.domain_id, site.project_id;
    else
      return query select 'DIFFERENT_WEBSITE_SET'::text, site.domain_id, site.project_id;
    end if;
    return;
  end if;

  insert into public.projects (domain, company_name) values (p_domain, btrim(p_company_name))
  returning id into v_project;

  insert into public.workspace_projects (project_id, workspace_id, actor_type, rule_id, rule_version)
  values (v_project, s.workspace_id, 'system', 'p1.workspace_setup', '1');

  insert into public.workspace_domains (workspace_id, normalized_domain, actor_type, actor_account_id, actor_membership_id)
  values (s.workspace_id, p_domain, 'customer_account', p_account_id, s.membership_id)
  returning id into v_domain;

  return query select 'SET'::text, v_domain, v_project;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 4. Site diagnostics
-- ════════════════════════════════════════════════════════════════════════

-- P1-F2: takes one unit from a diagnostic rate-limit bucket (Q2′-2's keyed,
-- short-lived table). Serialised per bucket, as S1's account limits.
create or replace function public.take_diagnostic_rate_limit(
  p_bucket_kind text,
  p_bucket_key text,
  p_key_id text,
  p_window_seconds integer,
  p_max integer
) returns table (allowed boolean, recent integer)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_now timestamptz;
  v_recent integer;
begin
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400
     or p_max is null or p_max < 1 or p_max > 1000 then
    raise exception using errcode = '22023', message = 'p1_invalid_rate_limit_args';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'zypact.p1.diag_rate_limit:' || coalesce(p_bucket_kind, '') || ':' || coalesce(p_bucket_key, ''), 0));
  v_now := clock_timestamp();
  select count(*) into v_recent from public.diagnostic_rate_limit_events e
   where e.bucket_kind = p_bucket_kind and e.bucket_key = p_bucket_key
     and e.occurred_at > v_now - make_interval(secs => p_window_seconds);
  if v_recent >= p_max then
    return query select false, v_recent;
    return;
  end if;
  insert into public.diagnostic_rate_limit_events (bucket_kind, bucket_key, key_purpose, key_id, expires_at)
  values (p_bucket_kind, p_bucket_key, 'zypact.diag.rate_limit.v1', p_key_id, v_now + make_interval(secs => p_window_seconds));
  return query select true, v_recent + 1;
end;
$$;

-- P1-F3: records one completed W1 run for the workspace's own website, with
-- its pages and findings, atomically. The run is opened, filled and completed
-- in this one transaction, so Q2′-2's guards see it open while children are
-- inserted and frozen afterwards. A run supersedes the previous one.
create or replace function public.record_site_diagnostic(
  p_token text,
  p_account_id uuid,
  p_run jsonb,
  p_pages jsonb,
  p_findings jsonb
) returns table (status text, run_id uuid)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  s record;
  site record;
  v_prev uuid;
  v_run uuid;
begin
  select * into s from public._p1_session(p_token, p_account_id);
  if s.status <> 'ACTIVE' then
    return query select 'NOT_SIGNED_IN'::text, null::uuid;
    return;
  end if;
  if p_run is null or jsonb_typeof(p_run) <> 'object'
     or p_pages is null or jsonb_typeof(p_pages) <> 'array' or jsonb_array_length(p_pages) > 10
     or p_findings is null or jsonb_typeof(p_findings) <> 'array' or jsonb_array_length(p_findings) > 300 then
    raise exception using errcode = '22023', message = 'p1_invalid_diagnostic_args';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('zypact.p1.workspace:' || s.workspace_id::text, 0));

  select * into site from public._p1_site(s.workspace_id);
  if site.domain_id is null or site.project_id is null then
    return query select 'NO_WEBSITE'::text, null::uuid;
    return;
  end if;
  if p_run ->> 'normalized_domain' is distinct from site.normalized_domain then
    return query select 'DOMAIN_MISMATCH'::text, null::uuid;
    return;
  end if;

  select r.id into v_prev from public.site_diagnostic_runs r
   where r.workspace_id = s.workspace_id and r.project_id = site.project_id and r.completed_at is not null
   order by r.started_at desc, r.id desc
   limit 1;

  insert into public.site_diagnostic_runs (
    workspace_id, project_id, normalized_domain, start_url, rule_set_version, crawler_version, user_agent,
    page_cap, supersedes_run_id, domain_id, cache_scope_workspace_id,
    actor_type, actor_account_id, actor_membership_id)
  values (
    s.workspace_id, site.project_id, site.normalized_domain, p_run ->> 'start_url', p_run ->> 'rule_set_version',
    p_run ->> 'crawler_version', p_run ->> 'user_agent', (p_run ->> 'page_cap')::smallint, v_prev, site.domain_id,
    s.workspace_id, 'customer_account', p_account_id, s.membership_id)
  returning id into v_run;

  insert into public.site_diagnostic_pages (
    run_id, workspace_id, project_id, page_index, url, query_present, fetched_at, http_status, content_type,
    bytes, body_sha256, robots_allowed, fetch_error)
  select v_run, s.workspace_id, site.project_id, x.page_index, x.url, x.query_present, x.fetched_at, x.http_status,
         x.content_type, x.bytes, x.body_sha256, x.robots_allowed, x.fetch_error
    from jsonb_to_recordset(p_pages) as x(page_index smallint, url text, query_present boolean, fetched_at timestamptz,
      http_status smallint, content_type text, bytes integer, body_sha256 text, robots_allowed boolean, fetch_error text);

  insert into public.site_diagnostic_findings (
    run_id, workspace_id, project_id, page_id, check_id, state, unknown_reason, excerpt, excerpt_start, excerpt_end,
    excerpt_body_sha256, pii_screen_version, detail, rule_version)
  select v_run, s.workspace_id, site.project_id, p.id, x.check_id, x.state, x.unknown_reason, x.excerpt,
         x.excerpt_start, x.excerpt_end, x.excerpt_body_sha256, x.pii_screen_version, null, x.rule_version
    from jsonb_to_recordset(p_findings) as x(page_index smallint, check_id text, state text, unknown_reason text,
      excerpt text, excerpt_start integer, excerpt_end integer, excerpt_body_sha256 text, pii_screen_version text,
      rule_version text)
    left join public.site_diagnostic_pages p on p.run_id = v_run and p.page_index = x.page_index;

  update public.site_diagnostic_runs r set outcome = p_run ->> 'outcome' where r.id = v_run;

  return query select 'RECORDED'::text, v_run;
end;
$$;

-- P1-F4: one run of the workspace (the latest completed one by default),
-- with its pages and findings, and the list of earlier runs.
create or replace function public.get_site_diagnostic(
  p_token text,
  p_account_id uuid,
  p_run_id uuid default null
) returns jsonb
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  s record;
  v_run public.site_diagnostic_runs%rowtype;
begin
  select * into s from public._p1_session(p_token, p_account_id);
  if s.status <> 'ACTIVE' then
    return jsonb_build_object('status', 'NOT_SIGNED_IN');
  end if;

  select r.* into v_run from public.site_diagnostic_runs r
   where r.workspace_id = s.workspace_id and r.completed_at is not null
     and (p_run_id is null or r.id = p_run_id)
   order by r.started_at desc, r.id desc
   limit 1;
  if not found then
    return jsonb_build_object('status', 'NONE');
  end if;

  return jsonb_build_object(
    'status', 'OK',
    'run', jsonb_build_object(
      'id', v_run.id, 'normalized_domain', v_run.normalized_domain, 'start_url', v_run.start_url,
      'rule_set_version', v_run.rule_set_version, 'crawler_version', v_run.crawler_version,
      'page_cap', v_run.page_cap, 'started_at', v_run.started_at, 'completed_at', v_run.completed_at,
      'outcome', v_run.outcome, 'domain_verified', v_run.domain_verification_event_id is not null),
    'pages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'page_index', p.page_index, 'url', p.url, 'http_status', p.http_status, 'content_type', p.content_type,
        'bytes', p.bytes, 'robots_allowed', p.robots_allowed, 'fetch_error', p.fetch_error) order by p.page_index)
        from public.site_diagnostic_pages p where p.run_id = v_run.id), '[]'::jsonb),
    'findings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'check_id', f.check_id, 'state', f.state, 'unknown_reason', f.unknown_reason, 'excerpt', f.excerpt,
        'page_url', p.url, 'rule_version', f.rule_version) order by f.check_id, p.page_index nulls first)
        from public.site_diagnostic_findings f
        left join public.site_diagnostic_pages p on p.id = f.page_id
       where f.run_id = v_run.id), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('id', h.id, 'completed_at', h.completed_at, 'outcome', h.outcome)
                       order by h.started_at desc)
        from (select r.id, r.started_at, r.completed_at, r.outcome from public.site_diagnostic_runs r
               where r.workspace_id = s.workspace_id and r.completed_at is not null
               order by r.started_at desc limit 10) h), '[]'::jsonb));
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 5. Brand Profile
-- ════════════════════════════════════════════════════════════════════════

-- P1-F5: saves a new profile version. p_expected_version is the version the
-- customer edited (0 for the first); anything else is VERSION_CONFLICT, so two
-- tabs cannot silently overwrite each other. Earlier versions are kept.
create or replace function public.save_brand_profile(
  p_token text,
  p_account_id uuid,
  p_expected_version integer,
  p_company_name text,
  p_description text,
  p_category text,
  p_audience text,
  p_competitors text[],
  p_objective text,
  p_based_on_run_id uuid
) returns table (status text, version integer)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  s record;
  site record;
  v_current integer;
begin
  select * into s from public._p1_session(p_token, p_account_id);
  if s.status <> 'ACTIVE' then
    return query select 'NOT_SIGNED_IN'::text, null::integer;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('zypact.p1.workspace:' || s.workspace_id::text, 0));

  select * into site from public._p1_site(s.workspace_id);
  if site.domain_id is null then
    return query select 'NO_WEBSITE'::text, null::integer;
    return;
  end if;
  if p_based_on_run_id is not null and not exists (
       select 1 from public.site_diagnostic_runs r
        where r.id = p_based_on_run_id and r.workspace_id = s.workspace_id) then
    raise exception using errcode = '22023', message = 'p1_run_not_in_workspace';
  end if;

  select coalesce(max(b.version), 0) into v_current
    from public.workspace_brand_profiles b where b.workspace_id = s.workspace_id;
  if p_expected_version is distinct from v_current then
    return query select 'VERSION_CONFLICT'::text, v_current;
    return;
  end if;

  insert into public.workspace_brand_profiles (
    workspace_id, version, company_name, description, category, audience, competitors, objective,
    based_on_run_id, actor_type, actor_account_id, actor_membership_id)
  values (
    s.workspace_id, v_current + 1, p_company_name, p_description, p_category, p_audience,
    coalesce(p_competitors, '{}'), p_objective, p_based_on_run_id, 'customer_account', p_account_id, s.membership_id);

  return query select 'SAVED'::text, v_current + 1;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 6. Workspace state (Overview)
-- ════════════════════════════════════════════════════════════════════════

-- P1-F6: what the workspace has so far, for the Overview and setup flow.
create or replace function public.get_workspace_state(
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
  site record;
  v_profile public.workspace_brand_profiles%rowtype;
  v_run public.site_diagnostic_runs%rowtype;
begin
  select * into s from public._p1_session(p_token, p_account_id);
  if s.status <> 'ACTIVE' then
    return jsonb_build_object('status', 'NOT_SIGNED_IN');
  end if;
  select * into site from public._p1_site(s.workspace_id);

  select b.* into v_profile from public.workspace_brand_profiles b
   where b.workspace_id = s.workspace_id order by b.version desc limit 1;

  select r.* into v_run from public.site_diagnostic_runs r
   where r.workspace_id = s.workspace_id and r.completed_at is not null
   order by r.started_at desc, r.id desc limit 1;

  return jsonb_build_object(
    'status', 'OK',
    'workspace', (select jsonb_build_object('id', w.id, 'name', w.name) from public.workspaces w where w.id = s.workspace_id),
    'website', case when site.domain_id is null then null else jsonb_build_object(
      'domain', site.normalized_domain,
      'verification', coalesce((select st.status from public.workspace_domain_state st where st.domain_id = site.domain_id), 'none')) end,
    'profile', case when v_profile.id is null then null else jsonb_build_object(
      'version', v_profile.version, 'company_name', v_profile.company_name, 'description', v_profile.description,
      'category', v_profile.category, 'audience', v_profile.audience, 'competitors', to_jsonb(v_profile.competitors),
      'objective', v_profile.objective, 'based_on_run_id', v_profile.based_on_run_id, 'saved_at', v_profile.created_at) end,
    'latest_run', case when v_run.id is null then null else jsonb_build_object(
      'id', v_run.id, 'completed_at', v_run.completed_at, 'outcome', v_run.outcome,
      'pages', (select count(*) from public.site_diagnostic_pages p where p.run_id = v_run.id),
      'counts', (select jsonb_build_object(
          'pass', count(*) filter (where f.state = 'pass'), 'issue', count(*) filter (where f.state = 'issue'),
          'info', count(*) filter (where f.state = 'info'), 'unknown', count(*) filter (where f.state = 'unknown'))
        from public.site_diagnostic_findings f where f.run_id = v_run.id)) end);
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 7. Function privileges
-- ════════════════════════════════════════════════════════════════════════

revoke all on function public._p1_names_ok(text[]) from public, anon, authenticated, service_role;
revoke all on function public._p1_append_only() from public, anon, authenticated, service_role;
revoke all on function public._p1_session(text, uuid) from public, anon, authenticated, service_role;
revoke all on function public._p1_site(uuid) from public, anon, authenticated, service_role;

revoke all on function public.set_workspace_website(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.take_diagnostic_rate_limit(text, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.record_site_diagnostic(text, uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.get_site_diagnostic(text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.save_brand_profile(text, uuid, integer, text, text, text, text, text[], text, uuid) from public, anon, authenticated;
revoke all on function public.get_workspace_state(text, uuid) from public, anon, authenticated;

grant execute on function public.set_workspace_website(text, uuid, text, text) to service_role;
grant execute on function public.take_diagnostic_rate_limit(text, text, text, integer, integer) to service_role;
grant execute on function public.record_site_diagnostic(text, uuid, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.get_site_diagnostic(text, uuid, uuid) to service_role;
grant execute on function public.save_brand_profile(text, uuid, integer, text, text, text, text, text[], text, uuid) to service_role;
grant execute on function public.get_workspace_state(text, uuid) to service_role;
