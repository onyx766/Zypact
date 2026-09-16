-- M7 step 4 — creating the retest protocol.
--
-- ── The contradiction inside 0047 this resolves ──────────────────────────
--
-- 0047 anticipates retest protocols: `baseline_protocol_id` is a self-FK
-- (line 212), with a composite FK on (baseline_protocol_id, project_id) so a
-- retest can never point across a tenant boundary. Its own header says "A
-- retest protocol references its own baseline via baseline_protocol_id".
--
-- But 0047 also carries:
--
--   create unique index protocols_one_active_per_version
--     on public.protocols (buyer_question_version_id)
--     where status in ('approved', 'active');
--
-- and NOTHING in migrations 0001-0072 ever moves a protocol off 'approved'.
-- `approve_protocol` (0047, fixed by 0049) is the only writer of
-- protocols.status and only performs draft -> approved. A baseline therefore
-- stays 'approved' permanently, and a same-question retest could never be
-- approved beside it: the index would reject it.
--
-- A same-question retest is the core mechanic of the V1 offer, so the index
-- as written forbids the product. The rule it was expressing — "a question
-- version maps to exactly one live protocol" — predates retest and was aimed
-- at baselines. Founder decision, 2026-09-16: narrow it rather than change
-- the baseline lifecycle.
--
-- The replacement expresses the same intent precisely:
--   * one live BASELINE per question version (baseline_protocol_id is null);
--   * at most one live RETEST per baseline.
--
-- Deliberately NOT done: a protocol completion transition. Completing a
-- baseline when its job succeeds would also free the index, but
-- `admit_and_reserve_attempt` refuses any protocol not in ('approved',
-- 'active'), so completion would block recovery and retry on a finished
-- baseline. That is a lifecycle change deserving its own migration and its
-- own analysis, not a side effect of enabling retest.
--
-- ── Identity preservation is the point ───────────────────────────────────
--
-- The retest reuses the baseline's `buyer_question_version_id` verbatim. Not
-- a copy of the text, not a new version — the same row. That is what makes it
-- a *same-question* retest, and it is why the index had to be narrowed rather
-- than sidestepped by minting a new question version, which would have
-- silently destroyed the comparison while appearing to work.
--
-- Provider, surface, model_config and paraphrase_plan are copied from the
-- baseline for the same reason. Any difference between the two phases is a
-- confounder, and 0074/step 8 surface configuration differences explicitly.
--
-- `planned_retest_runs` matches the baseline's `planned_baseline_runs`: the
-- signed-off comparison method assumes equal-sized phases, and an asymmetric
-- plan changes the detection threshold without anyone choosing to.
--
-- `minimum_useful_change` is stamped at 0.60 per the founder sign-off of
-- 2026-09-16 (OUTCOME_COMPARISON_PROPOSAL section 6.1). It is recorded on the
-- protocol, not hard-coded in the engine, so the value a given Outcome Card
-- was judged against is always recoverable from the row.
--
-- Rollback:
--   drop function if exists public.create_retest_protocol(uuid, uuid, uuid);
--   drop index if exists public.protocols_one_live_retest_per_baseline;
--   drop index if exists public.protocols_one_live_baseline_per_version;
--   create unique index if not exists protocols_one_active_per_version
--     on public.protocols (buyer_question_version_id)
--     where status in ('approved', 'active');
--
-- The index swap below is safe on existing data: every protocol created to
-- date has `baseline_protocol_id is null`, so the narrowed baseline index
-- covers exactly the same rows the old one did and cannot fail to build.

-- ---------------------------------------------------------------------
-- 1. Narrow the liveness rule
-- ---------------------------------------------------------------------

create unique index if not exists protocols_one_live_baseline_per_version
  on public.protocols (buyer_question_version_id)
  where status in ('approved', 'active')
    and baseline_protocol_id is null;

create unique index if not exists protocols_one_live_retest_per_baseline
  on public.protocols (baseline_protocol_id)
  where status in ('approved', 'active')
    and baseline_protocol_id is not null;

-- Dropped only after the replacements exist, so there is no instant in which
-- the liveness rule is unenforced.
drop index if exists public.protocols_one_active_per_version;

comment on index public.protocols_one_live_baseline_per_version is
  'Replaces 0047 protocols_one_active_per_version. Same rule, scoped to '
  'baselines: 0047 forbade the retest protocols its own schema anticipated.';

-- ---------------------------------------------------------------------
-- 2. create_retest_protocol
-- ---------------------------------------------------------------------

create or replace function public.create_retest_protocol(
  p_intervention_id uuid,
  p_project_id      uuid,
  p_approved_by     uuid
)
returns table (
  status_code        text,
  retest_protocol_id uuid
)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_intervention public.interventions%rowtype;
  v_baseline     public.protocols%rowtype;
  v_eligible     boolean;
  v_reason       text;
  v_new_id       uuid;
  v_approval     text;
begin
  if p_intervention_id is null or p_project_id is null or p_approved_by is null then
    raise exception using errcode = '22023', message = 'invalid_create_retest_protocol_args';
  end if;

  select i.* into v_intervention
    from public.interventions i
   where i.id = p_intervention_id
     and i.project_id = p_project_id
   for update;

  if not found then
    return query select 'INTERVENTION_NOT_FOUND'::text, null::uuid;
    return;
  end if;

  -- The gate. Called rather than reimplemented: 0072's retest_eligibility is
  -- the single authority, so this function and the screen the founder is
  -- looking at can never disagree about whether a retest may run.
  select e.eligible, e.reason
    into v_eligible, v_reason
    from public.retest_eligibility(p_intervention_id, p_project_id) e;

  if not v_eligible then
    return query select v_reason, null::uuid;
    return;
  end if;

  select p.* into v_baseline
    from public.protocols p
   where p.id = v_intervention.protocol_id
     and p.project_id = p_project_id
   for update;

  if not found then
    return query select 'BASELINE_NOT_FOUND'::text, null::uuid;
    return;
  end if;

  -- Idempotent replay. A second click must return the retest that exists, not
  -- mint a second one — and the partial unique index would reject the second
  -- anyway, turning a double submit into an error instead of a no-op.
  select p.id into v_new_id
    from public.protocols p
   where p.baseline_protocol_id = v_baseline.id
     and p.project_id = p_project_id
     and p.status in ('draft', 'approved', 'active')
   limit 1;

  if v_new_id is not null then
    return query select 'RETEST_ALREADY_EXISTS'::text, v_new_id;
    return;
  end if;

  -- A baseline that never planned any runs cannot be compared against.
  if v_baseline.planned_baseline_runs <= 0 then
    return query select 'BASELINE_HAS_NO_PLAN'::text, null::uuid;
    return;
  end if;

  insert into public.protocols (
    project_id,
    buyer_question_version_id,
    baseline_protocol_id,
    provider,
    surface,
    model_config,
    planned_baseline_runs,
    planned_retest_runs,
    paraphrase_plan,
    unit_of_analysis,
    primary_metric,
    minimum_useful_change,
    sample_planning_method,
    sample_planning_assumptions,
    run_cap,
    spend_cap_usd,
    time_window_seconds,
    rate_limit_per_hour,
    concurrency_limit,
    retry_cap,
    observation_window_rule,
    analyzer_version,
    entity_resolution_version,
    methodology_version
  ) values (
    p_project_id,
    -- The same row, never a copy: this is what makes it a same-question retest.
    v_baseline.buyer_question_version_id,
    v_baseline.id,
    v_baseline.provider,
    v_baseline.surface,
    v_baseline.model_config,
    -- This protocol runs no baseline of its own.
    0,
    v_baseline.planned_baseline_runs,
    v_baseline.paraphrase_plan,
    v_baseline.unit_of_analysis,
    v_baseline.primary_metric,
    jsonb_build_object(
      'value', 0.60,
      'metric', v_baseline.primary_metric,
      'comparison_method', 'newcombe_95',
      'source', 'founder_sign_off_2026_09_16'
    ),
    v_baseline.sample_planning_method,
    v_baseline.sample_planning_assumptions,
    v_baseline.run_cap,
    v_baseline.spend_cap_usd,
    v_baseline.time_window_seconds,
    v_baseline.rate_limit_per_hour,
    v_baseline.concurrency_limit,
    v_baseline.retry_cap,
    v_baseline.observation_window_rule,
    v_baseline.analyzer_version,
    v_baseline.entity_resolution_version,
    v_baseline.methodology_version
  )
  returning id into v_new_id;

  -- Approved through the existing RPC rather than by writing the status
  -- directly, so the retest passes exactly the same approval gate a baseline
  -- does, including the approved-question-version check.
  select a.status into v_approval
    from public.approve_protocol(v_new_id, p_project_id, p_approved_by) a;

  if v_approval <> 'APPROVED' then
    raise exception using
      errcode = 'P0001',
      message = format('unexpected_retest_protocol_approval_status:%s', v_approval);
  end if;

  return query select 'CREATED'::text, v_new_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. ACL
-- ---------------------------------------------------------------------

revoke all on function public.create_retest_protocol(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.create_retest_protocol(uuid, uuid, uuid)
  to service_role;
