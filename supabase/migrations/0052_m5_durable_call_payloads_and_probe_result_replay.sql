-- M5 — D-026: durable call payloads and probe_result replay safety.
-- DRAFT migration. Additive only with respect to 0050/0051 (both left
-- byte-identical by this file). Not applied to any database by this
-- commit.
--
-- Ce que cette migration fait :
--   * provider_call_receipts gagne raw_response_body (le texte exact de
--     la réponse Perplexity) ; analysis_call_receipts gagne raw_content
--     (le texte exact de la réponse d'analyse) — jusqu'ici, ces deux
--     tables ne portaient que des empreintes SHA-256, jamais le contenu
--     lui-même, rendant toute reprise après crash impossible sans un
--     second appel provider/LLM.
--   * Trois contraintes réelles par table : pairing contenu/empreinte
--     (l'un implique l'autre), contenu obligatoire quand outcome =
--     'success', et vérification SHA-256 réelle côté SQL (CHECK
--     appelant le helper _sha256_hex déjà existant depuis 0051 —
--     jamais une simple confiance dans ce que l'appelant prétend avoir
--     haché).
--   * probe_results gagne une contrainte UNIQUE(probe_run_id) réelle,
--     préflightée contre les doublons historiques — jusqu'ici rien
--     n'empêchait, ni ne permettait de détecter, une seconde ligne pour
--     la même tentative.
--   * record_provider_call_receipt_for_job et
--     record_analysis_call_receipt_for_job sont redéfinies avec un
--     paramètre supplémentaire à défaut nullable (p_raw_response_body /
--     p_raw_content) — l'ancienne signature est supprimée (DROP, sans
--     CASCADE) puis recréée avec le paramètre en plus, exactement la
--     technique déjà utilisée par D-025 pour
--     _admit_and_reserve_attempt_core.
--   * get_protocol_execution_job_context gagne une colonne de sortie
--     supplémentaire, probe_result — le probe_results éventuel de la
--     tentative courante (jamais un accès direct, toujours via cette
--     RPC déjà fencée). Les colonnes existantes external_calls/
--     provider_receipts/analysis_receipts exposent déjà les nouvelles
--     colonnes automatiquement (array_agg(r.*) sur une table qui vient
--     de gagner une colonne n'exige aucune modification de la requête)
--     — seule l'ajout de probe_result exige une redéfinition réelle.
--   * CORRECTION (post-approbation) — le dataset devient un attribut
--     durable du job, et non plus une lecture dérivée après coup :
--     protocol_execution_jobs gagne dataset_batch_id uuid not null,
--     project-scoped par FK composite vers dataset_batches(id,
--     project_id), avec UNIQUE(dataset_batch_id) (un batch ne sert
--     jamais deux jobs). enqueue_protocol_execution_job (0050/0051)
--     est redéfinie pour créer, dans la même transaction que le job,
--     exactement un dataset_batches row (manual_scan) et le job qui le
--     référence — NO_BASELINE_RUNS_PLANNED ne crée ni l'un ni l'autre ;
--     ALREADY_EXISTS, y compris sous concurrence (déjà sérialisée par
--     le FOR UPDATE sur protocols que cette fonction pose déjà),
--     retourne le job et son batch existants sans nouvelle ligne.
--     create_probe_run_and_start_attempt_for_job (0051) est redéfinie
--     avec une signature réduite (6 arguments : les deux paramètres
--     p_dataset_id/p_dataset_source_type contrôlés par l'appelant sont
--     supprimés) — le dataset est dérivé exclusivement de
--     job.dataset_batch_id, jamais fourni par le worker. Voir D-026
--     pour la preuve que la lignée protocole → question → dataset
--     n'existe pas dans le schéma, et pour le raisonnement complet.
--
-- Ce que cette migration NE fait PAS :
--   * Ne modifie pas 0050 ni 0051 — chaque redéfinition ici est un
--     DROP + CREATE OR REPLACE dans ce fichier, exactement la technique
--     déjà utilisée par 0051 lui-même pour surcharger des fonctions
--     définies dans 0050.
--   * Ne crée aucune migration 0053.
--   * N'écrit, ni ne touche, aucun fichier worker, CLI, ou provider —
--     tranche SQL + types/adaptateurs uniquement.
--   * Ne modifie pas lib/llm/call-model.ts — le contenu exact des
--     octets envoyés/reçus par ce fichier reste un problème distinct,
--     hors de cette tranche (voir D-026 §Reason).
--   * Ne référence aucun 5×3/$2 legacy ni verdict won/partial/lost.
--   * Ne s'applique à, ni ne se connecte à, aucune base staging ou
--     Production — ce fichier est créé localement uniquement.

-- =======================================================================
-- 1. provider_call_receipts.raw_response_body — contenu exact,
--    préflighté, contraint (pairing / success / hash réel).
-- =======================================================================

alter table public.provider_call_receipts
  add column if not exists raw_response_body text null;

do $$
declare
  v_bad_count integer;
begin
  select count(*) into v_bad_count
    from public.provider_call_receipts
   where (raw_response_body is null) <> (raw_response_sha256 is null);

  if v_bad_count > 0 then
    raise exception 'D-026 preflight failed: % provider_call_receipts rows have raw_response_body/raw_response_sha256 out of pairing', v_bad_count;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'provider_call_receipts_content_hash_pairing_check'
  ) then
    alter table public.provider_call_receipts
      add constraint provider_call_receipts_content_hash_pairing_check
      check ((raw_response_body is null) = (raw_response_sha256 is null));
  end if;
end $$;

do $$
declare
  v_bad_count integer;
begin
  select count(*) into v_bad_count
    from public.provider_call_receipts
   where outcome = 'success' and raw_response_body is null;

  if v_bad_count > 0 then
    raise exception 'D-026 preflight failed: % provider_call_receipts rows are outcome=success with no raw_response_body', v_bad_count;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'provider_call_receipts_success_requires_content_check'
  ) then
    alter table public.provider_call_receipts
      add constraint provider_call_receipts_success_requires_content_check
      check (outcome <> 'success' or raw_response_body is not null);
  end if;
end $$;

do $$
declare
  v_bad_count integer;
begin
  select count(*) into v_bad_count
    from public.provider_call_receipts
   where raw_response_body is not null
     and raw_response_sha256 is not null
     and raw_response_sha256 <> public._sha256_hex(raw_response_body);

  if v_bad_count > 0 then
    raise exception 'D-026 preflight failed: % provider_call_receipts rows have raw_response_sha256 not matching sha256(raw_response_body)', v_bad_count;
  end if;
end $$;

-- Real SHA-256 verification, server-side: this CHECK calls the same
-- pgcrypto-backed _sha256_hex helper _sha256_hex(text) already defined
-- and IMMUTABLE since 0051 — never a bare trust that the caller hashed
-- what it says it hashed. A mismatched pair is rejected by Postgres
-- itself at INSERT time, uncaught, exactly like every other CHECK
-- constraint in this migration set — no exception-absorption anywhere.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'provider_call_receipts_content_hash_match_check'
  ) then
    alter table public.provider_call_receipts
      add constraint provider_call_receipts_content_hash_match_check
      check (raw_response_body is null or raw_response_sha256 = public._sha256_hex(raw_response_body));
  end if;
end $$;

-- =======================================================================
-- 2. analysis_call_receipts.raw_content — même contrat, paire avec
--    response_sha256 (la sortie de l'analyse, celle qu'il faut pour
--    reprendre saveProbeResult sans second appel LLM). request_sha256
--    reste sans contenu associé dans cette tranche : call-model.ts
--    n'expose pas les octets exacts de la requête sortante (voir
--    D-026 §Reason) — hors de cette tranche par instruction explicite.
-- =======================================================================

alter table public.analysis_call_receipts
  add column if not exists raw_content text null;

do $$
declare
  v_bad_count integer;
begin
  select count(*) into v_bad_count
    from public.analysis_call_receipts
   where (raw_content is null) <> (response_sha256 is null);

  if v_bad_count > 0 then
    raise exception 'D-026 preflight failed: % analysis_call_receipts rows have raw_content/response_sha256 out of pairing', v_bad_count;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'analysis_call_receipts_content_hash_pairing_check'
  ) then
    alter table public.analysis_call_receipts
      add constraint analysis_call_receipts_content_hash_pairing_check
      check ((raw_content is null) = (response_sha256 is null));
  end if;
end $$;

do $$
declare
  v_bad_count integer;
begin
  select count(*) into v_bad_count
    from public.analysis_call_receipts
   where outcome = 'success' and raw_content is null;

  if v_bad_count > 0 then
    raise exception 'D-026 preflight failed: % analysis_call_receipts rows are outcome=success with no raw_content', v_bad_count;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'analysis_call_receipts_success_requires_content_check'
  ) then
    alter table public.analysis_call_receipts
      add constraint analysis_call_receipts_success_requires_content_check
      check (outcome <> 'success' or raw_content is not null);
  end if;
end $$;

do $$
declare
  v_bad_count integer;
begin
  select count(*) into v_bad_count
    from public.analysis_call_receipts
   where raw_content is not null
     and response_sha256 is not null
     and response_sha256 <> public._sha256_hex(raw_content);

  if v_bad_count > 0 then
    raise exception 'D-026 preflight failed: % analysis_call_receipts rows have response_sha256 not matching sha256(raw_content)', v_bad_count;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'analysis_call_receipts_content_hash_match_check'
  ) then
    alter table public.analysis_call_receipts
      add constraint analysis_call_receipts_content_hash_match_check
      check (raw_content is null or response_sha256 = public._sha256_hex(raw_content));
  end if;
end $$;

-- =======================================================================
-- 3. probe_results — unicité réelle d'un probe_result par probe_run,
--    préflightée contre les doublons historiques réels (probe_results
--    est une table ancienne, 0003, potentiellement déjà peuplée sur un
--    environnement réel — contrairement aux tables M5, cette préflight
--    n'est pas seulement défensive par convention).
-- =======================================================================

do $$
declare
  v_dupe_count integer;
begin
  select count(*) into v_dupe_count
    from (
      select probe_run_id
        from public.probe_results
       group by probe_run_id
      having count(*) > 1
    ) dupes;

  if v_dupe_count > 0 then
    raise exception 'D-026 preflight failed: % probe_run_id value(s) have more than one probe_results row', v_dupe_count;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'probe_results_probe_run_id_key'
  ) then
    alter table public.probe_results
      add constraint probe_results_probe_run_id_key unique (probe_run_id);
  end if;
end $$;

-- =======================================================================
-- 4. record_provider_call_receipt_for_job (0050) redefined: one added
--    default-null parameter, p_raw_response_body, inserted into the
--    same statement that already writes the hash — the CHECK
--    constraints above are what actually enforce pairing/success/hash-
--    match; this RPC does not duplicate that logic. Old 12-arg
--    signature dropped (no CASCADE); the only caller (the TypeScript
--    adapter) is updated in the same tranche.
-- =======================================================================

drop function if exists public.record_provider_call_receipt_for_job(
  uuid, uuid, uuid, uuid, uuid, text, integer, text, text, integer, numeric, text
);

create or replace function
  public.record_provider_call_receipt_for_job(
    p_job_id uuid,
    p_claim_token uuid,
    p_project_id uuid,
    p_external_call_id uuid,
    p_probe_run_id uuid,
    p_outcome text,
    p_http_status integer default null,
    p_provider_request_id text default null,
    p_raw_response_sha256 text default null,
    p_latency_ms integer default null,
    p_actual_cost_usd numeric default null,
    p_cost_basis text default null,
    p_raw_response_body text default null
  )
returns table (
  status        text,
  external_call public.protocol_external_calls,
  receipt       public.provider_call_receipts
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  v_call public.protocol_external_calls%rowtype;
  v_receipt public.provider_call_receipts%rowtype;
  v_new_status text;
begin
  if p_job_id is null or p_claim_token is null or p_project_id is null
     or p_external_call_id is null or p_probe_run_id is null or p_outcome is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_record_provider_call_receipt_for_job_args';
  end if;

  if p_outcome not in ('success', 'provider_error', 'provider_outcome_unknown') then
    raise exception using
      errcode = '22023',
      message = 'invalid_record_provider_call_receipt_for_job_outcome';
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
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_external_calls, null::public.provider_call_receipts;
    return;
  end if;

  if v_job.claim_token is distinct from p_claim_token
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= now()
     or v_job.status not in ('claimed', 'running') then
    return query select 'JOB_NOT_OWNED'::text, null::public.protocol_external_calls, null::public.provider_call_receipts;
    return;
  end if;

  select ec.* into v_call
    from public.protocol_external_calls ec
   where ec.id = p_external_call_id and ec.project_id = p_project_id
   for update;

  if not found then
    return query select 'NOT_FOUND'::text, null::public.protocol_external_calls, null::public.provider_call_receipts;
    return;
  end if;

  if v_call.call_kind <> 'perplexity' then
    return query select 'WRONG_CALL_KIND'::text, v_call, null::public.provider_call_receipts;
    return;
  end if;

  if not exists (
    select 1 from public.protocol_attempts pa
     where pa.id = v_call.protocol_attempt_id
       and pa.job_id = p_job_id
       and pa.project_id = p_project_id
  ) then
    return query select 'CALL_NOT_OWNED_BY_JOB'::text, null::public.protocol_external_calls, null::public.provider_call_receipts;
    return;
  end if;

  if v_call.status <> 'in_progress' or v_call.probe_run_id is distinct from p_probe_run_id then
    return query select 'CONFLICT'::text, v_call, null::public.provider_call_receipts;
    return;
  end if;

  insert into public.provider_call_receipts (
    project_id, external_call_id, probe_run_id, outcome, http_status,
    provider_request_id, raw_response_sha256, latency_ms, raw_response_body
  ) values (
    p_project_id, p_external_call_id, p_probe_run_id, p_outcome, p_http_status,
    p_provider_request_id, p_raw_response_sha256, p_latency_ms, p_raw_response_body
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
           needs_review_reason = 'perplexity_outcome_unknown',
           updated_at = now()
     where j.id = p_job_id and j.status in ('claimed', 'running');
  end if;

  return query select 'RECEIPTED'::text, v_call, v_receipt;
end;
$$;

revoke all on function
  public.record_provider_call_receipt_for_job(
    uuid, uuid, uuid, uuid, uuid, text, integer, text, text, integer, numeric, text, text
  ) from public;
revoke all on function
  public.record_provider_call_receipt_for_job(
    uuid, uuid, uuid, uuid, uuid, text, integer, text, text, integer, numeric, text, text
  ) from anon;
revoke all on function
  public.record_provider_call_receipt_for_job(
    uuid, uuid, uuid, uuid, uuid, text, integer, text, text, integer, numeric, text, text
  ) from authenticated;
grant execute on function
  public.record_provider_call_receipt_for_job(
    uuid, uuid, uuid, uuid, uuid, text, integer, text, text, integer, numeric, text, text
  ) to service_role;

-- =======================================================================
-- 5. record_analysis_call_receipt_for_job (0050) redefined: one added
--    default-null parameter, p_raw_content, same rationale as above.
--    Old 14-arg signature dropped (no CASCADE).
-- =======================================================================

drop function if exists public.record_analysis_call_receipt_for_job(
  uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text
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
    p_raw_content text default null
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
    model, used_mock, request_sha256, response_sha256, latency_ms, raw_content
  ) values (
    p_project_id, p_external_call_id, p_probe_run_id, p_outcome, p_provider,
    p_model, coalesce(p_used_mock, false), p_request_sha256, p_response_sha256, p_latency_ms, p_raw_content
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
    uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text, text
  ) from public;
revoke all on function
  public.record_analysis_call_receipt_for_job(
    uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text, text
  ) from anon;
revoke all on function
  public.record_analysis_call_receipt_for_job(
    uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text, text
  ) from authenticated;
grant execute on function
  public.record_analysis_call_receipt_for_job(
    uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text, text
  ) to service_role;

-- =======================================================================
-- 6. get_protocol_execution_job_context (0051) redefined: one added
--    output column, probe_result — the current attempt's probe_results
--    row, if one already exists (looked up by probe_run_id, now
--    guaranteed at most one by section 3's real UNIQUE constraint).
--    external_calls/provider_receipts/analysis_receipts already expose
--    raw_response_body/raw_content automatically (array_agg(r.*) on a
--    table that just gained a column requires no query change) — this
--    section only has to add the one genuinely new field. Same
--    arguments (uuid, uuid, uuid); DROP required because a function's
--    RETURNS TABLE column list cannot be changed by CREATE OR REPLACE.
-- =======================================================================

drop function if exists public.get_protocol_execution_job_context(uuid, uuid, uuid);

create or replace function
  public.get_protocol_execution_job_context(
    p_job_id uuid,
    p_claim_token uuid,
    p_project_id uuid
  )
returns table (
  status                   text,
  job                      public.protocol_execution_jobs,
  protocol                 public.protocols,
  current_attempt          public.protocol_attempts,
  external_calls           public.protocol_external_calls[],
  provider_receipts        public.provider_call_receipts[],
  analysis_receipts        public.analysis_call_receipts[],
  probe_run                public.probe_runs,
  completed_baseline_slots integer,
  probe_result             public.probe_results
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
  v_probe_result public.probe_results%rowtype;
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
      null::public.analysis_call_receipts[], null::public.probe_runs, null::integer,
      null::public.probe_results;
    return;
  end if;

  if v_job.claim_token is distinct from p_claim_token
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= now()
     or v_job.status not in ('claimed', 'running') then
    return query select 'JOB_NOT_OWNED'::text, v_job,
      null::public.protocols, null::public.protocol_attempts,
      null::public.protocol_external_calls[], null::public.provider_call_receipts[],
      null::public.analysis_call_receipts[], null::public.probe_runs, null::integer,
      null::public.probe_results;
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

      select res.* into v_probe_result
        from public.probe_results res
       where res.probe_run_id = v_attempt.probe_run_id and res.project_id = p_project_id;
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
    v_run,
    (select count(distinct pa.baseline_ordinal)::integer
       from public.protocol_attempts pa
      where pa.job_id = p_job_id
        and pa.baseline_ordinal is not null
        and pa.status = 'completed'),
    v_probe_result;
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
-- 7. protocol_execution_jobs.dataset_batch_id — the dataset becomes a
--    durable attribute of the job itself, not a read derived after the
--    fact from a prior attempt. The lineage
--    job.protocol_id -> protocols -> buyer_question_versions ->
--    buyer_questions -> dataset_batches was checked, by exact schema
--    name, and does not exist (see D-026): dataset_batches (0038)
--    carries no reference in that direction, and 0047-0049 add none.
--    The attempt-level chain proven in this migration's first version
--    (protocol_attempts.job_id/probe_run_id -> probe_runs.dataset_id)
--    is real, but only resolvable once at least one attempt under the
--    job already has a probe_run -- it returns nothing durable before
--    the first slot starts, or between two slots while
--    current_attempt_id is null. Storing the dataset on the job itself
--    removes that gap entirely: it is chosen once, atomically, at
--    enqueue time (section 8), and is always readable directly off
--    protocol_execution_jobs, independent of any attempt's lifecycle.
--
--    No silent backfill: if any protocol_execution_jobs row already
--    exists when this column is added, there is no dataset any
--    pre-existing row could be truthfully assigned without inventing
--    one -- the preflight below fails closed with a clear diagnostic
--    instead of fabricating a value.
-- =======================================================================

alter table public.protocol_execution_jobs
  add column if not exists dataset_batch_id uuid null;

do $$
declare
  v_existing_count integer;
begin
  select count(*) into v_existing_count from public.protocol_execution_jobs;

  if v_existing_count > 0 then
    raise exception 'D-026 preflight failed: % protocol_execution_jobs row(s) already exist with no dataset_batch_id -- no backfill is permitted (there is no truthful value to assign); this migration must be revisited with an explicit reconciliation plan before applying to any environment that already has M5 jobs', v_existing_count;
  end if;
end $$;

alter table public.protocol_execution_jobs
  alter column dataset_batch_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_execution_jobs_dataset_batch_project_fk'
  ) then
    alter table public.protocol_execution_jobs
      add constraint protocol_execution_jobs_dataset_batch_project_fk
      foreign key (dataset_batch_id, project_id)
      references public.dataset_batches (id, project_id);
  end if;
end $$;

-- One dataset batch never serves two jobs -- the same discipline
-- protocol_execution_jobs_protocol_id_key (0050) already applies to
-- protocol_id (one job per protocol), extended to the dataset it owns.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_execution_jobs_dataset_batch_id_key'
  ) then
    alter table public.protocol_execution_jobs
      add constraint protocol_execution_jobs_dataset_batch_id_key unique (dataset_batch_id);
  end if;
end $$;

-- =======================================================================
-- 8. enqueue_protocol_execution_job (0050, redefined by D-025 in 0051)
--    redefined again: creates exactly one dataset_batches row
--    (manual_scan -- the only source type M5 can reach, since M5 has no
--    snapshot_request_id) and exactly one job referencing it, in the
--    same function invocation, never a later separate write.
--    NO_BASELINE_RUNS_PLANNED still returns before any row of either
--    kind is created. ALREADY_EXISTS still returns the pre-existing job
--    (whose row already carries dataset_batch_id) with no new dataset
--    batch and no new job -- concurrency for the same protocol_id was
--    already fully serialized by the FOR UPDATE lock this function
--    takes on the protocols row before reaching either check, so two
--    concurrent callers can never each create their own batch for the
--    same protocol. Signature unchanged (uuid, uuid, integer) from
--    0050/0051 -- CREATE OR REPLACE is sufficient, no DROP needed.
-- =======================================================================

create or replace function
  public.enqueue_protocol_execution_job(
    p_protocol_id uuid,
    p_project_id uuid,
    p_max_attempts integer default 3
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
  v_protocol public.protocols%rowtype;
  v_existing public.protocol_execution_jobs%rowtype;
  v_new public.protocol_execution_jobs%rowtype;
  v_dataset_batch_id uuid;
begin
  if p_protocol_id is null or p_project_id is null
     or p_max_attempts is null or p_max_attempts < 1 then
    raise exception using
      errcode = '22023',
      message = 'invalid_enqueue_protocol_execution_job_args';
  end if;

  select p.* into v_protocol
    from public.protocols p
   where p.id = p_protocol_id and p.project_id = p_project_id
   for update;

  if not found then
    return query select 'PROTOCOL_NOT_FOUND'::text, null::public.protocol_execution_jobs;
    return;
  end if;

  if v_protocol.status not in ('approved', 'active') then
    return query select 'PROTOCOL_NOT_APPROVED'::text, null::public.protocol_execution_jobs;
    return;
  end if;

  if v_protocol.planned_baseline_runs = 0 then
    return query select 'NO_BASELINE_RUNS_PLANNED'::text, null::public.protocol_execution_jobs;
    return;
  end if;

  select j.* into v_existing
    from public.protocol_execution_jobs j
   where j.protocol_id = p_protocol_id and j.project_id = p_project_id;

  if found then
    return query select 'ALREADY_EXISTS'::text, v_existing;
    return;
  end if;

  insert into public.dataset_batches (project_id, dataset_source_type)
  values (p_project_id, 'manual_scan')
  returning id into v_dataset_batch_id;

  insert into public.protocol_execution_jobs (
    project_id, protocol_id, status, max_attempts, dataset_batch_id
  ) values (
    p_project_id, p_protocol_id, 'queued', p_max_attempts, v_dataset_batch_id
  )
  returning * into v_new;

  return query select 'QUEUED'::text, v_new;
end;
$$;

-- =======================================================================
-- 9. create_probe_run_and_start_attempt_for_job (0051) redefined: the
--    dataset is now derived exclusively from job.dataset_batch_id --
--    p_dataset_id/p_dataset_source_type are removed from the signature
--    entirely, so no caller (worker) can supply, or override, a
--    dataset. The old 8-arg signature is dropped (no CASCADE); the new
--    6-arg signature is the only one that will ever exist alongside it.
-- =======================================================================

drop function if exists public.create_probe_run_and_start_attempt_for_job(
  uuid, uuid, uuid, uuid, text, text, uuid, text
);

create or replace function
  public.create_probe_run_and_start_attempt_for_job(
    p_job_id uuid,
    p_claim_token uuid,
    p_project_id uuid,
    p_attempt_id uuid,
    p_platform text,
    p_probe_mode text
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
  v_dataset_source_type text;
begin
  if p_job_id is null or p_claim_token is null or p_project_id is null
     or p_attempt_id is null or p_platform is null or p_probe_mode is null then
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

  -- The dataset is derived exclusively from the job's own
  -- dataset_batch_id (section 7), never from a caller-supplied
  -- argument: this select exists to read dataset_source_type (probe_runs
  -- itself needs both columns), not to choose or validate a different
  -- dataset -- v_job.dataset_batch_id is not null by the column's own
  -- NOT NULL constraint, and the composite FK to dataset_batches(id,
  -- project_id) already guarantees this row exists and is project-scoped.
  select db.dataset_source_type into v_dataset_source_type
    from public.dataset_batches db
   where db.id = v_job.dataset_batch_id and db.project_id = p_project_id;

  insert into public.probe_runs (project_id, platform, status, probe_mode, dataset_id, dataset_source_type)
  values (p_project_id, p_platform, 'pending', p_probe_mode, v_job.dataset_batch_id, v_dataset_source_type)
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
  public.create_probe_run_and_start_attempt_for_job(uuid, uuid, uuid, uuid, text, text) from public;
revoke all on function
  public.create_probe_run_and_start_attempt_for_job(uuid, uuid, uuid, uuid, text, text) from anon;
revoke all on function
  public.create_probe_run_and_start_attempt_for_job(uuid, uuid, uuid, uuid, text, text) from authenticated;
grant execute on function
  public.create_probe_run_and_start_attempt_for_job(uuid, uuid, uuid, uuid, text, text) to service_role;
