-- Q2′-2 — Workspace domains and site-diagnostic records (D-040 §6–§7; D-043).
--
-- Every object here is NEW. This migration redefines no existing function,
-- alters no existing table, and touches no paid-execution object:
--   * no write to protocols, protocol_execution_jobs, protocol_external_calls,
--     spend_controls, buyer_question_launch_selections, snapshot_requests or
--     any Q2′-1 table (they are only referenced by foreign keys);
--   * no fetcher, check catalogue, customer RPC or UI: the diagnostic (W1)
--     and domain verification (V1d) write these tables later, through their
--     own SECURITY DEFINER functions, under their own authorisation;
--   * no model call and no IP data in diagnostic history.
--
-- Tenancy (as Q2′-1): every table is closed — RLS on, no policies, and no
-- privilege for public, anon, authenticated or service_role. Every child row
-- is pinned to its workspace (and project, for diagnostics) by composite
-- foreign keys. Actors use Q2′-1's shape check; invitation holders cannot act
-- on these tables.
--
-- Domain verification (Revision 2, Q2-D2):
--   * workspace_domains — one record per (workspace, domain). There is no
--     uniqueness across workspaces: a global constraint would disclose that
--     another workspace had claimed the domain.
--   * workspace_domain_state — the per-domain serialisation point. Every
--     verification event locks it FOR UPDATE, must carry seq = state.seq + 1,
--     and is checked against the CURRENT state. The state is a function of
--     the event log: it may only advance seq to an event that already exists
--     at that number, and its guard derives every other column from that
--     event, so no caller (a nested trigger included) can write a state the
--     log does not imply. Verification-sensitive decisions (a verified
--     diagnostic run, and later W1/V1d/paid gates) read this state under
--     lock, never a historical verified event alone.
--   * workspace_domain_challenges — only a SHA-256 of each challenge is
--     stored; a challenge expires within 48 hours (Q2-R3) and is consumed
--     once, only by the success event the state has applied.
--   * workspace_domain_verification_events — append-only, gap-free per domain,
--     with an exact transition matrix and stale-observation refusals.
--   * A successful verification is due for re-check after 30 days (Q2-R1);
--     past that instant it is not verified (fail closed).
--
-- Diagnostics (Q2-D1, Q2-D3): runs, one row per fetched page, and findings.
-- No page bodies, headers or cookies; URLs without query, fragment or
-- userinfo; per-page body hashes; the D-040 §6.3 unknown reasons; excerpts of
-- at most 300 characters only with offsets, the page hash and a recorded
-- personal-data screen. A finding's detail must match the approved spec of
-- its own (check_id, rule_version); no spec is approved yet, so only a null
-- detail can be stored (fail closed).
-- The result cache is workspace-isolated. A completed
-- run is frozen; re-runs are new rows.
--
-- Rate limits (Q2-D4, Q2-R4): a separate table with no link to runs or
-- workspaces. Keys are 64-hex digests computed by the server; for IP buckets
-- a keyed HMAC under the purpose label zypact.diag.rate_limit.v1 (Q2-R2: the
-- existing IP-hash secret may be reused only with that purpose separation,
-- environment isolation and no Production credential in local tests or CI).
-- Rows expire within 48 hours, cannot be updated, and are deleted only after
-- expiry by _q2p2_purge_rate_limit_events().
--
-- Recovery: forward-only. Every table is new and empty until W1/V1d write it,
-- and every function is new, so a later timestamped migration can drop them.

-- ════════════════════════════════════════════════════════════════════════
-- 1. Helpers
-- ════════════════════════════════════════════════════════════════════════

-- A domain as stored, exactly what this check enforces:
--   * two or more dot-separated labels, 4 to 253 characters in all; no
--     scheme, port, path, userinfo, whitespace or trailing dot;
--   * every label lowercase LDH, 1 to 63 characters, no leading or trailing
--     hyphen, and no '--' in positions 3 and 4 unless it is the IDNA A-label
--     prefix 'xn--' (the reserved R-LDH form is refused);
--   * the last label is alphabetic (2 to 63 letters) or an A-label
--     ('xn--' followed by 1 to 59 LDH characters), so IDNA TLDs are accepted.
-- Internationalised names are stored only as A-labels. The database checks
-- the A-label's shape, not its Punycode: converting a U-label and validating
-- it under IDNA2008 is the writer's duty (V1d), before the insert.
create or replace function public._q2p2_domain_is_normalised(p_domain text)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select p_domain is not null
     and length(p_domain) between 4 and 253
     and p_domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9]([a-z0-9-]{0,57}[a-z0-9])?)$'
     and p_domain !~ '(^|\.)(?!xn--)[a-z0-9]{2}--';
$$;

-- The exact transition matrix (Revision 2 §1.1): the status a domain moves
-- to when an event is applied to its current status, or null if refused.
-- The event trigger refuses on null; the state guard derives the new status
-- from it, so both use one definition.
create or replace function public._q2p2_next_status(p_status text, p_event text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case
    when p_event = 'challenge_issued' and p_status in ('none', 'pending', 'unverified', 'revoked') then 'pending'
    when p_event = 'challenge_issued' and p_status = 'verified' then 'verified'
    when p_event = 'verification_succeeded' and p_status in ('pending', 'verified') then 'verified'
    when p_event = 'verification_failed' and p_status in ('pending', 'verified') then p_status
    when p_event = 'challenge_expired' and p_status = 'pending' then 'unverified'
    when p_event = 'challenge_expired' and p_status = 'verified' then 'verified'
    when p_event = 'verification_lost' and p_status = 'verified' then 'unverified'
    when p_event = 'revoked' and p_status in ('pending', 'verified', 'unverified') then 'revoked'
  end;
$$;

-- A finding's detail (Q2-D3: no page body, no sensitive data) is checked
-- against the approved spec of its own check and rule version. A spec is
-- {"keys": {<key>: <field>, ...}} and each field is exactly one of:
--   {"type": "boolean"}
--   {"type": "count", "max": M}      an integer 0..M, M an integer 1..10000
--   {"type": "ratio"}                a number 0..1, at most 4 decimals
--   {"type": "enum", "values": [..]} one token from the field's own list
--   {"type": "enum_list", "values": [..], "max_items": N}
--                                    at most N (1..16) tokens from that list
-- Tokens and keys are lowercase identifiers (a letter, then letters, digits or
-- '_'; at most 32 characters); a list holds 1 to 64 tokens.
-- A detail matches only if it is an object of 1 to 16 keys, every key is a
-- field of the spec, and every value has that field's type and bounds. So no
-- free text, free number, arbitrary identifier, URL, address, null, nested
-- object or value outside the spec can be stored; numbers are only bounded
-- counts (at most 5 digits) and ratios, never identifiers. A malformed spec,
-- or no spec, matches nothing.
create or replace function public._q2p2_detail_matches_spec(p_spec jsonb, p_detail jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  k text;
  v jsonb;
  f jsonb;
  n numeric;
  v_max numeric;
begin
  if p_spec is null or jsonb_typeof(p_spec) <> 'object' or jsonb_typeof(p_spec -> 'keys') is distinct from 'object'
     or p_detail is null or jsonb_typeof(p_detail) <> 'object'
     or (select count(*) from jsonb_object_keys(p_detail)) not between 1 and 16 then
    return false;
  end if;
  for k, v in select d.key, d.value from jsonb_each(p_detail) d loop
    f := p_spec -> 'keys' -> k;
    if k !~ '^[a-z][a-z0-9_]{0,31}$' or f is null or jsonb_typeof(f) <> 'object' then
      return false;
    end if;
    case f ->> 'type'
      when 'boolean' then
        if jsonb_typeof(v) <> 'boolean' then
          return false;
        end if;
      when 'count' then
        if jsonb_typeof(f -> 'max') is distinct from 'number' or jsonb_typeof(v) <> 'number' then
          return false;
        end if;
        v_max := (f ->> 'max')::numeric;
        n := (v #>> '{}')::numeric;
        if v_max <> trunc(v_max) or v_max < 1 or v_max > 10000 or n <> trunc(n) or n < 0 or n > v_max then
          return false;
        end if;
      when 'ratio' then
        if jsonb_typeof(v) <> 'number' then
          return false;
        end if;
        n := (v #>> '{}')::numeric;
        if n < 0 or n > 1 or scale(n) > 4 then
          return false;
        end if;
      when 'enum', 'enum_list' then
        if jsonb_typeof(f -> 'values') is distinct from 'array' or jsonb_array_length(f -> 'values') not between 1 and 64
           or exists (select 1 from jsonb_array_elements(f -> 'values') x
                       where jsonb_typeof(x.value) <> 'string' or (x.value #>> '{}') !~ '^[a-z][a-z0-9_]{0,31}$') then
          return false;
        end if;
        if f ->> 'type' = 'enum' then
          if jsonb_typeof(v) <> 'string' or not ((f -> 'values') @> jsonb_build_array(v)) then
            return false;
          end if;
        else
          if jsonb_typeof(f -> 'max_items') is distinct from 'number' or jsonb_typeof(v) <> 'array' then
            return false;
          end if;
          v_max := (f ->> 'max_items')::numeric;
          if v_max <> trunc(v_max) or v_max < 1 or v_max > 16 or jsonb_array_length(v) > v_max
             or exists (select 1 from jsonb_array_elements(v) x
                         where jsonb_typeof(x.value) <> 'string' or not ((f -> 'values') @> jsonb_build_array(x.value))) then
            return false;
          end if;
        end if;
      else
        return false;
    end case;
  end loop;
  return true;
end;
$$;

-- The per-check detail registry: the approved spec of (check_id,
-- rule_version), or null. It is EMPTY here. No diagnostic check vocabulary
-- has been approved, so no field is invented: every non-null detail is
-- refused until a later, independently reviewed migration replaces this
-- function with the approved specs (a new rule version needs its own spec).
create or replace function public._q2p2_finding_detail_spec(p_check_id text, p_rule_version text)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
begin
  return null;
end;
$$;

-- A finding's detail is null, or matches its own check's approved spec.
create or replace function public._q2p2_finding_detail_is_valid(p_check_id text, p_rule_version text, p_detail jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_detail is null then
    return true;
  end if;
  return coalesce(public._q2p2_detail_matches_spec(public._q2p2_finding_detail_spec(p_check_id, p_rule_version), p_detail), false);
end;
$$;

-- A URL as stored: http(s), lowercase host, optional port and path; no query,
-- fragment, userinfo, '@' or whitespace; at most 2048 characters.
create or replace function public._q2p2_url_is_sanitised(p_url text)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select p_url is not null
     and length(p_url) <= 2048
     and p_url ~ '^https?://[a-z0-9.-]+(:[0-9]{1,5})?(/[^?#@[:space:]]*)?$';
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 2. Domain verification
-- ════════════════════════════════════════════════════════════════════════

create table public.workspace_domains (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces(id),
  normalized_domain    text not null check (public._q2p2_domain_is_normalised(normalized_domain)),
  actor_type           text not null,
  actor_account_id     uuid,
  actor_membership_id  uuid,
  actor_invitation_id  uuid,
  actor_session_id     uuid,
  actor_operator_id    uuid,
  rule_id              text,
  rule_version         text,
  created_at           timestamptz not null default now(),
  constraint workspace_domains_workspace_domain_key unique (workspace_id, normalized_domain),
  constraint workspace_domains_id_workspace_key unique (id, workspace_id),
  constraint workspace_domains_actor_shape check (public._q2p_actor_shape_ok(
    actor_type, actor_account_id, actor_membership_id, actor_invitation_id,
    actor_session_id, actor_operator_id, rule_id, rule_version)),
  constraint workspace_domains_no_invitation_actor check (actor_type <> 'invitation_holder'),
  constraint workspace_domains_actor_membership_fk foreign key (actor_membership_id, actor_account_id, workspace_id)
    references public.workspace_members(id, account_id, workspace_id)
);

-- The serialisation point. Infrastructure-only: written by the triggers below.
create table public.workspace_domain_state (
  domain_id             uuid primary key,
  workspace_id          uuid not null,
  seq                   bigint not null default 0 check (seq >= 0),
  status                text not null default 'none'
                          check (status in ('none', 'pending', 'verified', 'unverified', 'revoked')),
  current_challenge_id  uuid,
  verified_event_id     uuid,
  recheck_due_at        timestamptz,
  updated_at            timestamptz not null default clock_timestamp(),
  constraint workspace_domain_state_domain_fk foreign key (domain_id, workspace_id)
    references public.workspace_domains(id, workspace_id),
  constraint workspace_domain_state_recheck_iff_verified check ((status = 'verified') = (recheck_due_at is not null)),
  constraint workspace_domain_state_event_iff_verified check ((status = 'verified') = (verified_event_id is not null))
);

create table public.workspace_domain_challenges (
  id                   uuid primary key default gen_random_uuid(),
  domain_id            uuid not null,
  workspace_id         uuid not null,
  method               text not null check (method in ('dns_txt', 'well_known_file', 'meta_tag')),
  challenge_sha256     text not null unique check (challenge_sha256 ~ '^[0-9a-f]{64}$'),
  issued_at            timestamptz not null default clock_timestamp(),
  expires_at           timestamptz not null,
  consumed_at          timestamptz,
  actor_type           text not null,
  actor_account_id     uuid,
  actor_membership_id  uuid,
  actor_invitation_id  uuid,
  actor_session_id     uuid,
  actor_operator_id    uuid,
  rule_id              text,
  rule_version         text,
  constraint workspace_domain_challenges_domain_fk foreign key (domain_id, workspace_id)
    references public.workspace_domains(id, workspace_id),
  constraint workspace_domain_challenges_id_domain_key unique (id, domain_id),
  constraint workspace_domain_challenges_ttl check (
    expires_at > issued_at and expires_at <= issued_at + interval '48 hours'),
  constraint workspace_domain_challenges_consumed_after_issue check (consumed_at is null or consumed_at >= issued_at),
  constraint workspace_domain_challenges_actor_shape check (public._q2p_actor_shape_ok(
    actor_type, actor_account_id, actor_membership_id, actor_invitation_id,
    actor_session_id, actor_operator_id, rule_id, rule_version)),
  constraint workspace_domain_challenges_no_invitation_actor check (actor_type <> 'invitation_holder'),
  constraint workspace_domain_challenges_actor_membership_fk foreign key (actor_membership_id, actor_account_id, workspace_id)
    references public.workspace_members(id, account_id, workspace_id)
);

create table public.workspace_domain_verification_events (
  id                   uuid primary key default gen_random_uuid(),
  domain_id            uuid not null,
  workspace_id         uuid not null,
  seq                  bigint not null check (seq >= 1),
  event                text not null check (event in (
                         'challenge_issued', 'verification_succeeded', 'verification_failed',
                         'verification_lost', 'challenge_expired', 'revoked')),
  challenge_id         uuid,
  checked_at           timestamptz,
  evidence_sha256      text check (evidence_sha256 is null or evidence_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at          timestamptz not null default clock_timestamp(),
  actor_type           text not null,
  actor_account_id     uuid,
  actor_membership_id  uuid,
  actor_invitation_id  uuid,
  actor_session_id     uuid,
  actor_operator_id    uuid,
  rule_id              text,
  rule_version         text,
  constraint workspace_domain_verification_events_domain_fk foreign key (domain_id, workspace_id)
    references public.workspace_domains(id, workspace_id),
  constraint workspace_domain_verification_events_challenge_fk foreign key (challenge_id, domain_id)
    references public.workspace_domain_challenges(id, domain_id),
  constraint workspace_domain_verification_events_seq_key unique (domain_id, seq),
  constraint workspace_domain_verification_events_id_domain_key unique (id, domain_id),
  constraint workspace_domain_verification_events_id_domain_workspace_key unique (id, domain_id, workspace_id),
  constraint workspace_domain_verification_events_challenge_iff check (
    (event in ('challenge_issued', 'verification_succeeded', 'verification_failed', 'challenge_expired'))
      = (challenge_id is not null)),
  constraint workspace_domain_verification_events_checked_at_iff check (
    (event in ('verification_succeeded', 'verification_failed', 'verification_lost')) = (checked_at is not null)),
  constraint workspace_domain_verification_events_evidence_iff check (
    (event in ('verification_succeeded', 'verification_failed')) = (evidence_sha256 is not null)),
  constraint workspace_domain_verification_events_actor_shape check (public._q2p_actor_shape_ok(
    actor_type, actor_account_id, actor_membership_id, actor_invitation_id,
    actor_session_id, actor_operator_id, rule_id, rule_version)),
  constraint workspace_domain_verification_events_no_invitation_actor check (actor_type <> 'invitation_holder'),
  constraint workspace_domain_verification_events_actor_membership_fk foreign key (actor_membership_id, actor_account_id, workspace_id)
    references public.workspace_members(id, account_id, workspace_id)
);

-- A challenge is issued at most once (one-time use).
create unique index workspace_domain_verification_events_issued_once
  on public.workspace_domain_verification_events (challenge_id) where event = 'challenge_issued';

-- The state's pointers, checked at commit.
alter table public.workspace_domain_state
  add constraint workspace_domain_state_challenge_fk foreign key (current_challenge_id, domain_id)
    references public.workspace_domain_challenges(id, domain_id) deferrable initially deferred,
  add constraint workspace_domain_state_verified_event_fk foreign key (verified_event_id, domain_id)
    references public.workspace_domain_verification_events(id, domain_id) deferrable initially deferred;

-- Every domain gets its state row in the same transaction.
create or replace function public._q2p2_domain_create_state()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  insert into public.workspace_domain_state (domain_id, workspace_id) values (new.id, new.workspace_id);
  return new;
end;
$$;
create trigger workspace_domains_create_state after insert on public.workspace_domains
  for each row execute function public._q2p2_domain_create_state();

-- The state is a function of the event log. Trigger depth alone proves only
-- that some trigger is running, so it is not the authority here:
--   * insert: only the initial row, only for a domain that exists (the
--     domain trigger creates it);
--   * update: only seq may change, only to old.seq + 1, and only to the
--     number of an event that already exists for this domain and workspace.
--     Every other column is then derived HERE from that event and the shared
--     transition matrix; the writer cannot choose them;
--   * delete is refused, and nothing is written at depth 1 (directly).
-- So an unrelated nested trigger can at most apply an existing event early,
-- which leaves the same state and makes the event's own advance fail.
create or replace function public._q2p2_state_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  ev     public.workspace_domain_verification_events%rowtype;
  v_next text;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'q2p2_append_only: workspace_domain_state';
  end if;
  if pg_trigger_depth() < 2 then
    raise exception using errcode = '55000', message = 'q2p2_state_written_only_by_its_triggers';
  end if;
  if tg_op = 'INSERT' then
    if new.seq <> 0 or new.status <> 'none' or new.current_challenge_id is not null
       or new.verified_event_id is not null or new.recheck_due_at is not null
       or not exists (select 1 from public.workspace_domains d
                       where d.id = new.domain_id and d.workspace_id = new.workspace_id) then
      raise exception using errcode = '55000', message = 'q2p2_state_invalid_initial_row';
    end if;
    return new;
  end if;
  if new.domain_id is distinct from old.domain_id or new.workspace_id is distinct from old.workspace_id
     or new.seq is distinct from old.seq + 1
     or new.status is distinct from old.status
     or new.current_challenge_id is distinct from old.current_challenge_id
     or new.verified_event_id is distinct from old.verified_event_id
     or new.recheck_due_at is distinct from old.recheck_due_at then
    raise exception using errcode = '55000', message = 'q2p2_state_invalid_update';
  end if;
  select e.* into ev from public.workspace_domain_verification_events e
   where e.domain_id = new.domain_id and e.seq = new.seq;
  if not found or ev.workspace_id is distinct from new.workspace_id then
    raise exception using errcode = '55000', message = 'q2p2_state_not_derived_from_event';
  end if;
  v_next := public._q2p2_next_status(old.status, ev.event);
  if v_next is null then
    raise exception using errcode = '55000', message = 'q2p2_state_not_derived_from_event';
  end if;
  new.status := v_next;
  new.current_challenge_id := case
    when ev.event = 'challenge_issued' then ev.challenge_id
    when ev.event = 'verification_failed' then old.current_challenge_id end;
  new.verified_event_id := case
    when ev.event = 'verification_succeeded' then ev.id
    when v_next = 'verified' then old.verified_event_id end;
  new.recheck_due_at := case
    when ev.event = 'verification_succeeded' then ev.checked_at + interval '30 days'
    when v_next = 'verified' then old.recheck_due_at end;
  new.updated_at := ev.recorded_at;
  return new;
end;
$$;
create trigger workspace_domain_state_guard before insert or update or delete on public.workspace_domain_state
  for each row execute function public._q2p2_state_guard();

-- Challenges: issued_at is the database clock; only consumed_at may change,
-- once, from inside a trigger, and only for the success event that cites
-- this challenge and that the domain's state has already applied (its
-- verified event, at its seq). consumed_at is that event's recorded_at.
create or replace function public._q2p2_challenge_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  ev public.workspace_domain_verification_events%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'q2p2_append_only: workspace_domain_challenges';
  elsif tg_op = 'INSERT' then
    new.issued_at := clock_timestamp();
    if new.consumed_at is not null then
      raise exception using errcode = '55000', message = 'q2p2_challenge_created_consumed';
    end if;
    return new;
  end if;
  if pg_trigger_depth() < 2 or old.consumed_at is not null or new.consumed_at is null
     or (to_jsonb(new) - 'consumed_at') is distinct from (to_jsonb(old) - 'consumed_at') then
    raise exception using errcode = '55000', message = 'q2p2_challenge_single_consumption_only';
  end if;
  select e.* into ev from public.workspace_domain_verification_events e
    join public.workspace_domain_state s
      on s.domain_id = e.domain_id and s.verified_event_id = e.id and s.seq = e.seq
   where e.challenge_id = old.id and e.domain_id = old.domain_id and e.event = 'verification_succeeded';
  if not found then
    raise exception using errcode = '55000', message = 'q2p2_challenge_consumption_not_derived_from_event';
  end if;
  new.consumed_at := ev.recorded_at;
  return new;
end;
$$;
create trigger workspace_domain_challenges_guard before insert or update or delete on public.workspace_domain_challenges
  for each row execute function public._q2p2_challenge_guard();

-- The serialised transition, before the event row is written. Lock the
-- domain's state, require the next sequence number, check the exact
-- transition matrix against the CURRENT state and refuse stale observations.
-- The state is advanced after the insert (_q2p2_advance_domain_state).
create or replace function public._q2p2_apply_verification_event()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  st  public.workspace_domain_state%rowtype;
  ch  public.workspace_domain_challenges%rowtype;
  v_now  timestamptz;
  v_next text;
begin
  select s.* into st from public.workspace_domain_state s where s.domain_id = new.domain_id for update;
  if not found or st.workspace_id is distinct from new.workspace_id then
    raise exception using errcode = '23503', message = 'q2p2_domain_state_missing';
  end if;
  if new.seq is distinct from st.seq + 1 then
    raise exception using errcode = '40001', message = 'q2p2_stale_event_sequence';
  end if;
  v_now := clock_timestamp();
  new.recorded_at := v_now;

  v_next := public._q2p2_next_status(st.status, new.event);
  if v_next is null then
    raise exception using errcode = '22023', message = 'q2p2_invalid_transition';
  end if;

  if new.challenge_id is not null then
    select c.* into ch from public.workspace_domain_challenges c
     where c.id = new.challenge_id and c.domain_id = new.domain_id for update;
    if not found then
      raise exception using errcode = '23503', message = 'q2p2_challenge_missing';
    end if;
  end if;

  if new.event = 'challenge_issued' then
    if ch.consumed_at is not null or v_now >= ch.expires_at then
      raise exception using errcode = '22023', message = 'q2p2_challenge_not_issuable';
    end if;
  elsif new.event in ('verification_succeeded', 'verification_failed', 'challenge_expired') then
    if st.current_challenge_id is distinct from new.challenge_id then
      raise exception using errcode = '22023', message = 'q2p2_challenge_not_current';
    end if;
    if ch.consumed_at is not null then
      raise exception using errcode = '22023', message = 'q2p2_challenge_consumed';
    end if;
    if new.event = 'challenge_expired' then
      if v_now <= ch.expires_at then
        raise exception using errcode = '22023', message = 'q2p2_challenge_not_expired';
      end if;
    else
      if new.checked_at < ch.issued_at or new.checked_at > ch.expires_at then
        raise exception using errcode = '22023', message = 'q2p2_observation_outside_challenge_window';
      end if;
      if new.checked_at > v_now or new.checked_at < v_now - interval '10 minutes' then
        raise exception using errcode = '22023', message = 'q2p2_stale_observation';
      end if;
    end if;
  elsif new.event = 'verification_lost' then
    if new.checked_at > v_now or new.checked_at < v_now - interval '10 minutes' then
      raise exception using errcode = '22023', message = 'q2p2_stale_observation';
    end if;
  end if;

  return new;
end;
$$;
create trigger workspace_domain_verification_events_apply before insert on public.workspace_domain_verification_events
  for each row execute function public._q2p2_apply_verification_event();

-- After the event row exists: advance the domain's state to it (only seq is
-- written; the state guard derives the rest from this event), then consume
-- a success's challenge (the challenge guard checks it against the applied
-- event). The state row is still locked by the event's own transaction.
create or replace function public._q2p2_advance_domain_state()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  update public.workspace_domain_state set seq = new.seq where domain_id = new.domain_id;
  if not found then
    raise exception using errcode = '23503', message = 'q2p2_domain_state_missing';
  end if;
  if new.event = 'verification_succeeded' then
    update public.workspace_domain_challenges set consumed_at = new.recorded_at where id = new.challenge_id;
  end if;
  return null;
end;
$$;
create trigger workspace_domain_verification_events_advance after insert on public.workspace_domain_verification_events
  for each row execute function public._q2p2_advance_domain_state();

-- The only verification decision helper: the CURRENT state under FOR SHARE,
-- judged at one database instant. Past recheck_due_at is not verified.
create or replace function public._q2p2_domain_verified(p_domain_id uuid)
returns boolean
language plpgsql
volatile
set search_path = pg_catalog, pg_temp
as $$
declare
  v_status text;
  v_due timestamptz;
begin
  select s.status, s.recheck_due_at into v_status, v_due
    from public.workspace_domain_state s where s.domain_id = p_domain_id for share;
  return found and v_status = 'verified' and v_due is not null and clock_timestamp() < v_due;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 3. Site diagnostics
-- ════════════════════════════════════════════════════════════════════════

create table public.site_diagnostic_runs (
  id                            uuid primary key default gen_random_uuid(),
  workspace_id                  uuid not null,
  project_id                    uuid not null,
  normalized_domain             text not null check (public._q2p2_domain_is_normalised(normalized_domain)),
  start_url                     text not null check (public._q2p2_url_is_sanitised(start_url)),
  rule_set_version              text not null check (btrim(rule_set_version) <> ''),
  crawler_version               text not null check (btrim(crawler_version) <> ''),
  user_agent                    text not null check (btrim(user_agent) <> '' and length(user_agent) <= 300),
  page_cap                      smallint not null check (page_cap between 1 and 10),
  supersedes_run_id             uuid,
  domain_id                     uuid,
  domain_verification_event_id  uuid,
  cache_scope_workspace_id      uuid not null,
  started_at                    timestamptz not null default clock_timestamp(),
  completed_at                  timestamptz,
  outcome                       text check (outcome in ('completed', 'failed', 'robots_unavailable', 'cancelled')),
  actor_type                    text not null,
  actor_account_id              uuid,
  actor_membership_id           uuid,
  actor_invitation_id           uuid,
  actor_session_id              uuid,
  actor_operator_id             uuid,
  rule_id                       text,
  rule_version                  text,
  constraint site_diagnostic_runs_project_fk foreign key (project_id, workspace_id)
    references public.workspace_projects(project_id, workspace_id),
  constraint site_diagnostic_runs_id_workspace_project_key unique (id, workspace_id, project_id),
  constraint site_diagnostic_runs_supersedes_fk foreign key (supersedes_run_id, workspace_id, project_id)
    references public.site_diagnostic_runs(id, workspace_id, project_id),
  constraint site_diagnostic_runs_not_self_superseding check (supersedes_run_id is null or supersedes_run_id <> id),
  constraint site_diagnostic_runs_domain_fk foreign key (domain_id, workspace_id)
    references public.workspace_domains(id, workspace_id),
  constraint site_diagnostic_runs_verification_fk foreign key (domain_verification_event_id, domain_id, workspace_id)
    references public.workspace_domain_verification_events(id, domain_id, workspace_id),
  constraint site_diagnostic_runs_verification_needs_domain check (domain_verification_event_id is null or domain_id is not null),
  constraint site_diagnostic_runs_cache_is_workspace check (cache_scope_workspace_id = workspace_id),
  constraint site_diagnostic_runs_completion_pair check ((completed_at is null) = (outcome is null)),
  constraint site_diagnostic_runs_actor_shape check (public._q2p_actor_shape_ok(
    actor_type, actor_account_id, actor_membership_id, actor_invitation_id,
    actor_session_id, actor_operator_id, rule_id, rule_version)),
  constraint site_diagnostic_runs_no_invitation_actor check (actor_type <> 'invitation_holder'),
  constraint site_diagnostic_runs_actor_membership_fk foreign key (actor_membership_id, actor_account_id, workspace_id)
    references public.workspace_members(id, account_id, workspace_id)
);

create index site_diagnostic_runs_workspace_domain_idx on public.site_diagnostic_runs (workspace_id, normalized_domain, started_at);

-- A run is created open; it may cite a verification only when that event is
-- the domain's CURRENT verified event and the domain is verified now (state
-- read under FOR SHARE). Completion is set once; then the run is frozen.
create or replace function public._q2p2_run_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_domain text;
  st public.workspace_domain_state%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'q2p2_append_only: site_diagnostic_runs';
  elsif tg_op = 'INSERT' then
    new.started_at := clock_timestamp();
    if new.completed_at is not null or new.outcome is not null then
      raise exception using errcode = '55000', message = 'q2p2_run_created_completed';
    end if;
    if new.domain_id is not null then
      select d.normalized_domain into v_domain from public.workspace_domains d
       where d.id = new.domain_id and d.workspace_id = new.workspace_id;
      if v_domain is distinct from new.normalized_domain then
        raise exception using errcode = '22023', message = 'q2p2_run_domain_mismatch';
      end if;
    end if;
    if new.domain_verification_event_id is not null then
      select s.* into st from public.workspace_domain_state s where s.domain_id = new.domain_id for share;
      if not found or st.status <> 'verified' or st.verified_event_id is distinct from new.domain_verification_event_id
         or not (clock_timestamp() < st.recheck_due_at) then
        raise exception using errcode = '22023', message = 'q2p2_verification_not_current';
      end if;
    end if;
    return new;
  end if;
  if old.completed_at is not null or new.outcome is null
     or (to_jsonb(new) - 'completed_at' - 'outcome') is distinct from (to_jsonb(old) - 'completed_at' - 'outcome') then
    raise exception using errcode = '55000', message = 'q2p2_run_single_completion_only';
  end if;
  new.completed_at := clock_timestamp();
  return new;
end;
$$;
create trigger site_diagnostic_runs_guard before insert or update or delete on public.site_diagnostic_runs
  for each row execute function public._q2p2_run_guard();

create table public.site_diagnostic_pages (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null,
  workspace_id    uuid not null,
  project_id      uuid not null,
  page_index      smallint not null check (page_index between 0 and 9),
  url             text not null check (public._q2p2_url_is_sanitised(url)),
  query_present   boolean not null,
  fetched_at      timestamptz not null,
  http_status     smallint check (http_status between 100 and 599),
  content_type    text check (content_type is null or length(content_type) <= 200),
  bytes           integer not null check (bytes >= 0),
  body_sha256     text check (body_sha256 is null or body_sha256 ~ '^[0-9a-f]{64}$'),
  robots_allowed  boolean not null,
  fetch_error     text check (fetch_error in (
                    'fetch_failed', 'timeout', 'size_cap', 'not_html', 'blocked_by_robots', 'robots_unavailable')),
  constraint site_diagnostic_pages_run_fk foreign key (run_id, workspace_id, project_id)
    references public.site_diagnostic_runs(id, workspace_id, project_id),
  constraint site_diagnostic_pages_run_index_key unique (run_id, page_index),
  constraint site_diagnostic_pages_run_url_key unique (run_id, url),
  constraint site_diagnostic_pages_id_run_key unique (id, run_id),
  constraint site_diagnostic_pages_hash_iff_bytes check ((bytes > 0) = (body_sha256 is not null))
);

create table public.site_diagnostic_findings (
  id                   uuid primary key default gen_random_uuid(),
  run_id               uuid not null,
  workspace_id         uuid not null,
  project_id           uuid not null,
  page_id              uuid,
  check_id             text not null check (check_id ~ '^[a-z][a-z0-9_.]{2,63}$'),
  state                text not null check (state in ('pass', 'issue', 'info', 'unknown')),
  unknown_reason       text check (unknown_reason in (
                         'fetch_failed', 'timeout', 'size_cap', 'parse_error', 'blocked_by_robots',
                         'robots_unavailable', 'not_html', 'page_cap_reached', 'not_applicable')),
  excerpt              text check (excerpt is null or length(excerpt) between 1 and 300),
  excerpt_start        integer,
  excerpt_end          integer,
  excerpt_body_sha256  text check (excerpt_body_sha256 is null or excerpt_body_sha256 ~ '^[0-9a-f]{64}$'),
  pii_screen_version   text check (pii_screen_version is null or btrim(pii_screen_version) <> ''),
  detail               jsonb,
  rule_version         text not null check (btrim(rule_version) <> ''),
  recorded_at          timestamptz not null default clock_timestamp(),
  constraint site_diagnostic_findings_run_fk foreign key (run_id, workspace_id, project_id)
    references public.site_diagnostic_runs(id, workspace_id, project_id),
  constraint site_diagnostic_findings_page_fk foreign key (page_id, run_id)
    references public.site_diagnostic_pages(id, run_id),
  constraint site_diagnostic_findings_detail_per_check check (
    public._q2p2_finding_detail_is_valid(check_id, rule_version, detail)
    and (detail is null or pg_column_size(detail) <= 4096)),
  constraint site_diagnostic_findings_unknown_reason_iff check ((state = 'unknown') = (unknown_reason is not null)),
  constraint site_diagnostic_findings_excerpt_bundle check (
    (excerpt is null) = (excerpt_start is null) and (excerpt is null) = (excerpt_end is null)
    and (excerpt is null) = (excerpt_body_sha256 is null) and (excerpt is null) = (pii_screen_version is null)),
  constraint site_diagnostic_findings_excerpt_needs_page check (excerpt is null or page_id is not null),
  constraint site_diagnostic_findings_excerpt_offsets check (
    excerpt_start is null or (excerpt_start >= 0 and excerpt_end > excerpt_start))
);

-- Pages and findings are inserted only while their run is open (the run row
-- is read FOR SHARE, serialising with completion), within the run's page cap;
-- an excerpt must carry its page's body hash.
create or replace function public._q2p2_run_child_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_completed timestamptz;
  v_cap smallint;
  v_hash text;
begin
  if tg_op <> 'INSERT' then
    raise exception using errcode = '55000', message = 'q2p2_append_only: ' || tg_table_name;
  end if;
  select r.completed_at, r.page_cap into v_completed, v_cap
    from public.site_diagnostic_runs r where r.id = new.run_id for share;
  if not found then
    raise exception using errcode = '23503', message = 'q2p2_run_missing';
  end if;
  if v_completed is not null then
    raise exception using errcode = '55000', message = 'q2p2_run_frozen';
  end if;
  if tg_table_name = 'site_diagnostic_pages' then
    if new.page_index >= v_cap then
      raise exception using errcode = '22023', message = 'q2p2_page_cap_exceeded';
    end if;
  elsif new.excerpt is not null then
    select p.body_sha256 into v_hash from public.site_diagnostic_pages p where p.id = new.page_id and p.run_id = new.run_id;
    if v_hash is distinct from new.excerpt_body_sha256 then
      raise exception using errcode = '22023', message = 'q2p2_excerpt_hash_mismatch';
    end if;
  end if;
  return new;
end;
$$;
create trigger site_diagnostic_pages_guard before insert or update or delete on public.site_diagnostic_pages
  for each row execute function public._q2p2_run_child_guard();
create trigger site_diagnostic_findings_guard before insert or update or delete on public.site_diagnostic_findings
  for each row execute function public._q2p2_run_child_guard();

-- ════════════════════════════════════════════════════════════════════════
-- 4. Rate-limit records: separate, keyed, short-lived (Q2-D4, Q2-R2, Q2-R4)
-- ════════════════════════════════════════════════════════════════════════

create table public.diagnostic_rate_limit_events (
  id           bigint generated always as identity primary key,
  bucket_kind  text not null check (bucket_kind in ('account', 'ip', 'domain')),
  bucket_key   text not null check (bucket_key ~ '^[0-9a-f]{64}$'),
  key_purpose  text not null check (key_purpose = 'zypact.diag.rate_limit.v1'),
  key_id       text not null check (btrim(key_id) <> '' and length(key_id) <= 64),
  occurred_at  timestamptz not null default clock_timestamp(),
  expires_at   timestamptz not null,
  constraint diagnostic_rate_limit_events_ttl check (
    expires_at > occurred_at and expires_at <= occurred_at + interval '48 hours')
);
create index diagnostic_rate_limit_events_bucket_idx on public.diagnostic_rate_limit_events (bucket_kind, bucket_key, occurred_at);
create index diagnostic_rate_limit_events_expiry_idx on public.diagnostic_rate_limit_events (expires_at);

-- occurred_at is the database clock; rows cannot be updated, and can be
-- deleted only once expired.
create or replace function public._q2p2_rate_limit_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.occurred_at := clock_timestamp();
    return new;
  elsif tg_op = 'UPDATE' then
    raise exception using errcode = '55000', message = 'q2p2_rate_limit_events_immutable';
  end if;
  if old.expires_at > clock_timestamp() then
    raise exception using errcode = '55000', message = 'q2p2_rate_limit_event_not_expired';
  end if;
  return old;
end;
$$;
create trigger diagnostic_rate_limit_events_guard before insert or update or delete on public.diagnostic_rate_limit_events
  for each row execute function public._q2p2_rate_limit_guard();

-- The cleanup: deletes expired rows only, and returns how many.
create or replace function public._q2p2_purge_rate_limit_events()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  delete from public.diagnostic_rate_limit_events where expires_at <= clock_timestamp();
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 5. Append-only enforcement, closed tables, function privileges
-- ════════════════════════════════════════════════════════════════════════

create trigger workspace_domains_append_only before update or delete on public.workspace_domains
  for each row execute function public._q2p_append_only();
create trigger workspace_domain_verification_events_append_only before update or delete on public.workspace_domain_verification_events
  for each row execute function public._q2p_append_only();

create trigger workspace_domains_no_truncate before truncate on public.workspace_domains
  for each statement execute function public._q2p_no_truncate();
create trigger workspace_domain_state_no_truncate before truncate on public.workspace_domain_state
  for each statement execute function public._q2p_no_truncate();
create trigger workspace_domain_challenges_no_truncate before truncate on public.workspace_domain_challenges
  for each statement execute function public._q2p_no_truncate();
create trigger workspace_domain_verification_events_no_truncate before truncate on public.workspace_domain_verification_events
  for each statement execute function public._q2p_no_truncate();
create trigger site_diagnostic_runs_no_truncate before truncate on public.site_diagnostic_runs
  for each statement execute function public._q2p_no_truncate();
create trigger site_diagnostic_pages_no_truncate before truncate on public.site_diagnostic_pages
  for each statement execute function public._q2p_no_truncate();
create trigger site_diagnostic_findings_no_truncate before truncate on public.site_diagnostic_findings
  for each statement execute function public._q2p_no_truncate();
create trigger diagnostic_rate_limit_events_no_truncate before truncate on public.diagnostic_rate_limit_events
  for each statement execute function public._q2p_no_truncate();

alter table public.workspace_domains enable row level security;
alter table public.workspace_domain_state enable row level security;
alter table public.workspace_domain_challenges enable row level security;
alter table public.workspace_domain_verification_events enable row level security;
alter table public.site_diagnostic_runs enable row level security;
alter table public.site_diagnostic_pages enable row level security;
alter table public.site_diagnostic_findings enable row level security;
alter table public.diagnostic_rate_limit_events enable row level security;

-- Closed to every client role, service_role included.
revoke all on table
  public.workspace_domains, public.workspace_domain_state, public.workspace_domain_challenges,
  public.workspace_domain_verification_events, public.site_diagnostic_runs,
  public.site_diagnostic_pages, public.site_diagnostic_findings, public.diagnostic_rate_limit_events
  from public, anon, authenticated, service_role;
revoke all on sequence public.diagnostic_rate_limit_events_id_seq from public, anon, authenticated, service_role;

-- No API role may execute any Q2′-2 function.
revoke all on function public._q2p2_domain_is_normalised(text) from public, anon, authenticated, service_role;
revoke all on function public._q2p2_url_is_sanitised(text) from public, anon, authenticated, service_role;
revoke all on function public._q2p2_next_status(text, text) from public, anon, authenticated, service_role;
revoke all on function public._q2p2_detail_matches_spec(jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public._q2p2_finding_detail_spec(text, text) from public, anon, authenticated, service_role;
revoke all on function public._q2p2_finding_detail_is_valid(text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public._q2p2_domain_create_state() from public, anon, authenticated, service_role;
revoke all on function public._q2p2_state_guard() from public, anon, authenticated, service_role;
revoke all on function public._q2p2_challenge_guard() from public, anon, authenticated, service_role;
revoke all on function public._q2p2_apply_verification_event() from public, anon, authenticated, service_role;
revoke all on function public._q2p2_advance_domain_state() from public, anon, authenticated, service_role;
revoke all on function public._q2p2_domain_verified(uuid) from public, anon, authenticated, service_role;
revoke all on function public._q2p2_run_guard() from public, anon, authenticated, service_role;
revoke all on function public._q2p2_run_child_guard() from public, anon, authenticated, service_role;
revoke all on function public._q2p2_rate_limit_guard() from public, anon, authenticated, service_role;
revoke all on function public._q2p2_purge_rate_limit_events() from public, anon, authenticated, service_role;
