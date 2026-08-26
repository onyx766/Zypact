-- M2 — Canonical observations schema, FIRST TRANCHE. Schema only — no
-- backfill, no dataset_batches row is ever created by this migration,
-- no legacy or new column is made NOT NULL. See D-014 in DECISIONS.md
-- (Approved 2026-08-19) and METHODOLOGY.md v1.1.
--
-- This migration is idempotent — safe to re-run on any existing project.
-- Does not touch the auth schema, does not change RLS on any EXISTING
-- table, does not modify migrations 0036 or 0037 in any way.
--
-- Scope:
--   1. dataset_batches — synthetic dataset identity for manual scans and
--      unresolved historical rows. Created before any dataset_id column
--      exists anywhere in this migration, so dataset_id can never be an
--      orphaned reference: Postgres enforces the foreign key at write
--      time, not application discipline.
--   2. canonical_entities / entity_aliases — deterministic, per-project
--      entity resolution. entity_aliases carries a composite foreign
--      key back to canonical_entities(id, project_id, entity_type), so
--      its denormalized project_id/entity_type can never diverge from
--      its parent row — enforced by the database, not by convention.
--   3. probe_runs / probe_results — additive columns only:
--      snapshot_request_id (legacy, nullable, direct FK to
--      snapshot_requests, unrelated to dataset_batches),
--      dataset_id (nullable FK to dataset_batches, ON DELETE RESTRICT
--      — see below), dataset_source_type (nullable), run_position,
--      negative_claim_detected, observation_schema_version. None of
--      these are backfilled and none are made NOT NULL here.
--   4. Append-only enforcement (REVOKE UPDATE/DELETE/TRUNCATE) on the
--      three new tables only, mirroring 0032/0036/0037.
--   5. RLS enabled on the three new tables, with zero policies — the
--      same pattern as 0011/0017/0027: anon/authenticated get no row
--      access through PostgREST, service_role bypasses RLS and keeps
--      full access via the explicit grants below. No RLS policy is
--      added by this migration.
--
-- What this migration does NOT do:
--   * Does not create any dataset_batches row — no backfill of any kind
--     for any table.
--   * Does not populate dataset_id/dataset_source_type/run_position on
--     any existing probe_runs/probe_results row.
--   * Does not make any new or existing column NOT NULL. A follow-up
--     migration adds NOT NULL on probe_runs.dataset_id,
--     probe_runs.dataset_source_type, probe_results.dataset_id, and
--     probe_results.dataset_source_type — only after a backfill
--     confirms zero remaining NULL rows on both tables (see D-014).
--   * Does not touch migrations 0036 or 0037.
--   * Does not change RLS on any table other than the three created
--     here. analysis_llm_calls and probe_failures (0036/0037) remain
--     exactly as those migrations left them — not this tranche's scope.
--   * Does not add a second external probe provider.
--   * Does not grant back UPDATE on probe_results. Migration 0036
--     already revoked UPDATE/DELETE/TRUNCATE on probe_results for
--     service_role (append-only). This migration adds nullable columns
--     there via DDL only, which does not require UPDATE privilege. A
--     future backfill that needs to populate those columns on already
--     -existing probe_results rows will need its own, separately
--     authorized privilege change (e.g. a column-scoped GRANT UPDATE
--     limited to exactly the new columns) — not decided here.
--   * Does not add any RLS policy. RLS is enabled with zero policies,
--     which is itself the intended restrictive behavior for anon/
--     authenticated — not a placeholder for a policy to be added later
--     in this tranche.

-- ---------------------------------------------------------------------
-- dataset_batches — synthetic dataset identity, created before any
-- dataset_id column exists anywhere below.
-- ---------------------------------------------------------------------
create table if not exists public.dataset_batches (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references public.projects (id) on delete cascade,
  dataset_source_type  text not null
                       check (dataset_source_type in ('snapshot_request', 'manual_scan', 'legacy_unresolved')),
  snapshot_request_id  uuid null references public.snapshot_requests (id) on delete cascade,
  backfill_key         text null,
  note                 text null,
  created_at           timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'dataset_batches_snapshot_request_id_check'
  ) then
    alter table public.dataset_batches
      add constraint dataset_batches_snapshot_request_id_check
      check (
        (dataset_source_type = 'snapshot_request' and snapshot_request_id is not null)
        or
        (dataset_source_type <> 'snapshot_request' and snapshot_request_id is null)
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'dataset_batches_backfill_key_key'
  ) then
    alter table public.dataset_batches
      add constraint dataset_batches_backfill_key_key
      unique (backfill_key);
  end if;
end $$;

create index if not exists dataset_batches_project_idx
  on public.dataset_batches (project_id);

grant select, insert on public.dataset_batches to service_role;

-- ---------------------------------------------------------------------
-- canonical_entities — deterministic, per-project entity identity.
-- Scoped by project_id; never shared across tenants (D-014).
-- ---------------------------------------------------------------------
create table if not exists public.canonical_entities (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects (id) on delete cascade,
  entity_type       text not null
                    check (entity_type in ('client', 'competitor', 'platform')),
  resolver_version  integer not null,
  created_at        timestamptz not null default now()
);

-- Composite unique key, required so entity_aliases can hold a composite
-- foreign key referencing exactly (id, project_id, entity_type) below.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'canonical_entities_id_project_type_key'
  ) then
    alter table public.canonical_entities
      add constraint canonical_entities_id_project_type_key
      unique (id, project_id, entity_type);
  end if;
end $$;

create index if not exists canonical_entities_project_idx
  on public.canonical_entities (project_id);

grant select, insert on public.canonical_entities to service_role;

-- ---------------------------------------------------------------------
-- entity_aliases — raw observed strings resolved to a canonical_entity.
-- project_id and entity_type are denormalized from the parent
-- canonical_entities row and enforced identical to it by the composite
-- foreign key below — not by application discipline alone.
-- ---------------------------------------------------------------------
create table if not exists public.entity_aliases (
  id                    uuid primary key default gen_random_uuid(),
  canonical_entity_id   uuid not null,
  project_id            uuid not null references public.projects (id) on delete cascade,
  entity_type           text not null
                        check (entity_type in ('client', 'competitor', 'platform')),
  raw_text              text not null,
  normalized_text       text not null,
  resolver_version      integer not null,
  created_at            timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'entity_aliases_canonical_entity_fk'
  ) then
    alter table public.entity_aliases
      add constraint entity_aliases_canonical_entity_fk
      foreign key (canonical_entity_id, project_id, entity_type)
      references public.canonical_entities (id, project_id, entity_type)
      on delete cascade;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'entity_aliases_normalized_unique'
  ) then
    alter table public.entity_aliases
      add constraint entity_aliases_normalized_unique
      unique (project_id, entity_type, normalized_text);
  end if;
end $$;

create index if not exists entity_aliases_canonical_entity_idx
  on public.entity_aliases (canonical_entity_id);

grant select, insert on public.entity_aliases to service_role;

-- ---------------------------------------------------------------------
-- probe_runs — additive columns only. All nullable. No backfill, no
-- NOT NULL in this migration. probe_runs already permits UPDATE for
-- service_role (unlike probe_results); this migration does not change
-- that.
-- ---------------------------------------------------------------------
alter table if exists public.probe_runs
  add column if not exists snapshot_request_id uuid null
  references public.snapshot_requests (id) on delete set null;

-- ON DELETE RESTRICT, not SET NULL: dataset_id is a canonical identity
-- (D-014). Deleting a referenced dataset_batches row must never silently
-- null out the identity of every probe_run pointing to it — it must
-- fail instead, forcing an explicit decision.
alter table if exists public.probe_runs
  add column if not exists dataset_id uuid null
  references public.dataset_batches (id) on delete restrict;

alter table if exists public.probe_runs
  add column if not exists dataset_source_type text null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'probe_runs_dataset_source_type_check'
  ) then
    alter table public.probe_runs
      add constraint probe_runs_dataset_source_type_check
      check (dataset_source_type is null or dataset_source_type in ('snapshot_request', 'manual_scan', 'legacy_unresolved'));
  end if;
end $$;

-- ---------------------------------------------------------------------
-- probe_results — additive columns only. All nullable. No backfill, no
-- NOT NULL in this migration. probe_results already has UPDATE/DELETE/
-- TRUNCATE revoked for service_role since migration 0036 (append-only);
-- this migration does not grant anything back — see the note at the
-- top of this file.
-- ---------------------------------------------------------------------
alter table if exists public.probe_results
  add column if not exists snapshot_request_id uuid null
  references public.snapshot_requests (id) on delete set null;

-- ON DELETE RESTRICT, not SET NULL: same reasoning as probe_runs above.
alter table if exists public.probe_results
  add column if not exists dataset_id uuid null
  references public.dataset_batches (id) on delete restrict;

alter table if exists public.probe_results
  add column if not exists dataset_source_type text null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'probe_results_dataset_source_type_check'
  ) then
    alter table public.probe_results
      add constraint probe_results_dataset_source_type_check
      check (dataset_source_type is null or dataset_source_type in ('snapshot_request', 'manual_scan', 'legacy_unresolved'));
  end if;
end $$;

alter table if exists public.probe_results
  add column if not exists run_position text null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'probe_results_run_position_check'
  ) then
    alter table public.probe_results
      add constraint probe_results_run_position_check
      check (
        run_position is null or run_position in (
          'not_observed_in_run',
          'listed_in_run',
          'primary_in_run',
          'ambiguous_in_run',
          'analysis_failed'
        )
      );
  end if;
end $$;

alter table if exists public.probe_results
  add column if not exists negative_claim_detected boolean null;

alter table if exists public.probe_results
  add column if not exists observation_schema_version integer null;

-- ---------------------------------------------------------------------
-- Append-only enforcement on the three new tables only. INSERT and
-- SELECT remain granted; only post-insert mutation is revoked. REVOKE
-- is idempotent: revoking a privilege the role does not hold is a
-- no-op. probe_runs and probe_results already carry their own grants
-- from earlier migrations and are not touched by this block.
-- ---------------------------------------------------------------------
revoke update on table public.dataset_batches from service_role;
revoke delete on table public.dataset_batches from service_role;
revoke truncate on table public.dataset_batches from service_role;

revoke update on table public.canonical_entities from service_role;
revoke delete on table public.canonical_entities from service_role;
revoke truncate on table public.canonical_entities from service_role;

revoke update on table public.entity_aliases from service_role;
revoke delete on table public.entity_aliases from service_role;
revoke truncate on table public.entity_aliases from service_role;

-- ---------------------------------------------------------------------
-- RLS on the three new tables only, zero policies — the same pattern
-- as 0011/0017/0027. With RLS enabled and no policy, anon and
-- authenticated clients cannot see or write any row through PostgREST;
-- service_role bypasses RLS by definition and keeps full access via the
-- explicit grants above. No table other than these three is touched.
-- ---------------------------------------------------------------------
alter table public.dataset_batches enable row level security;
alter table public.dataset_batches no force row level security;

alter table public.canonical_entities enable row level security;
alter table public.canonical_entities no force row level security;

alter table public.entity_aliases enable row level security;
alter table public.entity_aliases no force row level security;
