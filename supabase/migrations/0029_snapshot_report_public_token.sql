-- Add a private bearer token for client-facing snapshot reports.
--
-- The artifact table remains inaccessible to anon/authenticated clients.
-- Public report pages resolve this opaque token only through server-side code.

alter table
  public.snapshot_report_artifacts
add column if not exists
  public_token text;

update public.snapshot_report_artifacts
set public_token =
  replace(gen_random_uuid()::text, '-', '') ||
  replace(gen_random_uuid()::text, '-', '')
where public_token is null;

alter table
  public.snapshot_report_artifacts
alter column public_token set not null;

create unique index if not exists
  snapshot_report_artifacts_public_token_idx
on public.snapshot_report_artifacts (public_token);

alter table
  public.snapshot_report_artifacts
add constraint
  snapshot_report_artifacts_public_token_length
check (char_length(public_token) >= 43)
not valid;

alter table
  public.snapshot_report_artifacts
validate constraint
  snapshot_report_artifacts_public_token_length;
