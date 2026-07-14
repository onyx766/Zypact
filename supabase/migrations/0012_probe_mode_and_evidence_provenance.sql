-- Sprint 12 — pipeline integrity: persist probe fidelity and Evidence
-- Bank provenance.
--
-- This migration is idempotent — safe to re-run on any existing project.
--
-- Changes:
--   1. Add `probe_mode` to `probe_runs` and `probe_results`.
--      * Enum-shaped column with a CHECK constraint (`simulated` | `live`).
--      * Backfilled to `'simulated'` on every existing row because no
--        live platform-API probe path exists in the codebase yet. Any
--        historical answer was pasted (manual/synthetic) and then
--        analyzed by our own LLM.
--      * NOT NULL enforced after the backfill.
--   2. Add `provenance` to `evidence_banks`.
--      * Enum-shaped column with a CHECK constraint
--        (`auto_filled_from_mirror_profile` | `user_edited` | `user_reviewed`).
--      * Backfilled to `'auto_filled_from_mirror_profile'`. We do NOT
--        mark existing rows as `user_reviewed` because we have no
--        evidence anyone confirmed them.
--      * NOT NULL enforced after the backfill.
--
-- What this migration does NOT do (per Sprint 12 rules):
--   * Does not touch `auth` schema or any Supabase system schema.
--   * Does not change RLS, grants, or the service-role bypass.
--   * Does not touch other MVP tables.
--   * Does not implement any live probe integration — the `live` value
--     is reserved but never written by the current pipeline.

-- ---------------------------------------------------------------------
-- probe_runs.probe_mode
-- ---------------------------------------------------------------------
alter table if exists public.probe_runs
  add column if not exists probe_mode text;

update public.probe_runs
   set probe_mode = 'simulated'
 where probe_mode is null;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'probe_runs_probe_mode_check'
  ) then
    alter table public.probe_runs
      add constraint probe_runs_probe_mode_check
      check (probe_mode in ('simulated','live'));
  end if;
end $$;

alter table public.probe_runs
  alter column probe_mode set not null;

alter table public.probe_runs
  alter column probe_mode set default 'simulated';

-- ---------------------------------------------------------------------
-- probe_results.probe_mode
-- ---------------------------------------------------------------------
alter table if exists public.probe_results
  add column if not exists probe_mode text;

update public.probe_results
   set probe_mode = 'simulated'
 where probe_mode is null;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'probe_results_probe_mode_check'
  ) then
    alter table public.probe_results
      add constraint probe_results_probe_mode_check
      check (probe_mode in ('simulated','live'));
  end if;
end $$;

alter table public.probe_results
  alter column probe_mode set not null;

alter table public.probe_results
  alter column probe_mode set default 'simulated';

-- ---------------------------------------------------------------------
-- evidence_banks.provenance
-- ---------------------------------------------------------------------
alter table if exists public.evidence_banks
  add column if not exists provenance text;

update public.evidence_banks
   set provenance = 'auto_filled_from_mirror_profile'
 where provenance is null;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'evidence_banks_provenance_check'
  ) then
    alter table public.evidence_banks
      add constraint evidence_banks_provenance_check
      check (
        provenance in (
          'auto_filled_from_mirror_profile',
          'user_edited',
          'user_reviewed'
        )
      );
  end if;
end $$;

alter table public.evidence_banks
  alter column provenance set not null;

alter table public.evidence_banks
  alter column provenance set default 'auto_filled_from_mirror_profile';
