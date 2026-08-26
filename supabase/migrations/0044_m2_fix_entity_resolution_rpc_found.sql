-- M2 tranche 3 hotfix #2 — fixes a silent PL/pgSQL FOUND-clobbering bug
-- in resolve_and_record_entity_observation, discovered by a dedicated
-- read-only audit after migration 0043's ambiguity fix let this
-- function run to completion against real staging data for the first
-- time. This bug is independent of and predates 0043's fix — it was
-- always present in 0042, simply unreachable while the ambiguity
-- error always aborted the transaction first.
--
-- Root cause: PL/pgSQL's FOUND variable is a single, function-wide
-- boolean that is silently reset by EVERY subsequent SELECT INTO,
-- INSERT, UPDATE, or DELETE — regardless of which table it touches.
-- The alias-head lookup (§6, `select ea.* into v_alias_head from
-- entity_aliases ... for update`) set FOUND correctly, but for a
-- competitor/platform proposal whose alias head was NOT found, the
-- very next statement — `insert into canonical_entities ... returning
-- id into v_canonical_entity_id` (§7-8, always affects exactly one
-- row) — silently overwrote FOUND to true. The later
-- `if not found then insert into entity_aliases ...` (§8, the actual
-- alias-write decision) therefore read the canonical_entities INSERT's
-- FOUND, not the alias lookup's, and always took a wrong branch: it
-- fell through the ALREADY_APPLIED/SUPERSEDED_PRIOR checks (both false
-- against v_alias_head's stale, all-NULL fields) into CONFLICT, which
-- writes nothing to entity_aliases while still keeping the
-- freshly-created (undeduplicated) canonical_entity_id for the
-- observation. Net effect, confirmed against real staging data: every
-- first-ever sighting of a given (project_id, normalized_text) created
-- a brand-new canonical_entities row and never wrote to
-- entity_aliases at all — a competitor mentioned across N different
-- probe_results ended up with N distinct canonical identities instead
-- of one, and entity_aliases stayed permanently empty for every
-- competitor/platform ever resolved.
--
-- Fix: three explicit boolean variables — v_pass_found,
-- v_alias_head_found, v_existing_observation_found — each captured
-- from FOUND immediately after its own SELECT INTO ... FOR UPDATE and
-- never reassigned afterward. Every later branch that used to read the
-- implicit FOUND now reads its corresponding named boolean instead, so
-- an intervening INSERT (the canonical_entities find-or-create) can
-- never again change a decision that belongs to an earlier lookup.
-- This is the same discipline the function already used for the
-- client canonical_entities find-or-create (`if v_client_entity_id is
-- null then ...` — an explicit captured value, never FOUND), just
-- applied consistently everywhere else FOUND was previously read.
--
-- What changed vs 0043, precisely: only the internal body of
-- resolve_and_record_entity_observation. Every branch, comparison, and
-- side effect is preserved exactly — reused alias head, new
-- canonical_entity + new alias, the APPLIED / ALREADY_APPLIED /
-- SUPERSEDED_PRIOR / CONFLICT outcomes, the brand-self exclusion
-- override (D-018), the observation head lookup/insert/compare, pass
-- completion, and all row-locking (`for update`) and append-only
-- (insert-only on entity_aliases/entity_observations/
-- entity_brand_snapshots) behavior. No table, column, constraint,
-- index, view, or RLS policy is touched. The function's public
-- signature, RETURNS TABLE columns, SECURITY DEFINER, search_path, and
-- EXECUTE privilege (service_role only) are byte-for-byte unchanged —
-- CREATE OR REPLACE FUNCTION with an identical signature preserves the
-- function's OID, so ownership and grants survive; the REVOKE/GRANT
-- block below is reissued anyway, verbatim, as an explicit assertion
-- rather than an assumption.
--
-- What this migration does NOT do:
--   * Does not touch start_or_resume_entity_resolution_pass — audited
--     line by line (read-only) and confirmed to have no FOUND usage
--     of this kind: every `found` check in that function is evaluated
--     immediately after its own SELECT, with nothing intervening
--     before the check, including its own brand-snapshot race-retry
--     path (which already uses an explicit `v_brand_snapshot_id is
--     null` check, never FOUND).
--   * Does not modify migrations 0001 through 0043 in any way.
--   * Does not repair, update, delete, or otherwise touch any
--     already-written entity_observations, entity_aliases, or
--     canonical_entities row — including the 17 orphaned
--     canonical_entities rows and zero entity_aliases rows produced by
--     this exact bug against real staging data. That repair is a
--     separate, later, explicitly-authorized action (a higher
--     resolver_version reprocessing pass for entity_observations/
--     entity_aliases via their active views, and a dedicated decision
--     for the orphaned canonical_entities rows, which no active view
--     ever supersedes).
--   * Does not create, alter, or drop any table, column, constraint,
--     index, view, or RLS policy.
--   * Does not alter any table-level privilege.
--   * Writes no data itself; the function still writes nothing until
--     called.

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
  v_now                        timestamptz := clock_timestamp();
  v_pass                       public.entity_resolution_passes%rowtype;
  v_pass_found                 boolean;
  v_probe_run_id               uuid;
  v_generated_prompt_id        uuid;
  v_normalized_brand_terms     text[];
  v_effective_status           text;
  v_effective_entity_type      text;
  v_client_entity_id           uuid;
  v_canonical_entity_id        uuid;
  v_alias_head                 public.entity_aliases%rowtype;
  v_alias_head_found           boolean;
  v_alias_id                   uuid;
  v_alias_generation           integer;
  v_alias_outcome              text;
  v_existing_obs                public.entity_observations%rowtype;
  v_existing_observation_found boolean;
  v_observation_id             uuid;
  v_observation_generation     integer;
  v_observation_outcome        text;
  v_observation_count          integer;
  v_pass_status                text;
begin
  -- 1. lock the pass row; it must be in_progress. A completed or
  -- abandoned pass, or one that never existed, raises rather than
  -- silently accepting a write.
  select erp.*
    into v_pass
    from public.entity_resolution_passes erp
   where erp.id = p_resolution_pass_id
   for update;
  v_pass_found := found;

  if not v_pass_found then
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
      -- find-or-create the project's single client entity. Already
      -- uses an explicit captured value (v_client_entity_id), never
      -- FOUND — unaffected by this fix, kept as-is.
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
    -- (project_id, normalized_text). v_alias_head_found is captured
    -- here, once, and is the ONLY signal read by every later branch
    -- below that needs to know whether this lookup found a row —
    -- never the implicit FOUND, which the canonical_entities insert
    -- immediately below (competitor/platform, not-found branch) would
    -- otherwise silently overwrite.
    select ea.*
      into v_alias_head
      from public.entity_aliases ea
     where ea.project_id = v_pass.project_id
       and ea.normalized_text = p_normalized_text
     order by ea.alias_generation desc
     limit 1
     for update;
    v_alias_head_found := found;

    -- 7. unconditional demote-block: a client identity can never be
    -- demoted through this ordinary path, at any resolver_version
    if v_alias_head_found and v_alias_head.entity_type = 'client' and v_effective_entity_type <> 'client' then
      raise exception using errcode = '22023', message = 'client_alias_demote_blocked';
    end if;

    if v_effective_entity_type in ('competitor', 'platform') then
      if v_alias_head_found then
        v_canonical_entity_id := v_alias_head.canonical_entity_id;
      else
        -- This INSERT always affects exactly one row and would set
        -- the implicit FOUND to true — irrelevant now, since every
        -- branch below reads v_alias_head_found (captured above),
        -- never FOUND.
        insert into public.canonical_entities as ce3 (project_id, entity_type, resolver_version)
        values (v_pass.project_id, v_effective_entity_type, v_pass.resolver_version)
        returning ce3.id into v_canonical_entity_id;
      end if;
    end if;

    -- 8. compare the (possibly overridden) proposal to the active head
    if not v_alias_head_found then
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
  -- for (resolution_pass_id, mention_ordinal). v_existing_observation_found
  -- is captured immediately after and used for the decision right
  -- below it — nothing intervenes between this SELECT and that check,
  -- so this site was never actually broken, but it is made explicit
  -- here too for uniform discipline (no bare FOUND anywhere in this
  -- function after the alias lookup).
  select eo.*
    into v_existing_obs
    from public.entity_observations eo
   where eo.resolution_pass_id = p_resolution_pass_id
     and eo.mention_ordinal = p_mention_ordinal
   order by eo.observation_generation desc
   limit 1
   for update;
  v_existing_observation_found := found;

  if not v_existing_observation_found then
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
