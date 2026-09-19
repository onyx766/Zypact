-- An intervention is registered against a baseline, never against a retest.
--
-- 0071's register_intervention checks that the protocol exists in the
-- project and is approved, active or completed. A retest protocol passes all
-- three: create_retest_protocol (0073) approves it at creation, and it
-- completes when its runs finish. Registering an intervention against one
-- would let create_retest_protocol build a retest OF THAT RETEST — its
-- baseline_protocol_id pointing at the first retest — and the Outcome Card
-- would then compare against the first retest as though it were the
-- baseline.
--
-- Nothing in the canonical V1 scope describes chained retests. V1 is one
-- intervention hypothesis per baseline, compared against that baseline. The
-- founder route already refuses this (`not_a_baseline`, Phase 2); this
-- migration makes the database refuse it too, so no other caller of the RPC
-- can reach the state.
--
-- Registration is the single entry point that matters. An intervention's
-- protocol_id cannot change after insert: service_role has no UPDATE on
-- interventions, and 0072's trigger freezes protocol_id once approved. So a
-- guard here closes the path without touching create_retest_protocol.
--
-- Staging held zero interventions when this was written (CURRENT_STATUS
-- 16.1), so no existing row can be in the state being forbidden. The final
-- block checks that rather than assuming it.
--
-- Rollback: re-apply 0071's register_intervention body. The signature is
-- unchanged, so grants survive either way.


-- ---------------------------------------------------------------------
-- 1. No existing intervention is already chained
-- ---------------------------------------------------------------------

do $$
declare
  v_chained bigint;
begin
  select count(*) into v_chained
    from public.interventions i
    join public.protocols p on p.id = i.protocol_id
   where p.baseline_protocol_id is not null;

  if v_chained > 0 then
    raise exception using
      errcode = 'P0001',
      message = format(
        '0078 precondition failed: %s intervention(s) already registered against a retest protocol. Resolve them before applying.',
        v_chained
      );
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- 2. register_intervention — 0071's body, plus one check
-- ---------------------------------------------------------------------

-- Same signature as 0071, so `create or replace` replaces rather than adds an
-- overload, and the existing grants are preserved.
create or replace function public.register_intervention(
  p_project_id                uuid,
  p_protocol_id               uuid,
  p_hypothesis                text,
  p_expected_mechanism        text,
  p_action_type               text,
  p_action_target             text,
  p_owner                     text,
  p_supporting_evidence       jsonb,
  p_alternative_explanations  text default null,
  p_confounders_to_monitor    text default null,
  p_decision_threshold_note   text default null,
  p_implementation_deadline   timestamptz default null,
  p_expected_observation_days integer default null
)
returns setof public.interventions
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_protocol public.protocols%rowtype;
  v_result public.interventions%rowtype;
begin
  if p_project_id is null or p_protocol_id is null then
    raise exception using errcode = '22023', message = 'invalid_intervention_identity';
  end if;

  if p_supporting_evidence is null
     or jsonb_typeof(p_supporting_evidence) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_supporting_evidence_shape';
  end if;

  -- Lock the baseline: its identity is what this intervention is registered
  -- against, and it must not move underneath the insert.
  select p.* into v_protocol
    from public.protocols p
   where p.id = p_protocol_id
     and p.project_id = p_project_id
   for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'protocol_not_found';
  end if;

  -- 0078. Checked before executability, so a retest protocol is refused for
  -- what it is rather than for a status it happens to have.
  if v_protocol.baseline_protocol_id is not null then
    raise exception using errcode = 'P0001', message = 'protocol_is_not_a_baseline';
  end if;

  -- An intervention responds to evidence. A protocol that has not been
  -- approved has produced none.
  if v_protocol.status not in ('approved', 'active', 'completed') then
    raise exception using errcode = 'P0001', message = 'protocol_not_executable';
  end if;

  insert into public.interventions (
    project_id, protocol_id, buyer_question_version_id,
    status,
    hypothesis, expected_mechanism, action_type, action_target, owner,
    supporting_evidence, alternative_explanations, confounders_to_monitor,
    decision_threshold_note, implementation_deadline, expected_observation_days
  ) values (
    p_project_id, p_protocol_id, v_protocol.buyer_question_version_id,
    'proposed',
    p_hypothesis, p_expected_mechanism, p_action_type, p_action_target, p_owner,
    p_supporting_evidence, p_alternative_explanations, p_confounders_to_monitor,
    p_decision_threshold_note, p_implementation_deadline, p_expected_observation_days
  )
  returning * into v_result;

  return next v_result;
end;
$$;


-- ---------------------------------------------------------------------
-- 3. ACL — restated, not changed
-- ---------------------------------------------------------------------

revoke all on function public.register_intervention(
  uuid, uuid, text, text, text, text, text, jsonb, text, text, text, timestamptz, integer
) from public, anon, authenticated;
grant execute on function public.register_intervention(
  uuid, uuid, text, text, text, text, text, jsonb, text, text, text, timestamptz, integer
) to service_role;
