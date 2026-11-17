#!/usr/bin/env tsx
/**
 * Pilot report artifacts on a real PostgreSQL
 * (20261119120000_pilot_report_artifacts.sql, D-055):
 *
 *   S  save_pilot_report_artifact: a manifest naming exactly the pilot's
 *      protocols and attempts saves revision 1, then 2; another pilot's
 *      protocol, a missing protocol or attempt, an attempt under the wrong
 *      protocol, a wrong hash, a payload for another pilot or project, and
 *      an unpaired integrity status are refused and store nothing;
 *   H  share_pilot_report_artifact: only the newest revision; a blocked one
 *      never; a needs-review one only with the acknowledgement; a replay
 *      answers the same link; another pilot's id finds nothing;
 *   G  the guard: content never changes, a shared revision never changes,
 *      no row is deleted, a blocked revision cannot be marked shared;
 *   R  read_shared_pilot_report: only a shared, non-blocked revision for a
 *      well-formed token, and whether a newer one has been shared;
 *   X  privileges.
 *
 * The one attempt is produced through the worker's own RPCs (a provider
 * failure), never by writing evidence rows. Runs against a DISPOSABLE
 * Supabase Postgres with every migration applied
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
const WORKER = "w-pilot-report";
const admin = (sql: string) => psql(sql, "supabase_admin");
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const question = (n: number) => `Which pilot report tools suit a shop of ${n} people?`;

function quiesce(): void {
  admin(`update public.protocol_job_run_requests set status = 'expired', resolved_at = now() where status = 'pending';`);
  admin(`update public.protocol_execution_jobs set lease_expires_at = now() - interval '1 second' where status in ('claimed', 'running') and lease_expires_at > now();`);
}

function createPilot(domain: string): string[] {
  return row(psql(
    `select outcome, coalesce(pilot_id::text, ''), coalesce(project_id::text, '') from public.create_pilot(${lit(FOUNDER)}::uuid, ${lit(`Report Co ${domain}`)}, ${lit(`https://${domain}`)}, ${lit(domain)}, 'The customer added the DNS record we sent.', 15, current_date, ${lit(randomUUID())}::uuid);`
  ));
}

function addQuestion(pilotId: string, text: string): string[] {
  return row(psql(
    `select outcome, coalesce(pilot_question_id::text, ''), coalesce(protocol_id::text, ''), coalesce(job_id::text, '') from public.add_pilot_question(${lit(pilotId)}::uuid, ${lit(FOUNDER)}::uuid, ${lit(text)}, ${lit(sha(text))}, 'customer_supplied', 'Email of 12 Nov', current_date, ${lit(randomUUID())}::uuid);`
  ));
}

/** Drives one slot to a provider error exactly as the worker does (scripts/test-pilot-questions-db.ts); returns the attempt. */
function failOneAttempt(jobId: string, projectId: string): string {
  const [req] = row(psql(`select outcome from public.request_protocol_job_run(${lit(jobId)}::uuid, ${lit(projectId)}::uuid, 'admin_pilot_run', ${lit(FOUNDER)}::uuid, 120);`));
  if (req !== "REQUESTED") return "";
  const [out, , token] = row(psql(`select outcome, coalesce((job).id::text, ''), coalesce(claim_token::text, '') from public.claim_requested_protocol_execution_job(${lit(WORKER)}, 300);`));
  if (out !== "CLAIMED") return "";
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

interface Manifest {
  protocols: string[];
  attempts: { id: string; protocolId: string; rawResponseSha256: string | null }[];
}

function save(pilotId: string, payload: Record<string, unknown>, manifest: Manifest, status = "integrity_passed", reasons: string[] = []): string[] {
  return row(psql(
    `select outcome, coalesce(artifact_id::text, ''), coalesce(revision::text, '') from public.save_pilot_report_artifact(${lit(pilotId)}::uuid, ${lit(FOUNDER)}::uuid, '# Pilot report', ${lit(JSON.stringify(payload))}::jsonb, ${lit(JSON.stringify(manifest))}::jsonb, ${lit(status)}, ${lit(JSON.stringify(reasons))}::jsonb, now());`
  ));
}

const share = (artifactId: string, pilotId: string, ack: boolean) =>
  row(psql(`select outcome, coalesce(public_token, '') from public.share_pilot_report_artifact(${lit(artifactId)}::uuid, ${lit(pilotId)}::uuid, ${lit(FOUNDER)}::uuid, ${ack});`));

const readShared = (token: string) =>
  psql(`select revision::text || '|' || newer_shared_revision::text || '|' || (payload ->> 'pilotId') from public.read_shared_pilot_report(${lit(token)});`);

const count = (pilotId: string) => admin(`select count(*) from public.pilot_report_artifacts where pilot_id = ${lit(pilotId)}::uuid;`);

async function main(): Promise<void> {
  console.log("test-pilot-report-db");
  quiesce();

  const [outA, pilotA, projectA] = createPilot("pr-a.example");
  const [, , protoA1, jobA1] = addQuestion(pilotA, question(1));
  const [, , protoA2] = addQuestion(pilotA, question(2));
  const [, pilotB, projectB] = createPilot("pr-b.example");
  const [, , protoB1] = addQuestion(pilotB, question(3));
  const attempt = failOneAttempt(jobA1, projectA);
  quiesce();
  check("setup: two pilots, three questions, one attempt recorded through the worker's own functions",
    outA === "CREATED" && protoA1 !== "" && protoA2 !== "" && protoB1 !== "" && attempt !== "");

  const storedSha = admin(`select coalesce(r.raw_response_sha256, '') from public.protocol_attempts a left join public.probe_results r on r.probe_run_id = a.probe_run_id where a.id = ${lit(attempt)}::uuid;`);
  const attemptSha = storedSha === "" ? null : storedSha;
  const payloadA = { pilotId: pilotA, projectId: projectA };
  const good: Manifest = { protocols: [protoA1, protoA2], attempts: [{ id: attempt, protocolId: protoA1, rawResponseSha256: attemptSha }] };

  /* S --------------------------------------------------------------- */
  const [s1, art1, rev1] = save(pilotA, payloadA, good);
  check("S1 a manifest naming exactly the pilot's protocols and attempts saves revision 1", s1 === "SAVED" && rev1 === "1" && art1 !== "");
  check("S2 the revision carries a content hash and a 64-character link token",
    admin(`select (content_sha256 ~ '^[0-9a-f]{64}$' and public_token ~ '^[0-9a-f]{64}$' and shared_at is null)::text from public.pilot_report_artifacts where id = ${lit(art1)}::uuid;`) === "true");
  const [s2, art2, rev2] = save(pilotA, payloadA, good);
  check("S3 a second build is a new revision; the first is untouched", s2 === "SAVED" && rev2 === "2" && art2 !== art1 && count(pilotA) === "2");
  check("S4 another pilot's protocol is refused, and nothing is stored",
    save(pilotA, payloadA, { ...good, protocols: [protoA1, protoA2, protoB1] })[0] === "EVIDENCE_OUTSIDE_PILOT" && count(pilotA) === "2");
  check("S5 a pilot protocol left out is refused", save(pilotA, payloadA, { ...good, protocols: [protoA1], attempts: good.attempts })[0] === "EVIDENCE_INCOMPLETE");
  check("S6 an attempt left out is refused, so a failed attempt cannot be hidden", save(pilotA, payloadA, { ...good, attempts: [] })[0] === "EVIDENCE_INCOMPLETE");
  check("S7 an attempt listed under another of the pilot's protocols is refused",
    save(pilotA, payloadA, { ...good, attempts: [{ ...good.attempts[0], protocolId: protoA2 }] })[0] === "EVIDENCE_OUTSIDE_PILOT");
  check("S8 a response hash that is not the stored one is refused",
    save(pilotA, payloadA, { ...good, attempts: [{ ...good.attempts[0], rawResponseSha256: sha("not the response") }] })[0] === "EVIDENCE_MISMATCH");
  check("S9 a payload naming another project is refused", save(pilotA, { pilotId: pilotA, projectId: projectB }, good)[0] === "EVIDENCE_OUTSIDE_PILOT");
  check("S10 a payload naming another pilot is an invalid call",
    fails(`select * from public.save_pilot_report_artifact(${lit(pilotA)}::uuid, ${lit(FOUNDER)}::uuid, '# r', ${lit(JSON.stringify({ pilotId: pilotB, projectId: projectA }))}::jsonb, ${lit(JSON.stringify(good))}::jsonb, 'integrity_passed', '[]'::jsonb, now());`)?.includes("invalid_save_pilot_report_args") === true);
  check("S11 a pass with a reason, or a review without one, is an invalid call",
    fails(`select * from public.save_pilot_report_artifact(${lit(pilotA)}::uuid, ${lit(FOUNDER)}::uuid, '# r', ${lit(JSON.stringify(payloadA))}::jsonb, ${lit(JSON.stringify(good))}::jsonb, 'integrity_passed', '["x"]'::jsonb, now());`)?.includes("invalid_save_pilot_report_args") === true &&
    fails(`select * from public.save_pilot_report_artifact(${lit(pilotA)}::uuid, ${lit(FOUNDER)}::uuid, '# r', ${lit(JSON.stringify(payloadA))}::jsonb, ${lit(JSON.stringify(good))}::jsonb, 'needs_review', '[]'::jsonb, now());`)?.includes("invalid_save_pilot_report_args") === true);
  check("S12 an attempt listed twice is an invalid call",
    fails(`select * from public.save_pilot_report_artifact(${lit(pilotA)}::uuid, ${lit(FOUNDER)}::uuid, '# r', ${lit(JSON.stringify(payloadA))}::jsonb, ${lit(JSON.stringify({ ...good, attempts: [good.attempts[0], good.attempts[0]] }))}::jsonb, 'integrity_passed', '[]'::jsonb, now());`)?.includes("invalid_save_pilot_report_args") === true);
  const ghost = randomUUID();
  check("S13 an unknown pilot is not found", save(ghost, { pilotId: ghost, projectId: projectA }, good)[0] === "PILOT_NOT_FOUND");

  /* H --------------------------------------------------------------- */
  check("H1 an older revision cannot be shared", share(art1, pilotA, true)[0] === "NOT_LATEST");
  const [, art3] = save(pilotA, payloadA, good, "needs_review", ["Question 2: the Perplexity measurement has not finished."]);
  check("H2 a revision that needs review is refused without the acknowledgement", share(art3, pilotA, false)[0] === "ACKNOWLEDGEMENT_REQUIRED");
  check("H3 another pilot's id finds nothing", share(art3, pilotB, true)[0] === "NOT_FOUND");
  const [h4, token3] = share(art3, pilotA, true);
  check("H4 with the acknowledgement it is shared, and the review is recorded",
    h4 === "SHARED" && /^[0-9a-f]{64}$/.test(token3) &&
    admin(`select (reviewed_by = ${lit(FOUNDER)}::uuid and reviewed_at is not null and shared_at is not null and needs_review_acknowledged)::text from public.pilot_report_artifacts where id = ${lit(art3)}::uuid;`) === "true");
  const [h5, token3b] = share(art3, pilotA, false);
  check("H5 a replay answers the same link", h5 === "ALREADY_SHARED" && token3b === token3);
  const [, art4] = save(pilotA, payloadA, good, "blocked", ["Question 1: its evidence does not belong to this pilot's project and protocol."]);
  check("H6 a blocked revision is never shared", share(art4, pilotA, true)[0] === "BLOCKED");

  /* G --------------------------------------------------------------- */
  check("G1 a shared revision cannot change, even for the database owner",
    fails(`update public.pilot_report_artifacts set markdown = '# changed' where id = ${lit(art3)}::uuid;`, "supabase_admin")?.includes("pilot_report_artifact_is_shared_and_immutable") === true);
  check("G2 an unshared revision's content cannot change either",
    fails(`update public.pilot_report_artifacts set payload = '{}'::jsonb where id = ${lit(art1)}::uuid;`, "supabase_admin")?.includes("pilot_report_artifact_content_is_immutable") === true);
  check("G3 no revision can be deleted",
    fails(`delete from public.pilot_report_artifacts where id = ${lit(art1)}::uuid;`, "supabase_admin")?.includes("pilot_report_artifacts_are_append_only") === true);
  check("G4 a blocked revision cannot be marked shared, even directly",
    fails(`update public.pilot_report_artifacts set shared_at = now(), reviewed_at = now(), reviewed_by = ${lit(FOUNDER)}::uuid where id = ${lit(art4)}::uuid;`, "supabase_admin")?.includes("pilot_report_artifacts_share_check") === true);

  /* R --------------------------------------------------------------- */
  check("R1 the shared revision is readable by its link", readShared(token3) === `3|false|${pilotA}`);
  const token1 = admin(`select public_token from public.pilot_report_artifacts where id = ${lit(art1)}::uuid;`);
  const token4 = admin(`select public_token from public.pilot_report_artifacts where id = ${lit(art4)}::uuid;`);
  check("R2 an unshared revision's token reads nothing", readShared(token1) === "");
  check("R3 a blocked revision's token reads nothing", readShared(token4) === "");
  check("R4 a malformed token reads nothing", readShared("not-a-token") === "" && readShared(token3.toUpperCase()) === "");
  const [, art5] = save(pilotA, payloadA, good);
  share(art5, pilotA, false);
  check("R5 an earlier shared revision says a newer one has been shared", readShared(token3) === `3|true|${pilotA}`);

  /* X --------------------------------------------------------------- */
  for (const role of ["anon", "authenticated"] as const) {
    check(`X1 ${role} can execute none of the three functions and read nothing`,
      fails(`select * from public.save_pilot_report_artifact(${lit(pilotA)}::uuid, ${lit(FOUNDER)}::uuid, '# r', ${lit(JSON.stringify(payloadA))}::jsonb, ${lit(JSON.stringify(good))}::jsonb, 'integrity_passed', '[]'::jsonb, now());`, role)?.includes("permission denied") === true &&
      fails(`select * from public.share_pilot_report_artifact(${lit(art5)}::uuid, ${lit(pilotA)}::uuid, ${lit(FOUNDER)}::uuid, true);`, role)?.includes("permission denied") === true &&
      fails(`select * from public.read_shared_pilot_report(${lit(token3)});`, role)?.includes("permission denied") === true &&
      fails(`select count(*) from public.pilot_report_artifacts;`, role)?.includes("permission denied") === true);
  }
  check("X2 service_role may read the table but not write it directly",
    psql(`select count(*) from public.pilot_report_artifacts where pilot_id = ${lit(pilotA)}::uuid;`) === "5" &&
    fails(`insert into public.pilot_report_artifacts (pilot_id, project_id, revision, markdown, payload, manifest, content_sha256, generated_at, integrity_status, public_token, created_by) values (${lit(pilotA)}::uuid, ${lit(projectA)}::uuid, 99, 'x', '{}', '{}', ${lit(sha("x"))}, now(), 'integrity_passed', ${lit(sha("t"))}, ${lit(FOUNDER)}::uuid);`)?.includes("permission denied") === true &&
    fails(`update public.pilot_report_artifacts set shared_at = now() where id = ${lit(art1)}::uuid;`)?.includes("permission denied") === true &&
    fails(`delete from public.pilot_report_artifacts where id = ${lit(art1)}::uuid;`)?.includes("permission denied") === true);
  check("X3 the guard's function cannot be called by service_role",
    admin(`select has_function_privilege('service_role', 'public.pilot_report_artifacts_guard()', 'execute')::text;`) === "false");
  check("X4 RLS is on", admin(`select relrowsecurity::text from pg_class where oid = 'public.pilot_report_artifacts'::regclass;`) === "true");

  finish();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
