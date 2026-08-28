-- M0 — Harden inherited table privileges.
--
-- Gap closed. Supabase's stock bootstrap leaves two default-privilege
-- clauses in place:
--
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     GRANT REFERENCES, TRIGGER, TRUNCATE, MAINTAIN ON TABLES TO anon;
--   ... TO authenticated;
--   ... GRANT ALL ON TABLES TO service_role;
--
-- Every table created by `postgres` before a migration explicitly revoked
-- them therefore carries REFERENCES, TRIGGER, TRUNCATE and MAINTAIN for
-- `anon` and `authenticated`, and the full ALL set — TRUNCATE and DELETE
-- included — for `service_role`. Historic migrations revoked only the DML
-- verbs, so the residue survived on 18 tables.
--
-- RLS does not restrict TRUNCATE. `probe_results`, `probe_runs`,
-- `probe_failures` and `analysis_llm_calls` are evidence tables, and the
-- canonical package requires evidence immutability to be enforced at the
-- database layer, not only in UI code. No reachable exploitation path
-- exists today — `anon` and `authenticated` hold no DML verb, no EXECUTE
-- on any of the 62 SECURITY DEFINER functions, and no CREATE on any
-- schema, while PostgREST exposes no TRUNCATE verb — so this closes a
-- defence-in-depth gap before a worker starts accumulating paid evidence,
-- not an open breach.
--
-- VERSION COMPATIBILITY — read this before editing the shape below.
--
-- REFERENCES, TRIGGER and TRUNCATE exist in every PostgreSQL version this
-- repository targets. MAINTAIN does not: it was introduced in PostgreSQL
-- 17. Staging runs 17.6, but the repository's Level 2 harness runs
-- postgres:16-alpine, where `revoke maintain` fails outright with
-- `unrecognized privilege type "maintain"` and aborts the migration.
--
-- The shape below is therefore two flat table-level revocations for the
-- portable verbs, plus two guarded DO blocks: one keyed on the existence
-- of the `postgres` role, one on server_version_num >= 170000. Eight
-- constant dynamic commands in all — three portable, five MAINTAIN.
--
-- Scope discipline. This migration touches privileges and nothing else:
-- no RLS, no policy, no function, no constraint, no column, no table
-- property, no row. The 18 tables below are the exact set carrying the
-- residue; the M5-era tables that already run
-- `revoke all ... from public, anon, authenticated, service_role` are
-- deliberately absent.
--
-- Idempotent by construction: REVOKE of an absent privilege is a no-op,
-- so re-running any statement is safe.

-- ---------------------------------------------------------------------
-- 1. anon and authenticated — the 18 inherited tables.
--
-- Each of the 18 carries exactly REFERENCES, TRIGGER, TRUNCATE and
-- MAINTAIN for both roles, and no DML verb for either. After this block
-- and the MAINTAIN block below, both roles hold nothing at all on these
-- tables.
-- ---------------------------------------------------------------------

revoke references, trigger, truncate on table
  public.analysis_llm_calls,
  public.canonical_entities,
  public.competitors,
  public.dataset_batches,
  public.entity_aliases,
  public.evidence_banks,
  public.fix_briefs,
  public.gap_maps,
  public.gaps,
  public.generated_assets,
  public.generated_prompts,
  public.mirror_profiles,
  public.probe_failures,
  public.probe_results,
  public.probe_runs,
  public.projects,
  public.qa_reports,
  public.site_pages
from anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. service_role — targeted revocation of the same verbs.
--
-- The 20 tables below are the real residue, measured by loading the
-- staging schema dump into a disposable PostgreSQL 17 and reading the
-- catalogs directly. `service_role` carries 68 dangerous entries there:
--
--   TRUNCATE            12 tables
--   TRIGGER             18 tables
--   REFERENCES          18 tables
--   MAINTAIN            20 tables
--
-- The 12 TRUNCATE tables reach service_role through `GRANT ALL ON TABLE`,
-- which expands to the full `arwdDxtm` set. Reading the dump text without
-- expanding ALL under-reports the residue as 8 tables; the catalog is the
-- authority, not the grant statement as written.
--
-- The same 20 tables carry the residue in a database rebuilt from these
-- migrations alone, so no divergence between staging and a fresh rebuild
-- is claimed or relied on here: one list is correct for both.
--
-- Deliberately NOT `revoke all` followed by a re-grant: the DML each
-- table grants service_role differs (SELECT alone, SELECT+INSERT, or
-- SELECT+INSERT+UPDATE), and a blanket revoke would force this migration
-- to restate DML pairs it has no business owning. A targeted revocation
-- of named privileges cannot disturb them; the runtime contract asserts
-- the DML matrix is byte-identical, and the staging fixture holds it at
-- 84 entries before and after.
--
-- snapshot_report_artifacts and snapshot_requests carry MAINTAIN only.
-- They sit outside the 18 of block 1 and are named here explicitly, which
-- is what makes this list 20 rather than 18.
-- ---------------------------------------------------------------------

revoke references, trigger, truncate on table
  public.analysis_llm_calls,
  public.canonical_entities,
  public.competitors,
  public.dataset_batches,
  public.entity_aliases,
  public.evidence_banks,
  public.fix_briefs,
  public.gap_maps,
  public.gaps,
  public.generated_assets,
  public.generated_prompts,
  public.mirror_profiles,
  public.probe_failures,
  public.probe_results,
  public.probe_runs,
  public.projects,
  public.qa_reports,
  public.site_pages,
  public.snapshot_report_artifacts,
  public.snapshot_requests
from service_role;

-- ---------------------------------------------------------------------
-- 3. Default privileges — for future tables created by `postgres` only,
--    and only where the `postgres` role exists.
--
-- Without this the fix decays: the next `create table` in public by
-- `postgres` would hand the verbs straight back. For anon and
-- authenticated the default grants exactly the four, so revoking them
-- empties the default entry. For service_role the default is ALL; a
-- targeted revoke leaves precisely SELECT, INSERT, UPDATE and DELETE,
-- which is what the application layer relies on for new tables. The
-- exact surviving set is asserted by the runtime contract as the aclitem
-- string `service_role=arwd/postgres`, not assumed.
--
-- ROLE PORTABILITY — why this is a guarded block and not a flat statement.
--
-- `alter default privileges for role postgres` fails outright with
-- `role "postgres" does not exist` wherever that role is absent. The
-- repository's Level 2 harness runs postgres:16-alpine with
-- POSTGRES_USER=zypact_level2 and creates only anon, authenticated,
-- service_role, level2_plain and level2_rls_role. 0057 is the first
-- migration in this repository to name `for role postgres` at all.
--
-- The grantor is named explicitly and never inferred: on staging the
-- entries to repair carry `defaclrole = postgres`, while `supabase
-- db push` connects through a temporary login role. Dropping `for role`
-- would target whichever role happens to be current and could leave the
-- real entry untouched — a security fix that silently fixes nothing.
-- Portability is therefore bought by SKIPPING the block where `postgres`
-- is absent, never by retargeting it.
--
-- WHAT THIS BLOCK DOES NOT PROMISE. Where the `postgres` role does not
-- exist, the default ACLs are deliberately left alone. Existing tables
-- are still hardened by blocks 1 and 2; future tables are not. That is a
-- knowingly partial outcome in such an environment, not a repair.
--
-- No EXCEPTION handler: if `postgres` exists but the executing role
-- lacks the authority to alter its default privileges, the error
-- propagates and the migration fails transactionally. A swallowed error
-- would report success while leaving the residue in place.
--
-- SCOPE RESERVATION — read this before relying on the block above.
--
-- Default privileges are per grantor. This block names `for role
-- postgres`, so it protects only tables a future migration creates AS
-- `postgres`. It does not protect tables created by any other role.
--
-- A Supabase-provisioned database also carries default privileges owned
-- by `supabase_admin`. In the `postgres` database of a stock Supabase
-- PostgreSQL 17 image there are three such entries — for schemas
-- `public`, `graphql` and `graphql_public` — each granting the full
-- `arwdDxtm` set to anon, authenticated and service_role. A table created
-- by `supabase_admin` would therefore still inherit all four dangerous
-- verbs.
--
-- 0057 never names `supabase_admin`. It neither repairs nor worsens those
-- entries: their ACL fingerprint is identical before and after this
-- migration. Their real state on staging is NOT established — `pg_dump`
-- emitted no `ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"` line,
-- so the figure above comes from a stock image, not from the project.
-- Treat that residue as open and unquantified until it is handled by a
-- separate, explicitly authorised migration.
--
-- OPERATIONAL RULE, in force until that separate migration lands:
-- no Zypact table may be created under `supabase_admin`. Every schema
-- change goes exclusively through the controlled migrations in
-- supabase/migrations, applied as `postgres`. A table created by any
-- other role sits outside the guarantee this block provides.
-- ---------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'postgres') then
    execute $p$alter default privileges for role postgres in schema public
      revoke references, trigger, truncate on tables from anon$p$;

    execute $p$alter default privileges for role postgres in schema public
      revoke references, trigger, truncate on tables from authenticated$p$;

    execute $p$alter default privileges for role postgres in schema public
      revoke references, trigger, truncate on tables from service_role$p$;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4. MAINTAIN — PostgreSQL 17 and later only.
--
-- MAINTAIN was introduced in PostgreSQL 17. On 16 it is not a recognised
-- privilege type at all: `revoke maintain` raises `unrecognized privilege
-- type "maintain"` and aborts the migration. The three portable verbs
-- therefore stay outside this block, and MAINTAIN lives entirely inside
-- it as string literals — PL/pgSQL never parses a literal as SQL, so on
-- PostgreSQL 16 nothing containing MAINTAIN is ever parsed or executed.
--
-- Two conditions, mirroring the split above:
--
--   - the two table-level revocations run on every PostgreSQL 17+, with
--     no dependence on any role existing;
--   - the three default-ACL revocations additionally require the
--     `postgres` role, for exactly the reason given in block 3.
--
-- The role guard is the same predicate as block 3, character for
-- character, so the two blocks cannot drift apart. No EXCEPTION handler
-- here either.
-- ---------------------------------------------------------------------

do $$
begin
  if current_setting('server_version_num')::int >= 170000 then
    execute $m$revoke maintain on table
      public.analysis_llm_calls, public.canonical_entities,
      public.competitors, public.dataset_batches, public.entity_aliases,
      public.evidence_banks, public.fix_briefs, public.gap_maps,
      public.gaps, public.generated_assets, public.generated_prompts,
      public.mirror_profiles, public.probe_failures, public.probe_results,
      public.probe_runs, public.projects, public.qa_reports,
      public.site_pages
    from anon, authenticated$m$;

    execute $m$revoke maintain on table
      public.analysis_llm_calls, public.canonical_entities,
      public.competitors, public.dataset_batches, public.entity_aliases,
      public.evidence_banks, public.fix_briefs, public.gap_maps,
      public.gaps, public.generated_assets, public.generated_prompts,
      public.mirror_profiles, public.probe_failures, public.probe_results,
      public.probe_runs, public.projects, public.qa_reports,
      public.site_pages, public.snapshot_report_artifacts,
      public.snapshot_requests
    from service_role$m$;

    if exists (select 1 from pg_roles where rolname = 'postgres') then
      execute $m$alter default privileges for role postgres in schema public
        revoke maintain on tables from anon$m$;

      execute $m$alter default privileges for role postgres in schema public
        revoke maintain on tables from authenticated$m$;

      execute $m$alter default privileges for role postgres in schema public
        revoke maintain on tables from service_role$m$;
    end if;
  end if;
end $$;
