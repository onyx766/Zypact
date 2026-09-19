-- M7 step 5 — retest execution, and the phase integrity it depends on.
--
-- ── Why this migration adds no job machinery ─────────────────────────────
--
-- Founder decision, 2026-09-16: a retest runs as a separate job reusing the
-- claim, lease and fencing primitives unchanged. Once 0073 made the retest
-- its OWN protocol row, that decision costs nothing to honour:
-- `enqueue_protocol_execution_job` already accepts any approved protocol and
-- keys its one-job-per-protocol rule on protocol_id, so a retest protocol
-- receives its own job through the existing, runtime-proven path. No new job
-- table, no new claim function, no change to a single fenced routine.
--
-- What does NOT come for free is phase integrity.
--
-- ── The hole this closes ─────────────────────────────────────────────────
--
-- `attempt_kind` is a caller-supplied parameter. `admit_and_reserve_attempt`
-- and `admit_and_reserve_attempt_for_job` validate it only against the closed
-- set ('baseline','retest','control','paraphrase') — nothing checks it against
-- the protocol it is being recorded for. So a worker that forgets to switch
-- kinds would happily write attempt_kind = 'baseline' onto a retest protocol,
-- and every layer above would accept it.
--
-- That failure is invisible and permanent. The attempts are real, the
-- evidence is real, the job succeeds, the report renders — and the retest's
-- runs are labelled as baseline runs. Any later comparison that separates
-- phases by attempt_kind silently compares a baseline against itself, and the
-- Outcome Card it produces is not merely wrong but confidently wrong. Nothing
-- downstream could detect it, because there is no inconsistency left to find.
--
-- A BEFORE INSERT trigger is used rather than a CHECK constraint because the
-- rule spans two tables: the legal kinds depend on whether the attempt's
-- protocol carries a baseline_protocol_id. It is deliberately placed on
-- `protocol_attempts` rather than inside the admit RPCs, so it also binds the
-- M4 raw RPCs that remain granted to service_role until the cutover ships —
-- the writers most likely to be forgotten.
--
-- Retries are unaffected: 0051's retry paths copy `v_source.attempt_kind` from
-- the attempt being retried, which by induction already satisfies the rule.
--
-- ── protocol_execution_phase ─────────────────────────────────────────────
--
-- The worker needs to know which kind to pass. Deriving it worker-side from
-- "does this protocol have a baseline_protocol_id" would put the phase rule in
-- two places, and the trigger above would then be discovered by a production
-- failure rather than consulted. One read-only function answers it, and the
-- trigger enforces the same predicate, so the worker cannot be subtly wrong.
--
-- Rollback:
--   drop function if exists public.protocol_execution_phase(uuid, uuid);
--   drop trigger if exists protocol_attempts_phase_matches_protocol
--     on public.protocol_attempts;
--   drop function if exists public._assert_attempt_kind_matches_phase();
--
-- Nothing here mutates a row. Existing attempts are not revalidated: the
-- trigger is BEFORE INSERT only, deliberately, so applying this migration
-- cannot fail on historical data and cannot rewrite it.

-- ---------------------------------------------------------------------
-- 1. Phase integrity on every attempt insert
-- ---------------------------------------------------------------------

create or replace function public._assert_attempt_kind_matches_phase()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_retest boolean;
begin
  select (p.baseline_protocol_id is not null)
    into v_is_retest
    from public.protocols p
   where p.id = new.protocol_id;

  if not found then
    -- The FK will refuse this insert on its own; say nothing extra.
    return new;
  end if;

  if v_is_retest and new.attempt_kind <> 'retest' then
    raise exception using
      errcode = 'P0001',
      message = 'attempt_kind_must_be_retest_on_a_retest_protocol';
  end if;

  if (not v_is_retest) and new.attempt_kind = 'retest' then
    raise exception using
      errcode = 'P0001',
      message = 'attempt_kind_retest_requires_a_retest_protocol';
  end if;

  return new;
end;
$$;

drop trigger if exists protocol_attempts_phase_matches_protocol on public.protocol_attempts;
create trigger protocol_attempts_phase_matches_protocol
  before insert on public.protocol_attempts
  for each row execute function public._assert_attempt_kind_matches_phase();

-- ---------------------------------------------------------------------
-- 2. protocol_execution_phase — the worker's single source for the kind
-- ---------------------------------------------------------------------

create or replace function public.protocol_execution_phase(
  p_protocol_id uuid,
  p_project_id  uuid
)
returns table (
  phase                text,
  attempt_kind         text,
  planned_runs         integer,
  baseline_protocol_id uuid
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v public.protocols%rowtype;
begin
  select p.* into v
    from public.protocols p
   where p.id = p_protocol_id
     and p.project_id = p_project_id;

  if not found then
    return;
  end if;

  if v.baseline_protocol_id is not null then
    return query select 'retest'::text, 'retest'::text,
                        v.planned_baseline_runs, v.baseline_protocol_id;
  else
    return query select 'baseline'::text, 'baseline'::text,
                        v.planned_baseline_runs, null::uuid;
  end if;
end;
$$;

comment on function public.protocol_execution_phase(uuid, uuid) is
  'The phase of a protocol and the attempt_kind its attempts must carry. '
  'planned_runs is planned_baseline_runs for both phases: that column is the '
  'protocol''s planned run count and the only one the 0051/0052 slot '
  'machinery reads.';

-- ---------------------------------------------------------------------
-- 3. ACL
-- ---------------------------------------------------------------------

revoke all on function public.protocol_execution_phase(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.protocol_execution_phase(uuid, uuid)
  to service_role;

revoke all on function public._assert_attempt_kind_matches_phase()
  from public, anon, authenticated;
