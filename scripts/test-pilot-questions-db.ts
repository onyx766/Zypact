#!/usr/bin/env tsx
/**
 * Pilot questions on a real PostgreSQL (20261109140000_pilot_questions.sql, D-054):
 *
 *   A  create_pilot: one project per pilot, replay and conflict, one open
 *      pilot per website, no pilot over a live request;
 *   Q  add_pilot_question: 15 questions give 15 queued jobs in ONE project,
 *      each with exactly the protocol plan a request approval writes; the
 *      limit, duplicates, the hash re-check, provenance, replay;
 *   R  a Run names its pilot job: admin_pilot_run is recorded and the
 *      requested claim takes that job only; a closed pilot, or one past its
 *      end date, cannot be run;
 *   F  the D-052 provider-failure retry works on a pilot job;
 *   P  the review's fixes: the start date window and a Run before it; a
 *      close waits for a pending Run or a live lease; the claim refuses a
 *      request recorded before the pilot ended; a retest of a pilot
 *      baseline is gated like the baseline; retiring a question whose
 *      measurement cannot go on; a retry refused for a closed pilot;
 *   K  the keys refuse a protocol or version of another project, and the
 *      slot trigger (20261109180000, D-061) refuses a slot whose engine is
 *      not its protocol's provider;
 *   X  privileges.
 *
 * Failures are produced through the worker's own RPCs, never by writing
 * evidence rows. Test setup done as supabase_admin touches only rows that are
 * not evidence (a run request's status, a lease time, a pilot's dates, and
 * the draft retest protocol create_retest_protocol would write, which is
 * then approved and queued by the real functions) and says so.
 *
 * Runs against a DISPOSABLE Supabase Postgres with every migration applied
 * (scripts/run-p2-workspace-db-local.sh). Opt-in: SKIP (exit 2) without
 * ZYPACT_P2_DB_CONTAINER. No network.
 */
import { createHash, randomUUID } from "node:crypto";

import { db, lit, makeChecker, requireContainer, row } from "./lib/workspace-db";

const CONTAINER = requireContainer();
(globalThis as unknown as { fetch: unknown }).fetch = () => {
  throw new Error("network disabled");
};
const { psql, fails } = db(CONTAINER);
const { check, finish } = makeChecker();

const FOUNDER = randomUUID();
const WORKER = "w-pilot-questions";
const admin = (sql: string) => psql(sql, "supabase_admin");
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const question = (n: number) => `Which pilot analytics tools suit a shop of ${n} people?`;

/* ---------------------------------------------------------------- helpers */

/**
 * Test setup: earlier database tests in the same container may leave a
 * pending run request or a live lease. Both are run-control rows, not
 * evidence; they are lapsed here so this file starts from a quiet worker.
 */
function quiesce(): void {
  admin(`update public.protocol_job_run_requests set status = 'expired', resolved_at = now() where status = 'pending';`);
  admin(`update public.protocol_execution_jobs set lease_expires_at = now() - interval '1 second' where status in ('claimed', 'running') and lease_expires_at > now();`);
}

function createPilot(domain: string, key = randomUUID(), limit = 15, startsOn = "current_date"): string[] {
  return row(psql(
    `select outcome, coalesce(pilot_id::text, ''), coalesce(project_id::text, '') from public.create_pilot(${lit(FOUNDER)}::uuid, ${lit(`Pilot Co ${domain}`)}, ${lit(`https://${domain}`)}, ${lit(domain)}, 'The customer added the DNS record we sent.', ${limit}, ${startsOn}, ${lit(key)}::uuid);`
  ));
}

function addQuestion(pilotId: string, text: string, opts: { key?: string; hash?: string; provenance?: string | null; ref?: string; on?: string } = {}): string[] {
  const p = opts.provenance === undefined ? lit("customer_supplied") : opts.provenance === null ? "null" : lit(opts.provenance);
  return row(psql(
    `select outcome, coalesce(pilot_question_id::text, ''), coalesce(protocol_id::text, ''), coalesce(job_id::text, '') from public.add_pilot_question(${lit(pilotId)}::uuid, ${lit(FOUNDER)}::uuid, ${lit(text)}, ${lit(opts.hash ?? sha(text))}, ${p}, ${lit(opts.ref ?? "Email 'Pilot questions' of 12 Nov")}, ${opts.on ?? "current_date"}, ${lit(opts.key ?? randomUUID())}::uuid);`
  ));
}

const requestRun = (jobId: string, projectId: string, via = "admin_pilot_run") =>
  row(psql(`select outcome, coalesce(request_id::text, '') from public.request_protocol_job_run(${lit(jobId)}::uuid, ${lit(projectId)}::uuid, ${lit(via)}, ${lit(FOUNDER)}::uuid, 120);`));

const cancelRun = (requestId: string) => psql(`select outcome from public.cancel_protocol_job_run_request(${lit(requestId)}::uuid);`);

const claim = () =>
  row(psql(`select outcome, coalesce((job).id::text, ''), coalesce(claim_token::text, '') from public.claim_requested_protocol_execution_job(${lit(WORKER)}, 300);`));

const jobState = (jobId: string) =>
  row(admin(`select status, coalesce(failure_reason, '') from public.protocol_execution_jobs where id = ${lit(jobId)}::uuid;`));

/** Drives the current slot to a provider error exactly as the worker does; returns the failed attempt. */
function failAtProvider(jobId: string, projectId: string, token: string): string {
  const ordinal = admin(`select next_baseline_ordinal from public.protocol_execution_jobs where id = ${lit(jobId)}::uuid;`);
  const [, attempt] = row(psql(
    `select status, (attempt).id from public.admit_and_reserve_attempt_for_job(${lit(jobId)}::uuid, ${lit(token)}::uuid, ${lit(projectId)}::uuid, 'baseline', ${lit(`${jobId}:baseline:${ordinal}`)}, 0.02, 0.02, null);`
  ));
  psql(`select 1 from public.create_probe_run_and_start_attempt_for_job(${lit(jobId)}::uuid, ${lit(token)}::uuid, ${lit(projectId)}::uuid, ${lit(attempt)}::uuid, 'perplexity', 'simulated');`);
  const probeRun = admin(`select probe_run_id from public.protocol_attempts where id = ${lit(attempt)}::uuid;`);
  const call = admin(`select id from public.protocol_external_calls where protocol_attempt_id = ${lit(attempt)}::uuid and call_kind = 'perplexity';`);
  const body = `{"q":"${attempt}"}`;
  psql(`select 1 from public.mark_external_call_sent_for_job(${lit(jobId)}::uuid, ${lit(token)}::uuid, ${lit(projectId)}::uuid, ${lit(call)}::uuid, ${lit(probeRun)}::uuid, 'perplexity', ${lit(body)}, ${lit(sha(body))});`);
  psql(`select 1 from public.record_provider_call_receipt_for_job(${lit(jobId)}::uuid, ${lit(token)}::uuid, ${lit(projectId)}::uuid, ${lit(call)}::uuid, ${lit(probeRun)}::uuid, 'provider_error', 500, null, null, 120, null, null, null);`);
  psql(`select 1 from public.abort_attempt_and_fail_job_for_job(${lit(jobId)}::uuid, ${lit(token)}::uuid, ${lit(projectId)}::uuid, ${lit(attempt)}::uuid, 'failed', 'provider_error', 'provider_error');`);
  return attempt;
}

/** A protocol's plan, without its identity, timestamps, approver and question. */
const planOf = (protocolId: string) => admin(
  `select (to_jsonb(p) - array['id','project_id','buyer_question_version_id','created_at','updated_at','approved_at','approved_by','paraphrase_plan'])::text from public.protocols p where p.id = ${lit(protocolId)}::uuid;`
);
const jobShapeOf = (protocolId: string) => admin(
  `select (to_jsonb(j) - array['id','project_id','protocol_id','dataset_batch_id','created_at','updated_at'])::text from public.protocol_execution_jobs j where j.protocol_id = ${lit(protocolId)}::uuid;`
);

async function main(): Promise<void> {
  console.log("test-pilot-questions-db");
  quiesce();

  /* A: create_pilot ---------------------------------------------------- */
  const keyA = randomUUID();
  const [outA, pilotA, projectA] = createPilot("pq-a.example", keyA);
  check("A1 a pilot is created with its own project", outA === "CREATED" && pilotA !== "" && projectA !== "");
  check("A2 the project carries the company and the website, and no single question as its category",
    admin(`select company_name || '|' || domain || '|' || coalesce(category, 'null') || '|' || coalesce(user_id::text, 'null') from public.projects where id = ${lit(projectA)}::uuid;`)
      === "Pilot Co pq-a.example|pq-a.example|null|null");
  check("A3 the pilot ends 90 days after it starts",
    admin(`select (ends_on - starts_on)::text from public.pilots where id = ${lit(pilotA)}::uuid;`) === "90");
  const [outA4, pilotA4, projectA4] = createPilot("pq-a.example", keyA);
  check("A4 a replay of the key answers the same pilot", outA4 === "ALREADY_CREATED" && pilotA4 === pilotA && projectA4 === projectA);
  check("A5 the key with another body is a conflict", createPilot("pq-a.example", keyA, 10)[0] === "IDEMPOTENCY_KEY_CONFLICT");
  check("A6 a second open pilot for the website is refused", createPilot("pq-a.example")[0] === "DOMAIN_HAS_LIVE_PILOT");
  psql(`select id from public.create_snapshot_request_as_founder('p@pq-busy.example', 'p@pq-busy.example', 'Busy Co', 'https://pq-busy.example', 'pq-busy.example', ${lit(question(0))}, null);`);
  check("A7 a website with a request in progress cannot start a pilot", createPilot("pq-busy.example")[0] === "DOMAIN_HAS_LIVE_REQUEST");
  check("A8 a missing website-control note is refused",
    fails(`select * from public.create_pilot(${lit(FOUNDER)}::uuid, 'Co', 'https://pq-x.example', 'pq-x.example', 'short', 15, current_date, ${lit(randomUUID())}::uuid);`)?.includes("invalid_create_pilot_args") === true);
  check("A9 a limit above 20 is refused",
    fails(`select * from public.create_pilot(${lit(FOUNDER)}::uuid, 'Co', 'https://pq-x.example', 'pq-x.example', 'The customer added our record.', 21, current_date, ${lit(randomUUID())}::uuid);`)?.includes("invalid_create_pilot_args") === true);

  /* Q: add_pilot_question ---------------------------------------------- */
  const added: Array<{ pq: string; protocol: string; job: string }> = [];
  for (let n = 1; n <= 15; n += 1) {
    const [out, pq, protocol, job] = addQuestion(pilotA, question(n), n % 2 === 0 ? { provenance: "founder_supplied" } : {});
    if (out === "ADDED") added.push({ pq, protocol, job });
  }
  check("Q1 fifteen approved questions give fifteen queued jobs", added.length === 15
    && admin(`select count(*) from public.protocol_execution_jobs where project_id = ${lit(projectA)}::uuid and status = 'queued';`) === "15");
  check("Q2 all fifteen protocols, versions and questions belong to the pilot's one project",
    admin(`select count(distinct p.project_id)::text || ':' || count(*)::text from public.protocols p where p.id in (select protocol_id from public.pilot_question_protocols pqp join public.pilot_questions q on q.id = pqp.pilot_question_id where q.pilot_id = ${lit(pilotA)}::uuid);`) === "1:15"
      && admin(`select count(*) from public.buyer_question_versions where project_id = ${lit(projectA)}::uuid and approved_at is not null;`) === "15");
  check("Q3 the questions are numbered 1 to 15",
    admin(`select string_agg(ordinal::text, ',' order by ordinal) from public.pilot_questions where pilot_id = ${lit(pilotA)}::uuid;`)
      === Array.from({ length: 15 }, (_, i) => i + 1).join(","));
  check("Q4 the sixteenth is refused at the limit", addQuestion(pilotA, question(16))[0] === "LIMIT_REACHED");

  // Parity with a founder-created request's approval, on the real functions.
  const reqP = psql(`select id from public.create_snapshot_request_as_founder('p@pq-parity.example', 'p@pq-parity.example', 'Parity Co', 'https://pq-parity.example', 'pq-parity.example', ${lit(question(99))}, null);`);
  const refProtocol = psql(`select protocol_id from public.approve_and_launch_snapshot_baseline(${lit(reqP)}::uuid, ${lit(FOUNDER)}::uuid, '["Beta Co","Gamma Co"]'::jsonb, ${lit(sha(question(99)))}, 'customer_supplied');`);
  check("Q5 every pilot protocol's plan equals a request approval's plan, column by column",
    planOf(refProtocol).includes('"run_cap": 7') && planOf(refProtocol).includes('"planned_baseline_runs": 5')
      && added.every((a) => planOf(a.protocol) === planOf(refProtocol)), planOf(added[0].protocol));
  check("Q6 every pilot job starts exactly as a request approval's job",
    jobShapeOf(refProtocol).includes('"status": "queued"')
      && added.every((a) => jobShapeOf(a.protocol) === jobShapeOf(refProtocol)), jobShapeOf(added[0].protocol));
  check("Q7 each plan sends exactly its approved question and hash",
    admin(`select (paraphrase_plan = ${lit(JSON.stringify([{ text: question(3), hash: sha(question(3)) }]))}::jsonb)::text from public.protocols where id = ${lit(added[2].protocol)}::uuid;`) === "true");
  const [prov1, rat1] = row(admin(`select v.provenance, v.rationale from public.buyer_question_versions v join public.protocols p on p.buyer_question_version_id = v.id where p.id = ${lit(added[0].protocol)}::uuid;`));
  const [prov2] = row(admin(`select v.provenance from public.buyer_question_versions v join public.protocols p on p.buyer_question_version_id = v.id where p.id = ${lit(added[1].protocol)}::uuid;`));
  check("Q8 who supplied each question is recorded, with the written approval in the rationale",
    prov1 === "customer_supplied" && prov2 === "founder_supplied" && rat1.includes("approved by the customer in writing"));

  const [, pilotB, projectB] = createPilot("pq-b.example");
  const keyQ = randomUUID();
  const [outQ, pqQ, protoQ, jobQ] = addQuestion(pilotB, question(50), { key: keyQ });
  const replayQ = addQuestion(pilotB, question(50), { key: keyQ });
  check("Q9 a replayed key answers the same question, protocol and job",
    outQ === "ADDED" && replayQ[0] === "ALREADY_ADDED" && replayQ[1] === pqQ && replayQ[2] === protoQ && replayQ[3] === jobQ);
  check("Q10 the same key for another question is a conflict", addQuestion(pilotB, question(51), { key: keyQ })[0] === "IDEMPOTENCY_KEY_CONFLICT");
  check("Q11 the same question twice is refused", addQuestion(pilotB, question(50))[0] === "DUPLICATE_QUESTION");
  check("Q12 a hash that is not the text's is refused, and nothing is created",
    addQuestion(pilotB, question(52), { hash: sha("another text") })[0] === "HASH_MISMATCH"
      && admin(`select count(*) from public.buyer_question_versions where project_id = ${lit(projectB)}::uuid;`) === "1");
  check("Q13 a question without its supplier is refused",
    fails(`select * from public.add_pilot_question(${lit(pilotB)}::uuid, ${lit(FOUNDER)}::uuid, ${lit(question(53))}, ${lit(sha(question(53)))}, null, 'Email of 12 Nov', current_date, ${lit(randomUUID())}::uuid);`)?.includes("question_provenance_required") === true);
  check("Q14 a question without the approval reference, or approved in the future, is refused",
    fails(`select * from public.add_pilot_question(${lit(pilotB)}::uuid, ${lit(FOUNDER)}::uuid, ${lit(question(54))}, ${lit(sha(question(54)))}, 'customer_supplied', ' ', current_date, ${lit(randomUUID())}::uuid);`)?.includes("invalid_add_pilot_question_args") === true
      && fails(`select * from public.add_pilot_question(${lit(pilotB)}::uuid, ${lit(FOUNDER)}::uuid, ${lit(question(55))}, ${lit(sha(question(55)))}, 'customer_supplied', 'Email of 12 Nov', current_date + 1, ${lit(randomUUID())}::uuid);`)?.includes("invalid_add_pilot_question_args") === true);
  check("Q15 an unknown pilot answers not found", addQuestion(randomUUID(), question(56))[0] === "PILOT_NOT_FOUND");

  /* R: a Run names its pilot job ---------------------------------------- */
  quiesce();
  const target = added[6];
  const older = added[0];
  check("R1 with no run request the claim takes nothing, though fifteen pilot jobs are queued", claim()[0] === "NO_RUN_REQUEST");
  const [rq, rqId] = requestRun(target.job, projectA);
  check("R2 a Run for a pilot question is recorded as admin_pilot_run by the founder",
    rq === "REQUESTED" && admin(`select requested_via || ':' || requested_by from public.protocol_job_run_requests where id = ${lit(rqId)}::uuid;`) === `admin_pilot_run:${FOUNDER}`);
  const [cOut, cJob] = claim();
  check("R3 the requested claim takes that question's job, not an older one",
    cOut === "CLAIMED" && cJob === target.job && jobState(older.job)[0] === "queued");
  quiesce();
  check("R4 an unknown start is still refused",
    fails(`select * from public.request_protocol_job_run(${lit(older.job)}::uuid, ${lit(projectA)}::uuid, 'admin_unknown', ${lit(FOUNDER)}::uuid, 120);`)?.includes("invalid_request_protocol_job_run_args") === true);
  const [nonPilotOut, nonPilotReq] = requestRun(admin(`select id from public.protocol_execution_jobs where protocol_id = ${lit(refProtocol)}::uuid;`),
    admin(`select project_id from public.protocols where id = ${lit(refProtocol)}::uuid;`), "admin_run_pipeline");
  check("R5 a request's own Run is unchanged", nonPilotOut === "REQUESTED" && cancelRun(nonPilotReq) === "CANCELLED");

  check("R6 a pilot closes with a reason, and closing again replays",
    psql(`select outcome from public.close_pilot(${lit(pilotB)}::uuid, ${lit(FOUNDER)}::uuid, 'The customer ended the pilot early.');`) === "CLOSED"
      && psql(`select outcome from public.close_pilot(${lit(pilotB)}::uuid, ${lit(FOUNDER)}::uuid, 'The customer ended the pilot early.');`) === "ALREADY_CLOSED");
  check("R7 closing records who and why, and changes no job",
    admin(`select status || ':' || closed_by || ':' || (close_reason like 'The customer ended%')::text from public.pilots where id = ${lit(pilotB)}::uuid;`) === `closed:${FOUNDER}:true`
      && jobState(jobQ)[0] === "queued");
  check("R8 a Run for a closed pilot's question is refused, and nothing is recorded",
    requestRun(jobQ, projectB)[0] === "PILOT_CLOSED"
      && admin(`select count(*) from public.protocol_job_run_requests where job_id = ${lit(jobQ)}::uuid;`) === "0");
  check("R9 no question can be added to a closed pilot", addQuestion(pilotB, question(57))[0] === "PILOT_CLOSED");
  check("R10 the website can start a new pilot once the old one is closed", createPilot("pq-b.example")[0] === "CREATED");

  const [, pilotC, projectC] = createPilot("pq-c.example");
  const [, , , jobC] = addQuestion(pilotC, question(60));
  // Test setup: move a pilot's window into the past (not evidence).
  admin(`update public.pilots set starts_on = current_date - 91, ends_on = current_date - 1 where id = ${lit(pilotC)}::uuid;`);
  check("R11 a Run for a pilot past its end date is refused", requestRun(jobC, projectC)[0] === "PILOT_CLOSED");
  check("R12 no question can be added past the end date", addQuestion(pilotC, question(61))[0] === "PILOT_ENDED");

  /* F: the provider-failure retry on a pilot job ------------------------ */
  quiesce();
  const failing = added[9];
  const [fReq] = requestRun(failing.job, projectA);
  const [fOut, fJob, fToken] = claim();
  const failedAttempt = fOut === "CLAIMED" && fJob === failing.job ? failAtProvider(failing.job, projectA, fToken) : "";
  check("F1 a pilot job that stops at the provider is failed", fReq === "REQUESTED" && jobState(failing.job).join(":") === "failed:provider_error");
  const [retryOut, , newAttempt] = row(psql(
    `select outcome, coalesce(denial_code, ''), coalesce(new_attempt_id::text, '') from public.retry_failed_protocol_job(${lit(failing.job)}::uuid, ${lit(projectA)}::uuid, ${lit(FOUNDER)}::uuid, 'Perplexity returned HTTP 500.', ${lit(failedAttempt)}::uuid, ${lit(randomUUID())});`
  ));
  check("F2 the founder retry is approved inside the protocol's caps and the job is queued again",
    retryOut === "APPROVED" && newAttempt !== "" && jobState(failing.job)[0] === "queued");
  check("F3 the failed run stays failed and on record",
    admin(`select status from public.protocol_attempts where id = ${lit(failedAttempt)}::uuid;`) === "failed");

  /* P: the review's fixes ------------------------------------------------ */
  quiesce();
  // Finding 3: the start date is bounded, and a Run waits for it.
  check("P1 a start date two days ago, or 61 days ahead, is refused, and no pilot is written",
    createPilot("pq-d1.example", randomUUID(), 15, "current_date - 2")[0] === "START_DATE_OUT_OF_RANGE"
      && createPilot("pq-d1.example", randomUUID(), 15, "current_date + 61")[0] === "START_DATE_OUT_OF_RANGE"
      && admin(`select count(*) from public.pilots where normalized_domain = 'pq-d1.example';`) === "0");
  const keyD = randomUUID();
  const [outD, pilotD, projectD] = createPilot("pq-d2.example", keyD, 15, "current_date + 60");
  check("P2 a start date 60 days ahead is accepted, and the replay is checked before the window",
    outD === "CREATED" && createPilot("pq-d2.example", keyD, 15, "current_date - 5")[0] === "IDEMPOTENCY_KEY_CONFLICT"
      && createPilot("pq-d3.example", randomUUID(), 15, "current_date - 1")[0] === "CREATED");
  const [, , , jobD] = addQuestion(pilotD, question(70));
  check("P3 a question can be added before the start, but its Run is refused and nothing is recorded",
    jobD !== "" && requestRun(jobD, projectD)[0] === "PILOT_NOT_STARTED"
      && admin(`select count(*) from public.protocol_job_run_requests where job_id = ${lit(jobD)}::uuid;`) === "0");

  // Finding 1: a close waits for a pending Run or a live lease.
  const [, pilotE, projectE] = createPilot("pq-e.example");
  const [, , , jobE] = addQuestion(pilotE, question(71));
  const closeOf = (pilotId: string) =>
    psql(`select outcome from public.close_pilot(${lit(pilotId)}::uuid, ${lit(FOUNDER)}::uuid, 'The customer ended the pilot early.');`);
  const [eOut] = requestRun(jobE, projectE);
  check("P4 a pilot with a pending Run cannot be closed", eOut === "REQUESTED" && closeOf(pilotE) === "PILOT_JOB_ACTIVE"
    && admin(`select status from public.pilots where id = ${lit(pilotE)}::uuid;`) === "active");
  const [eClaim, eJob] = claim();
  check("P5 while the worker holds the job's lease, the pilot still cannot be closed",
    eClaim === "CLAIMED" && eJob === jobE && closeOf(pilotE) === "PILOT_JOB_ACTIVE");
  quiesce(); // test setup: the lease lapses
  check("P6 once nothing is running or pending it closes, and the lapsed job cannot be resumed",
    closeOf(pilotE) === "CLOSED" && requestRun(jobE, projectE)[0] === "PILOT_CLOSED");

  // Finding 1, the second barrier: a request recorded before the pilot ended.
  const [, pilotG, projectG] = createPilot("pq-g.example");
  const [, , , jobG] = addQuestion(pilotG, question(72));
  const [gOut, gReq] = requestRun(jobG, projectG);
  // Test setup: the pilot passes its end date while the request waits (a pilot's dates).
  admin(`update public.pilots set starts_on = current_date - 91, ends_on = current_date - 1 where id = ${lit(pilotG)}::uuid;`);
  const [gClaim, gJob] = claim();
  check("P7 the claim refuses that request, records why, and leaves the job queued",
    gOut === "REQUESTED" && gClaim === "PILOT_CLOSED" && gJob === ""
      && admin(`select status || ':' || refusal_code from public.protocol_job_run_requests where id = ${lit(gReq)}::uuid;`) === "refused:PILOT_CLOSED"
      && jobState(jobG)[0] === "queued");

  // Finding 2: a retest of a pilot baseline is gated like the baseline.
  quiesce();
  const [, pilotT, projectT] = createPilot("pq-t.example");
  const [, , protoT] = addQuestion(pilotT, question(73));
  // Test setup: the draft retest protocol create_retest_protocol (0073) writes for this baseline.
  const retestProto = admin(`insert into public.protocols (project_id, buyer_question_version_id, baseline_protocol_id, provider, surface, model_config, planned_baseline_runs, planned_retest_runs, paraphrase_plan, unit_of_analysis, primary_metric, minimum_useful_change, sample_planning_method, sample_planning_assumptions, run_cap, spend_cap_usd, time_window_seconds, rate_limit_per_hour, concurrency_limit, retry_cap, observation_window_rule, analyzer_version, entity_resolution_version, methodology_version) select project_id, buyer_question_version_id, id, provider, surface, model_config, planned_baseline_runs, planned_retest_runs, paraphrase_plan, unit_of_analysis, primary_metric, minimum_useful_change, sample_planning_method, sample_planning_assumptions, run_cap, spend_cap_usd, time_window_seconds, rate_limit_per_hour, concurrency_limit, retry_cap, observation_window_rule, analyzer_version, entity_resolution_version, methodology_version from public.protocols where id = ${lit(protoT)}::uuid returning id;`);
  const retestApproved = psql(`select status from public.approve_protocol(${lit(retestProto)}::uuid, ${lit(projectT)}::uuid, ${lit(FOUNDER)}::uuid);`);
  const retestQueued = psql(`select status from public.enqueue_protocol_execution_job(${lit(retestProto)}::uuid, ${lit(projectT)}::uuid);`);
  const retestJob = admin(`select id from public.protocol_execution_jobs where protocol_id = ${lit(retestProto)}::uuid;`);
  const [tOut, tReq] = requestRun(retestJob, projectT);
  check("P8 a pilot baseline's retest can be run while the pilot is open, and blocks its close",
    retestApproved === "APPROVED" && retestQueued === "QUEUED" && tOut === "REQUESTED" && closeOf(pilotT) === "PILOT_JOB_ACTIVE");
  admin(`update public.pilots set starts_on = current_date - 91, ends_on = current_date - 1 where id = ${lit(pilotT)}::uuid;`); // test setup
  check("P9 the claim refuses the ended pilot's retest",
    claim()[0] === "PILOT_CLOSED"
      && admin(`select refusal_code from public.protocol_job_run_requests where id = ${lit(tReq)}::uuid;`) === "PILOT_CLOSED");
  check("P10 the pilot then closes, and a Run for its retest is refused",
    closeOf(pilotT) === "CLOSED" && requestRun(retestJob, projectT)[0] === "PILOT_CLOSED" && jobState(retestJob)[0] === "queued");

  // Finding 4: retiring a question whose measurement cannot go on.
  quiesce();
  const [, pilotR, projectR] = createPilot("pq-r.example", randomUUID(), 3);
  const [, pqR1, , jobR1] = addQuestion(pilotR, question(80));
  const [, pqR2, , jobR2] = addQuestion(pilotR, question(81));
  const retire = (pq: string, pilotId = pilotR) =>
    psql(`select outcome from public.retire_pilot_question(${lit(pilotId)}::uuid, ${lit(pq)}::uuid, ${lit(FOUNDER)}::uuid, 'The measurement cannot go on.');`);
  check("P11 a queued question cannot be retired", retire(pqR1) === "QUESTION_NOT_STOPPED");
  const [r1Req] = requestRun(jobR1, projectR);
  check("P12 a question with a pending Run cannot be retired", r1Req === "REQUESTED" && retire(pqR1) === "QUESTION_JOB_ACTIVE");
  const [r1Claim, , r1Token] = claim();
  const failedR1 = r1Claim === "CLAIMED" ? failAtProvider(jobR1, projectR, r1Token) : "";
  quiesce();
  check("P13 a provider failure that can still be retried is not retired",
    jobState(jobR1).join(":") === "failed:provider_error" && retire(pqR1) === "QUESTION_RETRYABLE");
  /** Through the real RPCs: three claims whose leases lapse, then a Run finds the job exhausted. */
  const abandon = (jobId: string, projectId: string): string => {
    for (let i = 0; i < 3; i += 1) {
      requestRun(jobId, projectId);
      claim();
      quiesce(); // test setup: the lease lapses
    }
    return requestRun(jobId, projectId)[0];
  };
  check("P14 a job whose worker stopped three times is abandoned",
    abandon(jobR2, projectR) === "JOB_ATTEMPTS_EXHAUSTED" && jobState(jobR2)[0] === "abandoned_exhausted");
  check("P15 an abandoned question is retired once, recording who and why",
    retire(pqR2) === "RETIRED" && retire(pqR2) === "ALREADY_RETIRED"
      && admin(`select retired_by || ':' || (retire_reason = 'The measurement cannot go on.')::text from public.pilot_questions where id = ${lit(pqR2)}::uuid;`) === `${FOUNDER}:true`);
  check("P16 a retired question's Run is refused, and its rows stay",
    requestRun(jobR2, projectR)[0] === "PILOT_QUESTION_RETIRED"
      && admin(`select count(*) from public.pilot_question_protocols where pilot_question_id = ${lit(pqR2)}::uuid;`) === "1"
      && jobState(jobR2)[0] === "abandoned_exhausted");
  const [againOut, againPq] = addQuestion(pilotR, question(81));
  check("P17 its approved text can be added again, as a new question with the next ordinal",
    againOut === "ADDED" && againPq !== pqR2 && admin(`select ordinal from public.pilot_questions where id = ${lit(againPq)}::uuid;`) === "3");
  check("P18 a live question's text is still a duplicate, and the limit counts live questions",
    addQuestion(pilotR, question(80))[0] === "DUPLICATE_QUESTION"
      && addQuestion(pilotR, question(82))[0] === "ADDED" && addQuestion(pilotR, question(83))[0] === "LIMIT_REACHED");

  // The smaller point: the retry refuses a closed pilot's job before reserving.
  quiesce();
  check("P19 the pilot closes", closeOf(pilotR) === "CLOSED");
  const [r1Retry] = row(psql(
    `select outcome, coalesce(denial_code, ''), coalesce(new_attempt_id::text, '') from public.retry_failed_protocol_job(${lit(jobR1)}::uuid, ${lit(projectR)}::uuid, ${lit(FOUNDER)}::uuid, 'Perplexity returned HTTP 500.', ${lit(failedR1)}::uuid, ${lit(randomUUID())});`
  ));
  check("P20 a retry for the closed pilot's question is refused, and nothing is reserved or reopened",
    r1Retry === "PILOT_CLOSED" && jobState(jobR1)[0] === "failed"
      && admin(`select count(*) from public.protocol_operator_actions where job_id = ${lit(jobR1)}::uuid;`) === "0");
  check("P21 a closed pilot's question cannot be retired", retire(pqR1) === "PILOT_CLOSED");

  const [, pilotL, projectL] = createPilot("pq-l.example", randomUUID(), 20);
  const limitQs = Array.from({ length: 6 }, (_, i) => addQuestion(pilotL, question(90 + i)));
  for (const q of limitQs) abandon(q[3], projectL);
  const retiredFive = limitQs.slice(0, 5).map((q) => retire(q[1], pilotL));
  check("P22 at most 5 questions of a pilot are retired",
    retiredFive.every((o) => o === "RETIRED") && retire(limitQs[5][1], pilotL) === "RETIRE_LIMIT_REACHED");

  /* K: keys refuse another project's rows ------------------------------- */
  const otherProject = admin(`select project_id from public.protocols where id = ${lit(refProtocol)}::uuid;`);
  // A question with no slot yet, so only the protocol key can refuse the
  // slot (the slot's own unique key would refuse a second slot first). The
  // whole statement fails, so nothing it inserts stays.
  const k1Sql = `with q as (insert into public.buyer_questions (project_id) values (${lit(projectA)}::uuid) returning id, project_id),
    v as (insert into public.buyer_question_versions (buyer_question_id, project_id, version_number, prompt_text, prompt_hash, intent_type, commercial_value, winnability, priority, rationale, provenance)
          select q.id, q.project_id, 1, ${lit(question(98))}, ${lit(sha(question(98)))}, 'shortlist', 3, 3, 13, 'Test setup for the protocol key.', 'customer_supplied' from q returning id, project_id),
    pq as (insert into public.pilot_questions (pilot_id, project_id, ordinal, buyer_question_version_id, prompt_hash, question_provenance, customer_approval_ref, customer_approved_on, added_by, idempotency_key, request_fingerprint)
          select ${lit(pilotA)}::uuid, v.project_id, 19, v.id, ${lit(sha(question(98)))}, 'customer_supplied', 'ref', current_date, ${lit(FOUNDER)}::uuid, gen_random_uuid(), md5('k1') from v returning id, project_id)
    insert into public.pilot_question_protocols (pilot_question_id, project_id, engine, phase, protocol_id)
    select pq.id, pq.project_id, 'perplexity_sonar', 'baseline', ${lit(refProtocol)}::uuid from pq;`;
  // D-061: the slot trigger (20261109180000) now refuses this row before the
  // key is checked. To prove the key itself still refuses it, the trigger is
  // disabled inside a transaction that the failure rolls back.
  const k1 = fails(`begin;\nalter table public.pilot_question_protocols disable trigger pilot_question_protocols_consistency;\n${k1Sql}`, "supabase_admin");
  check("K1 a pilot question cannot point at another project's protocol: the protocol key itself refuses it",
    k1 !== null && k1.includes("pilot_question_protocols_protocol_fk")
      && admin(`select count(*) from public.pilot_questions where pilot_id = ${lit(pilotA)}::uuid and ordinal = 19;`) === "0"
      && admin(`select tgenabled from pg_trigger where tgrelid = 'public.pilot_question_protocols'::regclass and tgname = 'pilot_question_protocols_consistency';`) === "O", k1 ?? "");
  const k1b = fails(k1Sql, "supabase_admin");
  check("K1b with the slot trigger on (D-061), the trigger refuses it first, and nothing stays",
    k1b !== null && k1b.includes("pilot_slot_protocol_outside_the_pilot_project")
      && admin(`select count(*) from public.pilot_questions where pilot_id = ${lit(pilotA)}::uuid and ordinal = 19;`) === "0", k1b ?? "");
  check("K2 a pilot question cannot use another project's question version",
    fails(`insert into public.pilot_questions (pilot_id, project_id, ordinal, buyer_question_version_id, prompt_hash, question_provenance, customer_approval_ref, customer_approved_on, added_by, idempotency_key, request_fingerprint) select ${lit(pilotA)}::uuid, ${lit(projectA)}::uuid, 20, v.id, v.prompt_hash, 'customer_supplied', 'ref', current_date, ${lit(FOUNDER)}::uuid, gen_random_uuid(), md5('x') from public.buyer_question_versions v where v.project_id = ${lit(otherProject)}::uuid limit 1;`, "supabase_admin") !== null);
  // D-061 changed this rule: the engine CHECK accepts ChatGPT, and a ChatGPT
  // slot exists only over a ChatGPT protocol (add_pilot_question_engine).
  // A ChatGPT slot over a Perplexity protocol is refused by the slot trigger
  // for that reason, before the protocol key (which would also refuse
  // reusing another question's protocol) is reached.
  const k3 = fails(`insert into public.pilot_question_protocols (pilot_question_id, project_id, engine, phase, protocol_id) values (${lit(added[0].pq)}::uuid, ${lit(projectA)}::uuid, 'openai_chatgpt', 'baseline', ${lit(added[1].protocol)}::uuid);`, "supabase_admin");
  check("K3 a ChatGPT slot over a Perplexity protocol is refused: its engine is not the protocol's provider (D-061)",
    k3 !== null && k3.includes("pilot_slot_engine_is_not_the_protocol_provider")
      && admin(`select count(*) from public.pilot_question_protocols where pilot_question_id = ${lit(added[0].pq)}::uuid;`) === "1", k3 ?? "");

  /* X: privileges ------------------------------------------------------- */
  const fns = [
    "public.create_pilot(uuid,text,text,text,text,integer,date,uuid)",
    "public.add_pilot_question(uuid,uuid,text,text,text,text,date,uuid)",
    "public.close_pilot(uuid,uuid,text)",
    "public.retire_pilot_question(uuid,uuid,uuid,text)",
    "public.request_protocol_job_run(uuid,uuid,text,uuid,integer)",
    "public.claim_requested_protocol_execution_job(text,integer)",
    "public.retry_failed_protocol_job(uuid,uuid,uuid,text,uuid,text)",
  ];
  check("X1 anon and authenticated can execute none of the functions; service_role can execute all",
    fns.every((fn) => admin(`select has_function_privilege('anon', ${lit(fn)}, 'execute')::text || has_function_privilege('authenticated', ${lit(fn)}, 'execute')::text || has_function_privilege('service_role', ${lit(fn)}, 'execute')::text;`) === "falsefalsetrue"));
  check("X2 every function is SECURITY DEFINER with a pinned search_path",
    fns.every((fn) => admin(`select prosecdef::text || ':' || coalesce(array_to_string(proconfig, ','), '') from pg_proc where oid = ${lit(fn)}::regprocedure;`) === "true:search_path=public, pg_temp"));
  check("X3 service_role can read but not write the three tables",
    fails(`select count(*) from public.pilots; select count(*) from public.pilot_questions; select count(*) from public.pilot_question_protocols;`) === null
      && fails(`update public.pilots set status = 'closed';`) !== null
      && fails(`delete from public.pilot_questions;`) !== null
      && fails(`insert into public.pilot_question_protocols (pilot_question_id, project_id, engine, phase, protocol_id) values (${lit(added[0].pq)}::uuid, ${lit(projectA)}::uuid, 'perplexity_sonar', 'baseline', ${lit(added[1].protocol)}::uuid);`) !== null);
  check("X4 anon and authenticated cannot read the tables",
    ["anon", "authenticated"].every((r) =>
      ["pilots", "pilot_questions", "pilot_question_protocols"].every((t) => fails(`select count(*) from public.${t};`, r as "anon" | "authenticated") !== null)));
  check("X5 RLS is on for the three tables, with no policy",
    admin(`select count(*) from pg_class where relname in ('pilots','pilot_questions','pilot_question_protocols') and relrowsecurity;`) === "3"
      && admin(`select count(*) from pg_policies where tablename in ('pilots','pilot_questions','pilot_question_protocols');`) === "0");

  quiesce();
  finish();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
