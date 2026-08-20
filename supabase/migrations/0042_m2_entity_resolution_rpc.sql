-- M2 tranche 3b — Entity resolution RPCs (D-017, D-018, D-019).
--
-- Adds exactly two SECURITY DEFINER functions and their REVOKE/GRANT.
-- No table, column, constraint, or view is created or altered by this
-- migration — that was migration 0041's scope. No data is written by
-- this migration itself; the functions write no rows until called.
-- No SQL normalization function is created here — per D-019, v1
-- normalization is exclusively authoritative in
-- lib/evidence/normalize-entity-text.ts. Neither function attempts to
-- recompute or verify Unicode-exact equivalence in SQL; they validate
-- only structural preconditions (non-empty, non-null, positivity) and
-- exact-string membership of an already-normalized value against an
-- already-normalized array — comparisons with zero Unicode ambiguity.
--
-- Backend trust hypothesis (D-019), stated explicitly here as the
-- migration's own documentation, not merely in the decision record:
-- both functions are reachable by service_role only, and service_role
-- is exclusively this backend's own trusted server-side credential —
-- never exposed to any end-user-facing surface, never a caller these
-- functions need to defend against supplying a maliciously fabricated
-- normalized_text. A bug in the authoritative TypeScript normalizer
-- would affect both live writes and entity_brand_snapshots'
-- normalized_brand_terms identically (computed by the same module),
-- so it is self-consistently wrong, not exploitable by an external
-- actor who can never reach this RPC surface at all. No public
-- endpoint may accept or forward a caller-supplied normalizedText
-- value into this write path — that value is always computed
-- server-side, by the authoritative module, immediately before the
-- RPC call (verified by a static test, not by this migration).
--
-- A real gap closed while writing this migration, not present in any
-- prior planning turn: start_or_resume_entity_resolution_pass must be
-- able to create a brand-new entity_brand_snapshots row the first
-- time a given (project_id, dataset_id, resolver_version) is resolved
-- for, and no prior signature carried the inputs needed to do that.
-- p_company_name, p_domain, p_mirror_aliases, and
-- p_normalized_brand_terms are added as required parameters
-- (p_mirror_aliases defaults to '{}').
--
-- A second gap, found and closed during a dedicated audit of this
-- exact code path, not present in the version first written: the
-- original non-null-only precondition let an empty company_name/
-- domain, or a normalized_brand_terms array that was present but
-- empty (or contained a blank element), pass silently — which would
-- have created a snapshot brand-self detection could never match
-- against. And the original reuse path re-selected an existing
-- snapshot's id without ever comparing its stored fields to the
-- fresh call's parameters, silently absorbing any divergence. Both
-- are fixed now: company_name/domain must be non-empty after trim;
-- normalized_brand_terms must be non-empty with no blank element;
-- mirror_aliases must be non-null (an empty array remains explicitly
-- allowed) with no blank element; and reusing an existing snapshot —
-- whether found before the insert attempt or reloaded after losing a
-- concurrent creation race — requires an exact match (array order
-- included) of all four fields against the fresh parameters, or the
-- call raises 22023 rather than silently reusing a diverging row.
-- entity_brand_snapshots itself is never updated or deleted by either
-- function in this migration — only entity_resolution_passes' own
-- lifecycle columns are ever written after initial creation.
--
-- start_or_resume_entity_resolution_pass:
--   - validates all required parameters, p_resolver_version >= 1,
--     p_expected_mention_count >= 0, and p_stale_after strictly > 0
--     (correction turn, point 1) using one clock_timestamp() value
--     captured once and reused for every timestamp this call writes
--     or compares against (deterministic staleness evaluation);
--   - verifies p_probe_result_id belongs to p_project_id and
--     p_dataset_id belongs to p_project_id, deriving
--     dataset_source_type internally rather than accepting it as a
--     parameter;
--   - locks any existing completed/in_progress row for
--     (probe_result_id, resolver_version) and, if found, verifies
--     EXACT equality of project_id, probe_result_id, dataset_id,
--     dataset_source_type, resolver_version, and
--     expected_mention_count against the fresh call's parameters —
--     any mismatch raises 22023, never a silent reuse (correction
--     turn, point 2);
--   - returns ALREADY_COMPLETED for an existing completed row;
--     RESUMES a fresh in_progress row (touching last_activity_at);
--     marks a stale in_progress row abandoned and creates a fresh
--     attempt otherwise (never colliding on the completed/in_progress
--     partial unique indexes, since neither applies to an abandoned
--     row — verified against 0041's actual constraints, see
--     scripts/test-m2-tranche3-writers.ts);
--   - a pass created with expected_mention_count = 0 completes
--     immediately, never waiting on an observation that will never
--     arrive;
--   - a first-insert race on either partial unique index is caught
--     (unique_violation) and resolved by looping back to re-select
--     the winner's row, never raising to the caller and never
--     leaving a duplicate.
--
-- resolve_and_record_entity_observation:
--   - accepts no p_proposed_canonical_id (D-018) and no
--     p_project_id/p_probe_result_id/p_probe_run_id/
--     p_generated_prompt_id/p_dataset_id/p_dataset_source_type/
--     p_resolver_version — all derived from the locked pass row and,
--     via its probe_result_id, from probe_results;
--   - validates p_mention_ordinal >= 0, p_raw_text and
--     p_normalized_text non-empty after trim, p_status is exactly one
--     of resolved/ambiguous/unresolved/excluded_brand_self, and
--     p_proposed_entity_type's nullability matches p_status
--     (correction turn, point 4);
--   - raises if p_status='resolved' and p_proposed_entity_type='client'
--     (must be excluded_brand_self instead), and if
--     p_status='excluded_brand_self' and p_proposed_entity_type is not
--     'client';
--   - excluded_brand_self is accepted only when the RPC itself
--     confirms p_normalized_text is an exact member of the pass's own
--     brand_snapshot_id's normalized_brand_terms — the caller's claim
--     alone is never sufficient (correction turn, point 4: the
--     caller cannot force excluded_brand_self for a non-matching
--     text);
--   - independently of any caller claim, ANY competitor/platform
--     proposal whose normalized_text matches normalized_brand_terms
--     is unconditionally overridden to excluded_brand_self (D-018),
--     closing the case where the client's own name appears in
--     competitorsMentioned on its first-ever sighting, with no
--     pre-existing alias to compare against;
--   - locks the active alias head (max alias_generation) for
--     (project_id, normalized_text); a client-typed head can never be
--     demoted by a differing proposal through this function, at any
--     resolver_version (unconditional, raises rather than returning a
--     status);
--   - compares the (possibly overridden) proposal to the alias head:
--     no head -> APPLIED (generation 1); identical -> ALREADY_APPLIED;
--     higher resolver_version with a differing mapping ->
--     SUPERSEDED_PRIOR (generation + 1); resolver_version not greater
--     with a differing mapping -> CONFLICT, never written;
--   - locks the current observation head (max observation_generation)
--     for (resolution_pass_id, mention_ordinal) and applies the
--     identical APPLIED/ALREADY_APPLIED/CONFLICT comparison against
--     raw_text, normalized_text, canonical_entity_id, entity_type,
--     status, and context together;
--   - touches last_activity_at and, if the resulting row count for
--     this pass equals its expected_mention_count, transitions it to
--     completed within the same transaction; pass_status in the
--     return row always reflects this call's own outcome, never a
--     stale report of a pre-existing state.
--
-- Locking order, both functions: entity_resolution_passes row first
-- (serializes everything else against it) -> canonical_entities
-- (client find-or-create, or competitor/platform resolution) ->
-- entity_aliases active head -> entity_observations active head.
--
-- Both functions are SECURITY DEFINER, set search_path = public,
-- pg_temp, owned by the role that runs this migration (never
-- service_role — D-018's ownership requirement), revoked from
-- public/anon/authenticated, with EXECUTE granted to service_role
-- only. No table-level GRANT is touched by this migration — 0041
-- already fixed the final table/view privilege state.
--
-- What this migration does NOT do:
--   * Does not create any SQL normalization function.
--   * Does not create, modify, or wire any adapter, pipeline code, or
--     reprocessing script.
--   * Does not grant or revoke any TABLE-level privilege.
--   * Does not touch migrations 0001 through 0041 in any way.
--   * Writes no data — both functions exist but are never called by
--     this migration itself.

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
    select 1 from public.probe_results
     where id = p_probe_result_id and project_id = p_project_id
  ) then
    raise exception using errcode = '22023', message = 'probe_result_project_mismatch';
  end if;

  select dataset_source_type
    into v_dataset_source_type
    from public.dataset_batches
   where id = p_dataset_id
     and project_id = p_project_id;

  if not found then
    raise exception using errcode = '22023', message = 'dataset_project_mismatch';
  end if;

  <<retry_loop>>
  loop
    -- 1. lock any existing completed/in_progress row for this exact key
    select *
      into v_existing
      from public.entity_resolution_passes
     where probe_result_id = p_probe_result_id
       and resolver_version = p_resolver_version
       and status in ('completed', 'in_progress')
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
        update public.entity_resolution_passes
           set last_activity_at = v_now
         where id = v_existing.id;
        return query select v_existing.id, 'in_progress'::text, 'RESUMED'::text;
        return;
      end if;

      -- stale: abandon this attempt and fall through to create a fresh one
      update public.entity_resolution_passes
         set status = 'abandoned'
       where id = v_existing.id
         and status = 'in_progress';
    end if;

    -- 2. find-or-create the brand snapshot for (project_id, dataset_id,
    -- resolver_version). entity_brand_snapshots is append-only — this
    -- block only ever inserts a new row or reuses an existing one
    -- as-is; it never updates or deletes one. Reuse requires an exact
    -- match (array order included) of all four comparable fields
    -- against the fresh call's parameters; any divergence raises
    -- rather than silently reusing a differing row.
    select *
      into v_brand_snapshot
      from public.entity_brand_snapshots
     where project_id = p_project_id
       and dataset_id = p_dataset_id
       and resolver_version = p_resolver_version
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

      insert into public.entity_brand_snapshots (
        project_id, dataset_id, resolver_version,
        company_name, domain, mirror_aliases, normalized_brand_terms
      )
      values (
        p_project_id, p_dataset_id, p_resolver_version,
        p_company_name, p_domain, p_mirror_aliases, p_normalized_brand_terms
      )
      on conflict (project_id, dataset_id, resolver_version) do nothing
      returning id into v_brand_snapshot_id;

      if v_brand_snapshot_id is null then
        -- a concurrent transaction won the race to create this exact
        -- snapshot; reload its row and apply the identical exact-match
        -- comparison — never silently reused without verification.
        select *
          into v_brand_snapshot
          from public.entity_brand_snapshots
         where project_id = p_project_id
           and dataset_id = p_dataset_id
           and resolver_version = p_resolver_version
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
      insert into public.entity_resolution_passes (
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
      returning id into v_new_id;

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
  select *
    into v_pass
    from public.entity_resolution_passes
   where id = p_resolution_pass_id
   for update;

  if not found then
    raise exception using errcode = '22023', message = 'pass_not_found';
  end if;

  if v_pass.status <> 'in_progress' then
    raise exception using errcode = '22023', message = 'pass_not_in_progress';
  end if;

  -- 2. derive identity from the locked pass and its probe_result — none
  -- of these are accepted as independently-supplied parameters (D-018)
  select probe_run_id, generated_prompt_id
    into v_probe_run_id, v_generated_prompt_id
    from public.probe_results
   where id = v_pass.probe_result_id;

  select normalized_brand_terms
    into v_normalized_brand_terms
    from public.entity_brand_snapshots
   where id = v_pass.brand_snapshot_id;

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
      insert into public.canonical_entities (project_id, entity_type, resolver_version)
      values (v_pass.project_id, 'client', v_pass.resolver_version)
      on conflict (project_id) where entity_type = 'client' do nothing
      returning id into v_client_entity_id;

      if v_client_entity_id is null then
        select id into v_client_entity_id
          from public.canonical_entities
         where project_id = v_pass.project_id and entity_type = 'client';
      end if;

      v_canonical_entity_id := v_client_entity_id;
    end if;

    -- 6. lock the active alias head (max alias_generation) for
    -- (project_id, normalized_text)
    select *
      into v_alias_head
      from public.entity_aliases
     where project_id = v_pass.project_id
       and normalized_text = p_normalized_text
     order by alias_generation desc
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
        insert into public.canonical_entities (project_id, entity_type, resolver_version)
        values (v_pass.project_id, v_effective_entity_type, v_pass.resolver_version)
        returning id into v_canonical_entity_id;
      end if;
    end if;

    -- 8. compare the (possibly overridden) proposal to the active head
    if not found then
      insert into public.entity_aliases (
        canonical_entity_id, project_id, entity_type,
        raw_text, normalized_text, resolver_version, alias_generation
      )
      values (
        v_canonical_entity_id, v_pass.project_id, v_effective_entity_type,
        p_raw_text, p_normalized_text, v_pass.resolver_version, 1
      )
      returning id, alias_generation into v_alias_id, v_alias_generation;
      v_alias_outcome := 'APPLIED';
    elsif v_alias_head.canonical_entity_id = v_canonical_entity_id
          and v_alias_head.entity_type = v_effective_entity_type then
      v_alias_id := v_alias_head.id;
      v_alias_generation := v_alias_head.alias_generation;
      v_alias_outcome := 'ALREADY_APPLIED';
    elsif v_pass.resolver_version > v_alias_head.resolver_version then
      insert into public.entity_aliases (
        canonical_entity_id, project_id, entity_type,
        raw_text, normalized_text, resolver_version, alias_generation
      )
      values (
        v_canonical_entity_id, v_pass.project_id, v_effective_entity_type,
        p_raw_text, p_normalized_text, v_pass.resolver_version, v_alias_head.alias_generation + 1
      )
      returning id, alias_generation into v_alias_id, v_alias_generation;
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
  select *
    into v_existing_obs
    from public.entity_observations
   where resolution_pass_id = p_resolution_pass_id
     and mention_ordinal = p_mention_ordinal
   order by observation_generation desc
   limit 1
   for update;

  if not found then
    insert into public.entity_observations (
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
    returning id, observation_generation into v_observation_id, v_observation_generation;
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
    from public.entity_observations
   where resolution_pass_id = p_resolution_pass_id;

  if v_observation_count = v_pass.expected_mention_count then
    update public.entity_resolution_passes
       set status = 'completed', completed_at = v_now, last_activity_at = v_now
     where id = p_resolution_pass_id;
    v_pass_status := 'completed';
  else
    update public.entity_resolution_passes
       set last_activity_at = v_now
     where id = p_resolution_pass_id;
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
