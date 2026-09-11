-- Record the integrity decision on the artifact itself.
--
-- `lib/export/report-integrity.ts` already classifies a report into the three
-- canonical states — integrity_passed / needs_review / blocked — but nothing
-- stored the result, so the decision could not gate delivery and an admin had
-- no way to see WHY a report was held. Automatic delivery is only defensible
-- if the reason it was allowed is durable and auditable next to the artifact
-- it allowed.
--
-- The states carry the rules from the canonical package:
--   integrity_passed — may deliver automatically;
--   needs_review     — requires founder/admin review before delivery;
--   blocked          — never delivers.
--
-- `blocked` additionally must not be readable by a client. A blocked artifact
-- is still persisted, because a founder needs to see what was refused and
-- why, but the public report page refuses to render it.
--
-- Why the save function is dropped and recreated rather than overloaded:
-- adding parameters via `create or replace` would leave the 8-argument
-- version resident as a separate overload, and a caller that missed the new
-- arguments would keep writing artifacts with no integrity decision at all —
-- silently producing exactly the ungated rows this migration exists to
-- prevent. The 8-argument form was introduced in 0065 and is called only by
-- scripts/render-protocol-report.ts, which is updated in the same change.
--
-- Rollback:
--   drop function if exists public.save_protocol_report_artifact(
--     uuid, uuid, text, text, text, text, timestamptz, jsonb, text, jsonb);
--   -- then re-apply 0065's 8-argument function body.
--   alter table public.snapshot_report_artifacts
--     drop constraint if exists snapshot_report_artifacts_integrity_status_check,
--     drop column if exists integrity_reasons,
--     drop column if exists integrity_status;

alter table public.snapshot_report_artifacts
  add column if not exists integrity_status text null,
  add column if not exists integrity_reasons jsonb null;

alter table public.snapshot_report_artifacts
  drop constraint if exists snapshot_report_artifacts_integrity_status_check;

alter table public.snapshot_report_artifacts
  add constraint snapshot_report_artifacts_integrity_status_check
  check (
    integrity_status is null
    or integrity_status in ('integrity_passed', 'needs_review', 'blocked')
  );

comment on column public.snapshot_report_artifacts.integrity_status is
  'Canonical integrity decision. Null for legacy artifacts predating 0068. '
  'integrity_passed may auto-deliver; needs_review requires review; blocked '
  'never delivers and is not rendered to a client.';

drop function if exists public.save_protocol_report_artifact(
  uuid, uuid, text, text, text, text, timestamptz, jsonb
);

create or replace function
  public.save_protocol_report_artifact(
    p_request_id uuid,
    p_project_id uuid,
    p_full_markdown text,
    p_short_markdown text,
    p_full_filename text,
    p_short_filename text,
    p_generated_at timestamptz,
    p_payload jsonb,
    p_integrity_status text,
    p_integrity_reasons jsonb
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

  -- No default and no null: an artifact without a decision could be picked up
  -- by a delivery worker that treats "unknown" as "fine".
  if p_integrity_status is null
     or p_integrity_status not in
        ('integrity_passed', 'needs_review', 'blocked') then
    raise exception
      'save_protocol_report_artifact requires an integrity status';
  end if;

  if p_integrity_reasons is null
     or jsonb_typeof(p_integrity_reasons) <> 'array' then
    raise exception
      'save_protocol_report_artifact requires integrity reasons as a JSON array';
  end if;

  -- A passing decision with reasons attached is contradictory, and the
  -- contradiction would be invisible once stored.
  if p_integrity_status = 'integrity_passed'
     and jsonb_array_length(p_integrity_reasons) <> 0 then
    raise exception
      'integrity_passed must carry no reasons';
  end if;

  if p_integrity_status <> 'integrity_passed'
     and jsonb_array_length(p_integrity_reasons) = 0 then
    raise exception
      'a non-passing integrity status must carry at least one reason';
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

  if v_request.protocol_id is null then
    return;
  end if;

  if v_request.status <> 'approved' then
    return;
  end if;

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
      integrity_status,
      integrity_reasons,
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
      p_integrity_status,
      p_integrity_reasons,
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
           integrity_status = p_integrity_status,
           integrity_reasons = p_integrity_reasons,
           updated_at = now()
     where snapshot_request_id = p_request_id
    returning * into v_result;
  end if;

  return next v_result;
end;
$$;

revoke all on function
  public.save_protocol_report_artifact(
    uuid, uuid, text, text, text, text, timestamptz, jsonb, text, jsonb
  )
from public;

revoke all on function
  public.save_protocol_report_artifact(
    uuid, uuid, text, text, text, text, timestamptz, jsonb, text, jsonb
  )
from anon;

revoke all on function
  public.save_protocol_report_artifact(
    uuid, uuid, text, text, text, text, timestamptz, jsonb, text, jsonb
  )
from authenticated;

grant execute on function
  public.save_protocol_report_artifact(
    uuid, uuid, text, text, text, text, timestamptz, jsonb, text, jsonb
  )
to service_role;
