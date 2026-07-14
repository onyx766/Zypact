-- Zypact MVP — Sprint 4 schema addition.
-- Apply with:  supabase db push
-- Adds the competitors table for the Competitor Discovery Agent.

create table if not exists competitors (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references projects (id) on delete cascade,
  name              text not null,
  website           text null,
  discovery_source  text not null
                    check (discovery_source in
                      ('user','client_site','ai_answer','model_knowledge')),
  mention_count     integer not null default 0
                    check (mention_count >= 0),
  prompt_ids        jsonb not null default '[]'::jsonb,
  threat_level      text not null
                    check (threat_level in ('high','medium','low')),
  confidence        text not null
                    check (confidence in ('verified','unverified')),
  is_phantom        boolean not null default false,
  is_blind_spot     boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Enforce: model_knowledge implies unverified confidence.
-- Wrapped in a DO block so re-applying the migration is a no-op instead of
-- an error ("constraint already exists").
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'competitors_model_knowledge_unverified'
  ) then
    alter table competitors
      add constraint competitors_model_knowledge_unverified
      check (discovery_source <> 'model_knowledge' or confidence = 'unverified');
  end if;
end
$$;

-- Enforce: ai_answer implies mention_count >= 1.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'competitors_ai_answer_min_mentions'
  ) then
    alter table competitors
      add constraint competitors_ai_answer_min_mentions
      check (discovery_source <> 'ai_answer' or mention_count >= 1);
  end if;
end
$$;

create index if not exists competitors_project_idx
  on competitors (project_id);
create index if not exists competitors_project_threat_idx
  on competitors (project_id, threat_level);
create index if not exists competitors_project_phantom_idx
  on competitors (project_id, is_phantom);
create index if not exists competitors_project_blindspot_idx
  on competitors (project_id, is_blind_spot);
