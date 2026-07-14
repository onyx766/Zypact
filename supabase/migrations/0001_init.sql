-- Zypact MVP — Sprint 1 schema.
-- Apply with:  supabase db push
-- or paste into the Supabase SQL editor.

create extension if not exists "pgcrypto";

create table if not exists projects (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid null,
  company_name  text null,
  domain        text not null,
  category      text null,
  created_at    timestamptz not null default now()
);

create index if not exists projects_domain_idx on projects (domain);
create index if not exists projects_user_id_idx on projects (user_id);

create table if not exists site_pages (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects (id) on delete cascade,
  url         text not null,
  title       text not null default '',
  content     text not null default '',
  page_type   text not null default 'other',
  created_at  timestamptz not null default now()
);

create index if not exists site_pages_project_idx on site_pages (project_id);

create table if not exists mirror_profiles (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects (id) on delete cascade,
  json        jsonb not null,
  created_at  timestamptz not null default now()
);

create index if not exists mirror_profiles_project_idx on mirror_profiles (project_id);
