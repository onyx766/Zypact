-- Pilot report links and the unscoped protocol claims (D-059 item 9,
-- D-060).
--
-- Purpose:
--   1. Once a later revision of a pilot's report has been shared, the link
--      to an earlier shared revision stops working (D-059 item 9, approved by
--      the founder on 2026-11-17). Enforced here, in the customer page's only
--      read, so the earlier report's content never leaves the database.
--   2. The two unscoped protocol claims can no longer be called by
--      service_role (D-054 Open, "The older claims"; D-060). The live worker
--      claims only the job a Run named (D-052), so after this migration a
--      queued job without a pending run request is inert: a worker image
--      running older code can no longer take a pilot's queued job.
--
-- Decision references: D-059 (the founder's rulings, item 9), D-060 (this
-- migration's engineering), D-052 and D-054 (the requested claim), D-037
-- (the held 0085, which plans the same revoke).
--
-- Release order (D-058 item 4): numbered strictly between 20261109160000
-- and 20261110120000. It applies directly after 20261109160000 (pilot
-- actions), with expected_prev 20261109160000, and before the worker and
-- web app built from the same release commit are deployed. It depends only
-- on objects from 0050, 0054, 0059, 20261109130000, 20261109140000 and
-- 20261109150000; nothing from the account stack (P1 to Q4,
-- 20261110120000-20261113120000).
--
-- What it changes:
--   1. `read_shared_pilot_report(text)` (20261109150000 section 5) is
--      redefined with the same signature, the same output columns, SECURITY
--      DEFINER, STABLE and the same pinned search_path, so `create or
--      replace` keeps its grants; they are restated below exactly as
--      20261109150000 wrote them. Its body is 20261109150000's byte for byte
--      apart from one block marked D-060 begin/end, which replaces the first
--      line of its select list (scripts/test-pilot-links-and-claims.ts
--      checks this). For a shared, non-blocked revision with a well-formed
--      token:
--        - when a later revision of the same pilot has been shared, the row
--          still comes back, with `newer_shared_revision` true and `payload`
--          NULL, so the page can say the link was replaced without
--          receiving the earlier report;
--        - otherwise the row comes back with its payload and the flag false,
--          as before.
--      An unshared or blocked revision still reads nothing, and an unshared
--      or blocked later revision replaces nothing (a blocked revision can
--      never be shared, by function and by constraint).
--   2. `claim_protocol_execution_job(text, integer)` (0050, redefined by
--      0054) and `claim_protocol_execution_job_by_id(text, integer, uuid,
--      uuid)` (0059) lose EXECUTE for service_role (`revoke all`: EXECUTE is
--      the only privilege a function has). Their revokes for public, anon
--      and authenticated are restated as 0054 and 0059 wrote them; 0057
--      changed table privileges only. Neither function is created, replaced,
--      dropped or altered; test:m5-0059-schema and test:m5-0060-schema pin
--      their bodies. No suite that calls them applies this migration: each
--      applies a bounded migration set that ends before it (the 0050 to
--      0054 runtimes, the 0059 and 0060 runtimes, test:m5-a-stack-runtime
--      up to 0056, test:m7-0077-runtime up to 0077, and PG-9's 0001-0081
--      and 0083, which refuses timestamped files). Three of them call as
--      service_role and would be refused (42501) if their set ever reached
--      this migration: PG-9 and test:m5-a-stack-runtime over PostgREST with
--      the service-role key, and test:m5-0059-runtime through `set role
--      service_role`. Before that, each must move to the requested claim or
--      call as the owner, as the others do (the 0060 runtime through a
--      SECURITY DEFINER helper).
--      `claim_requested_protocol_execution_job(text, integer)`, the live
--      worker's claim (scripts/run-protocol-worker.ts), keeps its grant.
--
-- Preconditions (each refuses the whole migration, which then changes
-- nothing):
--   - `pilot_report_artifacts` and `read_shared_pilot_report(text)` exist,
--     with 20261109150000's output columns;
--   - both unscoped claims exist;
--   - `claim_requested_protocol_execution_job(text, integer)` exists and is
--     executable by service_role, so the live worker keeps a claim.
-- Postconditions (checked after every change; applied in one transaction,
-- as the named-file procedure applies it, a refusal rolls back the whole
-- apply). scripts/test-pilot-links-and-claims-db.ts G makes each
-- precondition refuse, and the postconditions on the unscoped claims and on
-- the read's grants:
--   - neither unscoped claim is executable by service_role, anon or
--     authenticated (this also catches a grant to PUBLIC, or one through a
--     role membership, that the revokes could not remove);
--   - the requested claim and the read stay executable by service_role, and
--     the read by neither anon nor authenticated;
--   - the read is SECURITY DEFINER, STABLE, with its pinned search_path.
--
-- Nothing here calls a provider or a model, sends anything, or writes,
-- updates or deletes a row. No table, column, index, trigger or policy is
-- created, changed or dropped. `pilot_report_artifacts` stays append-only:
-- an earlier revision's payload is still stored, and only this read
-- withholds it.
--
-- Rollback / forward recovery (each a separately authorised forward step):
--   1. Older links: to restore the old read, re-run 20261109150000 section
--      5 (its definition of read_shared_pilot_report and its four privilege
--      lines). That restores the function only. The earlier payloads were
--      never deleted, because the table is append-only, but this step alone
--      reopens no older link:
--        - the web app built with this migration (D-060) shows the
--          "replaced" notice for every link the restored function flags, by
--          design: it decides by the flag before the payload;
--        - production's web deployment from before step 7 of
--          docs/PILOT_PRODUCTION_PLAN.md has no pilot report page, so
--          promoting it turns every pilot link into a 404, the newest
--          included;
--        - a web build from before D-060 that has the pilot report page
--          (for example one built from main at d03363f, never deployed)
--          serves an earlier link's payload only with the restored
--          function; with this migration's read it serves the newest link
--          and answers 404 for the earlier ones.
--      Reopening older links therefore needs both the restored function and
--      a separately authorised deploy of such a build.
--   2. The unscoped claims: these two statements restore both, as 0054 and
--      0059 granted them:
--        grant execute on function public.claim_protocol_execution_job(text, integer) to service_role;
--        grant execute on function public.claim_protocol_execution_job_by_id(text, integer, uuid, uuid) to service_role;
--      Do it only by decision: with them restored, a worker image running
--      code from before D-052 could again take any queued job, a pilot's
--      included, without a Run. The held 0085 (D-037) revokes them again.
--   Recovery never needs the account stack, and nothing here is
--   destructive to evidence.

-- ---------------------------------------------------------------------
-- 0. Preconditions
-- ---------------------------------------------------------------------

do $pre$
begin
  if to_regclass('public.pilot_report_artifacts') is null
     or to_regprocedure('public.read_shared_pilot_report(text)') is null then
    raise exception using errcode = 'P0001',
      message = '20261109170000 precondition: 20261109150000 (pilot report artifacts) is not applied';
  end if;

  if pg_get_function_result('public.read_shared_pilot_report(text)'::regprocedure)
     is distinct from 'TABLE(payload jsonb, revision integer, generated_at timestamp with time zone, shared_at timestamp with time zone, newer_shared_revision boolean)' then
    raise exception using errcode = 'P0001',
      message = '20261109170000 precondition: read_shared_pilot_report does not return 20261109150000''s columns';
  end if;

  if to_regprocedure('public.claim_protocol_execution_job(text, integer)') is null
     or to_regprocedure('public.claim_protocol_execution_job_by_id(text, integer, uuid, uuid)') is null then
    raise exception using errcode = 'P0001',
      message = '20261109170000 precondition: an unscoped protocol claim (0054, 0059) is missing';
  end if;

  if to_regprocedure('public.claim_requested_protocol_execution_job(text, integer)') is null
     or not has_function_privilege('service_role', 'public.claim_requested_protocol_execution_job(text, integer)', 'execute') then
    raise exception using errcode = 'P0001',
      message = '20261109170000 precondition: the requested claim (20261109130000) is missing or not executable by service_role, so the worker would be left without a claim';
  end if;
end
$pre$;

-- ---------------------------------------------------------------------
-- 1. read_shared_pilot_report: an earlier shared revision's link stops
--    working once a later revision has been shared (D-059 item 9)
-- ---------------------------------------------------------------------

create or replace function public.read_shared_pilot_report(p_public_token text)
returns table (
  payload jsonb,
  revision integer,
  generated_at timestamptz,
  shared_at timestamptz,
  newer_shared_revision boolean
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  -- D-060 begin: once a later revision of the same pilot has been shared,
  -- this revision's payload is withheld (D-059 item 9). The test is the
  -- flag's own, so the two always agree.
  select case when exists (
                select 1 from public.pilot_report_artifacts b
                 where b.pilot_id = a.pilot_id
                   and b.revision > a.revision
                   and b.shared_at is not null)
              then null::jsonb
              else a.payload
         end,
         a.revision, a.generated_at, a.shared_at,
  -- D-060 end
         exists (
           select 1 from public.pilot_report_artifacts b
            where b.pilot_id = a.pilot_id
              and b.revision > a.revision
              and b.shared_at is not null)
    from public.pilot_report_artifacts a
   where p_public_token ~ '^[0-9a-f]{64}$'
     and a.public_token = p_public_token
     and a.shared_at is not null
     and a.integrity_status <> 'blocked';
$$;

revoke all on function public.read_shared_pilot_report(text) from public;
revoke all on function public.read_shared_pilot_report(text) from anon;
revoke all on function public.read_shared_pilot_report(text) from authenticated;
grant execute on function public.read_shared_pilot_report(text) to service_role;

-- ---------------------------------------------------------------------
-- 2. The unscoped claims: no API role may call them (D-054 Open, D-060)
-- ---------------------------------------------------------------------

revoke all on function
  public.claim_protocol_execution_job(text, integer) from public;
revoke all on function
  public.claim_protocol_execution_job(text, integer) from anon;
revoke all on function
  public.claim_protocol_execution_job(text, integer) from authenticated;
revoke all on function
  public.claim_protocol_execution_job(text, integer) from service_role;

revoke all on function
  public.claim_protocol_execution_job_by_id(text, integer, uuid, uuid) from public;
revoke all on function
  public.claim_protocol_execution_job_by_id(text, integer, uuid, uuid) from anon;
revoke all on function
  public.claim_protocol_execution_job_by_id(text, integer, uuid, uuid) from authenticated;
revoke all on function
  public.claim_protocol_execution_job_by_id(text, integer, uuid, uuid) from service_role;

-- ---------------------------------------------------------------------
-- 3. Postconditions
-- ---------------------------------------------------------------------

do $post$
declare
  v_role text;
begin
  foreach v_role in array array['service_role', 'anon', 'authenticated'] loop
    if has_function_privilege(v_role, 'public.claim_protocol_execution_job(text, integer)', 'execute')
       or has_function_privilege(v_role, 'public.claim_protocol_execution_job_by_id(text, integer, uuid, uuid)', 'execute') then
      raise exception using errcode = 'P0001',
        message = format('20261109170000 postcondition: %s can still execute an unscoped protocol claim', v_role);
    end if;
  end loop;

  if not has_function_privilege('service_role', 'public.claim_requested_protocol_execution_job(text, integer)', 'execute') then
    raise exception using errcode = 'P0001',
      message = '20261109170000 postcondition: service_role can no longer execute the requested claim';
  end if;

  if not has_function_privilege('service_role', 'public.read_shared_pilot_report(text)', 'execute')
     or has_function_privilege('anon', 'public.read_shared_pilot_report(text)', 'execute')
     or has_function_privilege('authenticated', 'public.read_shared_pilot_report(text)', 'execute') then
    raise exception using errcode = 'P0001',
      message = '20261109170000 postcondition: read_shared_pilot_report is not executable by service_role only';
  end if;

  if not exists (
    select 1 from pg_proc p
     where p.oid = 'public.read_shared_pilot_report(text)'::regprocedure
       and p.prosecdef
       and p.provolatile = 's'
       and p.proconfig = array['search_path=public, pg_temp']::text[]) then
    raise exception using errcode = 'P0001',
      message = '20261109170000 postcondition: read_shared_pilot_report is not SECURITY DEFINER and STABLE with its pinned search_path';
  end if;
end
$post$;
