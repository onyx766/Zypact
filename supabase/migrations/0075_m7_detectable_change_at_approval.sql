-- M7 step 6 — power shown at approval.
--
-- OUTCOME_COMPARISON_PROPOSAL.md section 5, a CONDITION of the founder's
-- 2026-09-16 sign-off, not an optional enhancement: "If a protocol's plan
-- cannot detect the Δ_min being approved, that must be visible on the
-- approval screen, before any money is spent." Signed-off text: "approve_
-- protocol computes and stores the smallest detectable change for the
-- approved plan."
--
-- ── Why the math is duplicated into SQL rather than supplied by the app ──
--
-- lib/reports/compare-protocols.ts already implements this exact search —
-- smallestDetectableChange(n1, n2) — tested against the founder-signed-off
-- table (60/40/27/25/17 points at n=5/10/15/20/30). The natural instinct is
-- to compute it once there and pass the result into a create/approve call.
--
-- That does not fit how a protocol actually gets approved. The real V1
-- customer path is `approve_and_launch_snapshot_baseline` (0062/0063/0069):
-- one PL/pgSQL function that INSERTs the protocol and calls
-- `approve_protocol` on it in the same transaction, with no TypeScript step
-- in between where a caller-supplied value could be threaded through. The
-- signed-off proposal text itself says `approve_protocol` does the
-- computing, and that is honoured here rather than substituted with a
-- lighter-weight design of this migration's own invention.
--
-- `_smallest_detectable_change` therefore duplicates the TS search in
-- PL/pgSQL, deliberately mirrored operation-for-operation against
-- lib/reports/compare-protocols.ts (same Wilson-then-Newcombe construction,
-- same WILSON_Z constant, same loop structure) so the two are easy to
-- compare side by side and hard to let drift silently apart. It is verified
-- by its own runtime contract against the IDENTICAL signed-off table the TS
-- version is tested against — text review cannot prove a trigger fires or a
-- search converges; only a running Postgres can, and the 0073 run-count bug
-- is the concrete reason this project does not trust arithmetic it has not
-- run.
--
-- ── Why n1 = n2 = planned_baseline_runs, for BOTH a baseline and a retest ──
--
-- At the moment ANY protocol is approved — baseline or retest — its own
-- `planned_baseline_runs` already tells the whole story: 0073's
-- create_retest_protocol copies a baseline's planned_baseline_runs verbatim
-- into its retest's planned_baseline_runs (never planned_retest_runs — see
-- that migration's own header for why), so a baseline and its eventual
-- retest are symmetric by construction, not by assumption. Computing
-- `_smallest_detectable_change(planned_baseline_runs, planned_baseline_runs)`
-- is therefore the honest answer at BASELINE-approval time (before any
-- retest protocol exists) and remains correct, unchanged, when this same
-- code runs again for the RETEST protocol's own approval inside
-- create_retest_protocol. No special-casing by phase is needed anywhere in
-- this migration.
--
-- ── What this migration does not do ──
--
-- It does not surface the value on any approval screen — that is an
-- application-layer follow-up, deliberately out of scope for a migration.
-- It does not change any status code, control-flow branch, or grant that
-- 0069/0073 depend on: approve_protocol keeps its exact (uuid, uuid, uuid)
-- signature, so every existing caller is unaffected by create-or-replace.
--
-- Rollback:
--   create or replace [approve_protocol body restored to 0049's, verbatim]
--   drop function if exists public._smallest_detectable_change(integer, integer);
--   alter table public.protocols
--     drop constraint if exists protocols_detectable_change_bounds_check,
--     drop column if exists detectable_change_at_plan;
--
-- The column is nullable and additive; no existing protocol row is touched
-- by this migration (no UPDATE, no backfill), so a rollback destroys
-- nothing — every already-approved protocol simply keeps
-- detectable_change_at_plan = null, exactly as it is today.

-- ---------------------------------------------------------------------
-- 1. The disclosure column
-- ---------------------------------------------------------------------

alter table public.protocols
  add column if not exists detectable_change_at_plan double precision null;

alter table public.protocols
  drop constraint if exists protocols_detectable_change_bounds_check;
alter table public.protocols
  add constraint protocols_detectable_change_bounds_check check (
    detectable_change_at_plan is null
    or (detectable_change_at_plan >= 0 and detectable_change_at_plan <= 1)
  );

comment on column public.protocols.detectable_change_at_plan is
  'Smallest |Δ| a same-sized baseline/retest pair at this plan could ever '
  'separate from zero (Newcombe 95%), computed and stored by approve_protocol '
  'at the moment of approval. Null for any protocol approved before this '
  'column existed. Mirrors lib/reports/compare-protocols.ts '
  'smallestDetectableChange(n, n) — see that file for the tested, '
  'signed-off table this must reproduce.';

-- ---------------------------------------------------------------------
-- 2. _smallest_detectable_change — mirrors compare-protocols.ts exactly
-- ---------------------------------------------------------------------

create or replace function public._smallest_detectable_change(
  p_n1 integer,
  p_n2 integer
)
returns double precision
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  -- lib/reports/build-protocol-report.ts WILSON_Z. Two-sided 95%.
  z  constant double precision := 1.959963984540054;
  z2 constant double precision := z * z;

  v_best double precision := null;
  v_k1 integer;
  v_k2 integer;

  -- Baseline-side Wilson bounds, recomputed once per v_k1 (not once per
  -- (v_k1, v_k2) pair, unlike the TS version's newcombeInterval, which
  -- recomputes both sides on every call) — a performance difference only,
  -- never a correctness one: the value at a given (k, n) is the same
  -- closed-form expression either way.
  v_p1 double precision;
  v_denom1 double precision;
  v_center1 double precision;
  v_margin1 double precision;
  v_w1_low double precision;
  v_w1_high double precision;

  v_p2 double precision;
  v_denom2 double precision;
  v_center2 double precision;
  v_margin2 double precision;
  v_w2_low double precision;
  v_w2_high double precision;

  v_delta double precision;
  v_lo double precision;
  v_hi double precision;
  v_magnitude double precision;
begin
  if p_n1 is null or p_n2 is null or p_n1 <= 0 or p_n2 <= 0 then
    return null;
  end if;

  for v_k1 in 0..p_n1 loop
    v_p1 := v_k1::double precision / p_n1;
    v_denom1 := 1 + z2 / p_n1;
    v_center1 := (v_p1 + z2 / (2 * p_n1)) / v_denom1;
    v_margin1 := (z / v_denom1) * sqrt(
      (v_p1 * (1 - v_p1)) / p_n1 + z2 / (4 * p_n1 * p_n1)
    );
    v_w1_low := greatest(0, v_center1 - v_margin1);
    v_w1_high := least(1, v_center1 + v_margin1);

    for v_k2 in 0..p_n2 loop
      v_p2 := v_k2::double precision / p_n2;
      v_denom2 := 1 + z2 / p_n2;
      v_center2 := (v_p2 + z2 / (2 * p_n2)) / v_denom2;
      v_margin2 := (z / v_denom2) * sqrt(
        (v_p2 * (1 - v_p2)) / p_n2 + z2 / (4 * p_n2 * p_n2)
      );
      v_w2_low := greatest(0, v_center2 - v_margin2);
      v_w2_high := least(1, v_center2 + v_margin2);

      -- Newcombe's hybrid-score interval (method 10) for p2 - p1, built
      -- from the two Wilson bounds above. Direct multiplication for the
      -- square terms, not power(x, 2): the same choice compare-protocols.ts
      -- makes, so both implementations run the identical arithmetic rather
      -- than risking a libm pow() and a JS ** operator disagreeing in the
      -- last bit at some (k1, k2) pair.
      v_delta := v_p2 - v_p1;
      v_lo := v_delta - sqrt(
        (v_p2 - v_w2_low) * (v_p2 - v_w2_low) +
        (v_w1_high - v_p1) * (v_w1_high - v_p1)
      );
      v_hi := v_delta + sqrt(
        (v_w2_high - v_p2) * (v_w2_high - v_p2) +
        (v_p1 - v_w1_low) * (v_p1 - v_w1_low)
      );
      v_lo := greatest(-1, v_lo);
      v_hi := least(1, v_hi);

      if v_lo > 0 or v_hi < 0 then
        v_magnitude := abs(v_p2 - v_p1);
        if v_best is null or v_magnitude < v_best then
          v_best := v_magnitude;
        end if;
      end if;
    end loop;
  end loop;

  return v_best;
end;
$$;

revoke all on function public._smallest_detectable_change(integer, integer)
  from public, anon, authenticated;
grant execute on function public._smallest_detectable_change(integer, integer)
  to service_role;

-- ---------------------------------------------------------------------
-- 3. approve_protocol — same signature, now also computes and stores it
-- ---------------------------------------------------------------------

create or replace function
  public.approve_protocol(
    p_protocol_id uuid,
    p_project_id uuid,
    p_approved_by uuid
  )
returns table (
  status   text,
  protocol public.protocols
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_row public.protocols%rowtype;
  v_version public.buyer_question_versions%rowtype;
begin
  if p_protocol_id is null or p_project_id is null or p_approved_by is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_approve_protocol_args';
  end if;

  select p.* into v_row
    from public.protocols p
   where p.id = p_protocol_id and p.project_id = p_project_id
   for update;

  if not found then
    return query select 'NOT_FOUND'::text, null::public.protocols;
    return;
  end if;

  if v_row.status in ('approved', 'active', 'completed') then
    return query select 'ALREADY_APPROVED'::text, v_row;
    return;
  end if;

  if v_row.status = 'abandoned' then
    return query select 'CONFLICT'::text, v_row;
    return;
  end if;

  select bqv.* into v_version
    from public.buyer_question_versions bqv
   where bqv.id = v_row.buyer_question_version_id
     and bqv.project_id = p_project_id;

  if v_version.approved_at is null then
    return query select 'VERSION_NOT_APPROVED'::text, v_row;
    return;
  end if;

  update public.protocols pr
     set status = 'approved',
         approved_by = p_approved_by,
         approved_at = now(),
         -- Section 3 above: symmetric by construction for both a baseline
         -- and a retest protocol, so no phase branch is needed here.
         detectable_change_at_plan =
           public._smallest_detectable_change(
             pr.planned_baseline_runs, pr.planned_baseline_runs
           ),
         updated_at = now()
   where pr.id = p_protocol_id
     and pr.project_id = p_project_id
     and pr.status = 'draft'
  returning pr.* into v_row;

  return query select 'APPROVED'::text, v_row;
end;
$$;

revoke all on function
  public.approve_protocol(uuid, uuid, uuid) from public;
revoke all on function
  public.approve_protocol(uuid, uuid, uuid) from anon;
revoke all on function
  public.approve_protocol(uuid, uuid, uuid) from authenticated;
grant execute on function
  public.approve_protocol(uuid, uuid, uuid) to service_role;
