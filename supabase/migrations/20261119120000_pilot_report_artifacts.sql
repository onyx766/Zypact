-- Pilot report artifacts (D-053, D-055): one combined report for all of a
-- pilot's questions, saved as append-only revisions and shared by link once
-- the founder has reviewed it.
--
-- Applies after 20261118120000 (pilot questions). Depends only on objects
-- from 0047-0081 and the two pilot migrations; nothing from the account
-- stack (Q2'-1 to Q4).
--
-- What this adds:
--   1. `pilot_report_artifacts`: each revision's Markdown, payload and
--      evidence manifest, its integrity status paired with its reasons (as
--      0068 and 0076 pair them), a content hash, a link token, and who
--      reviewed and shared it. Revisions are append-only: a new build is a
--      new revision. Before it is shared, only the review and share fields
--      can be written, once; after it is shared, nothing can change. No row
--      can be deleted (`pilot_report_artifacts_guard`).
--   2. `save_pilot_report_artifact`: stores a revision only when none of the
--      pilot's measurements is still running (no live lease or pending run
--      request on a job of its protocols or their retests, and no attempt
--      still reserved or in progress), its manifest names exactly the
--      pilot's protocols, including those of retired questions, and every
--      attempt of them, each attempt belongs to the protocol it is listed
--      under, and each listed response hash matches the stored one.
--      Otherwise it stores nothing and answers MEASUREMENT_IN_PROGRESS,
--      EVIDENCE_OUTSIDE_PILOT, EVIDENCE_INCOMPLETE or EVIDENCE_MISMATCH.
--   3. `share_pilot_report_artifact`: refuses a `blocked` revision, a
--      `needs_review` revision without the founder's explicit
--      acknowledgement, and any revision that is not the pilot's latest.
--   4. `read_shared_pilot_report`: the client page's only read. It answers a
--      shared, non-blocked revision for a well-formed token, and nothing
--      else.
--
-- Nothing here calls a provider or a model, sends anything, or writes an
-- attempt, receipt, probe row, protocol or job. No existing row is updated,
-- deleted or backfilled, and no existing function is redefined. Every
-- function pins its search_path and is executable by service_role only (the
-- guard trigger's function by no role). The table has RLS on with no policy,
-- and service_role may only read it.
--
-- Rollback / forward recovery (the web app first, then the database):
--   1. Roll the web app back. Shared links stop resolving (the page is gone).
--   2. drop function if exists public.read_shared_pilot_report(text);
--      drop function if exists public.share_pilot_report_artifact(uuid, uuid, uuid, boolean);
--      drop function if exists public.save_pilot_report_artifact(uuid, uuid, text, jsonb, jsonb, text, jsonb, timestamptz);
--      drop table if exists public.pilot_report_artifacts;
--      drop function if exists public.pilot_report_artifacts_guard();
--   Dropping the table loses only report revisions, which can be rebuilt
--   from the evidence; no evidence, protocol, pilot or question row
--   references it.

-- ---------------------------------------------------------------------
-- 1. pilot_report_artifacts
-- ---------------------------------------------------------------------

create table if not exists public.pilot_report_artifacts (
  id                         uuid primary key default gen_random_uuid(),
  pilot_id                   uuid not null,
  project_id                 uuid not null,
  revision                   integer not null check (revision >= 1),

  markdown                   text not null check (char_length(btrim(markdown)) > 0),
  payload                    jsonb not null check (jsonb_typeof(payload) = 'object'),
  -- The protocols and attempts the payload was built from, each attempt
  -- with its stored response hash. Checked by save_pilot_report_artifact.
  manifest                   jsonb not null check (jsonb_typeof(manifest) = 'object'),
  -- sha256(sha256(markdown) || sha256(payload::text)), as 0076's revision
  -- hash is built.
  content_sha256             text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  generated_at               timestamptz not null,

  integrity_status           text not null
                             check (integrity_status in ('integrity_passed', 'needs_review', 'blocked')),
  integrity_reasons          jsonb not null default '[]'::jsonb
                             check (jsonb_typeof(integrity_reasons) = 'array'),

  public_token               text not null check (public_token ~ '^[0-9a-f]{64}$'),

  created_by                 uuid not null,
  created_at                 timestamptz not null default now(),

  -- In this phase the founder's review and the share are one act.
  reviewed_by                uuid null,
  reviewed_at                timestamptz null,
  shared_at                  timestamptz null,
  needs_review_acknowledged  boolean not null default false,

  constraint pilot_report_artifacts_pilot_fk
    foreign key (pilot_id, project_id)
    references public.pilots (id, project_id)
    on delete restrict,
  constraint pilot_report_artifacts_revision_key unique (pilot_id, revision),
  constraint pilot_report_artifacts_token_key unique (public_token),
  -- 0068's pairing: a pass carries no reason, anything less names one.
  constraint pilot_report_artifacts_integrity_reasons_pair_check check (
    (integrity_status = 'integrity_passed' and jsonb_array_length(integrity_reasons) = 0)
    or (integrity_status <> 'integrity_passed' and jsonb_array_length(integrity_reasons) > 0)
  ),
  constraint pilot_report_artifacts_share_check check (
    (shared_at is null) = (reviewed_at is null)
    and (shared_at is null) = (reviewed_by is null)
    and (integrity_status <> 'blocked' or shared_at is null)
    and (needs_review_acknowledged = (integrity_status = 'needs_review' and shared_at is not null))
  )
);

create index if not exists pilot_report_artifacts_pilot_idx
  on public.pilot_report_artifacts (pilot_id, revision desc);

comment on table public.pilot_report_artifacts is
  'D-055: revisions of a pilot''s combined report. Append-only; written only by save_pilot_report_artifact and share_pilot_report_artifact; immutable once shared.';

alter table public.pilot_report_artifacts enable row level security;

revoke all on table public.pilot_report_artifacts from public, anon, authenticated, service_role;
grant select on table public.pilot_report_artifacts to service_role;

-- ---------------------------------------------------------------------
-- 2. The append-only guard
-- ---------------------------------------------------------------------

create or replace function public.pilot_report_artifacts_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'pilot_report_artifacts_are_append_only';
  end if;

  if old.shared_at is not null then
    raise exception using errcode = 'P0001', message = 'pilot_report_artifact_is_shared_and_immutable';
  end if;

  if (new.id, new.pilot_id, new.project_id, new.revision, new.markdown, new.payload, new.manifest,
      new.content_sha256, new.generated_at, new.integrity_status, new.integrity_reasons,
      new.public_token, new.created_by, new.created_at)
     is distinct from
     (old.id, old.pilot_id, old.project_id, old.revision, old.markdown, old.payload, old.manifest,
      old.content_sha256, old.generated_at, old.integrity_status, old.integrity_reasons,
      old.public_token, old.created_by, old.created_at) then
    raise exception using errcode = 'P0001', message = 'pilot_report_artifact_content_is_immutable';
  end if;

  return new;
end;
$$;

revoke all on function public.pilot_report_artifacts_guard() from public, anon, authenticated, service_role;

drop trigger if exists pilot_report_artifacts_guard on public.pilot_report_artifacts;
create trigger pilot_report_artifacts_guard
  before update or delete on public.pilot_report_artifacts
  for each row execute function public.pilot_report_artifacts_guard();

-- ---------------------------------------------------------------------
-- 3. save_pilot_report_artifact
-- ---------------------------------------------------------------------

create or replace function public.save_pilot_report_artifact(
  p_pilot_id           uuid,
  p_created_by         uuid,
  p_markdown           text,
  p_payload            jsonb,
  p_manifest           jsonb,
  p_integrity_status   text,
  p_integrity_reasons  jsonb,
  p_generated_at       timestamptz
)
returns table (outcome text, artifact_id uuid, revision integer)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_pilot public.pilots%rowtype;
  v_manifest_protocols uuid[];
  v_pilot_protocols uuid[];
  v_revision integer;
  v_id uuid;
begin
  if p_pilot_id is null or p_created_by is null
     or p_markdown is null or char_length(btrim(p_markdown)) = 0
     or p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or (p_payload ->> 'pilotId') is distinct from p_pilot_id::text
     or p_manifest is null or jsonb_typeof(p_manifest) <> 'object'
     or jsonb_typeof(p_manifest -> 'protocols') is distinct from 'array'
     or jsonb_typeof(p_manifest -> 'attempts') is distinct from 'array'
     or p_generated_at is null
     or p_integrity_status is null
     or p_integrity_status not in ('integrity_passed', 'needs_review', 'blocked')
     or p_integrity_reasons is null or jsonb_typeof(p_integrity_reasons) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_save_pilot_report_args';
  end if;

  if (p_integrity_status = 'integrity_passed') <> (jsonb_array_length(p_integrity_reasons) = 0) then
    raise exception using errcode = '22023', message = 'invalid_save_pilot_report_args';
  end if;

  -- Every manifest entry is well formed, and nothing is listed twice.
  if exists (
       select 1 from jsonb_array_elements(p_manifest -> 'protocols') e
        where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ v_uuid)
     or exists (
       select 1 from jsonb_array_elements(p_manifest -> 'attempts') e
        where jsonb_typeof(e) <> 'object'
           or jsonb_typeof(e -> 'id') is distinct from 'string' or (e ->> 'id') !~ v_uuid
           or jsonb_typeof(e -> 'protocolId') is distinct from 'string' or (e ->> 'protocolId') !~ v_uuid
           or not (jsonb_typeof(e -> 'rawResponseSha256') in ('null', 'string'))
           or (jsonb_typeof(e -> 'rawResponseSha256') = 'string' and (e ->> 'rawResponseSha256') !~ '^[0-9a-f]{64}$'))
     or (select count(*) from jsonb_array_elements(p_manifest -> 'protocols'))
        <> (select count(distinct e #>> '{}') from jsonb_array_elements(p_manifest -> 'protocols') e)
     or (select count(*) from jsonb_array_elements(p_manifest -> 'attempts'))
        <> (select count(distinct e ->> 'id') from jsonb_array_elements(p_manifest -> 'attempts') e) then
    raise exception using errcode = '22023', message = 'invalid_save_pilot_report_args';
  end if;

  -- Serialises revision numbers per pilot.
  select * into v_pilot from public.pilots where id = p_pilot_id for update;
  if not found then
    return query select 'PILOT_NOT_FOUND'::text, null::uuid, null::integer;
    return;
  end if;

  if (p_payload ->> 'projectId') is distinct from v_pilot.project_id::text then
    return query select 'EVIDENCE_OUTSIDE_PILOT'::text, null::uuid, null::integer;
    return;
  end if;

  -- A measurement still running: answers may still be written, so the
  -- report would read a moving target. Checked before the evidence, so a
  -- build that raced a run is refused for what it is. The pilot row lock
  -- above is the one request_protocol_job_run takes for share, so no new Run
  -- can be requested for this pilot while the save runs.
  if exists (
    select 1
      from public.pilot_questions pq
      join public.pilot_question_protocols pqp on pqp.pilot_question_id = pq.id
      join public.protocols pr
        on pr.id = pqp.protocol_id or pr.baseline_protocol_id = pqp.protocol_id
      left join public.protocol_execution_jobs j on j.protocol_id = pr.id
     where pq.pilot_id = p_pilot_id
       and (
         (j.status in ('claimed', 'running') and j.lease_expires_at > now())
         or exists (
           select 1
             from public.protocol_job_run_requests r
            where r.job_id = j.id
              and r.status = 'pending'
              and r.expires_at > now())
         or exists (
           select 1
             from public.protocol_attempts a
            where a.protocol_id = pr.id
              and a.status in ('reserved', 'in_progress'))
       )
  ) then
    return query select 'MEASUREMENT_IN_PROGRESS'::text, null::uuid, null::integer;
    return;
  end if;

  v_manifest_protocols := array(
    select (e #>> '{}')::uuid from jsonb_array_elements(p_manifest -> 'protocols') e);
  v_pilot_protocols := array(
    select pqp.protocol_id
      from public.pilot_question_protocols pqp
      join public.pilot_questions pq on pq.id = pqp.pilot_question_id
     where pq.pilot_id = p_pilot_id);

  -- A protocol that is not one of this pilot's.
  if exists (select unnest(v_manifest_protocols) except select unnest(v_pilot_protocols)) then
    return query select 'EVIDENCE_OUTSIDE_PILOT'::text, null::uuid, null::integer;
    return;
  end if;

  -- An attempt that does not exist, belongs to another protocol or project,
  -- or is listed under a protocol the manifest does not name.
  if exists (
    select 1
      from jsonb_array_elements(p_manifest -> 'attempts') e
      left join public.protocol_attempts a on a.id = (e ->> 'id')::uuid
     where a.id is null
        or a.protocol_id <> (e ->> 'protocolId')::uuid
        or a.project_id <> v_pilot.project_id
        or not ((e ->> 'protocolId')::uuid = any (v_manifest_protocols))) then
    return query select 'EVIDENCE_OUTSIDE_PILOT'::text, null::uuid, null::integer;
    return;
  end if;

  -- A pilot protocol, retired questions' included, or one of its attempts,
  -- left out: the report would hide failed or excluded attempts.
  if exists (select unnest(v_pilot_protocols) except select unnest(v_manifest_protocols))
     or exists (
       select 1 from public.protocol_attempts a
        where a.protocol_id = any (v_pilot_protocols)
          and not exists (
            select 1 from jsonb_array_elements(p_manifest -> 'attempts') e
             where (e ->> 'id')::uuid = a.id)) then
    return query select 'EVIDENCE_INCOMPLETE'::text, null::uuid, null::integer;
    return;
  end if;

  -- Each listed response hash is the stored one (none where no result exists).
  if exists (
    select 1
      from jsonb_array_elements(p_manifest -> 'attempts') e
      join public.protocol_attempts a on a.id = (e ->> 'id')::uuid
      left join public.probe_results r on r.probe_run_id = a.probe_run_id
     where (e ->> 'rawResponseSha256') is distinct from r.raw_response_sha256) then
    return query select 'EVIDENCE_MISMATCH'::text, null::uuid, null::integer;
    return;
  end if;

  select coalesce(max(pra.revision), 0) + 1 into v_revision
    from public.pilot_report_artifacts pra
   where pra.pilot_id = p_pilot_id;

  insert into public.pilot_report_artifacts (
    pilot_id, project_id, revision, markdown, payload, manifest, content_sha256,
    generated_at, integrity_status, integrity_reasons, public_token, created_by
  ) values (
    p_pilot_id, v_pilot.project_id, v_revision, p_markdown, p_payload, p_manifest,
    encode(sha256(sha256(convert_to(p_markdown, 'UTF8')) || sha256(convert_to(p_payload::text, 'UTF8'))), 'hex'),
    p_generated_at, p_integrity_status, p_integrity_reasons,
    replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
    p_created_by
  )
  returning id into v_id;

  return query select 'SAVED'::text, v_id, v_revision;
end;
$$;

revoke all on function public.save_pilot_report_artifact(uuid, uuid, text, jsonb, jsonb, text, jsonb, timestamptz) from public;
revoke all on function public.save_pilot_report_artifact(uuid, uuid, text, jsonb, jsonb, text, jsonb, timestamptz) from anon;
revoke all on function public.save_pilot_report_artifact(uuid, uuid, text, jsonb, jsonb, text, jsonb, timestamptz) from authenticated;
grant execute on function public.save_pilot_report_artifact(uuid, uuid, text, jsonb, jsonb, text, jsonb, timestamptz) to service_role;

-- ---------------------------------------------------------------------
-- 4. share_pilot_report_artifact
-- ---------------------------------------------------------------------

create or replace function public.share_pilot_report_artifact(
  p_artifact_id               uuid,
  p_pilot_id                  uuid,
  p_shared_by                 uuid,
  p_acknowledge_needs_review  boolean
)
returns table (outcome text, public_token text)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_art public.pilot_report_artifacts%rowtype;
begin
  if p_artifact_id is null or p_pilot_id is null or p_shared_by is null or p_acknowledge_needs_review is null then
    raise exception using errcode = '22023', message = 'invalid_share_pilot_report_args';
  end if;

  -- The same lock a save takes, so "latest" cannot change underneath.
  perform 1 from public.pilots where id = p_pilot_id for share;

  select * into v_art
    from public.pilot_report_artifacts pra
   where pra.id = p_artifact_id and pra.pilot_id = p_pilot_id
   for update;
  if not found then
    return query select 'NOT_FOUND'::text, null::text;
    return;
  end if;

  if v_art.shared_at is not null then
    return query select 'ALREADY_SHARED'::text, v_art.public_token;
    return;
  end if;

  if v_art.integrity_status = 'blocked' then
    return query select 'BLOCKED'::text, null::text;
    return;
  end if;

  if exists (
    select 1 from public.pilot_report_artifacts pra
     where pra.pilot_id = p_pilot_id and pra.revision > v_art.revision) then
    return query select 'NOT_LATEST'::text, null::text;
    return;
  end if;

  if v_art.integrity_status = 'needs_review' and not p_acknowledge_needs_review then
    return query select 'ACKNOWLEDGEMENT_REQUIRED'::text, null::text;
    return;
  end if;

  update public.pilot_report_artifacts pra
     set reviewed_by = p_shared_by,
         reviewed_at = now(),
         shared_at = now(),
         needs_review_acknowledged = (v_art.integrity_status = 'needs_review')
   where pra.id = v_art.id;

  return query select 'SHARED'::text, v_art.public_token;
end;
$$;

revoke all on function public.share_pilot_report_artifact(uuid, uuid, uuid, boolean) from public;
revoke all on function public.share_pilot_report_artifact(uuid, uuid, uuid, boolean) from anon;
revoke all on function public.share_pilot_report_artifact(uuid, uuid, uuid, boolean) from authenticated;
grant execute on function public.share_pilot_report_artifact(uuid, uuid, uuid, boolean) to service_role;

-- ---------------------------------------------------------------------
-- 5. read_shared_pilot_report
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
  select a.payload, a.revision, a.generated_at, a.shared_at,
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
