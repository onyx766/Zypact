-- M2 tranche 3 hotfix — fixes a PL/pgSQL column-ambiguity bug in
-- resolve_and_record_entity_observation, discovered running the real
-- historical backfill (scripts/backfill-entity-observations.ts)
-- against staging for the first time. Neither RPC had ever executed
-- against a real Postgres before that attempt — only against the
-- in-memory adapter's reimplementation — so this class of bug was
-- structurally invisible to every prior test in this tranche.
--
-- Root cause: a PL/pgSQL function's own `RETURNS TABLE(col1 type1,
-- ...)` clause implicitly declares col1, col2, ... as PL/pgSQL
-- variables, in scope for the entire function body — exactly like OUT
-- parameters. resolve_and_record_entity_observation's RETURNS TABLE
-- declares `observation_generation` and `alias_generation` among its
-- output columns; entity_observations.observation_generation and
-- entity_aliases.alias_generation are real columns of those same
-- names. Any SQL statement inside the function body that referenced
-- either column name WITHOUT a table qualifier was therefore
-- ambiguous between "the table column" and "the implicit output
-- variable" — Postgres raises 22P02/42702
-- ("column reference ... is ambiguous") rather than guessing. The
-- observed failure was specifically:
--
--   insert into public.entity_observations (...)
--   values (...)
--   returning id, observation_generation into v_observation_id, v_observation_generation;
--
-- which failed with exactly:
--   column reference "observation_generation" is ambiguous | code=42702
--   | details=It could refer to either a PL/pgSQL variable or a table column.
--
-- Fix: every SELECT/WHERE/UPDATE/INSERT/RETURNING clause in both
-- functions now qualifies every table column with an explicit range
-- alias, closing off this entire class of ambiguity — not just the
-- one statement that happened to fail first. This includes
-- entity_aliases.alias_generation's ORDER BY/RETURNING sites, which
-- share the identical risk but had not yet been reached/observed to
-- fail (the transaction always aborted at the observation insert
-- first, rolling back any alias write attempted moments earlier in
-- the same call).
--
-- Audit of start_or_resume_entity_resolution_pass (as requested,
-- "même si elle n'a pas encore échoué"): its own RETURNS TABLE columns
-- are `resolution_pass_id`, `pass_status`, `pass_outcome`. No table
-- this function queries (entity_resolution_passes, dataset_batches,
-- probe_results, entity_brand_snapshots) has a column literally named
-- any of those three — entity_resolution_passes has `id` and `status`,
-- not `resolution_pass_id`/`pass_status`. So this function has never
-- been at risk of the SAME ambiguity class, which matches its observed
-- behavior: every call to it, across every attempt on staging so far,
-- has succeeded. It is nonetheless rewritten here with the identical
-- defensive table-aliasing discipline, purely so that adding a future
-- RETURNS TABLE column whose name happens to collide with a real
-- column can never silently reintroduce this bug class unqualified.
--
-- What this migration does NOT do:
--   * Does not change either function's public signature (parameter
--     names, parameter types, or RETURNS TABLE column names/types) —
--     CREATE OR REPLACE FUNCTION with an identical signature preserves
--     the function's OID, so ownership and existing grants survive
--     this replacement unchanged. The REVOKE/GRANT block below is
--     reissued anyway, verbatim, as an explicit assertion of that end
--     state rather than an assumption about CREATE OR REPLACE's own
--     behavior.
--   * Does not change SECURITY DEFINER, search_path, or volatility.
--   * Does not create, alter, or drop any table, column, constraint,
--     index, view, or RLS policy.
--   * Does not touch entity_resolution_passes' abandoned/in_progress
--     rows already on staging, or any other data — this migration
--     writes no data itself; the functions still write nothing until
--     called.
--   * Does not touch migrations 0001 through 0042 in any way.
--   * Does not alter any table-level privilege — 0041 already fixed
--     the final table/view privilege state; this migration only
--     touches these two functions' own EXECUTE grants, reasserted
--     identically to 0042.

create or replace function
  public.start_or_resume_entity_resolution_pass(
    p_project_id             uuid,
    p_probe_result_id        uuid,
    p_resolver_version       integer,
    p_dataset_id             uuid,
    p_expected_mention_count integer,
    p_company_name           text,
    p_domain                 text,
    p_normalized_brand_terms text[],
    p_mirror_aliases         text[] default '{}',
    p_stale_after            interval default '15 minutes'
  )
returns table (
  resolution_pass_id uuid,
  pass_status text,
  pass_outcome text
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_now                 timestamptz := clock_timestamp();
  v_dataset_source_type  text;
  v_existing             public.entity_resolution_passes%rowtype;
  v_brand_snapshot       public.entity_brand_snapshots%rowtype;
  v_brand_snapshot_id    uuid;
  v_new_id               uuid;
  v_new_status           text;
begin
  if p_project_id is null or p_probe_result_id is null or p_resolver_version is null
     or p_dataset_id is null or p_expected_mention_count is null then
    raise exception using errcode = '22023', message = 'missing_required_parameter';
  end if;

  if p_resolver_version < 1 then
    raise exception using errcode = '22023', message = 'invalid_resolver_version';
  end if;

  if p_expected_mention_count < 0 then
    raise exception using errcode = '22023', message = 'invalid_expected_mention_count';
  end if;

  if p_stale_after is null or p_stale_after <= interval '0' then
    raise exception using errcode = '22023', message = 'invalid_stale_after';
  end if;

  if p_company_name is null or length(trim(p_company_name)) = 0 then
    raise exception using errcode = '22023', message = 'empty_company_name';
  end if;

  if p_domain is null or length(trim(p_domain)) = 0 then
    raise exception using errcode = '22023', message = 'empty_domain';
  end if;

  if p_normalized_brand_terms is null
     or coalesce(array_length(p_normalized_brand_terms, 1), 0) = 0 then
    raise exception using errcode = '22023', message = 'empty_normalized_brand_terms';
  end if;

  if exists (
    select 1 from unnest(p_normalized_brand_terms) as term
     where term is null or length(trim(term)) = 0
  ) then
    raise exception using errcode = '22023', message = 'blank_normalized_brand_term';
  end if;

  -- mirror_aliases: non-null required, but an empty array is explicitly
  -- allowed (a project may genuinely have no known aliases yet)
  if p_mirror_aliases is null then
    raise exception using errcode = '22023', message = 'null_mirror_aliases';
  end if;

  if exists (
    select 1 from unnest(p_mirror_aliases) as alias
     where alias is null or length(trim(alias)) = 0
  ) then
    raise exception using errcode = '22023', message = 'blank_mirror_alias';
  end if;

  if not exists (
    select 1 from public.probe_results pr
     where pr.id = p_probe_result_id and pr.project_id = p_project_id
  ) then
    raise exception using errcode = '22023', message = 'probe_result_project_mismatch';
  end if;

  select dsb.dataset_source_type
    into v_dataset_source_type
    from public.dataset_batches dsb
   where dsb.id = p_dataset_id
     and dsb.project_id = p_project_id;

  if not found then
    raise exception using errcode = '22023', message = 'dataset_project_mismatch';
  end if;

  <<retry_loop>>
  loop
    -- 1. lock any existing completed/in_progress row for this exact key
    select erp.*
      into v_existing
      from public.entity_resolution_passes erp
     where erp.probe_result_id = p_probe_result_id
       and erp.resolver_version = p_resolver_version
       and erp.status in ('completed', 'in_progress')
     for update;

    if found then
      -- exact-match verification under lock (correction turn, point 2)
      if v_existing.project_id <> p_project_id
         or v_existing.probe_result_id <> p_probe_result_id
         or v_existing.dataset_id <> p_dataset_id
         or v_existing.dataset_source_type <> v_dataset_source_type
         or v_existing.resolver_version <> p_resolver_version
         or v_existing.expected_mention_count <> p_expected_mention_count then
        raise exception using errcode = '22023', message = 'pass_parameter_mismatch';
      end if;

      if v_existing.status = 'completed' then
        return query select v_existing.id, v_existing.status, 'ALREADY_COMPLETED'::text;
        return;
      end if;

      -- status = 'in_progress'
      if v_now - v_existing.last_activity_at <= p_stale_after then
        update public.entity_resolution_passes erp2
           set last_activity_at = v_now
         where erp2.id = v_existing.id;
        return query select v_existing.id, 'in_progress'::text, 'RESUMED'::text;
        return;
      end if;

      -- stale: abandon this attempt and fall through to create a fresh one
      update public.entity_resolution_passes erp3
         set status = 'abandoned'
       where erp3.id = v_existing.id
         and erp3.status = 'in_progress';
    end if;

    -- 2. find-or-create the brand snapshot for (project_id, dataset_id,
    -- resolver_version). entity_brand_snapshots is append-only — this
    -- block only ever inserts a new row or reuses an existing one
    -- as-is; it never updates or deletes one. Reuse requires an exact
    -- match (array order included) of all four comparable fields
    -- against the fresh call's parameters; any divergence raises
    -- rather than silently reusing a differing row.
    select ebs.*
      into v_brand_snapshot
      from public.entity_brand_snapshots ebs
     where ebs.project_id = p_project_id
       and ebs.dataset_id = p_dataset_id
       and ebs.resolver_version = p_resolver_version
     for update;

    if found then
      if v_brand_snapshot.company_name <> p_company_name
         or v_brand_snapshot.domain <> p_domain
         or v_brand_snapshot.mirror_aliases <> p_mirror_aliases
         or v_brand_snapshot.normalized_brand_terms <> p_normalized_brand_terms then
        raise exception using errcode = '22023', message = 'brand_snapshot_parameter_mismatch';
      end if;

      v_brand_snapshot_id := v_brand_snapshot.id;
    else
      v_brand_snapshot_id := null;

      insert into public.entity_brand_snapshots as ebs2 (
        project_id, dataset_id, resolver_version,
        company_name, domain, mirror_aliases, normalized_brand_terms
      )
      values (
        p_project_id, p_dataset_id, p_resolver_version,
        p_company_name, p_domain, p_mirror_aliases, p_normalized_brand_terms
      )
      on conflict (project_id, dataset_id, resolver_version) do nothing
      returning ebs2.id into v_brand_snapshot_id;

      if v_brand_snapshot_id is null then
        -- a concurrent transaction won the race to create this exact
        -- snapshot; reload its row and apply the identical exact-match
        -- comparison — never silently reused without verification.
        select ebs3.*
          into v_brand_snapshot
          from public.entity_brand_snapshots ebs3
         where ebs3.project_id = p_project_id
           and ebs3.dataset_id = p_dataset_id
           and ebs3.resolver_version = p_resolver_version
         for update;

        if v_brand_snapshot.company_name <> p_company_name
           or v_brand_snapshot.domain <> p_domain
           or v_brand_snapshot.mirror_aliases <> p_mirror_aliases
           or v_brand_snapshot.normalized_brand_terms <> p_normalized_brand_terms then
          raise exception using errcode = '22023', message = 'brand_snapshot_parameter_mismatch';
        end if;

        v_brand_snapshot_id := v_brand_snapshot.id;
      end if;
    end if;

    -- 3. create the pass itself. expected_mention_count = 0 completes
    -- immediately, never waiting for an observation that will never arrive.
    v_new_status := case when p_expected_mention_count = 0 then 'completed' else 'in_progress' end;

    begin
      insert into public.entity_resolution_passes as erp4 (
        project_id, probe_result_id, resolver_version, dataset_id,
        dataset_source_type, brand_snapshot_id, expected_mention_count,
        status, started_at, last_activity_at, completed_at
      )
      values (
        p_project_id, p_probe_result_id, p_resolver_version, p_dataset_id,
        v_dataset_source_type, v_brand_snapshot_id, p_expected_mention_count,
        v_new_status, v_now, v_now,
        case when v_new_status = 'completed' then v_now else null end
      )
      returning erp4.id into v_new_id;

      return query select v_new_id, v_new_status, 'STARTED'::text;
      return;
    exception
      when unique_violation then
        -- another transaction won the race to create this exact pass;
        -- loop back and re-select its row instead of raising.
        continue retry_loop;
    end;
  end loop;
end;
$$;

create or replace function
  public.resolve_and_record_entity_observation(
    p_resolution_pass_id   uuid,
    p_mention_ordinal      integer,
    p_raw_text             text,
    p_normalized_text      text,
    p_status               text,
    p_proposed_entity_type text,
    p_context              text
  )
returns table (
  observation_id         uuid,
  observation_generation integer,
  observation_outcome    text,
  alias_id               uuid,
  alias_generation       integer,
  alias_outcome          text,
  pass_status            text
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_now                    timestamptz := clock_timestamp();
  v_pass                   public.entity_resolution_passes%rowtype;
  v_probe_run_id           uuid;
  v_generated_prompt_id    uuid;
  v_normalized_brand_terms text[];
  v_effective_status       text;
  v_effective_entity_type  text;
  v_client_entity_id       uuid;
  v_canonical_entity_id    uuid;
  v_alias_head             public.entity_aliases%rowtype;
  v_alias_id               uuid;
  v_alias_generation       integer;
  v_alias_outcome          text;
  v_existing_obs           public.entity_observations%rowtype;
  v_observation_id         uuid;
  v_observation_generation integer;
  v_observation_outcome    text;
  v_observation_count      integer;
  v_pass_status            text;
begin
  -- 1. lock the pass row; it must be in_progress. A completed or
  -- abandoned pass, or one that never existed, raises rather than
  -- silently accepting a write.
  select erp.*
    into v_pass
    from public.entity_resolution_passes erp
   where erp.id = p_resolution_pass_id
   for update;

  if not found then
    raise exception using errcode = '22023', message = 'pass_not_found';
  end if;

  if v_pass.status <> 'in_progress' then
    raise exception using errcode = '22023', message = 'pass_not_in_progress';
  end if;

  -- 2. derive identity from the locked pass and its probe_result — none
  -- of these are accepted as independently-supplied parameters (D-018)
  select pr.probe_run_id, pr.generated_prompt_id
    into v_probe_run_id, v_generated_prompt_id
    from public.probe_results pr
   where pr.id = v_pass.probe_result_id;

  select ebs.normalized_brand_terms
    into v_normalized_brand_terms
    from public.entity_brand_snapshots ebs
   where ebs.id = v_pass.brand_snapshot_id;

  -- 3. structural preconditions (correction turn, point 4) — no Unicode
  -- recomputation anywhere; every check below is either a positivity
  -- check or an exact-string comparison of two already-normalized
  -- values (D-019)
  if p_mention_ordinal is null or p_mention_ordinal < 0 then
    raise exception using errcode = '22023', message = 'invalid_mention_ordinal';
  end if;

  if p_raw_text is null or length(trim(p_raw_text)) = 0 then
    raise exception using errcode = '22023', message = 'empty_raw_text';
  end if;

  if p_normalized_text is null or length(trim(p_normalized_text)) = 0 then
    raise exception using errcode = '22023', message = 'empty_normalized_text';
  end if;

  if p_status is null
     or p_status not in ('resolved', 'ambiguous', 'unresolved', 'excluded_brand_self') then
    raise exception using errcode = '22023', message = 'invalid_status';
  end if;

  if p_status in ('resolved', 'excluded_brand_self') and p_proposed_entity_type is null then
    raise exception using errcode = '22023', message = 'missing_proposed_entity_type';
  end if;

  if p_status in ('ambiguous', 'unresolved') and p_proposed_entity_type is not null then
    raise exception using errcode = '22023', message = 'unexpected_proposed_entity_type';
  end if;

  if p_status = 'resolved' and p_proposed_entity_type = 'client' then
    raise exception using errcode = '22023', message = 'resolved_forbids_client';
  end if;

  if p_status = 'excluded_brand_self' and p_proposed_entity_type <> 'client' then
    raise exception using errcode = '22023', message = 'excluded_brand_self_requires_client';
  end if;

  -- 4. excluded_brand_self must be independently confirmed against the
  -- pass's own frozen brand snapshot — the caller's claim alone is
  -- never sufficient (correction turn, point 4)
  if p_status = 'excluded_brand_self'
     and not (p_normalized_text = any (v_normalized_brand_terms)) then
    raise exception using errcode = '22023', message = 'excluded_brand_self_no_match';
  end if;

  v_effective_status := p_status;
  v_effective_entity_type := p_proposed_entity_type;

  -- 5. D-018 unconditional override — any competitor/platform proposal
  -- whose normalized_text matches the brand snapshot is reclassified,
  -- regardless of whether an alias head already exists for it
  if p_status = 'resolved'
     and p_proposed_entity_type in ('competitor', 'platform')
     and p_normalized_text = any (v_normalized_brand_terms) then
    v_effective_status := 'excluded_brand_self';
    v_effective_entity_type := 'client';
  end if;

  if v_effective_status in ('resolved', 'excluded_brand_self') then
    if v_effective_entity_type = 'client' then
      -- find-or-create the project's single client entity
      insert into public.canonical_entities as ce (project_id, entity_type, resolver_version)
      values (v_pass.project_id, 'client', v_pass.resolver_version)
      on conflict (project_id) where entity_type = 'client' do nothing
      returning ce.id into v_client_entity_id;

      if v_client_entity_id is null then
        select ce2.id into v_client_entity_id
          from public.canonical_entities ce2
         where ce2.project_id = v_pass.project_id and ce2.entity_type = 'client';
      end if;

      v_canonical_entity_id := v_client_entity_id;
    end if;

    -- 6. lock the active alias head (max alias_generation) for
    -- (project_id, normalized_text)
    select ea.*
      into v_alias_head
      from public.entity_aliases ea
     where ea.project_id = v_pass.project_id
       and ea.normalized_text = p_normalized_text
     order by ea.alias_generation desc
     limit 1
     for update;

    -- 7. unconditional demote-block: a client identity can never be
    -- demoted through this ordinary path, at any resolver_version
    if found and v_alias_head.entity_type = 'client' and v_effective_entity_type <> 'client' then
      raise exception using errcode = '22023', message = 'client_alias_demote_blocked';
    end if;

    if v_effective_entity_type in ('competitor', 'platform') then
      if found then
        v_canonical_entity_id := v_alias_head.canonical_entity_id;
      else
        insert into public.canonical_entities as ce3 (project_id, entity_type, resolver_version)
        values (v_pass.project_id, v_effective_entity_type, v_pass.resolver_version)
        returning ce3.id into v_canonical_entity_id;
      end if;
    end if;

    -- 8. compare the (possibly overridden) proposal to the active head
    if not found then
      insert into public.entity_aliases as ea2 (
        canonical_entity_id, project_id, entity_type,
        raw_text, normalized_text, resolver_version, alias_generation
      )
      values (
        v_canonical_entity_id, v_pass.project_id, v_effective_entity_type,
        p_raw_text, p_normalized_text, v_pass.resolver_version, 1
      )
      returning ea2.id, ea2.alias_generation into v_alias_id, v_alias_generation;
      v_alias_outcome := 'APPLIED';
    elsif v_alias_head.canonical_entity_id = v_canonical_entity_id
          and v_alias_head.entity_type = v_effective_entity_type then
      v_alias_id := v_alias_head.id;
      v_alias_generation := v_alias_head.alias_generation;
      v_alias_outcome := 'ALREADY_APPLIED';
    elsif v_pass.resolver_version > v_alias_head.resolver_version then
      insert into public.entity_aliases as ea3 (
        canonical_entity_id, project_id, entity_type,
        raw_text, normalized_text, resolver_version, alias_generation
      )
      values (
        v_canonical_entity_id, v_pass.project_id, v_effective_entity_type,
        p_raw_text, p_normalized_text, v_pass.resolver_version, v_alias_head.alias_generation + 1
      )
      returning ea3.id, ea3.alias_generation into v_alias_id, v_alias_generation;
      v_alias_outcome := 'SUPERSEDED_PRIOR';
    else
      v_alias_id := v_alias_head.id;
      v_alias_generation := v_alias_head.alias_generation;
      v_alias_outcome := 'CONFLICT';
    end if;
  else
    -- ambiguous / unresolved: alias resolution is skipped entirely
    v_canonical_entity_id := null;
    v_effective_entity_type := null;
    v_alias_id := null;
    v_alias_generation := null;
    v_alias_outcome := 'NOT_APPLICABLE';
  end if;

  -- 9. lock the current observation head (max observation_generation)
  -- for (resolution_pass_id, mention_ordinal)
  select eo.*
    into v_existing_obs
    from public.entity_observations eo
   where eo.resolution_pass_id = p_resolution_pass_id
     and eo.mention_ordinal = p_mention_ordinal
   order by eo.observation_generation desc
   limit 1
   for update;

  if not found then
    insert into public.entity_observations as eo2 (
      probe_result_id, probe_run_id, generated_prompt_id, project_id,
      dataset_id, dataset_source_type, resolution_pass_id,
      canonical_entity_id, entity_type, raw_text, normalized_text,
      resolver_version, mention_ordinal, context, status, observation_generation
    )
    values (
      v_pass.probe_result_id, v_probe_run_id, v_generated_prompt_id, v_pass.project_id,
      v_pass.dataset_id, v_pass.dataset_source_type, p_resolution_pass_id,
      v_canonical_entity_id, v_effective_entity_type, p_raw_text, p_normalized_text,
      v_pass.resolver_version, p_mention_ordinal, p_context, v_effective_status, 1
    )
    returning eo2.id, eo2.observation_generation into v_observation_id, v_observation_generation;
    v_observation_outcome := 'APPLIED';
  elsif v_existing_obs.raw_text = p_raw_text
        and v_existing_obs.normalized_text = p_normalized_text
        and v_existing_obs.canonical_entity_id is not distinct from v_canonical_entity_id
        and v_existing_obs.entity_type is not distinct from v_effective_entity_type
        and v_existing_obs.status = v_effective_status
        and v_existing_obs.context is not distinct from p_context then
    v_observation_id := v_existing_obs.id;
    v_observation_generation := v_existing_obs.observation_generation;
    v_observation_outcome := 'ALREADY_APPLIED';
  else
    v_observation_id := v_existing_obs.id;
    v_observation_generation := v_existing_obs.observation_generation;
    v_observation_outcome := 'CONFLICT';
  end if;

  -- 10. touch last_activity_at; complete the pass if this is the last
  -- expected mention, within this same transaction
  select count(*)
    into v_observation_count
    from public.entity_observations eo3
   where eo3.resolution_pass_id = p_resolution_pass_id;

  if v_observation_count = v_pass.expected_mention_count then
    update public.entity_resolution_passes erp5
       set status = 'completed', completed_at = v_now, last_activity_at = v_now
     where erp5.id = p_resolution_pass_id;
    v_pass_status := 'completed';
  else
    update public.entity_resolution_passes erp6
       set last_activity_at = v_now
     where erp6.id = p_resolution_pass_id;
    v_pass_status := 'in_progress';
  end if;

  return query select
    v_observation_id, v_observation_generation, v_observation_outcome,
    v_alias_id, v_alias_generation, v_alias_outcome, v_pass_status;
end;
$$;

revoke all on function
  public.start_or_resume_entity_resolution_pass(
    uuid, uuid, integer, uuid, integer, text, text, text[], text[], interval
  )
from public;
revoke all on function
  public.start_or_resume_entity_resolution_pass(
    uuid, uuid, integer, uuid, integer, text, text, text[], text[], interval
  )
from anon;
revoke all on function
  public.start_or_resume_entity_resolution_pass(
    uuid, uuid, integer, uuid, integer, text, text, text[], text[], interval
  )
from authenticated;
grant execute on function
  public.start_or_resume_entity_resolution_pass(
    uuid, uuid, integer, uuid, integer, text, text, text[], text[], interval
  )
to service_role;

revoke all on function
  public.resolve_and_record_entity_observation(
    uuid, integer, text, text, text, text, text
  )
from public;
revoke all on function
  public.resolve_and_record_entity_observation(
    uuid, integer, text, text, text, text, text
  )
from anon;
revoke all on function
  public.resolve_and_record_entity_observation(
    uuid, integer, text, text, text, text, text
  )
from authenticated;
grant execute on function
  public.resolve_and_record_entity_observation(
    uuid, integer, text, text, text, text, text
  )
to service_role;
