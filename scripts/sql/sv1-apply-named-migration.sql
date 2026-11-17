-- SV1 REHEARSAL COPY. Used only by scripts/test-q2p-supabase-stack-sv1.ts against a
-- disposable local Supabase stack. Never run against a remote database.
-- The body is everything from the line "-- Named-file migration apply." to the
-- end of this file; the production copy is that body, unchanged.
-- Body sha256 since 2026-11-17 (D-058: order guard, optional target_sysid guard):
--   db6feffff039c324bef2a8894deb3e2c3236f5c0e8bbca7cd4ecc204b8972cca
-- Before 2026-11-17 the body was the D-041 procedure validated in the QD-6
-- local runs, sha256 8a430331af6716b3217332d4d5dddaf9516864a1cb665dd41624c0e02e0b2b7b;
-- Q2'-1, Q2'-2 and S1 were applied to production with that body.
--
-- Named-file migration apply. Run ONLY as:
--   psql --single-transaction -v ON_ERROR_STOP=1 \
--        -v file=<path> -v new_version=<14 digits> -v new_name=<name> -v expected_prev=<version> \
--        -f apply_named_migration.sql
-- psql does not interpolate :variables inside dollar-quoted bodies, so the guard
-- uses \gset + \if; failures raise inside the single transaction (full rollback).
set local lock_timeout = '5s';
set local statement_timeout = '120s';
-- Optional target guard (2026-11-17, D-058): with -v target_sysid=<value>,
-- the apply refuses unless this cluster's system identifier equals it. The
-- production plan always passes it, from the operator's private record.
\if :{?target_sysid}
select (select system_identifier::text from pg_control_system()) = :'target_sysid' as sysid_ok \gset
\if :sysid_ok
\else
  do $g$ begin raise exception 'named-migration guard: this database is not the target (system identifier differs)'; end $g$;
\endif
\endif
lock table supabase_migrations.schema_migrations in exclusive mode;
select coalesce(max(version), '') = :'expected_prev' as prev_ok,
       not exists (select 1 from supabase_migrations.schema_migrations
                    where version = :'new_version') as new_absent,
       :'new_version' ~ '^[0-9]{14}$' as version_ok,
       :'expected_prev' ~ '^[0-9]{14}$' and :'new_version' > :'expected_prev' as order_ok
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
\if :order_ok
\else
  do $g$ begin raise exception 'named-migration guard: version is not later than the expected predecessor'; end $g$;
\endif
\i :file
\set file_text `cat :file`
insert into supabase_migrations.schema_migrations (version, name, statements)
values (:'new_version', :'new_name', array[:'file_text' || E'\n']);
