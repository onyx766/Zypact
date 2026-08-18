-- M1 — Probe evidence contract, SECOND TRANCHE. Follows migration 0036.
-- Closes two of the three gaps 0036 documented as accepted-for-now:
--
--   1. probe_results.raw_response_sha256 hashed only a reconstructed
--      transcript, never Perplexity's raw response bytes. This migration
--      adds raw_response_body / raw_response_body_sha256, the exact
--      response text captured before JSON.parse.
--   2. A failed Perplexity attempt (network error, non-2xx status, or an
--      empty answer) was thrown as an in-memory Error and never
--      persisted. This migration adds probe_failures, an append-only
--      table for exactly those attempts.
--
-- Still NOT closed by this migration (unchanged from 0036):
--   * analysis_llm_calls is still written by the probe-analysis pipeline
--     stage only. Mirror Profile, Competitor Discovery, Gap Map, Fix
--     Brief, and QA remain untraced.
--
-- This migration is idempotent — safe to re-run on any existing project.
-- Does not touch the auth schema, does not change RLS, does not touch
-- probe_results/analysis_llm_calls beyond the two new columns below.

-- ---------------------------------------------------------------------
-- probe_results — the true raw response body, separate from the
-- reconstructed transcript already covered by raw_response_sha256
-- ---------------------------------------------------------------------
alter table if exists public.probe_results
  add column if not exists raw_response_body text;

alter table if exists public.probe_results
  add column if not exists raw_response_body_sha256 text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'probe_results_raw_response_body_sha256_format_check'
  ) then
    alter table public.probe_results
      add constraint probe_results_raw_response_body_sha256_format_check
      check (raw_response_body_sha256 is null or raw_response_body_sha256 ~ '^[0-9a-f]{64}$');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- probe_failures — persisted evidence for failed live probe attempts.
--
-- Not linked to probe_runs: a probe_runs row is only created once
-- analyze-probe-response.ts starts, which happens after a *successful*
-- runPerplexityProbe call. A provider-level failure (network error,
-- non-2xx, empty answer) happens before any probe_runs row exists, so
-- probe_run_id is nullable here. When a probe_runs row does exist for
-- the same attempt (not the common case for a first-call failure), the
-- caller may still supply it.
-- ---------------------------------------------------------------------
create table if not exists public.probe_failures (
  id                          uuid primary key default gen_random_uuid(),
  probe_run_id                uuid null references public.probe_runs (id) on delete cascade,
  project_id                  uuid not null references public.projects (id) on delete cascade,
  platform                    text not null,
  prompt                      text not null,
  failure_reason              text not null
                               check (failure_reason in ('network_error', 'http_error', 'empty_answer')),
  provider_http_status        integer,
  provider_error_body         text,
  provider_error_body_sha256  text,
  provider_latency_ms         integer,
  provider_request_id         text,
  raw_probe_request_sha256    text,
  full_request_body_sha256    text,
  retry_count                 integer not null default 0,
  created_at                  timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'probe_failures_provider_error_body_sha256_format_check'
  ) then
    alter table public.probe_failures
      add constraint probe_failures_provider_error_body_sha256_format_check
      check (provider_error_body_sha256 is null or provider_error_body_sha256 ~ '^[0-9a-f]{64}$');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'probe_failures_raw_probe_request_sha256_format_check'
  ) then
    alter table public.probe_failures
      add constraint probe_failures_raw_probe_request_sha256_format_check
      check (raw_probe_request_sha256 is null or raw_probe_request_sha256 ~ '^[0-9a-f]{64}$');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'probe_failures_full_request_body_sha256_format_check'
  ) then
    alter table public.probe_failures
      add constraint probe_failures_full_request_body_sha256_format_check
      check (full_request_body_sha256 is null or full_request_body_sha256 ~ '^[0-9a-f]{64}$');
  end if;
end $$;

create index if not exists probe_failures_project_idx
  on public.probe_failures (project_id);
create index if not exists probe_failures_project_reason_idx
  on public.probe_failures (project_id, failure_reason);

grant select, insert on public.probe_failures to service_role;

-- ---------------------------------------------------------------------
-- Append-only enforcement — mirrors 0032 and 0036. INSERT and SELECT
-- remain granted; only post-insert mutation is revoked. REVOKE is
-- idempotent: revoking a privilege the role does not hold is a no-op.
-- probe_failures has no existing writer to migrate (brand new table),
-- so this is safe to apply in the same migration that creates it.
-- ---------------------------------------------------------------------
revoke update on table public.probe_failures from service_role;
revoke delete on table public.probe_failures from service_role;
revoke truncate on table public.probe_failures from service_role;
