-- M5 — D-027: durable analysis parse-failure ledger and request-body
-- durability for analysis_call_receipts. DRAFT migration. Additive only
-- with respect to 0050/0051/0052 (all left byte-identical by this
-- file). Not applied to any database by this commit.
--
-- Ce que cette migration fait :
--   * protocol_external_calls gagne parse_failed_at timestamptz null et
--     parse_failure_code text null — un marqueur durable, distinct du
--     statut du reçu, pour le cas où le provider a bien répondu
--     (receipt outcome='success') mais où le contenu reçu a échoué un
--     parsing/validation JSON/Zod local. Jamais confondu avec un échec
--     provider (outcome='provider_error'/'provider_outcome_unknown') :
--     ce marqueur ne s'applique qu'à une génération dont le reçu est
--     déjà un succès.
--   * analysis_call_receipts gagne raw_request_body text null, apparié
--     à request_sha256 (colonne existante depuis 0050) par un pairing
--     réel et un hash serveur réel — le pendant, côté requête, de
--     raw_content (0052). Une politique mock/réel stricte est ajoutée :
--     used_mock=true exige les deux colonnes null (rien à durabiliser
--     pour un appel simulé) ; used_mock=false exige les deux non-null
--     (un appel réel doit toujours porter sa requête exacte).
--   * record_analysis_call_receipt_for_job (0050, 15 args depuis 0052)
--     est redéfinie avec un seizième paramètre à défaut nullable
--     (p_raw_request_body) — l'ancienne signature 15-arg est supprimée
--     (DROP, sans CASCADE) puis recréée, exactement la technique déjà
--     utilisée par 0052 pour cette même fonction.
--   * mark_analysis_parse_failed_for_job (nouvelle RPC, 5 arguments)
--     marque durablement une génération analysis dont le reçu est un
--     succès mais dont le contenu a échoué un parsing local — jamais un
--     changement de statut de job, jamais une politique de réparation
--     automatique.
--   * retry_analysis_generation_for_job (0051) est étendue : sa branche
--     d'éligibilité accepte désormais, en plus de la branche historique
--     failed/timed_out/cancelled, une source completed dont la
--     génération a été marquée en échec de parsing — jamais une
--     nouvelle politique de déclenchement, seulement une éligibilité
--     SQL supplémentaire. retry_cap, spend_cap_usd, la déduplication et
--     _reserve_additional_analysis_generation_core restent inchangés.
--   * protocol_execution_job_monitoring_v1 gagne un unique compteur
--     scalaire, analysis_parse_failures_total.
--
-- Ce que cette migration NE fait PAS :
--   * Ne modifie pas 0050, 0051 ni 0052.
--   * Ne crée aucune migration 0054.
--   * Ne décide d'aucune politique de réparation automatique : cette
--     migration rend seulement une source éligible ; le futur worker
--     M5 décidera séparément s'il appelle retry_analysis_generation_for_job.
--   * Ne touche à aucun fichier call-model.ts, parser, probe-analysis,
--     Perplexity, worker ou CLI.
--   * Ne référence aucun 5×3/$2 legacy ni verdict won/partial/lost.
--   * Ne s'applique à, ni ne se connecte à, aucune base staging ou
--     Production — ce fichier est créé localement uniquement.

-- =======================================================================
-- 1. protocol_external_calls.parse_failed_at / parse_failure_code —
--    marqueur durable de parse failure, préflighté, borné, scopé.
-- =======================================================================

alter table public.protocol_external_calls
  add column if not exists parse_failed_at timestamptz null,
  add column if not exists parse_failure_code text null;

do $$
declare
  v_bad_count integer;
begin
  select count(*) into v_bad_count
    from public.protocol_external_calls
   where (parse_failed_at is null) <> (parse_failure_code is null);

  if v_bad_count > 0 then
    raise exception 'D-027 preflight failed: % protocol_external_calls rows have parse_failed_at/parse_failure_code out of pairing', v_bad_count;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_external_calls_parse_failure_pairing_check'
  ) then
    alter table public.protocol_external_calls
      add constraint protocol_external_calls_parse_failure_pairing_check
      check ((parse_failed_at is null) = (parse_failure_code is null));
  end if;
end $$;

do $$
declare
  v_bad_count integer;
begin
  select count(*) into v_bad_count
    from public.protocol_external_calls
   where parse_failure_code is not null
     and parse_failure_code not in ('invalid_json', 'schema_validation_failed', 'normalization_failed');

  if v_bad_count > 0 then
    raise exception 'D-027 preflight failed: % protocol_external_calls rows have an unrecognized parse_failure_code', v_bad_count;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_external_calls_parse_failure_code_check'
  ) then
    alter table public.protocol_external_calls
      add constraint protocol_external_calls_parse_failure_code_check
      check (parse_failure_code is null or parse_failure_code in ('invalid_json', 'schema_validation_failed', 'normalization_failed'));
  end if;
end $$;

do $$
declare
  v_bad_count integer;
begin
  select count(*) into v_bad_count
    from public.protocol_external_calls
   where parse_failed_at is not null
     and not (call_kind = 'analysis' and status = 'completed');

  if v_bad_count > 0 then
    raise exception 'D-027 preflight failed: % protocol_external_calls rows have parse_failed_at outside call_kind=analysis/status=completed', v_bad_count;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_external_calls_parse_failure_scope_check'
  ) then
    alter table public.protocol_external_calls
      add constraint protocol_external_calls_parse_failure_scope_check
      check (parse_failed_at is null or (call_kind = 'analysis' and status = 'completed'));
  end if;
end $$;

-- =======================================================================
-- 2. analysis_call_receipts.raw_request_body — pairing réel avec
--    request_sha256 (colonne existante depuis 0050), hash serveur réel,
--    et politique mock/réel stricte (used_mock IS TRUE/IS FALSE, jamais
--    un simple = true/= false — used_mock est not null depuis 0050,
--    mais IS TRUE/IS FALSE rejette aussi tout NULL sans clause séparée
--    si cette garantie devait un jour changer).
-- =======================================================================

alter table public.analysis_call_receipts
  add column if not exists raw_request_body text null;

do $$
declare
  v_bad_count integer;
begin
  select count(*) into v_bad_count
    from public.analysis_call_receipts
   where (raw_request_body is null) <> (request_sha256 is null);

  if v_bad_count > 0 then
    raise exception 'D-027 preflight failed: % analysis_call_receipts rows have raw_request_body/request_sha256 out of pairing', v_bad_count;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'analysis_call_receipts_request_pairing_check'
  ) then
    alter table public.analysis_call_receipts
      add constraint analysis_call_receipts_request_pairing_check
      check ((raw_request_body is null) = (request_sha256 is null));
  end if;
end $$;

do $$
declare
  v_bad_count integer;
begin
  select count(*) into v_bad_count
    from public.analysis_call_receipts
   where raw_request_body is not null
     and request_sha256 is not null
     and request_sha256 <> public._sha256_hex(raw_request_body);

  if v_bad_count > 0 then
    raise exception 'D-027 preflight failed: % analysis_call_receipts rows have request_sha256 not matching sha256(raw_request_body)', v_bad_count;
  end if;
end $$;

-- Real SHA-256 verification, server-side: this CHECK calls the same
-- pgcrypto-backed _sha256_hex helper already defined and IMMUTABLE
-- since 0051 — never a bare trust that the caller hashed what it says
-- it hashed.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'analysis_call_receipts_request_hash_match_check'
  ) then
    alter table public.analysis_call_receipts
      add constraint analysis_call_receipts_request_hash_match_check
      check (raw_request_body is null or request_sha256 = public._sha256_hex(raw_request_body));
  end if;
end $$;

do $$
declare
  v_bad_count integer;
begin
  select count(*) into v_bad_count
    from public.analysis_call_receipts
   where (used_mock is true and (raw_request_body is not null or request_sha256 is not null))
      or (used_mock is false and (raw_request_body is null or request_sha256 is null));

  if v_bad_count > 0 then
    raise exception 'D-027 preflight failed: % analysis_call_receipts rows violate the used_mock/raw_request_body pairing policy', v_bad_count;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'analysis_call_receipts_request_mock_pairing_check'
  ) then
    alter table public.analysis_call_receipts
      add constraint analysis_call_receipts_request_mock_pairing_check
      check (
        (used_mock is true and raw_request_body is null and request_sha256 is null)
        or
        (used_mock is false and raw_request_body is not null and request_sha256 is not null)
      );
  end if;
end $$;

-- =======================================================================
-- 3. record_analysis_call_receipt_for_job (0050, redefined 15-arg by
--    0052) redefined again: one added default-null parameter,
--    p_raw_request_body, inserted into the same statement that already
--    writes request_sha256 — never a later, separate UPDATE, for the
--    identical reason 0052 already established for p_raw_content. Old
--    15-arg signature dropped (no CASCADE); the body is otherwise
--    byte-identical to 0052's own definition.
-- =======================================================================

drop function if exists public.record_analysis_call_receipt_for_job(
  uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text, text
);

create or replace function
  public.record_analysis_call_receipt_for_job(
    p_job_id uuid,
    p_claim_token uuid,
    p_project_id uuid,
    p_external_call_id uuid,
    p_probe_run_id uuid,
    p_outcome text,
    p_provider text default null,
    p_model text default null,
    p_used_mock boolean default false,
    p_request_sha256 text default null,
    p_response_sha256 text default null,
    p_latency_ms integer default null,
    p_actual_cost_usd numeric default null,
    p_cost_basis text default null,
    p_raw_content text default null,
    p_raw_request_body text default null
  )
returns table (
  status        text,
  external_call public.protocol_external_calls,
  receipt       public.analysis_call_receipts
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  v_call public.protocol_external_calls%rowtype;
  v_receipt public.analysis_call_receipts%rowtype;
  v_new_status text;
begin
  if p_job_id is null or p_claim_token is null or p_project_id is null
     or p_external_call_id is null or p_probe_run_id is null or p_outcome is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_record_analysis_call_receipt_for_job_args';
  end if;

  if p_outcome not in ('success', 'provider_error', 'provider_outcome_unknown') then
    raise exception using
      errcode = '22023',
      message = 'invalid_record_analysis_call_receipt_for_job_outcome';
  end if;

  if (p_actual_cost_usd is null) <> (p_cost_basis is null) then
    raise exception using
      errcode = '22023',
      message = 'actual_cost_usd_and_cost_basis_must_be_paired';
  end if;

  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id
   for update;

  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_external_calls, null::public.analysis_call_receipts;
    return;
  end if;

  if v_job.claim_token is distinct from p_claim_token
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= now()
     or v_job.status not in ('claimed', 'running') then
    return query select 'JOB_NOT_OWNED'::text, null::public.protocol_external_calls, null::public.analysis_call_receipts;
    return;
  end if;

  select ec.* into v_call
    from public.protocol_external_calls ec
   where ec.id = p_external_call_id and ec.project_id = p_project_id
   for update;

  if not found then
    return query select 'NOT_FOUND'::text, null::public.protocol_external_calls, null::public.analysis_call_receipts;
    return;
  end if;

  if v_call.call_kind <> 'analysis' then
    return query select 'WRONG_CALL_KIND'::text, v_call, null::public.analysis_call_receipts;
    return;
  end if;

  if not exists (
    select 1 from public.protocol_attempts pa
     where pa.id = v_call.protocol_attempt_id
       and pa.job_id = p_job_id
       and pa.project_id = p_project_id
  ) then
    return query select 'CALL_NOT_OWNED_BY_JOB'::text, null::public.protocol_external_calls, null::public.analysis_call_receipts;
    return;
  end if;

  if v_call.status <> 'in_progress' or v_call.probe_run_id is distinct from p_probe_run_id then
    return query select 'CONFLICT'::text, v_call, null::public.analysis_call_receipts;
    return;
  end if;

  insert into public.analysis_call_receipts (
    project_id, external_call_id, probe_run_id, outcome, provider,
    model, used_mock, request_sha256, response_sha256, latency_ms, raw_content,
    raw_request_body
  ) values (
    p_project_id, p_external_call_id, p_probe_run_id, p_outcome, p_provider,
    p_model, coalesce(p_used_mock, false), p_request_sha256, p_response_sha256, p_latency_ms, p_raw_content,
    p_raw_request_body
  )
  returning * into v_receipt;

  v_new_status := case p_outcome
    when 'success' then 'completed'
    when 'provider_error' then 'failed'
    else 'timed_out'
  end;

  update public.protocol_external_calls
     set status = v_new_status,
         actual_cost_usd = p_actual_cost_usd,
         cost_basis = p_cost_basis,
         terminalized_at = now()
   where id = p_external_call_id and project_id = p_project_id
  returning * into v_call;

  if p_outcome = 'provider_outcome_unknown' then
    update public.protocol_execution_jobs j
       set status = 'needs_review',
           needs_review_reason = 'analysis_outcome_unknown',
           updated_at = now()
     where j.id = p_job_id and j.status in ('claimed', 'running');
  end if;

  return query select 'RECEIPTED'::text, v_call, v_receipt;
end;
$$;

revoke all on function
  public.record_analysis_call_receipt_for_job(
    uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text, text, text
  ) from public;
revoke all on function
  public.record_analysis_call_receipt_for_job(
    uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text, text, text
  ) from anon;
revoke all on function
  public.record_analysis_call_receipt_for_job(
    uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text, text, text
  ) from authenticated;
grant execute on function
  public.record_analysis_call_receipt_for_job(
    uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text, text, text
  ) to service_role;

-- =======================================================================
-- 4. mark_analysis_parse_failed_for_job — new, fenced, replay-safe RPC.
--    Marks a durable parse-failure on the current attempt's authoritative
--    analysis generation, only when its receipt is already a real
--    success — never a job-status change, never a repair policy.
-- =======================================================================

create or replace function
  public.mark_analysis_parse_failed_for_job(
    p_job_id uuid,
    p_claim_token uuid,
    p_project_id uuid,
    p_external_call_id uuid,
    p_parse_failure_code text
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
  v_call public.protocol_external_calls%rowtype;
  v_attempt public.protocol_attempts%rowtype;
  v_max_generation integer;
begin
  -- 1. validation des cinq arguments
  if p_job_id is null or p_claim_token is null or p_project_id is null
     or p_external_call_id is null or p_parse_failure_code is null
     or p_parse_failure_code not in ('invalid_json', 'schema_validation_failed', 'normalization_failed') then
    raise exception using
      errcode = '22023',
      message = 'invalid_mark_analysis_parse_failed_for_job_args';
  end if;

  -- 2. verrou job project-scoped
  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id
   for update;

  -- 3. JOB_NOT_FOUND
  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_external_calls;
    return;
  end if;

  -- 4. fencing claim/status/lease -> JOB_NOT_OWNED
  if v_job.claim_token is distinct from p_claim_token
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= now()
     or v_job.status not in ('claimed', 'running') then
    return query select 'JOB_NOT_OWNED'::text, null::public.protocol_external_calls;
    return;
  end if;

  -- 5. lookup external call project-scoped
  select ec.* into v_call
    from public.protocol_external_calls ec
   where ec.id = p_external_call_id and ec.project_id = p_project_id
   for update;

  -- 6. appartenance exacte a current_attempt_id -> NOT_CURRENT_ATTEMPT
  if not found or v_call.protocol_attempt_id is distinct from v_job.current_attempt_id then
    return query select 'NOT_CURRENT_ATTEMPT'::text, null::public.protocol_external_calls;
    return;
  end if;

  -- 7. call_kind analysis -> WRONG_CALL_KIND
  if v_call.call_kind <> 'analysis' then
    return query select 'WRONG_CALL_KIND'::text, v_call;
    return;
  end if;

  -- 8/9. deja marque : meme code -> ALREADY_MARKED ; code different -> PARSE_FAILURE_CODE_CONFLICT
  if v_call.parse_failed_at is not null then
    if v_call.parse_failure_code = p_parse_failure_code then
      return query select 'ALREADY_MARKED'::text, v_call;
      return;
    else
      return query select 'PARSE_FAILURE_CODE_CONFLICT'::text, v_call;
      return;
    end if;
  end if;

  -- 10. verrou current attempt
  select pa.* into v_attempt
    from public.protocol_attempts pa
   where pa.id = v_job.current_attempt_id and pa.job_id = p_job_id and pa.project_id = p_project_id
   for update;

  -- 11. CURRENT_ATTEMPT_NOT_FOUND (defensif -- protocol_execution_jobs_current_attempt_fk
  --     garantit deja cette ligne, meme precedent que D-020/retry_analysis_generation_for_job).
  if not found then
    return query select 'CURRENT_ATTEMPT_NOT_FOUND'::text, v_call;
    return;
  end if;

  -- 12. absence de probe_result, derivee via protocol_attempts.probe_run_id,
  --     project-scoped -- meme convention exacte que get_protocol_execution_job_context.
  if v_attempt.probe_run_id is not null and exists (
    select 1 from public.probe_results pr
     where pr.probe_run_id = v_attempt.probe_run_id and pr.project_id = p_project_id
  ) then
    return query select 'PROBE_RESULT_ALREADY_EXISTS'::text, v_call;
    return;
  end if;

  -- 13. generation analysis autoritaire maximale -> sinon SOURCE_NOT_AUTHORITATIVE_GENERATION
  select max(generation) into v_max_generation
    from public.protocol_external_calls
   where protocol_attempt_id = v_call.protocol_attempt_id and call_kind = 'analysis';

  if v_call.generation <> v_max_generation then
    return query select 'SOURCE_NOT_AUTHORITATIVE_GENERATION'::text, v_call;
    return;
  end if;

  -- 14. NOT_ELIGIBLE -- status completed + coherence des trois probe_run_id +
  --     receipt success meme projet meme probe_run.
  if v_call.status <> 'completed'
     or v_attempt.probe_run_id is null
     or v_call.probe_run_id is null
     or v_call.probe_run_id is distinct from v_attempt.probe_run_id
     or not exists (
       select 1 from public.analysis_call_receipts r
        where r.external_call_id = v_call.id
          and r.outcome = 'success'
          and r.project_id = p_project_id
          and r.probe_run_id = v_attempt.probe_run_id
     ) then
    return query select 'NOT_ELIGIBLE'::text, v_call;
    return;
  end if;

  -- 15. UPDATE atomique -> MARKED
  update public.protocol_external_calls
     set parse_failed_at = now(), parse_failure_code = p_parse_failure_code
   where id = p_external_call_id and project_id = p_project_id
  returning * into v_call;

  return query select 'MARKED'::text, v_call;
end;
$$;

revoke all on function
  public.mark_analysis_parse_failed_for_job(uuid, uuid, uuid, uuid, text) from public;
revoke all on function
  public.mark_analysis_parse_failed_for_job(uuid, uuid, uuid, uuid, text) from anon;
revoke all on function
  public.mark_analysis_parse_failed_for_job(uuid, uuid, uuid, uuid, text) from authenticated;
grant execute on function
  public.mark_analysis_parse_failed_for_job(uuid, uuid, uuid, uuid, text) to service_role;

-- =======================================================================
-- 5. retry_analysis_generation_for_job (0051) extended: the eligibility
--    branch (previously the sole SOURCE_NOT_ELIGIBLE condition) now also
--    accepts a completed, parse-failed source with a real success
--    receipt and a coherent probe_run_id, and no probe_result yet.
--    Signature unchanged (uuid, uuid, uuid, uuid, numeric); dedup,
--    authoritative-generation check, ambiguity gate, retry_cap,
--    spend_cap_usd, and _reserve_additional_analysis_generation_core are
--    textually unchanged.
-- =======================================================================

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

  -- D-027: eligibility now has two independent branches. The historical
  -- branch (failed/timed_out/cancelled with a receipt) is textually
  -- unchanged. The new branch accepts a completed, parse-failed source
  -- only when its own probe_run_id is coherent with the attempt's, its
  -- receipt is a real, same-project, same-probe_run success, and no
  -- probe_result exists yet -- otherwise PROBE_RESULT_ALREADY_EXISTS,
  -- never a silently-accepted repair of an already-resulted generation.
  if v_source.status in ('failed', 'timed_out', 'cancelled') then
    if not exists (select 1 from public.analysis_call_receipts r where r.external_call_id = v_source.id) then
      return query select 'SOURCE_NOT_ELIGIBLE'::text, v_source;
      return;
    end if;
  elsif v_source.status = 'completed' and v_source.parse_failed_at is not null and v_source.parse_failure_code is not null then
    if v_attempt.probe_run_id is null
       or v_source.probe_run_id is null
       or v_source.probe_run_id is distinct from v_attempt.probe_run_id
       or not exists (
         select 1 from public.analysis_call_receipts r
          where r.external_call_id = v_source.id
            and r.outcome = 'success'
            and r.project_id = p_project_id
            and r.probe_run_id = v_attempt.probe_run_id
       ) then
      return query select 'SOURCE_NOT_ELIGIBLE'::text, v_source;
      return;
    end if;
    if exists (
      select 1 from public.probe_results pr
       where pr.probe_run_id = v_attempt.probe_run_id and pr.project_id = p_project_id
    ) then
      return query select 'PROBE_RESULT_ALREADY_EXISTS'::text, v_source;
      return;
    end if;
  else
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

-- =======================================================================
-- 6. protocol_execution_job_monitoring_v1 -- one additive scalar
--    counter, no raw/content column, no array_agg, no row projection.
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
  (select avg(latency_ms) from public.analysis_call_receipts) as analysis_latency_ms_avg,
  (select count(*) from public.protocol_execution_jobs
    where status = 'running' and current_attempt_id is null) as jobs_awaiting_next_baseline_slot,
  (select count(distinct (job_id, baseline_ordinal)) from public.protocol_attempts
    where job_id is not null and baseline_ordinal is not null and status = 'completed'
  ) as baseline_slots_completed_total,
  -- D-027: a durable, scalar-only signal that some analysis generation's
  -- receipt succeeded but its content failed local parsing -- never a
  -- job-status change, never repair policy. No raw/content column is
  -- ever referenced here.
  (select count(*) from public.protocol_external_calls where parse_failed_at is not null) as analysis_parse_failures_total;

revoke all on public.protocol_execution_job_monitoring_v1 from public, anon, authenticated, service_role;
grant select on public.protocol_execution_job_monitoring_v1 to service_role;
