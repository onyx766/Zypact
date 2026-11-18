-- Pilot retest and Outcome Cards inside the pilot report (D-062).
--
-- Purpose. One registered customer change across 1-5 live pilot questions,
-- each measured again on both engines after the change. The founder registers
-- it once the customer has approved it in writing; one group step creates one
-- approved M7 intervention per question and engine (2-10 in all). The change
-- is recorded as live, the waiting period passes, each member gets an
-- approved retest protocol, a queued job and a retest slot, and each retest is
-- run from the pilot page like any other measurement. The Outcome Cards live
-- inside the pilot report revision, never in a table of their own, and a
-- revision with any retest always needs review.
--
-- Release order (D-058 item 4). Numbered inside D-058's window, after
-- 20261109180000 and before 20261110120000. Through the named-file procedure:
-- expected_prev=20261109180000. Apply with the protocol worker stopped and the
-- founder console idle: the ALTERs and the table locks below wait for no one
-- then. The web app built from the same commit is deployed after this
-- migration; the worker image is unchanged. It references nothing created by
-- the unapplied stack 20261110120000-20261113120000.
--
-- Dependencies. 0071-0079 unchanged; 20261109140000 (pilot questions),
-- 20261109150000 (report artifacts), 20261109160000 (pilot actions),
-- 20261109170000 (the unscoped claims revoked) and 20261109180000 (ChatGPT
-- measurement). Preparation queues up to 10 retest jobs, and a queued job is
-- inert only while the unscoped claims stay revoked, so that revoke is a
-- precondition.
--
-- What it changes:
--   1. pilot_question_protocols: the phase CHECK accepts 'retest'; a retest
--      slot names its member (pilot_retest_member_id, one slot per member)
--      and only a baseline slot can be a member's baseline (a new unique key
--      the members' foreign key targets). The slot key (question, engine,
--      phase) is kept, so a question has at most one retest slot per engine.
--   2. Four tables: pilot_retests (the group, its registered text and its
--      lifecycle), pilot_retest_members (one per question and engine, each
--      exactly one M7 intervention), pilot_retest_notes (the log of other
--      changes) and pilot_retest_steps (the writer record, below). RLS on, no
--      policy, service_role may only read them; members, notes and steps are
--      append-only, and a group's registered text and each lifecycle tuple
--      are written once.
--   3. The writer record. Every group step inserts its pilot_retest_steps row
--      (stamped with pg_current_xact_id()) before any wrapped M7 call. The
--      triggers on interventions, protocols and pilot slots accept a write
--      on a pilot baseline only when a step of the right kind, for the right
--      group, exists in the same transaction. service_role cannot insert a
--      step, so no direct session can forge one; the table owner can, as it
--      can disable any trigger (the residual risk D-062 records).
--   4. The helper pilot_retest_job_is_final(job): true when no path in the
--      product can still add or change a retest answer (lib/pilots/
--      retest-rules.ts retestJobIsFinal mirrors it).
--   5. Six group steps, each one transaction under the pilot row lock:
--      register_pilot_retest, confirm_pilot_retest_implementation,
--      prepare_pilot_retests, abandon_pilot_retest, requeue_pilot_retest_job
--      and add_pilot_retest_note. Nothing here runs, reserves or spends:
--      preparation only queues, and each retest is run by its own Run.
--   6. Six trigger functions and eight triggers (section 4).
--   7. save_pilot_report_artifact and share_pilot_report_artifact:
--      20261109160000's bodies byte for byte plus one block marked D-062
--      begin/end each (scripts/test-pilot-retest-schema.ts proves it). With
--      no group and no retest slot both blocks pass, so every revision
--      without a retest behaves exactly as before.
--
-- What it leaves alone. No function of 0071-0079 is redefined (0078 and 0079
-- hold by construction: the group steps call the M7 functions, they never
-- replace them). No M5 job, claim, admission, reservation or receipt function
-- is redefined. No existing row is updated or deleted, and nothing calls a
-- provider.
--
-- Lock-order invariant. A group step takes the pilot row FOR UPDATE, then its
-- group row FOR UPDATE, then (abandon and requeue only) retest job rows FOR
-- UPDATE NOWAIT, then whatever the wrapped M7 calls lock. It never waits for
-- a protocol_execution_jobs row lock: Run and Retry lock the job before the
-- pilot, so a busy job answers RETEST_JOB_BUSY instead of a deadlock.
--
-- Preconditions (each its own block; any failure aborts the transaction):
-- 20261109170000 is applied (its unscoped claims revoked); 20261109180000 is
-- applied (its functions, trigger, index and the two slot CHECKs as it left
-- them); the wrapped M7 functions exist with their signatures; the save and
-- share functions are 20261109160000's (md5 of their source pinned); none of
-- the objects created here exists; and, under SHARE ROW EXCLUSIVE locks on
-- interventions, protocols and outcome_card_artifacts held to commit, no
-- intervention, protocol or Outcome Card row references a pilot slot's
-- protocol. Postconditions at the end assert the definitions, triggers and
-- privileges.
--
-- Recovery.
--   * Before any pilot_retests row exists, in one transaction, in this order:
--       drop trigger if exists outcome_card_artifacts_pilot_retest_guard on public.outcome_card_artifacts;
--       drop trigger if exists protocols_pilot_retest_guard on public.protocols;
--       drop trigger if exists interventions_pilot_retest_guard on public.interventions;
--       drop trigger if exists pilot_question_protocols_retest_slot on public.pilot_question_protocols;
--       drop trigger if exists pilot_retest_steps_append_only on public.pilot_retest_steps;
--       drop trigger if exists pilot_retest_notes_append_only on public.pilot_retest_notes;
--       drop trigger if exists pilot_retest_members_append_only on public.pilot_retest_members;
--       drop trigger if exists pilot_retests_guard on public.pilot_retests;
--     then re-run 20261109160000 sections 6 and 7 (the save and share
--     definitions and their four privilege lines each), then drop the 13
--     functions of sections 2 to 4 below:
--       drop function if exists public.add_pilot_retest_note(uuid, uuid, uuid, date, text, text, uuid, uuid);
--       drop function if exists public.requeue_pilot_retest_job(uuid, uuid, uuid, text, uuid, text);
--       drop function if exists public.abandon_pilot_retest(uuid, uuid, uuid, text, boolean);
--       drop function if exists public.prepare_pilot_retests(uuid, uuid, uuid);
--       drop function if exists public.confirm_pilot_retest_implementation(uuid, uuid, uuid, date, text, text, text, boolean, text, boolean);
--       drop function if exists public.register_pilot_retest(uuid, uuid, uuid[], text, text, text, text, text, text, text, text, text, text, boolean, text, integer, text, date, uuid[], boolean, uuid);
--       drop function if exists public.pilot_retest_card_guard();
--       drop function if exists public.pilot_retest_protocol_guard();
--       drop function if exists public.pilot_retest_intervention_guard();
--       drop function if exists public.pilot_retest_slot_check();
--       drop function if exists public.pilot_retest_rows_append_only();
--       drop function if exists public.pilot_retests_guard();
--       drop function if exists public.pilot_retest_job_is_final(uuid);
--     then, on pilot_question_protocols:
--       alter table public.pilot_question_protocols drop constraint pilot_question_protocols_retest_member_fk;
--       alter table public.pilot_question_protocols drop constraint pilot_question_protocols_retest_member_check;
--       alter table public.pilot_question_protocols drop constraint pilot_question_protocols_member_key;
--       alter table public.pilot_question_protocols drop column pilot_retest_member_id;
--       alter table public.pilot_retest_members drop constraint pilot_retest_members_baseline_slot_fk;
--       alter table public.pilot_question_protocols drop constraint pilot_question_protocols_slot_protocol_key;
--       alter table public.pilot_question_protocols drop constraint pilot_question_protocols_phase_check;
--       alter table public.pilot_question_protocols add constraint pilot_question_protocols_phase_check check (phase = 'baseline');
--     (the re-added CHECK fails, and so the whole recovery, if a retest slot
--     exists), restore the table comment 20261109180000 wrote (its section
--     3), and drop the four tables:
--       drop table if exists public.pilot_retest_steps;
--       drop table if exists public.pilot_retest_notes;
--       drop table if exists public.pilot_retest_members;
--       drop table if exists public.pilot_retests;
--     scripts/test-pilot-retest-db.ts runs exactly these statements before
--     re-running this file (case G), which proves them.
--   * Once a group exists, recovery is forward only: its members reference
--     frozen interventions, and its notes and steps are history.
--       - Operational stop: unset ZYPACT_PILOT_RETEST_ENABLED on the web
--         host. Reports still show existing groups; abandon and notes stay
--         available, as review resolution does.
--       - If a trigger on an existing table blocks legitimate M7 work outside
--         the pilots, each of interventions_pilot_retest_guard,
--         protocols_pilot_retest_guard and
--         outcome_card_artifacts_pilot_retest_guard may be dropped on its own
--         as a separately authorised step. The group steps do not depend on
--         them, and the application keeps its own exclusions.
--       - If the group functions are ever dropped while the triggers stay,
--         M7 writes on pilot baselines stay refused: that fails closed.
--       - No web rollback below this release after the first preparation:
--         an older reader reads baseline slots only, while the save requires
--         every slot's protocol, so every build would answer
--         EVIDENCE_INCOMPLETE.

-- =======================================================================
-- 0. Preconditions
-- =======================================================================

-- 1. 20261109170000 is applied: a queued retest job is inert only while the
--    unscoped claims cannot be called by service_role.
do $$
begin
  if to_regprocedure('public.read_shared_pilot_report(text)') is null
     or to_regprocedure('public.claim_protocol_execution_job(text,integer)') is null
     or to_regprocedure('public.claim_protocol_execution_job_by_id(text,integer,uuid,uuid)') is null then
    raise exception using
      errcode = 'P0001',
      message = '20261109190000 precondition: 20261109170000 is not applied (the pilot report read or an unscoped claim is missing)';
  end if;

  if has_function_privilege('service_role', 'public.claim_protocol_execution_job(text,integer)', 'execute') then
    raise exception using
      errcode = 'P0001',
      message = '20261109190000 precondition: claim_protocol_execution_job is executable by service_role (20261109170000 revokes it)';
  end if;

  if has_function_privilege('service_role', 'public.claim_protocol_execution_job_by_id(text,integer,uuid,uuid)', 'execute') then
    raise exception using
      errcode = 'P0001',
      message = '20261109190000 precondition: claim_protocol_execution_job_by_id is executable by service_role (20261109170000 revokes it)';
  end if;
end $$;

-- 2. 20261109180000 is applied, and the slot CHECKs are as it left them.
do $$
declare
  v_def text;
begin
  if to_regprocedure('public.add_pilot_question_engine(uuid,uuid,text,uuid)') is null
     or to_regprocedure('public.protocol_worker_capabilities()') is null
     or to_regprocedure('public.pilot_question_protocols_consistency()') is null
     or to_regclass('public.protocols_one_live_baseline_per_engine') is null then
    raise exception using
      errcode = 'P0001',
      message = '20261109190000 precondition: 20261109180000 is not applied (a function or the per-engine index is missing)';
  end if;

  if not exists (
    select 1
      from pg_trigger t
     where t.tgrelid = 'public.pilot_question_protocols'::regclass
       and t.tgname = 'pilot_question_protocols_consistency'
       and t.tgfoid = 'public.pilot_question_protocols_consistency()'::regprocedure
       and t.tgenabled = 'O'
       and not t.tgisinternal
  ) then
    raise exception using
      errcode = 'P0001',
      message = '20261109190000 precondition: the slot consistency trigger of 20261109180000 is missing or not enabled';
  end if;

  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.pilot_question_protocols'::regclass
     and c.conname = 'pilot_question_protocols_engine_check';
  if v_def is distinct from $d$CHECK ((engine = ANY (ARRAY['perplexity_sonar'::text, 'openai_chatgpt'::text])))$d$ then
    raise exception using
      errcode = 'P0001',
      message = format('20261109190000 precondition: pilot_question_protocols_engine_check is not 20261109180000''s (found: %s)', coalesce(v_def, 'missing'));
  end if;

  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.pilot_question_protocols'::regclass
     and c.conname = 'pilot_question_protocols_phase_check';
  if v_def is distinct from $d$CHECK ((phase = 'baseline'::text))$d$ then
    raise exception using
      errcode = 'P0001',
      message = format('20261109190000 precondition: pilot_question_protocols_phase_check is not 20261109140000''s (found: %s)', coalesce(v_def, 'missing'));
  end if;
end $$;

-- 3. The M7 and M5 functions the group steps call, with their signatures.
do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'public.register_intervention(uuid,uuid,text,text,text,text,text,jsonb,text,text,text,timestamptz,integer)',
    'public.approve_intervention(uuid,uuid,uuid)',
    'public.confirm_intervention_implementation(uuid,uuid,uuid,jsonb,text,text)',
    'public.abandon_intervention(uuid,uuid,uuid,text)',
    'public.create_retest_protocol(uuid,uuid,uuid)',
    'public.retest_eligibility(uuid,uuid)',
    'public.enqueue_protocol_execution_job(uuid,uuid,integer)'
  ] loop
    if to_regprocedure(v_sig) is null then
      raise exception using
        errcode = 'P0001',
        message = format('20261109190000 precondition: %s is missing', v_sig);
    end if;
  end loop;
end $$;

-- 4. What this migration overwrites is 20261109160000's save and share: the
--    md5 of each body's source text (prosrc, the same on PostgreSQL 16 and
--    17) with carriage returns removed, as the preflight hashes its pinned
--    definitions since #132 (PF-30): a body applied with Windows line
--    endings is the same code (engineer). The pins are unchanged.
--    scripts/test-pilot-retest-schema.ts proves each literal is the md5 of
--    that body as it stands in 20261109160000's file.
do $$
begin
  if (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p
       where p.oid = to_regprocedure('public.save_pilot_report_artifact(uuid,uuid,text,jsonb,jsonb,text,jsonb,timestamptz)'))
     is distinct from 'e66f4dd316ff2f2cb250442b5fc119f2' then
    raise exception using
      errcode = 'P0001',
      message = '20261109190000 precondition: save_pilot_report_artifact is not 20261109160000''s';
  end if;

  if (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p
       where p.oid = to_regprocedure('public.share_pilot_report_artifact(uuid,uuid,uuid,boolean)'))
     is distinct from 'dc8b5f430f0d4ebd630e6793e64e669e' then
    raise exception using
      errcode = 'P0001',
      message = '20261109190000 precondition: share_pilot_report_artifact is not 20261109160000''s';
  end if;
end $$;

-- 5. None of the objects this migration creates exists yet.
do $$
begin
  if to_regclass('public.pilot_retests') is not null
     or to_regclass('public.pilot_retest_members') is not null
     or to_regclass('public.pilot_retest_notes') is not null
     or to_regclass('public.pilot_retest_steps') is not null
     or exists (
       select 1
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and p.proname in (
            'pilot_retest_job_is_final', 'register_pilot_retest', 'confirm_pilot_retest_implementation',
            'prepare_pilot_retests', 'abandon_pilot_retest', 'requeue_pilot_retest_job', 'add_pilot_retest_note',
            'pilot_retests_guard', 'pilot_retest_rows_append_only', 'pilot_retest_slot_check',
            'pilot_retest_intervention_guard', 'pilot_retest_protocol_guard', 'pilot_retest_card_guard'))
     or exists (
       select 1
         from pg_trigger t
        where not t.tgisinternal
          and t.tgname in (
            'pilot_retests_guard', 'pilot_retest_members_append_only', 'pilot_retest_notes_append_only',
            'pilot_retest_steps_append_only', 'pilot_question_protocols_retest_slot',
            'interventions_pilot_retest_guard', 'protocols_pilot_retest_guard',
            'outcome_card_artifacts_pilot_retest_guard'))
     or exists (
       select 1
         from information_schema.columns c
        where c.table_schema = 'public'
          and c.table_name = 'pilot_question_protocols'
          and c.column_name = 'pilot_retest_member_id') then
    raise exception using
      errcode = 'P0001',
      message = '20261109190000 precondition: an object this migration creates already exists';
  end if;
end $$;

-- 6. Nothing references a pilot slot's protocol yet. The three tables are
--    locked first (SHARE ROW EXCLUSIVE, held to commit under the named-file
--    procedure's single transaction), so a registration, a retest protocol
--    or an Outcome Card written by the still-deployed console cannot slip in
--    between this check and the triggers below.
do $$
begin
  lock table public.interventions, public.protocols, public.outcome_card_artifacts in share row exclusive mode;

  if exists (
       select 1
         from public.interventions i
         join public.pilot_question_protocols s on s.protocol_id = i.protocol_id)
     or exists (
       select 1
         from public.protocols p
         join public.pilot_question_protocols s on s.protocol_id = p.baseline_protocol_id)
     or exists (
       select 1
         from public.outcome_card_artifacts o
         join public.pilot_question_protocols s
           on s.protocol_id = o.baseline_protocol_id or s.protocol_id = o.retest_protocol_id) then
    raise exception using
      errcode = 'P0001',
      message = '20261109190000 precondition: an intervention, protocol or Outcome Card already references a pilot slot''s protocol';
  end if;
end $$;

-- =======================================================================
-- 1. Schema
-- =======================================================================

-- The group: one registered customer change. Its text is registered once
-- (trimmed, bounded) and each lifecycle tuple is written once.
create table public.pilot_retests (
  id                          uuid primary key default gen_random_uuid(),
  pilot_id                    uuid not null,
  project_id                  uuid not null,
  sequence                    integer not null check (sequence between 1 and 2),

  change_title                text not null
                              check (char_length(change_title) between 3 and 120 and change_title = btrim(change_title)),
  change_description          text not null
                              check (char_length(change_description) between 10 and 2000 and change_description = btrim(change_description)),
  change_target               text not null
                              check (char_length(change_target) between 3 and 500 and change_target = btrim(change_target)),
  change_owner                text not null
                              check (char_length(change_owner) between 3 and 200 and change_owner = btrim(change_owner)),
  hypothesis                  text not null
                              check (char_length(hypothesis) between 10 and 2000 and hypothesis = btrim(hypothesis)),
  expected_mechanism          text not null
                              check (char_length(expected_mechanism) between 10 and 2000 and expected_mechanism = btrim(expected_mechanism)),
  alternative_explanations    text not null
                              check (char_length(alternative_explanations) between 10 and 2000 and alternative_explanations = btrim(alternative_explanations)),
  open_questions              text not null
                              check (char_length(open_questions) between 10 and 2000 and open_questions = btrim(open_questions)),
  -- The customer's own words for what would change their next decision (M2).
  decision_threshold          text not null
                              check (char_length(decision_threshold) between 10 and 2000 and decision_threshold = btrim(decision_threshold)),
  confounders_to_monitor      text not null
                              check (char_length(confounders_to_monitor) between 10 and 2000 and confounders_to_monitor = btrim(confounders_to_monitor)),
  -- 0071's interventions_action_type_check, exactly.
  action_type                 text not null
                              check (action_type in (
                                'content_published', 'content_updated', 'page_created', 'structured_data_added',
                                'third_party_listing', 'documentation_updated', 'other')),
  threshold_below_limit       boolean not null,
  outcome_rule                text not null check (outcome_rule = 'pilot-outcome-card/1'),
  observation_days            integer not null check (observation_days between 7 and 60),
  implement_by                date not null,
  -- Where the customer's written approval is kept; never in a report (M10).
  customer_approval_ref       text not null
                              check (char_length(customer_approval_ref) between 3 and 300 and customer_approval_ref = btrim(customer_approval_ref)),
  customer_approved_on        date not null,
  source_action_version_ids   uuid[] not null default '{}'
                              check (cardinality(source_action_version_ids) <= 5 and array_position(source_action_version_ids, null) is null),
  registered_by               uuid not null,
  registered_at               timestamptz not null default now(),
  idempotency_key             uuid not null,
  request_fingerprint         text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),

  -- Implementation (confirm_pilot_retest_implementation).
  implemented_at              timestamptz null,
  window_opens_at             timestamptz null,
  window_closes_at            timestamptz null,
  implementation_confirmed_by uuid null,
  went_live_on                date null,
  evidence_url                text null
                              check (evidence_url is null
                                     or (char_length(evidence_url) between 10 and 2048
                                         and evidence_url ~ '^https?://' and evidence_url = btrim(evidence_url))),
  artifact_sha256             text null check (artifact_sha256 is null or artifact_sha256 ~ '^[0-9a-f]{64}$'),
  implementation_note         text null
                              check (implementation_note is null
                                     or (char_length(implementation_note) between 10 and 2000 and implementation_note = btrim(implementation_note))),
  implemented_as_registered   boolean null,

  -- Preparation (prepare_pilot_retests).
  retests_prepared_at         timestamptz null,
  retests_prepared_by         uuid null,

  -- Abandonment (abandon_pilot_retest).
  abandoned_at                timestamptz null,
  abandoned_by                uuid null,
  abandoned_reason            text null
                              check (abandoned_reason is null
                                     or (char_length(abandoned_reason) between 10 and 2000 and abandoned_reason = btrim(abandoned_reason))),

  constraint pilot_retests_pilot_fk
    foreign key (pilot_id, project_id)
    references public.pilots (id, project_id)
    on delete restrict,
  constraint pilot_retests_sequence_key unique (pilot_id, sequence),
  constraint pilot_retests_idempotency_key unique (pilot_id, idempotency_key),
  constraint pilot_retests_scope_key unique (id, pilot_id, project_id),
  -- Each lifecycle tuple is all set or all null (written pairwise: a chained
  -- equality would not say this).
  constraint pilot_retests_implementation_tuple_check check (
    (implemented_at is null) = (window_opens_at is null)
    and (implemented_at is null) = (window_closes_at is null)
    and (implemented_at is null) = (implementation_confirmed_by is null)
    and (implemented_at is null) = (went_live_on is null)
    and (implemented_at is null) = (implementation_note is null)
    and (implemented_at is null) = (implemented_as_registered is null)
  ),
  -- An implemented change carries a URL or a fingerprint, or both (M9); a
  -- change not implemented carries neither.
  constraint pilot_retests_implementation_evidence_check check (
    (implemented_at is null and evidence_url is null and artifact_sha256 is null)
    or (implemented_at is not null and (evidence_url is not null or artifact_sha256 is not null))
  ),
  constraint pilot_retests_window_check check (
    implemented_at is null
    or (window_opens_at = implemented_at and window_closes_at > window_opens_at)
  ),
  constraint pilot_retests_preparation_tuple_check check (
    (retests_prepared_at is null) = (retests_prepared_by is null)
    and (retests_prepared_at is null or implemented_at is not null)
  ),
  constraint pilot_retests_abandonment_tuple_check check (
    (abandoned_at is null) = (abandoned_by is null)
    and (abandoned_at is null) = (abandoned_reason is null)
  )
);

-- One live (not abandoned) group per pilot.
create unique index pilot_retests_one_live_per_pilot
  on public.pilot_retests (pilot_id)
  where abandoned_at is null;

-- One question on one engine inside a group: exactly one M7 intervention.
create table public.pilot_retest_members (
  id                    uuid primary key default gen_random_uuid(),
  pilot_retest_id       uuid not null,
  pilot_id              uuid not null,
  project_id            uuid not null,
  pilot_question_id     uuid not null,
  engine                text not null check (engine in ('perplexity_sonar', 'openai_chatgpt')),
  -- A member can only point at a baseline slot (the slot foreign key below).
  baseline_phase        text not null default 'baseline' check (baseline_phase = 'baseline'),
  baseline_protocol_id  uuid not null,
  intervention_id       uuid not null unique
                        references public.interventions (id) on delete restrict,
  created_at            timestamptz not null default now(),

  constraint pilot_retest_members_retest_fk
    foreign key (pilot_retest_id, pilot_id, project_id)
    references public.pilot_retests (id, pilot_id, project_id)
    on delete restrict,
  -- One pilot per project (pilots_project_key) makes this the group's pilot.
  constraint pilot_retest_members_question_fk
    foreign key (pilot_question_id, project_id)
    references public.pilot_questions (id, project_id)
    on delete restrict,
  constraint pilot_retest_members_slot_key unique (pilot_retest_id, pilot_question_id, engine),
  constraint pilot_retest_members_scope_key unique (id, pilot_question_id, engine, project_id)
);

-- The log of other changes (decision 7, M14). A correction is a new note
-- naming the one it corrects; nothing is edited.
create table public.pilot_retest_notes (
  id                   uuid primary key default gen_random_uuid(),
  pilot_retest_id      uuid not null,
  pilot_id             uuid not null,
  project_id           uuid not null,
  noted_on             date not null,
  kind                 text not null
                       check (kind in (
                         'engine_change', 'measurement_change', 'competitor_activity', 'customer_change',
                         'source_change', 'news_or_market_event', 'implementation_issue', 'other_change')),
  text                 text not null check (char_length(text) between 10 and 2000 and text = btrim(text)),
  corrects_note_id     uuid null,
  written_by           uuid not null,
  written_at           timestamptz not null default now(),
  idempotency_key      uuid not null,
  request_fingerprint  text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),

  constraint pilot_retest_notes_retest_fk
    foreign key (pilot_retest_id, pilot_id, project_id)
    references public.pilot_retests (id, pilot_id, project_id)
    on delete restrict,
  constraint pilot_retest_notes_retest_key unique (id, pilot_retest_id),
  constraint pilot_retest_notes_corrects_fk
    foreign key (corrects_note_id, pilot_retest_id)
    references public.pilot_retest_notes (id, pilot_retest_id)
    on delete restrict,
  constraint pilot_retest_notes_idempotency_key unique (pilot_id, idempotency_key)
);

create index pilot_retest_notes_retest_idx on public.pilot_retest_notes (pilot_retest_id, written_at);

-- The writer record (S3). Each group step inserts its row before any wrapped
-- call; the triggers accept a pilot write only with a step of the right kind
-- in the same transaction (xact_id is the top-level transaction's id).
create table public.pilot_retest_steps (
  id                     uuid primary key default gen_random_uuid(),
  pilot_retest_id        uuid not null,
  pilot_id               uuid not null,
  project_id             uuid not null,
  step                   text not null check (step in ('register', 'confirm', 'prepare', 'abandon', 'requeue')),
  xact_id                xid8 not null default pg_current_xact_id(),
  -- For 'register': exactly the baselines being registered.
  baseline_protocol_ids  uuid[] not null default '{}',
  -- For 'requeue': the member and the reason.
  member_id              uuid null references public.pilot_retest_members (id) on delete restrict,
  note                   text null,
  performed_by           uuid not null,
  performed_at           timestamptz not null default now(),

  constraint pilot_retest_steps_retest_fk
    foreign key (pilot_retest_id, pilot_id, project_id)
    references public.pilot_retests (id, pilot_id, project_id)
    on delete restrict,
  constraint pilot_retest_steps_shape_check check (
    ((step = 'register') = (cardinality(baseline_protocol_ids) > 0))
    and ((step = 'requeue') = (member_id is not null))
    and ((step = 'requeue') = (note is not null))
    and (note is null or (char_length(note) between 10 and 2000 and note = btrim(note)))
  )
);

create index pilot_retest_steps_xact_idx on public.pilot_retest_steps (xact_id);

-- pilot_question_protocols, changes 1 and 2: a retest phase, and the key a
-- member's baseline slot foreign key targets. Dropped by name without IF
-- EXISTS: precondition 2 proved it is 20261109140000's.
alter table public.pilot_question_protocols
  drop constraint pilot_question_protocols_phase_check;
alter table public.pilot_question_protocols
  add constraint pilot_question_protocols_phase_check
  check (phase in ('baseline', 'retest'));

-- Cannot fail: protocol_id alone is already unique.
alter table public.pilot_question_protocols
  add constraint pilot_question_protocols_slot_protocol_key
  unique (pilot_question_id, engine, phase, protocol_id);

alter table public.pilot_retest_members
  add constraint pilot_retest_members_baseline_slot_fk
  foreign key (pilot_question_id, engine, baseline_phase, baseline_protocol_id)
  references public.pilot_question_protocols (pilot_question_id, engine, phase, protocol_id)
  on delete restrict;

-- Changes 3 to 7: a retest slot names its member, and only a retest slot.
-- MATCH SIMPLE: the foreign key is not checked for a baseline slot (null).
alter table public.pilot_question_protocols
  add column pilot_retest_member_id uuid null;
alter table public.pilot_question_protocols
  add constraint pilot_question_protocols_retest_member_fk
  foreign key (pilot_retest_member_id, pilot_question_id, engine, project_id)
  references public.pilot_retest_members (id, pilot_question_id, engine, project_id)
  on delete restrict;
alter table public.pilot_question_protocols
  add constraint pilot_question_protocols_retest_member_check
  check ((phase = 'retest') = (pilot_retest_member_id is not null));
alter table public.pilot_question_protocols
  add constraint pilot_question_protocols_member_key
  unique (pilot_retest_member_id);

comment on table public.pilot_question_protocols is
  'D-054, D-061, D-062: the protocol measuring a pilot question on one engine, before (baseline) or after a registered change (retest). Written only by add_pilot_question, add_pilot_question_engine and prepare_pilot_retests (retest slots); each slot matches its protocol (triggers pilot_question_protocols_consistency and pilot_question_protocols_retest_slot).';

comment on table public.pilot_retests is
  'D-062: one registered customer change of a pilot, retested on both engines. Written only by the pilot retest group steps; registered text frozen, each lifecycle tuple written once.';
comment on table public.pilot_retest_members is
  'D-062: one question on one engine inside a pilot retest group, exactly one M7 intervention. Append-only.';
comment on table public.pilot_retest_notes is
  'D-062: the log of other changes recorded during a pilot retest. Append-only; a correction is a new note.';
comment on table public.pilot_retest_steps is
  'D-062: the writer record. Each group step inserts its row before any wrapped call; the pilot retest triggers accept a write only with a step of the right kind in the same transaction. Append-only.';

alter table public.pilot_retests enable row level security;
alter table public.pilot_retests no force row level security;
alter table public.pilot_retest_members enable row level security;
alter table public.pilot_retest_members no force row level security;
alter table public.pilot_retest_notes enable row level security;
alter table public.pilot_retest_notes no force row level security;
alter table public.pilot_retest_steps enable row level security;
alter table public.pilot_retest_steps no force row level security;

revoke all on table public.pilot_retests from public, anon, authenticated, service_role;
revoke all on table public.pilot_retest_members from public, anon, authenticated, service_role;
revoke all on table public.pilot_retest_notes from public, anon, authenticated, service_role;
revoke all on table public.pilot_retest_steps from public, anon, authenticated, service_role;
grant select on table public.pilot_retests to service_role;
grant select on table public.pilot_retest_members to service_role;
grant select on table public.pilot_retest_notes to service_role;
grant select on table public.pilot_retest_steps to service_role;

-- =======================================================================
-- 2. When a pilot retest is final
-- =======================================================================

-- True when no path in the product can still add or change an answer of the
-- retest whose job this is; null when the job is not a pilot retest slot's.
-- lib/pilots/retest-rules.ts retestJobIsFinal is its exact mirror
-- (scripts/test-pilot-retest-db.ts proves the two agree). Treating
-- abandoned_exhausted as final follows the pilot console, which offers no
-- reactivation; a later direct reactivation would show as a refused report
-- save (RETEST_CARD_CHANGED_SINCE_SHARED or RETESTS_CHANGED), never as a
-- silent change. current_date is UTC on Supabase. Granted to nobody: only the
-- report save (its owner) calls it.
create or replace function public.pilot_retest_job_is_final(p_job_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_job         public.protocol_execution_jobs%rowtype;
  v_member_id   uuid;
  v_question    public.pilot_questions%rowtype;
  v_pilot       public.pilots%rowtype;
  v_protocol    public.protocols%rowtype;
  v_runnable    boolean;
  v_retryable   boolean := false;
  v_requeueable boolean := false;
  v_consumed    integer;
begin
  if p_job_id is null then
    return null;
  end if;

  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id;

  if not found then
    return null;
  end if;

  select s.pilot_retest_member_id into v_member_id
    from public.pilot_question_protocols s
   where s.protocol_id = v_job.protocol_id
     and s.phase = 'retest';

  if v_member_id is null then
    return null;
  end if;

  select q.* into v_question
    from public.pilot_questions q
    join public.pilot_question_protocols s on s.pilot_question_id = q.id
   where s.protocol_id = v_job.protocol_id;

  select pl.* into v_pilot
    from public.pilots pl
   where pl.id = v_question.pilot_id;

  v_runnable := v_pilot.status = 'active'
    and current_date between v_pilot.starts_on and v_pilot.ends_on
    and v_question.retired_at is null;

  if v_job.status = 'failed'
     and v_job.review_resolution is null
     and v_job.current_attempt_id is null then
    -- 20261109180000's per-slot retry predicate (retire_pilot_question).
    if v_job.failure_reason = 'provider_error' then
      select p.* into v_protocol
        from public.protocols p
       where p.id = v_job.protocol_id;

      select count(*) into v_consumed
        from public.protocol_attempts pa
       where pa.protocol_id = v_job.protocol_id
         and pa.status <> 'cancelled';

      v_retryable := exists (
          select 1
            from public.protocol_attempts pa
           where pa.job_id = v_job.id
             and pa.status = 'failed'
             and pa.terminalized_at is not null
             and pa.baseline_ordinal = v_job.next_baseline_ordinal
             and not exists (
               select 1 from public.protocol_attempts r where r.retry_of_attempt_id = pa.id
             )
             and not exists (
               select 1 from public.protocol_attempts c
                where c.job_id = v_job.id
                  and c.baseline_ordinal = pa.baseline_ordinal
                  and c.status = 'completed'
             )
        )
        and v_consumed + 1
              + greatest(coalesce(v_protocol.planned_baseline_runs, 0) - v_job.next_baseline_ordinal, 0)
            <= v_protocol.run_cap;
    end if;

    -- requeue_pilot_retest_job's own conditions.
    v_requeueable := not exists (
        select 1 from public.protocol_attempts pa where pa.protocol_id = v_job.protocol_id
      )
      and (
        select count(*)
          from public.pilot_retest_steps st
         where st.member_id = v_member_id
           and st.step = 'requeue'
      ) < 3;
  end if;

  return case v_job.status
    when 'succeeded' then true
    when 'abandoned_exhausted' then true
    when 'cancelled' then true
    -- A review resolution can still change the attempts (0070).
    when 'needs_review' then false
    when 'queued' then not v_runnable
    when 'claimed' then not v_runnable
    when 'running' then not v_runnable
    when 'failed' then not (v_runnable and (v_retryable or v_requeueable))
    -- An unknown status is never final.
    else false
  end;
end;
$$;

revoke all on function public.pilot_retest_job_is_final(uuid) from public, anon, authenticated, service_role;

-- =======================================================================
-- 3. The group steps
-- =======================================================================

-- Every step: SECURITY DEFINER with a pinned search_path, executable by
-- service_role only. Malformed input raises 22023; a refusal is a returned
-- outcome; an unexpected answer from a wrapped M7 call raises P0001
-- pilot_retest_<step>_failed[:code], so the whole step rolls back (no
-- exception handler surrounds a wrapped call). Members are always taken in
-- the question's ordinal order, Perplexity before ChatGPT. Each step locks the
-- pilot row FOR UPDATE, then its group row, and inserts its
-- pilot_retest_steps row before its first wrapped call.

-- -----------------------------------------------------------------------
-- 3a. Register the customer's change (one approved intervention per
--     question and engine, in one transaction)
-- -----------------------------------------------------------------------
create or replace function public.register_pilot_retest(
    p_pilot_id                   uuid,
    p_registered_by              uuid,
    p_pilot_question_ids         uuid[],
    p_change_title               text,
    p_change_description         text,
    p_change_target              text,
    p_change_owner               text,
    p_action_type                text,
    p_hypothesis                 text,
    p_expected_mechanism         text,
    p_alternative_explanations   text,
    p_open_questions             text,
    p_decision_threshold         text,
    p_threshold_below_limit      boolean,
    p_confounders_to_monitor     text,
    p_observation_days           integer,
    p_customer_approval_ref      text,
    p_customer_approved_on       date,
    p_source_action_version_ids  uuid[],
    p_confirmed                  boolean,
    p_idempotency_key            uuid
  )
returns table (
  outcome            text,
  pilot_retest_id    uuid,
  pilot_question_id  uuid,
  engine             text
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_pilot         public.pilots%rowtype;
  v_existing      public.pilot_retests%rowtype;
  v_fingerprint   text;
  v_groups        integer;
  v_implement_by  date;
  v_q             record;
  v_engine        text;
  v_slot          public.pilot_question_protocols%rowtype;
  v_protocol      public.protocols%rowtype;
  v_job_status    text;
  v_readable      integer;
  v_baselines     uuid[] := '{}';
  v_group_id      uuid;
  v_member        record;
  v_evidence      jsonb;
  v_rows          public.interventions[];
  v_row           public.interventions;
  v_members       integer := 0;
begin
  if p_pilot_id is null or p_registered_by is null or p_idempotency_key is null or p_confirmed is null
     or p_pilot_question_ids is null
     or cardinality(p_pilot_question_ids) not between 1 and 5
     or array_position(p_pilot_question_ids, null) is not null
     or (select count(distinct u) from unnest(p_pilot_question_ids) u) <> cardinality(p_pilot_question_ids)
     or p_change_title is null or p_change_title <> btrim(p_change_title)
     or char_length(p_change_title) not between 3 and 120
     or p_change_description is null or p_change_description <> btrim(p_change_description)
     or char_length(p_change_description) not between 10 and 2000
     or p_change_target is null or p_change_target <> btrim(p_change_target)
     or char_length(p_change_target) not between 3 and 500
     or p_change_owner is null or p_change_owner <> btrim(p_change_owner)
     or char_length(p_change_owner) not between 3 and 200
     or p_hypothesis is null or p_hypothesis <> btrim(p_hypothesis)
     or char_length(p_hypothesis) not between 10 and 2000
     or p_expected_mechanism is null or p_expected_mechanism <> btrim(p_expected_mechanism)
     or char_length(p_expected_mechanism) not between 10 and 2000
     or p_alternative_explanations is null or p_alternative_explanations <> btrim(p_alternative_explanations)
     or char_length(p_alternative_explanations) not between 10 and 2000
     or p_open_questions is null or p_open_questions <> btrim(p_open_questions)
     or char_length(p_open_questions) not between 10 and 2000
     or p_decision_threshold is null or p_decision_threshold <> btrim(p_decision_threshold)
     or char_length(p_decision_threshold) not between 10 and 2000
     or p_confounders_to_monitor is null or p_confounders_to_monitor <> btrim(p_confounders_to_monitor)
     or char_length(p_confounders_to_monitor) not between 10 and 2000
     or p_action_type is null
     or p_action_type not in (
       'content_published', 'content_updated', 'page_created', 'structured_data_added',
       'third_party_listing', 'documentation_updated', 'other')
     or p_threshold_below_limit is null
     or p_observation_days is null or p_observation_days not between 7 and 60
     or p_customer_approval_ref is null or p_customer_approval_ref <> btrim(p_customer_approval_ref)
     or char_length(p_customer_approval_ref) not between 3 and 300
     or p_customer_approved_on is null or p_customer_approved_on > current_date
     or p_source_action_version_ids is null
     or cardinality(p_source_action_version_ids) > 5
     or array_position(p_source_action_version_ids, null) is not null
     or (select count(distinct u) from unnest(p_source_action_version_ids) u) <> cardinality(p_source_action_version_ids) then
    raise exception using
      errcode = '22023',
      message = 'invalid_register_pilot_retest_args';
  end if;

  -- Every input but the pilot, the key and the confirmation, with both id
  -- lists sorted: a repeated press replays, the same key with another body
  -- conflicts.
  v_fingerprint := md5(concat_ws(chr(31),
    p_registered_by::text,
    array_to_string(array(select u::text from unnest(p_pilot_question_ids) u order by 1), ','),
    p_change_title, p_change_description, p_change_target, p_change_owner, p_action_type,
    p_hypothesis, p_expected_mechanism, p_alternative_explanations, p_open_questions,
    p_decision_threshold, p_threshold_below_limit::text, p_confounders_to_monitor,
    p_observation_days::text, p_customer_approval_ref, p_customer_approved_on::text,
    array_to_string(array(select u::text from unnest(p_source_action_version_ids) u order by 1), ',')));

  select p.* into v_pilot
    from public.pilots p
   where p.id = p_pilot_id
   for update;

  if not found then
    return query select 'PILOT_NOT_FOUND'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  select r.* into v_existing
    from public.pilot_retests r
   where r.pilot_id = p_pilot_id
     and r.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.request_fingerprint = v_fingerprint then
      return query select 'ALREADY_REGISTERED'::text, v_existing.id, null::uuid, null::text;
    else
      return query select 'IDEMPOTENCY_KEY_CONFLICT'::text, null::uuid, null::uuid, null::text;
    end if;
    return;
  end if;

  if not p_confirmed then
    return query select 'CONFIRMATION_REQUIRED'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  if v_pilot.status <> 'active' or current_date > v_pilot.ends_on then
    return query select 'PILOT_CLOSED'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  if exists (
    select 1 from public.pilot_retests r
     where r.pilot_id = p_pilot_id
       and r.abandoned_at is null
  ) then
    return query select 'RETEST_ALREADY_REGISTERED'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  select count(*) into v_groups
    from public.pilot_retests r
   where r.pilot_id = p_pilot_id;

  if v_groups >= 2 then
    return query select 'RETEST_LIMIT_REACHED'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- The window must close at least 7 days before the pilot ends, whatever
  -- day the change goes live by (decision 5).
  v_implement_by := v_pilot.ends_on - 7 - p_observation_days;
  if current_date > v_implement_by then
    return query select 'WINDOW_PAST_PILOT_END'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  -- Each question, in ordinal order (an id that is not this pilot's comes
  -- first, in the order given), then each engine. The first refusal names
  -- the question and, where it is about one baseline, the engine.
  for v_q in
    select u.id as given_id, u.n, q.id as question_id, q.ordinal, q.retired_at
      from unnest(p_pilot_question_ids) with ordinality as u(id, n)
      left join public.pilot_questions q
        on q.id = u.id and q.pilot_id = p_pilot_id
     order by q.ordinal nulls first, u.n
  loop
    if v_q.question_id is null or v_q.retired_at is not null then
      return query select 'QUESTION_NOT_LIVE'::text, null::uuid, v_q.given_id, null::text;
      return;
    end if;

    -- M6a: the questions of a change that went live are never retested
    -- again.
    if exists (
      select 1
        from public.pilot_retest_members m
        join public.pilot_retests r on r.id = m.pilot_retest_id
       where m.pilot_question_id = v_q.question_id
         and r.implemented_at is not null
    ) then
      return query select 'QUESTION_IN_EARLIER_LIVE_CHANGE'::text, null::uuid, v_q.question_id, null::text;
      return;
    end if;

    foreach v_engine in array array['perplexity_sonar', 'openai_chatgpt'] loop
      select s.* into v_slot
        from public.pilot_question_protocols s
       where s.pilot_question_id = v_q.question_id
         and s.engine = v_engine
         and s.phase = 'baseline';

      if not found then
        return query select 'BASELINE_MISSING'::text, null::uuid, v_q.question_id, v_engine;
        return;
      end if;

      select p.* into v_protocol
        from public.protocols p
       where p.id = v_slot.protocol_id;

      if v_protocol.planned_baseline_runs is distinct from 5 then
        return query select 'BASELINE_PLAN_NOT_FIVE_RUNS'::text, null::uuid, v_q.question_id, v_engine;
        return;
      end if;

      select j.status into v_job_status
        from public.protocol_execution_jobs j
       where j.protocol_id = v_slot.protocol_id;

      if v_job_status is distinct from 'succeeded'
         or exists (
           select 1 from public.protocol_attempts a
            where a.protocol_id = v_slot.protocol_id
              and a.status in ('reserved', 'in_progress')) then
        return query select 'BASELINE_NOT_FINISHED'::text, null::uuid, v_q.question_id, v_engine;
        return;
      end if;

      -- M3: the report's own readable rule (build-protocol-report.ts): a
      -- completed baseline attempt whose stored result says whether the
      -- company was named.
      select count(*) into v_readable
        from public.protocol_attempts a
        join public.probe_results pr on pr.probe_run_id = a.probe_run_id
       where a.protocol_id = v_slot.protocol_id
         and a.attempt_kind = 'baseline'
         and a.status = 'completed'
         and pr.client_mentioned is not null;

      if v_readable < 5 then
        return query select 'BASELINE_NOT_FIVE_READABLE'::text, null::uuid, v_q.question_id, v_engine;
        return;
      end if;

      -- M6b: after a change went live, a later change needs baselines
      -- collected entirely after it.
      if exists (
        select 1
          from public.pilot_retests r
         where r.pilot_id = p_pilot_id
           and r.implemented_at is not null
           and exists (
             select 1 from public.protocol_attempts a
              where a.protocol_id = v_slot.protocol_id
                and a.reserved_at < least(r.implemented_at, r.went_live_on::timestamp at time zone 'UTC'))
      ) then
        return query select 'BASELINE_BEFORE_EARLIER_CHANGE'::text, null::uuid, v_q.question_id, v_engine;
        return;
      end if;

      if exists (
        select 1 from public.interventions i
         where i.protocol_id = v_slot.protocol_id
           and i.status in ('proposed', 'approved', 'implemented')
      ) then
        return query select 'BASELINE_ALREADY_REGISTERED'::text, null::uuid, v_q.question_id, v_engine;
        return;
      end if;

      v_baselines := v_baselines || v_slot.protocol_id;
    end loop;
  end loop;

  -- Each source must be its action's latest version, reviewed, of an action
  -- of this pilot that is not withdrawn (20261109160000's ACTION_NOT_REVIEWED
  -- rule).
  if exists (
    select 1
      from unnest(p_source_action_version_ids) as u(id)
      left join public.pilot_action_versions pav
        on pav.id = u.id and pav.pilot_id = p_pilot_id
     where pav.id is null
        or pav.version_number <> (
             select max(pav2.version_number) from public.pilot_action_versions pav2 where pav2.action_id = pav.action_id)
        or not exists (
             select 1 from public.pilot_action_events ev where ev.action_version_id = pav.id and ev.event = 'reviewed')
        or exists (
             select 1 from public.pilot_action_events ev where ev.action_id = pav.action_id and ev.event = 'withdrawn')
  ) then
    return query select 'SOURCE_ACTION_NOT_CURRENT'::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  insert into public.pilot_retests (
    pilot_id, project_id, sequence,
    change_title, change_description, change_target, change_owner,
    hypothesis, expected_mechanism, alternative_explanations, open_questions,
    decision_threshold, confounders_to_monitor,
    action_type, threshold_below_limit, outcome_rule, observation_days, implement_by,
    customer_approval_ref, customer_approved_on, source_action_version_ids,
    registered_by, idempotency_key, request_fingerprint
  ) values (
    p_pilot_id, v_pilot.project_id, v_groups + 1,
    p_change_title, p_change_description, p_change_target, p_change_owner,
    p_hypothesis, p_expected_mechanism, p_alternative_explanations, p_open_questions,
    p_decision_threshold, p_confounders_to_monitor,
    p_action_type, p_threshold_below_limit, 'pilot-outcome-card/1', p_observation_days, v_implement_by,
    p_customer_approval_ref, p_customer_approved_on, p_source_action_version_ids,
    p_registered_by, p_idempotency_key, v_fingerprint
  )
  returning id into v_group_id;

  -- The writer record, before the first wrapped call.
  insert into public.pilot_retest_steps (
    pilot_retest_id, pilot_id, project_id, step, baseline_protocol_ids, performed_by
  ) values (
    v_group_id, p_pilot_id, v_pilot.project_id, 'register', v_baselines, p_registered_by
  );

  for v_member in
    select q.id as question_id, s.engine as slot_engine, s.protocol_id as baseline_id
      from public.pilot_questions q
      join public.pilot_question_protocols s
        on s.pilot_question_id = q.id and s.phase = 'baseline'
     where q.pilot_id = p_pilot_id
       and q.id = any (p_pilot_question_ids)
     order by q.ordinal, case s.engine when 'perplexity_sonar' then 0 else 1 end
  loop
    -- D-009: the readable baseline answers it rests on, in run order (M20).
    select coalesce(jsonb_agg(a.id order by a.baseline_ordinal, a.id), '[]'::jsonb) into v_evidence
      from public.protocol_attempts a
      join public.probe_results pr on pr.probe_run_id = a.probe_run_id
     where a.protocol_id = v_member.baseline_id
       and a.attempt_kind = 'baseline'
       and a.status = 'completed'
       and pr.client_mentioned is not null;

    select array_agg(i) into v_rows
      from public.register_intervention(
        v_pilot.project_id, v_member.baseline_id,
        p_hypothesis, p_expected_mechanism, p_action_type, p_change_target, p_change_owner,
        v_evidence, p_alternative_explanations, p_confounders_to_monitor, p_decision_threshold,
        (v_implement_by + 1)::timestamp at time zone 'UTC', p_observation_days
      ) i;

    if coalesce(cardinality(v_rows), 0) <> 1 then
      raise exception using errcode = 'P0001', message = 'pilot_retest_register_failed:register_intervention';
    end if;
    v_row := v_rows[1];
    if v_row.status is distinct from 'proposed'
       or v_row.protocol_id is distinct from v_member.baseline_id
       or v_row.approved_at is not null then
      raise exception using errcode = 'P0001', message = 'pilot_retest_register_failed:register_intervention';
    end if;

    insert into public.pilot_retest_members (
      pilot_retest_id, pilot_id, project_id, pilot_question_id, engine, baseline_protocol_id, intervention_id
    ) values (
      v_group_id, p_pilot_id, v_pilot.project_id, v_member.question_id, v_member.slot_engine,
      v_member.baseline_id, v_row.id
    );

    -- S2: a replay would return an older row unchanged, so the approval
    -- must be this transaction's, by this founder.
    select array_agg(i) into v_rows
      from public.approve_intervention(v_row.id, v_pilot.project_id, p_registered_by) i;

    if coalesce(cardinality(v_rows), 0) <> 1 then
      raise exception using errcode = 'P0001', message = 'pilot_retest_register_failed:approve_intervention';
    end if;
    v_row := v_rows[1];
    if v_row.status is distinct from 'approved'
       or v_row.approved_at is distinct from now()
       or v_row.approved_by is distinct from p_registered_by then
      raise exception using errcode = 'P0001', message = 'pilot_retest_register_failed:approve_intervention';
    end if;

    v_members := v_members + 1;
  end loop;

  if v_members <> 2 * cardinality(p_pilot_question_ids) then
    raise exception using errcode = 'P0001', message = 'pilot_retest_register_failed:members';
  end if;

  return query select 'REGISTERED'::text, v_group_id, null::uuid, null::text;
end;
$$;

revoke all on function public.register_pilot_retest(uuid, uuid, uuid[], text, text, text, text, text, text, text, text, text, text, boolean, text, integer, text, date, uuid[], boolean, uuid) from public;
revoke all on function public.register_pilot_retest(uuid, uuid, uuid[], text, text, text, text, text, text, text, text, text, text, boolean, text, integer, text, date, uuid[], boolean, uuid) from anon;
revoke all on function public.register_pilot_retest(uuid, uuid, uuid[], text, text, text, text, text, text, text, text, text, text, boolean, text, integer, text, date, uuid[], boolean, uuid) from authenticated;
grant execute on function public.register_pilot_retest(uuid, uuid, uuid[], text, text, text, text, text, text, text, text, text, text, boolean, text, integer, text, date, uuid[], boolean, uuid) to service_role;

-- -----------------------------------------------------------------------
-- 3b. Record the change as live: every member implemented in one
--     transaction, with one now() and one window
-- -----------------------------------------------------------------------
create or replace function public.confirm_pilot_retest_implementation(
    p_pilot_id                   uuid,
    p_pilot_retest_id            uuid,
    p_confirmed_by               uuid,
    p_went_live_on               date,
    p_evidence_url               text,
    p_artifact_sha256            text,
    p_note                       text,
    p_implemented_as_registered  boolean,
    p_deviation_note             text,
    p_confirmed                  boolean
  )
returns table (
  outcome           text,
  window_closes_at  timestamptz
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_pilot   public.pilots%rowtype;
  v_group   public.pilot_retests%rowtype;
  v_member  record;
  v_rows    public.interventions[];
  v_row     public.interventions;
  v_closes  timestamptz;
begin
  if p_pilot_id is null or p_pilot_retest_id is null or p_confirmed_by is null or p_confirmed is null
     or p_went_live_on is null or p_went_live_on > current_date
     or (p_evidence_url is null and p_artifact_sha256 is null)
     or (p_evidence_url is not null
         and (p_evidence_url <> btrim(p_evidence_url)
              or char_length(p_evidence_url) not between 10 and 2048
              or p_evidence_url !~ '^https?://'))
     or (p_artifact_sha256 is not null and p_artifact_sha256 !~ '^[0-9a-f]{64}$')
     or p_note is null or p_note <> btrim(p_note) or char_length(p_note) not between 10 and 2000
     or p_implemented_as_registered is null
     or (p_implemented_as_registered and p_deviation_note is not null)
     or (not p_implemented_as_registered
         and (p_deviation_note is null
              or p_deviation_note <> btrim(p_deviation_note)
              or char_length(p_deviation_note) not between 10 and 2000)) then
    raise exception using
      errcode = '22023',
      message = 'invalid_confirm_pilot_retest_implementation_args';
  end if;

  select p.* into v_pilot
    from public.pilots p
   where p.id = p_pilot_id
   for update;

  if not found then
    return query select 'PILOT_NOT_FOUND'::text, null::timestamptz;
    return;
  end if;

  select r.* into v_group
    from public.pilot_retests r
   where r.id = p_pilot_retest_id
     and r.pilot_id = p_pilot_id
   for update;

  if not found then
    return query select 'RETEST_NOT_FOUND'::text, null::timestamptz;
    return;
  end if;

  if v_group.abandoned_at is not null then
    return query select 'RETEST_ABANDONED'::text, null::timestamptz;
    return;
  end if;

  if v_group.implemented_at is not null then
    return query select 'ALREADY_IMPLEMENTED'::text, v_group.window_closes_at;
    return;
  end if;

  if not p_confirmed then
    return query select 'CONFIRMATION_REQUIRED'::text, null::timestamptz;
    return;
  end if;

  if v_pilot.status <> 'active' or current_date > v_pilot.ends_on then
    return query select 'PILOT_CLOSED'::text, null::timestamptz;
    return;
  end if;

  -- M17: the change cannot have gone live before it was registered (and so
  -- before any member's finished baseline).
  if p_went_live_on < (v_group.registered_at at time zone 'UTC')::date then
    return query select 'WENT_LIVE_BEFORE_REGISTRATION'::text, null::timestamptz;
    return;
  end if;

  -- Decision 5: the window must close at least 7 days before the pilot ends.
  if ((now() at time zone 'UTC') + make_interval(days => v_group.observation_days))::date > v_pilot.ends_on - 7 then
    return query select 'WINDOW_PAST_PILOT_END'::text, null::timestamptz;
    return;
  end if;

  if not p_implemented_as_registered
     and (select count(*) from public.pilot_retest_notes n where n.pilot_retest_id = v_group.id) >= 20 then
    return query select 'NOTE_LIMIT_REACHED'::text, null::timestamptz;
    return;
  end if;

  v_closes := now() + make_interval(days => v_group.observation_days);

  insert into public.pilot_retest_steps (pilot_retest_id, pilot_id, project_id, step, performed_by)
  values (v_group.id, p_pilot_id, v_pilot.project_id, 'confirm', p_confirmed_by);

  for v_member in
    select m.*
      from public.pilot_retest_members m
      join public.pilot_questions q on q.id = m.pilot_question_id
     where m.pilot_retest_id = v_group.id
     order by q.ordinal, case m.engine when 'perplexity_sonar' then 0 else 1 end
  loop
    -- Deviations are always null: a departure from the registered change is
    -- a logged note instead (risk 7).
    select array_agg(i) into v_rows
      from public.confirm_intervention_implementation(
        v_member.intervention_id, v_pilot.project_id, p_confirmed_by,
        jsonb_build_object(
          'pilot_retest_id', v_group.id,
          'went_live_on', p_went_live_on,
          'evidence_url', p_evidence_url,
          'note', p_note,
          'implemented_as_registered', p_implemented_as_registered
        ),
        p_artifact_sha256, null
      ) i;

    if coalesce(cardinality(v_rows), 0) <> 1 then
      raise exception using errcode = 'P0001', message = 'pilot_retest_confirm_failed:confirm_intervention_implementation';
    end if;
    v_row := v_rows[1];
    if v_row.status is distinct from 'implemented'
       or v_row.implemented_at is distinct from now()
       or v_row.observation_window_opens_at is distinct from now()
       or v_row.observation_window_closes_at is distinct from v_closes
       or v_row.protocol_deviations is not null then
      raise exception using errcode = 'P0001', message = 'pilot_retest_confirm_failed:confirm_intervention_implementation';
    end if;
  end loop;

  update public.pilot_retests r
     set implemented_at = now(),
         window_opens_at = now(),
         window_closes_at = v_closes,
         implementation_confirmed_by = p_confirmed_by,
         went_live_on = p_went_live_on,
         evidence_url = p_evidence_url,
         artifact_sha256 = p_artifact_sha256,
         implementation_note = p_note,
         implemented_as_registered = p_implemented_as_registered
   where r.id = v_group.id;

  if not p_implemented_as_registered then
    insert into public.pilot_retest_notes (
      pilot_retest_id, pilot_id, project_id, noted_on, kind, text, corrects_note_id,
      written_by, idempotency_key, request_fingerprint
    ) values (
      v_group.id, p_pilot_id, v_pilot.project_id, p_went_live_on, 'implementation_issue', p_deviation_note, null,
      p_confirmed_by, gen_random_uuid(), md5(p_deviation_note)
    );
  end if;

  return query select 'IMPLEMENTED'::text, v_closes;
end;
$$;

revoke all on function public.confirm_pilot_retest_implementation(uuid, uuid, uuid, date, text, text, text, boolean, text, boolean) from public;
revoke all on function public.confirm_pilot_retest_implementation(uuid, uuid, uuid, date, text, text, text, boolean, text, boolean) from anon;
revoke all on function public.confirm_pilot_retest_implementation(uuid, uuid, uuid, date, text, text, text, boolean, text, boolean) from authenticated;
grant execute on function public.confirm_pilot_retest_implementation(uuid, uuid, uuid, date, text, text, text, boolean, text, boolean) to service_role;

-- -----------------------------------------------------------------------
-- 3c. Prepare the retests once the window has closed: per member an
--     approved retest protocol, a queued job and a retest slot. Nothing runs
--     and nothing is spent: each retest is run by its own Run.
-- -----------------------------------------------------------------------
create or replace function public.prepare_pilot_retests(
    p_pilot_id         uuid,
    p_pilot_retest_id  uuid,
    p_prepared_by      uuid
  )
returns table (
  outcome           text,
  prepared          integer,
  window_closes_at  timestamptz
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_pilot     public.pilots%rowtype;
  v_group     public.pilot_retests%rowtype;
  v_member    record;
  v_eligible  boolean;
  v_reason    text;
  v_codes     text[];
  v_ids       uuid[];
  v_retest    public.protocols%rowtype;
  v_baseline  public.protocols%rowtype;
  v_queued    text[];
  v_prepared  integer := 0;
begin
  if p_pilot_id is null or p_pilot_retest_id is null or p_prepared_by is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_prepare_pilot_retests_args';
  end if;

  select p.* into v_pilot
    from public.pilots p
   where p.id = p_pilot_id
   for update;

  if not found then
    return query select 'PILOT_NOT_FOUND'::text, null::integer, null::timestamptz;
    return;
  end if;

  select r.* into v_group
    from public.pilot_retests r
   where r.id = p_pilot_retest_id
     and r.pilot_id = p_pilot_id
   for update;

  if not found then
    return query select 'RETEST_NOT_FOUND'::text, null::integer, null::timestamptz;
    return;
  end if;

  if v_group.abandoned_at is not null then
    return query select 'RETEST_ABANDONED'::text, null::integer, null::timestamptz;
    return;
  end if;

  if v_group.implemented_at is null then
    return query select 'NOT_IMPLEMENTED'::text, null::integer, null::timestamptz;
    return;
  end if;

  if v_group.retests_prepared_at is not null then
    return query
    select 'ALREADY_PREPARED'::text,
           (select count(*)::integer
              from public.pilot_question_protocols s
              join public.pilot_retest_members m on m.id = s.pilot_retest_member_id
             where m.pilot_retest_id = v_group.id),
           v_group.window_closes_at;
    return;
  end if;

  if v_pilot.status <> 'active' or current_date > v_pilot.ends_on then
    return query select 'PILOT_CLOSED'::text, null::integer, null::timestamptz;
    return;
  end if;

  if now() < v_group.window_closes_at then
    return query select 'WINDOW_OPEN'::text, null::integer, v_group.window_closes_at;
    return;
  end if;

  -- All or nothing, and never an early retest: every member's window must
  -- have elapsed by 0072's own authority.
  for v_member in
    select m.*
      from public.pilot_retest_members m
      join public.pilot_questions q on q.id = m.pilot_question_id
     where m.pilot_retest_id = v_group.id
     order by q.ordinal, case m.engine when 'perplexity_sonar' then 0 else 1 end
  loop
    select e.eligible, e.reason into v_eligible, v_reason
      from public.retest_eligibility(v_member.intervention_id, v_pilot.project_id) e;
    if v_eligible is not true or v_reason is distinct from 'WINDOW_ELAPSED' then
      return query select 'MEMBER_NOT_ELIGIBLE'::text, null::integer, v_group.window_closes_at;
      return;
    end if;
  end loop;

  insert into public.pilot_retest_steps (pilot_retest_id, pilot_id, project_id, step, performed_by)
  values (v_group.id, p_pilot_id, v_pilot.project_id, 'prepare', p_prepared_by);

  for v_member in
    select m.*
      from public.pilot_retest_members m
      join public.pilot_questions q on q.id = m.pilot_question_id
     where m.pilot_retest_id = v_group.id
     order by q.ordinal, case m.engine when 'perplexity_sonar' then 0 else 1 end
  loop
    select array_agg(c.status_code), array_agg(c.retest_protocol_id) into v_codes, v_ids
      from public.create_retest_protocol(v_member.intervention_id, v_pilot.project_id, p_prepared_by) c;

    if coalesce(cardinality(v_codes), 0) <> 1 or v_codes[1] is distinct from 'CREATED' or v_ids[1] is null then
      raise exception using
        errcode = 'P0001',
        message = format('pilot_retest_prepare_failed:%s', coalesce(v_codes[1], 'no_row'));
    end if;

    select p.* into v_retest
      from public.protocols p
     where p.id = v_ids[1];

    select p.* into v_baseline
      from public.protocols p
     where p.id = v_member.baseline_protocol_id;

    -- The retest measures exactly what the member's baseline measured, with
    -- the plan and threshold the method fixes (5 runs, a smallest useful
    -- change of 0.60, the detectable change recorded at approval), under the
    -- baseline's own run, retry and spend caps (engineer: 0073 copies them,
    -- and the readback proves it, so a retest never runs under other caps).
    if v_retest.baseline_protocol_id is distinct from v_member.baseline_protocol_id
       or v_retest.provider is distinct from v_baseline.provider
       or v_retest.provider is distinct from v_member.engine
       or v_retest.buyer_question_version_id is distinct from v_baseline.buyer_question_version_id
       or v_retest.status is distinct from 'approved'
       or v_retest.planned_baseline_runs is distinct from 5
       or (v_retest.minimum_useful_change ->> 'value')::numeric is distinct from 0.6
       or v_retest.detectable_change_at_plan is null
       or v_retest.run_cap is distinct from v_baseline.run_cap
       or v_retest.retry_cap is distinct from v_baseline.retry_cap
       or v_retest.spend_cap_usd is distinct from v_baseline.spend_cap_usd then
      raise exception using errcode = 'P0001', message = 'pilot_retest_prepare_failed:retest_protocol';
    end if;

    -- The default attempts, as add_pilot_question queues a baseline.
    select array_agg(e.status) into v_queued
      from public.enqueue_protocol_execution_job(v_retest.id, v_pilot.project_id) e;

    if coalesce(cardinality(v_queued), 0) <> 1 or v_queued[1] is distinct from 'QUEUED' then
      raise exception using
        errcode = 'P0001',
        message = format('pilot_retest_prepare_failed:%s', coalesce(v_queued[1], 'no_row'));
    end if;

    insert into public.pilot_question_protocols (
      pilot_question_id, project_id, engine, phase, protocol_id, pilot_retest_member_id
    ) values (
      v_member.pilot_question_id, v_pilot.project_id, v_member.engine, 'retest', v_retest.id, v_member.id
    );

    v_prepared := v_prepared + 1;
  end loop;

  update public.pilot_retests r
     set retests_prepared_at = now(),
         retests_prepared_by = p_prepared_by
   where r.id = v_group.id;

  return query select 'PREPARED'::text, v_prepared, v_group.window_closes_at;
end;
$$;

revoke all on function public.prepare_pilot_retests(uuid, uuid, uuid) from public;
revoke all on function public.prepare_pilot_retests(uuid, uuid, uuid) from anon;
revoke all on function public.prepare_pilot_retests(uuid, uuid, uuid) from authenticated;
grant execute on function public.prepare_pilot_retests(uuid, uuid, uuid) to service_role;

-- -----------------------------------------------------------------------
-- 3d. Abandon the change: every member together, and only until the first
--     retest answer exists (0077's rule, applied to the whole group)
-- -----------------------------------------------------------------------
create or replace function public.abandon_pilot_retest(
    p_pilot_id         uuid,
    p_pilot_retest_id  uuid,
    p_abandoned_by     uuid,
    p_reason           text,
    p_confirmed        boolean
  )
returns table (
  outcome text
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_pilot   public.pilots%rowtype;
  v_group   public.pilot_retests%rowtype;
  v_member  record;
  v_rows    public.interventions[];
  v_row     public.interventions;
begin
  if p_pilot_id is null or p_pilot_retest_id is null or p_abandoned_by is null or p_confirmed is null
     or p_reason is null or p_reason <> btrim(p_reason) or char_length(p_reason) not between 10 and 2000 then
    raise exception using
      errcode = '22023',
      message = 'invalid_abandon_pilot_retest_args';
  end if;

  select p.* into v_pilot
    from public.pilots p
   where p.id = p_pilot_id
   for update;

  if not found then
    return query select 'PILOT_NOT_FOUND'::text;
    return;
  end if;

  select r.* into v_group
    from public.pilot_retests r
   where r.id = p_pilot_retest_id
     and r.pilot_id = p_pilot_id
   for update;

  if not found then
    return query select 'RETEST_NOT_FOUND'::text;
    return;
  end if;

  if v_group.abandoned_at is not null then
    return query select 'ALREADY_ABANDONED'::text;
    return;
  end if;

  if not p_confirmed then
    return query select 'CONFIRMATION_REQUIRED'::text;
    return;
  end if;

  -- The retest jobs are locked before anything is decided, and never waited
  -- for: a Run or a Retry holding one answers RETEST_JOB_BUSY here.
  if v_group.retests_prepared_at is not null then
    begin
      perform 1
         from public.protocol_execution_jobs j
        where j.protocol_id in (
                select s.protocol_id
                  from public.pilot_question_protocols s
                  join public.pilot_retest_members m on m.id = s.pilot_retest_member_id
                 where m.pilot_retest_id = v_group.id)
        order by j.id
        for update nowait;
    exception
      when lock_not_available then
        return query select 'RETEST_JOB_BUSY'::text;
        return;
    end;
  end if;

  if exists (
    select 1
      from public.pilot_retest_members m
      join public.pilot_question_protocols s on s.pilot_retest_member_id = m.id
     where m.pilot_retest_id = v_group.id
       and (
         exists (select 1 from public.protocol_attempts a where a.protocol_id = s.protocol_id)
         or exists (
           select 1 from public.protocol_execution_jobs j
            where j.protocol_id = s.protocol_id
              and j.status in ('claimed', 'running'))
       )
  ) then
    return query select 'RETEST_STARTED'::text;
    return;
  end if;

  if exists (
    select 1
      from public.pilot_retest_members m
      join public.pilot_question_protocols s on s.pilot_retest_member_id = m.id
      join public.protocol_execution_jobs j on j.protocol_id = s.protocol_id
      join public.protocol_job_run_requests rq on rq.job_id = j.id
     where m.pilot_retest_id = v_group.id
       and rq.status = 'pending'
       and rq.expires_at > now()
  ) then
    return query select 'RETEST_RUN_PENDING'::text;
    return;
  end if;

  insert into public.pilot_retest_steps (pilot_retest_id, pilot_id, project_id, step, performed_by)
  values (v_group.id, p_pilot_id, v_pilot.project_id, 'abandon', p_abandoned_by);

  for v_member in
    select m.*
      from public.pilot_retest_members m
      join public.pilot_questions q on q.id = m.pilot_question_id
     where m.pilot_retest_id = v_group.id
     order by q.ordinal, case m.engine when 'perplexity_sonar' then 0 else 1 end
  loop
    -- When a retest exists, 0077 cancels its queued job and abandons its
    -- protocol; its job lock is already held here.
    select array_agg(i) into v_rows
      from public.abandon_intervention(v_member.intervention_id, v_pilot.project_id, p_abandoned_by, p_reason) i;

    if coalesce(cardinality(v_rows), 0) <> 1 then
      raise exception using errcode = 'P0001', message = 'pilot_retest_abandon_failed:abandon_intervention';
    end if;
    v_row := v_rows[1];
    if v_row.status is distinct from 'abandoned' or v_row.abandoned_at is distinct from now() then
      raise exception using errcode = 'P0001', message = 'pilot_retest_abandon_failed:abandon_intervention';
    end if;
  end loop;

  update public.pilot_retests r
     set abandoned_at = now(),
         abandoned_by = p_abandoned_by,
         abandoned_reason = p_reason
   where r.id = v_group.id;

  return query select 'ABANDONED'::text;
end;
$$;

revoke all on function public.abandon_pilot_retest(uuid, uuid, uuid, text, boolean) from public;
revoke all on function public.abandon_pilot_retest(uuid, uuid, uuid, text, boolean) from anon;
revoke all on function public.abandon_pilot_retest(uuid, uuid, uuid, text, boolean) from authenticated;
grant execute on function public.abandon_pilot_retest(uuid, uuid, uuid, text, boolean) to service_role;

-- -----------------------------------------------------------------------
-- 3e. Queue again a retest that stopped before any answer (S8). No attempt
--     exists, so nothing was reserved; the next Run goes through the paid
--     execution gate, the run request, the claim, admission and reservation
--     as usual. At most 3 times per member.
-- -----------------------------------------------------------------------
create or replace function public.requeue_pilot_retest_job(
    p_pilot_id           uuid,
    p_pilot_retest_id    uuid,
    p_pilot_question_id  uuid,
    p_engine             text,
    p_requeued_by        uuid,
    p_reason             text
  )
returns table (
  outcome  text,
  job_id   uuid
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_pilot      public.pilots%rowtype;
  v_group      public.pilot_retests%rowtype;
  v_member     public.pilot_retest_members%rowtype;
  v_retest_id  uuid;
  v_job        public.protocol_execution_jobs%rowtype;
  v_found      boolean := false;
begin
  if p_pilot_id is null or p_pilot_retest_id is null or p_pilot_question_id is null or p_requeued_by is null
     or p_engine is null or p_engine not in ('perplexity_sonar', 'openai_chatgpt')
     or p_reason is null or p_reason <> btrim(p_reason) or char_length(p_reason) not between 10 and 2000 then
    raise exception using
      errcode = '22023',
      message = 'invalid_requeue_pilot_retest_job_args';
  end if;

  select p.* into v_pilot
    from public.pilots p
   where p.id = p_pilot_id
   for update;

  if not found then
    return query select 'PILOT_NOT_FOUND'::text, null::uuid;
    return;
  end if;

  select r.* into v_group
    from public.pilot_retests r
   where r.id = p_pilot_retest_id
     and r.pilot_id = p_pilot_id
   for update;

  if not found then
    return query select 'RETEST_NOT_FOUND'::text, null::uuid;
    return;
  end if;

  if v_group.abandoned_at is not null then
    return query select 'RETEST_ABANDONED'::text, null::uuid;
    return;
  end if;

  if v_group.retests_prepared_at is null then
    return query select 'NOT_PREPARED'::text, null::uuid;
    return;
  end if;

  select m.* into v_member
    from public.pilot_retest_members m
   where m.pilot_retest_id = v_group.id
     and m.pilot_question_id = p_pilot_question_id
     and m.engine = p_engine;

  if not found then
    return query select 'MEMBER_NOT_FOUND'::text, null::uuid;
    return;
  end if;

  select s.protocol_id into v_retest_id
    from public.pilot_question_protocols s
   where s.pilot_retest_member_id = v_member.id;

  if v_retest_id is null then
    return query select 'MEMBER_NOT_FOUND'::text, null::uuid;
    return;
  end if;

  if v_pilot.status <> 'active'
     or current_date < v_pilot.starts_on
     or current_date > v_pilot.ends_on then
    return query select 'PILOT_CLOSED'::text, null::uuid;
    return;
  end if;

  begin
    select j.* into v_job
      from public.protocol_execution_jobs j
     where j.protocol_id = v_retest_id
       for update nowait;
    v_found := found;
  exception
    when lock_not_available then
      return query select 'RETEST_JOB_BUSY'::text, null::uuid;
      return;
  end;

  if not v_found then
    return query select 'MEMBER_NOT_FOUND'::text, null::uuid;
    return;
  end if;

  if v_job.status = 'queued' then
    return query select 'ALREADY_QUEUED'::text, v_job.id;
    return;
  end if;

  if v_job.status <> 'failed'
     or v_job.review_resolution is not null
     or v_job.current_attempt_id is not null
     or exists (select 1 from public.protocol_attempts a where a.protocol_id = v_retest_id)
     or exists (
       select 1 from public.protocol_job_run_requests rq
        where rq.job_id = v_job.id
          and rq.status = 'pending'
          and rq.expires_at > now()) then
    return query select 'JOB_NOT_STOPPED_BEFORE_ANSWERS'::text, null::uuid;
    return;
  end if;

  if (select count(*)
        from public.pilot_retest_steps st
       where st.member_id = v_member.id
         and st.step = 'requeue') >= 3 then
    return query select 'REQUEUE_LIMIT_REACHED'::text, null::uuid;
    return;
  end if;

  insert into public.pilot_retest_steps (
    pilot_retest_id, pilot_id, project_id, step, member_id, note, performed_by
  ) values (
    v_group.id, p_pilot_id, v_pilot.project_id, 'requeue', v_member.id, p_reason, p_requeued_by
  );

  -- The columns retry_failed_protocol_job resets (20261109140000), with a
  -- fresh claim budget. No attempt, reservation or call exists to touch.
  update public.protocol_execution_jobs j
     set status = 'queued',
         attempt_count = 0,
         worker_id = null,
         claim_token = null,
         lease_expires_at = null,
         failure_reason = null,
         needs_review_reason = null,
         updated_at = now()
   where j.id = v_job.id;

  return query select 'REQUEUED'::text, v_job.id;
end;
$$;

revoke all on function public.requeue_pilot_retest_job(uuid, uuid, uuid, text, uuid, text) from public;
revoke all on function public.requeue_pilot_retest_job(uuid, uuid, uuid, text, uuid, text) from anon;
revoke all on function public.requeue_pilot_retest_job(uuid, uuid, uuid, text, uuid, text) from authenticated;
grant execute on function public.requeue_pilot_retest_job(uuid, uuid, uuid, text, uuid, text) to service_role;

-- -----------------------------------------------------------------------
-- 3f. Log another change (decision 7, M14). Taken under the pilot row lock,
--     so a report save sees every note or none. Accepted whatever the
--     pilot's state.
-- -----------------------------------------------------------------------
create or replace function public.add_pilot_retest_note(
    p_pilot_id          uuid,
    p_pilot_retest_id   uuid,
    p_written_by        uuid,
    p_noted_on          date,
    p_kind              text,
    p_text              text,
    p_corrects_note_id  uuid,
    p_idempotency_key   uuid
  )
returns table (
  outcome  text,
  note_id  uuid
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_pilot        public.pilots%rowtype;
  v_group        public.pilot_retests%rowtype;
  v_existing     public.pilot_retest_notes%rowtype;
  v_fingerprint  text;
  v_id           uuid;
begin
  if p_pilot_id is null or p_pilot_retest_id is null or p_written_by is null or p_idempotency_key is null
     or p_noted_on is null or p_noted_on > current_date
     or p_kind is null
     or p_kind not in (
       'engine_change', 'measurement_change', 'competitor_activity', 'customer_change',
       'source_change', 'news_or_market_event', 'implementation_issue', 'other_change')
     or p_text is null or p_text <> btrim(p_text) or char_length(p_text) not between 10 and 2000 then
    raise exception using
      errcode = '22023',
      message = 'invalid_add_pilot_retest_note_args';
  end if;

  v_fingerprint := md5(concat_ws(chr(31),
    p_pilot_retest_id::text, p_written_by::text, p_noted_on::text, p_kind, p_text,
    coalesce(p_corrects_note_id::text, '')));

  select p.* into v_pilot
    from public.pilots p
   where p.id = p_pilot_id
   for update;

  if not found then
    return query select 'PILOT_NOT_FOUND'::text, null::uuid;
    return;
  end if;

  select n.* into v_existing
    from public.pilot_retest_notes n
   where n.pilot_id = p_pilot_id
     and n.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.request_fingerprint = v_fingerprint then
      return query select 'ALREADY_ADDED'::text, v_existing.id;
    else
      return query select 'IDEMPOTENCY_KEY_CONFLICT'::text, null::uuid;
    end if;
    return;
  end if;

  select r.* into v_group
    from public.pilot_retests r
   where r.id = p_pilot_retest_id
     and r.pilot_id = p_pilot_id;

  if not found then
    return query select 'RETEST_NOT_FOUND'::text, null::uuid;
    return;
  end if;

  if v_group.abandoned_at is not null then
    return query select 'RETEST_ABANDONED'::text, null::uuid;
    return;
  end if;

  if p_noted_on < v_pilot.starts_on then
    return query select 'NOTED_BEFORE_PILOT'::text, null::uuid;
    return;
  end if;

  if p_corrects_note_id is not null and not exists (
    select 1 from public.pilot_retest_notes n
     where n.id = p_corrects_note_id
       and n.pilot_retest_id = v_group.id
  ) then
    return query select 'CORRECTED_NOTE_NOT_FOUND'::text, null::uuid;
    return;
  end if;

  if (select count(*) from public.pilot_retest_notes n where n.pilot_retest_id = v_group.id) >= 20 then
    return query select 'NOTE_LIMIT_REACHED'::text, null::uuid;
    return;
  end if;

  insert into public.pilot_retest_notes (
    pilot_retest_id, pilot_id, project_id, noted_on, kind, text, corrects_note_id,
    written_by, idempotency_key, request_fingerprint
  ) values (
    v_group.id, p_pilot_id, v_pilot.project_id, p_noted_on, p_kind, p_text, p_corrects_note_id,
    p_written_by, p_idempotency_key, v_fingerprint
  )
  returning id into v_id;

  return query select 'ADDED'::text, v_id;
end;
$$;

revoke all on function public.add_pilot_retest_note(uuid, uuid, uuid, date, text, text, uuid, uuid) from public;
revoke all on function public.add_pilot_retest_note(uuid, uuid, uuid, date, text, text, uuid, uuid) from anon;
revoke all on function public.add_pilot_retest_note(uuid, uuid, uuid, date, text, text, uuid, uuid) from authenticated;
grant execute on function public.add_pilot_retest_note(uuid, uuid, uuid, date, text, text, uuid, uuid) to service_role;

-- =======================================================================
-- 4. Triggers
-- =======================================================================

-- Each trigger function is SECURITY DEFINER with a pinned search_path and is
-- executable by no client role: only its trigger runs it. Every refusal is
-- P0001 with the message named in D-062.

-- A group is never deleted; its registered text never changes, and each
-- lifecycle tuple, once written, never changes again.
create or replace function public.pilot_retests_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'pilot_retests_are_append_only';
  end if;

  if (new.id, new.pilot_id, new.project_id, new.sequence,
      new.change_title, new.change_description, new.change_target, new.change_owner,
      new.hypothesis, new.expected_mechanism, new.alternative_explanations, new.open_questions,
      new.decision_threshold, new.confounders_to_monitor,
      new.action_type, new.threshold_below_limit, new.outcome_rule, new.observation_days, new.implement_by,
      new.customer_approval_ref, new.customer_approved_on, new.source_action_version_ids,
      new.registered_by, new.registered_at, new.idempotency_key, new.request_fingerprint)
     is distinct from
     (old.id, old.pilot_id, old.project_id, old.sequence,
      old.change_title, old.change_description, old.change_target, old.change_owner,
      old.hypothesis, old.expected_mechanism, old.alternative_explanations, old.open_questions,
      old.decision_threshold, old.confounders_to_monitor,
      old.action_type, old.threshold_below_limit, old.outcome_rule, old.observation_days, old.implement_by,
      old.customer_approval_ref, old.customer_approved_on, old.source_action_version_ids,
      old.registered_by, old.registered_at, old.idempotency_key, old.request_fingerprint) then
    raise exception using errcode = 'P0001', message = 'pilot_retest_registration_is_immutable';
  end if;

  if (old.implemented_at is not null
      and (new.implemented_at, new.window_opens_at, new.window_closes_at, new.implementation_confirmed_by,
           new.went_live_on, new.evidence_url, new.artifact_sha256, new.implementation_note,
           new.implemented_as_registered)
          is distinct from
          (old.implemented_at, old.window_opens_at, old.window_closes_at, old.implementation_confirmed_by,
           old.went_live_on, old.evidence_url, old.artifact_sha256, old.implementation_note,
           old.implemented_as_registered))
     or (old.retests_prepared_at is not null
         and (new.retests_prepared_at, new.retests_prepared_by)
             is distinct from (old.retests_prepared_at, old.retests_prepared_by))
     or (old.abandoned_at is not null
         and (new.abandoned_at, new.abandoned_by, new.abandoned_reason)
             is distinct from (old.abandoned_at, old.abandoned_by, old.abandoned_reason)) then
    raise exception using errcode = 'P0001', message = 'pilot_retest_lifecycle_is_immutable';
  end if;

  return new;
end;
$$;

revoke all on function public.pilot_retests_guard() from public, anon, authenticated, service_role;

create trigger pilot_retests_guard
  before update or delete on public.pilot_retests
  for each row execute function public.pilot_retests_guard();

-- Members, notes and steps are append-only.
create or replace function public.pilot_retest_rows_append_only()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception using errcode = 'P0001', message = 'pilot_retest_rows_are_append_only';
end;
$$;

revoke all on function public.pilot_retest_rows_append_only() from public, anon, authenticated, service_role;

create trigger pilot_retest_members_append_only
  before update or delete on public.pilot_retest_members
  for each row execute function public.pilot_retest_rows_append_only();
create trigger pilot_retest_notes_append_only
  before update or delete on public.pilot_retest_notes
  for each row execute function public.pilot_retest_rows_append_only();
create trigger pilot_retest_steps_append_only
  before update or delete on public.pilot_retest_steps
  for each row execute function public.pilot_retest_rows_append_only();

-- A retest slot belongs to its member: the member exists with the slot's
-- question, engine and project, the slot's protocol is a retest of the
-- member's baseline, and the member's group is being prepared in this
-- transaction. It fires after 20261109180000's trigger (names sort
-- pilot_question_protocols_consistency first), which still checks the engine,
-- the project and the question version of every slot.
create or replace function public.pilot_retest_slot_check()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_member    public.pilot_retest_members%rowtype;
  v_baseline  uuid;
begin
  select m.* into v_member
    from public.pilot_retest_members m
   where m.id = new.pilot_retest_member_id;

  if not found
     or v_member.pilot_question_id is distinct from new.pilot_question_id
     or v_member.engine is distinct from new.engine
     or v_member.project_id is distinct from new.project_id then
    raise exception using errcode = 'P0001', message = 'pilot_retest_slot_inconsistent';
  end if;

  select p.baseline_protocol_id into v_baseline
    from public.protocols p
   where p.id = new.protocol_id;

  if v_baseline is distinct from v_member.baseline_protocol_id then
    raise exception using errcode = 'P0001', message = 'pilot_retest_slot_inconsistent';
  end if;

  if not exists (
    select 1 from public.pilot_retest_steps st
     where st.xact_id = pg_current_xact_id()
       and st.step = 'prepare'
       and st.pilot_retest_id = v_member.pilot_retest_id
  ) then
    raise exception using errcode = 'P0001', message = 'pilot_retest_slot_inconsistent';
  end if;

  return new;
end;
$$;

revoke all on function public.pilot_retest_slot_check() from public, anon, authenticated, service_role;

create trigger pilot_question_protocols_retest_slot
  before insert on public.pilot_question_protocols
  for each row
  when (new.phase = 'retest')
  execute function public.pilot_retest_slot_check();

-- An intervention on a pilot baseline exists only as a group member, and a
-- member changes only through its group's steps. Any other intervention is
-- passed after one index lookup, so M7 outside the pilots is unaffected.
create or replace function public.pilot_retest_intervention_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_protocol  uuid;
  v_member    public.pilot_retest_members%rowtype;
  v_step      text;
begin
  v_protocol := case tg_op when 'INSERT' then new.protocol_id else old.protocol_id end;

  if not exists (
    select 1 from public.pilot_question_protocols s where s.protocol_id = v_protocol
  ) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if exists (
      select 1 from public.pilot_retest_steps st
       where st.xact_id = pg_current_xact_id()
         and st.step = 'register'
         and new.protocol_id = any (st.baseline_protocol_ids)
    ) then
      return new;
    end if;
    raise exception using errcode = 'P0001', message = 'pilot_intervention_outside_retest';
  end if;

  select m.* into v_member
    from public.pilot_retest_members m
   where m.intervention_id = old.id;

  if not found then
    -- Recovery only (S5): no such row should exist (precondition 6 and the
    -- insert rule above). If one does, it may only be closed, by rejection
    -- or abandonment.
    if old.status in ('proposed', 'approved', 'implemented')
       and new.status in ('rejected', 'abandoned') then
      return new;
    end if;
    raise exception using errcode = 'P0001', message = 'pilot_intervention_outside_retest';
  end if;

  if new.early_retest_authorized_at is distinct from old.early_retest_authorized_at then
    raise exception using errcode = 'P0001', message = 'pilot_early_retest_not_allowed';
  end if;

  if new.protocol_deviations is distinct from old.protocol_deviations then
    raise exception using errcode = 'P0001', message = 'pilot_deviation_not_allowed';
  end if;

  v_step := case
    when old.status = 'proposed' and new.status = 'approved' then 'register'
    when old.status = 'approved' and new.status = 'implemented' then 'confirm'
    when old.status in ('proposed', 'approved', 'implemented') and new.status = 'abandoned' then 'abandon'
    else null
  end;

  if v_step is not null and exists (
    select 1 from public.pilot_retest_steps st
     where st.xact_id = pg_current_xact_id()
       and st.step = v_step
       and st.pilot_retest_id = v_member.pilot_retest_id
  ) then
    return new;
  end if;

  raise exception using errcode = 'P0001', message = 'pilot_intervention_outside_retest';
end;
$$;

revoke all on function public.pilot_retest_intervention_guard() from public, anon, authenticated, service_role;

create trigger interventions_pilot_retest_guard
  before insert or update on public.interventions
  for each row execute function public.pilot_retest_intervention_guard();

-- A retest of a pilot baseline is created only by its group's preparation.
create or replace function public.pilot_retest_protocol_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.pilot_question_protocols s where s.protocol_id = new.baseline_protocol_id
  ) then
    return new;
  end if;

  if exists (
    select 1
      from public.pilot_retest_steps st
      join public.pilot_retest_members m on m.pilot_retest_id = st.pilot_retest_id
     where st.xact_id = pg_current_xact_id()
       and st.step = 'prepare'
       and m.baseline_protocol_id = new.baseline_protocol_id
  ) then
    return new;
  end if;

  raise exception using errcode = 'P0001', message = 'pilot_retest_outside_group';
end;
$$;

revoke all on function public.pilot_retest_protocol_guard() from public, anon, authenticated, service_role;

create trigger protocols_pilot_retest_guard
  before insert on public.protocols
  for each row
  when (new.baseline_protocol_id is not null)
  execute function public.pilot_retest_protocol_guard();

-- A pilot's Outcome Cards live inside its report revisions, never in
-- outcome_card_artifacts. There is no exemption: service_role may write that
-- table directly (0076).
create or replace function public.pilot_retest_card_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
       select 1 from public.pilot_question_protocols s
        where s.protocol_id = new.baseline_protocol_id
           or s.protocol_id = new.retest_protocol_id)
     or exists (
       select 1 from public.pilot_retest_members m where m.intervention_id = new.intervention_id)
     or (tg_op = 'UPDATE'
         and (exists (
                select 1 from public.pilot_question_protocols s
                 where s.protocol_id = old.baseline_protocol_id
                    or s.protocol_id = old.retest_protocol_id)
              or exists (
                select 1 from public.pilot_retest_members m where m.intervention_id = old.intervention_id))) then
    raise exception using errcode = 'P0001', message = 'pilot_outcome_card_lives_in_the_pilot_report';
  end if;

  return new;
end;
$$;

revoke all on function public.pilot_retest_card_guard() from public, anon, authenticated, service_role;

create trigger outcome_card_artifacts_pilot_retest_guard
  before insert or update on public.outcome_card_artifacts
  for each row execute function public.pilot_retest_card_guard();

-- =======================================================================
-- 5. save_pilot_report_artifact and share_pilot_report_artifact, redefined:
--    20261109160000's bodies byte for byte, each with one block marked
--    D-062 begin/end after its D-057 block (in the save, before the revision
--    is numbered; in the share, before the acknowledgement check). The block
--    declares its own variables, so 20261109160000's declarations are
--    untouched. The signatures are unchanged; the privileges are restated.
-- =======================================================================

create or replace function public.save_pilot_report_artifact(
  p_pilot_id           uuid,
  p_created_by         uuid,
  p_markdown           text,
  p_payload            jsonb,
  p_manifest           jsonb,
  p_integrity_status   text,
  p_integrity_reasons  jsonb,
  p_generated_at       timestamptz
)
returns table (outcome text, artifact_id uuid, revision integer)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_pilot public.pilots%rowtype;
  v_manifest_protocols uuid[];
  v_pilot_protocols uuid[];
  v_revision integer;
  v_id uuid;
begin
  if p_pilot_id is null or p_created_by is null
     or p_markdown is null or char_length(btrim(p_markdown)) = 0
     or p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or (p_payload ->> 'pilotId') is distinct from p_pilot_id::text
     or p_manifest is null or jsonb_typeof(p_manifest) <> 'object'
     or jsonb_typeof(p_manifest -> 'protocols') is distinct from 'array'
     or jsonb_typeof(p_manifest -> 'attempts') is distinct from 'array'
     or p_generated_at is null
     or p_integrity_status is null
     or p_integrity_status not in ('integrity_passed', 'needs_review', 'blocked')
     or p_integrity_reasons is null or jsonb_typeof(p_integrity_reasons) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_save_pilot_report_args';
  end if;

  if (p_integrity_status = 'integrity_passed') <> (jsonb_array_length(p_integrity_reasons) = 0) then
    raise exception using errcode = '22023', message = 'invalid_save_pilot_report_args';
  end if;

  -- Every manifest entry is well formed, and nothing is listed twice.
  if exists (
       select 1 from jsonb_array_elements(p_manifest -> 'protocols') e
        where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ v_uuid)
     or exists (
       select 1 from jsonb_array_elements(p_manifest -> 'attempts') e
        where jsonb_typeof(e) <> 'object'
           or jsonb_typeof(e -> 'id') is distinct from 'string' or (e ->> 'id') !~ v_uuid
           or jsonb_typeof(e -> 'protocolId') is distinct from 'string' or (e ->> 'protocolId') !~ v_uuid
           or not (jsonb_typeof(e -> 'rawResponseSha256') in ('null', 'string'))
           or (jsonb_typeof(e -> 'rawResponseSha256') = 'string' and (e ->> 'rawResponseSha256') !~ '^[0-9a-f]{64}$'))
     or (select count(*) from jsonb_array_elements(p_manifest -> 'protocols'))
        <> (select count(distinct e #>> '{}') from jsonb_array_elements(p_manifest -> 'protocols') e)
     or (select count(*) from jsonb_array_elements(p_manifest -> 'attempts'))
        <> (select count(distinct e ->> 'id') from jsonb_array_elements(p_manifest -> 'attempts') e) then
    raise exception using errcode = '22023', message = 'invalid_save_pilot_report_args';
  end if;

  -- Serialises revision numbers per pilot.
  select * into v_pilot from public.pilots where id = p_pilot_id for update;
  if not found then
    return query select 'PILOT_NOT_FOUND'::text, null::uuid, null::integer;
    return;
  end if;

  if (p_payload ->> 'projectId') is distinct from v_pilot.project_id::text then
    return query select 'EVIDENCE_OUTSIDE_PILOT'::text, null::uuid, null::integer;
    return;
  end if;

  -- A measurement still running: answers may still be written, so the
  -- report would read a moving target. Checked before the evidence, so a
  -- build that raced a run is refused for what it is. The pilot row lock
  -- above is the one request_protocol_job_run takes for share, so no new Run
  -- can be requested for this pilot while the save runs.
  if exists (
    select 1
      from public.pilot_questions pq
      join public.pilot_question_protocols pqp on pqp.pilot_question_id = pq.id
      join public.protocols pr
        on pr.id = pqp.protocol_id or pr.baseline_protocol_id = pqp.protocol_id
      left join public.protocol_execution_jobs j on j.protocol_id = pr.id
     where pq.pilot_id = p_pilot_id
       and (
         (j.status in ('claimed', 'running') and j.lease_expires_at > now())
         or exists (
           select 1
             from public.protocol_job_run_requests r
            where r.job_id = j.id
              and r.status = 'pending'
              and r.expires_at > now())
         or exists (
           select 1
             from public.protocol_attempts a
            where a.protocol_id = pr.id
              and a.status in ('reserved', 'in_progress'))
       )
  ) then
    return query select 'MEASUREMENT_IN_PROGRESS'::text, null::uuid, null::integer;
    return;
  end if;

  v_manifest_protocols := array(
    select (e #>> '{}')::uuid from jsonb_array_elements(p_manifest -> 'protocols') e);
  v_pilot_protocols := array(
    select pqp.protocol_id
      from public.pilot_question_protocols pqp
      join public.pilot_questions pq on pq.id = pqp.pilot_question_id
     where pq.pilot_id = p_pilot_id);

  -- A protocol that is not one of this pilot's.
  if exists (select unnest(v_manifest_protocols) except select unnest(v_pilot_protocols)) then
    return query select 'EVIDENCE_OUTSIDE_PILOT'::text, null::uuid, null::integer;
    return;
  end if;

  -- An attempt that does not exist, belongs to another protocol or project,
  -- or is listed under a protocol the manifest does not name.
  if exists (
    select 1
      from jsonb_array_elements(p_manifest -> 'attempts') e
      left join public.protocol_attempts a on a.id = (e ->> 'id')::uuid
     where a.id is null
        or a.protocol_id <> (e ->> 'protocolId')::uuid
        or a.project_id <> v_pilot.project_id
        or not ((e ->> 'protocolId')::uuid = any (v_manifest_protocols))) then
    return query select 'EVIDENCE_OUTSIDE_PILOT'::text, null::uuid, null::integer;
    return;
  end if;

  -- A pilot protocol, retired questions' included, or one of its attempts,
  -- left out: the report would hide failed or excluded attempts.
  if exists (select unnest(v_pilot_protocols) except select unnest(v_manifest_protocols))
     or exists (
       select 1 from public.protocol_attempts a
        where a.protocol_id = any (v_pilot_protocols)
          and not exists (
            select 1 from jsonb_array_elements(p_manifest -> 'attempts') e
             where (e ->> 'id')::uuid = a.id)) then
    return query select 'EVIDENCE_INCOMPLETE'::text, null::uuid, null::integer;
    return;
  end if;

  -- Each listed response hash is the stored one (none where no result exists).
  if exists (
    select 1
      from jsonb_array_elements(p_manifest -> 'attempts') e
      join public.protocol_attempts a on a.id = (e ->> 'id')::uuid
      left join public.probe_results r on r.probe_run_id = a.probe_run_id
     where (e ->> 'rawResponseSha256') is distinct from r.raw_response_sha256) then
    return query select 'EVIDENCE_MISMATCH'::text, null::uuid, null::integer;
    return;
  end if;

  -- D-057 begin: suggested actions. The manifest lists the action versions
  -- the payload shows (none when the key is absent). Each must be its
  -- action's latest version, reviewed, of an action of this pilot that is
  -- not withdrawn, and every such action must be listed, so a revision
  -- shows exactly the reviewed actions. A revision with any action is never
  -- integrity_passed: the founder reads it before sharing (D-057).
  if (p_manifest ? 'actionVersions' and jsonb_typeof(p_manifest -> 'actionVersions') <> 'array')
     or (p_payload ? 'actions' and jsonb_typeof(p_payload -> 'actions') <> 'array') then
    raise exception using errcode = '22023', message = 'invalid_save_pilot_report_args';
  end if;
  if exists (
       select 1 from jsonb_array_elements(coalesce(p_manifest -> 'actionVersions', '[]'::jsonb)) e
        where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ v_uuid)
     or exists (
       select 1 from jsonb_array_elements(coalesce(p_payload -> 'actions', '[]'::jsonb)) a
        where jsonb_typeof(a) <> 'object' or jsonb_typeof(a -> 'versionId') is distinct from 'string'
           or jsonb_typeof(a -> 'evidence') is distinct from 'array')
     or (select count(*) from jsonb_array_elements(coalesce(p_manifest -> 'actionVersions', '[]'::jsonb)))
        <> (select count(distinct e #>> '{}') from jsonb_array_elements(coalesce(p_manifest -> 'actionVersions', '[]'::jsonb)) e)
     or (select count(*) from jsonb_array_elements(coalesce(p_payload -> 'actions', '[]'::jsonb)))
        <> (select count(distinct a ->> 'versionId') from jsonb_array_elements(coalesce(p_payload -> 'actions', '[]'::jsonb)) a)
     or exists (
       select e #>> '{}' from jsonb_array_elements(coalesce(p_manifest -> 'actionVersions', '[]'::jsonb)) e
       except
       select a ->> 'versionId' from jsonb_array_elements(coalesce(p_payload -> 'actions', '[]'::jsonb)) a)
     or exists (
       select a ->> 'versionId' from jsonb_array_elements(coalesce(p_payload -> 'actions', '[]'::jsonb)) a
       except
       select e #>> '{}' from jsonb_array_elements(coalesce(p_manifest -> 'actionVersions', '[]'::jsonb)) e)
     or (jsonb_array_length(coalesce(p_manifest -> 'actionVersions', '[]'::jsonb)) > 0
         and p_integrity_status = 'integrity_passed') then
    raise exception using errcode = '22023', message = 'invalid_save_pilot_report_args';
  end if;

  -- A listed version that is not its action's latest, reviewed version of
  -- an action of this pilot that is not withdrawn.
  if exists (
    select 1
      from jsonb_array_elements(coalesce(p_manifest -> 'actionVersions', '[]'::jsonb)) e
      left join public.pilot_action_versions pav
        on pav.id = (e #>> '{}')::uuid and pav.pilot_id = p_pilot_id
     where pav.id is null
        or pav.version_number <> (
             select max(pav2.version_number) from public.pilot_action_versions pav2 where pav2.action_id = pav.action_id)
        or not exists (
             select 1 from public.pilot_action_events ev where ev.action_version_id = pav.id and ev.event = 'reviewed')
        or exists (
             select 1 from public.pilot_action_events ev where ev.action_id = pav.action_id and ev.event = 'withdrawn')) then
    return query select 'ACTION_NOT_REVIEWED'::text, null::uuid, null::integer;
    return;
  end if;

  -- A reviewed, current action of this pilot left out.
  if exists (
    select 1
      from public.pilot_action_versions pav
     where pav.pilot_id = p_pilot_id
       and pav.version_number = (
             select max(pav2.version_number) from public.pilot_action_versions pav2 where pav2.action_id = pav.action_id)
       and exists (
             select 1 from public.pilot_action_events ev where ev.action_version_id = pav.id and ev.event = 'reviewed')
       and not exists (
             select 1 from public.pilot_action_events ev where ev.action_id = pav.action_id and ev.event = 'withdrawn')
       and not exists (
             select 1 from jsonb_array_elements(coalesce(p_manifest -> 'actionVersions', '[]'::jsonb)) e
              where (e #>> '{}')::uuid = pav.id)) then
    return query select 'ACTIONS_INCOMPLETE'::text, null::uuid, null::integer;
    return;
  end if;

  -- What the payload shows of each action is the stored version: its six
  -- fields, and its links (answer and source) as a set. Not checked for a
  -- blocked revision, which can never be shared or served and lists an
  -- action whose links failed so the founder's preview shows why.
  if p_integrity_status <> 'blocked' and exists (
    select 1
      from jsonb_array_elements(coalesce(p_payload -> 'actions', '[]'::jsonb)) a
      join public.pilot_action_versions pav
        on pav.id = (a ->> 'versionId')::uuid and pav.pilot_id = p_pilot_id
     where (a ->> 'title') is distinct from pav.title
        or (a ->> 'observation') is distinct from pav.observation
        or (a ->> 'suggestedAction') is distinct from pav.suggested_action
        or (a ->> 'whyItMightMatter') is distinct from pav.why_it_might_matter
        or (a ->> 'alternativeExplanations') is distinct from pav.alternative_explanations
        or (a ->> 'openQuestions') is distinct from pav.open_questions
        or array(
             select coalesce(ev ->> 'attemptId', '') || '|' || coalesce(ev ->> 'sourceUrl', '')
               from jsonb_array_elements(a -> 'evidence') ev
              order by 1)
           is distinct from array(
             select pae.attempt_id::text || '|' || coalesce(pae.source_url, '')
               from public.pilot_action_evidence pae
              where pae.action_version_id = pav.id
              order by 1)) then
    return query select 'ACTIONS_CONTENT_MISMATCH'::text, null::uuid, null::integer;
    return;
  end if;
  -- D-057 end

  -- D-062 begin: pilot retests and their Outcome Cards (20261109190000). The
  -- manifest lists the pilot's retest groups, their notes, the job of every
  -- retest slot and the Outcome Cards the payload shows (an absent key is an
  -- empty list), and each must be exactly what is stored now. A card exists
  -- exactly for each member of a group not abandoned whose retest has an
  -- answer and is final (pilot_retest_job_is_final), so an unwelcome card
  -- cannot be left out and none is built from an unfinished retest. A card
  -- the newest shared revision shows never changes or vanishes. Unless the
  -- revision is blocked, what the payload shows of each group is the stored
  -- group. A revision with any retest is never integrity_passed: sharing it
  -- is the recorded review of its cards. With no group these checks pass.
  declare
    v_m_retests  jsonb := coalesce(p_manifest -> 'retests', '[]'::jsonb);
    v_m_notes    jsonb := coalesce(p_manifest -> 'retestNotes', '[]'::jsonb);
    v_m_jobs     jsonb := coalesce(p_manifest -> 'retestJobs', '[]'::jsonb);
    v_m_cards    jsonb := coalesce(p_manifest -> 'retestCards', '[]'::jsonb);
    v_p_retests  jsonb := coalesce(p_payload -> 'retests', '[]'::jsonb);
    v_p_cards    jsonb := coalesce(p_payload -> 'outcomeCards', '[]'::jsonb);
    -- NON_CAUSALITY_FOOTER (lib/reports/outcome-card-types.ts) and
    -- PILOT_RETEST_WITHHELD_TEXT (lib/reports/pilot-retest-copy.ts).
    v_footer     constant text := 'This Outcome Card documents an observed change under the recorded conditions. It does not establish that the intervention caused the change.';
    v_withheld   constant text := 'This text is not shown because it uses wording this report may not use.';
    v_statuses   constant text[] := array['increase_observed', 'decrease_observed', 'no_clear_change', 'inconclusive'];
    v_states     constant text[] := array['registered', 'implemented', 'prepared', 'abandoned'];
    v_text_keys  constant text[] := array[
      'changeTitle', 'changeDescription', 'changeTarget', 'changeOwner', 'hypothesis', 'expectedMechanism',
      'alternativeExplanations', 'openQuestions', 'decisionThreshold', 'confoundersToMonitor'];
    v_instant    constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$';
    v_shared     jsonb;
    v_e          jsonb;
    v_r          public.pilot_retests%rowtype;
    v_stored     jsonb;
    v_state      text;
  begin
    -- 1. Shape: every key a list of well-formed entries, nothing listed twice,
    --    the payload naming exactly the manifest's groups and cards, every
    --    card with its identities, one of the four statuses and the footer.
    if jsonb_typeof(v_m_retests) <> 'array' or jsonb_typeof(v_m_notes) <> 'array'
       or jsonb_typeof(v_m_jobs) <> 'array' or jsonb_typeof(v_m_cards) <> 'array'
       or jsonb_typeof(v_p_retests) <> 'array' or jsonb_typeof(v_p_cards) <> 'array' then
      raise exception using errcode = '22023', message = 'invalid_save_pilot_report_args';
    end if;
    if exists (
         select 1 from jsonb_array_elements(v_m_retests) e
          where jsonb_typeof(e) <> 'object'
             or jsonb_typeof(e -> 'id') is distinct from 'string' or (e ->> 'id') !~ v_uuid
             or jsonb_typeof(e -> 'state') is distinct from 'string' or not coalesce((e ->> 'state') = any (v_states), false)
             or jsonb_typeof(e -> 'memberIds') is distinct from 'array'
             or exists (
                  select 1
                    from jsonb_array_elements(case when jsonb_typeof(e -> 'memberIds') = 'array' then e -> 'memberIds' else '[]'::jsonb end) x
                   where jsonb_typeof(x) <> 'string' or (x #>> '{}') !~ v_uuid)
             or (select count(*) from jsonb_array_elements(case when jsonb_typeof(e -> 'memberIds') = 'array' then e -> 'memberIds' else '[]'::jsonb end))
                <> (select count(distinct x #>> '{}') from jsonb_array_elements(case when jsonb_typeof(e -> 'memberIds') = 'array' then e -> 'memberIds' else '[]'::jsonb end) x))
       or exists (
         select 1 from jsonb_array_elements(v_m_notes) e
          where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ v_uuid)
       or exists (
         select 1 from jsonb_array_elements(v_m_jobs) e
          where jsonb_typeof(e) <> 'object'
             or jsonb_typeof(e -> 'jobId') is distinct from 'string' or (e ->> 'jobId') !~ v_uuid
             or jsonb_typeof(e -> 'protocolId') is distinct from 'string' or (e ->> 'protocolId') !~ v_uuid
             or jsonb_typeof(e -> 'status') is distinct from 'string'
             or not coalesce(jsonb_typeof(e -> 'reviewResolution') in ('null', 'string'), false))
       or exists (
         select 1 from jsonb_array_elements(v_m_cards) e
          where jsonb_typeof(e) <> 'object'
             or jsonb_typeof(e -> 'memberId') is distinct from 'string' or (e ->> 'memberId') !~ v_uuid
             or jsonb_typeof(e -> 'status') is distinct from 'string' or not coalesce((e ->> 'status') = any (v_statuses), false)
             or jsonb_typeof(e -> 'retestAttemptIds') is distinct from 'array'
             or exists (
                  select 1
                    from jsonb_array_elements(case when jsonb_typeof(e -> 'retestAttemptIds') = 'array' then e -> 'retestAttemptIds' else '[]'::jsonb end) x
                   where jsonb_typeof(x) <> 'string' or (x #>> '{}') !~ v_uuid)
             or (select count(*) from jsonb_array_elements(case when jsonb_typeof(e -> 'retestAttemptIds') = 'array' then e -> 'retestAttemptIds' else '[]'::jsonb end))
                <> (select count(distinct x #>> '{}') from jsonb_array_elements(case when jsonb_typeof(e -> 'retestAttemptIds') = 'array' then e -> 'retestAttemptIds' else '[]'::jsonb end) x))
       or exists (
         select 1 from jsonb_array_elements(v_p_retests) e
          where jsonb_typeof(e) <> 'object'
             or jsonb_typeof(e -> 'retestId') is distinct from 'string' or (e ->> 'retestId') !~ v_uuid)
       or exists (
         select 1 from jsonb_array_elements(v_p_cards) e
          where jsonb_typeof(e) <> 'object'
             or jsonb_typeof(e -> 'memberId') is distinct from 'string' or (e ->> 'memberId') !~ v_uuid
             or jsonb_typeof(e -> 'interventionId') is distinct from 'string' or (e ->> 'interventionId') !~ v_uuid
             or jsonb_typeof(e -> 'retestId') is distinct from 'string' or (e ->> 'retestId') !~ v_uuid
             or jsonb_typeof(e -> 'baselineProtocolId') is distinct from 'string' or (e ->> 'baselineProtocolId') !~ v_uuid
             or jsonb_typeof(e -> 'retestProtocolId') is distinct from 'string' or (e ->> 'retestProtocolId') !~ v_uuid
             or jsonb_typeof(e -> 'status') is distinct from 'string' or not coalesce((e ->> 'status') = any (v_statuses), false)
             or jsonb_typeof(e -> 'footer') is distinct from 'string' or (e ->> 'footer') is distinct from v_footer)
       or (select count(*) from jsonb_array_elements(v_m_retests))
          <> (select count(distinct e ->> 'id') from jsonb_array_elements(v_m_retests) e)
       or (select count(*) from jsonb_array_elements(v_m_notes))
          <> (select count(distinct e #>> '{}') from jsonb_array_elements(v_m_notes) e)
       or (select count(*) from jsonb_array_elements(v_m_jobs))
          <> (select count(distinct e ->> 'jobId') from jsonb_array_elements(v_m_jobs) e)
       or (select count(*) from jsonb_array_elements(v_m_cards))
          <> (select count(distinct e ->> 'memberId') from jsonb_array_elements(v_m_cards) e)
       or (select count(*) from jsonb_array_elements(v_p_retests))
          <> (select count(distinct e ->> 'retestId') from jsonb_array_elements(v_p_retests) e)
       or (select count(*) from jsonb_array_elements(v_p_cards))
          <> (select count(distinct e ->> 'memberId') from jsonb_array_elements(v_p_cards) e)
       or exists (
         select e ->> 'id' from jsonb_array_elements(v_m_retests) e
         except
         select e ->> 'retestId' from jsonb_array_elements(v_p_retests) e)
       or exists (
         select e ->> 'retestId' from jsonb_array_elements(v_p_retests) e
         except
         select e ->> 'id' from jsonb_array_elements(v_m_retests) e)
       or exists (
         select e ->> 'memberId' from jsonb_array_elements(v_m_cards) e
         except
         select e ->> 'memberId' from jsonb_array_elements(v_p_cards) e)
       or exists (
         select e ->> 'memberId' from jsonb_array_elements(v_p_cards) e
         except
         select e ->> 'memberId' from jsonb_array_elements(v_m_cards) e)
       or (jsonb_array_length(v_m_retests) > 0 and p_integrity_status = 'integrity_passed') then
      raise exception using errcode = '22023', message = 'invalid_save_pilot_report_args';
    end if;

    -- 2. The groups (with their state and members), their notes and every
    --    retest slot's job are what the build read: anything written since
    --    (a step, a note, a Run, a review resolution) makes the build stale.
    if array(
         select r.id::text || '|'
                || case when r.abandoned_at is not null then 'abandoned'
                        when r.retests_prepared_at is not null then 'prepared'
                        when r.implemented_at is not null then 'implemented'
                        else 'registered' end
                || '|' || coalesce((
                     select string_agg(m.id::text, ',' order by m.id::text)
                       from public.pilot_retest_members m
                      where m.pilot_retest_id = r.id), '')
           from public.pilot_retests r
          where r.pilot_id = p_pilot_id
          order by 1)
       is distinct from array(
         select (e ->> 'id') || '|' || (e ->> 'state') || '|'
                || coalesce((
                     select string_agg(x #>> '{}', ',' order by x #>> '{}')
                       from jsonb_array_elements(e -> 'memberIds') x), '')
           from jsonb_array_elements(v_m_retests) e
          order by 1)
       or array(
         select n.id::text
           from public.pilot_retest_notes n
          where n.pilot_id = p_pilot_id
          order by 1)
          is distinct from array(
         select e #>> '{}'
           from jsonb_array_elements(v_m_notes) e
          order by 1)
       or array(
         select j.id::text || '|' || j.protocol_id::text || '|' || j.status || '|' || coalesce(j.review_resolution, '-')
           from public.pilot_question_protocols s
           join public.pilot_questions pq on pq.id = s.pilot_question_id
           join public.protocol_execution_jobs j on j.protocol_id = s.protocol_id
          where pq.pilot_id = p_pilot_id
            and s.phase = 'retest'
          order by 1)
          is distinct from array(
         select (e ->> 'jobId') || '|' || (e ->> 'protocolId') || '|' || (e ->> 'status') || '|' || coalesce(e ->> 'reviewResolution', '-')
           from jsonb_array_elements(v_m_jobs) e
          order by 1) then
      return query select 'RETESTS_CHANGED'::text, null::uuid, null::integer;
      return;
    end if;

    -- 3. Each card is its member's: its intervention (implemented, on the
    --    member's baseline), its group, its baseline and retest protocols,
    --    exactly the retest's attempts, and the status the manifest lists.
    if exists (
      select 1
        from jsonb_array_elements(v_m_cards) c
        join jsonb_array_elements(v_p_cards) p on (p ->> 'memberId') = (c ->> 'memberId')
        left join public.pilot_retest_members m
          on m.id::text = (c ->> 'memberId') and m.pilot_id = p_pilot_id
        left join public.pilot_question_protocols s on s.pilot_retest_member_id = m.id
        left join public.interventions i on i.id = m.intervention_id
       where m.id is null
          or (p ->> 'interventionId') is distinct from m.intervention_id::text
          or (p ->> 'retestId') is distinct from m.pilot_retest_id::text
          or (p ->> 'baselineProtocolId') is distinct from m.baseline_protocol_id::text
          or s.protocol_id is null
          or (p ->> 'retestProtocolId') is distinct from s.protocol_id::text
          or i.status is distinct from 'implemented'
          or i.protocol_id is distinct from m.baseline_protocol_id
          or array(select x #>> '{}' from jsonb_array_elements(c -> 'retestAttemptIds') x order by 1)
             is distinct from array(select a.id::text from public.protocol_attempts a where a.protocol_id = s.protocol_id order by 1)
          or (p ->> 'status') is distinct from (c ->> 'status')
    ) then
      return query select 'RETEST_CARD_MISMATCH'::text, null::uuid, null::integer;
      return;
    end if;

    -- 4. M1: exactly the members of groups not abandoned whose retest has at
    --    least one attempt and is final have a card, in both directions.
    if array(select c ->> 'memberId' from jsonb_array_elements(v_m_cards) c order by 1)
       is distinct from array(
         select m.id::text
           from public.pilot_retest_members m
           join public.pilot_retests r on r.id = m.pilot_retest_id
           join public.pilot_question_protocols s on s.pilot_retest_member_id = m.id
           join public.protocol_execution_jobs j on j.protocol_id = s.protocol_id
          where m.pilot_id = p_pilot_id
            and r.abandoned_at is null
            and exists (select 1 from public.protocol_attempts a where a.protocol_id = s.protocol_id)
            and public.pilot_retest_job_is_final(j.id) is true
          order by 1) then
      return query select 'RETEST_CARDS_INCOMPLETE'::text, null::uuid, null::integer;
      return;
    end if;

    -- 5. A card the newest shared revision shows keeps its status and its
    --    retest answers in every later revision.
    select pra.manifest -> 'retestCards' into v_shared
      from public.pilot_report_artifacts pra
     where pra.pilot_id = p_pilot_id
       and pra.shared_at is not null
     order by pra.revision desc
     limit 1;
    if exists (
      select 1
        from jsonb_array_elements(case when jsonb_typeof(v_shared) = 'array' then v_shared else '[]'::jsonb end) o
       where not exists (
         select 1
           from jsonb_array_elements(v_m_cards) c
          where (c ->> 'memberId') = (o ->> 'memberId')
            and (c ->> 'status') = (o ->> 'status')
            and array(select x #>> '{}' from jsonb_array_elements(c -> 'retestAttemptIds') x order by 1)
                = array(
                    select x #>> '{}'
                      from jsonb_array_elements(case when jsonb_typeof(o -> 'retestAttemptIds') = 'array' then o -> 'retestAttemptIds' else '[]'::jsonb end) x
                     order by 1))
    ) then
      return query select 'RETEST_CARD_CHANGED_SINCE_SHARED'::text, null::uuid, null::integer;
      return;
    end if;

    -- 6. What the payload shows of each group is the stored group (not
    --    checked for a blocked revision, as D-057). A text field is shown as
    --    stored or, when the build withheld it, as the withheld sentence; the
    --    customer approval reference is never shown (M10).
    if p_integrity_status <> 'blocked' then
      for v_e in select e from jsonb_array_elements(v_p_retests) e loop
        select r.* into v_r
          from public.pilot_retests r
         where r.id::text = (v_e ->> 'retestId')
           and r.pilot_id = p_pilot_id;
        if not found then
          return query select 'RETEST_CONTENT_MISMATCH'::text, null::uuid, null::integer;
          return;
        end if;

        v_state := case when v_r.abandoned_at is not null then 'abandoned'
                        when v_r.retests_prepared_at is not null then 'prepared'
                        when v_r.implemented_at is not null then 'implemented'
                        else 'registered' end;
        v_stored := jsonb_build_object(
          'changeTitle', v_r.change_title,
          'changeDescription', v_r.change_description,
          'changeTarget', v_r.change_target,
          'changeOwner', v_r.change_owner,
          'hypothesis', v_r.hypothesis,
          'expectedMechanism', v_r.expected_mechanism,
          'alternativeExplanations', v_r.alternative_explanations,
          'openQuestions', v_r.open_questions,
          'decisionThreshold', v_r.decision_threshold,
          'confoundersToMonitor', v_r.confounders_to_monitor);

        if jsonb_typeof(v_e -> 'text') is distinct from 'object'
           or jsonb_typeof(v_e -> 'withheldFields') is distinct from 'array'
           or exists (
                select 1
                  from jsonb_array_elements(case when jsonb_typeof(v_e -> 'withheldFields') = 'array' then v_e -> 'withheldFields' else '[]'::jsonb end) w
                 where jsonb_typeof(w) <> 'string' or not coalesce((w #>> '{}') = any (v_text_keys), false))
           or array(
                select k from jsonb_object_keys(case when jsonb_typeof(v_e -> 'text') = 'object' then v_e -> 'text' else '{}'::jsonb end) k
                 order by 1)
              is distinct from array(select k from unnest(v_text_keys) k order by 1)
           or exists (
                select 1
                  from jsonb_each_text(v_stored) st
                 where (v_e -> 'text' ->> st.key) is distinct from st.value
                   and not (coalesce((v_e -> 'withheldFields') ? st.key, false)
                            and (v_e -> 'text' ->> st.key) is not distinct from v_withheld))
           or (v_e -> 'sequence') is distinct from to_jsonb(v_r.sequence)
           or (v_e ->> 'state') is distinct from v_state
           or (v_e ->> 'actionType') is distinct from v_r.action_type
           or (v_e -> 'observationDays') is distinct from to_jsonb(v_r.observation_days)
           or (v_e ->> 'implementBy') is distinct from to_char(v_r.implement_by, 'YYYY-MM-DD')
           or (v_e ->> 'customerApprovedOn') is distinct from to_char(v_r.customer_approved_on, 'YYYY-MM-DD')
           or (v_e -> 'thresholdBelowLimit') is distinct from to_jsonb(v_r.threshold_below_limit)
           or (v_e ->> 'outcomeRule') is distinct from v_r.outcome_rule
           or (v_e ->> 'registeredOn') is distinct from to_char(v_r.registered_at at time zone 'UTC', 'YYYY-MM-DD')
           or (v_e -> 'prepared') is distinct from to_jsonb(v_r.retests_prepared_at is not null)
           or (case
                when v_r.implemented_at is null then
                  (v_e -> 'implementation') is distinct from 'null'::jsonb
                  or (v_e -> 'windowOpensAt') is distinct from 'null'::jsonb
                  or (v_e -> 'windowClosesAt') is distinct from 'null'::jsonb
                else
                  jsonb_typeof(v_e -> 'implementation') is distinct from 'object'
                  or (v_e -> 'implementation' ->> 'wentLiveOn') is distinct from to_char(v_r.went_live_on, 'YYYY-MM-DD')
                  or (v_e -> 'implementation' -> 'evidenceUrl') is distinct from coalesce(to_jsonb(v_r.evidence_url), 'null'::jsonb)
                  or (v_e -> 'implementation' -> 'artifactSha256') is distinct from coalesce(to_jsonb(v_r.artifact_sha256), 'null'::jsonb)
                  or (v_e -> 'implementation' -> 'implementedAsRegistered') is distinct from to_jsonb(v_r.implemented_as_registered)
                  or not case when coalesce((v_e -> 'implementation' ->> 'recordedAt') ~ v_instant, false)
                              then abs(extract(epoch from ((v_e -> 'implementation' ->> 'recordedAt')::timestamptz - v_r.implemented_at))) < 0.001
                              else false end
                  or not case when coalesce((v_e ->> 'windowOpensAt') ~ v_instant, false)
                              then abs(extract(epoch from ((v_e ->> 'windowOpensAt')::timestamptz - v_r.window_opens_at))) < 0.001
                              else false end
                  or not case when coalesce((v_e ->> 'windowClosesAt') ~ v_instant, false)
                              then abs(extract(epoch from ((v_e ->> 'windowClosesAt')::timestamptz - v_r.window_closes_at))) < 0.001
                              else false end
              end)
           or (v_e -> 'abandoned') is distinct from
                (case when v_r.abandoned_at is null then 'null'::jsonb
                      else jsonb_build_object(
                             'abandonedOn', to_char(v_r.abandoned_at at time zone 'UTC', 'YYYY-MM-DD'),
                             'wasLive', v_r.implemented_at is not null) end)
           -- M13: one entry per stored source version, in order; the title
           -- only while its action is not withdrawn.
           or (v_e -> 'sourceActions') is distinct from coalesce((
                select jsonb_agg(jsonb_build_object(
                         'versionId', u.id,
                         'title', case when w.withdrawn then null else pav.title end,
                         'withdrawn', w.withdrawn) order by u.n)
                  from unnest(v_r.source_action_version_ids) with ordinality as u(id, n)
                  join public.pilot_action_versions pav on pav.id = u.id
                  cross join lateral (
                    select exists (
                      select 1 from public.pilot_action_events ev
                       where ev.action_id = pav.action_id and ev.event = 'withdrawn') as withdrawn) w), '[]'::jsonb)
           -- The group's notes, exactly: each as stored, or withheld.
           or jsonb_typeof(v_e -> 'notes') is distinct from 'array'
           or jsonb_array_length(case when jsonb_typeof(v_e -> 'notes') = 'array' then v_e -> 'notes' else '[]'::jsonb end)
              <> (select count(*) from public.pilot_retest_notes n where n.pilot_retest_id = v_r.id)
           or exists (
                select 1
                  from public.pilot_retest_notes n
                 where n.pilot_retest_id = v_r.id
                   and not exists (
                     select 1
                       from jsonb_array_elements(case when jsonb_typeof(v_e -> 'notes') = 'array' then v_e -> 'notes' else '[]'::jsonb end) x
                      where (x ->> 'id') = n.id::text
                        and (x ->> 'notedOn') = to_char(n.noted_on, 'YYYY-MM-DD')
                        and (x ->> 'kind') = n.kind
                        and (((x ->> 'text') = n.text and (x -> 'withheld') = 'false'::jsonb)
                             or ((x ->> 'text') = v_withheld and (x -> 'withheld') = 'true'::jsonb))
                        and (x -> 'correctsNoteId') = coalesce(to_jsonb(n.corrects_note_id), 'null'::jsonb)
                        and case when coalesce((x ->> 'writtenAt') ~ v_instant, false)
                                 then abs(extract(epoch from ((x ->> 'writtenAt')::timestamptz - n.written_at))) < 0.001
                                 else false end)) then
          return query select 'RETEST_CONTENT_MISMATCH'::text, null::uuid, null::integer;
          return;
        end if;
      end loop;
    end if;
  end;
  -- D-062 end

  select coalesce(max(pra.revision), 0) + 1 into v_revision
    from public.pilot_report_artifacts pra
   where pra.pilot_id = p_pilot_id;

  insert into public.pilot_report_artifacts (
    pilot_id, project_id, revision, markdown, payload, manifest, content_sha256,
    generated_at, integrity_status, integrity_reasons, public_token, created_by
  ) values (
    p_pilot_id, v_pilot.project_id, v_revision, p_markdown, p_payload, p_manifest,
    encode(sha256(sha256(convert_to(p_markdown, 'UTF8')) || sha256(convert_to(p_payload::text, 'UTF8'))), 'hex'),
    p_generated_at, p_integrity_status, p_integrity_reasons,
    replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
    p_created_by
  )
  returning id into v_id;

  return query select 'SAVED'::text, v_id, v_revision;
end;
$$;

revoke all on function public.save_pilot_report_artifact(uuid, uuid, text, jsonb, jsonb, text, jsonb, timestamptz) from public;
revoke all on function public.save_pilot_report_artifact(uuid, uuid, text, jsonb, jsonb, text, jsonb, timestamptz) from anon;
revoke all on function public.save_pilot_report_artifact(uuid, uuid, text, jsonb, jsonb, text, jsonb, timestamptz) from authenticated;
grant execute on function public.save_pilot_report_artifact(uuid, uuid, text, jsonb, jsonb, text, jsonb, timestamptz) to service_role;

create or replace function public.share_pilot_report_artifact(
  p_artifact_id               uuid,
  p_pilot_id                  uuid,
  p_shared_by                 uuid,
  p_acknowledge_needs_review  boolean
)
returns table (outcome text, public_token text)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_art public.pilot_report_artifacts%rowtype;
begin
  if p_artifact_id is null or p_pilot_id is null or p_shared_by is null or p_acknowledge_needs_review is null then
    raise exception using errcode = '22023', message = 'invalid_share_pilot_report_args';
  end if;

  -- The same lock a save takes, so "latest" cannot change underneath.
  perform 1 from public.pilots where id = p_pilot_id for share;

  select * into v_art
    from public.pilot_report_artifacts pra
   where pra.id = p_artifact_id and pra.pilot_id = p_pilot_id
   for update;
  if not found then
    return query select 'NOT_FOUND'::text, null::text;
    return;
  end if;

  if v_art.shared_at is not null then
    return query select 'ALREADY_SHARED'::text, v_art.public_token;
    return;
  end if;

  if v_art.integrity_status = 'blocked' then
    return query select 'BLOCKED'::text, null::text;
    return;
  end if;

  if exists (
    select 1 from public.pilot_report_artifacts pra
     where pra.pilot_id = p_pilot_id and pra.revision > v_art.revision) then
    return query select 'NOT_LATEST'::text, null::text;
    return;
  end if;

  -- D-057 begin: suggested actions. The revision's listed action versions
  -- (none when the manifest has no list) must still be exactly the pilot's
  -- reviewed, current actions: each its action's latest version, reviewed,
  -- not withdrawn, and none missing. An action withdrawn, edited or reviewed
  -- after the build makes the revision stale, so a withdrawn or superseded
  -- action never reaches the customer. The pilot row is held for share above,
  -- and a review, withdrawal or action save takes it for update, so none can
  -- change the actions while this runs.
  if exists (
       select 1
         from jsonb_array_elements_text(coalesce(v_art.manifest -> 'actionVersions', '[]'::jsonb)) e(version_id)
         left join public.pilot_action_versions pav
           on pav.id = e.version_id::uuid and pav.pilot_id = p_pilot_id
        where pav.id is null
           or pav.version_number <> (
                select max(pav2.version_number) from public.pilot_action_versions pav2 where pav2.action_id = pav.action_id)
           or not exists (
                select 1 from public.pilot_action_events ev where ev.action_version_id = pav.id and ev.event = 'reviewed')
           or exists (
                select 1 from public.pilot_action_events ev where ev.action_id = pav.action_id and ev.event = 'withdrawn'))
     or exists (
       select 1
         from public.pilot_action_versions pav
        where pav.pilot_id = p_pilot_id
          and pav.version_number = (
                select max(pav2.version_number) from public.pilot_action_versions pav2 where pav2.action_id = pav.action_id)
          and exists (
                select 1 from public.pilot_action_events ev where ev.action_version_id = pav.id and ev.event = 'reviewed')
          and not exists (
                select 1 from public.pilot_action_events ev where ev.action_id = pav.action_id and ev.event = 'withdrawn')
          and not exists (
                select 1 from jsonb_array_elements_text(coalesce(v_art.manifest -> 'actionVersions', '[]'::jsonb)) e(version_id)
                 where e.version_id::uuid = pav.id)) then
    return query select 'ACTIONS_STALE'::text, null::text;
    return;
  end if;
  -- D-057 end

  -- D-062 begin: pilot retests (20261109190000). Nothing of a retest may be
  -- running or about to start (S7), and the revision must still describe the
  -- pilot's retests as they are: the groups with their state and members,
  -- their notes, every retest slot's job (a review resolution made after the
  -- build changes answers without adding one) and every retest attempt. A
  -- missing manifest key is an empty list, so a revision built before D-062
  -- is stale only once a group exists. The pilot row is held for share
  -- above, and every group step and note takes it for update. (engineer)
  -- The cards are also still exactly the final retests (M1, as the save
  -- checks it): finality depends on the pilot's status, today's date and the
  -- question's retirement, which can change after the save without any row
  -- the checks above compare, so a retest that was retryable at the save and
  -- is final now makes the revision stale.
  declare
    v_m_cards    jsonb := case when jsonb_typeof(v_art.manifest -> 'retestCards') = 'array'
                               then v_art.manifest -> 'retestCards' else '[]'::jsonb end;
    v_m_retests  jsonb := case when jsonb_typeof(v_art.manifest -> 'retests') = 'array'
                               then v_art.manifest -> 'retests' else '[]'::jsonb end;
    v_m_notes    jsonb := case when jsonb_typeof(v_art.manifest -> 'retestNotes') = 'array'
                               then v_art.manifest -> 'retestNotes' else '[]'::jsonb end;
    v_m_jobs     jsonb := case when jsonb_typeof(v_art.manifest -> 'retestJobs') = 'array'
                               then v_art.manifest -> 'retestJobs' else '[]'::jsonb end;
    v_m_attempts jsonb := case when jsonb_typeof(v_art.manifest -> 'attempts') = 'array'
                               then v_art.manifest -> 'attempts' else '[]'::jsonb end;
  begin
    if exists (
      select 1
        from public.pilot_question_protocols s
        join public.pilot_questions pq on pq.id = s.pilot_question_id
        left join public.protocol_execution_jobs j on j.protocol_id = s.protocol_id
       where pq.pilot_id = p_pilot_id
         and s.phase = 'retest'
         and (
           (j.status in ('claimed', 'running') and j.lease_expires_at > now())
           or exists (
             select 1
               from public.protocol_job_run_requests r
              where r.job_id = j.id
                and r.status = 'pending'
                and r.expires_at > now())
           or exists (
             select 1
               from public.protocol_attempts a
              where a.protocol_id = s.protocol_id
                and a.status in ('reserved', 'in_progress'))
         )
    ) then
      return query select 'RETEST_IN_PROGRESS'::text, null::text;
      return;
    end if;

    if array(
         select r.id::text || '|'
                || case when r.abandoned_at is not null then 'abandoned'
                        when r.retests_prepared_at is not null then 'prepared'
                        when r.implemented_at is not null then 'implemented'
                        else 'registered' end
                || '|' || coalesce((
                     select string_agg(m.id::text, ',' order by m.id::text)
                       from public.pilot_retest_members m
                      where m.pilot_retest_id = r.id), '')
           from public.pilot_retests r
          where r.pilot_id = p_pilot_id
          order by 1)
       is distinct from array(
         select (e ->> 'id') || '|' || (e ->> 'state') || '|'
                || coalesce((
                     select string_agg(x #>> '{}', ',' order by x #>> '{}')
                       from jsonb_array_elements(case when jsonb_typeof(e -> 'memberIds') = 'array' then e -> 'memberIds' else '[]'::jsonb end) x), '')
           from jsonb_array_elements(v_m_retests) e
          order by 1)
       or array(
         select n.id::text
           from public.pilot_retest_notes n
          where n.pilot_id = p_pilot_id
          order by 1)
          is distinct from array(
         select e #>> '{}'
           from jsonb_array_elements(v_m_notes) e
          order by 1)
       or array(
         select j.id::text || '|' || j.protocol_id::text || '|' || j.status || '|' || coalesce(j.review_resolution, '-')
           from public.pilot_question_protocols s
           join public.pilot_questions pq on pq.id = s.pilot_question_id
           join public.protocol_execution_jobs j on j.protocol_id = s.protocol_id
          where pq.pilot_id = p_pilot_id
            and s.phase = 'retest'
          order by 1)
          is distinct from array(
         select (e ->> 'jobId') || '|' || (e ->> 'protocolId') || '|' || (e ->> 'status') || '|' || coalesce(e ->> 'reviewResolution', '-')
           from jsonb_array_elements(v_m_jobs) e
          order by 1)
       or exists (
         select 1
           from public.pilot_question_protocols s
           join public.pilot_questions pq on pq.id = s.pilot_question_id
           join public.protocol_attempts a on a.protocol_id = s.protocol_id
          where pq.pilot_id = p_pilot_id
            and s.phase = 'retest'
            and not exists (
              select 1 from jsonb_array_elements(v_m_attempts) e where (e ->> 'id') = a.id::text))
       or array(
         select coalesce(c ->> 'memberId', '-') from jsonb_array_elements(v_m_cards) c order by 1)
          is distinct from array(
         select m.id::text
           from public.pilot_retest_members m
           join public.pilot_retests r on r.id = m.pilot_retest_id
           join public.pilot_question_protocols s on s.pilot_retest_member_id = m.id
           join public.protocol_execution_jobs j on j.protocol_id = s.protocol_id
          where m.pilot_id = p_pilot_id
            and r.abandoned_at is null
            and exists (select 1 from public.protocol_attempts a where a.protocol_id = s.protocol_id)
            and public.pilot_retest_job_is_final(j.id) is true
          order by 1) then
      return query select 'RETESTS_STALE'::text, null::text;
      return;
    end if;
  end;
  -- D-062 end

  if v_art.integrity_status = 'needs_review' and not p_acknowledge_needs_review then
    return query select 'ACKNOWLEDGEMENT_REQUIRED'::text, null::text;
    return;
  end if;

  update public.pilot_report_artifacts pra
     set reviewed_by = p_shared_by,
         reviewed_at = now(),
         shared_at = now(),
         needs_review_acknowledged = (v_art.integrity_status = 'needs_review')
   where pra.id = v_art.id;

  return query select 'SHARED'::text, v_art.public_token;
end;
$$;

revoke all on function public.share_pilot_report_artifact(uuid, uuid, uuid, boolean) from public;
revoke all on function public.share_pilot_report_artifact(uuid, uuid, uuid, boolean) from anon;
revoke all on function public.share_pilot_report_artifact(uuid, uuid, uuid, boolean) from authenticated;
grant execute on function public.share_pilot_report_artifact(uuid, uuid, uuid, boolean) to service_role;

-- =======================================================================
-- 6. Postconditions
-- =======================================================================

do $$
declare
  v_def  text;
  v_name text;
  v_fn   text;
  v_t    record;
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.pilot_question_protocols'::regclass
     and c.conname = 'pilot_question_protocols_phase_check';
  if v_def is distinct from $d$CHECK ((phase = ANY (ARRAY['baseline'::text, 'retest'::text])))$d$ then
    raise exception using errcode = 'P0001', message = format('20261109190000 postcondition: pilot_question_protocols_phase_check is %s', coalesce(v_def, 'missing'));
  end if;

  foreach v_name in array array[
    'pilot_question_protocols_slot_protocol_key', 'pilot_question_protocols_retest_member_fk',
    'pilot_question_protocols_retest_member_check', 'pilot_question_protocols_member_key'
  ] loop
    if not exists (
      select 1 from pg_constraint c
       where c.conrelid = 'public.pilot_question_protocols'::regclass and c.conname = v_name
    ) then
      raise exception using errcode = 'P0001', message = format('20261109190000 postcondition: constraint %s is missing', v_name);
    end if;
  end loop;

  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.pilot_retest_members'::regclass and c.conname = 'pilot_retest_members_baseline_slot_fk'
  ) then
    raise exception using errcode = 'P0001', message = '20261109190000 postcondition: the members'' baseline slot foreign key is missing';
  end if;

  foreach v_name in array array[
    'public.pilot_retests', 'public.pilot_retest_members', 'public.pilot_retest_notes', 'public.pilot_retest_steps'
  ] loop
    if not (select c.relrowsecurity from pg_class c where c.oid = v_name::regclass)
       or not has_table_privilege('service_role', v_name, 'select')
       or has_table_privilege('service_role', v_name, 'insert')
       or has_table_privilege('service_role', v_name, 'update')
       or has_table_privilege('service_role', v_name, 'delete')
       or has_table_privilege('anon', v_name, 'select')
       or has_table_privilege('authenticated', v_name, 'select') then
      raise exception using errcode = 'P0001', message = format('20261109190000 postcondition: %s is not RLS-on and read-only to service_role', v_name);
    end if;
  end loop;

  -- The six group steps, and save and share: SECURITY DEFINER, the pinned
  -- search_path, executable by service_role only.
  foreach v_fn in array array[
    'public.register_pilot_retest(uuid,uuid,uuid[],text,text,text,text,text,text,text,text,text,text,boolean,text,integer,text,date,uuid[],boolean,uuid)',
    'public.confirm_pilot_retest_implementation(uuid,uuid,uuid,date,text,text,text,boolean,text,boolean)',
    'public.prepare_pilot_retests(uuid,uuid,uuid)',
    'public.abandon_pilot_retest(uuid,uuid,uuid,text,boolean)',
    'public.requeue_pilot_retest_job(uuid,uuid,uuid,text,uuid,text)',
    'public.add_pilot_retest_note(uuid,uuid,uuid,date,text,text,uuid,uuid)',
    'public.save_pilot_report_artifact(uuid,uuid,text,jsonb,jsonb,text,jsonb,timestamptz)',
    'public.share_pilot_report_artifact(uuid,uuid,uuid,boolean)'
  ] loop
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('authenticated', v_fn, 'execute')
       or not has_function_privilege('service_role', v_fn, 'execute')
       or not (select p.prosecdef and p.proconfig = array['search_path=public, pg_temp']
                 from pg_proc p where p.oid = v_fn::regprocedure) then
      raise exception using errcode = 'P0001', message = format('20261109190000 postcondition: %s is not SECURITY DEFINER, pinned, for service_role only', v_fn);
    end if;
  end loop;

  -- The helper and the six trigger functions: executable by no client role.
  foreach v_fn in array array[
    'public.pilot_retest_job_is_final(uuid)',
    'public.pilot_retests_guard()',
    'public.pilot_retest_rows_append_only()',
    'public.pilot_retest_slot_check()',
    'public.pilot_retest_intervention_guard()',
    'public.pilot_retest_protocol_guard()',
    'public.pilot_retest_card_guard()'
  ] loop
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('authenticated', v_fn, 'execute')
       or has_function_privilege('service_role', v_fn, 'execute')
       or not (select p.prosecdef and p.proconfig = array['search_path=public, pg_temp']
                 from pg_proc p where p.oid = v_fn::regprocedure) then
      raise exception using errcode = 'P0001', message = format('20261109190000 postcondition: %s is executable by a client role or not SECURITY DEFINER and pinned', v_fn);
    end if;
  end loop;

  -- The eight triggers: present, enabled, of the right kind. tgtype: ROW 1,
  -- BEFORE 2, INSERT 4, DELETE 8, UPDATE 16.
  for v_t in
    select *
      from (values
        ('public.pilot_retests', 'pilot_retests_guard', 'public.pilot_retests_guard()', 27),
        ('public.pilot_retest_members', 'pilot_retest_members_append_only', 'public.pilot_retest_rows_append_only()', 27),
        ('public.pilot_retest_notes', 'pilot_retest_notes_append_only', 'public.pilot_retest_rows_append_only()', 27),
        ('public.pilot_retest_steps', 'pilot_retest_steps_append_only', 'public.pilot_retest_rows_append_only()', 27),
        ('public.pilot_question_protocols', 'pilot_question_protocols_retest_slot', 'public.pilot_retest_slot_check()', 7),
        ('public.interventions', 'interventions_pilot_retest_guard', 'public.pilot_retest_intervention_guard()', 23),
        ('public.protocols', 'protocols_pilot_retest_guard', 'public.pilot_retest_protocol_guard()', 7),
        ('public.outcome_card_artifacts', 'outcome_card_artifacts_pilot_retest_guard', 'public.pilot_retest_card_guard()', 23)
      ) as x(rel, name, fn, kind)
  loop
    if not exists (
      select 1
        from pg_trigger tg
       where tg.tgrelid = v_t.rel::regclass
         and tg.tgname = v_t.name
         and tg.tgfoid = v_t.fn::regprocedure
         and tg.tgenabled = 'O'
         and not tg.tgisinternal
         and tg.tgtype = v_t.kind
    ) then
      raise exception using errcode = 'P0001', message = format('20261109190000 postcondition: trigger %s is missing, disabled or of the wrong kind', v_t.name);
    end if;
  end loop;

  -- save and share are no longer 20261109160000's.
  if (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p
       where p.oid = 'public.save_pilot_report_artifact(uuid,uuid,text,jsonb,jsonb,text,jsonb,timestamptz)'::regprocedure)
     = 'e66f4dd316ff2f2cb250442b5fc119f2'
     or (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p
          where p.oid = 'public.share_pilot_report_artifact(uuid,uuid,uuid,boolean)'::regprocedure)
     = 'dc8b5f430f0d4ebd630e6793e64e669e' then
    raise exception using errcode = 'P0001', message = '20261109190000 postcondition: save or share was not redefined';
  end if;
end $$;
