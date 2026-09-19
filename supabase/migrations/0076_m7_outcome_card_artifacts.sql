-- M7 step 8 — persisting and delivering the Outcome Card.
--
-- Founder decision, 2026-09-18: a dedicated table and a full delivery
-- pipeline, mirroring `snapshot_report_artifacts` (0027/0029/0031/0035/
-- 0065/0068) rather than reusing it or storing the card as JSON on a
-- protocol row. The reasoning that decision weighed:
--
-- `snapshot_report_artifacts` is keyed by `snapshot_request_id`, and a
-- retest protocol has no `snapshot_request` at all — it is identified by
-- its INTERVENTION and its BASELINE PROTOCOL, concepts that postdate that
-- table by twenty-plus migrations. Bending the existing table to also
-- describe a two-phase comparison would mean either a nullable foreign key
-- that is sometimes meaningless, or overloading `report_payload` with two
-- fundamentally different JSON shapes behind one column. Neither is
-- honest about what the row means.
--
-- `outcome_card_artifacts` is therefore keyed by `intervention_id` (unique
-- — one card per intervention, exactly as one report artifact exists per
-- snapshot request), with `baseline_protocol_id`/`retest_protocol_id`
-- carried as real foreign keys rather than derived at read time. Everything
-- else below is a deliberate, close mirror of the existing artifact
-- machinery: the same public-token shape (0029), the same delivery-claim
-- fencing (0035), the same integrity-status pairing constraint (0068). This
-- is not independently novel design; it is one applied twice with the
-- second application's identity fixed to fit what it actually describes.
--
-- ── One deliberate improvement over the 0035 precedent ──────────────────
--
-- 0035's `begin_snapshot_report_delivery` does not consult integrity status
-- at all — that gate lived ENTIRELY in application code
-- (`deliver-protocol-report.ts`), because `integrity_status` did not exist
-- until 0068, three migrations later, and 0068 never went back to add a
-- database-layer check to the fencing RPCs it postdated.
--
-- This branch's own migration audit (docs/MIGRATION_AUDIT_0061_0069.md,
-- finding F-1) found the exact consequence of that gap on the baseline
-- path: `blocked` was enforced only in admin UI components, and the send-
-- report API route would have delivered a blocked artifact if called
-- directly. The fix there was adding the check at the application layer.
--
-- `begin_outcome_card_delivery` below does not repeat that gap: it refuses
-- to open a delivery claim on a `blocked` artifact AT THE DATABASE LAYER,
-- unconditionally, regardless of what any future caller checks or forgets
-- to check. `needs_review` is deliberately NOT refused here — the canonical
-- rule is that it requires founder/admin review, not that it can never be
-- sent, exactly mirroring the F-1 fix's own scope (blocked is refused;
-- needs_review is a human decision, not a database refusal).
--
-- ── What this migration does not do ──
--
-- It does not build the TypeScript orchestration function
-- (deliver-protocol-report.ts's equivalent for an Outcome Card), an API
-- route, or a public client page. Those are application-layer follow-ups
-- that call the RPCs defined here, exactly as the existing delivery
-- pipeline calls 0035/0065/0068's.
--
-- Rollback:
--   drop function if exists public.release_outcome_card_delivery_claim(uuid, uuid, uuid);
--   drop function if exists public.finalize_outcome_card_delivery(uuid, uuid, uuid, text);
--   drop function if exists public.begin_outcome_card_delivery(uuid, uuid, text);
--   drop function if exists public.save_outcome_card_artifact(
--     uuid, uuid, uuid, uuid, text, timestamptz, jsonb, text, jsonb);
--   drop function if exists public.outcome_card_artifact_revision(text, jsonb);
--   drop function if exists public._assert_outcome_card_artifact_input(text, timestamptz);
--   drop function if exists public._generate_outcome_card_public_token();
--   drop table if exists public.outcome_card_artifacts;
--
-- The table is new and nothing else references it, so a rollback cannot
-- destroy any evidence, protocol, or intervention row.

-- ---------------------------------------------------------------------
-- 1. outcome_card_artifacts
-- ---------------------------------------------------------------------

create table if not exists public.outcome_card_artifacts (
  id                      uuid primary key default gen_random_uuid(),

  intervention_id         uuid not null unique
                            references public.interventions (id) on delete cascade,
  project_id              uuid not null
                            references public.projects (id) on delete cascade,
  baseline_protocol_id    uuid not null
                            references public.protocols (id) on delete restrict,
  retest_protocol_id      uuid not null
                            references public.protocols (id) on delete restrict,

  markdown                text not null,
  payload                 jsonb not null,
  generated_at            timestamptz not null,

  integrity_status        text not null
                            check (integrity_status in ('integrity_passed', 'needs_review', 'blocked')),
  integrity_reasons        jsonb not null default '[]'::jsonb,

  public_token            text not null,

  delivered_at            timestamptz null,
  delivery_message_id     text null,
  delivery_claim_token    uuid null,
  delivery_claimed_at     timestamptz null,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint outcome_card_artifacts_markdown_not_empty
    check (char_length(markdown) > 0),
  constraint outcome_card_artifacts_payload_is_object
    check (jsonb_typeof(payload) = 'object'),
  constraint outcome_card_artifacts_reasons_is_array
    check (jsonb_typeof(integrity_reasons) = 'array'),
  -- Mirrors 0068's exact pairing: a pass carries no reasons, and anything
  -- less than a pass must name at least one.
  constraint outcome_card_artifacts_integrity_reasons_pair_check
    check (
      (integrity_status = 'integrity_passed' and jsonb_array_length(integrity_reasons) = 0)
      or
      (integrity_status <> 'integrity_passed' and jsonb_array_length(integrity_reasons) > 0)
    ),
  constraint outcome_card_artifacts_public_token_length
    check (char_length(public_token) >= 43)
);

create unique index if not exists outcome_card_artifacts_public_token_idx
  on public.outcome_card_artifacts (public_token);

create index if not exists outcome_card_artifacts_project_idx
  on public.outcome_card_artifacts (project_id);

comment on table public.outcome_card_artifacts is
  'One row per registered intervention''s Outcome Card. Keyed by '
  'intervention_id, not by any snapshot_request — a retest has no request '
  'to be keyed against. Mirrors snapshot_report_artifacts'' shape closely '
  'on purpose; see this migration''s header for why the two are not the '
  'same table.';

alter table public.outcome_card_artifacts enable row level security;
alter table public.outcome_card_artifacts no force row level security;

revoke all on table public.outcome_card_artifacts from public;
revoke all on table public.outcome_card_artifacts from anon;
revoke all on table public.outcome_card_artifacts from authenticated;
grant select, insert, update, delete on table public.outcome_card_artifacts to service_role;

-- ---------------------------------------------------------------------
-- 2. Helpers — mirror 0031's _generate_snapshot_public_token and
--    _assert_snapshot_artifact_input exactly, trimmed to this table's
--    single markdown body (the Outcome Card has no short/full split).
-- ---------------------------------------------------------------------

create or replace function public._generate_outcome_card_public_token()
returns text
language sql
security definer
volatile
set search_path = public, pg_temp
as $$
  select replace(gen_random_uuid()::text, '-', '')
      || replace(gen_random_uuid()::text, '-', '');
$$;

revoke all on function public._generate_outcome_card_public_token() from public;
revoke all on function public._generate_outcome_card_public_token() from anon;
revoke all on function public._generate_outcome_card_public_token() from authenticated;
revoke all on function public._generate_outcome_card_public_token() from service_role;

create or replace function public._assert_outcome_card_artifact_input(
  p_markdown text,
  p_generated_at timestamptz
)
returns void
language plpgsql
security definer
immutable
set search_path = public, pg_temp
as $$
begin
  if p_markdown is null
     or char_length(btrim(p_markdown)) = 0
     or p_generated_at is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_outcome_card_artifact_input';
  end if;
end;
$$;

revoke all on function public._assert_outcome_card_artifact_input(text, timestamptz) from public;
revoke all on function public._assert_outcome_card_artifact_input(text, timestamptz) from anon;
revoke all on function public._assert_outcome_card_artifact_input(text, timestamptz) from authenticated;
revoke all on function public._assert_outcome_card_artifact_input(text, timestamptz) from service_role;

-- ---------------------------------------------------------------------
-- 3. outcome_card_artifact_revision — mirrors
--    snapshot_report_artifact_revision's hash-of-hashes construction.
--    jsonb's text cast is canonical for equal values (Postgres normalizes
--    key order internally), so hashing payload::text is deterministic.
-- ---------------------------------------------------------------------

do $do$
declare
  v_pgcrypto_schema text;
  v_digest regprocedure;
begin
  select n.nspname
    into v_pgcrypto_schema
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pgcrypto';

  if v_pgcrypto_schema is null then
    raise exception 'pgcrypto extension is not installed; migration 0076 requires it';
  end if;

  v_digest := to_regprocedure(format('%I.digest(bytea,text)', v_pgcrypto_schema));
  if v_digest is null then
    raise exception 'pgcrypto schema % does not provide digest(bytea,text)', v_pgcrypto_schema;
  end if;

  execute format($fn$
create or replace function public.outcome_card_artifact_revision(
  p_markdown text,
  p_payload jsonb
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $body$
  select encode(
    %1$I.digest(
      %1$I.digest(convert_to(p_markdown, 'UTF8'), 'sha256'::text)
      || %1$I.digest(convert_to(p_payload::text, 'UTF8'), 'sha256'::text),
      'sha256'::text
    ),
    'hex'
  );
$body$;
$fn$, v_pgcrypto_schema);
end
$do$;

revoke all on function public.outcome_card_artifact_revision(text, jsonb) from public;
revoke all on function public.outcome_card_artifact_revision(text, jsonb) from anon;
revoke all on function public.outcome_card_artifact_revision(text, jsonb) from authenticated;
grant execute on function public.outcome_card_artifact_revision(text, jsonb) to service_role;

-- ---------------------------------------------------------------------
-- 4. save_outcome_card_artifact
-- ---------------------------------------------------------------------
--
-- Beyond the shape mirrored from save_protocol_report_artifact (0065),
-- this function re-derives one safety invariant rather than trusting the
-- caller for it: the intervention must actually be `implemented`, and the
-- supplied retest protocol must actually be the retest FOR that
-- intervention's own baseline. lib/reports/outcome-card-integrity.ts
-- computes the same fact in TypeScript from live rows before calling this
-- — that computation and this check are independent, deliberately: a
-- caller bug in one must not be the only thing standing between a
-- fabricated card and a stored row.

create or replace function public.save_outcome_card_artifact(
  p_intervention_id       uuid,
  p_project_id            uuid,
  p_baseline_protocol_id  uuid,
  p_retest_protocol_id    uuid,
  p_markdown              text,
  p_generated_at          timestamptz,
  p_payload               jsonb,
  p_integrity_status      text,
  p_integrity_reasons     jsonb
)
returns setof public.outcome_card_artifacts
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_intervention public.interventions%rowtype;
  v_retest public.protocols%rowtype;
  v_artifact public.outcome_card_artifacts%rowtype;
  v_result public.outcome_card_artifacts%rowtype;
begin
  perform public._assert_outcome_card_artifact_input(p_markdown, p_generated_at);

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_outcome_card_payload';
  end if;

  if p_integrity_status is null
     or p_integrity_status not in ('integrity_passed', 'needs_review', 'blocked') then
    raise exception using errcode = '22023', message = 'invalid_outcome_card_integrity_status';
  end if;

  if p_integrity_reasons is null or jsonb_typeof(p_integrity_reasons) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_outcome_card_integrity_reasons';
  end if;

  if p_integrity_status = 'integrity_passed' and jsonb_array_length(p_integrity_reasons) <> 0 then
    raise exception using errcode = '22023', message = 'integrity_passed_must_carry_no_reasons';
  end if;
  if p_integrity_status <> 'integrity_passed' and jsonb_array_length(p_integrity_reasons) = 0 then
    raise exception using errcode = '22023', message = 'integrity_below_passed_requires_a_reason';
  end if;

  select i.* into v_intervention
    from public.interventions i
   where i.id = p_intervention_id
     and i.project_id = p_project_id
   for update;

  if not found then
    return;
  end if;

  -- The re-derived invariant. An Outcome Card describes a registered
  -- claim that was actually carried out; "approved" alone is not enough.
  if v_intervention.status <> 'implemented' then
    return;
  end if;

  if v_intervention.protocol_id is distinct from p_baseline_protocol_id then
    return;
  end if;

  select p.* into v_retest
    from public.protocols p
   where p.id = p_retest_protocol_id
     and p.project_id = p_project_id
     and p.baseline_protocol_id = p_baseline_protocol_id
   for update;

  if not found then
    return;
  end if;

  select artifact.* into v_artifact
    from public.outcome_card_artifacts artifact
   where artifact.intervention_id = p_intervention_id
   for update;

  -- A delivered artifact is immutable, matching 0065's precedent: the
  -- client has already read it.
  if found and v_artifact.delivered_at is not null then
    return;
  end if;

  if not found then
    insert into public.outcome_card_artifacts (
      intervention_id, project_id, baseline_protocol_id, retest_protocol_id,
      markdown, payload, generated_at,
      integrity_status, integrity_reasons,
      public_token
    ) values (
      p_intervention_id, p_project_id, p_baseline_protocol_id, p_retest_protocol_id,
      p_markdown, p_payload, p_generated_at,
      p_integrity_status, p_integrity_reasons,
      public._generate_outcome_card_public_token()
    )
    returning * into v_result;
  else
    update public.outcome_card_artifacts
       set markdown = p_markdown,
           payload = p_payload,
           generated_at = p_generated_at,
           integrity_status = p_integrity_status,
           integrity_reasons = p_integrity_reasons,
           updated_at = now()
     where intervention_id = p_intervention_id
    returning * into v_result;
  end if;

  return next v_result;
end;
$$;

revoke all on function public.save_outcome_card_artifact(
  uuid, uuid, uuid, uuid, text, timestamptz, jsonb, text, jsonb
) from public, anon, authenticated;
grant execute on function public.save_outcome_card_artifact(
  uuid, uuid, uuid, uuid, text, timestamptz, jsonb, text, jsonb
) to service_role;

-- ---------------------------------------------------------------------
-- 5. Delivery fencing — mirrors 0035's begin/finalize/release exactly,
--    keyed by intervention_id.
-- ---------------------------------------------------------------------

create or replace function public.begin_outcome_card_delivery(
  p_intervention_id uuid,
  p_expected_artifact_id uuid,
  p_expected_revision text
)
returns table (
  artifact_id uuid,
  revision text,
  delivery_claim_token uuid,
  markdown text,
  payload jsonb
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_artifact public.outcome_card_artifacts%rowtype;
  v_current_revision text;
  v_token uuid;
begin
  select * into v_artifact
    from public.outcome_card_artifacts
   where intervention_id = p_intervention_id
   for update;

  if not found then
    raise exception 'outcome card artifact not found'
      using errcode = 'no_data_found';
  end if;

  if v_artifact.id is distinct from p_expected_artifact_id then
    raise exception 'artifact id mismatch'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_artifact.delivered_at is not null then
    raise exception 'outcome card already delivered'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_artifact.delivery_claim_token is not null then
    raise exception 'delivery claim is active'
      using errcode = 'lock_not_available';
  end if;

  -- The deliberate improvement over 0035 — see this migration's header.
  -- `blocked` is refused HERE, unconditionally, not only by whichever
  -- caller happens to check integrity_status first.
  if v_artifact.integrity_status = 'blocked' then
    raise exception 'outcome card is blocked and may never be delivered'
      using errcode = 'invalid_parameter_value';
  end if;

  v_current_revision := public.outcome_card_artifact_revision(
    v_artifact.markdown, v_artifact.payload
  );

  if v_current_revision is distinct from p_expected_revision then
    raise exception 'artifact revision changed since preview'
      using errcode = 'serialization_failure';
  end if;

  v_token := gen_random_uuid();

  update public.outcome_card_artifacts
     set delivery_claim_token = v_token,
         delivery_claimed_at = now(),
         updated_at = now()
   where id = v_artifact.id;

  return query
    select v_artifact.id, v_current_revision, v_token, v_artifact.markdown, v_artifact.payload;
end;
$$;

create or replace function public.finalize_outcome_card_delivery(
  p_intervention_id uuid,
  p_artifact_id uuid,
  p_delivery_claim_token uuid,
  p_delivery_message_id text
)
returns table (artifact_id uuid, delivered_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_artifact public.outcome_card_artifacts%rowtype;
  v_delivered_at timestamptz;
begin
  select * into v_artifact
    from public.outcome_card_artifacts
   where intervention_id = p_intervention_id
   for update;

  if not found then
    raise exception 'outcome card artifact not found'
      using errcode = 'no_data_found';
  end if;

  if v_artifact.id is distinct from p_artifact_id then
    raise exception 'artifact id mismatch'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_artifact.delivered_at is not null then
    raise exception 'outcome card already delivered'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_artifact.delivery_claim_token is null
     or v_artifact.delivery_claim_token is distinct from p_delivery_claim_token then
    raise exception 'delivery claim token mismatch'
      using errcode = 'invalid_parameter_value';
  end if;

  v_delivered_at := now();

  update public.outcome_card_artifacts
     set delivered_at = v_delivered_at,
         delivery_message_id = p_delivery_message_id,
         delivery_claim_token = null,
         delivery_claimed_at = null,
         updated_at = now()
   where id = v_artifact.id;

  return query select v_artifact.id, v_delivered_at;
end;
$$;

create or replace function public.release_outcome_card_delivery_claim(
  p_intervention_id uuid,
  p_artifact_id uuid,
  p_delivery_claim_token uuid
)
returns table (artifact_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_artifact public.outcome_card_artifacts%rowtype;
begin
  select * into v_artifact
    from public.outcome_card_artifacts
   where intervention_id = p_intervention_id
   for update;

  if not found then
    raise exception 'outcome card artifact not found'
      using errcode = 'no_data_found';
  end if;

  if v_artifact.id is distinct from p_artifact_id then
    raise exception 'artifact id mismatch'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_artifact.delivered_at is not null then
    raise exception 'outcome card already delivered'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_artifact.delivery_claim_token is null
     or v_artifact.delivery_claim_token is distinct from p_delivery_claim_token then
    raise exception 'delivery claim token mismatch'
      using errcode = 'invalid_parameter_value';
  end if;

  update public.outcome_card_artifacts
     set delivery_claim_token = null,
         delivery_claimed_at = null,
         updated_at = now()
   where id = v_artifact.id;

  return query select v_artifact.id;
end;
$$;

revoke all on function public.begin_outcome_card_delivery(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.begin_outcome_card_delivery(uuid, uuid, text) to service_role;

revoke all on function public.finalize_outcome_card_delivery(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.finalize_outcome_card_delivery(uuid, uuid, uuid, text) to service_role;

revoke all on function public.release_outcome_card_delivery_claim(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.release_outcome_card_delivery_claim(uuid, uuid, uuid) to service_role;
