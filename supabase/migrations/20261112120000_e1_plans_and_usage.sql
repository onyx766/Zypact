-- E1 — plans, allowances and the measurement usage ledger (D-048).
-- Applies after P2 (20261111120000).
--
-- What this adds:
--   * the Free and Starter plans of the approved direction (D-047 Part B,
--     item 3), as fixed allowances in one immutable function;
--   * plan assignments per workspace (founder, system or a future Stripe
--     webhook), append-only;
--   * a usage ledger in which every measurement run is RESERVED before any
--     attempt, then CONSUMED (a successful run) or RELEASED (failed or
--     excluded), append-only, idempotent on the caller's key;
--   * the paid-measurement switch: a founder-written, append-only record.
--     With no record, or the latest disabled, NO reservation succeeds. It is
--     the database-level "built but switched off" of D-047.
--
-- Rules:
--   * a run counts against the allowance while reserved or consumed; a
--     released run does not, so a failed provider call never uses the
--     customer's allowance;
--   * releases are bounded too: once a period's releases reach that
--     period's allowance, no further reservation succeeds that period
--     (FAILURE_BUDGET_EXHAUSTED), so repeated failures cannot spend without
--     limit (D-037 still caps actual spend per job);
--   * the Free plan's allowance is lifetime (3 successful runs, never reset);
--     Starter's are per billing month from the plan's period anchor;
--   * there is no overage: an exhausted allowance refuses.
--
-- Closed, as Q2′, P1 and P2: RLS on with no policy, no table privilege for
-- any API role; public functions executable by service_role only; `_e1_`
-- helpers by no role. No paid call happens here; this only decides whether
-- a later call may be admitted.
--
-- Recovery: no existing table references these. A rollback drops the
-- functions, helpers and the three tables; it loses plan and usage history
-- only, never evidence.

-- ════════════════════════════════════════════════════════════════════════
-- 1. Fixed plan rules (no role may execute them)
-- ════════════════════════════════════════════════════════════════════════

-- Successful-run allowance per plan and measurement type. Free's is lifetime;
-- Starter's is per billing month. Mirrored in lib/plans/catalog.ts, and the
-- two are checked against each other by scripts/test-e1-plans.ts.
create or replace function public._e1_allowance(p_plan text, p_type text)
returns integer
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case p_plan
    when 'free' then case p_type when 'free_trial' then 3 else 0 end
    when 'starter' then case p_type
      when 'monitoring' then 160
      when 'deep_baseline' then 50
      when 'retest' then 30
      else 0 end
    else 0 end;
$$;

create or replace function public._e1_active_question_limit(p_plan text)
returns integer
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case p_plan when 'free' then 1 when 'starter' then 20 else 0 end;
$$;

create or replace function public._e1_engine_allowed(p_plan text, p_engine text)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case p_plan
    when 'free' then p_engine = 'perplexity'
    when 'starter' then p_engine in ('perplexity', 'chatgpt')
    else false end;
$$;

-- The start of the billing month containing p_at, counted from p_anchor.
create or replace function public._e1_period_start(p_anchor timestamptz, p_at timestamptz)
returns timestamptz
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_age interval;
  v_months integer;
  v_start timestamptz;
begin
  if p_at <= p_anchor then
    return p_anchor;
  end if;
  v_age := age(p_at, p_anchor);
  v_months := (extract(year from v_age) * 12 + extract(month from v_age))::integer;
  v_start := p_anchor + make_interval(months => v_months);
  -- age() and month arithmetic can disagree at month ends (an anchor of
  -- 31 January plus one month is 28 February). Settle on month arithmetic:
  -- the latest anchor + n months that is not after p_at.
  while v_months > 0 and p_anchor + make_interval(months => v_months) > p_at loop
    v_months := v_months - 1;
  end loop;
  while p_anchor + make_interval(months => v_months + 1) <= p_at loop
    v_months := v_months + 1;
  end loop;
  v_start := p_anchor + make_interval(months => v_months);
  return v_start;
end;
$$;

create or replace function public._e1_append_only()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception using errcode = '55000', message = 'e1_append_only: ' || tg_table_name;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 2. Tables
-- ════════════════════════════════════════════════════════════════════════

create table public.workspace_plan_assignments (
  id                      uuid primary key default gen_random_uuid(),
  workspace_id            uuid not null references public.workspaces(id),
  plan                    text not null check (plan in ('free', 'starter')),
  source                  text not null check (source in ('founder', 'system', 'stripe')),
  period_anchor           timestamptz not null,
  stripe_customer_id      text check (stripe_customer_id is null or stripe_customer_id ~ '^cus_[A-Za-z0-9]{6,64}$'),
  stripe_subscription_id  text check (stripe_subscription_id is null or stripe_subscription_id ~ '^sub_[A-Za-z0-9]{6,64}$'),
  idempotency_key         text not null unique check (btrim(idempotency_key) <> '' and length(idempotency_key) <= 200),
  request_fingerprint     text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  actor_type              text not null check (actor_type in ('founder', 'system')),
  actor_operator_id       uuid,
  rule_id                 text,
  rule_version            text,
  created_at              timestamptz not null default clock_timestamp(),
  constraint workspace_plan_assignments_actor_shape check (public._q2p_actor_shape_ok(
    actor_type, null, null, null, null, actor_operator_id, rule_id, rule_version)),
  constraint workspace_plan_assignments_source_actor check (
    (source = 'founder' and actor_type = 'founder')
    or (source in ('system', 'stripe') and actor_type = 'system')),
  constraint workspace_plan_assignments_stripe_refs check (
    source = 'stripe' or (stripe_customer_id is null and stripe_subscription_id is null))
);

create table public.workspace_usage_events (
  id                   uuid primary key default gen_random_uuid(),
  reservation_id       uuid not null,
  workspace_id         uuid not null references public.workspaces(id),
  plan                 text not null check (plan in ('free', 'starter')),
  measurement_type     text not null check (measurement_type in ('free_trial', 'monitoring', 'deep_baseline', 'retest')),
  engine               text not null check (engine in ('perplexity', 'chatgpt')),
  event                text not null check (event in ('reserved', 'consumed', 'released')),
  -- The billing month the reservation counts in; null for a lifetime allowance.
  period_start         timestamptz,
  idempotency_key      text check (idempotency_key is null or (btrim(idempotency_key) <> '' and length(idempotency_key) <= 200)),
  protocol_attempt_id  uuid references public.protocol_attempts(id),
  reason               text check (reason is null or reason ~ '^[a-z][a-z0-9_]{1,63}$'),
  rule_id              text not null check (btrim(rule_id) <> ''),
  rule_version         text not null check (btrim(rule_version) <> ''),
  created_at           timestamptz not null default clock_timestamp(),
  constraint workspace_usage_events_one_per_kind unique (reservation_id, event),
  constraint workspace_usage_events_key_iff_reserved check ((event = 'reserved') = (idempotency_key is not null)),
  constraint workspace_usage_events_lifetime_free check ((measurement_type = 'free_trial') = (period_start is null)),
  constraint workspace_usage_events_reason_on_release check (event <> 'released' or reason is not null)
);

-- One settlement per reservation, whichever it is.
create unique index workspace_usage_events_one_settlement
  on public.workspace_usage_events (reservation_id) where event in ('consumed', 'released');
-- The caller's key names one reservation per workspace.
create unique index workspace_usage_events_reservation_key
  on public.workspace_usage_events (workspace_id, idempotency_key) where event = 'reserved';
create index workspace_usage_events_period
  on public.workspace_usage_events (workspace_id, measurement_type, period_start);

-- A settlement belongs to a reservation of the same workspace, type and engine.
create or replace function public._e1_usage_event_check()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.event <> 'reserved' and not exists (
       select 1 from public.workspace_usage_events r
        where r.reservation_id = new.reservation_id and r.event = 'reserved'
          and r.workspace_id = new.workspace_id and r.measurement_type = new.measurement_type
          and r.engine = new.engine and r.plan = new.plan
          and r.period_start is not distinct from new.period_start) then
    raise exception using errcode = '23514', message = 'e1_settlement_without_reservation';
  end if;
  return new;
end;
$$;

create trigger workspace_usage_events_check
  before insert on public.workspace_usage_events
  for each row execute function public._e1_usage_event_check();

create table public.paid_measurement_switch_events (
  id                 uuid primary key default gen_random_uuid(),
  enabled            boolean not null,
  actor_operator_id  uuid not null,
  reason             text not null check (btrim(reason) <> '' and length(reason) <= 500),
  created_at         timestamptz not null default clock_timestamp()
);

-- Append-only and closed.
create trigger workspace_plan_assignments_append_only
  before update or delete on public.workspace_plan_assignments
  for each row execute function public._e1_append_only();
create trigger workspace_plan_assignments_no_truncate
  before truncate on public.workspace_plan_assignments
  for each statement execute function public._e1_append_only();
create trigger workspace_usage_events_append_only
  before update or delete on public.workspace_usage_events
  for each row execute function public._e1_append_only();
create trigger workspace_usage_events_no_truncate
  before truncate on public.workspace_usage_events
  for each statement execute function public._e1_append_only();
create trigger paid_measurement_switch_events_append_only
  before update or delete on public.paid_measurement_switch_events
  for each row execute function public._e1_append_only();
create trigger paid_measurement_switch_events_no_truncate
  before truncate on public.paid_measurement_switch_events
  for each statement execute function public._e1_append_only();

alter table public.workspace_plan_assignments enable row level security;
alter table public.workspace_usage_events enable row level security;
alter table public.paid_measurement_switch_events enable row level security;
revoke all on table public.workspace_plan_assignments, public.workspace_usage_events,
  public.paid_measurement_switch_events
  from public, anon, authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- 3. Reading the current plan (no role may execute it)
-- ════════════════════════════════════════════════════════════════════════

-- The workspace's current plan. No assignment means Free, anchored at the
-- workspace's creation.
create or replace function public._e1_current_plan(p_workspace_id uuid,
  out plan text, out source text, out period_anchor timestamptz)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  select a.plan, a.source, a.period_anchor into plan, source, period_anchor
    from public.workspace_plan_assignments a
   where a.workspace_id = p_workspace_id
   order by a.created_at desc, a.id desc
   limit 1;
  if plan is null then
    plan := 'free';
    source := 'default';
    select w.created_at into period_anchor from public.workspaces w where w.id = p_workspace_id;
  end if;
end;
$$;

create or replace function public._e1_paid_measurement_on()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select coalesce((select e.enabled from public.paid_measurement_switch_events e
                    order by e.created_at desc, e.id desc limit 1), false);
$$;

-- Held (reserved, not settled), consumed and released counts for one
-- workspace, type and period (null period = lifetime).
create or replace function public._e1_counts(p_workspace_id uuid, p_type text, p_period timestamptz,
  out held integer, out consumed integer, out released integer)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select
    count(*) filter (where s.event is null)::integer,
    count(*) filter (where s.event = 'consumed')::integer,
    count(*) filter (where s.event = 'released')::integer
    from public.workspace_usage_events r
    left join public.workspace_usage_events s
      on s.reservation_id = r.reservation_id and s.event in ('consumed', 'released')
   where r.workspace_id = p_workspace_id and r.event = 'reserved'
     and r.measurement_type = p_type and r.period_start is not distinct from p_period;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 4. Functions
-- ════════════════════════════════════════════════════════════════════════

-- E1-F1: assigns a plan. Founder (operator id) or system (rule id and
-- version; a Stripe webhook is a system actor with source 'stripe').
-- Idempotent on the key: the same key and body is ALREADY_ASSIGNED; the same
-- key with a different body is IDEMPOTENCY_KEY_CONFLICT and writes nothing.
create or replace function public.assign_workspace_plan(
  p_workspace_id uuid,
  p_plan text,
  p_source text,
  p_period_anchor timestamptz,
  p_idempotency_key text,
  p_actor_type text,
  p_actor_operator_id uuid,
  p_rule_id text,
  p_rule_version text,
  p_stripe_customer_id text,
  p_stripe_subscription_id text
) returns table (status text, assignment_id uuid)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_fp text;
  v_existing public.workspace_plan_assignments%rowtype;
  v_id uuid;
begin
  perform public._q2p_require_founder_or_system(p_actor_type, p_actor_operator_id, p_rule_id, p_rule_version);
  if p_workspace_id is null or p_plan is null or p_source is null or p_period_anchor is null
     or coalesce(btrim(p_idempotency_key), '') = '' then
    raise exception using errcode = '22023', message = 'e1_invalid_plan_args';
  end if;
  if not exists (select 1 from public.workspaces w where w.id = p_workspace_id) then
    raise exception using errcode = '22023', message = 'e1_unknown_workspace';
  end if;

  v_fp := public._q2p_sha256_hex(jsonb_build_object(
    'action', 'assign_workspace_plan', 'workspace_id', p_workspace_id, 'plan', p_plan, 'source', p_source,
    'period_anchor', p_period_anchor, 'stripe_customer_id', p_stripe_customer_id,
    'stripe_subscription_id', p_stripe_subscription_id)::text);

  perform pg_advisory_xact_lock(hashtextextended('zypact.e1.usage:' || p_workspace_id::text, 0));

  select a.* into v_existing from public.workspace_plan_assignments a where a.idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    if v_existing.request_fingerprint = v_fp then
      return query select 'ALREADY_ASSIGNED'::text, v_existing.id;
    else
      return query select 'IDEMPOTENCY_KEY_CONFLICT'::text, null::uuid;
    end if;
    return;
  end if;

  insert into public.workspace_plan_assignments (
    workspace_id, plan, source, period_anchor, stripe_customer_id, stripe_subscription_id,
    idempotency_key, request_fingerprint, actor_type, actor_operator_id, rule_id, rule_version)
  values (
    p_workspace_id, p_plan, p_source, p_period_anchor, p_stripe_customer_id, p_stripe_subscription_id,
    p_idempotency_key, v_fp, p_actor_type, p_actor_operator_id, p_rule_id, p_rule_version)
  returning id into v_id;

  return query select 'ASSIGNED'::text, v_id;
end;
$$;

-- E1-F2: the founder turns paid measurement on or off for every workspace.
create or replace function public.set_paid_measurement_switch(
  p_enabled boolean,
  p_actor_operator_id uuid,
  p_reason text
) returns table (status text, enabled boolean)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
begin
  if p_enabled is null or p_actor_operator_id is null or coalesce(btrim(p_reason), '') = '' then
    raise exception using errcode = '22023', message = 'e1_invalid_switch_args';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('zypact.e1.paid_switch', 0));
  insert into public.paid_measurement_switch_events (enabled, actor_operator_id, reason)
  values (p_enabled, p_actor_operator_id, p_reason);
  return query select 'RECORDED'::text, p_enabled;
end;
$$;

-- E1-F3: reserves one measurement run before any attempt. Called by the
-- system path that is about to admit an attempt (rule id and version name
-- it). A replay of the same key returns the same reservation, even after
-- the switch is turned off or the allowance is used up.
create or replace function public.reserve_measurement_run(
  p_workspace_id uuid,
  p_measurement_type text,
  p_engine text,
  p_idempotency_key text,
  p_rule_id text,
  p_rule_version text
) returns table (status text, reservation_id uuid, allowance integer, used integer)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_existing public.workspace_usage_events%rowtype;
  v_plan record;
  v_allowance integer;
  v_period timestamptz;
  v_counts record;
  v_id uuid := gen_random_uuid();
begin
  if p_workspace_id is null or coalesce(btrim(p_idempotency_key), '') = ''
     or coalesce(btrim(p_rule_id), '') = '' or coalesce(btrim(p_rule_version), '') = ''
     or p_measurement_type not in ('free_trial', 'monitoring', 'deep_baseline', 'retest')
     or p_engine not in ('perplexity', 'chatgpt') then
    raise exception using errcode = '22023', message = 'e1_invalid_reservation_args';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('zypact.e1.usage:' || p_workspace_id::text, 0));

  select e.* into v_existing from public.workspace_usage_events e
   where e.workspace_id = p_workspace_id and e.idempotency_key = p_idempotency_key and e.event = 'reserved';
  if v_existing.id is not null then
    if v_existing.measurement_type = p_measurement_type and v_existing.engine = p_engine then
      return query select 'ALREADY_RESERVED'::text, v_existing.reservation_id, null::integer, null::integer;
    else
      return query select 'IDEMPOTENCY_KEY_CONFLICT'::text, null::uuid, null::integer, null::integer;
    end if;
    return;
  end if;

  if not public._e1_paid_measurement_on() then
    return query select 'PAID_MEASUREMENT_OFF'::text, null::uuid, null::integer, null::integer;
    return;
  end if;

  select * into v_plan from public._e1_current_plan(p_workspace_id);
  if v_plan.period_anchor is null then
    raise exception using errcode = '22023', message = 'e1_unknown_workspace';
  end if;
  if not public._e1_engine_allowed(v_plan.plan, p_engine) then
    return query select 'ENGINE_NOT_IN_PLAN'::text, null::uuid, null::integer, null::integer;
    return;
  end if;
  v_allowance := public._e1_allowance(v_plan.plan, p_measurement_type);
  if v_allowance = 0 then
    return query select 'NOT_IN_PLAN'::text, null::uuid, 0, null::integer;
    return;
  end if;

  v_period := case when p_measurement_type = 'free_trial' then null
                   else public._e1_period_start(v_plan.period_anchor, clock_timestamp()) end;
  select * into v_counts from public._e1_counts(p_workspace_id, p_measurement_type, v_period);
  if v_counts.held + v_counts.consumed >= v_allowance then
    return query select 'ALLOWANCE_EXHAUSTED'::text, null::uuid, v_allowance, v_counts.held + v_counts.consumed;
    return;
  end if;
  if v_counts.released >= v_allowance then
    return query select 'FAILURE_BUDGET_EXHAUSTED'::text, null::uuid, v_allowance, v_counts.held + v_counts.consumed;
    return;
  end if;

  insert into public.workspace_usage_events (
    reservation_id, workspace_id, plan, measurement_type, engine, event, period_start, idempotency_key,
    rule_id, rule_version)
  values (
    v_id, p_workspace_id, v_plan.plan, p_measurement_type, p_engine, 'reserved', v_period, p_idempotency_key,
    p_rule_id, p_rule_version);

  return query select 'RESERVED'::text, v_id, v_allowance, v_counts.held + v_counts.consumed + 1;
end;
$$;

-- E1-F4: settles a reservation once: consumed (a successful run) or
-- released (failed, timed out, cancelled or excluded; a reason is
-- required). The same settlement again is ALREADY_SETTLED; a different one
-- is SETTLEMENT_CONFLICT and writes nothing. A consumed run is never
-- restored, whatever later happens to its question.
create or replace function public.settle_measurement_run(
  p_reservation_id uuid,
  p_outcome text,
  p_protocol_attempt_id uuid,
  p_reason text,
  p_rule_id text,
  p_rule_version text
) returns table (status text)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_res public.workspace_usage_events%rowtype;
  v_settled public.workspace_usage_events%rowtype;
begin
  if p_reservation_id is null or p_outcome not in ('consumed', 'released')
     or coalesce(btrim(p_rule_id), '') = '' or coalesce(btrim(p_rule_version), '') = '' then
    raise exception using errcode = '22023', message = 'e1_invalid_settlement_args';
  end if;

  select e.* into v_res from public.workspace_usage_events e
   where e.reservation_id = p_reservation_id and e.event = 'reserved';
  if v_res.id is null then
    return query select 'NOT_FOUND'::text;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('zypact.e1.usage:' || v_res.workspace_id::text, 0));

  select e.* into v_settled from public.workspace_usage_events e
   where e.reservation_id = p_reservation_id and e.event in ('consumed', 'released');
  if v_settled.id is not null then
    if v_settled.event = p_outcome and v_settled.protocol_attempt_id is not distinct from p_protocol_attempt_id then
      return query select 'ALREADY_SETTLED'::text;
    else
      return query select 'SETTLEMENT_CONFLICT'::text;
    end if;
    return;
  end if;

  insert into public.workspace_usage_events (
    reservation_id, workspace_id, plan, measurement_type, engine, event, period_start, idempotency_key,
    protocol_attempt_id, reason, rule_id, rule_version)
  values (
    p_reservation_id, v_res.workspace_id, v_res.plan, v_res.measurement_type, v_res.engine, p_outcome,
    v_res.period_start, null, p_protocol_attempt_id, p_reason, p_rule_id, p_rule_version);

  return query select 'SETTLED'::text;
end;
$$;

-- E1-F5: the signed-in customer's plan and usage, for the Plan page.
create or replace function public.get_workspace_usage(
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
  v_period timestamptz;
  v_types jsonb := '[]'::jsonb;
  v_type text;
  v_counts record;
  v_p timestamptz;
begin
  select * into s from public._p1_session(p_token, p_account_id);
  if s.status <> 'ACTIVE' then
    return jsonb_build_object('status', 'NOT_SIGNED_IN');
  end if;
  select * into v_plan from public._e1_current_plan(s.workspace_id);
  v_period := public._e1_period_start(v_plan.period_anchor, clock_timestamp());

  foreach v_type in array array['free_trial', 'monitoring', 'deep_baseline', 'retest'] loop
    v_p := case when v_type = 'free_trial' then null else v_period end;
    select * into v_counts from public._e1_counts(s.workspace_id, v_type, v_p);
    v_types := v_types || jsonb_build_object(
      'type', v_type, 'allowance', public._e1_allowance(v_plan.plan, v_type), 'lifetime', v_type = 'free_trial',
      'consumed', v_counts.consumed, 'held', v_counts.held, 'released', v_counts.released);
  end loop;

  return jsonb_build_object(
    'status', 'OK',
    'plan', v_plan.plan,
    'source', v_plan.source,
    'period_start', v_period,
    'period_end', v_period + interval '1 month',
    'active_question_limit', public._e1_active_question_limit(v_plan.plan),
    'engines', to_jsonb(array(select e from unnest(array['perplexity', 'chatgpt']) e
                               where public._e1_engine_allowed(v_plan.plan, e))),
    'paid_measurement_on', public._e1_paid_measurement_on(),
    'types', v_types);
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 5. Function privileges
-- ════════════════════════════════════════════════════════════════════════

revoke all on function public._e1_allowance(text, text) from public, anon, authenticated, service_role;
revoke all on function public._e1_active_question_limit(text) from public, anon, authenticated, service_role;
revoke all on function public._e1_engine_allowed(text, text) from public, anon, authenticated, service_role;
revoke all on function public._e1_period_start(timestamptz, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public._e1_append_only() from public, anon, authenticated, service_role;
revoke all on function public._e1_usage_event_check() from public, anon, authenticated, service_role;
revoke all on function public._e1_current_plan(uuid) from public, anon, authenticated, service_role;
revoke all on function public._e1_paid_measurement_on() from public, anon, authenticated, service_role;
revoke all on function public._e1_counts(uuid, text, timestamptz) from public, anon, authenticated, service_role;

revoke all on function public.assign_workspace_plan(uuid, text, text, timestamptz, text, text, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.set_paid_measurement_switch(boolean, uuid, text) from public, anon, authenticated;
revoke all on function public.reserve_measurement_run(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.settle_measurement_run(uuid, text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.get_workspace_usage(text, uuid) from public, anon, authenticated;

grant execute on function public.assign_workspace_plan(uuid, text, text, timestamptz, text, text, uuid, text, text, text, text) to service_role;
grant execute on function public.set_paid_measurement_switch(boolean, uuid, text) to service_role;
grant execute on function public.reserve_measurement_run(uuid, text, text, text, text, text) to service_role;
grant execute on function public.settle_measurement_run(uuid, text, uuid, text, text, text) to service_role;
grant execute on function public.get_workspace_usage(text, uuid) to service_role;
