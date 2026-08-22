-- M5 — D-021: reprise sans double admission, idempotence opérateur
-- fingerprintée, retries provider/analysis séparés et rejouables,
-- création/rattachement probe_run atomique et rejouable, transition
-- ambiguë vers needs_review, contexte de reprise, monitoring interne.
-- DRAFT migration. Additive uniquement par rapport à 0050 (corrigée).
-- Not applied to any database by this commit.
--
-- Ce que cette migration NE fait PAS :
--   * Ne révoque rien — la révocation des trois RPC M4 brutes
--     (admit_and_reserve_attempt, start_attempt, reconcile_attempt)
--     reste dans une future migration de cutover, non créée ici.
--   * Ne backfill aucune donnée existante — chaque nouvelle contrainte
--     unique/composite est précédée d'un préflight READ-ONLY qui lève
--     une exception explicite si une collision historique existe,
--     plutôt que de la masquer ou de la corriger silencieusement.
--   * Ne touche à aucun adaptateur TypeScript, worker, CLI, ni aux
--     clients provider (lib/probes/perplexity.ts, lib/llm/call-model.ts)
--     — tranche SQL locale uniquement.
--   * Ne modifie pas les migrations 0001-0049.
--   * Ne référence aucun 5×3/$2 legacy ni verdict won/partial/lost.
--   * Ne s'applique à, ni ne se connecte à, aucune base staging ou
--     Production — ce fichier est créé localement uniquement.

-- =======================================================================
-- 0. protocol_execution_jobs.needs_review_reason — cohérence structurelle
--    avec status. Colonne déjà existante (0050), aucune nouvelle colonne
--    nécessaire. Vérifié : les deux RPC de reçu (record_provider_call_
--    receipt_for_job, record_analysis_call_receipt_for_job) posent déjà
--    la raison dans le même UPDATE que le statut ; authorize_operator_
--    retry efface déjà la raison dans les deux branches en sortant de
--    needs_review ; aucun autre écrivain ne touche à needs_review_reason
--    — aucun corps de fonction existant ne nécessite de correction.
-- =======================================================================

do $$
declare
  v_bad_count integer;
begin
  select count(*) into v_bad_count
    from public.protocol_execution_jobs
   where (status = 'needs_review') <> (needs_review_reason is not null);

  if v_bad_count > 0 then
    raise exception 'D-021 preflight failed: % protocol_execution_jobs rows violate the needs_review_reason/status invariant', v_bad_count;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_execution_jobs_needs_review_reason_pair_check'
  ) then
    alter table public.protocol_execution_jobs
      add constraint protocol_execution_jobs_needs_review_reason_pair_check
      check ((status = 'needs_review') = (needs_review_reason is not null));
  end if;
end $$;

-- =======================================================================
-- 1. protocol_operator_actions — idempotence opérateur avec fingerprint
--    canonique. authorize_operator_retry n'avait aucune clé caller-
--    supplied (son ancien 'operator-retry-' || gen_random_uuid()::text
--    interne était une clé fraîche à chaque appel, structurellement non
--    rejouable) — cette section corrige cela avant tout code applicatif.
-- =======================================================================

alter table public.protocol_operator_actions add column if not exists idempotency_key text null;
alter table public.protocol_operator_actions add column if not exists request_fingerprint text null;

do $$
declare
  v_existing_count integer;
begin
  select count(*) into v_existing_count from public.protocol_operator_actions;
  if v_existing_count > 0 then
    raise exception 'D-021 preflight failed: protocol_operator_actions has % existing rows with no idempotency_key/request_fingerprint — backfill is out of scope for this migration', v_existing_count;
  end if;
end $$;

alter table public.protocol_operator_actions alter column idempotency_key set not null;
alter table public.protocol_operator_actions alter column request_fingerprint set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_operator_actions_idempotency_key_not_blank_check'
  ) then
    alter table public.protocol_operator_actions
      add constraint protocol_operator_actions_idempotency_key_not_blank_check
      check (btrim(idempotency_key) <> '');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_operator_actions_fingerprint_format_check'
  ) then
    alter table public.protocol_operator_actions
      add constraint protocol_operator_actions_fingerprint_format_check
      check (request_fingerprint ~ '^[0-9a-f]{64}$');
  end if;
end $$;

-- D-021: request_fingerprint is a real SHA-256 hex digest of the
-- canonical JSONB request, computed server-side via pgcrypto's
-- digest() -- never the raw jsonb::text serialization itself. pgcrypto
-- is already installed by migration 0001 (`create extension if not
-- exists "pgcrypto"`), but the schema it lives in varies by
-- environment (`public` on a stock cluster, `extensions` on Supabase)
-- -- exactly the problem migration 0035 already solved for
-- snapshot_report_artifact_revision. The same pattern is reused here:
-- the schema is discovered from pg_extension at MIGRATION time and
-- baked into a small, private, reusable helper as a literal
-- identifier -- no runtime catalog lookup, no dynamic SQL inside
-- authorize_operator_retry itself.
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
    raise exception 'pgcrypto extension is not installed; migration 0051 requires it';
  end if;

  v_digest := to_regprocedure(format('%I.digest(bytea,text)', v_pgcrypto_schema));
  if v_digest is null then
    raise exception 'pgcrypto schema % does not provide digest(bytea,text)', v_pgcrypto_schema;
  end if;

  execute format($fn$
create or replace function public._sha256_hex(p_input text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $body$
  select encode(%1$I.digest(convert_to(p_input, 'UTF8'), 'sha256'::text), 'hex');
$body$;
$fn$, v_pgcrypto_schema);
end
$do$;

revoke all on function public._sha256_hex(text) from public, anon, authenticated, service_role;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_operator_actions_project_job_key_key'
  ) then
    alter table public.protocol_operator_actions
      add constraint protocol_operator_actions_project_job_key_key
      unique (project_id, job_id, idempotency_key);
  end if;
end $$;

-- _reserve_additional_analysis_generation_core gains a fourth,
-- default-null parameter recording which prior external_call this
-- generation retries (used both by authorize_operator_retry's
-- retry_analysis_only branch and by the new automatic
-- retry_analysis_generation_for_job below). Dropped and recreated
-- (rather than a second overload) so both existing 3-arg call sites
-- resolve unambiguously against the new signature using its default.
drop function if exists public._reserve_additional_analysis_generation_core(uuid, uuid, numeric);

create or replace function
  public._reserve_additional_analysis_generation_core(
    p_attempt_id uuid,
    p_project_id uuid,
    p_reserved_cost_usd numeric,
    p_retry_of_external_call_id uuid default null
  )
returns table (
  status        text,
  external_call public.protocol_external_calls
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_attempt public.protocol_attempts%rowtype;
  v_protocol public.protocols%rowtype;
  v_next_generation integer;
  v_spent numeric;
  v_new public.protocol_external_calls%rowtype;
begin
  if p_attempt_id is null or p_project_id is null
     or p_reserved_cost_usd is null or p_reserved_cost_usd < 0 then
    raise exception using
      errcode = '22023',
      message = 'invalid_reserve_additional_analysis_generation_core_args';
  end if;

  select pa.* into v_attempt
    from public.protocol_attempts pa
   where pa.id = p_attempt_id and pa.project_id = p_project_id
   for update;

  if not found then
    return query select 'NOT_FOUND'::text, null::public.protocol_external_calls;
    return;
  end if;

  if v_attempt.status <> 'in_progress' then
    return query select 'ATTEMPT_NOT_IN_PROGRESS'::text, null::public.protocol_external_calls;
    return;
  end if;

  select p.* into v_protocol
    from public.protocols p
   where p.id = v_attempt.protocol_id and p.project_id = p_project_id
   for update;

  if not found then
    return query select 'PROTOCOL_NOT_FOUND'::text, null::public.protocol_external_calls;
    return;
  end if;

  select coalesce(max(generation), 0) + 1 into v_next_generation
    from public.protocol_external_calls
   where protocol_attempt_id = p_attempt_id and call_kind = 'analysis';

  if v_next_generation > v_protocol.retry_cap + 1 then
    return query select 'RETRY_CAP_EXCEEDED'::text, null::public.protocol_external_calls;
    return;
  end if;

  select coalesce(sum(coalesce(pa2.actual_cost_usd, pa2.reserved_cost_usd)), 0) into v_spent
    from public.protocol_attempts pa2
   where pa2.protocol_id = v_protocol.id and pa2.status <> 'cancelled';

  if v_spent + p_reserved_cost_usd > v_protocol.spend_cap_usd then
    return query select 'SPEND_CAP_EXCEEDED'::text, null::public.protocol_external_calls;
    return;
  end if;

  insert into public.protocol_external_calls (
    project_id, protocol_attempt_id, call_kind, generation, status, reserved_cost_usd,
    retry_of_external_call_id
  ) values (
    p_project_id, p_attempt_id, 'analysis', v_next_generation, 'reserved', p_reserved_cost_usd,
    p_retry_of_external_call_id
  )
  returning * into v_new;

  update public.protocol_attempts
     set reserved_cost_usd = reserved_cost_usd + p_reserved_cost_usd,
         last_activity_at = now()
   where id = p_attempt_id and project_id = p_project_id;

  return query select 'RESERVED'::text, v_new;
end;
$$;

revoke all on function
  public._reserve_additional_analysis_generation_core(uuid, uuid, numeric, uuid)
  from public, anon, authenticated, service_role;

-- authorize_operator_retry — redefined with a mandatory caller-supplied
-- p_idempotency_key (did not exist before) and an optional
-- p_source_external_call_id (mandatory in practice for
-- retry_analysis_only, checked below). The old 8-parameter signature
-- (no stable key at all) is dropped explicitly so no overload without
-- one remains callable.
drop function if exists public.authorize_operator_retry(uuid, uuid, text, text, text, uuid, numeric, numeric);

create or replace function
  public.authorize_operator_retry(
    p_job_id uuid,
    p_project_id uuid,
    p_actor text,
    p_reason text,
    p_action text,
    p_source_attempt_id uuid,
    p_reserved_cost_usd numeric,
    p_idempotency_key text,
    p_source_external_call_id uuid default null,
    p_perplexity_reserved_cost_usd numeric default null
  )
returns table (
  status            text,
  outcome           text,
  denial_code       text,
  new_attempt       public.protocol_attempts,
  new_external_call public.protocol_external_calls
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  v_source public.protocol_attempts%rowtype;
  v_core record;
  v_calls record;
  v_reserve record;
  v_action_row public.protocol_operator_actions%rowtype;
  v_existing_action public.protocol_operator_actions%rowtype;
  v_fingerprint text;
begin
  if p_job_id is null or p_project_id is null
     or p_actor is null or btrim(p_actor) = ''
     or p_reason is null or btrim(p_reason) = ''
     or p_action is null or p_source_attempt_id is null
     or p_reserved_cost_usd is null or p_reserved_cost_usd < 0
     or p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception using
      errcode = '22023',
      message = 'invalid_authorize_operator_retry_args';
  end if;

  if p_action not in ('retry_full_attempt', 'retry_analysis_only') then
    raise exception using
      errcode = '22023',
      message = 'invalid_operator_retry_action';
  end if;

  if p_action = 'retry_full_attempt'
     and (p_perplexity_reserved_cost_usd is null or p_perplexity_reserved_cost_usd < 0) then
    raise exception using
      errcode = '22023',
      message = 'retry_full_attempt_requires_perplexity_reserved_cost_usd';
  end if;

  if p_action = 'retry_analysis_only' and p_source_external_call_id is null then
    raise exception using
      errcode = '22023',
      message = 'retry_analysis_only_requires_source_external_call_id';
  end if;

  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id
   for update;

  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::text, null::text,
      null::public.protocol_attempts, null::public.protocol_external_calls;
    return;
  end if;

  -- D-021 clarification (append-only, see docs/DECISIONS.md): the
  -- idempotent-replay lookup by (project_id, job_id, idempotency_key)
  -- happens BEFORE the needs_review gate, and is honored regardless of
  -- the job's current status. A decision, once recorded, must remain
  -- safely replayable even after its own side effect (moving the job
  -- out of needs_review) has already occurred -- otherwise a duplicate
  -- submission under network ambiguity would observe a different
  -- outcome than the original call, defeating the purpose of the
  -- caller-supplied key. Only a genuinely new key is gated on
  -- needs_review below.
  v_fingerprint := public._sha256_hex(
    jsonb_build_object(
      'job_id', p_job_id,
      'project_id', p_project_id,
      'action', p_action,
      'source_attempt_id', p_source_attempt_id,
      'source_external_call_id', p_source_external_call_id,
      'reserved_cost_usd', p_reserved_cost_usd,
      'perplexity_reserved_cost_usd', p_perplexity_reserved_cost_usd
    )::text
  );

  select * into v_existing_action
    from public.protocol_operator_actions
   where project_id = p_project_id and job_id = p_job_id and idempotency_key = p_idempotency_key;

  if found then
    if v_existing_action.request_fingerprint = v_fingerprint then
      return query select
        (case v_existing_action.outcome when 'approved' then 'APPROVED' else 'DENIED' end)::text,
        v_existing_action.outcome,
        v_existing_action.denial_code,
        (select pa from public.protocol_attempts pa where pa.id = v_existing_action.new_attempt_id),
        (select ec from public.protocol_external_calls ec where ec.id = v_existing_action.new_external_call_id);
      return;
    else
      return query select 'IDEMPOTENCY_KEY_CONFLICT'::text, null::text, null::text,
        null::public.protocol_attempts, null::public.protocol_external_calls;
      return;
    end if;
  end if;

  if v_job.status <> 'needs_review' then
    return query select 'JOB_NOT_IN_NEEDS_REVIEW'::text, null::text, null::text,
      null::public.protocol_attempts, null::public.protocol_external_calls;
    return;
  end if;

  select pa.* into v_source
    from public.protocol_attempts pa
   where pa.id = p_source_attempt_id and pa.project_id = p_project_id and pa.job_id = p_job_id;

  if not found then
    return query select 'SOURCE_ATTEMPT_NOT_OWNED_BY_JOB'::text, null::text, null::text,
      null::public.protocol_attempts, null::public.protocol_external_calls;
    return;
  end if;

  if p_action = 'retry_full_attempt' then
    select * into v_core
      from public._admit_and_reserve_attempt_core(
        v_job.protocol_id, p_project_id, v_source.attempt_kind,
        'operator-retry:' || p_idempotency_key,
        p_perplexity_reserved_cost_usd + p_reserved_cost_usd,
        p_source_attempt_id, p_job_id
      );

    if v_core.status <> 'RESERVED' then
      insert into public.protocol_operator_actions (
        project_id, job_id, actor, reason, action, outcome, denial_code,
        idempotency_key, request_fingerprint
      ) values (
        p_project_id, p_job_id, p_actor, p_reason, p_action, 'denied', v_core.status,
        p_idempotency_key, v_fingerprint
      )
      returning * into v_action_row;

      return query select 'DENIED'::text, 'denied'::text, v_core.status,
        null::public.protocol_attempts, null::public.protocol_external_calls;
      return;
    end if;

    select * into v_calls
      from public._create_attempt_external_calls_core(
        (v_core.attempt).id, p_project_id, p_perplexity_reserved_cost_usd, p_reserved_cost_usd
      );

    insert into public.protocol_operator_actions (
      project_id, job_id, actor, reason, action, outcome, denial_code,
      new_attempt_id, new_external_call_id, idempotency_key, request_fingerprint
    ) values (
      p_project_id, p_job_id, p_actor, p_reason, p_action, 'approved', null,
      (v_core.attempt).id, (v_calls.perplexity_call).id, p_idempotency_key, v_fingerprint
    )
    returning * into v_action_row;

    update public.protocol_execution_jobs
       set status = 'queued',
           needs_review_reason = null,
           current_attempt_id = (v_core.attempt).id,
           updated_at = now()
     where id = p_job_id;

    return query select 'APPROVED'::text, 'approved'::text, null::text,
      v_core.attempt, v_calls.perplexity_call;
    return;
  else
    if v_source.status <> 'in_progress' then
      return query select 'SOURCE_ATTEMPT_NOT_IN_PROGRESS'::text, null::text, null::text,
        null::public.protocol_attempts, null::public.protocol_external_calls;
      return;
    end if;

    if not exists (
      select 1 from public.protocol_external_calls ec
       where ec.id = p_source_external_call_id
         and ec.protocol_attempt_id = p_source_attempt_id
         and ec.project_id = p_project_id
         and ec.call_kind = 'analysis'
    ) then
      return query select 'SOURCE_EXTERNAL_CALL_NOT_OWNED_BY_ATTEMPT'::text, null::text, null::text,
        null::public.protocol_attempts, null::public.protocol_external_calls;
      return;
    end if;

    select * into v_reserve
      from public._reserve_additional_analysis_generation_core(
        p_source_attempt_id, p_project_id, p_reserved_cost_usd, p_source_external_call_id
      );

    if v_reserve.status <> 'RESERVED' then
      insert into public.protocol_operator_actions (
        project_id, job_id, actor, reason, action, outcome, denial_code,
        idempotency_key, request_fingerprint
      ) values (
        p_project_id, p_job_id, p_actor, p_reason, p_action, 'denied', v_reserve.status,
        p_idempotency_key, v_fingerprint
      )
      returning * into v_action_row;

      return query select 'DENIED'::text, 'denied'::text, v_reserve.status,
        null::public.protocol_attempts, null::public.protocol_external_calls;
      return;
    end if;

    insert into public.protocol_operator_actions (
      project_id, job_id, actor, reason, action, outcome, denial_code,
      new_attempt_id, new_external_call_id, idempotency_key, request_fingerprint
    ) values (
      p_project_id, p_job_id, p_actor, p_reason, p_action, 'approved', null,
      p_source_attempt_id, (v_reserve.external_call).id, p_idempotency_key, v_fingerprint
    )
    returning * into v_action_row;

    update public.protocol_execution_jobs
       set status = 'queued', needs_review_reason = null, updated_at = now()
     where id = p_job_id;

    return query select 'APPROVED'::text, 'approved'::text, null::text,
      v_source, v_reserve.external_call;
    return;
  end if;
end;
$$;

revoke all on function
  public.authorize_operator_retry(uuid, uuid, text, text, text, uuid, numeric, text, uuid, numeric) from public;
revoke all on function
  public.authorize_operator_retry(uuid, uuid, text, text, text, uuid, numeric, text, uuid, numeric) from anon;
revoke all on function
  public.authorize_operator_retry(uuid, uuid, text, text, text, uuid, numeric, text, uuid, numeric) from authenticated;
grant execute on function
  public.authorize_operator_retry(uuid, uuid, text, text, text, uuid, numeric, text, uuid, numeric) to service_role;

-- =======================================================================
-- 2. Full-attempt retry — un seul enfant direct par tentative source,
--    project/protocole-scopé structurellement. Automatique uniquement
--    quand Perplexity lui-même est la branche en échec net (avec reçu) ;
--    jamais quand seule l'analyse a échoué (voir section 3).
-- =======================================================================

do $$
declare
  v_dupe_count integer;
begin
  select count(*) into v_dupe_count from (
    select retry_of_attempt_id from public.protocol_attempts
     where retry_of_attempt_id is not null
     group by retry_of_attempt_id having count(*) > 1
  ) d;
  if v_dupe_count > 0 then
    raise exception 'D-021 preflight failed: % existing protocol_attempts.retry_of_attempt_id collisions', v_dupe_count;
  end if;
end $$;

do $$
declare
  v_bad_count integer;
begin
  select count(*) into v_bad_count
    from public.protocol_attempts child
    join public.protocol_attempts parent on parent.id = child.retry_of_attempt_id
   where child.retry_of_attempt_id is not null
     and (child.protocol_id <> parent.protocol_id or child.project_id <> parent.project_id);
  if v_bad_count > 0 then
    raise exception 'D-021 preflight failed: % existing protocol_attempts rows have a cross-protocol/cross-project retry_of_attempt_id link', v_bad_count;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_attempts_id_protocol_project_key'
  ) then
    alter table public.protocol_attempts
      add constraint protocol_attempts_id_protocol_project_key
      unique (id, protocol_id, project_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_attempts_retry_of_attempt_protocol_project_fk'
  ) then
    alter table public.protocol_attempts
      add constraint protocol_attempts_retry_of_attempt_protocol_project_fk
      foreign key (retry_of_attempt_id, protocol_id, project_id)
      references public.protocol_attempts (id, protocol_id, project_id);
  end if;
end $$;

create unique index if not exists protocol_attempts_retry_of_attempt_id_key
  on public.protocol_attempts (retry_of_attempt_id)
  where retry_of_attempt_id is not null;

-- Automatic, worker-callable, bounded full-attempt retry. Eligible only
-- when: this is the job's own current attempt; it is terminal but not
-- completed; Perplexity generation 1 itself is failed/timed_out/
-- cancelled WITH a receipt (the branch that actually failed net); no
-- external_call on this attempt is ambiguous (in_progress + sent, no
-- receipt at all). Replay-safe via retry_of_attempt_id: an existing
-- child with matching reserved costs is returned as ALREADY_RETRIED; a
-- mismatched-cost call against an already-retried source is refused as
-- SOURCE_ALREADY_RETRIED, zero mutation.
create or replace function
  public.retry_full_attempt_for_job(
    p_job_id uuid,
    p_claim_token uuid,
    p_project_id uuid,
    p_source_attempt_id uuid,
    p_perplexity_reserved_cost_usd numeric,
    p_analysis_reserved_cost_usd numeric
  )
returns table (
  status          text,
  attempt         public.protocol_attempts,
  perplexity_call public.protocol_external_calls,
  analysis_call   public.protocol_external_calls
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  v_source public.protocol_attempts%rowtype;
  v_perplexity public.protocol_external_calls%rowtype;
  v_ambiguous_count integer;
  v_existing_child public.protocol_attempts%rowtype;
  v_core record;
  v_calls record;
begin
  if p_job_id is null or p_claim_token is null or p_project_id is null
     or p_source_attempt_id is null
     or p_perplexity_reserved_cost_usd is null or p_perplexity_reserved_cost_usd < 0
     or p_analysis_reserved_cost_usd is null or p_analysis_reserved_cost_usd < 0 then
    raise exception using
      errcode = '22023',
      message = 'invalid_retry_full_attempt_for_job_args';
  end if;

  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id
   for update;

  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_attempts,
      null::public.protocol_external_calls, null::public.protocol_external_calls;
    return;
  end if;

  if v_job.claim_token is distinct from p_claim_token
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= now()
     or v_job.status not in ('claimed', 'running') then
    return query select 'JOB_NOT_OWNED'::text, null::public.protocol_attempts,
      null::public.protocol_external_calls, null::public.protocol_external_calls;
    return;
  end if;

  -- D-021 clarification (append-only, see docs/DECISIONS.md): the
  -- existing-child lookup by retry_of_attempt_id (an identifier that
  -- never changes once set) is checked BEFORE the current_attempt_id
  -- equality gate. A successful retry moves current_attempt_id to the
  -- new child attempt, so gating the replay check on that same pointer
  -- would make a genuinely idempotent replay of a request that already
  -- succeeded indistinguishable from a stale, out-of-date request --
  -- breaking the idempotent-replay guarantee this function exists to
  -- provide, including under true concurrency. Only when no child
  -- exists yet is current_attempt_id consulted, to gate the creation
  -- of a genuinely new retry.
  select pa.* into v_existing_child
    from public.protocol_attempts pa
   where pa.retry_of_attempt_id = p_source_attempt_id
     and pa.job_id = p_job_id and pa.project_id = p_project_id;

  if found then
    if v_existing_child.reserved_cost_usd = p_perplexity_reserved_cost_usd + p_analysis_reserved_cost_usd then
      return query select 'ALREADY_RETRIED'::text, v_existing_child,
        (select ec from public.protocol_external_calls ec
          where ec.protocol_attempt_id = v_existing_child.id and ec.call_kind = 'perplexity'),
        (select ec from public.protocol_external_calls ec
          where ec.protocol_attempt_id = v_existing_child.id and ec.call_kind = 'analysis');
      return;
    else
      return query select 'SOURCE_ALREADY_RETRIED'::text, v_existing_child,
        null::public.protocol_external_calls, null::public.protocol_external_calls;
      return;
    end if;
  end if;

  if v_job.current_attempt_id is distinct from p_source_attempt_id then
    return query select 'SOURCE_NOT_CURRENT_ATTEMPT'::text, null::public.protocol_attempts,
      null::public.protocol_external_calls, null::public.protocol_external_calls;
    return;
  end if;

  select pa.* into v_source
    from public.protocol_attempts pa
   where pa.id = p_source_attempt_id and pa.job_id = p_job_id and pa.project_id = p_project_id
   for update;

  if not found then
    return query select 'SOURCE_ATTEMPT_NOT_OWNED_BY_JOB'::text, null::public.protocol_attempts,
      null::public.protocol_external_calls, null::public.protocol_external_calls;
    return;
  end if;

  if v_source.terminalized_at is null or v_source.status not in ('failed', 'timed_out', 'cancelled') then
    return query select 'SOURCE_NOT_ELIGIBLE'::text, v_source,
      null::public.protocol_external_calls, null::public.protocol_external_calls;
    return;
  end if;

  select count(*) into v_ambiguous_count
    from public.protocol_external_calls ec
   where ec.protocol_attempt_id = v_source.id
     and ec.status = 'in_progress' and ec.request_sent_at is not null
     and not exists (select 1 from public.provider_call_receipts r where r.external_call_id = ec.id)
     and not exists (select 1 from public.analysis_call_receipts r where r.external_call_id = ec.id);

  if v_ambiguous_count > 0 then
    return query select 'AMBIGUOUS_CALL_PRESENT'::text, v_source,
      null::public.protocol_external_calls, null::public.protocol_external_calls;
    return;
  end if;

  select ec.* into v_perplexity
    from public.protocol_external_calls ec
   where ec.protocol_attempt_id = v_source.id and ec.call_kind = 'perplexity' and ec.generation = 1;

  if not found
     or v_perplexity.status not in ('failed', 'timed_out', 'cancelled')
     or not exists (select 1 from public.provider_call_receipts r where r.external_call_id = v_perplexity.id) then
    return query select 'PERPLEXITY_NOT_ELIGIBLE_FOR_FULL_RETRY'::text, v_source,
      null::public.protocol_external_calls, null::public.protocol_external_calls;
    return;
  end if;

  select * into v_core
    from public._admit_and_reserve_attempt_core(
      v_job.protocol_id, p_project_id, v_source.attempt_kind,
      'retry-of-attempt:' || p_source_attempt_id::text,
      p_perplexity_reserved_cost_usd + p_analysis_reserved_cost_usd,
      p_source_attempt_id, p_job_id
    );

  if v_core.status <> 'RESERVED' then
    return query select v_core.status, v_core.attempt,
      null::public.protocol_external_calls, null::public.protocol_external_calls;
    return;
  end if;

  select * into v_calls
    from public._create_attempt_external_calls_core(
      (v_core.attempt).id, p_project_id, p_perplexity_reserved_cost_usd, p_analysis_reserved_cost_usd
    );

  update public.protocol_execution_jobs
     set current_attempt_id = (v_core.attempt).id, updated_at = now()
   where id = p_job_id;

  return query select 'RESERVED'::text, v_core.attempt, v_calls.perplexity_call, v_calls.analysis_call;
end;
$$;

revoke all on function
  public.retry_full_attempt_for_job(uuid, uuid, uuid, uuid, numeric, numeric) from public;
revoke all on function
  public.retry_full_attempt_for_job(uuid, uuid, uuid, uuid, numeric, numeric) from anon;
revoke all on function
  public.retry_full_attempt_for_job(uuid, uuid, uuid, uuid, numeric, numeric) from authenticated;
grant execute on function
  public.retry_full_attempt_for_job(uuid, uuid, uuid, uuid, numeric, numeric) to service_role;

-- =======================================================================
-- 3. Analysis-only retry — un seul enfant direct par génération source,
--    project/attempt-scopée structurellement. Automatique uniquement
--    quand Perplexity est completed+reçu et que la génération analysis
--    la plus récente (autoritaire) est en échec net avec reçu.
-- =======================================================================

alter table public.protocol_external_calls add column if not exists retry_of_external_call_id uuid null;

do $$
declare
  v_bad_count integer;
begin
  -- Trivialement 0 : la colonne vient d'être ajoutée sans données.
  -- Conservé pour la symétrie/discipline avec les autres préflights.
  select count(*) into v_bad_count
    from public.protocol_external_calls
   where retry_of_external_call_id is not null;
  if v_bad_count > 0 then
    raise exception 'D-021 preflight failed: % existing protocol_external_calls rows already have retry_of_external_call_id set', v_bad_count;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_external_calls_id_attempt_project_key'
  ) then
    alter table public.protocol_external_calls
      add constraint protocol_external_calls_id_attempt_project_key
      unique (id, protocol_attempt_id, project_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_external_calls_retry_of_call_attempt_project_fk'
  ) then
    alter table public.protocol_external_calls
      add constraint protocol_external_calls_retry_of_call_attempt_project_fk
      foreign key (retry_of_external_call_id, protocol_attempt_id, project_id)
      references public.protocol_external_calls (id, protocol_attempt_id, project_id);
  end if;
end $$;

create unique index if not exists protocol_external_calls_retry_of_external_call_id_key
  on public.protocol_external_calls (retry_of_external_call_id)
  where retry_of_external_call_id is not null;

-- Automatic, worker-callable, bounded analysis-only retry. Eligible
-- only when: the source external_call belongs to the job's own current
-- attempt; Perplexity generation 1 of that attempt is completed with a
-- receipt (otherwise retry_full_attempt_for_job is the correct RPC, not
-- this one); the source is exactly the maximum (authoritative)
-- analysis generation, never an older one; it is failed/timed_out/
-- cancelled with a receipt; no external_call on the attempt is
-- ambiguous. Replay-safe via retry_of_external_call_id: an existing
-- child with a matching reserved cost is ALREADY_RETRIED; a mismatched
-- call is SOURCE_ALREADY_RETRIED, zero mutation.
create or replace function
  public.retry_analysis_generation_for_job(
    p_job_id uuid,
    p_claim_token uuid,
    p_project_id uuid,
    p_source_external_call_id uuid,
    p_reserved_cost_usd numeric
  )
returns table (
  status        text,
  external_call public.protocol_external_calls
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  v_source public.protocol_external_calls%rowtype;
  v_attempt public.protocol_attempts%rowtype;
  v_perplexity public.protocol_external_calls%rowtype;
  v_max_generation integer;
  v_ambiguous_count integer;
  v_existing_child public.protocol_external_calls%rowtype;
begin
  if p_job_id is null or p_claim_token is null or p_project_id is null
     or p_source_external_call_id is null
     or p_reserved_cost_usd is null or p_reserved_cost_usd < 0 then
    raise exception using
      errcode = '22023',
      message = 'invalid_retry_analysis_generation_for_job_args';
  end if;

  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id
   for update;

  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_external_calls;
    return;
  end if;

  if v_job.claim_token is distinct from p_claim_token
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= now()
     or v_job.status not in ('claimed', 'running') then
    return query select 'JOB_NOT_OWNED'::text, null::public.protocol_external_calls;
    return;
  end if;

  if v_job.current_attempt_id is null then
    return query select 'NO_CURRENT_ATTEMPT'::text, null::public.protocol_external_calls;
    return;
  end if;

  select ec.* into v_source
    from public.protocol_external_calls ec
   where ec.id = p_source_external_call_id and ec.project_id = p_project_id
   for update;

  if not found or v_source.protocol_attempt_id is distinct from v_job.current_attempt_id
     or v_source.call_kind <> 'analysis' then
    return query select 'SOURCE_NOT_CURRENT_ATTEMPT'::text, null::public.protocol_external_calls;
    return;
  end if;

  select pa.* into v_attempt
    from public.protocol_attempts pa
   where pa.id = v_job.current_attempt_id and pa.job_id = p_job_id and pa.project_id = p_project_id
   for update;

  -- Defensive guard: protocol_execution_jobs_current_attempt_fk already
  -- guarantees this row exists whenever current_attempt_id is non-null
  -- -- kept anyway, matching the same defensive precedent D-020 set for
  -- complete_protocol_execution_job's CURRENT_ATTEMPT_NOT_FOUND.
  if not found then
    return query select 'CURRENT_ATTEMPT_NOT_FOUND'::text, null::public.protocol_external_calls;
    return;
  end if;

  select ec.* into v_existing_child
    from public.protocol_external_calls ec
   where ec.retry_of_external_call_id = p_source_external_call_id
     and ec.protocol_attempt_id = v_attempt.id and ec.project_id = p_project_id;

  if found then
    if v_existing_child.reserved_cost_usd = p_reserved_cost_usd then
      return query select 'ALREADY_RETRIED'::text, v_existing_child;
      return;
    else
      return query select 'SOURCE_ALREADY_RETRIED'::text, v_existing_child;
      return;
    end if;
  end if;

  select ec.* into v_perplexity
    from public.protocol_external_calls ec
   where ec.protocol_attempt_id = v_attempt.id and ec.call_kind = 'perplexity' and ec.generation = 1;

  if not found or v_perplexity.status <> 'completed'
     or not exists (select 1 from public.provider_call_receipts r where r.external_call_id = v_perplexity.id) then
    return query select 'PERPLEXITY_NOT_COMPLETED'::text, null::public.protocol_external_calls;
    return;
  end if;

  select max(generation) into v_max_generation
    from public.protocol_external_calls
   where protocol_attempt_id = v_attempt.id and call_kind = 'analysis';

  if v_source.generation <> v_max_generation then
    return query select 'SOURCE_NOT_AUTHORITATIVE_GENERATION'::text, null::public.protocol_external_calls;
    return;
  end if;

  if v_source.status not in ('failed', 'timed_out', 'cancelled')
     or not exists (select 1 from public.analysis_call_receipts r where r.external_call_id = v_source.id) then
    return query select 'SOURCE_NOT_ELIGIBLE'::text, v_source;
    return;
  end if;

  select count(*) into v_ambiguous_count
    from public.protocol_external_calls ec
   where ec.protocol_attempt_id = v_attempt.id
     and ec.status = 'in_progress' and ec.request_sent_at is not null
     and not exists (select 1 from public.provider_call_receipts r where r.external_call_id = ec.id)
     and not exists (select 1 from public.analysis_call_receipts r where r.external_call_id = ec.id);

  if v_ambiguous_count > 0 then
    return query select 'AMBIGUOUS_CALL_PRESENT'::text, v_source;
    return;
  end if;

  return query
    select core.status, core.external_call
      from public._reserve_additional_analysis_generation_core(
        v_attempt.id, p_project_id, p_reserved_cost_usd, p_source_external_call_id
      ) as core;
end;
$$;

revoke all on function
  public.retry_analysis_generation_for_job(uuid, uuid, uuid, uuid, numeric) from public;
revoke all on function
  public.retry_analysis_generation_for_job(uuid, uuid, uuid, uuid, numeric) from anon;
revoke all on function
  public.retry_analysis_generation_for_job(uuid, uuid, uuid, uuid, numeric) from authenticated;
grant execute on function
  public.retry_analysis_generation_for_job(uuid, uuid, uuid, uuid, numeric) to service_role;

-- D-021: reserve_additional_analysis_generation_for_job (0050) called
-- _reserve_additional_analysis_generation_core directly, with no source
-- tracking and no idempotency of any kind -- a real bypass around every
-- protection this migration adds, since a worker could call it instead
-- of retry_analysis_generation_for_job and create an ungoverned,
-- unbounded-by-source-tracking generation. Nothing in the D-021 design
-- has a legitimate remaining use for it: authorize_operator_retry's
-- retry_analysis_only branch and the new retry_analysis_generation_
-- for_job both call the private core directly. Rather than retrofit it
-- into a second, inferior copy of retry_analysis_generation_for_job, its
-- EXECUTE grant to service_role is revoked outright -- it was never
-- applied to any remote environment, so there is no existing caller to
-- protect and no cutover window is needed, unlike the M4 raw RPCs.
revoke execute on function
  public.reserve_additional_analysis_generation_for_job(uuid, uuid, uuid, uuid, numeric) from service_role;

-- =======================================================================
-- 4. admit_and_reserve_attempt_for_job — reprise sans double admission.
--    current_attempt_id IS NULL est désormais le SEUL cas où cette RPC
--    crée quoi que ce soit ; sinon elle retourne RESUME_CURRENT_ATTEMPT
--    avec le contexte existant complet, jamais une nouvelle réservation.
--    Corps intégral repris de 0050, avec la garde insérée juste après le
--    fencing, avant tout appel au coeur d'admission.
-- =======================================================================

create or replace function
  public.admit_and_reserve_attempt_for_job(
    p_job_id uuid,
    p_claim_token uuid,
    p_project_id uuid,
    p_attempt_kind text,
    p_idempotency_key text,
    p_perplexity_reserved_cost_usd numeric,
    p_analysis_reserved_cost_usd numeric,
    p_retry_of_attempt_id uuid default null
  )
returns table (
  status          text,
  attempt         public.protocol_attempts,
  perplexity_call public.protocol_external_calls,
  analysis_call   public.protocol_external_calls
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  v_core record;
  v_calls record;
  v_resume_attempt public.protocol_attempts%rowtype;
  v_resume_perplexity public.protocol_external_calls%rowtype;
  v_resume_analysis public.protocol_external_calls%rowtype;
begin
  if p_job_id is null or p_claim_token is null or p_project_id is null
     or p_attempt_kind is null or p_idempotency_key is null
     or p_perplexity_reserved_cost_usd is null or p_perplexity_reserved_cost_usd < 0
     or p_analysis_reserved_cost_usd is null or p_analysis_reserved_cost_usd < 0 then
    raise exception using
      errcode = '22023',
      message = 'invalid_admit_and_reserve_attempt_for_job_args';
  end if;

  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id
   for update;

  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_attempts,
      null::public.protocol_external_calls, null::public.protocol_external_calls;
    return;
  end if;

  if v_job.claim_token is distinct from p_claim_token
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= now()
     or v_job.status not in ('claimed', 'running') then
    return query select 'JOB_NOT_OWNED'::text, null::public.protocol_attempts,
      null::public.protocol_external_calls, null::public.protocol_external_calls;
    return;
  end if;

  -- D-021: current_attempt_id déjà posé -- ne créer JAMAIS une seconde
  -- tentative ; retourner le contexte existant pour une reprise sans
  -- nouvelle admission, quel que soit le statut de cette tentative.
  if v_job.current_attempt_id is not null then
    select pa.* into v_resume_attempt
      from public.protocol_attempts pa
     where pa.id = v_job.current_attempt_id and pa.job_id = p_job_id and pa.project_id = p_project_id;

    -- Defensive guard: protocol_execution_jobs_current_attempt_fk
    -- already guarantees this row exists -- kept for the same reason
    -- D-020 kept CURRENT_ATTEMPT_NOT_FOUND in complete_protocol_
    -- execution_job despite the identical FK guarantee there.
    if not found then
      return query select 'CURRENT_ATTEMPT_NOT_FOUND'::text, null::public.protocol_attempts,
        null::public.protocol_external_calls, null::public.protocol_external_calls;
      return;
    end if;

    select ec.* into v_resume_perplexity
      from public.protocol_external_calls ec
     where ec.protocol_attempt_id = v_resume_attempt.id and ec.call_kind = 'perplexity' and ec.generation = 1;

    select ec.* into v_resume_analysis
      from public.protocol_external_calls ec
     where ec.protocol_attempt_id = v_resume_attempt.id and ec.call_kind = 'analysis'
     order by ec.generation desc
     limit 1;

    return query select 'RESUME_CURRENT_ATTEMPT'::text, v_resume_attempt, v_resume_perplexity, v_resume_analysis;
    return;
  end if;

  select * into v_core
    from public._admit_and_reserve_attempt_core(
      v_job.protocol_id, p_project_id, p_attempt_kind, p_idempotency_key,
      p_perplexity_reserved_cost_usd + p_analysis_reserved_cost_usd,
      p_retry_of_attempt_id, p_job_id
    );

  if v_core.status <> 'RESERVED' then
    return query select v_core.status, v_core.attempt,
      null::public.protocol_external_calls, null::public.protocol_external_calls;
    return;
  end if;

  select * into v_calls
    from public._create_attempt_external_calls_core(
      (v_core.attempt).id, p_project_id,
      p_perplexity_reserved_cost_usd, p_analysis_reserved_cost_usd
    );

  update public.protocol_execution_jobs j
     set status = 'running',
         current_attempt_id = (v_core.attempt).id,
         updated_at = now()
   where j.id = p_job_id;

  return query select 'RESERVED'::text, v_core.attempt, v_calls.perplexity_call, v_calls.analysis_call;
end;
$$;

-- Signature/ACL inchangées de 0050 -- les REVOKE/GRANT ne sont pas
-- répétés ici (CREATE OR REPLACE ne les affecte pas).

-- =======================================================================
-- 5. probe_run — création + rattachement atomiques et rejouables.
--    protocol_attempts.probe_run_id (0047) est déjà le marqueur
--    d'idempotence nécessaire ; il ne manquait qu'une FK composite
--    project-scoped et une RPC qui combine les deux écritures.
-- =======================================================================

do $$
declare
  v_bad_count integer;
begin
  select count(*) into v_bad_count
    from public.protocol_attempts pa
    join public.probe_runs pr on pr.id = pa.probe_run_id
   where pa.probe_run_id is not null and pr.project_id <> pa.project_id;
  if v_bad_count > 0 then
    raise exception 'D-021 preflight failed: % existing protocol_attempts rows have a cross-project probe_run_id link', v_bad_count;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_attempts_probe_run_project_fk'
  ) then
    alter table public.protocol_attempts
      add constraint protocol_attempts_probe_run_project_fk
      foreign key (probe_run_id, project_id)
      references public.probe_runs (id, project_id);
  end if;
end $$;

create or replace function
  public.create_probe_run_and_start_attempt_for_job(
    p_job_id uuid,
    p_claim_token uuid,
    p_project_id uuid,
    p_attempt_id uuid,
    p_platform text,
    p_probe_mode text,
    p_dataset_id uuid,
    p_dataset_source_type text
  )
returns table (
  status    text,
  attempt   public.protocol_attempts,
  probe_run public.probe_runs
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  v_attempt public.protocol_attempts%rowtype;
  v_run public.probe_runs%rowtype;
begin
  if p_job_id is null or p_claim_token is null or p_project_id is null
     or p_attempt_id is null or p_platform is null or p_probe_mode is null
     or p_dataset_id is null or p_dataset_source_type is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_create_probe_run_and_start_attempt_for_job_args';
  end if;

  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id
   for update;

  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_attempts, null::public.probe_runs;
    return;
  end if;

  if v_job.claim_token is distinct from p_claim_token
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= now()
     or v_job.status not in ('claimed', 'running') then
    return query select 'JOB_NOT_OWNED'::text, null::public.protocol_attempts, null::public.probe_runs;
    return;
  end if;

  select pa.* into v_attempt
    from public.protocol_attempts pa
   where pa.id = p_attempt_id and pa.job_id = p_job_id and pa.project_id = p_project_id
   for update;

  if not found then
    return query select 'CONFLICT'::text, null::public.protocol_attempts, null::public.probe_runs;
    return;
  end if;

  if v_attempt.status = 'in_progress' then
    if v_attempt.probe_run_id is null then
      return query select 'CONFLICT'::text, v_attempt, null::public.probe_runs;
      return;
    end if;

    select pr.* into v_run
      from public.probe_runs pr
     where pr.id = v_attempt.probe_run_id and pr.project_id = p_project_id;

    if not found then
      return query select 'CONFLICT'::text, v_attempt, null::public.probe_runs;
      return;
    end if;

    return query select 'ALREADY_STARTED'::text, v_attempt, v_run;
    return;
  end if;

  if v_attempt.status <> 'reserved' then
    return query select 'ATTEMPT_TERMINAL'::text, v_attempt, null::public.probe_runs;
    return;
  end if;

  insert into public.probe_runs (project_id, platform, status, probe_mode, dataset_id, dataset_source_type)
  values (p_project_id, p_platform, 'pending', p_probe_mode, p_dataset_id, p_dataset_source_type)
  returning * into v_run;

  -- Aliased and every WHERE reference qualified: this function's own
  -- `status` OUT column would otherwise make a bare `status = 'reserved'`
  -- read here ambiguous (Postgres 42702) -- the exact bug class fixed by
  -- migration 0049 for approve_protocol/start_attempt.
  update public.protocol_attempts pa
     set status = 'in_progress',
         probe_run_id = v_run.id,
         last_activity_at = now()
   where pa.id = p_attempt_id and pa.project_id = p_project_id and pa.status = 'reserved'
  returning * into v_attempt;

  return query select 'STARTED'::text, v_attempt, v_run;
end;
$$;

revoke all on function
  public.create_probe_run_and_start_attempt_for_job(uuid, uuid, uuid, uuid, text, text, uuid, text) from public;
revoke all on function
  public.create_probe_run_and_start_attempt_for_job(uuid, uuid, uuid, uuid, text, text, uuid, text) from anon;
revoke all on function
  public.create_probe_run_and_start_attempt_for_job(uuid, uuid, uuid, uuid, text, text, uuid, text) from authenticated;
grant execute on function
  public.create_probe_run_and_start_attempt_for_job(uuid, uuid, uuid, uuid, text, text, uuid, text) to service_role;

-- =======================================================================
-- 6. Contexte de reprise — lecture agrégée, fencée, snapshot cohérent
--    (une seule fonction, un seul instant), jamais plusieurs SELECT
--    typés indépendants dont la composition pourrait être incohérente.
--    Read-only : pas de FOR UPDATE, STABLE plutôt que VOLATILE.
-- =======================================================================

create or replace function
  public.get_protocol_execution_job_context(
    p_job_id uuid,
    p_claim_token uuid,
    p_project_id uuid
  )
returns table (
  status            text,
  job               public.protocol_execution_jobs,
  protocol          public.protocols,
  current_attempt   public.protocol_attempts,
  external_calls    public.protocol_external_calls[],
  provider_receipts public.provider_call_receipts[],
  analysis_receipts public.analysis_call_receipts[],
  probe_run         public.probe_runs
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  v_protocol public.protocols%rowtype;
  v_attempt public.protocol_attempts%rowtype;
  v_run public.probe_runs%rowtype;
begin
  if p_job_id is null or p_claim_token is null or p_project_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_get_protocol_execution_job_context_args';
  end if;

  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id;

  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_execution_jobs,
      null::public.protocols, null::public.protocol_attempts,
      null::public.protocol_external_calls[], null::public.provider_call_receipts[],
      null::public.analysis_call_receipts[], null::public.probe_runs;
    return;
  end if;

  if v_job.claim_token is distinct from p_claim_token
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= now()
     or v_job.status not in ('claimed', 'running') then
    return query select 'JOB_NOT_OWNED'::text, v_job,
      null::public.protocols, null::public.protocol_attempts,
      null::public.protocol_external_calls[], null::public.provider_call_receipts[],
      null::public.analysis_call_receipts[], null::public.probe_runs;
    return;
  end if;

  select p.* into v_protocol
    from public.protocols p
   where p.id = v_job.protocol_id and p.project_id = p_project_id;

  if v_job.current_attempt_id is not null then
    select pa.* into v_attempt
      from public.protocol_attempts pa
     where pa.id = v_job.current_attempt_id and pa.job_id = p_job_id and pa.project_id = p_project_id;

    if v_attempt.probe_run_id is not null then
      select pr.* into v_run
        from public.probe_runs pr
       where pr.id = v_attempt.probe_run_id and pr.project_id = p_project_id;
    end if;
  end if;

  return query select
    'OK'::text,
    v_job,
    v_protocol,
    v_attempt,
    (select coalesce(array_agg(ec.* order by ec.call_kind, ec.generation), array[]::public.protocol_external_calls[])
       from public.protocol_external_calls ec
      where v_attempt.id is not null and ec.protocol_attempt_id = v_attempt.id),
    (select coalesce(array_agg(r.*), array[]::public.provider_call_receipts[])
       from public.provider_call_receipts r
       join public.protocol_external_calls ec on ec.id = r.external_call_id
      where v_attempt.id is not null and ec.protocol_attempt_id = v_attempt.id),
    (select coalesce(array_agg(r.*), array[]::public.analysis_call_receipts[])
       from public.analysis_call_receipts r
       join public.protocol_external_calls ec on ec.id = r.external_call_id
      where v_attempt.id is not null and ec.protocol_attempt_id = v_attempt.id),
    v_run;
end;
$$;

revoke all on function
  public.get_protocol_execution_job_context(uuid, uuid, uuid) from public;
revoke all on function
  public.get_protocol_execution_job_context(uuid, uuid, uuid) from anon;
revoke all on function
  public.get_protocol_execution_job_context(uuid, uuid, uuid) from authenticated;
grant execute on function
  public.get_protocol_execution_job_context(uuid, uuid, uuid) to service_role;

-- =======================================================================
-- 7. Ambiguïté -> needs_review — seul mécanisme structurel. Aucune RPC
--    existante ne couvre le cas "reclaim voit in_progress + request_
--    sent_at + aucun receipt" : les deux RPC de reçu exigent qu'un
--    receipt existe déjà (provider_outcome_unknown) ; fail_protocol_
--    execution_job ne peut produire que 'failed' ; claim_protocol_
--    execution_job n'inspecte jamais protocol_external_calls.
-- =======================================================================

create or replace function
  public.mark_protocol_execution_job_needs_review_for_ambiguity(
    p_job_id uuid,
    p_claim_token uuid,
    p_project_id uuid
  )
returns table (
  status text,
  job    public.protocol_execution_jobs
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  v_ambiguous_count integer;
begin
  if p_job_id is null or p_claim_token is null or p_project_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_mark_protocol_execution_job_needs_review_for_ambiguity_args';
  end if;

  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id
   for update;

  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_execution_jobs;
    return;
  end if;

  -- Vérifié avant le fencing, comme ALREADY_SUCCEEDED dans D-020 : un
  -- job déjà needs_review n'a plus de propriétaire actif à valider, et
  -- ce rejeu doit rester idempotent plutôt que de tomber sur JOB_NOT_OWNED.
  if v_job.status = 'needs_review' then
    return query select 'ALREADY_NEEDS_REVIEW'::text, v_job;
    return;
  end if;

  if v_job.claim_token is distinct from p_claim_token
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= now()
     or v_job.status not in ('claimed', 'running') then
    return query select 'JOB_NOT_OWNED'::text, v_job;
    return;
  end if;

  if v_job.current_attempt_id is null then
    return query select 'NO_AMBIGUOUS_CALL'::text, v_job;
    return;
  end if;

  select count(*) into v_ambiguous_count
    from public.protocol_external_calls ec
   where ec.protocol_attempt_id = v_job.current_attempt_id
     and ec.status = 'in_progress' and ec.request_sent_at is not null
     and not exists (select 1 from public.provider_call_receipts r where r.external_call_id = ec.id)
     and not exists (select 1 from public.analysis_call_receipts r where r.external_call_id = ec.id);

  if v_ambiguous_count = 0 then
    return query select 'NO_AMBIGUOUS_CALL'::text, v_job;
    return;
  end if;

  update public.protocol_execution_jobs
     set status = 'needs_review',
         needs_review_reason = 'ambiguous_external_call_sent_without_receipt',
         updated_at = now()
   where id = p_job_id and project_id = p_project_id
  returning * into v_job;

  return query select 'NEEDS_REVIEW'::text, v_job;
end;
$$;

revoke all on function
  public.mark_protocol_execution_job_needs_review_for_ambiguity(uuid, uuid, uuid) from public;
revoke all on function
  public.mark_protocol_execution_job_needs_review_for_ambiguity(uuid, uuid, uuid) from anon;
revoke all on function
  public.mark_protocol_execution_job_needs_review_for_ambiguity(uuid, uuid, uuid) from authenticated;
grant execute on function
  public.mark_protocol_execution_job_needs_review_for_ambiguity(uuid, uuid, uuid) to service_role;

-- =======================================================================
-- 8. Monitoring interne minimal — métriques brutes uniquement, aucun
--    seuil. security_invoker garantit que les droits du rôle appelant
--    (service_role) sont évalués directement, jamais hérités
--    silencieusement du propriétaire de la vue.
-- =======================================================================

create or replace view public.protocol_execution_job_monitoring_v1
with (security_invoker = true) as
select
  (select count(*) from public.protocol_execution_jobs where status = 'queued') as jobs_queued,
  (select extract(epoch from (now() - min(created_at)))::bigint
     from public.protocol_execution_jobs where status = 'queued') as oldest_queued_job_age_seconds,
  (select count(*) from public.protocol_execution_jobs where status in ('claimed', 'running')) as jobs_claimed_or_running,
  (select count(*) from public.protocol_execution_jobs
    where status in ('claimed', 'running') and lease_expires_at < now()) as leases_expired,
  (select count(*) from public.protocol_execution_jobs where status = 'needs_review') as jobs_needs_review,
  (select count(*) from public.protocol_execution_jobs where status = 'failed') as jobs_failed,
  (select count(*) from public.protocol_execution_jobs where status = 'abandoned_exhausted') as jobs_abandoned_exhausted,
  (select count(*) from public.protocol_execution_jobs where status = 'succeeded') as jobs_succeeded,
  (select avg(attempt_count) from public.protocol_execution_jobs) as avg_attempts_per_job,
  (select count(*) from public.protocol_external_calls where call_kind = 'perplexity' and status = 'reserved') as perplexity_calls_reserved,
  (select count(*) from public.protocol_external_calls where call_kind = 'perplexity' and status = 'in_progress') as perplexity_calls_in_progress,
  (select count(*) from public.protocol_external_calls where call_kind = 'perplexity' and status = 'completed') as perplexity_calls_completed,
  (select count(*) from public.protocol_external_calls where call_kind = 'perplexity' and status in ('failed', 'timed_out', 'cancelled')) as perplexity_calls_failed,
  (select count(*) from public.protocol_external_calls where call_kind = 'analysis' and status = 'reserved') as analysis_calls_reserved,
  (select count(*) from public.protocol_external_calls where call_kind = 'analysis' and status = 'in_progress') as analysis_calls_in_progress,
  (select count(*) from public.protocol_external_calls where call_kind = 'analysis' and status = 'completed') as analysis_calls_completed,
  (select count(*) from public.protocol_external_calls where call_kind = 'analysis' and status in ('failed', 'timed_out', 'cancelled')) as analysis_calls_failed,
  (select count(*) from public.protocol_external_calls ec
    where ec.status = 'in_progress' and ec.request_sent_at is not null
      and not exists (select 1 from public.provider_call_receipts r where r.external_call_id = ec.id)
      and not exists (select 1 from public.analysis_call_receipts r where r.external_call_id = ec.id)
  ) as external_calls_sent_without_receipt,
  (select coalesce(sum(reserved_cost_usd), 0) from public.protocol_external_calls) as reserved_cost_usd_total,
  (select coalesce(sum(actual_cost_usd), 0) from public.protocol_external_calls where actual_cost_usd is not null and cost_basis = 'estimated') as estimated_cost_usd_total,
  (select coalesce(sum(actual_cost_usd), 0) from public.protocol_external_calls where actual_cost_usd is not null and cost_basis = 'measured') as measured_cost_usd_total,
  (select count(*) from public.protocol_external_calls
    where actual_cost_usd is null and status in ('completed', 'failed', 'timed_out', 'cancelled')
  ) as terminal_calls_with_unknown_cost,
  (select avg(latency_ms) from public.provider_call_receipts) as provider_latency_ms_avg,
  (select avg(latency_ms) from public.analysis_call_receipts) as analysis_latency_ms_avg;

revoke all on public.protocol_execution_job_monitoring_v1 from public, anon, authenticated, service_role;
grant select on public.protocol_execution_job_monitoring_v1 to service_role;
