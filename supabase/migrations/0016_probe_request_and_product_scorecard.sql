-- Sprint 13C — probe request integrity + product-vs-source scorecard.
--
-- Adds auditable fields to every probe result:
--   - raw_probe_request: exact platform request body/user message
--   - product_*: whether the client was recommended as a product/tool
--   - cited_as_source / client_source_count: source-citation visibility
--   - platforms_referenced: AI engines mentioned in the answer, not competitors
--
-- Existing rows are backfilled conservatively from the old mention verdict so
-- old reports remain readable. New rows write product-vs-source semantics.

alter table if exists public.probe_results
  add column if not exists raw_probe_request text not null default '';

alter table if exists public.probe_results
  add column if not exists product_mentioned boolean not null default false;

alter table if exists public.probe_results
  add column if not exists product_position text not null default 'absent';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'probe_results_product_position_check'
  ) then
    alter table public.probe_results
      add constraint probe_results_product_position_check
      check (product_position in ('primary','listed','negative','absent'));
  end if;
end $$;

alter table if exists public.probe_results
  add column if not exists product_verdict text not null default 'not_relevant';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'probe_results_product_verdict_check'
  ) then
    alter table public.probe_results
      add constraint probe_results_product_verdict_check
      check (product_verdict in ('won','partial','lost','not_relevant'));
  end if;
end $$;

alter table if exists public.probe_results
  add column if not exists cited_as_source boolean not null default false;

alter table if exists public.probe_results
  add column if not exists client_source_count integer not null default 0;

alter table if exists public.probe_results
  add column if not exists platforms_referenced jsonb not null default '[]'::jsonb;

update public.probe_results
   set raw_probe_request = coalesce(nullif(raw_probe_request, ''), prompt),
       product_mentioned = case when product_mentioned then product_mentioned else client_mentioned end,
       product_position = case when product_position = 'absent' and client_mentioned then client_position else product_position end,
       product_verdict = case when product_verdict = 'not_relevant' and verdict in ('won','partial','lost','not_relevant') then verdict else product_verdict end
 where raw_probe_request = ''
    or (product_mentioned = false and client_mentioned = true)
    or (product_verdict = 'not_relevant' and verdict <> 'not_relevant');

create index if not exists probe_results_project_product_verdict_idx
  on public.probe_results (project_id, product_verdict);
