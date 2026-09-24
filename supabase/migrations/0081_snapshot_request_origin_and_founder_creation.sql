-- Founder-created audits, and the origin that tells them apart.
--
-- THE GAP. `create_snapshot_request_guarded` (0018, re-signatured in 0061) is
-- the only way a snapshot request has ever been created, and it enforces four
-- limits written for a form open to strangers: one request per email per 30
-- days, one per domain per 30 days, one active request per domain, and three
-- per IP per 24 hours. A founder creating an audit for a prospect who never
-- filled in that form is refused by three of them. Those three exist to stop
-- abuse of a free public endpoint and say nothing about founder-initiated
-- work.
--
-- WHAT THIS ADDS.
--   1. `origin` on snapshot_requests: 'public_form' or 'founder'. Existing
--      rows take 'public_form', which is what they are — every one came
--      through the guarded RPC. Without this column a founder-created audit
--      is indistinguishable from a customer's own request, and the admin
--      counts silently mix the two.
--   2. `create_snapshot_request_as_founder`, a SEPARATE function. The public
--      one is not touched, not dropped and not re-signed here, so the public
--      form cannot acquire a bypass through this migration by any path.
--
-- WHICH LIMIT SURVIVES, AND WHY. The active-domain check is kept. It is not
-- an abuse throttle: two live requests for one domain race for the same
-- project reservation (0024) and would produce two protocols measuring the
-- same company at the same time. The other three are rate limits on a public
-- endpoint and do not describe an authenticated founder.
--
-- STATUS. Rows are created `pending_approval`, never `pending_verification`.
-- Email verification exists to prove a stranger owns the address they typed;
-- a founder entering a prospect's details is the vouching party, and there is
-- nobody waiting to click a verification link. `pending_approval` is also
-- exactly what `approve_and_launch_snapshot_baseline` (0062/0069) requires,
-- so a founder-created audit still cannot reach a paid provider call until
-- the founder approves it explicitly. Nothing here approves anything, and
-- nothing here enqueues a job.
--
-- `request_ip_hash` stays null. It is an abuse-tracking field for public
-- submissions, and recording the founder's own address would be a misleading
-- value in a column every other row uses for something else.
--
-- LOCKING. Only the domain lock is taken, and it is the same key the guarded
-- function uses, so a founder creation and a public submission cannot both
-- pass the active-domain check for one domain at the same instant. Taking a
-- subset of the guarded function's lock set in the same relative order cannot
-- deadlock against it.
--
-- Rollback:
--   drop function if exists public.create_snapshot_request_as_founder(
--     text, text, text, text, text, text, text);
--   alter table public.snapshot_requests drop column if exists origin;
--   Dropping the column loses the public/founder distinction for rows created
--   while it existed. It destroys no request, no report and no evidence.

alter table public.snapshot_requests
  add column if not exists origin text not null default 'public_form';

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'snapshot_requests_origin_check'
  ) then
    alter table public.snapshot_requests
      add constraint snapshot_requests_origin_check
      check (origin in ('public_form', 'founder'));
  end if;
end
$$;

create or replace function public.create_snapshot_request_as_founder(
  p_work_email text,
  p_normalized_email text,
  p_company_name text,
  p_website_url text,
  p_normalized_domain text,
  p_buyer_category text,
  p_contact_name text default null
)
returns setof public.snapshot_requests
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
begin
  -- The application normalizes and validates before calling. This refuses the
  -- shapes that would otherwise become an unusable row: a request with no
  -- recipient, no company, no domain or no question cannot be approved, and
  -- discovering that after the row exists is worse than refusing it here.
  if p_work_email is null or btrim(p_work_email) = ''
     or p_normalized_email is null or btrim(p_normalized_email) = ''
     or p_company_name is null or btrim(p_company_name) = ''
     or p_website_url is null or btrim(p_website_url) = ''
     or p_normalized_domain is null or btrim(p_normalized_domain) = ''
     or p_buyer_category is null or btrim(p_buyer_category) = '' then
    raise exception using
      errcode = '22023',
      message = 'invalid_founder_snapshot_request_args';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('snapshot-domain:' || p_normalized_domain, 0)
  );

  -- Deliberately the same status set as the guarded function's active-domain
  -- check, including its exclusion of 'report_ready': a delivered or
  -- finished audit does not block the next one, an in-flight one does.
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
    contact_name,
    origin
  )
  values (
    p_work_email,
    p_normalized_email,
    p_company_name,
    p_website_url,
    p_normalized_domain,
    p_buyer_category,
    'pending_approval',
    null,
    p_contact_name,
    'founder'
  )
  returning *;
end;
$$;

revoke all on function public.create_snapshot_request_as_founder(
  text, text, text, text, text, text, text
) from public;

revoke all on function public.create_snapshot_request_as_founder(
  text, text, text, text, text, text, text
) from anon;

revoke all on function public.create_snapshot_request_as_founder(
  text, text, text, text, text, text, text
) from authenticated;

grant execute on function public.create_snapshot_request_as_founder(
  text, text, text, text, text, text, text
) to service_role;
