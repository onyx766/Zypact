-- Persist founder-reviewed snapshot reports.
--
-- Reports are private operational artifacts:
-- - never accessible to anon or authenticated browser clients;
-- - only the server-side service role may read or write them;
-- - one current artifact is stored per snapshot request.

create table if not exists
  public.snapshot_report_artifacts (
    id uuid primary key default gen_random_uuid(),

    snapshot_request_id uuid not null unique
      references public.snapshot_requests (id)
      on delete cascade,

    project_id uuid not null
      references public.projects (id)
      on delete cascade,

    full_report_markdown text not null,
    short_report_markdown text not null,

    full_report_filename text not null,
    short_report_filename text not null,

    generated_at timestamptz not null,

    delivered_at timestamptz null,
    delivery_message_id text null,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint snapshot_report_artifacts_full_not_empty
      check (char_length(full_report_markdown) > 0),

    constraint snapshot_report_artifacts_short_not_empty
      check (char_length(short_report_markdown) > 0),

    constraint snapshot_report_artifacts_filenames_not_empty
      check (
        char_length(full_report_filename) > 0
        and char_length(short_report_filename) > 0
      )
  );

create index if not exists
  snapshot_report_artifacts_project_idx
on public.snapshot_report_artifacts (project_id);

alter table
  public.snapshot_report_artifacts
enable row level security;

alter table
  public.snapshot_report_artifacts
no force row level security;

revoke all
on table public.snapshot_report_artifacts
from public;

revoke all
on table public.snapshot_report_artifacts
from anon;

revoke all
on table public.snapshot_report_artifacts
from authenticated;

grant select, insert, update, delete
on table public.snapshot_report_artifacts
to service_role;
