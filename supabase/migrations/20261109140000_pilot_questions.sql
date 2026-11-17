-- Pilot questions (D-053, D-054): one managed pilot holds up to 20 approved
-- buyer questions under ONE project, each measured by its own protocol and
-- job through the same approval, admission and reservation path a
-- founder-created request uses.
--
-- Applies after 20261109130000 (pilot step 1). Numbered 20261118120000
-- until 2026-11-17 (D-058); the SQL is unchanged. Depends only on objects from
-- 0047-0081 and pilot step 1; nothing from the account stack (Q2'-1 to Q4).
--
-- Before this, one snapshot request held one question in its own project,
-- so a 15-question pilot would have been 15 projects and 15 reports. A pilot
-- is anchored on its own record, not on a request: a request's report pass
-- would build and could send a one-question report, and its report would
-- lift the active-domain rule while the pilot is still running (D-054).
--
-- What this adds:
--   1. `pilots`: the customer, the website, how the team confirmed the
--      customer controls it (D-051), the question limit (at most 20), and
--      the 90-day window (D-053).
--   2. `pilot_questions`: each approved question, who wrote it (D-052), the
--      customer's written approval (a reference and a date), and its
--      M4 question version.
--   3. `pilot_question_protocols`: the per-engine slot. Only Perplexity
--      Sonar is allowed until ChatGPT is wired (D-053 item 3).
--   4. `create_pilot`, `add_pilot_question`, `close_pilot` and
--      `retire_pilot_question`. A pilot starts between yesterday and 60
--      days from today. A close is refused while any of the pilot's
--      measurements is running or about to start.
--   5. Three pilot step 1 functions are redefined, each byte for byte
--      apart from its pilot block (scripts/test-pilot-questions.ts):
--        `request_protocol_job_run`: the console start `admin_pilot_run`,
--          and refusals for a job of a pilot that is closed or past its
--          end date (`PILOT_CLOSED`), not yet started
--          (`PILOT_NOT_STARTED`), or whose question is retired
--          (`PILOT_QUESTION_RETIRED`), with the pilot row locked FOR SHARE;
--        `claim_requested_protocol_execution_job`: the same states refuse
--          the claim (`PILOT_CLOSED`), a second barrier;
--        `retry_failed_protocol_job`: the same states refuse the retry
--          (`PILOT_CLOSED`) before anything is reserved.
--      Each covers a pilot's baseline and any retest of that baseline.
--      The requested_via CHECK of `protocol_job_run_requests` gains
--      `admin_pilot_run`, and its refusal_code CHECK gains `PILOT_CLOSED`.
--
-- Not changed: approval (`approve_buyer_question_version`,
-- `approve_protocol`), the queue (`enqueue_protocol_execution_job`),
-- admission, reservation, the report pass and every request function. The
-- older claims, `claim_protocol_execution_job` (0054) and
-- `claim_protocol_execution_job_by_id` (0059), are not changed and do not
-- check pilots; the live runner uses only the requested claim (D-052),
-- and they stay for the M5 test harnesses. A pilot's jobs are never picked up by the report pass,
-- which reads requests only, so nothing about a pilot is reported or sent
-- by this migration.
--
-- No existing row is updated, deleted or backfilled. No attempt, external
-- call, receipt, request body, probe row or report is written here. Every
-- function is SECURITY DEFINER, pins its search_path and is executable by
-- service_role only. The three tables have RLS on with no policy, and
-- service_role may only read them.
--
-- Rollback / forward recovery, in the reverse of the deploy order (the web
-- app, then the database):
--   1. Roll the web app back. The old console never sends admin_pilot_run.
--   2. Restore pilot step 1's three functions and the two CHECKs:
--        re-apply 20261109130000's bodies and grants of
--        request_protocol_job_run, claim_requested_protocol_execution_job
--        and retry_failed_protocol_job, then
--        alter table public.protocol_job_run_requests
--          drop constraint protocol_job_run_requests_requested_via_check;
--        alter table public.protocol_job_run_requests
--          add constraint protocol_job_run_requests_requested_via_check
--          check (requested_via in ('admin_run_pipeline', 'admin_run_retest',
--                                   'admin_founder_baseline', 'operator_cli'));
--        alter table public.protocol_job_run_requests
--          drop constraint protocol_job_run_requests_refusal_code_check;
--        alter table public.protocol_job_run_requests
--          add constraint protocol_job_run_requests_refusal_code_check
--          check (refusal_code in ('JOB_NOT_FOUND', 'JOB_NOT_ELIGIBLE', 'JOB_LOCKED'));
--      An add fails while a row records admin_pilot_run or PILOT_CLOSED;
--      such rows are run-request history and are kept, so in that case
--      leave the wider CHECK in place.
--   3. Drop the rest:
--        drop function if exists public.retire_pilot_question(uuid, uuid, uuid, text);
--        drop function if exists public.close_pilot(uuid, uuid, text);
--        drop function if exists public.add_pilot_question(uuid, uuid, text, text, text, text, date, uuid);
--        drop function if exists public.create_pilot(uuid, text, text, text, text, integer, date, uuid);
--        drop table if exists public.pilot_question_protocols;
--        drop table if exists public.pilot_questions;
--        drop table if exists public.pilots;
--      Dropping the tables loses only the pilot grouping. Every project,
--      question version, protocol, job and attempt a pilot created is an
--      ordinary M4/M5 row and stays.

-- =======================================================================
-- 1. Tables
-- =======================================================================

create table if not exists public.pilots (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references public.projects (id) on delete restrict,
  company_name        text not null
                      check (char_length(company_name) between 2 and 120 and company_name = btrim(company_name)),
  website_url         text not null
                      check (char_length(website_url) between 1 and 2048),
  normalized_domain   text not null
                      check (char_length(normalized_domain) between 3 and 253
                             and normalized_domain = lower(normalized_domain)
                             and normalized_domain ~ '^[a-z0-9.-]+$'),
  -- D-051: how the team confirmed the customer controls the website.
  site_control_note   text not null
                      check (char_length(btrim(site_control_note)) between 10 and 2000),
  -- D-053: 15 questions, 20 at most.
  question_limit      integer not null
                      check (question_limit between 1 and 20),
  -- D-053: 90 days.
  starts_on           date not null,
  ends_on             date not null,
  status              text not null default 'active'
                      check (status in ('active', 'closed')),
  created_by          uuid not null,
  created_at          timestamptz not null default now(),
  idempotency_key     uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),
  closed_by           uuid null,
  closed_at           timestamptz null,
  close_reason        text null,

  constraint pilots_project_key unique (project_id),
  constraint pilots_id_project_key unique (id, project_id),
  constraint pilots_idempotency_key unique (idempotency_key),
  constraint pilots_window_check check (ends_on = starts_on + 90),
  constraint pilots_close_check check (
    (status = 'closed') = (closed_at is not null)
    and (status = 'closed') = (closed_by is not null)
    and (status = 'closed') = (close_reason is not null)
  )
);

-- One open pilot per website, as one live request per website (0081).
create unique index if not exists pilots_one_active_per_domain
  on public.pilots (normalized_domain)
  where status = 'active';

create table if not exists public.pilot_questions (
  id                         uuid primary key default gen_random_uuid(),
  pilot_id                   uuid not null,
  project_id                 uuid not null,
  -- 20 live questions at most, plus at most 5 retired ones (D-054).
  ordinal                    integer not null check (ordinal between 1 and 25),
  buyer_question_version_id  uuid not null,
  prompt_hash                text not null check (prompt_hash ~ '^[0-9a-f]{64}$'),
  -- D-052 item 4: who wrote the question.
  question_provenance        text not null
                             check (question_provenance in ('customer_supplied', 'founder_supplied')),
  -- D-051: the customer's dated, written approval of this question. A
  -- reference to where it is kept (an email subject and date, a document
  -- name), never the message itself.
  customer_approval_ref      text not null
                             check (char_length(btrim(customer_approval_ref)) between 3 and 300),
  customer_approved_on       date not null,
  added_by                   uuid not null,
  added_at                   timestamptz not null default now(),
  idempotency_key            uuid not null,
  request_fingerprint        text not null check (request_fingerprint ~ '^[0-9a-f]{32}$'),
  -- D-054: a question whose measurement can no longer finish is retired,
  -- never deleted. Its rows and evidence stay, it stops counting toward the
  -- limit, and its approved text may be added again. Written only by
  -- retire_pilot_question.
  retired_by                 uuid null,
  retired_at                 timestamptz null,
  retire_reason              text null,

  constraint pilot_questions_retire_check check (
    (retired_at is null) = (retired_by is null)
    and (retired_at is null) = (retire_reason is null)
    and (retire_reason is null or char_length(btrim(retire_reason)) between 10 and 2000)
  ),
  constraint pilot_questions_pilot_project_fk
    foreign key (pilot_id, project_id)
    references public.pilots (id, project_id)
    on delete restrict,
  constraint pilot_questions_version_project_fk
    foreign key (buyer_question_version_id, project_id)
    references public.buyer_question_versions (id, project_id)
    on delete restrict,
  constraint pilot_questions_id_project_key unique (id, project_id),
  constraint pilot_questions_ordinal_key unique (pilot_id, ordinal),
  constraint pilot_questions_version_key unique (buyer_question_version_id),
  constraint pilot_questions_idempotency_key unique (pilot_id, idempotency_key)
);

-- One live question per approved text in a pilot. A retired question does
-- not count, so the same text can be measured again after a retirement.
create unique index if not exists pilot_questions_one_live_prompt
  on public.pilot_questions (pilot_id, prompt_hash)
  where retired_at is null;

create table if not exists public.pilot_question_protocols (
  id                 uuid primary key default gen_random_uuid(),
  pilot_question_id  uuid not null,
  project_id         uuid not null,
  -- D-053 item 3: ChatGPT measures nothing for a pilot until it is
  -- confirmed, approved, wired and deployed. Widening this CHECK belongs to
  -- that pull request.
  engine             text not null check (engine = 'perplexity_sonar'),
  -- The retest slot belongs to the pilot retest step.
  phase              text not null check (phase = 'baseline'),
  protocol_id        uuid not null,
  created_at         timestamptz not null default now(),

  constraint pilot_question_protocols_question_fk
    foreign key (pilot_question_id, project_id)
    references public.pilot_questions (id, project_id)
    on delete restrict,
  constraint pilot_question_protocols_protocol_fk
    foreign key (protocol_id, project_id)
    references public.protocols (id, project_id)
    on delete restrict,
  constraint pilot_question_protocols_slot_key unique (pilot_question_id, engine, phase),
  constraint pilot_question_protocols_protocol_key unique (protocol_id)
);

alter table public.pilots enable row level security;
alter table public.pilots no force row level security;
alter table public.pilot_questions enable row level security;
alter table public.pilot_questions no force row level security;
alter table public.pilot_question_protocols enable row level security;
alter table public.pilot_question_protocols no force row level security;

revoke all on table public.pilots from public, anon, authenticated, service_role;
grant select on table public.pilots to service_role;
revoke all on table public.pilot_questions from public, anon, authenticated, service_role;
grant select on table public.pilot_questions to service_role;
revoke all on table public.pilot_question_protocols from public, anon, authenticated, service_role;
grant select on table public.pilot_question_protocols to service_role;

comment on table public.pilots is
  'D-054: a managed pilot. Written only by create_pilot and close_pilot.';
comment on table public.pilot_questions is
  'D-054: an approved buyer question of a pilot. Written only by add_pilot_question and retire_pilot_question.';
comment on table public.pilot_question_protocols is
  'D-054: the protocol measuring a pilot question on one engine. Written only by add_pilot_question.';

-- =======================================================================
-- 2. Create a pilot
-- =======================================================================

-- The application normalizes the website exactly as a request's
-- (lib/snapshot-requests/normalize-request.ts) before calling. The
-- fingerprint lets a repeated press with the same key replay, and the same
-- key with a different body conflict.
create or replace function public.create_pilot(
    p_created_by uuid,
    p_company_name text,
    p_website_url text,
    p_normalized_domain text,
    p_site_control_note text,
    p_question_limit integer,
    p_starts_on date,
    p_idempotency_key uuid
  )
returns table (
  outcome     text,
  pilot_id    uuid,
  project_id  uuid
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_fingerprint text;
  v_existing public.pilots%rowtype;
  v_project_id uuid;
  v_pilot_id uuid;
begin
  if p_created_by is null or p_idempotency_key is null
     or p_company_name is null or p_company_name <> btrim(p_company_name)
     or char_length(p_company_name) not between 2 and 120
     or p_website_url is null or char_length(p_website_url) not between 1 and 2048
     or p_normalized_domain is null or p_normalized_domain <> lower(p_normalized_domain)
     or p_normalized_domain !~ '^[a-z0-9.-]+$' or char_length(p_normalized_domain) not between 3 and 253
     or p_site_control_note is null or char_length(btrim(p_site_control_note)) not between 10 and 2000
     or p_question_limit is null or p_question_limit not between 1 and 20
     or p_starts_on is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_create_pilot_args';
  end if;

  v_fingerprint := md5(concat_ws(chr(31),
    p_created_by::text, p_company_name, p_website_url, p_normalized_domain,
    btrim(p_site_control_note), p_question_limit::text, p_starts_on::text));

  -- The same lock a request for this website takes (0081), so a request
  -- and a pilot for one website cannot be created at the same time.
  perform pg_advisory_xact_lock(
    hashtextextended('snapshot-domain:' || p_normalized_domain, 0)
  );

  select p.* into v_existing
    from public.pilots p
   where p.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.request_fingerprint = v_fingerprint then
      return query select 'ALREADY_CREATED'::text, v_existing.id, v_existing.project_id;
    else
      return query select 'IDEMPOTENCY_KEY_CONFLICT'::text, null::uuid, null::uuid;
    end if;
    return;
  end if;

  -- D-054: a pilot starts no earlier than yesterday and no later than 60
  -- days from today, so a typo can neither open a window decades away nor
  -- create a pilot that has already ended. Checked after the replay, so a
  -- repeated press on a later day still answers the pilot it created.
  if p_starts_on < current_date - 1 or p_starts_on > current_date + 60 then
    return query select 'START_DATE_OUT_OF_RANGE'::text, null::uuid, null::uuid;
    return;
  end if;

  -- 0081's own status set: an in-flight request measures this website
  -- already.
  if exists (
    select 1
      from public.snapshot_requests r
     where r.normalized_domain = p_normalized_domain
       and r.status in (
         'pending_verification',
         'verified',
         'pending_approval',
         'approved',
         'queued',
         'running',
         'quality_review',
         'needs_founder_review'
       )
  ) then
    return query select 'DOMAIN_HAS_LIVE_REQUEST'::text, null::uuid, null::uuid;
    return;
  end if;

  if exists (
    select 1
      from public.pilots p
     where p.normalized_domain = p_normalized_domain
       and p.status = 'active'
  ) then
    return query select 'DOMAIN_HAS_LIVE_PILOT'::text, null::uuid, null::uuid;
    return;
  end if;

  -- The worker names the brand from the project's company name and domain
  -- (lib/protocol-worker/worker.ts), as for a request's project
  -- (_ensure_snapshot_request_project, 0030). A pilot has many questions,
  -- so no single question becomes the project's category.
  insert into public.projects (user_id, company_name, domain, category)
  values (null, p_company_name, p_normalized_domain, null)
  returning id into v_project_id;

  insert into public.pilots (
    project_id, company_name, website_url, normalized_domain, site_control_note,
    question_limit, starts_on, ends_on, created_by, idempotency_key, request_fingerprint
  ) values (
    v_project_id, p_company_name, p_website_url, p_normalized_domain, btrim(p_site_control_note),
    p_question_limit, p_starts_on, p_starts_on + 90, p_created_by, p_idempotency_key, v_fingerprint
  )
  returning id into v_pilot_id;

  return query select 'CREATED'::text, v_pilot_id, v_project_id;
end;
$$;

-- =======================================================================
-- 3. Add an approved question to a pilot
-- =======================================================================

-- One transaction, the same sequence as approve_and_launch_snapshot_baseline
-- (pilot step 1's redefinition of 0069): question, version, M4 approval, a
-- protocol with the identical Perplexity plan, protocol approval, the queue.
-- Nothing is run: the founder presses Run per question, which goes through
-- the paid-execution gate and a run request like every other start.
--
-- The application computes the prompt hash; this function re-checks it
-- against the exact text, so a question and its hash can never disagree.
create or replace function public.add_pilot_question(
    p_pilot_id uuid,
    p_added_by uuid,
    p_question_text text,
    p_prompt_hash text,
    p_question_provenance text,
    p_customer_approval_ref text,
    p_customer_approved_on date,
    p_idempotency_key uuid
  )
returns table (
  outcome            text,
  pilot_question_id  uuid,
  protocol_id        uuid,
  job_id             uuid
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_pilot          public.pilots%rowtype;
  v_existing       public.pilot_questions%rowtype;
  v_fingerprint    text;
  v_count          integer;
  v_total          integer;
  v_project_id     uuid;
  v_question_id    uuid;
  v_version_id     uuid;
  v_protocol_id    uuid;
  v_job_id         uuid;
  v_pilot_question_id uuid;
  v_version_status text;
  v_protocol_status text;
  v_enqueue_status text;
  v_rationale      text;
begin
  if p_pilot_id is null or p_added_by is null or p_idempotency_key is null
     or p_question_text is null or p_question_text <> btrim(p_question_text)
     or char_length(p_question_text) not between 10 and 300
     or p_prompt_hash is null or p_prompt_hash !~ '^[0-9a-f]{64}$'
     or p_customer_approval_ref is null
     or char_length(btrim(p_customer_approval_ref)) not between 3 and 300
     or p_customer_approved_on is null or p_customer_approved_on > current_date then
    raise exception using
      errcode = '22023',
      message = 'invalid_add_pilot_question_args';
  end if;

  -- D-052 item 4: the founder must say who wrote the question.
  if p_question_provenance is null
     or p_question_provenance not in ('customer_supplied', 'founder_supplied') then
    raise exception using
      errcode = '22023',
      message = 'question_provenance_required';
  end if;

  select p.* into v_pilot
    from public.pilots p
   where p.id = p_pilot_id
   for update;

  if not found then
    return query select 'PILOT_NOT_FOUND'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  v_project_id := v_pilot.project_id;
  v_fingerprint := md5(concat_ws(chr(31),
    p_added_by::text, p_question_text, p_prompt_hash, p_question_provenance,
    btrim(p_customer_approval_ref), p_customer_approved_on::text));

  -- A repeated press after a lost response replays; the same key for a
  -- different question is a conflict, never the first question's answer.
  select q.* into v_existing
    from public.pilot_questions q
   where q.pilot_id = p_pilot_id
     and q.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.request_fingerprint = v_fingerprint then
      return query
      select 'ALREADY_ADDED'::text, v_existing.id, pqp.protocol_id, j.id
        from public.pilot_question_protocols pqp
        join public.protocol_execution_jobs j on j.protocol_id = pqp.protocol_id
       where pqp.pilot_question_id = v_existing.id
         and pqp.engine = 'perplexity_sonar'
         and pqp.phase = 'baseline';
    else
      return query select 'IDEMPOTENCY_KEY_CONFLICT'::text, null::uuid, null::uuid, null::uuid;
    end if;
    return;
  end if;

  if v_pilot.status <> 'active' then
    return query select 'PILOT_CLOSED'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  if current_date > v_pilot.ends_on then
    return query select 'PILOT_ENDED'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  if encode(sha256(convert_to(p_question_text, 'UTF8')), 'hex') <> p_prompt_hash then
    return query select 'HASH_MISMATCH'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- A retired question does not count: its text may be measured again.
  if exists (
    select 1 from public.pilot_questions q
     where q.pilot_id = p_pilot_id
       and q.prompt_hash = p_prompt_hash
       and q.retired_at is null
  ) then
    return query select 'DUPLICATE_QUESTION'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- The limit counts live questions; the ordinal follows every question,
  -- retired ones included, so ordinals are never reused.
  select count(*) filter (where q.retired_at is null), count(*)
    into v_count, v_total
    from public.pilot_questions q
   where q.pilot_id = p_pilot_id;

  if v_count >= v_pilot.question_limit then
    return query select 'LIMIT_REACHED'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  v_rationale := case p_question_provenance
    when 'customer_supplied' then
      'Buyer question written by the customer, approved by the customer in writing, and entered by the founder in the admin console for a managed pilot; not independently scored.'
    else
      'Buyer question recommended or drafted by Zypact, approved by the customer in writing, and entered by the founder in the admin console for a managed pilot; not independently scored.'
  end;

  insert into public.buyer_questions (project_id)
  values (v_project_id)
  returning id into v_question_id;

  insert into public.buyer_question_versions (
    buyer_question_id, project_id, version_number,
    prompt_text, prompt_hash, intent_type,
    commercial_value, winnability, priority,
    rationale, provenance
  ) values (
    v_question_id, v_project_id, 1,
    p_question_text, p_prompt_hash, 'shortlist',
    3, 3, 13,
    v_rationale,
    p_question_provenance
  )
  returning id into v_version_id;

  select approval.status
    into v_version_status
    from public.approve_buyer_question_version(v_version_id, v_project_id, p_added_by) as approval;

  if v_version_status <> 'APPROVED' then
    raise exception using
      errcode = 'P0001',
      message = format('unexpected_buyer_question_version_approval_status:%s', v_version_status);
  end if;

  insert into public.protocols (
    project_id, buyer_question_version_id, provider, surface, model_config,
    planned_baseline_runs, planned_retest_runs,
    unit_of_analysis, primary_metric, sample_planning_method,
    run_cap, spend_cap_usd, time_window_seconds,
    rate_limit_per_hour, concurrency_limit, retry_cap,
    paraphrase_plan
  ) values (
    v_project_id, v_version_id, 'perplexity_sonar', 'answer',
    jsonb_build_object('model', 'sonar'),
    -- D-032: 5 planned baseline runs for protocols created from here on.
    5, 0,
    'buyer_question_version', 'presence_rate', 'fixed_operator_default_pending_pilot_calibration',
    -- run_cap keeps two attempts of retry headroom above the plan.
    7, 2, 86400,
    10, 1, 2,
    -- The one approved question and the same hash written to
    -- buyer_question_versions above. With one entry, every planned run
    -- sends the identical approved question.
    jsonb_build_array(
      jsonb_build_object('text', p_question_text, 'hash', p_prompt_hash)
    )
  )
  returning id into v_protocol_id;

  select approval.status
    into v_protocol_status
    from public.approve_protocol(v_protocol_id, v_project_id, p_added_by) as approval;

  if v_protocol_status <> 'APPROVED' then
    raise exception using
      errcode = 'P0001',
      message = format('unexpected_protocol_approval_status:%s', v_protocol_status);
  end if;

  select enqueue.status
    into v_enqueue_status
    from public.enqueue_protocol_execution_job(v_protocol_id, v_project_id) as enqueue;

  if v_enqueue_status <> 'QUEUED' then
    raise exception using
      errcode = 'P0001',
      message = format('unexpected_protocol_execution_job_enqueue_status:%s', v_enqueue_status);
  end if;

  select j.id into v_job_id
    from public.protocol_execution_jobs j
   where j.protocol_id = v_protocol_id;

  insert into public.pilot_questions (
    pilot_id, project_id, ordinal, buyer_question_version_id, prompt_hash,
    question_provenance, customer_approval_ref, customer_approved_on,
    added_by, idempotency_key, request_fingerprint
  ) values (
    p_pilot_id, v_project_id, v_total + 1, v_version_id, p_prompt_hash,
    p_question_provenance, btrim(p_customer_approval_ref), p_customer_approved_on,
    p_added_by, p_idempotency_key, v_fingerprint
  )
  returning id into v_pilot_question_id;

  insert into public.pilot_question_protocols (
    pilot_question_id, project_id, engine, phase, protocol_id
  ) values (
    v_pilot_question_id, v_project_id, 'perplexity_sonar', 'baseline', v_protocol_id
  );

  return query select 'ADDED'::text, v_pilot_question_id, v_protocol_id, v_job_id;
end;
$$;

-- =======================================================================
-- 4. Close a pilot
-- =======================================================================

-- Records who closed the pilot, when and why. Jobs are not changed: a
-- queued job may hold a reserved retry, and ending it here could strand
-- that reservation. Instead:
--   * the close is refused (PILOT_JOB_ACTIVE) while any measurement of the
--     pilot, a baseline or a retest of one, holds a live lease or has a
--     pending run request, so nothing already started spends after the
--     close. The founder waits for it to finish, then closes;
--   * request_protocol_job_run and retry_failed_protocol_job take this
--     row FOR SHARE before their pilot check, so neither can slip in
--     between this check and the close;
--   * claim_requested_protocol_execution_job refuses a closed pilot's job
--     as a second barrier.
create or replace function public.close_pilot(
    p_pilot_id uuid,
    p_closed_by uuid,
    p_reason text
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
  v_pilot public.pilots%rowtype;
begin
  if p_pilot_id is null or p_closed_by is null
     or p_reason is null or char_length(btrim(p_reason)) not between 10 and 2000 then
    raise exception using
      errcode = '22023',
      message = 'invalid_close_pilot_args';
  end if;

  select p.* into v_pilot
    from public.pilots p
   where p.id = p_pilot_id
   for update;

  if not found then
    return query select 'PILOT_NOT_FOUND'::text;
    return;
  end if;

  if v_pilot.status = 'closed' then
    return query select 'ALREADY_CLOSED'::text;
    return;
  end if;

  if exists (
    select 1
      from public.pilot_questions pq
      join public.pilot_question_protocols pqp on pqp.pilot_question_id = pq.id
      join public.protocols pr
        on pr.id = pqp.protocol_id or pr.baseline_protocol_id = pqp.protocol_id
      join public.protocol_execution_jobs j on j.protocol_id = pr.id
     where pq.pilot_id = p_pilot_id
       and (
         (j.status in ('claimed', 'running') and j.lease_expires_at > now())
         or exists (
           select 1
             from public.protocol_job_run_requests r
            where r.job_id = j.id
              and r.status = 'pending'
              and r.expires_at > now()
         )
       )
  ) then
    return query select 'PILOT_JOB_ACTIVE'::text;
    return;
  end if;

  update public.pilots
     set status = 'closed',
         closed_by = p_closed_by,
         closed_at = now(),
         close_reason = btrim(p_reason)
   where id = p_pilot_id
     and status = 'active';

  return query select 'CLOSED'::text;
end;
$$;

-- =======================================================================
-- 4b. Retire a pilot question whose measurement can no longer finish
-- =======================================================================

-- A question whose job ended `abandoned_exhausted`, or `failed` in a way
-- the D-052 retry does not take, would otherwise stay in the pilot for
-- good: Run and Retry refuse it, and the same text would be a duplicate.
-- Retiring keeps every row and all evidence, stops the question counting
-- toward the limit, lets its approved text be added again (a new question
-- version, protocol and job, with fresh caps), and refuses any later Run
-- or retry of it. At most 5 questions per pilot may be retired, which
-- bounds the extra spend re-adding can cause.
create or replace function public.retire_pilot_question(
    p_pilot_id uuid,
    p_pilot_question_id uuid,
    p_retired_by uuid,
    p_reason text
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
  v_pilot public.pilots%rowtype;
  v_question public.pilot_questions%rowtype;
  v_slot_protocol_id uuid;
  v_job public.protocol_execution_jobs%rowtype;
  v_protocol public.protocols%rowtype;
  v_consumed integer;
  v_retired integer;
begin
  if p_pilot_id is null or p_pilot_question_id is null or p_retired_by is null
     or p_reason is null or char_length(btrim(p_reason)) not between 10 and 2000 then
    raise exception using
      errcode = '22023',
      message = 'invalid_retire_pilot_question_args';
  end if;

  -- The lock add_pilot_question and close_pilot take, so the limit, the
  -- duplicate rule and the retirement count are read under it. Every Run
  -- and retry takes it FOR SHARE before its pilot check.
  select p.* into v_pilot
    from public.pilots p
   where p.id = p_pilot_id
   for update;

  if not found then
    return query select 'PILOT_NOT_FOUND'::text;
    return;
  end if;

  select q.* into v_question
    from public.pilot_questions q
   where q.id = p_pilot_question_id
     and q.pilot_id = p_pilot_id;

  if not found then
    return query select 'QUESTION_NOT_FOUND'::text;
    return;
  end if;

  if v_question.retired_at is not null then
    return query select 'ALREADY_RETIRED'::text;
    return;
  end if;

  if v_pilot.status <> 'active' then
    return query select 'PILOT_CLOSED'::text;
    return;
  end if;

  select pqp.protocol_id into v_slot_protocol_id
    from public.pilot_question_protocols pqp
   where pqp.pilot_question_id = v_question.id
     and pqp.engine = 'perplexity_sonar'
     and pqp.phase = 'baseline';

  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.protocol_id = v_slot_protocol_id;

  if not found then
    return query select 'QUESTION_NOT_STOPPED'::text;
    return;
  end if;

  -- Nothing of this question may be running or about to start: its
  -- baseline job, or a retest of that baseline.
  if exists (
    select 1
      from public.protocols pr
      join public.protocol_execution_jobs j on j.protocol_id = pr.id
     where (pr.id = v_slot_protocol_id or pr.baseline_protocol_id = v_slot_protocol_id)
       and (
         (j.status in ('claimed', 'running') and j.lease_expires_at > now())
         or exists (
           select 1
             from public.protocol_job_run_requests r
            where r.job_id = j.id
              and r.status = 'pending'
              and r.expires_at > now()
         )
       )
  ) then
    return query select 'QUESTION_JOB_ACTIVE'::text;
    return;
  end if;

  if v_job.status not in ('failed', 'abandoned_exhausted') then
    return query select 'QUESTION_NOT_STOPPED'::text;
    return;
  end if;

  -- A run that failed at the provider and can still be retried is retried,
  -- not retired. These are retry_failed_protocol_job's job, slot and
  -- run-cap gates (pilot step 1); its call-level gates (an open or
  -- unreceipted call) are not repeated, so such a job waits for its call
  -- to be reconciled.
  if v_job.status = 'failed'
     and v_job.review_resolution is null
     and v_job.current_attempt_id is null
     and v_job.failure_reason = 'provider_error' then
    select p.* into v_protocol
      from public.protocols p
     where p.id = v_job.protocol_id;

    select count(*) into v_consumed
      from public.protocol_attempts pa
     where pa.protocol_id = v_job.protocol_id
       and pa.status <> 'cancelled';

    if exists (
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
           <= v_protocol.run_cap then
      return query select 'QUESTION_RETRYABLE'::text;
      return;
    end if;
  end if;

  select count(*) into v_retired
    from public.pilot_questions q
   where q.pilot_id = p_pilot_id
     and q.retired_at is not null;

  if v_retired >= 5 then
    return query select 'RETIRE_LIMIT_REACHED'::text;
    return;
  end if;

  update public.pilot_questions
     set retired_by = p_retired_by,
         retired_at = now(),
         retire_reason = btrim(p_reason)
   where id = v_question.id
     and retired_at is null;

  return query select 'RETIRED'::text;
end;
$$;

-- =======================================================================
-- 5. A Run for a pilot question
-- =======================================================================

alter table public.protocol_job_run_requests
  drop constraint protocol_job_run_requests_requested_via_check;
alter table public.protocol_job_run_requests
  add constraint protocol_job_run_requests_requested_via_check
  check (requested_via in (
    'admin_run_pipeline', 'admin_run_retest',
    'admin_founder_baseline', 'operator_cli', 'admin_pilot_run'
  ));

-- Pilot step 1's function, unchanged except for `admin_pilot_run` in the
-- accepted starts and the pilot block after the job is found
-- (scripts/test-pilot-questions.ts checks both, byte for byte). The
-- signature is unchanged, so `create or replace` keeps its grants; they are
-- restated below.
create or replace function public.request_protocol_job_run(
    p_job_id uuid,
    p_project_id uuid,
    p_requested_via text,
    p_requested_by uuid,
    p_ttl_seconds integer
  )
returns table (
  outcome     text,
  request_id  uuid,
  expires_at  timestamptz
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  v_pending public.protocol_job_run_requests%rowtype;
  v_row public.protocol_job_run_requests%rowtype;
  v_found boolean := false;
  v_expires timestamptz;
  -- D-054
  v_pilot public.pilots%rowtype;
  v_pilot_id uuid;
  v_question_retired boolean := false;
begin
  if p_job_id is null or p_project_id is null
     or p_requested_via is null
     or p_requested_via not in (
       'admin_run_pipeline', 'admin_run_retest', 'admin_founder_baseline', 'operator_cli',
       'admin_pilot_run'
     )
     or (p_requested_via <> 'operator_cli' and p_requested_by is null)
     or p_ttl_seconds is null or p_ttl_seconds < 30 or p_ttl_seconds > 600 then
    raise exception using
      errcode = '22023',
      message = 'invalid_request_protocol_job_run_args';
  end if;

  -- One writer at a time, so the pending check and the insert cannot
  -- interleave with another request.
  perform pg_advisory_xact_lock(hashtextextended('protocol-job-run-request', 0));

  update public.protocol_job_run_requests r
     set status = 'expired',
         resolved_at = now()
   where r.status = 'pending'
     and r.expires_at <= now();

  select r.* into v_pending
    from public.protocol_job_run_requests r
   where r.status = 'pending';

  if found then
    if v_pending.job_id = p_job_id and v_pending.project_id = p_project_id then
      -- A repeated press for the same job keeps its request alive for a
      -- full TTL from now, so a late second start is not handed a request
      -- that lapses before its machine boots.
      update public.protocol_job_run_requests r
         set expires_at = greatest(r.expires_at, now() + make_interval(secs => p_ttl_seconds))
       where r.id = v_pending.id
      returning r.expires_at into v_expires;
      return query select 'ALREADY_REQUESTED'::text, v_pending.id, v_expires;
    else
      return query select 'ANOTHER_RUN_PENDING'::text, null::uuid, null::timestamptz;
    end if;
    return;
  end if;

  -- One machine runs one job per start (D-034). A job holding a live lease
  -- means that machine is busy: it stops after its own job and would never
  -- serve this request, so the founder is told now rather than left waiting.
  if exists (
    select 1 from public.protocol_execution_jobs j
     where j.status in ('claimed', 'running')
       and j.lease_expires_at > now()
  ) then
    return query select 'WORKER_BUSY'::text, null::uuid, null::timestamptz;
    return;
  end if;

  begin
    select j.* into v_job
      from public.protocol_execution_jobs j
     where j.id = p_job_id
       and j.project_id = p_project_id
     for update nowait;
    v_found := found;
  exception
    when lock_not_available then
      return query select 'JOB_LOCKED'::text, null::uuid, null::timestamptz;
      return;
  end;

  if not v_found then
    return query select 'JOB_NOT_FOUND'::text, null::uuid, null::timestamptz;
    return;
  end if;

  -- D-054: a pilot's measurement, its baseline or a retest of that
  -- baseline, runs only while its pilot is open and inside its dates, and
  -- only while its question is not retired. The pilot row is locked FOR
  -- SHARE, so this Run and close_pilot or retire_pilot_question (FOR
  -- UPDATE) cannot interleave: whichever commits second sees the other.
  select pq.pilot_id, pq.retired_at is not null
    into v_pilot_id, v_question_retired
    from public.pilot_question_protocols pqp
    join public.pilot_questions pq on pq.id = pqp.pilot_question_id
   where pqp.protocol_id = v_job.protocol_id
      or pqp.protocol_id = (
        select pr.baseline_protocol_id from public.protocols pr where pr.id = v_job.protocol_id
      );

  if v_pilot_id is not null then
    select pl.* into v_pilot
      from public.pilots pl
     where pl.id = v_pilot_id
     for share;

    if v_pilot.status <> 'active' or current_date > v_pilot.ends_on then
      return query select 'PILOT_CLOSED'::text, null::uuid, null::timestamptz;
      return;
    end if;

    if current_date < v_pilot.starts_on then
      return query select 'PILOT_NOT_STARTED'::text, null::uuid, null::timestamptz;
      return;
    end if;

    if v_question_retired then
      return query select 'PILOT_QUESTION_RETIRED'::text, null::uuid, null::timestamptz;
      return;
    end if;
  end if;

  -- A dead lease with no claims left is what the global claim's sweep turns
  -- into abandoned_exhausted. Applied here to this one row, with the same
  -- alert, so the founder sees the honest state instead of "Resume run".
  if v_job.status in ('claimed', 'running')
     and v_job.lease_expires_at < now()
     and v_job.attempt_count >= v_job.max_attempts then
    with abandoned as (
      update public.protocol_execution_jobs j
         set status = 'abandoned_exhausted', updated_at = now()
       where j.id = v_job.id
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

    return query select 'JOB_ATTEMPTS_EXHAUSTED'::text, null::uuid, null::timestamptz;
    return;
  end if;

  if not (
    v_job.status = 'queued'
    or (v_job.status in ('claimed', 'running')
        and v_job.lease_expires_at < now()
        and v_job.attempt_count < v_job.max_attempts)
  ) then
    return query select 'JOB_NOT_RUNNABLE'::text, null::uuid, null::timestamptz;
    return;
  end if;

  insert into public.protocol_job_run_requests (
    job_id, project_id, requested_via, requested_by, expires_at
  ) values (
    p_job_id, p_project_id, p_requested_via, p_requested_by,
    now() + make_interval(secs => p_ttl_seconds)
  )
  returning * into v_row;

  return query select 'REQUESTED'::text, v_row.id, v_row.expires_at;
end;
$$;

-- =======================================================================
-- 6. The requested claim refuses a closed pilot's job (second barrier)
-- =======================================================================

alter table public.protocol_job_run_requests
  drop constraint protocol_job_run_requests_refusal_code_check;
alter table public.protocol_job_run_requests
  add constraint protocol_job_run_requests_refusal_code_check
  check (refusal_code in ('JOB_NOT_FOUND', 'JOB_NOT_ELIGIBLE', 'JOB_LOCKED', 'PILOT_CLOSED'));

-- Pilot step 1's function, unchanged except for the pilot block after the
-- job is found (scripts/test-pilot-questions.ts checks it byte for byte).
-- The signature is unchanged, so `create or replace` keeps its grants;
-- they are restated below.
create or replace function public.claim_requested_protocol_execution_job(
    p_worker_id text,
    p_lease_seconds integer
  )
returns table (
  outcome     text,
  job         public.protocol_execution_jobs,
  claim_token uuid
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_request public.protocol_job_run_requests%rowtype;
  v_job public.protocol_execution_jobs%rowtype;
  v_found boolean := false;
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

  select r.* into v_request
    from public.protocol_job_run_requests r
   where r.status = 'pending'
   for update;

  if not found then
    return query select 'NO_RUN_REQUEST'::text, null::public.protocol_execution_jobs, null::uuid;
    return;
  end if;

  if v_request.expires_at <= now() then
    update public.protocol_job_run_requests r
       set status = 'expired', resolved_at = now()
     where r.id = v_request.id;
    return query select 'NO_RUN_REQUEST'::text, null::public.protocol_execution_jobs, null::uuid;
    return;
  end if;

  -- Lock the named row first, evaluate second, and never step over it.
  begin
    select j.* into v_job
      from public.protocol_execution_jobs j
     where j.id = v_request.job_id
       and j.project_id = v_request.project_id
     for update nowait;
    v_found := found;
  exception
    when lock_not_available then
      update public.protocol_job_run_requests r
         set status = 'refused', resolved_at = now(), refusal_code = 'JOB_LOCKED'
       where r.id = v_request.id;
      return query select 'JOB_LOCKED'::text, null::public.protocol_execution_jobs, null::uuid;
      return;
  end;

  if not v_found then
    update public.protocol_job_run_requests r
       set status = 'refused', resolved_at = now(), refusal_code = 'JOB_NOT_FOUND'
     where r.id = v_request.id;
    return query select 'JOB_NOT_FOUND'::text, null::public.protocol_execution_jobs, null::uuid;
    return;
  end if;

  -- D-054: the second barrier. A job of a pilot that is closed or outside
  -- its dates, or whose question is retired (its baseline, or a retest of
  -- that baseline), is never claimed, even when its run request was
  -- recorded before the pilot changed: a pilot can pass its end date while
  -- a request waits. close_pilot already refuses while a request is
  -- pending. Read without a lock: nothing here is written to the pilot.
  if exists (
    select 1
      from public.pilot_question_protocols pqp
      join public.pilot_questions pq on pq.id = pqp.pilot_question_id
      join public.pilots pl on pl.id = pq.pilot_id
     where (pqp.protocol_id = v_job.protocol_id
            or pqp.protocol_id = (
              select pr.baseline_protocol_id from public.protocols pr where pr.id = v_job.protocol_id
            ))
       and (pl.status <> 'active'
            or current_date > pl.ends_on
            or current_date < pl.starts_on
            or pq.retired_at is not null)
  ) then
    update public.protocol_job_run_requests r
       set status = 'refused', resolved_at = now(), refusal_code = 'PILOT_CLOSED'
     where r.id = v_request.id;
    return query select 'PILOT_CLOSED'::text, null::public.protocol_execution_jobs, null::uuid;
    return;
  end if;

  if not (
    v_job.status = 'queued'
    or (v_job.status in ('claimed', 'running')
        and v_job.lease_expires_at < now()
        and v_job.attempt_count < v_job.max_attempts)
  ) then
    update public.protocol_job_run_requests r
       set status = 'refused', resolved_at = now(), refusal_code = 'JOB_NOT_ELIGIBLE'
     where r.id = v_request.id;
    return query select 'JOB_NOT_ELIGIBLE'::text, null::public.protocol_execution_jobs, null::uuid;
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

  update public.protocol_job_run_requests r
     set status = 'consumed', resolved_at = now(), consumed_by_worker = p_worker_id
   where r.id = v_request.id;

  return query select 'CLAIMED'::text, v_job, v_token;
end;
$$;

-- =======================================================================
-- 7. The provider-failure retry refuses a closed pilot's job
-- =======================================================================

-- Pilot step 1's function, unchanged except for three declarations and the
-- pilot block after the request check (scripts/test-pilot-questions.ts
-- checks both byte for byte). The signature is unchanged, so
-- `create or replace` keeps its grants; they are restated below.
create or replace function public.retry_failed_protocol_job(
    p_job_id uuid,
    p_project_id uuid,
    p_actor uuid,
    p_reason text,
    p_source_attempt_id uuid,
    p_idempotency_key text
  )
returns table (
  outcome           text,
  denial_code       text,
  new_attempt_id    uuid
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_job public.protocol_execution_jobs%rowtype;
  v_protocol public.protocols%rowtype;
  v_source public.protocol_attempts%rowtype;
  v_perplexity public.protocol_external_calls%rowtype;
  v_analysis public.protocol_external_calls%rowtype;
  v_request_status text;
  v_consumed integer;
  v_key text;
  v_result record;
  v_replay_perplexity numeric;
  v_replay_analysis numeric;
  -- D-054
  v_pilot public.pilots%rowtype;
  v_pilot_id uuid;
  v_question_retired boolean := false;
begin
  if p_job_id is null or p_project_id is null or p_actor is null
     or p_reason is null or char_length(btrim(p_reason)) not between 10 and 2000
     or p_source_attempt_id is null
     or p_idempotency_key is null or btrim(p_idempotency_key) = ''
     or char_length(p_idempotency_key) > 200 then
    raise exception using
      errcode = '22023',
      message = 'invalid_retry_failed_protocol_job_args';
  end if;

  -- Founder console retries share the operator-action key space with the
  -- worker's own operator retries, under their own prefix.
  v_key := 'failed-job-retry:' || p_idempotency_key;

  select j.* into v_job
    from public.protocol_execution_jobs j
   where j.id = p_job_id and j.project_id = p_project_id
   for update;

  if not found then
    return query select 'JOB_NOT_FOUND'::text, null::text, null::uuid;
    return;
  end if;

  -- Replay first, whatever the job's status is now (the D-021 ordering). The
  -- recorded decision is answered by authorize_operator_retry itself, which
  -- compares the request's fingerprint (the source run and its reserved
  -- amounts): the same key for a different failed run is a conflict, never
  -- the first run's answer.
  if exists (
    select 1 from public.protocol_operator_actions a
     where a.project_id = p_project_id
       and a.job_id = p_job_id
       and a.idempotency_key = v_key
  ) then
    select ec.reserved_cost_usd into v_replay_perplexity
      from public.protocol_external_calls ec
     where ec.protocol_attempt_id = p_source_attempt_id
       and ec.call_kind = 'perplexity' and ec.generation = 1;
    select ec.reserved_cost_usd into v_replay_analysis
      from public.protocol_external_calls ec
     where ec.protocol_attempt_id = p_source_attempt_id
       and ec.call_kind = 'analysis' and ec.generation = 1;

    select * into v_result
      from public.authorize_operator_retry(
        p_job_id, p_project_id, p_actor::text, btrim(p_reason), 'retry_full_attempt',
        p_source_attempt_id, coalesce(v_replay_analysis, 0), v_key,
        null, coalesce(v_replay_perplexity, 0)
      );

    if v_result.status = 'APPROVED' then
      return query select 'APPROVED'::text, null::text, (v_result.new_attempt).id;
    elsif v_result.status = 'DENIED' then
      return query select 'DENIED'::text, v_result.denial_code::text, null::uuid;
    else
      return query select 'IDEMPOTENCY_KEY_CONFLICT'::text, null::text, null::uuid;
    end if;
    return;
  end if;

  if v_job.status <> 'failed' then
    return query select 'JOB_NOT_FAILED'::text, null::text, null::uuid;
    return;
  end if;

  -- A job the founder closed through review, a cap failure, or a job still
  -- pointing at a run is final here.
  if v_job.review_resolution is not null
     or v_job.current_attempt_id is not null
     or v_job.failure_reason is distinct from 'provider_error' then
    return query select 'JOB_NOT_RETRYABLE'::text, null::text, null::uuid;
    return;
  end if;

  -- A request that launched this job and has since been closed is final.
  -- A retest job has no snapshot request; its protocol status governs it.
  select r.status into v_request_status
    from public.snapshot_requests r
   where r.protocol_id = v_job.protocol_id;

  if found and v_request_status <> 'approved' then
    return query select 'REQUEST_NOT_OPEN'::text, null::text, null::uuid;
    return;
  end if;

  -- D-054: a pilot's measurement is retried only while its pilot is open
  -- and inside its dates, and only while its question is not retired, so
  -- nothing is reserved for a job that could never be run. The pilot row
  -- is locked FOR SHARE, as for a Run, so a retry and close_pilot or
  -- retire_pilot_question cannot interleave.
  select pq.pilot_id, pq.retired_at is not null
    into v_pilot_id, v_question_retired
    from public.pilot_question_protocols pqp
    join public.pilot_questions pq on pq.id = pqp.pilot_question_id
   where pqp.protocol_id = v_job.protocol_id
      or pqp.protocol_id = (
        select pr.baseline_protocol_id from public.protocols pr where pr.id = v_job.protocol_id
      );

  if v_pilot_id is not null then
    select pl.* into v_pilot
      from public.pilots pl
     where pl.id = v_pilot_id
     for share;

    if v_pilot.status <> 'active'
       or current_date > v_pilot.ends_on
       or current_date < v_pilot.starts_on
       or v_question_retired then
      return query select 'PILOT_CLOSED'::text, null::text, null::uuid;
      return;
    end if;
  end if;

  select pa.* into v_source
    from public.protocol_attempts pa
   where pa.id = p_source_attempt_id
     and pa.project_id = p_project_id
     and pa.job_id = p_job_id
   for update;

  if not found then
    return query select 'SOURCE_ATTEMPT_NOT_OWNED_BY_JOB'::text, null::text, null::uuid;
    return;
  end if;

  -- The newest run of the slot that failed: terminal `failed`, in the slot
  -- the job stopped at, never retried, with no completed run in its slot.
  if v_source.status <> 'failed'
     or v_source.terminalized_at is null
     or v_source.baseline_ordinal is distinct from v_job.next_baseline_ordinal
     or exists (
       select 1 from public.protocol_attempts pa
        where pa.retry_of_attempt_id = v_source.id
     )
     or exists (
       select 1 from public.protocol_attempts pa
        where pa.job_id = p_job_id
          and pa.baseline_ordinal = v_source.baseline_ordinal
          and pa.status = 'completed'
     ) then
    return query select 'SOURCE_ATTEMPT_NOT_RETRYABLE'::text, null::text, null::uuid;
    return;
  end if;

  -- No call of the run may be open or sent without a receipt.
  if exists (
    select 1 from public.protocol_external_calls ec
     where ec.protocol_attempt_id = v_source.id
       and (
         ec.status in ('reserved', 'in_progress')
         or (ec.request_sent_at is not null
             and not exists (select 1 from public.provider_call_receipts r where r.external_call_id = ec.id)
             and not exists (select 1 from public.analysis_call_receipts r where r.external_call_id = ec.id))
       )
  ) then
    return query select 'AMBIGUOUS_CALL_PRESENT'::text, null::text, null::uuid;
    return;
  end if;

  select ec.* into v_perplexity
    from public.protocol_external_calls ec
   where ec.protocol_attempt_id = v_source.id
     and ec.call_kind = 'perplexity'
     and ec.generation = 1;

  if not found
     or v_perplexity.status <> 'failed'
     or not exists (
       select 1 from public.provider_call_receipts r where r.external_call_id = v_perplexity.id
     ) then
    return query select 'NOT_A_PROVIDER_FAILURE'::text, null::text, null::uuid;
    return;
  end if;

  select ec.* into v_analysis
    from public.protocol_external_calls ec
   where ec.protocol_attempt_id = v_source.id
     and ec.call_kind = 'analysis'
     and ec.generation = 1;

  if not found then
    return query select 'NOT_A_PROVIDER_FAILURE'::text, null::text, null::uuid;
    return;
  end if;

  -- The retry must leave room in the run cap for the rest of the plan; a
  -- paid retry that cannot finish it is refused before anything is reserved.
  select p.* into v_protocol
    from public.protocols p
   where p.id = v_job.protocol_id and p.project_id = p_project_id;

  select count(*) into v_consumed
    from public.protocol_attempts pa
   where pa.protocol_id = v_job.protocol_id
     and pa.status <> 'cancelled';

  if v_consumed + 1
       + greatest(coalesce(v_protocol.planned_baseline_runs, 0) - v_job.next_baseline_ordinal, 0)
     > v_protocol.run_cap then
    return query select 'RUN_CAP_INSUFFICIENT_FOR_REMAINING_PLAN'::text, null::text, null::uuid;
    return;
  end if;

  -- Reopen for review, then authorise through the one operator-retry path.
  update public.protocol_execution_jobs
     set status = 'needs_review',
         needs_review_reason = 'operator_retry_of_failed_job',
         updated_at = now()
   where id = p_job_id;

  select * into v_result
    from public.authorize_operator_retry(
      p_job_id, p_project_id, p_actor::text, btrim(p_reason), 'retry_full_attempt',
      v_source.id, v_analysis.reserved_cost_usd, v_key,
      null, v_perplexity.reserved_cost_usd
    );

  if v_result.status = 'APPROVED' then
    -- Queued again with a fresh claim budget, as reactivate_abandoned_job
    -- does (D-024). The earlier failure stays on the failed run
    -- (termination_reason) and in the operator-action record.
    update public.protocol_execution_jobs
       set attempt_count = 0,
           worker_id = null,
           claim_token = null,
           lease_expires_at = null,
           failure_reason = null,
           updated_at = now()
     where id = p_job_id;

    return query select 'APPROVED'::text, null::text, (v_result.new_attempt).id;
    return;
  end if;

  -- A denied retry leaves the job exactly as it was. The denial stays
  -- recorded, so a replay of the same key answers the same way.
  update public.protocol_execution_jobs
     set status = 'failed',
         needs_review_reason = null,
         failure_reason = v_job.failure_reason,
         updated_at = now()
   where id = p_job_id;

  return query select 'DENIED'::text, v_result.denial_code::text, null::uuid;
end;
$$;

-- =======================================================================
-- Privileges: service role only.
-- =======================================================================

revoke all on function public.create_pilot(uuid, text, text, text, text, integer, date, uuid) from public;
revoke all on function public.create_pilot(uuid, text, text, text, text, integer, date, uuid) from anon;
revoke all on function public.create_pilot(uuid, text, text, text, text, integer, date, uuid) from authenticated;
grant execute on function public.create_pilot(uuid, text, text, text, text, integer, date, uuid) to service_role;

revoke all on function public.add_pilot_question(uuid, uuid, text, text, text, text, date, uuid) from public;
revoke all on function public.add_pilot_question(uuid, uuid, text, text, text, text, date, uuid) from anon;
revoke all on function public.add_pilot_question(uuid, uuid, text, text, text, text, date, uuid) from authenticated;
grant execute on function public.add_pilot_question(uuid, uuid, text, text, text, text, date, uuid) to service_role;

revoke all on function public.close_pilot(uuid, uuid, text) from public;
revoke all on function public.close_pilot(uuid, uuid, text) from anon;
revoke all on function public.close_pilot(uuid, uuid, text) from authenticated;
grant execute on function public.close_pilot(uuid, uuid, text) to service_role;

revoke all on function public.request_protocol_job_run(uuid, uuid, text, uuid, integer) from public;
revoke all on function public.request_protocol_job_run(uuid, uuid, text, uuid, integer) from anon;
revoke all on function public.request_protocol_job_run(uuid, uuid, text, uuid, integer) from authenticated;
grant execute on function public.request_protocol_job_run(uuid, uuid, text, uuid, integer) to service_role;

revoke all on function public.retire_pilot_question(uuid, uuid, uuid, text) from public;
revoke all on function public.retire_pilot_question(uuid, uuid, uuid, text) from anon;
revoke all on function public.retire_pilot_question(uuid, uuid, uuid, text) from authenticated;
grant execute on function public.retire_pilot_question(uuid, uuid, uuid, text) to service_role;

revoke all on function public.claim_requested_protocol_execution_job(text, integer) from public;
revoke all on function public.claim_requested_protocol_execution_job(text, integer) from anon;
revoke all on function public.claim_requested_protocol_execution_job(text, integer) from authenticated;
grant execute on function public.claim_requested_protocol_execution_job(text, integer) to service_role;

revoke all on function public.retry_failed_protocol_job(uuid, uuid, uuid, text, uuid, text) from public;
revoke all on function public.retry_failed_protocol_job(uuid, uuid, uuid, text, uuid, text) from anon;
revoke all on function public.retry_failed_protocol_job(uuid, uuid, uuid, text, uuid, text) from authenticated;
grant execute on function public.retry_failed_protocol_job(uuid, uuid, uuid, text, uuid, text) to service_role;
