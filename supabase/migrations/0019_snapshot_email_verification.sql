-- Founder Institute Basic Prototype — snapshot email verification.
--
-- Security contract:
--   - the raw verification token is never stored;
--   - only its SHA-256 hash is stored;
--   - tokens expire and can be consumed only once;
--   - successful verification moves the request atomically from
--     pending_verification to pending_approval;
--   - browser clients cannot call these functions directly.

alter table public.snapshot_requests
  add column if not exists verification_token_hash text null,
  add column if not exists verification_expires_at timestamptz null,
  add column if not exists verified_at timestamptz null;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'snapshot_requests_verification_pair_check'
       and conrelid = 'public.snapshot_requests'::regclass
  ) then
    alter table public.snapshot_requests
      add constraint snapshot_requests_verification_pair_check
      check (
        (
          verification_token_hash is null
          and verification_expires_at is null
        )
        or
        (
          verification_token_hash is not null
          and verification_expires_at is not null
        )
      );
  end if;
end;
$$;

create unique index if not exists
  snapshot_requests_verification_token_hash_uidx
  on public.snapshot_requests (verification_token_hash)
  where verification_token_hash is not null;

create index if not exists
  snapshot_requests_verification_expiry_idx
  on public.snapshot_requests (verification_expires_at)
  where verification_token_hash is not null;

create or replace function public.issue_snapshot_request_verification(
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
      message = 'invalid_snapshot_verification_hash';
  end if;

  if p_expires_at is null or p_expires_at <= now() then
    return false;
  end if;

  update public.snapshot_requests
     set verification_token_hash = p_token_hash,
         verification_expires_at = p_expires_at,
         verified_at = null,
         updated_at = now()
   where id = p_request_id
     and status = 'pending_verification';

  get diagnostics v_updated_count = row_count;

  return v_updated_count = 1;
end;
$$;

create or replace function public.consume_snapshot_request_verification(
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
   where verification_token_hash = p_token_hash
     and status = 'pending_verification'
     and verification_expires_at > now()
  returning *;
end;
$$;

revoke all on function public.issue_snapshot_request_verification(
  uuid, text, timestamptz
) from public;

revoke all on function public.issue_snapshot_request_verification(
  uuid, text, timestamptz
) from anon;

revoke all on function public.issue_snapshot_request_verification(
  uuid, text, timestamptz
) from authenticated;

grant execute on function public.issue_snapshot_request_verification(
  uuid, text, timestamptz
) to service_role;

revoke all on function public.consume_snapshot_request_verification(
  text
) from public;

revoke all on function public.consume_snapshot_request_verification(
  text
) from anon;

revoke all on function public.consume_snapshot_request_verification(
  text
) from authenticated;

grant execute on function public.consume_snapshot_request_verification(
  text
) to service_role;
