#!/usr/bin/env tsx
/**
 * Pilot Mode step 1 on a real PostgreSQL (20261114120000_pilot_step1_operator_controls.sql, D-052):
 *
 *   R  a run names its job: the requested claim takes that job or nothing;
 *   F  a run that failed at the provider can be retried, inside the caps,
 *      through authorize_operator_retry, and only that kind of failure;
 *   C  a failed request can be closed, which frees its website;
 *   P  who wrote a founder-created question is recorded at approval.
 *
 * Failures are produced through the worker's own RPCs (claim, admit, start,
 * mark sent, provider receipt, abort), never by writing evidence rows.
 * Negative cases that need a state the RPCs cannot reach are set up as
 * supabase_admin on rows that are not evidence (a job's reason, a call's
 * status, a protocol cap) and say so.
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
const WORKER = "w-pilot-step1";
const admin = (sql: string) => psql(sql, "supabase_admin");
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

/* ---------------------------------------------------------------- helpers */

function founderRequest(domain: string, question = "Which retail analytics tools suit small shops?"): string {
  return psql(
    `select id from public.create_snapshot_request_as_founder(${lit(`pilot@${domain}`)}, ${lit(`pilot@${domain}`)}, ${lit(`Co ${domain}`)}, ${lit(`https://${domain}`)}, ${lit(domain)}, ${lit(question)}, 'Dana');`
  );
}

function approve(requestId: string, provenance: string | null): string {
  const question = admin(`select buyer_category from public.snapshot_requests where id = ${lit(requestId)}::uuid;`);
  const p = provenance === null ? "null" : lit(provenance);
  return psql(
    `select protocol_id from public.approve_and_launch_snapshot_baseline(${lit(requestId)}::uuid, ${lit(FOUNDER)}::uuid, '["Beta Co","Gamma Co"]'::jsonb, ${lit(sha(question))}, ${p});`
  );
}

function jobOf(protocolId: string): { id: string; project: string } {
  const [id, project] = row(admin(`select id, project_id from public.protocol_execution_jobs where protocol_id = ${lit(protocolId)}::uuid;`));
  return { id, project };
}

const requestRun = (job: { id: string; project: string }, via = "admin_run_pipeline") =>
  row(psql(`select outcome, coalesce(request_id::text, ''), coalesce(expires_at::text, '') from public.request_protocol_job_run(${lit(job.id)}::uuid, ${lit(job.project)}::uuid, ${lit(via)}, ${lit(FOUNDER)}::uuid, 120);`));

const claim = () =>
  row(psql(`select outcome, coalesce((job).id::text, ''), coalesce(claim_token::text, '') from public.claim_requested_protocol_execution_job(${lit(WORKER)}, 300);`));

/** Request a run and claim it; returns the claim token. */
function runAndClaim(job: { id: string; project: string }): string {
  const [requested] = requestRun(job);
  if (requested !== "REQUESTED") throw new Error(`run not requested: ${requested}`);
  const [outcome, claimedJob, token] = claim();
  if (outcome !== "CLAIMED" || claimedJob !== job.id) throw new Error(`not claimed: ${outcome}`);
  return token;
}

/**
 * Drives the current slot to a provider error exactly as the worker does,
 * and returns [admission outcome, the attempt that failed].
 */
function failAtProvider(
  job: { id: string; project: string },
  token: string,
  how: { http: number; termination: string } = { http: 500, termination: "provider_error" }
): [string, string] {
  const ordinal = admin(`select next_baseline_ordinal from public.protocol_execution_jobs where id = ${lit(job.id)}::uuid;`);
  const [admission, attempt] = row(psql(
    `select status, (attempt).id from public.admit_and_reserve_attempt_for_job(${lit(job.id)}::uuid, ${lit(token)}::uuid, ${lit(job.project)}::uuid, 'baseline', ${lit(`${job.id}:baseline:${ordinal}`)}, 0.02, 0.02, null);`
  ));
  psql(`select 1 from public.create_probe_run_and_start_attempt_for_job(${lit(job.id)}::uuid, ${lit(token)}::uuid, ${lit(job.project)}::uuid, ${lit(attempt)}::uuid, 'perplexity', 'simulated');`);
  const probeRun = admin(`select probe_run_id from public.protocol_attempts where id = ${lit(attempt)}::uuid;`);
  const call = admin(`select id from public.protocol_external_calls where protocol_attempt_id = ${lit(attempt)}::uuid and call_kind = 'perplexity';`);
  const body = `{"q":"${attempt}"}`;
  psql(`select 1 from public.mark_external_call_sent_for_job(${lit(job.id)}::uuid, ${lit(token)}::uuid, ${lit(job.project)}::uuid, ${lit(call)}::uuid, ${lit(probeRun)}::uuid, 'perplexity', ${lit(body)}, ${lit(sha(body))});`);
  psql(`select 1 from public.record_provider_call_receipt_for_job(${lit(job.id)}::uuid, ${lit(token)}::uuid, ${lit(job.project)}::uuid, ${lit(call)}::uuid, ${lit(probeRun)}::uuid, 'provider_error', ${how.http}, null, null, 120, null, null, null);`);
  psql(`select 1 from public.abort_attempt_and_fail_job_for_job(${lit(job.id)}::uuid, ${lit(token)}::uuid, ${lit(job.project)}::uuid, ${lit(attempt)}::uuid, 'failed', ${lit(how.termination)}, 'provider_error');`);
  return [admission, attempt];
}

/**
 * The worker's path for an answer that arrived and was empty once read
 * (worker.ts closeAttemptFailed "empty_provider_answer"): a success receipt,
 * then T3 with that reason.
 */
function failWithEmptyAnswer(job: { id: string; project: string }, token: string): string {
  const ordinal = admin(`select next_baseline_ordinal from public.protocol_execution_jobs where id = ${lit(job.id)}::uuid;`);
  const [, attempt] = row(psql(
    `select status, (attempt).id from public.admit_and_reserve_attempt_for_job(${lit(job.id)}::uuid, ${lit(token)}::uuid, ${lit(job.project)}::uuid, 'baseline', ${lit(`${job.id}:baseline:${ordinal}`)}, 0.02, 0.02, null);`
  ));
  psql(`select 1 from public.create_probe_run_and_start_attempt_for_job(${lit(job.id)}::uuid, ${lit(token)}::uuid, ${lit(job.project)}::uuid, ${lit(attempt)}::uuid, 'perplexity', 'simulated');`);
  const probeRun = admin(`select probe_run_id from public.protocol_attempts where id = ${lit(attempt)}::uuid;`);
  const call = admin(`select id from public.protocol_external_calls where protocol_attempt_id = ${lit(attempt)}::uuid and call_kind = 'perplexity';`);
  const body = `{"q":"${attempt}"}`;
  psql(`select 1 from public.mark_external_call_sent_for_job(${lit(job.id)}::uuid, ${lit(token)}::uuid, ${lit(job.project)}::uuid, ${lit(call)}::uuid, ${lit(probeRun)}::uuid, 'perplexity', ${lit(body)}, ${lit(sha(body))});`);
  const reply = `{"choices":[{"message":{"content":""}}],"id":"${attempt}"}`;
  psql(`select 1 from public.record_provider_call_receipt_for_job(${lit(job.id)}::uuid, ${lit(token)}::uuid, ${lit(job.project)}::uuid, ${lit(call)}::uuid, ${lit(probeRun)}::uuid, 'success', 200, null, ${lit(sha(reply))}, 120, null, null, ${lit(reply)});`);
  psql(`select 1 from public.abort_attempt_and_fail_job_for_job(${lit(job.id)}::uuid, ${lit(token)}::uuid, ${lit(job.project)}::uuid, ${lit(attempt)}::uuid, 'failed', 'empty_provider_answer', 'empty_provider_answer');`);
  return attempt;
}

const retry = (job: { id: string; project: string }, source: string, key: string, reason = "Provider returned an error on this run.") =>
  row(psql(`select outcome, coalesce(denial_code, ''), coalesce(new_attempt_id::text, '') from public.retry_failed_protocol_job(${lit(job.id)}::uuid, ${lit(job.project)}::uuid, ${lit(FOUNDER)}::uuid, ${lit(reason)}, ${lit(source)}::uuid, ${lit(key)});`));

const close = (requestId: string, reason = "The provider failed and the customer agreed to stop.") =>
  psql(`select outcome from public.close_failed_snapshot_request(${lit(requestId)}::uuid, ${lit(FOUNDER)}::uuid, ${lit(reason)});`);

const jobState = (job: { id: string }) =>
  row(admin(`select status, attempt_count, coalesce(current_attempt_id::text, ''), coalesce(failure_reason, ''), coalesce(lease_expires_at::text, ''), coalesce(needs_review_reason, '') from public.protocol_execution_jobs where id = ${lit(job.id)}::uuid;`));

/** A checksum of one attempt's own evidence: its row, its calls, their receipts and request bodies. */
const attemptEvidence = (attemptId: string) => admin(`
  select md5(coalesce(string_agg(x, '|' order by x), '')) from (
    select 'a:' || pa.id || ':' || pa.status || ':' || coalesce(pa.termination_reason, '') || ':' || pa.reserved_cost_usd
           || ':' || coalesce(pa.actual_cost_usd::text, '') || ':' || coalesce(pa.terminalized_at::text, '') as x
      from public.protocol_attempts pa where pa.id = ${lit(attemptId)}::uuid
    union all
    select 'c:' || ec.id || ':' || ec.status || ':' || ec.reserved_cost_usd || ':' || coalesce(ec.actual_cost_usd::text, '')
           || ':' || coalesce(ec.request_sent_at::text, '') || ':' || coalesce(ec.terminalized_at::text, '')
      from public.protocol_external_calls ec where ec.protocol_attempt_id = ${lit(attemptId)}::uuid
    union all
    select 'r:' || r.id || ':' || r.outcome || ':' || coalesce(r.http_status::text, '') || ':' || coalesce(r.raw_response_sha256, '')
      from public.provider_call_receipts r join public.protocol_external_calls ec on ec.id = r.external_call_id
     where ec.protocol_attempt_id = ${lit(attemptId)}::uuid
    union all
    select 'q:' || q.id || ':' || q.request_body_sha256
      from public.external_call_requests q join public.protocol_external_calls ec on ec.id = q.external_call_id
     where ec.protocol_attempt_id = ${lit(attemptId)}::uuid
  ) e;`);

/** A checksum of every evidence row of a protocol: attempts, calls, receipts, request bodies. */
const evidence = (protocolId: string) => admin(`
  select md5(coalesce(string_agg(x, '|' order by x), '')) from (
    select 'a:' || pa.id || ':' || pa.status || ':' || coalesce(pa.termination_reason, '') || ':' || pa.reserved_cost_usd as x
      from public.protocol_attempts pa where pa.protocol_id = ${lit(protocolId)}::uuid
    union all
    select 'c:' || ec.id || ':' || ec.status || ':' || coalesce(ec.request_sent_at::text, '')
      from public.protocol_external_calls ec join public.protocol_attempts pa on pa.id = ec.protocol_attempt_id
     where pa.protocol_id = ${lit(protocolId)}::uuid
    union all
    select 'r:' || r.id || ':' || r.outcome
      from public.provider_call_receipts r join public.protocol_external_calls ec on ec.id = r.external_call_id
      join public.protocol_attempts pa on pa.id = ec.protocol_attempt_id where pa.protocol_id = ${lit(protocolId)}::uuid
  ) e;`);

async function main(): Promise<void> {
  console.log("test-pilot-step1-db");

  /* P: provenance at approval ----------------------------------------- */
  const reqP = founderRequest("prov-founder.example");
  check("P1 a founder-created approval without provenance is refused",
    fails(`select * from public.approve_and_launch_snapshot_baseline(${lit(reqP)}::uuid, ${lit(FOUNDER)}::uuid, '["Beta Co","Gamma Co"]'::jsonb, ${lit("a".repeat(64))}, null);`)?.includes("question_provenance_required") === true);
  check("P2 nothing was created by the refused approval",
    admin(`select status || ':' || coalesce(protocol_id::text, 'none') from public.snapshot_requests where id = ${lit(reqP)}::uuid;`) === "pending_approval:none");
  const protoP = approve(reqP, "founder_supplied");
  const [provP, ratP] = row(admin(`select v.provenance, v.rationale from public.buyer_question_versions v join public.protocols p on p.buyer_question_version_id = v.id where p.id = ${lit(protoP)}::uuid;`));
  check("P3 founder_supplied is stored with a rationale naming the founder, not the public form",
    provP === "founder_supplied" && ratP.includes("recommended or drafted by Zypact and entered by the founder") && !ratP.includes("public demo-request form"));
  check("P4 a replay of the launched request needs no provenance and changes nothing",
    psql(`select protocol_id from public.approve_and_launch_snapshot_baseline(${lit(reqP)}::uuid, ${lit(FOUNDER)}::uuid, '["Beta Co","Gamma Co"]'::jsonb, ${lit("a".repeat(64))}, null);`) === protoP);
  const reqC = founderRequest("prov-customer.example");
  const protoC = approve(reqC, "customer_supplied");
  const [provC, ratC] = row(admin(`select v.provenance, v.rationale from public.buyer_question_versions v join public.protocols p on p.buyer_question_version_id = v.id where p.id = ${lit(protoC)}::uuid;`));
  check("P5 customer_supplied is stored with a rationale naming the founder as the one who entered it",
    provC === "customer_supplied" && ratC.includes("written by the customer and entered by the founder"));
  const insertPublic = (domain: string) => admin(
    `insert into public.snapshot_requests (work_email, normalized_email, company_name, website_url, normalized_domain, buyer_category, status, origin) values (${lit(`p@${domain}`)}, ${lit(`p@${domain}`)}, 'Public Co', ${lit(`https://${domain}`)}, ${lit(domain)}, 'Which tools suit a small team?', 'pending_approval', 'public_form') returning id;`);
  const reqPub = insertPublic("prov-public.example");
  const protoPub = approve(reqPub, null);
  const [provPub, ratPub] = row(admin(`select v.provenance, v.rationale from public.buyer_question_versions v join public.protocols p on p.buyer_question_version_id = v.id where p.id = ${lit(protoPub)}::uuid;`));
  check("P6 a public-form approval is unchanged: customer_supplied with 0069's exact rationale",
    provPub === "customer_supplied" && ratPub === "Buyer question supplied directly by the requester via the public demo-request form; not independently scored.");
  const reqPub2 = insertPublic("prov-public2.example");
  check("P7 a public-form approval cannot claim Zypact wrote the question",
    fails(`select * from public.approve_and_launch_snapshot_baseline(${lit(reqPub2)}::uuid, ${lit(FOUNDER)}::uuid, '["Beta Co","Gamma Co"]'::jsonb, ${lit("b".repeat(64))}, 'founder_supplied');`)?.includes("question_provenance_not_allowed_for_public_form") === true);
  check("P8 only the five-argument approval exists, executable by service_role only",
    admin(`select count(*) from pg_proc where proname = 'approve_and_launch_snapshot_baseline';`) === "1"
      && admin(`select has_function_privilege('anon', 'public.approve_and_launch_snapshot_baseline(uuid,uuid,jsonb,text,text)', 'execute')::text || has_function_privilege('authenticated', 'public.approve_and_launch_snapshot_baseline(uuid,uuid,jsonb,text,text)', 'execute')::text || has_function_privilege('service_role', 'public.approve_and_launch_snapshot_baseline(uuid,uuid,jsonb,text,text)', 'execute')::text;`) === "falsefalsetrue");

  /* R: a run names its job --------------------------------------------- */
  const jobA = jobOf(protoC);   // older queued job
  const jobB = jobOf(protoPub); // newer queued job
  check("R1 with no run request the claim takes nothing, though two jobs are queued",
    claim()[0] === "NO_RUN_REQUEST" && jobState(jobA)[0] === "queued" && jobState(jobB)[0] === "queued");
  const [rq, rqId, rqExpiry] = requestRun(jobB);
  check("R2 a run request is recorded with an id and an expiry", rq === "REQUESTED" && rqId.length > 0 && rqExpiry.length > 0);
  admin(`update public.protocol_job_run_requests set expires_at = now() + interval '5 seconds' where id = ${lit(rqId)}::uuid;`); // test setup: a press near its expiry
  const [again, againId, againExpiry] = requestRun(jobB);
  check("R3 a second press for the same job is ALREADY_REQUESTED with the same id, and refreshes a nearly expired request to a full TTL",
    again === "ALREADY_REQUESTED" && againId === rqId
      && admin(`select (${lit(againExpiry)}::timestamptz >= now() + interval '110 seconds')::text;`) === "true"
      && admin(`select (expires_at >= now() + interval '110 seconds')::text from public.protocol_job_run_requests where id = ${lit(rqId)}::uuid;`) === "true");
  check("R4 a press for another job while one is pending is ANOTHER_RUN_PENDING", requestRun(jobA)[0] === "ANOTHER_RUN_PENDING");
  const [cOutcome, cJob, cToken] = claim();
  check("R5 the claim takes the requested (newer) job, not the oldest one", cOutcome === "CLAIMED" && cJob === jobB.id && cToken.length > 0);
  check("R6 the older job is untouched", jobState(jobA)[0] === "queued");
  check("R7 the request is consumed by this worker",
    admin(`select status || ':' || consumed_by_worker from public.protocol_job_run_requests where id = ${lit(rqId)}::uuid;`) === `consumed:${WORKER}`);
  check("R8 while a job holds a live lease, a new run is WORKER_BUSY", requestRun(jobA)[0] === "WORKER_BUSY");
  check("R9 the claim takes nothing once the request is consumed", claim()[0] === "NO_RUN_REQUEST");
  // Finish B's claim the way the worker would on a provider failure, so the lease is released.
  const [bAdmission, bFailed] = failAtProvider(jobB, cToken);
  check("R10 B's first run was admitted and then failed at the provider", bAdmission === "RESERVED" && jobState(jobB)[0] === "failed");
  const [, cancelId] = requestRun(jobA);
  check("R11 a pending request can be cancelled once", psql(`select outcome from public.cancel_protocol_job_run_request(${lit(cancelId)}::uuid);`) === "CANCELLED"
    && psql(`select outcome from public.cancel_protocol_job_run_request(${lit(cancelId)}::uuid);`) === "NOT_PENDING");
  check("R12 a cancelled request is not claimed", claim()[0] === "NO_RUN_REQUEST" && jobState(jobA)[0] === "queued");
  const [, expId] = requestRun(jobA);
  admin(`update public.protocol_job_run_requests set requested_at = now() - interval '10 minutes', expires_at = now() - interval '8 minutes' where id = ${lit(expId)}::uuid;`); // test setup: age the request
  check("R13 an expired request is not claimed and is marked expired",
    claim()[0] === "NO_RUN_REQUEST" && admin(`select status from public.protocol_job_run_requests where id = ${lit(expId)}::uuid;`) === "expired");
  check("R14 a job that is not waiting to run is JOB_NOT_RUNNABLE", requestRun(jobB)[0] === "JOB_NOT_RUNNABLE");
  const [, refId] = requestRun(jobA);
  admin(`update public.protocol_execution_jobs set status = 'failed', failure_reason = 'provider_error' where id = ${lit(jobA.id)}::uuid;`); // test setup: the job ends before the claim
  check("R15 a request whose job ended before the claim is refused, with its code recorded",
    claim()[0] === "JOB_NOT_ELIGIBLE" && admin(`select status || ':' || refusal_code from public.protocol_job_run_requests where id = ${lit(refId)}::uuid;`) === "refused:JOB_NOT_ELIGIBLE");
  admin(`update public.protocol_execution_jobs set status = 'queued', failure_reason = null where id = ${lit(jobA.id)}::uuid;`);
  // A dead lease with no claims left is swept to abandoned_exhausted, with its alert.
  const reqX = founderRequest("abandoned.example");
  const jobX = jobOf(approve(reqX, "customer_supplied"));
  admin(`update public.protocol_execution_jobs set status = 'running', worker_id = 'gone', claim_token = gen_random_uuid(), lease_expires_at = now() - interval '1 minute', attempt_count = max_attempts where id = ${lit(jobX.id)}::uuid;`); // test setup: a crashed worker
  check("R16 a run for a job whose claims are exhausted sweeps it to abandoned_exhausted, with an alert",
    requestRun(jobX)[0] === "JOB_ATTEMPTS_EXHAUSTED" && jobState(jobX)[0] === "abandoned_exhausted"
      && admin(`select count(*) from public.protocol_execution_job_alerts where job_id = ${lit(jobX.id)}::uuid and event_type = 'abandoned_exhausted';`) === "1");
  check("R17 invalid run requests are refused: a TTL outside 30-600 s, a console run with no founder",
    fails(`select * from public.request_protocol_job_run(${lit(jobA.id)}::uuid, ${lit(jobA.project)}::uuid, 'admin_run_pipeline', ${lit(FOUNDER)}::uuid, 10);`) !== null
      && fails(`select * from public.request_protocol_job_run(${lit(jobA.id)}::uuid, ${lit(jobA.project)}::uuid, 'admin_run_pipeline', null, 120);`) !== null);
  check("R18 at most one pending request can exist, even written directly",
    fails(`insert into public.protocol_job_run_requests (job_id, project_id, requested_via, requested_by, expires_at) values (${lit(jobA.id)}::uuid, ${lit(jobA.project)}::uuid, 'operator_cli', null, now() + interval '1 minute'), (${lit(jobA.id)}::uuid, ${lit(jobA.project)}::uuid, 'operator_cli', null, now() + interval '1 minute');`, "supabase_admin") !== null);

  /* F: retry a run that failed at the provider ------------------------- */
  const before = evidence(protoPub);
  const failedRunBefore = attemptEvidence(bFailed);
  check("F1 a retry needs a reason of at least 10 characters",
    fails(`select * from public.retry_failed_protocol_job(${lit(jobB.id)}::uuid, ${lit(jobB.project)}::uuid, ${lit(FOUNDER)}::uuid, 'short', ${lit(bFailed)}::uuid, 'k');`)?.includes("invalid_retry_failed_protocol_job_args") === true);
  const key1 = randomUUID();
  const [r1, d1, child1] = retry(jobB, bFailed, key1);
  check("F2 the retry is APPROVED with a new attempt", r1 === "APPROVED" && d1 === "" && child1.length > 0);
  const [cRetryOf, cOrdinal, cStatus, cReserved] = row(admin(`select retry_of_attempt_id, baseline_ordinal, status, reserved_cost_usd from public.protocol_attempts where id = ${lit(child1)}::uuid;`));
  const sourceReserved = admin(`select reserved_cost_usd from public.protocol_attempts where id = ${lit(bFailed)}::uuid;`);
  check("F3 the new attempt retries the failed one, in its slot, reserved at the failed run's own amounts",
    cRetryOf === bFailed && cOrdinal === "1" && cStatus === "reserved" && Number(cReserved) === Number(sourceReserved));
  check("F4 the new attempt's two calls are reserved",
    admin(`select string_agg(call_kind || ':' || status, ',' order by call_kind) from public.protocol_external_calls where protocol_attempt_id = ${lit(child1)}::uuid;`) === "analysis:reserved,perplexity:reserved");
  const [js, jac, jcur, jfail, jlease, jnr] = jobState(jobB);
  check("F5 the job is queued with a fresh claim budget and no lease, pointing at the new attempt",
    js === "queued" && jac === "0" && jcur === child1 && jfail === "" && jlease === "" && jnr === "");
  check("F6 the retry is recorded as an approved operator action under the console prefix",
    admin(`select action || ':' || outcome || ':' || actor from public.protocol_operator_actions where job_id = ${lit(jobB.id)}::uuid and idempotency_key = ${lit(`failed-job-retry:${key1}`)};`) === `retry_full_attempt:approved:${FOUNDER}`);
  check("F7 the failed run's own evidence (row, calls, receipt, request body) is byte-for-byte unchanged, and it still counts",
    attemptEvidence(bFailed) === failedRunBefore
      && admin(`select status || ':' || termination_reason from public.protocol_attempts where id = ${lit(bFailed)}::uuid;`) === "failed:provider_error"
      && evidence(protoPub) !== before /* only the new attempt was added */
      && admin(`select count(*) from public.protocol_attempts where protocol_id = ${lit(protoPub)}::uuid and status <> 'cancelled';`) === "2");
  check("F8 a replay of the key answers the same, creating nothing", retry(jobB, bFailed, key1).join() === `APPROVED,,${child1}`
    && admin(`select count(*) from public.protocol_attempts where protocol_id = ${lit(protoPub)}::uuid;`) === "2");
  check("F9 a second key is refused because the job is no longer failed", retry(jobB, bFailed, randomUUID())[0] === "JOB_NOT_FAILED");
  const t2 = runAndClaim(jobB);
  const [resume, failed2] = failAtProvider(jobB, t2);
  check("F10 the worker resumes the retried attempt rather than admitting a new one", resume === "RESUME_CURRENT_ATTEMPT" && failed2 === child1);
  check("F10b the first retry's key cannot be reused for this new failure: it is a conflict, not the old answer",
    retry(jobB, child1, key1)[0] === "IDEMPOTENCY_KEY_CONFLICT" && jobState(jobB)[0] === "failed");
  const [r2, , child2] = retry(jobB, child1, randomUUID());
  check("F11 a second provider failure can be retried once more (retry depth 2)", r2 === "APPROVED" && child2.length > 0);
  const t3 = runAndClaim(jobB);
  const [, failed3] = failAtProvider(jobB, t3);
  const attemptsBefore = admin(`select count(*) from public.protocol_attempts where protocol_id = ${lit(protoPub)}::uuid;`);
  check("F12 a third failure is refused: the run cap could not finish the plan, and nothing is reserved",
    retry(jobB, failed3, randomUUID())[0] === "RUN_CAP_INSUFFICIENT_FOR_REMAINING_PLAN"
      && admin(`select count(*) from public.protocol_attempts where protocol_id = ${lit(protoPub)}::uuid;`) === attemptsBefore
      && jobState(jobB)[0] === "failed");

  // Denied by the admission core: a protocol whose spend cap is set low (test setup on the protocol row).
  const reqD = founderRequest("denied.example");
  const protoD = approve(reqD, "customer_supplied");
  const jobD = jobOf(protoD);
  const [, failedD] = failAtProvider(jobD, runAndClaim(jobD));
  admin(`update public.protocols set spend_cap_usd = 0.05 where id = ${lit(protoD)}::uuid;`);
  const keyD = randomUUID();
  const [rD, dD] = retry(jobD, failedD, keyD);
  const [dStatus, , dCur, dFail, , dNr] = jobState(jobD);
  check("F13 a retry the caps refuse is DENIED and leaves the job exactly as it was",
    rD === "DENIED" && dD === "SPEND_CAP_EXCEEDED" && dStatus === "failed" && dCur === "" && dFail === "provider_error" && dNr === "");
  check("F14 the denial is recorded and replays the same", retry(jobD, failedD, keyD).join() === "DENIED,SPEND_CAP_EXCEEDED,"
    && admin(`select outcome from public.protocol_operator_actions where idempotency_key = ${lit(`failed-job-retry:${keyD}`)};`) === "denied");
  admin(`update public.protocols set spend_cap_usd = 2 where id = ${lit(protoD)}::uuid;`);
  // The two empty-answer paths, each driven through the worker's own RPCs.
  const jobE = jobOf(approve(founderRequest("empty-answer.example"), "customer_supplied"));
  const emptyE = failWithEmptyAnswer(jobE, runAndClaim(jobE));
  check("F15 an answer that arrived empty is close-only: its paid answer would be discarded",
    jobState(jobE)[3] === "empty_provider_answer" && retry(jobE, emptyE, randomUUID())[0] === "JOB_NOT_RETRYABLE");
  const jobF = jobOf(approve(founderRequest("unreadable-reply.example"), "customer_supplied"));
  const [, unreadableF] = failAtProvider(jobF, runAndClaim(jobF), { http: 200, termination: "empty_answer:RECEIPTED" });
  check("F15b a reply with no readable answer is recorded as a provider error, so it is retryable",
    jobState(jobF)[3] === "provider_error" && retry(jobF, unreadableF, randomUUID())[0] === "APPROVED");
  admin(`update public.protocol_external_calls set status = 'completed' where protocol_attempt_id = ${lit(failedD)}::uuid and call_kind = 'perplexity';`); // test setup: a state no worker path writes
  check("F16 (defensive) a provider_error job whose run nonetheless holds a completed Perplexity call is refused",
    retry(jobD, failedD, randomUUID())[0] === "NOT_A_PROVIDER_FAILURE");
  admin(`update public.protocol_external_calls set status = 'failed' where protocol_attempt_id = ${lit(failedD)}::uuid and call_kind = 'perplexity';`);
  check("F17 a retry of an attempt from another job is refused",
    retry(jobD, bFailed, randomUUID())[0] === "SOURCE_ATTEMPT_NOT_OWNED_BY_JOB");

  /* C: close a failed request ------------------------------------------ */
  check("C1 a request whose job has not failed cannot be closed", close(reqC) === "JOB_NOT_ENDED_IN_FAILURE");
  check("C2 a request still awaiting approval cannot be closed", close(founderRequest("pending.example")) === "REQUEST_NOT_CLOSABLE");
  check("C3 before closing, the failed request still blocks a new audit of its website",
    fails(`select id from public.create_snapshot_request_as_founder('x@denied.example', 'x@denied.example', 'Co', 'https://denied.example', 'denied.example', 'Which tools?', null);`)?.includes("snapshot_limit_active_domain") === true);
  const evidenceD = evidence(protoD);
  check("C4 a failed request closes", close(reqD) === "CLOSED"
    && admin(`select status from public.snapshot_requests where id = ${lit(reqD)}::uuid;`) === "failed");
  check("C5 who closed it, why and on what job state is recorded once",
    admin(`select closed_by || ':' || job_status || ':' || (reason like 'The provider failed%')::text from public.snapshot_request_closures where snapshot_request_id = ${lit(reqD)}::uuid;`) === `${FOUNDER}:failed:true`);
  check("C6 closing again replays", close(reqD) === "ALREADY_CLOSED");
  check("C7 closing changes no evidence", evidence(protoD) === evidenceD);
  check("C8 after closing, the website can be audited again",
    fails(`select id from public.create_snapshot_request_as_founder('x@denied.example', 'x@denied.example', 'Co', 'https://denied.example', 'denied.example', 'Which tools?', null);`) === null);
  check("C9 a closed request's measurement can no longer be retried", retry(jobD, failedD, randomUUID())[0] === "REQUEST_NOT_OPEN");
  check("C10 an abandoned job's request can be closed too", close(reqX) === "CLOSED");
  check("C11 closing it ends the abandoned job, so nothing can revive it and spend for a closed request",
    jobState(jobX)[0] === "failed" && jobState(jobX)[3] === "request_closed"
      && requestRun(jobX)[0] === "JOB_NOT_RUNNABLE"
      && admin(`select job_status from public.snapshot_request_closures where snapshot_request_id = ${lit(reqX)}::uuid;`) === "abandoned_exhausted");

  /* Privileges --------------------------------------------------------- */
  const fns = [
    "public.request_protocol_job_run(uuid,uuid,text,uuid,integer)",
    "public.cancel_protocol_job_run_request(uuid)",
    "public.claim_requested_protocol_execution_job(text,integer)",
    "public.retry_failed_protocol_job(uuid,uuid,uuid,text,uuid,text)",
    "public.close_failed_snapshot_request(uuid,uuid,text)",
  ];
  check("X1 anon and authenticated can execute none of the new functions; service_role can execute all",
    fns.every((fn) => admin(`select has_function_privilege('anon', ${lit(fn)}, 'execute')::text || has_function_privilege('authenticated', ${lit(fn)}, 'execute')::text || has_function_privilege('service_role', ${lit(fn)}, 'execute')::text;`) === "falsefalsetrue"));
  check("X2 every new function is SECURITY DEFINER with a pinned search_path",
    fns.every((fn) => admin(`select prosecdef::text || ':' || coalesce(array_to_string(proconfig, ','), '') from pg_proc where oid = ${lit(fn)}::regprocedure;`) === "true:search_path=public, pg_temp"));
  check("X3 service_role can read but not write the two new tables",
    fails(`select count(*) from public.protocol_job_run_requests; select count(*) from public.snapshot_request_closures;`) === null
      && fails(`insert into public.snapshot_request_closures (snapshot_request_id, job_id, job_status, closed_by, reason) values (${lit(reqD)}::uuid, ${lit(jobD.id)}::uuid, 'failed', ${lit(FOUNDER)}::uuid, 'written directly by a client');`) !== null
      && fails(`delete from public.protocol_job_run_requests;`) !== null);
  check("X4 anon cannot read the new tables",
    fails(`select count(*) from public.protocol_job_run_requests;`, "anon") !== null
      && fails(`select count(*) from public.snapshot_request_closures;`, "anon") !== null);

  finish();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
