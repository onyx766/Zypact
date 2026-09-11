-- Public demo request form — add a requester contact name.
--
-- Nullable by design: existing rows have no value and are never backfilled.
-- The public form and its zod schema require the field for new submissions;
-- the database only guarantees the column exists and accepts null, matching
-- how every other snapshot_requests write already goes through the guarded
-- RPC below rather than a raw insert.

alter table public.snapshot_requests
  add column if not exists contact_name text null;

-- create_snapshot_request_guarded (migration 0018) must be dropped and
-- recreated: adding a parameter changes its signature, so CREATE OR REPLACE
-- alone would leave the old 7-argument function in place as a second,
-- unreachable overload.
drop function if exists public.create_snapshot_request_guarded(
  text, text, text, text, text, text, text
);

create or replace function public.create_snapshot_request_guarded(
  p_work_email text,
  p_normalized_email text,
  p_company_name text,
  p_website_url text,
  p_normalized_domain text,
  p_buyer_category text,
  p_request_ip_hash text default null,
  p_contact_name text default null
)
returns setof public.snapshot_requests
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
begin
  -- Always acquire locks in the same order to avoid deadlocks.
  perform pg_advisory_xact_lock(
    hashtextextended('snapshot-email:' || p_normalized_email, 0)
  );

  perform pg_advisory_xact_lock(
    hashtextextended('snapshot-domain:' || p_normalized_domain, 0)
  );

  if p_request_ip_hash is not null then
    perform pg_advisory_xact_lock(
      hashtextextended('snapshot-ip:' || p_request_ip_hash, 0)
    );
  end if;

  if exists (
    select 1
      from public.snapshot_requests
     where normalized_email = p_normalized_email
       and created_at >= now() - interval '30 days'
       and status in (
         'pending_verification',
         'verified',
         'pending_approval',
         'approved',
         'queued',
         'running',
         'quality_review',
         'needs_founder_review',
         'report_ready'
       )
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'snapshot_limit_email_30d';
  end if;

  if exists (
    select 1
      from public.snapshot_requests
     where normalized_domain = p_normalized_domain
       and created_at >= now() - interval '30 days'
       and status in (
         'pending_verification',
         'verified',
         'pending_approval',
         'approved',
         'queued',
         'running',
         'quality_review',
         'needs_founder_review',
         'report_ready'
       )
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'snapshot_limit_domain_30d';
  end if;

  if exists (
    select 1
      from public.snapshot_requests
     where normalized_domain = p_normalized_domain
       and status in (
         'pending_verification',
         'verified',
         'pending_approval',
         'approved',
         'queued',
         'running',
         'quality_review',
         'needs_founder_review'
       )
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'snapshot_limit_active_domain';
  end if;

  if p_request_ip_hash is not null and (
    select count(*)
      from public.snapshot_requests
     where request_ip_hash = p_request_ip_hash
       and created_at >= now() - interval '24 hours'
  ) >= 3 then
    raise exception using
      errcode = 'P0001',
      message = 'snapshot_limit_ip_daily';
  end if;

  return query
  insert into public.snapshot_requests (
    work_email,
    normalized_email,
    company_name,
    website_url,
    normalized_domain,
    buyer_category,
    status,
    request_ip_hash,
    contact_name
  )
  values (
    p_work_email,
    p_normalized_email,
    p_company_name,
    p_website_url,
    p_normalized_domain,
    p_buyer_category,
    'pending_verification',
    p_request_ip_hash,
    p_contact_name
  )
  returning *;
end;
$$;

revoke all on function public.create_snapshot_request_guarded(
  text, text, text, text, text, text, text, text
) from public;

revoke all on function public.create_snapshot_request_guarded(
  text, text, text, text, text, text, text, text
) from anon;

revoke all on function public.create_snapshot_request_guarded(
  text, text, text, text, text, text, text, text
) from authenticated;

grant execute on function public.create_snapshot_request_guarded(
  text, text, text, text, text, text, text, text
) to service_role;
