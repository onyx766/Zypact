-- S1 — customer account sessions and account rate limits (D-045).
--
-- Builds on Q2′-1 (20261102132000): workspaces, workspace_members and the
-- purpose-labelled token hash. Applies after Q2′-2 (20261103173000).
--
-- Account sessions are the second session type of SELF_SERVICE_PRODUCT §5.2.
-- They are separate from Q2′-1's review-invitation sessions: another table,
-- another token purpose ('zypact.account_session.v1'), and no function here
-- reads or accepts an invitation token.
--
-- Closed, as Q2′-1: RLS on with no policy, no table privilege for any API
-- role, rows reached only through SECURITY DEFINER functions with a fixed
-- search_path and a 5-second lock_timeout. service_role may execute the
-- public functions; no role may execute the `_s1_` helpers.
--
-- Identity is not a grant (D-040): a session can be opened only for an
-- account that holds exactly one active workspace membership, and every
-- check re-reads that membership.

-- ════════════════════════════════════════════════════════════════════════
-- 1. account_sessions
-- ════════════════════════════════════════════════════════════════════════

create table public.account_sessions (
  id                    uuid primary key default gen_random_uuid(),
  token_hash            text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  account_id            uuid not null,
  workspace_id          uuid not null,
  membership_id         uuid not null,
  created_at            timestamptz not null,
  last_seen_at          timestamptz not null,
  absolute_expires_at   timestamptz not null,
  idle_timeout_seconds  integer not null check (idle_timeout_seconds between 300 and 86400),
  step_up_at            timestamptz,
  revoked_at            timestamptz,
  revoked_reason        text,
  constraint account_sessions_membership_fk foreign key (membership_id, account_id, workspace_id)
    references public.workspace_members (id, account_id, workspace_id),
  constraint account_sessions_lifetime check (
    absolute_expires_at > created_at and absolute_expires_at <= created_at + interval '7 days'),
  constraint account_sessions_idle_within_lifetime check (
    created_at + make_interval(secs => idle_timeout_seconds) <= absolute_expires_at),
  constraint account_sessions_seen check (last_seen_at >= created_at),
  constraint account_sessions_step_up check (step_up_at is null or step_up_at >= created_at),
  constraint account_sessions_revocation_shape check ((revoked_at is null) = (revoked_reason is null)),
  constraint account_sessions_revoked_after_created check (revoked_at is null or revoked_at >= created_at),
  constraint account_sessions_revoked_reason check (revoked_reason is null or revoked_reason in (
    'sign_out', 'password_change', 'email_change', 'admin_revoke', 'membership_removed'))
);

create index account_sessions_active_by_account
  on public.account_sessions (account_id) where revoked_at is null;

-- Every column is immutable except: last_seen_at and step_up_at, which may
-- only move forward while the session is not revoked; and the revocation
-- pair, which may be set once, together, from null. Delete is refused.
create or replace function public._s1_account_sessions_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 's1_append_only: account_sessions';
  end if;
  if old.revoked_at is not null then
    raise exception using errcode = '55000', message = 's1_session_already_revoked';
  end if;
  if (to_jsonb(new) - array['last_seen_at', 'step_up_at', 'revoked_at', 'revoked_reason'])
     is distinct from
     (to_jsonb(old) - array['last_seen_at', 'step_up_at', 'revoked_at', 'revoked_reason']) then
    raise exception using errcode = '55000', message = 's1_session_immutable';
  end if;
  if new.last_seen_at < old.last_seen_at then
    raise exception using errcode = '55000', message = 's1_session_last_seen_backwards';
  end if;
  if old.step_up_at is not null and (new.step_up_at is null or new.step_up_at < old.step_up_at) then
    raise exception using errcode = '55000', message = 's1_session_step_up_backwards';
  end if;
  return new;
end;
$$;

create trigger account_sessions_guard
  before update or delete on public.account_sessions
  for each row execute function public._s1_account_sessions_guard();

create or replace function public._s1_no_truncate()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception using errcode = '55000', message = 's1_no_truncate: ' || tg_table_name;
end;
$$;

create trigger account_sessions_no_truncate
  before truncate on public.account_sessions
  for each statement execute function public._s1_no_truncate();

-- ════════════════════════════════════════════════════════════════════════
-- 2. account_rate_limit_events
-- ════════════════════════════════════════════════════════════════════════
-- Keyed, short-lived and unlinked to any account record. bucket_key is a
-- keyed HMAC computed by the application under the purpose label
-- 'zypact.account.rate_limit.v1'; neither the address nor the email is
-- stored. Rows may be deleted only once expired (the purge below).

create table public.account_rate_limit_events (
  id           bigint generated always as identity primary key,
  purpose      text not null check (purpose in (
                 'sign_up', 'sign_in', 'resend_verification', 'password_reset', 'step_up')),
  bucket_kind  text not null check (bucket_kind in ('ip', 'email', 'account')),
  bucket_key   text not null check (bucket_key ~ '^[0-9a-f]{64}$'),
  key_id       text not null check (key_id ~ '^[a-z0-9_.-]{1,32}$'),
  occurred_at  timestamptz not null,
  expires_at   timestamptz not null,
  constraint account_rate_limit_events_expiry check (
    expires_at > occurred_at and expires_at <= occurred_at + interval '48 hours')
);

create index account_rate_limit_events_bucket
  on public.account_rate_limit_events (purpose, bucket_kind, bucket_key, occurred_at);

create or replace function public._s1_rate_limit_events_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception using errcode = '55000', message = 's1_append_only: account_rate_limit_events';
  end if;
  if old.expires_at > clock_timestamp() then
    raise exception using errcode = '55000', message = 's1_rate_limit_event_not_expired';
  end if;
  return old;
end;
$$;

create trigger account_rate_limit_events_guard
  before update or delete on public.account_rate_limit_events
  for each row execute function public._s1_rate_limit_events_guard();

create trigger account_rate_limit_events_no_truncate
  before truncate on public.account_rate_limit_events
  for each statement execute function public._s1_no_truncate();

-- ════════════════════════════════════════════════════════════════════════
-- 3. Closed tables
-- ════════════════════════════════════════════════════════════════════════

alter table public.account_sessions enable row level security;
alter table public.account_rate_limit_events enable row level security;

revoke all on table public.account_sessions, public.account_rate_limit_events
  from public, anon, authenticated, service_role;
-- The identity column's sequence is a separate object. Supabase's default
-- privileges grant it to the API roles; close it as Q2′-2 closes its own.
revoke all on sequence public.account_rate_limit_events_id_seq from public, anon, authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- 4. Session functions (service_role only)
-- ════════════════════════════════════════════════════════════════════════
-- Lock order, wherever more than one row is locked: the session FOR UPDATE,
-- then its membership FOR SHARE. Every expiry is decided with one
-- clock_timestamp() taken after the locks.

create or replace function public._s1_session_token_hash(p_token text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  if p_token is null or length(p_token) < 32 or length(p_token) > 256 then
    raise exception using errcode = '22023', message = 's1_invalid_token';
  end if;
  return public._q2p_token_hash('zypact.account_session.v1', p_token);
end;
$$;

-- S1-F1: opens a session for an account with exactly one active membership.
create or replace function public.open_account_session(
  p_account_id uuid,
  p_token text,
  p_absolute_seconds integer,
  p_idle_seconds integer
) returns table (status text, session_id uuid, workspace_id uuid, membership_id uuid)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_hash text := public._s1_session_token_hash(p_token);
  v_count integer;
  v_member public.workspace_members%rowtype;
  v_now timestamptz;
  v_id uuid;
begin
  if p_account_id is null
     or p_absolute_seconds is null or p_absolute_seconds < 300 or p_absolute_seconds > 604800
     or p_idle_seconds is null or p_idle_seconds < 300 or p_idle_seconds > 86400
     or p_idle_seconds > p_absolute_seconds then
    raise exception using errcode = '22023', message = 's1_invalid_session_args';
  end if;

  -- Lock first, then count: a removal (F8) waits for this transaction, and a
  -- membership added concurrently can only raise the count (fail closed).
  perform 1 from public.workspace_members m
   where m.account_id = p_account_id and m.removed_at is null
   for share;
  select count(*) into v_count from public.workspace_members m
   where m.account_id = p_account_id and m.removed_at is null;
  if v_count = 0 then
    return query select 'NO_MEMBERSHIP'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;
  if v_count > 1 then
    return query select 'AMBIGUOUS_MEMBERSHIP'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  select m.* into v_member from public.workspace_members m
   where m.account_id = p_account_id and m.removed_at is null
   for share;
  if not found then
    return query select 'NO_MEMBERSHIP'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  v_now := clock_timestamp();
  insert into public.account_sessions (token_hash, account_id, workspace_id, membership_id,
    created_at, last_seen_at, absolute_expires_at, idle_timeout_seconds)
  values (v_hash, p_account_id, v_member.workspace_id, v_member.id,
    v_now, v_now, v_now + make_interval(secs => p_absolute_seconds), p_idle_seconds)
  returning id into v_id;

  return query select 'OPENED'::text, v_id, v_member.workspace_id, v_member.id;
end;
$$;

-- S1-F2: decides whether a session is usable now, and records the activity.
-- NOT_FOUND also covers a token presented with another account's identity.
create or replace function public.check_account_session(
  p_token text,
  p_account_id uuid
) returns table (status text, session_id uuid, workspace_id uuid, membership_id uuid,
                 step_up_at timestamptz, absolute_expires_at timestamptz)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_hash text := public._s1_session_token_hash(p_token);
  v_s public.account_sessions%rowtype;
  v_removed timestamptz;
  v_now timestamptz;
begin
  if p_account_id is null then
    raise exception using errcode = '22023', message = 's1_invalid_session_args';
  end if;

  select s.* into v_s from public.account_sessions s where s.token_hash = v_hash for update;
  if not found or v_s.account_id <> p_account_id then
    return query select 'NOT_FOUND'::text, null::uuid, null::uuid, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;
  if v_s.revoked_at is not null then
    return query select 'REVOKED'::text, v_s.id, null::uuid, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  select m.removed_at into v_removed from public.workspace_members m
   where m.id = v_s.membership_id
   for share;

  v_now := clock_timestamp();

  if v_removed is not null then
    update public.account_sessions s
       set revoked_at = v_now, revoked_reason = 'membership_removed'
     where s.id = v_s.id;
    return query select 'REVOKED'::text, v_s.id, null::uuid, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  if v_now >= v_s.absolute_expires_at
     or v_now >= v_s.last_seen_at + make_interval(secs => v_s.idle_timeout_seconds) then
    return query select 'EXPIRED'::text, v_s.id, null::uuid, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  update public.account_sessions s set last_seen_at = greatest(s.last_seen_at, v_now) where s.id = v_s.id;
  return query select 'ACTIVE'::text, v_s.id, v_s.workspace_id, v_s.membership_id,
    v_s.step_up_at, v_s.absolute_expires_at;
end;
$$;

-- S1-F3: records a completed step-up (re-authentication) on an active
-- session. The caller verifies the credential; this only stamps the instant.
create or replace function public.record_account_step_up(
  p_token text,
  p_account_id uuid
) returns table (status text, step_up_at timestamptz)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_status text;
  v_session uuid;
  v_now timestamptz;
begin
  select c.status, c.session_id into v_status, v_session
    from public.check_account_session(p_token, p_account_id) c;
  if v_status <> 'ACTIVE' then
    return query select v_status, null::timestamptz;
    return;
  end if;
  v_now := clock_timestamp();
  update public.account_sessions s
     set step_up_at = greatest(coalesce(s.step_up_at, v_now), v_now),
         last_seen_at = greatest(s.last_seen_at, v_now)
   where s.id = v_session
  returning s.step_up_at into v_now;
  return query select 'STEPPED_UP'::text, v_now;
end;
$$;

-- S1-F4: revokes one session (sign-out).
create or replace function public.revoke_account_session(
  p_token text,
  p_reason text
) returns table (status text)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_hash text := public._s1_session_token_hash(p_token);
  v_s public.account_sessions%rowtype;
begin
  if p_reason is null or p_reason not in ('sign_out', 'admin_revoke') then
    raise exception using errcode = '22023', message = 's1_invalid_revoke_reason';
  end if;
  select s.* into v_s from public.account_sessions s where s.token_hash = v_hash for update;
  if not found then
    return query select 'NOT_FOUND'::text;
    return;
  end if;
  if v_s.revoked_at is not null then
    return query select 'ALREADY_REVOKED'::text;
    return;
  end if;
  update public.account_sessions s
     set revoked_at = clock_timestamp(), revoked_reason = p_reason
   where s.id = v_s.id;
  return query select 'REVOKED'::text;
end;
$$;

-- S1-F5: revokes every active session of an account (password or email
-- change, admin revoke). Locks in id order so two callers cannot deadlock.
create or replace function public.revoke_account_sessions_for_account(
  p_account_id uuid,
  p_reason text
) returns table (status text, revoked_count integer)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_ids uuid[];
  v_now timestamptz;
begin
  if p_account_id is null
     or p_reason is null or p_reason not in ('password_change', 'email_change', 'admin_revoke') then
    raise exception using errcode = '22023', message = 's1_invalid_revoke_reason';
  end if;
  select coalesce(array_agg(s.id order by s.id), '{}') into v_ids from (
    select s.id from public.account_sessions s
     where s.account_id = p_account_id and s.revoked_at is null
     order by s.id
     for update
  ) s;
  v_now := clock_timestamp();
  update public.account_sessions s
     set revoked_at = v_now, revoked_reason = p_reason
   where s.id = any(v_ids);
  return query select 'REVOKED'::text, coalesce(array_length(v_ids, 1), 0);
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 5. Rate limits (service_role only) and the purge (no role)
-- ════════════════════════════════════════════════════════════════════════

-- S1-F6: takes one unit from a bucket if fewer than p_max were taken in the
-- last p_window_seconds. Every caller of the same bucket is serialised by an
-- advisory lock, so two concurrent calls cannot both take the last unit.
create or replace function public.take_account_rate_limit(
  p_purpose text,
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
    raise exception using errcode = '22023', message = 's1_invalid_rate_limit_args';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'zypact.s1.rate_limit:' || coalesce(p_purpose, '') || ':' || coalesce(p_bucket_kind, '') || ':' || coalesce(p_bucket_key, ''), 0));

  v_now := clock_timestamp();
  select count(*) into v_recent from public.account_rate_limit_events e
   where e.purpose = p_purpose and e.bucket_kind = p_bucket_kind and e.bucket_key = p_bucket_key
     and e.occurred_at > v_now - make_interval(secs => p_window_seconds);

  if v_recent >= p_max then
    return query select false, v_recent;
    return;
  end if;

  insert into public.account_rate_limit_events (purpose, bucket_kind, bucket_key, key_id, occurred_at, expires_at)
  values (p_purpose, p_bucket_kind, p_bucket_key, p_key_id, v_now, v_now + make_interval(secs => p_window_seconds));

  return query select true, v_recent + 1;
end;
$$;

-- Deletes expired rate-limit rows. No API role may execute it; scheduling it
-- is a gate before customer use, as for Q2′-2's purge (Q2-R4).
create or replace function public._s1_purge_account_rate_limit_events()
returns integer
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_deleted integer;
begin
  delete from public.account_rate_limit_events e where e.expires_at <= clock_timestamp();
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 6. Function privileges
-- ════════════════════════════════════════════════════════════════════════

revoke all on function public._s1_account_sessions_guard() from public, anon, authenticated, service_role;
revoke all on function public._s1_no_truncate() from public, anon, authenticated, service_role;
revoke all on function public._s1_rate_limit_events_guard() from public, anon, authenticated, service_role;
revoke all on function public._s1_session_token_hash(text) from public, anon, authenticated, service_role;
revoke all on function public._s1_purge_account_rate_limit_events() from public, anon, authenticated, service_role;

revoke all on function public.open_account_session(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.check_account_session(text, uuid) from public, anon, authenticated;
revoke all on function public.record_account_step_up(text, uuid) from public, anon, authenticated;
revoke all on function public.revoke_account_session(text, text) from public, anon, authenticated;
revoke all on function public.revoke_account_sessions_for_account(uuid, text) from public, anon, authenticated;
revoke all on function public.take_account_rate_limit(text, text, text, text, integer, integer) from public, anon, authenticated;

grant execute on function public.open_account_session(uuid, text, integer, integer) to service_role;
grant execute on function public.check_account_session(text, uuid) to service_role;
grant execute on function public.record_account_step_up(text, uuid) to service_role;
grant execute on function public.revoke_account_session(text, text) to service_role;
grant execute on function public.revoke_account_sessions_for_account(uuid, text) to service_role;
grant execute on function public.take_account_rate_limit(text, text, text, text, integer, integer) to service_role;
