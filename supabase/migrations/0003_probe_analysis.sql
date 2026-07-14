-- Zypact MVP — Sprint 3 schema addition.
-- Apply with:  supabase db push
-- Adds probe_runs + probe_results for the Probe Analysis Agent.

create table if not exists probe_runs (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects (id) on delete cascade,
  platform    text not null check (platform in ('perplexity','chatgpt','gemini')),
  status      text not null default 'pending'
              check (status in ('pending','succeeded','failed')),
  created_at  timestamptz not null default now()
);

create index if not exists probe_runs_project_idx on probe_runs (project_id);

create table if not exists probe_results (
  id                   uuid primary key default gen_random_uuid(),
  probe_run_id         uuid not null references probe_runs (id) on delete cascade,
  project_id           uuid not null references projects (id) on delete cascade,
  generated_prompt_id  uuid null references generated_prompts (id) on delete set null,
  prompt               text not null,
  platform             text not null
                       check (platform in ('perplexity','chatgpt','gemini')),
  raw_response         text not null,
  client_mentioned     boolean not null default false,
  client_position      text not null
                       check (client_position in ('primary','listed','negative','absent')),
  competitors_mentioned jsonb not null default '[]'::jsonb,
  sources_cited        jsonb not null default '[]'::jsonb,
  answer_summary       text not null default '',
  verdict              text not null
                       check (verdict in ('won','partial','lost','not_relevant')),
  why_client_lost      text not null default '',
  created_at           timestamptz not null default now()
);

create index if not exists probe_results_project_idx
  on probe_results (project_id);
create index if not exists probe_results_project_verdict_idx
  on probe_results (project_id, verdict);
create index if not exists probe_results_probe_run_idx
  on probe_results (probe_run_id);
