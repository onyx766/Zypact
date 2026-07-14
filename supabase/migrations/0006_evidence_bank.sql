-- Zypact MVP — Sprint 6 schema addition.
-- Apply with:  supabase db push
-- Adds the evidence_banks table (one row per project) — the safety layer
-- that constrains future Fix Agent and QA Agent output.

create table if not exists evidence_banks (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null unique
                       references projects (id) on delete cascade,
  product_description  text not null default '',
  target_audience      jsonb not null default '[]'::jsonb,
  main_use_cases       jsonb not null default '[]'::jsonb,
  features             jsonb not null default '[]'::jsonb,
  proof_items          jsonb not null default '[]'::jsonb,
  competitors          jsonb not null default '[]'::jsonb,
  allowed_claims       jsonb not null default '[]'::jsonb,
  forbidden_claims     jsonb not null default '[]'::jsonb,
  tone                 text not null default 'plain'
                       check (tone in
                         ('plain','confident','technical','friendly','executive')),
  notes                text not null default '',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- Length ceiling mirrors PRODUCT_DESCRIPTION_MAX in the Zod schema.
  constraint evidence_banks_product_description_len
    check (char_length(product_description) <= 2000),

  -- forbiddenClaims must contain at least 3 items — mirrors Zod min(3).
  constraint evidence_banks_forbidden_claims_min
    check (jsonb_array_length(forbidden_claims) >= 3)
);

create index if not exists evidence_banks_project_idx
  on evidence_banks (project_id);
