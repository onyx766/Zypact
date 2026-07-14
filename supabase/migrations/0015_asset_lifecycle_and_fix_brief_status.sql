-- Sprint 13B.2 — Asset lifecycle + derived Fix Brief completion states.
alter table generated_assets add column if not exists lifecycle_status text not null default 'active';
alter table generated_assets drop constraint if exists generated_assets_lifecycle_status_check;
alter table generated_assets add constraint generated_assets_lifecycle_status_check check (lifecycle_status in ('active','superseded'));
create index if not exists generated_assets_project_lifecycle_idx on generated_assets (project_id, lifecycle_status);
create index if not exists generated_assets_fix_brief_lifecycle_idx on generated_assets (fix_brief_id, lifecycle_status);
alter table fix_briefs drop constraint if exists fix_briefs_status_check;
alter table fix_briefs add constraint fix_briefs_status_check check (status in ('draft','needs_evidence','ready_for_assets','partially_complete','assets_ready','historical'));
