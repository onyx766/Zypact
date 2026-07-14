-- Zypact MVP — Sprint 10 migration fix.
-- Apply with:  supabase db push  (or paste into the SQL editor).
--
-- WHY this exists:
--   Fresh Supabase projects normally auto-GRANT privileges on `public.*`
--   tables to `service_role`, `authenticated`, and `anon`. In some
--   project templates (and with the newer `sb_secret_*` API-key format)
--   that auto-GRANT does not run, so INSERTs from the app return
--   Postgres 42501: "permission denied for table projects".
--
--   Sprint 10 uncovered this on a real project. This migration is a
--   minimal, idempotent GRANT block that makes the Zypact schema work
--   on any Supabase project regardless of default privilege behavior.
--
-- SAFE to re-apply. GRANTs are idempotent.

do $$
declare
  t text;
  tables constant text[] := array[
    'projects',
    'site_pages',
    'mirror_profiles',
    'generated_prompts',
    'probe_runs',
    'probe_results',
    'competitors',
    'gap_maps',
    'gaps',
    'evidence_banks',
    'fix_briefs',
    'generated_assets',
    'qa_reports'
  ];
begin
  foreach t in array tables loop
    execute format(
      'grant select, insert, update, delete on public.%I to service_role',
      t
    );
    execute format(
      'grant select, insert, update, delete on public.%I to authenticated',
      t
    );
    execute format(
      'grant select on public.%I to anon',
      t
    );
  end loop;
end
$$;

-- Also grant on any future tables in the public schema so we don't have
-- to repeat this for the next sprint.
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant select on tables to anon;
