-- M1-A — Exact provider request body.
--
-- Gap closed: since 0036, probe_results and probe_failures have stored
-- `full_request_body_sha256` -- a real SHA-256 of the exact JSON body
-- sent to the provider -- but never the body itself. The only text
-- column on the request side is `raw_probe_request` (added by 0016),
-- which holds the buyer PROMPT, not the outbound HTTP body: it does not
-- cover `model`, `temperature`, `max_tokens`, `stream`, or
-- `web_search_options`. A hash alone is not auditable evidence: it can
-- confirm a body someone already has, never reproduce one.
--
-- This migration adds the missing text column on both tables, mirroring
-- exactly the contract 0053 established for
-- analysis_call_receipts.raw_request_body:
--   * body and hash are inserted in the same statement, never a later
--     UPDATE;
--   * a real server-side SHA-256 CHECK (via the IMMUTABLE pgcrypto-backed
--     public._sha256_hex helper defined in 0051) rejects any row whose
--     declared hash does not match its stored body.
--
-- Historical rows are NOT reconstructed. A body that was never captured
-- cannot be recovered from its hash, and fabricating one would be
-- evidence forgery. Pre-existing rows keep hash-only provenance and are
-- explicitly labelled as such by a generated column, so a reader can
-- never mistake "we did not capture this" for "this was captured".
--
-- Idempotent. Does not touch the auth schema, RLS, or any privilege.
-- Adds no grant and revokes nothing: probe_results (0036) and
-- probe_failures (0037) already have UPDATE/DELETE/TRUNCATE revoked from
-- service_role, and the new column inherits that append-only guarantee.

-- ---------------------------------------------------------------------
-- 1. probe_results — exact outbound request body
-- ---------------------------------------------------------------------
alter table if exists public.probe_results
  add column if not exists full_request_body text;

comment on column public.probe_results.full_request_body is
  'M1-A — the exact UTF-8 JSON body sent to the provider, byte-identical to what was written to the wire and to what full_request_body_sha256 hashes. Distinct from raw_probe_request, which is the buyer prompt only. Null on rows captured before this contract existed.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'probe_results_full_request_body_pairing_check'
  ) then
    alter table public.probe_results
      add constraint probe_results_full_request_body_pairing_check
      check (full_request_body is null or full_request_body_sha256 is not null);
  end if;
end $$;

do $$
declare
  v_bad_count integer;
begin
  select count(*) into v_bad_count
    from public.probe_results
   where full_request_body is not null
     and full_request_body_sha256 is not null
     and full_request_body_sha256 <> public._sha256_hex(full_request_body);

  if v_bad_count > 0 then
    raise exception 'M1-A preflight failed: % probe_results rows have full_request_body_sha256 not matching sha256(full_request_body)', v_bad_count;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'probe_results_full_request_body_hash_match_check'
  ) then
    alter table public.probe_results
      add constraint probe_results_full_request_body_hash_match_check
      check (
        full_request_body is null
        or full_request_body_sha256 = public._sha256_hex(full_request_body)
      );
  end if;
end $$;

alter table if exists public.probe_results
  add column if not exists full_request_body_capture text
    generated always as (
      case
        when full_request_body is not null then 'captured'
        when full_request_body_sha256 is not null then 'legacy_hash_only'
        else 'absent'
      end
    ) stored;

comment on column public.probe_results.full_request_body_capture is
  'M1-A — derived provenance of the outbound request body. GENERATED ALWAYS, so no writer can assert a capture level the stored columns do not support. captured = exact body present and hash-verified; legacy_hash_only = hash recorded before M1-A, body never captured and never reconstructible; absent = neither.';

-- ---------------------------------------------------------------------
-- 2. probe_failures — same contract on the failure path
-- ---------------------------------------------------------------------
alter table if exists public.probe_failures
  add column if not exists full_request_body text;

comment on column public.probe_failures.full_request_body is
  'M1-A — the exact UTF-8 JSON body sent to the provider on the attempt that failed. A failed paid attempt is evidence too: its request must be as reproducible as a successful one.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'probe_failures_full_request_body_pairing_check'
  ) then
    alter table public.probe_failures
      add constraint probe_failures_full_request_body_pairing_check
      check (full_request_body is null or full_request_body_sha256 is not null);
  end if;
end $$;

do $$
declare
  v_bad_count integer;
begin
  select count(*) into v_bad_count
    from public.probe_failures
   where full_request_body is not null
     and full_request_body_sha256 is not null
     and full_request_body_sha256 <> public._sha256_hex(full_request_body);

  if v_bad_count > 0 then
    raise exception 'M1-A preflight failed: % probe_failures rows have full_request_body_sha256 not matching sha256(full_request_body)', v_bad_count;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'probe_failures_full_request_body_hash_match_check'
  ) then
    alter table public.probe_failures
      add constraint probe_failures_full_request_body_hash_match_check
      check (
        full_request_body is null
        or full_request_body_sha256 = public._sha256_hex(full_request_body)
      );
  end if;
end $$;

alter table if exists public.probe_failures
  add column if not exists full_request_body_capture text
    generated always as (
      case
        when full_request_body is not null then 'captured'
        when full_request_body_sha256 is not null then 'legacy_hash_only'
        else 'absent'
      end
    ) stored;

comment on column public.probe_failures.full_request_body_capture is
  'M1-A — derived provenance of the outbound request body on the failure path. GENERATED ALWAYS; same three levels as probe_results.full_request_body_capture.';
