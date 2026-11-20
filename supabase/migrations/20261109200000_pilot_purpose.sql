-- Pilot purpose: a customer pilot or an internal practice run (pilot report clarity).
--
-- Purpose. A pilot the Zypact team runs on itself to practise the workflow
-- must never read as a confirmed paying customer's report. This records who a
-- pilot is for, and the pilot report says "Internal practice run" at the top
-- of a practice run's report (lib/reports/build-pilot-report.ts). Nothing is
-- measured differently: the column only labels the report.
--
-- Release order (D-058 item 4). Numbered inside D-058's window, after
-- 20261109190000 and before 20261110120000, so it is applied in numeric order
-- before the unapplied stack 20261110120000-20261113120000. Through the
-- named-file procedure: expected_prev=20261109190000. Apply with no Run
-- pending and no job holding a live lease: the ALTER TABLE takes a short
-- ACCESS EXCLUSIVE lock on public.pilots, which a Run's pilot row lock would
-- make it wait for. The web app built from the same commit is deployed after
-- this migration (until then the report reader finds no column, reads the
-- purpose as unknown and holds the report for review). The worker image is
-- unchanged. It references nothing created by the unapplied stack.
--
-- Dependencies. 20261109140000 (public.pilots) and 20261109190000 (the pilot
-- retest, the previous migration in the window).
--
-- What it changes:
--   1. public.pilots gains `purpose` ('customer' or 'internal_practice',
--      not null, default 'customer'), and `purpose_set_by` / `purpose_set_at`,
--      both null until the purpose is first set, then both set. Every
--      existing pilot reads 'customer'. Adding a column with a constant
--      default rewrites no row.
--   2. public.set_pilot_purpose(pilot, set_by, purpose): one transaction
--      under the pilot row lock; records who set it and when. It works on a
--      closed pilot too, because it changes no measurement, no evidence and
--      no stored report revision (a revision keeps the purpose it was built
--      with). service_role only.
--
-- What it leaves alone. No function is redefined, so no pinned function
-- changes. No row of any other table is touched, nothing calls a provider,
-- and no grant on public.pilots changes (service_role may still only read it).
--
-- Recovery.
--   * Before any pilot is set to 'internal_practice': drop the function and
--     the three columns and their checks, then delete the ledger row
--     20261109200000. Nothing else depends on them.
--   * After a pilot is set: the same, but first record which pilots were
--     practice runs (select id, purpose, purpose_set_by, purpose_set_at from
--     public.pilots where purpose <> 'customer'), because dropping the column
--     loses that label. Stored report revisions keep the label they were
--     built with either way. Forward recovery (a corrective migration) is
--     preferred once the web app reads the column.
--
-- Preconditions (each its own block; any failure aborts the transaction):
-- 20261109190000 is applied; none of the objects created here exists.

do $precondition$
begin
  if to_regclass('public.pilot_retests') is null
     or to_regprocedure('public.prepare_pilot_retests(uuid,uuid,uuid)') is null then
    raise exception using
      errcode = 'P0001',
      message = '20261109200000 precondition: 20261109190000 is not applied (the pilot retest tables or functions are missing)';
  end if;
end
$precondition$;

do $precondition$
begin
  if exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'pilots'
          and column_name in ('purpose', 'purpose_set_by', 'purpose_set_at'))
     or exists (
       select 1 from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.proname = 'set_pilot_purpose') then
    raise exception using
      errcode = 'P0001',
      message = '20261109200000 precondition: a pilot purpose column or set_pilot_purpose already exists';
  end if;
end
$precondition$;

-- =======================================================================
-- 1. The columns
-- =======================================================================

alter table public.pilots
  add column purpose text not null default 'customer',
  add column purpose_set_by uuid null,
  add column purpose_set_at timestamptz null;

alter table public.pilots
  add constraint pilots_purpose_check check (purpose in ('customer', 'internal_practice')),
  add constraint pilots_purpose_set_check check ((purpose_set_by is null) = (purpose_set_at is null));

comment on column public.pilots.purpose is
  'Who the pilot is for: customer, or internal_practice (a Zypact practice run, labelled as such on its report).';

-- =======================================================================
-- 2. Set a pilot's purpose
-- =======================================================================

create or replace function public.set_pilot_purpose(
    p_pilot_id uuid,
    p_set_by uuid,
    p_purpose text
  )
returns table (
  outcome text
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_pilot public.pilots%rowtype;
begin
  if p_pilot_id is null or p_set_by is null
     or p_purpose is null or p_purpose not in ('customer', 'internal_practice') then
    raise exception using
      errcode = '22023',
      message = 'invalid_set_pilot_purpose_args';
  end if;

  select p.* into v_pilot
    from public.pilots p
   where p.id = p_pilot_id
   for update;

  if not found then
    return query select 'PILOT_NOT_FOUND'::text;
    return;
  end if;

  if v_pilot.purpose = p_purpose then
    return query select 'UNCHANGED'::text;
    return;
  end if;

  update public.pilots
     set purpose = p_purpose,
         purpose_set_by = p_set_by,
         purpose_set_at = now()
   where id = p_pilot_id;

  return query select 'SET'::text;
end;
$$;

revoke all on function public.set_pilot_purpose(uuid, uuid, text) from public;
revoke all on function public.set_pilot_purpose(uuid, uuid, text) from anon;
revoke all on function public.set_pilot_purpose(uuid, uuid, text) from authenticated;
grant execute on function public.set_pilot_purpose(uuid, uuid, text) to service_role;
