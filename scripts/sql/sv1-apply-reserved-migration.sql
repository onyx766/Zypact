-- SV1 REHEARSAL COPY. Used only by scripts/test-q2p-supabase-stack-sv1.ts against a
-- disposable local Supabase stack. Never run against a remote database.
-- Copied unchanged below this header from the D-041 procedure validated in the
-- QD-6 local runs (source sha256 b011ccc2f5e923f0143944f23b48cfce077b4883f20322b0f9e588ec7ab199ee).
--
-- QD-6 reserved-version apply procedure (strategy B). Applies ONE allow-listed
-- historical four-digit migration whose version sorts below the ledger tail,
-- atomically with its ledger row. Never edits or removes an existing row.
--
-- Run ONLY as:
--   psql -X -q --single-transaction -v ON_ERROR_STOP=1 \
--     -v target_sysid=<pg system identifier of the intended cluster> \
--     -v file=<path to the migration file> -v version=<NNNN> -v name=<name> \
--     -v expected_tail=<current max(version) of the ledger> \
--     -f apply_reserved_migration.sql
--
-- Everything the operator could get wrong is either an explicit argument that
-- must match the target exactly (cluster identity, ledger tail) or pinned in
-- the allowlist below (file bytes, the function's definition before and after).
-- Every guard runs inside the single transaction; any failure raises and the
-- whole transaction (migration statements and ledger row) rolls back.
-- psql variables are never interpolated inside dollar quotes, so each check
-- is computed with \gset and branched with \if.

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- 0. Must run inside one transaction (--single-transaction): outside a
--    transaction block SET LOCAL has no effect, so its value tells us.
select current_setting('lock_timeout') = '5s' as in_txn_ok \gset
\if :in_txn_ok
\else
  do $g$ begin raise exception 'reserved-migration guard: not inside a single transaction (use --single-transaction)'; end $g$;
\endif

-- 1. Target identity: refuse any cluster other than the one named explicitly.
select coalesce((select system_identifier::text from pg_control_system()), '') = :'target_sysid' as target_ok \gset
\if :target_ok
\else
  do $g$ begin raise exception 'reserved-migration guard: target cluster identity does not match target_sysid'; end $g$;
\endif

-- 2. Exact allowlist: version, name, file bytes, and the md5 of
--    pg_get_functiondef(reconcile_attempt_for_job) before (0050 section 12)
--    and after (0083). Only 0083 is listed.
\set file_text `cat :file`
select coalesce(max(v.pre_def), '') as pre_def, coalesce(max(v.post_def), '') as post_def,
       count(*) = 1 as allow_ok
  from (values ('0083', 'm5_estimated_cost_keeps_attempt_cap_basis',
                '742c0e1db329bb89454dabc1aa5a1fd4f8e94523ab9fb585e877da76ded42e23',
                'baaf43cc539611ec78fef9762c168a53', '721e487901b2272708e38565b7070c53'))
       as v(version, name, file_sha256, pre_def, post_def)
 where v.version = :'version' and v.name = :'name'
   and v.file_sha256 = encode(sha256(convert_to(:'file_text' || E'\n', 'UTF8')), 'hex') \gset
\if :allow_ok
\else
  do $g$ begin raise exception 'reserved-migration guard: version/name/file bytes are not on the exact allowlist'; end $g$;
\endif

-- 3. Ledger guards, under an exclusive lock held to commit.
lock table supabase_migrations.schema_migrations in exclusive mode;
select not exists (select 1 from supabase_migrations.schema_migrations where version = :'version') as absent_ok,
       coalesce((select max(version) from supabase_migrations.schema_migrations), '') = :'expected_tail' as tail_ok,
       :'version' < :'expected_tail' as below_tail_ok,
       (select count(*) from supabase_migrations.schema_migrations
         where version in ('0050', '20260924023646')) = 2 as deps_ok,
       not exists (select 1 from supabase_migrations.schema_migrations where version = '0082') as no_0082_ok
\gset
\if :absent_ok
\else
  do $g$ begin raise exception 'reserved-migration guard: version already recorded'; end $g$;
\endif
\if :tail_ok
\else
  do $g$ begin raise exception 'reserved-migration guard: ledger tail is not the expected_tail'; end $g$;
\endif
\if :below_tail_ok
\else
  do $g$ begin raise exception 'reserved-migration guard: version does not sort below the tail (use the standard procedure)'; end $g$;
\endif
\if :deps_ok
\else
  do $g$ begin raise exception 'reserved-migration guard: a required ledger version (0050, 20260924023646) is missing'; end $g$;
\endif
\if :no_0082_ok
\else
  do $g$ begin raise exception 'reserved-migration guard: 0082 is recorded; the PG-9 interlock order is unknown'; end $g$;
\endif

-- 4. Object pre-state: the function 0083 replaces must exist exactly as 0050
--    left it, executable by service_role only (checked by meaning, not by the
--    platform-specific ACL text).
select coalesce(md5(pg_get_functiondef(to_regprocedure('public.reconcile_attempt_for_job(uuid,uuid,uuid,uuid,text,text)'))), 'missing') = :'pre_def'
       and not has_function_privilege('anon', 'public.reconcile_attempt_for_job(uuid,uuid,uuid,uuid,text,text)', 'execute')
       and not has_function_privilege('authenticated', 'public.reconcile_attempt_for_job(uuid,uuid,uuid,uuid,text,text)', 'execute')
       and has_function_privilege('service_role', 'public.reconcile_attempt_for_job(uuid,uuid,uuid,uuid,text,text)', 'execute')
       as pre_ok \gset
\if :pre_ok
\else
  do $g$ begin raise exception 'reserved-migration guard: reconcile_attempt_for_job is missing or not in the expected pre-state'; end $g$;
\endif

-- 5. The migration file, unchanged.
\i :file

-- 6. Object post-state must equal the normal-order result.
select coalesce(md5(pg_get_functiondef(to_regprocedure('public.reconcile_attempt_for_job(uuid,uuid,uuid,uuid,text,text)'))), 'missing') = :'post_def'
       and not has_function_privilege('anon', 'public.reconcile_attempt_for_job(uuid,uuid,uuid,uuid,text,text)', 'execute')
       and not has_function_privilege('authenticated', 'public.reconcile_attempt_for_job(uuid,uuid,uuid,uuid,text,text)', 'execute')
       and has_function_privilege('service_role', 'public.reconcile_attempt_for_job(uuid,uuid,uuid,uuid,text,text)', 'execute')
       as post_ok \gset
\if :post_ok
\else
  do $g$ begin raise exception 'reserved-migration guard: post-state differs from the expected normal-order result'; end $g$;
\endif

-- 7. The ledger row, in the same transaction, under the migration's own version.
insert into supabase_migrations.schema_migrations (version, name, statements)
values (:'version', :'name', array[:'file_text' || E'\n']);
