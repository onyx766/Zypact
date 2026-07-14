-- Zypact MVP — Sprint 7 schema addition.
-- Apply with:  supabase db push
-- Adds the fix_briefs table (many per project) — the Fix Brief Agent's
-- validated output in `fix_brief` mode. Sprint 7 does NOT yet materialize
-- generated assets; that comes with `generate_asset` mode later.

create table if not exists fix_briefs (
  id                     uuid primary key default gen_random_uuid(),
  project_id             uuid not null
                         references projects (id) on delete cascade,
  -- Optional pointers — we may derive a Fix Brief from an ad-hoc gap in the
  -- future, so both foreign keys are nullable. `on delete set null` keeps
  -- historical briefs even if the source gap/probe is later replaced.
  gap_id                 uuid null
                         references gaps (id) on delete set null,
  probe_result_id        uuid null
                         references probe_results (id) on delete set null,
  lost_prompt            text not null,
  competitor_recommended text not null,
  root_cause             text not null,
  recommended_fix        text not null,
  fix_type               text not null
                         check (fix_type in
                           ('comparison_page','faq_block','proof_block',
                            'comparison_table','schema')),
  assets_to_generate     jsonb not null default '[]'::jsonb,
  evidence_needed        jsonb not null default '[]'::jsonb,
  evidence_available     jsonb not null default '[]'::jsonb,
  priority               int not null check (priority between 1 and 5),
  expected_impact        text not null,
  status                 text not null
                         check (status in
                           ('draft','needs_evidence','ready_for_assets')),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  -- rootCause ceiling mirrors ROOT_CAUSE_MAX in the Zod schema.
  constraint fix_briefs_root_cause_len
    check (char_length(root_cause) <= 1000),

  -- At least one asset must be requested — mirrors Zod `.min(1)`.
  constraint fix_briefs_assets_min
    check (jsonb_array_length(assets_to_generate) >= 1)
);

create index if not exists fix_briefs_project_idx
  on fix_briefs (project_id);
create index if not exists fix_briefs_project_priority_idx
  on fix_briefs (project_id, priority);
create index if not exists fix_briefs_project_status_idx
  on fix_briefs (project_id, status);
