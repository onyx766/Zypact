-- M4 — Question, protocole, échantillonnage, contrôle des appels payants.
-- DRAFT migration. Not applied to any database by this commit.
--
-- Scope, in dependency order:
--   1. buyer_questions — stable per-project question identity.
--   2. buyer_question_versions — immutable versions (D-014-style
--      append-only ledger, same shape as entity_observations): a text
--      change is always a new row, never an UPDATE of prompt_text.
--      Approval (approved_by/approved_at) is RPC-only — direct INSERT
--      is granted (creating a new, unapproved version is a simple,
--      non-concurrency-sensitive operation), but UPDATE is revoked
--      entirely from service_role, exactly like probe_results has had
--      since migration 0036: the approval RPC is the only path that can
--      ever set those two columns.
--   3. protocols — one protocol per approved buyer_question_version
--      (product rule: 1:1, enforced by a partial unique index on
--      buyer_question_version_id where status in ('approved','active')).
--      A retest protocol references its own baseline via
--      baseline_protocol_id (self-FK). Created in 'draft' by direct
--      INSERT; every other status transition is RPC-only.
--   4. protocol_attempts — the admission/reservation/reconciliation
--      ledger, one row per paid-call attempt. RPC-only in every
--      direction (no direct INSERT/UPDATE grant at all), exactly like
--      entity_observations/entity_aliases (D-017) — five RPCs are the
--      only writers.
--   5. Five SECURITY DEFINER RPCs: approve_buyer_question_version,
--      approve_protocol, admit_and_reserve_attempt, start_attempt,
--      reconcile_attempt.
--
-- Non-negotiable rules this schema encodes structurally, not just by
-- convention:
--   - Rule 3 (planned = planned_baseline_runs + planned_retest_runs)
--     and rule 4 (run_cap is only an upper bound, never the planned
--     count): protocols_planned_le_run_cap CHECK enforces
--     run_cap >= planned_baseline_runs + planned_retest_runs — the two
--     can never be conflated, and the cap can never be smaller than
--     the plan it is supposed to bound.
--   - Rule 8 (no attempt without an approved question/protocol):
--     admit_and_reserve_attempt locks the protocol row and refuses
--     (PROTOCOL_NOT_APPROVED) unless status in ('approved','active').
--   - Rule 9 (admission+reservation atomic, FOR UPDATE): the entire
--     admit_and_reserve_attempt body — every cap check and the final
--     INSERT — runs inside one PL/pgSQL function call, one implicit
--     transaction, after locking the protocol row FOR UPDATE first.
--   - Rule 10 (reservation exists before probe_runs/provider call):
--     protocol_attempts.probe_run_id is nullable and only ever set by
--     start_attempt, called strictly after admit_and_reserve_attempt
--     already produced a 'reserved' row — the schema cannot represent
--     an attempt whose probe_run_id was set before it was reserved.
--   - Rule 11 (duplicate idempotency key returns the existing attempt):
--     admit_and_reserve_attempt checks (protocol_id, idempotency_key)
--     for ANY existing row (any status) before ever inserting, and
--     returns ALREADY_RESERVED with that row instead.
--   - Rule 12 (a retry is a new attempt linked by retry_of_attempt_id):
--     protocol_attempts.retry_of_attempt_id is a nullable self-FK;
--     admit_and_reserve_attempt bounds the chain length by
--     protocol.retry_cap.
--   - Rule 13 (real cost always reconciled; cap exceeded blocks the
--     next call; explicit termination reason kept): reconcile_attempt
--     is the only path to a terminal status and always requires
--     actual_cost_usd; admit_and_reserve_attempt's spend-cap check
--     sums actual_cost_usd (falling back to reserved_cost_usd for
--     still-open attempts) against protocol.spend_cap_usd on every
--     call, so an already-exceeded cap blocks every subsequent
--     admission; termination_reason is a required-in-practice free
--     text column the caller populates on every reconciliation.
--   - Rule 14 (SECURITY DEFINER, search_path pinned, service_role-only
--     EXECUTE): all five functions below.
--   - Rule 15 (project/tenant scoping never trusts a bare payload
--     value): every table's FKs are composite, pinning project_id
--     transitively through buyer_question_id -> buyer_questions,
--     buyer_question_version_id -> buyer_question_versions,
--     protocol_id -> protocols — the same composite-FK pattern already
--     established by migrations 0041/0045. Every RPC re-derives
--     protocol_id/buyer_question_version_id from the locked row it
--     reads, never from a second, independently-supplied parameter.
--
-- What this migration does NOT do:
--   * Does not touch entity_observations, entity_aliases,
--     canonical_entities, or any M1/M2 RPC (migrations 0001-0046).
--   * Does not touch the M3 integrity gate
--     (lib/export/report-integrity.ts is application code, not schema;
--     nothing here references it).
--   * Does not backfill generated_prompts, probe_runs, or probe_results.
--     protocol_attempts.probe_run_id is nullable and never populated
--     for historical rows.
--   * Does not change WORKER_PROMPTS/WORKER_RUNS/WORKER_BUDGET_USD or
--     mvp-scan.ts's DEFAULT_PROMPTS/DEFAULT_RUNS/DEFAULT_BUDGET_USD —
--     wiring those call sites to consume an approved protocol is a
--     separate, later, explicitly-authorized step (M4 code change, not
--     this migration).
--   * Does not apply to, or connect to, any staging or production
--     database — this file is created locally only.

-- ---------------------------------------------------------------------
-- 1. buyer_questions
-- ---------------------------------------------------------------------

create table if not exists public.buyer_questions (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  created_at  timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'buyer_questions_id_project_key'
  ) then
    alter table public.buyer_questions
      add constraint buyer_questions_id_project_key unique (id, project_id);
  end if;
end $$;

create index if not exists buyer_questions_project_idx
  on public.buyer_questions (project_id);

alter table public.buyer_questions enable row level security;
alter table public.buyer_questions no force row level security;

revoke all on table public.buyer_questions from public, anon, authenticated, service_role;
grant select, insert on table public.buyer_questions to service_role;

-- ---------------------------------------------------------------------
-- 2. buyer_question_versions — append-only; approval is RPC-only.
-- ---------------------------------------------------------------------

create table if not exists public.buyer_question_versions (
  id                 uuid primary key default gen_random_uuid(),
  buyer_question_id  uuid not null references public.buyer_questions (id) on delete restrict,
  project_id         uuid not null references public.projects (id) on delete cascade,
  version_number     integer not null check (version_number >= 1),
  prompt_text        text not null check (btrim(prompt_text) <> ''),
  -- SHA-256 of the normalized prompt text, computed exclusively by the
  -- TypeScript application layer (same authority pattern as D-019 for
  -- entity normalization) — never recomputed or verified in SQL.
  prompt_hash        text not null check (btrim(prompt_hash) <> ''),
  intent_type        text not null,
  commercial_value   integer not null,
  winnability        integer not null,
  priority           integer not null,
  rationale          text not null,
  provenance         text not null
                     check (provenance in (
                       'customer_supplied', 'crm_evidence', 'founder_supplied',
                       'model_assisted_reviewed', 'public_benchmark'
                     )),
  approved_by        uuid null,
  approved_at        timestamptz null,
  created_at         timestamptz not null default now(),

  constraint buyer_question_versions_approval_pair_check check (
    (approved_by is null and approved_at is null)
    or (approved_by is not null and approved_at is not null)
  )
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'buyer_question_versions_id_project_key'
  ) then
    alter table public.buyer_question_versions
      add constraint buyer_question_versions_id_project_key unique (id, project_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'buyer_question_versions_question_project_fk'
  ) then
    alter table public.buyer_question_versions
      add constraint buyer_question_versions_question_project_fk
      foreign key (buyer_question_id, project_id)
      references public.buyer_questions (id, project_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'buyer_question_versions_number_key'
  ) then
    alter table public.buyer_question_versions
      add constraint buyer_question_versions_number_key
      unique (buyer_question_id, version_number);
  end if;
end $$;

create index if not exists buyer_question_versions_project_idx
  on public.buyer_question_versions (project_id);
create index if not exists buyer_question_versions_question_idx
  on public.buyer_question_versions (buyer_question_id);

alter table public.buyer_question_versions enable row level security;
alter table public.buyer_question_versions no force row level security;

revoke all on table public.buyer_question_versions from public, anon, authenticated, service_role;
grant select, insert on table public.buyer_question_versions to service_role;
-- Approval columns are RPC-only: no UPDATE grant at all, matching the
-- probe_results append-only pattern (migration 0036) and D-015's RPC.

-- ---------------------------------------------------------------------
-- 3. protocols — one per approved version; status transitions RPC-only.
-- ---------------------------------------------------------------------

create table if not exists public.protocols (
  id                           uuid primary key default gen_random_uuid(),
  project_id                   uuid not null references public.projects (id) on delete cascade,
  buyer_question_version_id    uuid not null references public.buyer_question_versions (id) on delete restrict,
  baseline_protocol_id         uuid null references public.protocols (id) on delete restrict,
  provider                     text not null,
  surface                      text not null,
  model_config                 jsonb not null default '{}'::jsonb,
  planned_baseline_runs        integer not null check (planned_baseline_runs >= 0),
  planned_retest_runs          integer not null check (planned_retest_runs >= 0),
  -- Rule 2: a paraphrase is an explicit, declared variant with its own
  -- exact text and hash — never a silent rewording. Each element:
  -- {"text": "...", "hash": "sha256..."}. If a paraphrase changes the
  -- question's meaning, the product rule is that it becomes a new
  -- buyer_question_versions row instead — enforced by process/review,
  -- not by a SQL constraint (meaning is not mechanically checkable).
  paraphrase_plan               jsonb not null default '[]'::jsonb,
  unit_of_analysis              text not null,
  primary_metric                text not null,
  minimum_useful_change         jsonb null,
  sample_planning_method        text not null,
  sample_planning_assumptions   jsonb not null default '{}'::jsonb,
  -- Rule 4: run_cap is only ever an upper bound — see the CHECK below,
  -- which forbids it from ever being smaller than the plan.
  run_cap                       integer not null check (run_cap >= 0),
  spend_cap_usd                 numeric not null check (spend_cap_usd >= 0),
  time_window_seconds           integer not null check (time_window_seconds > 0),
  rate_limit_per_hour           integer not null check (rate_limit_per_hour > 0),
  concurrency_limit             integer not null check (concurrency_limit > 0),
  retry_cap                     integer not null check (retry_cap >= 0),
  observation_window_rule       jsonb not null default '{}'::jsonb,
  analyzer_version              integer not null default 1,
  entity_resolution_version     integer not null default 2,
  methodology_version           text not null default '1.1',
  status                        text not null default 'draft'
                                 check (status in ('draft', 'approved', 'active', 'completed', 'abandoned')),
  approved_by                   uuid null,
  approved_at                   timestamptz null,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),

  constraint protocols_approval_pair_check check (
    (status = 'draft' and approved_by is null and approved_at is null)
    or
    (status in ('approved', 'active', 'completed') and approved_by is not null and approved_at is not null)
    or
    (status = 'abandoned')
  ),
  constraint protocols_planned_le_run_cap check (
    run_cap >= planned_baseline_runs + planned_retest_runs
  )
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocols_id_project_key'
  ) then
    alter table public.protocols
      add constraint protocols_id_project_key unique (id, project_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocols_version_project_fk'
  ) then
    alter table public.protocols
      add constraint protocols_version_project_fk
      foreign key (buyer_question_version_id, project_id)
      references public.buyer_question_versions (id, project_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocols_baseline_project_fk'
  ) then
    alter table public.protocols
      add constraint protocols_baseline_project_fk
      foreign key (baseline_protocol_id, project_id)
      references public.protocols (id, project_id);
  end if;
end $$;

-- Product rule: a question/version maps to exactly one live protocol.
create unique index if not exists protocols_one_active_per_version
  on public.protocols (buyer_question_version_id)
  where status in ('approved', 'active');

create index if not exists protocols_project_idx on public.protocols (project_id);

alter table public.protocols enable row level security;
alter table public.protocols no force row level security;

revoke all on table public.protocols from public, anon, authenticated, service_role;
grant select, insert on table public.protocols to service_role;
-- status/approval transitions are RPC-only: no UPDATE grant at all.

-- ---------------------------------------------------------------------
-- 4. protocol_attempts — RPC-only in every direction.
-- ---------------------------------------------------------------------

create table if not exists public.protocol_attempts (
  id                          uuid primary key default gen_random_uuid(),
  project_id                  uuid not null references public.projects (id) on delete cascade,
  protocol_id                 uuid not null references public.protocols (id) on delete restrict,
  buyer_question_version_id   uuid not null references public.buyer_question_versions (id) on delete restrict,
  attempt_kind                text not null check (attempt_kind in ('baseline', 'retest', 'control', 'paraphrase')),
  status                      text not null
                               check (status in (
                                 'reserved', 'in_progress', 'completed', 'failed',
                                 'timed_out', 'cancelled', 'excluded'
                               )),
  idempotency_key             text not null check (btrim(idempotency_key) <> ''),
  reserved_cost_usd           numeric not null check (reserved_cost_usd >= 0),
  actual_cost_usd             numeric null check (actual_cost_usd is null or actual_cost_usd >= 0),
  probe_run_id                uuid null references public.probe_runs (id) on delete restrict,
  retry_of_attempt_id         uuid null references public.protocol_attempts (id) on delete restrict,
  termination_reason          text null,
  reserved_at                  timestamptz not null default now(),
  last_activity_at             timestamptz not null default now(),
  terminalized_at              timestamptz null,
  created_at                   timestamptz not null default now(),

  constraint protocol_attempts_terminal_pair_check check (
    (status in ('reserved', 'in_progress') and terminalized_at is null and actual_cost_usd is null)
    or
    (status in ('completed', 'failed', 'timed_out', 'cancelled', 'excluded') and terminalized_at is not null)
  ),
  constraint protocol_attempts_activity_check check (last_activity_at >= reserved_at)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_attempts_id_project_key'
  ) then
    alter table public.protocol_attempts
      add constraint protocol_attempts_id_project_key unique (id, project_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_attempts_protocol_project_fk'
  ) then
    alter table public.protocol_attempts
      add constraint protocol_attempts_protocol_project_fk
      foreign key (protocol_id, project_id)
      references public.protocols (id, project_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'protocol_attempts_version_project_fk'
  ) then
    alter table public.protocol_attempts
      add constraint protocol_attempts_version_project_fk
      foreign key (buyer_question_version_id, project_id)
      references public.buyer_question_versions (id, project_id);
  end if;
end $$;

-- Rule 11: at most one non-terminal attempt per (protocol_id,
-- idempotency_key). A terminal duplicate is still found and returned
-- by admit_and_reserve_attempt's own SELECT before this index would
-- ever matter — this index protects the concurrent-reservation case.
create unique index if not exists protocol_attempts_active_idempotency_key
  on public.protocol_attempts (protocol_id, idempotency_key)
  where status in ('reserved', 'in_progress');

create index if not exists protocol_attempts_protocol_idx
  on public.protocol_attempts (protocol_id);
create index if not exists protocol_attempts_project_idx
  on public.protocol_attempts (project_id);

alter table public.protocol_attempts enable row level security;
alter table public.protocol_attempts no force row level security;

revoke all on table public.protocol_attempts from public, anon, authenticated, service_role;
grant select on table public.protocol_attempts to service_role;
-- RPC-only writer, exactly like entity_observations/entity_aliases (D-017).

-- ---------------------------------------------------------------------
-- 5. RPCs
-- ---------------------------------------------------------------------

create or replace function
  public.approve_buyer_question_version(
    p_version_id uuid,
    p_project_id uuid,
    p_approved_by uuid
  )
returns table (
  status  text,
  version public.buyer_question_versions
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_row public.buyer_question_versions%rowtype;
begin
  if p_version_id is null or p_project_id is null or p_approved_by is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_approve_buyer_question_version_args';
  end if;

  select bqv.* into v_row
    from public.buyer_question_versions bqv
   where bqv.id = p_version_id and bqv.project_id = p_project_id
   for update;

  if not found then
    return query select 'NOT_FOUND'::text, null::public.buyer_question_versions;
    return;
  end if;

  if v_row.approved_at is not null then
    return query select 'ALREADY_APPROVED'::text, v_row;
    return;
  end if;

  update public.buyer_question_versions
     set approved_by = p_approved_by,
         approved_at = now()
   where id = p_version_id
     and project_id = p_project_id
     and approved_at is null
  returning * into v_row;

  return query select 'APPROVED'::text, v_row;
end;
$$;

revoke all on function
  public.approve_buyer_question_version(uuid, uuid, uuid) from public;
revoke all on function
  public.approve_buyer_question_version(uuid, uuid, uuid) from anon;
revoke all on function
  public.approve_buyer_question_version(uuid, uuid, uuid) from authenticated;
grant execute on function
  public.approve_buyer_question_version(uuid, uuid, uuid) to service_role;


create or replace function
  public.approve_protocol(
    p_protocol_id uuid,
    p_project_id uuid,
    p_approved_by uuid
  )
returns table (
  status   text,
  protocol public.protocols
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_row public.protocols%rowtype;
  v_version public.buyer_question_versions%rowtype;
begin
  if p_protocol_id is null or p_project_id is null or p_approved_by is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_approve_protocol_args';
  end if;

  select p.* into v_row
    from public.protocols p
   where p.id = p_protocol_id and p.project_id = p_project_id
   for update;

  if not found then
    return query select 'NOT_FOUND'::text, null::public.protocols;
    return;
  end if;

  if v_row.status in ('approved', 'active', 'completed') then
    return query select 'ALREADY_APPROVED'::text, v_row;
    return;
  end if;

  if v_row.status = 'abandoned' then
    return query select 'CONFLICT'::text, v_row;
    return;
  end if;

  select bqv.* into v_version
    from public.buyer_question_versions bqv
   where bqv.id = v_row.buyer_question_version_id
     and bqv.project_id = p_project_id;

  if v_version.approved_at is null then
    return query select 'VERSION_NOT_APPROVED'::text, v_row;
    return;
  end if;

  update public.protocols
     set status = 'approved',
         approved_by = p_approved_by,
         approved_at = now(),
         updated_at = now()
   where id = p_protocol_id
     and project_id = p_project_id
     and status = 'draft'
  returning * into v_row;

  return query select 'APPROVED'::text, v_row;
end;
$$;

revoke all on function
  public.approve_protocol(uuid, uuid, uuid) from public;
revoke all on function
  public.approve_protocol(uuid, uuid, uuid) from anon;
revoke all on function
  public.approve_protocol(uuid, uuid, uuid) from authenticated;
grant execute on function
  public.approve_protocol(uuid, uuid, uuid) to service_role;


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
      message = 'invalid_admit_and_reserve_attempt_args';
  end if;

  if p_attempt_kind not in ('baseline', 'retest', 'control', 'paraphrase') then
    raise exception using errcode = '22023', message = 'invalid_attempt_kind';
  end if;

  -- Rule 9: lock the protocol row first. Every cap check below reads a
  -- consistent snapshot under this lock, and the final INSERT happens
  -- inside this same function call — one transaction, no gap a
  -- concurrent admit call for the same protocol could race into.
  select p.* into v_protocol
    from public.protocols p
   where p.id = p_protocol_id and p.project_id = p_project_id
   for update;

  if not found then
    return query select 'NOT_FOUND'::text, null::public.protocol_attempts;
    return;
  end if;

  -- Rule 8: no attempt without an approved protocol.
  if v_protocol.status not in ('approved', 'active') then
    return query select 'PROTOCOL_NOT_APPROVED'::text, null::public.protocol_attempts;
    return;
  end if;

  -- Rule 11: a duplicate idempotency key returns the existing attempt —
  -- any status, never a second reservation.
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

    -- Rule 12: retry_cap bounds the TOTAL length of the retry chain from
    -- its original (non-retry) attempt, not merely how many times the
    -- immediate target has been retried directly. A chain of distinct
    -- retry-of-retry-of-retry links must still be bounded, so walk from
    -- the target up to the chain's root via retry_of_attempt_id,
    -- counting hops: the root itself is retry number 0, and each hop is
    -- one more retry already consumed. The new attempt being admitted
    -- would be retry number (depth + 1); recursion is capped at
    -- retry_cap + 1 hops since a deeper true depth changes nothing about
    -- the reject decision.
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

  -- Rule 13: an already-exceeded spend cap blocks the next admission —
  -- checked on every call, using actual cost where known, reserved
  -- (estimated) cost for still-open attempts.
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
    reserved_at, last_activity_at
  ) values (
    p_project_id, p_protocol_id, v_protocol.buyer_question_version_id, p_attempt_kind,
    'reserved', p_idempotency_key, p_estimated_cost_usd, p_retry_of_attempt_id,
    now(), now()
  )
  returning * into v_new;

  return query select 'RESERVED'::text, v_new;
end;
$$;

revoke all on function
  public.admit_and_reserve_attempt(uuid, uuid, text, text, numeric, uuid) from public;
revoke all on function
  public.admit_and_reserve_attempt(uuid, uuid, text, text, numeric, uuid) from anon;
revoke all on function
  public.admit_and_reserve_attempt(uuid, uuid, text, text, numeric, uuid) from authenticated;
grant execute on function
  public.admit_and_reserve_attempt(uuid, uuid, text, text, numeric, uuid) to service_role;


create or replace function
  public.start_attempt(
    p_attempt_id uuid,
    p_project_id uuid,
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
  v_row public.protocol_attempts%rowtype;
begin
  if p_attempt_id is null or p_project_id is null or p_probe_run_id is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_start_attempt_args';
  end if;

  select pa.* into v_row
    from public.protocol_attempts pa
   where pa.id = p_attempt_id and pa.project_id = p_project_id
   for update;

  if not found then
    return query select 'NOT_FOUND'::text, null::public.protocol_attempts;
    return;
  end if;

  if v_row.status = 'in_progress' and v_row.probe_run_id = p_probe_run_id then
    return query select 'ALREADY_STARTED'::text, v_row;
    return;
  end if;

  if v_row.status <> 'reserved' then
    return query select 'CONFLICT'::text, v_row;
    return;
  end if;

  update public.protocol_attempts
     set status = 'in_progress',
         probe_run_id = p_probe_run_id,
         last_activity_at = now()
   where id = p_attempt_id
     and project_id = p_project_id
     and status = 'reserved'
  returning * into v_row;

  return query select 'STARTED'::text, v_row;
end;
$$;

revoke all on function
  public.start_attempt(uuid, uuid, uuid) from public;
revoke all on function
  public.start_attempt(uuid, uuid, uuid) from anon;
revoke all on function
  public.start_attempt(uuid, uuid, uuid) from authenticated;
grant execute on function
  public.start_attempt(uuid, uuid, uuid) to service_role;


create or replace function
  public.reconcile_attempt(
    p_attempt_id uuid,
    p_project_id uuid,
    p_status text,
    p_actual_cost_usd numeric,
    p_probe_run_id uuid default null,
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
  v_row public.protocol_attempts%rowtype;
begin
  if p_attempt_id is null or p_project_id is null or p_status is null
     or p_actual_cost_usd is null or p_actual_cost_usd < 0 then
    raise exception using
      errcode = '22023',
      message = 'invalid_reconcile_attempt_args';
  end if;

  if p_status not in ('completed', 'failed', 'timed_out', 'cancelled', 'excluded') then
    return query select 'INVALID_STATUS'::text, null::public.protocol_attempts;
    return;
  end if;

  select pa.* into v_row
    from public.protocol_attempts pa
   where pa.id = p_attempt_id and pa.project_id = p_project_id
   for update;

  if not found then
    return query select 'NOT_FOUND'::text, null::public.protocol_attempts;
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

  update public.protocol_attempts
     set status = p_status,
         actual_cost_usd = p_actual_cost_usd,
         probe_run_id = coalesce(p_probe_run_id, probe_run_id),
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
  public.reconcile_attempt(uuid, uuid, text, numeric, uuid, text) from public;
revoke all on function
  public.reconcile_attempt(uuid, uuid, text, numeric, uuid, text) from anon;
revoke all on function
  public.reconcile_attempt(uuid, uuid, text, numeric, uuid, text) from authenticated;
grant execute on function
  public.reconcile_attempt(uuid, uuid, text, numeric, uuid, text) to service_role;
