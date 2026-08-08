-- Snapshot report delivery fencing.
--
-- A founder can review a stored report and then either send it or replace it
-- with a corrected one. Those two actions raced: send read the artifact,
-- called an external email provider, and only then wrote `delivered_at`. A
-- replacement landing inside that window meant one revision reached the
-- customer while the database recorded another as delivered.
--
-- A row lock cannot span the provider call — it ends when the RPC's
-- transaction commits. So exclusion is carried by a persistent claim instead:
-- `begin_snapshot_report_delivery` reserves the artifact and returns the exact
-- markdown the claim covers, the application emails *that* payload, and
-- `finalize_snapshot_report_delivery` records delivery against the same token.
-- Replacement refuses while any claim is held.
--
-- A claim is authoritative regardless of age. An old claim means the provider
-- may already have accepted the email before the process died, which is
-- ambiguous, so it fails closed and waits for a human. `delivery_claimed_at`
-- is diagnostic only: nothing here reads it to grant authorization.

alter table public.snapshot_report_artifacts
  add column if not exists delivery_claim_token uuid null;

alter table public.snapshot_report_artifacts
  add column if not exists delivery_claimed_at timestamptz null;

comment on column public.snapshot_report_artifacts.delivery_claim_token is
  'Non-null while a delivery is reserved. Blocks replacement and any second '
  'claim until finalize or an explicit matching-token release. Age never '
  'clears it.';

comment on column public.snapshot_report_artifacts.delivery_claimed_at is
  'Diagnostic only. Never used to authorize replacement or a new claim.';

-- ---------------------------------------------------------------------------
-- NULL-safety: every caller-supplied fencing value is compared with
-- IS DISTINCT FROM, never <>. In SQL `x <> NULL` is NULL, and PL/pgSQL does
-- not enter an IF NULL branch — so a NULL parameter would fall straight
-- through a `<>` guard and authorize the operation. An unset adapter field or
-- a missing JSON key must fail closed, not open.

-- Canonical revision
-- ---------------------------------------------------------------------------
-- Hash-of-hashes rather than concatenated markdown: hashing each field first
-- makes the boundary unambiguous, so no combination of report bodies can
-- collide by shifting text across the join. Both columns are NOT NULL, so
-- there is no null case to define.

create or replace function public.snapshot_report_artifact_revision(
  p_full_report_markdown text,
  p_short_report_markdown text
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select encode(
    digest(
      digest(convert_to(p_full_report_markdown, 'UTF8'), 'sha256')
      || digest(convert_to(p_short_report_markdown, 'UTF8'), 'sha256'),
      'sha256'
    ),
    'hex'
  );
$$;

-- ---------------------------------------------------------------------------
-- Replace an undelivered, unclaimed artifact
-- ---------------------------------------------------------------------------

create or replace function public.replace_undelivered_snapshot_report_artifact(
  p_snapshot_request_id uuid,
  p_expected_artifact_id uuid,
  p_expected_revision text,
  p_full_report_markdown text,
  p_short_report_markdown text
)
returns table (artifact_id uuid, revision text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.snapshot_requests;
  v_artifact public.snapshot_report_artifacts;
  v_current_revision text;
begin
  select * into v_request
    from public.snapshot_requests
    where id = p_snapshot_request_id
    for update;

  if not found then
    raise exception 'snapshot request not found'
      using errcode = 'no_data_found';
  end if;

  if v_request.status <> 'report_ready' then
    raise exception 'snapshot request status is %, expected report_ready',
      v_request.status
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_artifact
    from public.snapshot_report_artifacts
    where snapshot_request_id = p_snapshot_request_id
    for update;

  if not found then
    raise exception 'snapshot report artifact not found'
      using errcode = 'no_data_found';
  end if;

  if v_artifact.id is distinct from p_expected_artifact_id then
    raise exception 'artifact id mismatch'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_artifact.delivered_at is not null then
    raise exception 'report already delivered'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Age is deliberately not consulted: a held claim always wins.
  if v_artifact.delivery_claim_token is not null then
    raise exception 'delivery claim is active'
      using errcode = 'lock_not_available';
  end if;

  v_current_revision := public.snapshot_report_artifact_revision(
    v_artifact.full_report_markdown,
    v_artifact.short_report_markdown
  );

  if v_current_revision is distinct from p_expected_revision then
    raise exception 'artifact revision changed since preview'
      using errcode = 'serialization_failure';
  end if;

  -- One UPDATE: both bodies move together or neither does.
  update public.snapshot_report_artifacts
    set full_report_markdown = p_full_report_markdown,
        short_report_markdown = p_short_report_markdown,
        updated_at = now()
    where id = v_artifact.id;

  return query
    select v_artifact.id,
           public.snapshot_report_artifact_revision(
             p_full_report_markdown,
             p_short_report_markdown
           );
end;
$$;

-- ---------------------------------------------------------------------------
-- Reserve a delivery
-- ---------------------------------------------------------------------------
-- Returns the markdown the claim covers so the caller never re-reads an
-- unclaimed artifact. Reviewed revision == claimed revision == emailed
-- revision.

create or replace function public.begin_snapshot_report_delivery(
  p_snapshot_request_id uuid,
  p_expected_artifact_id uuid,
  p_expected_revision text
)
returns table (
  artifact_id uuid,
  revision text,
  delivery_claim_token uuid,
  full_report_markdown text,
  short_report_markdown text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.snapshot_requests;
  v_artifact public.snapshot_report_artifacts;
  v_current_revision text;
  v_token uuid;
begin
  select * into v_request
    from public.snapshot_requests
    where id = p_snapshot_request_id
    for update;

  if not found then
    raise exception 'snapshot request not found'
      using errcode = 'no_data_found';
  end if;

  if v_request.status <> 'report_ready' then
    raise exception 'snapshot request status is %, expected report_ready',
      v_request.status
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_artifact
    from public.snapshot_report_artifacts
    where snapshot_request_id = p_snapshot_request_id
    for update;

  if not found then
    raise exception 'snapshot report artifact not found'
      using errcode = 'no_data_found';
  end if;

  if v_artifact.id is distinct from p_expected_artifact_id then
    raise exception 'artifact id mismatch'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_artifact.delivered_at is not null then
    raise exception 'report already delivered'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_artifact.delivery_claim_token is not null then
    raise exception 'delivery claim is active'
      using errcode = 'lock_not_available';
  end if;

  v_current_revision := public.snapshot_report_artifact_revision(
    v_artifact.full_report_markdown,
    v_artifact.short_report_markdown
  );

  if v_current_revision is distinct from p_expected_revision then
    raise exception 'artifact revision changed since preview'
      using errcode = 'serialization_failure';
  end if;

  v_token := gen_random_uuid();

  update public.snapshot_report_artifacts
    set delivery_claim_token = v_token,
        delivery_claimed_at = now(),
        updated_at = now()
    where id = v_artifact.id;

  return query
    select v_artifact.id,
           v_current_revision,
           v_token,
           v_artifact.full_report_markdown,
           v_artifact.short_report_markdown;
end;
$$;

-- ---------------------------------------------------------------------------
-- Finalize a claimed delivery
-- ---------------------------------------------------------------------------

create or replace function public.finalize_snapshot_report_delivery(
  p_snapshot_request_id uuid,
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
  v_artifact public.snapshot_report_artifacts;
  v_delivered_at timestamptz;
begin
  select * into v_artifact
    from public.snapshot_report_artifacts
    where snapshot_request_id = p_snapshot_request_id
    for update;

  if not found then
    raise exception 'snapshot report artifact not found'
      using errcode = 'no_data_found';
  end if;

  if v_artifact.id is distinct from p_artifact_id then
    raise exception 'artifact id mismatch'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_artifact.delivered_at is not null then
    raise exception 'report already delivered'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_artifact.delivery_claim_token is null
     or v_artifact.delivery_claim_token is distinct from p_delivery_claim_token then
    raise exception 'delivery claim token mismatch'
      using errcode = 'invalid_parameter_value';
  end if;

  v_delivered_at := now();

  update public.snapshot_report_artifacts
    set delivered_at = v_delivered_at,
        delivery_message_id = p_delivery_message_id,
        delivery_claim_token = null,
        delivery_claimed_at = null,
        updated_at = now()
    where id = v_artifact.id;

  return query select v_artifact.id, v_delivered_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- Release a claim
-- ---------------------------------------------------------------------------
-- A primitive only. It takes no view on whether a provider failure was
-- definitive — the caller owns that judgement, and must not call this after an
-- ambiguous outcome.

create or replace function public.release_snapshot_report_delivery_claim(
  p_snapshot_request_id uuid,
  p_artifact_id uuid,
  p_delivery_claim_token uuid
)
returns table (artifact_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_artifact public.snapshot_report_artifacts;
begin
  select * into v_artifact
    from public.snapshot_report_artifacts
    where snapshot_request_id = p_snapshot_request_id
    for update;

  if not found then
    raise exception 'snapshot report artifact not found'
      using errcode = 'no_data_found';
  end if;

  if v_artifact.id is distinct from p_artifact_id then
    raise exception 'artifact id mismatch'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_artifact.delivered_at is not null then
    raise exception 'report already delivered'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_artifact.delivery_claim_token is null
     or v_artifact.delivery_claim_token is distinct from p_delivery_claim_token then
    raise exception 'delivery claim token mismatch'
      using errcode = 'invalid_parameter_value';
  end if;

  update public.snapshot_report_artifacts
    set delivery_claim_token = null,
        delivery_claimed_at = null,
        updated_at = now()
    where id = v_artifact.id;

  return query select v_artifact.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- ACLs — server service path only, per migration 0031 precedent
-- ---------------------------------------------------------------------------

revoke all on function public.snapshot_report_artifact_revision(text, text) from public;
revoke all on function public.snapshot_report_artifact_revision(text, text) from anon;
revoke all on function public.snapshot_report_artifact_revision(text, text) from authenticated;
grant execute on function public.snapshot_report_artifact_revision(text, text) to service_role;

revoke all on function public.replace_undelivered_snapshot_report_artifact(uuid, uuid, text, text, text) from public;
revoke all on function public.replace_undelivered_snapshot_report_artifact(uuid, uuid, text, text, text) from anon;
revoke all on function public.replace_undelivered_snapshot_report_artifact(uuid, uuid, text, text, text) from authenticated;
grant execute on function public.replace_undelivered_snapshot_report_artifact(uuid, uuid, text, text, text) to service_role;

revoke all on function public.begin_snapshot_report_delivery(uuid, uuid, text) from public;
revoke all on function public.begin_snapshot_report_delivery(uuid, uuid, text) from anon;
revoke all on function public.begin_snapshot_report_delivery(uuid, uuid, text) from authenticated;
grant execute on function public.begin_snapshot_report_delivery(uuid, uuid, text) to service_role;

revoke all on function public.finalize_snapshot_report_delivery(uuid, uuid, uuid, text) from public;
revoke all on function public.finalize_snapshot_report_delivery(uuid, uuid, uuid, text) from anon;
revoke all on function public.finalize_snapshot_report_delivery(uuid, uuid, uuid, text) from authenticated;
grant execute on function public.finalize_snapshot_report_delivery(uuid, uuid, uuid, text) to service_role;

revoke all on function public.release_snapshot_report_delivery_claim(uuid, uuid, uuid) from public;
revoke all on function public.release_snapshot_report_delivery_claim(uuid, uuid, uuid) from anon;
revoke all on function public.release_snapshot_report_delivery_claim(uuid, uuid, uuid) from authenticated;
grant execute on function public.release_snapshot_report_delivery_claim(uuid, uuid, uuid) to service_role;
