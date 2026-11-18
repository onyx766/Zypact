#!/usr/bin/env tsx
/**
 * ChatGPT measurement, phase B, on a real PostgreSQL
 * (20261109180000_chatgpt_measurement.sql, D-061):
 *
 *   M  the probe modes: live_openai_chatgpt is accepted on probe_runs and
 *      probe_results, anything else is refused;
 *   E  persist_probe_result_for_job: a ChatGPT run's result is recorded as
 *      chatgpt under its own mode; a Perplexity result keeps exactly the
 *      hash 0054's function gives it (0054's own definition persists first,
 *      the new one replays it: ALREADY_PERSISTED), and 0054 would have
 *      mislabelled the ChatGPT row (CONFLICT);
 *   I  one live baseline per question version per engine: a second
 *      Perplexity baseline (any Perplexity provider string) or a second
 *      ChatGPT one is refused, Perplexity beside ChatGPT is allowed, and a
 *      retest is not a baseline;
 *   A  add_pilot_question_engine: the protocol it writes (the question's own
 *      version and plan, D-059's caps, the approved setting), the queued job,
 *      the slot; the replay; every refusal, with nothing written; and that it
 *      holds the pilot row FOR UPDATE;
 *   T  the slot trigger: an engine that is not the protocol's provider,
 *      another project, another version, a retest as a baseline; the engine
 *      and phase CHECKs;
 *   R  retire_pilot_question with two slots: refused while either slot, or a
 *      retest of one, is running or requested; retired when the ChatGPT job
 *      failed for good while Perplexity completed; RETRYABLE while the only
 *      stopped slot can be retried;
 *   O  (review of phase B) a slot stopped for good never retires a question
 *      whose other slot, or a retest of any slot, holds a run that has not
 *      finished: a Retry approved but not yet Run, a run whose worker
 *      stopped part-way, a run held for review, a retest claimed with a
 *      lapsed lease; each is retired once that run is finished, and the
 *      report save is then never left stuck; one slot keeps its earlier
 *      outcome; the header's switch-off query counts what it says;
 *   G  (review of phase B) the migration's ten preconditions, each made to
 *      refuse inside a rolled-back transaction after the header's own
 *      recovery statements restore the state before it (which proves that
 *      recovery too);
 *   C  protocol_worker_capabilities() as service_role;
 *   X  privileges, SECURITY DEFINER and search_path.
 *
 * Every attempt, call and receipt is produced through the worker's own RPCs,
 * never by writing evidence rows. Test setup done as supabase_admin touches
 * only rows that are not evidence (a run request's status, a lease time, a
 * pilot's dates, a draft protocol, a pilot question row pointing at an
 * unapproved version) and says so. 0054's persist is created under a test
 * name for the replay proof and dropped in the same session. The G cases
 * also close leftover attempts, change a CHECK, an index, a provider or a
 * probe run's platform, and every one of them is rolled back (G12).
 *
 * Since the pilot retest (20261109190000, D-062):
 *   - a retest of a pilot slot's protocol is created only by its group's
 *     preparation (trigger protocols_pilot_retest_guard, which refuses even
 *     the owner). I5, R6 and O8 plant such a retest as test setup, so each
 *     is inserted in one admin transaction with `set local
 *     session_replication_role = replica` (a declared owner bypass of that
 *     one insert); its approval and queueing still go through the real
 *     functions. T5's retest is of a protocol that is not a slot, and needs
 *     no bypass;
 *   - a retest slot passes the phase CHECK and 20261109180000's trigger, and
 *     is refused by 20261109190000's slot trigger when it names no member
 *     (T7: pilot_retest_slot_inconsistent);
 *   - G restores the state before 20261109180000 by running
 *     20261109190000's own first recovery (built from its header,
 *     scripts/lib/pilot-retest-recovery.ts) before this migration's.
 *
 * Runs against a DISPOSABLE Supabase Postgres with every migration applied
 * (scripts/run-p2-workspace-db-local.sh). Opt-in: SKIP (exit 2) without
 * ZYPACT_P2_DB_CONTAINER. No network, no provider.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { pilotRetestRecovery } from "./lib/pilot-retest-recovery";
import { db, lit, makeChecker, requireContainer, row } from "./lib/workspace-db";

const CONTAINER = requireContainer();
(globalThis as unknown as { fetch: unknown }).fetch = () => {
  throw new Error("network disabled");
};
const { psql, fails } = db(CONTAINER);
const { check, finish } = makeChecker();

const FOUNDER = randomUUID();
const WORKER = "w-chatgpt-phase-b";
const admin = (sql: string) => psql(sql, "supabase_admin");
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const question = (n: number) => `Which phase B analytics tools suit a shop of ${n} people?`;
const SETTING = "openai-responses-websearch-v4:auto:gpt-5.4-2026-03-05";
const MODEL = "gpt-5.4-2026-03-05";

/* ---------------------------------------------------------------- helpers */

/** Test setup: earlier suites in the same container may leave a pending run request or a live lease (run-control rows, not evidence). */
function quiesce(): void {
  admin(`update public.protocol_job_run_requests set status = 'expired', resolved_at = now() where status = 'pending';`);
  admin(`update public.protocol_execution_jobs set lease_expires_at = now() - interval '1 second' where status in ('claimed', 'running') and lease_expires_at > now();`);
}

function createPilot(domain: string): string[] {
  return row(psql(
    `select outcome, coalesce(pilot_id::text, ''), coalesce(project_id::text, '') from public.create_pilot(${lit(FOUNDER)}::uuid, ${lit(`Phase B Co ${domain}`)}, ${lit(`https://${domain}`)}, ${lit(domain)}, 'The customer added the DNS record we sent.', 15, current_date, ${lit(randomUUID())}::uuid);`
  ));
}

/** [outcome, pilot_question_id, protocol_id, job_id] */
function addQuestion(pilotId: string, text: string): string[] {
  return row(psql(
    `select outcome, coalesce(pilot_question_id::text, ''), coalesce(protocol_id::text, ''), coalesce(job_id::text, '') from public.add_pilot_question(${lit(pilotId)}::uuid, ${lit(FOUNDER)}::uuid, ${lit(text)}, ${lit(sha(text))}, 'customer_supplied', 'Email of 12 Nov', current_date, ${lit(randomUUID())}::uuid);`
  ));
}

const ADD_ENGINE = (pilotId: string, pq: string, engine = "openai_chatgpt") =>
  `select outcome, coalesce(protocol_id::text, ''), coalesce(job_id::text, '') from public.add_pilot_question_engine(${lit(pilotId)}::uuid, ${lit(pq)}::uuid, ${lit(engine)}, ${lit(FOUNDER)}::uuid);`;
/** [outcome, protocol_id, job_id] */
const addEngine = (pilotId: string, pq: string, engine = "openai_chatgpt") => row(psql(ADD_ENGINE(pilotId, pq, engine)));

const requestRun = (jobId: string, projectId: string) =>
  row(psql(`select outcome, coalesce(request_id::text, '') from public.request_protocol_job_run(${lit(jobId)}::uuid, ${lit(projectId)}::uuid, 'admin_pilot_run', ${lit(FOUNDER)}::uuid, 120);`));
const cancelRun = (requestId: string) => psql(`select outcome from public.cancel_protocol_job_run_request(${lit(requestId)}::uuid);`);
/** [outcome, job_id, claim_token] */
const claim = () =>
  row(psql(`select outcome, coalesce((job).id::text, ''), coalesce(claim_token::text, '') from public.claim_requested_protocol_execution_job(${lit(WORKER)}, 300);`));
const jobState = (jobId: string) =>
  row(admin(`select status, coalesce(failure_reason, '') from public.protocol_execution_jobs where id = ${lit(jobId)}::uuid;`));
const projectOfJob = (jobId: string) => admin(`select project_id from public.protocol_execution_jobs where id = ${lit(jobId)}::uuid;`);

/** Runs a Run request and the requested claim for one job; returns the claim token or "". */
function runAndClaim(jobId: string, projectId: string): string {
  const [req] = requestRun(jobId, projectId);
  if (req !== "REQUESTED") return "";
  const [out, claimed, token] = claim();
  return out === "CLAIMED" && claimed === jobId ? token : "";
}

/** Admits and reserves the current slot as the worker does; returns the attempt id. */
function admit(jobId: string, projectId: string, token: string, providerUsd: number): string {
  const ordinal = admin(`select next_baseline_ordinal from public.protocol_execution_jobs where id = ${lit(jobId)}::uuid;`);
  const [status, attempt] = row(psql(
    `select status, coalesce((attempt).id::text, '') from public.admit_and_reserve_attempt_for_job(${lit(jobId)}::uuid, ${lit(token)}::uuid, ${lit(projectId)}::uuid, 'baseline', ${lit(`${jobId}:baseline:${ordinal}`)}, ${providerUsd}, 0.02, null);`
  ));
  return status === "RESERVED" ? attempt : "";
}

const startRun = (jobId: string, projectId: string, token: string, attempt: string, platform: string, mode: string) =>
  psql(`select status from public.create_probe_run_and_start_attempt_for_job(${lit(jobId)}::uuid, ${lit(token)}::uuid, ${lit(projectId)}::uuid, ${lit(attempt)}::uuid, ${lit(platform)}, ${lit(mode)});`);

const CONTENT = JSON.stringify({
  product_mentioned: true,
  product_position: "primary",
  competitors_mentioned: [{ name: "Acme", position: 1, context: "listed first" }],
  sources_cited: [{ source: "acme-reviews.com", type: "review_site" }],
  answer_summary: "Acme is recommended as the top choice.",
  cited_as_source: false,
  client_source_count: 0,
  platforms_referenced: [],
  negative_claim_detected: false,
});
const PERSIST_ARGS = (jobId: string, token: string, projectId: string) =>
  `${lit(jobId)}::uuid, ${lit(token)}::uuid, ${lit(projectId)}::uuid, ${lit(CONTENT)}::jsonb`;

/**
 * Drives the started attempt to a completed analysis exactly as the worker
 * does (the provider leg is call_kind 'perplexity' for every engine, D-061
 * item 1), up to and excluding persist. Returns the probe run id.
 */
function receiptsFor(jobId: string, projectId: string, token: string, attempt: string, engine: "perplexity" | "chatgpt"): string {
  const probeRun = admin(`select probe_run_id from public.protocol_attempts where id = ${lit(attempt)}::uuid;`);
  const pcall = admin(`select id from public.protocol_external_calls where protocol_attempt_id = ${lit(attempt)}::uuid and call_kind = 'perplexity';`);
  const acall = admin(`select id from public.protocol_external_calls where protocol_attempt_id = ${lit(attempt)}::uuid and call_kind = 'analysis';`);
  const preq = `{"q":"${attempt}"}`;
  const answer = engine === "chatgpt"
    ? `{"object":"response","status":"completed","model":"${MODEL}","output":[{"type":"message","content":[{"type":"output_text","text":"Acme is the top choice for ${attempt}."}]}]}`
    : `{"choices":[{"message":{"content":"Acme is the top choice for ${attempt}."}}]}`;
  const cost = engine === "chatgpt" ? "0.031, 'estimated'" : "null, null";
  const areq = `analysis request for ${attempt}`;
  const content = `analysis content for ${attempt}`;
  psql(`select 1 from public.mark_external_call_sent_for_job(${lit(jobId)}::uuid, ${lit(token)}::uuid, ${lit(projectId)}::uuid, ${lit(pcall)}::uuid, ${lit(probeRun)}::uuid, 'perplexity', ${lit(preq)}, ${lit(sha(preq))});`);
  psql(`select 1 from public.record_provider_call_receipt_for_job(${lit(jobId)}::uuid, ${lit(token)}::uuid, ${lit(projectId)}::uuid, ${lit(pcall)}::uuid, ${lit(probeRun)}::uuid, 'success', 200, ${lit(`req-${pcall}`)}, ${lit(sha(answer))}, 500, ${cost}, ${lit(answer)});`);
  psql(`select 1 from public.mark_external_call_sent_for_job(${lit(jobId)}::uuid, ${lit(token)}::uuid, ${lit(projectId)}::uuid, ${lit(acall)}::uuid, ${lit(probeRun)}::uuid, 'analysis', ${lit(areq)}, ${lit(sha(areq))});`);
  psql(`select 1 from public.record_analysis_call_receipt_for_job(${lit(jobId)}::uuid, ${lit(token)}::uuid, ${lit(projectId)}::uuid, ${lit(acall)}::uuid, ${lit(probeRun)}::uuid, 'success', 'anthropic', 'claude-fixture', false, ${lit(sha(areq))}, ${lit(sha(content))}, 400, null, null, ${lit(content)}, ${lit(areq)});`);
  return probeRun;
}

/** [status, probe_result_id, canonical hash] from the current persist. */
const persist = (jobId: string, token: string, projectId: string) =>
  row(psql(`select status, coalesce(probe_result_id::text, ''), coalesce(canonical_result_sha256, '') from public.persist_probe_result_for_job(${PERSIST_ARGS(jobId, token, projectId)});`));

/**
 * 0054's own definition of persist_probe_result_for_job, created for one
 * session under a test name, called once, and dropped: what the function
 * computed before 20261109180000.
 */
const OLD_PERSIST = (() => {
  const src = readFileSync(path.join(process.cwd(), "supabase/migrations/0054_m5_worker_probe_result_and_alert_outbox.sql"), "utf8");
  const start = src.indexOf("create or replace function\n  public.persist_probe_result_for_job(");
  const end = src.indexOf("\n$$;\n", start) + "\n$$;\n".length;
  const def = src.slice(start, end);
  if (start < 0 || def.split("public.persist_probe_result_for_job(").length !== 2) throw new Error("0054's persist definition not found");
  return def.replace("public.persist_probe_result_for_job(", "public.zz_phase_b_persist_0054(");
})();
const persistAs0054 = (jobId: string, token: string, projectId: string) =>
  row(admin(`${OLD_PERSIST}\nselect status || '|' || coalesce(probe_result_id::text, '') || '|' || coalesce(canonical_result_sha256, '') from public.zz_phase_b_persist_0054(${PERSIST_ARGS(jobId, token, projectId)});\ndrop function public.zz_phase_b_persist_0054(uuid, uuid, uuid, jsonb);`));

/** Completes one started attempt (receipts, persist, reconcile, completion gate); returns the gate's status. */
function finishAttempt(jobId: string, projectId: string, token: string, attempt: string, engine: "perplexity" | "chatgpt"): string {
  receiptsFor(jobId, projectId, token, attempt, engine);
  psql(`select 1 from public.persist_probe_result_for_job(${PERSIST_ARGS(jobId, token, projectId)});`);
  psql(`select 1 from public.reconcile_attempt_for_job(${lit(jobId)}::uuid, ${lit(token)}::uuid, ${lit(projectId)}::uuid, ${lit(attempt)}::uuid, 'completed', null);`);
  return psql(`select status from public.complete_protocol_execution_job(${lit(jobId)}::uuid, ${lit(token)}::uuid, ${lit(projectId)}::uuid);`);
}

/** Runs a Perplexity job's five planned slots to a succeeded job through the worker's RPCs. */
function completeJob(jobId: string, projectId: string): string {
  const token = runAndClaim(jobId, projectId);
  let gate = "";
  for (let i = 0; i < 5 && token !== ""; i += 1) {
    const attempt = admit(jobId, projectId, token, 0.02);
    if (attempt === "" || startRun(jobId, projectId, token, attempt, "perplexity", "simulated") !== "STARTED") return "ADMISSION_FAILED";
    gate = finishAttempt(jobId, projectId, token, attempt, "perplexity");
  }
  return gate;
}

/** Drives the current slot to a provider error exactly as the worker does; returns the failed attempt. */
function failAtProvider(jobId: string, projectId: string, token: string, platform: string, mode: string, providerUsd: number): string {
  const attempt = admit(jobId, projectId, token, providerUsd);
  startRun(jobId, projectId, token, attempt, platform, mode);
  const probeRun = admin(`select probe_run_id from public.protocol_attempts where id = ${lit(attempt)}::uuid;`);
  const call = admin(`select id from public.protocol_external_calls where protocol_attempt_id = ${lit(attempt)}::uuid and call_kind = 'perplexity';`);
  const body = `{"q":"${attempt}"}`;
  psql(`select 1 from public.mark_external_call_sent_for_job(${lit(jobId)}::uuid, ${lit(token)}::uuid, ${lit(projectId)}::uuid, ${lit(call)}::uuid, ${lit(probeRun)}::uuid, 'perplexity', ${lit(body)}, ${lit(sha(body))});`);
  psql(`select 1 from public.record_provider_call_receipt_for_job(${lit(jobId)}::uuid, ${lit(token)}::uuid, ${lit(projectId)}::uuid, ${lit(call)}::uuid, ${lit(probeRun)}::uuid, 'provider_error', 429, null, null, 120, null, null, null);`);
  psql(`select 1 from public.abort_attempt_and_fail_job_for_job(${lit(jobId)}::uuid, ${lit(token)}::uuid, ${lit(projectId)}::uuid, ${lit(attempt)}::uuid, 'failed', 'provider_error', 'provider_error');`);
  return attempt;
}

/** Through the real RPCs: three claims whose leases lapse, then a Run finds the job exhausted. */
function abandon(jobId: string, projectId: string): string {
  for (let i = 0; i < 3; i += 1) {
    requestRun(jobId, projectId);
    claim();
    quiesce(); // test setup: the lease lapses
  }
  return requestRun(jobId, projectId)[0];
}

/**
 * Test setup: a draft protocol a founder could write (protocols has no CHECK on the provider), copied from another with overrides.
 * `bypass` inserts it past 20261109190000's protocols_pilot_retest_guard (a retest of a pilot slot's protocol), in its own
 * admin transaction under `set local session_replication_role = replica` (the declared owner bypass, D-062).
 */
function draftLike(protocolId: string, over: { provider?: string; versionId?: string; baselineOf?: string; bypass?: boolean } = {}): string {
  const [open, close] = over.bypass ? ["begin;\nset local session_replication_role = replica;\n", "\ncommit;"] : ["", ""];
  return admin(`${open}insert into public.protocols (project_id, buyer_question_version_id, baseline_protocol_id, provider, surface, model_config, planned_baseline_runs, planned_retest_runs, paraphrase_plan, unit_of_analysis, primary_metric, minimum_useful_change, sample_planning_method, sample_planning_assumptions, run_cap, spend_cap_usd, time_window_seconds, rate_limit_per_hour, concurrency_limit, retry_cap, observation_window_rule, analyzer_version, entity_resolution_version, methodology_version) select project_id, ${over.versionId ? `${lit(over.versionId)}::uuid` : "buyer_question_version_id"}, ${over.baselineOf ? `${lit(over.baselineOf)}::uuid` : "null"}, ${over.provider ? lit(over.provider) : "provider"}, surface, model_config, planned_baseline_runs, planned_retest_runs, paraphrase_plan, unit_of_analysis, primary_metric, minimum_useful_change, sample_planning_method, sample_planning_assumptions, run_cap, spend_cap_usd, time_window_seconds, rate_limit_per_hour, concurrency_limit, retry_cap, observation_window_rule, analyzer_version, entity_resolution_version, methodology_version from public.protocols where id = ${lit(protocolId)}::uuid returning id;${close}`);
}
const approve = (protocolId: string, projectId: string) =>
  psql(`select status from public.approve_protocol(${lit(protocolId)}::uuid, ${lit(projectId)}::uuid, ${lit(FOUNDER)}::uuid);`);
const approveFails = (protocolId: string, projectId: string) =>
  fails(`select status from public.approve_protocol(${lit(protocolId)}::uuid, ${lit(projectId)}::uuid, ${lit(FOUNDER)}::uuid);`);

/** A protocol's plan, without its identity, timestamps, approver and the three engine fields. */
const planOf = (protocolId: string) => admin(
  `select (to_jsonb(p) - array['id','created_at','updated_at','approved_at','provider','model_config','spend_cap_usd'])::text from public.protocols p where p.id = ${lit(protocolId)}::uuid;`
);
const jobShapeOf = (protocolId: string) => admin(
  `select (to_jsonb(j) - array['id','project_id','protocol_id','dataset_batch_id','created_at','updated_at'])::text from public.protocol_execution_jobs j where j.protocol_id = ${lit(protocolId)}::uuid;`
);
const countIn = (table: string, projectId: string) => admin(`select count(*) from public.${table} where project_id = ${lit(projectId)}::uuid;`);
const slotInsert = (pq: string, projectId: string, engine: string, phase: string, protocolId: string) =>
  fails(`insert into public.pilot_question_protocols (pilot_question_id, project_id, engine, phase, protocol_id) values (${lit(pq)}::uuid, ${lit(projectId)}::uuid, ${lit(engine)}, ${lit(phase)}, ${lit(protocolId)}::uuid);`, "supabase_admin");

/** Starts a background session that runs `sql` (as service_role) and keeps its transaction open; resolves with its output. */
function background(sql: string): { done: Promise<string> } {
  const child = spawn("docker", ["exec", "-i", CONTAINER, "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qtA"], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += String(d); });
  child.stderr.on("data", (d) => { out += String(d); });
  child.stdin.end(`set role service_role;\n${sql}`);
  return { done: new Promise((resolve) => child.on("close", () => resolve(out.trim()))) };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------- the migration's own guards (G) */

const MIGRATION_FILE = "supabase/migrations/20261109180000_chatgpt_measurement.sql";
const fileText = (name: string) => readFileSync(path.join(process.cwd(), "supabase/migrations", name), "utf8");
/** From `start` through the first `end` after it, inclusive; throws when either is missing (a moved source must fail loudly). */
function span(src: string, start: string, end: string): string {
  const s = src.indexOf(start);
  const e = s < 0 ? -1 : src.indexOf(end, s);
  if (s < 0 || e < 0) throw new Error(`span not found: ${start.slice(0, 60)}`);
  return src.slice(s, e + end.length);
}

/**
 * The migration header's first recovery, statement for statement and in its
 * order, built from the files it names: what restores the state before
 * 20261109180000 while no ChatGPT row exists.
 */
function headerRecovery(): string {
  // D-062: the state before 20261109190000 first (no group exists yet in
  // this container), by that migration's own header recovery.
  const s190 = pilotRetestRecovery();
  const s140 = fileText("20261109140000_pilot_questions.sql");
  const s0054 = fileText("0054_m5_worker_probe_result_and_alert_outbox.sql");
  const s0073 = fileText("0073_m7_retest_protocol_creation.sql");
  const s0013 = fileText(readdirSync(path.join(process.cwd(), "supabase/migrations")).find((f) => f.startsWith("0013_"))!);
  return [
    s190,
    "drop function if exists public.protocol_worker_capabilities();",
    span(s140, "create or replace function public.retire_pilot_question(", "\n$$;\n"),
    span(s140, "revoke all on function public.retire_pilot_question(uuid, uuid, uuid, text) from public;",
      "grant execute on function public.retire_pilot_question(uuid, uuid, uuid, text) to service_role;"),
    "drop function if exists public.add_pilot_question_engine(uuid, uuid, text, uuid);",
    span(s0054, "create or replace function\n  public.persist_probe_result_for_job(",
      "grant execute on function\n  public.persist_probe_result_for_job(uuid, uuid, uuid, jsonb) to service_role;\n"),
    "drop trigger if exists pilot_question_protocols_consistency on public.pilot_question_protocols;",
    "drop function if exists public.pilot_question_protocols_consistency();",
    span(s140, "comment on table public.pilot_question_protocols is", ";\n"),
    "alter table public.pilot_question_protocols drop constraint pilot_question_protocols_engine_check;",
    "alter table public.pilot_question_protocols add constraint pilot_question_protocols_engine_check check (engine = 'perplexity_sonar');",
    span(s0073, "create unique index if not exists protocols_one_live_baseline_per_version", ";\n"),
    span(s0073, "comment on index public.protocols_one_live_baseline_per_version is", ";\n"),
    "drop index if exists public.protocols_one_live_baseline_per_engine;",
    // 0013 is idempotent: it drops both probe-mode CHECKs and re-adds them as it wrote them.
    s0013,
  ].join("\n");
}

async function main(): Promise<void> {
  console.log("test-chatgpt-phase-b-db");
  quiesce();

  /* G: the migration's preconditions, each made to refuse ----------------- */
  // Review of phase B (DB-4). Each case runs in one transaction as the owner:
  // the header's recovery restores the state before 20261109180000 (no
  // ChatGPT row exists yet in this container), attempts other suites left
  // open are set aside, one condition is broken, and the migration file is
  // re-run. The error ends the session, which rolls everything back; a re-run
  // that does not refuse reaches the closing rollback.
  {
    const [, pilotG, projectG] = createPilot("pb-g.example");
    const [, , pxG, jobPxG] = addQuestion(pilotG, question(60));
    const MIGRATION = readFileSync(path.join(process.cwd(), MIGRATION_FILE), "utf8");
    const RESTORE = headerRecovery();
    // Test setup inside the transaction: the precondition refuses any open
    // attempt, so attempts other suites left open are closed for the
    // rehearsal (0047's reconcile_attempt), and rolled back with it.
    const SET_ASIDE = `select count(*) from (select public.reconcile_attempt(pa.id, pa.project_id, 'cancelled', 0, null, 'test setup: set aside for the precondition rehearsal') from public.protocol_attempts pa where pa.status in ('reserved', 'in_progress')) s;`;
    /** Test setup: a Run, the requested claim and an admitted attempt of the pilot's Perplexity job; optionally started on `platform` and closed. */
    const attemptOf = (platform: string | null) => `do $g$
declare v_out text; v_tok uuid; v_att uuid;
begin
  select r.outcome into v_out from public.request_protocol_job_run(${lit(jobPxG)}::uuid, ${lit(projectG)}::uuid, 'admin_pilot_run', ${lit(FOUNDER)}::uuid, 120) r;
  if v_out is distinct from 'REQUESTED' then raise exception 'G setup: the run request answered %', v_out; end if;
  select c.claim_token into v_tok from public.claim_requested_protocol_execution_job('w-g-setup', 300) c;
  if v_tok is null then raise exception 'G setup: nothing was claimed'; end if;
  select (a.attempt).id into v_att from public.admit_and_reserve_attempt_for_job(${lit(jobPxG)}::uuid, v_tok, ${lit(projectG)}::uuid, 'baseline', ${lit(`${jobPxG}:baseline:1`)}, 0.02, 0.02, null) a;
  if v_att is null then raise exception 'G setup: nothing was reserved'; end if;
${platform === null ? "" : `  perform 1 from public.create_probe_run_and_start_attempt_for_job(${lit(jobPxG)}::uuid, v_tok, ${lit(projectG)}::uuid, v_att, ${lit(platform)}, 'simulated');
  perform 1 from public.reconcile_attempt(v_att, ${lit(projectG)}::uuid, 'cancelled', 0, null, 'G setup: closed');
`}end $g$;`;
    const rerun = (setup: string) => fails(`begin;\n${RESTORE}\n${SET_ASIDE}\n${setup}\n${MIGRATION}\nrollback;`, "supabase_admin");
    const refusal = (setup: string, message: string) => {
      const err = rerun(setup);
      return { ok: err !== null && err.includes(message), detail: err === null ? "no error" : err.split("\n").find((l) => l.includes("ERROR")) ?? err };
    };
    /** The objects the migration creates or changes, and the evidence rows a setup touches: equal before and after the cases. */
    const snapshot = () => admin(
      `select string_agg(coalesce(md5(pg_get_functiondef(to_regprocedure(f))), 'missing'), ',' order by f) from unnest(array['public.persist_probe_result_for_job(uuid,uuid,uuid,jsonb)', 'public.retire_pilot_question(uuid,uuid,uuid,text)', 'public.add_pilot_question_engine(uuid,uuid,text,uuid)', 'public.protocol_worker_capabilities()', 'public.pilot_question_protocols_consistency()']) f;\n` +
      `select string_agg(conname || '=' || pg_get_constraintdef(oid), ',' order by conname) from pg_constraint where conname in ('probe_runs_probe_mode_check', 'probe_results_probe_mode_check', 'pilot_question_protocols_engine_check', 'pilot_question_protocols_phase_check');\n` +
      `select coalesce(to_regclass('public.protocols_one_live_baseline_per_engine')::text, 'none') || ',' || coalesce(to_regclass('public.protocols_one_live_baseline_per_version')::text, 'none') || ',' || (select count(*) from pg_trigger where tgname = 'pilot_question_protocols_consistency')::text || ',' || coalesce(obj_description('public.pilot_question_protocols'::regclass, 'pg_class'), '');\n` +
      `select (select count(*) from public.protocol_attempts where status in ('reserved', 'in_progress')) || ',' || (select count(*) from public.protocol_attempts) || ',' || (select count(*) from public.probe_runs) || ',' || (select string_agg(provider, ',' order by provider) from (select distinct provider from public.protocols) d) || ',' || (select count(*) from public.protocol_job_run_requests) || ',' || (select status from public.protocol_execution_jobs where id = ${lit(jobPxG)}::uuid);`);
    const before = snapshot();

    const asIs = rerun("");
    check("G1 the header's recovery statements, in its order, restore a state the migration accepts: re-run after them, it passes every guard (the control for G2 to G12)",
      asIs === null, asIs ?? "");
    const g2 = refusal("alter table public.probe_runs drop constraint probe_runs_probe_mode_check;\nalter table public.probe_runs add constraint probe_runs_probe_mode_check check (probe_mode in ('simulated', 'live_perplexity', 'live_other'));",
      "20261109180000 precondition: probe_runs_probe_mode_check is not 0013's");
    check("G2 the first precondition refuses a probe_runs probe-mode CHECK that is not 0013's", g2.ok, g2.detail);
    const g3 = refusal("alter table public.probe_results drop constraint probe_results_probe_mode_check;",
      "20261109180000 precondition: probe_results_probe_mode_check is not 0013's (found: missing)");
    check("G3 the second precondition refuses a missing probe_results probe-mode CHECK", g3.ok, g3.detail);
    const g4 = refusal("drop index public.protocols_one_live_baseline_per_version;",
      "20261109180000 precondition: the one-live-baseline index is not 0073's (found: missing)");
    check("G4 the third precondition refuses when 0073's index is missing", g4.ok, g4.detail);
    const g5 = refusal("alter table public.pilot_question_protocols drop constraint pilot_question_protocols_engine_check;\nalter table public.pilot_question_protocols add constraint pilot_question_protocols_engine_check check (engine in ('perplexity_sonar', 'openai_chatgpt'));",
      "20261109180000 precondition: pilot_question_protocols_engine_check is not 20261109140000's");
    check("G5 the fourth precondition refuses a slot engine CHECK that is not 20261109140000's", g5.ok, g5.detail);
    const g6 = refusal("alter table public.pilot_question_protocols drop constraint pilot_question_protocols_phase_check;\nalter table public.pilot_question_protocols add constraint pilot_question_protocols_phase_check check (phase in ('baseline', 'retest'));",
      "20261109180000 precondition: pilot_question_protocols_phase_check is not 20261109140000's");
    check("G6 the fifth precondition refuses a slot phase CHECK that is not 20261109140000's", g6.ok, g6.detail);
    const g7 = refusal("create function public.protocol_worker_capabilities() returns text[] language sql as $g$ select array[]::text[] $g$;",
      "20261109180000 precondition: an object this migration creates already exists");
    const g7b = refusal("create index protocols_one_live_baseline_per_engine on public.protocols (id);",
      "20261109180000 precondition: an object this migration creates already exists");
    check("G7 the sixth precondition refuses when an object it creates already exists (the capability probe; the per-engine index)",
      g7.ok && g7b.ok, `${g7.detail} | ${g7b.detail}`);
    const g8 = refusal(`insert into public.protocols (project_id, buyer_question_version_id, baseline_protocol_id, provider, surface, model_config, planned_baseline_runs, planned_retest_runs, paraphrase_plan, unit_of_analysis, primary_metric, minimum_useful_change, sample_planning_method, sample_planning_assumptions, run_cap, spend_cap_usd, time_window_seconds, rate_limit_per_hour, concurrency_limit, retry_cap, observation_window_rule, analyzer_version, entity_resolution_version, methodology_version) select project_id, buyer_question_version_id, null, 'gemini', surface, model_config, planned_baseline_runs, planned_retest_runs, paraphrase_plan, unit_of_analysis, primary_metric, minimum_useful_change, sample_planning_method, sample_planning_assumptions, run_cap, spend_cap_usd, time_window_seconds, rate_limit_per_hour, concurrency_limit, retry_cap, observation_window_rule, analyzer_version, entity_resolution_version, methodology_version from public.protocols where id = ${lit(pxG)}::uuid;`,
      "20261109180000 precondition: a protocol names a provider outside the closed set");
    check("G8 the seventh precondition refuses a protocol (here a draft) whose provider is outside the closed set", g8.ok, g8.detail);
    const g9 = refusal(attemptOf("chatgpt"), "20261109180000 precondition: a protocol attempt's probe run is not perplexity");
    check("G9 the eighth precondition refuses a protocol attempt whose probe run is not perplexity (the attempt itself closed)", g9.ok, g9.detail);
    const g10 = refusal(attemptOf(null), "20261109180000 precondition: a protocol attempt is reserved or in progress");
    check("G10 the ninth precondition refuses a reserved attempt", g10.ok, g10.detail);
    const g11 = refusal(`update public.protocols set provider = 'perplexity' where id = ${lit(pxG)}::uuid;`,
      "20261109180000 precondition: an existing pilot slot does not match its protocol");
    check("G11 the tenth precondition refuses a slot whose engine is not its protocol's provider (a provider inside the closed set)", g11.ok, g11.detail);
    const after = snapshot();
    check("G12 every re-run and its setup were rolled back: the functions, CHECKs, indexes, trigger and comment, the attempts, probe runs, providers, run requests and the setup job are as they were before G1",
      before !== "" && after === before, after === before ? "" : `${before}\n  vs\n${after}`);
  }

  /* M: probe modes ------------------------------------------------------- */
  check("M1 both probe-mode CHECKs accept exactly simulated, live_perplexity and live_openai_chatgpt",
    ["probe_runs", "probe_results"].every((t) =>
      admin(`select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.${t}'::regclass and conname = '${t}_probe_mode_check';`)
        === "CHECK ((probe_mode = ANY (ARRAY['simulated'::text, 'live_perplexity'::text, 'live_openai_chatgpt'::text])))"));

  /* A: add_pilot_question_engine, happy path ------------------------------ */
  const [outA, pilotA, projectA] = createPilot("pb-a.example");
  const [qOut, pqA, pxA] = addQuestion(pilotA, question(1));
  const [aOut, cgA, jobCgA] = addEngine(pilotA, pqA);
  check("A1 ChatGPT is added to a live pilot question: a protocol and a queued job",
    outA === "CREATED" && qOut === "ADDED" && aOut === "ADDED" && cgA !== "" && jobCgA !== "" && jobState(jobCgA)[0] === "queued");
  const [prov, surface, model, setting, status, approvedBy, spend] = row(admin(
    `select provider, surface, model_config ->> 'model', model_config ->> 'setting_version', status, approved_by::text, spend_cap_usd::text from public.protocols where id = ${lit(cgA)}::uuid;`));
  check("A2 the protocol is openai_chatgpt, a full answer, the approved setting and model, approved by the founder, with a 4 USD cap",
    prov === "openai_chatgpt" && surface === "answer" && model === MODEL && setting === SETTING && status === "approved"
      && approvedBy === FOUNDER && spend === "4", [prov, surface, model, setting, status, spend].join("|"));
  check("A3 everything else in its plan is the Perplexity baseline's: the same version, paraphrase plan, 5 runs, run cap 7, retry cap 2, limits and detectable change",
    planOf(cgA) === planOf(pxA) && planOf(cgA).includes('"run_cap": 7') && planOf(cgA).includes('"retry_cap": 2')
      && planOf(cgA).includes('"planned_baseline_runs": 5'), planOf(cgA));
  check("A4 its job starts exactly as the Perplexity job did", jobShapeOf(cgA) === jobShapeOf(pxA), jobShapeOf(cgA));
  check("A5 the slot is an openai_chatgpt baseline of the question, beside the Perplexity one",
    admin(`select string_agg(engine || ':' || phase || ':' || (protocol_id = ${lit(cgA)}::uuid or protocol_id = ${lit(pxA)}::uuid)::text, ',' order by engine) from public.pilot_question_protocols where pilot_question_id = ${lit(pqA)}::uuid;`)
      === "openai_chatgpt:baseline:true,perplexity_sonar:baseline:true");
  const before = [countIn("protocols", projectA), countIn("protocol_execution_jobs", projectA)].join(",");
  const [rOut, rProto, rJob] = addEngine(pilotA, pqA);
  check("A6 a repeated press answers the same protocol and job and writes nothing",
    rOut === "ALREADY_ADDED" && rProto === cgA && rJob === jobCgA
      && [countIn("protocols", projectA), countIn("protocol_execution_jobs", projectA)].join(",") === before
      && admin(`select count(*) from public.pilot_question_protocols where pilot_question_id = ${lit(pqA)}::uuid;`) === "2");
  check("A7 only openai_chatgpt is accepted (22023), and every argument is required",
    (fails(ADD_ENGINE(pilotA, pqA, "perplexity_sonar")) ?? "").includes("pilot_question_engine_not_supported")
      && (fails(ADD_ENGINE(pilotA, pqA, "gemini")) ?? "").includes("pilot_question_engine_not_supported")
      && (fails(`select * from public.add_pilot_question_engine(${lit(pilotA)}::uuid, null, 'openai_chatgpt', ${lit(FOUNDER)}::uuid);`) ?? "").includes("invalid_add_pilot_question_engine_args"));
  const [, pilotB, projectB] = createPilot("pb-b.example");
  const [, pqB] = addQuestion(pilotB, question(2));
  check("A8 an unknown pilot, an unknown question, or another pilot's question is not found",
    addEngine(randomUUID(), pqA)[0] === "PILOT_NOT_FOUND" && addEngine(pilotA, randomUUID())[0] === "QUESTION_NOT_FOUND"
      && addEngine(pilotB, pqA)[0] === "QUESTION_NOT_FOUND");

  // Refusals that depend on state; each writes nothing.
  const [, pqB2] = addQuestion(pilotB, question(3));
  const writtenB = () => [countIn("protocols", projectB), countIn("protocol_execution_jobs", projectB)].join(",");
  const baseB = writtenB();
  admin(`update public.pilots set starts_on = current_date - 91, ends_on = current_date - 1 where id = ${lit(pilotB)}::uuid;`); // test setup: the pilot's dates
  check("A9 a pilot past its end date refuses, and nothing is written", addEngine(pilotB, pqB)[0] === "PILOT_ENDED" && writtenB() === baseB);
  admin(`update public.pilots set starts_on = current_date, ends_on = current_date + 90 where id = ${lit(pilotB)}::uuid;`); // test setup
  // Test setup: a pilot question whose version was never approved, and one whose hash is not its version's text's.
  const unapproved = admin(`with q as (insert into public.buyer_questions (project_id) values (${lit(projectB)}::uuid) returning id, project_id),
    v as (insert into public.buyer_question_versions (buyer_question_id, project_id, version_number, prompt_text, prompt_hash, intent_type, commercial_value, winnability, priority, rationale, provenance)
          select q.id, q.project_id, 1, ${lit(question(4))}, ${lit(sha(question(4)))}, 'shortlist', 3, 3, 13, 'Test setup: never approved.', 'customer_supplied' from q returning id, project_id)
    insert into public.pilot_questions (pilot_id, project_id, ordinal, buyer_question_version_id, prompt_hash, question_provenance, customer_approval_ref, customer_approved_on, added_by, idempotency_key, request_fingerprint)
    select ${lit(pilotB)}::uuid, v.project_id, 21, v.id, ${lit(sha(question(4)))}, 'customer_supplied', 'ref', current_date, ${lit(FOUNDER)}::uuid, gen_random_uuid(), md5('pb-unapproved') from v returning id;`);
  const mismatched = admin(`with q as (insert into public.buyer_questions (project_id) values (${lit(projectB)}::uuid) returning id, project_id),
    v as (insert into public.buyer_question_versions (buyer_question_id, project_id, version_number, prompt_text, prompt_hash, intent_type, commercial_value, winnability, priority, rationale, provenance, approved_by, approved_at)
          select q.id, q.project_id, 1, ${lit(question(5))}, ${lit(sha("a different approved text"))}, 'shortlist', 3, 3, 13, 'Test setup: hash is not the text.', 'customer_supplied', ${lit(FOUNDER)}::uuid, now() from q returning id, project_id)
    insert into public.pilot_questions (pilot_id, project_id, ordinal, buyer_question_version_id, prompt_hash, question_provenance, customer_approval_ref, customer_approved_on, added_by, idempotency_key, request_fingerprint)
    select ${lit(pilotB)}::uuid, v.project_id, 22, v.id, ${lit(sha("a different approved text"))}, 'customer_supplied', 'ref', current_date, ${lit(FOUNDER)}::uuid, gen_random_uuid(), md5('pb-mismatch') from v returning id;`);
  check("A10 a question whose version is not approved refuses, and nothing is written",
    addEngine(pilotB, unapproved)[0] === "VERSION_NOT_APPROVED" && writtenB() === baseB);
  const otherHash = admin(`with q as (insert into public.buyer_questions (project_id) values (${lit(projectB)}::uuid) returning id, project_id),
    v as (insert into public.buyer_question_versions (buyer_question_id, project_id, version_number, prompt_text, prompt_hash, intent_type, commercial_value, winnability, priority, rationale, provenance, approved_by, approved_at)
          select q.id, q.project_id, 1, ${lit(question(8))}, ${lit(sha(question(8)))}, 'shortlist', 3, 3, 13, 'Test setup: the question records another hash.', 'customer_supplied', ${lit(FOUNDER)}::uuid, now() from q returning id, project_id)
    insert into public.pilot_questions (pilot_id, project_id, ordinal, buyer_question_version_id, prompt_hash, question_provenance, customer_approval_ref, customer_approved_on, added_by, idempotency_key, request_fingerprint)
    select ${lit(pilotB)}::uuid, v.project_id, 23, v.id, ${lit(sha(question(9)))}, 'customer_supplied', 'ref', current_date, ${lit(FOUNDER)}::uuid, gen_random_uuid(), md5('pb-otherhash') from v returning id;`);
  check("A11 a question whose hash is not its version's text, or not its version's hash, refuses, and nothing is written",
    addEngine(pilotB, mismatched)[0] === "HASH_MISMATCH" && addEngine(pilotB, otherHash)[0] === "HASH_MISMATCH" && writtenB() === baseB);
  // Retire the second question (abandoned) so a retired question can be tried.
  quiesce();
  const jobB2 = admin(`select pqp.protocol_id from public.pilot_question_protocols pqp where pqp.pilot_question_id = ${lit(pqB2)}::uuid;`);
  const jobOfB2 = admin(`select id from public.protocol_execution_jobs where protocol_id = ${lit(jobB2)}::uuid;`);
  const retire = (pilotId: string, pq: string) =>
    psql(`select outcome from public.retire_pilot_question(${lit(pilotId)}::uuid, ${lit(pq)}::uuid, ${lit(FOUNDER)}::uuid, 'The measurement cannot go on.');`);
  const abandonedB2 = abandon(jobOfB2, projectB);
  const baseB2 = writtenB();
  check("A12 a retired question refuses, and nothing is written",
    abandonedB2 === "JOB_ATTEMPTS_EXHAUSTED" && retire(pilotB, pqB2) === "RETIRED" && addEngine(pilotB, pqB2)[0] === "QUESTION_RETIRED" && writtenB() === baseB2);
  check("A13 a closed pilot refuses a question that has no ChatGPT slot yet, and nothing is written",
    psql(`select outcome from public.close_pilot(${lit(pilotB)}::uuid, ${lit(FOUNDER)}::uuid, 'The customer ended the pilot early.');`) === "CLOSED"
      && addEngine(pilotB, pqB)[0] === "PILOT_CLOSED" && writtenB() === baseB2);
  // A slot added before its pilot was closed, or before it ended, replays
  // with the same protocol and job (a repeated press after a lost response).
  quiesce();
  const [, pilotC, projectC] = createPilot("pb-c.example");
  const [, pqC] = addQuestion(pilotC, question(40));
  const [cAdded, cProto, cJob] = addEngine(pilotC, pqC);
  const writtenC = () => [countIn("protocols", projectC), countIn("protocol_execution_jobs", projectC)].join(",");
  const baseC = writtenC();
  const closedC = psql(`select outcome from public.close_pilot(${lit(pilotC)}::uuid, ${lit(FOUNDER)}::uuid, 'The customer ended the pilot early.');`);
  const [cAgain, cAgainProto, cAgainJob] = addEngine(pilotC, pqC);
  check("A13b a ChatGPT slot added before its pilot was closed replays after the close: ALREADY_ADDED, the same protocol and job, nothing written",
    cAdded === "ADDED" && closedC === "CLOSED" && cAgain === "ALREADY_ADDED" && cAgainProto === cProto && cAgainJob === cJob
      && cProto !== "" && cJob !== "" && writtenC() === baseC, [cAdded, closedC, cAgain].join("|"));
  const [, pilotD, projectD] = createPilot("pb-d.example");
  const [, pqD] = addQuestion(pilotD, question(41));
  const [dAdded, dProto, dJob] = addEngine(pilotD, pqD);
  const baseD = [countIn("protocols", projectD), countIn("protocol_execution_jobs", projectD)].join(",");
  admin(`update public.pilots set starts_on = current_date - 91, ends_on = current_date - 1 where id = ${lit(pilotD)}::uuid;`); // test setup: the pilot's dates pass
  const [dAgain, dAgainProto, dAgainJob] = addEngine(pilotD, pqD);
  check("A13c a ChatGPT slot added before its pilot ended replays after the end date: ALREADY_ADDED, the same protocol and job, nothing written",
    dAdded === "ADDED" && dAgain === "ALREADY_ADDED" && dAgainProto === dProto && dAgainJob === dJob && dProto !== ""
      && [countIn("protocols", projectD), countIn("protocol_execution_jobs", projectD)].join(",") === baseD, [dAdded, dAgain].join("|"));

  // The pilot row is held FOR UPDATE until the add commits.
  quiesce();
  const [, pqL] = addQuestion(pilotA, question(6));
  const marker = `zp-b1-lock-${randomUUID()}`;
  const held = background(`begin;\n${ADD_ENGINE(pilotA, pqL)}\nselect pg_sleep(6) /* ${marker} */;\ncommit;\n`);
  let waiting = false;
  for (let i = 0; i < 40 && !waiting; i += 1) {
    await sleep(250);
    waiting = admin(`select count(*) from pg_stat_activity where state = 'active' and query like ${lit(`%${marker}%`)} and pid <> pg_backend_pid();`) === "1";
  }
  const keyShare = fails(`select 1 from public.pilots where id = ${lit(pilotA)}::uuid for key share nowait;`, "supabase_admin");
  const heldOut = await held.done;
  check("A14 while an add is open, the pilot row is locked FOR UPDATE: even FOR KEY SHARE cannot take it",
    waiting && keyShare !== null && keyShare.includes("could not obtain lock on row"), keyShare ?? "not refused");
  check("A15 the held add then commits its slot", heldOut.split("\n")[0]?.startsWith("ADDED|") === true
    && admin(`select count(*) from public.pilot_question_protocols where pilot_question_id = ${lit(pqL)}::uuid;`) === "2", heldOut);

  /* I: one live baseline per version per engine --------------------------- */
  const versionA = admin(`select buyer_question_version_id from public.protocols where id = ${lit(pxA)}::uuid;`);
  const dupeOf = (provider: string) => approveFails(draftLike(pxA, { provider }), projectA) ?? "";
  check("I1 the per-engine index replaced 0073's, with 0073's predicate",
    admin(`select count(*) from pg_class where relname = 'protocols_one_live_baseline_per_version';`) === "0"
      && admin(`select indisunique::text from pg_index where indexrelid = 'public.protocols_one_live_baseline_per_engine'::regclass;`) === "true");
  check("I2 a second live Perplexity baseline on the version is refused, under every Perplexity provider string",
    ["perplexity_sonar", "perplexity", "perplexity_agent"].every((p) => dupeOf(p).includes("protocols_one_live_baseline_per_engine")));
  check("I3 a second live ChatGPT baseline on the version is refused", dupeOf("openai_chatgpt").includes("protocols_one_live_baseline_per_engine"));
  check("I4 Perplexity beside ChatGPT on one version is allowed (both are live)",
    admin(`select string_agg(provider, ',' order by provider) from public.protocols where buyer_question_version_id = ${lit(versionA)}::uuid and status in ('approved', 'active') and baseline_protocol_id is null;`)
      === "openai_chatgpt,perplexity_sonar");
  const retestOfCg = draftLike(cgA, { baselineOf: cgA, bypass: true });
  check("I5 a retest is not a baseline: a ChatGPT retest on the same version is approved beside both baselines",
    approve(retestOfCg, projectA) === "APPROVED");
  check("I6 a refused approval leaves the draft a draft",
    admin(`select count(*) from public.protocols where buyer_question_version_id = ${lit(versionA)}::uuid and status = 'draft';`) === "4");

  /* E: persist ----------------------------------------------------------- */
  quiesce();
  const [, pilotE, projectE] = createPilot("pb-e.example");
  const [, pqE, , jobPxE] = addQuestion(pilotE, question(10));
  const [, , jobCgE] = addEngine(pilotE, pqE);
  // Perplexity: 0054's own function persists first, the new one replays.
  const tokPx = runAndClaim(jobPxE, projectE);
  const attPx = tokPx ? admit(jobPxE, projectE, tokPx, 0.02) : "";
  const startedPx = attPx ? startRun(jobPxE, projectE, tokPx, attPx, "perplexity", "simulated") : "";
  if (startedPx === "STARTED") receiptsFor(jobPxE, projectE, tokPx, attPx, "perplexity");
  const [oldStatus, oldId, oldHash] = startedPx === "STARTED" ? persistAs0054(jobPxE, tokPx, projectE) : ["", "", ""];
  const [newStatus, newId, newHash] = persist(jobPxE, tokPx, projectE);
  check("E1 a Perplexity result persisted by 0054's own definition is replayed by the new one: ALREADY_PERSISTED, the same hash",
    oldStatus === "PERSISTED" && newStatus === "ALREADY_PERSISTED" && newId === oldId && newHash === oldHash && /^[0-9a-f]{64}$/.test(newHash),
    `${oldStatus}/${newStatus}`);
  check("E2 0054's test copy is gone", admin(`select count(*) from pg_proc where proname = 'zz_phase_b_persist_0054';`) === "0");
  check("E3 the Perplexity row is platform perplexity, its own mode, provider_model null",
    admin(`select platform || ':' || probe_mode || ':' || coalesce(provider_model, 'null') from public.probe_results where id = ${lit(newId)}::uuid;`) === "perplexity:simulated:null");
  psql(`select 1 from public.reconcile_attempt_for_job(${lit(jobPxE)}::uuid, ${lit(tokPx)}::uuid, ${lit(projectE)}::uuid, ${lit(attPx)}::uuid, 'completed', null);`);
  quiesce();

  // ChatGPT: the run starts under its own mode and platform; others are refused.
  const tokCg = runAndClaim(jobCgE, projectE);
  const attCg = tokCg ? admit(jobCgE, projectE, tokCg, 0.54) : "";
  const badMode = fails(`select status from public.create_probe_run_and_start_attempt_for_job(${lit(jobCgE)}::uuid, ${lit(tokCg)}::uuid, ${lit(projectE)}::uuid, ${lit(attCg)}::uuid, 'chatgpt', 'live_openai_chatgpt_v2');`) ?? "";
  const badPlatform = fails(`select status from public.create_probe_run_and_start_attempt_for_job(${lit(jobCgE)}::uuid, ${lit(tokCg)}::uuid, ${lit(projectE)}::uuid, ${lit(attCg)}::uuid, 'openai', 'live_openai_chatgpt');`) ?? "";
  check("M2 a run start with another mode or platform is refused by the CHECKs, and the attempt stays reserved",
    attCg !== "" && badMode.includes("probe_runs_probe_mode_check") && badPlatform.includes("probe_runs_platform_check")
      && admin(`select status from public.protocol_attempts where id = ${lit(attCg)}::uuid;`) === "reserved", `${badMode}|${badPlatform}`);
  check("M3 the ChatGPT run starts as platform chatgpt under live_openai_chatgpt",
    startRun(jobCgE, projectE, tokCg, attCg, "chatgpt", "live_openai_chatgpt") === "STARTED"
      && admin(`select r.platform || ':' || r.probe_mode from public.probe_runs r join public.protocol_attempts a on a.probe_run_id = r.id where a.id = ${lit(attCg)}::uuid;`) === "chatgpt:live_openai_chatgpt");
  receiptsFor(jobCgE, projectE, tokCg, attCg, "chatgpt");
  const [cgStatus, cgRow, cgHash] = persist(jobCgE, tokCg, projectE);
  check("E4 the ChatGPT result is persisted as platform chatgpt under live_openai_chatgpt, provider_model null",
    cgStatus === "PERSISTED"
      && admin(`select platform || ':' || probe_mode || ':' || coalesce(provider_model, 'null') from public.probe_results where id = ${lit(cgRow)}::uuid;`) === "chatgpt:live_openai_chatgpt:null");
  const [cgReplay, cgReplayId, cgReplayHash] = persist(jobCgE, tokCg, projectE);
  check("E5 its replay answers ALREADY_PERSISTED with the same hash", cgReplay === "ALREADY_PERSISTED" && cgReplayId === cgRow && cgReplayHash === cgHash);
  const [oldOnCg] = persistAs0054(jobCgE, tokCg, projectE);
  check("E6 0054's definition would have labelled it perplexity: its replay is a CONFLICT", oldOnCg === "CONFLICT");
  // A copy of the ChatGPT row with only the mode changed: the CHECK refuses it
  // before any key is checked, so nothing is written.
  const copyWithMode = (mode: string) => fails(`do $t$
    declare v_cols text;
    begin
      select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into v_cols
        from information_schema.columns
       where table_schema = 'public' and table_name = 'probe_results'
         and is_generated = 'NEVER' and column_name not in ('id', 'probe_mode');
      execute format('insert into public.probe_results (%s, probe_mode) select %s, %L from public.probe_results where id = %L', v_cols, v_cols, ${lit(mode)}, ${lit(cgRow)});
    end $t$;`, "supabase_admin") ?? "";
  const accepted = copyWithMode("live_openai_chatgpt");
  check("M4 probe_results refuses any other mode by its CHECK (the ChatGPT mode passes it and meets the run's key), and nothing is written",
    copyWithMode("live_unknown").includes("probe_results_probe_mode_check")
      && accepted.includes("duplicate key value") && !accepted.includes("probe_mode_check")
      && admin(`select count(*) from public.probe_results where project_id = ${lit(projectE)}::uuid;`) === "2", accepted);
  psql(`select 1 from public.reconcile_attempt_for_job(${lit(jobCgE)}::uuid, ${lit(tokCg)}::uuid, ${lit(projectE)}::uuid, ${lit(attCg)}::uuid, 'completed', null);`);
  quiesce();

  /* T: the slot trigger and CHECKs ---------------------------------------- */
  const [, pqT] = addQuestion(pilotA, question(20));
  const versionT = admin(`select buyer_question_version_id from public.pilot_questions where id = ${lit(pqT)}::uuid;`);
  const pxOnT = draftLike(pxA, { versionId: versionT });
  const cgOnOtherVersion = draftLike(cgA, { versionId: versionA });
  const cgOnT = draftLike(cgA, { versionId: versionT });
  const [, otherPilot, otherProject] = createPilot("pb-t.example");
  const [, , otherPx] = addQuestion(otherPilot, question(21));
  check("T1 a ChatGPT slot over a Perplexity protocol is refused: the engine is not the provider",
    (slotInsert(pqT, projectA, "openai_chatgpt", "baseline", pxOnT) ?? "").includes("pilot_slot_engine_is_not_the_protocol_provider"));
  check("T2 a Perplexity slot over a ChatGPT protocol is refused too",
    (slotInsert(pqT, projectA, "perplexity_sonar", "baseline", cgOnT) ?? "").includes("pilot_slot_engine_is_not_the_protocol_provider"));
  check("T3 a protocol of another project is refused",
    (slotInsert(pqT, projectA, "perplexity_sonar", "baseline", otherPx) ?? "").includes("pilot_slot_protocol_outside_the_pilot_project")
      && otherProject !== projectA);
  check("T4 a protocol measuring another question version is refused",
    (slotInsert(pqT, projectA, "openai_chatgpt", "baseline", cgOnOtherVersion) ?? "").includes("pilot_slot_protocol_measures_another_question_version"));
  const retestOnT = draftLike(cgOnT, { baselineOf: cgOnT });
  check("T5 a retest protocol cannot be a baseline slot",
    (slotInsert(pqT, projectA, "openai_chatgpt", "baseline", retestOnT) ?? "").includes("pilot_slot_baseline_protocol_is_a_retest"));
  const geminiOnT = draftLike(pxA, { versionId: versionT, provider: "gemini" });
  check("T6 an engine outside the two is refused by the engine CHECK", (slotInsert(pqT, projectA, "gemini", "baseline", geminiOnT) ?? "").includes("pilot_question_protocols_engine_check"));
  check("T7 a retest slot outside a group's preparation is refused: it passes the phase CHECK (D-062) and this trigger, and 20261109190000's slot trigger refuses a slot with no member",
    (slotInsert(pqT, projectA, "openai_chatgpt", "retest", retestOnT) ?? "").includes("pilot_retest_slot_inconsistent"));
  check("T8 none of the refused slots was written", admin(`select count(*) from public.pilot_question_protocols where pilot_question_id = ${lit(pqT)}::uuid;`) === "1");

  /* R: retire_pilot_question with two slots ------------------------------ */
  quiesce();
  const [, pilotR, projectR] = createPilot("pb-r.example");
  const [, pqR, , jobPxR] = addQuestion(pilotR, question(30));
  const [, cgR, jobCgR] = addEngine(pilotR, pqR);
  check("R1 with both measurements queued the question is not stopped", retire(pilotR, pqR) === "QUESTION_NOT_STOPPED");
  const [cgReq, cgReqId] = requestRun(jobCgR, projectR);
  check("R2 a pending Run on the ChatGPT slot blocks retirement", cgReq === "REQUESTED" && retire(pilotR, pqR) === "QUESTION_JOB_ACTIVE");
  const [cgClaim, , cgToken] = claim();
  check("R3 a live lease on the ChatGPT slot blocks it too", cgClaim === "CLAIMED" && retire(pilotR, pqR) === "QUESTION_JOB_ACTIVE" && cgReqId !== "");
  // As the worker with the ChatGPT switch off: refused before admission, nothing reserved.
  const closed = psql(`select status from public.fail_protocol_execution_job(${lit(jobCgR)}::uuid, ${lit(cgToken)}::uuid, ${lit(projectR)}::uuid, 'PROVIDER_ADAPTER_NOT_ENABLED');`);
  check("R4 the ChatGPT job is failed before admission (not a provider error, so not retryable)",
    closed === "FAILED" && jobState(jobCgR).join(":") === "failed:PROVIDER_ADAPTER_NOT_ENABLED");
  const [pxReq, pxReqId] = requestRun(jobPxR, projectR);
  check("R5 a pending Run on the Perplexity slot blocks retirement", pxReq === "REQUESTED" && retire(pilotR, pqR) === "QUESTION_JOB_ACTIVE");
  cancelRun(pxReqId);
  // A retest of the ChatGPT slot, approved and queued by the real functions (test setup: the draft create_retest_protocol would write).
  const retestR = draftLike(cgR, { baselineOf: cgR, bypass: true });
  const retestQueued = approve(retestR, projectR) === "APPROVED"
    && psql(`select status from public.enqueue_protocol_execution_job(${lit(retestR)}::uuid, ${lit(projectR)}::uuid);`) === "QUEUED";
  const retestJob = admin(`select id from public.protocol_execution_jobs where protocol_id = ${lit(retestR)}::uuid;`);
  const [rtReq, rtReqId] = requestRun(retestJob, projectR);
  check("R6 a pending Run on a retest of the ChatGPT slot blocks retirement", retestQueued && rtReq === "REQUESTED" && retire(pilotR, pqR) === "QUESTION_JOB_ACTIVE");
  cancelRun(rtReqId);
  quiesce();
  const gate = completeJob(jobPxR, projectR);
  check("R7 the Perplexity measurement completes its five runs", gate === "SUCCEEDED" && jobState(jobPxR)[0] === "succeeded",
    `${gate}:${jobState(jobPxR).join(":")}`);
  quiesce();
  check("R8 Perplexity completed and ChatGPT failed for good: the question is retired with both slots",
    retire(pilotR, pqR) === "RETIRED"
      && admin(`select count(*) from public.pilot_question_protocols where pilot_question_id = ${lit(pqR)}::uuid;`) === "2"
      && jobState(jobPxR)[0] === "succeeded" && jobState(jobCgR)[0] === "failed");
  check("R9 the retired question's ChatGPT measurement cannot be run; a repeated add only answers its existing slot",
    requestRun(jobCgR, projectR)[0] === "PILOT_QUESTION_RETIRED"
      && addEngine(pilotR, pqR).join("|") === `ALREADY_ADDED|${cgR}|${jobCgR}`);
  const [againOut, pqAgain] = addQuestion(pilotR, question(30));
  check("R10 its approved text is added again as a new question, and ChatGPT can be added to it",
    againOut === "ADDED" && pqAgain !== pqR && addEngine(pilotR, pqAgain)[0] === "ADDED");

  // A stopped slot that can still be retried does not retire the question on its own.
  quiesce();
  const [, pqR2, , jobPxR2] = addQuestion(pilotR, question(31));
  const [, , jobCgR2] = addEngine(pilotR, pqR2);
  const tokR2 = runAndClaim(jobCgR2, projectR);
  const failedCg = tokR2 ? failAtProvider(jobCgR2, projectR, tokR2, "chatgpt", "live_openai_chatgpt", 0.54) : "";
  quiesce();
  check("R11 a ChatGPT run that failed at the provider (a flex refusal) leaves its job failed and retryable",
    failedCg !== "" && jobState(jobCgR2).join(":") === "failed:provider_error");
  check("R12 with Perplexity still queued, the question is RETRYABLE, not retired", retire(pilotR, pqR2) === "QUESTION_RETRYABLE");
  check("R13 once Perplexity is abandoned, one slot has stopped for good and the question is retired",
    abandon(jobPxR2, projectR) === "JOB_ATTEMPTS_EXHAUSTED" && retire(pilotR, pqR2) === "RETIRED");

  /* O: a stopped slot never retires a question whose other run is unfinished */
  // Review of phase B (DB-1). Retiring makes Run and review refuse the
  // question, so a run left open then could never close and would hold the
  // pilot's report save for good (MEASUREMENT_IN_PROGRESS).
  quiesce();
  const [, pilotO, projectO] = createPilot("pb-o.example");
  const openOf = (protocolId: string) =>
    admin(`select coalesce(string_agg(status, ',' order by created_at), 'none') from public.protocol_attempts where protocol_id = ${lit(protocolId)}::uuid and status in ('reserved', 'in_progress');`);
  const retiredOf = (pq: string) => admin(`select (retired_at is not null)::text from public.pilot_questions where id = ${lit(pq)}::uuid;`);
  /** save_pilot_report_artifact's answer to an empty manifest: anything but MEASUREMENT_IN_PROGRESS gets past the in-progress check. */
  const saveProbe = (pilotId: string, projectId: string) =>
    row(psql(`select outcome from public.save_pilot_report_artifact(${lit(pilotId)}::uuid, ${lit(FOUNDER)}::uuid, '# probe', ${lit(JSON.stringify({ pilotId, projectId }))}::jsonb, '{"protocols":[],"attempts":[]}'::jsonb, 'needs_review', '["probe"]'::jsonb, now());`))[0];
  /** As the worker with its ChatGPT switch off: claimed, then refused before admission (failed, not a provider error, so stopped for good). */
  const stopChatGpt = (jobId: string, projectId: string) => {
    const token = runAndClaim(jobId, projectId);
    return token
      ? psql(`select status from public.fail_protocol_execution_job(${lit(jobId)}::uuid, ${lit(token)}::uuid, ${lit(projectId)}::uuid, 'PROVIDER_ADAPTER_NOT_ENABLED');`)
      : "";
  };
  /** Runs a claimed job's remaining planned slots to the completion gate; returns its last answer. */
  const finishRemaining = (jobId: string, projectId: string, token: string) => {
    let gate = "";
    for (let i = 0; i < 5 && gate !== "SUCCEEDED" && token !== ""; i += 1) {
      const attempt = admit(jobId, projectId, token, 0.02);
      if (attempt === "" || startRun(jobId, projectId, token, attempt, "perplexity", "simulated") !== "STARTED") return "ADMISSION_FAILED";
      gate = finishAttempt(jobId, projectId, token, attempt, "perplexity");
    }
    return gate;
  };
  /** The read-only query of the migration header's recovery note (DB-2), exactly as written there. */
  const RECOVERY_QUERY = (() => {
    const src = readFileSync(path.join(process.cwd(), "supabase/migrations/20261109180000_chatgpt_measurement.sql"), "utf8");
    const lines = src.split("\n");
    const start = lines.indexOf("--     The query (read-only; it reads no customer data):");
    const out: string[] = [];
    for (let i = start + 1; start >= 0 && i < lines.length; i += 1) {
      if (!lines[i].startsWith("--       ")) break;
      out.push(lines[i].slice("--       ".length));
      if (lines[i].trimEnd().endsWith(";")) break;
    }
    return out.join("\n");
  })();
  const recoveryCounts = () => admin(`begin transaction read only;\n${RECOVERY_QUERY}\nrollback;`).split("\n")[0] ?? "";

  // (a) A Retry approved on Perplexity but not yet Run; ChatGPT stopped for good.
  const [, pqOa, pxOa, jobPxOa] = addQuestion(pilotO, question(50));
  const [, cgOa, jobCgOa] = addEngine(pilotO, pqOa);
  const cgStopped = stopChatGpt(jobCgOa, projectO);
  quiesce();
  const tokOa = runAndClaim(jobPxOa, projectO);
  const failedOa = tokOa ? failAtProvider(jobPxOa, projectO, tokOa, "perplexity", "simulated", 0.02) : "";
  quiesce();
  const [retryOa, , reservedOa] = row(psql(`select outcome, coalesce(denial_code, ''), coalesce(new_attempt_id::text, '') from public.retry_failed_protocol_job(${lit(jobPxOa)}::uuid, ${lit(projectO)}::uuid, ${lit(FOUNDER)}::uuid, 'Perplexity returned HTTP 429 on run 1.', ${lit(failedOa)}::uuid, ${lit(randomUUID())});`));
  check("O1 setup: ChatGPT stopped for good; Perplexity's Retry approved and not yet Run (queued, its attempt reserved)",
    cgStopped === "FAILED" && jobState(jobCgOa).join(":") === "failed:PROVIDER_ADAPTER_NOT_ENABLED" && retryOa === "APPROVED"
      && jobState(jobPxOa)[0] === "queued" && openOf(pxOa) === "reserved" && cgOa !== "", `${cgStopped}/${retryOa}/${jobState(jobPxOa).join(":")}`);
  check("O2 (a) retiring is refused QUESTION_JOB_ACTIVE, the question stays live and the attempt stays reserved",
    retire(pilotO, pqOa) === "QUESTION_JOB_ACTIVE" && retiredOf(pqOa) === "false" && openOf(pxOa) === "reserved");
  check("O3 while that attempt is open the pilot's report save answers MEASUREMENT_IN_PROGRESS (retired now, it would answer so for good)",
    saveProbe(pilotO, projectO) === "MEASUREMENT_IN_PROGRESS");
  // The remedy the console names: press Run and let it finish.
  const tokOa2 = runAndClaim(jobPxOa, projectO);
  const startedOa = tokOa2 ? startRun(jobPxOa, projectO, tokOa2, reservedOa, "perplexity", "simulated") : "";
  const firstGate = startedOa === "STARTED" ? finishAttempt(jobPxOa, projectO, tokOa2, reservedOa, "perplexity") : "";
  const lastGate = firstGate === "NEXT_BASELINE_REQUIRED" ? finishRemaining(jobPxOa, projectO, tokOa2) : firstGate;
  quiesce();
  check("O4 once that Run finished the measurement, the question is retired, and the save gets past the in-progress check",
    startedOa === "STARTED" && lastGate === "SUCCEEDED" && openOf(pxOa) === "none"
      && retire(pilotO, pqOa) === "RETIRED" && saveProbe(pilotO, projectO) !== "MEASUREMENT_IN_PROGRESS",
    `${startedOa}/${firstGate}/${lastGate}`);

  // (b) A Perplexity run whose worker stopped part-way: lease lapsed, a sent call with no receipt.
  const [, pqOb, pxOb, jobPxOb] = addQuestion(pilotO, question(51));
  const [, , jobCgOb] = addEngine(pilotO, pqOb);
  stopChatGpt(jobCgOb, projectO);
  quiesce();
  const tokOb = runAndClaim(jobPxOb, projectO);
  const attOb = tokOb ? admit(jobPxOb, projectO, tokOb, 0.02) : "";
  const startedOb = attOb ? startRun(jobPxOb, projectO, tokOb, attOb, "perplexity", "simulated") : "";
  if (startedOb === "STARTED") {
    const probeRun = admin(`select probe_run_id from public.protocol_attempts where id = ${lit(attOb)}::uuid;`);
    const call = admin(`select id from public.protocol_external_calls where protocol_attempt_id = ${lit(attOb)}::uuid and call_kind = 'perplexity';`);
    const body = `{"q":"${attOb}"}`;
    psql(`select 1 from public.mark_external_call_sent_for_job(${lit(jobPxOb)}::uuid, ${lit(tokOb)}::uuid, ${lit(projectO)}::uuid, ${lit(call)}::uuid, ${lit(probeRun)}::uuid, 'perplexity', ${lit(body)}, ${lit(sha(body))});`);
  }
  quiesce(); // test setup: the worker died; its lease lapses
  check("O5 (b) a run whose worker stopped part-way (running, lease lapsed, attempt in progress) keeps the question: QUESTION_JOB_ACTIVE",
    startedOb === "STARTED" && jobState(jobPxOb)[0] === "running" && openOf(pxOb) === "in_progress"
      && retire(pilotO, pqOb) === "QUESTION_JOB_ACTIVE" && retiredOf(pqOb) === "false");
  // The remedy: Run again; the worker finds the unreceipted call and holds the job for review.
  const tokOb2 = runAndClaim(jobPxOb, projectO);
  const heldOb = tokOb2 ? row(psql(`select status from public.mark_protocol_execution_job_needs_review_for_ambiguity(${lit(jobPxOb)}::uuid, ${lit(tokOb2)}::uuid, ${lit(projectO)}::uuid);`))[0] : "";
  quiesce();
  check("O6 held for review with its attempt still in progress, the question is still kept",
    jobState(jobPxOb)[0] === "needs_review" && openOf(pxOb) === "in_progress" && retire(pilotO, pqOb) === "QUESTION_JOB_ACTIVE", heldOb);
  const reviewed = row(psql(`select status from public.resolve_protocol_job_review(${lit(jobPxOb)}::uuid, ${lit(projectO)}::uuid, ${lit(FOUNDER)}::uuid, 'failed', 'The Perplexity call may have been made; closing this run.');`))[0];
  check("O7 once the review closed the run (excluded, never completed), the question is retired and the save gets past the in-progress check",
    reviewed === "failed" && openOf(pxOb) === "none"
      && admin(`select status from public.protocol_attempts where id = ${lit(attOb)}::uuid;`) === "excluded"
      && retire(pilotO, pqOb) === "RETIRED" && saveProbe(pilotO, projectO) !== "MEASUREMENT_IN_PROGRESS", reviewed);

  // A retest of the stopped slot, claimed and left with a lapsed lease (no attempt at all).
  const [, pqOc, , jobPxOc] = addQuestion(pilotO, question(52));
  const [, cgOc, jobCgOc] = addEngine(pilotO, pqOc);
  stopChatGpt(jobCgOc, projectO);
  quiesce();
  const pxOcDone = completeJob(jobPxOc, projectO);
  quiesce();
  const retestOc = draftLike(cgOc, { baselineOf: cgOc, bypass: true });
  const retestOcQueued = approve(retestOc, projectO) === "APPROVED"
    && psql(`select status from public.enqueue_protocol_execution_job(${lit(retestOc)}::uuid, ${lit(projectO)}::uuid);`) === "QUEUED";
  const retestOcJob = admin(`select id from public.protocol_execution_jobs where protocol_id = ${lit(retestOc)}::uuid;`);
  const retestToken = runAndClaim(retestOcJob, projectO);
  quiesce(); // test setup: its lease lapses
  check("O8 a retest of any slot (here of the stopped ChatGPT slot) claimed with a lapsed lease keeps the question too",
    pxOcDone === "SUCCEEDED" && retestOcQueued && retestToken !== "" && jobState(retestOcJob)[0] === "claimed"
      && retire(pilotO, pqOc) === "QUESTION_JOB_ACTIVE" && retiredOf(pqOc) === "false");

  // Control: one slot. The same reserved Retry answers as before D-061.
  const [, pqOd, pxOd, jobPxOd] = addQuestion(pilotO, question(53));
  const tokOd = runAndClaim(jobPxOd, projectO);
  const failedOd = tokOd ? failAtProvider(jobPxOd, projectO, tokOd, "perplexity", "simulated", 0.02) : "";
  quiesce();
  const retryOd = row(psql(`select outcome from public.retry_failed_protocol_job(${lit(jobPxOd)}::uuid, ${lit(projectO)}::uuid, ${lit(FOUNDER)}::uuid, 'Perplexity returned HTTP 429 on run 1.', ${lit(failedOd)}::uuid, ${lit(randomUUID())});`))[0];
  check("O9 one slot: a reserved Retry keeps the outcome it had before D-061 (QUESTION_NOT_STOPPED)",
    retryOd === "APPROVED" && openOf(pxOd) === "reserved" && retire(pilotO, pqOd) === "QUESTION_NOT_STOPPED");

  // DB-2: the header's read-only query names what the switch-off order waits for.
  quiesce();
  const [, pqOe] = addQuestion(pilotO, question(54));
  const [, , jobCgOe] = addEngine(pilotO, pqOe);
  const countsAt = () => recoveryCounts().split("|").map(Number);
  const q0 = countsAt();
  const [reqOe] = requestRun(jobCgOe, projectO);
  const q1 = countsAt();
  const [claimOe, , tokOe] = claim();
  const q2 = countsAt();
  quiesce(); // test setup: the worker stops; the lease lapses
  const q3 = countsAt();
  const delta = (a: number[], b: number[]) => b.map((v, i) => v - (a[i] ?? 0)).join(",");
  check("O10 the recovery query in the migration header is read-only and counts a pending ChatGPT Run, a ChatGPT run in flight, and an unfinished one",
    RECOVERY_QUERY.startsWith("select") && RECOVERY_QUERY.trimEnd().endsWith("as chatgpt_runs_unfinished;") && q0.length === 3 && q0.every((n) => Number.isInteger(n))
      && reqOe === "REQUESTED" && delta(q0, q1) === "1,0,0"
      && claimOe === "CLAIMED" && tokOe !== "" && delta(q0, q2) === "0,1,0"
      && delta(q0, q3) === "0,0,1",
    `${q0.join(",")} → ${q1.join(",")} → ${q2.join(",")} → ${q3.join(",")}`);

  /* C: the capability probe ---------------------------------------------- */
  check("C1 protocol_worker_capabilities() lists live_openai_chatgpt to service_role",
    psql(`select array_to_string(public.protocol_worker_capabilities(), ',');`) === "live_openai_chatgpt");

  /* X: privileges --------------------------------------------------------- */
  const fns = [
    ["public.add_pilot_question_engine(uuid,uuid,text,uuid)", "search_path=public, pg_temp"],
    ["public.retire_pilot_question(uuid,uuid,uuid,text)", "search_path=public, pg_temp"],
    ["public.protocol_worker_capabilities()", "search_path=public, pg_temp"],
    ["public.persist_probe_result_for_job(uuid,uuid,uuid,jsonb)", "search_path=pg_catalog, pg_temp"],
  ] as const;
  check("X1 anon and authenticated can execute none of them; service_role can execute all",
    fns.every(([fn]) => admin(`select has_function_privilege('anon', ${lit(fn)}, 'execute')::text || has_function_privilege('authenticated', ${lit(fn)}, 'execute')::text || has_function_privilege('service_role', ${lit(fn)}, 'execute')::text;`) === "falsefalsetrue"));
  check("X2 each is SECURITY DEFINER with its pinned search_path",
    fns.every(([fn, cfg]) => admin(`select prosecdef::text || ':' || coalesce(array_to_string(proconfig, ','), '') from pg_proc where oid = ${lit(fn)}::regprocedure;`) === `true:${cfg}`));
  check("X3 no client role can execute the trigger function; the anon and authenticated roles are refused the capability probe",
    ["anon", "authenticated", "service_role"].every((r) => admin(`select has_function_privilege(${lit(r)}, 'public.pilot_question_protocols_consistency()', 'execute')::text;`) === "false")
      && ["anon", "authenticated"].every((r) => fails(`select public.protocol_worker_capabilities();`, r as "anon" | "authenticated") !== null));
  check("X4 service_role still cannot write a slot directly",
    fails(`insert into public.pilot_question_protocols (pilot_question_id, project_id, engine, phase, protocol_id) values (${lit(pqT)}::uuid, ${lit(projectA)}::uuid, 'openai_chatgpt', 'baseline', ${lit(cgOnT)}::uuid);`) !== null);

  quiesce();
  finish();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
