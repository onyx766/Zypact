#!/usr/bin/env tsx
/**
 * Q4 behaviour on a real PostgreSQL (20261113120000_q4_question_activation.sql, D-049):
 * step-up before approval, activation into buyer_question_versions through
 * M4's own approval, the plan's active-question limit, new versions for
 * changed wording, archive and reactivation, isolation, append-only and
 * privileges.
 *
 * Runs against a DISPOSABLE Supabase Postgres with every migration applied
 * (scripts/run-p2-workspace-db-local.sh). Opt-in: SKIP (exit 2) without
 * ZYPACT_P2_DB_CONTAINER. No network.
 */
import { createHash, randomUUID } from "node:crypto";

import { db, lit, makeChecker, makeTenant, requireContainer, row, who, type Tenant } from "./lib/workspace-db";

const CONTAINER = requireContainer();
(globalThis as unknown as { fetch: unknown }).fetch = () => {
  throw new Error("network disabled");
};
const { psql, fails } = db(CONTAINER);
const { check, finish } = makeChecker();

const CONSENT = `'q4.activate.v1', '${"a".repeat(64)}'`;
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

const stepUp = (t: Tenant) => row(psql(`select status from public.record_account_step_up(${who(t)});`))[0];
const addDraft = (t: Tenant, text: string, category = "discovery") =>
  row(psql(`select status, draft_id from public.add_question_draft(${who(t)}, ${lit(text)}, ${lit(category)}, null);`));
const reviseDraft = (t: Tenant, id: string, v: number, text: string, status = "draft") =>
  row(psql(`select status, version from public.revise_question_draft(${who(t)}, ${lit(id)}::uuid, ${v}, ${lit(text)}, 'discovery', ${lit(status)});`));
const approve = (t: Tenant, draft: string, v: number, key = randomUUID()) =>
  row(psql(`select status, buyer_question_id, buyer_question_version_id from public.approve_question_draft(${who(t)}, ${lit(draft)}::uuid, ${v}, ${lit(key)}, ${CONSENT});`));
const archive = (t: Tenant, q: string) => psql(`select status from public.archive_active_question(${who(t)}, ${lit(q)}::uuid);`);
const list = (t: Tenant) =>
  JSON.parse(psql(`select public.list_active_questions(${who(t)});`)) as {
    status: string;
    limit: number;
    active_count: number;
    questions: Array<{ buyer_question_id: string; draft_id: string; active: boolean; versions: Array<{ number: number; text: string; approved_at: string | null }> }>;
  };
const workspaceOf = (accountId: string) => psql(`select workspace_id from public.workspace_members where account_id = ${lit(accountId)}::uuid;`, "supabase_admin");

async function main(): Promise<void> {
  console.log("test-q4-activation-db");
  const a = makeTenant(psql, "Acme", "acme-analytics.example");
  const b = makeTenant(psql, "Other", "other-co.example");
  const noSite = makeTenant(psql, "NoSite", null);

  const textA = "What is the best retail analytics software for small shops?";
  const [, dA] = addDraft(a, textA);
  const [, dB] = addDraft(a, "How do independent retailers forecast stock levels?");

  /* S: step-up ------------------------------------------------------ */
  check("S1 approval without a step-up is STEP_UP_REQUIRED", approve(a, dA, 1)[0] === "STEP_UP_REQUIRED");
  check("S2 nothing was created", psql(`select count(*) from public.workspace_question_approvals where workspace_id = ${lit(workspaceOf(a.accountId))}::uuid;`, "supabase_admin") === "0");
  check("S3 the step-up is recorded", stepUp(a) === "STEPPED_UP");
  check("S4 malformed consent is refused", fails(`select * from public.approve_question_draft(${who(a)}, ${lit(dA)}::uuid, 1, 'k', 'v1', 'x');`)?.includes("q4_invalid_approval_args") === true);
  check("S5 a stale step-up cannot be stored", fails(`insert into public.workspace_question_approvals (workspace_id, project_id, draft_id, draft_version, approved_text_sha256, draft_origin, buyer_question_id, buyer_question_version_id, action, session_id, step_up_at, consent_text_version, consent_text_sha256, idempotency_key, actor_type, actor_account_id, actor_membership_id) values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, '${"b".repeat(64)}', 'customer_written', gen_random_uuid(), gen_random_uuid(), 'activate', gen_random_uuid(), now() - interval '1 hour', 'q4.activate.v1', '${"a".repeat(64)}', 'x', 'customer_account', gen_random_uuid(), gen_random_uuid());`, "supabase_admin") !== null);

  /* A: activation --------------------------------------------------- */
  const key1 = randomUUID();
  const [st, qA, vA1] = approve(a, dA, 1, key1);
  check("A1 the first approval is ACTIVATED", st === "ACTIVATED" && Boolean(qA) && Boolean(vA1));
  const ver = row(psql(`select prompt_text, prompt_hash, version_number, provenance, approved_at is not null, approved_by from public.buyer_question_versions where id = ${lit(vA1)}::uuid;`, "supabase_admin"));
  check("A2 the version holds the exact draft text and its SHA-256", ver[0] === textA && ver[1] === sha(textA) && ver[2] === "1" && ver[3] === "customer_supplied");
  const approvalId = psql(`select id from public.workspace_question_approvals where buyer_question_version_id = ${lit(vA1)}::uuid;`, "supabase_admin");
  check("A3 M4 approval names the approval record", ver[4] === "t" && ver[5] === approvalId);
  check("A4 the version lives in the workspace's own project", psql(`select count(*) from public.buyer_question_versions v join public.workspace_projects wp on wp.project_id = v.project_id where v.id = ${lit(vA1)}::uuid and wp.workspace_id = ${lit(workspaceOf(a.accountId))}::uuid;`, "supabase_admin") === "1");
  check("A5 the approval record keeps session, step-up and consent", psql(`select count(*) from public.workspace_question_approvals where id = ${lit(approvalId)}::uuid and step_up_at is not null and consent_text_version = 'q4.activate.v1' and draft_origin = 'customer_written' and approved_text_sha256 = ${lit(sha(textA))};`, "supabase_admin") === "1");
  check("A6 a replay of the key returns the same question", approve(a, dA, 1, key1).join() === `ALREADY_APPROVED,${qA},${vA1}`);
  check("A7 the key for another draft is IDEMPOTENCY_KEY_CONFLICT", approve(a, dB, 1, key1)[0] === "IDEMPOTENCY_KEY_CONFLICT");
  check("A8 approving the same wording again is UNCHANGED", approve(a, dA, 1)[0] === "UNCHANGED");
  check("A9 a stale draft version is VERSION_CONFLICT", approve(a, dA, 9)[0] === "VERSION_CONFLICT");
  check("A10 approval never touches the usage ledger", psql(`select count(*) from public.workspace_usage_events where workspace_id = ${lit(workspaceOf(a.accountId))}::uuid;`, "supabase_admin") === "0");
  check("A11 approval starts no protocol or attempt", psql(`select (select count(*) from public.protocols p join public.buyer_question_versions v on v.id = p.buyer_question_version_id where v.buyer_question_id = ${lit(qA)}::uuid);`, "supabase_admin") === "0");

  /* L: limit -------------------------------------------------------- */
  check("L1 Free allows one active question", list(a).limit === 1 && list(a).active_count === 1);
  check("L2 a second activation on Free is LIMIT_REACHED", approve(a, dB, 1)[0] === "LIMIT_REACHED");

  /* V: versions ----------------------------------------------------- */
  const textA2 = "What is the best retail analytics software for independent shops?";
  check("V1 the draft is edited", reviseDraft(a, dA, 1, textA2)[0] === "SAVED");
  const [vs, vq, vA2] = approve(a, dA, 2);
  check("V2 approving changed wording is VERSION_ADDED on the same question", vs === "VERSION_ADDED" && vq === qA && vA2 !== vA1);
  check("V3 a new version does not count against the limit", list(a).active_count === 1);
  const versions = list(a).questions.find((q) => q.buyer_question_id === qA)?.versions ?? [];
  check("V4 both versions are kept, the first unchanged", versions.length === 2 && versions[0].text === textA && versions[1].text === textA2 && versions[1].number === 2);
  check("V5 an archived draft cannot be approved", (() => {
    reviseDraft(a, dB, 1, "How do independent retailers forecast stock levels?", "archived");
    return approve(a, dB, 2)[0] === "DRAFT_ARCHIVED";
  })());

  /* R: archive and reactivate --------------------------------------- */
  check("R1 archive is ARCHIVED", archive(a, qA) === "ARCHIVED");
  check("R2 archive again is ALREADY_ARCHIVED", archive(a, qA) === "ALREADY_ARCHIVED");
  check("R3 the question is listed as not active, with its versions", list(a).questions.find((q) => q.buyer_question_id === qA)?.active === false && list(a).active_count === 0);
  const [, dC] = addDraft(a, "Which inventory tools integrate with Shopify POS?");
  check("R4 the freed slot can be used", approve(a, dC, 1)[0] === "ACTIVATED");
  check("R5 reactivating beyond the limit is LIMIT_REACHED", approve(a, dA, 2)[0] === "LIMIT_REACHED");
  const ws = workspaceOf(a.accountId);
  psql(`select status from public.assign_workspace_plan(${lit(ws)}::uuid, 'starter', 'founder', now(), ${lit(randomUUID())}, 'founder', gen_random_uuid(), null, null, null, null);`);
  const [rs, rq, rv] = approve(a, dA, 2);
  check("R6 on Starter, the archived question is REACTIVATED with its existing version", rs === "REACTIVATED" && rq === qA && rv === vA2);
  check("R7 reactivation added no version", psql(`select count(*) from public.buyer_question_versions where buyer_question_id = ${lit(qA)}::uuid;`, "supabase_admin") === "2");
  check("R8 Starter's limit is 20", list(a).limit === 20 && list(a).active_count === 2);

  /* W: wording ------------------------------------------------------ */
  check("W1 the same wording as an active question is ALREADY_ACTIVE_WORDING", (() => {
    reviseDraft(a, dA, 2, textA2, "archived");
    const [, dDup] = addDraft(a, textA2);
    return approve(a, dDup, 1)[0] === "ALREADY_ACTIVE_WORDING";
  })());

  /* I: isolation ---------------------------------------------------- */
  stepUp(b);
  check("I1 another workspace cannot approve this draft", approve(b, dC, 1)[0] === "NOT_FOUND");
  check("I2 another workspace cannot archive this question", archive(b, qA) === "NOT_FOUND");
  check("I3 another workspace lists nothing", list(b).questions.length === 0);
  check("I4 a workspace without a website is NO_WEBSITE", (() => {
    stepUp(noSite);
    const [, d] = addDraft(noSite, "A question for a workspace without a site");
    return approve(noSite, d, 1)[0] === "NO_WEBSITE";
  })());
  const ghost: Tenant = { accountId: a.accountId, token: "0".repeat(64) };
  check("I5 an unknown session is NOT_SIGNED_IN", approve(ghost, dC, 1)[0] === "NOT_SIGNED_IN" && archive(ghost, qA) === "NOT_SIGNED_IN");

  /* P: append-only and privileges ----------------------------------- */
  for (const table of ["workspace_question_approvals", "workspace_active_question_events"]) {
    check(`P1 ${table}: UPDATE is refused`, fails(`update public.${table} set workspace_id = workspace_id;`, "supabase_admin")?.includes("q4_append_only") === true);
    check(`P2 ${table}: DELETE is refused`, fails(`delete from public.${table};`, "supabase_admin")?.includes("q4_append_only") === true);
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      check(`P3 ${table}: ${role} cannot read it`, fails(`select 1 from public.${table} limit 1;`, role) !== null);
    }
  }
  for (const role of ["anon", "authenticated"] as const) {
    check(`P4 ${role} cannot approve`, fails(`select * from public.approve_question_draft(${who(a)}, ${lit(dC)}::uuid, 1, 'k', ${CONSENT});`, role)?.includes("permission denied") === true);
    check(`P5 ${role} cannot list`, fails(`select public.list_active_questions(${who(a)});`, role)?.includes("permission denied") === true);
  }
  check("P6 service_role cannot call a _q4_ helper", fails(`select public._q4_active_count(gen_random_uuid());`)?.includes("permission denied") === true);

  finish();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
