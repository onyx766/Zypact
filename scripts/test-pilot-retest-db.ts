#!/usr/bin/env tsx
/**
 * The pilot retest on a real PostgreSQL (20261109190000_pilot_retest.sql,
 * D-062):
 *
 *   G   the migration's preconditions, each made to refuse inside a
 *       rolled-back transaction after the header's own first recovery
 *       restores the state before it (which proves that recovery too);
 *   R   register_pilot_retest: the happy path (members, approved
 *       interventions stamped now(), the readable evidence, the copied text,
 *       the deadline, the step record), replay and key conflict, every
 *       outcome and every 22023;
 *   A   atomicity (S2): a raise mid-loop, a zero-row approval, and a member
 *       abandoned out of band before a confirm each leave nothing behind;
 *   C   confirm_pilot_retest_implementation: one now() and one window for
 *       every member, every refusal, the deviation note;
 *   P   prepare_pilot_retests: WINDOW_OPEN, the window fixture, approved
 *       retests with the method's plan, slots with their member, queued
 *       jobs, the replay;
 *   S   the generic M7 paths as service_role (S11): refused, or writing
 *       nothing, on a pilot baseline; a non-pilot intervention end to end in
 *       the same transaction as a group step (S4);
 *   J   retest jobs: a Run where two slot rows match, the claim, a provider
 *       failure and its Retry, a closed pilot refused;
 *   Q   requeue_pilot_retest_job: a ChatGPT retest refused before admission
 *       is queued again and then runs; every refusal; the limit;
 *   B   abandon_pilot_retest: after preparation with no attempt; refused once
 *       started, with a pending Run, with a busy job; a second group after a
 *       change abandoned before going live, never on the questions of one
 *       that went live (M6a, M6b), and never a third;
 *   F   finality parity: pilot_retest_job_is_final equals
 *       lib/pilots/retest-rules.ts retestJobIsFinal on the same rows, over
 *       every job status, an open, closed or ended pilot, and the retry and
 *       requeue conditions;
 *   T   retirement: a member question is never retired;
 *   K   the guards refuse even the owner without a step; the recovery rule;
 *   V   the report save and share: each D-062 refusal, the freeze after a
 *       share, a stale revision, a retest in progress; with no group,
 *       nothing changes;
 *   W   two sessions (S6): register against register, a note or a confirm
 *       against a save, a Retry against a register, a Run against a save
 *       and a note, abandon and requeue against a Run; never a deadlock;
 *   X   privileges and RLS on the four tables and the 13 functions.
 *
 * Every attempt, call and receipt is produced through the worker's own RPCs
 * (claim once, admit and start each attempt, the receipts, persist,
 * reconcile, then complete_protocol_execution_job), never by writing
 * evidence rows. Test setup done as supabase_admin touches only rows that
 * are not evidence and says so:
 *   - run-control rows (a run request's status, a lease time) and a pilot's
 *     dates or status, inside rolled-back probes where possible;
 *   - S12, the window fixture: one admin transaction with `set local
 *     session_replication_role = replica` moves every member intervention's
 *     window and its group's implementation tuple back by the same interval,
 *     so a window closes without waiting days (the immutability triggers are
 *     what that bypasses; every CHECK still holds);
 *   - the same declared owner bypass, in rolled-back probes or one-row
 *     setups, to plant what no product path can write: an intervention on a
 *     pilot baseline outside a group (the recovery rule), a member abandoned
 *     out of band (A c), a baseline protocol made a draft (A a), a planned
 *     run count changed;
 *   - a test-only AFTER INSERT trigger on pilot_retest_members (A b), owned
 *     by supabase_admin, dropped in the same session.
 *
 * Runs against a DISPOSABLE Supabase Postgres with every migration applied
 * (scripts/run-p2-workspace-db-local.sh). Opt-in: SKIP (exit 2) without
 * ZYPACT_P2_DB_CONTAINER. No network, no provider.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { retestJobIsFinal, type RetestFinalityInput } from "../lib/pilots/retest-rules";
import { NON_CAUSALITY_FOOTER } from "../lib/reports/outcome-card-types";
import { PILOT_RETEST_WITHHELD_TEXT } from "../lib/reports/pilot-retest-copy";
import { PILOT_RETEST_MIGRATION, pilotRetestRecovery } from "./lib/pilot-retest-recovery";
import { db, lit, makeChecker, requireContainer, row } from "./lib/workspace-db";

const CONTAINER = requireContainer();
(globalThis as unknown as { fetch: unknown }).fetch = () => {
  throw new Error("network disabled");
};
const { psql, fails } = db(CONTAINER);
const { check, finish } = makeChecker();

const FOUNDER = randomUUID();
const WORKER = "w-pilot-retest";
const admin = (sql: string) => psql(sql, "supabase_admin");
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const question = (n: number) => `Which retest analytics tools suit a shop of ${n} people?`;
const MIGRATION = readFileSync(path.join(process.cwd(), "supabase/migrations", PILOT_RETEST_MIGRATION), "utf8");

/* ---------------------------------------------------------------- helpers */

/** Test setup: earlier suites may leave a pending run request or a live lease (run-control rows, not evidence). */
function quiesce(): void {
  admin(`update public.protocol_job_run_requests set status = 'expired', resolved_at = now() where status = 'pending';`);
  admin(`update public.protocol_execution_jobs set lease_expires_at = now() - interval '1 second' where status in ('claimed', 'running') and lease_expires_at > now();`);
}

/** [outcome, pilot_id, project_id] */
const createPilot = (domain: string) => row(psql(
  `select outcome, coalesce(pilot_id::text, ''), coalesce(project_id::text, '') from public.create_pilot(${lit(FOUNDER)}::uuid, ${lit(`Retest Co ${domain}`)}, ${lit(`https://${domain}`)}, ${lit(domain)}, 'The customer added the DNS record we sent.', 15, current_date, ${lit(randomUUID())}::uuid);`));
/** [outcome, pilot_question_id, protocol_id, job_id] */
const addQuestion = (pilotId: string, text: string) => row(psql(
  `select outcome, coalesce(pilot_question_id::text, ''), coalesce(protocol_id::text, ''), coalesce(job_id::text, '') from public.add_pilot_question(${lit(pilotId)}::uuid, ${lit(FOUNDER)}::uuid, ${lit(text)}, ${lit(sha(text))}, 'customer_supplied', 'Email of 12 Nov', current_date, ${lit(randomUUID())}::uuid);`));
/** [outcome, protocol_id, job_id] */
const addEngine = (pilotId: string, pq: string) => row(psql(
  `select outcome, coalesce(protocol_id::text, ''), coalesce(job_id::text, '') from public.add_pilot_question_engine(${lit(pilotId)}::uuid, ${lit(pq)}::uuid, 'openai_chatgpt', ${lit(FOUNDER)}::uuid);`));
const requestRun = (jobId: string, projectId: string) =>
  row(psql(`select outcome, coalesce(request_id::text, '') from public.request_protocol_job_run(${lit(jobId)}::uuid, ${lit(projectId)}::uuid, 'admin_pilot_run', ${lit(FOUNDER)}::uuid, 120);`));
const cancelRun = (requestId: string) => psql(`select outcome from public.cancel_protocol_job_run_request(${lit(requestId)}::uuid);`);
/** [outcome, job_id, claim_token] */
const claim = () =>
  row(psql(`select outcome, coalesce((job).id::text, ''), coalesce(claim_token::text, '') from public.claim_requested_protocol_execution_job(${lit(WORKER)}, 300);`));
const jobOf = (protocolId: string) => admin(`select id from public.protocol_execution_jobs where protocol_id = ${lit(protocolId)}::uuid;`);
const jobState = (jobId: string) => admin(`select status || ':' || coalesce(failure_reason, '') || ':' || attempt_count from public.protocol_execution_jobs where id = ${lit(jobId)}::uuid;`);
const count = (sql: string) => Number(admin(`select count(*) from ${sql};`));

type Engine = "perplexity" | "chatgpt";
const MENTIONED = JSON.stringify({
  product_mentioned: true, product_position: "primary",
  competitors_mentioned: [{ name: "Acme", position: 2, context: "listed second" }],
  sources_cited: [{ source: "acme-reviews.com", type: "review_site" }],
  answer_summary: "The company is recommended first.", cited_as_source: false, client_source_count: 0,
  platforms_referenced: [], negative_claim_detected: false,
});
const ABSENT = JSON.stringify({
  product_mentioned: false, product_position: "absent",
  competitors_mentioned: [{ name: "Acme", position: 1, context: "listed first" }],
  sources_cited: [{ source: "acme-reviews.com", type: "review_site" }],
  answer_summary: "Acme is recommended.", cited_as_source: false, client_source_count: 0,
  platforms_referenced: [], negative_claim_detected: false,
});

/**
 * One worker visit through the real RPCs, as one DO block (service_role):
 * a Run, the requested claim, then `attempts` attempts admitted, started,
 * receipted, persisted, reconciled and passed through the completion gate.
 * `mentioned` of them name the company. With `ambiguousLast`, the last
 * attempt's provider call is sent and never receipted, and the job is held
 * for review (the worker's ambiguity path). `failFirstAtProvider` instead
 * stops the first attempt with a provider error (retryable).
 */
function visitSql(jobId: string, projectId: string, engine: Engine, kind: "baseline" | "retest",
  opts: { attempts?: number; mentioned?: number; ambiguousLast?: boolean; providerError?: boolean; run?: boolean; reservedFirst?: boolean } = {}): string {
  const attempts = opts.attempts ?? 5;
  const mentioned = opts.mentioned ?? attempts;
  const platform = engine === "chatgpt" ? "chatgpt" : "perplexity";
  const mode = engine === "chatgpt" ? "live_openai_chatgpt" : "simulated";
  const usd = engine === "chatgpt" ? "0.54" : "0.02";
  const cost = engine === "chatgpt" ? "0.031, 'estimated'" : "null, null";
  const answer = engine === "chatgpt"
    ? `'{"object":"response","status":"completed","model":"gpt-5.4-2026-03-05","output":[{"type":"message","content":[{"type":"output_text","text":"Acme for ' || v_att || '"}]}]}'`
    : `'{"choices":[{"message":{"content":"Acme for ' || v_att || '"}}]}'`;
  const h = (x: string) => `encode(sha256(convert_to(${x}, 'UTF8')), 'hex')`;
  return `do $w$
declare
  v_job uuid := ${lit(jobId)}; v_proj uuid := ${lit(projectId)};
  v_out text; v_tok uuid; v_ord integer; v_att uuid; v_run uuid; v_pc uuid; v_ac uuid;
  v_preq text; v_ans text; v_areq text; v_content text; i integer;
begin
  ${opts.run === false ? "" : `select r.outcome into v_out from public.request_protocol_job_run(v_job, v_proj, 'admin_pilot_run', ${lit(FOUNDER)}::uuid, 120) r;
  if v_out is distinct from 'REQUESTED' then raise exception 'fixture: the run request answered %', v_out; end if;`}
  select c.claim_token into v_tok from public.claim_requested_protocol_execution_job(${lit(WORKER)}, 300) c;
  if v_tok is null then raise exception 'fixture: nothing was claimed'; end if;
  for i in 1..${attempts} loop
    select j.next_baseline_ordinal into v_ord from public.protocol_execution_jobs j where j.id = v_job;
    ${opts.reservedFirst ? `if i = 1 then
      -- The Retry already reserved this slot's attempt: the worker starts it.
      select pa.id into v_att from public.protocol_attempts pa where pa.job_id = v_job and pa.status = 'reserved';
    else
      select (a.attempt).id into v_att from public.admit_and_reserve_attempt_for_job(v_job, v_tok, v_proj, '${kind}', v_job::text || ':baseline:' || v_ord, ${usd}, 0.02, null) a;
    end if;` : `select (a.attempt).id into v_att from public.admit_and_reserve_attempt_for_job(v_job, v_tok, v_proj, '${kind}', v_job::text || ':baseline:' || v_ord, ${usd}, 0.02, null) a;`}
    if v_att is null then raise exception 'fixture: attempt % was not reserved', i; end if;
    select s.status into v_out from public.create_probe_run_and_start_attempt_for_job(v_job, v_tok, v_proj, v_att, '${platform}', '${mode}') s;
    if v_out is distinct from 'STARTED' then raise exception 'fixture: attempt % did not start: %', i, v_out; end if;
    select pa.probe_run_id into v_run from public.protocol_attempts pa where pa.id = v_att;
    select ec.id into v_pc from public.protocol_external_calls ec where ec.protocol_attempt_id = v_att and ec.call_kind = 'perplexity';
    select ec.id into v_ac from public.protocol_external_calls ec where ec.protocol_attempt_id = v_att and ec.call_kind = 'analysis';
    v_preq := '{"q":"' || v_att || '"}';
    perform 1 from public.mark_external_call_sent_for_job(v_job, v_tok, v_proj, v_pc, v_run, 'perplexity', v_preq, ${h("v_preq")});
    ${opts.ambiguousLast ? `if i = ${attempts} then
      select s.status into v_out from public.mark_protocol_execution_job_needs_review_for_ambiguity(v_job, v_tok, v_proj) s;
      return;
    end if;` : ""}
    ${opts.providerError ? `perform 1 from public.record_provider_call_receipt_for_job(v_job, v_tok, v_proj, v_pc, v_run, 'provider_error', 429, null, null, 120, null, null, null);
    perform 1 from public.abort_attempt_and_fail_job_for_job(v_job, v_tok, v_proj, v_att, 'failed', 'provider_error', 'provider_error');
    return;` : ""}
    v_ans := ${answer};
    perform 1 from public.record_provider_call_receipt_for_job(v_job, v_tok, v_proj, v_pc, v_run, 'success', 200, 'req-' || v_pc, ${h("v_ans")}, 500, ${cost}, v_ans);
    v_areq := 'analysis request for ' || v_att;
    v_content := 'analysis content for ' || v_att;
    perform 1 from public.mark_external_call_sent_for_job(v_job, v_tok, v_proj, v_ac, v_run, 'analysis', v_areq, ${h("v_areq")});
    perform 1 from public.record_analysis_call_receipt_for_job(v_job, v_tok, v_proj, v_ac, v_run, 'success', 'anthropic', 'claude-fixture', false, ${h("v_areq")}, ${h("v_content")}, 400, null, null, v_content, v_areq);
    select p.status into v_out from public.persist_probe_result_for_job(v_job, v_tok, v_proj, case when i <= ${mentioned} then ${lit(MENTIONED)}::jsonb else ${lit(ABSENT)}::jsonb end) p;
    if v_out is distinct from 'PERSISTED' then raise exception 'fixture: attempt % was not persisted: %', i, v_out; end if;
    perform 1 from public.reconcile_attempt_for_job(v_job, v_tok, v_proj, v_att, 'completed', null);
    perform 1 from public.complete_protocol_execution_job(v_job, v_tok, v_proj);
  end loop;
end $w$;`;
}
const visit = (jobId: string, projectId: string, engine: Engine, kind: "baseline" | "retest", opts: Parameters<typeof visitSql>[4] = {}) => {
  quiesce();
  psql(visitSql(jobId, projectId, engine, kind, opts));
  quiesce();
};

interface Q { pq: string; px: string; cg: string; jobPx: string; jobCg: string }
/** A live question with both baselines finished: 5 readable answers each (or as `opts` says). */
function liveQuestion(pilotId: string, projectId: string, n: number, opts: { cg?: boolean; run?: boolean; pxFour?: boolean } = {}): Q {
  const [out, pq, px, jobPx] = addQuestion(pilotId, question(n));
  if (out !== "ADDED") throw new Error(`question ${n} not added: ${out}`);
  let cg = "";
  let jobCg = "";
  if (opts.cg !== false) {
    const [eOut, eProto, eJob] = addEngine(pilotId, pq);
    if (eOut !== "ADDED") throw new Error(`engine for ${n} not added: ${eOut}`);
    cg = eProto;
    jobCg = eJob;
  }
  if (opts.run !== false) {
    if (opts.pxFour) {
      visit(jobPx, projectId, "perplexity", "baseline", { attempts: 4 });
      visit(jobPx, projectId, "perplexity", "baseline", { attempts: 1, ambiguousLast: true });
      psql(`select status from public.resolve_protocol_job_review(${lit(jobPx)}::uuid, ${lit(projectId)}::uuid, ${lit(FOUNDER)}::uuid, 'excluded_and_completed', 'The last call may have been made; excluded.');`);
    } else {
      visit(jobPx, projectId, "perplexity", "baseline", { mentioned: 2 });
    }
    if (jobCg) visit(jobCg, projectId, "chatgpt", "baseline", { mentioned: 1 });
  }
  return { pq, px, cg, jobPx, jobCg };
}

const TEXT = {
  title: "Comparison page for small shops",
  description: "Publish a plain comparison page of shop analytics tools on the customer's site.",
  target: "https://shop.example/compare",
  owner: "The customer's web team",
  actionType: "page_created",
  hypothesis: "One hypothesis: engines draw on pages that compare tools directly.",
  mechanism: "A comparison page may be read and cited when the question is asked.",
  alternatives: "Engines may change their sources for reasons unrelated to this page.",
  open: "Whether the engines read a new page within the waiting period at all.",
  threshold: "If the company is named in most answers we would keep investing in pages.",
  confounders: "A competitor launch or a change in the engines during the window.",
};
type RegisterOver = Partial<{
  questions: string; title: string; description: string; target: string; owner: string; actionType: string;
  hypothesis: string; mechanism: string; alternatives: string; open: string; threshold: string; below: string;
  confounders: string; days: string; ref: string; approvedOn: string; sources: string; confirmed: string; key: string;
  registeredBy: string;
}>;
/** The call, with overridable raw SQL arguments; returns outcome|retest|question|engine. */
function REGISTER(pilotId: string, questionIds: string[], over: RegisterOver = {}): string {
  const t = (v: string | undefined, d: string) => v ?? lit(d);
  return `select outcome || '|' || coalesce(pilot_retest_id::text, '') || '|' || coalesce(pilot_question_id::text, '') || '|' || coalesce(engine, '') from public.register_pilot_retest(
    ${lit(pilotId)}::uuid, ${over.registeredBy ?? `${lit(FOUNDER)}::uuid`},
    ${over.questions ?? `array[${questionIds.map((q) => `${lit(q)}::uuid`).join(", ")}]::uuid[]`},
    ${t(over.title, TEXT.title)}, ${t(over.description, TEXT.description)}, ${t(over.target, TEXT.target)}, ${t(over.owner, TEXT.owner)},
    ${t(over.actionType, TEXT.actionType)}, ${t(over.hypothesis, TEXT.hypothesis)}, ${t(over.mechanism, TEXT.mechanism)},
    ${t(over.alternatives, TEXT.alternatives)}, ${t(over.open, TEXT.open)}, ${t(over.threshold, TEXT.threshold)},
    ${over.below ?? "false"}, ${t(over.confounders, TEXT.confounders)}, ${over.days ?? "14"},
    ${t(over.ref, "Email from the customer, 14 Nov")}, ${over.approvedOn ?? "current_date"},
    ${over.sources ?? "'{}'::uuid[]"}, ${over.confirmed ?? "true"}, ${over.key ?? `${lit(randomUUID())}::uuid`});`;
}
const register = (pilotId: string, qs: string[], over: RegisterOver = {}) => row(psql(REGISTER(pilotId, qs, over)));

const CONFIRM = (pilotId: string, retestId: string, over: Partial<{ wentLive: string; url: string; sha: string; note: string; asRegistered: string; deviation: string; confirmed: string }> = {}) =>
  `select outcome || '|' || coalesce(window_closes_at::text, '') from public.confirm_pilot_retest_implementation(${lit(pilotId)}::uuid, ${lit(retestId)}::uuid, ${lit(FOUNDER)}::uuid, ${over.wentLive ?? "current_date"}, ${over.url ?? lit("https://shop.example/compare")}, ${over.sha ?? "null"}, ${over.note ?? lit("The customer's web team published the page today.")}, ${over.asRegistered ?? "true"}, ${over.deviation ?? "null"}, ${over.confirmed ?? "true"});`;
const confirm = (pilotId: string, retestId: string, over: Parameters<typeof CONFIRM>[2] = {}) => row(psql(CONFIRM(pilotId, retestId, over)));
const PREPARE = (pilotId: string, retestId: string) =>
  `select outcome || '|' || coalesce(prepared::text, '') || '|' || coalesce(window_closes_at::text, '') from public.prepare_pilot_retests(${lit(pilotId)}::uuid, ${lit(retestId)}::uuid, ${lit(FOUNDER)}::uuid);`;
const prepare = (pilotId: string, retestId: string) => row(psql(PREPARE(pilotId, retestId)));
const ABANDON = (pilotId: string, retestId: string, confirmed = "true") =>
  `select outcome from public.abandon_pilot_retest(${lit(pilotId)}::uuid, ${lit(retestId)}::uuid, ${lit(FOUNDER)}::uuid, 'The customer withdrew the change.', ${confirmed});`;
const abandon = (pilotId: string, retestId: string, confirmed = "true") => psql(ABANDON(pilotId, retestId, confirmed));
const REQUEUE = (pilotId: string, retestId: string, pq: string, engine: string, reason = "The worker was not set up for this engine yet.") =>
  `select outcome || '|' || coalesce(job_id::text, '') from public.requeue_pilot_retest_job(${lit(pilotId)}::uuid, ${lit(retestId)}::uuid, ${lit(pq)}::uuid, ${lit(engine)}, ${lit(FOUNDER)}::uuid, ${lit(reason)});`;
const requeue = (pilotId: string, retestId: string, pq: string, engine: string) => row(psql(REQUEUE(pilotId, retestId, pq, engine)));
const NOTE = (pilotId: string, retestId: string, over: Partial<{ notedOn: string; kind: string; text: string; corrects: string; key: string }> = {}) =>
  `select outcome || '|' || coalesce(note_id::text, '') from public.add_pilot_retest_note(${lit(pilotId)}::uuid, ${lit(retestId)}::uuid, ${lit(FOUNDER)}::uuid, ${over.notedOn ?? "current_date"}, ${over.kind ?? lit("competitor_activity")}, ${over.text ?? lit("A competitor published a new comparison page.")}, ${over.corrects ?? "null"}, ${over.key ?? `${lit(randomUUID())}::uuid`});`;
const note = (pilotId: string, retestId: string, over: Parameters<typeof NOTE>[2] = {}) => row(psql(NOTE(pilotId, retestId, over)));

/** Runs `call` as service_role after `setup` (as the owner) inside one transaction, then rolls everything back. */
const probe = (setup: string, call: string) => admin(`begin;\n${setup}\nset local role service_role;\n${call}\nrollback;`);
const probeFails = (setup: string, call: string) => fails(`begin;\n${setup}\nset local role service_role;\n${call}\nrollback;`, "supabase_admin");
const REPLICA = "set local session_replication_role = replica;";
const ORIGIN = "set local session_replication_role = origin;";

/** Members of a group, in member order: [member, question, engine, baseline, intervention]. */
const membersOf = (retestId: string) => admin(
  `select string_agg(m.id || ':' || m.pilot_question_id || ':' || m.engine || ':' || m.baseline_protocol_id || ':' || m.intervention_id, ',' order by q.ordinal, case m.engine when 'perplexity_sonar' then 0 else 1 end)
     from public.pilot_retest_members m join public.pilot_questions q on q.id = m.pilot_question_id where m.pilot_retest_id = ${lit(retestId)}::uuid;`)
  .split(",").filter(Boolean).map((s) => s.split(":"));
/** The retest slot protocol of a member. */
const retestOf = (memberId: string) => admin(`select protocol_id from public.pilot_question_protocols where pilot_retest_member_id = ${lit(memberId)}::uuid;`);

/**
 * S12: the window fixture. One admin transaction under replica mode moves the
 * group's implementation tuple and every member intervention's window back
 * by (observation_days + 1) days, so the window has closed. Every CHECK
 * still holds (window_opens_at = implemented_at; closes after opens).
 */
function closeWindow(retestId: string): void {
  admin(`begin;
${REPLICA}
update public.pilot_retests r
   set implemented_at = r.implemented_at - make_interval(days => r.observation_days + 1),
       window_opens_at = r.window_opens_at - make_interval(days => r.observation_days + 1),
       window_closes_at = r.window_closes_at - make_interval(days => r.observation_days + 1)
 where r.id = ${lit(retestId)}::uuid;
update public.interventions i
   set implemented_at = i.implemented_at - make_interval(days => i.expected_observation_days + 1),
       observation_window_opens_at = i.observation_window_opens_at - make_interval(days => i.expected_observation_days + 1),
       observation_window_closes_at = i.observation_window_closes_at - make_interval(days => i.expected_observation_days + 1)
 where i.id in (select m.intervention_id from public.pilot_retest_members m where m.pilot_retest_id = ${lit(retestId)}::uuid);
commit;`);
}

/** Starts a background session that runs `sql` and keeps its transaction open; resolves with its output. */
function background(sql: string, role: "service_role" | "supabase_admin" = "service_role"): { done: Promise<string> } {
  const child = spawn("docker", ["exec", "-i", CONTAINER, "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qtA"], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += String(d); });
  child.stderr.on("data", (d) => { out += String(d); });
  child.stdin.end(`${role === "service_role" ? "set role service_role;\n" : ""}${sql}`);
  return { done: new Promise((resolve) => child.on("close", () => resolve(out.trim()))) };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Waits until a background statement tagged `marker` is active (it holds its locks). */
async function waitActive(marker: string): Promise<boolean> {
  for (let i = 0; i < 60; i += 1) {
    await sleep(200);
    if (admin(`select count(*) from pg_stat_activity where state = 'active' and query like ${lit(`%${marker}%`)} and pid <> pg_backend_pid();`) === "1") return true;
  }
  return false;
}

/* ------------------------------------------- the report save's inputs (V) */

const ISO = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const STATE = (g: string) => `case when ${g}.abandoned_at is not null then 'abandoned' when ${g}.retests_prepared_at is not null then 'prepared' when ${g}.implemented_at is not null then 'implemented' else 'registered' end`;
/** What a build would read: the manifest's lists, each group as the payload shows it, and each member's card identities. */
function buildInputs(pilotId: string) {
  const json = admin(`with slots as (
  select s.* from public.pilot_question_protocols s join public.pilot_questions q on q.id = s.pilot_question_id where q.pilot_id = ${lit(pilotId)}::uuid
)
select jsonb_build_object(
  'projectId', (select project_id from public.pilots where id = ${lit(pilotId)}::uuid),
  'protocols', (select coalesce(jsonb_agg(s.protocol_id), '[]'::jsonb) from slots s),
  'attempts', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'protocolId', a.protocol_id, 'rawResponseSha256', r.raw_response_sha256)), '[]'::jsonb)
                 from public.protocol_attempts a left join public.probe_results r on r.probe_run_id = a.probe_run_id
                where a.protocol_id in (select protocol_id from slots)),
  'retests', (select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'state', ${STATE("g")},
                 'memberIds', (select coalesce(jsonb_agg(m.id), '[]'::jsonb) from public.pilot_retest_members m where m.pilot_retest_id = g.id))), '[]'::jsonb)
                from public.pilot_retests g where g.pilot_id = ${lit(pilotId)}::uuid),
  'retestNotes', (select coalesce(jsonb_agg(n.id), '[]'::jsonb) from public.pilot_retest_notes n where n.pilot_id = ${lit(pilotId)}::uuid),
  'retestJobs', (select coalesce(jsonb_agg(jsonb_build_object('jobId', j.id, 'protocolId', j.protocol_id, 'status', j.status, 'reviewResolution', j.review_resolution)), '[]'::jsonb)
                   from slots s join public.protocol_execution_jobs j on j.protocol_id = s.protocol_id where s.phase = 'retest'),
  'members', (select coalesce(jsonb_agg(jsonb_build_object('memberId', m.id, 'interventionId', m.intervention_id, 'retestId', m.pilot_retest_id,
                 'baselineProtocolId', m.baseline_protocol_id, 'retestProtocolId', s.protocol_id,
                 'attemptIds', (select coalesce(jsonb_agg(a.id), '[]'::jsonb) from public.protocol_attempts a where a.protocol_id = s.protocol_id))), '[]'::jsonb)
                from public.pilot_retest_members m left join slots s on s.pilot_retest_member_id = m.id where m.pilot_id = ${lit(pilotId)}::uuid),
  'payloadRetests', (select coalesce(jsonb_agg(jsonb_build_object(
      'retestId', g.id, 'sequence', g.sequence, 'state', ${STATE("g")},
      'registeredOn', to_char(g.registered_at at time zone 'UTC', 'YYYY-MM-DD'),
      'customerApprovedOn', to_char(g.customer_approved_on, 'YYYY-MM-DD'),
      'text', jsonb_build_object('changeTitle', g.change_title, 'changeDescription', g.change_description, 'changeTarget', g.change_target,
                'changeOwner', g.change_owner, 'hypothesis', g.hypothesis, 'expectedMechanism', g.expected_mechanism,
                'alternativeExplanations', g.alternative_explanations, 'openQuestions', g.open_questions,
                'decisionThreshold', g.decision_threshold, 'confoundersToMonitor', g.confounders_to_monitor),
      'withheldFields', '[]'::jsonb, 'actionType', g.action_type, 'thresholdBelowLimit', g.threshold_below_limit,
      'outcomeRule', g.outcome_rule, 'observationDays', g.observation_days, 'implementBy', to_char(g.implement_by, 'YYYY-MM-DD'),
      'sourceActions', coalesce((select jsonb_agg(jsonb_build_object('versionId', u.id, 'title', case when w.wd then null else v.title end, 'withdrawn', w.wd) order by u.n)
                          from unnest(g.source_action_version_ids) with ordinality u(id, n) join public.pilot_action_versions v on v.id = u.id
                          cross join lateral (select exists (select 1 from public.pilot_action_events ev where ev.action_id = v.action_id and ev.event = 'withdrawn') as wd) w), '[]'::jsonb),
      'implementation', case when g.implemented_at is null then 'null'::jsonb else jsonb_build_object('recordedAt', ${ISO("g.implemented_at")},
                          'wentLiveOn', to_char(g.went_live_on, 'YYYY-MM-DD'), 'evidenceUrl', g.evidence_url, 'artifactSha256', g.artifact_sha256,
                          'implementedAsRegistered', g.implemented_as_registered) end,
      'windowOpensAt', case when g.implemented_at is null then 'null'::jsonb else to_jsonb(${ISO("g.window_opens_at")}) end,
      'windowClosesAt', case when g.implemented_at is null then 'null'::jsonb else to_jsonb(${ISO("g.window_closes_at")}) end,
      'prepared', g.retests_prepared_at is not null,
      'abandoned', case when g.abandoned_at is null then 'null'::jsonb else jsonb_build_object('abandonedOn', to_char(g.abandoned_at at time zone 'UTC', 'YYYY-MM-DD'), 'wasLive', g.implemented_at is not null) end,
      'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'notedOn', to_char(n.noted_on, 'YYYY-MM-DD'), 'kind', n.kind, 'text', n.text,
                  'withheld', false, 'correctsNoteId', n.corrects_note_id, 'writtenAt', ${ISO("n.written_at")})) from public.pilot_retest_notes n where n.pilot_retest_id = g.id), '[]'::jsonb),
      'members', '[]'::jsonb)), '[]'::jsonb) from public.pilot_retests g where g.pilot_id = ${lit(pilotId)}::uuid)
)::text;`);
  return JSON.parse(json) as {
    projectId: string; protocols: string[]; attempts: unknown[]; retests: { id: string; state: string; memberIds: string[] }[];
    retestNotes: string[]; retestJobs: { jobId: string; protocolId: string; status: string; reviewResolution: string | null }[];
    members: { memberId: string; interventionId: string; retestId: string; baselineProtocolId: string; retestProtocolId: string | null; attemptIds: string[] }[];
    payloadRetests: Record<string, unknown>[];
  };
}
type Inputs = ReturnType<typeof buildInputs>;
type Card = { memberId: string; status: string };
/** The save's arguments for `cards`; `mutate` edits the manifest and payload before the call. */
function SAVE(pilotId: string, read: Inputs, cards: Card[], opts: { status?: string; mutate?: (m: Record<string, unknown>, p: Record<string, unknown>) => void } = {}): string {
  const inputs = structuredClone(read); // a mutation never reaches the next call
  const byMember = new Map(inputs.members.map((m) => [m.memberId, m]));
  const manifest: Record<string, unknown> = {
    protocols: inputs.protocols, attempts: inputs.attempts, retests: inputs.retests, retestNotes: inputs.retestNotes,
    retestJobs: inputs.retestJobs,
    retestCards: cards.map((c) => ({ memberId: c.memberId, status: c.status, retestAttemptIds: byMember.get(c.memberId)?.attemptIds ?? [] })),
  };
  const payload: Record<string, unknown> = {
    pilotId, projectId: inputs.projectId, retests: inputs.payloadRetests,
    outcomeCards: cards.map((c) => {
      const m = byMember.get(c.memberId);
      return { memberId: c.memberId, interventionId: m?.interventionId, retestId: m?.retestId, baselineProtocolId: m?.baselineProtocolId,
        retestProtocolId: m?.retestProtocolId, status: c.status, footer: NON_CAUSALITY_FOOTER };
    }),
  };
  opts.mutate?.(manifest, payload);
  const status = opts.status ?? "needs_review";
  return `select outcome || '|' || coalesce(artifact_id::text, '') || '|' || coalesce(revision::text, '') from public.save_pilot_report_artifact(${lit(pilotId)}::uuid, ${lit(FOUNDER)}::uuid, '# Pilot report', ${lit(JSON.stringify(payload))}::jsonb, ${lit(JSON.stringify(manifest))}::jsonb, ${lit(status)}, ${status === "integrity_passed" ? "'[]'::jsonb" : `'["A retest is shown."]'::jsonb`}, now());`;
}
const SHARE = (pilotId: string, artifactId: string) =>
  `select outcome from public.share_pilot_report_artifact(${lit(artifactId)}::uuid, ${lit(pilotId)}::uuid, ${lit(FOUNDER)}::uuid, true);`;

/** The rows pilot_retest_job_is_final reads, and its answer, read in one statement (optionally after a setup, rolled back). */
function finality(jobId: string, setup = ""): { fn: boolean | null; ts: boolean; input: RetestFinalityInput } {
  const out = admin(`begin;\n${setup}\nselect json_build_object(
  'fn', public.pilot_retest_job_is_final(j.id),
  'job', json_build_object('id', j.id, 'status', j.status, 'reviewResolution', j.review_resolution, 'currentAttemptId', j.current_attempt_id,
                           'failureReason', j.failure_reason, 'nextBaselineOrdinal', j.next_baseline_ordinal),
  'protocol', json_build_object('plannedBaselineRuns', p.planned_baseline_runs, 'runCap', p.run_cap),
  'attempts', coalesce((select json_agg(json_build_object('id', a.id, 'jobId', a.job_id, 'status', a.status, 'terminalizedAt', a.terminalized_at,
                         'baselineOrdinal', a.baseline_ordinal, 'retryOfAttemptId', a.retry_of_attempt_id)) from public.protocol_attempts a where a.protocol_id = j.protocol_id), '[]'::json),
  'pilot', json_build_object('status', pl.status, 'startsOn', pl.starts_on, 'endsOn', pl.ends_on),
  'questionRetired', q.retired_at is not null,
  'requeueCount', (select count(*) from public.pilot_retest_steps st where st.member_id = s.pilot_retest_member_id and st.step = 'requeue'),
  'today', current_date)::text
  from public.protocol_execution_jobs j
  join public.protocols p on p.id = j.protocol_id
  join public.pilot_question_protocols s on s.protocol_id = j.protocol_id and s.phase = 'retest'
  join public.pilot_questions q on q.id = s.pilot_question_id
  join public.pilots pl on pl.id = q.pilot_id
 where j.id = ${lit(jobId)}::uuid;\nrollback;`);
  const parsed = JSON.parse(out) as RetestFinalityInput & { fn: boolean | null };
  return { fn: parsed.fn, ts: retestJobIsFinal(parsed), input: parsed };
}

/* ======================================================================= */

async function main(): Promise<void> {
  console.log("test-pilot-retest-db");
  quiesce();

  /* G: the migration's preconditions, each made to refuse ----------------- */
  // Each case runs in one transaction as the owner: the header's first
  // recovery restores the state before 20261109190000 (no group exists yet
  // in this container), one condition is broken, and the migration file is
  // re-run. The error ends the session, which rolls everything back; a re-run
  // that does not refuse reaches the closing rollback. Earlier suites plant
  // retests of pilot slot protocols as test setup (20261109140000 P8,
  // 20261109180000 I5, R6, O8); precondition 6 would refuse those, so they
  // are set aside inside the transaction (their slot rows deleted, rolled
  // back with it).
  {
    const [, pilotG, projectG] = createPilot("rt-g.example");
    const [, pqG, pxG] = addQuestion(pilotG, question(900));
    const RESTORE = pilotRetestRecovery();
    const SET_ASIDE = "delete from public.pilot_question_protocols s where exists (select 1 from public.protocols p where p.baseline_protocol_id = s.protocol_id);";
    const rerun = (setup: string) => fails(`begin;\n${RESTORE}\n${SET_ASIDE}\n${setup}\n${MIGRATION}\nrollback;`, "supabase_admin");
    const refusal = (setup: string, message: string) => {
      const err = rerun(setup);
      return { ok: err !== null && err.includes(message), detail: err === null ? "no error" : err.split("\n").find((l) => l.includes("ERROR")) ?? err };
    };
    const snapshot = () => admin(
      `select string_agg(p.proname || '=' || md5(p.prosrc), ',' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like '%pilot_retest%' or p.proname in ('save_pilot_report_artifact', 'share_pilot_report_artifact'));\n` +
      `select string_agg(conname || '=' || pg_get_constraintdef(oid), ',' order by conname) from pg_constraint where conrelid = 'public.pilot_question_protocols'::regclass;\n` +
      `select string_agg(tgname, ',' order by tgname) from pg_trigger where not tgisinternal and tgname like '%retest%';\n` +
      `select (select count(*) from public.pilot_question_protocols) || ',' || (select count(*) from public.interventions) || ',' || (select count(*) from public.protocols) || ',' || coalesce(obj_description('public.pilot_question_protocols'::regclass, 'pg_class'), '');`);
    const before = snapshot();
    const asIs = rerun("");
    check("G1 the header's recovery statements, in its order, restore a state the migration accepts: re-run after them, it passes every guard (the control for G2 to G13)",
      asIs === null, asIs ?? "");
    const g2 = refusal("grant execute on function public.claim_protocol_execution_job(text, integer) to service_role;",
      "20261109190000 precondition: claim_protocol_execution_job is executable by service_role");
    const g2b = refusal("grant execute on function public.claim_protocol_execution_job_by_id(text, integer, uuid, uuid) to service_role;",
      "20261109190000 precondition: claim_protocol_execution_job_by_id is executable by service_role");
    const g2c = refusal("drop function public.read_shared_pilot_report(text);", "20261109190000 precondition: 20261109170000 is not applied");
    check("G2 precondition 1 refuses either unscoped claim executable by service_role, and a missing pilot report read (20261109170000 not applied)",
      g2.ok && g2b.ok && g2c.ok, `${g2.detail} | ${g2b.detail} | ${g2c.detail}`);
    const g3 = refusal("drop function public.protocol_worker_capabilities();", "20261109190000 precondition: 20261109180000 is not applied");
    const g3b = refusal("alter table public.pilot_question_protocols disable trigger pilot_question_protocols_consistency;",
      "20261109190000 precondition: the slot consistency trigger of 20261109180000 is missing or not enabled");
    const g3c = refusal("alter table public.pilot_question_protocols drop constraint pilot_question_protocols_engine_check;\nalter table public.pilot_question_protocols add constraint pilot_question_protocols_engine_check check (engine in ('openai_chatgpt', 'perplexity_sonar'));",
      "20261109190000 precondition: pilot_question_protocols_engine_check is not 20261109180000's");
    const g3d = refusal("alter table public.pilot_question_protocols drop constraint pilot_question_protocols_phase_check;\nalter table public.pilot_question_protocols add constraint pilot_question_protocols_phase_check check (phase in ('baseline', 'other'));",
      "20261109190000 precondition: pilot_question_protocols_phase_check is not 20261109140000's");
    check("G3 precondition 2 refuses a missing 20261109180000 function, its trigger disabled, and either slot CHECK not as it left them",
      g3.ok && g3b.ok && g3c.ok && g3d.ok, [g3, g3b, g3c, g3d].map((g) => g.detail).join(" | "));
    const g4 = refusal("drop function public.retest_eligibility(uuid, uuid);", "20261109190000 precondition: public.retest_eligibility(uuid,uuid) is missing");
    check("G4 precondition 3 refuses a wrapped M7 function that is missing", g4.ok, g4.detail);
    const pa = readFileSync(path.join(process.cwd(), "supabase/migrations/20261109160000_pilot_actions.sql"), "utf8");
    const paSave = pa.slice(pa.indexOf("create or replace function public.save_pilot_report_artifact("), pa.indexOf("\n$$;\n", pa.indexOf("create or replace function public.save_pilot_report_artifact(")) + 5);
    const paShare = pa.slice(pa.indexOf("create or replace function public.share_pilot_report_artifact("), pa.indexOf("\n$$;\n", pa.indexOf("create or replace function public.share_pilot_report_artifact(")) + 5);
    const g5 = refusal(paSave.replace("-- Serialises revision numbers per pilot.", "-- Serialises revision numbers per pilot (changed)."),
      "20261109190000 precondition: save_pilot_report_artifact is not 20261109160000's");
    const g5b = refusal(paShare.replace("-- The same lock a save takes", "-- The same lock a save takes (changed)"),
      "20261109190000 precondition: share_pilot_report_artifact is not 20261109160000's");
    check("G5 precondition 4 refuses a save or a share that is not 20261109160000's (one comment changed: the md5 of the source differs)",
      g5.ok && g5b.ok, `${g5.detail} | ${g5b.detail}`);
    const g6 = refusal("create table public.pilot_retest_steps (id integer);", "20261109190000 precondition: an object this migration creates already exists");
    const g6b = refusal("create function public.pilot_retest_card_guard() returns trigger language plpgsql as $g$ begin return null; end $g$;",
      "20261109190000 precondition: an object this migration creates already exists");
    const g6c = refusal("alter table public.pilot_question_protocols add column pilot_retest_member_id uuid;",
      "20261109190000 precondition: an object this migration creates already exists");
    check("G6 precondition 5 refuses when a table, a function or the slot column it creates already exists", g6.ok && g6b.ok && g6c.ok,
      [g6, g6b, g6c].map((g) => g.detail).join(" | "));
    const g7 = refusal(`select count(*) from public.register_intervention(${lit(projectG)}::uuid, ${lit(pxG)}::uuid, 'h', 'm', 'other', 't', 'o', '[]'::jsonb);`,
      "20261109190000 precondition: an intervention, protocol or Outcome Card already references a pilot slot's protocol");
    const g7b = refusal(`insert into public.protocols (project_id, buyer_question_version_id, baseline_protocol_id, provider, surface, model_config, planned_baseline_runs, planned_retest_runs, paraphrase_plan, unit_of_analysis, primary_metric, minimum_useful_change, sample_planning_method, sample_planning_assumptions, run_cap, spend_cap_usd, time_window_seconds, rate_limit_per_hour, concurrency_limit, retry_cap, observation_window_rule, analyzer_version, entity_resolution_version, methodology_version) select project_id, buyer_question_version_id, id, provider, surface, model_config, planned_baseline_runs, planned_retest_runs, paraphrase_plan, unit_of_analysis, primary_metric, minimum_useful_change, sample_planning_method, sample_planning_assumptions, run_cap, spend_cap_usd, time_window_seconds, rate_limit_per_hour, concurrency_limit, retry_cap, observation_window_rule, analyzer_version, entity_resolution_version, methodology_version from public.protocols where id = ${lit(pxG)}::uuid;`,
      "20261109190000 precondition: an intervention, protocol or Outcome Card already references a pilot slot's protocol");
    check("G7 precondition 6 refuses an intervention, or a retest protocol, already on a pilot slot's protocol (planted after the set-aside)",
      g7.ok && g7b.ok, `${g7.detail} | ${g7b.detail}`);
    const after = snapshot();
    check("G8 every re-run and its setup were rolled back: the functions, the slot constraints, the triggers, the rows and the comment are as before G1",
      before !== "" && after === before && pqG !== "", after === before ? "" : `${before}\n  vs\n${after}`);
  }

  /* R: registration ------------------------------------------------------- */
  const [, pilotR, projectR] = createPilot("rt-r.example");
  const q1 = liveQuestion(pilotR, projectR, 1);
  const q2 = liveQuestion(pilotR, projectR, 2);
  const q3 = liveQuestion(pilotR, projectR, 3);
  const qMiss = liveQuestion(pilotR, projectR, 4, { cg: false });
  const qQueued = liveQuestion(pilotR, projectR, 5, { run: false });
  const qFour = liveQuestion(pilotR, projectR, 6, { pxFour: true });
  check("R0 setup: three questions with both baselines finished (5 readable answers each), one without ChatGPT, one queued, one with an answer excluded by review",
    [q1, q2, q3].every((q) => jobState(q.jobPx).startsWith("succeeded") && jobState(q.jobCg).startsWith("succeeded"))
      && jobState(qQueued.jobPx).startsWith("queued") && jobState(qFour.jobPx).startsWith("succeeded")
      && admin(`select count(*) filter (where status = 'completed') || '/' || count(*) filter (where status = 'excluded') from public.protocol_attempts where protocol_id = ${lit(qFour.px)}::uuid;`) === "4/1");
  const groups = () => count(`public.pilot_retests where pilot_id = ${lit(pilotR)}::uuid`);
  const written = () => [groups(), count(`public.pilot_retest_members where pilot_id = ${lit(pilotR)}::uuid`),
    count(`public.pilot_retest_steps where pilot_id = ${lit(pilotR)}::uuid`), count(`public.interventions where project_id = ${lit(projectR)}::uuid`)].join(",");
  const base0 = written();

  // Every 22023.
  const bad = (over: RegisterOver, qs = [q1.pq]) => (fails(REGISTER(pilotR, qs, over)) ?? "").includes("invalid_register_pilot_retest_args");
  const BAD: [string, RegisterOver, string[]?][] = [
    ["no question", { questions: "'{}'::uuid[]" }],
    ["six questions", {}, [q1.pq, q2.pq, q3.pq, qMiss.pq, qQueued.pq, qFour.pq]],
    ["a repeated question", {}, [q1.pq, q1.pq]],
    ["a null question", { questions: `array[${lit(q1.pq)}::uuid, null]::uuid[]` }],
    ["an untrimmed title", { title: lit(" Comparison page") }],
    ["a title of 2 characters", { title: lit("Ab") }],
    ["a target of 501 characters", { target: lit("x".repeat(501)) }],
    ["an owner of 201 characters", { owner: lit("x".repeat(201)) }],
    ["a hypothesis of 9 characters", { hypothesis: lit("Too short") }],
    ["a threshold of 2001 characters", { threshold: lit("y".repeat(2001)) }],
    ["an unknown action type", { actionType: lit("page_rewritten") }],
    ["6 days", { days: "6" }], ["61 days", { days: "61" }],
    ["an approval in the future", { approvedOn: "current_date + 1" }],
    ["an approval reference of 2 characters", { ref: lit("Ab") }],
    ["six source versions", { sources: `array[${Array.from({ length: 6 }, () => `${lit(randomUUID())}::uuid`).join(", ")}]` }],
    ["a repeated source version", { sources: (() => { const v = randomUUID(); return `array[${lit(v)}::uuid, ${lit(v)}::uuid]`; })() }],
    ["a null below-limit answer", { below: "null" }], ["a null confirmation", { confirmed: "null" }], ["a null key", { key: "null" }],
  ];
  const badOut = BAD.filter(([, over, qs]) => !bad(over, qs)).map(([n]) => n);
  check("R1 every malformed argument raises 22023 invalid_register_pilot_retest_args, and nothing is written", badOut.length === 0 && written() === base0, badOut.join(", "));

  const R = (qs: string[], over: RegisterOver = {}, setup = "") => (setup ? probe(setup, REGISTER(pilotR, qs, over)) : psql(REGISTER(pilotR, qs, over))).split("|");
  check("R2 an unknown pilot is not found", row(psql(REGISTER(randomUUID(), [q1.pq])))[0] === "PILOT_NOT_FOUND");
  check("R3 without the founder's confirmation nothing is registered", R([q1.pq], { confirmed: "false" })[0] === "CONFIRMATION_REQUIRED");
  check("R4 a closed pilot refuses (test setup, rolled back: the pilot closed)",
    R([q1.pq], {}, `update public.pilots set status = 'closed', closed_by = ${lit(FOUNDER)}::uuid, closed_at = now(), close_reason = 'Test setup, rolled back.' where id = ${lit(pilotR)}::uuid;`)[0] === "PILOT_CLOSED");
  check("R5 a pilot past its end date refuses (test setup, rolled back)",
    R([q1.pq], {}, `update public.pilots set starts_on = current_date - 91, ends_on = current_date - 1 where id = ${lit(pilotR)}::uuid;`)[0] === "PILOT_CLOSED");
  const late = R([q1.pq], { days: "60" }, `update public.pilots set starts_on = current_date - 70, ends_on = current_date + 20 where id = ${lit(pilotR)}::uuid;`);
  const fits = R([q1.pq], { days: "13" }, `update public.pilots set starts_on = current_date - 70, ends_on = current_date + 20 where id = ${lit(pilotR)}::uuid;`);
  check("R6 a window that cannot close 7 days before the pilot ends is refused (WINDOW_PAST_PILOT_END); the last day that fits registers",
    late[0] === "WINDOW_PAST_PILOT_END" && fits[0] === "REGISTERED", `${late[0]}/${fits[0]}`);
  const unknownQ = randomUUID();
  const notLive = R([q1.pq, unknownQ]);
  const retired = R([q2.pq], {}, `update public.pilot_questions set retired_at = now(), retired_by = ${lit(FOUNDER)}::uuid, retire_reason = 'Test setup, rolled back.' where id = ${lit(q2.pq)}::uuid;`);
  const [, otherPilot, otherProject] = createPilot("rt-other.example");
  const otherQ = addQuestion(otherPilot, question(7))[1];
  check("R7 a question that is not this pilot's, another pilot's, or a retired one is QUESTION_NOT_LIVE, naming it",
    notLive.join("|") === `QUESTION_NOT_LIVE||${unknownQ}|` && retired.join("|") === `QUESTION_NOT_LIVE||${q2.pq}|`
      && R([otherQ])[0] === "QUESTION_NOT_LIVE" && otherProject !== "");
  check("R8 a question without its ChatGPT baseline is BASELINE_MISSING on openai_chatgpt",
    R([q1.pq, qMiss.pq]).join("|") === `BASELINE_MISSING||${qMiss.pq}|openai_chatgpt`);
  check("R9 a baseline whose plan is not 5 runs is refused (test setup, rolled back, replica: the planned count changed)",
    R([q1.pq], {}, `${REPLICA}\nupdate public.protocols set planned_baseline_runs = 4 where id = ${lit(q1.cg)}::uuid;\n${ORIGIN}`).join("|") === `BASELINE_PLAN_NOT_FIVE_RUNS||${q1.pq}|openai_chatgpt`);
  check("R10 a baseline not finished (queued) is BASELINE_NOT_FINISHED, Perplexity first",
    R([qQueued.pq]).join("|") === `BASELINE_NOT_FINISHED||${qQueued.pq}|perplexity_sonar`);
  check("R11 a baseline with 4 readable answers (one excluded by review) is BASELINE_NOT_FIVE_READABLE (M3)",
    R([qFour.pq]).join("|") === `BASELINE_NOT_FIVE_READABLE||${qFour.pq}|perplexity_sonar`);
  check("R12 a baseline a live intervention already holds is BASELINE_ALREADY_REGISTERED (test setup, rolled back, replica: a planted recovery row)",
    R([q3.pq], {}, `${REPLICA}\ninsert into public.interventions (project_id, protocol_id, buyer_question_version_id, hypothesis, expected_mechanism, action_type, action_target, owner) select project_id, id, buyer_question_version_id, 'h', 'm', 'other', 't', 'o' from public.protocols where id = ${lit(q3.cg)}::uuid;\n${ORIGIN}`).join("|")
      === `BASELINE_ALREADY_REGISTERED||${q3.pq}|openai_chatgpt`);
  check("R13 a source that is not a reviewed, current action version of this pilot is SOURCE_ACTION_NOT_CURRENT",
    R([q1.pq], { sources: `array[${lit(randomUUID())}::uuid]` })[0] === "SOURCE_ACTION_NOT_CURRENT");
  check("R14 none of the refusals wrote anything", written() === base0, written());

  /* A: atomicity (S2) ----------------------------------------------------- */
  const statusOf = (protocolId: string) => admin(`select status from public.protocols where id = ${lit(protocolId)}::uuid;`);
  const q2cgStatus = statusOf(q2.cg);
  admin(`begin;\n${REPLICA}\nupdate public.protocols set status = 'abandoned' where id = ${lit(q2.cg)}::uuid;\ncommit;`); // test setup: the fourth baseline no longer executable
  const aErr = fails(REGISTER(pilotR, [q1.pq, q2.pq])) ?? "";
  admin(`begin;\n${REPLICA}\nupdate public.protocols set status = ${lit(q2cgStatus)} where id = ${lit(q2.cg)}::uuid;\ncommit;`); // test setup: restored
  check("A1 (a) register_intervention raising mid-loop (the fourth baseline is no longer executable) rolls the whole step back: no group, member, step or intervention",
    aErr.includes("protocol_not_executable") && written() === base0 && statusOf(q2.cg) === q2cgStatus, aErr.split("\n")[0]);
  admin(`create function public.zz_retest_atomicity_b() returns trigger language plpgsql as $t$
begin
  if (select count(*) from public.pilot_retest_members m where m.pilot_retest_id = new.pilot_retest_id) = 3 then
    perform set_config('session_replication_role', 'replica', true);
    update public.interventions set status = 'rejected', rejected_reason = 'Test setup: rejected out of band.', rejected_by = ${lit(FOUNDER)}::uuid, rejected_at = now() where id = new.intervention_id;
    perform set_config('session_replication_role', 'origin', true);
  end if;
  return null;
end $t$;
create trigger zz_retest_atomicity_b after insert on public.pilot_retest_members for each row execute function public.zz_retest_atomicity_b();`);
  const bErr = fails(REGISTER(pilotR, [q1.pq, q2.pq])) ?? "";
  admin(`drop trigger zz_retest_atomicity_b on public.pilot_retest_members;\ndrop function public.zz_retest_atomicity_b();`);
  check("A2 (b) approve_intervention returning no row (the third member's intervention rejected out of band) raises, and nothing persists",
    bErr.includes("pilot_retest_register_failed:approve_intervention") && written() === base0
      && admin(`select count(*) from pg_proc where proname = 'zz_retest_atomicity_b';`) === "0", bErr.split("\n")[0]);

  // The happy path.
  const keyR = randomUUID();
  const [rOut, groupR] = register(pilotR, [q2.pq, q1.pq], { key: `${lit(keyR)}::uuid`, days: "14" });
  const membersR = membersOf(groupR);
  check("R15 a change on two questions is REGISTERED with four members in member order (question ordinal, Perplexity before ChatGPT)",
    rOut === "REGISTERED" && membersR.map((m) => `${m[1]}:${m[2]}:${m[3]}`).join(",")
      === [`${q1.pq}:perplexity_sonar:${q1.px}`, `${q1.pq}:openai_chatgpt:${q1.cg}`, `${q2.pq}:perplexity_sonar:${q2.px}`, `${q2.pq}:openai_chatgpt:${q2.cg}`].join(","),
    JSON.stringify(membersR));
  const interventionRow = (id: string) => row(admin(`select i.status, (i.approved_at = r.registered_at)::text, i.approved_by::text, i.protocol_id::text,
    (i.hypothesis = r.hypothesis and i.expected_mechanism = r.expected_mechanism and i.action_type = r.action_type and i.action_target = r.change_target
      and i.owner = r.change_owner and i.alternative_explanations = r.alternative_explanations and i.confounders_to_monitor = r.confounders_to_monitor
      and i.decision_threshold_note = r.decision_threshold)::text,
    (i.implementation_deadline = (r.implement_by + 1)::timestamp at time zone 'UTC')::text, i.expected_observation_days::text,
    (i.supporting_evidence::text = (select jsonb_agg(a.id order by a.baseline_ordinal)::text from public.protocol_attempts a join public.probe_results pr on pr.probe_run_id = a.probe_run_id where a.protocol_id = i.protocol_id and a.status = 'completed' and pr.client_mentioned is not null))::text
    from public.interventions i join public.pilot_retest_members m on m.intervention_id = i.id join public.pilot_retests r on r.id = m.pilot_retest_id where i.id = ${lit(id)}::uuid;`));
  check("R16 each member's intervention is approved in the same transaction (approved_at = registered_at), by the founder, on its baseline, with the registered text, the deadline, the window and the 5 readable answers as evidence",
    membersR.every((m) => interventionRow(m[4]).join("|") === `approved|true|${FOUNDER}|${m[3]}|true|true|14|true`), membersR.map((m) => interventionRow(m[4]).join("|")).join(" ; "));
  check("R17 the group: sequence 1, rule pilot-outcome-card/1, implement_by = the pilot's end - 7 - the waiting period, the text trimmed as given; one register step naming the four baselines",
    admin(`select sequence || '|' || outcome_rule || '|' || (implement_by = (select ends_on from public.pilots where id = ${lit(pilotR)}::uuid) - 21)::text || '|' || change_title from public.pilot_retests where id = ${lit(groupR)}::uuid;`)
      === `1|pilot-outcome-card/1|true|${TEXT.title}`
      && admin(`select step || '|' || (baseline_protocol_ids = array[${[q1.px, q1.cg, q2.px, q2.cg].map((p) => `${lit(p)}::uuid`).join(", ")}])::text from public.pilot_retest_steps where pilot_retest_id = ${lit(groupR)}::uuid;`) === "register|true");
  const afterReg = written();
  check("R18 a repeated press replays: ALREADY_REGISTERED with the same group, nothing written; the same key with another body is a conflict",
    register(pilotR, [q1.pq, q2.pq], { key: `${lit(keyR)}::uuid`, days: "14" }).join("|") === `ALREADY_REGISTERED|${groupR}||`
      && register(pilotR, [q1.pq, q2.pq], { key: `${lit(keyR)}::uuid`, days: "15" })[0] === "IDEMPOTENCY_KEY_CONFLICT" && written() === afterReg);
  check("R19 a second live group is refused while this one is not abandoned (RETEST_ALREADY_REGISTERED)", register(pilotR, [q3.pq])[0] === "RETEST_ALREADY_REGISTERED");

  /* S: the generic M7 paths on a pilot baseline (S11), before confirmation */
  const [m1, , , m1Base, m1Int] = membersR[0];
  const iRow = (id: string) => admin(`select status || '|' || updated_at::text || '|' || coalesce(implemented_at::text, '') from public.interventions where id = ${lit(id)}::uuid;`);
  const m1Before = iRow(m1Int);
  const reApprove = psql(`select count(*) from public.approve_intervention(${lit(m1Int)}::uuid, ${lit(projectR)}::uuid, ${lit(FOUNDER)}::uuid);`);
  check("S1 approve_intervention on an approved member returns the row and writes nothing (status and updated_at unchanged)", reApprove === "1" && iRow(m1Int) === m1Before);
  const genericErr = (sql: string) => (fails(sql) ?? "").split("\n").find((l) => l.includes("ERROR")) ?? "no error";
  const sConfirm = genericErr(`select count(*) from public.confirm_intervention_implementation(${lit(m1Int)}::uuid, ${lit(projectR)}::uuid, ${lit(FOUNDER)}::uuid, '{"note":"generic"}'::jsonb, null, null);`);
  const sDeviation = genericErr(`select count(*) from public.confirm_intervention_implementation(${lit(m1Int)}::uuid, ${lit(projectR)}::uuid, ${lit(FOUNDER)}::uuid, '{"note":"generic"}'::jsonb, null, 'A deviation.');`);
  const sAbandon = genericErr(`select count(*) from public.abandon_intervention(${lit(m1Int)}::uuid, ${lit(projectR)}::uuid, ${lit(FOUNDER)}::uuid, 'Generic abandon.');`);
  const sRegister = genericErr(`select count(*) from public.register_intervention(${lit(projectR)}::uuid, ${lit(q3.px)}::uuid, 'h', 'm', 'other', 't', 'o', '[]'::jsonb);`);
  check("S2 as service_role, confirm on an approved member, abandon, and registering on another pilot baseline are refused (pilot_intervention_outside_retest); a deviation is refused as such",
    sConfirm.includes("pilot_intervention_outside_retest") && sAbandon.includes("pilot_intervention_outside_retest")
      && sRegister.includes("pilot_intervention_outside_retest") && sDeviation.includes("pilot_deviation_not_allowed") && iRow(m1Int) === m1Before,
    [sConfirm, sAbandon, sRegister, sDeviation].join(" | "));

  /* C: confirm ------------------------------------------------------------ */
  const C = (over: Parameters<typeof CONFIRM>[2] = {}, setup = "") => (setup ? probe(setup, CONFIRM(pilotR, groupR, over)) : psql(CONFIRM(pilotR, groupR, over))).split("|");
  const badC = (over: Parameters<typeof CONFIRM>[2]) => (fails(CONFIRM(pilotR, groupR, over)) ?? "").includes("invalid_confirm_pilot_retest_implementation_args");
  const BADC: [string, Parameters<typeof CONFIRM>[2]][] = [
    ["neither a URL nor a fingerprint", { url: "null" }], ["a URL that is not http", { url: lit("ftp://shop.example/x") }],
    ["an untrimmed URL", { url: lit(" https://shop.example/compare") }], ["a short fingerprint", { sha: lit("abc") }],
    ["a go-live date in the future", { wentLive: "current_date + 1" }], ["a note of 9 characters", { note: lit("Too short") }],
    ["a deviation note while as registered", { deviation: lit("Published without the table.") }],
    ["no deviation note while not as registered", { asRegistered: "false" }], ["a null confirmation", { confirmed: "null" }],
  ];
  const badCOut = BADC.filter(([, over]) => !badC(over)).map(([n]) => n);
  check("C1 every malformed argument raises 22023 invalid_confirm_pilot_retest_implementation_args", badCOut.length === 0, badCOut.join(", "));
  check("C2 an unknown pilot or group is not found; without confirmation nothing is recorded",
    row(psql(CONFIRM(randomUUID(), groupR)))[0] === "PILOT_NOT_FOUND" && row(psql(CONFIRM(pilotR, randomUUID())))[0] === "RETEST_NOT_FOUND"
      && C({ confirmed: "false" })[0] === "CONFIRMATION_REQUIRED");
  check("C3 a closed pilot refuses, a go-live before registration refuses (M17), a window past the pilot's end - 7 refuses (test setups rolled back)",
    C({}, `update public.pilots set status = 'closed', closed_by = ${lit(FOUNDER)}::uuid, closed_at = now(), close_reason = 'Test setup, rolled back.' where id = ${lit(pilotR)}::uuid;`)[0] === "PILOT_CLOSED"
      && C({ wentLive: "current_date - 1" })[0] === "WENT_LIVE_BEFORE_REGISTRATION"
      && C({}, `update public.pilots set starts_on = current_date - 70, ends_on = current_date + 20 where id = ${lit(pilotR)}::uuid;`)[0] === "WINDOW_PAST_PILOT_END");
  const twenty = Array.from({ length: 20 }, (_, i) => NOTE(pilotR, groupR, { text: lit(`Test setup note ${i + 10} rolled back.`) })).join("\n");
  check("C4 a deviation note that would be the 21st note is NOTE_LIMIT_REACHED (20 notes added in the same rolled-back transaction)",
    probe("", `${twenty}\n${CONFIRM(pilotR, groupR, { asRegistered: "false", deviation: lit("The page went live without the comparison table.") })}`).split("\n").pop()?.startsWith("NOTE_LIMIT_REACHED") === true);
  const [cOut, closes] = C({ sha: lit(sha("the published page")), asRegistered: "false", deviation: lit("The page went live without the comparison table.") });
  const implRows = admin(`select count(distinct i.implemented_at) || '|' || count(distinct i.observation_window_closes_at) || '|' || bool_and(i.implemented_at = r.implemented_at and i.observation_window_opens_at = r.window_opens_at and i.observation_window_closes_at = r.window_closes_at and i.status = 'implemented' and i.protocol_deviations is null and i.artifact_sha256 = r.artifact_sha256)::text || '|' || (r.window_closes_at = r.implemented_at + interval '14 days')::text
    from public.interventions i join public.pilot_retest_members m on m.intervention_id = i.id join public.pilot_retests r on r.id = m.pilot_retest_id where r.id = ${lit(groupR)}::uuid group by r.window_closes_at, r.implemented_at;`);
  check("C5 IMPLEMENTED: every member implemented with one now() and one window (14 days), deviations null, the group's tuple written",
    cOut === "IMPLEMENTED" && closes !== "" && implRows === "1|1|true|true", implRows);
  check("C6 the departure is logged as an implementation_issue note dated the go-live day; a replay answers ALREADY_IMPLEMENTED with the stored window",
    admin(`select kind || '|' || (noted_on = current_date)::text || '|' || text from public.pilot_retest_notes where pilot_retest_id = ${lit(groupR)}::uuid;`)
      === "implementation_issue|true|The page went live without the comparison table."
      && C().join("|") === `ALREADY_IMPLEMENTED|${closes}`);
  const m1Impl = iRow(m1Int);
  const reConfirm = psql(`select count(*) from public.confirm_intervention_implementation(${lit(m1Int)}::uuid, ${lit(projectR)}::uuid, ${lit(FOUNDER)}::uuid, '{"note":"again"}'::jsonb, null, null);`);
  const sEarly = genericErr(`select count(*) from public.authorize_early_retest(${lit(m1Int)}::uuid, ${lit(projectR)}::uuid, ${lit(FOUNDER)}::uuid, 'Early.');`);
  check("S3 confirm_intervention_implementation on an implemented member writes nothing; an early retest is refused (pilot_early_retest_not_allowed)",
    reConfirm === "1" && iRow(m1Int) === m1Impl && sEarly.includes("pilot_early_retest_not_allowed"), sEarly);

  /* P: prepare ------------------------------------------------------------ */
  const [, pilotN, projectN] = createPilot("rt-n.example");
  const n1 = liveQuestion(pilotN, projectN, 31);
  const [, groupN] = register(pilotN, [n1.pq]);
  check("P1 a group not yet live is NOT_IMPLEMENTED; a live one whose window is open is WINDOW_OPEN",
    prepare(pilotN, groupN)[0] === "NOT_IMPLEMENTED" && prepare(pilotR, groupR).join("|") === `WINDOW_OPEN||${closes}`);
  check("P2 a member whose own window is still open is MEMBER_NOT_ELIGIBLE, all or nothing (test setup, rolled back, replica: only the group's window moved)",
    probe(`${REPLICA}\nupdate public.pilot_retests set implemented_at = implemented_at - interval '20 days', window_opens_at = window_opens_at - interval '20 days', window_closes_at = window_closes_at - interval '20 days' where id = ${lit(groupR)}::uuid;\n${ORIGIN}`, PREPARE(pilotR, groupR)).startsWith("MEMBER_NOT_ELIGIBLE|"));
  closeWindow(groupR); // S12
  const sRetest = genericErr(`select * from public.create_retest_protocol(${lit(m1Int)}::uuid, ${lit(projectR)}::uuid, ${lit(FOUNDER)}::uuid);`);
  check("S4 with the window closed, the generic create_retest_protocol on a member is refused before preparation (pilot_retest_outside_group)",
    sRetest.includes("pilot_retest_outside_group") && count(`public.protocols where baseline_protocol_id = ${lit(m1Base)}::uuid`) === 0, sRetest);
  check("P3 a closed pilot refuses preparation (test setup, rolled back)",
    probe(`update public.pilots set status = 'closed', closed_by = ${lit(FOUNDER)}::uuid, closed_at = now(), close_reason = 'Test setup, rolled back.' where id = ${lit(pilotR)}::uuid;`, PREPARE(pilotR, groupR)).startsWith("PILOT_CLOSED|"));
  const [pOut, pCount] = prepare(pilotR, groupR);
  const retestsR = membersR.map((m) => retestOf(m[0]));
  const retestRows = retestsR.map((rp, i) => admin(`select (p.baseline_protocol_id = ${lit(membersR[i][3])}::uuid)::text || '|' || p.provider || '|' || p.status || '|' || p.planned_baseline_runs || '|' || (p.minimum_useful_change ->> 'value') || '|' || p.detectable_change_at_plan || '|' || (p.buyer_question_version_id = b.buyer_question_version_id)::text || '|' || j.status
     from public.protocols p join public.protocols b on b.id = p.baseline_protocol_id join public.protocol_execution_jobs j on j.protocol_id = p.id where p.id = ${lit(rp)}::uuid;`));
  check("P4 PREPARED 4: each member has an approved retest of its baseline on its engine, 5 planned runs, a smallest useful change of 0.60, a detectable change of 0.6 at plan, a queued job and a retest slot naming it",
    pOut === "PREPARED" && pCount === "4" && retestsR.every((r) => r !== "")
      && retestRows.every((r, i) => r === `true|${membersR[i][2]}|approved|5|0.60|0.6|true|queued`), retestRows.join(" ; "));
  check("P5 a replay answers ALREADY_PREPARED with the same count; a prepare step is recorded once",
    prepare(pilotR, groupR).join("|").startsWith("ALREADY_PREPARED|4|")
      && count(`public.pilot_retest_steps where pilot_retest_id = ${lit(groupR)}::uuid and step = 'prepare'`) === 1);
  const jobsR = retestsR.map(jobOf);

  /* J: retest jobs -------------------------------------------------------- */
  check("J1 a closed pilot's retest cannot be Run (test setup, rolled back)",
    probe(`update public.pilots set status = 'closed', closed_by = ${lit(FOUNDER)}::uuid, closed_at = now(), close_reason = 'Test setup, rolled back.' where id = ${lit(pilotR)}::uuid;`,
      `select outcome from public.request_protocol_job_run(${lit(jobsR[0])}::uuid, ${lit(projectR)}::uuid, 'admin_pilot_run', ${lit(FOUNDER)}::uuid, 120);`) === "PILOT_CLOSED");
  quiesce();
  const [runOut, runReq] = requestRun(jobsR[0], projectR);
  check("J2 a Run of a retest is REQUESTED although two slot rows (the retest's and its baseline's) match its pilot lookup",
    runOut === "REQUESTED" && count(`public.pilot_question_protocols where protocol_id in (${lit(retestsR[0])}::uuid, ${lit(membersR[0][3])}::uuid)`) === 2);
  cancelRun(runReq);
  visit(jobsR[0], projectR, "perplexity", "retest", { mentioned: 5 });
  check("J3 the claim takes the retest job and five retest attempts complete it (succeeded)", jobState(jobsR[0]).startsWith("succeeded")
    && admin(`select string_agg(distinct attempt_kind, ',') || '|' || count(*) from public.protocol_attempts where protocol_id = ${lit(retestsR[0])}::uuid;`) === "retest|5");
  visit(jobsR[2], projectR, "perplexity", "retest", { attempts: 1, providerError: true });
  const failedRetest = admin(`select id from public.protocol_attempts where protocol_id = ${lit(retestsR[2])}::uuid;`);
  const [retryOut] = row(psql(`select outcome from public.retry_failed_protocol_job(${lit(jobsR[2])}::uuid, ${lit(projectR)}::uuid, ${lit(FOUNDER)}::uuid, 'Perplexity answered HTTP 429 on run 1.', ${lit(failedRetest)}::uuid, ${lit(randomUUID())});`));
  check("J4 a retest that failed at the provider is retried (APPROVED: queued with its retry reserved)", retryOut === "APPROVED" && jobState(jobsR[2]).startsWith("queued"));

  /* Q: requeue ------------------------------------------------------------ */
  quiesce();
  const tokQ = (() => { requestRun(jobsR[1], projectR); return claim()[2]; })();
  const failedQ = psql(`select status from public.fail_protocol_execution_job(${lit(jobsR[1])}::uuid, ${lit(tokQ)}::uuid, ${lit(projectR)}::uuid, 'PROVIDER_ADAPTER_NOT_ENABLED');`);
  check("Q1 a ChatGPT retest refused before admission is failed with no attempt", failedQ === "FAILED"
    && jobState(jobsR[1]) === "failed:PROVIDER_ADAPTER_NOT_ENABLED:1" && count(`public.protocol_attempts where protocol_id = ${lit(retestsR[1])}::uuid`) === 0);
  const [q1Engine] = [membersR[1][2]];
  check("Q2 the requeue refusals: an unknown member, a retest that has answers, one already queued, one held by a lock, and a closed pilot",
    requeue(pilotR, groupR, randomUUID(), "openai_chatgpt")[0] === "MEMBER_NOT_FOUND"
      && requeue(pilotR, groupR, q1.pq, "perplexity_sonar")[0] === "JOB_NOT_STOPPED_BEFORE_ANSWERS"
      && requeue(pilotR, groupR, q2.pq, "openai_chatgpt").join("|") === `ALREADY_QUEUED|${jobsR[3]}`
      && probe(`update public.pilots set status = 'closed', closed_by = ${lit(FOUNDER)}::uuid, closed_at = now(), close_reason = 'Test setup, rolled back.' where id = ${lit(pilotR)}::uuid;`, REQUEUE(pilotR, groupR, q1.pq, q1Engine)).startsWith("PILOT_CLOSED|")
      && row(psql(REQUEUE(pilotN, groupN, n1.pq, "openai_chatgpt")))[0] === "NOT_PREPARED"
      && (fails(REQUEUE(pilotR, groupR, q1.pq, "gemini")) ?? "").includes("invalid_requeue_pilot_retest_job_args"));
  // Two sessions: a lock on the job makes the requeue answer RETEST_JOB_BUSY (never a wait).
  const markerQ = `zp-rt-qbusy-${randomUUID()}`;
  const heldQ = background(`begin;\nselect 1 from public.protocol_execution_jobs where id = ${lit(jobsR[1])}::uuid for update;\nselect pg_sleep(4) /* ${markerQ} */;\nrollback;\n`, "supabase_admin");
  const activeQ = await waitActive(markerQ);
  const busyQ = requeue(pilotR, groupR, q1.pq, "openai_chatgpt");
  await heldQ.done;
  check("Q3 while the job row is locked elsewhere, requeue answers RETEST_JOB_BUSY at once", activeQ && busyQ[0] === "RETEST_JOB_BUSY", busyQ.join("|"));
  const [rqOut, rqJob] = requeue(pilotR, groupR, q1.pq, "openai_chatgpt");
  check("Q4 REQUEUED: the job is queued with a fresh claim budget and no failure; a requeue step records the reason",
    rqOut === "REQUEUED" && rqJob === jobsR[1] && jobState(jobsR[1]) === "queued::0"
      && admin(`select step || '|' || note from public.pilot_retest_steps where member_id = ${lit(membersR[1][0])}::uuid;`) === "requeue|The worker was not set up for this engine yet.");
  visit(jobsR[1], projectR, "chatgpt", "retest", { mentioned: 0 });
  check("Q5 the requeued ChatGPT retest then runs through the Run, the claim, admission and reservation to its five answers",
    jobState(jobsR[1]).startsWith("succeeded") && count(`public.protocol_attempts where protocol_id = ${lit(retestsR[1])}::uuid and status = 'completed'`) === 5);

  /* F: finality parity ---------------------------------------------------- */
  const PILOT_ENDED = `update public.pilots set starts_on = current_date - 91, ends_on = current_date - 1 where id = ${lit(pilotR)}::uuid;`;
  const PILOT_CLOSED_SQL = `update public.pilots set status = 'closed', closed_by = ${lit(FOUNDER)}::uuid, closed_at = now(), close_reason = 'Test setup, rolled back.' where id = ${lit(pilotR)}::uuid;`;
  const setJob = (job: string, cols: string) => `update public.protocol_execution_jobs set ${cols} where id = ${lit(job)}::uuid;`;
  const LEASE = `worker_id = 'w', claim_token = gen_random_uuid(), lease_expires_at = now() + interval '1 minute'`;
  const parityCases: [string, string, string, boolean | null][] = [
    ["succeeded", jobsR[0], "", true],
    ["queued, pilot open", jobsR[3], "", false],
    ["queued, pilot ended", jobsR[3], PILOT_ENDED, true],
    ["queued, pilot closed", jobsR[3], PILOT_CLOSED_SQL, true],
    ["claimed, pilot open", jobsR[3], setJob(jobsR[3], `status = 'claimed', ${LEASE}`), false],
    ["running, pilot ended", jobsR[3], `${setJob(jobsR[3], `status = 'running', ${LEASE}`)}\n${PILOT_ENDED}`, true],
    ["needs_review", jobsR[3], setJob(jobsR[3], "status = 'needs_review', needs_review_reason = 'test'"), false],
    ["needs_review, pilot ended", jobsR[3], `${setJob(jobsR[3], "status = 'needs_review', needs_review_reason = 'test'")}\n${PILOT_ENDED}`, false],
    ["abandoned_exhausted", jobsR[3], setJob(jobsR[3], "status = 'abandoned_exhausted'"), true],
    ["cancelled", jobsR[3], setJob(jobsR[3], "status = 'cancelled'"), true],
    ["failed before any answer (requeueable)", jobsR[3], setJob(jobsR[3], "status = 'failed', failure_reason = 'PROVIDER_ADAPTER_NOT_ENABLED'"), false],
    ["failed before any answer, pilot ended", jobsR[3], `${setJob(jobsR[3], "status = 'failed', failure_reason = 'PROVIDER_ADAPTER_NOT_ENABLED'")}\n${PILOT_ENDED}`, true],
    ["failed before any answer, at the requeue limit", jobsR[3],
      `${setJob(jobsR[3], "status = 'failed', failure_reason = 'PROVIDER_ADAPTER_NOT_ENABLED'")}\ninsert into public.pilot_retest_steps (pilot_retest_id, pilot_id, project_id, step, member_id, note, performed_by) select ${lit(groupR)}::uuid, ${lit(pilotR)}::uuid, ${lit(projectR)}::uuid, 'requeue', ${lit(membersR[3][0])}::uuid, 'Test setup, rolled back.', ${lit(FOUNDER)}::uuid from generate_series(1, 3);`, true],
    ["failed, reviewed", jobsR[3], setJob(jobsR[3], "status = 'failed', failure_reason = 'resolved_by_review', review_resolution = 'failed'"), true],
    ["failed with answers, not a provider error", jobsR[0], setJob(jobsR[0], "status = 'failed', failure_reason = 'cap'"), true],
    ["queued with a reserved retry (open pilot)", jobsR[2], "", false],
  ];
  const parity = parityCases.map(([label, job, setup, expected]) => {
    const f = finality(job, setup);
    return { label, ok: f.fn === f.ts && (expected === null || f.fn === expected), detail: `${label}: sql ${f.fn} ts ${f.ts} expected ${expected}` };
  });
  check(`F1 pilot_retest_job_is_final equals retestJobIsFinal on the same rows in all ${parity.length} states, each as the rule says`,
    parity.every((p) => p.ok), parity.filter((p) => !p.ok).map((p) => p.detail).join(" ; "));
  // A provider failure that is retryable, then the same with no run cap left (final once the pilot cannot run it either).
  const [, pilotF, projectF] = createPilot("rt-f.example");
  const f1 = liveQuestion(pilotF, projectF, 41);
  const [, groupF] = register(pilotF, [f1.pq]);
  confirm(pilotF, groupF);
  closeWindow(groupF);
  prepare(pilotF, groupF);
  const jobF = jobOf(retestOf(membersOf(groupF)[0][0]));
  visit(jobF, projectF, "perplexity", "retest", { attempts: 1, providerError: true });
  const fRetry = finality(jobF);
  const fNoCap = finality(jobF, `${REPLICA}\nupdate public.protocols set run_cap = 5 where id = (select protocol_id from public.protocol_execution_jobs where id = ${lit(jobF)}::uuid);\n${ORIGIN}`);
  const fEnded = finality(jobF, `update public.pilots set starts_on = current_date - 91, ends_on = current_date - 1 where id = ${lit(pilotF)}::uuid;`);
  check("F2 a retest failed at the provider is not final while its retry fits the run cap; with no cap left, or once the pilot ended, it is final; SQL and TypeScript agree",
    fRetry.fn === false && fRetry.ts === false && fNoCap.fn === true && fNoCap.ts === true && fEnded.fn === true && fEnded.ts === true,
    `${fRetry.fn}/${fRetry.ts} ${fNoCap.fn}/${fNoCap.ts} ${fEnded.fn}/${fEnded.ts}`);
  check("F3 a job that is not a pilot retest slot's is null (a baseline job)", admin(`select coalesce(public.pilot_retest_job_is_final(${lit(q1.jobPx)}::uuid)::text, 'null');`) === "null");

  /* T: retirement --------------------------------------------------------- */
  const retireQ = (pq: string) => psql(`select outcome from public.retire_pilot_question(${lit(pilotR)}::uuid, ${lit(pq)}::uuid, ${lit(FOUNDER)}::uuid, 'The measurement cannot go on.');`);
  check("T1 a member question is never retired: its baselines succeeded for good, so it is QUESTION_NOT_STOPPED", retireQ(q2.pq) === "QUESTION_NOT_STOPPED");
  quiesce();
  const [tReq, tReqId] = requestRun(jobsR[3], projectR);
  check("T2 while its retest has a pending Run it is QUESTION_JOB_ACTIVE", tReq === "REQUESTED" && retireQ(q2.pq) === "QUESTION_JOB_ACTIVE");
  cancelRun(tReqId);

  /* V: the report save and share ----------------------------------------- */
  // Finish the retried Perplexity retest of question 2 so three retests are final; ChatGPT's stays queued (not final).
  visit(jobsR[2], projectR, "perplexity", "retest", { attempts: 5, mentioned: 3, reservedFirst: true });
  check("V0 setup: three retests final with answers (two Perplexity, one ChatGPT) and one queued",
    [0, 1, 2].every((i) => jobState(jobsR[i]).startsWith("succeeded")) && jobState(jobsR[3]).startsWith("queued"), jobsR.map(jobState).join(" "));
  const cards: Card[] = [{ memberId: membersR[0][0], status: "increase_observed" }, { memberId: membersR[1][0], status: "no_clear_change" }, { memberId: membersR[2][0], status: "inconclusive" }];
  let inputs = buildInputs(pilotR);
  const save = (c: Card[], opts: Parameters<typeof SAVE>[3] = {}) => row(psql(SAVE(pilotR, inputs, c, opts)));
  const saveErr = (c: Card[], opts: Parameters<typeof SAVE>[3] = {}) => (fails(SAVE(pilotR, inputs, c, opts)) ?? "").includes("invalid_save_pilot_report_args");
  const revisions = () => count(`public.pilot_report_artifacts where pilot_id = ${lit(pilotR)}::uuid`);
  const rev0 = revisions();
  const control = fails(`begin;\nset local role service_role;\n${SAVE(pilotR, inputs, cards)}\nrollback;`, "supabase_admin");
  if (control !== null && process.env.ZYPACT_DEBUG_DIR) {
    writeFileSync(`${process.env.ZYPACT_DEBUG_DIR}/v-control.sql`, SAVE(pilotR, inputs, cards));
  }
  check("V1a the control: the build as read saves (rolled back)", control === null, control ?? "");
  type Mut = NonNullable<Parameters<typeof SAVE>[3]>["mutate"];
  const SHAPES: [string, Mut, string?][] = [
    ["a state outside the four", (m) => { (m.retests as { state: string }[])[0].state = "live"; }],
    ["a group listed twice", (m) => { (m.retests as unknown[]).push((m.retests as unknown[])[0]); }],
    ["a note id that is not a uuid", (m) => { m.retestNotes = ["not-a-uuid"]; }],
    ["a job without a review resolution key", (m) => { delete (m.retestJobs as Record<string, unknown>[])[0].reviewResolution; }],
    ["a card status outside the four", (m, p) => { (m.retestCards as { status: string }[])[0].status = "won"; (p.outcomeCards as { status: string }[])[0].status = "won"; }],
    ["a card without the footer", (_m, p) => { (p.outcomeCards as { footer: string }[])[0].footer = "Shortened."; }],
    ["a payload group the manifest does not list", (_m, p) => { (p.retests as Record<string, unknown>[]).push({ ...(p.retests as Record<string, unknown>[])[0], retestId: randomUUID() }); }],
    ["a payload card the manifest does not list", (m) => { (m.retestCards as unknown[]).pop(); }],
    ["retests as an object", (m) => { m.retests = {}; }],
  ];
  const shapeOut = SHAPES.filter(([, mutate]) => !saveErr(cards, { mutate })).map(([n]) => n);
  check("V1 the save refuses malformed retest lists and cards with 22023 (each case), and a retest revision saved integrity_passed",
    shapeOut.length === 0 && saveErr(cards, { status: "integrity_passed" }) && revisions() === rev0, shapeOut.join(", "));
  check("V2 RETESTS_CHANGED: a group's state, a missing note, or a retest job's status that is not what is stored",
    save(cards, { mutate: (m) => { (m.retests as { state: string }[])[0].state = "implemented"; } })[0] === "RETESTS_CHANGED"
      && save(cards, { mutate: (m) => { m.retestNotes = []; } })[0] === "RETESTS_CHANGED"
      && save(cards, { mutate: (m) => { (m.retestJobs as { status: string }[])[0].status = "failed"; } })[0] === "RETESTS_CHANGED");
  check("V3 RETEST_CARD_MISMATCH: another intervention, a retest answer left out, or a payload status unlike the manifest's",
    save(cards, { mutate: (_m, p) => { (p.outcomeCards as { interventionId: string }[])[0].interventionId = membersR[3][4]; } })[0] === "RETEST_CARD_MISMATCH"
      && save(cards, { mutate: (m) => { (m.retestCards as { retestAttemptIds: string[] }[])[0].retestAttemptIds.pop(); } })[0] === "RETEST_CARD_MISMATCH"
      && save(cards, { mutate: (_m, p) => { (p.outcomeCards as { status: string }[])[0].status = "decrease_observed"; } })[0] === "RETEST_CARD_MISMATCH");
  check("V4 RETEST_CARDS_INCOMPLETE (M1): an unwelcome card left out, or a card for the retest that is not final",
    save(cards.slice(1))[0] === "RETEST_CARDS_INCOMPLETE"
      && save([...cards, { memberId: membersR[3][0], status: "inconclusive" }])[0] === "RETEST_CARDS_INCOMPLETE");
  const textMut = (field: string, value: string, withheld: string[] = []): Mut => (_m, p) => {
    const g = (p.retests as { text: Record<string, string>; withheldFields: string[] }[])[0];
    g.text[field] = value;
    g.withheldFields = withheld;
  };
  check("V5 RETEST_CONTENT_MISMATCH: a registered text changed, a withheld field not listed, a date, a window instant off by 2 ms, a note's text; the same text in a blocked revision is not checked",
    save(cards, { mutate: textMut("hypothesis", "A different hypothesis entirely.") })[0] === "RETEST_CONTENT_MISMATCH"
      && save(cards, { mutate: textMut("hypothesis", PILOT_RETEST_WITHHELD_TEXT) })[0] === "RETEST_CONTENT_MISMATCH"
      && save(cards, { mutate: (_m, p) => { (p.retests as { implementBy: string }[])[0].implementBy = "2030-01-01"; } })[0] === "RETEST_CONTENT_MISMATCH"
      && save(cards, { mutate: (_m, p) => { const g = (p.retests as { windowClosesAt: string }[])[0]; g.windowClosesAt = new Date(Date.parse(g.windowClosesAt) + 2).toISOString(); } })[0] === "RETEST_CONTENT_MISMATCH"
      && save(cards, { mutate: (_m, p) => { (p.retests as { notes: { text: string }[] }[])[0].notes[0].text = "Another text."; } })[0] === "RETEST_CONTENT_MISMATCH"
      && save(cards, { status: "blocked", mutate: textMut("hypothesis", "A different hypothesis entirely.") })[0] === "SAVED");
  const [okOut, artId] = save(cards, {
    mutate: (_m, p) => {
      const g = (p.retests as { text: Record<string, string>; withheldFields: string[]; windowOpensAt: string; notes: { text: string; withheld: boolean }[] }[])[0];
      g.text.decisionThreshold = PILOT_RETEST_WITHHELD_TEXT;
      g.withheldFields = ["decisionThreshold"];
      g.windowOpensAt = new Date(Date.parse(g.windowOpensAt)).toISOString(); // milliseconds, as JavaScript writes them
      g.notes[0].text = PILOT_RETEST_WITHHELD_TEXT;
      g.notes[0].withheld = true;
    },
  });
  check("V6 SAVED: the cards of exactly the final retests, a withheld field and a withheld note shown as the withheld sentence, an instant in milliseconds",
    okOut === "SAVED" && artId !== "");
  check("V7 sharing that revision is allowed (nothing of a retest is running or requested)", psql(SHARE(pilotR, artId)) === "SHARED");
  inputs = buildInputs(pilotR);
  const changedCards: Card[] = [{ ...cards[0], status: "inconclusive" }, cards[1], cards[2]];
  check("V8 the freeze (engineer): a later revision that changes a shared card's status, or leaves it out, is RETEST_CARD_CHANGED_SINCE_SHARED; the same cards save",
    save(changedCards)[0] === "RETEST_CARD_CHANGED_SINCE_SHARED" && save(cards)[0] === "SAVED");
  // Staleness: each change after the build makes the revision stale at share.
  inputs = buildInputs(pilotR);
  const [, artStale] = save(cards);
  const [nOut] = note(pilotR, groupR);
  check("V9 a note written after the build makes the revision RETESTS_STALE", nOut === "ADDED" && psql(SHARE(pilotR, artStale)) === "RETESTS_STALE");
  inputs = buildInputs(pilotR);
  const [, artReview] = save(cards);
  check("V10 a review resolution after the build (rolled back) makes it RETESTS_STALE; so does a retest job's status",
    probe(`update public.protocol_execution_jobs set review_resolution = 'excluded_and_completed' where id = ${lit(jobsR[0])}::uuid;`, SHARE(pilotR, artReview)) === "RETESTS_STALE"
      && probe(setJob(jobsR[3], "status = 'cancelled'"), SHARE(pilotR, artReview)) === "RETESTS_STALE");
  quiesce();
  const [vReq, vReqId] = requestRun(jobsR[3], projectR);
  check("V11 a pending Run of a retest makes the share RETEST_IN_PROGRESS; so does a live lease (rolled back)",
    vReq === "REQUESTED" && psql(SHARE(pilotR, artReview)) === "RETEST_IN_PROGRESS");
  cancelRun(vReqId);
  check("V12 (live lease)", probe(setJob(jobsR[3], `status = 'claimed', ${LEASE}`), SHARE(pilotR, artReview)) === "RETEST_IN_PROGRESS");
  visit(jobsR[3], projectR, "chatgpt", "retest", { attempts: 1 });
  check("V13 a retest attempt after the build makes the revision RETESTS_STALE", psql(SHARE(pilotR, artReview)) === "RETESTS_STALE");
  const [, pilotE, projectE] = createPilot("rt-e.example");
  liveQuestion(pilotE, projectE, 51, { cg: false });
  const plain = buildInputs(pilotE);
  const [plainOut, plainArt] = row(psql(`select outcome || '|' || coalesce(artifact_id::text, '') from public.save_pilot_report_artifact(${lit(pilotE)}::uuid, ${lit(FOUNDER)}::uuid, '# Pilot report', ${lit(JSON.stringify({ pilotId: pilotE, projectId: projectE }))}::jsonb, ${lit(JSON.stringify({ protocols: plain.protocols, attempts: plain.attempts }))}::jsonb, 'integrity_passed', '[]'::jsonb, now());`));
  check("V14 with no group, a revision without any retest key saves integrity_passed and shares as before", plainOut === "SAVED" && psql(SHARE(pilotE, plainArt)) === "SHARED");

  /* B: abandonment and later groups --------------------------------------- */
  const [, pilotB, projectB] = createPilot("rt-b.example");
  const b1 = liveQuestion(pilotB, projectB, 61);
  const b2 = liveQuestion(pilotB, projectB, 62);
  const [, groupB] = register(pilotB, [b1.pq]);
  confirm(pilotB, groupB);
  closeWindow(groupB);
  prepare(pilotB, groupB);
  const membersB = membersOf(groupB);
  const jobsB = membersB.map((m) => jobOf(retestOf(m[0])));
  check("B1 refusals before anything: an unknown group, no confirmation", abandon(pilotB, randomUUID()) === "RETEST_NOT_FOUND" && abandon(pilotB, groupB, "false") === "CONFIRMATION_REQUIRED");
  quiesce();
  const [bReq, bReqId] = requestRun(jobsB[0], projectB);
  check("B2 a pending Run of a retest is RETEST_RUN_PENDING", bReq === "REQUESTED" && abandon(pilotB, groupB) === "RETEST_RUN_PENDING");
  cancelRun(bReqId);
  const markerB = `zp-rt-bbusy-${randomUUID()}`;
  const heldB = background(`begin;\nselect 1 from public.protocol_execution_jobs where id = ${lit(jobsB[1])}::uuid for update;\nselect pg_sleep(4) /* ${markerB} */;\nrollback;\n`, "supabase_admin");
  const activeB = await waitActive(markerB);
  const busyB = abandon(pilotB, groupB);
  await heldB.done;
  check("B3 a retest job locked elsewhere (the worker's own lock, with no pilot lock) makes abandon answer RETEST_JOB_BUSY at once", activeB && busyB === "RETEST_JOB_BUSY", busyB);
  quiesce();
  check("B4 a retest that started (one attempt, rolled back) is RETEST_STARTED",
    probe(`set local role service_role;\n${visitSql(jobsB[0], projectB, "perplexity", "retest", { attempts: 1 })}\nreset role;`, ABANDON(pilotB, groupB)) === "RETEST_STARTED");
  quiesce();
  const [bOut] = [abandon(pilotB, groupB)];
  check("B5 abandoned after preparation with no attempt: every intervention abandoned, the queued retest jobs cancelled, the retest protocols abandoned, the slots kept",
    bOut === "ABANDONED"
      && admin(`select string_agg(distinct i.status, ',') from public.interventions i join public.pilot_retest_members m on m.intervention_id = i.id where m.pilot_retest_id = ${lit(groupB)}::uuid;`) === "abandoned"
      && jobsB.every((j) => jobState(j).startsWith("cancelled:intervention_abandoned"))
      && admin(`select string_agg(distinct p.status, ',') from public.protocols p join public.pilot_question_protocols s on s.protocol_id = p.id join public.pilot_retest_members m on m.id = s.pilot_retest_member_id where m.pilot_retest_id = ${lit(groupB)}::uuid;`) === "abandoned"
      && abandon(pilotB, groupB) === "ALREADY_ABANDONED");
  check("B6 the questions of a change that went live are never registered again (M6a)", register(pilotB, [b1.pq]).join("|") === `QUESTION_IN_EARLIER_LIVE_CHANGE||${b1.pq}|`);
  check("B7 a baseline collected before the earlier change went live is refused (M6b; test setup, rolled back, replica: the earlier go-live moved to tomorrow)",
    probe(`${REPLICA}\nupdate public.pilot_retests set implemented_at = now() + interval '1 day', window_opens_at = now() + interval '1 day', window_closes_at = now() + interval '20 days', went_live_on = current_date + 1 where id = ${lit(groupB)}::uuid;\n${ORIGIN}`, REGISTER(pilotB, [b2.pq])).startsWith(`BASELINE_BEFORE_EARLIER_CHANGE||${b2.pq}|perplexity_sonar`));
  const [b2Out, groupB2] = register(pilotB, [b2.pq]);
  check("B8 a baseline collected after it registers as the second group (sequence 2)", b2Out === "REGISTERED"
    && admin(`select sequence from public.pilot_retests where id = ${lit(groupB2)}::uuid;`) === "2");
  check("B9 abandoned before going live, then a third registration is RETEST_LIMIT_REACHED",
    abandon(pilotB, groupB2) === "ABANDONED" && register(pilotB, [b2.pq])[0] === "RETEST_LIMIT_REACHED");
  // A group abandoned before it went live: its questions may be registered again, with a source action.
  const [, pilotS, projectS] = createPilot("rt-s.example");
  const s1 = liveQuestion(pilotS, projectS, 71);
  const [, groupS1] = register(pilotS, [s1.pq]);
  const sAttempt = admin(`select id from public.protocol_attempts where protocol_id = ${lit(s1.px)}::uuid and status = 'completed' order by baseline_ordinal limit 1;`);
  const [aOut, actionS, versionS] = row(psql(`select outcome, coalesce(saved_action_id::text, ''), coalesce(saved_version_id::text, '') from public.save_pilot_action(${lit(pilotS)}::uuid, null::uuid, null::integer, ${lit(FOUNDER)}::uuid, 'Publish a comparison page', 'The company is named in two of five answers.', 'Publish a plain comparison page on the site.', 'One hypothesis: engines read comparison pages.', 'Engines may change their sources anyway.', 'Whether the page is read in time.', ${lit(JSON.stringify([{ attemptId: sAttempt, sourceUrl: null }]))}::jsonb, ${lit(randomUUID())}::uuid);`));
  const abandonedS1 = abandon(pilotS, groupS1);
  const unreviewed = register(pilotS, [s1.pq], { sources: `array[${lit(versionS)}::uuid]` })[0];
  psql(`select outcome from public.review_pilot_action(${lit(pilotS)}::uuid, ${lit(actionS)}::uuid, 1, ${lit(FOUNDER)}::uuid, true);`);
  const [s2Out, groupS2] = register(pilotS, [s1.pq], { sources: `array[${lit(versionS)}::uuid]` });
  check("B10 a second group follows one abandoned before it went live, on the same question, citing a reviewed source action (unreviewed it was SOURCE_ACTION_NOT_CURRENT)",
    aOut === "SAVED" && abandonedS1 === "ABANDONED" && unreviewed === "SOURCE_ACTION_NOT_CURRENT" && s2Out === "REGISTERED"
      && admin(`select (source_action_version_ids = array[${lit(versionS)}::uuid])::text from public.pilot_retests where id = ${lit(groupS2)}::uuid;`) === "true",
    [aOut, abandonedS1, unreviewed, s2Out].join("/"));
  check("B11 the other not-found and abandoned outcomes: confirm, prepare and requeue on an abandoned group; prepare, abandon and requeue on an unknown pilot or group",
    confirm(pilotB, groupB)[0] === "RETEST_ABANDONED" && prepare(pilotB, groupB)[0] === "RETEST_ABANDONED"
      && requeue(pilotB, groupB, b1.pq, "perplexity_sonar")[0] === "RETEST_ABANDONED"
      && prepare(randomUUID(), groupB)[0] === "PILOT_NOT_FOUND" && prepare(pilotB, randomUUID())[0] === "RETEST_NOT_FOUND"
      && abandon(randomUUID(), groupB) === "PILOT_NOT_FOUND" && requeue(randomUUID(), groupB, b1.pq, "perplexity_sonar")[0] === "PILOT_NOT_FOUND"
      && requeue(pilotB, randomUUID(), b1.pq, "perplexity_sonar")[0] === "RETEST_NOT_FOUND" && note(randomUUID(), groupB)[0] === "PILOT_NOT_FOUND");

  /* A (c): a member abandoned out of band before confirmation -------------- */
  const [, pilotC, projectC] = createPilot("rt-c.example");
  const c1 = liveQuestion(pilotC, projectC, 81);
  const [, groupC] = register(pilotC, [c1.pq]);
  const membersC = membersOf(groupC);
  admin(`begin;\n${REPLICA}\nupdate public.interventions set status = 'abandoned', abandoned_by = ${lit(FOUNDER)}::uuid, abandoned_at = now(), abandoned_reason = 'Test setup: abandoned out of band.' where id = ${lit(membersC[1][4])}::uuid;\ncommit;`);
  const cErr = fails(CONFIRM(pilotC, groupC)) ?? "";
  check("A3 (c) with the last member abandoned out of band, confirm raises and the earlier member is unchanged (approved, no window); the group is not live",
    cErr.includes("pilot_retest_confirm_failed:confirm_intervention_implementation")
      && admin(`select status || '|' || coalesce(observation_window_closes_at::text, 'none') from public.interventions where id = ${lit(membersC[0][4])}::uuid;`) === "approved|none"
      && admin(`select coalesce(implemented_at::text, 'none') from public.pilot_retests where id = ${lit(groupC)}::uuid;`) === "none"
      && count(`public.pilot_retest_steps where pilot_retest_id = ${lit(groupC)}::uuid and step = 'confirm'`) === 0, cErr.split("\n")[0]);

  /* Notes ----------------------------------------------------------------- */
  const keyN = randomUUID();
  const [noteOut, noteId] = note(pilotN, groupN, { key: `${lit(keyN)}::uuid` });
  check("N1 a note is ADDED; its replay is ALREADY_ADDED; the same key for another note is a conflict",
    noteOut === "ADDED" && note(pilotN, groupN, { key: `${lit(keyN)}::uuid` }).join("|") === `ALREADY_ADDED|${noteId}`
      && note(pilotN, groupN, { key: `${lit(keyN)}::uuid`, text: lit("Another competitor page was published.") })[0] === "IDEMPOTENCY_KEY_CONFLICT");
  check("N2 a correction names a note of its group; another note is CORRECTED_NOTE_NOT_FOUND; before the pilot is NOTED_BEFORE_PILOT; an unknown group is RETEST_NOT_FOUND",
    note(pilotN, groupN, { corrects: `${lit(noteId)}::uuid`, kind: lit("other_change"), text: lit("Correction: the page was a press release.") })[0] === "ADDED"
      && note(pilotN, groupN, { corrects: `${lit(randomUUID())}::uuid` })[0] === "CORRECTED_NOTE_NOT_FOUND"
      && note(pilotN, groupN, { notedOn: "current_date - 1" })[0] === "NOTED_BEFORE_PILOT"
      && note(pilotN, randomUUID())[0] === "RETEST_NOT_FOUND"
      && note(pilotB, groupB)[0] === "RETEST_ABANDONED"
      && (fails(NOTE(pilotN, groupN, { kind: lit("engine-change") })) ?? "").includes("invalid_add_pilot_retest_note_args")
      && (fails(NOTE(pilotN, groupN, { notedOn: "current_date + 1" })) ?? "").includes("invalid_add_pilot_retest_note_args"));
  const toTwenty = Array.from({ length: 18 }, (_, i) => NOTE(pilotN, groupN, { text: lit(`Rolled-back test note number ${i + 10}.`) })).join("\n");
  check("N3 the 21st note is NOTE_LIMIT_REACHED (20 per group; the extra notes rolled back)",
    probe("", `${toTwenty}\n${NOTE(pilotN, groupN)}`).split("\n").pop()?.startsWith("NOTE_LIMIT_REACHED") === true);
  check("N4 a closed pilot still accepts a note (engineer; rolled back)",
    probe(`update public.pilots set status = 'closed', closed_by = ${lit(FOUNDER)}::uuid, closed_at = now(), close_reason = 'Test setup, rolled back.' where id = ${lit(pilotN)}::uuid;`, NOTE(pilotN, groupN)).startsWith("ADDED|"));

  /* K: the guards refuse even the owner ------------------------------------ */
  const ownerErr = (sql: string) => (fails(sql, "supabase_admin") ?? "").split("\n").find((l) => l.includes("ERROR")) ?? "no error";
  const kInsert = ownerErr(`insert into public.interventions (project_id, protocol_id, buyer_question_version_id, hypothesis, expected_mechanism, action_type, action_target, owner) select project_id, id, buyer_question_version_id, 'h', 'm', 'other', 't', 'o' from public.protocols where id = ${lit(q3.px)}::uuid;`);
  const kUpdate = ownerErr(`update public.interventions set updated_at = now() where id = ${lit(m1Int)}::uuid;`);
  const kProtocol = ownerErr(`insert into public.protocols (project_id, buyer_question_version_id, baseline_protocol_id, provider, surface, model_config, planned_baseline_runs, planned_retest_runs, paraphrase_plan, unit_of_analysis, primary_metric, minimum_useful_change, sample_planning_method, sample_planning_assumptions, run_cap, spend_cap_usd, time_window_seconds, rate_limit_per_hour, concurrency_limit, retry_cap, observation_window_rule, analyzer_version, entity_resolution_version, methodology_version) select project_id, buyer_question_version_id, id, provider, surface, model_config, planned_baseline_runs, planned_retest_runs, paraphrase_plan, unit_of_analysis, primary_metric, minimum_useful_change, sample_planning_method, sample_planning_assumptions, run_cap, spend_cap_usd, time_window_seconds, rate_limit_per_hour, concurrency_limit, retry_cap, observation_window_rule, analyzer_version, entity_resolution_version, methodology_version from public.protocols where id = ${lit(q3.px)}::uuid;`);
  const kSlot = ownerErr(`insert into public.pilot_question_protocols (pilot_question_id, project_id, engine, phase, protocol_id, pilot_retest_member_id) values (${lit(q2.pq)}::uuid, ${lit(projectR)}::uuid, 'openai_chatgpt', 'retest', ${lit(retestsR[3])}::uuid, ${lit(membersR[3][0])}::uuid);`);
  const kCard = ownerErr(`insert into public.outcome_card_artifacts (intervention_id, project_id, baseline_protocol_id, retest_protocol_id, markdown, payload, generated_at, integrity_status, integrity_reasons, public_token) values (${lit(m1Int)}::uuid, ${lit(projectR)}::uuid, ${lit(m1Base)}::uuid, ${lit(retestsR[0])}::uuid, 'x', '{}'::jsonb, now(), 'needs_review', '["x"]'::jsonb, repeat('a', 43));`);
  check("K1 without a step the owner too is refused: an intervention on a pilot baseline, a member's update, a retest of a pilot baseline, a retest slot, and an Outcome Card row",
    kInsert.includes("pilot_intervention_outside_retest") && kUpdate.includes("pilot_intervention_outside_retest") && kProtocol.includes("pilot_retest_outside_group")
      && kSlot.includes("pilot_retest_slot_inconsistent") && kCard.includes("pilot_outcome_card_lives_in_the_pilot_report"),
    [kInsert, kUpdate, kProtocol, kSlot, kCard].join(" | "));
  const appendOnly = [
    `update public.pilot_retest_members set created_at = now() where pilot_retest_id = ${lit(groupR)}::uuid;`,
    `delete from public.pilot_retest_notes where pilot_retest_id = ${lit(groupR)}::uuid;`,
    `update public.pilot_retest_steps set performed_at = now() where pilot_retest_id = ${lit(groupR)}::uuid;`,
  ].map(ownerErr);
  check("K2 members, notes and steps are append-only, even for the owner (pilot_retest_rows_are_append_only)", appendOnly.every((e) => e.includes("pilot_retest_rows_are_append_only")), appendOnly.join(" | "));
  const gDelete = ownerErr(`delete from public.pilot_retests where id = ${lit(groupR)}::uuid;`);
  const gText = ownerErr(`update public.pilot_retests set hypothesis = 'Another hypothesis, after the fact.' where id = ${lit(groupR)}::uuid;`);
  const gLife = ownerErr(`update public.pilot_retests set window_closes_at = window_closes_at + interval '1 day' where id = ${lit(groupR)}::uuid;`);
  check("K3 a group is never deleted, its registered text never changes, and a lifecycle tuple once written never changes",
    gDelete.includes("pilot_retests_are_append_only") && gText.includes("pilot_retest_registration_is_immutable") && gLife.includes("pilot_retest_lifecycle_is_immutable"),
    [gDelete, gText, gLife].join(" | "));
  // The recovery rule: a planted non-member intervention on a pilot baseline may be closed, and only closed.
  const planted = admin(`begin;\n${REPLICA}\ninsert into public.interventions (project_id, protocol_id, buyer_question_version_id, hypothesis, expected_mechanism, action_type, action_target, owner, supporting_evidence) select project_id, id, buyer_question_version_id, 'h', 'm', 'other', 't', 'o', '["x"]'::jsonb from public.protocols where id = ${lit(q3.cg)}::uuid returning id;\ncommit;`);
  const plantedApprove = genericErr(`select count(*) from public.approve_intervention(${lit(planted)}::uuid, ${lit(projectR)}::uuid, ${lit(FOUNDER)}::uuid);`);
  const plantedAbandon = psql(`select status from public.abandon_intervention(${lit(planted)}::uuid, ${lit(projectR)}::uuid, ${lit(FOUNDER)}::uuid, 'Recovery: a row registered outside a group.');`);
  check("K4 the recovery rule: a non-member intervention on a pilot baseline (planted, replica) cannot be approved, and can be abandoned",
    plantedApprove.includes("pilot_intervention_outside_retest") && plantedAbandon === "abandoned", `${plantedApprove} | ${plantedAbandon}`);

  /* S (S4): a non-pilot intervention end to end beside a group step -------- */
  const nonPilot = admin(`with p as (insert into public.projects (domain) values ('rt-np.example') returning id),
    q as (insert into public.buyer_questions (project_id) select id from p returning id, project_id),
    v as (insert into public.buyer_question_versions (buyer_question_id, project_id, version_number, prompt_text, prompt_hash, intent_type, commercial_value, winnability, priority, rationale, provenance, approved_by, approved_at)
          select q.id, q.project_id, 1, ${lit(question(99))}, ${lit(sha(question(99)))}, 'shortlist', 3, 3, 13, 'Test setup: a project outside the pilots.', 'customer_supplied', ${lit(FOUNDER)}::uuid, now() from q returning id, project_id)
    insert into public.protocols (project_id, buyer_question_version_id, provider, surface, model_config, planned_baseline_runs, planned_retest_runs, unit_of_analysis, primary_metric, sample_planning_method, run_cap, spend_cap_usd, time_window_seconds, rate_limit_per_hour, concurrency_limit, retry_cap, paraphrase_plan)
    select v.project_id, v.id, 'perplexity_sonar', 'answer', '{"model":"sonar"}'::jsonb, 5, 0, 'buyer_question_version', 'presence_rate', 'fixed_operator_default_pending_pilot_calibration', 7, 2, 86400, 10, 1, 2, jsonb_build_array(jsonb_build_object('text', ${lit(question(99))}, 'hash', ${lit(sha(question(99)))})) from v returning id || '|' || project_id;`);
  const [npProtocol, npProject] = nonPilot.split("|");
  const npOut = psql(`begin;
${NOTE(pilotN, groupN, { text: lit("Recorded in the same transaction as M7 work elsewhere.") })}
select a.status from public.approve_protocol(${lit(npProtocol)}::uuid, ${lit(npProject)}::uuid, ${lit(FOUNDER)}::uuid) a;
with i as (select * from public.register_intervention(${lit(npProject)}::uuid, ${lit(npProtocol)}::uuid, 'h', 'm', 'other', 't', 'o', '["x"]'::jsonb, null, null, null, null, 7))
select i.status from i;
select status from public.approve_intervention((select id from public.interventions where protocol_id = ${lit(npProtocol)}::uuid), ${lit(npProject)}::uuid, ${lit(FOUNDER)}::uuid);
select status from public.confirm_intervention_implementation((select id from public.interventions where protocol_id = ${lit(npProtocol)}::uuid), ${lit(npProject)}::uuid, ${lit(FOUNDER)}::uuid, '{"note":"done"}'::jsonb, null, null);
select status from public.authorize_early_retest((select id from public.interventions where protocol_id = ${lit(npProtocol)}::uuid), ${lit(npProject)}::uuid, ${lit(FOUNDER)}::uuid, 'Test: outside the pilots, an early retest stays possible.');
select status_code from public.create_retest_protocol((select id from public.interventions where protocol_id = ${lit(npProtocol)}::uuid), ${lit(npProject)}::uuid, ${lit(FOUNDER)}::uuid);
insert into public.outcome_card_artifacts (intervention_id, project_id, baseline_protocol_id, retest_protocol_id, markdown, payload, generated_at, integrity_status, integrity_reasons, public_token)
select i.id, i.project_id, i.protocol_id, (select p.id from public.protocols p where p.baseline_protocol_id = i.protocol_id), 'x', '{}'::jsonb, now(), 'needs_review', '["x"]'::jsonb, repeat('b', 43)
  from public.interventions i where i.protocol_id = ${lit(npProtocol)}::uuid returning 'CARD';
commit;`);
  check("S5 outside the pilots M7 runs end to end (register, approve, confirm, early retest, retest protocol, card row) in the same transaction as a group step",
    npOut.split("\n").join(",").startsWith("ADDED|") && npOut.split("\n").slice(1).join(",") === "APPROVED,proposed,approved,implemented,implemented,CREATED,CARD", npOut);
  const cardUpdate = ownerErr(`update public.outcome_card_artifacts set baseline_protocol_id = ${lit(m1Base)}::uuid where project_id = ${lit(npProject)}::uuid;`);
  check("S6 an Outcome Card row cannot be pointed at a pilot baseline afterwards (update refused)", cardUpdate.includes("pilot_outcome_card_lives_in_the_pilot_report"), cardUpdate);

  /* W: two sessions (S6) -------------------------------------------------- */
  /** Holds `sql` (its sleep tagged with `marker`) in a background transaction for `seconds`, then ends it. */
  const hold = (sql: string, marker: string, end: "rollback" | "commit", seconds = 3, role: "service_role" | "supabase_admin" = "service_role") =>
    background(`begin;\n${sql}\nselect pg_sleep(${seconds}) /* ${marker} */;\n${end};\n`, role);
  const tag = (n: string) => `zp-rt-${n}-${randomUUID()}`;
  // a Retry against a register (the Retry locks its job, then the pilot FOR SHARE)
  const [, pilotWR, projectWR] = createPilot("rt-wr.example");
  const wr1 = liveQuestion(pilotWR, projectWR, 95);
  const wrFail = liveQuestion(pilotWR, projectWR, 96, { cg: false, run: false });
  visit(wrFail.jobPx, projectWR, "perplexity", "baseline", { attempts: 1, providerError: true });
  const wrFailed = admin(`select id from public.protocol_attempts where protocol_id = ${lit(wrFail.px)}::uuid;`);
  let marker = tag("w2");
  let held = hold(REGISTER(pilotWR, [wr1.pq]), marker, "rollback");
  let active = await waitActive(marker);
  const retryW = row(psql(`select outcome from public.retry_failed_protocol_job(${lit(wrFail.jobPx)}::uuid, ${lit(projectWR)}::uuid, ${lit(FOUNDER)}::uuid, 'Perplexity answered HTTP 429 on run 1.', ${lit(wrFailed)}::uuid, ${lit(randomUUID())});`));
  let heldOut = await held.done;
  check("W1 a Retry against a register: the Retry waits for the pilot row and then completes (APPROVED); no deadlock",
    active && heldOut.startsWith("REGISTERED|") && retryW[0] === "APPROVED", `${heldOut} / ${retryW.join("|")}`);

  const [, pilotW, projectW] = createPilot("rt-w.example");
  const w1 = liveQuestion(pilotW, projectW, 91);
  const w2 = liveQuestion(pilotW, projectW, 92);
  // register against register
  marker = tag("w1");
  held = hold(REGISTER(pilotW, [w1.pq]), marker, "commit");
  active = await waitActive(marker);
  const second = row(psql(REGISTER(pilotW, [w2.pq])));
  heldOut = await held.done;
  check("W2 register against register: the second waits for the pilot row and then answers RETEST_ALREADY_REGISTERED",
    active && heldOut.startsWith("REGISTERED|") && second[0] === "RETEST_ALREADY_REGISTERED", `${heldOut} / ${second[0]}`);
  const groupW = heldOut.split("|")[1];
  let wInputs = buildInputs(pilotW);
  const SAVE_W = () => SAVE(pilotW, wInputs, []);
  // a note against a save: the save waits for the note's pilot lock and sees it
  marker = tag("w3");
  held = hold(NOTE(pilotW, groupW), marker, "commit");
  active = await waitActive(marker);
  const saveAfterNote = row(psql(SAVE_W()));
  heldOut = await held.done;
  check("W3 a note against a save: the save waits for the pilot row, then sees the note (RETESTS_CHANGED), never a half-read",
    active && heldOut.startsWith("ADDED|") && saveAfterNote[0] === "RETESTS_CHANGED", `${heldOut} / ${saveAfterNote[0]}`);
  wInputs = buildInputs(pilotW);
  const savedW = row(psql(SAVE_W()));
  check("W4 the same build saves once nothing moved (the control)", savedW[0] === "SAVED", savedW.join("|"));
  // a confirm against a save
  wInputs = buildInputs(pilotW);
  marker = tag("w5");
  held = hold(CONFIRM(pilotW, groupW), marker, "commit");
  active = await waitActive(marker);
  const saveAfterConfirm = row(psql(SAVE_W()));
  heldOut = await held.done;
  check("W5 a confirm against a save: the save waits, then sees the group live (RETESTS_CHANGED)",
    active && heldOut.startsWith("IMPLEMENTED|") && saveAfterConfirm[0] === "RETESTS_CHANGED", `${heldOut} / ${saveAfterConfirm[0]}`);
  closeWindow(groupW);
  prepare(pilotW, groupW);
  const jobsW = membersOf(groupW).map((m) => jobOf(retestOf(m[0])));
  // a Run of a retest against a save, and against a note
  wInputs = buildInputs(pilotW);
  quiesce();
  marker = tag("w6");
  held = hold(`select outcome from public.request_protocol_job_run(${lit(jobsW[0])}::uuid, ${lit(projectW)}::uuid, 'admin_pilot_run', ${lit(FOUNDER)}::uuid, 120);`, marker, "commit");
  active = await waitActive(marker);
  const saveDuringRun = row(psql(SAVE_W()));
  heldOut = await held.done;
  check("W6 a Run of a retest against a save: the save waits for the Run's pilot share lock, then refuses (MEASUREMENT_IN_PROGRESS)",
    active && heldOut === "REQUESTED" && saveDuringRun[0] === "MEASUREMENT_IN_PROGRESS", `${heldOut} / ${saveDuringRun[0]}`);
  quiesce();
  marker = tag("w7");
  held = hold(`select outcome from public.request_protocol_job_run(${lit(jobsW[1])}::uuid, ${lit(projectW)}::uuid, 'admin_pilot_run', ${lit(FOUNDER)}::uuid, 120);`, marker, "rollback");
  active = await waitActive(marker);
  const noteDuringRun = note(pilotW, groupW);
  heldOut = await held.done;
  check("W7 a Run of a retest against a note: the note waits, then is ADDED", active && heldOut === "REQUESTED" && noteDuringRun[0] === "ADDED", `${heldOut} / ${noteDuringRun[0]}`);
  // abandon against a Run: the Run meets abandon's job lock and answers JOB_LOCKED
  quiesce();
  marker = tag("w8");
  held = hold(ABANDON(pilotW, groupW), marker, "rollback");
  active = await waitActive(marker);
  const runDuringAbandon = requestRun(jobsW[0], projectW);
  heldOut = await held.done;
  check("W8 abandon against a Run: the Run meets abandon's job lock (JOB_LOCKED) at once; no deadlock",
    active && heldOut === "ABANDONED" && runDuringAbandon[0] === "JOB_LOCKED", `${heldOut} / ${runDuringAbandon[0]}`);
  // the other order: a Run holding its job and pilot locks while abandon starts
  quiesce();
  marker = tag("w9");
  held = hold(`select outcome from public.request_protocol_job_run(${lit(jobsW[0])}::uuid, ${lit(projectW)}::uuid, 'admin_pilot_run', ${lit(FOUNDER)}::uuid, 120);`, marker, "rollback");
  active = await waitActive(marker);
  const abandonDuringRun = probe("", ABANDON(pilotW, groupW));
  heldOut = await held.done;
  check("W9 a Run against abandon: abandon waits for the Run's pilot lock, then decides on what is committed (rolled back); no deadlock",
    active && heldOut === "REQUESTED" && ["ABANDONED", "RETEST_JOB_BUSY"].includes(abandonDuringRun), `${heldOut} / ${abandonDuringRun}`);
  // requeue against a Run
  quiesce();
  requestRun(jobsW[1], projectW);
  const [, , tokW] = claim();
  psql(`select status from public.fail_protocol_execution_job(${lit(jobsW[1])}::uuid, ${lit(tokW)}::uuid, ${lit(projectW)}::uuid, 'PROVIDER_ADAPTER_NOT_ENABLED');`);
  marker = tag("w10");
  held = hold(REQUEUE(pilotW, groupW, w1.pq, "openai_chatgpt"), marker, "rollback");
  active = await waitActive(marker);
  const runDuringRequeue = requestRun(jobsW[1], projectW);
  heldOut = await held.done;
  check("W10 requeue against a Run: the Run meets the requeue's job lock (JOB_LOCKED); no deadlock",
    active && heldOut.startsWith("REQUEUED|") && runDuringRequeue[0] === "JOB_LOCKED", `${heldOut} / ${runDuringRequeue[0]}`);
  // the requeue limit
  quiesce();
  let limitOk = true;
  for (let i = 0; i < 3; i += 1) {
    if (requeue(pilotW, groupW, w1.pq, "openai_chatgpt")[0] !== "REQUEUED") limitOk = false;
    requestRun(jobsW[1], projectW);
    const [, , t] = claim();
    psql(`select status from public.fail_protocol_execution_job(${lit(jobsW[1])}::uuid, ${lit(t)}::uuid, ${lit(projectW)}::uuid, 'PROVIDER_ADAPTER_NOT_ENABLED');`);
    quiesce();
  }
  const fLimit = finality(jobsW[1]);
  check("Q6 after 3 requeues the 4th is REQUEUE_LIMIT_REACHED, and the retest is then final with no answer (SQL and TypeScript agree)",
    limitOk && requeue(pilotW, groupW, w1.pq, "openai_chatgpt")[0] === "REQUEUE_LIMIT_REACHED" && fLimit.fn === true && fLimit.ts === true);

  /* X: privileges and RLS ------------------------------------------------- */
  const TABLES = ["pilot_retests", "pilot_retest_members", "pilot_retest_notes", "pilot_retest_steps"];
  check("X1 the four tables have RLS on; service_role may only read them; anon and authenticated may not read them",
    TABLES.every((t) => admin(`select relrowsecurity::text || relforcerowsecurity::text from pg_class where oid = 'public.${t}'::regclass;`) === "truefalse"
      && admin(`select has_table_privilege('service_role', 'public.${t}', 'select')::text || has_table_privilege('service_role', 'public.${t}', 'insert')::text || has_table_privilege('service_role', 'public.${t}', 'update')::text || has_table_privilege('service_role', 'public.${t}', 'delete')::text || has_table_privilege('anon', 'public.${t}', 'select')::text || has_table_privilege('authenticated', 'public.${t}', 'select')::text;`) === "truefalsefalsefalsefalsefalse"));
  check("X2 service_role cannot write any of them directly", (fails(`insert into public.pilot_retest_steps (pilot_retest_id, pilot_id, project_id, step, performed_by) values (${lit(groupR)}::uuid, ${lit(pilotR)}::uuid, ${lit(projectR)}::uuid, 'prepare', ${lit(FOUNDER)}::uuid);`) ?? "").includes("permission denied"));
  const WRITERS = [
    "register_pilot_retest(uuid,uuid,uuid[],text,text,text,text,text,text,text,text,text,text,boolean,text,integer,text,date,uuid[],boolean,uuid)",
    "confirm_pilot_retest_implementation(uuid,uuid,uuid,date,text,text,text,boolean,text,boolean)",
    "prepare_pilot_retests(uuid,uuid,uuid)", "abandon_pilot_retest(uuid,uuid,uuid,text,boolean)",
    "requeue_pilot_retest_job(uuid,uuid,uuid,text,uuid,text)", "add_pilot_retest_note(uuid,uuid,uuid,date,text,text,uuid,uuid)",
  ];
  const HIDDEN = ["pilot_retest_job_is_final(uuid)", "pilot_retests_guard()", "pilot_retest_rows_append_only()", "pilot_retest_slot_check()",
    "pilot_retest_intervention_guard()", "pilot_retest_protocol_guard()", "pilot_retest_card_guard()"];
  const priv = (fn: string) => admin(`select has_function_privilege('anon', 'public.${fn}', 'execute')::text || has_function_privilege('authenticated', 'public.${fn}', 'execute')::text || has_function_privilege('service_role', 'public.${fn}', 'execute')::text || ':' || prosecdef::text || ':' || array_to_string(proconfig, ',') from pg_proc where oid = 'public.${fn}'::regprocedure;`);
  check("X3 the six group steps are SECURITY DEFINER with search_path=public, pg_temp, executable by service_role only",
    WRITERS.every((f) => priv(f) === "falsefalsetrue:true:search_path=public, pg_temp"), WRITERS.map(priv).join(" ; "));
  check("X4 the helper and the six trigger functions are SECURITY DEFINER, pinned, and executable by no client role",
    HIDDEN.every((f) => priv(f) === "falsefalsefalse:true:search_path=public, pg_temp")
      && (fails(`select public.pilot_retest_job_is_final(${lit(jobsR[0])}::uuid);`) ?? "").includes("permission denied"), HIDDEN.map(priv).join(" ; "));

  quiesce();
  finish();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
