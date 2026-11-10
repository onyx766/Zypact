-- PRODUCTION PREFLIGHT (read-only). docs/PROD_PREFLIGHT_SPEC.md.
--
-- Run ONLY as:
--   psql -X -q -v ON_ERROR_STOP=1 "<connection string>" -f scripts/sql/prod-preflight.sql
--
-- One read-only transaction, rolled back at the end. It reads catalog
-- metadata, the migration ledger and three counts. It prints check ids,
-- PASS/FAIL, versions, hashes and counts: no row of customer data, no email,
-- no evidence, no token. Every check that must pass has pass = true or false;
-- informational rows have pass = null.

\set ON_ERROR_STOP on
begin transaction isolation level repeatable read read only;
set local statement_timeout = '30s';
set local lock_timeout = '2s';

with
ledger as (
  select version from supabase_migrations.schema_migrations
),
q2p_s1_tables(name) as (values
  ('workspaces'), ('workspace_members'), ('workspace_membership_versions'), ('workspace_projects'),
  ('question_research_sets'), ('question_sources'), ('question_candidates'), ('question_candidate_sources'),
  ('question_review_invitations'), ('question_review_sessions'), ('approval_records'),
  ('buyer_question_version_origins'), ('approved_wording_classifications'), ('exception_items'), ('exception_events'),
  ('workspace_domains'), ('workspace_domain_state'), ('workspace_domain_challenges'),
  ('workspace_domain_verification_events'), ('site_diagnostic_runs'), ('site_diagnostic_pages'),
  ('site_diagnostic_findings'), ('diagnostic_rate_limit_events'),
  ('account_sessions'), ('account_rate_limit_events'),
  ('workspace_brand_profiles'), ('workspace_question_drafts'), ('workspace_question_draft_versions'),
  ('workspace_actions'), ('workspace_action_versions'),
  ('workspace_plan_assignments'), ('workspace_usage_events'), ('paid_measurement_switch_events'),
  ('workspace_question_approvals'), ('workspace_active_question_events')
),
q2p_s1_functions(name) as (values
  ('create_workspace_with_owner'), ('assign_project_to_workspace'), ('add_workspace_member'),
  ('remove_workspace_member'), ('approve_buyer_question_set'), ('assert_current_account_member'),
  ('open_account_session'), ('check_account_session'), ('record_account_step_up'),
  ('revoke_account_session'), ('revoke_account_sessions_for_account'), ('take_account_rate_limit'),
  ('set_workspace_website'), ('take_diagnostic_rate_limit'), ('record_site_diagnostic'), ('get_site_diagnostic'),
  ('save_brand_profile'), ('get_workspace_state'),
  ('add_question_draft'), ('revise_question_draft'), ('list_question_drafts'),
  ('create_workspace_action'), ('revise_workspace_action'), ('list_workspace_actions'),
  ('assign_workspace_plan'), ('set_paid_measurement_switch'), ('reserve_measurement_run'),
  ('settle_measurement_run'), ('get_workspace_usage'),
  ('approve_question_draft'), ('archive_active_question'), ('list_active_questions')
),
reconcile as (
  select to_regprocedure('public.reconcile_attempt_for_job(uuid,uuid,uuid,uuid,text,text)') as oid
),
checks(id, label, pass, observed) as (
  -- P1 target identity --------------------------------------------------
  select 'P1.1', 'cluster system identifier (becomes target_sysid for 0083)',
         null::boolean,
         case when has_function_privilege('pg_control_system()', 'execute')
              then (select system_identifier::text from pg_control_system())
              else 'NO ACCESS to pg_control_system()' end
  union all
  select 'P1.2', 'pg_control_system() is readable by this role',
         has_function_privilege('pg_control_system()', 'execute'), current_user::text
  union all
  select 'P1.3', 'server is PostgreSQL 15 or later',
         current_setting('server_version_num')::int >= 150000, current_setting('server_version')
  union all
  select 'P1.4', 'database name (informational)', null, current_database()::text

  -- P2 migration ledger ---------------------------------------------------
  union all
  select 'P2.1', 'ledger holds 0001-0080 exactly once each',
         (select count(*) from ledger where version ~ '^[0-9]{4}$' and version::int between 1 and 80) = 80,
         (select count(*)::text from ledger where version ~ '^[0-9]{4}$' and version::int between 1 and 80)
  union all
  select 'P2.2', 'ledger holds the 0081 alias 20260924023646',
         exists (select 1 from ledger where version = '20260924023646'), null
  union all
  select 'P2.3', 'ledger tail is 20260924023646 (expected_tail for 0083, expected_prev for Q2''-1)',
         (select max(version) from ledger) = '20260924023646', (select max(version) from ledger)
  union all
  select 'P2.4', 'no held, reserved or pending version is recorded',
         not exists (select 1 from ledger where version in
           ('0081', '0082', '0083', '0084', '0085', '20261102132000', '20261103173000', '20261109120000', '20261110120000', '20261111120000', '20261112120000', '20261113120000')),
         (select coalesce(string_agg(version, ',' order by version), 'none') from ledger where version in
           ('0081', '0082', '0083', '0084', '0085', '20261102132000', '20261103173000', '20261109120000', '20261110120000', '20261111120000', '20261112120000', '20261113120000'))
  union all
  select 'P2.5', 'ledger has exactly 81 rows (no unknown version)',
         (select count(*) from ledger) = 81, (select count(*)::text from ledger)

  -- P3 0083 pre-state ------------------------------------------------------
  union all
  select 'P3.1', 'reconcile_attempt_for_job is exactly as 0050 left it (md5 of its definition)',
         (select coalesce(md5(pg_get_functiondef(oid)), 'missing') from reconcile) = 'baaf43cc539611ec78fef9762c168a53',
         (select coalesce(md5(pg_get_functiondef(oid)), 'missing') from reconcile)
  union all
  select 'P3.2', 'only service_role may execute reconcile_attempt_for_job',
         (select oid is not null
                 and not has_function_privilege('anon', oid, 'execute')
                 and not has_function_privilege('authenticated', oid, 'execute')
                 and has_function_privilege('service_role', oid, 'execute') from reconcile),
         null

  -- P4 nothing from Q2'-1, Q2'-2 or S1 exists yet --------------------------
  union all
  select 'P4.1', 'none of the 35 Q2''/S1 tables exists',
         (select count(*) from q2p_s1_tables t where to_regclass('public.' || t.name) is not null) = 0,
         (select coalesce(string_agg(t.name, ','), 'none') from q2p_s1_tables t where to_regclass('public.' || t.name) is not null)
  union all
  select 'P4.2', 'none of the Q2''/S1/P1/P2/E1/Q4 functions exists, nor any _q2p_, _q2p2_, _s1_, _p1_, _p2_, _e1_ or _q4_ helper',
         (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
            and (p.proname in (select name from q2p_s1_functions)
                 or p.proname like '\_q2p\_%' or p.proname like '\_q2p2\_%' or p.proname like '\_s1\_%' or p.proname like '\_p1\_%' or p.proname like '\_p2\_%' or p.proname like '\_e1\_%' or p.proname like '\_q4\_%')) = 0,
         (select count(*)::text from pg_proc p where p.pronamespace = 'public'::regnamespace
            and (p.proname in (select name from q2p_s1_functions)
                 or p.proname like '\_q2p\_%' or p.proname like '\_q2p2\_%' or p.proname like '\_s1\_%' or p.proname like '\_p1\_%' or p.proname like '\_p2\_%' or p.proname like '\_e1\_%' or p.proname like '\_q4\_%'))
  union all
  select 'P4.3', 'the tables Q2'' references exist',
         to_regclass('public.projects') is not null and to_regclass('public.buyer_question_versions') is not null
           and to_regclass('public.snapshot_requests') is not null,
         null

  -- P5 roles ---------------------------------------------------------------
  union all
  select 'P5.1', 'anon, authenticated and service_role exist',
         (select count(*) from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) = 3, null
  union all
  select 'P5.2', 'service_role has BYPASSRLS',
         coalesce((select rolbypassrls from pg_roles where rolname = 'service_role'), false), null

  -- P6 nothing is running --------------------------------------------------
  union all
  select 'P6.1', 'no protocol job is claimed or running (stop the worker first)',
         (select count(*) from public.protocol_execution_jobs where status in ('claimed', 'running')) = 0,
         (select count(*)::text from public.protocol_execution_jobs where status in ('claimed', 'running'))
  union all
  select 'P6.2', 'other sessions with a transaction open over 60 s (informational; visibility depends on grants)',
         null,
         (select count(*)::text from pg_stat_activity
           where pid <> pg_backend_pid() and xact_start < clock_timestamp() - interval '60 seconds')
)
select id, label, case when pass is null then 'info' when pass then 'PASS' else 'FAIL' end as result, observed
  from checks
 order by id;

rollback;
