-- Zypact MVP — Sprint 8 schema addition.
-- Apply with:  supabase db push
-- Adds the generated_assets table (many per fix brief) — the Fix Agent's
-- validated output in `generate_asset` mode. Sprint 8 saves every asset
-- with qa_status='pending_qa'; the QA Agent (future sprint) will mutate.

create table if not exists generated_assets (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null
                 references projects (id) on delete cascade,
  fix_brief_id   uuid not null
                 references fix_briefs (id) on delete cascade,
  asset_type     text not null
                 check (asset_type in
                   ('comparison_page_outline','faq_block','proof_block',
                    'comparison_table','json_ld_schema')),
  title          text not null,
  content        text not null,
  placeholders   jsonb not null default '[]'::jsonb,
  claims_used    jsonb not null default '[]'::jsonb,
  qa_status      text not null default 'pending_qa'
                 check (qa_status in
                   ('pending_qa','needs_evidence','safe_to_publish',
                    'unsupported_claims')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint generated_assets_title_nonempty  check (char_length(title) > 0),
  constraint generated_assets_content_nonempty check (char_length(content) > 0)
);

create index if not exists generated_assets_project_idx
  on generated_assets (project_id);
create index if not exists generated_assets_fix_brief_idx
  on generated_assets (fix_brief_id);
create index if not exists generated_assets_project_status_idx
  on generated_assets (project_id, qa_status);
