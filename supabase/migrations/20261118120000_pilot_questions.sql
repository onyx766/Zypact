-- Pilot questions (D-053, D-054): one managed pilot holds up to 20 approved
-- buyer questions under ONE project, each measured by its own protocol and
-- job through the same approval, admission and reservation path a
-- founder-created request uses.
--
-- Applies after 20261114120000 (pilot step 1). Depends only on objects from
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
--   4. `create_pilot`, `add_pilot_question`, `close_pilot`.
--   5. `request_protocol_job_run` (pilot step 1) is redefined with two
--      changes only: the console start `admin_pilot_run`, and a refusal
--      (`PILOT_CLOSED`) for a job of a pilot that is closed or past its end
--      date. The requested_via CHECK of `protocol_job_run_requests` gains
--      the same value.
--
-- Not changed: approval (`approve_buyer_question_version`,
-- `approve_protocol`), the queue (`enqueue_protocol_execution_job`), the
-- claim, admission, reservation, the worker, the report pass and every
-- request function. A pilot's jobs are never picked up by the report pass,
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
--   2. Restore pilot step 1's request_protocol_job_run and its CHECK:
--        re-apply section 1 of 20261114120000 for that function's body and
--        grants, then
--        alter table public.protocol_job_run_requests
--          drop constraint protocol_job_run_requests_requested_via_check;
--        alter table public.protocol_job_run_requests
--          add constraint protocol_job_run_requests_requested_via_check
--          check (requested_via in ('admin_run_pipeline', 'admin_run_retest',
--                                   'admin_founder_baseline', 'operator_cli'));
--      The second statement fails while a row records admin_pilot_run;
--      such rows are run-request history and are kept, so in that case
--      leave the wider CHECK in place.
--   3. Drop the rest:
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
  ordinal                    integer not null check (ordinal between 1 and 20),
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
  constraint pilot_questions_prompt_key unique (pilot_id, prompt_hash),
  constraint pilot_questions_version_key unique (buyer_question_version_id),
  constraint pilot_questions_idempotency_key unique (pilot_id, idempotency_key)
);

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
  'D-054: an approved buyer question of a pilot. Written only by add_pilot_question.';
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

  if exists (
    select 1 from public.pilot_questions q
     where q.pilot_id = p_pilot_id
       and q.prompt_hash = p_prompt_hash
  ) then
    return query select 'DUPLICATE_QUESTION'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  select count(*) into v_count
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
    p_pilot_id, v_project_id, v_count + 1, v_version_id, p_prompt_hash,
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
-- that reservation. request_protocol_job_run refuses every Run for a
-- closed pilot instead, so nothing more is measured.
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

  -- D-054: a pilot's measurement runs only while its pilot is open and
  -- inside its window. Closing a pilot changes no job, so this is what
  -- stops a closed pilot from spending.
  if exists (
    select 1
      from public.pilot_question_protocols pqp
      join public.pilot_questions pq on pq.id = pqp.pilot_question_id
      join public.pilots pl on pl.id = pq.pilot_id
     where pqp.protocol_id = v_job.protocol_id
       and (pl.status <> 'active' or current_date > pl.ends_on)
  ) then
    return query select 'PILOT_CLOSED'::text, null::uuid, null::timestamptz;
    return;
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
