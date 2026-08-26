-- M2 tranche 3 — Entity resolution and brand-self exclusion, SCHEMA ONLY.
-- See D-017 (Approved 2026-08-19) and D-018 (Approved 2026-08-20) in
-- DECISIONS.md. This migration contains schema, constraints, indexes,
-- and privilege corrections only. It writes no data, creates no RPC,
-- and does not touch migrations 0001 through 0040 in any way.
--
-- Scope, in dependency order:
--   1. Companion composite UNIQUE constraints on the pre-existing
--      dataset_batches and probe_results tables, required so later
--      composite foreign keys in this file can reference them. Every
--      one is trivially satisfiable regardless of existing data,
--      since each table's own `id` primary key is already unique.
--   2. canonical_entities — a partial unique index enforcing exactly
--      one entity_type='client' row per project.
--   3. entity_aliases — adds alias_generation (default 1, safe on
--      existing rows: Postgres back-fills a constant default without
--      a table rewrite) and replaces the UNIQUE(project_id,
--      entity_type, normalized_text) key with UNIQUE(project_id,
--      normalized_text, alias_generation) — dropping entity_type from
--      the key is what makes client/competitor exclusivity structural
--      (D-017). Also revokes the INSERT privilege migration 0038 gave
--      service_role on this table: entity_aliases becomes RPC-only
--      written starting with this tranche.
--   4. entity_brand_snapshots (new, append-only) — freezes the exact
--      brand-term inputs used for one (project_id, dataset_id,
--      resolver_version), created once, never recomputed.
--   5. entity_resolution_passes (new, control-plane, NOT append-only)
--      — tracks one resolution attempt per (probe_result_id,
--      resolver_version); status is in_progress/completed/abandoned.
--   6. entity_observations (new, append-only) — one row per individual
--      raw mention extracted from a probe_result.
--   7. entity_aliases_active / entity_observations_active — the only
--      sanctioned read path for "what does this currently mean."
--
-- Mandatory preconditions, verified read-only by the operator BEFORE
-- this migration is applied to any environment. Postgres itself
-- enforces both — the corresponding ALTER TABLE / CREATE INDEX
-- statement below fails outright if either query returns a row. This
-- is intended fail-closed behavior, not a bug to work around, and no
-- automatic correction is made by this migration if either fails:
--
--   select project_id, normalized_text, count(distinct entity_type) as distinct_types
--   from entity_aliases
--   group by project_id, normalized_text
--   having count(distinct entity_type) > 1;
--
--   select project_id, count(*) as client_count
--   from canonical_entities
--   where entity_type = 'client'
--   group by project_id
--   having count(*) > 1;
--
-- What this migration does NOT do:
--   * Does not create the start_or_resume_entity_resolution_pass or
--     resolve_and_record_entity_observation RPCs (D-017/D-018) — a
--     separate future migration (0042) adds those.
--   * Does not write, backfill, or migrate any data.
--   * Does not touch canonical_entities' existing direct-INSERT grant
--     from migration 0038 — out of scope for this tranche (D-017 §3).
--   * Does not change RLS or privileges on any table other than the
--     ones listed above.
--   * Does not wire any pipeline, adapter, or script to this schema.

-- ---------------------------------------------------------------------
-- 1. Companion composite UNIQUE constraints on pre-existing tables.
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'dataset_batches_id_project_key'
  ) then
    alter table public.dataset_batches
      add constraint dataset_batches_id_project_key unique (id, project_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'dataset_batches_id_source_type_key'
  ) then
    alter table public.dataset_batches
      add constraint dataset_batches_id_source_type_key unique (id, dataset_source_type);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'probe_results_id_project_key'
  ) then
    alter table public.probe_results
      add constraint probe_results_id_project_key unique (id, project_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'probe_results_id_dataset_key'
  ) then
    alter table public.probe_results
      add constraint probe_results_id_dataset_key unique (id, dataset_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'probe_results_id_run_key'
  ) then
    alter table public.probe_results
      add constraint probe_results_id_run_key unique (id, probe_run_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'probe_results_id_prompt_key'
  ) then
    alter table public.probe_results
      add constraint probe_results_id_prompt_key unique (id, generated_prompt_id);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. canonical_entities — exactly one 'client' row per project.
-- Precondition (see header): zero projects may already have more than
-- one entity_type='client' row, or this CREATE INDEX fails outright.
-- ---------------------------------------------------------------------

create unique index if not exists canonical_entities_one_client_per_project
  on public.canonical_entities (project_id)
  where entity_type = 'client';

-- ---------------------------------------------------------------------
-- 3. entity_aliases — generation-based correction model.
-- Precondition (see header): zero existing (project_id, normalized_text)
-- pairs may already span more than one entity_type, or the new
-- generation key below fails outright once alias_generation defaults
-- every existing row to 1.
-- ---------------------------------------------------------------------

alter table public.entity_aliases
  add column if not exists alias_generation integer not null default 1;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_aliases_generation_check'
  ) then
    alter table public.entity_aliases
      add constraint entity_aliases_generation_check check (alias_generation >= 1);
  end if;
end $$;

do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'entity_aliases_normalized_unique'
  ) then
    alter table public.entity_aliases
      drop constraint entity_aliases_normalized_unique;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_aliases_generation_key'
  ) then
    alter table public.entity_aliases
      add constraint entity_aliases_generation_key
      unique (project_id, normalized_text, alias_generation);
  end if;
end $$;

-- entity_aliases becomes RPC-only written starting with this tranche.
-- REVOKE is idempotent: revoking a privilege the role does not hold is
-- a no-op, so this is safe to re-run.
revoke insert on table public.entity_aliases from service_role;

-- ---------------------------------------------------------------------
-- 4. entity_brand_snapshots — immutable, one per
-- (project_id, dataset_id, resolver_version).
-- ---------------------------------------------------------------------

create table if not exists public.entity_brand_snapshots (
  id                      uuid primary key default gen_random_uuid(),
  project_id              uuid not null references public.projects (id) on delete cascade,
  dataset_id              uuid not null references public.dataset_batches (id) on delete restrict,
  resolver_version        integer not null check (resolver_version >= 1),
  company_name            text not null,
  domain                  text not null,
  mirror_aliases          text[] not null default '{}',
  normalized_brand_terms  text[] not null,
  created_at              timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_brand_snapshots_key'
  ) then
    alter table public.entity_brand_snapshots
      add constraint entity_brand_snapshots_key
      unique (project_id, dataset_id, resolver_version);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_brand_snapshots_id_key'
  ) then
    alter table public.entity_brand_snapshots
      add constraint entity_brand_snapshots_id_key
      unique (project_id, dataset_id, resolver_version, id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_brand_snapshots_dataset_project_fk'
  ) then
    alter table public.entity_brand_snapshots
      add constraint entity_brand_snapshots_dataset_project_fk
      foreign key (dataset_id, project_id) references public.dataset_batches (id, project_id);
  end if;
end $$;

create index if not exists entity_brand_snapshots_project_idx
  on public.entity_brand_snapshots (project_id);

revoke all on table public.entity_brand_snapshots from public, anon, authenticated, service_role;
grant select on table public.entity_brand_snapshots to service_role;

alter table public.entity_brand_snapshots enable row level security;
alter table public.entity_brand_snapshots no force row level security;

-- ---------------------------------------------------------------------
-- 5. entity_resolution_passes — control-plane, NOT append-only.
-- ---------------------------------------------------------------------

create table if not exists public.entity_resolution_passes (
  id                      uuid primary key default gen_random_uuid(),
  project_id              uuid not null references public.projects (id) on delete cascade,
  probe_result_id         uuid not null references public.probe_results (id) on delete restrict,
  resolver_version        integer not null check (resolver_version >= 1),
  dataset_id              uuid not null references public.dataset_batches (id) on delete restrict,
  dataset_source_type     text not null
                          check (dataset_source_type in ('snapshot_request', 'manual_scan', 'legacy_unresolved')),
  brand_snapshot_id       uuid not null references public.entity_brand_snapshots (id) on delete restrict,
  expected_mention_count  integer not null check (expected_mention_count >= 0),
  status                  text not null default 'in_progress'
                          check (status in ('in_progress', 'completed', 'abandoned')),
  started_at              timestamptz not null default now(),
  last_activity_at        timestamptz not null default now(),
  completed_at            timestamptz null,
  constraint entity_resolution_passes_completion_check check (
    (status = 'completed' and completed_at is not null)
    or (status <> 'completed' and completed_at is null)
  ),
  constraint entity_resolution_passes_activity_check check (last_activity_at >= started_at)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_resolution_passes_id_result_key'
  ) then
    alter table public.entity_resolution_passes
      add constraint entity_resolution_passes_id_result_key unique (id, probe_result_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_resolution_passes_id_project_key'
  ) then
    alter table public.entity_resolution_passes
      add constraint entity_resolution_passes_id_project_key unique (id, project_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_resolution_passes_id_dataset_key'
  ) then
    alter table public.entity_resolution_passes
      add constraint entity_resolution_passes_id_dataset_key unique (id, dataset_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_resolution_passes_id_source_type_key'
  ) then
    alter table public.entity_resolution_passes
      add constraint entity_resolution_passes_id_source_type_key unique (id, dataset_source_type);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_resolution_passes_id_version_key'
  ) then
    alter table public.entity_resolution_passes
      add constraint entity_resolution_passes_id_version_key unique (id, resolver_version);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_resolution_passes_project_fk'
  ) then
    alter table public.entity_resolution_passes
      add constraint entity_resolution_passes_project_fk
      foreign key (probe_result_id, project_id) references public.probe_results (id, project_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_resolution_passes_dataset_fk'
  ) then
    alter table public.entity_resolution_passes
      add constraint entity_resolution_passes_dataset_fk
      foreign key (probe_result_id, dataset_id) references public.probe_results (id, dataset_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_resolution_passes_dataset_source_type_fk'
  ) then
    alter table public.entity_resolution_passes
      add constraint entity_resolution_passes_dataset_source_type_fk
      foreign key (dataset_id, dataset_source_type) references public.dataset_batches (id, dataset_source_type);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_resolution_passes_snapshot_fk'
  ) then
    alter table public.entity_resolution_passes
      add constraint entity_resolution_passes_snapshot_fk
      foreign key (project_id, dataset_id, resolver_version, brand_snapshot_id)
      references public.entity_brand_snapshots (project_id, dataset_id, resolver_version, id);
  end if;
end $$;

-- At most one COMPLETED pass, ever, per (probe_result_id, resolver_version).
create unique index if not exists entity_resolution_passes_completed_key
  on public.entity_resolution_passes (probe_result_id, resolver_version)
  where status = 'completed';

-- At most one IN_PROGRESS pass at a time per (probe_result_id, resolver_version).
create unique index if not exists entity_resolution_passes_in_progress_key
  on public.entity_resolution_passes (probe_result_id, resolver_version)
  where status = 'in_progress';

create index if not exists entity_resolution_passes_project_idx
  on public.entity_resolution_passes (project_id);

-- Control-plane, not evidence: service_role gets no direct write grant
-- at all (RPC-only, D-017/D-018 §"security fix" — the two future RPCs
-- are owned by the migration-running role, never service_role, so they
-- do not need this table's privileges granted back to service_role).
revoke all on table public.entity_resolution_passes from public, anon, authenticated, service_role;
grant select on table public.entity_resolution_passes to service_role;

alter table public.entity_resolution_passes enable row level security;
alter table public.entity_resolution_passes no force row level security;

-- ---------------------------------------------------------------------
-- 6. entity_observations — append-only.
-- ---------------------------------------------------------------------

create table if not exists public.entity_observations (
  id                      uuid primary key default gen_random_uuid(),
  probe_result_id         uuid not null references public.probe_results (id) on delete restrict,
  probe_run_id            uuid not null,
  generated_prompt_id     uuid null,
  project_id              uuid not null references public.projects (id) on delete cascade,
  dataset_id              uuid not null references public.dataset_batches (id) on delete restrict,
  dataset_source_type     text not null
                          check (dataset_source_type in ('snapshot_request', 'manual_scan', 'legacy_unresolved')),
  resolution_pass_id      uuid not null references public.entity_resolution_passes (id) on delete restrict,
  canonical_entity_id     uuid null,
  entity_type             text null check (entity_type is null or entity_type in ('client', 'competitor', 'platform')),
  raw_text                text not null,
  normalized_text         text not null,
  resolver_version        integer not null check (resolver_version >= 1),
  mention_ordinal         integer not null check (mention_ordinal >= 0),
  context                 text null,
  status                  text not null check (status in ('resolved', 'ambiguous', 'unresolved', 'excluded_brand_self')),
  observation_generation  integer not null default 1 check (observation_generation >= 1),
  created_at              timestamptz not null default now(),
  -- Both directions of the brand-self rule made explicit in one place
  -- (D-017 §4): excluded_brand_self REQUIRES entity_type='client';
  -- resolved FORBIDS entity_type='client' (only competitor/platform
  -- allowed — 'platform' is supported here by schema and RPC, but its
  -- production by the pipeline is deferred beyond this tranche; no
  -- platform observation is fabricated by anything in this migration).
  constraint entity_observations_status_entity_check check (
    (status = 'excluded_brand_self' and entity_type = 'client' and canonical_entity_id is not null)
    or
    (status = 'resolved' and entity_type in ('competitor', 'platform') and canonical_entity_id is not null)
    or
    (status in ('ambiguous', 'unresolved') and entity_type is null and canonical_entity_id is null)
  ),
  constraint entity_observations_pass_identity_key
  unique (resolution_pass_id, mention_ordinal, observation_generation)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_observations_canonical_entity_fk'
  ) then
    alter table public.entity_observations
      add constraint entity_observations_canonical_entity_fk
      foreign key (canonical_entity_id, project_id, entity_type)
      references public.canonical_entities (id, project_id, entity_type);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_observations_dataset_source_type_fk'
  ) then
    alter table public.entity_observations
      add constraint entity_observations_dataset_source_type_fk
      foreign key (dataset_id, dataset_source_type) references public.dataset_batches (id, dataset_source_type);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_observations_pass_result_fk'
  ) then
    alter table public.entity_observations
      add constraint entity_observations_pass_result_fk
      foreign key (resolution_pass_id, probe_result_id) references public.entity_resolution_passes (id, probe_result_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_observations_pass_project_fk'
  ) then
    alter table public.entity_observations
      add constraint entity_observations_pass_project_fk
      foreign key (resolution_pass_id, project_id) references public.entity_resolution_passes (id, project_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_observations_pass_dataset_fk'
  ) then
    alter table public.entity_observations
      add constraint entity_observations_pass_dataset_fk
      foreign key (resolution_pass_id, dataset_id) references public.entity_resolution_passes (id, dataset_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_observations_pass_source_type_fk'
  ) then
    alter table public.entity_observations
      add constraint entity_observations_pass_source_type_fk
      foreign key (resolution_pass_id, dataset_source_type) references public.entity_resolution_passes (id, dataset_source_type);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_observations_pass_version_fk'
  ) then
    alter table public.entity_observations
      add constraint entity_observations_pass_version_fk
      foreign key (resolution_pass_id, resolver_version) references public.entity_resolution_passes (id, resolver_version);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_observations_result_run_fk'
  ) then
    alter table public.entity_observations
      add constraint entity_observations_result_run_fk
      foreign key (probe_result_id, probe_run_id) references public.probe_results (id, probe_run_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_observations_result_project_fk'
  ) then
    alter table public.entity_observations
      add constraint entity_observations_result_project_fk
      foreign key (probe_result_id, project_id) references public.probe_results (id, project_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entity_observations_result_prompt_fk'
  ) then
    alter table public.entity_observations
      add constraint entity_observations_result_prompt_fk
      foreign key (probe_result_id, generated_prompt_id) references public.probe_results (id, generated_prompt_id);
  end if;
end $$;

create index if not exists entity_observations_project_idx
  on public.entity_observations (project_id);
create index if not exists entity_observations_result_idx
  on public.entity_observations (probe_result_id);
create index if not exists entity_observations_canonical_entity_idx
  on public.entity_observations (canonical_entity_id);

revoke all on table public.entity_observations from public, anon, authenticated, service_role;
grant select on table public.entity_observations to service_role;

alter table public.entity_observations enable row level security;
alter table public.entity_observations no force row level security;

-- ---------------------------------------------------------------------
-- 7. Active-head read views — the only sanctioned read path for
-- "what does this currently mean." No consumer queries entity_aliases
-- or entity_observations directly for that purpose.
-- ---------------------------------------------------------------------

create or replace view public.entity_aliases_active as
select distinct on (ea.project_id, ea.normalized_text)
  ea.id,
  ea.canonical_entity_id,
  ea.project_id,
  ea.entity_type,
  ea.raw_text,
  ea.normalized_text,
  ea.resolver_version,
  ea.alias_generation,
  ea.created_at
from public.entity_aliases ea
order by ea.project_id, ea.normalized_text, ea.alias_generation desc;

create or replace view public.entity_observations_active as
select distinct on (eo.probe_result_id, eo.mention_ordinal)
  eo.id,
  eo.probe_result_id,
  eo.probe_run_id,
  eo.generated_prompt_id,
  eo.project_id,
  eo.dataset_id,
  eo.dataset_source_type,
  eo.resolution_pass_id,
  eo.canonical_entity_id,
  eo.entity_type,
  eo.raw_text,
  eo.normalized_text,
  eo.resolver_version,
  eo.mention_ordinal,
  eo.context,
  eo.status,
  eo.observation_generation,
  eo.created_at
from public.entity_observations eo
join public.entity_resolution_passes erp
  on erp.id = eo.resolution_pass_id
 and erp.status = 'completed'
where erp.resolver_version = (
  select max(erp2.resolver_version)
  from public.entity_resolution_passes erp2
  where erp2.probe_result_id = eo.probe_result_id
    and erp2.status = 'completed'
)
order by eo.probe_result_id, eo.mention_ordinal, eo.observation_generation desc;

revoke all on public.entity_aliases_active from public, anon, authenticated, service_role;
revoke all on public.entity_observations_active from public, anon, authenticated, service_role;

grant select on public.entity_aliases_active to service_role;
grant select on public.entity_observations_active to service_role;
