-- Sprint 13 — live Perplexity probe mode.
--
-- Adds the explicit `live_perplexity` probe fidelity value used by the
-- Perplexity Sonar integration. Existing rows remain `simulated`.
--
-- This migration is idempotent and only changes probe-mode CHECK
-- constraints. It does not touch RLS, grants, auth, or any stored data.

-- ---------------------------------------------------------------------
-- probe_runs.probe_mode
-- ---------------------------------------------------------------------
do $$
begin
  if exists (
    select 1
      from pg_constraint
     where conname = 'probe_runs_probe_mode_check'
  ) then
    alter table public.probe_runs
      drop constraint probe_runs_probe_mode_check;
  end if;
end $$;

alter table public.probe_runs
  add constraint probe_runs_probe_mode_check
  check (probe_mode in ('simulated','live_perplexity'));

alter table public.probe_runs
  alter column probe_mode set default 'simulated';

-- ---------------------------------------------------------------------
-- probe_results.probe_mode
-- ---------------------------------------------------------------------
do $$
begin
  if exists (
    select 1
      from pg_constraint
     where conname = 'probe_results_probe_mode_check'
  ) then
    alter table public.probe_results
      drop constraint probe_results_probe_mode_check;
  end if;
end $$;

alter table public.probe_results
  add constraint probe_results_probe_mode_check
  check (probe_mode in ('simulated','live_perplexity'));

alter table public.probe_results
  alter column probe_mode set default 'simulated';
