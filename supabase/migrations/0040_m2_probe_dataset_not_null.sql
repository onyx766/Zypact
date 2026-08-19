-- M2 — NOT NULL tightening for dataset identity columns.
--
-- Preconditions verified read-only immediately before this migration
-- was proposed:
--   - all production writers of probe_runs/probe_results supply
--     dataset_id/dataset_source_type at INSERT time (D-014, D-015,
--     runtime writer hardening committed at 09dbcbc);
--   - the historical backfill (commit a6afa54) closed every
--     pre-existing NULL row on staging;
--   - both zero-count verification queries return 0 on staging
--     immediately before this migration:
--       select count(*) from probe_runs
--        where dataset_id is null or dataset_source_type is null;
--       select count(*) from probe_results
--        where dataset_id is null or dataset_source_type is null;
--
-- Scope: exactly four ALTER COLUMN ... SET NOT NULL statements. No
-- other column, constraint, index, RLS policy, table, or data is
-- touched. If either zero-count query above is not zero on the
-- target environment, this migration fails outright (Postgres
-- refuses SET NOT NULL when a NULL value exists) — intended
-- fail-closed behavior, not a bug to work around.
--
-- Does not touch the auth schema. Does not change RLS. Does not
-- modify migrations 0036, 0037, 0038, or 0039 in any way. Does not
-- write any data.

alter table public.probe_runs
  alter column dataset_id set not null;

alter table public.probe_runs
  alter column dataset_source_type set not null;

alter table public.probe_results
  alter column dataset_id set not null;

alter table public.probe_results
  alter column dataset_source_type set not null;
