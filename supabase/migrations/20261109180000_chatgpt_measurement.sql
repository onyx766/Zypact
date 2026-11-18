-- ChatGPT measurement, phase B (D-061): the schema the ChatGPT engine needs
-- to measure a pilot question beside Perplexity. The engine, its approved
-- setting and its source rule: D-050, D-053, D-056. The founder's approved
-- values used here (ChatGPT caps of 7 runs, 2 retries and 4 USD): D-059.
--
-- Release order. Applies after 20261109170000 (older pilot report links and
-- the unscoped claims, D-060) and before 20261109190000 (pilot retest).
-- Through the named-file procedure, expected_prev is the ledger tail at that
-- time: 20261109170000. Numbered inside D-058's window (after
-- 20261109160000, before 20261110120000); it references nothing created by
-- the account stack (20261110120000-20261113120000). Apply with the protocol
-- worker stopped: the ALTERs below take ACCESS EXCLUSIVE locks, and a
-- precondition refuses while any protocol attempt is open. The worker image
-- that flips CHATGPT_WORKER_SCHEMA_READY ships after this migration, and its
-- startup check (protocol_worker_capabilities, below) refuses a database
-- without it.
--
-- What this changes, in order:
--   1. probe_runs and probe_results accept the probe mode
--      'live_openai_chatgpt' (0013's two CHECKs, dropped by name and
--      re-added with the one new value).
--   2. One live baseline per question version PER ENGINE. The unique index
--      protocols_one_live_baseline_per_engine replaces 0073's
--      one-live-baseline-per-version index; it is created first, so the
--      rule is never unenforced. Every Perplexity provider string
--      ('perplexity', 'perplexity_sonar', 'perplexity_agent') is one
--      engine; any other provider (today only 'openai_chatgpt') is its own.
--      Without this a ChatGPT baseline on a pilot question's approved
--      version could never be approved, and minting a second version would
--      break the same-question rule 0073 protects. Two Perplexity baselines
--      on one version stay refused. The retest index is unchanged: a retest
--      belongs to one baseline, so it is already per engine.
--   3. pilot_question_protocols: the engine CHECK accepts 'perplexity_sonar'
--      and 'openai_chatgpt' (the phase stays 'baseline'; the pilot retest
--      widens it). A BEFORE INSERT trigger refuses a slot whose engine is
--      not its protocol's provider, whose protocol is outside the pilot's
--      project or measures another question version than the pilot
--      question's, or, for a baseline slot, is a retest protocol. Only
--      SECURITY DEFINER functions write the table; the trigger is defence
--      in depth.
--   4. persist_probe_result_for_job: 0054's definition byte for byte,
--      except that the probe result's platform is the probe run's own
--      platform instead of the literal 'perplexity' (two lines, marked
--      D-061). provider_model stays NULL. A Perplexity result keeps
--      exactly its canonical hash, so replays answer ALREADY_PERSISTED.
--   5. add_pilot_question_engine: adds the ChatGPT baseline to a live pilot
--      question through add_pilot_question's approval sequence: the
--      question's own approved version and its one-question paraphrase
--      plan, 5 planned runs, caps of 7 runs, 2 retries and 4 USD, the
--      approved setting, protocol approval, the queue, then the slot.
--      Nothing is run: the founder presses Run per question and engine.
--   6. retire_pilot_question: 20261109140000's definition byte for byte
--      apart from marked declarations and one marked block, so the active,
--      stopped and retryable checks cover every slot of the question (both
--      engines) and each slot's retests. The 5-retirement limit stays.
--   7. protocol_worker_capabilities(): what this schema lets the worker
--      record. With the ChatGPT switch on, the worker reads it at startup
--      and refuses to start unless it lists 'live_openai_chatgpt', so a
--      worker switched on before this migration stops before any claim.
--
-- Not changed. The call kinds: the provider leg of every engine keeps
-- call_kind 'perplexity' (D-061 item 1); the protocol's provider is the
-- engine. No M5 spend, reservation, receipt or retry function, no call_kind
-- CHECK and no monitoring view is redefined. Approval
-- (approve_buyer_question_version, approve_protocol), the queue, admission,
-- the claims, the provider-failure retry, close_pilot and the report and
-- action functions are not redefined. No row is inserted, updated or
-- deleted, and nothing calls a provider.
--
-- Preconditions, checked first (any failure aborts the whole transaction):
-- the two probe-mode CHECKs, 0073's index and the two slot CHECKs are
-- exactly as their migrations left them; none of the objects created here
-- exists yet; every protocol names a provider from the closed set the code
-- writes; every probe run of a protocol attempt is 'perplexity', so every
-- existing result's replay hash is unchanged; no protocol attempt is
-- reserved or in progress; every existing pilot slot already satisfies the
-- trigger's rules. Postconditions at the end assert the resulting
-- definitions, the index swap, the trigger and every privilege.
--
-- Recovery:
--   * Before any ChatGPT protocol, slot, probe run or probe result exists,
--     and while no question version has a live baseline on two engines, in
--     one transaction and in this order:
--       drop function if exists public.protocol_worker_capabilities();
--       re-apply 20261109140000's retire_pilot_question definition and its
--         four privilege statements;
--       drop function if exists public.add_pilot_question_engine(uuid, uuid, text, uuid);
--       re-apply 0054's persist_probe_result_for_job definition and its
--         four privilege statements;
--       drop trigger if exists pilot_question_protocols_consistency
--         on public.pilot_question_protocols;
--       drop function if exists public.pilot_question_protocols_consistency();
--       restore the table comment 20261109140000 wrote;
--       alter table public.pilot_question_protocols
--         drop constraint pilot_question_protocols_engine_check;
--       alter table public.pilot_question_protocols
--         add constraint pilot_question_protocols_engine_check
--         check (engine = 'perplexity_sonar');
--       recreate 0073's protocols_one_live_baseline_per_version with 0073's
--         own statement, and only then
--         drop index if exists public.protocols_one_live_baseline_per_engine;
--       drop both probe-mode CHECKs and re-add them as 0013 wrote them.
--   * Once any ChatGPT row exists, recovery is forward only: evidence rows
--     are insert-only, and the narrower CHECKs, slot CHECK and index would
--     no longer validate. Set WORKER_CHATGPT_ENABLED to "false" and redeploy
--     the worker (it then refuses a ChatGPT protocol before admission, and
--     nothing is reserved), unset ZYPACT_PILOT_CHATGPT_ENABLED on the web
--     host, and stop adding ChatGPT slots. A ChatGPT question that can no
--     longer finish is retired with its question (step 6).

-- =======================================================================
-- 0. Preconditions
-- =======================================================================

do $$
declare
  v_def text;
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.probe_runs'::regclass
     and c.conname = 'probe_runs_probe_mode_check';
  if v_def is distinct from $d$CHECK ((probe_mode = ANY (ARRAY['simulated'::text, 'live_perplexity'::text])))$d$ then
    raise exception using
      errcode = 'P0001',
      message = format('20261109180000 precondition: probe_runs_probe_mode_check is not 0013''s (found: %s)', coalesce(v_def, 'missing'));
  end if;

  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.probe_results'::regclass
     and c.conname = 'probe_results_probe_mode_check';
  if v_def is distinct from $d$CHECK ((probe_mode = ANY (ARRAY['simulated'::text, 'live_perplexity'::text])))$d$ then
    raise exception using
      errcode = 'P0001',
      message = format('20261109180000 precondition: probe_results_probe_mode_check is not 0013''s (found: %s)', coalesce(v_def, 'missing'));
  end if;

  select pg_get_indexdef(i.indexrelid) into v_def
    from pg_index i
   where i.indexrelid = to_regclass('public.protocols_one_live_baseline_per_version');
  if v_def is distinct from $d$CREATE UNIQUE INDEX protocols_one_live_baseline_per_version ON public.protocols USING btree (buyer_question_version_id) WHERE ((status = ANY (ARRAY['approved'::text, 'active'::text])) AND (baseline_protocol_id IS NULL))$d$ then
    raise exception using
      errcode = 'P0001',
      message = format('20261109180000 precondition: the one-live-baseline index is not 0073''s (found: %s)', coalesce(v_def, 'missing'));
  end if;

  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.pilot_question_protocols'::regclass
     and c.conname = 'pilot_question_protocols_engine_check';
  if v_def is distinct from $d$CHECK ((engine = 'perplexity_sonar'::text))$d$ then
    raise exception using
      errcode = 'P0001',
      message = format('20261109180000 precondition: pilot_question_protocols_engine_check is not 20261109140000''s (found: %s)', coalesce(v_def, 'missing'));
  end if;

  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.pilot_question_protocols'::regclass
     and c.conname = 'pilot_question_protocols_phase_check';
  if v_def is distinct from $d$CHECK ((phase = 'baseline'::text))$d$ then
    raise exception using
      errcode = 'P0001',
      message = format('20261109180000 precondition: pilot_question_protocols_phase_check is not 20261109140000''s (found: %s)', coalesce(v_def, 'missing'));
  end if;

  if to_regclass('public.protocols_one_live_baseline_per_engine') is not null
     or to_regprocedure('public.add_pilot_question_engine(uuid,uuid,text,uuid)') is not null
     or to_regprocedure('public.protocol_worker_capabilities()') is not null
     or to_regprocedure('public.pilot_question_protocols_consistency()') is not null then
    raise exception using
      errcode = 'P0001',
      message = '20261109180000 precondition: an object this migration creates already exists';
  end if;

  -- The closed set of provider strings the code writes: 'perplexity_sonar'
  -- (every SQL writer), 'perplexity' (the legacy label of the same Sonar
  -- adapter, test fixtures), 'perplexity_agent' (the Agent API adapter) and
  -- 'openai_chatgpt' (lib/protocol-worker/worker.ts probeRunnerForProtocol).
  -- The engine expression below maps exactly this set, so no existing
  -- protocol can fall outside the rule.
  if exists (
    select 1
      from public.protocols p
     where p.provider not in ('perplexity', 'perplexity_sonar', 'perplexity_agent', 'openai_chatgpt')
  ) then
    raise exception using
      errcode = 'P0001',
      message = '20261109180000 precondition: a protocol names a provider outside the closed set';
  end if;

  -- A protocol attempt's probe run is the run it started
  -- (protocol_attempts.probe_run_id). The result's canonical hash includes
  -- the platform, so persisting from the run keeps every existing hash
  -- only while every such run is 'perplexity'.
  if exists (
    select 1
      from public.protocol_attempts pa
      join public.probe_runs pr on pr.id = pa.probe_run_id
     where pr.platform <> 'perplexity'
  ) then
    raise exception using
      errcode = 'P0001',
      message = '20261109180000 precondition: a protocol attempt''s probe run is not perplexity';
  end if;

  if exists (
    select 1
      from public.protocol_attempts pa
     where pa.status in ('reserved', 'in_progress')
  ) then
    raise exception using
      errcode = 'P0001',
      message = '20261109180000 precondition: a protocol attempt is reserved or in progress (stop the worker and let it settle first)';
  end if;

  if exists (
    select 1
      from public.pilot_question_protocols pqp
      join public.pilot_questions q on q.id = pqp.pilot_question_id
      join public.pilots pl on pl.id = q.pilot_id
      join public.protocols p on p.id = pqp.protocol_id
     where p.provider <> pqp.engine
        or p.project_id <> pl.project_id
        or pqp.project_id <> pl.project_id
        or p.buyer_question_version_id <> q.buyer_question_version_id
        or (pqp.phase = 'baseline' and p.baseline_protocol_id is not null)
  ) then
    raise exception using
      errcode = 'P0001',
      message = '20261109180000 precondition: an existing pilot slot does not match its protocol';
  end if;
end $$;

-- =======================================================================
-- 1. The ChatGPT probe mode
-- =======================================================================

-- Dropped by name without IF EXISTS: the precondition proved both exist, and
-- a skipped drop must never leave the narrower CHECK in place.
alter table public.probe_runs
  drop constraint probe_runs_probe_mode_check;
alter table public.probe_runs
  add constraint probe_runs_probe_mode_check
  check (probe_mode in ('simulated', 'live_perplexity', 'live_openai_chatgpt'));

alter table public.probe_results
  drop constraint probe_results_probe_mode_check;
alter table public.probe_results
  add constraint probe_results_probe_mode_check
  check (probe_mode in ('simulated', 'live_perplexity', 'live_openai_chatgpt'));

-- =======================================================================
-- 2. One live baseline per question version per engine
-- =======================================================================

-- The replacement exists before 0073's index is dropped, so there is no
-- instant in which the liveness rule is unenforced. Every row 0073's index
-- accepted is accepted here (a finer key), so it cannot fail to build.
create unique index protocols_one_live_baseline_per_engine
  on public.protocols (
    buyer_question_version_id,
    (case when provider in ('perplexity', 'perplexity_sonar', 'perplexity_agent') then 'perplexity' else provider end)
  )
  where status in ('approved', 'active')
    and baseline_protocol_id is null;

drop index public.protocols_one_live_baseline_per_version;

comment on index public.protocols_one_live_baseline_per_engine is
  'D-061: one live baseline per question version per engine. Replaces 0073''s one-per-version rule; '
  'every Perplexity provider string is one engine, so two Perplexity baselines on one version stay refused.';

-- =======================================================================
-- 3. Pilot slots: ChatGPT's engine, and each slot matches its protocol
-- =======================================================================

alter table public.pilot_question_protocols
  drop constraint pilot_question_protocols_engine_check;
alter table public.pilot_question_protocols
  add constraint pilot_question_protocols_engine_check
  check (engine in ('perplexity_sonar', 'openai_chatgpt'));

-- Defence in depth: only SECURITY DEFINER functions write the table, and
-- each writes a matching slot. Granted to nobody; a trigger runs it.
create or replace function public.pilot_question_protocols_consistency()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_question public.pilot_questions%rowtype;
  v_pilot_project_id uuid;
  v_protocol public.protocols%rowtype;
begin
  select q.* into v_question
    from public.pilot_questions q
   where q.id = new.pilot_question_id;

  if not found then
    raise exception using errcode = '23503', message = 'pilot_slot_question_not_found';
  end if;

  select pl.project_id into v_pilot_project_id
    from public.pilots pl
   where pl.id = v_question.pilot_id;

  select p.* into v_protocol
    from public.protocols p
   where p.id = new.protocol_id;

  if not found then
    raise exception using errcode = '23503', message = 'pilot_slot_protocol_not_found';
  end if;

  -- The engine is the protocol's provider: a ChatGPT heading can never sit
  -- over a Perplexity protocol, nor the reverse.
  if v_protocol.provider is distinct from new.engine then
    raise exception using errcode = '23514', message = 'pilot_slot_engine_is_not_the_protocol_provider';
  end if;

  if v_protocol.project_id is distinct from v_pilot_project_id
     or new.project_id is distinct from v_pilot_project_id then
    raise exception using errcode = '23514', message = 'pilot_slot_protocol_outside_the_pilot_project';
  end if;

  -- Every engine measures the pilot question's one approved version.
  if v_protocol.buyer_question_version_id is distinct from v_question.buyer_question_version_id then
    raise exception using errcode = '23514', message = 'pilot_slot_protocol_measures_another_question_version';
  end if;

  if new.phase = 'baseline' and v_protocol.baseline_protocol_id is not null then
    raise exception using errcode = '23514', message = 'pilot_slot_baseline_protocol_is_a_retest';
  end if;

  return new;
end;
$$;

revoke all on function public.pilot_question_protocols_consistency() from public, anon, authenticated, service_role;

drop trigger if exists pilot_question_protocols_consistency on public.pilot_question_protocols;
create trigger pilot_question_protocols_consistency
  before insert on public.pilot_question_protocols
  for each row execute function public.pilot_question_protocols_consistency();

comment on table public.pilot_question_protocols is
  'D-054, D-061: the protocol measuring a pilot question on one engine. Written only by add_pilot_question and add_pilot_question_engine; each slot matches its protocol (trigger pilot_question_protocols_consistency).';

-- =======================================================================
-- 4. persist_probe_result_for_job: the probe result's platform is the
--    probe run's. 0054's definition byte for byte apart from the two
--    marked D-061 blocks (scripts/test-chatgpt-phase-b-schema.ts proves
--    it against 0054). Its privileges are restated exactly as 0054's.
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
    -- D-061 begin: the probe run's own platform (was the literal 'perplexity').
    -- Every run started before 20261109180000 is 'perplexity' (its
    -- precondition), so their canonical hashes and replays are unchanged.
    'platform', v_probe_run.platform,
    -- D-061 end
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
    -- D-061 begin: the probe run's own platform, as in the canonical JSON above.
    v_attempt.probe_run_id, p_project_id, v_buyer_question_version.prompt_text, v_probe_run.platform, v_provider_receipt.raw_response_body,
    -- D-061 end
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
-- 5. Add the ChatGPT baseline to a pilot question
-- =======================================================================

-- add_pilot_question's sequence for a second engine of the same question:
-- the question's own approved version (never a new one, so both engines
-- measure the same approved text), its one-question paraphrase plan built
-- from that version, a protocol for the approved ChatGPT setting with the
-- founder's caps (D-059: 7 runs, 2 retries, 4 USD; the other limits as
-- Perplexity's), protocol approval, the queue, then the slot. Nothing is
-- run: the founder presses Run per question and engine, through the paid
-- execution gate and a run request like every other start.
--
-- The setting literals are CHATGPT_APPROVED_SETTING_VERSION and its model in
-- lib/probes/chatgpt.ts (scripts/test-chatgpt-phase-b-schema.ts pins them
-- equal); the worker refuses a ChatGPT protocol naming any other setting
-- before admission. The surface is 'answer', as for Perplexity: both engines
-- return a full written answer to the question.
--
-- Refusals are outcomes the console maps to words, as add_pilot_question's
-- are; an unknown engine or a missing argument raises 22023. A question that
-- already has its ChatGPT slot answers that slot (a repeated press after a
-- lost response), whatever the pilot's state is now.
create or replace function public.add_pilot_question_engine(
    p_pilot_id uuid,
    p_pilot_question_id uuid,
    p_engine text,
    p_added_by uuid
  )
returns table (
  outcome      text,
  protocol_id  uuid,
  job_id       uuid
)
language plpgsql
security definer
volatile
set search_path = public, pg_temp
as $$
declare
  v_pilot           public.pilots%rowtype;
  v_question        public.pilot_questions%rowtype;
  v_version         public.buyer_question_versions%rowtype;
  v_protocol_id     uuid;
  v_job_id          uuid;
  v_protocol_status text;
  v_enqueue_status  text;
begin
  if p_pilot_id is null or p_pilot_question_id is null or p_engine is null or p_added_by is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_add_pilot_question_engine_args';
  end if;

  -- D-061: ChatGPT is the only engine added this way. Perplexity's
  -- baseline is created with the question (add_pilot_question).
  if p_engine <> 'openai_chatgpt' then
    raise exception using
      errcode = '22023',
      message = 'pilot_question_engine_not_supported';
  end if;

  -- The lock add_pilot_question, close_pilot, retire_pilot_question and the
  -- report save take: a slot is never added beside a close, a retirement or
  -- between a report's read and its save. Every Run and retry takes it FOR
  -- SHARE before its pilot check.
  select p.* into v_pilot
    from public.pilots p
   where p.id = p_pilot_id
   for update;

  if not found then
    return query select 'PILOT_NOT_FOUND'::text, null::uuid, null::uuid;
    return;
  end if;

  select q.* into v_question
    from public.pilot_questions q
   where q.id = p_pilot_question_id
     and q.pilot_id = p_pilot_id;

  if not found then
    return query select 'QUESTION_NOT_FOUND'::text, null::uuid, null::uuid;
    return;
  end if;

  select pqp.protocol_id, j.id
    into v_protocol_id, v_job_id
    from public.pilot_question_protocols pqp
    join public.protocol_execution_jobs j on j.protocol_id = pqp.protocol_id
   where pqp.pilot_question_id = v_question.id
     and pqp.engine = p_engine
     and pqp.phase = 'baseline';

  if found then
    return query select 'ALREADY_ADDED'::text, v_protocol_id, v_job_id;
    return;
  end if;

  if v_pilot.status <> 'active' then
    return query select 'PILOT_CLOSED'::text, null::uuid, null::uuid;
    return;
  end if;

  if current_date > v_pilot.ends_on then
    return query select 'PILOT_ENDED'::text, null::uuid, null::uuid;
    return;
  end if;

  if v_question.retired_at is not null then
    return query select 'QUESTION_RETIRED'::text, null::uuid, null::uuid;
    return;
  end if;

  select v.* into v_version
    from public.buyer_question_versions v
   where v.id = v_question.buyer_question_version_id
     and v.project_id = v_pilot.project_id;

  if not found or v_version.approved_at is null then
    return query select 'VERSION_NOT_APPROVED'::text, null::uuid, null::uuid;
    return;
  end if;

  -- The question, its version and the version's text must agree, so the
  -- second engine is sent exactly the text the customer approved.
  if v_version.prompt_hash <> v_question.prompt_hash
     or encode(sha256(convert_to(v_version.prompt_text, 'UTF8')), 'hex') <> v_question.prompt_hash then
    return query select 'HASH_MISMATCH'::text, null::uuid, null::uuid;
    return;
  end if;

  insert into public.protocols (
    project_id, buyer_question_version_id, provider, surface, model_config,
    planned_baseline_runs, planned_retest_runs,
    unit_of_analysis, primary_metric, sample_planning_method,
    run_cap, spend_cap_usd, time_window_seconds,
    rate_limit_per_hour, concurrency_limit, retry_cap,
    paraphrase_plan
  ) values (
    v_pilot.project_id, v_version.id, 'openai_chatgpt', 'answer',
    jsonb_build_object(
      'model', 'gpt-5.4-2026-03-05',
      'setting_version', 'openai-responses-websearch-v4:auto:gpt-5.4-2026-03-05'
    ),
    -- D-032: 5 planned baseline runs, as Perplexity's.
    5, 0,
    'buyer_question_version', 'presence_rate', 'fixed_operator_default_pending_pilot_calibration',
    -- D-059: run_cap 7 (two runs of retry headroom above the plan) and a
    -- 4 USD cap; the time window, rate, concurrency and retry cap are
    -- Perplexity's.
    7, 4, 86400,
    10, 1, 2,
    -- The one approved question and its hash, from the version both
    -- engines measure; every planned run sends the identical text.
    jsonb_build_array(
      jsonb_build_object('text', v_version.prompt_text, 'hash', v_version.prompt_hash)
    )
  )
  returning id into v_protocol_id;

  select approval.status
    into v_protocol_status
    from public.approve_protocol(v_protocol_id, v_pilot.project_id, p_added_by) as approval;

  if v_protocol_status <> 'APPROVED' then
    raise exception using
      errcode = 'P0001',
      message = format('unexpected_protocol_approval_status:%s', v_protocol_status);
  end if;

  select enqueue.status
    into v_enqueue_status
    from public.enqueue_protocol_execution_job(v_protocol_id, v_pilot.project_id) as enqueue;

  if v_enqueue_status <> 'QUEUED' then
    raise exception using
      errcode = 'P0001',
      message = format('unexpected_protocol_execution_job_enqueue_status:%s', v_enqueue_status);
  end if;

  select j.id into v_job_id
    from public.protocol_execution_jobs j
   where j.protocol_id = v_protocol_id;

  insert into public.pilot_question_protocols (
    pilot_question_id, project_id, engine, phase, protocol_id
  ) values (
    v_question.id, v_pilot.project_id, p_engine, 'baseline', v_protocol_id
  );

  return query select 'ADDED'::text, v_protocol_id, v_job_id;
end;
$$;

revoke all on function public.add_pilot_question_engine(uuid, uuid, text, uuid) from public;
revoke all on function public.add_pilot_question_engine(uuid, uuid, text, uuid) from anon;
revoke all on function public.add_pilot_question_engine(uuid, uuid, text, uuid) from authenticated;
grant execute on function public.add_pilot_question_engine(uuid, uuid, text, uuid) to service_role;

-- =======================================================================
-- 6. retire_pilot_question over every slot of the question.
--    20261109140000's definition byte for byte apart from the marked
--    D-061 declarations and block (scripts/test-chatgpt-phase-b-schema.ts
--    proves it). The signature is unchanged; its privileges are restated.
-- =======================================================================

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
  -- D-061 begin
  v_stopped boolean := false;
  v_retryable boolean := false;
  v_slot_retryable boolean;
  -- D-061 end
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

  -- D-061 begin: every slot of the question, on every engine, and every
  -- retest of each slot. Nothing of the question may be running or about
  -- to start. Then at least one slot's job must have stopped for good:
  -- abandoned, or failed in a way the D-052 retry does not take (the same
  -- job, slot and run-cap gates as before, applied per slot). A slot that
  -- has not stopped, or that can still be retried, does not keep the
  -- question once another slot has stopped: there is no per-engine
  -- retirement, so the question is retired with every slot and its
  -- approved text may be added again (D-054 item 9). With one slot this is
  -- exactly the earlier rule and its outcomes.
  if exists (
    select 1
      from public.pilot_question_protocols pqp
      join public.protocols pr
        on pr.id = pqp.protocol_id or pr.baseline_protocol_id = pqp.protocol_id
      join public.protocol_execution_jobs j on j.protocol_id = pr.id
     where pqp.pilot_question_id = v_question.id
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

  for v_slot_protocol_id in
    select pqp.protocol_id
      from public.pilot_question_protocols pqp
     where pqp.pilot_question_id = v_question.id
       and pqp.phase = 'baseline'
     order by pqp.engine
  loop
    select j.* into v_job
      from public.protocol_execution_jobs j
     where j.protocol_id = v_slot_protocol_id;

    -- No job, or a job that has not stopped: this slot stops nothing.
    if not found or v_job.status not in ('failed', 'abandoned_exhausted') then
      continue;
    end if;

    v_slot_retryable := false;
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
        v_slot_retryable := true;
      end if;
    end if;

    if v_slot_retryable then
      v_retryable := true;
    else
      v_stopped := true;
    end if;
  end loop;

  if not v_stopped then
    if v_retryable then
      return query select 'QUESTION_RETRYABLE'::text;
    else
      return query select 'QUESTION_NOT_STOPPED'::text;
    end if;
    return;
  end if;
  -- D-061 end

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

revoke all on function public.retire_pilot_question(uuid, uuid, uuid, text) from public;
revoke all on function public.retire_pilot_question(uuid, uuid, uuid, text) from anon;
revoke all on function public.retire_pilot_question(uuid, uuid, uuid, text) from authenticated;
grant execute on function public.retire_pilot_question(uuid, uuid, uuid, text) to service_role;

-- =======================================================================
-- 7. What this schema lets the protocol worker record
-- =======================================================================

-- With WORKER_CHATGPT_ENABLED on, the worker calls this at startup and
-- refuses to start unless it lists 'live_openai_chatgpt'. A worker switched
-- on against a database without this migration finds no function and stops
-- before any claim or reservation.
create or replace function public.protocol_worker_capabilities()
returns text[]
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select array['live_openai_chatgpt']::text[];
$$;

revoke all on function public.protocol_worker_capabilities() from public;
revoke all on function public.protocol_worker_capabilities() from anon;
revoke all on function public.protocol_worker_capabilities() from authenticated;
grant execute on function public.protocol_worker_capabilities() to service_role;

-- =======================================================================
-- 8. Postconditions
-- =======================================================================

do $$
declare
  v_def text;
  v_fn text;
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.probe_runs'::regclass
     and c.conname = 'probe_runs_probe_mode_check';
  if v_def is distinct from $d$CHECK ((probe_mode = ANY (ARRAY['simulated'::text, 'live_perplexity'::text, 'live_openai_chatgpt'::text])))$d$ then
    raise exception using errcode = 'P0001', message = format('20261109180000 postcondition: probe_runs_probe_mode_check is %s', coalesce(v_def, 'missing'));
  end if;

  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.probe_results'::regclass
     and c.conname = 'probe_results_probe_mode_check';
  if v_def is distinct from $d$CHECK ((probe_mode = ANY (ARRAY['simulated'::text, 'live_perplexity'::text, 'live_openai_chatgpt'::text])))$d$ then
    raise exception using errcode = 'P0001', message = format('20261109180000 postcondition: probe_results_probe_mode_check is %s', coalesce(v_def, 'missing'));
  end if;

  -- The deparsed CASE spans lines; whitespace is compared collapsed.
  select regexp_replace(pg_get_indexdef(i.indexrelid), '\s+', ' ', 'g') into v_def
    from pg_index i
   where i.indexrelid = to_regclass('public.protocols_one_live_baseline_per_engine')
     and i.indisunique
     and i.indisvalid;
  if v_def is distinct from $d$CREATE UNIQUE INDEX protocols_one_live_baseline_per_engine ON public.protocols USING btree (buyer_question_version_id, ( CASE WHEN (provider = ANY (ARRAY['perplexity'::text, 'perplexity_sonar'::text, 'perplexity_agent'::text])) THEN 'perplexity'::text ELSE provider END)) WHERE ((status = ANY (ARRAY['approved'::text, 'active'::text])) AND (baseline_protocol_id IS NULL))$d$ then
    raise exception using errcode = 'P0001', message = format('20261109180000 postcondition: the per-engine index is %s', coalesce(v_def, 'missing'));
  end if;

  if to_regclass('public.protocols_one_live_baseline_per_version') is not null then
    raise exception using errcode = 'P0001', message = '20261109180000 postcondition: 0073''s one-per-version index still exists';
  end if;

  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.pilot_question_protocols'::regclass
     and c.conname = 'pilot_question_protocols_engine_check';
  if v_def is distinct from $d$CHECK ((engine = ANY (ARRAY['perplexity_sonar'::text, 'openai_chatgpt'::text])))$d$ then
    raise exception using errcode = 'P0001', message = format('20261109180000 postcondition: pilot_question_protocols_engine_check is %s', coalesce(v_def, 'missing'));
  end if;

  if not exists (
    select 1
      from pg_trigger t
     where t.tgrelid = 'public.pilot_question_protocols'::regclass
       and t.tgname = 'pilot_question_protocols_consistency'
       and t.tgfoid = 'public.pilot_question_protocols_consistency()'::regprocedure
       and t.tgenabled = 'O'
       and not t.tgisinternal
       -- ROW (1) + BEFORE (2) + INSERT (4), and no other event.
       and t.tgtype = 7
  ) then
    raise exception using errcode = 'P0001', message = '20261109180000 postcondition: the slot consistency trigger is missing or not BEFORE INSERT FOR EACH ROW';
  end if;

  foreach v_fn in array array[
    'public.persist_probe_result_for_job(uuid,uuid,uuid,jsonb)',
    'public.add_pilot_question_engine(uuid,uuid,text,uuid)',
    'public.retire_pilot_question(uuid,uuid,uuid,text)',
    'public.protocol_worker_capabilities()'
  ] loop
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('authenticated', v_fn, 'execute')
       or not has_function_privilege('service_role', v_fn, 'execute')
       or not (select p.prosecdef from pg_proc p where p.oid = v_fn::regprocedure) then
      raise exception using errcode = 'P0001', message = format('20261109180000 postcondition: %s is not SECURITY DEFINER for service_role only', v_fn);
    end if;
  end loop;

  if has_function_privilege('anon', 'public.pilot_question_protocols_consistency()', 'execute')
     or has_function_privilege('authenticated', 'public.pilot_question_protocols_consistency()', 'execute')
     or has_function_privilege('service_role', 'public.pilot_question_protocols_consistency()', 'execute') then
    raise exception using errcode = 'P0001', message = '20261109180000 postcondition: the trigger function is executable by a client role';
  end if;
end $$;
