#!/usr/bin/env tsx
/**
 * Pilot suggested actions on a real PostgreSQL
 * (20261109160000_pilot_actions.sql, D-057):
 *
 *   A  save_pilot_action: a completed answer of this pilot saves version 1;
 *      a replay answers the same ids; another body under the same key is a
 *      conflict; another pilot's answer, a failed attempt or an unknown one
 *      is refused and nothing is stored; a stale edit is a version
 *      conflict; malformed calls raise; at most 30 actions in use;
 *   V  review_pilot_action: confirmation required, one review per version,
 *      only the latest version, nothing for a withdrawn action;
 *   W  withdraw_pilot_action, and no edit or review afterwards;
 *   R  save_pilot_report_artifact (redefined): the listed versions must be
 *      reviewed, latest and not withdrawn; a reviewed action cannot be left
 *      out; a revision with an action is never integrity_passed; the
 *      payload and the manifest list the same versions; another pilot's
 *      version is refused;
 *   C  what the payload shows of an action must be the stored version and
 *      its stored links, except in a blocked revision;
 *   S  share_pilot_report_artifact (redefined): a revision whose actions
 *      were edited, withdrawn or joined by a newly reviewed one is refused
 *      as ACTIONS_STALE; one whose actions are unchanged is shared, and the
 *      customer read shows them;
 *   Q  an answer to a retired question: save_pilot_action refuses it, and
 *      the trigger refuses it even for the database owner;
 *   K  two reviews, or two withdrawals, at once on two real sessions: one
 *      records the event, the other answers that it is already done, and
 *      neither fails;
 *   G  the guards: no update or delete on any of the four tables, and a
 *      link to anything but a completed answer of this pilot is refused
 *      even for the database owner;
 *   X  privileges and RLS.
 *
 * The answers are produced through the worker's own RPCs, never by writing
 * evidence rows. Runs against a DISPOSABLE Supabase Postgres with every
 * migration applied (scripts/run-p2-workspace-db-local.sh). Opt-in: SKIP
 * (exit 2) without ZYPACT_P2_DB_CONTAINER. No network.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

import { db, lit, makeChecker, requireContainer, row } from "./lib/workspace-db";

const CONTAINER = requireContainer();
(globalThis as unknown as { fetch: unknown }).fetch = () => {
  throw new Error("network disabled");
};
const { psql, fails } = db(CONTAINER);
const { check, finish } = makeChecker();

const FOUNDER = randomUUID();
const WORKER = "w-pilot-actions";
const admin = (sql: string) => psql(sql, "supabase_admin");
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const question = (n: number) => `Which pilot action tools suit a shop of ${n} people?`;

function quiesce(): void {
  admin(`update public.protocol_job_run_requests set status = 'expired', resolved_at = now() where status = 'pending';`);
  admin(`update public.protocol_execution_jobs set lease_expires_at = now() - interval '1 second' where status in ('claimed', 'running') and lease_expires_at > now();`);
}

function createPilot(domain: string): string[] {
  return row(psql(
    `select outcome, coalesce(pilot_id::text, ''), coalesce(project_id::text, '') from public.create_pilot(${lit(FOUNDER)}::uuid, ${lit(`Action Co ${domain}`)}, ${lit(`https://${domain}`)}, ${lit(domain)}, 'The customer added the DNS record we sent.', 15, current_date, ${lit(randomUUID())}::uuid);`
  ));
}

function addQuestion(pilotId: string, text: string): string[] {
  return row(psql(
    `select outcome, coalesce(pilot_question_id::text, ''), coalesce(protocol_id::text, ''), coalesce(job_id::text, '') from public.add_pilot_question(${lit(pilotId)}::uuid, ${lit(FOUNDER)}::uuid, ${lit(text)}, ${lit(sha(text))}, 'customer_supplied', 'Email of 12 Nov', current_date, ${lit(randomUUID())}::uuid);`
  ));
}

function claim(jobId: string, projectId: string): { token: string; attempt: string; probeRun: string } | null {
  const [req] = row(psql(`select outcome from public.request_protocol_job_run(${lit(jobId)}::uuid, ${lit(projectId)}::uuid, 'admin_pilot_run', ${lit(FOUNDER)}::uuid, 120);`));
  if (req !== "REQUESTED") return null;
  const [out, , token] = row(psql(`select outcome, coalesce((job).id::text, ''), coalesce(claim_token::text, '') from public.claim_requested_protocol_execution_job(${lit(WORKER)}, 300);`));
  if (out !== "CLAIMED") return null;
  const ordinal = admin(`select next_baseline_ordinal from public.protocol_execution_jobs where id = ${lit(jobId)}::uuid;`);
  const [, attempt] = row(psql(
    `select status, (attempt).id from public.admit_and_reserve_attempt_for_job(${lit(jobId)}::uuid, ${lit(token)}::uuid, ${lit(projectId)}::uuid, 'baseline', ${lit(`${jobId}:baseline:${ordinal}`)}, 0.02, 0.02, null);`
  ));
  psql(`select 1 from public.create_probe_run_and_start_attempt_for_job(${lit(jobId)}::uuid, ${lit(token)}::uuid, ${lit(projectId)}::uuid, ${lit(attempt)}::uuid, 'perplexity', 'simulated');`);
  const probeRun = admin(`select probe_run_id from public.protocol_attempts where id = ${lit(attempt)}::uuid;`);
  return { token, attempt, probeRun };
}

/** A provider error, exactly as the worker records it (scripts/test-pilot-report-db.ts). */
function failOneAttempt(jobId: string, projectId: string): string {
  const c = claim(jobId, projectId);
  if (!c) return "";
  const call = admin(`select id from public.protocol_external_calls where protocol_attempt_id = ${lit(c.attempt)}::uuid and call_kind = 'perplexity';`);
  const body = `{"q":"${c.attempt}"}`;
  psql(`select 1 from public.mark_external_call_sent_for_job(${lit(jobId)}::uuid, ${lit(c.token)}::uuid, ${lit(projectId)}::uuid, ${lit(call)}::uuid, ${lit(c.probeRun)}::uuid, 'perplexity', ${lit(body)}, ${lit(sha(body))});`);
  psql(`select 1 from public.record_provider_call_receipt_for_job(${lit(jobId)}::uuid, ${lit(c.token)}::uuid, ${lit(projectId)}::uuid, ${lit(call)}::uuid, ${lit(c.probeRun)}::uuid, 'provider_error', 500, null, null, 120, null, null, null);`);
  psql(`select 1 from public.abort_attempt_and_fail_job_for_job(${lit(jobId)}::uuid, ${lit(c.token)}::uuid, ${lit(projectId)}::uuid, ${lit(c.attempt)}::uuid, 'failed', 'provider_error', 'provider_error');`);
  return c.attempt;
}

const CONTENT = JSON.stringify({
  product_mentioned: true,
  product_position: "primary",
  competitors_mentioned: [{ name: "Acme", position: 1, context: "listed first" }],
  sources_cited: [],
  answer_summary: "Acme is recommended as the top choice.",
  cited_as_source: false,
  client_source_count: 0,
  platforms_referenced: [],
  negative_claim_detected: false,
});

/** A completed answer, exactly as the worker records it (scripts/test-m5-0060-runtime-contract.ts). */
function completeOneAttempt(jobId: string, projectId: string): string {
  const c = claim(jobId, projectId);
  if (!c) return "";
  const pcall = admin(`select id from public.protocol_external_calls where protocol_attempt_id = ${lit(c.attempt)}::uuid and call_kind = 'perplexity';`);
  const acall = admin(`select id from public.protocol_external_calls where protocol_attempt_id = ${lit(c.attempt)}::uuid and call_kind = 'analysis';`);
  const preq = `{"q":"${c.attempt}"}`;
  const answer = `{"choices":[{"message":{"content":"Acme is the top choice for ${c.attempt}."}}]}`;
  const areq = `analysis request for ${c.attempt}`;
  const content = `analysis content for ${c.attempt}`;
  psql(`select 1 from public.mark_external_call_sent_for_job(${lit(jobId)}::uuid, ${lit(c.token)}::uuid, ${lit(projectId)}::uuid, ${lit(pcall)}::uuid, ${lit(c.probeRun)}::uuid, 'perplexity', ${lit(preq)}, ${lit(sha(preq))});`);
  psql(`select 1 from public.record_provider_call_receipt_for_job(${lit(jobId)}::uuid, ${lit(c.token)}::uuid, ${lit(projectId)}::uuid, ${lit(pcall)}::uuid, ${lit(c.probeRun)}::uuid, 'success', 200, ${lit(`req-${pcall}`)}, ${lit(sha(answer))}, 500, null, null, ${lit(answer)});`);
  psql(`select 1 from public.mark_external_call_sent_for_job(${lit(jobId)}::uuid, ${lit(c.token)}::uuid, ${lit(projectId)}::uuid, ${lit(acall)}::uuid, ${lit(c.probeRun)}::uuid, 'analysis', ${lit(areq)}, ${lit(sha(areq))});`);
  psql(`select 1 from public.record_analysis_call_receipt_for_job(${lit(jobId)}::uuid, ${lit(c.token)}::uuid, ${lit(projectId)}::uuid, ${lit(acall)}::uuid, ${lit(c.probeRun)}::uuid, 'success', 'anthropic', 'claude-fixture', false, ${lit(sha(areq))}, ${lit(sha(content))}, 400, null, null, ${lit(content)}, ${lit(areq)});`);
  psql(`select 1 from public.persist_probe_result_for_job(${lit(jobId)}::uuid, ${lit(c.token)}::uuid, ${lit(projectId)}::uuid, ${lit(CONTENT)}::jsonb);`);
  psql(`select 1 from public.reconcile_attempt_for_job(${lit(jobId)}::uuid, ${lit(c.token)}::uuid, ${lit(projectId)}::uuid, ${lit(c.attempt)}::uuid, 'completed', null);`);
  return c.attempt;
}

const TEXT = {
  title: "Add a comparison page",
  observation: "The answers that named Acme cited no page on the customer's own site.",
  suggested: "Publish a plain comparison page and keep the review profiles current.",
  why: "One hypothesis: the engine draws on pages that compare products directly.",
  alternatives: "The engine may favour other sources for reasons unrelated to any page.",
  open: "Whether the engine would read a new page within the pilot at all.",
};

function saveAction(
  pilotId: string,
  evidence: { attemptId: string; sourceUrl: string | null }[],
  opts: { actionId?: string | null; expected?: number | null; key?: string; title?: string } = {}
): string[] {
  const key = opts.key ?? randomUUID();
  const actionId = opts.actionId ? `${lit(opts.actionId)}::uuid` : "null::uuid";
  const expected = opts.expected ?? null;
  return row(psql(
    `select outcome, coalesce(saved_action_id::text, ''), coalesce(saved_version_id::text, ''), coalesce(saved_version_number::text, '') from public.save_pilot_action(${lit(pilotId)}::uuid, ${actionId}, ${expected === null ? "null" : expected}::integer, ${lit(FOUNDER)}::uuid, ${lit(opts.title ?? TEXT.title)}, ${lit(TEXT.observation)}, ${lit(TEXT.suggested)}, ${lit(TEXT.why)}, ${lit(TEXT.alternatives)}, ${lit(TEXT.open)}, ${lit(JSON.stringify(evidence))}::jsonb, ${lit(key)}::uuid);`
  ));
}

const review = (pilotId: string, actionId: string, version: number, confirmed = true) =>
  psql(`select outcome from public.review_pilot_action(${lit(pilotId)}::uuid, ${lit(actionId)}::uuid, ${version}, ${lit(FOUNDER)}::uuid, ${confirmed});`);
const withdraw = (pilotId: string, actionId: string) =>
  psql(`select outcome from public.withdraw_pilot_action(${lit(pilotId)}::uuid, ${lit(actionId)}::uuid, ${lit(FOUNDER)}::uuid, 'No longer supported by the answers.');`);
const counts = (pilotId: string) =>
  admin(`select (select count(*) from public.pilot_actions where pilot_id = ${lit(pilotId)}::uuid)::text || '/' || (select count(*) from public.pilot_action_versions where pilot_id = ${lit(pilotId)}::uuid)::text || '/' || (select count(*) from public.pilot_action_evidence where pilot_id = ${lit(pilotId)}::uuid)::text || '/' || (select count(*) from public.pilot_action_events where pilot_id = ${lit(pilotId)}::uuid)::text;`);

interface Manifest {
  protocols: string[];
  attempts: { id: string; protocolId: string; rawResponseSha256: string | null }[];
  actionVersions?: string[];
}

/**
 * What a report payload shows of a stored action version, as the builder
 * writes it: the six fields and the links (attempt id and source URL), read
 * here from the stored rows. A version that does not exist gets no content.
 */
function payloadAction(versionId: string): Record<string, unknown> {
  const out = admin(
    `select json_build_object('versionId', v.id, 'title', v.title, 'observation', v.observation, 'suggestedAction', v.suggested_action, 'whyItMightMatter', v.why_it_might_matter, 'alternativeExplanations', v.alternative_explanations, 'openQuestions', v.open_questions, 'evidence', coalesce((select json_agg(json_build_object('attemptId', e.attempt_id, 'sourceUrl', e.source_url) order by e.position) from public.pilot_action_evidence e where e.action_version_id = v.id), '[]'::json))::text from public.pilot_action_versions v where v.id = ${lit(versionId)}::uuid;`
  );
  return out ? (JSON.parse(out) as Record<string, unknown>) : { versionId, evidence: [] };
}

function saveReport(
  pilotId: string,
  projectId: string,
  manifest: Manifest,
  status: string,
  reasons: string[],
  payloadVersions?: string[],
  shape: (a: Record<string, unknown>) => Record<string, unknown> = (a) => a
): string[] {
  const payload: Record<string, unknown> = { pilotId, projectId };
  const versions = payloadVersions ?? manifest.actionVersions;
  if (versions) payload.actions = versions.map((versionId) => shape(payloadAction(versionId)));
  return row(psql(
    `select outcome, coalesce(artifact_id::text, '') from public.save_pilot_report_artifact(${lit(pilotId)}::uuid, ${lit(FOUNDER)}::uuid, '# Pilot report', ${lit(JSON.stringify(payload))}::jsonb, ${lit(JSON.stringify(manifest))}::jsonb, ${lit(status)}, ${lit(JSON.stringify(reasons))}::jsonb, now());`
  ));
}

const REVIEW_REASON = ["The report includes 1 suggested action written by the team."];

const share = (artifactId: string, pilotId: string) =>
  row(psql(`select outcome || '|' || coalesce(public_token, '') from public.share_pilot_report_artifact(${lit(artifactId)}::uuid, ${lit(pilotId)}::uuid, ${lit(FOUNDER)}::uuid, true);`));

/** One psql session run concurrently with others (the synchronous helper cannot overlap two). */
function psqlAsync(sql: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["exec", "-i", CONTAINER, "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qtA"]);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("close", (code) => resolve({ code: code ?? 1, out: out.trim(), err }));
    child.stdin.end(`set role service_role;\n${sql}`);
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log("test-pilot-actions-db");
  quiesce();

  const [outA, pilotA, projectA] = createPilot("pa-a.example");
  const [, , protoA1, jobA1] = addQuestion(pilotA, question(1));
  const [, , protoA2, jobA2] = addQuestion(pilotA, question(2));
  const [, pilotB, projectB] = createPilot("pa-b.example");
  const [, , protoB1, jobB1] = addQuestion(pilotB, question(3));
  const done = completeOneAttempt(jobA1, projectA);
  quiesce();
  const failed = failOneAttempt(jobA2, projectA);
  quiesce();
  const doneB = completeOneAttempt(jobB1, projectB);
  quiesce();
  check("setup: two pilots, a completed and a failed answer in A, a completed answer in B, through the worker's own functions",
    outA === "CREATED" && protoA1 !== "" && protoA2 !== "" && protoB1 !== "" && done !== "" && failed !== "" && doneB !== "" &&
    admin(`select status from public.protocol_attempts where id = ${lit(done)}::uuid;`) === "completed" &&
    admin(`select status from public.protocol_attempts where id = ${lit(failed)}::uuid;`) === "failed");

  /* A --------------------------------------------------------------- */
  const key1 = randomUUID();
  const [a1, action1, version1, n1] = saveAction(pilotA, [{ attemptId: done, sourceUrl: null }], { key: key1 });
  check("A1 an action resting on a completed answer of this pilot saves version 1, with its link",
    a1 === "SAVED" && action1 !== "" && version1 !== "" && n1 === "1" && counts(pilotA) === "1/1/1/0");
  const [a2, action1b, version1b] = saveAction(pilotA, [{ attemptId: done, sourceUrl: null }], { key: key1 });
  check("A2 a replay answers the same ids and stores nothing more", a2 === "SAVED" && action1b === action1 && version1b === version1 && counts(pilotA) === "1/1/1/0");
  check("A3 the same key with another body is a conflict", saveAction(pilotA, [{ attemptId: done, sourceUrl: null }], { key: key1, title: "Another title" })[0] === "CONFLICT");
  check("A4 another pilot's answer is refused, and nothing is stored",
    saveAction(pilotA, [{ attemptId: doneB, sourceUrl: null }])[0] === "EVIDENCE_OUTSIDE_PILOT" && counts(pilotA) === "1/1/1/0");
  check("A5 a failed attempt is not an answer, and nothing is stored",
    saveAction(pilotA, [{ attemptId: done, sourceUrl: null }, { attemptId: failed, sourceUrl: null }])[0] === "EVIDENCE_NOT_AN_ANSWER" && counts(pilotA) === "1/1/1/0");
  check("A6 an unknown attempt is refused", saveAction(pilotA, [{ attemptId: randomUUID(), sourceUrl: null }])[0] === "EVIDENCE_OUTSIDE_PILOT");
  check("A7 an edit must name the newest version",
    saveAction(pilotA, [{ attemptId: done, sourceUrl: null }], { actionId: action1, expected: 2 })[0] === "VERSION_CONFLICT" &&
    saveAction(pilotA, [{ attemptId: done, sourceUrl: null }], { actionId: randomUUID(), expected: 1 })[0] === "ACTION_NOT_FOUND");
  const call = (title: string, evidence: string, actionId = "null::uuid", expected = "null") =>
    fails(`select * from public.save_pilot_action(${lit(pilotA)}::uuid, ${actionId}, ${expected}::integer, ${lit(FOUNDER)}::uuid, ${lit(title)}, ${lit(TEXT.observation)}, ${lit(TEXT.suggested)}, ${lit(TEXT.why)}, ${lit(TEXT.alternatives)}, ${lit(TEXT.open)}, ${lit(evidence)}::jsonb, ${lit(randomUUID())}::uuid);`);
  const linkJson = JSON.stringify([{ attemptId: done, sourceUrl: null }]);
  check("A8 a short title, no link, eleven links, a duplicate link, a non-http source, or an action without its version raise",
    (call("ab", linkJson) ?? "").includes("invalid_save_pilot_action_args") &&
    (call(TEXT.title, "[]") ?? "").includes("invalid_save_pilot_action_args") &&
    (call(TEXT.title, JSON.stringify(Array.from({ length: 11 }, () => ({ attemptId: randomUUID(), sourceUrl: null })))) ?? "").includes("invalid_save_pilot_action_args") &&
    (call(TEXT.title, JSON.stringify([{ attemptId: done, sourceUrl: null }, { attemptId: done, sourceUrl: null }])) ?? "").includes("invalid_save_pilot_action_args") &&
    (call(TEXT.title, JSON.stringify([{ attemptId: done, sourceUrl: "ftp://x.example/file" }])) ?? "").includes("invalid_save_pilot_action_args") &&
    (call(TEXT.title, linkJson, `${lit(action1)}::uuid`) ?? "").includes("invalid_save_pilot_action_args") &&
    counts(pilotA) === "1/1/1/0");

  /* V --------------------------------------------------------------- */
  check("V1 a review needs the explicit confirmation, and records nothing without it",
    review(pilotA, action1, 1, false) === "CONFIRMATION_REQUIRED" && counts(pilotA) === "1/1/1/0");
  check("V2 the founder reviews version 1; a second review answers already reviewed",
    review(pilotA, action1, 1) === "REVIEWED" && review(pilotA, action1, 1) === "ALREADY_REVIEWED" && counts(pilotA) === "1/1/1/1");
  const [e1, , version2, n2] = saveAction(pilotA, [{ attemptId: done, sourceUrl: null }], { actionId: action1, expected: 1, title: "Add a comparison page, edited" });
  check("V3 an edit is version 2, and version 1 can no longer be reviewed", e1 === "SAVED" && n2 === "2" && version2 !== version1 && review(pilotA, action1, 1) === "NOT_LATEST");
  check("V4 a review of an older or unknown version is refused",
    review(pilotA, action1, 3) === "VERSION_NOT_FOUND" && review(pilotA, randomUUID(), 1) === "ACTION_NOT_FOUND");

  /* R --------------------------------------------------------------- */
  const shaOf = (id: string) => {
    const v = admin(`select coalesce(r.raw_response_sha256, '') from public.protocol_attempts a left join public.probe_results r on r.probe_run_id = a.probe_run_id where a.id = ${lit(id)}::uuid;`);
    return v === "" ? null : v;
  };
  const base: Manifest = {
    protocols: [protoA1, protoA2],
    attempts: [
      { id: done, protocolId: protoA1, rawResponseSha256: shaOf(done) },
      { id: failed, protocolId: protoA2, rawResponseSha256: shaOf(failed) },
    ],
  };
  check("R1 a version that is not reviewed is refused, and nothing is stored",
    saveReport(pilotA, projectA, { ...base, actionVersions: [version2] }, "needs_review", REVIEW_REASON)[0] === "ACTION_NOT_REVIEWED" &&
    admin(`select count(*) from public.pilot_report_artifacts where pilot_id = ${lit(pilotA)}::uuid;`) === "0");
  check("R2 a reviewed version that is no longer the latest is refused",
    saveReport(pilotA, projectA, { ...base, actionVersions: [version1] }, "needs_review", REVIEW_REASON)[0] === "ACTION_NOT_REVIEWED");
  check("R2b with no reviewed current action, a revision without actions saves as before",
    saveReport(pilotA, projectA, base, "needs_review", ["Question 2: the Perplexity measurement stopped before it finished."])[0] === "SAVED");
  check("R3 version 2 is reviewed", review(pilotA, action1, 2) === "REVIEWED");
  check("R4 a reviewed current action left out is refused, so a revision cannot drop it silently",
    saveReport(pilotA, projectA, base, "needs_review", ["x"])[0] === "ACTIONS_INCOMPLETE" &&
    saveReport(pilotA, projectA, { ...base, actionVersions: [] }, "needs_review", ["x"])[0] === "ACTIONS_INCOMPLETE");
  check("R5 a revision with an action is never integrity_passed",
    fails(`select * from public.save_pilot_report_artifact(${lit(pilotA)}::uuid, ${lit(FOUNDER)}::uuid, '# r', ${lit(JSON.stringify({ pilotId: pilotA, projectId: projectA, actions: [{ versionId: version2 }] }))}::jsonb, ${lit(JSON.stringify({ ...base, actionVersions: [version2] }))}::jsonb, 'integrity_passed', '[]'::jsonb, now());`)?.includes("invalid_save_pilot_report_args") === true);
  check("R6 the payload and the manifest must list the same versions",
    fails(`select * from public.save_pilot_report_artifact(${lit(pilotA)}::uuid, ${lit(FOUNDER)}::uuid, '# r', ${lit(JSON.stringify({ pilotId: pilotA, projectId: projectA, actions: [] }))}::jsonb, ${lit(JSON.stringify({ ...base, actionVersions: [version2] }))}::jsonb, 'needs_review', '["x"]'::jsonb, now());`)?.includes("invalid_save_pilot_report_args") === true);
  const [r7, art7] = saveReport(pilotA, projectA, { ...base, actionVersions: [version2] }, "needs_review", REVIEW_REASON);
  check("R7 the reviewed latest version, listed in both, saves a revision that needs review",
    r7 === "SAVED" && admin(`select integrity_status from public.pilot_report_artifacts where id = ${lit(art7)}::uuid;`) === "needs_review");

  /* W --------------------------------------------------------------- */
  check("W1 a withdrawal is recorded once", withdraw(pilotA, action1) === "WITHDRAWN" && withdraw(pilotA, action1) === "ALREADY_WITHDRAWN");
  check("W2 a withdrawn action can no longer be edited or reviewed",
    saveAction(pilotA, [{ attemptId: done, sourceUrl: null }], { actionId: action1, expected: 2 })[0] === "ACTION_WITHDRAWN" &&
    review(pilotA, action1, 2) === "ACTION_WITHDRAWN");
  check("W3 after the withdrawal the action cannot be listed, and the next revision saves without it",
    saveReport(pilotA, projectA, { ...base, actionVersions: [version2] }, "needs_review", REVIEW_REASON)[0] === "ACTION_NOT_REVIEWED" &&
    saveReport(pilotA, projectA, { ...base, actionVersions: [] }, "integrity_passed", [])[0] === "SAVED");

  /* L --------------------------------------------------------------- */
  let saved = 0;
  for (let i = 0; i < 30; i += 1) if (saveAction(pilotB, [{ attemptId: doneB, sourceUrl: null }], { title: `Action number ${i + 1}` })[0] === "SAVED") saved += 1;
  check("L1 thirty actions in use per pilot, and the thirty-first is refused",
    saved === 30 && saveAction(pilotB, [{ attemptId: doneB, sourceUrl: null }])[0] === "LIMIT_REACHED");
  const firstB = admin(`select id from public.pilot_actions where pilot_id = ${lit(pilotB)}::uuid order by created_at limit 1;`);
  check("L2 a withdrawn action frees its place", withdraw(pilotB, firstB) === "WITHDRAWN" && saveAction(pilotB, [{ attemptId: doneB, sourceUrl: null }])[0] === "SAVED");

  /* C, S: a fresh pilot ------------------------------------------------- */
  quiesce();
  const [, pilotC, projectC] = createPilot("pa-c.example");
  const [, , protoC1, jobC1] = addQuestion(pilotC, question(5));
  const doneC = completeOneAttempt(jobC1, projectC);
  quiesce();
  const baseC: Manifest = { protocols: [protoC1], attempts: [{ id: doneC, protocolId: protoC1, rawResponseSha256: shaOf(doneC) }] };
  const [, xAction, x1] = saveAction(pilotC, [{ attemptId: doneC, sourceUrl: null }], { title: "Action X" });
  review(pilotC, xAction, 1);
  check("C1 a payload that shows other wording than the stored, reviewed version is refused, and nothing is stored",
    saveReport(pilotC, projectC, { ...baseC, actionVersions: [x1] }, "needs_review", REVIEW_REASON, undefined,
      (a) => ({ ...a, title: "This fix will guarantee you rank first" }))[0] === "ACTIONS_CONTENT_MISMATCH" &&
    saveReport(pilotC, projectC, { ...baseC, actionVersions: [x1] }, "needs_review", REVIEW_REASON, undefined,
      (a) => ({ ...a, suggestedAction: `${String(a.suggestedAction)} Guaranteed.` }))[0] === "ACTIONS_CONTENT_MISMATCH" &&
    admin(`select count(*) from public.pilot_report_artifacts where pilot_id = ${lit(pilotC)}::uuid;`) === "0");
  check("C2 a payload that shows other links is refused: none, another answer, or another spelling of a source",
    saveReport(pilotC, projectC, { ...baseC, actionVersions: [x1] }, "needs_review", REVIEW_REASON, undefined, (a) => ({ ...a, evidence: [] }))[0] === "ACTIONS_CONTENT_MISMATCH" &&
    saveReport(pilotC, projectC, { ...baseC, actionVersions: [x1] }, "needs_review", REVIEW_REASON, undefined,
      (a) => ({ ...a, evidence: [{ attemptId: done, sourceUrl: null }] }))[0] === "ACTIONS_CONTENT_MISMATCH" &&
    saveReport(pilotC, projectC, { ...baseC, actionVersions: [x1] }, "needs_review", REVIEW_REASON, undefined,
      (a) => ({ ...a, evidence: [{ attemptId: doneC, sourceUrl: "https://WWW.G2.com/x" }] }))[0] === "ACTIONS_CONTENT_MISMATCH");
  check("C3 a payload without an evidence list raises",
    fails(`select * from public.save_pilot_report_artifact(${lit(pilotC)}::uuid, ${lit(FOUNDER)}::uuid, '# r', ${lit(JSON.stringify({ pilotId: pilotC, projectId: projectC, actions: [{ ...payloadAction(x1), evidence: undefined }] }))}::jsonb, ${lit(JSON.stringify({ ...baseC, actionVersions: [x1] }))}::jsonb, 'needs_review', '["x"]'::jsonb, now());`)?.includes("invalid_save_pilot_report_args") === true);
  const [cb, cbArt] = saveReport(pilotC, projectC, { ...baseC, actionVersions: [x1] }, "blocked", ["Suggested action 1: it names a source that is not among the sources of question 1."], undefined,
    (a) => ({ ...a, evidence: [] }));
  check("C4 a blocked revision may show an action whose links failed (so the preview shows why), and it can never be shared",
    cb === "SAVED" && share(cbArt, pilotC)[0] === "BLOCKED");
  const [r1Out, r1] = saveReport(pilotC, projectC, { ...baseC, actionVersions: [x1] }, "needs_review", REVIEW_REASON);
  check("C5 the payload the builder writes, the stored wording and links, saves", r1Out === "SAVED");

  const [eOut, , x2] = saveAction(pilotC, [{ attemptId: doneC, sourceUrl: null }], { actionId: xAction, expected: 1, title: "Action X, edited" });
  check("S1 after an edit (a new draft) the revision built with the earlier version cannot be shared, and stays unshared",
    eOut === "SAVED" && share(r1, pilotC)[0] === "ACTIONS_STALE" &&
    admin(`select (shared_at is null)::text from public.pilot_report_artifacts where id = ${lit(r1)}::uuid;`) === "true");
  check("S2 reviewing the edit does not make the old revision current", review(pilotC, xAction, 2) === "REVIEWED" && share(r1, pilotC)[0] === "ACTIONS_STALE");
  const [r2Out, r2] = saveReport(pilotC, projectC, { ...baseC, actionVersions: [x2] }, "needs_review", REVIEW_REASON);
  check("S3 after a withdrawal the revision showing the action cannot be shared",
    r2Out === "SAVED" && withdraw(pilotC, xAction) === "WITHDRAWN" && share(r2, pilotC)[0] === "ACTIONS_STALE");
  const [, yAction, y1] = saveAction(pilotC, [{ attemptId: doneC, sourceUrl: null }], { title: "Action Y" });
  review(pilotC, yAction, 1);
  const [r3Out, r3] = saveReport(pilotC, projectC, { ...baseC, actionVersions: [y1] }, "needs_review", REVIEW_REASON);
  const [, zAction] = saveAction(pilotC, [{ attemptId: doneC, sourceUrl: null }], { title: "Action Z" });
  check("S4 an action reviewed after the build makes the revision stale too: it would leave a reviewed action out",
    r3Out === "SAVED" && review(pilotC, zAction, 1) === "REVIEWED" && share(r3, pilotC)[0] === "ACTIONS_STALE");
  const z1 = admin(`select id from public.pilot_action_versions where action_id = ${lit(zAction)}::uuid and version_number = 1;`);
  const [r4Out, r4] = saveReport(pilotC, projectC, { ...baseC, actionVersions: [y1, z1] }, "needs_review", ["The report includes 2 suggested actions written by the team."]);
  const [shared, token] = share(r4, pilotC);
  check("S5 with nothing changed since the build the revision is shared, and the customer read shows exactly its actions",
    r4Out === "SAVED" && shared === "SHARED" &&
    psql(`select (select string_agg(a ->> 'versionId', ',' order by a ->> 'versionId') from jsonb_array_elements(payload -> 'actions') a) from public.read_shared_pilot_report(${lit(token)});`) ===
      [y1, z1].sort().join(","));
  const wReason = "The answers no longer support it, so it is withdrawn.";
  check("S6 a shared revision keeps what it showed after a later withdrawal, and is not shared again",
    psql(`select outcome from public.withdraw_pilot_action(${lit(pilotC)}::uuid, ${lit(yAction)}::uuid, ${lit(FOUNDER)}::uuid, ${lit(wReason)});`) === "WITHDRAWN" &&
    share(r4, pilotC)[0] === "ALREADY_SHARED");

  const aRevisions = admin(`select count(*) from public.pilot_report_artifacts where pilot_id = ${lit(pilotA)}::uuid;`);
  check("R8 another pilot's reviewed, current version listed in this pilot's report is refused, and nothing is stored",
    saveReport(pilotA, projectA, { ...base, actionVersions: [z1] }, "needs_review", REVIEW_REASON)[0] === "ACTION_NOT_REVIEWED" &&
    admin(`select count(*) from public.pilot_report_artifacts where pilot_id = ${lit(pilotA)}::uuid;`) === aRevisions);

  /* Q: a retired question ---------------------------------------------- */
  quiesce();
  const [, pilotD, projectD] = createPilot("pa-d.example");
  const [, qD1, , jobD1] = addQuestion(pilotD, question(6));
  const doneD = completeOneAttempt(jobD1, projectD);
  quiesce();
  const [okD, , vD] = saveAction(pilotD, [{ attemptId: doneD, sourceUrl: null }], { title: "Action on a question later retired" });
  // Test setup: the question is retired after its answer completed, as an
  // abandoned measurement would be (scripts/test-pilot-questions-db.ts P15).
  admin(`update public.pilot_questions set retired_at = now(), retired_by = ${lit(FOUNDER)}::uuid, retire_reason = 'The measurement cannot go on.' where id = ${lit(qD1)}::uuid;`);
  check("Q1 an answer to a retired question is refused by save_pilot_action, and nothing is stored",
    okD === "SAVED" && saveAction(pilotD, [{ attemptId: doneD, sourceUrl: null }])[0] === "QUESTION_RETIRED" && counts(pilotD) === "1/1/1/0");
  check("Q2 the trigger refuses a link to a retired question's answer even for the database owner",
    fails(`insert into public.pilot_action_evidence (action_version_id, pilot_id, project_id, position, attempt_id) values (${lit(vD)}::uuid, ${lit(pilotD)}::uuid, ${lit(projectD)}::uuid, 9, ${lit(doneD)}::uuid);`, "supabase_admin")?.includes("pilot_action_evidence_question_retired") === true);

  /* K: two at once ------------------------------------------------------- */
  const [, kAction] = saveAction(pilotC, [{ attemptId: doneC, sourceUrl: null }], { title: "Reviewed twice at once" });
  const reviewSql = `select outcome from public.review_pilot_action(${lit(pilotC)}::uuid, ${lit(kAction)}::uuid, 1, ${lit(FOUNDER)}::uuid, true);`;
  const firstReview = psqlAsync(`begin;\n${reviewSql}\nselect pg_sleep(1.5);\ncommit;`);
  await sleep(400);
  const secondReview = psqlAsync(reviewSql);
  const [rv1, rv2] = await Promise.all([firstReview, secondReview]);
  check("K1 two reviews at once: one records it, the other waits and answers already reviewed, and neither fails",
    rv1.code === 0 && rv2.code === 0 && rv1.out.split("\n")[0] === "REVIEWED" && rv2.out === "ALREADY_REVIEWED" &&
    admin(`select count(*) from public.pilot_action_events where action_id = ${lit(kAction)}::uuid and event = 'reviewed';`) === "1",
    `${rv1.code}:${rv1.out}:${rv1.err.slice(0, 120)} | ${rv2.code}:${rv2.out}:${rv2.err.slice(0, 120)}`);
  const withdrawSql = `select outcome from public.withdraw_pilot_action(${lit(pilotC)}::uuid, ${lit(kAction)}::uuid, ${lit(FOUNDER)}::uuid, 'Withdrawn twice at once in a test.');`;
  const firstWithdraw = psqlAsync(`begin;\n${withdrawSql}\nselect pg_sleep(1.5);\ncommit;`);
  await sleep(400);
  const secondWithdraw = psqlAsync(withdrawSql);
  const [wd1, wd2] = await Promise.all([firstWithdraw, secondWithdraw]);
  check("K2 two withdrawals at once: one records it, the other waits and answers already withdrawn, and neither fails",
    wd1.code === 0 && wd2.code === 0 && wd1.out.split("\n")[0] === "WITHDRAWN" && wd2.out === "ALREADY_WITHDRAWN" &&
    admin(`select count(*) from public.pilot_action_events where action_id = ${lit(kAction)}::uuid and event = 'withdrawn';`) === "1",
    `${wd1.code}:${wd1.out}:${wd1.err.slice(0, 120)} | ${wd2.code}:${wd2.out}:${wd2.err.slice(0, 120)}`);

  /* G --------------------------------------------------------------- */
  for (const t of ["pilot_actions", "pilot_action_versions", "pilot_action_evidence", "pilot_action_events"]) {
    check(`G1 ${t}: no update and no delete, even for the database owner`,
      fails(`update public.${t} set pilot_id = pilot_id where pilot_id = ${lit(pilotA)}::uuid;`, "supabase_admin")?.includes("pilot_actions_are_append_only") === true &&
      fails(`delete from public.${t} where pilot_id = ${lit(pilotA)}::uuid;`, "supabase_admin")?.includes("pilot_actions_are_append_only") === true);
  }
  check("G2 a link to another pilot's answer is refused even for the database owner",
    fails(`insert into public.pilot_action_evidence (action_version_id, pilot_id, project_id, position, attempt_id) values (${lit(version2)}::uuid, ${lit(pilotA)}::uuid, ${lit(projectA)}::uuid, 9, ${lit(doneB)}::uuid);`, "supabase_admin")?.includes("pilot_action_evidence_is_not_a_pilot_answer") === true);
  check("G3 a link to a failed attempt of this pilot is refused even for the database owner",
    fails(`insert into public.pilot_action_evidence (action_version_id, pilot_id, project_id, position, attempt_id) values (${lit(version2)}::uuid, ${lit(pilotA)}::uuid, ${lit(projectA)}::uuid, 9, ${lit(failed)}::uuid);`, "supabase_admin")?.includes("pilot_action_evidence_is_not_a_pilot_answer") === true);

  /* X --------------------------------------------------------------- */
  for (const role of ["anon", "authenticated"] as const) {
    check(`X1 ${role} can execute none of the three functions and read none of the tables`,
      fails(`select * from public.save_pilot_action(${lit(pilotA)}::uuid, null, null, ${lit(FOUNDER)}::uuid, ${lit(TEXT.title)}, ${lit(TEXT.observation)}, ${lit(TEXT.suggested)}, ${lit(TEXT.why)}, ${lit(TEXT.alternatives)}, ${lit(TEXT.open)}, ${lit(linkJson)}::jsonb, ${lit(randomUUID())}::uuid);`, role)?.includes("permission denied") === true &&
      fails(`select * from public.review_pilot_action(${lit(pilotA)}::uuid, ${lit(action1)}::uuid, 1, ${lit(FOUNDER)}::uuid, true);`, role)?.includes("permission denied") === true &&
      fails(`select * from public.withdraw_pilot_action(${lit(pilotA)}::uuid, ${lit(action1)}::uuid, ${lit(FOUNDER)}::uuid, 'A reason of enough length.');`, role)?.includes("permission denied") === true &&
      ["pilot_actions", "pilot_action_versions", "pilot_action_evidence", "pilot_action_events"].every((t) =>
        fails(`select count(*) from public.${t};`, role)?.includes("permission denied") === true));
  }
  check("X2 service_role may read the tables but not write them directly",
    psql(`select count(*) from public.pilot_actions where pilot_id = ${lit(pilotA)}::uuid;`) === "1" &&
    fails(`insert into public.pilot_actions (pilot_id, project_id, created_by) values (${lit(pilotA)}::uuid, ${lit(projectA)}::uuid, ${lit(FOUNDER)}::uuid);`)?.includes("permission denied") === true &&
    fails(`delete from public.pilot_action_events where pilot_id = ${lit(pilotA)}::uuid;`)?.includes("permission denied") === true);
  check("X3 the trigger functions cannot be called by service_role",
    admin(`select (has_function_privilege('service_role', 'public.pilot_actions_append_only()', 'execute') or has_function_privilege('service_role', 'public.pilot_action_evidence_check()', 'execute'))::text;`) === "false");
  check("X4 RLS is on for all four tables",
    admin(`select bool_and(relrowsecurity)::text from pg_class where oid in ('public.pilot_actions'::regclass, 'public.pilot_action_versions'::regclass, 'public.pilot_action_evidence'::regclass, 'public.pilot_action_events'::regclass);`) === "true");

  finish();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
