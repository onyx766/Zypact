-- SV1 REHEARSAL COPY. Used only by scripts/test-q2p-supabase-stack-sv1.ts against a
-- disposable local Supabase stack. Never run against a remote database.
-- Copied unchanged below this header from the D-041 procedure validated in the
-- QD-6 local runs (source sha256 8a430331af6716b3217332d4d5dddaf9516864a1cb665dd41624c0e02e0b2b7b).
--
-- Named-file migration apply. Run ONLY as:
--   psql --single-transaction -v ON_ERROR_STOP=1 \
--        -v file=<path> -v new_version=<14 digits> -v new_name=<name> -v expected_prev=<version> \
--        -f apply_named_migration.sql
-- psql does not interpolate :variables inside dollar-quoted bodies, so the guard
-- uses \gset + \if; failures raise inside the single transaction (full rollback).
set local lock_timeout = '5s';
set local statement_timeout = '120s';
lock table supabase_migrations.schema_migrations in exclusive mode;
select coalesce(max(version), '') = :'expected_prev' as prev_ok,
       not exists (select 1 from supabase_migrations.schema_migrations
                    where version = :'new_version') as new_absent,
       :'new_version' ~ '^[0-9]{14}$' as version_ok
  from supabase_migrations.schema_migrations \gset
\if :version_ok
\else
  do $g$ begin raise exception 'named-migration guard: version is not 14 digits'; end $g$;
\endif
\if :prev_ok
\else
  do $g$ begin raise exception 'named-migration guard: latest ledger version is not the expected predecessor'; end $g$;
\endif
\if :new_absent
\else
  do $g$ begin raise exception 'named-migration guard: version already recorded'; end $g$;
\endif
\i :file
\set file_text `cat :file`
insert into supabase_migrations.schema_migrations (version, name, statements)
values (:'new_version', :'new_name', array[:'file_text' || E'\n']);
