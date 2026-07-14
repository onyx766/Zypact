-- Founder Institute Basic Prototype — atomic snapshot request limits.
--
-- The checks and insertion run in one PostgreSQL transaction.
-- Advisory locks prevent concurrent requests from bypassing limits.

create or replace function public.create_snapshot_request_guarded(
  p_work_email text,
  p_normalized_email text,
  p_company_name text,
  p_website_url text,
  p_normalized_domain text,
  p_buyer_category text,
  p_request_ip_hash text default null
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
    request_ip_hash
  )
  values (
    p_work_email,
    p_normalized_email,
    p_company_name,
    p_website_url,
    p_normalized_domain,
    p_buyer_category,
    'pending_verification',
    p_request_ip_hash
  )
  returning *;
end;
$$;

revoke all on function public.create_snapshot_request_guarded(
  text, text, text, text, text, text, text
) from public;

revoke all on function public.create_snapshot_request_guarded(
  text, text, text, text, text, text, text
) from anon;

revoke all on function public.create_snapshot_request_guarded(
  text, text, text, text, text, text, text
) from authenticated;

grant execute on function public.create_snapshot_request_guarded(
  text, text, text, text, text, text, text
) to service_role;
