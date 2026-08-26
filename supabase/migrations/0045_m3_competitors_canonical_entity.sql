-- M3 — Source unique et rapports. Option A (read-only architecture brief,
-- approved): links `competitors` rows to the M2 canonical entity-resolution
-- layer where one genuinely exists, without ever guessing one.
--
-- Scope, in dependency order:
--   1. competitors.canonical_entity_id (nullable) — set only by an exact
--      (never fuzzy, never normalizeKey()) match between the name a
--      Competitor Discovery run returned and a rawText actually observed
--      for one canonical entity, via entity_observations_active. Rows from
--      discovery_source in ('user', 'client_site', 'model_knowledge'), and
--      any 'ai_answer' row whose name did not exactly match an observed
--      rawText (e.g. an LLM paraphrase), stay NULL — an explicit, honest
--      "not linked" state, never invented.
--   2. competitors.canonical_entity_type — a constant-valued discriminator
--      column, NULL iff canonical_entity_id is NULL, otherwise always the
--      literal 'competitor'. Exists solely so the FK below can be a
--      project-scoped composite FK against canonical_entities' EXISTING
--      (id, project_id, entity_type) unique key from migration 0038 — no
--      new unique constraint is added to canonical_entities.
--   3. The composite FK itself, which is what actually prevents a
--      competitors row from ever referencing a canonical_entities row of
--      another project (project_id must match) or of entity_type
--      'client'/'platform' (canonical_entity_type is pinned to
--      'competitor' by the CHECK, and the FK's target column is
--      entity_type — a mismatch fails the FK, not silently ignored).
--
-- What this migration does NOT do:
--   * Does not backfill canonical_entity_id on any existing competitors
--     row. `competitors` is fully replaced (delete + insert) by every
--     discoverCompetitors() run (lib/pipeline/discover-competitors.ts),
--     so the next run naturally regenerates rows carrying whatever
--     canonical identity is genuinely available — a backfill script would
--     only reintroduce the fuzzy-matching risk this design avoids.
--   * Does not add any new unique constraint to canonical_entities — the
--     required (id, project_id, entity_type) key already exists
--     (canonical_entities_id_project_type_key, migration 0038).
--   * Does not change RLS, privileges, or any other column on competitors.
--   * Does not touch entity_observations, entity_aliases, or any other
--     M2 table.

alter table public.competitors
  add column if not exists canonical_entity_id uuid null;

alter table public.competitors
  add column if not exists canonical_entity_type text null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'competitors_canonical_entity_type_check'
  ) then
    alter table public.competitors
      add constraint competitors_canonical_entity_type_check
      check (canonical_entity_type is null or canonical_entity_type = 'competitor');
  end if;
end $$;

-- Both columns travel together: a row either carries no canonical link at
-- all, or carries a fully-formed one. Never one without the other.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'competitors_canonical_entity_pair_check'
  ) then
    alter table public.competitors
      add constraint competitors_canonical_entity_pair_check
      check (
        (canonical_entity_id is null and canonical_entity_type is null)
        or
        (canonical_entity_id is not null and canonical_entity_type is not null)
      );
  end if;
end $$;

-- Project-scoped, type-pinned FK. Reuses canonical_entities'
-- (id, project_id, entity_type) unique key from migration 0038 — a
-- competitors row can only ever reference a canonical_entities row that
-- (a) belongs to the SAME project_id and (b) has entity_type = 'competitor'
-- (enforced jointly with the CHECK above, which pins
-- canonical_entity_type to the literal 'competitor'). Cross-project and
-- cross-type references both fail at the database layer, not only in
-- application code.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'competitors_canonical_entity_fk'
  ) then
    alter table public.competitors
      add constraint competitors_canonical_entity_fk
      foreign key (canonical_entity_id, project_id, canonical_entity_type)
      references public.canonical_entities (id, project_id, entity_type);
  end if;
end $$;

create index if not exists competitors_canonical_entity_idx
  on public.competitors (canonical_entity_id)
  where canonical_entity_id is not null;
