-- M5 — D-028: durable probe_result persistence + alert outbox.
-- DRAFT migration. Additive only with respect to 0050-0053 (all left
-- byte-identical by this file). Not applied to any database by this
-- commit.
--
-- Ce que cette migration fait :
--   * probe_results gagne canonical_result_sha256 (identité du résultat
--     PARSÉ, distincte de analysis_call_receipts.response_sha256 qui ne
--     prouve que la lignée du modèle brut) — calculée exclusivement
--     côté serveur dans persist_probe_result_for_job, jamais fournie
--     par l'appelant.
--   * probe_results.verdict / product_verdict gagnent la valeur
--     'not_evaluated' (CHECK étendue, additive, aucune ligne existante
--     modifiée) : M5 ne calcule jamais de verdict won/partial/lost —
--     ces deux colonnes legacy reçoivent ce placeholder structurel fixe
--     pour satisfaire leur NOT NULL, jamais un jugement réel. La vérité
--     canonique M5 est run_position (déjà nullable depuis 0038).
--   * probe_results.dataset_source_type gagne la valeur
--     'protocol_execution_job' (CHECK étendue, additive).
--   * Trois nouvelles tables append-only : protocol_execution_job_alerts
--     (un événement immuable par transition réelle needs_review/
--     abandoned_exhausted, jamais UNIQUE(job_id, event_type) — un job
--     peut retraverser needs_review plusieurs fois), protocol_
--     execution_job_alert_deliveries (état/lease de livraison, distinct
--     de l'événement lui-même), protocol_execution_job_alert_delivery_
--     attempts (une ligne durable par tentative HTTP réelle, jamais
--     supprimée, jamais remise à request_sent après terminalisation).
--   * Cinq nouvelles RPC service_role-only, SECURITY DEFINER,
--     search_path = pg_catalog, pg_temp (chaque objet applicatif
--     qualifié public.<objet> explicitement) : persist_probe_result_
--     for_job, claim_next_pending_alert, renew_alert_lease, mark_alert_
--     request_sent, record_alert_delivery_receipt.
--   * Quatre RPC 0050-0053 redéfinies EXCLUSIVEMENT pour émettre
--     l'événement d'outbox dans la MÊME transaction que leur transition
--     de statut existante (via un CTE consommant le RETURNING de
--     l'UPDATE déjà présent) — aucune autre ligne de logique métier
--     modifiée : record_provider_call_receipt_for_job, record_analysis_
--     call_receipt_for_job, mark_protocol_execution_job_needs_review_
--     for_ambiguity, claim_protocol_execution_job.
--
-- Ce que cette migration NE fait PAS :
--   * Ne modifie pas 0050-0053 en tant que fichiers — chaque
--     redéfinition ici est un CREATE OR REPLACE dans CE fichier,
--     signature strictement inchangée pour les quatre fonctions
--     redéfinies (aucun DROP nécessaire).
--   * Ne touche à aucun fichier worker, CLI, ou provider réel — tranche
--     SQL uniquement ; le worker M5 réel reste une tranche
--     d'implémentation ultérieure, non créée ici.
--   * Ne backfille aucune ligne existante de probe_results.
--   * N'envoie aucun email réel — persist_probe_result_for_job et les
--     quatre RPC d'alerte ne font que persister l'état ; l'appel HTTP
--     Resend lui-même appartient exclusivement au futur worker
--     d'alerte, jamais à ces RPC.
--   * Ne référence aucun 5×3/$2 legacy ni jugement won/partial/lost
--     réellement calculé par M5 (voir ci-dessus).
--   * Ne s'applique à, ni ne se connecte à, aucune base staging ou
--     Production — ce fichier est créé localement uniquement.

-- =======================================================================
-- 1. probe_results — canonical_result_sha256, extension additive des
--    vocabulaires legacy (verdict/product_verdict) et de
--    dataset_source_type.
-- =======================================================================

alter table if exists public.probe_results
  add column if not exists canonical_result_sha256 text null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'probe_results_canonical_result_sha256_format_check'
  ) then
    alter table public.probe_results
      add constraint probe_results_canonical_result_sha256_format_check
      check (canonical_result_sha256 is null or canonical_result_sha256 ~ '^[0-9a-f]{64}$');
  end if;
end $$;

-- verdict (0003) was an inline, unnamed column CHECK. Postgres auto-names
-- an inline single-column CHECK '<table>_<column>_check', which for this
-- column already happened to be exactly 'probe_results_verdict_check' --
-- so an earlier "add the 5-value check only if this name doesn't already
-- exist" guard silently kept the original 4-value definition in place and
-- never widened it. Replaced with the same deterministic, unconditional
-- drop-then-add pattern used below for product_verdict_check: always
-- drop whatever is currently named probe_results_verdict_check (if any)
-- and always (re)add the 5-value definition, so this statement's result
-- no longer depends on what constraint name happened to already exist.
alter table public.probe_results
  drop constraint if exists probe_results_verdict_check;

alter table public.probe_results
  add constraint probe_results_verdict_check
  check (
    verdict in (
      'won',
      'partial',
      'lost',
      'not_relevant',
      'not_evaluated'
    )
  );

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'probe_results_product_verdict_check') then
    alter table public.probe_results drop constraint probe_results_product_verdict_check;
  end if;
  alter table public.probe_results
    add constraint probe_results_product_verdict_check
    check (product_verdict in ('won', 'partial', 'lost', 'not_relevant', 'not_evaluated'));
end $$;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'probe_results_dataset_source_type_check') then
    alter table public.probe_results drop constraint probe_results_dataset_source_type_check;
  end if;
  alter table public.probe_results
    add constraint probe_results_dataset_source_type_check
    check (
      dataset_source_type is null or dataset_source_type in (
        'snapshot_request', 'manual_scan', 'legacy_unresolved', 'protocol_execution_job'
      )
    );
end $$;

-- =======================================================================
-- 2. protocol_execution_job_alerts — un événement immuable par
--    transition réelle. Jamais UNIQUE(job_id, event_type) : un job peut
--    quitter puis rejoindre needs_review, chaque transition produit sa
--    propre ligne. reason_code est immuable et lu par le dispatcher
--    depuis CETTE table, jamais depuis protocol_execution_jobs.
--    needs_review_reason (mutable, écrasable par une reprise ultérieure).
-- =======================================================================

create table if not exists public.protocol_execution_job_alerts (
  alert_event_id           uuid primary key default gen_random_uuid(),
  project_id               uuid not null,
  job_id                   uuid not null,
  event_type               text not null check (event_type in ('needs_review', 'abandoned_exhausted')),
  reason_code              text not null,
  source_attempt_id        uuid null,
  source_external_call_id  uuid null,
  transition_at            timestamptz not null default now(),
  transition_seq           bigint generated always as identity
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_execution_job_alerts_reason_code_check'
  ) then
    alter table public.protocol_execution_job_alerts
      add constraint protocol_execution_job_alerts_reason_code_check
      check (
        (event_type = 'needs_review' and reason_code in (
          'perplexity_outcome_unknown', 'analysis_outcome_unknown', 'ambiguous_external_call_sent_without_receipt'
        ))
        or
        (event_type = 'abandoned_exhausted' and reason_code = 'attempts_exhausted')
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_execution_job_alerts_job_project_fk'
  ) then
    alter table public.protocol_execution_job_alerts
      add constraint protocol_execution_job_alerts_job_project_fk
      foreign key (job_id, project_id)
      references public.protocol_execution_jobs (id, project_id);
  end if;
end $$;

-- NULL sur une colonne de FK composite désactive naturellement la
-- vérification en Postgres -- aucun bloc conditionnel nécessaire pour
-- ces deux FK, dont les colonnes source sont nullable. Les clés uniques
-- composites référencées existent déjà (0050 section 6b, 0051 section 3)
-- -- aucune contrainte additive supplémentaire n'est nécessaire.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_execution_job_alerts_source_attempt_job_project_fk'
  ) then
    alter table public.protocol_execution_job_alerts
      add constraint protocol_execution_job_alerts_source_attempt_job_project_fk
      foreign key (source_attempt_id, job_id, project_id)
      references public.protocol_attempts (id, job_id, project_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_execution_job_alerts_source_call_attempt_project_fk'
  ) then
    alter table public.protocol_execution_job_alerts
      add constraint protocol_execution_job_alerts_source_call_attempt_project_fk
      foreign key (source_external_call_id, source_attempt_id, project_id)
      references public.protocol_external_calls (id, protocol_attempt_id, project_id);
  end if;
end $$;

create index if not exists protocol_execution_job_alerts_job_idx on public.protocol_execution_job_alerts (job_id);
create index if not exists protocol_execution_job_alerts_project_idx on public.protocol_execution_job_alerts (project_id);
create index if not exists protocol_execution_job_alerts_event_type_transition_idx
  on public.protocol_execution_job_alerts (event_type, transition_at);

alter table public.protocol_execution_job_alerts enable row level security;
alter table public.protocol_execution_job_alerts no force row level security;

revoke all on table public.protocol_execution_job_alerts from public, anon, authenticated, service_role;
grant select, insert on table public.protocol_execution_job_alerts to service_role;

-- =======================================================================
-- 3. protocol_execution_job_alert_deliveries — état/lease de livraison,
--    distinct de l'événement lui-même. `accepted` signifie uniquement
--    que Resend a accepté la requête HTTP -- jamais "livré" (réservé à
--    une future preuve webhook email.delivered, hors 0054). `sent`
--    n'est jamais utilisé comme nom de statut.
-- =======================================================================

create table if not exists public.protocol_execution_job_alert_deliveries (
  delivery_id        uuid primary key default gen_random_uuid(),
  alert_event_id     uuid not null unique references public.protocol_execution_job_alerts (alert_event_id),
  status             text not null default 'pending'
                     check (status in ('pending', 'claimed', 'request_sent', 'accepted', 'failed', 'needs_review_delivery')),
  worker_id          text null,
  claim_token        uuid null,
  lease_expires_at   timestamptz null,
  next_attempt_at    timestamptz null,
  attempt_count      integer not null default 0 check (attempt_count >= 0 and attempt_count <= 3),
  created_at         timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'pejad_claim_fields_check'
  ) then
    alter table public.protocol_execution_job_alert_deliveries
      add constraint pejad_claim_fields_check
      check (
        status <> 'claimed'
        or (worker_id is not null and claim_token is not null and lease_expires_at is not null)
      );
  end if;
end $$;

create index if not exists protocol_execution_job_alert_deliveries_status_lease_idx
  on public.protocol_execution_job_alert_deliveries (status, lease_expires_at);

-- DEFECT_05: dedicated to claim_next_pending_alert's own candidate
-- selection (status='pending' and attempt_count<3, ordered by
-- created_at) -- distinct from the sweep index above, which covers
-- (status, lease_expires_at) for the 'claimed'/'request_sent'
-- reconciliation branches instead. `next_attempt_at`'s own comparison
-- against now() cannot be folded into a partial-index predicate
-- (now() is not IMMUTABLE), so it is intentionally left as a residual
-- filter evaluated on the already-narrow set this index produces.
create index if not exists protocol_execution_job_alert_deliveries_pending_claim_idx
  on public.protocol_execution_job_alert_deliveries (created_at)
  where status = 'pending' and attempt_count < 3;

alter table public.protocol_execution_job_alert_deliveries enable row level security;
alter table public.protocol_execution_job_alert_deliveries no force row level security;

revoke all on table public.protocol_execution_job_alert_deliveries from public, anon, authenticated, service_role;
grant select, insert on table public.protocol_execution_job_alert_deliveries to service_role;

-- =======================================================================
-- 4. protocol_execution_job_alert_delivery_attempts — une ligne durable
--    par tentative HTTP réelle. Créée UNE SEULE FOIS en 'request_sent',
--    mise à jour UNE SEULE FOIS vers un outcome terminal, jamais
--    supprimée, jamais remise à 'request_sent'.
-- =======================================================================

create table if not exists public.protocol_execution_job_alert_delivery_attempts (
  attempt_id         uuid primary key default gen_random_uuid(),
  delivery_id        uuid not null references public.protocol_execution_job_alert_deliveries (delivery_id),
  attempt_seq        integer not null check (attempt_seq between 1 and 3),
  idempotency_key    text not null,
  outcome            text not null default 'request_sent'
                     check (outcome in ('request_sent', 'accepted', 'http_error', 'ambiguous_under_24h', 'ambiguous_over_24h')),
  request_sent_at    timestamptz not null default now(),
  finished_at        timestamptz null,
  resend_email_id    text null,
  http_status        integer null,
  error_code         text null
                     check (error_code is null or error_code in (
                       'network_error', 'http_429', 'http_5xx', 'http_4xx_permanent', 'timeout'
                     )),
  created_at         timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pejada_delivery_seq_key') then
    alter table public.protocol_execution_job_alert_delivery_attempts
      add constraint pejada_delivery_seq_key unique (delivery_id, attempt_seq);
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pejada_finished_pair_check') then
    alter table public.protocol_execution_job_alert_delivery_attempts
      add constraint pejada_finished_pair_check
      check (
        (outcome = 'request_sent' and finished_at is null)
        or (outcome <> 'request_sent' and finished_at is not null)
      );
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pejada_resend_id_pair_check') then
    alter table public.protocol_execution_job_alert_delivery_attempts
      add constraint pejada_resend_id_pair_check
      check (
        (outcome = 'accepted' and resend_email_id is not null)
        or (outcome <> 'accepted' and resend_email_id is null)
      );
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pejada_error_code_pair_check') then
    alter table public.protocol_execution_job_alert_delivery_attempts
      add constraint pejada_error_code_pair_check
      check (
        (outcome = 'http_error' and error_code is not null)
        or (outcome <> 'http_error' and error_code is null)
      );
  end if;
end $$;

create index if not exists protocol_execution_job_alert_delivery_attempts_delivery_idx
  on public.protocol_execution_job_alert_delivery_attempts (delivery_id);

alter table public.protocol_execution_job_alert_delivery_attempts enable row level security;
alter table public.protocol_execution_job_alert_delivery_attempts no force row level security;

revoke all on table public.protocol_execution_job_alert_delivery_attempts from public, anon, authenticated, service_role;
grant select, insert, update on table public.protocol_execution_job_alert_delivery_attempts to service_role;
revoke delete, truncate on table public.protocol_execution_job_alert_delivery_attempts from service_role;

-- =======================================================================
-- 5. persist_probe_result_for_job — RPC fencée, race-safe, contenu JSON
--    strictement validé (clés exactes, types, bornes, invariants
--    croisés), hash canonique calculé exclusivement côté serveur.
--    search_path = pg_catalog, pg_temp : aucun objet applicatif n'est
--    résolu via `public` implicite -- chaque référence est qualifiée
--    public.<objet> explicitement (public.probe_results, public.
--    protocol_execution_jobs, public._sha256_hex, etc.).
-- =======================================================================

create or replace function
  public.persist_probe_result_for_job(
    p_job_id uuid,
    p_claim_token uuid,
    p_project_id uuid,
    p_content jsonb
  )
returns table (
  status                  text,
  probe_result_id         uuid,
  canonical_result_sha256 text
)
language plpgsql
security definer
volatile
set search_path = pg_catalog, pg_temp
as $$
declare
  v_allowed_keys text[] := array[
    'product_mentioned', 'product_position', 'competitors_mentioned', 'sources_cited',
    'answer_summary', 'cited_as_source', 'client_source_count', 'platforms_referenced',
    'negative_claim_detected'
  ];
  v_job public.protocol_execution_jobs%rowtype;
  v_attempt public.protocol_attempts%rowtype;
  v_protocol public.protocols%rowtype;
  -- protocols.buyer_question_version_id is a reference, never the text
  -- itself -- the real question text lives on buyer_question_versions.
  -- prompt_text (0047), joined once here, never assumed to be a direct
  -- column on protocols.
  v_buyer_question_version public.buyer_question_versions%rowtype;
  v_probe_run public.probe_runs%rowtype;
  v_analysis_call public.protocol_external_calls%rowtype;
  v_analysis_receipt public.analysis_call_receipts%rowtype;
  v_perplexity_call public.protocol_external_calls%rowtype;
  v_provider_receipt public.provider_call_receipts%rowtype;
  v_max_generation integer;
  v_product_mentioned boolean;
  v_product_position text;
  v_competitors jsonb;
  v_sources jsonb;
  v_answer_summary text;
  v_cited_as_source boolean;
  v_client_source_count integer;
  v_platforms jsonb;
  v_negative_claim_detected boolean;
  v_run_position text;
  v_retry_count integer;
  v_canonical jsonb;
  v_hash text;
  v_new_id uuid;
  v_existing_id uuid;
  v_existing_hash text;
  -- DEFECT_01/03 fix: every JSON number is read into `numeric` first
  -- (a cast that can never fail once jsonb_typeof already confirmed
  -- 'number' -- JSON number syntax is a strict subset of numeric input
  -- syntax) and validated for integer-ness/range BEFORE any `::integer`
  -- cast, which can raise 22P02 (non-integer) or 22003 (out of int4
  -- range) on a bare, unguarded cast.
  v_client_source_count_numeric numeric;
begin
  if p_job_id is null or p_claim_token is null or p_project_id is null or p_content is null then
    raise exception using errcode = '22023', message = 'invalid_persist_probe_result_for_job_args';
  end if;

  if jsonb_typeof(p_content) <> 'object' then
    return query select 'INVALID_CONTENT_KEYS'::text, null::uuid, null::text; return;
  end if;

  -- Exact key set: nothing missing, nothing extra.
  if exists (select 1 from jsonb_object_keys(p_content) k where k <> all (v_allowed_keys))
     or exists (select 1 from unnest(v_allowed_keys) k where not (p_content ? k))
  then
    return query select 'INVALID_CONTENT_KEYS'::text, null::uuid, null::text; return;
  end if;

  -- No JSON null values anywhere in the object.
  if exists (select 1 from jsonb_each(p_content) e where e.value = 'null'::jsonb) then
    return query select 'INVALID_CONTENT_KEYS'::text, null::uuid, null::text; return;
  end if;

  if jsonb_typeof(p_content -> 'product_mentioned') <> 'boolean'
     or jsonb_typeof(p_content -> 'product_position') <> 'string'
     or jsonb_typeof(p_content -> 'competitors_mentioned') <> 'array'
     or jsonb_typeof(p_content -> 'sources_cited') <> 'array'
     or jsonb_typeof(p_content -> 'answer_summary') <> 'string'
     or jsonb_typeof(p_content -> 'cited_as_source') <> 'boolean'
     or jsonb_typeof(p_content -> 'client_source_count') <> 'number'
     or jsonb_typeof(p_content -> 'platforms_referenced') <> 'array'
     or jsonb_typeof(p_content -> 'negative_claim_detected') <> 'boolean'
  then
    return query select 'INVALID_CONTENT_TYPE'::text, null::uuid, null::text; return;
  end if;

  v_product_mentioned := (p_content ->> 'product_mentioned')::boolean;
  v_product_position := p_content ->> 'product_position';
  v_competitors := p_content -> 'competitors_mentioned';
  v_sources := p_content -> 'sources_cited';
  v_answer_summary := p_content ->> 'answer_summary';
  v_cited_as_source := (p_content ->> 'cited_as_source')::boolean;
  -- DEFECT_01: read as numeric first -- jsonb_typeof already confirmed
  -- 'number' above, so this cast can never fail -- then verify exact
  -- integer-ness and int4 range BEFORE the ::integer cast, which would
  -- otherwise raise an uncaught exception (22P02) on a fraction like
  -- 1.5, or (22003) on a value beyond int4 range like 2147483648.
  v_client_source_count_numeric := (p_content ->> 'client_source_count')::numeric;
  if v_client_source_count_numeric <> trunc(v_client_source_count_numeric)
     or v_client_source_count_numeric < 0
     or v_client_source_count_numeric > 2147483647
  then
    return query select 'INVALID_CONTENT_VALUE'::text, null::uuid, null::text; return;
  end if;
  v_client_source_count := v_client_source_count_numeric::integer;
  v_platforms := p_content -> 'platforms_referenced';
  v_negative_claim_detected := (p_content ->> 'negative_claim_detected')::boolean;

  if v_product_position not in ('primary', 'listed', 'negative', 'absent') then
    return query select 'INVALID_CONTENT_VALUE'::text, null::uuid, null::text; return;
  end if;
  if length(v_answer_summary) > 4000 then
    return query select 'INVALID_CONTENT_VALUE'::text, null::uuid, null::text; return;
  end if;
  if v_client_source_count < 0 or v_client_source_count > 50 then
    return query select 'INVALID_CONTENT_VALUE'::text, null::uuid, null::text; return;
  end if;
  if jsonb_array_length(v_competitors) > 50 or jsonb_array_length(v_sources) > 50 or jsonb_array_length(v_platforms) > 20 then
    return query select 'INVALID_CONTENT_VALUE'::text, null::uuid, null::text; return;
  end if;

  -- Nested structure: competitors_mentioned. Three strictly separate
  -- passes -- object-type, then key-set/field-type (never a numeric
  -- cast), then bounds (only once `position` is already confirmed to be
  -- a genuine JSON number) -- so a malformed element (wrong type, wrong
  -- keys, non-numeric position) can never reach a cast that could throw.
  -- A single flat OR list would NOT be safe here: Postgres does not
  -- guarantee short-circuit evaluation of OR branches in a WHERE
  -- clause, so `(el ->> 'position')::numeric` could still be evaluated
  -- (and raise) even when an earlier branch already proved the element
  -- invalid for an unrelated reason (DEFECT_03).
  if exists (select 1 from jsonb_array_elements(v_competitors) el where jsonb_typeof(el) <> 'object') then
    return query select 'INVALID_CONTENT_VALUE'::text, null::uuid, null::text; return;
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_competitors) el
     where (el - array['name', 'position', 'context']) <> '{}'::jsonb
        or not (el ?& array['name', 'position', 'context'])
        or jsonb_typeof(el -> 'name') <> 'string'
        or jsonb_typeof(el -> 'position') <> 'number'
        or jsonb_typeof(el -> 'context') <> 'string'
  ) then
    return query select 'INVALID_CONTENT_VALUE'::text, null::uuid, null::text; return;
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_competitors) el
     where length(el ->> 'name') < 1 or length(el ->> 'name') > 200
        or length(el ->> 'context') > 500
        or (el ->> 'position')::numeric <> trunc((el ->> 'position')::numeric)
        or (el ->> 'position')::numeric < 1
        or (el ->> 'position')::numeric > 500
  ) then
    return query select 'INVALID_CONTENT_VALUE'::text, null::uuid, null::text; return;
  end if;

  -- Nested structure: sources_cited. Same two-pass discipline.
  if exists (select 1 from jsonb_array_elements(v_sources) el where jsonb_typeof(el) <> 'object') then
    return query select 'INVALID_CONTENT_VALUE'::text, null::uuid, null::text; return;
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_sources) el
     where (el - array['source', 'type']) <> '{}'::jsonb
        or not (el ?& array['source', 'type'])
        or jsonb_typeof(el -> 'source') <> 'string'
        or jsonb_typeof(el -> 'type') <> 'string'
        or length(el ->> 'source') < 1 or length(el ->> 'source') > 500
        or (el ->> 'type') not in ('review_site', 'blog', 'forum', 'vendor_site', 'news', 'other')
  ) then
    return query select 'INVALID_CONTENT_VALUE'::text, null::uuid, null::text; return;
  end if;

  if exists (
    select 1 from jsonb_array_elements_text(v_platforms) p where length(p) < 1 or length(p) > 100
  ) then
    return query select 'INVALID_CONTENT_VALUE'::text, null::uuid, null::text; return;
  end if;

  -- Cross invariants: never two contradictory representations persisted.
  if not (
    (v_product_position = 'absent' and v_product_mentioned = false)
    or (v_product_position in ('primary', 'listed', 'negative') and v_product_mentioned = true)
  ) then
    return query select 'INVALID_CONTENT_INVARIANT'::text, null::uuid, null::text; return;
  end if;

  if v_negative_claim_detected <> (v_product_position = 'negative') then
    return query select 'INVALID_CONTENT_INVARIANT'::text, null::uuid, null::text; return;
  end if;

  if v_cited_as_source <> (v_client_source_count > 0) then
    return query select 'INVALID_CONTENT_INVARIANT'::text, null::uuid, null::text; return;
  end if;

  if exists (
    select 1 from jsonb_array_elements_text(v_platforms) plat
     where not exists (
       select 1 from jsonb_array_elements(v_sources) src
        where lower(src ->> 'source') like '%' || lower(plat) || '%'
     )
  ) then
    return query select 'INVALID_CONTENT_INVARIANT'::text, null::uuid, null::text; return;
  end if;

  -- Fencing.
  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id
   for update;

  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::uuid, null::text; return;
  end if;

  if v_job.claim_token is distinct from p_claim_token
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= now()
     or v_job.status not in ('claimed', 'running')
  then
    return query select 'JOB_NOT_OWNED'::text, null::uuid, null::text; return;
  end if;

  if v_job.current_attempt_id is null then
    return query select 'NO_CURRENT_ATTEMPT'::text, null::uuid, null::text; return;
  end if;

  select pa.* into v_attempt
    from public.protocol_attempts pa
   where pa.id = v_job.current_attempt_id and pa.job_id = p_job_id and pa.project_id = p_project_id
   for update;

  if not found then
    return query select 'ATTEMPT_NOT_OWNED_BY_JOB'::text, null::uuid, null::text; return;
  end if;

  -- DEFECT_02: each of these three lookups is guaranteed to succeed by
  -- the schema's own FK chain (protocol_execution_jobs.protocol_id,
  -- protocols.buyer_question_version_id, and protocol_attempts.
  -- probe_run_id once an attempt has actually started) -- but "should
  -- never happen" is not "cannot happen" at the SQL layer, and this
  -- codebase's own established precedent (e.g. CURRENT_ATTEMPT_NOT_FOUND
  -- in retry_analysis_generation_for_job) is to check FOUND explicitly
  -- anyway, rather than let an unexpected NULL propagate into a later
  -- NOT NULL constraint violation on INSERT.
  select p.* into v_protocol
    from public.protocols p
   where p.id = v_job.protocol_id and p.project_id = p_project_id;

  if not found then
    return query select 'PROTOCOL_NOT_FOUND'::text, null::uuid, null::text; return;
  end if;

  select bqv.* into v_buyer_question_version
    from public.buyer_question_versions bqv
   where bqv.id = v_protocol.buyer_question_version_id and bqv.project_id = p_project_id;

  if not found then
    return query select 'BUYER_QUESTION_VERSION_NOT_FOUND'::text, null::uuid, null::text; return;
  end if;

  select pr.* into v_probe_run
    from public.probe_runs pr
   where pr.id = v_attempt.probe_run_id and pr.project_id = p_project_id;

  if not found then
    return query select 'PROBE_RUN_NOT_FOUND'::text, null::uuid, null::text; return;
  end if;

  select max(generation) into v_max_generation
    from public.protocol_external_calls
   where protocol_attempt_id = v_attempt.id and call_kind = 'analysis';

  select ec.* into v_analysis_call
    from public.protocol_external_calls ec
   where ec.protocol_attempt_id = v_attempt.id and ec.call_kind = 'analysis' and ec.generation = v_max_generation;

  if not found then
    return query select 'WRONG_CALL_KIND'::text, null::uuid, null::text; return;
  end if;

  if v_analysis_call.status <> 'completed' then
    return query select 'ANALYSIS_NOT_COMPLETED'::text, null::uuid, null::text; return;
  end if;

  if v_analysis_call.parse_failed_at is not null then
    return query select 'PARSE_ALREADY_MARKED_FAILED'::text, null::uuid, null::text; return;
  end if;

  select r.* into v_analysis_receipt
    from public.analysis_call_receipts r
   where r.external_call_id = v_analysis_call.id;

  if not found then
    return query select 'RECEIPT_NOT_FOUND'::text, null::uuid, null::text; return;
  end if;

  select ec.* into v_perplexity_call
    from public.protocol_external_calls ec
   where ec.protocol_attempt_id = v_attempt.id and ec.call_kind = 'perplexity' and ec.generation = 1;

  select r.* into v_provider_receipt
    from public.provider_call_receipts r
   where r.external_call_id = v_perplexity_call.id;

  if not found then
    return query select 'RECEIPT_NOT_FOUND'::text, null::uuid, null::text; return;
  end if;

  v_run_position := case v_product_position
    when 'primary' then 'primary_in_run'
    when 'listed' then 'listed_in_run'
    when 'negative' then 'listed_in_run'
    when 'absent' then 'not_observed_in_run'
  end;

  v_retry_count := v_analysis_call.generation - 1;

  -- Canonical JSON: schema_version + every persisted lineage/parsed/
  -- derived field except probe_results.id (own generated UUID) and
  -- created_at (non-semantic timestamp) -- the only two exclusions the
  -- design allows without individual justification. generated_prompt_id
  -- and snapshot_request_id (always NULL for M5, no M1/M2 equivalent
  -- exists) are individually justified exclusions, per D-028.
  v_canonical := jsonb_build_object(
    'schema_version', 1,
    'probe_run_id', v_attempt.probe_run_id,
    'project_id', p_project_id,
    'prompt', v_buyer_question_version.prompt_text,
    'platform', 'perplexity',
    'raw_response', v_provider_receipt.raw_response_body,
    'client_mentioned', v_product_mentioned,
    'client_position', v_product_position,
    'competitors_mentioned', v_competitors,
    'sources_cited', v_sources,
    'answer_summary', v_answer_summary,
    'verdict', 'not_evaluated',
    'why_client_lost', '',
    'probe_mode', v_probe_run.probe_mode,
    'raw_probe_request', v_buyer_question_version.prompt_text,
    'product_mentioned', v_product_mentioned,
    'product_position', v_product_position,
    'product_verdict', 'not_evaluated',
    'cited_as_source', v_cited_as_source,
    'client_source_count', v_client_source_count,
    'platforms_referenced', v_platforms,
    'raw_response_sha256', v_provider_receipt.raw_response_sha256,
    'raw_probe_request_sha256', public._sha256_hex(v_buyer_question_version.prompt_text),
    'full_request_body_sha256', null,
    'provider_http_status', v_provider_receipt.http_status,
    'provider_latency_ms', v_provider_receipt.latency_ms,
    'provider_request_id', v_provider_receipt.provider_request_id,
    'provider_model', null,
    'retry_count', v_retry_count,
    'raw_response_body', null,
    'raw_response_body_sha256', null,
    'dataset_id', v_job.dataset_batch_id,
    'dataset_source_type', 'protocol_execution_job',
    'run_position', v_run_position,
    'negative_claim_detected', v_negative_claim_detected,
    'observation_schema_version', 1
  );
  v_hash := public._sha256_hex(v_canonical::text);

  insert into public.probe_results (
    probe_run_id, project_id, prompt, platform, raw_response,
    client_mentioned, client_position, competitors_mentioned, sources_cited, answer_summary,
    verdict, why_client_lost, probe_mode, raw_probe_request,
    product_mentioned, product_position, product_verdict, cited_as_source, client_source_count, platforms_referenced,
    raw_response_sha256, raw_probe_request_sha256, full_request_body_sha256,
    provider_http_status, provider_latency_ms, provider_request_id, provider_model, retry_count,
    raw_response_body, raw_response_body_sha256,
    dataset_id, dataset_source_type, run_position, negative_claim_detected, observation_schema_version,
    canonical_result_sha256
  ) values (
    v_attempt.probe_run_id, p_project_id, v_buyer_question_version.prompt_text, 'perplexity', v_provider_receipt.raw_response_body,
    v_product_mentioned, v_product_position, v_competitors, v_sources, v_answer_summary,
    'not_evaluated', '', v_probe_run.probe_mode, v_buyer_question_version.prompt_text,
    v_product_mentioned, v_product_position, 'not_evaluated', v_cited_as_source, v_client_source_count, v_platforms,
    v_provider_receipt.raw_response_sha256, public._sha256_hex(v_buyer_question_version.prompt_text), null,
    v_provider_receipt.http_status, v_provider_receipt.latency_ms, v_provider_receipt.provider_request_id, null, v_retry_count,
    null, null,
    v_job.dataset_batch_id, 'protocol_execution_job', v_run_position, v_negative_claim_detected, 1,
    v_hash
  )
  on conflict (probe_run_id) do nothing
  returning id into v_new_id;

  if v_new_id is not null then
    return query select 'PERSISTED'::text, v_new_id, v_hash; return;
  end if;

  select pr.id, pr.canonical_result_sha256 into v_existing_id, v_existing_hash
    from public.probe_results pr where pr.probe_run_id = v_attempt.probe_run_id;

  if v_existing_hash = v_hash then
    return query select 'ALREADY_PERSISTED'::text, v_existing_id, v_existing_hash; return;
  else
    return query select 'CONFLICT'::text, v_existing_id, v_existing_hash; return;
  end if;
end;
$$;

revoke all on function
  public.persist_probe_result_for_job(uuid, uuid, uuid, jsonb) from public;
revoke all on function
  public.persist_probe_result_for_job(uuid, uuid, uuid, jsonb) from anon;
revoke all on function
  public.persist_probe_result_for_job(uuid, uuid, uuid, jsonb) from authenticated;
grant execute on function
  public.persist_probe_result_for_job(uuid, uuid, uuid, jsonb) to service_role;

-- =======================================================================
-- 6. record_provider_call_receipt_for_job (0052) redefined: identical
--    body, only the needs_review transition is now wrapped in a CTE
--    that also inserts the outbox event from its own RETURNING, in the
--    same statement/transaction. Signature unchanged (13 args) -- no
--    DROP needed.
-- =======================================================================

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
    with transitioned as (
      update public.protocol_execution_jobs j
         set status = 'needs_review',
             needs_review_reason = 'perplexity_outcome_unknown',
             updated_at = now()
       where j.id = p_job_id and j.status in ('claimed', 'running')
      returning j.id, j.project_id
    ),
    inserted_alert as (
      insert into public.protocol_execution_job_alerts (
        project_id, job_id, event_type, reason_code, source_attempt_id, source_external_call_id
      )
      select t.project_id, t.id, 'needs_review', 'perplexity_outcome_unknown', v_call.protocol_attempt_id, p_external_call_id
        from transitioned t
      returning alert_event_id
    )
    insert into public.protocol_execution_job_alert_deliveries (alert_event_id)
    select alert_event_id from inserted_alert;
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
-- 7. record_analysis_call_receipt_for_job (0053, 16 args) redefined:
--    identical body, same outbox-CTE addition as above (reason
--    'analysis_outcome_unknown'). Signature unchanged -- no DROP needed.
-- =======================================================================

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
    with transitioned as (
      update public.protocol_execution_jobs j
         set status = 'needs_review',
             needs_review_reason = 'analysis_outcome_unknown',
             updated_at = now()
       where j.id = p_job_id and j.status in ('claimed', 'running')
      returning j.id, j.project_id
    ),
    inserted_alert as (
      insert into public.protocol_execution_job_alerts (
        project_id, job_id, event_type, reason_code, source_attempt_id, source_external_call_id
      )
      select t.project_id, t.id, 'needs_review', 'analysis_outcome_unknown', v_call.protocol_attempt_id, p_external_call_id
        from transitioned t
      returning alert_event_id
    )
    insert into public.protocol_execution_job_alert_deliveries (alert_event_id)
    select alert_event_id from inserted_alert;
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
-- 8. mark_protocol_execution_job_needs_review_for_ambiguity (0051)
--    redefined: identical body, same outbox-CTE addition (reason
--    'ambiguous_external_call_sent_without_receipt'). Signature
--    unchanged (3 args) -- no DROP needed.
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

  with transitioned as (
    update public.protocol_execution_jobs
       set status = 'needs_review',
           needs_review_reason = 'ambiguous_external_call_sent_without_receipt',
           updated_at = now()
     where id = p_job_id and project_id = p_project_id
    returning *
  ),
  inserted_alert as (
    insert into public.protocol_execution_job_alerts (
      project_id, job_id, event_type, reason_code, source_attempt_id
    )
    select project_id, id, 'needs_review', 'ambiguous_external_call_sent_without_receipt', current_attempt_id
      from transitioned
    returning alert_event_id
  ),
  outbox as (
    insert into public.protocol_execution_job_alert_deliveries (alert_event_id)
    select alert_event_id from inserted_alert
  )
  select * into v_job from transitioned;

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
-- 9. claim_protocol_execution_job (0050) redefined: identical body, the
--    'abandoned_exhausted' sweep is now a CTE that also inserts the
--    outbox event from its own RETURNING (reason 'attempts_exhausted').
--    Signature unchanged (2 args) -- no DROP needed.
-- =======================================================================

create or replace function
  public.claim_protocol_execution_job(
    p_worker_id text,
    p_lease_seconds integer
  )
returns table (
  status      text,
  job         public.protocol_execution_jobs,
  claim_token uuid
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  v_token uuid;
begin
  if p_worker_id is null or btrim(p_worker_id) = ''
     or p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception using
      errcode = '22023',
      message = 'invalid_claim_protocol_execution_job_args';
  end if;

  with abandoned as (
    update public.protocol_execution_jobs j
       set status = 'abandoned_exhausted', updated_at = now()
     where j.status in ('claimed', 'running')
       and j.lease_expires_at < now()
       and j.attempt_count >= j.max_attempts
    returning j.id, j.project_id
  ),
  inserted_alerts as (
    insert into public.protocol_execution_job_alerts (project_id, job_id, event_type, reason_code)
    select project_id, id, 'abandoned_exhausted', 'attempts_exhausted'
      from abandoned
    returning alert_event_id
  )
  insert into public.protocol_execution_job_alert_deliveries (alert_event_id)
  select alert_event_id from inserted_alerts;

  select j.* into v_job
    from public.protocol_execution_jobs j
   where (
       j.status = 'queued'
       or (j.status in ('claimed', 'running') and j.lease_expires_at < now() and j.attempt_count < j.max_attempts)
     )
   order by j.created_at asc
   for update skip locked
   limit 1;

  if not found then
    return query select 'NO_JOB_AVAILABLE'::text, null::public.protocol_execution_jobs, null::uuid;
    return;
  end if;

  v_token := gen_random_uuid();

  update public.protocol_execution_jobs
     set status = 'claimed',
         worker_id = p_worker_id,
         claim_token = v_token,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempt_count = attempt_count + 1,
         updated_at = now()
   where id = v_job.id
  returning * into v_job;

  return query select 'CLAIMED'::text, v_job, v_token;
end;
$$;

revoke all on function
  public.claim_protocol_execution_job(text, integer) from public;
revoke all on function
  public.claim_protocol_execution_job(text, integer) from anon;
revoke all on function
  public.claim_protocol_execution_job(text, integer) from authenticated;
grant execute on function
  public.claim_protocol_execution_job(text, integer) to service_role;

-- =======================================================================
-- 10. claim_next_pending_alert — fencing/lease identical in spirit to
--     claim_protocol_execution_job. Also atomically reconciles stale
--     deliveries (claimed-with-expired-lease, request_sent-with-
--     expired-lease under/over 24h) before selecting a candidate, so a
--     crashed alert worker can never leave a delivery stuck. Payload
--     closed and free of raw body/prompt/free text.
-- =======================================================================

create or replace function
  public.claim_next_pending_alert(
    p_worker_id text,
    p_lease_seconds integer
  )
returns table (
  status                         text,
  delivery_id                    uuid,
  alert_event_id                 uuid,
  claim_token                    uuid,
  attempt_count                  integer,
  project_id                     uuid,
  job_id                         uuid,
  event_type                     text,
  reason_code                    text,
  idempotency_key                text,
  reconciled_stale_claimed_count integer,
  reconciled_under_24h_count     integer,
  reconciled_over_24h_count      integer
)
language plpgsql
security definer
volatile
set search_path = pg_catalog, pg_temp
as $$
declare
  v_reconciled_claimed integer := 0;
  v_reconciled_under24 integer := 0;
  v_reconciled_over24 integer := 0;
  v_delivery public.protocol_execution_job_alert_deliveries%rowtype;
  v_alert public.protocol_execution_job_alerts%rowtype;
  v_token uuid;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' or p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception using errcode = '22023', message = 'invalid_claim_next_pending_alert_args';
  end if;

  -- A. claimed, lease expired, no request_sent attempt in flight -> pending.
  with reset_claimed as (
    update public.protocol_execution_job_alert_deliveries d
       set status = 'pending', worker_id = null, claim_token = null, lease_expires_at = null
     where d.status = 'claimed' and d.lease_expires_at < now()
       and not exists (
         select 1 from public.protocol_execution_job_alert_delivery_attempts a
          where a.delivery_id = d.delivery_id and a.outcome = 'request_sent'
       )
    returning d.delivery_id
  )
  select count(*) into v_reconciled_claimed from reset_claimed;

  -- B/C. request_sent, lease expired -- reconciled by attempt age; each
  -- UPDATE re-checks outcome/status in its own WHERE clause so a
  -- concurrent record_alert_delivery_receipt can never race this sweep
  -- into terminalizing the same attempt twice.
  with stale as (
    select d.delivery_id, a.attempt_id, a.request_sent_at, d.attempt_count,
           (now() - a.request_sent_at < interval '24 hours') as is_under_24h
      from public.protocol_execution_job_alert_deliveries d
      join public.protocol_execution_job_alert_delivery_attempts a
        on a.delivery_id = d.delivery_id and a.outcome = 'request_sent'
     where d.status = 'request_sent' and d.lease_expires_at < now()
  ),
  terminalized as (
    update public.protocol_execution_job_alert_delivery_attempts a
       set outcome = case when s.is_under_24h then 'ambiguous_under_24h' else 'ambiguous_over_24h' end,
           finished_at = now()
      from stale s
     where a.attempt_id = s.attempt_id and a.outcome = 'request_sent'
    returning a.attempt_id, s.delivery_id, s.is_under_24h, s.attempt_count
  ),
  applied as (
    update public.protocol_execution_job_alert_deliveries d
       set status = case when t.is_under_24h and t.attempt_count < 3 then 'pending' else 'needs_review_delivery' end,
           next_attempt_at = case when t.is_under_24h and t.attempt_count < 3 then now() else null end,
           worker_id = null, claim_token = null, lease_expires_at = null
      from terminalized t
     where d.delivery_id = t.delivery_id
    returning t.is_under_24h, (t.is_under_24h and t.attempt_count < 3) as retried
  )
  select
    coalesce(count(*) filter (where retried), 0), coalesce(count(*) filter (where not retried), 0)
    into v_reconciled_under24, v_reconciled_over24
    from applied;

  select d.* into v_delivery
    from public.protocol_execution_job_alert_deliveries d
   where d.status = 'pending'
     and (d.next_attempt_at is null or d.next_attempt_at <= now())
     and d.attempt_count < 3
   order by d.created_at asc
   for update skip locked
   limit 1;

  if not found then
    return query select
      'NO_ALERT_AVAILABLE'::text, null::uuid, null::uuid, null::uuid, null::integer,
      null::uuid, null::uuid, null::text, null::text, null::text,
      v_reconciled_claimed, v_reconciled_under24, v_reconciled_over24;
    return;
  end if;

  v_token := gen_random_uuid();

  update public.protocol_execution_job_alert_deliveries d
     set status = 'claimed', worker_id = p_worker_id, claim_token = v_token,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   where d.delivery_id = v_delivery.delivery_id
  returning * into v_delivery;

  select a.* into v_alert
    from public.protocol_execution_job_alerts a
   where a.alert_event_id = v_delivery.alert_event_id;

  return query select
    'CLAIMED'::text, v_delivery.delivery_id, v_alert.alert_event_id, v_token, v_delivery.attempt_count,
    v_alert.project_id, v_alert.job_id, v_alert.event_type, v_alert.reason_code,
    ('m5-alert:' || v_alert.alert_event_id::text),
    v_reconciled_claimed, v_reconciled_under24, v_reconciled_over24;
end;
$$;

revoke all on function
  public.claim_next_pending_alert(text, integer) from public;
revoke all on function
  public.claim_next_pending_alert(text, integer) from anon;
revoke all on function
  public.claim_next_pending_alert(text, integer) from authenticated;
grant execute on function
  public.claim_next_pending_alert(text, integer) to service_role;

-- =======================================================================
-- 11. renew_alert_lease
-- =======================================================================

create or replace function
  public.renew_alert_lease(
    p_delivery_id uuid,
    p_claim_token uuid,
    p_lease_seconds integer
  )
returns table (
  status      text,
  delivery_id uuid
)
language plpgsql
security definer
volatile
set search_path = pg_catalog, pg_temp
as $$
declare
  v_delivery public.protocol_execution_job_alert_deliveries%rowtype;
begin
  if p_delivery_id is null or p_claim_token is null or p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception using errcode = '22023', message = 'invalid_renew_alert_lease_args';
  end if;

  select d.* into v_delivery
    from public.protocol_execution_job_alert_deliveries d
   where d.delivery_id = p_delivery_id
   for update;

  if not found then
    return query select 'DELIVERY_NOT_FOUND'::text, null::uuid;
    return;
  end if;

  if v_delivery.claim_token is distinct from p_claim_token
     or v_delivery.lease_expires_at is null or v_delivery.lease_expires_at <= now()
     or v_delivery.status not in ('claimed', 'request_sent') then
    return query select 'DELIVERY_NOT_OWNED'::text, null::uuid;
    return;
  end if;

  update public.protocol_execution_job_alert_deliveries d
     set lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   where d.delivery_id = p_delivery_id;

  return query select 'RENEWED'::text, p_delivery_id;
end;
$$;

revoke all on function
  public.renew_alert_lease(uuid, uuid, integer) from public;
revoke all on function
  public.renew_alert_lease(uuid, uuid, integer) from anon;
revoke all on function
  public.renew_alert_lease(uuid, uuid, integer) from authenticated;
grant execute on function
  public.renew_alert_lease(uuid, uuid, integer) to service_role;

-- =======================================================================
-- 12. mark_alert_request_sent — creates the delivery_attempts row
--     immediately before the real HTTP call (never after); enforces the
--     three-attempt cap before creating a row, never after.
-- =======================================================================

create or replace function
  public.mark_alert_request_sent(
    p_delivery_id uuid,
    p_claim_token uuid
  )
returns table (
  status          text,
  attempt_id      uuid,
  attempt_seq     integer,
  idempotency_key text
)
language plpgsql
security definer
volatile
set search_path = pg_catalog, pg_temp
as $$
declare
  v_delivery public.protocol_execution_job_alert_deliveries%rowtype;
  v_next_seq integer;
  v_attempt_id uuid;
  v_key text;
begin
  if p_delivery_id is null or p_claim_token is null then
    raise exception using errcode = '22023', message = 'invalid_mark_alert_request_sent_args';
  end if;

  select d.* into v_delivery
    from public.protocol_execution_job_alert_deliveries d
   where d.delivery_id = p_delivery_id
   for update;

  if not found then
    return query select 'DELIVERY_NOT_FOUND'::text, null::uuid, null::integer, null::text;
    return;
  end if;

  if v_delivery.claim_token is distinct from p_claim_token
     or v_delivery.lease_expires_at is null or v_delivery.lease_expires_at <= now()
     or v_delivery.status <> 'claimed' then
    return query select 'DELIVERY_NOT_OWNED'::text, null::uuid, null::integer, null::text;
    return;
  end if;

  if v_delivery.attempt_count >= 3 then
    return query select 'ALERT_ATTEMPT_CAP_EXCEEDED'::text, null::uuid, null::integer, null::text;
    return;
  end if;

  v_next_seq := v_delivery.attempt_count + 1;
  v_key := 'm5-alert:' || v_delivery.alert_event_id::text;

  insert into public.protocol_execution_job_alert_delivery_attempts as a (
    delivery_id, attempt_seq, idempotency_key, outcome, request_sent_at
  ) values (
    p_delivery_id, v_next_seq, v_key, 'request_sent', now()
  )
  returning a.attempt_id into v_attempt_id;

  update public.protocol_execution_job_alert_deliveries
     set status = 'request_sent', attempt_count = v_next_seq
   where delivery_id = p_delivery_id;

  return query select 'REQUEST_MARKED_SENT'::text, v_attempt_id, v_next_seq, v_key;
end;
$$;

revoke all on function
  public.mark_alert_request_sent(uuid, uuid) from public;
revoke all on function
  public.mark_alert_request_sent(uuid, uuid) from anon;
revoke all on function
  public.mark_alert_request_sent(uuid, uuid) from authenticated;
grant execute on function
  public.mark_alert_request_sent(uuid, uuid) to service_role;

-- =======================================================================
-- 13. record_alert_delivery_receipt — the single terminal update of one
--     delivery_attempts row. Re-checks claim_token/lease/delivery
--     status/attempt outcome all in the same gated UPDATE so a
--     concurrent stale-reconciliation sweep (claim_next_pending_alert)
--     can never terminalize the same attempt twice: zero rows updated
--     -> ATTEMPT_ALREADY_TERMINAL or DELIVERY_NOT_OWNED, never a blind
--     overwrite. Jitter (+/-20%) computed server-side via random().
-- =======================================================================

create or replace function
  public.record_alert_delivery_receipt(
    p_delivery_id uuid,
    p_claim_token uuid,
    p_attempt_id uuid,
    p_outcome text,
    p_http_status integer default null,
    p_resend_email_id text default null,
    p_error_code text default null
  )
returns table (
  status                text,
  delivery_id           uuid,
  final_delivery_status text
)
language plpgsql
security definer
volatile
set search_path = pg_catalog, pg_temp
as $$
declare
  v_delivery public.protocol_execution_job_alert_deliveries%rowtype;
  v_next_status text;
  v_next_attempt_at timestamptz;
  v_jitter numeric;
  v_updated integer;
begin
  if p_delivery_id is null or p_claim_token is null or p_attempt_id is null or p_outcome is null then
    raise exception using errcode = '22023', message = 'invalid_record_alert_delivery_receipt_args';
  end if;

  if p_outcome not in ('accepted', 'http_error', 'ambiguous_under_24h', 'ambiguous_over_24h') then
    return query select 'INVALID_OUTCOME'::text, null::uuid, null::text;
    return;
  end if;

  select d.* into v_delivery
    from public.protocol_execution_job_alert_deliveries d
   where d.delivery_id = p_delivery_id
   for update;

  if not found then
    return query select 'DELIVERY_NOT_FOUND'::text, null::uuid, null::text;
    return;
  end if;

  if v_delivery.claim_token is distinct from p_claim_token
     or v_delivery.lease_expires_at is null or v_delivery.lease_expires_at <= now()
     or v_delivery.status <> 'request_sent' then
    return query select 'DELIVERY_NOT_OWNED'::text, null::uuid, null::text;
    return;
  end if;

  update public.protocol_execution_job_alert_delivery_attempts att
     set outcome = p_outcome,
         finished_at = now(),
         resend_email_id = case when p_outcome = 'accepted' then p_resend_email_id else null end,
         http_status = p_http_status,
         error_code = case when p_outcome = 'http_error' then p_error_code else null end
   where attempt_id = p_attempt_id and att.delivery_id = p_delivery_id and outcome = 'request_sent';

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return query select 'ATTEMPT_ALREADY_TERMINAL'::text, null::uuid, null::text;
    return;
  end if;

  v_jitter := 0.8 + (random() * 0.4);

  if p_outcome = 'accepted' then
    v_next_status := 'accepted';
    v_next_attempt_at := null;
  elsif p_outcome = 'http_error' then
    if p_error_code = 'http_4xx_permanent' or v_delivery.attempt_count >= 3 then
      v_next_status := 'failed';
      v_next_attempt_at := null;
    else
      v_next_status := 'pending';
      v_next_attempt_at := now() + make_interval(secs => (case v_delivery.attempt_count when 1 then 30 else 300 end) * v_jitter);
    end if;
  elsif p_outcome = 'ambiguous_under_24h' then
    if v_delivery.attempt_count >= 3 then
      v_next_status := 'needs_review_delivery';
      v_next_attempt_at := null;
    else
      v_next_status := 'pending';
      v_next_attempt_at := now();
    end if;
  else
    v_next_status := 'needs_review_delivery';
    v_next_attempt_at := null;
  end if;

  update public.protocol_execution_job_alert_deliveries d
     set status = v_next_status, next_attempt_at = v_next_attempt_at,
         worker_id = null, claim_token = null, lease_expires_at = null
   where d.delivery_id = p_delivery_id;

  return query select 'RECEIPT_RECORDED'::text, p_delivery_id, v_next_status;
end;
$$;

revoke all on function
  public.record_alert_delivery_receipt(uuid, uuid, uuid, text, integer, text, text) from public;
revoke all on function
  public.record_alert_delivery_receipt(uuid, uuid, uuid, text, integer, text, text) from anon;
revoke all on function
  public.record_alert_delivery_receipt(uuid, uuid, uuid, text, integer, text, text) from authenticated;
grant execute on function
  public.record_alert_delivery_receipt(uuid, uuid, uuid, text, integer, text, text) to service_role;
