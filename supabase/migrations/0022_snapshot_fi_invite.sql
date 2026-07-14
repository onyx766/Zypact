-- Founder Institute Basic Prototype — optional FI invitation gate.
--
-- Security contract:
--   - raw invitation codes are never stored;
--   - only a server-generated HMAC SHA-256 hash is stored temporarily;
--   - email verification remains mandatory;
--   - a matching invitation moves the verified request directly to queued;
--   - a missing or incorrect invitation moves it to pending_approval;
--   - the temporary invitation hash is removed when the email token is
--     consumed or verification delivery fails;
--   - no project or AI scan is created here.

alter table public.snapshot_requests
  add column if not exists
    invite_code_hash text null,
  add column if not exists
    approval_source text null;

update public.snapshot_requests
   set approval_source = 'founder'
 where approval_source is null
   and approved_at is not null
   and approved_by is not null;

alter table public.snapshot_requests
  drop constraint if exists
    snapshot_requests_approval_pair_check;

alter table public.snapshot_requests
  drop constraint if exists
    snapshot_requests_approval_metadata_check;

alter table public.snapshot_requests
  add constraint
    snapshot_requests_approval_metadata_check
  check (
    (
      approval_source is null
      and approved_at is null
      and approved_by is null
    )
    or
    (
      approval_source = 'founder'
      and approved_at is not null
      and approved_by is not null
    )
    or
    (
      approval_source = 'fi_invite'
      and approved_at is not null
      and approved_by is null
    )
  );

alter table public.snapshot_requests
  drop constraint if exists
    snapshot_requests_invite_hash_check;

alter table public.snapshot_requests
  add constraint
    snapshot_requests_invite_hash_check
  check (
    invite_code_hash is null
    or (
      length(invite_code_hash) = 64
      and invite_code_hash ~
        '^[0-9a-f]{64}$'
    )
  );

drop function if exists
  public.issue_snapshot_request_verification(
    uuid,
    text,
    timestamptz
  );

create function
  public.issue_snapshot_request_verification(
    p_request_id uuid,
    p_token_hash text,
    p_expires_at timestamptz,
    p_invite_code_hash text default null
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
     or p_token_hash !~
       '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message =
        'invalid_snapshot_verification_hash';
  end if;

  if p_invite_code_hash is not null
     and (
       length(p_invite_code_hash) <> 64
       or p_invite_code_hash !~
         '^[0-9a-f]{64}$'
     ) then
    raise exception using
      errcode = '22023',
      message =
        'invalid_snapshot_invite_hash';
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
         invite_code_hash =
           p_invite_code_hash,
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
    timestamptz,
    text
  )
from public;

revoke all on function
  public.issue_snapshot_request_verification(
    uuid,
    text,
    timestamptz,
    text
  )
from anon;

revoke all on function
  public.issue_snapshot_request_verification(
    uuid,
    text,
    timestamptz,
    text
  )
from authenticated;

grant execute on function
  public.issue_snapshot_request_verification(
    uuid,
    text,
    timestamptz,
    text
  )
to service_role;

drop function if exists
  public.consume_snapshot_request_verification(
    text
  );

create function
  public.consume_snapshot_request_verification(
    p_token_hash text,
    p_valid_invite_hash text default null
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
     or p_token_hash !~
       '^[0-9a-f]{64}$' then
    return;
  end if;

  if p_valid_invite_hash is not null
     and (
       length(p_valid_invite_hash) <> 64
       or p_valid_invite_hash !~
         '^[0-9a-f]{64}$'
     ) then
    raise exception using
      errcode = '22023',
      message =
        'invalid_snapshot_valid_invite_hash';
  end if;

  return query
  update public.snapshot_requests
     set status =
           case
             when p_valid_invite_hash
                    is not null
              and invite_code_hash =
                    p_valid_invite_hash
             then 'queued'
             else 'pending_approval'
           end,
         verified_at = now(),
         approved_at =
           case
             when p_valid_invite_hash
                    is not null
              and invite_code_hash =
                    p_valid_invite_hash
             then now()
             else null
           end,
         approved_by = null,
         approval_source =
           case
             when p_valid_invite_hash
                    is not null
              and invite_code_hash =
                    p_valid_invite_hash
             then 'fi_invite'
             else null
           end,
         verification_token_hash = null,
         verification_expires_at = null,
         invite_code_hash = null,
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
    text,
    text
  )
from public;

revoke all on function
  public.consume_snapshot_request_verification(
    text,
    text
  )
from anon;

revoke all on function
  public.consume_snapshot_request_verification(
    text,
    text
  )
from authenticated;

grant execute on function
  public.consume_snapshot_request_verification(
    text,
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
         invite_code_hash = null,
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
         approval_source = 'founder',
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
     and request.approval_source =
           'founder'
     and request.approved_at is not null
     and request.approved_by is not null;
end;
$$;
