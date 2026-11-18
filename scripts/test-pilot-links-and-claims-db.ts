#!/usr/bin/env tsx
/**
 * Pilot report links and the unscoped claims on a real PostgreSQL
 * (20261109170000_pilot_links_and_claim_scope.sql, D-059 item 9, D-060):
 *
 *   R  read_shared_pilot_report: an earlier shared revision's link answers
 *      no payload and the "newer revision shared" flag once a later
 *      revision of the same pilot is shared; the newest shared revision
 *      answers its payload; an unshared or blocked later revision, or
 *      another pilot's share, replaces nothing; unshared, blocked,
 *      malformed and unknown tokens still read nothing; the earlier
 *      payloads are still stored;
 *   F  the read keeps its signature, output columns, SECURITY DEFINER,
 *      STABLE, pinned search_path and service_role-only grant;
 *   K  as service_role, both unscoped protocol claims raise
 *      insufficient_privilege (42501), and so for anon and authenticated;
 *      PUBLIC holds no EXECUTE on them; the requested claim stays
 *      executable by service_role; both unscoped claims still exist, the
 *      database owner can still call them (the owner-run suites' path), and
 *      their bodies are still 0054's and 0059's;
 *   G  the migration's own guards refuse: re-run on this database after a
 *      setup that breaks exactly one of its preconditions, or that leaves
 *      an API role an inherited EXECUTE the revokes cannot remove, it
 *      raises that guard's own message; re-run as it is, it passes; every
 *      re-run and its setup are rolled back.
 *
 * Revisions are saved and shared through save_pilot_report_artifact and
 * share_pilot_report_artifact, never by writing rows. Runs against a
 * DISPOSABLE Supabase Postgres with every migration applied
 * (scripts/run-p2-workspace-db-local.sh). Opt-in: SKIP (exit 2) without
 * ZYPACT_P2_DB_CONTAINER. No network. Every claim call that could change a
 * row runs inside a transaction that is rolled back.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { db, lit, makeChecker, requireContainer, row } from "./lib/workspace-db";

const CONTAINER = requireContainer();
(globalThis as unknown as { fetch: unknown }).fetch = () => {
  throw new Error("network disabled");
};
const { psql, fails } = db(CONTAINER);
const { check, finish } = makeChecker();

const FOUNDER = randomUUID();
const admin = (sql: string) => psql(sql, "supabase_admin");
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const question = (n: number) => `Which reporting tools suit a team of ${n} analysts?`;
const CLAIM = "public.claim_protocol_execution_job(text, integer)";
const CLAIM_BY_ID = "public.claim_protocol_execution_job_by_id(text, integer, uuid, uuid)";
const REQUESTED = "public.claim_requested_protocol_execution_job(text, integer)";
const CLAIM_OUTCOMES = ["NO_RUN_REQUEST", "CLAIMED", "JOB_NOT_FOUND", "JOB_NOT_ELIGIBLE", "JOB_LOCKED", "PILOT_CLOSED"];

function createPilot(domain: string): string[] {
  return row(psql(
    `select outcome, coalesce(pilot_id::text, ''), coalesce(project_id::text, '') from public.create_pilot(${lit(FOUNDER)}::uuid, ${lit(`Links Co ${domain}`)}, ${lit(`https://${domain}`)}, ${lit(domain)}, 'The customer added the DNS record we sent.', 15, current_date, ${lit(randomUUID())}::uuid);`
  ));
}

function addQuestion(pilotId: string, text: string): string[] {
  return row(psql(
    `select outcome, coalesce(pilot_question_id::text, ''), coalesce(protocol_id::text, ''), coalesce(job_id::text, '') from public.add_pilot_question(${lit(pilotId)}::uuid, ${lit(FOUNDER)}::uuid, ${lit(text)}, ${lit(sha(text))}, 'customer_supplied', 'Email of 12 Nov', current_date, ${lit(randomUUID())}::uuid);`
  ));
}

/** One revision of a pilot whose only question has not run: the manifest names its protocol and no attempt. */
function save(pilotId: string, projectId: string, protocolId: string, status = "integrity_passed", reasons: string[] = []): string[] {
  const payload = { pilotId, projectId };
  const manifest = { protocols: [protocolId], attempts: [] };
  return row(psql(
    `select outcome, coalesce(artifact_id::text, ''), coalesce(revision::text, '') from public.save_pilot_report_artifact(${lit(pilotId)}::uuid, ${lit(FOUNDER)}::uuid, '# Pilot report', ${lit(JSON.stringify(payload))}::jsonb, ${lit(JSON.stringify(manifest))}::jsonb, ${lit(status)}, ${lit(JSON.stringify(reasons))}::jsonb, now());`
  ));
}

const share = (artifactId: string, pilotId: string, ack: boolean) =>
  row(psql(`select outcome, coalesce(public_token, '') from public.share_pilot_report_artifact(${lit(artifactId)}::uuid, ${lit(pilotId)}::uuid, ${lit(FOUNDER)}::uuid, ${ack});`));

/**
 * revision|flag|payload: "null" only when the payload is NULL (withheld),
 * the payload's pilot id when it has one, "no-pilot-id" for any other
 * payload; "" when no row comes back.
 */
const readShared = (token: string) =>
  psql(`select revision::text || '|' || newer_shared_revision::text || '|' || case when payload is null then 'null' else coalesce(payload ->> 'pilotId', 'no-pilot-id') end from public.read_shared_pilot_report(${lit(token)});`);

const tokenOf = (artifactId: string) => admin(`select public_token from public.pilot_report_artifacts where id = ${lit(artifactId)}::uuid;`);

/**
 * The error text, with its SQLSTATE, of a statement run as `role` inside a
 * transaction that is rolled back; null when it succeeds. An error ends the
 * session, which rolls the transaction back; a success reaches the rollback.
 */
const failsVerbose = (sql: string, role: "service_role" | "anon" | "authenticated") =>
  fails(`\\set VERBOSITY verbose\nbegin;\n${sql}\nrollback;`, role);

const md5 = (t: string) => createHash("md5").update(t, "utf8").digest("hex");
/** What pg_proc.prosrc holds for a function a migration defines with `as $$ … $$;`. */
function bodyOf(file: string, definitionStart: string): string {
  const sql = readFileSync(`supabase/migrations/${file}`, "utf8");
  const at = sql.indexOf(definitionStart);
  const open = at < 0 ? -1 : sql.indexOf("as $$", at);
  const close = open < 0 ? -1 : sql.indexOf("\n$$;", open);
  if (at < 0 || open < 0 || close < 0 || sql.indexOf(definitionStart, at + 1) >= 0) throw new Error(`no single definition in ${file}`);
  return sql.slice(open + "as $$".length, close + 1);
}

async function main(): Promise<void> {
  console.log("test-pilot-links-and-claims-db");

  /* setup ------------------------------------------------------------- */
  const [outA, pilotA, projectA] = createPilot("plc-a.example");
  const [qA, , protoA] = addQuestion(pilotA, question(1));
  const [outB, pilotB, projectB] = createPilot("plc-b.example");
  const [qB, , protoB] = addQuestion(pilotB, question(2));
  check("setup: two pilots, one question each, nothing run",
    outA === "CREATED" && outB === "CREATED" && qA === "ADDED" && qB === "ADDED" && protoA !== "" && protoB !== "");

  /* R ----------------------------------------------------------------- */
  const [s1, art1, rev1] = save(pilotA, projectA, protoA);
  const [h1, t1] = share(art1, pilotA, false);
  check("R1 the first shared revision reads its payload, and no newer revision is flagged",
    s1 === "SAVED" && rev1 === "1" && h1 === "SHARED" && readShared(t1) === `1|false|${pilotA}`);

  const [s2, art2] = save(pilotA, projectA, protoA);
  check("R2 a later revision that is not shared replaces nothing: the shared link still reads its payload, and the unshared one reads nothing",
    s2 === "SAVED" && readShared(t1) === `1|false|${pilotA}` && readShared(tokenOf(art2)) === "");

  const [s3, art3] = save(pilotA, projectA, protoA, "blocked", ["Question 1: its evidence does not belong to this pilot's project and protocol."]);
  check("R3 a later blocked revision can never be shared and replaces nothing; its token reads nothing",
    s3 === "SAVED" && share(art3, pilotA, true)[0] === "BLOCKED" &&
    readShared(t1) === `1|false|${pilotA}` && readShared(tokenOf(art3)) === "");

  const [s4, art4] = save(pilotA, projectA, protoA, "needs_review", ["Question 1: the Perplexity measurement has not finished."]);
  const [h4, t4] = share(art4, pilotA, true);
  check("R4 once a later revision is shared, the earlier link answers no payload and the flag; the newest answers its payload",
    s4 === "SAVED" && h4 === "SHARED" && readShared(t1) === "1|true|null" && readShared(t4) === `4|false|${pilotA}`);

  const [s5, art5] = save(pilotA, projectA, protoA);
  const [h5, t5] = share(art5, pilotA, false);
  check("R5 a third share replaces both earlier links; only the newest reads its payload",
    s5 === "SAVED" && h5 === "SHARED" &&
    readShared(t1) === "1|true|null" && readShared(t4) === "4|true|null" && readShared(t5) === `5|false|${pilotA}`);

  check("R6 nothing was deleted: the earlier revisions' payloads are still stored (the table is append-only)",
    admin(`select string_agg(revision::text || ':' || (payload ->> 'pilotId'), ',' order by revision) from public.pilot_report_artifacts where pilot_id = ${lit(pilotA)}::uuid and shared_at is not null;`) ===
      `1:${pilotA},4:${pilotA},5:${pilotA}`);

  const [sB, artB] = save(pilotB, projectB, protoB);
  const [hB, tB] = share(artB, pilotB, false);
  check("R7 another pilot's share replaces nothing in this one",
    sB === "SAVED" && hB === "SHARED" && readShared(tB) === `1|false|${pilotB}` && readShared(t5) === `5|false|${pilotA}`);

  check("R8 a replay of an earlier share answers its token, and the link stays replaced",
    share(art4, pilotA, true).join("|") === `ALREADY_SHARED|${t4}` && readShared(t4) === "4|true|null");

  check("R9 a malformed or unknown token reads nothing",
    readShared("not-a-token") === "" && readShared(t5.toUpperCase()) === "" && readShared(sha(randomUUID())) === "");

  /* F ----------------------------------------------------------------- */
  check("F1 the read keeps 20261109150000's signature and output columns",
    admin(`select pg_get_function_result('public.read_shared_pilot_report(text)'::regprocedure);`) ===
      "TABLE(payload jsonb, revision integer, generated_at timestamp with time zone, shared_at timestamp with time zone, newer_shared_revision boolean)" &&
    admin(`select pg_get_function_identity_arguments('public.read_shared_pilot_report(text)'::regprocedure);`) === "p_public_token text");
  check("F2 it is SECURITY DEFINER, STABLE, SQL, with its pinned search_path",
    admin(`select (p.prosecdef and p.provolatile = 's' and l.lanname = 'sql' and p.proconfig = array['search_path=public, pg_temp']::text[])::text from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = 'public.read_shared_pilot_report(text)'::regprocedure;`) === "true");
  check("F3 only service_role may execute it",
    admin(`select string_agg(r || '=' || has_function_privilege(r, 'public.read_shared_pilot_report(text)', 'execute')::text, ',' order by r) from unnest(array['anon', 'authenticated', 'service_role']) r;`) ===
      "anon=false,authenticated=false,service_role=true" &&
    (["anon", "authenticated"] as const).every((role) =>
      fails(`select * from public.read_shared_pilot_report(${lit(t5)});`, role)?.includes("permission denied") === true));

  /* K ----------------------------------------------------------------- */
  const claimSql = `select status from ${CLAIM.replace("(text, integer)", "")}('w-plc-db', 60);`;
  const claimByIdSql = `select outcome from ${CLAIM_BY_ID.replace("(text, integer, uuid, uuid)", "")}('w-plc-db', 60, ${lit(randomUUID())}::uuid, ${lit(randomUUID())}::uuid);`;
  const k1 = failsVerbose(claimSql, "service_role");
  const k1b = failsVerbose(claimByIdSql, "service_role");
  check("K1 as service_role, both unscoped claims raise insufficient_privilege (42501)",
    k1?.includes("42501") === true && k1.includes("permission denied for function claim_protocol_execution_job") &&
    k1b?.includes("42501") === true && k1b.includes("permission denied for function claim_protocol_execution_job_by_id"),
    `${k1 ?? "no error"} / ${k1b ?? "no error"}`);
  check("K2 anon and authenticated are refused too",
    (["anon", "authenticated"] as const).every((role) =>
      failsVerbose(claimSql, role)?.includes("42501") === true && failsVerbose(claimByIdSql, role)?.includes("42501") === true));
  check("K3 the catalog agrees: no API role holds EXECUTE on either, and PUBLIC holds none",
    admin(`select count(*) from unnest(array['anon', 'authenticated', 'service_role']) r, unnest(array['${CLAIM}', '${CLAIM_BY_ID}']) f where has_function_privilege(r, f, 'execute');`) === "0" &&
    admin(`select count(*) from pg_proc p cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid in ('${CLAIM}'::regprocedure, '${CLAIM_BY_ID}'::regprocedure) and a.grantee = 0;`) === "0");
  const requested = psql(`begin;\nselect outcome from ${REQUESTED.replace("(text, integer)", "")}('w-plc-db', 60);\nrollback;`);
  check("K4 the requested claim, the live worker's, stays executable by service_role (called in a rolled-back transaction)",
    admin(`select has_function_privilege('service_role', '${REQUESTED}', 'execute')::text;`) === "true" &&
    CLAIM_OUTCOMES.includes(requested), requested);
  const ownerClaim = admin(`begin;\n${claimSql}\nrollback;`);
  const ownerClaimById = admin(`begin;\n${claimByIdSql}\nrollback;`);
  check("K5 neither unscoped claim was dropped: the database owner still calls both (the owner-run suites' path), in a rolled-back transaction",
    ["CLAIMED", "NO_JOB_AVAILABLE"].includes(ownerClaim) && ownerClaimById === "JOB_NOT_FOUND",
    `${ownerClaim} / ${ownerClaimById}`);
  const body0054 = md5(bodyOf("0054_m5_worker_probe_result_and_alert_outbox.sql", "create or replace function\n  public.claim_protocol_execution_job(\n"));
  const body0059 = md5(bodyOf("0059_m5_phase3d_targeted_claim.sql", "create or replace function\n  public.claim_protocol_execution_job_by_id(\n"));
  const bodies = admin(`select (select md5(prosrc) from pg_proc where oid = '${CLAIM}'::regprocedure) || '|' || (select md5(prosrc) from pg_proc where oid = '${CLAIM_BY_ID}'::regprocedure);`);
  check("K6 their definitions are still 0054's and 0059's: the bodies byte for byte, SECURITY DEFINER with the pinned search_path",
    bodies === `${body0054}|${body0059}` &&
    admin(`select count(*) from pg_proc p where p.oid in ('${CLAIM}'::regprocedure, '${CLAIM_BY_ID}'::regprocedure) and p.prosecdef and p.proconfig = array['search_path=public, pg_temp']::text[];`) === "2",
    `${bodies} vs ${body0054}|${body0059}`);

  /* G ----------------------------------------------------------------- */
  // The migration's own guards, made to refuse. Each case re-runs the
  // (idempotent) migration file as the owner inside one transaction, after
  // a setup that should trip exactly one guard. The error ends the session,
  // which rolls the setup and the re-run back together; a re-run that does
  // not refuse reaches the closing rollback. Supabase creates service_role
  // NOINHERIT, so an inherited grant needs an explicit `with inherit true`.
  const MIGRATION = readFileSync("supabase/migrations/20261109170000_pilot_links_and_claim_scope.sql", "utf8");
  const READ = "public.read_shared_pilot_report(text)";
  const rerun = (setup: string) => fails(`begin;\n${setup}\n${MIGRATION}\nrollback;`, "supabase_admin");
  const inherited = (role: string, grantee: string, fn: string) =>
    `create role ${role} nologin;\ngrant execute on function ${fn} to ${role};\ngrant ${role} to ${grantee} with inherit true;`;
  /** Every API role's EXECUTE on the four functions, each function's ACL, and the read's definition. */
  const snapshot = () => admin(
    `select string_agg(f || ':' || r || '=' || has_function_privilege(r, f, 'execute')::text, ',' order by f collate "C", r collate "C") from unnest(array['${CLAIM}', '${CLAIM_BY_ID}', '${REQUESTED}', '${READ}']) f, unnest(array['anon', 'authenticated', 'service_role']) r;\n` +
    `select string_agg(coalesce(p.proacl::text, 'null'), ',' order by p.oid) from pg_proc p where p.oid in ('${CLAIM}'::regprocedure, '${CLAIM_BY_ID}'::regprocedure, '${REQUESTED}'::regprocedure, '${READ}'::regprocedure);\n` +
    `select md5(pg_get_functiondef('${READ}'::regprocedure));`);
  const before = snapshot();
  const refusal = (setup: string, message: string) => {
    const err = rerun(setup);
    return { ok: err !== null && err.includes(message), detail: err === null ? "no error" : err.split("\n").find((l) => l.includes("ERROR")) ?? err };
  };

  const asIs = rerun("");
  check("G1 the migration re-run as it is passes every guard (the control for G2 to G8)", asIs === null, asIs ?? "");
  const g2 = refusal(`drop function ${READ};`,
    "20261109170000 precondition: 20261109150000 (pilot report artifacts) is not applied");
  check("G2 the first precondition refuses when the read is missing", g2.ok, g2.detail);
  const g3 = refusal(`drop function ${READ};\ncreate function ${READ.replace("(text)", "(p_public_token text)")} returns table (payload jsonb) language sql stable as $g$ select null::jsonb $g$;`,
    "20261109170000 precondition: read_shared_pilot_report does not return 20261109150000's columns");
  check("G3 the second precondition refuses when the read has other output columns", g3.ok, g3.detail);
  const g4 = refusal(`drop function ${CLAIM_BY_ID};`,
    "20261109170000 precondition: an unscoped protocol claim (0054, 0059) is missing");
  check("G4 the third precondition refuses when an unscoped claim is missing", g4.ok, g4.detail);
  const g5 = refusal(`revoke execute on function ${REQUESTED} from service_role;`,
    "20261109170000 precondition: the requested claim (20261109130000) is missing or not executable by service_role");
  check("G5 the fourth precondition refuses when service_role cannot execute the requested claim (the postcondition would answer otherwise, with its own message)", g5.ok, g5.detail);
  const g6 = refusal(inherited("zp_plc_by_id", "service_role", CLAIM_BY_ID),
    "20261109170000 postcondition: service_role can still execute an unscoped protocol claim");
  check("G6 the postcondition refuses when service_role keeps the targeted claim alone, through an inherited grant the revoke cannot remove", g6.ok, g6.detail);
  const g7 = refusal(inherited("zp_plc_global", "service_role", CLAIM),
    "20261109170000 postcondition: service_role can still execute an unscoped protocol claim");
  check("G7 the postcondition refuses when service_role keeps the global claim alone, the same way", g7.ok, g7.detail);
  const g8 = refusal(inherited("zp_plc_read", "anon", READ),
    "20261109170000 postcondition: read_shared_pilot_report is not executable by service_role only");
  check("G8 the postcondition refuses when anon can execute the read through an inherited grant", g8.ok, g8.detail);
  const after = snapshot();
  check("G9 every re-run and its setup were rolled back: no test role is left, and every API role's EXECUTE, each ACL and the read's definition are as they were before G1",
    admin(`select count(*) from pg_roles where rolname like 'zp_plc_%';`) === "0" && before !== "" && after === before,
    after === before ? "" : `${before}\n  vs\n${after}`);

  finish();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
