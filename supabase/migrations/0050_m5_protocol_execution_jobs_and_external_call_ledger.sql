-- M5 — worker durable, fencing par job, ledger par appel externe.
-- DRAFT migration. Not applied to any database by this commit.
--
-- Option B+ : un job durable existe à la granularité d'une exécution
-- baseline (jamais le retest — M7). Le job possède le claim/bail/
-- fencing. protocol_attempts reste le ledger financier par tentative,
-- désormais rattaché à son job via une colonne nullable job_id.
--
-- Deux appels externes par tentative, chacun avec sa propre ligne
-- append-only dans protocol_external_calls (call_kind in
-- ('perplexity','analysis')) : Perplexity est toujours génération 1
-- seule (une issue incertaine met tout le job en needs_review plutôt
-- que de créer une nouvelle génération) ; l'analyse peut avoir
-- plusieurs générations, bornées par retry_cap + 1, chacune réservant
-- son propre coût sous verrou du protocole.
--
-- Compatibilité historique : protocol_attempts.job_id est la SEULE
-- nouvelle colonne ajoutée à protocol_attempts — nullable, sans
-- backfill. Les 4 lignes réelles déjà présentes en staging (smoke4)
-- restent job_id = null indéfiniment ; aucune contrainte NOT NULL,
-- aucune contrainte conditionnelle supplémentaire n'est ajoutée sur
-- protocol_attempts au-delà de cette nullabilité.
--
-- Un seul job baseline par protocole : UNIQUE(protocol_id) TOTALE (pas
-- partielle). Un job expiré/abandonné est toujours réclamé ou réactivé
-- SUR LA MÊME LIGNE, jamais remplacé. Sortir de needs_review passe par
-- authorize_operator_retry (-> queued). Sortir de abandoned_exhausted
-- passe par reactivate_abandoned_job (audité, remet attempt_count à 0,
-- ne touche jamais protocol_attempts/protocol_external_calls).
--
-- Admission atomique : _admit_and_reserve_attempt_core est un nouveau
-- coeur privé, SECURITY DEFINER, contenant le corps EXACT de l'admit_
-- and_reserve_attempt original de la migration 0047, avec un paramètre
-- supplémentaire p_job_id porté par le MÊME insert final (jamais un
-- UPDATE séparé). admit_and_reserve_attempt (signature externe
-- inchangée) est réécrit via CREATE OR REPLACE (même technique que
-- 0049) pour déléguer à ce coeur avec job_id := null — son corps 0047
-- original n'est pas modifié dans le fichier 0047 lui-même, mais son
-- comportement runtime est désormais celui du coeur partagé. start_
-- attempt et reconcile_attempt (0047) restent byte-for-byte inchangés
-- — seul leur EXECUTE est révoqué à service_role plus bas.
--
-- reconcile_attempt_for_job N'APPELLE PAS reconcile_attempt (0047) —
-- celui-ci exige p_actual_cost_usd non nul, ce qui est incompatible
-- avec la règle « une tentative peut être completed avec
-- actual_cost_usd = NULL si une génération d'analyse terminale a un
-- coût inconnu ». reconcile_attempt_for_job calcule directement cette
-- somme depuis protocol_external_calls et implémente sa propre écriture
-- sur protocol_attempts.
--
-- Coût : quatre natures possibles pour actual_cost_usd — measured,
-- estimated, ou NULL (unknown, jamais copié depuis reserved_cost_usd).
-- La contrainte protocol_external_calls_cost_basis_pair_check est la
-- garantie structurelle qu'une réservation n'est jamais enregistrée
-- comme un coût réel : (actual_cost_usd is null) = (cost_basis is null).
--
-- probe_run_id : nullable en 'reserved' ; obligatoire dès que
-- request_sent_at est renseigné (contrainte
-- protocol_external_calls_probe_run_lifecycle_check) ; obligatoire pour
-- tout reçu (colonne NOT NULL sur provider_call_receipts et
-- analysis_call_receipts) ; l'association ne se fait que via
-- mark_external_call_sent_for_job (RPC fencée), jamais un UPDATE brut.
-- L'appel 'analysis' réutilise le MÊME probe_run_id que son 'perplexity'
-- frère de la même tentative — probe_run_id identifie quelle exécution
-- de sonde est analysée, pas seulement qui l'a produite.
--
-- Fencing : chaque mutation worker (admission, start, envoi, reçu,
-- réservation supplémentaire, réconciliation, complétion, échec du job)
-- verrouille protocol_execution_jobs FOR UPDATE et vérifie job_id +
-- claim_token exact + lease_expires_at > now() + project_id ; en cas de
-- désaccord elle renvoie un statut explicite (JOB_NOT_OWNED, etc.),
-- jamais une exception qui masquerait un refus silencieux. Un ancien
-- worker au bail expiré échoue donc ce contrôle avant toute écriture.
--
-- Gate de complétion (D-020) : protocol_execution_jobs.current_attempt_id
-- (nullable avant admission) référence, via une FK composite
-- (current_attempt_id, id, project_id) -> protocol_attempts
-- (id, job_id, project_id), la tentative que le job possède
-- actuellement — jamais une tentative d'un autre job, même du même
-- projet. admit_and_reserve_attempt_for_job la définit atomiquement ;
-- authorize_operator_retry ne la remplace que dans sa branche
-- retry_full_attempt (retry_analysis_only la laisse intacte).
-- complete_protocol_execution_job ne marque plus jamais succeeded sans
-- preuve : la tentative courante doit être réconciliée et completed,
-- l'appel Perplexity génération 1 doit être completed avec son reçu, et
-- la génération analysis la plus RÉCENTE de cette tentative (jamais une
-- génération antérieure) doit être completed avec son reçu — les
-- générations antérieures restent append-only et comptent dans la
-- réconciliation des coûts, sans jamais déterminer le résultat. Un coût
-- inconnu honnêtement réconcilié n'est jamais rejeté. Une répétition
-- après succès renvoie ALREADY_SUCCEEDED (aucune mutation) ; un autre
-- état terminal renvoie CONFLICT (aucune mutation) ; ces deux tests
-- précèdent le fencing, puisqu'un job déjà terminal n'a plus de
-- propriétaire actif à valider.
--
-- ACL : EXECUTE est révoqué à service_role sur admit_and_reserve_attempt,
-- start_attempt, reconcile_attempt (0047) — ils restent appelables en
-- interne (fonction à fonction, sous l'autorité SECURITY DEFINER du
-- propriétaire) mais plus directement par service_role. Les nouvelles
-- tables ne reçoivent que SELECT pour service_role — aucune écriture
-- directe ; chaque écriture passe par une RPC fencée. Les fonctions
-- privées (préfixées _) ne reçoivent EXECUTE d'aucun rôle, y compris
-- service_role.
--
-- Ce que cette migration NE fait PAS :
--   * Ne modifie pas les migrations 0047, 0048, 0049 elles-mêmes (les
--     fichiers restent inchangés) ; seul admit_and_reserve_attempt est
--     redéfini par CREATE OR REPLACE, exactement comme 0049 l'a déjà
--     fait pour approve_protocol/start_attempt.
--   * Ne backfill aucune ligne existante (protocol_attempts.job_id
--     reste null pour les 4 tentatives réelles déjà en staging).
--   * Ne câble pas encore lib/pipeline/run-protocol-gated-baseline.ts
--     ni scripts/mvp-scan.ts sur ces nouvelles RPC — c'est une tranche
--     d'implémentation ultérieure, hors périmètre M5-1.
--   * Ne référence aucun 5×3/$2 legacy ni verdict won/partial/lost.
--   * Ne s'applique à, ni ne se connecte à, aucune base staging ou
--     Production — ce fichier est créé localement uniquement.

-- ---------------------------------------------------------------------
-- 0. probe_runs(id, project_id) — contrainte composite additive, sans
--    changement de données. N'existe pas aujourd'hui (vérifié par grep
--    sur pg_constraint / le texte de 0003_probe_analysis.sql).
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'probe_runs_id_project_key'
  ) then
    alter table public.probe_runs
      add constraint probe_runs_id_project_key unique (id, project_id);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. protocol_execution_jobs — un job baseline par protocole (UNIQUE
--    totale). RPC-only en écriture ; service_role ne reçoit que SELECT.
-- ---------------------------------------------------------------------

create table if not exists public.protocol_execution_jobs (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references public.projects (id) on delete cascade,
  protocol_id          uuid not null references public.protocols (id) on delete restrict,
  status               text not null default 'queued'
                        check (status in (
                          'queued', 'claimed', 'running', 'succeeded',
                          'failed', 'needs_review', 'abandoned_exhausted'
                        )),
  worker_id            text null,
  claim_token          uuid null,
  lease_expires_at     timestamptz null,
  attempt_count        integer not null default 0 check (attempt_count >= 0),
  max_attempts         integer not null check (max_attempts >= 1),
  needs_review_reason  text null,
  failure_reason       text null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- Un job possédé (claimed/running) porte toujours ses trois champs de
  -- bail ; un job non possédé (queued ou tout statut terminal) n'est
  -- jamais contraint dans l'autre sens — un job terminal garde son
  -- dernier claim_token/worker_id comme trace d'audit.
  constraint protocol_execution_jobs_claim_fields_check check (
    status not in ('claimed', 'running')
    or (worker_id is not null and claim_token is not null and lease_expires_at is not null)
  )
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_execution_jobs_id_project_key'
  ) then
    alter table public.protocol_execution_jobs
      add constraint protocol_execution_jobs_id_project_key unique (id, project_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_execution_jobs_protocol_id_key'
  ) then
    alter table public.protocol_execution_jobs
      add constraint protocol_execution_jobs_protocol_id_key unique (protocol_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_execution_jobs_protocol_project_fk'
  ) then
    alter table public.protocol_execution_jobs
      add constraint protocol_execution_jobs_protocol_project_fk
      foreign key (protocol_id, project_id)
      references public.protocols (id, project_id);
  end if;
end $$;

create index if not exists protocol_execution_jobs_project_idx
  on public.protocol_execution_jobs (project_id);
create index if not exists protocol_execution_jobs_status_lease_idx
  on public.protocol_execution_jobs (status, lease_expires_at);

alter table public.protocol_execution_jobs enable row level security;
alter table public.protocol_execution_jobs no force row level security;

revoke all on table public.protocol_execution_jobs from public, anon, authenticated, service_role;
grant select on table public.protocol_execution_jobs to service_role;

-- ---------------------------------------------------------------------
-- 2. protocol_external_calls — un ledger par appel externe (Perplexity
--    ou analyse), une ligne par (protocol_attempt_id, call_kind,
--    generation). RPC-only ; service_role ne reçoit que SELECT.
-- ---------------------------------------------------------------------

create table if not exists public.protocol_external_calls (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references public.projects (id) on delete cascade,
  protocol_attempt_id  uuid not null references public.protocol_attempts (id) on delete restrict,
  call_kind            text not null check (call_kind in ('perplexity', 'analysis')),
  generation           integer not null check (generation >= 1),
  status               text not null
                        check (status in (
                          'reserved', 'in_progress', 'completed',
                          'failed', 'timed_out', 'cancelled'
                        )),
  reserved_cost_usd    numeric not null check (reserved_cost_usd >= 0),
  actual_cost_usd      numeric null check (actual_cost_usd is null or actual_cost_usd >= 0),
  cost_basis           text null check (cost_basis is null or cost_basis in ('measured', 'estimated')),
  probe_run_id         uuid null references public.probe_runs (id) on delete restrict,
  request_sent_at      timestamptz null,
  terminalized_at      timestamptz null,
  created_at           timestamptz not null default now(),

  -- Perplexity est toujours génération 1 seule ; une issue incertaine
  -- met tout le job en needs_review plutôt que de créer une génération
  -- 2 sous la même tentative.
  constraint protocol_external_calls_perplexity_single_generation_check check (
    call_kind <> 'perplexity' or generation = 1
  ),
  -- Garantie structurelle : jamais de réservation enregistrée comme
  -- coût réel — un actual_cost_usd non nul exige toujours une base
  -- explicite (measured/estimated) ; une base sans coût, ou l'inverse,
  -- est impossible.
  constraint protocol_external_calls_cost_basis_pair_check check (
    (actual_cost_usd is null and cost_basis is null)
    or (actual_cost_usd is not null and cost_basis is not null)
  ),
  constraint protocol_external_calls_terminal_pair_check check (
    (status in ('reserved', 'in_progress') and terminalized_at is null)
    or (status in ('completed', 'failed', 'timed_out', 'cancelled') and terminalized_at is not null)
  ),
  -- probe_run_id : nullable en 'reserved' ; obligatoire dès que
  -- request_sent_at est renseigné, quel que soit le statut ensuite.
  constraint protocol_external_calls_probe_run_lifecycle_check check (
    request_sent_at is null or probe_run_id is not null
  )
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_external_calls_id_project_key'
  ) then
    alter table public.protocol_external_calls
      add constraint protocol_external_calls_id_project_key unique (id, project_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_external_calls_attempt_project_fk'
  ) then
    alter table public.protocol_external_calls
      add constraint protocol_external_calls_attempt_project_fk
      foreign key (protocol_attempt_id, project_id)
      references public.protocol_attempts (id, project_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_external_calls_attempt_kind_generation_key'
  ) then
    alter table public.protocol_external_calls
      add constraint protocol_external_calls_attempt_kind_generation_key
      unique (protocol_attempt_id, call_kind, generation);
  end if;
end $$;

create index if not exists protocol_external_calls_project_idx
  on public.protocol_external_calls (project_id);

alter table public.protocol_external_calls enable row level security;
alter table public.protocol_external_calls no force row level security;

revoke all on table public.protocol_external_calls from public, anon, authenticated, service_role;
grant select on table public.protocol_external_calls to service_role;

-- ---------------------------------------------------------------------
-- 3. provider_call_receipts — reçu append-only pour un appel externe
--    call_kind = 'perplexity'. Un seul reçu par appel externe (UNIQUE
--    (external_call_id)) : une nouvelle tentative est une nouvelle
--    génération, donc une nouvelle ligne protocol_external_calls, donc
--    un nouveau reçu — jamais une seconde ligne pour le même appel.
-- ---------------------------------------------------------------------

create table if not exists public.provider_call_receipts (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references public.projects (id) on delete cascade,
  external_call_id      uuid not null references public.protocol_external_calls (id) on delete restrict,
  probe_run_id          uuid not null references public.probe_runs (id) on delete restrict,
  outcome               text not null check (outcome in ('success', 'provider_error', 'provider_outcome_unknown')),
  http_status           integer null,
  provider_request_id   text null,
  raw_response_sha256   text null check (raw_response_sha256 is null or raw_response_sha256 ~ '^[0-9a-f]{64}$'),
  latency_ms            integer null check (latency_ms is null or latency_ms >= 0),
  received_at           timestamptz not null default now(),
  created_at            timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'provider_call_receipts_external_call_key'
  ) then
    alter table public.provider_call_receipts
      add constraint provider_call_receipts_external_call_key unique (external_call_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'provider_call_receipts_external_call_project_fk'
  ) then
    alter table public.provider_call_receipts
      add constraint provider_call_receipts_external_call_project_fk
      foreign key (external_call_id, project_id)
      references public.protocol_external_calls (id, project_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'provider_call_receipts_probe_run_project_fk'
  ) then
    alter table public.provider_call_receipts
      add constraint provider_call_receipts_probe_run_project_fk
      foreign key (probe_run_id, project_id)
      references public.probe_runs (id, project_id);
  end if;
end $$;

create index if not exists provider_call_receipts_project_idx
  on public.provider_call_receipts (project_id);

alter table public.provider_call_receipts enable row level security;
alter table public.provider_call_receipts no force row level security;

revoke all on table public.provider_call_receipts from public, anon, authenticated, service_role;
grant select on table public.provider_call_receipts to service_role;

-- ---------------------------------------------------------------------
-- 4. analysis_call_receipts — même contrat, pour call_kind = 'analysis'
--    (runProbeAnalysisAgent). Champs alignés sur le precedent
--    analysis_llm_calls (migration 0036) : provider/model/used_mock/
--    request_sha256/response_sha256, plus probe_run_id (obligatoire ici
--    — absent de analysis_llm_calls, requis par ce contrat M5).
-- ---------------------------------------------------------------------

create table if not exists public.analysis_call_receipts (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects (id) on delete cascade,
  external_call_id  uuid not null references public.protocol_external_calls (id) on delete restrict,
  probe_run_id      uuid not null references public.probe_runs (id) on delete restrict,
  outcome           text not null check (outcome in ('success', 'provider_error', 'provider_outcome_unknown')),
  provider          text null check (provider is null or provider in ('openai', 'anthropic', 'mock')),
  model             text null,
  used_mock         boolean not null default false,
  request_sha256    text null check (request_sha256 is null or request_sha256 ~ '^[0-9a-f]{64}$'),
  response_sha256   text null check (response_sha256 is null or response_sha256 ~ '^[0-9a-f]{64}$'),
  latency_ms        integer null check (latency_ms is null or latency_ms >= 0),
  received_at       timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'analysis_call_receipts_external_call_key'
  ) then
    alter table public.analysis_call_receipts
      add constraint analysis_call_receipts_external_call_key unique (external_call_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'analysis_call_receipts_external_call_project_fk'
  ) then
    alter table public.analysis_call_receipts
      add constraint analysis_call_receipts_external_call_project_fk
      foreign key (external_call_id, project_id)
      references public.protocol_external_calls (id, project_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'analysis_call_receipts_probe_run_project_fk'
  ) then
    alter table public.analysis_call_receipts
      add constraint analysis_call_receipts_probe_run_project_fk
      foreign key (probe_run_id, project_id)
      references public.probe_runs (id, project_id);
  end if;
end $$;

create index if not exists analysis_call_receipts_project_idx
  on public.analysis_call_receipts (project_id);

alter table public.analysis_call_receipts enable row level security;
alter table public.analysis_call_receipts no force row level security;

revoke all on table public.analysis_call_receipts from public, anon, authenticated, service_role;
grant select on table public.analysis_call_receipts to service_role;

-- ---------------------------------------------------------------------
-- 5. protocol_operator_actions — trace append-only de toute décision
--    opérateur (retry_full_attempt, retry_analysis_only,
--    reactivate_abandoned_job). Refus de cap enregistré sans
--    réservation (outcome = 'denied', denial_code renseigné).
-- ---------------------------------------------------------------------

create table if not exists public.protocol_operator_actions (
  id                     uuid primary key default gen_random_uuid(),
  project_id             uuid not null references public.projects (id) on delete cascade,
  job_id                 uuid not null references public.protocol_execution_jobs (id) on delete restrict,
  actor                  text not null check (btrim(actor) <> ''),
  reason                 text not null check (btrim(reason) <> ''),
  action                 text not null
                         check (action in (
                           'retry_full_attempt', 'retry_analysis_only', 'reactivate_abandoned_job'
                         )),
  outcome                text not null check (outcome in ('approved', 'denied')),
  denial_code            text null,
  new_attempt_id         uuid null references public.protocol_attempts (id) on delete restrict,
  new_external_call_id   uuid null references public.protocol_external_calls (id) on delete restrict,
  created_at             timestamptz not null default now(),

  constraint protocol_operator_actions_denial_pair_check check (
    (outcome = 'approved' and denial_code is null)
    or (outcome = 'denied' and denial_code is not null)
  )
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_operator_actions_job_project_fk'
  ) then
    alter table public.protocol_operator_actions
      add constraint protocol_operator_actions_job_project_fk
      foreign key (job_id, project_id)
      references public.protocol_execution_jobs (id, project_id);
  end if;
end $$;

create index if not exists protocol_operator_actions_project_idx
  on public.protocol_operator_actions (project_id);
create index if not exists protocol_operator_actions_job_idx
  on public.protocol_operator_actions (job_id);

alter table public.protocol_operator_actions enable row level security;
alter table public.protocol_operator_actions no force row level security;

revoke all on table public.protocol_operator_actions from public, anon, authenticated, service_role;
grant select on table public.protocol_operator_actions to service_role;

-- ---------------------------------------------------------------------
-- 6. protocol_attempts.job_id — nullable, sans backfill. Les 4 lignes
--    réelles déjà présentes en staging (smoke4) restent job_id = null.
-- ---------------------------------------------------------------------

alter table public.protocol_attempts add column if not exists job_id uuid null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_attempts_job_project_fk'
  ) then
    alter table public.protocol_attempts
      add constraint protocol_attempts_job_project_fk
      foreign key (job_id, project_id)
      references public.protocol_execution_jobs (id, project_id);
  end if;
end $$;

create index if not exists protocol_attempts_job_idx on public.protocol_attempts (job_id);

-- ---------------------------------------------------------------------
-- 6b. protocol_execution_jobs.current_attempt_id (D-020) — la tentative
--     que ce job possède actuellement. Nullable avant admission ;
--     définie atomiquement par admit_and_reserve_attempt_for_job puis
--     remplacée atomiquement par authorize_operator_retry (branche
--     retry_full_attempt uniquement — retry_analysis_only ne la touche
--     jamais, la tentative courante restant la même). Une simple FK sur
--     (current_attempt_id, project_id) permettrait de pointer une
--     tentative d'un AUTRE job du même projet ; la contrainte composite
--     ci-dessous l'interdit structurellement, au niveau du schéma :
--     job(current_attempt_id, id, project_id)
--       -> protocol_attempts(id, job_id, project_id).
--     Aucune contrainte unique métier redondante n'est ajoutée — la
--     seule clé composite ci-dessous est la précondition technique
--     requise pour que cette FK existe (id seul est déjà PRIMARY KEY ;
--     ce triplet est un sur-ensemble, jamais contraignant en soi).
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_attempts_id_job_project_key'
  ) then
    alter table public.protocol_attempts
      add constraint protocol_attempts_id_job_project_key unique (id, job_id, project_id);
  end if;
end $$;

alter table public.protocol_execution_jobs add column if not exists current_attempt_id uuid null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_execution_jobs_current_attempt_fk'
  ) then
    alter table public.protocol_execution_jobs
      add constraint protocol_execution_jobs_current_attempt_fk
      foreign key (current_attempt_id, id, project_id)
      references public.protocol_attempts (id, job_id, project_id);
  end if;
end $$;

create index if not exists protocol_execution_jobs_current_attempt_idx
  on public.protocol_execution_jobs (current_attempt_id);

-- ---------------------------------------------------------------------
-- 7. Fonctions privées — aucun EXECUTE à aucun rôle, y compris
--    service_role. Appelables uniquement en interne, fonction à
--    fonction, sous l'autorité SECURITY DEFINER du propriétaire.
-- ---------------------------------------------------------------------

-- Corps identique à admit_and_reserve_attempt (0047), avec un paramètre
-- supplémentaire p_job_id porté par le même INSERT final. Toute la
-- logique de caps (protocole approuvé, idempotency, retry_cap, run_cap,
-- spend_cap, rate_limit, concurrency_limit) est reprise sans
-- modification.
create or replace function
  public._admit_and_reserve_attempt_core(
    p_protocol_id uuid,
    p_project_id uuid,
    p_attempt_kind text,
    p_idempotency_key text,
    p_estimated_cost_usd numeric,
    p_retry_of_attempt_id uuid,
    p_job_id uuid
  )
returns table (
  status  text,
  attempt public.protocol_attempts
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_protocol public.protocols%rowtype;
  v_existing public.protocol_attempts%rowtype;
  v_retry_row public.protocol_attempts%rowtype;
  v_consumed integer;
  v_spent numeric;
  v_recent integer;
  v_concurrent integer;
  v_retry_depth integer;
  v_new public.protocol_attempts%rowtype;
begin
  if p_protocol_id is null or p_project_id is null or p_attempt_kind is null
     or p_idempotency_key is null or btrim(p_idempotency_key) = ''
     or p_estimated_cost_usd is null or p_estimated_cost_usd < 0 then
    raise exception using
      errcode = '22023',
      message = 'invalid_admit_and_reserve_attempt_core_args';
  end if;

  if p_attempt_kind not in ('baseline', 'retest', 'control', 'paraphrase') then
    raise exception using errcode = '22023', message = 'invalid_attempt_kind';
  end if;

  select p.* into v_protocol
    from public.protocols p
   where p.id = p_protocol_id and p.project_id = p_project_id
   for update;

  if not found then
    return query select 'NOT_FOUND'::text, null::public.protocol_attempts;
    return;
  end if;

  if v_protocol.status not in ('approved', 'active') then
    return query select 'PROTOCOL_NOT_APPROVED'::text, null::public.protocol_attempts;
    return;
  end if;

  select pa.* into v_existing
    from public.protocol_attempts pa
   where pa.protocol_id = p_protocol_id and pa.idempotency_key = p_idempotency_key;

  if found then
    return query select 'ALREADY_RESERVED'::text, v_existing;
    return;
  end if;

  if p_retry_of_attempt_id is not null then
    select pa.* into v_retry_row
      from public.protocol_attempts pa
     where pa.id = p_retry_of_attempt_id
       and pa.protocol_id = p_protocol_id
       and pa.project_id = p_project_id;

    if not found then
      return query select 'INVALID_RETRY_REFERENCE'::text, null::public.protocol_attempts;
      return;
    end if;

    with recursive retry_chain(id, parent_id, depth) as (
      select pa.id, pa.retry_of_attempt_id, 0
        from public.protocol_attempts pa
       where pa.id = p_retry_of_attempt_id
      union all
      select parent.id, parent.retry_of_attempt_id, retry_chain.depth + 1
        from public.protocol_attempts parent
        join retry_chain on parent.id = retry_chain.parent_id
       where retry_chain.depth < v_protocol.retry_cap + 1
    )
    select max(depth) into v_retry_depth from retry_chain;

    if v_retry_depth + 1 > v_protocol.retry_cap then
      return query select 'RETRY_CAP_EXCEEDED'::text, null::public.protocol_attempts;
      return;
    end if;
  end if;

  select count(*) into v_consumed
    from public.protocol_attempts pa
   where pa.protocol_id = p_protocol_id and pa.status <> 'cancelled';

  if v_consumed >= v_protocol.run_cap then
    return query select 'RUN_CAP_EXCEEDED'::text, null::public.protocol_attempts;
    return;
  end if;

  select coalesce(sum(coalesce(pa.actual_cost_usd, pa.reserved_cost_usd)), 0) into v_spent
    from public.protocol_attempts pa
   where pa.protocol_id = p_protocol_id and pa.status <> 'cancelled';

  if v_spent + p_estimated_cost_usd > v_protocol.spend_cap_usd then
    return query select 'SPEND_CAP_EXCEEDED'::text, null::public.protocol_attempts;
    return;
  end if;

  select count(*) into v_recent
    from public.protocol_attempts pa
   where pa.protocol_id = p_protocol_id
     and pa.reserved_at >= now() - interval '1 hour';

  if v_recent >= v_protocol.rate_limit_per_hour then
    return query select 'RATE_LIMIT_EXCEEDED'::text, null::public.protocol_attempts;
    return;
  end if;

  select count(*) into v_concurrent
    from public.protocol_attempts pa
   where pa.protocol_id = p_protocol_id and pa.status in ('reserved', 'in_progress');

  if v_concurrent >= v_protocol.concurrency_limit then
    return query select 'CONCURRENCY_LIMIT_EXCEEDED'::text, null::public.protocol_attempts;
    return;
  end if;

  insert into public.protocol_attempts (
    project_id, protocol_id, buyer_question_version_id, attempt_kind,
    status, idempotency_key, reserved_cost_usd, retry_of_attempt_id,
    job_id, reserved_at, last_activity_at
  ) values (
    p_project_id, p_protocol_id, v_protocol.buyer_question_version_id, p_attempt_kind,
    'reserved', p_idempotency_key, p_estimated_cost_usd, p_retry_of_attempt_id,
    p_job_id, now(), now()
  )
  returning * into v_new;

  return query select 'RESERVED'::text, v_new;
end;
$$;

revoke all on function
  public._admit_and_reserve_attempt_core(uuid, uuid, text, text, numeric, uuid, uuid)
  from public, anon, authenticated, service_role;

-- Insère les deux lignes de ledger génération 1 (perplexity + analysis)
-- pour une tentative fraîchement admise. Appelée par
-- admit_and_reserve_attempt_for_job et par la branche
-- retry_full_attempt de authorize_operator_retry.
create or replace function
  public._create_attempt_external_calls_core(
    p_attempt_id uuid,
    p_project_id uuid,
    p_perplexity_reserved_cost_usd numeric,
    p_analysis_reserved_cost_usd numeric
  )
returns table (
  perplexity_call public.protocol_external_calls,
  analysis_call   public.protocol_external_calls
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_perplexity public.protocol_external_calls%rowtype;
  v_analysis public.protocol_external_calls%rowtype;
begin
  insert into public.protocol_external_calls (
    project_id, protocol_attempt_id, call_kind, generation, status, reserved_cost_usd
  ) values (
    p_project_id, p_attempt_id, 'perplexity', 1, 'reserved', p_perplexity_reserved_cost_usd
  )
  returning * into v_perplexity;

  insert into public.protocol_external_calls (
    project_id, protocol_attempt_id, call_kind, generation, status, reserved_cost_usd
  ) values (
    p_project_id, p_attempt_id, 'analysis', 1, 'reserved', p_analysis_reserved_cost_usd
  )
  returning * into v_analysis;

  return query select v_perplexity, v_analysis;
end;
$$;

revoke all on function
  public._create_attempt_external_calls_core(uuid, uuid, numeric, numeric)
  from public, anon, authenticated, service_role;

-- Réserve une génération d'analyse supplémentaire (un retry de
-- l'analyse seule, sous la même tentative en_cours). Verrouille le
-- protocole pour le contrôle du spend_cap_usd, comme
-- _admit_and_reserve_attempt_core. Le coût inconnu d'une génération
-- terminale antérieure retombe sur son reserved_cost_usd dans ce
-- calcul (coalesce), jamais sur un actual_cost_usd fabriqué.
create or replace function
  public._reserve_additional_analysis_generation_core(
    p_attempt_id uuid,
    p_project_id uuid,
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

  -- Defensive guard: protocol_attempts.protocol_id -> protocols(id) is
  -- ON DELETE RESTRICT, so this row is expected to always exist. A
  -- missing protocol row must still fail closed here, deterministically
  -- — never fall through and let the retry_cap / spend_cap comparisons
  -- below run against a NULL v_protocol (which would silently evaluate
  -- to NULL/false and bypass both caps).
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
    project_id, protocol_attempt_id, call_kind, generation, status, reserved_cost_usd
  ) values (
    p_project_id, p_attempt_id, 'analysis', v_next_generation, 'reserved', p_reserved_cost_usd
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
  public._reserve_additional_analysis_generation_core(uuid, uuid, numeric)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 8. admit_and_reserve_attempt (0047) — signature externe identique,
--    corps réécrit par CREATE OR REPLACE (même technique que 0049) pour
--    déléguer au coeur partagé avec job_id := null. Le fichier 0047
--    n'est pas modifié ; seul le comportement runtime change.
-- ---------------------------------------------------------------------

create or replace function
  public.admit_and_reserve_attempt(
    p_protocol_id uuid,
    p_project_id uuid,
    p_attempt_kind text,
    p_idempotency_key text,
    p_estimated_cost_usd numeric,
    p_retry_of_attempt_id uuid default null
  )
returns table (
  status  text,
  attempt public.protocol_attempts
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
begin
  return query
    select core.status, core.attempt
      from public._admit_and_reserve_attempt_core(
        p_protocol_id, p_project_id, p_attempt_kind, p_idempotency_key,
        p_estimated_cost_usd, p_retry_of_attempt_id, null
      ) as core;
end;
$$;

-- ---------------------------------------------------------------------
-- 9. RPC fencées — job lifecycle (enqueue, claim, renew).
-- ---------------------------------------------------------------------

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

  select j.* into v_existing
    from public.protocol_execution_jobs j
   where j.protocol_id = p_protocol_id and j.project_id = p_project_id;

  if found then
    return query select 'ALREADY_EXISTS'::text, v_existing;
    return;
  end if;

  insert into public.protocol_execution_jobs (project_id, protocol_id, status, max_attempts)
  values (p_project_id, p_protocol_id, 'queued', p_max_attempts)
  returning * into v_new;

  return query select 'QUEUED'::text, v_new;
end;
$$;

revoke all on function
  public.enqueue_protocol_execution_job(uuid, uuid, integer) from public;
revoke all on function
  public.enqueue_protocol_execution_job(uuid, uuid, integer) from anon;
revoke all on function
  public.enqueue_protocol_execution_job(uuid, uuid, integer) from authenticated;
grant execute on function
  public.enqueue_protocol_execution_job(uuid, uuid, integer) to service_role;


-- Balaie d'abord les jobs 'claimed' OU 'running' au bail expiré et déjà
-- épuisés (attempt_count >= max_attempts) vers 'abandoned_exhausted' —
-- ainsi ils ne peuvent jamais être sélectionnés comme candidats par la
-- requête de claim qui suit dans la même transaction. Un job resté
-- 'claimed' (worker mort avant sa première admission) est traité
-- exactement comme un job 'running' au bail expiré : sans ce
-- traitement symétrique, un tel job resterait bloqué indéfiniment, ni
-- repris ni jamais abandonné. needs_review est exclu de toute reprise
-- automatique par construction (ni 'queued' ni 'claimed'/'running' au
-- sens de la clause WHERE ci-dessous).
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

  update public.protocol_execution_jobs j
     set status = 'abandoned_exhausted', updated_at = now()
   where j.status in ('claimed', 'running')
     and j.lease_expires_at < now()
     and j.attempt_count >= j.max_attempts;

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


create or replace function
  public.renew_protocol_execution_job_lease(
    p_job_id uuid,
    p_claim_token uuid,
    p_project_id uuid,
    p_lease_seconds integer
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
begin
  if p_job_id is null or p_claim_token is null or p_project_id is null
     or p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception using
      errcode = '22023',
      message = 'invalid_renew_protocol_execution_job_lease_args';
  end if;

  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id
   for update;

  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_execution_jobs;
    return;
  end if;

  -- Un ancien worker au bail déjà expiré ne peut pas même renouveler
  -- son propre bail.
  if v_job.claim_token is distinct from p_claim_token
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= now()
     or v_job.status not in ('claimed', 'running') then
    return query select 'JOB_NOT_OWNED'::text, v_job;
    return;
  end if;

  update public.protocol_execution_jobs
     set lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         updated_at = now()
   where id = p_job_id and project_id = p_project_id
  returning * into v_job;

  return query select 'RENEWED'::text, v_job;
end;
$$;

revoke all on function
  public.renew_protocol_execution_job_lease(uuid, uuid, uuid, integer) from public;
revoke all on function
  public.renew_protocol_execution_job_lease(uuid, uuid, uuid, integer) from anon;
revoke all on function
  public.renew_protocol_execution_job_lease(uuid, uuid, uuid, integer) from authenticated;
grant execute on function
  public.renew_protocol_execution_job_lease(uuid, uuid, uuid, integer) to service_role;

-- ---------------------------------------------------------------------
-- 10. RPC fencées — admission, démarrage, réservation supplémentaire.
-- ---------------------------------------------------------------------

-- Admission atomique en trois lignes : la tentative (avec job_id) via
-- le coeur partagé, puis les deux lignes de ledger génération 1
-- (perplexity + analysis) via _create_attempt_external_calls_core.
-- p_estimated_cost_usd passé au coeur = somme des deux réservations —
-- protocol_attempts.reserved_cost_usd porte donc bien cette somme dès
-- l'INSERT, sans UPDATE ultérieur.
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

  -- D-020: current_attempt_id is set unconditionally in the same
  -- statement as the status transition -- no later, separate write
  -- that a subsequent failure could leave partially applied.
  update public.protocol_execution_jobs j
     set status = 'running',
         current_attempt_id = (v_core.attempt).id,
         updated_at = now()
   where j.id = p_job_id;

  return query select 'RESERVED'::text, v_core.attempt, v_calls.perplexity_call, v_calls.analysis_call;
end;
$$;

revoke all on function
  public.admit_and_reserve_attempt_for_job(uuid, uuid, uuid, text, text, numeric, numeric, uuid) from public;
revoke all on function
  public.admit_and_reserve_attempt_for_job(uuid, uuid, uuid, text, text, numeric, numeric, uuid) from anon;
revoke all on function
  public.admit_and_reserve_attempt_for_job(uuid, uuid, uuid, text, text, numeric, numeric, uuid) from authenticated;
grant execute on function
  public.admit_and_reserve_attempt_for_job(uuid, uuid, uuid, text, text, numeric, numeric, uuid) to service_role;


-- Enveloppe fencée autour de start_attempt (0047, inchangé) : vérifie
-- job_id + claim_token + bail + que la tentative appartient bien à ce
-- job, puis délègue.
create or replace function
  public.start_attempt_for_job(
    p_job_id uuid,
    p_claim_token uuid,
    p_project_id uuid,
    p_attempt_id uuid,
    p_probe_run_id uuid
  )
returns table (
  status  text,
  attempt public.protocol_attempts
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  v_attempt public.protocol_attempts%rowtype;
  v_result record;
begin
  if p_job_id is null or p_claim_token is null or p_project_id is null
     or p_attempt_id is null or p_probe_run_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_start_attempt_for_job_args';
  end if;

  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id
   for update;

  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_attempts;
    return;
  end if;

  if v_job.claim_token is distinct from p_claim_token
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= now()
     or v_job.status not in ('claimed', 'running') then
    return query select 'JOB_NOT_OWNED'::text, null::public.protocol_attempts;
    return;
  end if;

  select pa.* into v_attempt
    from public.protocol_attempts pa
   where pa.id = p_attempt_id and pa.project_id = p_project_id;

  if not found or v_attempt.job_id is distinct from p_job_id then
    return query select 'ATTEMPT_NOT_OWNED_BY_JOB'::text, null::public.protocol_attempts;
    return;
  end if;

  select * into v_result from public.start_attempt(p_attempt_id, p_project_id, p_probe_run_id);

  return query select v_result.status, v_result.attempt;
end;
$$;

revoke all on function
  public.start_attempt_for_job(uuid, uuid, uuid, uuid, uuid) from public;
revoke all on function
  public.start_attempt_for_job(uuid, uuid, uuid, uuid, uuid) from anon;
revoke all on function
  public.start_attempt_for_job(uuid, uuid, uuid, uuid, uuid) from authenticated;
grant execute on function
  public.start_attempt_for_job(uuid, uuid, uuid, uuid, uuid) to service_role;


create or replace function
  public.reserve_additional_analysis_generation_for_job(
    p_job_id uuid,
    p_claim_token uuid,
    p_project_id uuid,
    p_protocol_attempt_id uuid,
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
begin
  if p_job_id is null or p_claim_token is null or p_project_id is null
     or p_protocol_attempt_id is null
     or p_reserved_cost_usd is null or p_reserved_cost_usd < 0 then
    raise exception using
      errcode = '22023',
      message = 'invalid_reserve_additional_analysis_generation_for_job_args';
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

  if not exists (
    select 1 from public.protocol_attempts pa
     where pa.id = p_protocol_attempt_id
       and pa.job_id = p_job_id
       and pa.project_id = p_project_id
  ) then
    return query select 'ATTEMPT_NOT_OWNED_BY_JOB'::text, null::public.protocol_external_calls;
    return;
  end if;

  return query
    select core.status, core.external_call
      from public._reserve_additional_analysis_generation_core(
        p_protocol_attempt_id, p_project_id, p_reserved_cost_usd
      ) as core;
end;
$$;

revoke all on function
  public.reserve_additional_analysis_generation_for_job(uuid, uuid, uuid, uuid, numeric) from public;
revoke all on function
  public.reserve_additional_analysis_generation_for_job(uuid, uuid, uuid, uuid, numeric) from anon;
revoke all on function
  public.reserve_additional_analysis_generation_for_job(uuid, uuid, uuid, uuid, numeric) from authenticated;
grant execute on function
  public.reserve_additional_analysis_generation_for_job(uuid, uuid, uuid, uuid, numeric) to service_role;

-- ---------------------------------------------------------------------
-- 11. RPC fencées — marqueur d'envoi durable, reçus append-only.
-- ---------------------------------------------------------------------

-- Association probe_run_id + marqueur d'envoi durable, atomiques dans
-- la même RPC fencée : le marqueur ne peut jamais être posé sans que
-- probe_run_id soit déjà renseigné dans le même statement.
create or replace function
  public.mark_external_call_sent_for_job(
    p_job_id uuid,
    p_claim_token uuid,
    p_project_id uuid,
    p_external_call_id uuid,
    p_probe_run_id uuid
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
begin
  if p_job_id is null or p_claim_token is null or p_project_id is null
     or p_external_call_id is null or p_probe_run_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_mark_external_call_sent_for_job_args';
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

  select ec.* into v_call
    from public.protocol_external_calls ec
   where ec.id = p_external_call_id and ec.project_id = p_project_id
   for update;

  if not found then
    return query select 'NOT_FOUND'::text, null::public.protocol_external_calls;
    return;
  end if;

  if not exists (
    select 1 from public.protocol_attempts pa
     where pa.id = v_call.protocol_attempt_id
       and pa.job_id = p_job_id
       and pa.project_id = p_project_id
  ) then
    return query select 'CALL_NOT_OWNED_BY_JOB'::text, null::public.protocol_external_calls;
    return;
  end if;

  if v_call.status <> 'reserved' then
    return query select 'CONFLICT'::text, v_call;
    return;
  end if;

  update public.protocol_external_calls ec
     set status = 'in_progress',
         probe_run_id = p_probe_run_id,
         request_sent_at = now()
   where ec.id = p_external_call_id and ec.project_id = p_project_id and ec.status = 'reserved'
  returning * into v_call;

  return query select 'SENT'::text, v_call;
end;
$$;

revoke all on function
  public.mark_external_call_sent_for_job(uuid, uuid, uuid, uuid, uuid) from public;
revoke all on function
  public.mark_external_call_sent_for_job(uuid, uuid, uuid, uuid, uuid) from anon;
revoke all on function
  public.mark_external_call_sent_for_job(uuid, uuid, uuid, uuid, uuid) from authenticated;
grant execute on function
  public.mark_external_call_sent_for_job(uuid, uuid, uuid, uuid, uuid) to service_role;


-- Reçu append-only pour un appel externe call_kind = 'perplexity'.
-- provider_outcome_unknown produit toujours 'timed_out' (jamais
-- 'excluded' — absent de l'enum à six statuts) et met tout le job en
-- 'needs_review' : c'est le seul déclencheur de needs_review pour la
-- branche Perplexity.
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
    p_cost_basis text default null
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
    provider_request_id, raw_response_sha256, latency_ms
  ) values (
    p_project_id, p_external_call_id, p_probe_run_id, p_outcome, p_http_status,
    p_provider_request_id, p_raw_response_sha256, p_latency_ms
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
    uuid, uuid, uuid, uuid, uuid, text, integer, text, text, integer, numeric, text
  ) from public;
revoke all on function
  public.record_provider_call_receipt_for_job(
    uuid, uuid, uuid, uuid, uuid, text, integer, text, text, integer, numeric, text
  ) from anon;
revoke all on function
  public.record_provider_call_receipt_for_job(
    uuid, uuid, uuid, uuid, uuid, text, integer, text, text, integer, numeric, text
  ) from authenticated;
grant execute on function
  public.record_provider_call_receipt_for_job(
    uuid, uuid, uuid, uuid, uuid, text, integer, text, text, integer, numeric, text
  ) to service_role;


-- Reçu append-only pour un appel externe call_kind = 'analysis'
-- (runProbeAnalysisAgent). Même contrat/mapping d'issue que la
-- réception Perplexity ci-dessus ; needs_review_reason distinct pour
-- distinguer la cause dans le job.
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
    p_cost_basis text default null
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
    model, used_mock, request_sha256, response_sha256, latency_ms
  ) values (
    p_project_id, p_external_call_id, p_probe_run_id, p_outcome, p_provider,
    p_model, coalesce(p_used_mock, false), p_request_sha256, p_response_sha256, p_latency_ms
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
    uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text
  ) from public;
revoke all on function
  public.record_analysis_call_receipt_for_job(
    uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text
  ) from anon;
revoke all on function
  public.record_analysis_call_receipt_for_job(
    uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text
  ) from authenticated;
grant execute on function
  public.record_analysis_call_receipt_for_job(
    uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text
  ) to service_role;

-- ---------------------------------------------------------------------
-- 12. reconcile_attempt_for_job — N'APPELLE PAS reconcile_attempt
--     (0047). Calcule directement actual_cost_usd depuis le ledger :
--     si une génération terminale a un coût inconnu (actual_cost_usd
--     is null), l'attempt entier reçoit actual_cost_usd = NULL (jamais
--     une somme partielle fabriquée) ; sinon la somme des coûts réels
--     terminaux. Exige que tous les appels externes de la tentative
--     soient déjà terminaux avant de réconcilier.
-- ---------------------------------------------------------------------

create or replace function
  public.reconcile_attempt_for_job(
    p_job_id uuid,
    p_claim_token uuid,
    p_project_id uuid,
    p_attempt_id uuid,
    p_status text,
    p_termination_reason text default null
  )
returns table (
  status  text,
  attempt public.protocol_attempts
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  v_row public.protocol_attempts%rowtype;
  v_open_calls integer;
  v_has_unknown boolean;
  v_known_sum numeric;
  v_actual_cost_usd numeric;
begin
  if p_job_id is null or p_claim_token is null or p_project_id is null
     or p_attempt_id is null or p_status is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_reconcile_attempt_for_job_args';
  end if;

  if p_status not in ('completed', 'failed', 'timed_out', 'cancelled', 'excluded') then
    return query select 'INVALID_STATUS'::text, null::public.protocol_attempts;
    return;
  end if;

  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id
   for update;

  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_attempts;
    return;
  end if;

  if v_job.claim_token is distinct from p_claim_token
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= now()
     or v_job.status not in ('claimed', 'running') then
    return query select 'JOB_NOT_OWNED'::text, null::public.protocol_attempts;
    return;
  end if;

  select pa.* into v_row
    from public.protocol_attempts pa
   where pa.id = p_attempt_id and pa.project_id = p_project_id and pa.job_id = p_job_id
   for update;

  if not found then
    return query select 'ATTEMPT_NOT_OWNED_BY_JOB'::text, null::public.protocol_attempts;
    return;
  end if;

  if v_row.terminalized_at is not null then
    if v_row.status = p_status then
      return query select 'ALREADY_RECONCILED'::text, v_row;
    else
      return query select 'CONFLICT'::text, v_row;
    end if;
    return;
  end if;

  select count(*) into v_open_calls
    from public.protocol_external_calls ec
   where ec.protocol_attempt_id = p_attempt_id
     and ec.status in ('reserved', 'in_progress');

  if v_open_calls > 0 then
    return query select 'EXTERNAL_CALLS_NOT_TERMINAL'::text, v_row;
    return;
  end if;

  select
    bool_or(actual_cost_usd is null),
    coalesce(sum(actual_cost_usd) filter (where actual_cost_usd is not null), 0)
    into v_has_unknown, v_known_sum
    from public.protocol_external_calls ec
   where ec.protocol_attempt_id = p_attempt_id
     and ec.status in ('completed', 'failed', 'timed_out', 'cancelled');

  if coalesce(v_has_unknown, false) then
    v_actual_cost_usd := null;
  else
    v_actual_cost_usd := v_known_sum;
  end if;

  update public.protocol_attempts
     set status = p_status,
         actual_cost_usd = v_actual_cost_usd,
         termination_reason = p_termination_reason,
         terminalized_at = now(),
         last_activity_at = now()
   where id = p_attempt_id
     and project_id = p_project_id
     and terminalized_at is null
  returning * into v_row;

  return query select 'RECONCILED'::text, v_row;
end;
$$;

revoke all on function
  public.reconcile_attempt_for_job(uuid, uuid, uuid, uuid, text, text) from public;
revoke all on function
  public.reconcile_attempt_for_job(uuid, uuid, uuid, uuid, text, text) from anon;
revoke all on function
  public.reconcile_attempt_for_job(uuid, uuid, uuid, uuid, text, text) from authenticated;
grant execute on function
  public.reconcile_attempt_for_job(uuid, uuid, uuid, uuid, text, text) to service_role;


-- ---------------------------------------------------------------------
-- 13. Complétion / échec du job.
--
-- D-020 — le gate de complétion. complete_protocol_execution_job ne
-- marque plus jamais succeeded sans preuve : la tentative courante
-- (current_attempt_id) doit être réconciliée et completed ; l'appel
-- Perplexity génération 1 doit être completed avec son reçu ; la
-- génération analysis la MAXIMALE de cette tentative doit être
-- completed avec son reçu — les générations antérieures restent
-- append-only, incluses dans la réconciliation des coûts par
-- reconcile_attempt_for_job, mais ne déterminent jamais le résultat.
-- Ordre exact (a-r du plan approuvé) : JOB_NOT_FOUND -> déjà succeeded
-- (ALREADY_SUCCEEDED, avant tout fencing, aucune mutation) -> autre
-- état terminal (CONFLICT, aucune mutation) -> fencing (JOB_NOT_OWNED)
-- -> current_attempt_id NULL (NO_CURRENT_ATTEMPT) -> verrou exact de la
-- tentative courante (id + job_id + project_id, garde défensive
-- CURRENT_ATTEMPT_NOT_FOUND malgré la FK) -> non réconciliée
-- (ATTEMPT_NOT_RECONCILED) -> réconciliée mais pas completed
-- (ATTEMPT_NOT_COMPLETED) -> verrou déterministe des external_calls
-- (call_kind, generation) -> un appel encore reserved/in_progress
-- (EXTERNAL_CALLS_NOT_TERMINAL) -> Perplexity gen1 absent/pas completed/
-- sans reçu (PERPLEXITY_NOT_COMPLETED) -> génération analysis maximale
-- absente/pas completed/sans reçu (ANALYSIS_NOT_COMPLETED) -> UPDATE
-- succeeded. Un coût inconnu honnêtement réconcilié (actual_cost_usd
-- NULL sur la tentative) n'est jamais rejeté ici. claim_token/bail
-- restent inchangés en cas de succès, comme trace d'audit (comportement
-- déjà documenté, inchangé).
-- ---------------------------------------------------------------------

create or replace function
  public.complete_protocol_execution_job(
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
  v_attempt public.protocol_attempts%rowtype;
  v_open_calls integer;
  v_perplexity public.protocol_external_calls%rowtype;
  v_max_analysis_generation integer;
  v_max_analysis public.protocol_external_calls%rowtype;
begin
  if p_job_id is null or p_claim_token is null or p_project_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_complete_protocol_execution_job_args';
  end if;

  -- a. verrou du job, scopé par (id, project_id).
  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id
   for update;

  -- b. absent -> JOB_NOT_FOUND.
  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_execution_jobs;
    return;
  end if;

  -- c. déjà succeeded -> ALREADY_SUCCEEDED, avant tout fencing, aucune
  -- mutation. Un job terminal n'a plus de propriétaire actif à valider.
  if v_job.status = 'succeeded' then
    return query select 'ALREADY_SUCCEEDED'::text, v_job;
    return;
  end if;

  -- d. un autre état terminal -> CONFLICT, aucune mutation.
  if v_job.status in ('failed', 'needs_review', 'abandoned_exhausted') then
    return query select 'CONFLICT'::text, v_job;
    return;
  end if;

  -- e. job actif (claimed/running) mais fencing invalide -> JOB_NOT_OWNED.
  if v_job.claim_token is distinct from p_claim_token
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= now()
     or v_job.status not in ('claimed', 'running') then
    return query select 'JOB_NOT_OWNED'::text, v_job;
    return;
  end if;

  -- f. aucune tentative courante -> NO_CURRENT_ATTEMPT.
  if v_job.current_attempt_id is null then
    return query select 'NO_CURRENT_ATTEMPT'::text, v_job;
    return;
  end if;

  -- g. verrou EXACT de la tentative courante, via id + job_id +
  -- project_id -- jamais un id de tentative seul.
  select pa.* into v_attempt
    from public.protocol_attempts pa
   where pa.id = v_job.current_attempt_id
     and pa.job_id = p_job_id
     and pa.project_id = p_project_id
   for update;

  -- h. garde défensive : absente malgré la FK composite ci-dessus.
  if not found then
    return query select 'CURRENT_ATTEMPT_NOT_FOUND'::text, v_job;
    return;
  end if;

  -- i. pas encore réconciliée.
  if v_attempt.terminalized_at is null then
    return query select 'ATTEMPT_NOT_RECONCILED'::text, v_job;
    return;
  end if;

  -- j. réconciliée mais pas completed.
  if v_attempt.status <> 'completed' then
    return query select 'ATTEMPT_NOT_COMPLETED'::text, v_job;
    return;
  end if;

  -- k. verrou déterministe de tous les external_calls de cette
  -- tentative -- même ordre (call_kind, generation) pour tout appelant,
  -- jamais l'ordre d'arrivée des lignes.
  perform 1
    from public.protocol_external_calls ec
   where ec.protocol_attempt_id = v_attempt.id
   order by ec.call_kind, ec.generation
   for update;

  -- l. aucun appel ne peut rester ouvert.
  select count(*) into v_open_calls
    from public.protocol_external_calls ec
   where ec.protocol_attempt_id = v_attempt.id
     and ec.status in ('reserved', 'in_progress');

  if v_open_calls > 0 then
    return query select 'EXTERNAL_CALLS_NOT_TERMINAL'::text, v_job;
    return;
  end if;

  -- m. Perplexity génération 1 exactement : completed, avec son
  -- provider_call_receipts correspondant. project_id/job_id/attempt_id
  -- sont déjà garantis par les FK composites existantes (protocol_
  -- external_calls_attempt_project_fk, provider_call_receipts_
  -- external_call_project_fk) -- non redupliqués ici.
  select ec.* into v_perplexity
    from public.protocol_external_calls ec
   where ec.protocol_attempt_id = v_attempt.id
     and ec.call_kind = 'perplexity'
     and ec.generation = 1;

  if not found
     or v_perplexity.status <> 'completed'
     or not exists (
       select 1 from public.provider_call_receipts r
        where r.external_call_id = v_perplexity.id
     ) then
    return query select 'PERPLEXITY_NOT_COMPLETED'::text, v_job;
    return;
  end if;

  -- n. la génération analysis la PLUS RÉCENTE fait seule autorité :
  -- completed, avec son analysis_call_receipts correspondant. Les
  -- générations antérieures (failed/timed_out/cancelled/completed)
  -- restent append-only et incluses dans reconcile_attempt_for_job,
  -- mais ne sont jamais consultées ici pour la décision.
  select max(generation) into v_max_analysis_generation
    from public.protocol_external_calls
   where protocol_attempt_id = v_attempt.id and call_kind = 'analysis';

  if v_max_analysis_generation is null then
    return query select 'ANALYSIS_NOT_COMPLETED'::text, v_job;
    return;
  end if;

  select ec.* into v_max_analysis
    from public.protocol_external_calls ec
   where ec.protocol_attempt_id = v_attempt.id
     and ec.call_kind = 'analysis'
     and ec.generation = v_max_analysis_generation;

  if not found
     or v_max_analysis.status <> 'completed'
     or not exists (
       select 1 from public.analysis_call_receipts r
        where r.external_call_id = v_max_analysis.id
     ) then
    return query select 'ANALYSIS_NOT_COMPLETED'::text, v_job;
    return;
  end if;

  -- p. un coût inconnu honnêtement réconcilié (attempt.actual_cost_usd
  -- NULL) n'est jamais rejeté -- aucune exigence actual_cost_usd non
  -- NULL n'est imposée ici ni ailleurs au-dessus.

  -- q. seulement maintenant, marquer le job succeeded. claim_token/bail
  -- conservés tels quels comme trace d'audit (comportement déjà
  -- documenté, inchangé).
  update public.protocol_execution_jobs
     set status = 'succeeded', updated_at = now()
   where id = p_job_id and project_id = p_project_id
  returning * into v_job;

  return query select 'SUCCEEDED'::text, v_job;
end;
$$;

revoke all on function
  public.complete_protocol_execution_job(uuid, uuid, uuid) from public;
revoke all on function
  public.complete_protocol_execution_job(uuid, uuid, uuid) from anon;
revoke all on function
  public.complete_protocol_execution_job(uuid, uuid, uuid) from authenticated;
grant execute on function
  public.complete_protocol_execution_job(uuid, uuid, uuid) to service_role;


create or replace function
  public.fail_protocol_execution_job(
    p_job_id uuid,
    p_claim_token uuid,
    p_project_id uuid,
    p_reason text
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
begin
  if p_job_id is null or p_claim_token is null or p_project_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_fail_protocol_execution_job_args';
  end if;

  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id
   for update;

  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_execution_jobs;
    return;
  end if;

  if v_job.claim_token is distinct from p_claim_token
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= now()
     or v_job.status not in ('claimed', 'running') then
    return query select 'JOB_NOT_OWNED'::text, v_job;
    return;
  end if;

  update public.protocol_execution_jobs
     set status = 'failed', failure_reason = p_reason, updated_at = now()
   where id = p_job_id and project_id = p_project_id
  returning * into v_job;

  return query select 'FAILED'::text, v_job;
end;
$$;

revoke all on function
  public.fail_protocol_execution_job(uuid, uuid, uuid, text) from public;
revoke all on function
  public.fail_protocol_execution_job(uuid, uuid, uuid, text) from anon;
revoke all on function
  public.fail_protocol_execution_job(uuid, uuid, uuid, text) from authenticated;
grant execute on function
  public.fail_protocol_execution_job(uuid, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------
-- 14. Actions opérateur — deux branches distinctes, atomiques et
--     auditées. Un refus de cap est enregistré (outcome = 'denied',
--     denial_code) sans créer de réservation. Ne vérifie ni claim_token
--     ni bail : l'autorité ici est needs_review + acteur/raison non
--     vides, un axe distinct du fencing worker (un job needs_review n'a
--     plus de worker actif en train de le muter).
-- ---------------------------------------------------------------------

create or replace function
  public.authorize_operator_retry(
    p_job_id uuid,
    p_project_id uuid,
    p_actor text,
    p_reason text,
    p_action text,
    p_source_attempt_id uuid,
    p_reserved_cost_usd numeric,
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
begin
  if p_job_id is null or p_project_id is null
     or p_actor is null or btrim(p_actor) = ''
     or p_reason is null or btrim(p_reason) = ''
     or p_action is null or p_source_attempt_id is null
     or p_reserved_cost_usd is null or p_reserved_cost_usd < 0 then
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

  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id
   for update;

  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::text, null::text,
      null::public.protocol_attempts, null::public.protocol_external_calls;
    return;
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
        'operator-retry-' || gen_random_uuid()::text,
        p_perplexity_reserved_cost_usd + p_reserved_cost_usd,
        p_source_attempt_id, p_job_id
      );

    if v_core.status <> 'RESERVED' then
      insert into public.protocol_operator_actions (
        project_id, job_id, actor, reason, action, outcome, denial_code
      ) values (
        p_project_id, p_job_id, p_actor, p_reason, p_action, 'denied', v_core.status
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
      new_attempt_id, new_external_call_id
    ) values (
      p_project_id, p_job_id, p_actor, p_reason, p_action, 'approved', null,
      (v_core.attempt).id, (v_calls.perplexity_call).id
    )
    returning * into v_action_row;

    -- D-020: retry_full_attempt replaces current_attempt_id atomically
    -- with the new attempt's id, in the same statement as the status
    -- transition -- retry_analysis_only (below) never touches this
    -- column, since the current attempt does not change.
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

    select * into v_reserve
      from public._reserve_additional_analysis_generation_core(
        p_source_attempt_id, p_project_id, p_reserved_cost_usd
      );

    if v_reserve.status <> 'RESERVED' then
      insert into public.protocol_operator_actions (
        project_id, job_id, actor, reason, action, outcome, denial_code
      ) values (
        p_project_id, p_job_id, p_actor, p_reason, p_action, 'denied', v_reserve.status
      )
      returning * into v_action_row;

      return query select 'DENIED'::text, 'denied'::text, v_reserve.status,
        null::public.protocol_attempts, null::public.protocol_external_calls;
      return;
    end if;

    insert into public.protocol_operator_actions (
      project_id, job_id, actor, reason, action, outcome, denial_code,
      new_attempt_id, new_external_call_id
    ) values (
      p_project_id, p_job_id, p_actor, p_reason, p_action, 'approved', null,
      p_source_attempt_id, (v_reserve.external_call).id
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
  public.authorize_operator_retry(uuid, uuid, text, text, text, uuid, numeric, numeric) from public;
revoke all on function
  public.authorize_operator_retry(uuid, uuid, text, text, text, uuid, numeric, numeric) from anon;
revoke all on function
  public.authorize_operator_retry(uuid, uuid, text, text, text, uuid, numeric, numeric) from authenticated;
grant execute on function
  public.authorize_operator_retry(uuid, uuid, text, text, text, uuid, numeric, numeric) to service_role;


-- Sortie auditée de abandoned_exhausted : réactive la MÊME ligne job
-- (jamais un remplacement), remet attempt_count à 0, ne touche jamais
-- protocol_attempts ni protocol_external_calls.
create or replace function
  public.reactivate_abandoned_job(
    p_job_id uuid,
    p_project_id uuid,
    p_actor text,
    p_reason text
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
begin
  if p_job_id is null or p_project_id is null
     or p_actor is null or btrim(p_actor) = ''
     or p_reason is null or btrim(p_reason) = '' then
    raise exception using
      errcode = '22023',
      message = 'invalid_reactivate_abandoned_job_args';
  end if;

  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id
   for update;

  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_execution_jobs;
    return;
  end if;

  if v_job.status <> 'abandoned_exhausted' then
    return query select 'JOB_NOT_ABANDONED'::text, v_job;
    return;
  end if;

  update public.protocol_execution_jobs
     set status = 'queued',
         attempt_count = 0,
         worker_id = null,
         claim_token = null,
         lease_expires_at = null,
         failure_reason = null,
         updated_at = now()
   where id = p_job_id
  returning * into v_job;

  insert into public.protocol_operator_actions (
    project_id, job_id, actor, reason, action, outcome
  ) values (
    p_project_id, p_job_id, p_actor, p_reason, 'reactivate_abandoned_job', 'approved'
  );

  return query select 'REACTIVATED'::text, v_job;
end;
$$;

revoke all on function
  public.reactivate_abandoned_job(uuid, uuid, text, text) from public;
revoke all on function
  public.reactivate_abandoned_job(uuid, uuid, text, text) from anon;
revoke all on function
  public.reactivate_abandoned_job(uuid, uuid, text, text) from authenticated;
grant execute on function
  public.reactivate_abandoned_job(uuid, uuid, text, text) to service_role;


-- ---------------------------------------------------------------------
-- 15. Révocation EXECUTE des RPC M4 directes pour service_role. Elles
--     restent appelables en interne (fonction à fonction, sous
--     l'autorité SECURITY DEFINER du propriétaire) mais plus par
--     service_role directement — tout écrivain externe doit désormais
--     passer par une RPC fencée _for_job. start_attempt et
--     reconcile_attempt restent byte-for-byte inchangés depuis 0047 ;
--     seul admit_and_reserve_attempt a son corps réécrit plus haut
--     (section 8).
-- ---------------------------------------------------------------------

revoke execute on function
  public.admit_and_reserve_attempt(uuid, uuid, text, text, numeric, uuid) from service_role;
revoke execute on function
  public.start_attempt(uuid, uuid, uuid) from service_role;
revoke execute on function
  public.reconcile_attempt(uuid, uuid, text, numeric, uuid, text) from service_role;
