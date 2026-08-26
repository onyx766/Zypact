-- M1 — Probe evidence contract, FIRST TRANCHE. Not a complete M1 close-out
-- — see "What this migration does NOT do" below for the specific gaps
-- accepted for this tranche and left open for a follow-up migration.
--
-- Adds exact-evidence hashes, provider metadata, and append-only
-- protection for probe_results; a new analysis_llm_calls table for
-- internal-analysis (OpenAI/Anthropic/mock) traceability, kept
-- structurally separate from the Perplexity probe evidence trail.
--
-- This migration is idempotent — safe to re-run on any existing project.
--
-- Scope:
--   1. probe_results: add SHA-256 hash columns for the exact raw request
--      and raw response, plus provider HTTP status, latency, request id,
--      exact model string, and retry count.
--   2. analysis_llm_calls: new table recording every internal-analysis
--      model call (Mirror Profile, Probe Analysis, Competitor Discovery,
--      Gap Map, Fix Brief, QA — OpenAI gpt-4o-mini or Anthropic) with its
--      own provider/model/mock/retry/latency fields and its own SHA-256
--      hashes, so an internal analysis call is never confused with a
--      Perplexity probe answer in the evidence trail.
--   3. Append-only enforcement: REVOKE UPDATE/DELETE/TRUNCATE on both
--      tables from service_role, mirroring migration 0032. INSERT and
--      SELECT remain granted. Unlike 0032's staged rollout, this is safe
--      to apply immediately: `saveProbeResult` in
--      `lib/db/supabase-adapter.ts` only ever performs `.insert(...)` on
--      `probe_results`, never `.update()`/`.delete()`, and
--      `analysis_llm_calls` is a brand-new table with no existing writer.
--
-- What this migration does NOT do:
--   * Does not touch the auth schema or any Supabase system schema.
--   * Does not change RLS.
--   * Does not backfill hashes for existing probe_results rows — those
--     predate exact-byte capture and cannot be reconstructed after the
--     fact; they are left NULL, which is visible and honest rather than
--     a fabricated hash.
--   * Does not add a second external probe provider. Perplexity Sonar
--     remains the only probe surface — these are additive metadata
--     columns on the existing Perplexity-only probe_results table.
--     `analysis_llm_calls` is for the pipeline's internal analysis LLM
--     (OpenAI/Anthropic), not a second probe surface.
--
-- Known first-tranche gaps, accepted for now, not silently closed:
--   * raw_response_sha256 hashes a reconstructed transcript (answer +
--     citations + search results, built by `buildRawTranscript` in
--     `lib/probes/perplexity.ts`), NOT Perplexity's raw response bytes.
--     It proves the transcript is unaltered since it was built; it does
--     not prove byte-for-byte fidelity to what Perplexity returned.
--   * A failed Perplexity attempt (non-2xx status, or an empty-answer
--     response) is thrown as an in-memory Error in
--     `lib/probes/perplexity.ts` and never reaches this table — no row,
--     no failure metadata, is persisted for it yet. Failed/excluded
--     attempts are not yet visible in denominator reconciliation, which
--     METHODOLOGY.md requires.
--   * analysis_llm_calls is only written by the `probe-analysis` pipeline
--     stage today. Mirror Profile, Competitor Discovery, Gap Map, Fix
--     Brief, and QA still call the model without a trace row here.

-- ---------------------------------------------------------------------
-- probe_results — exact evidence metadata
-- ---------------------------------------------------------------------
alter table if exists public.probe_results
  add column if not exists raw_response_sha256 text;

-- SHA-256 of the buyer-question text ONLY (the user message content), not
-- the complete outbound HTTP body. See `full_request_body_sha256` for the
-- hash that covers the exact JSON body sent on the wire (model,
-- temperature, max_tokens, stream, web_search_options included).
alter table if exists public.probe_results
  add column if not exists raw_probe_request_sha256 text;

-- SHA-256 of the exact JSON-serialized HTTP request body sent to the
-- probe provider. NULL for pasted/manual (non-live) answers, which never
-- had an outbound body, and for rows saved before this field existed.
alter table if exists public.probe_results
  add column if not exists full_request_body_sha256 text;

alter table if exists public.probe_results
  add column if not exists provider_http_status integer;

alter table if exists public.probe_results
  add column if not exists provider_latency_ms integer;

alter table if exists public.probe_results
  add column if not exists provider_request_id text;

alter table if exists public.probe_results
  add column if not exists provider_model text;

alter table if exists public.probe_results
  add column if not exists retry_count integer;

update public.probe_results
   set retry_count = 0
 where retry_count is null;

alter table public.probe_results
  alter column retry_count set not null;

alter table public.probe_results
  alter column retry_count set default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'probe_results_raw_response_sha256_format_check'
  ) then
    alter table public.probe_results
      add constraint probe_results_raw_response_sha256_format_check
      check (raw_response_sha256 is null or raw_response_sha256 ~ '^[0-9a-f]{64}$');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'probe_results_raw_probe_request_sha256_format_check'
  ) then
    alter table public.probe_results
      add constraint probe_results_raw_probe_request_sha256_format_check
      check (raw_probe_request_sha256 is null or raw_probe_request_sha256 ~ '^[0-9a-f]{64}$');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'probe_results_full_request_body_sha256_format_check'
  ) then
    alter table public.probe_results
      add constraint probe_results_full_request_body_sha256_format_check
      check (full_request_body_sha256 is null or full_request_body_sha256 ~ '^[0-9a-f]{64}$');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- analysis_llm_calls — internal-analysis provider traceability
-- (Mirror Profile, Probe Analysis, Competitor Discovery, Gap Map,
-- Fix Brief, QA — OpenAI gpt-4o-mini or Anthropic, never Perplexity)
-- ---------------------------------------------------------------------
create table if not exists public.analysis_llm_calls (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete cascade,
  stage            text not null,
  provider         text not null check (provider in ('openai', 'anthropic', 'mock')),
  model            text not null,
  used_mock        boolean not null default false,
  used_retry       boolean not null default false,
  latency_ms       integer not null default 0,
  request_sha256   text,
  response_sha256  text,
  created_at       timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'analysis_llm_calls_request_sha256_format_check'
  ) then
    alter table public.analysis_llm_calls
      add constraint analysis_llm_calls_request_sha256_format_check
      check (request_sha256 is null or request_sha256 ~ '^[0-9a-f]{64}$');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'analysis_llm_calls_response_sha256_format_check'
  ) then
    alter table public.analysis_llm_calls
      add constraint analysis_llm_calls_response_sha256_format_check
      check (response_sha256 is null or response_sha256 ~ '^[0-9a-f]{64}$');
  end if;
end $$;

create index if not exists analysis_llm_calls_project_idx
  on public.analysis_llm_calls (project_id);
create index if not exists analysis_llm_calls_project_stage_idx
  on public.analysis_llm_calls (project_id, stage);

grant select, insert on public.analysis_llm_calls to service_role;

-- ---------------------------------------------------------------------
-- Append-only enforcement — mirrors migration 0032. INSERT and SELECT
-- remain granted; only post-insert mutation is revoked. REVOKE is
-- idempotent: revoking a privilege the role does not hold is a no-op.
-- ---------------------------------------------------------------------
revoke update on table public.probe_results from service_role;
revoke delete on table public.probe_results from service_role;
revoke truncate on table public.probe_results from service_role;

revoke update on table public.analysis_llm_calls from service_role;
revoke delete on table public.analysis_llm_calls from service_role;
revoke truncate on table public.analysis_llm_calls from service_role;
