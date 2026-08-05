-- Token-fenced snapshot write RPCs.
--
-- PREPARATORY ONLY. This migration adds RPCs and corrects one existing
-- function. It revokes no table privilege and touches no default
-- privilege, so `service_role` can still write these tables directly.
-- Fencing does not become enforceable until migration 0032 revokes
-- INSERT/UPDATE/DELETE on `snapshot_requests` and
-- `snapshot_report_artifacts`. Nothing in the deployed application calls
-- anything added here.
--
-- Locking rule (mandatory, applied by every artifact RPC):
--   1. lock the `snapshot_requests` row FOR UPDATE;
--   2. lock the `snapshot_report_artifacts` row FOR UPDATE when present;
--   3. validate and mutate in the same transaction.
-- A token checked in one unlocked statement and written in another is a
-- TOCTOU hole, so ownership validation returns a row it already holds a
-- lock on.
--
-- `claimed_by` is diagnostic only. `claim_token` is the authorization
-- fence: a restarted process on the same VPS reuses its machine label
-- but can never reproduce a database-generated token.
--
-- No crawl, LLM agent, probe, or paid API call occurs in this migration.

-- ── Internal helpers ─────────────────────────────────────────────────

-- Lock the request row and prove the caller holds the active claim.
-- Returns the locked row, so the caller mutates under the same lock.
-- Never renews the lease: renewal stays an explicit operation.
create or replace function
  public._lock_active_snapshot_worker_claim(
    p_request_id uuid,
    p_project_id uuid,
    p_claim_token uuid
  )
returns public.snapshot_requests
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_request public.snapshot_requests%rowtype;
begin
  if p_request_id is null
     or p_project_id is null
     or p_claim_token is null then
    return null;
  end if;

  select request.*
    into v_request
    from public.snapshot_requests request
   where request.id = p_request_id
   for update;

  if not found then
    return null;
  end if;

  if v_request.project_id is null
     or v_request.project_id <> p_project_id
     or v_request.status <> 'running'
     or v_request.claimed_by is null
     or v_request.claim_token is null
     or v_request.lease_expires_at is null
     or v_request.claim_token <> p_claim_token
     or v_request.lease_expires_at <= now() then
    return null;
  end if;

  return v_request;
end;
$$;

revoke all on function
  public._lock_active_snapshot_worker_claim(uuid, uuid, uuid)
from public;
revoke all on function
  public._lock_active_snapshot_worker_claim(uuid, uuid, uuid)
from anon;
revoke all on function
  public._lock_active_snapshot_worker_claim(uuid, uuid, uuid)
from authenticated;
revoke all on function
  public._lock_active_snapshot_worker_claim(uuid, uuid, uuid)
from service_role;

-- 64-character hexadecimal token generated from two independent UUIDv4
-- values, hyphens removed. Satisfies the existing `char_length >= 43`
-- constraint and the route's /^[A-Za-z0-9_-]{43,128}$/ regex. Matches the
-- generator migration 0029 already used to backfill existing rows. Never
-- accepted from a caller.
create or replace function
  public._generate_snapshot_public_token()
returns text
language sql
security definer
volatile
set search_path = public, pg_temp
as $$
  select replace(gen_random_uuid()::text, '-', '')
      || replace(gen_random_uuid()::text, '-', '');
$$;

revoke all on function
  public._generate_snapshot_public_token()
from public;
revoke all on function
  public._generate_snapshot_public_token()
from anon;
revoke all on function
  public._generate_snapshot_public_token()
from authenticated;
revoke all on function
  public._generate_snapshot_public_token()
from service_role;

-- Shared artifact-field validation. Raises 22023 on invalid input.
create or replace function
  public._assert_snapshot_artifact_input(
    p_full_markdown text,
    p_short_markdown text,
    p_full_filename text,
    p_short_filename text,
    p_generated_at timestamptz
  )
returns void
language plpgsql
security definer
immutable
set search_path = public, pg_temp
as $$
begin
  if p_full_markdown is null
     or char_length(btrim(p_full_markdown)) = 0
     or p_short_markdown is null
     or char_length(btrim(p_short_markdown)) = 0
     or p_full_filename is null
     or char_length(btrim(p_full_filename)) = 0
     or p_short_filename is null
     or char_length(btrim(p_short_filename)) = 0
     or p_generated_at is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_snapshot_artifact_input';
  end if;
end;
$$;

revoke all on function
  public._assert_snapshot_artifact_input(text, text, text, text, timestamptz)
from public;
revoke all on function
  public._assert_snapshot_artifact_input(text, text, text, text, timestamptz)
from anon;
revoke all on function
  public._assert_snapshot_artifact_input(text, text, text, text, timestamptz)
from authenticated;
revoke all on function
  public._assert_snapshot_artifact_input(text, text, text, text, timestamptz)
from service_role;

-- ── Manual progress (signature unchanged) ────────────────────────────
--
-- Replaces the 0025 definition, preserving stage validation, rank
-- ordering, monotonic behavior, and return shape. Adds only the
-- manual-ownership guard so a worker-owned request cannot be advanced
-- through the manual path.

create or replace function
  public.update_snapshot_request_progress(
    p_request_id uuid,
    p_project_id uuid,
    p_progress_stage text
  )
returns setof public.snapshot_requests
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_request public.snapshot_requests%rowtype;
  v_current_rank integer;
  v_new_rank integer;
begin
  v_new_rank :=
    case p_progress_stage
      when 'reserved' then 1
      when 'crawling' then 2
      when 'analyzing_site' then 3
      when 'generating_questions' then 4
      when 'checking_ai_visibility' then 5
      when 'building_diagnosis' then 6
      when 'quality_review' then 7
      else null
    end;

  if v_new_rank is null then
    return;
  end if;

  select request.*
    into v_request
    from public.snapshot_requests request
   where request.id = p_request_id
     and request.project_id = p_project_id
     and request.status = 'running'
   for update;

  if not found then
    return;
  end if;

  -- A worker owns this request. The manual path must not touch it.
  if v_request.claim_token is not null then
    return;
  end if;

  v_current_rank :=
    case v_request.progress_stage
      when 'reserved' then 1
      when 'crawling' then 2
      when 'analyzing_site' then 3
      when 'generating_questions' then 4
      when 'checking_ai_visibility' then 5
      when 'building_diagnosis' then 6
      when 'quality_review' then 7
      else 0
    end;

  if v_new_rank < v_current_rank then
    return;
  end if;

  return query
  update public.snapshot_requests request
     set progress_stage = p_progress_stage,
         progress_updated_at =
           case
             when request.progress_stage is distinct from p_progress_stage
               then now()
             else request.progress_updated_at
           end,
         updated_at = now()
   where request.id = p_request_id
     and request.project_id = p_project_id
     and request.status = 'running'
  returning *;
end;
$$;

revoke all on function
  public.update_snapshot_request_progress(uuid, uuid, text)
from public;
revoke all on function
  public.update_snapshot_request_progress(uuid, uuid, text)
from anon;
revoke all on function
  public.update_snapshot_request_progress(uuid, uuid, text)
from authenticated;
grant execute on function
  public.update_snapshot_request_progress(uuid, uuid, text)
to service_role;

-- ── Manual finalization (signature unchanged) ────────────────────────
--
-- Replaces the 0026 definition. Adds the manual-ownership guard, an
-- artifact requirement for report_ready, and an artifact prohibition for
-- failed. Never touches artifact content or delivery metadata.

create or replace function
  public.finalize_snapshot_request(
    p_request_id uuid,
    p_project_id uuid,
    p_final_status text
  )
returns setof public.snapshot_requests
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_request public.snapshot_requests%rowtype;
  v_artifact_exists boolean;
begin
  if p_final_status not in (
    'report_ready',
    'failed'
  ) then
    raise exception using
      errcode = '22023',
      message = 'invalid_snapshot_final_status';
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

  -- A worker owns this request. The manual path must not finalize it.
  if v_request.claim_token is not null then
    return;
  end if;

  if v_request.status = p_final_status then
    return query
    select request.*
      from public.snapshot_requests request
     where request.id = p_request_id;

    return;
  end if;

  if v_request.status <> 'running' then
    return;
  end if;

  select exists (
    select 1
      from public.snapshot_report_artifacts artifact
     where artifact.snapshot_request_id = p_request_id
     for update
  )
    into v_artifact_exists;

  if p_final_status = 'report_ready' then
    if v_request.progress_stage is distinct from 'quality_review' then
      return;
    end if;

    -- report_ready without a stored report would be a lie to the founder.
    if not v_artifact_exists then
      return;
    end if;
  end if;

  if p_final_status = 'failed'
     and v_artifact_exists then
    -- A stored report contradicts failure. Leave it for founder repair.
    return;
  end if;

  return query
  update public.snapshot_requests
     set status = p_final_status,
         updated_at = now()
   where id = p_request_id
     and project_id = p_project_id
     and status = 'running'
  returning *;
end;
$$;

revoke all on function
  public.finalize_snapshot_request(uuid, uuid, text)
from public;
revoke all on function
  public.finalize_snapshot_request(uuid, uuid, text)
from anon;
revoke all on function
  public.finalize_snapshot_request(uuid, uuid, text)
from authenticated;
grant execute on function
  public.finalize_snapshot_request(uuid, uuid, text)
to service_role;

-- ── Worker progress ──────────────────────────────────────────────────

create or replace function
  public.update_snapshot_request_progress_worker(
    p_request_id uuid,
    p_project_id uuid,
    p_claim_token uuid,
    p_progress_stage text
  )
returns setof public.snapshot_requests
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_request public.snapshot_requests%rowtype;
  v_current_rank integer;
  v_new_rank integer;
begin
  v_new_rank :=
    case p_progress_stage
      when 'reserved' then 1
      when 'crawling' then 2
      when 'analyzing_site' then 3
      when 'generating_questions' then 4
      when 'checking_ai_visibility' then 5
      when 'building_diagnosis' then 6
      when 'quality_review' then 7
      else null
    end;

  if v_new_rank is null then
    return;
  end if;

  v_request :=
    public._lock_active_snapshot_worker_claim(
      p_request_id,
      p_project_id,
      p_claim_token
    );

  if v_request.id is null then
    return;
  end if;

  v_current_rank :=
    case v_request.progress_stage
      when 'reserved' then 1
      when 'crawling' then 2
      when 'analyzing_site' then 3
      when 'generating_questions' then 4
      when 'checking_ai_visibility' then 5
      when 'building_diagnosis' then 6
      when 'quality_review' then 7
      else 0
    end;

  if v_new_rank < v_current_rank then
    return;
  end if;

  -- Progress never renews the lease: a long stall between stages must
  -- stay detectable.
  return query
  update public.snapshot_requests request
     set progress_stage = p_progress_stage,
         progress_updated_at =
           case
             when request.progress_stage is distinct from p_progress_stage
               then now()
             else request.progress_updated_at
           end,
         updated_at = now()
   where request.id = p_request_id
  returning *;
end;
$$;

revoke all on function
  public.update_snapshot_request_progress_worker(uuid, uuid, uuid, text)
from public;
revoke all on function
  public.update_snapshot_request_progress_worker(uuid, uuid, uuid, text)
from anon;
revoke all on function
  public.update_snapshot_request_progress_worker(uuid, uuid, uuid, text)
from authenticated;
grant execute on function
  public.update_snapshot_request_progress_worker(uuid, uuid, uuid, text)
to service_role;

-- ── Atomic worker completion ─────────────────────────────────────────
--
-- Persists the artifact and finalizes the request in one transaction, so
-- the crash window between "report stored" and "request report_ready"
-- cannot exist for worker-created states.

create or replace function
  public.complete_snapshot_report_worker(
    p_request_id uuid,
    p_project_id uuid,
    p_claim_token uuid,
    p_full_markdown text,
    p_short_markdown text,
    p_full_filename text,
    p_short_filename text,
    p_generated_at timestamptz
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
begin
  perform public._assert_snapshot_artifact_input(
    p_full_markdown,
    p_short_markdown,
    p_full_filename,
    p_short_filename,
    p_generated_at
  );

  -- 1. request row locked and ownership proven under that lock
  v_request :=
    public._lock_active_snapshot_worker_claim(
      p_request_id,
      p_project_id,
      p_claim_token
    );

  if v_request.id is null then
    return;
  end if;

  -- 2. artifact row locked while the request lock is still held
  select artifact.*
    into v_artifact
    from public.snapshot_report_artifacts artifact
   where artifact.snapshot_request_id = p_request_id
   for update;

  if found
     and v_artifact.delivered_at is not null then
    -- A client already holds this report. Never overwrite it.
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
      public._generate_snapshot_public_token()
    )
    returning * into v_result;
  else
    -- Content columns only. public_token, delivered_at,
    -- delivery_message_id, snapshot_request_id, and project_id are
    -- omitted from the SET list, so preservation is structural.
    update public.snapshot_report_artifacts
       set full_report_markdown = p_full_markdown,
           short_report_markdown = p_short_markdown,
           full_report_filename = p_full_filename,
           short_report_filename = p_short_filename,
           generated_at = p_generated_at,
           updated_at = now()
     where snapshot_request_id = p_request_id
    returning * into v_result;
  end if;

  -- 3. finalize in the same transaction; ownership is released
  update public.snapshot_requests
     set status = 'report_ready',
         progress_stage = 'quality_review',
         progress_updated_at =
           case
             when progress_stage is distinct from 'quality_review'
               then now()
             else progress_updated_at
           end,
         claimed_by = null,
         claim_token = null,
         lease_expires_at = null,
         updated_at = now()
   where id = p_request_id
     and project_id = p_project_id
     and status = 'running';

  return next v_result;
end;
$$;

revoke all on function
  public.complete_snapshot_report_worker(
    uuid, uuid, uuid, text, text, text, text, timestamptz
  )
from public;
revoke all on function
  public.complete_snapshot_report_worker(
    uuid, uuid, uuid, text, text, text, text, timestamptz
  )
from anon;
revoke all on function
  public.complete_snapshot_report_worker(
    uuid, uuid, uuid, text, text, text, text, timestamptz
  )
from authenticated;
grant execute on function
  public.complete_snapshot_report_worker(
    uuid, uuid, uuid, text, text, text, text, timestamptz
  )
to service_role;

-- ── Worker failure ───────────────────────────────────────────────────

create or replace function
  public.mark_snapshot_request_failed_worker(
    p_request_id uuid,
    p_project_id uuid,
    p_claim_token uuid
  )
returns setof public.snapshot_requests
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_request public.snapshot_requests%rowtype;
  v_artifact_exists boolean;
begin
  v_request :=
    public._lock_active_snapshot_worker_claim(
      p_request_id,
      p_project_id,
      p_claim_token
    );

  if v_request.id is null then
    return;
  end if;

  select exists (
    select 1
      from public.snapshot_report_artifacts artifact
     where artifact.snapshot_request_id = p_request_id
     for update
  )
    into v_artifact_exists;

  -- A stored report contradicts failure, delivered or not.
  if v_artifact_exists then
    return;
  end if;

  return query
  update public.snapshot_requests
     set status = 'failed',
         claimed_by = null,
         claim_token = null,
         lease_expires_at = null,
         updated_at = now()
   where id = p_request_id
     and project_id = p_project_id
     and status = 'running'
  returning *;
end;
$$;

revoke all on function
  public.mark_snapshot_request_failed_worker(uuid, uuid, uuid)
from public;
revoke all on function
  public.mark_snapshot_request_failed_worker(uuid, uuid, uuid)
from anon;
revoke all on function
  public.mark_snapshot_request_failed_worker(uuid, uuid, uuid)
from authenticated;
grant execute on function
  public.mark_snapshot_request_failed_worker(uuid, uuid, uuid)
to service_role;

-- ── Manual artifact save ─────────────────────────────────────────────

create or replace function
  public.save_snapshot_report_artifact_manual(
    p_request_id uuid,
    p_project_id uuid,
    p_full_markdown text,
    p_short_markdown text,
    p_full_filename text,
    p_short_filename text,
    p_generated_at timestamptz
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
begin
  perform public._assert_snapshot_artifact_input(
    p_full_markdown,
    p_short_markdown,
    p_full_filename,
    p_short_filename,
    p_generated_at
  );

  select request.*
    into v_request
    from public.snapshot_requests request
   where request.id = p_request_id
     and request.project_id = p_project_id
   for update;

  if not found then
    return;
  end if;

  if v_request.status <> 'running'
     or v_request.claim_token is not null then
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
           updated_at = now()
     where snapshot_request_id = p_request_id
    returning * into v_result;
  end if;

  -- Never finalizes: manual finalization stays a separate operation.
  return next v_result;
end;
$$;

revoke all on function
  public.save_snapshot_report_artifact_manual(
    uuid, uuid, text, text, text, text, timestamptz
  )
from public;
revoke all on function
  public.save_snapshot_report_artifact_manual(
    uuid, uuid, text, text, text, text, timestamptz
  )
from anon;
revoke all on function
  public.save_snapshot_report_artifact_manual(
    uuid, uuid, text, text, text, text, timestamptz
  )
from authenticated;
grant execute on function
  public.save_snapshot_report_artifact_manual(
    uuid, uuid, text, text, text, text, timestamptz
  )
to service_role;

-- ── Backfill insert (insert-only) ────────────────────────────────────

create or replace function
  public.insert_snapshot_report_artifact_backfill(
    p_request_id uuid,
    p_project_id uuid,
    p_full_markdown text,
    p_short_markdown text,
    p_full_filename text,
    p_short_filename text,
    p_generated_at timestamptz
  )
returns setof public.snapshot_report_artifacts
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_request public.snapshot_requests%rowtype;
  v_artifact_exists boolean;
  v_result public.snapshot_report_artifacts%rowtype;
begin
  perform public._assert_snapshot_artifact_input(
    p_full_markdown,
    p_short_markdown,
    p_full_filename,
    p_short_filename,
    p_generated_at
  );

  select request.*
    into v_request
    from public.snapshot_requests request
   where request.id = p_request_id
     and request.project_id = p_project_id
   for update;

  if not found then
    return;
  end if;

  if v_request.status <> 'report_ready'
     or v_request.claim_token is not null then
    return;
  end if;

  select exists (
    select 1
      from public.snapshot_report_artifacts artifact
     where artifact.snapshot_request_id = p_request_id
     for update
  )
    into v_artifact_exists;

  -- Insert-only. Any existing artifact ends the operation.
  if v_artifact_exists then
    return;
  end if;

  insert into public.snapshot_report_artifacts (
    snapshot_request_id,
    project_id,
    full_report_markdown,
    short_report_markdown,
    full_report_filename,
    short_report_filename,
    generated_at,
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
    public._generate_snapshot_public_token()
  )
  returning * into v_result;

  return next v_result;
end;
$$;

revoke all on function
  public.insert_snapshot_report_artifact_backfill(
    uuid, uuid, text, text, text, text, timestamptz
  )
from public;
revoke all on function
  public.insert_snapshot_report_artifact_backfill(
    uuid, uuid, text, text, text, text, timestamptz
  )
from anon;
revoke all on function
  public.insert_snapshot_report_artifact_backfill(
    uuid, uuid, text, text, text, text, timestamptz
  )
from authenticated;
grant execute on function
  public.insert_snapshot_report_artifact_backfill(
    uuid, uuid, text, text, text, text, timestamptz
  )
to service_role;

-- ── Delivery bookkeeping ─────────────────────────────────────────────
--
-- Founder authorization stays in the HTTP route. This RPC restricts the
-- mutation shape: bookkeeping columns only, never report content.

create or replace function
  public.mark_snapshot_report_delivered(
    p_request_id uuid,
    p_message_id text,
    p_delivered_at timestamptz,
    p_resend boolean
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
begin
  if p_message_id is null
     or char_length(btrim(p_message_id)) = 0
     or p_delivered_at is null
     or p_resend is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_snapshot_delivery_input';
  end if;

  select request.*
    into v_request
    from public.snapshot_requests request
   where request.id = p_request_id
   for update;

  if not found then
    return;
  end if;

  if v_request.status <> 'report_ready' then
    return;
  end if;

  select artifact.*
    into v_artifact
    from public.snapshot_report_artifacts artifact
   where artifact.snapshot_request_id = p_request_id
   for update;

  if not found then
    return;
  end if;

  if not p_resend
     and v_artifact.delivered_at is not null then
    return;
  end if;

  if p_resend
     and v_artifact.delivered_at is null then
    return;
  end if;

  -- Bookkeeping only. Content, filenames, generated_at, public_token,
  -- project_id, and snapshot_request_id are omitted from the SET list.
  -- Resend replaces both the timestamp and the message ID, preserving
  -- the behavior validated in commit 7966888.
  return query
  update public.snapshot_report_artifacts
     set delivered_at = p_delivered_at,
         delivery_message_id = p_message_id,
         updated_at = now()
   where snapshot_request_id = p_request_id
  returning *;
end;
$$;

revoke all on function
  public.mark_snapshot_report_delivered(uuid, text, timestamptz, boolean)
from public;
revoke all on function
  public.mark_snapshot_report_delivered(uuid, text, timestamptz, boolean)
from anon;
revoke all on function
  public.mark_snapshot_report_delivered(uuid, text, timestamptz, boolean)
from authenticated;
grant execute on function
  public.mark_snapshot_report_delivered(uuid, text, timestamptz, boolean)
to service_role;

-- ── Corrected claim-next terminalization ─────────────────────────────
--
-- Identical to 0030 except that terminalization now skips any request
-- holding an artifact. Marking an artifact-bearing request `failed`
-- would contradict a stored — possibly already delivered — report.
-- Artifact-bearing stale requests are left untouched for founder repair
-- and remain unclaimable because attempt_count >= p_max_attempts.

create or replace function
  public.claim_next_snapshot_request(
    p_worker_id text,
    p_lease_seconds integer,
    p_max_attempts integer
  )
returns setof public.snapshot_requests
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_worker_id text;
  v_candidate public.snapshot_requests%rowtype;
  v_project_id uuid;
  v_token uuid;
begin
  v_worker_id := btrim(coalesce(p_worker_id, ''));

  if char_length(v_worker_id) < 1
     or char_length(v_worker_id) > 100 then
    raise exception using
      errcode = '22023',
      message = 'invalid_worker_id';
  end if;

  if p_lease_seconds is null
     or p_lease_seconds < 60
     or p_lease_seconds > 3600 then
    raise exception using
      errcode = '22023',
      message = 'invalid_lease_seconds';
  end if;

  if p_max_attempts is null
     or p_max_attempts < 1
     or p_max_attempts > 10 then
    raise exception using
      errcode = '22023',
      message = 'invalid_max_attempts';
  end if;

  update public.snapshot_requests
     set status = 'failed',
         claimed_by = null,
         claim_token = null,
         lease_expires_at = null,
         updated_at = now()
   where status = 'running'
     and claim_token is not null
     and lease_expires_at <= now()
     and attempt_count >= p_max_attempts
     and not exists (
       select 1
         from public.snapshot_report_artifacts artifact
        where artifact.snapshot_request_id = snapshot_requests.id
     );

  select request.*
    into v_candidate
    from public.snapshot_requests request
   where (
           request.status = 'running'
       and request.claim_token is not null
       and request.lease_expires_at <= now()
       and request.attempt_count < p_max_attempts
         )
      or (
           request.status = 'queued'
       and request.approved_at is not null
       and request.approved_by is not null
         )
   order by
     case when request.status = 'running' then 0 else 1 end,
     request.created_at asc,
     request.id asc
   limit 1
   for update skip locked;

  if not found then
    return;
  end if;

  v_project_id :=
    public._ensure_snapshot_request_project(v_candidate.id);

  if v_project_id is null then
    return;
  end if;

  v_token := gen_random_uuid();

  return query
  update public.snapshot_requests
     set project_id = v_project_id,
         status = 'running',
         progress_stage =
           case
             when snapshot_requests.status = 'queued'
               then 'reserved'
             else snapshot_requests.progress_stage
           end,
         progress_updated_at =
           case
             when snapshot_requests.status = 'queued'
               then now()
             else snapshot_requests.progress_updated_at
           end,
         attempt_count = snapshot_requests.attempt_count + 1,
         claimed_by = v_worker_id,
         claim_token = v_token,
         lease_expires_at =
           now() + make_interval(secs => p_lease_seconds),
         updated_at = now()
   where snapshot_requests.id = v_candidate.id
  returning *;
end;
$$;

revoke all on function
  public.claim_next_snapshot_request(text, integer, integer)
from public;
revoke all on function
  public.claim_next_snapshot_request(text, integer, integer)
from anon;
revoke all on function
  public.claim_next_snapshot_request(text, integer, integer)
from authenticated;
grant execute on function
  public.claim_next_snapshot_request(text, integer, integer)
to service_role;
