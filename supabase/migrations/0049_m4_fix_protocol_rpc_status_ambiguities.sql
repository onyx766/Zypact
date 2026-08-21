-- M4 hotfix — fixes a real "column reference \"status\" is ambiguous"
-- error (Postgres 42702) in BOTH approve_protocol and start_attempt,
-- the identical defect in two places. Discovered in approve_protocol
-- by a live functional smoke test against real staging Postgres for
-- the first time (2026-08-21) — the in-memory adapter's JS mock has no
-- such ambiguity concept, so no prior test run, however thorough,
-- could have caught this. start_attempt's occurrence was found
-- immediately afterward by reading every other RPC in migration 0047
-- for the same pattern; it has never been exercised by a real call and
-- so has not yet failed on staging, but it would fail identically the
-- moment it ever ran. Both bugs have been present since migration 0047.
--
-- Root cause (same shape in both functions): a function whose
-- `returns table (status text, ...)` clause names a return column
-- `status` implicitly declares `status` as a PL/pgSQL variable in
-- scope for the entire function body. Any later bare (unqualified)
-- `status` read inside a live query — in a WHERE clause in particular
-- — is then ambiguous between that variable and a table column also
-- named `status`. (An UPDATE's `SET status = ...` target is never
-- ambiguous — SET always resolves against the target table's columns
-- only, per the SQL standard — the bug is specifically a WHERE
-- clause's read reference.)
--
--   approve_protocol (public.protocols has a status column):
--     update public.protocols
--        set status = 'approved', ...
--      where id = p_protocol_id and project_id = p_project_id
--        and status = 'draft'     -- ambiguous
--     returning * into v_row;
--
--   start_attempt (public.protocol_attempts has a status column):
--     update public.protocol_attempts
--        set status = 'in_progress', ...
--      where id = p_attempt_id and project_id = p_project_id
--        and status = 'reserved'  -- ambiguous, identical shape
--     returning * into v_row;
--
-- Compare with the sibling functions approve_buyer_question_version
-- and reconcile_attempt (migration 0047, unmodified, unaffected):
-- their UPDATE WHERE clauses use `approved_at is null` and
-- `terminalized_at is null` respectively — names that never collide
-- with their own return columns (`status`, `version`/`attempt`) —
-- hence no bug there, and nothing to change there.
-- admit_and_reserve_attempt was also read line by line and already
-- qualifies every status read as `pa.status`/`v_protocol.status` — no
-- bug there either.
--
-- Fix, identical shape in both functions: alias the UPDATE target as
-- `pr` and qualify the WHERE clause's status reference (and the
-- id/project_id conditions, for consistency and defense against any
-- future column/return-name collision) as `pr.status`, `pr.id`,
-- `pr.project_id`, and the RETURNING clause as `pr.*`. No business
-- logic changed in either function: every branch, every return
-- outcome, every lock (`for update`), and the exact set of columns
-- written are byte-for-byte identical to migration 0047's versions.
--
-- What changed vs 0047, precisely: only each function's UPDATE
-- statement target alias and its WHERE/RETURNING clause
-- qualification. Both functions' public signatures
-- (approve_protocol(uuid, uuid, uuid),
-- start_attempt(uuid, uuid, uuid)), RETURNS TABLE columns, SECURITY
-- DEFINER, search_path, owner, and EXECUTE privilege (service_role
-- only) are byte-for-byte unchanged — CREATE OR REPLACE FUNCTION with
-- an identical signature preserves the function's OID, so ownership
-- and grants survive automatically; the REVOKE/GRANT blocks below are
-- reissued anyway, verbatim, as an explicit assertion rather than an
-- assumption (same discipline as migration 0044's
-- resolve_and_record_entity_observation hotfix).
--
-- What this migration does NOT do:
--   * Does not modify migrations 0001 through 0048 in any way,
--     including 0047 (which originally defined both functions) and
--     0048 (the numeric-scale CHECK constraints on
--     buyer_question_versions) — both remain untouched.
--   * Does not touch approve_buyer_question_version,
--     admit_and_reserve_attempt, or reconcile_attempt — confirmed
--     unaffected, as described above.
--   * Does not create, alter, or drop any table, column, constraint,
--     index, view, or RLS policy.
--   * Does not alter any table-level privilege.
--   * Does not repair, update, delete, or otherwise touch any
--     already-written buyer_questions, buyer_question_versions,
--     protocols, or protocol_attempts row — including the synthetic
--     staging residue from prior diagnostic runs. That is explicitly
--     out of scope here.
--   * Writes no data itself; both functions still write nothing until
--     called.
--   * Is not applied to any database by this authoring step. Requires
--     a separate, explicit authorization before `supabase db push`.

create or replace function
  public.approve_protocol(
    p_protocol_id uuid,
    p_project_id uuid,
    p_approved_by uuid
  )
returns table (
  status   text,
  protocol public.protocols
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_row public.protocols%rowtype;
  v_version public.buyer_question_versions%rowtype;
begin
  if p_protocol_id is null or p_project_id is null or p_approved_by is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_approve_protocol_args';
  end if;

  select p.* into v_row
    from public.protocols p
   where p.id = p_protocol_id and p.project_id = p_project_id
   for update;

  if not found then
    return query select 'NOT_FOUND'::text, null::public.protocols;
    return;
  end if;

  if v_row.status in ('approved', 'active', 'completed') then
    return query select 'ALREADY_APPROVED'::text, v_row;
    return;
  end if;

  if v_row.status = 'abandoned' then
    return query select 'CONFLICT'::text, v_row;
    return;
  end if;

  select bqv.* into v_version
    from public.buyer_question_versions bqv
   where bqv.id = v_row.buyer_question_version_id
     and bqv.project_id = p_project_id;

  if v_version.approved_at is null then
    return query select 'VERSION_NOT_APPROVED'::text, v_row;
    return;
  end if;

  update public.protocols pr
     set status = 'approved',
         approved_by = p_approved_by,
         approved_at = now(),
         updated_at = now()
   where pr.id = p_protocol_id
     and pr.project_id = p_project_id
     and pr.status = 'draft'
  returning pr.* into v_row;

  return query select 'APPROVED'::text, v_row;
end;
$$;

revoke all on function
  public.approve_protocol(uuid, uuid, uuid) from public;
revoke all on function
  public.approve_protocol(uuid, uuid, uuid) from anon;
revoke all on function
  public.approve_protocol(uuid, uuid, uuid) from authenticated;
grant execute on function
  public.approve_protocol(uuid, uuid, uuid) to service_role;


create or replace function
  public.start_attempt(
    p_attempt_id uuid,
    p_project_id uuid,
    p_probe_run_id uuid
  )
returns table (
  status  text,
  attempt public.protocol_attempts
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_row public.protocol_attempts%rowtype;
begin
  if p_attempt_id is null or p_project_id is null or p_probe_run_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_start_attempt_args';
  end if;

  select pa.* into v_row
    from public.protocol_attempts pa
   where pa.id = p_attempt_id and pa.project_id = p_project_id
   for update;

  if not found then
    return query select 'NOT_FOUND'::text, null::public.protocol_attempts;
    return;
  end if;

  if v_row.status = 'in_progress' and v_row.probe_run_id = p_probe_run_id then
    return query select 'ALREADY_STARTED'::text, v_row;
    return;
  end if;

  if v_row.status <> 'reserved' then
    return query select 'CONFLICT'::text, v_row;
    return;
  end if;

  update public.protocol_attempts pr
     set status = 'in_progress',
         probe_run_id = p_probe_run_id,
         last_activity_at = now()
   where pr.id = p_attempt_id
     and pr.project_id = p_project_id
     and pr.status = 'reserved'
  returning pr.* into v_row;

  return query select 'STARTED'::text, v_row;
end;
$$;

revoke all on function
  public.start_attempt(uuid, uuid, uuid) from public;
revoke all on function
  public.start_attempt(uuid, uuid, uuid) from anon;
revoke all on function
  public.start_attempt(uuid, uuid, uuid) from authenticated;
grant execute on function
  public.start_attempt(uuid, uuid, uuid) to service_role;
