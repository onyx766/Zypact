-- Founder Institute Basic Prototype — protected public snapshot requests.
--
-- This table stores a public request before email verification, founder
-- approval, project creation, or any paid AI-platform call.
--
-- Security contract:
--   - browser clients never write directly to this table;
--   - only server-side service_role access is allowed;
--   - no Perplexity scan is triggered by inserting a request.

create table if not exists public.snapshot_requests (
  id                 uuid primary key default gen_random_uuid(),
  work_email         text not null,
  normalized_email   text not null,
  company_name       text not null,
  website_url        text not null,
  normalized_domain  text not null,
  buyer_category     text not null,
  status             text not null default 'pending_verification',
  request_ip_hash    text null,
  project_id         uuid null references public.projects (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint snapshot_requests_status_check
    check (
      status in (
        'pending_verification',
        'verified',
        'pending_approval',
        'approved',
        'queued',
        'running',
        'quality_review',
        'needs_founder_review',
        'report_ready',
        'qa_failed',
        'failed',
        'rejected',
        'expired'
      )
    )
);

create index if not exists snapshot_requests_email_created_idx
  on public.snapshot_requests (normalized_email, created_at desc);

create index if not exists snapshot_requests_domain_created_idx
  on public.snapshot_requests (normalized_domain, created_at desc);

create index if not exists snapshot_requests_status_created_idx
  on public.snapshot_requests (status, created_at asc);

alter table public.snapshot_requests enable row level security;
alter table public.snapshot_requests no force row level security;

revoke all on table public.snapshot_requests from anon;
revoke all on table public.snapshot_requests from authenticated;

grant select, insert, update, delete
  on table public.snapshot_requests
  to service_role;
