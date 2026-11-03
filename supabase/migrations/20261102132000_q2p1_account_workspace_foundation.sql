-- Q2′-1 — Account-first data foundation (D-040 §10 stage 2; QD-6 naming).
--
-- Every object here is NEW. This migration redefines no existing function,
-- alters no existing table, and touches no paid-execution object:
--   * no write to protocols, protocol_execution_jobs, protocol_external_calls,
--     spend_controls, buyer_question_launch_selections or snapshot_requests
--     (snapshot_requests is only read and row-locked FOR SHARE, by the
--     invitation binding trigger and by F4);
--   * approve_and_launch_snapshot_baseline (0069) is unchanged — the
--     coexistence check (F5), enrolment (F3) and bqi_enrollments are Q2′-1b;
--   * nothing here is reachable by a customer: the only executable functions
--     are founder/system RPCs and the invitation-session RPC, all granted to
--     service_role only, and F6, which no role may execute directly.
--
-- Tenancy (QD-1 A′, C1): every new table is closed — RLS on, no policies, and
-- no privilege for public, anon, authenticated or service_role. Rows are
-- written only through the SECURITY DEFINER functions below. A customer actor
-- is bound from the verified claims (request.jwt.claims, never a parameter);
-- an invitation holder from the hash of the presented session token.
--
-- Actor model (§4): four actor types, one permitted column shape each,
-- enforced by one shared check (_q2p_actor_shape_ok). An invitation holder is
-- never given, assumed or linked to an account.
--
-- Recovery: forward-only. Every table is new and empty until written by these
-- functions, and every function is new, so a later timestamped migration can
-- drop them. No existing object needs restoring.

-- ════════════════════════════════════════════════════════════════════════
-- 1. Helpers
-- ════════════════════════════════════════════════════════════════════════

create or replace function public._q2p_actor_shape_ok(
  p_actor_type text,
  p_account_id uuid,
  p_membership_id uuid,
  p_invitation_id uuid,
  p_session_id uuid,
  p_operator_id uuid,
  p_rule_id text,
  p_rule_version text
) returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case p_actor_type
    when 'customer_account' then
      p_account_id is not null and p_membership_id is not null
      and p_invitation_id is null and p_session_id is null and p_operator_id is null
      and p_rule_id is null and p_rule_version is null
    when 'invitation_holder' then
      p_invitation_id is not null and p_session_id is not null
      and p_account_id is null and p_membership_id is null and p_operator_id is null
      and p_rule_id is null and p_rule_version is null
    when 'founder' then
      p_operator_id is not null
      and p_account_id is null and p_membership_id is null
      and p_invitation_id is null and p_session_id is null
      and p_rule_id is null and p_rule_version is null
    when 'system' then
      coalesce(btrim(p_rule_id), '') <> '' and coalesce(btrim(p_rule_version), '') <> ''
      and p_account_id is null and p_membership_id is null
      and p_invitation_id is null and p_session_id is null and p_operator_id is null
    else false
  end;
$$;

-- Token hashes carry a purpose label, so a hash of one token type can never
-- match another. Purposes in use (QS-09):
--   'zypact.question_review_invitation.v1'
--   'zypact.question_review_session.v1'
-- Token values themselves are never stored.
create or replace function public._q2p_token_hash(p_purpose text, p_token text)
returns text
language sql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
  select encode(sha256(convert_to(p_purpose || ':' || p_token, 'UTF8')), 'hex');
$$;
comment on function public._q2p_token_hash(text, text) is
  'SHA-256 over purpose label and token. Purposes: zypact.question_review_invitation.v1, zypact.question_review_session.v1.';

create or replace function public._q2p_sha256_hex(p_text text)
returns text
language sql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
  select encode(sha256(convert_to(p_text, 'UTF8')), 'hex');
$$;

-- Append-only: refuses every UPDATE and DELETE.
create or replace function public._q2p_append_only()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception using errcode = '55000', message = 'q2p_append_only: ' || tg_table_name;
end;
$$;

-- Refuses TRUNCATE (statement trigger).
create or replace function public._q2p_no_truncate()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception using errcode = '55000', message = 'q2p_no_truncate: ' || tg_table_name;
end;
$$;

-- True when `span` occurs in `excerpt` at least once with no letter, digit or
-- combining mark directly before or after it (Q1 C-04, spanAtWordBoundary).
create or replace function public._q2p_span_at_word_boundary(p_excerpt text, p_span text)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_from integer := 1;
  v_at integer;
  v_before text;
  v_after text;
  v_word constant text := '^[[:alpha:][:digit:]̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]$';
begin
  if p_excerpt is null or p_span is null or length(p_span) = 0 then
    return false;
  end if;
  loop
    v_at := strpos(substr(p_excerpt, v_from), p_span);
    exit when v_at = 0;
    v_at := v_at + v_from - 1;
    v_before := case when v_at > 1 then substr(p_excerpt, v_at - 1, 1) end;
    v_after := case when v_at + length(p_span) <= length(p_excerpt)
                    then substr(p_excerpt, v_at + length(p_span), 1) end;
    if (v_before is null or v_before !~ v_word) and (v_after is null or v_after !~ v_word) then
      return true;
    end if;
    v_from := v_at + 1;
  end loop;
  return false;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 2. T1 workspaces, T2 workspace_members, T2a workspace_membership_versions,
--    T3 workspace_projects
-- ════════════════════════════════════════════════════════════════════════

create table public.workspaces (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null check (btrim(name) <> '' and length(name) <= 200),
  idempotency_key      text not null unique check (btrim(idempotency_key) <> ''),
  request_fingerprint  text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  actor_type           text not null,
  actor_account_id     uuid,
  actor_membership_id  uuid,
  actor_invitation_id  uuid,
  actor_session_id     uuid,
  actor_operator_id    uuid,
  rule_id              text,
  rule_version         text,
  created_at           timestamptz not null default now(),
  constraint workspaces_actor_shape check (public._q2p_actor_shape_ok(
    actor_type, actor_account_id, actor_membership_id, actor_invitation_id,
    actor_session_id, actor_operator_id, rule_id, rule_version)),
  -- F1 is the only writer, and it is a founder or system path.
  constraint workspaces_actor_founder_or_system check (actor_type in ('founder', 'system'))
);

create table public.workspace_members (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces(id),
  account_id           uuid not null,
  role                 text not null check (role = 'owner'),
  added_at             timestamptz not null default now(),
  actor_type           text not null,
  actor_account_id     uuid,
  actor_membership_id  uuid,
  actor_invitation_id  uuid,
  actor_session_id     uuid,
  actor_operator_id    uuid,
  rule_id              text,
  rule_version         text,
  removed_at           timestamptz,
  removed_actor_type   text,
  removed_operator_id  uuid,
  removed_rule_id      text,
  removed_rule_version text,
  constraint workspace_members_id_account_workspace_key unique (id, account_id, workspace_id),
  constraint workspace_members_actor_shape check (public._q2p_actor_shape_ok(
    actor_type, actor_account_id, actor_membership_id, actor_invitation_id,
    actor_session_id, actor_operator_id, rule_id, rule_version)),
  -- Added only by F1 or F7, both founder or system paths.
  constraint workspace_members_actor_founder_or_system check (actor_type in ('founder', 'system')),
  -- Removal is all-or-nothing, and only by founder or system (F8).
  constraint workspace_members_removal_shape check (
    (removed_at is null and removed_actor_type is null and removed_operator_id is null
       and removed_rule_id is null and removed_rule_version is null)
    or (removed_at is not null and public._q2p_actor_shape_ok(
          removed_actor_type, null, null, null, null, removed_operator_id,
          removed_rule_id, removed_rule_version)
        and removed_actor_type in ('founder', 'system'))
  )
);

create unique index workspace_members_one_active
  on public.workspace_members (workspace_id, account_id) where removed_at is null;

-- Every column is immutable except the removal columns, which may be set once,
-- from null, together. Delete is refused.
create or replace function public._q2p_workspace_members_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'q2p_append_only: workspace_members';
  end if;
  if old.removed_at is not null then
    raise exception using errcode = '55000', message = 'q2p_membership_already_removed';
  end if;
  if new.removed_at is null
     or (to_jsonb(new) - array['removed_at', 'removed_actor_type', 'removed_operator_id',
                               'removed_rule_id', 'removed_rule_version'])
        is distinct from
        (to_jsonb(old) - array['removed_at', 'removed_actor_type', 'removed_operator_id',
                               'removed_rule_id', 'removed_rule_version']) then
    raise exception using errcode = '55000', message = 'q2p_membership_immutable';
  end if;
  return new;
end;
$$;

create trigger workspace_members_guard
  before update or delete on public.workspace_members
  for each row execute function public._q2p_workspace_members_guard();

-- T2a: infrastructure-only exception to the actor-column and append-only
-- conventions. One row per workspace; its only change is version + 1. It is
-- the per-workspace conflict point for membership changes (§3e Property 2),
-- never read for authorisation and never shown as data.
create table public.workspace_membership_versions (
  workspace_id  uuid primary key references public.workspaces(id),
  version       bigint not null default 0 check (version >= 0),
  updated_at    timestamptz not null default now()
);

create or replace function public._q2p_membership_versions_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'q2p_append_only: workspace_membership_versions';
  end if;
  if new.workspace_id is distinct from old.workspace_id or new.version <> old.version + 1 then
    raise exception using errcode = '55000', message = 'q2p_membership_version_increment_only';
  end if;
  return new;
end;
$$;

create trigger workspace_membership_versions_guard
  before update or delete on public.workspace_membership_versions
  for each row execute function public._q2p_membership_versions_guard();

create table public.workspace_projects (
  project_id           uuid primary key references public.projects(id),
  workspace_id         uuid not null references public.workspaces(id),
  actor_type           text not null,
  actor_account_id     uuid,
  actor_membership_id  uuid,
  actor_invitation_id  uuid,
  actor_session_id     uuid,
  actor_operator_id    uuid,
  rule_id              text,
  rule_version         text,
  created_at           timestamptz not null default now(),
  constraint workspace_projects_project_workspace_key unique (project_id, workspace_id),
  constraint workspace_projects_actor_shape check (public._q2p_actor_shape_ok(
    actor_type, actor_account_id, actor_membership_id, actor_invitation_id,
    actor_session_id, actor_operator_id, rule_id, rule_version)),
  constraint workspace_projects_actor_founder_or_system check (actor_type in ('founder', 'system'))
);

-- ════════════════════════════════════════════════════════════════════════
-- 3. T6 research sets, sources, candidates and their links
--    (bqi_enrollments is Q2′-1b.)
-- ════════════════════════════════════════════════════════════════════════

create table public.question_research_sets (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null,
  project_id           uuid not null,
  snapshot_request_id  uuid not null references public.snapshot_requests(id),
  supersedes           uuid references public.question_research_sets(id),
  site_context         jsonb not null check (jsonb_typeof(site_context) = 'object'),
  icp                  jsonb not null check (jsonb_typeof(icp) = 'object'),
  actor_type           text not null,
  actor_account_id     uuid,
  actor_membership_id  uuid,
  actor_invitation_id  uuid,
  actor_session_id     uuid,
  actor_operator_id    uuid,
  rule_id              text,
  rule_version         text,
  created_at           timestamptz not null default now(),
  constraint question_research_sets_project_fk foreign key (project_id, workspace_id)
    references public.workspace_projects(project_id, workspace_id),
  constraint question_research_sets_id_project_key unique (id, project_id),
  constraint question_research_sets_scope_key unique (id, workspace_id, project_id, snapshot_request_id),
  constraint question_research_sets_actor_shape check (public._q2p_actor_shape_ok(
    actor_type, actor_account_id, actor_membership_id, actor_invitation_id,
    actor_session_id, actor_operator_id, rule_id, rule_version))
);

-- The request belongs to the research set's project, and a correction
-- supersedes a set of the same request.
create or replace function public._q2p_research_set_scope_check()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if not exists (select 1 from public.snapshot_requests r
                  where r.id = new.snapshot_request_id and r.project_id = new.project_id) then
    raise exception using errcode = '23514', message = 'q2p_research_set_request_not_in_project';
  end if;
  if new.supersedes is not null and not exists (
       select 1 from public.question_research_sets s
        where s.id = new.supersedes and s.snapshot_request_id = new.snapshot_request_id
          and s.project_id = new.project_id) then
    raise exception using errcode = '23514', message = 'q2p_research_set_supersedes_other_request';
  end if;
  return new;
end;
$$;

create trigger question_research_sets_scope
  before insert on public.question_research_sets
  for each row execute function public._q2p_research_set_scope_check();

create table public.question_sources (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null,
  project_id             uuid not null,
  source_kind            text not null check (source_kind in
                           ('customer_material', 'public_community', 'public_review', 'public_analyst', 'site_copy')),
  url                    text,
  publisher              text,
  title                  text,
  customer_reference     text,
  customer_attested_at   timestamptz,
  received_at            timestamptz,
  retrieved_at           timestamptz,
  excerpt                text not null,
  excerpt_sha256         text not null,
  buyer_authored         boolean not null,
  verification           text not null check (verification in ('public_verifiable', 'customer_provided')),
  personal_data_removed  boolean not null,
  actor_type             text not null,
  actor_account_id       uuid,
  actor_membership_id    uuid,
  actor_invitation_id    uuid,
  actor_session_id       uuid,
  actor_operator_id      uuid,
  rule_id                text,
  rule_version           text,
  created_at             timestamptz not null default now(),
  constraint question_sources_project_fk foreign key (project_id, workspace_id)
    references public.workspace_projects(project_id, workspace_id),
  constraint question_sources_id_project_key unique (id, project_id),
  constraint question_sources_excerpt_length check (length(excerpt) between 1 and 300 and btrim(excerpt) <> ''),
  constraint question_sources_excerpt_hash check (excerpt_sha256 = public._q2p_sha256_hex(excerpt)),
  constraint question_sources_personal_data_removed check (personal_data_removed),
  constraint question_sources_public_needs_url_and_retrieval check (
    source_kind = 'customer_material'
    or (coalesce(btrim(url), '') <> '' and retrieved_at is not null)),
  constraint question_sources_customer_material_needs_attestation check (
    source_kind <> 'customer_material'
    or (coalesce(btrim(customer_reference), '') <> '' and customer_attested_at is not null
        and received_at is not null)),
  constraint question_sources_site_copy_not_buyer check (source_kind <> 'site_copy' or not buyer_authored),
  constraint question_sources_verification_matches_kind check (
    (source_kind = 'customer_material' and verification = 'customer_provided')
    or (source_kind <> 'customer_material' and verification = 'public_verifiable')),
  constraint question_sources_actor_shape check (public._q2p_actor_shape_ok(
    actor_type, actor_account_id, actor_membership_id, actor_invitation_id,
    actor_session_id, actor_operator_id, rule_id, rule_version))
);

create table public.question_candidates (
  id                         uuid primary key default gen_random_uuid(),
  workspace_id               uuid not null,
  project_id                 uuid not null,
  research_set_id            uuid not null,
  candidate_text             text not null check (btrim(candidate_text) <> ''),
  normalized_hash            text not null check (normalized_hash ~ '^[0-9a-f]{64}$'),
  evidence_grade             text not null check (evidence_grade in ('observed', 'adapted', 'hypothesis')),
  verification               text check (verification in ('public_verifiable', 'customer_provided')),
  question_kind              text not null check (question_kind in ('unbranded', 'branded_accuracy')),
  buyer_relevance            integer not null check (buyer_relevance between 0 and 3),
  buyer_relevance_reason     text not null check (btrim(buyer_relevance_reason) <> ''),
  icp_fit                    integer not null check (icp_fit between 0 and 3),
  icp_fit_reason             text not null check (btrim(icp_fit_reason) <> ''),
  commercial_intent          integer not null check (commercial_intent between 0 and 3),
  commercial_intent_reason   text not null check (btrim(commercial_intent_reason) <> ''),
  product_relevance          integer not null check (product_relevance between 0 and 3),
  product_relevance_reason   text not null check (btrim(product_relevance_reason) <> ''),
  intent                     text not null check (btrim(intent) <> ''),
  buyer_stage                text not null check (buyer_stage in ('problem', 'solution', 'vendor_evaluation', 'purchase')),
  persona                    text,
  adaptation_note            text,
  review_flags               text[] not null default '{}',
  flag_resolution            text,
  curator_rank               integer not null check (curator_rank >= 1),
  preselected                boolean not null default false,
  selection_reason           text,
  primary_source_id          uuid,
  actor_type                 text not null,
  actor_account_id           uuid,
  actor_membership_id        uuid,
  actor_invitation_id        uuid,
  actor_session_id           uuid,
  actor_operator_id          uuid,
  rule_id                    text,
  rule_version               text,
  created_at                 timestamptz not null default now(),
  constraint question_candidates_project_fk foreign key (project_id, workspace_id)
    references public.workspace_projects(project_id, workspace_id),
  constraint question_candidates_research_set_fk foreign key (research_set_id, project_id)
    references public.question_research_sets(id, project_id),
  constraint question_candidates_primary_source_fk foreign key (primary_source_id, project_id)
    references public.question_sources(id, project_id),
  constraint question_candidates_id_project_key unique (id, project_id),
  constraint question_candidates_id_set_key unique (id, research_set_id),
  constraint question_candidates_adapted_needs_note check (
    evidence_grade <> 'adapted' or coalesce(btrim(adaptation_note), '') <> ''),
  constraint question_candidates_verification_shape check (
    (evidence_grade = 'hypothesis' and verification is null)
    or (evidence_grade in ('observed', 'adapted') and verification is not null)),
  constraint question_candidates_actor_shape check (public._q2p_actor_shape_ok(
    actor_type, actor_account_id, actor_membership_id, actor_invitation_id,
    actor_session_id, actor_operator_id, rule_id, rule_version))
);

create table public.question_candidate_sources (
  candidate_id         uuid not null,
  source_id            uuid not null,
  relation             text not null check (relation in ('verbatim', 'paraphrase_basis', 'context')),
  quoted_span          text,
  workspace_id         uuid not null,
  project_id           uuid not null,
  actor_type           text not null,
  actor_account_id     uuid,
  actor_membership_id  uuid,
  actor_invitation_id  uuid,
  actor_session_id     uuid,
  actor_operator_id    uuid,
  rule_id              text,
  rule_version         text,
  created_at           timestamptz not null default now(),
  primary key (candidate_id, source_id, relation),
  constraint question_candidate_sources_project_fk foreign key (project_id, workspace_id)
    references public.workspace_projects(project_id, workspace_id),
  constraint question_candidate_sources_candidate_fk foreign key (candidate_id, project_id)
    references public.question_candidates(id, project_id),
  constraint question_candidate_sources_source_fk foreign key (source_id, project_id)
    references public.question_sources(id, project_id),
  constraint question_candidate_sources_verbatim_needs_span check (
    relation <> 'verbatim' or quoted_span is not null),
  constraint question_candidate_sources_actor_shape check (public._q2p_actor_shape_ok(
    actor_type, actor_account_id, actor_membership_id, actor_invitation_id,
    actor_session_id, actor_operator_id, rule_id, rule_version))
);

-- Link rules that need the source row: site_copy only as context; a quoted
-- span must occur in the excerpt on word boundaries (Q1 C-04).
create or replace function public._q2p_candidate_source_check()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_source public.question_sources%rowtype;
begin
  select * into v_source from public.question_sources where id = new.source_id;
  if v_source.source_kind = 'site_copy' and new.relation <> 'context' then
    raise exception using errcode = '23514', message = 'q2p_seller_source_only_as_context';
  end if;
  if new.quoted_span is not null then
    if length(new.quoted_span) = 0 or strpos(v_source.excerpt, new.quoted_span) = 0 then
      raise exception using errcode = '23514', message = 'q2p_quoted_span_not_in_excerpt';
    end if;
    if not public._q2p_span_at_word_boundary(v_source.excerpt, new.quoted_span) then
      raise exception using errcode = '23514', message = 'q2p_quoted_span_not_word_aligned';
    end if;
  end if;
  return new;
end;
$$;

create trigger question_candidate_sources_check
  before insert on public.question_candidate_sources
  for each row execute function public._q2p_candidate_source_check();

-- Checked at commit, once the candidate's links exist:
--   * a primary source must be a supporting (verbatim or paraphrase_basis) link;
--   * observed needs a verbatim link to a buyer-authored source whose
--     verification equals the candidate's;
--   * adapted needs a paraphrase_basis link to a buyer-authored source.
create or replace function public._q2p_candidate_evidence_check()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.primary_source_id is not null and not exists (
       select 1 from public.question_candidate_sources l
        where l.candidate_id = new.id and l.source_id = new.primary_source_id
          and l.relation in ('verbatim', 'paraphrase_basis')) then
    raise exception using errcode = '23514', message = 'q2p_primary_source_not_supporting';
  end if;
  if new.evidence_grade = 'observed' and not exists (
       select 1 from public.question_candidate_sources l
         join public.question_sources s on s.id = l.source_id
        where l.candidate_id = new.id and l.relation = 'verbatim'
          and s.buyer_authored and s.verification = new.verification) then
    raise exception using errcode = '23514', message = 'q2p_observed_requires_verbatim_buyer_source';
  end if;
  if new.evidence_grade = 'adapted' and not exists (
       select 1 from public.question_candidate_sources l
         join public.question_sources s on s.id = l.source_id
        where l.candidate_id = new.id and l.relation = 'paraphrase_basis' and s.buyer_authored) then
    raise exception using errcode = '23514', message = 'q2p_adapted_requires_paraphrase_basis';
  end if;
  return null;
end;
$$;

create constraint trigger question_candidates_evidence
  after insert on public.question_candidates
  deferrable initially deferred
  for each row execute function public._q2p_candidate_evidence_check();

-- ════════════════════════════════════════════════════════════════════════
-- 4. T8 review invitations and sessions (D-039 OD-4)
-- ════════════════════════════════════════════════════════════════════════

create table public.question_review_invitations (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null,
  project_id           uuid not null,
  snapshot_request_id  uuid not null,
  research_set_id      uuid not null,
  email_hmac           text not null check (email_hmac ~ '^[0-9a-f]{64}$'),
  email_hmac_key_id    text not null check (btrim(email_hmac_key_id) <> ''),
  email_verified_at    timestamptz,
  -- The request's persisted address at issue, bound to this invitation
  -- (_q2p_request_email_binding). Derived by a BEFORE INSERT trigger from
  -- snapshot_requests, never supplied by a caller, and immutable.
  request_email_binding text not null check (request_email_binding ~ '^[0-9a-f]{64}$'),
  token_hash           text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at           timestamptz not null,
  exchanged_at         timestamptz,
  revoked_at           timestamptz,
  superseded_by        uuid references public.question_review_invitations(id),
  actor_type           text not null,
  actor_account_id     uuid,
  actor_membership_id  uuid,
  actor_invitation_id  uuid,
  actor_session_id     uuid,
  actor_operator_id    uuid,
  rule_id              text,
  rule_version         text,
  created_at           timestamptz not null default now(),
  constraint question_review_invitations_project_fk foreign key (project_id, workspace_id)
    references public.workspace_projects(project_id, workspace_id),
  constraint question_review_invitations_set_fk
    foreign key (research_set_id, workspace_id, project_id, snapshot_request_id)
    references public.question_research_sets(id, workspace_id, project_id, snapshot_request_id),
  constraint question_review_invitations_scope_key
    unique (id, workspace_id, project_id, snapshot_request_id, research_set_id),
  constraint question_review_invitations_seven_days check (
    expires_at > created_at and expires_at <= created_at + interval '7 days'),
  -- An invitation may be issued before the address is verified, but never
  -- exchanged without it (D-039: verified at exchange, or copied from the
  -- request's existing verification).
  constraint question_review_invitations_exchange_needs_verified_email check (
    exchanged_at is null or email_verified_at is not null),
  -- A reissue revokes the invitation it supersedes.
  constraint question_review_invitations_superseded_is_revoked check (
    superseded_by is null or revoked_at is not null),
  constraint question_review_invitations_actor_shape check (public._q2p_actor_shape_ok(
    actor_type, actor_account_id, actor_membership_id, actor_invitation_id,
    actor_session_id, actor_operator_id, rule_id, rule_version)),
  constraint question_review_invitations_actor_founder_or_system check (actor_type in ('founder', 'system'))
);

-- Immutable except the single-transition columns (exchanged_at,
-- email_verified_at, revoked_at, superseded_by), each set once from null.
create or replace function public._q2p_invitation_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_mutable constant text[] := array['exchanged_at', 'email_verified_at', 'revoked_at', 'superseded_by'];
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'q2p_append_only: question_review_invitations';
  end if;
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable)
     or (old.exchanged_at is not null and new.exchanged_at is distinct from old.exchanged_at)
     or (old.email_verified_at is not null and new.email_verified_at is distinct from old.email_verified_at)
     or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at)
     or (old.superseded_by is not null and new.superseded_by is distinct from old.superseded_by) then
    raise exception using errcode = '55000', message = 'q2p_invitation_single_transition_only';
  end if;
  return new;
end;
$$;

create trigger question_review_invitations_guard
  before update or delete on public.question_review_invitations
  for each row execute function public._q2p_invitation_guard();

-- The invitation is bound to the address persisted on its snapshot request
-- at issue: a domain-separated SHA-256 of the invitation id and the
-- request's normalized_email. No secret is needed, because the database
-- compares its own rows; the per-invitation input keeps two invitations'
-- bindings unlinkable. A caller-supplied value is refused.
--
-- Disclosure: this is an unkeyed SHA-256, not an HMAC. Anyone who obtains a
-- row of this table (its id and binding) can test guessed addresses offline,
-- and work addresses are guessable; that includes anyone holding an export,
-- dump, replica or log of this table without the requests table. Inside the
-- database no API role can read it; the owner can, and can also read the
-- plaintext address, but the risk does not depend on plaintext access. It is
-- never returned by F4, copied to approval_records or logged by this code.
--
-- Continuity, not recipient identity: the binding proves the request's
-- persisted address is unchanged since the invitation was issued. It does
-- not prove the invitation was sent to, or verified by, that address:
-- email_hmac and email_verified_at are written by the issuer, and the
-- database holds no key to compare email_hmac with the request's address.
-- Q4′'s issue and exchange RPCs must enforce recipient matching.
--
-- Restore: F4 compares the request's CURRENT address with the binding. If
-- the address changes, every invitation bound to it stops authorising; if it
-- is changed back to the exact original normalized_email, an invitation that
-- is otherwise still valid (unrevoked, unexpired, live session) authorises
-- again. Any future path that changes a request's address must revoke its
-- outstanding invitations in the same transaction if a change is to be final.
create or replace function public._q2p_request_email_binding(p_invitation_id uuid, p_normalized_email text)
returns text
language sql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
  select public._q2p_sha256_hex('zypact.q2p.invitation_request_email.v1' || chr(31)
         || p_invitation_id::text || chr(31) || p_normalized_email)
$$;

create or replace function public._q2p_invitation_bind_request_email()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_email text;
begin
  if new.request_email_binding is not null then
    raise exception using errcode = '22023', message = 'request_email_binding_is_derived';
  end if;
  select r.normalized_email into v_email from public.snapshot_requests r
   where r.id = new.snapshot_request_id
   for share;
  if v_email is null then
    raise exception using errcode = '23503', message = 'invitation_request_missing';
  end if;
  new.request_email_binding := public._q2p_request_email_binding(new.id, v_email);
  return new;
end;
$$;

create trigger question_review_invitations_bind_request_email
  before insert on public.question_review_invitations
  for each row execute function public._q2p_invitation_bind_request_email();

create table public.question_review_sessions (
  id                   uuid primary key default gen_random_uuid(),
  invitation_id        uuid not null,
  workspace_id         uuid not null,
  project_id           uuid not null,
  snapshot_request_id  uuid not null,
  research_set_id      uuid not null,
  token_hash           text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  absolute_expires_at  timestamptz not null,
  last_seen_at         timestamptz not null,
  revoked_at           timestamptz,
  actor_type           text not null,
  actor_account_id     uuid,
  actor_membership_id  uuid,
  actor_invitation_id  uuid,
  actor_session_id     uuid,
  actor_operator_id    uuid,
  rule_id              text,
  rule_version         text,
  created_at           timestamptz not null default now(),
  constraint question_review_sessions_project_fk foreign key (project_id, workspace_id)
    references public.workspace_projects(project_id, workspace_id),
  -- Scope is copied from the invitation, never from the request: the
  -- composite key makes any other scope impossible.
  constraint question_review_sessions_invitation_fk
    foreign key (invitation_id, workspace_id, project_id, snapshot_request_id, research_set_id)
    references public.question_review_invitations(id, workspace_id, project_id, snapshot_request_id, research_set_id),
  constraint question_review_sessions_id_invitation_key unique (id, invitation_id),
  constraint question_review_sessions_id_invitation_project_key unique (id, invitation_id, project_id),
  constraint question_review_sessions_thirty_minutes check (
    absolute_expires_at > created_at and absolute_expires_at <= created_at + interval '30 minutes'),
  constraint question_review_sessions_last_seen check (last_seen_at >= created_at),
  constraint question_review_sessions_actor_shape check (public._q2p_actor_shape_ok(
    actor_type, actor_account_id, actor_membership_id, actor_invitation_id,
    actor_session_id, actor_operator_id, rule_id, rule_version)),
  constraint question_review_sessions_actor_system check (actor_type = 'system')
);

-- A session exists only for an invitation that has been exchanged with a
-- verified email, and never outlives that invitation.
create or replace function public._q2p_session_within_invitation()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if not exists (select 1 from public.question_review_invitations i
                  where i.id = new.invitation_id
                    and i.exchanged_at is not null and i.email_verified_at is not null) then
    raise exception using errcode = '23514', message = 'q2p_session_needs_exchanged_verified_invitation';
  end if;
  if not exists (select 1 from public.question_review_invitations i
                  where i.id = new.invitation_id and new.absolute_expires_at <= i.expires_at) then
    raise exception using errcode = '23514', message = 'q2p_session_outlives_invitation';
  end if;
  return new;
end;
$$;

create trigger question_review_sessions_within_invitation
  before insert on public.question_review_sessions
  for each row execute function public._q2p_session_within_invitation();

-- Immutable except last_seen_at, which may only move forward while the
-- session is live, and revoked_at, set once from null.
create or replace function public._q2p_session_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_mutable constant text[] := array['last_seen_at', 'revoked_at'];
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'q2p_append_only: question_review_sessions';
  end if;
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable)
     or new.last_seen_at < old.last_seen_at
     or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at) then
    raise exception using errcode = '55000', message = 'q2p_session_single_transition_only';
  end if;
  return new;
end;
$$;

create trigger question_review_sessions_guard
  before update or delete on public.question_review_sessions
  for each row execute function public._q2p_session_guard();

-- ════════════════════════════════════════════════════════════════════════
-- 5. T5 approval records; T7 origins and wording classifications
-- ════════════════════════════════════════════════════════════════════════

create table public.approval_records (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null,
  project_id             uuid not null,
  snapshot_request_id    uuid not null,
  research_set_id        uuid not null,
  action_type            text not null check (action_type = 'approve_buyer_question_set'),
  approved_version_ids   uuid[] not null check (cardinality(approved_version_ids) between 1 and 3),
  prompt_hashes          text[] not null check (cardinality(prompt_hashes) between 1 and 3),
  approved_at            timestamptz not null default now(),
  session_type           text not null check (session_type in ('review_invitation', 'account')),
  session_id             uuid not null,
  step_up_event_id       uuid,
  verified_email_hmac    text not null check (verified_email_hmac ~ '^[0-9a-f]{64}$'),
  email_hmac_key_id      text not null check (btrim(email_hmac_key_id) <> ''),
  consent_text_version   text not null check (btrim(consent_text_version) <> ''),
  consent_text_sha256    text not null check (consent_text_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key        text not null check (btrim(idempotency_key) <> ''),
  set_fingerprint        text not null check (set_fingerprint ~ '^[0-9a-f]{64}$'),
  actor_type             text not null,
  actor_account_id       uuid,
  actor_membership_id    uuid,
  actor_invitation_id    uuid,
  actor_session_id       uuid,
  actor_operator_id      uuid,
  rule_id                text,
  rule_version           text,
  constraint approval_records_project_fk foreign key (project_id, workspace_id)
    references public.workspace_projects(project_id, workspace_id),
  constraint approval_records_set_fk
    foreign key (research_set_id, workspace_id, project_id, snapshot_request_id)
    references public.question_research_sets(id, workspace_id, project_id, snapshot_request_id),
  -- Once a research set has an approved set, only that exact set replays.
  constraint approval_records_one_per_set unique (research_set_id),
  -- Idempotency keys are scoped to the research set (as D-021 scopes them to
  -- a job): the same key on another set is that set's own request.
  constraint approval_records_set_key unique (research_set_id, idempotency_key),
  constraint approval_records_arrays_align check (
    cardinality(approved_version_ids) = cardinality(prompt_hashes)),
  constraint approval_records_session_actor_agree check (
    (session_type = 'review_invitation' and actor_type = 'invitation_holder'
       and actor_session_id = session_id and step_up_event_id is null)
    or (session_type = 'account' and actor_type = 'customer_account' and step_up_event_id is not null)),
  constraint approval_records_actor_shape check (public._q2p_actor_shape_ok(
    actor_type, actor_account_id, actor_membership_id, actor_invitation_id,
    actor_session_id, actor_operator_id, rule_id, rule_version))
);

create table public.buyer_question_version_origins (
  version_id              uuid primary key,
  workspace_id            uuid not null,
  project_id              uuid not null,
  approval_record_id      uuid not null references public.approval_records(id),
  candidate_id            uuid,
  origin                  text not null check (origin in
                            ('recommended_unchanged', 'recommended_edited', 'replaced_with_candidate', 'customer_written')),
  candidate_grade         text check (candidate_grade in ('observed', 'adapted', 'hypothesis')),
  candidate_verification  text check (candidate_verification in ('public_verifiable', 'customer_provided')),
  candidate_text_hash     text check (candidate_text_hash ~ '^[0-9a-f]{64}$'),
  approved_text_hash      text not null check (approved_text_hash ~ '^[0-9a-f]{64}$'),
  actor_type              text not null,
  actor_account_id        uuid,
  actor_membership_id     uuid,
  actor_invitation_id     uuid,
  actor_session_id        uuid,
  actor_operator_id       uuid,
  rule_id                 text,
  rule_version            text,
  created_at              timestamptz not null default now(),
  constraint buyer_question_version_origins_project_fk foreign key (project_id, workspace_id)
    references public.workspace_projects(project_id, workspace_id),
  constraint buyer_question_version_origins_version_fk foreign key (version_id, project_id)
    references public.buyer_question_versions(id, project_id),
  constraint buyer_question_version_origins_candidate_fk foreign key (candidate_id, project_id)
    references public.question_candidates(id, project_id),
  constraint buyer_question_version_origins_candidate_shape check (
    (origin = 'customer_written' and candidate_id is null and candidate_grade is null
       and candidate_verification is null and candidate_text_hash is null)
    or (origin <> 'customer_written' and candidate_id is not null and candidate_grade is not null
       and candidate_text_hash is not null)),
  constraint buyer_question_version_origins_text_matches_origin check (
    (origin in ('recommended_unchanged', 'replaced_with_candidate') and approved_text_hash = candidate_text_hash)
    or (origin = 'recommended_edited' and approved_text_hash <> candidate_text_hash)
    or origin = 'customer_written'),
  constraint buyer_question_version_origins_actor_shape check (public._q2p_actor_shape_ok(
    actor_type, actor_account_id, actor_membership_id, actor_invitation_id,
    actor_session_id, actor_operator_id, rule_id, rule_version))
);

create table public.approved_wording_classifications (
  id                   uuid primary key default gen_random_uuid(),
  version_id           uuid not null,
  workspace_id         uuid not null,
  project_id           uuid not null,
  classification       text not null check (classification in ('observed', 'adapted', 'hypothesis', 'pending_review')),
  verification         text check (verification in ('public_verifiable', 'customer_provided')),
  basis_source_ids     uuid[] not null default '{}',
  rule                 text check (rule in ('inherited_unchanged', 'exact_source_match', 'founder_review')),
  adaptation_note      text,
  actor_type           text not null,
  actor_account_id     uuid,
  actor_membership_id  uuid,
  actor_invitation_id  uuid,
  actor_session_id     uuid,
  actor_operator_id    uuid,
  rule_id              text,
  rule_version         text,
  classified_at        timestamptz not null default now(),
  constraint approved_wording_classifications_project_fk foreign key (project_id, workspace_id)
    references public.workspace_projects(project_id, workspace_id),
  constraint approved_wording_classifications_version_fk foreign key (version_id, project_id)
    references public.buyer_question_versions(id, project_id),
  constraint approved_wording_classifications_rule_pending check (
    (classification = 'pending_review') = (rule is null)),
  -- Q1 R3: founder review can never record observed.
  constraint approved_wording_classifications_founder_review check (
    rule <> 'founder_review' or classification in ('adapted', 'hypothesis')),
  constraint approved_wording_classifications_observed_rule check (
    classification <> 'observed' or rule in ('inherited_unchanged', 'exact_source_match')),
  constraint approved_wording_classifications_exact_match_is_observed check (
    rule <> 'exact_source_match' or classification = 'observed'),
  constraint approved_wording_classifications_founder_adapted_note check (
    not (rule = 'founder_review' and classification = 'adapted')
    or coalesce(btrim(adaptation_note), '') <> ''),
  constraint approved_wording_classifications_verification_shape check (
    (classification in ('observed', 'adapted')) = (verification is not null)),
  constraint approved_wording_classifications_actor_shape check (public._q2p_actor_shape_ok(
    actor_type, actor_account_id, actor_membership_id, actor_invitation_id,
    actor_session_id, actor_operator_id, rule_id, rule_version))
);

-- ════════════════════════════════════════════════════════════════════════
-- 6. T4 exception queue
-- ════════════════════════════════════════════════════════════════════════

create table public.exception_items (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid references public.workspaces(id),
  kind                 text not null check (kind in
                         ('research', 'invitation', 'approval', 'membership', 'diagnostic', 'other')),
  reason               text not null check (btrim(reason) <> ''),
  subject_type         text,
  subject_id           uuid,
  actor_type           text not null,
  actor_account_id     uuid,
  actor_membership_id  uuid,
  actor_invitation_id  uuid,
  actor_session_id     uuid,
  actor_operator_id    uuid,
  rule_id              text,
  rule_version         text,
  created_at           timestamptz not null default now(),
  constraint exception_items_id_workspace_key unique (id, workspace_id),
  -- A customer actor is always checked against a membership of the item's workspace.
  constraint exception_items_customer_needs_workspace check (
    actor_type <> 'customer_account' or workspace_id is not null),
  constraint exception_items_actor_shape check (public._q2p_actor_shape_ok(
    actor_type, actor_account_id, actor_membership_id, actor_invitation_id,
    actor_session_id, actor_operator_id, rule_id, rule_version))
);

create table public.exception_events (
  id                   uuid primary key default gen_random_uuid(),
  item_id              uuid not null references public.exception_items(id),
  workspace_id         uuid,
  event                text not null check (event in ('opened', 'assigned', 'resolved', 'note')),
  assignee_operator_id uuid,
  note                 text,
  actor_type           text not null,
  actor_account_id     uuid,
  actor_membership_id  uuid,
  actor_invitation_id  uuid,
  actor_session_id     uuid,
  actor_operator_id    uuid,
  rule_id              text,
  rule_version         text,
  created_at           timestamptz not null default now(),
  constraint exception_events_item_fk foreign key (item_id, workspace_id)
    references public.exception_items(id, workspace_id),
  constraint exception_events_assigned_has_assignee check (
    event <> 'assigned' or assignee_operator_id is not null),
  constraint exception_events_customer_needs_workspace check (
    actor_type <> 'customer_account' or workspace_id is not null),
  constraint exception_events_actor_shape check (public._q2p_actor_shape_ok(
    actor_type, actor_account_id, actor_membership_id, actor_invitation_id,
    actor_session_id, actor_operator_id, rule_id, rule_version))
);

create index exception_events_item_idx on public.exception_events (item_id, created_at);

-- ════════════════════════════════════════════════════════════════════════
-- 7. Actor references: membership and invitation-session keys (§4)
-- ════════════════════════════════════════════════════════════════════════
-- A customer actor's membership must belong to that account and to the
-- row's workspace; an invitation holder's session must belong to that
-- invitation (and, where the row has one, to the row's project).

alter table public.workspaces
  add constraint workspaces_actor_membership_fk foreign key (actor_membership_id, actor_account_id, id)
    references public.workspace_members(id, account_id, workspace_id),
  add constraint workspaces_actor_session_fk foreign key (actor_session_id, actor_invitation_id)
    references public.question_review_sessions(id, invitation_id);

alter table public.workspace_members
  add constraint workspace_members_actor_membership_fk foreign key (actor_membership_id, actor_account_id, workspace_id)
    references public.workspace_members(id, account_id, workspace_id),
  add constraint workspace_members_actor_session_fk foreign key (actor_session_id, actor_invitation_id)
    references public.question_review_sessions(id, invitation_id);

alter table public.workspace_projects
  add constraint workspace_projects_actor_membership_fk foreign key (actor_membership_id, actor_account_id, workspace_id)
    references public.workspace_members(id, account_id, workspace_id),
  add constraint workspace_projects_actor_session_fk foreign key (actor_session_id, actor_invitation_id, project_id)
    references public.question_review_sessions(id, invitation_id, project_id);

alter table public.question_research_sets
  add constraint question_research_sets_actor_membership_fk foreign key (actor_membership_id, actor_account_id, workspace_id)
    references public.workspace_members(id, account_id, workspace_id),
  add constraint question_research_sets_actor_session_fk foreign key (actor_session_id, actor_invitation_id, project_id)
    references public.question_review_sessions(id, invitation_id, project_id);

alter table public.question_sources
  add constraint question_sources_actor_membership_fk foreign key (actor_membership_id, actor_account_id, workspace_id)
    references public.workspace_members(id, account_id, workspace_id),
  add constraint question_sources_actor_session_fk foreign key (actor_session_id, actor_invitation_id, project_id)
    references public.question_review_sessions(id, invitation_id, project_id);

alter table public.question_candidates
  add constraint question_candidates_actor_membership_fk foreign key (actor_membership_id, actor_account_id, workspace_id)
    references public.workspace_members(id, account_id, workspace_id),
  add constraint question_candidates_actor_session_fk foreign key (actor_session_id, actor_invitation_id, project_id)
    references public.question_review_sessions(id, invitation_id, project_id);

alter table public.question_candidate_sources
  add constraint question_candidate_sources_actor_membership_fk foreign key (actor_membership_id, actor_account_id, workspace_id)
    references public.workspace_members(id, account_id, workspace_id),
  add constraint question_candidate_sources_actor_session_fk foreign key (actor_session_id, actor_invitation_id, project_id)
    references public.question_review_sessions(id, invitation_id, project_id);

alter table public.question_review_invitations
  add constraint question_review_invitations_actor_membership_fk foreign key (actor_membership_id, actor_account_id, workspace_id)
    references public.workspace_members(id, account_id, workspace_id),
  add constraint question_review_invitations_actor_session_fk foreign key (actor_session_id, actor_invitation_id, project_id)
    references public.question_review_sessions(id, invitation_id, project_id);

alter table public.question_review_sessions
  add constraint question_review_sessions_actor_membership_fk foreign key (actor_membership_id, actor_account_id, workspace_id)
    references public.workspace_members(id, account_id, workspace_id),
  add constraint question_review_sessions_actor_session_fk foreign key (actor_session_id, actor_invitation_id, project_id)
    references public.question_review_sessions(id, invitation_id, project_id);

alter table public.approval_records
  add constraint approval_records_actor_membership_fk foreign key (actor_membership_id, actor_account_id, workspace_id)
    references public.workspace_members(id, account_id, workspace_id),
  add constraint approval_records_actor_session_fk foreign key (actor_session_id, actor_invitation_id, project_id)
    references public.question_review_sessions(id, invitation_id, project_id);

alter table public.buyer_question_version_origins
  add constraint buyer_question_version_origins_actor_membership_fk foreign key (actor_membership_id, actor_account_id, workspace_id)
    references public.workspace_members(id, account_id, workspace_id),
  add constraint buyer_question_version_origins_actor_session_fk foreign key (actor_session_id, actor_invitation_id, project_id)
    references public.question_review_sessions(id, invitation_id, project_id);

alter table public.approved_wording_classifications
  add constraint approved_wording_classifications_actor_membership_fk foreign key (actor_membership_id, actor_account_id, workspace_id)
    references public.workspace_members(id, account_id, workspace_id),
  add constraint approved_wording_classifications_actor_session_fk foreign key (actor_session_id, actor_invitation_id, project_id)
    references public.question_review_sessions(id, invitation_id, project_id);

alter table public.exception_items
  add constraint exception_items_actor_membership_fk foreign key (actor_membership_id, actor_account_id, workspace_id)
    references public.workspace_members(id, account_id, workspace_id),
  add constraint exception_items_actor_session_fk foreign key (actor_session_id, actor_invitation_id)
    references public.question_review_sessions(id, invitation_id);

alter table public.exception_events
  add constraint exception_events_actor_membership_fk foreign key (actor_membership_id, actor_account_id, workspace_id)
    references public.workspace_members(id, account_id, workspace_id),
  add constraint exception_events_actor_session_fk foreign key (actor_session_id, actor_invitation_id)
    references public.question_review_sessions(id, invitation_id);

-- ════════════════════════════════════════════════════════════════════════
-- 8. Append-only enforcement, closed tables
-- ════════════════════════════════════════════════════════════════════════

create trigger workspaces_append_only before update or delete on public.workspaces
  for each row execute function public._q2p_append_only();
create trigger workspace_projects_append_only before update or delete on public.workspace_projects
  for each row execute function public._q2p_append_only();
create trigger question_research_sets_append_only before update or delete on public.question_research_sets
  for each row execute function public._q2p_append_only();
create trigger question_sources_append_only before update or delete on public.question_sources
  for each row execute function public._q2p_append_only();
create trigger question_candidates_append_only before update or delete on public.question_candidates
  for each row execute function public._q2p_append_only();
create trigger question_candidate_sources_append_only before update or delete on public.question_candidate_sources
  for each row execute function public._q2p_append_only();
create trigger approval_records_append_only before update or delete on public.approval_records
  for each row execute function public._q2p_append_only();
create trigger buyer_question_version_origins_append_only before update or delete on public.buyer_question_version_origins
  for each row execute function public._q2p_append_only();
create trigger approved_wording_classifications_append_only before update or delete on public.approved_wording_classifications
  for each row execute function public._q2p_append_only();
create trigger exception_items_append_only before update or delete on public.exception_items
  for each row execute function public._q2p_append_only();
create trigger exception_events_append_only before update or delete on public.exception_events
  for each row execute function public._q2p_append_only();

create trigger workspaces_no_truncate before truncate on public.workspaces
  for each statement execute function public._q2p_no_truncate();
create trigger workspace_members_no_truncate before truncate on public.workspace_members
  for each statement execute function public._q2p_no_truncate();
create trigger workspace_membership_versions_no_truncate before truncate on public.workspace_membership_versions
  for each statement execute function public._q2p_no_truncate();
create trigger workspace_projects_no_truncate before truncate on public.workspace_projects
  for each statement execute function public._q2p_no_truncate();
create trigger question_research_sets_no_truncate before truncate on public.question_research_sets
  for each statement execute function public._q2p_no_truncate();
create trigger question_sources_no_truncate before truncate on public.question_sources
  for each statement execute function public._q2p_no_truncate();
create trigger question_candidates_no_truncate before truncate on public.question_candidates
  for each statement execute function public._q2p_no_truncate();
create trigger question_candidate_sources_no_truncate before truncate on public.question_candidate_sources
  for each statement execute function public._q2p_no_truncate();
create trigger question_review_invitations_no_truncate before truncate on public.question_review_invitations
  for each statement execute function public._q2p_no_truncate();
create trigger question_review_sessions_no_truncate before truncate on public.question_review_sessions
  for each statement execute function public._q2p_no_truncate();
create trigger approval_records_no_truncate before truncate on public.approval_records
  for each statement execute function public._q2p_no_truncate();
create trigger buyer_question_version_origins_no_truncate before truncate on public.buyer_question_version_origins
  for each statement execute function public._q2p_no_truncate();
create trigger approved_wording_classifications_no_truncate before truncate on public.approved_wording_classifications
  for each statement execute function public._q2p_no_truncate();
create trigger exception_items_no_truncate before truncate on public.exception_items
  for each statement execute function public._q2p_no_truncate();
create trigger exception_events_no_truncate before truncate on public.exception_events
  for each statement execute function public._q2p_no_truncate();

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_membership_versions enable row level security;
alter table public.workspace_projects enable row level security;
alter table public.question_research_sets enable row level security;
alter table public.question_sources enable row level security;
alter table public.question_candidates enable row level security;
alter table public.question_candidate_sources enable row level security;
alter table public.question_review_invitations enable row level security;
alter table public.question_review_sessions enable row level security;
alter table public.approval_records enable row level security;
alter table public.buyer_question_version_origins enable row level security;
alter table public.approved_wording_classifications enable row level security;
alter table public.exception_items enable row level security;
alter table public.exception_events enable row level security;

-- Closed to every client role, service_role included: rows are written and
-- read only through the functions below.
revoke all on table
  public.workspaces, public.workspace_members, public.workspace_membership_versions,
  public.workspace_projects, public.question_research_sets, public.question_sources,
  public.question_candidates, public.question_candidate_sources,
  public.question_review_invitations, public.question_review_sessions,
  public.approval_records, public.buyer_question_version_origins,
  public.approved_wording_classifications, public.exception_items, public.exception_events
  from public, anon, authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════
-- 9. F6 — assert_current_account_member (internal; no role may execute it)
-- ════════════════════════════════════════════════════════════════════════
-- The account comes only from request.jwt.claims (role authenticated, sub a
-- UUID), never from a parameter. The active membership row is locked FOR
-- SHARE until the caller's transaction ends, so a removal (F8) waits for
-- every protected operation already authorised, and an operation that starts
-- after a removal commits is refused (§3e Property 1). One uniform refusal.

create or replace function public.assert_current_account_member(p_workspace_id uuid)
returns uuid
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_raw text := current_setting('request.jwt.claims', true);
  v_claims jsonb;
  v_sub uuid;
  v_membership_id uuid;
begin
  begin
    v_claims := nullif(v_raw, '')::jsonb;
  exception when others then
    v_claims := null;
  end;
  if v_claims is null or jsonb_typeof(v_claims) <> 'object'
     or v_claims ->> 'role' is distinct from 'authenticated'
     or coalesce(v_claims ->> 'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or p_workspace_id is null then
    raise exception using errcode = '42501', message = 'q2p_not_authorised';
  end if;
  v_sub := (v_claims ->> 'sub')::uuid;

  select m.id into v_membership_id
    from public.workspace_members m
   where m.workspace_id = p_workspace_id
     and m.account_id = v_sub
     and m.removed_at is null
   for share;

  if v_membership_id is null then
    raise exception using errcode = '42501', message = 'q2p_not_authorised';
  end if;
  return v_membership_id;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 10. F1, F2, F7, F8 — founder or system paths (service_role only)
-- ════════════════════════════════════════════════════════════════════════

create or replace function public._q2p_require_founder_or_system(
  p_actor_type text, p_operator_id uuid, p_rule_id text, p_rule_version text
) returns void
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_actor_type not in ('founder', 'system')
     or not public._q2p_actor_shape_ok(p_actor_type, null, null, null, null, p_operator_id, p_rule_id, p_rule_version) then
    raise exception using errcode = '22023', message = 'q2p_invalid_actor';
  end if;
end;
$$;

-- F1: creates the workspace, its version row and its first owner, atomically.
-- Idempotent on the key (D-021 form, no exception absorption): the same key
-- and body return ALREADY_CREATED with that workspace; the same key with a
-- different body returns IDEMPOTENCY_KEY_CONFLICT and writes nothing.
create or replace function public.create_workspace_with_owner(
  p_account_id uuid,
  p_name text,
  p_idempotency_key text,
  p_actor_type text,
  p_actor_operator_id uuid default null,
  p_rule_id text default null,
  p_rule_version text default null
) returns table (status text, workspace_id uuid, membership_id uuid)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_fp text;
  v_ws public.workspaces%rowtype;
  v_member_id uuid;
begin
  perform public._q2p_require_founder_or_system(p_actor_type, p_actor_operator_id, p_rule_id, p_rule_version);
  if p_account_id is null or coalesce(btrim(p_name), '') = '' or coalesce(btrim(p_idempotency_key), '') = '' then
    raise exception using errcode = '22023', message = 'q2p_invalid_workspace_args';
  end if;
  -- Canonical request fingerprint (D-021 form).
  v_fp := public._q2p_sha256_hex(jsonb_build_object(
    'action', 'create_workspace_with_owner', 'account_id', p_account_id, 'name', p_name)::text);

  -- Serialise every call with this key. Under READ COMMITTED the lookup below
  -- then sees a concurrent winner that has committed. Under REPEATABLE READ or
  -- SERIALIZABLE the snapshot may predate it: the insert then hits the unique
  -- key and 23505 propagates — it is never caught to return a row.
  perform pg_advisory_xact_lock(hashtextextended('zypact.q2p.create_workspace:' || p_idempotency_key, 0));

  select w.* into v_ws from public.workspaces w where w.idempotency_key = p_idempotency_key;
  if found then
    if v_ws.request_fingerprint <> v_fp then
      return query select 'IDEMPOTENCY_KEY_CONFLICT'::text, null::uuid, null::uuid;
      return;
    end if;
    -- The owner created in the same transaction as this workspace: the
    -- earliest membership of the fingerprinted account.
    select m.id into v_member_id from public.workspace_members m
     where m.workspace_id = v_ws.id and m.account_id = p_account_id
     order by m.added_at, m.id limit 1;
    return query select 'ALREADY_CREATED'::text, v_ws.id, v_member_id;
    return;
  end if;

  insert into public.workspaces (name, idempotency_key, request_fingerprint,
    actor_type, actor_operator_id, rule_id, rule_version)
  values (p_name, p_idempotency_key, v_fp,
    p_actor_type, p_actor_operator_id, p_rule_id, p_rule_version)
  returning * into v_ws;

  insert into public.workspace_membership_versions (workspace_id, version) values (v_ws.id, 0);
  update public.workspace_membership_versions
     set version = version + 1, updated_at = now()
   where workspace_membership_versions.workspace_id = v_ws.id;

  insert into public.workspace_members (workspace_id, account_id, role,
    actor_type, actor_operator_id, rule_id, rule_version)
  values (v_ws.id, p_account_id, 'owner',
    p_actor_type, p_actor_operator_id, p_rule_id, p_rule_version)
  returning id into v_member_id;

  return query select 'CREATED'::text, v_ws.id, v_member_id;
end;
$$;

-- F2: maps a project to a workspace, once.
create or replace function public.assign_project_to_workspace(
  p_project_id uuid,
  p_workspace_id uuid,
  p_actor_type text,
  p_actor_operator_id uuid default null,
  p_rule_id text default null,
  p_rule_version text default null
) returns table (status text, project_id uuid, workspace_id uuid)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_existing uuid;
begin
  perform public._q2p_require_founder_or_system(p_actor_type, p_actor_operator_id, p_rule_id, p_rule_version);
  if p_project_id is null or p_workspace_id is null
     or not exists (select 1 from public.projects p where p.id = p_project_id)
     or not exists (select 1 from public.workspaces w where w.id = p_workspace_id) then
    raise exception using errcode = '22023', message = 'q2p_invalid_mapping_args';
  end if;

  select wp.workspace_id into v_existing from public.workspace_projects wp where wp.project_id = p_project_id;
  if found then
    raise exception using errcode = '23505', message = 'q2p_project_already_mapped';
  end if;

  insert into public.workspace_projects (project_id, workspace_id,
    actor_type, actor_operator_id, rule_id, rule_version)
  values (p_project_id, p_workspace_id,
    p_actor_type, p_actor_operator_id, p_rule_id, p_rule_version);

  return query select 'MAPPED'::text, p_project_id, p_workspace_id;
end;
$$;

-- F7: adds an active owner. Every membership change first writes the
-- workspace's version row, so concurrent changes conflict under every
-- isolation level (§3e Property 2). A duplicate active row is an idempotent
-- return of the existing membership. No internal retry: a 40001 surfaces.
create or replace function public.add_workspace_member(
  p_workspace_id uuid,
  p_account_id uuid,
  p_actor_type text,
  p_actor_operator_id uuid default null,
  p_rule_id text default null,
  p_rule_version text default null
) returns table (status text, membership_id uuid)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_member_id uuid;
begin
  perform public._q2p_require_founder_or_system(p_actor_type, p_actor_operator_id, p_rule_id, p_rule_version);
  if p_workspace_id is null or p_account_id is null then
    raise exception using errcode = '22023', message = 'q2p_invalid_member_args';
  end if;

  update public.workspace_membership_versions
     set version = version + 1, updated_at = now()
   where workspace_membership_versions.workspace_id = p_workspace_id;
  if not found then
    raise exception using errcode = '22023', message = 'q2p_workspace_not_found';
  end if;

  select m.id into v_member_id from public.workspace_members m
   where m.workspace_id = p_workspace_id and m.account_id = p_account_id and m.removed_at is null;
  if found then
    return query select 'ALREADY_MEMBER'::text, v_member_id;
    return;
  end if;

  -- No handler: the version-row write above serialises every membership change
  -- of this workspace, so under READ COMMITTED the check above already sees a
  -- concurrent duplicate that committed, and under REPEATABLE READ or
  -- SERIALIZABLE the version-row write raised 40001. A 23505 here can only come
  -- from a writer that bypassed this function, and it propagates.
  insert into public.workspace_members (workspace_id, account_id, role,
    actor_type, actor_operator_id, rule_id, rule_version)
  values (p_workspace_id, p_account_id, 'owner',
    p_actor_type, p_actor_operator_id, p_rule_id, p_rule_version)
  returning id into v_member_id;

  return query select 'ADDED'::text, v_member_id;
end;
$$;

-- F8: removes a membership once. Lock order: version row first, then the
-- membership row. Refuses to remove the last active owner. Idempotent on an
-- already-removed membership. No internal retry.
create or replace function public.remove_workspace_member(
  p_workspace_id uuid,
  p_membership_id uuid,
  p_actor_type text,
  p_actor_operator_id uuid default null,
  p_rule_id text default null,
  p_rule_version text default null
) returns table (status text, membership_id uuid, removed_at timestamptz)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_target public.workspace_members%rowtype;
  v_others bigint;
begin
  perform public._q2p_require_founder_or_system(p_actor_type, p_actor_operator_id, p_rule_id, p_rule_version);
  if p_workspace_id is null or p_membership_id is null then
    raise exception using errcode = '22023', message = 'q2p_invalid_member_args';
  end if;

  update public.workspace_membership_versions
     set version = version + 1, updated_at = now()
   where workspace_membership_versions.workspace_id = p_workspace_id;
  if not found then
    raise exception using errcode = '22023', message = 'q2p_workspace_not_found';
  end if;

  select m.* into v_target from public.workspace_members m
   where m.id = p_membership_id and m.workspace_id = p_workspace_id
   for update;
  if not found then
    raise exception using errcode = '22023', message = 'q2p_membership_not_found';
  end if;
  if v_target.removed_at is not null then
    return query select 'ALREADY_REMOVED'::text, v_target.id, v_target.removed_at;
    return;
  end if;

  select count(*) into v_others from public.workspace_members m
   where m.workspace_id = p_workspace_id and m.removed_at is null and m.id <> v_target.id;
  if v_others = 0 then
    raise exception using errcode = 'P0001', message = 'last_active_owner';
  end if;

  update public.workspace_members m
     set removed_at = now(),
         removed_actor_type = p_actor_type,
         removed_operator_id = p_actor_operator_id,
         removed_rule_id = p_rule_id,
         removed_rule_version = p_rule_version
   where m.id = v_target.id and m.removed_at is null
  returning * into v_target;

  return query select 'REMOVED'::text, v_target.id, v_target.removed_at;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 11. F4 — approve_buyer_question_set (invitation-session path)
-- ════════════════════════════════════════════════════════════════════════

-- Source-backed evidence checks used for every observed or adapted wording
-- classification F4 writes (strict; see the F4 header for the divergence
-- from Q1). Each re-reads the stored rows at approval time, so a row that
-- reached the table by any path is checked again before it can promote text.

-- True only when p_text is, byte for byte, the quoted span of a verbatim link
-- from the candidate to p_source_id, and that source is buyer-authored, is
-- not site copy, carries verification p_verification, still hashes to its
-- stored excerpt hash, and still contains the span on word boundaries.
create or replace function public._q2p_observed_span_ok(
  p_candidate_id uuid, p_source_id uuid, p_text text, p_verification text
) returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select p_candidate_id is not null and p_source_id is not null and p_text is not null
     and p_verification is not null
     and exists (
       select 1
         from public.question_candidate_sources l
         join public.question_sources s on s.id = l.source_id
        where l.candidate_id = p_candidate_id
          and l.source_id = p_source_id
          and l.relation = 'verbatim'
          and l.quoted_span = p_text
          and s.buyer_authored
          and s.source_kind <> 'site_copy'
          and s.verification = p_verification
          and s.excerpt_sha256 = public._q2p_sha256_hex(s.excerpt)
          and strpos(s.excerpt, l.quoted_span) > 0
          and public._q2p_span_at_word_boundary(s.excerpt, l.quoted_span));
$$;

-- True only when the candidate's p_source_id is a paraphrase basis from a
-- buyer-authored, non-site-copy source carrying verification p_verification,
-- whose excerpt still hashes to its stored hash.
create or replace function public._q2p_adapted_basis_ok(
  p_candidate_id uuid, p_source_id uuid, p_verification text
) returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
  select p_candidate_id is not null and p_source_id is not null and p_verification is not null
     and exists (
       select 1
         from public.question_candidate_sources l
         join public.question_sources s on s.id = l.source_id
        where l.candidate_id = p_candidate_id
          and l.source_id = p_source_id
          and l.relation = 'paraphrase_basis'
          and s.buyer_authored
          and s.source_kind <> 'site_copy'
          and s.verification = p_verification
          and s.excerpt_sha256 = public._q2p_sha256_hex(s.excerpt));
$$;
-- service_role only (the server route). The actor and the scope come only
-- from the hash of the presented session token. One uniform refusal for any
-- authorisation or scope failure. All-or-nothing; idempotent; exact-text
-- prompt hashes. NO PAID EFFECT: it writes nothing to protocols,
-- protocol_execution_jobs, buyer_question_launch_selections or
-- snapshot_requests, and calls no provider.
--
-- p_items: a JSON array of 1-3 objects
--   {"origin": "...", "candidate_id": "<uuid>|null", "text": "...", "prompt_hash": "<sha256 hex of text>"}
--
-- Authorisation (uniform refusal 42501 on any failure): the session is
-- unrevoked, within its absolute and idle limits; its invitation is
-- unrevoked, not superseded, unexpired, exchanged and email-verified; the
-- research set is the session's; the snapshot request's PERSISTED
-- normalized_email, read under lock, still matches the invitation's
-- request_email_binding. No email value is accepted from the caller.
-- Replays require all of this too.
--
-- Locks and time (R6): session FOR UPDATE, then invitation FOR SHARE, then
-- snapshot request FOR SHARE, then research set FOR UPDATE — always in that
-- order. Every expiry and idle check uses one clock_timestamp() taken after
-- all four locks are held (never the
-- transaction start), and that same instant is the approval's approved_at and
-- the session's new last_seen_at. A revocation committed before the locks is
-- seen (READ COMMITTED) or fails the call with 40001 (REPEATABLE READ,
-- SERIALIZABLE); a revocation attempted while an authorised approval holds
-- the locks waits for it. lock_timeout (5 s) fails a long wait with 55P03.
-- Future revocation or reissue paths that touch both rows must lock the
-- session before the invitation, or PostgreSQL may abort one side with 40P01.
-- A change to the request's address (none exists today) either committed
-- before the request lock and is seen, raises 40001 under REPEATABLE READ /
-- SERIALIZABLE, or waits for this approval. Under REPEATABLE READ any update
-- of the request row after the snapshot (a worker status change, say) also
-- raises 40001: a closed failure the caller retries.
--
-- Idempotency (D-021 form; no exception absorption), only after authorisation:
--   the request fingerprint is a canonical jsonb of the research set, the
--   consent text version and hash, and the set of items (origin, candidate,
--   prompt hash), sorted by prompt hash — the order in which questions are
--   submitted has no meaning in an approval, so it is ignored. Keys are
--   scoped to the research set. Under the research-set row lock:
--     same key, same fingerprint   -> ALREADY_APPROVED (the original record)
--     same key, other fingerprint  -> IDEMPOTENCY_KEY_CONFLICT (no write)
--     other key, same fingerprint  -> ALREADY_APPROVED (the original record)
--     other key, other fingerprint -> SET_ALREADY_APPROVED (no write)
--
-- Wording classification: strictly source-backed, never weaker than Q1.
--   observed  only when the approved text is, byte for byte, the quoted span
--             of a verbatim link from the candidate's PRIMARY source, and that
--             source is buyer-authored, not site copy, carries the
--             verification recorded, still hashes to its excerpt hash and
--             still contains the span on word boundaries
--             (_q2p_observed_span_ok). Unchanged or replaced text inherits
--             observed under rule inherited_unchanged only if this holds for
--             the candidate's own verification; edited text is observed under
--             exact_source_match with the primary source's verification.
--   adapted   (unchanged or replaced only) only when the primary source is a
--             paraphrase basis from a buyer-authored, non-site-copy source with
--             the candidate's verification (_q2p_adapted_basis_ok).
--   hypothesis (unchanged or replaced) is inherited as is.
--   Everything else — including customer-written text — is pending_review.
-- Verification is never upgraded: customer_provided stays customer_provided.
-- Divergence from Q1 (lib/buyer-questions/classify-wording.ts), always in the
-- conservative direction: Q1 accepts whitespace, terminal-punctuation and
-- other normalisation-tolerant matches (isObservedMatch) and a caller-chosen
-- primary source; here those cases are pending_review for founder review,
-- which may record adapted or hypothesis but never observed.

create or replace function public.approve_buyer_question_set(
  p_session_token text,
  p_research_set_id uuid,
  p_items jsonb,
  p_idempotency_key text,
  p_consent_text_version text,
  p_consent_text_sha256 text
) returns table (status text, approval_record_id uuid, version_ids uuid[])
language plpgsql
security definer
volatile
set search_path = public, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_session public.question_review_sessions%rowtype;
  v_invitation public.question_review_invitations%rowtype;
  v_set public.question_research_sets%rowtype;
  v_existing public.approval_records%rowtype;
  v_n integer;
  v_item jsonb;
  v_i integer;
  v_text text;
  v_hash text;
  v_origin text;
  v_cand_id uuid;
  v_cand public.question_candidates%rowtype;
  v_fp text;
  v_record_id uuid := gen_random_uuid();
  v_version_ids uuid[] := '{}';
  v_hashes text[] := '{}';
  v_origins text[] := '{}';
  v_cand_ids uuid[] := '{}';
  v_texts text[] := '{}';
  v_question_id uuid;
  v_status text;
  v_class text;
  v_rule text;
  v_verif text;
  v_basis uuid[];
  v_cv integer;
  v_win integer;
  v_rationale text;
  v_refuse constant text := 'question_set_refused';
  v_check_at timestamptz;
  v_request_email text;
begin
  -- Authorisation: the session token, hashed with its purpose label.
  if p_session_token is null or length(p_session_token) < 32 then
    raise exception using errcode = '42501', message = v_refuse;
  end if;

  select s.* into v_session from public.question_review_sessions s
   where s.token_hash = public._q2p_token_hash('zypact.question_review_session.v1', p_session_token)
   for update;
  if not found then
    raise exception using errcode = '42501', message = v_refuse;
  end if;

  -- The invitation is locked FOR SHARE, so a revocation (an UPDATE of this
  -- row) either committed before this lock — and is seen, or, under
  -- REPEATABLE READ / SERIALIZABLE with an older snapshot, raises 40001 — or
  -- waits until this approval has committed. Lock order is always session,
  -- then invitation, then snapshot request, then research set; nothing here
  -- locks them in another order.
  select i.* into v_invitation from public.question_review_invitations i
   where i.id = v_session.invitation_id
   for share;

  -- The persisted request email, locked FOR SHARE (a change to it either
  -- committed before this lock and is seen, raises 40001 under REPEATABLE
  -- READ / SERIALIZABLE, or waits for this approval). Lock order: session,
  -- invitation, snapshot request, research set.
  select r.normalized_email into v_request_email from public.snapshot_requests r
   where r.id = v_session.snapshot_request_id
   for share;

  -- Serialise approvals of this research set (locked before the decision, so
  -- expiry is judged after every wait).
  select rs.* into v_set from public.question_research_sets rs
   where rs.id = v_session.research_set_id and rs.project_id = v_session.project_id
   for update;

  -- The authorisation decision point: one wall-clock instant, taken after all
  -- four locks are held, used for every expiry and idle check, for the
  -- session's last_seen_at, and as the approval timestamp.
  v_check_at := clock_timestamp();

  if v_set.id is null
     or v_session.revoked_at is not null
     or v_session.absolute_expires_at <= v_check_at
     or v_session.last_seen_at <= v_check_at - interval '15 minutes'
     or v_invitation.revoked_at is not null
     or v_invitation.superseded_by is not null
     or v_invitation.expires_at <= v_check_at
     or v_invitation.exchanged_at is null
     or v_invitation.email_verified_at is null
     -- Scope is the session's, never the caller's.
     or p_research_set_id is distinct from v_session.research_set_id
     -- The request's persisted address must still be the one the invitation
     -- was issued against (derived in the database, never caller-supplied).
     or v_request_email is null
     or v_invitation.request_email_binding is null
     or public._q2p_request_email_binding(v_invitation.id, v_request_email)
          is distinct from v_invitation.request_email_binding then
    raise exception using errcode = '42501', message = v_refuse;
  end if;

  -- Content.
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_question_set';
  end if;
  v_n := jsonb_array_length(p_items);
  if v_n < 1 or v_n > 3
     or coalesce(btrim(p_idempotency_key), '') = ''
     or coalesce(btrim(p_consent_text_version), '') = ''
     or coalesce(p_consent_text_sha256, '') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_question_set';
  end if;

  for v_i in 0 .. v_n - 1 loop
    v_item := p_items -> v_i;
    v_origin := v_item ->> 'origin';
    v_text := v_item ->> 'text';
    v_hash := v_item ->> 'prompt_hash';
    begin
      v_cand_id := nullif(v_item ->> 'candidate_id', '')::uuid;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_question_set';
    end;
    if v_origin is null or v_origin not in
         ('recommended_unchanged', 'recommended_edited', 'replaced_with_candidate', 'customer_written')
       or v_text is null or btrim(v_text) = ''
       or v_hash is null or v_hash <> public._q2p_sha256_hex(v_text)
       or v_hash = any(v_hashes) then
      raise exception using errcode = '22023', message = 'invalid_question_set';
    end if;
    if v_origin = 'customer_written' then
      if v_cand_id is not null then
        raise exception using errcode = '22023', message = 'invalid_question_set';
      end if;
    else
      select c.* into v_cand from public.question_candidates c
       where c.id = v_cand_id and c.research_set_id = v_session.research_set_id
         and c.project_id = v_session.project_id;
      if not found then
        -- A candidate outside the session's research set is a scope failure.
        raise exception using errcode = '42501', message = v_refuse;
      end if;
      if (v_origin in ('recommended_unchanged', 'replaced_with_candidate')
            and public._q2p_sha256_hex(v_cand.candidate_text) <> v_hash)
         or (v_origin = 'recommended_edited' and public._q2p_sha256_hex(v_cand.candidate_text) = v_hash)
         or (v_origin in ('recommended_unchanged', 'recommended_edited') and not v_cand.preselected)
         or (v_origin = 'replaced_with_candidate' and v_cand.preselected) then
        raise exception using errcode = '22023', message = 'invalid_question_set';
      end if;
    end if;
    v_hashes := v_hashes || v_hash;
    v_origins := v_origins || v_origin;
    v_cand_ids := v_cand_ids || v_cand_id;
    v_texts := v_texts || v_text;
    v_version_ids := v_version_ids || gen_random_uuid();
  end loop;

  -- Canonical request fingerprint (D-021 form): order-independent over items.
  v_fp := public._q2p_sha256_hex(jsonb_build_object(
    'action', 'approve_buyer_question_set',
    'research_set_id', v_set.id,
    'consent_text_version', p_consent_text_version,
    'consent_text_sha256', p_consent_text_sha256,
    'items', (select jsonb_agg(jsonb_build_object(
                       'origin', u.origin, 'candidate_id', u.candidate_id, 'prompt_hash', u.prompt_hash)
                     order by u.prompt_hash)
                from unnest(v_origins, v_cand_ids, v_hashes) as u(origin, candidate_id, prompt_hash))
  )::text);

  -- Idempotency, under the research-set lock taken above.
  select a.* into v_existing from public.approval_records a
   where a.research_set_id = v_set.id and a.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.set_fingerprint <> v_fp then
      return query select 'IDEMPOTENCY_KEY_CONFLICT'::text, null::uuid, null::uuid[];
      return;
    end if;
    update public.question_review_sessions set last_seen_at = greatest(last_seen_at, v_check_at)
     where id = v_session.id;
    return query select 'ALREADY_APPROVED'::text, v_existing.id, v_existing.approved_version_ids;
    return;
  end if;
  select a.* into v_existing from public.approval_records a where a.research_set_id = v_set.id;
  if found then
    if v_existing.set_fingerprint <> v_fp then
      return query select 'SET_ALREADY_APPROVED'::text, null::uuid, null::uuid[];
      return;
    end if;
    update public.question_review_sessions set last_seen_at = greatest(last_seen_at, v_check_at)
     where id = v_session.id;
    return query select 'ALREADY_APPROVED'::text, v_existing.id, v_existing.approved_version_ids;
    return;
  end if;

  insert into public.approval_records (
    id, workspace_id, project_id, snapshot_request_id, research_set_id, action_type,
    approved_version_ids, prompt_hashes, approved_at, session_type, session_id,
    verified_email_hmac, email_hmac_key_id, consent_text_version, consent_text_sha256,
    idempotency_key, set_fingerprint,
    actor_type, actor_invitation_id, actor_session_id
  ) values (
    v_record_id, v_session.workspace_id, v_session.project_id, v_session.snapshot_request_id, v_set.id,
    'approve_buyer_question_set',
    v_version_ids, v_hashes, v_check_at, 'review_invitation', v_session.id,
    v_invitation.email_hmac, v_invitation.email_hmac_key_id, p_consent_text_version, p_consent_text_sha256,
    p_idempotency_key, v_fp,
    'invitation_holder', v_invitation.id, v_session.id
  );

  for v_i in 1 .. v_n loop
    v_cand := null;
    if v_cand_ids[v_i] is not null then
      select c.* into v_cand from public.question_candidates c where c.id = v_cand_ids[v_i];
    end if;

    -- First wording classification: strictly source-backed (see the header).
    v_class := 'pending_review'; v_rule := null; v_verif := null; v_basis := '{}';
    if v_origins[v_i] in ('recommended_unchanged', 'replaced_with_candidate') then
      if v_cand.evidence_grade = 'hypothesis' then
        v_class := 'hypothesis'; v_rule := 'inherited_unchanged';
      elsif v_cand.evidence_grade = 'observed'
            and public._q2p_observed_span_ok(v_cand.id, v_cand.primary_source_id, v_texts[v_i], v_cand.verification) then
        v_class := 'observed'; v_rule := 'inherited_unchanged';
        v_verif := v_cand.verification; v_basis := array[v_cand.primary_source_id];
      elsif v_cand.evidence_grade = 'adapted'
            and public._q2p_adapted_basis_ok(v_cand.id, v_cand.primary_source_id, v_cand.verification) then
        v_class := 'adapted'; v_rule := 'inherited_unchanged';
        v_verif := v_cand.verification; v_basis := array[v_cand.primary_source_id];
      end if;
    elsif v_origins[v_i] = 'recommended_edited' and v_cand.primary_source_id is not null then
      select s.verification into v_verif from public.question_sources s where s.id = v_cand.primary_source_id;
      if public._q2p_observed_span_ok(v_cand.id, v_cand.primary_source_id, v_texts[v_i], v_verif) then
        v_class := 'observed'; v_rule := 'exact_source_match'; v_basis := array[v_cand.primary_source_id];
      else
        v_verif := null;
      end if;
    end if;

    if v_cand_ids[v_i] is null then
      v_cv := 1; v_win := 1; v_rationale := 'awaiting review';
    else
      v_cv := 1 + v_cand.commercial_intent + case when v_cand.icp_fit = 3 then 1 else 0 end;
      v_win := 1 + v_cand.product_relevance + case when v_class = 'observed' then 1 else 0 end;
      v_rationale := 'Sort order from curator ratings (heuristic v1).'
        || ' Buyer relevance ' || v_cand.buyer_relevance || ': ' || btrim(v_cand.buyer_relevance_reason) || '.'
        || ' ICP fit ' || v_cand.icp_fit || ': ' || btrim(v_cand.icp_fit_reason) || '.'
        || ' Commercial intent ' || v_cand.commercial_intent || ': ' || btrim(v_cand.commercial_intent_reason) || '.'
        || ' Product relevance ' || v_cand.product_relevance || ': ' || btrim(v_cand.product_relevance_reason) || '.'
        || ' Wording ' || case when v_class = 'observed' then 'observed' else 'not observed' end || '.';
    end if;

    insert into public.buyer_questions (project_id) values (v_session.project_id) returning id into v_question_id;
    insert into public.buyer_question_versions (
      id, buyer_question_id, project_id, version_number, prompt_text, prompt_hash, intent_type,
      commercial_value, winnability, priority, rationale, provenance
    ) values (
      v_version_ids[v_i], v_question_id, v_session.project_id, 1, v_texts[v_i], v_hashes[v_i],
      coalesce(v_cand.intent, 'unclassified'),
      v_cv, v_win, least(25, v_cv * v_win), v_rationale,
      case when v_cand_ids[v_i] is null then 'customer_supplied' else 'founder_supplied' end
    );

    select a.status into v_status
      from public.approve_buyer_question_version(v_version_ids[v_i], v_session.project_id, v_record_id) a;
    if v_status is distinct from 'APPROVED' then
      raise exception using errcode = '55000', message = 'q2p_version_approval_failed';
    end if;

    insert into public.buyer_question_version_origins (
      version_id, workspace_id, project_id, approval_record_id, candidate_id, origin,
      candidate_grade, candidate_verification, candidate_text_hash, approved_text_hash,
      actor_type, actor_invitation_id, actor_session_id
    ) values (
      v_version_ids[v_i], v_session.workspace_id, v_session.project_id, v_record_id, v_cand_ids[v_i], v_origins[v_i],
      v_cand.evidence_grade, v_cand.verification,
      case when v_cand_ids[v_i] is null then null else public._q2p_sha256_hex(v_cand.candidate_text) end,
      v_hashes[v_i],
      'invitation_holder', v_invitation.id, v_session.id
    );

    insert into public.approved_wording_classifications (
      version_id, workspace_id, project_id, classification, verification, basis_source_ids, rule,
      actor_type, actor_invitation_id, actor_session_id
    ) values (
      v_version_ids[v_i], v_session.workspace_id, v_session.project_id, v_class, v_verif, v_basis, v_rule,
      'invitation_holder', v_invitation.id, v_session.id
    );
  end loop;

  update public.question_review_sessions set last_seen_at = greatest(last_seen_at, v_check_at)
   where id = v_session.id;

  return query select 'APPROVED'::text, v_record_id, v_version_ids;
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- 12. Function privileges
-- ════════════════════════════════════════════════════════════════════════

revoke all on function public._q2p_actor_shape_ok(text, uuid, uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public._q2p_token_hash(text, text) from public, anon, authenticated, service_role;
revoke all on function public._q2p_sha256_hex(text) from public, anon, authenticated, service_role;
revoke all on function public._q2p_span_at_word_boundary(text, text) from public, anon, authenticated, service_role;
revoke all on function public._q2p_append_only() from public, anon, authenticated, service_role;
revoke all on function public._q2p_no_truncate() from public, anon, authenticated, service_role;
revoke all on function public._q2p_workspace_members_guard() from public, anon, authenticated, service_role;
revoke all on function public._q2p_membership_versions_guard() from public, anon, authenticated, service_role;
revoke all on function public._q2p_research_set_scope_check() from public, anon, authenticated, service_role;
revoke all on function public._q2p_candidate_source_check() from public, anon, authenticated, service_role;
revoke all on function public._q2p_candidate_evidence_check() from public, anon, authenticated, service_role;
revoke all on function public._q2p_invitation_guard() from public, anon, authenticated, service_role;
revoke all on function public._q2p_request_email_binding(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public._q2p_invitation_bind_request_email() from public, anon, authenticated, service_role;
revoke all on function public._q2p_session_within_invitation() from public, anon, authenticated, service_role;
revoke all on function public._q2p_session_guard() from public, anon, authenticated, service_role;
revoke all on function public._q2p_require_founder_or_system(text, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public._q2p_observed_span_ok(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public._q2p_adapted_basis_ok(uuid, uuid, text) from public, anon, authenticated, service_role;

-- F6: no role executes it directly.
revoke all on function public.assert_current_account_member(uuid) from public, anon, authenticated, service_role;

-- Founder/system and invitation paths: service_role only.
revoke all on function public.create_workspace_with_owner(uuid, text, text, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.assign_project_to_workspace(uuid, uuid, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.add_workspace_member(uuid, uuid, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.remove_workspace_member(uuid, uuid, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.approve_buyer_question_set(text, uuid, jsonb, text, text, text) from public, anon, authenticated;
grant execute on function public.create_workspace_with_owner(uuid, text, text, text, uuid, text, text) to service_role;
grant execute on function public.assign_project_to_workspace(uuid, uuid, text, uuid, text, text) to service_role;
grant execute on function public.add_workspace_member(uuid, uuid, text, uuid, text, text) to service_role;
grant execute on function public.remove_workspace_member(uuid, uuid, text, uuid, text, text) to service_role;
grant execute on function public.approve_buyer_question_set(text, uuid, jsonb, text, text, text) to service_role;
