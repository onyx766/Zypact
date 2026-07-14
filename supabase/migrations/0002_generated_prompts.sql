-- Zypact MVP — Sprint 2 schema addition.
-- Apply with:  supabase db push
-- Adds the generated_prompts table for the Prompt Mirror Agent output.

create table if not exists generated_prompts (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references projects (id) on delete cascade,
  prompt            text not null,
  intent_type       text not null,
  commercial_value  smallint not null check (commercial_value between 1 and 5),
  winnability       smallint not null check (winnability between 1 and 5),
  priority          smallint not null check (priority between 1 and 25),
  rationale         text not null default '',
  selected          boolean not null default false,
  created_at        timestamptz not null default now()
);

create index if not exists generated_prompts_project_idx
  on generated_prompts (project_id);
create index if not exists generated_prompts_project_priority_idx
  on generated_prompts (project_id, priority desc);
