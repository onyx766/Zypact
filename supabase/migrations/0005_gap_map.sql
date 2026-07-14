-- Zypact MVP — Sprint 5 schema addition.
-- Apply with:  supabase db push
-- Adds gap_maps and gaps tables for the Gap Map Agent.

create table if not exists gap_maps (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects (id) on delete cascade,
  json        jsonb not null,
  created_at  timestamptz not null default now()
);

create index if not exists gap_maps_project_idx
  on gap_maps (project_id);
create index if not exists gap_maps_project_created_idx
  on gap_maps (project_id, created_at desc);

create table if not exists gaps (
  id                       uuid primary key default gen_random_uuid(),
  project_id               uuid not null references projects (id) on delete cascade,
  competitor_name          text null,
  type                     text not null,
  severity                 text not null
                           check (severity in ('high','medium','low')),
  explanation              text not null,
  affected_prompts         jsonb not null default '[]'::jsonb,
  suggested_fix_direction  text not null,
  created_at               timestamptz not null default now()
);

create index if not exists gaps_project_idx
  on gaps (project_id);
create index if not exists gaps_project_severity_idx
  on gaps (project_id, severity);
