-- Store the canonical V1 protocol report alongside its markdown projection.
--
-- Why a column rather than reusing short_report_markdown:
--
-- The legacy client page renders by regex-parsing the short markdown
-- (lib/snapshot-requests/parse-public-report.ts matches literal headings such
-- as "1. Executive diagnosis" and prose like /^In that frame,/). That chain is
-- DB -> markdown -> regex -> React, and when a renderer's wording drifts the
-- page silently degrades to "Not measured" instead of failing. A client-facing
-- number must not depend on prose matching, so the V1 report is stored as the
-- structured payload the page renders directly. The markdown stays, but as a
-- human-auditable projection rather than the source of truth.
--
-- This satisfies "one canonical snapshot must drive all client views and
-- artifacts": the payload is written once and read back verbatim. The client
-- page never re-derives an observation at render time, so a later analyzer
-- change cannot silently restate a number already delivered.
--
-- Why a new function rather than editing save_snapshot_report_artifact_manual
-- (0031): that function fences on `status = 'running' and claim_token is null`,
-- which is correct for the legacy mvp-scan worker path and wrong for the M4/M5
-- path added in 0062, where an approved request terminates on status
-- 'approved' and is executed through protocol_execution_jobs. Editing the
-- existing guard in place would break the legacy path's fencing tests for no
-- benefit. The legacy function is left completely untouched.
--
-- Rollback:
--   drop function if exists public.save_protocol_report_artifact(
--     uuid, uuid, text, text, text, text, timestamptz, jsonb);
--   alter table public.snapshot_report_artifacts
--     drop constraint if exists snapshot_report_artifacts_payload_is_object;
--   alter table public.snapshot_report_artifacts
--     drop column if exists report_payload;
--
-- The column is nullable and additive, so rolling it back cannot destroy any
-- pre-existing artifact: every column the legacy path writes is untouched.

alter table
  public.snapshot_report_artifacts
add column if not exists
  report_payload jsonb null;

-- A payload, when present, must be a JSON object. A bare string or array
-- would parse but could never satisfy the page's contract, and finding that
-- out at render time in front of a client is the wrong place.
alter table
  public.snapshot_report_artifacts
drop constraint if exists
  snapshot_report_artifacts_payload_is_object;

alter table
  public.snapshot_report_artifacts
add constraint
  snapshot_report_artifacts_payload_is_object
check (
  report_payload is null
  or jsonb_typeof(report_payload) = 'object'
);

comment on column public.snapshot_report_artifacts.report_payload is
  'Canonical V1 protocol report (lib/reports/protocol-report-types.ts). '
  'Null for legacy mvp-scan artifacts, which the markdown parser still serves.';

-- ── Save for the M4/M5 protocol path ─────────────────────────────────

create or replace function
  public.save_protocol_report_artifact(
    p_request_id uuid,
    p_project_id uuid,
    p_full_markdown text,
    p_short_markdown text,
    p_full_filename text,
    p_short_filename text,
    p_generated_at timestamptz,
    p_payload jsonb
  )
returns setof public.snapshot_report_artifacts
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_request public.snapshot_requests%rowtype;
  v_artifact public.snapshot_report_artifacts%rowtype;
  v_result public.snapshot_report_artifacts%rowtype;
  v_succeeded_jobs integer;
begin
  perform public._assert_snapshot_artifact_input(
    p_full_markdown,
    p_short_markdown,
    p_full_filename,
    p_short_filename,
    p_generated_at
  );

  if p_payload is null
     or jsonb_typeof(p_payload) <> 'object' then
    raise exception
      'save_protocol_report_artifact requires a JSON object payload';
  end if;

  select request.*
    into v_request
    from public.snapshot_requests request
   where request.id = p_request_id
     and request.project_id = p_project_id
   for update;

  if not found then
    return;
  end if;

  -- This function serves the M4/M5 path only. A request with no protocol was
  -- approved through the legacy path and must keep using the legacy writer,
  -- whose fencing guarantees are different.
  if v_request.protocol_id is null then
    return;
  end if;

  if v_request.status <> 'approved' then
    return;
  end if;

  -- Evidence must be complete before it can be described to a client. A job
  -- still running, failed, or awaiting review fails closed here rather than
  -- producing a confident-looking report over a partial sample.
  select count(*)
    into v_succeeded_jobs
    from public.protocol_execution_jobs job
   where job.protocol_id = v_request.protocol_id
     and job.status = 'succeeded';

  if v_succeeded_jobs = 0 then
    return;
  end if;

  select artifact.*
    into v_artifact
    from public.snapshot_report_artifacts artifact
   where artifact.snapshot_request_id = p_request_id
   for update;

  -- A delivered artifact is immutable. The client has already read it, so a
  -- silent rewrite would change history under them.
  if found
     and v_artifact.delivered_at is not null then
    return;
  end if;

  if not found then
    insert into public.snapshot_report_artifacts (
      snapshot_request_id,
      project_id,
      full_report_markdown,
      short_report_markdown,
      full_report_filename,
      short_report_filename,
      generated_at,
      report_payload,
      public_token
    )
    values (
      p_request_id,
      p_project_id,
      p_full_markdown,
      p_short_markdown,
      p_full_filename,
      p_short_filename,
      p_generated_at,
      p_payload,
      public._generate_snapshot_public_token()
    )
    returning * into v_result;
  else
    update public.snapshot_report_artifacts
       set full_report_markdown = p_full_markdown,
           short_report_markdown = p_short_markdown,
           full_report_filename = p_full_filename,
           short_report_filename = p_short_filename,
           generated_at = p_generated_at,
           report_payload = p_payload,
           updated_at = now()
     where snapshot_request_id = p_request_id
    returning * into v_result;
  end if;

  -- Never finalizes and never delivers: both stay separate, reviewable steps.
  return next v_result;
end;
$$;

revoke all on function
  public.save_protocol_report_artifact(
    uuid, uuid, text, text, text, text, timestamptz, jsonb
  )
from public;

revoke all on function
  public.save_protocol_report_artifact(
    uuid, uuid, text, text, text, text, timestamptz, jsonb
  )
from anon;

revoke all on function
  public.save_protocol_report_artifact(
    uuid, uuid, text, text, text, text, timestamptz, jsonb
  )
from authenticated;

grant execute on function
  public.save_protocol_report_artifact(
    uuid, uuid, text, text, text, text, timestamptz, jsonb
  )
to service_role;
