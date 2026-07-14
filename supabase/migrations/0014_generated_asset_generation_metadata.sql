-- Sprint 13B.1 — asset generation traceability.
-- Adds nullable metadata so benchmark reports can prove which provider/model
-- produced each generated asset. Existing rows are intentionally backfilled as
-- legacy_unknown because old assets were not persisted with generation metadata.

alter table generated_assets
  add column if not exists generation_provider text,
  add column if not exists generation_model text;

update generated_assets
set
  generation_provider = coalesce(generation_provider, 'legacy_unknown'),
  generation_model = coalesce(generation_model, 'legacy_unknown')
where generation_provider is null or generation_model is null;
