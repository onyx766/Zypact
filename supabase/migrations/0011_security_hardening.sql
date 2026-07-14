-- Zypact MVP — Sprint 10.5 database security hardening.
--
-- What this migration does, in one line:
--   Enable RLS on every MVP table, and remove direct client-side (`anon`
--   and `authenticated`) access to those tables. `service_role` keeps
--   full access, so every server route that already goes through
--   `lib/db/supabase-adapter.ts` continues to work unchanged.
--
-- Design contract:
--   * Idempotent. Safe to run twice.
--   * Touches ONLY the 13 explicit MVP tables listed below.
--   * Does NOT touch the `auth` schema, storage schema, or any Supabase
--     system schema. Supabase Auth itself continues to work.
--   * Does NOT revoke anything from `service_role`. The service-role
--     Postgres role must retain full CRUD; the DB adapter depends on it.
--   * Adds NO RLS policies. With RLS enabled and zero policies, `anon`
--     and `authenticated` clients cannot see any row through PostgREST
--     — this is exactly the intended behavior. Server routes bypass
--     this because they authenticate as `service_role`, which bypasses
--     RLS by definition.
--   * Rolls back the `SELECT` grant to `anon` from migration
--     `0010_grants.sql` for the same 13 tables. Grants to `service_role`
--     from that migration are preserved.
--
-- Non-goals (deliberately out of scope):
--   * No policies for direct authenticated PostgREST reads. The app has
--     no such reads today and adding permissive policies would silently
--     re-open the anonymous read hole we just closed.
--   * No changes to migrations 0001–0010.
--   * No auth.users triggers or profile tables. Sprint 10.5 uses
--     `auth.users.id` directly via the `projects.user_id` foreign-key
--     stored as `uuid null` (unchanged from 0001).

do $$
declare
  mvp_tables text[] := array[
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
  t text;
begin
  foreach t in array mvp_tables loop
    -- Enable RLS. `alter table ... enable row level security` is
    -- idempotent — running twice is a no-op, not an error.
    execute format('alter table public.%I enable row level security', t);

    -- Belt-and-braces: also ensure RLS is NOT forced off for the table
    -- owner. `no force row level security` is the Postgres default and
    -- keeps service_role's usual bypass working. This is a no-op if the
    -- table was never set to `force`, which is our case.
    execute format('alter table public.%I no force row level security', t);

    -- Revoke direct-table privileges from the two PostgREST roles.
    -- These are the "anonymous" and "logged-in via anon-key" clients
    -- Supabase's REST API uses. After this revoke, a PostgREST request
    -- against these tables using either key will return 401/403 or an
    -- empty result — see `scripts/verify-anon-hardened.ts`.
    execute format(
      'revoke select, insert, update, delete on public.%I from anon',
      t
    );
    execute format(
      'revoke select, insert, update, delete on public.%I from authenticated',
      t
    );

    -- IMPORTANT: do NOT revoke from service_role. Explicit
    -- re-grant here is defensive — 0010_grants.sql already granted
    -- these, but if that migration was skipped for any reason we
    -- want the server adapter to keep working after 0011.
    execute format(
      'grant select, insert, update, delete on public.%I to service_role',
      t
    );
  end loop;
end $$;

-- Reverse the schema-level SELECT grant to `anon` from 0010_grants.sql
-- so newly-added tables in the `public` schema won't automatically get
-- direct anonymous read access. Note: 0010 also set default privileges
-- for FUTURE tables to `anon`; we clear those here.
alter default privileges in schema public
  revoke select on tables from anon;
alter default privileges in schema public
  revoke select, insert, update, delete on tables from authenticated;

-- Re-affirm `service_role` default privileges are permissive for any
-- future MVP table. Safe to run multiple times.
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
