-- Zypact MVP — Sprint 9 schema addition.
-- Apply with:  supabase db push
--
-- Adds the qa_reports table (many per generated asset) — the adversarial
-- output of the QA Agent. Each row is a full QA verdict for a single
-- Generated Asset at a point in time. New rows are appended (not upsert)
-- so the history of QA verdicts across Evidence Bank edits stays visible.
--
-- The pipeline runner also updates `generated_assets.qa_status` after
-- every QA run so listing views can render the latest verdict without
-- fanning out to `qa_reports`.

create table if not exists qa_reports (
  id                     uuid primary key default gen_random_uuid(),
  project_id             uuid not null
                         references projects (id) on delete cascade,
  generated_asset_id     uuid not null
                         references generated_assets (id) on delete cascade,
  verdict                text not null
                         check (verdict in
                           ('safe_to_publish',
                            'needs_evidence',
                            'unsupported_claims')),
  violations             jsonb not null default '[]'::jsonb,
  placeholders_remaining jsonb not null default '[]'::jsonb,
  overall_notes          text not null,
  created_at             timestamptz not null default now(),

  constraint qa_reports_overall_notes_nonempty
    check (char_length(overall_notes) > 0),
  constraint qa_reports_violations_is_array
    check (jsonb_typeof(violations) = 'array'),
  constraint qa_reports_placeholders_is_array
    check (jsonb_typeof(placeholders_remaining) = 'array'),

  -- Verdict / violations consistency (mirrors QaAgentOutputSchema):
  -- - safe_to_publish  => zero violations
  -- - unsupported_claims => at least one violation
  -- needs_evidence has a mixed rule (placeholders remaining OR quality-only
  -- violations); enforcing that structurally in SQL is noisy, so we leave
  -- it to the Zod schema and let SQL cover the crisp cases.
  constraint qa_reports_safe_no_violations
    check (verdict <> 'safe_to_publish'
           or jsonb_array_length(violations) = 0),
  constraint qa_reports_unsupported_has_violations
    check (verdict <> 'unsupported_claims'
           or jsonb_array_length(violations) >= 1)
);

create index if not exists qa_reports_project_idx
  on qa_reports (project_id);
create index if not exists qa_reports_generated_asset_idx
  on qa_reports (generated_asset_id);
create index if not exists qa_reports_asset_created_idx
  on qa_reports (generated_asset_id, created_at desc);
