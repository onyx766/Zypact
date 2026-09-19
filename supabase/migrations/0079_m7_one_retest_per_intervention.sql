-- One retest per registered intervention.
--
-- 0073's create_retest_protocol is idempotent: a second call returns the
-- retest that already exists instead of minting another. But its lookup only
-- recognised a retest in 'draft', 'approved' or 'active'. Once a retest's
-- runs finished and its protocol moved to 'completed', the lookup no longer
-- found it — and because the intervention stays 'implemented' and its window
-- stays elapsed, retest_eligibility still said yes. A second call therefore
-- created a SECOND retest for the same intervention.
--
-- That is re-measurement until the result is welcome: read a completed
-- retest, dislike it, run another. It is the same outcome-switching that 0077
-- closed for abandonment, reached by a different path, and it defeats the
-- word "registered" in Registered Retest — the claim is fixed in advance so
-- that ONE measurement answers it.
--
-- The fix widens the idempotency lookup to include 'completed'. A completed
-- retest is now returned as RETEST_ALREADY_EXISTS, never replaced. Only
-- 'abandoned' retests are passed over, and 0077 refuses abandonment once any
-- attempt exists, so an abandoned retest is guaranteed to have observed
-- nothing.
--
-- A consequence the application relies on: every baseline has at most one
-- non-abandoned retest protocol. A new retest needs a new intervention; a new
-- intervention needs the baseline's slot, which 0071 holds for any
-- proposed/approved/implemented intervention; and an implemented intervention
-- can only release it by abandonment, which also abandons its retest.
-- lib/reports/deliver-outcome-card.ts resolves an intervention's retest on
-- exactly that basis.
--
-- 0073's body is reused verbatim except for that one predicate. Same
-- signature, so the function is replaced rather than overloaded and its
-- grants survive.
--
-- Rollback: re-apply 0073's create_retest_protocol body. No data is written
-- by this migration, so there is nothing else to undo.


-- ---------------------------------------------------------------------
-- 1. Precondition: no intervention already has two live-or-finished retests
-- ---------------------------------------------------------------------

do $$
declare
  v_doubled bigint;
begin
  select count(*) into v_doubled
    from (
      select baseline_protocol_id
        from public.protocols
       where baseline_protocol_id is not null
         and status <> 'abandoned'
       group by baseline_protocol_id
      having count(*) > 1
    ) d;

  if v_doubled > 0 then
    raise exception using
      errcode = 'P0001',
      message = format(
        '0079 precondition failed: %s baseline(s) already have more than one non-abandoned retest protocol. Resolve them before applying.',
        v_doubled
      );
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- 2. create_retest_protocol — 0073's body, one predicate widened
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
     -- 0079: 'completed' is included. Excluding it let a finished retest be
     -- followed by a fresh one for the same intervention — re-measurement
     -- until the result is welcome. Only 'abandoned' is excluded, and 0077
     -- guarantees an abandoned retest observed nothing.
     and p.status in ('draft', 'approved', 'active', 'completed')
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
    -- `planned_baseline_runs` is this protocol's planned run count, whichever
    -- phase it belongs to — the slot machinery in 0051/0052 reads no other
    -- column. Writing 0 here and putting the count in planned_retest_runs
    -- would look tidier and produce a protocol that can never execute:
    -- enqueue_protocol_execution_job refuses planned_baseline_runs = 0 with
    -- NO_BASELINE_RUNS_PLANNED, and next_baseline_ordinal / baseline_ordinal
    -- would have nothing to count against. The phase is carried by
    -- baseline_protocol_id, not by which column holds the number.
    --
    -- Matching the baseline's count exactly is also what keeps the comparison
    -- honest: the signed-off method assumes equal-sized phases, and an
    -- asymmetric plan would move the detection threshold with nobody
    -- choosing to.
    v_baseline.planned_baseline_runs,
    0,
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
-- 3. ACL — restated, not changed
-- ---------------------------------------------------------------------

revoke all on function public.create_retest_protocol(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.create_retest_protocol(uuid, uuid, uuid)
  to service_role;
