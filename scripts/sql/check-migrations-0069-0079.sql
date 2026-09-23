-- Read-only. Reports whether each of migrations 0069-0079 is actually
-- present in this database, independent of supabase_migrations.schema_migrations.
--
-- Use it when the ledger and the database disagree: the ledger records what
-- the CLI applied, while this reads what the schema actually contains. Each
-- row tests one object or one line of function body that only that
-- migration introduces. Function bodies are read from pg_proc.prosrc, which
-- preserves comments, so a marker can be a comment the migration added.

select * from (values
  ('0068 (baseline) save_protocol_report_artifact, approved-only gate',
    exists (select 1 from pg_proc where proname = 'save_protocol_report_artifact'
            and prosrc like '%status <> ''approved''%')),

  ('0069 approval writes 5 planned runs',
    exists (select 1 from pg_proc where proname = 'approve_and_launch_snapshot_baseline'
            and prosrc like '%D-032: 5 planned baseline runs%')),

  ('0070 job review scoped to its job',
    exists (select 1 from pg_proc where proname = 'resolve_protocol_job_review'
            and prosrc like '%job_id = v_job.id or job_id is null%')),

  ('0071 interventions table',
    to_regclass('public.interventions') is not null),

  ('0072 observation window columns',
    exists (select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'interventions'
              and column_name = 'observation_window_closes_at')),

  ('0073 create_retest_protocol function',
    exists (select 1 from pg_proc where proname = 'create_retest_protocol')),

  ('0074 retest phase trigger',
    exists (select 1 from pg_trigger where tgname = 'protocol_attempts_phase_matches_protocol')),

  ('0075 detectable change column',
    exists (select 1 from information_schema.columns
            where table_schema = 'public' and column_name = 'detectable_change_at_plan')),

  ('0076 outcome_card_artifacts table',
    to_regclass('public.outcome_card_artifacts') is not null),

  ('0077 abandon_intervention function',
    exists (select 1 from pg_proc where proname = 'abandon_intervention')),

  ('0078 register refuses non-baselines',
    exists (select 1 from pg_proc where proname = 'register_intervention'
            and prosrc like '%protocol_is_not_a_baseline%')),

  ('0079 completed retest is returned, not replaced',
    exists (select 1 from pg_proc where proname = 'create_retest_protocol'
            and prosrc like '%''draft'', ''approved'', ''active'', ''completed''%'))
) as t(migration, present)
order by migration;
