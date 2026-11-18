-- PRODUCTION PREFLIGHT (read-only). docs/PROD_PREFLIGHT_SPEC.md.
--
-- Run ONLY as:
--   psql -X -q -v ON_ERROR_STOP=1 -v expected_sysid=<from your private record> \
--        "<connection string>" -f scripts/sql/prod-preflight.sql
--
-- expected_sysid is the cluster system identifier recorded privately on
-- 2026-11-09; it is never written into the repository. Without it, or with a
-- different value, P1.1 fails.
--
-- Baseline (re-baselined 2026-11-17): production as CURRENT_STATUS §25
-- records it after S1 — 85 ledger rows, tail 20261109120000, with 0083,
-- Q2'-1, Q2'-2 and S1 applied and nothing later. This version has NEVER been
-- run against production.
--
-- One read-only transaction, rolled back at the end. It reads catalog
-- metadata, the migration ledger and counts: of jobs, attempts, probe runs,
-- protocols and sessions. It prints check ids, PASS/FAIL, versions, hashes
-- and counts: no row of customer data, no email, no evidence, no token.
-- Every check that must pass has pass = true or false; informational rows
-- have pass = null.
--
-- P6.4, P7.1 and P7.2 (review of ChatGPT phase B, D-061) read the data
-- 20261109180000's own preconditions read, with the same tests, so a state
-- that migration would refuse is found here first: an attempt reserved or in
-- progress, a protocol provider outside its closed set, a protocol attempt's
-- probe run on another platform than 'perplexity'.
--
-- The check set is built once (the checks CTE). One statement turns it into
-- the printed lines and the FAIL count. The last line printed is the verdict,
-- "PREFLIGHT: PASS" or "PREFLIGHT: FAIL (n)". On a FAIL the single raise-only
-- DO block below raises, so psql exits non-zero under ON_ERROR_STOP; on a PASS
-- the transaction is rolled back and psql exits 0.

\set ON_ERROR_STOP on
\if :{?expected_sysid}
\else
  \echo 'preflight: -v expected_sysid=<system identifier from your private record> was not given; P1.1 will FAIL'
  \set expected_sysid 'not given'
\endif
begin transaction isolation level repeatable read read only;
set local statement_timeout = '30s';
set local lock_timeout = '2s';
-- A role subject to row-level security now errors instead of reading 0 rows.
set local row_security = off;

with
ledger as (
  select version from supabase_migrations.schema_migrations
),
applied_versions(version) as (values
  ('0083'), ('20261102132000'), ('20261103173000'), ('20261109120000')
),
applied_tables(name) as (values
  ('workspaces'), ('workspace_members'), ('workspace_membership_versions'), ('workspace_projects'),
  ('question_research_sets'), ('question_sources'), ('question_candidates'), ('question_candidate_sources'),
  ('question_review_invitations'), ('question_review_sessions'), ('approval_records'),
  ('buyer_question_version_origins'), ('approved_wording_classifications'), ('exception_items'), ('exception_events'),
  ('workspace_domains'), ('workspace_domain_state'), ('workspace_domain_challenges'),
  ('workspace_domain_verification_events'), ('site_diagnostic_runs'), ('site_diagnostic_pages'),
  ('site_diagnostic_findings'), ('diagnostic_rate_limit_events'),
  ('account_sessions'), ('account_rate_limit_events')
),
applied_functions(name) as (values
  ('create_workspace_with_owner'), ('assign_project_to_workspace'), ('add_workspace_member'),
  ('remove_workspace_member'), ('approve_buyer_question_set'), ('assert_current_account_member'),
  ('open_account_session'), ('check_account_session'), ('record_account_step_up'),
  ('revoke_account_session'), ('revoke_account_sessions_for_account'), ('take_account_rate_limit')
),
pending_tables(name) as (values
  ('protocol_job_run_requests'), ('snapshot_request_closures'),
  ('pilots'), ('pilot_questions'), ('pilot_question_protocols'),
  ('pilot_report_artifacts'),
  ('pilot_actions'), ('pilot_action_versions'), ('pilot_action_evidence'), ('pilot_action_events'),
  ('workspace_brand_profiles'), ('workspace_question_drafts'), ('workspace_question_draft_versions'),
  ('workspace_actions'), ('workspace_action_versions'),
  ('workspace_plan_assignments'), ('workspace_usage_events'), ('paid_measurement_switch_events'),
  ('workspace_question_approvals'), ('workspace_active_question_events')
),
pending_functions(name) as (values
  ('request_protocol_job_run'), ('cancel_protocol_job_run_request'), ('claim_requested_protocol_execution_job'),
  ('retry_failed_protocol_job'), ('close_failed_snapshot_request'),
  ('create_pilot'), ('add_pilot_question'), ('close_pilot'), ('retire_pilot_question'),
  ('pilot_report_artifacts_guard'), ('save_pilot_report_artifact'), ('share_pilot_report_artifact'), ('read_shared_pilot_report'),
  ('pilot_actions_append_only'), ('pilot_action_evidence_check'), ('save_pilot_action'), ('review_pilot_action'),
  ('withdraw_pilot_action'),
  ('pilot_question_protocols_consistency'), ('add_pilot_question_engine'), ('protocol_worker_capabilities'),
  ('set_workspace_website'), ('take_diagnostic_rate_limit'), ('record_site_diagnostic'), ('get_site_diagnostic'),
  ('save_brand_profile'), ('get_workspace_state'),
  ('add_question_draft'), ('revise_question_draft'), ('list_question_drafts'),
  ('create_workspace_action'), ('revise_workspace_action'), ('list_workspace_actions'),
  ('assign_workspace_plan'), ('set_paid_measurement_switch'), ('reserve_measurement_run'),
  ('settle_measurement_run'), ('get_workspace_usage'),
  ('approve_question_draft'), ('archive_active_question'), ('list_active_questions')
),
-- The only informational checks. Every other check must be exactly true: a
-- must-pass check that comes out false or null is a FAIL (fail closed).
informational(id) as (values ('P1.4'), ('P6.2')),
reconcile as (
  select to_regprocedure('public.reconcile_attempt_for_job(uuid,uuid,uuid,uuid,text,text)') as oid
),
launch as (
  select to_regprocedure('public.approve_and_launch_snapshot_baseline(uuid,uuid,jsonb,text)') as oid,
         to_regprocedure('public.approve_and_launch_snapshot_baseline(uuid,uuid,jsonb,text,text)') as oid5
),
persist as (
  select to_regprocedure('public.persist_probe_result_for_job(uuid,uuid,uuid,jsonb)') as oid
),
checks(id, label, pass, observed) as (
  -- P1 target identity --------------------------------------------------
  select 'P1.1', 'this is the target database: system identifier equals -v expected_sysid',
         case when has_function_privilege('pg_control_system()', 'execute')
              then (select system_identifier::text from pg_control_system()) = :'expected_sysid'
              else false end,
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
  select 'P2.3', 'ledger tail is 20261109120000 (S1; expected_prev for pilot step 1 at 20261109130000)',
         (select max(version) from ledger) = '20261109120000', (select max(version) from ledger)
  union all
  select 'P2.4', 'no held, reserved or pending version is recorded',
         not exists (select 1 from ledger where version in
           ('0081', '0082', '0084', '0085', '20261109130000', '20261109140000', '20261109150000', '20261109160000', '20261109170000', '20261109180000', '20261110120000', '20261111120000', '20261112120000', '20261113120000', '20261114120000', '20261118120000', '20261119120000', '20261120120000')),
         (select coalesce(string_agg(version, ',' order by version), 'none') from ledger where version in
           ('0081', '0082', '0084', '0085', '20261109130000', '20261109140000', '20261109150000', '20261109160000', '20261109170000', '20261109180000', '20261110120000', '20261111120000', '20261112120000', '20261113120000', '20261114120000', '20261118120000', '20261119120000', '20261120120000'))
  union all
  select 'P2.5', 'ledger has exactly 85 rows (no unknown version)',
         (select count(*) from ledger) = 85, (select count(*)::text from ledger)
  union all
  select 'P2.6', 'the 4 applied versions (0083, Q2''-1, Q2''-2, S1) are each recorded',
         (select count(*) from ledger where version in (select version from applied_versions)) = 4,
         (select count(*)::text from ledger where version in (select version from applied_versions))

  -- P3 pinned function states: 0083's result, and the functions pilot step 1
  -- and ChatGPT phase B (20261109180000, D-061) redefine
  union all
  select 'P3.1', 'reconcile_attempt_for_job is exactly as 0083 left it (md5 of its definition, the reserved procedure''s post_def)',
         (select coalesce(md5(pg_get_functiondef(oid)), 'missing') from reconcile) = '721e487901b2272708e38565b7070c53',
         (select coalesce(md5(pg_get_functiondef(oid)), 'missing') from reconcile)
  union all
  select 'P3.2', 'only service_role may execute reconcile_attempt_for_job',
         (select oid is not null
                 and not has_function_privilege('anon', oid, 'execute')
                 and not has_function_privilege('authenticated', oid, 'execute')
                 and has_function_privilege('service_role', oid, 'execute') from reconcile),
         null
  union all
  select 'P3.3', 'approve_and_launch_snapshot_baseline is exactly as 0069 left it (md5 of its definition)',
         (select coalesce(md5(pg_get_functiondef(oid)), 'missing') from launch) = '710dfb5cb84ce09a94040ebb84086025',
         (select coalesce(md5(pg_get_functiondef(oid)), 'missing') from launch)
  union all
  select 'P3.4', 'the five-argument approve_and_launch_snapshot_baseline does not exist yet',
         (select oid5 is null from launch), null
  union all
  select 'P3.5', 'persist_probe_result_for_job is exactly as 0054 left it (md5 of its definition)',
         (select coalesce(md5(pg_get_functiondef(oid)), 'missing') from persist) = 'd812b7f4c606e03ea171113f9fbc9762',
         (select coalesce(md5(pg_get_functiondef(oid)), 'missing') from persist)

  -- P4 what is applied exists; nothing pending exists ----------------------
  union all
  select 'P4.1', 'none of the 20 pending tables exists (pilot step 1, questions, report, actions; P1, P2, E1, Q4)',
         (select count(*) from pending_tables t where to_regclass('public.' || t.name) is not null) = 0,
         (select coalesce(string_agg(t.name, ','), 'none') from pending_tables t where to_regclass('public.' || t.name) is not null)
  union all
  select 'P4.2', 'none of the 41 pending public functions exists, nor any _p1_, _p2_, _e1_ or _q4_ helper',
         (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
            and (p.proname in (select name from pending_functions)
                 or p.proname like '\_p1\_%' or p.proname like '\_p2\_%' or p.proname like '\_e1\_%' or p.proname like '\_q4\_%')) = 0,
         (select count(*)::text from pg_proc p where p.pronamespace = 'public'::regnamespace
            and (p.proname in (select name from pending_functions)
                 or p.proname like '\_p1\_%' or p.proname like '\_p2\_%' or p.proname like '\_e1\_%' or p.proname like '\_q4\_%'))
  union all
  select 'P4.3', 'the tables the pilot migrations reference exist',
         to_regclass('public.projects') is not null and to_regclass('public.buyer_question_versions') is not null
           and to_regclass('public.snapshot_requests') is not null and to_regclass('public.protocol_execution_jobs') is not null
           and to_regclass('public.protocol_attempts') is not null,
         null
  union all
  select 'P4.4', 'all 25 applied tables exist (Q2''-1, Q2''-2, S1)',
         (select count(*) from applied_tables t where to_regclass('public.' || t.name) is not null) = 25,
         (select count(*)::text from applied_tables t where to_regclass('public.' || t.name) is not null)
  union all
  select 'P4.5', 'all 12 applied public functions exist (Q2''-1, S1)',
         (select count(distinct p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace
            and p.proname in (select name from applied_functions)) = 12,
         (select count(distinct p.proname)::text from pg_proc p where p.pronamespace = 'public'::regnamespace
            and p.proname in (select name from applied_functions))
  union all
  select 'P4.6', 'all 40 applied helpers exist: _q2p_, _q2p2_, _s1_ (Q2''-1, Q2''-2, S1)',
         (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
            and (p.proname like '\_q2p\_%' or p.proname like '\_q2p2\_%' or p.proname like '\_s1\_%')) = 40,
         (select count(*)::text from pg_proc p where p.pronamespace = 'public'::regnamespace
            and (p.proname like '\_q2p\_%' or p.proname like '\_q2p2\_%' or p.proname like '\_s1\_%'))

  -- P5 roles ---------------------------------------------------------------
  union all
  select 'P5.1', 'anon, authenticated and service_role exist',
         (select count(*) from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) = 3, null
  union all
  select 'P5.2', 'service_role has BYPASSRLS',
         coalesce((select rolbypassrls from pg_roles where rolname = 'service_role'), false), null

  -- P6 nothing is running or waiting ---------------------------------------
  union all
  select 'P6.1', 'no protocol job is claimed or running (stop the worker first)',
         (select count(*) from public.protocol_execution_jobs where status in ('claimed', 'running')) = 0,
         (select count(*)::text from public.protocol_execution_jobs where status in ('claimed', 'running'))
  union all
  select 'P6.2', 'other sessions with a transaction open over 60 s (informational; visibility depends on grants)',
         null,
         (select count(*)::text from pg_stat_activity
           where pid <> pg_backend_pid() and xact_start < clock_timestamp() - interval '60 seconds')
  union all
  select 'P6.3', 'no protocol job is queued (the worker redeploy needs an empty queue)',
         (select count(*) from public.protocol_execution_jobs where status = 'queued') = 0,
         (select count(*)::text from public.protocol_execution_jobs where status = 'queued')
  union all
  select 'P6.4', 'no protocol attempt is reserved or in progress (20261109180000 refuses to apply while one is)',
         (select count(*) from public.protocol_attempts pa where pa.status in ('reserved', 'in_progress')) = 0,
         (select count(*)::text from public.protocol_attempts pa where pa.status in ('reserved', 'in_progress'))

  -- P7 the data 20261109180000's preconditions read (D-061) ----------------
  union all
  select 'P7.1', 'every protocol names a provider 20261109180000 accepts (perplexity, perplexity_sonar, perplexity_agent, openai_chatgpt)',
         (select count(*) from public.protocols p
           where p.provider not in ('perplexity', 'perplexity_sonar', 'perplexity_agent', 'openai_chatgpt')) = 0,
         (select count(*)::text from public.protocols p
           where p.provider not in ('perplexity', 'perplexity_sonar', 'perplexity_agent', 'openai_chatgpt'))
  union all
  select 'P7.2', 'every probe run of a protocol attempt is perplexity (20261109180000 keeps their results'' replay hashes)',
         (select count(*) from public.protocol_attempts pa
            join public.probe_runs pr on pr.id = pa.probe_run_id
           where pr.platform <> 'perplexity') = 0,
         (select count(*)::text from public.protocol_attempts pa
            join public.probe_runs pr on pr.id = pa.probe_run_id
           where pr.platform <> 'perplexity')
)
select string_agg(format('%-5s %-4s %s | %s', c.id,
                         case when i.id is not null then 'info' when c.pass is true then 'PASS' else 'FAIL' end,
                         c.label, coalesce(c.observed, '')),
                  E'\n' order by c.id) as lines,
       case when count(*) filter (where i.id is null and c.pass is not true) = 0 then 'PREFLIGHT: PASS'
            else 'PREFLIGHT: FAIL (' || count(*) filter (where i.id is null and c.pass is not true) || ')' end as verdict,
       count(*) filter (where i.id is null and c.pass is not true) > 0 as failed
  from checks c left join informational i on i.id = c.id \gset pf_
\echo :pf_lines
\echo :pf_verdict
\if :pf_failed
do $preflight$ begin raise exception 'PREFLIGHT: FAIL - a must-pass check failed; see the verdict line above'; end $preflight$;
\endif
rollback;
