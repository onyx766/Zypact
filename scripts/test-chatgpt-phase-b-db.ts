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
 *   C  protocol_worker_capabilities() as service_role;
 *   X  privileges, SECURITY DEFINER and search_path.
 *
 * Every attempt, call and receipt is produced through the worker's own RPCs,
 * never by writing evidence rows. Test setup done as supabase_admin touches
 * only rows that are not evidence (a run request's status, a lease time, a
 * pilot's dates, a draft protocol, a pilot question row pointing at an
 * unapproved version) and says so. 0054's persist is created under a test
 * name for the replay proof and dropped in the same session.
 *
 * Runs against a DISPOSABLE Supabase Postgres with every migration applied
 * (scripts/run-p2-workspace-db-local.sh). Opt-in: SKIP (exit 2) without
 * ZYPACT_P2_DB_CONTAINER. No network, no provider.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

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

/** Test setup: a draft protocol a founder could write (protocols has no CHECK on the provider), copied from another with overrides. */
function draftLike(protocolId: string, over: { provider?: string; versionId?: string; baselineOf?: string } = {}): string {
  return admin(`insert into public.protocols (project_id, buyer_question_version_id, baseline_protocol_id, provider, surface, model_config, planned_baseline_runs, planned_retest_runs, paraphrase_plan, unit_of_analysis, primary_metric, minimum_useful_change, sample_planning_method, sample_planning_assumptions, run_cap, spend_cap_usd, time_window_seconds, rate_limit_per_hour, concurrency_limit, retry_cap, observation_window_rule, analyzer_version, entity_resolution_version, methodology_version) select project_id, ${over.versionId ? `${lit(over.versionId)}::uuid` : "buyer_question_version_id"}, ${over.baselineOf ? `${lit(over.baselineOf)}::uuid` : "null"}, ${over.provider ? lit(over.provider) : "provider"}, surface, model_config, planned_baseline_runs, planned_retest_runs, paraphrase_plan, unit_of_analysis, primary_metric, minimum_useful_change, sample_planning_method, sample_planning_assumptions, run_cap, spend_cap_usd, time_window_seconds, rate_limit_per_hour, concurrency_limit, retry_cap, observation_window_rule, analyzer_version, entity_resolution_version, methodology_version from public.protocols where id = ${lit(protocolId)}::uuid returning id;`);
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

async function main(): Promise<void> {
  console.log("test-chatgpt-phase-b-db");
  quiesce();

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
  check("A13 a closed pilot refuses, but the existing slot still replays",
    psql(`select outcome from public.close_pilot(${lit(pilotB)}::uuid, ${lit(FOUNDER)}::uuid, 'The customer ended the pilot early.');`) === "CLOSED"
      && addEngine(pilotB, pqB)[0] === "PILOT_CLOSED" && writtenB() === baseB2);
  check("A13b a slot added before the close still replays after it",
    addEngine(pilotA, pqA)[0] === "ALREADY_ADDED");

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
  const retestOfCg = draftLike(cgA, { baselineOf: cgA });
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
  check("T7 a retest slot waits for the pilot retest step: the phase CHECK refuses it",
    (slotInsert(pqT, projectA, "openai_chatgpt", "retest", retestOnT) ?? "").includes("pilot_question_protocols_phase_check"));
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
  const retestR = draftLike(cgR, { baselineOf: cgR });
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
