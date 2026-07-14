-- Remove the abandoned FI invitation-code scope.
--
-- Migration 0022 remains in history because it was already applied.
-- The MVP workflow returns to:
-- email verification -> pending approval -> founder approval -> queued.

do $$
begin
  if exists (
    select 1
      from public.snapshot_requests
     where invite_code_hash is not null
        or approval_source = 'fi_invite'
  ) then
    raise exception
      'snapshot_fi_invite_rows_must_be_removed_before_cleanup';
  end if;
end;
$$;

drop function if exists
  public.issue_snapshot_request_verification(
    uuid,
    text,
    timestamptz,
    text
  );

create function
  public.issue_snapshot_request_verification(
    p_request_id uuid,
    p_token_hash text,
    p_expires_at timestamptz
  )
returns boolean
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_updated_count integer;
begin
  if p_token_hash is null
     or length(p_token_hash) <> 64
     or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message =
        'invalid_snapshot_verification_hash';
  end if;

  if p_expires_at is null
     or p_expires_at <= now() then
    return false;
  end if;

  update public.snapshot_requests
     set verification_token_hash =
           p_token_hash,
         verification_expires_at =
           p_expires_at,
         verified_at = null,
         updated_at = now()
   where id = p_request_id
     and status = 'pending_verification';

  get diagnostics
    v_updated_count = row_count;

  return v_updated_count = 1;
end;
$$;

revoke all on function
  public.issue_snapshot_request_verification(
    uuid,
    text,
    timestamptz
  )
from public;

revoke all on function
  public.issue_snapshot_request_verification(
    uuid,
    text,
    timestamptz
  )
from anon;

revoke all on function
  public.issue_snapshot_request_verification(
    uuid,
    text,
    timestamptz
  )
from authenticated;

grant execute on function
  public.issue_snapshot_request_verification(
    uuid,
    text,
    timestamptz
  )
to service_role;

drop function if exists
  public.consume_snapshot_request_verification(
    text,
    text
  );

create function
  public.consume_snapshot_request_verification(
    p_token_hash text
  )
returns setof public.snapshot_requests
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
begin
  if p_token_hash is null
     or length(p_token_hash) <> 64
     or p_token_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;

  return query
  update public.snapshot_requests
     set status = 'pending_approval',
         verified_at = now(),
         verification_token_hash = null,
         verification_expires_at = null,
         updated_at = now()
   where verification_token_hash =
           p_token_hash
     and status = 'pending_verification'
     and verification_expires_at > now()
  returning *;
end;
$$;

revoke all on function
  public.consume_snapshot_request_verification(
    text
  )
from public;

revoke all on function
  public.consume_snapshot_request_verification(
    text
  )
from anon;

revoke all on function
  public.consume_snapshot_request_verification(
    text
  )
from authenticated;

grant execute on function
  public.consume_snapshot_request_verification(
    text
  )
to service_role;

create or replace function
  public.fail_snapshot_verification_delivery(
    p_request_id uuid
  )
returns boolean
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_updated_count integer;
begin
  update public.snapshot_requests
     set status = 'failed',
         verification_token_hash = null,
         verification_expires_at = null,
         updated_at = now()
   where id = p_request_id
     and status = 'pending_verification'
     and verified_at is null;

  get diagnostics
    v_updated_count = row_count;

  return v_updated_count = 1;
end;
$$;

create or replace function
  public.approve_and_queue_snapshot_request(
    p_request_id uuid,
    p_approved_by uuid
  )
returns setof public.snapshot_requests
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_approved_count integer;
begin
  if p_request_id is null
     or p_approved_by is null then
    return;
  end if;

  update public.snapshot_requests
     set status = 'approved',
         approved_at = now(),
         approved_by = p_approved_by,
         updated_at = now()
   where id = p_request_id
     and status = 'pending_approval';

  get diagnostics
    v_approved_count = row_count;

  if v_approved_count = 1 then
    return query
    update public.snapshot_requests
       set status = 'queued',
           updated_at = now()
     where id = p_request_id
       and status = 'approved'
    returning *;

    return;
  end if;

  return query
  select request.*
    from public.snapshot_requests request
   where request.id = p_request_id
     and request.status = 'queued'
     and request.approved_at is not null
     and request.approved_by is not null;
end;
$$;

alter table public.snapshot_requests
  drop constraint if exists
    snapshot_requests_approval_metadata_check;

alter table public.snapshot_requests
  drop constraint if exists
    snapshot_requests_invite_hash_check;

alter table public.snapshot_requests
  drop column if exists invite_code_hash,
  drop column if exists approval_source;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname =
       'snapshot_requests_approval_pair_check'
       and conrelid =
         'public.snapshot_requests'::regclass
  ) then
    alter table public.snapshot_requests
      add constraint
        snapshot_requests_approval_pair_check
      check (
        (
          approved_at is null
          and approved_by is null
        )
        or
        (
          approved_at is not null
          and approved_by is not null
        )
      );
  end if;
end;
$$;
