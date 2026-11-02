#!/usr/bin/env tsx
/**
 * Static contract for Q2′-1 — the account-first data foundation
 * (supabase/migrations/<14 digits>_q2p1_account_workspace_foundation.sql).
 *
 * Cases QS-01..QS-20 of the Q2′ scope and test plan, as reconciled for Q2′-1
 * (F3, F5 and enrolment moved to Q2′-1b; no adapter). Every detector is then
 * proved to refuse a deliberate mutation of the SQL.
 *
 * Text-only, plus `git` for the changed-path scope (QS-15). No database, no
 * network. The runtime cases (QR-*) are in the Level 2 harness.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { LAST_PRE_TIMESTAMP_LEDGER_VERSION, migrationLedger, parseMigrationName } from "./lib/migration-names";

let failures = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

let fetchCalls = 0;
globalThis.fetch = ((..._a: unknown[]) => {
  fetchCalls += 1;
  throw new Error("network access attempted in a static contract");
}) as unknown as typeof fetch;

const ROOT = process.cwd();
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");
/** B1 rev 3, the commit Q2′-1 is built on (QS-15). */
const B1_BASE = "0d3f3f617158f3551ce78cc500d7b83452cbd299";

const q2pFiles = readdirSync(MIGRATIONS).filter((f) => /_q2p1_/.test(f));
const FILE = q2pFiles[0] ?? "";
const RAW = FILE ? readFileSync(path.join(MIGRATIONS, FILE), "utf8") : "";
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
const SQL = strip(RAW);

const T2A = "workspace_membership_versions";
const SINGLE_TRANSITION = ["workspace_members", "question_review_invitations", "question_review_sessions"];
const ACTOR_COLUMNS = [
  "actor_type", "actor_account_id", "actor_membership_id", "actor_invitation_id",
  "actor_session_id", "actor_operator_id", "rule_id", "rule_version",
];
const SERVICE_ROLE_RPCS = [
  "create_workspace_with_owner", "assign_project_to_workspace", "add_workspace_member",
  "remove_workspace_member", "approve_buyer_question_set",
];
const PAID_TABLES = [
  "protocols", "protocol_execution_jobs", "protocol_attempts", "protocol_external_calls",
  "buyer_question_launch_selections", "snapshot_requests", "spend_controls",
];

function tables(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of sql.matchAll(/create table public\.(\w+)\s*\(([\s\S]*?)\n\);/gi)) out.set(m[1], m[2]);
  return out;
}
function functionBody(sql: string, name: string): string {
  const m = sql.match(new RegExp(`create or replace function public\\.${name}\\s*\\([\\s\\S]*?\\n\\$\\$;`, "i"));
  return m ? m[0] : "";
}
function definedFunctions(sql: string): string[] {
  return [...sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(\w+)\s*\(/gi)].map((m) => m[1].toLowerCase());
}

/** Every detector, over a given SQL text. Each returns [id, label, ok, detail]. */
function detectors(sql: string): Array<[string, string, boolean, string]> {
  const out: Array<[string, string, boolean, string]> = [];
  const add = (id: string, label: string, ok: boolean, detail = "") => out.push([id, label, ok, detail]);
  const t = tables(sql);
  const names = [...t.keys()];
  const revokeAll = sql.match(/revoke all on table([\s\S]*?)from public, anon, authenticated, service_role;/i)?.[1] ?? "";

  add("QS-02", "every new table enables RLS",
    names.every((n) => new RegExp(`alter table public\\.${n} enable row level security;`, "i").test(sql)),
    names.filter((n) => !new RegExp(`alter table public\\.${n} enable row level security;`, "i").test(sql)).join(","));
  add("QS-02", "every new table is revoked from public, anon, authenticated and service_role",
    names.every((n) => new RegExp(`public\\.${n}\\b`).test(revokeAll)),
    names.filter((n) => !new RegExp(`public\\.${n}\\b`).test(revokeAll)).join(","));
  add("QS-02", "no policy is created", !/create\s+policy/i.test(sql));
  add("QS-02", "no table privilege is granted to any role", !/grant\s+(select|insert|update|delete|all)[^;]*on\s+(table\s+)?public\./i.test(sql));

  const withActors = names.filter((n) => n !== T2A);
  add("QS-03", "every table but T2a has the full actor column set",
    withActors.every((n) => ACTOR_COLUMNS.every((c) => new RegExp(`\\n\\s*${c}\\s`).test(t.get(n) ?? ""))),
    withActors.filter((n) => !ACTOR_COLUMNS.every((c) => new RegExp(`\\n\\s*${c}\\s`).test(t.get(n) ?? ""))).join(","));
  add("QS-03", "every table but T2a checks the shared actor shape",
    withActors.every((n) => /public\._q2p_actor_shape_ok\(\s*actor_type, actor_account_id, actor_membership_id, actor_invitation_id,\s*actor_session_id, actor_operator_id, rule_id, rule_version\)/.test(t.get(n) ?? "")),
    withActors.filter((n) => !/public\._q2p_actor_shape_ok\(\s*actor_type/.test(t.get(n) ?? "")).join(","));
  add("QS-03", "every table but T2a has membership and session actor foreign keys",
    withActors.every((n) => new RegExp(`${n}_actor_membership_fk foreign key`).test(sql) && new RegExp(`${n}_actor_session_fk foreign key`).test(sql)),
    withActors.filter((n) => !(new RegExp(`${n}_actor_membership_fk foreign key`).test(sql) && new RegExp(`${n}_actor_session_fk foreign key`).test(sql))).join(","));
  const shape = functionBody(sql, "_q2p_actor_shape_ok");
  add("QS-03", "the actor shape: invitation_holder forbids account and membership",
    /when 'invitation_holder' then\s+p_invitation_id is not null and p_session_id is not null\s+and p_account_id is null and p_membership_id is null/i.test(shape));
  add("QS-03", "the actor shape: customer_account needs account and membership, forbids invitation and session",
    /when 'customer_account' then\s+p_account_id is not null and p_membership_id is not null\s+and p_invitation_id is null and p_session_id is null/i.test(shape));
  add("QS-03", "the actor shape: founder needs an operator; system needs rule id and version",
    /when 'founder' then\s+p_operator_id is not null/i.test(shape) && /when 'system' then\s+coalesce\(btrim\(p_rule_id\), ''\) <> '' and coalesce\(btrim\(p_rule_version\), ''\) <> ''/i.test(shape)
      && /else false/i.test(shape));

  const appendOnly = names.filter((n) => n !== T2A && !SINGLE_TRANSITION.includes(n));
  add("QS-04", "every append-only table refuses update and delete",
    appendOnly.every((n) => new RegExp(`create trigger ${n}_append_only before update or delete on public\\.${n}`).test(sql)),
    appendOnly.filter((n) => !new RegExp(`create trigger ${n}_append_only`).test(sql)).join(","));
  add("QS-04", "the single-transition tables have their guards",
    SINGLE_TRANSITION.every((n) => new RegExp(`before update or delete on public\\.${n}\\s+for each row execute function public\\._q2p_\\w+_guard\\(\\)`).test(sql)));
  add("QS-04", "every table refuses TRUNCATE",
    names.every((n) => new RegExp(`create trigger ${n}_no_truncate before truncate on public\\.${n}`).test(sql)),
    names.filter((n) => !new RegExp(`${n}_no_truncate`).test(sql)).join(","));

  const pinned = names.filter((n) => /\n\s*project_id\s+uuid/.test(t.get(n) ?? "") && n !== "workspace_projects");
  add("QS-05", "every child table pins (project_id, workspace_id) to workspace_projects",
    pinned.length >= 9 && pinned.every((n) => /foreign key \(project_id, workspace_id\)\s+references public\.workspace_projects\(project_id, workspace_id\)/.test(t.get(n) ?? "")),
    pinned.filter((n) => !/references public\.workspace_projects\(project_id, workspace_id\)/.test(t.get(n) ?? "")).join(","));

  const ar = t.get("approval_records") ?? "";
  add("QS-06", "approval_records allows only approve_buyer_question_set", /action_type\s+text not null check \(action_type = 'approve_buyer_question_set'\)/.test(ar));
  add("QS-06", "approval_records: session type and actor agree",
    /session_type = 'review_invitation' and actor_type = 'invitation_holder'\s+and actor_session_id = session_id/.test(ar)
      && /session_type = 'account' and actor_type = 'customer_account' and step_up_event_id is not null/.test(ar));

  const awc = t.get("approved_wording_classifications") ?? "";
  add("QS-07", "founder_review implies adapted or hypothesis", /rule <> 'founder_review' or classification in \('adapted', 'hypothesis'\)/.test(awc));
  add("QS-07", "observed implies inherited_unchanged or exact_source_match", /classification <> 'observed' or rule in \('inherited_unchanged', 'exact_source_match'\)/.test(awc));

  const src = t.get("question_sources") ?? "";
  add("QS-08", "public source needs URL and retrieval date", /source_kind = 'customer_material'\s+or \(coalesce\(btrim\(url\), ''\) <> '' and retrieved_at is not null\)/.test(src));
  add("QS-08", "customer material needs reference, attestation and date received", /coalesce\(btrim\(customer_reference\), ''\) <> '' and customer_attested_at is not null\s+and received_at is not null/.test(src));
  add("QS-08", "personal data must be removed", /check \(personal_data_removed\)/.test(src));
  add("QS-08", "site copy is never buyer-authored", /source_kind <> 'site_copy' or not buyer_authored/.test(src));
  add("QS-08", "excerpt is 1-300 characters and hashed", /length\(excerpt\) between 1 and 300/.test(src) && /excerpt_sha256 = public\._q2p_sha256_hex\(excerpt\)/.test(src));
  add("QS-08", "quoted spans are checked in the excerpt and on word boundaries",
    /q2p_quoted_span_not_in_excerpt/.test(sql) && /q2p_quoted_span_not_word_aligned/.test(sql) && /_q2p_span_at_word_boundary/.test(sql));

  const columnNames = [...t.values()].flatMap((b) => [...b.matchAll(/\n\s*(\w+)\s+(?:text|uuid|jsonb|boolean|integer|bigint|timestamptz)/g)].map((m) => m[1]));
  add("QS-09", "no column stores a raw token or raw email",
    columnNames.every((c) => !/^(token|raw_token|session_token|invitation_token|email|work_email|email_address)$/.test(c)),
    columnNames.filter((c) => /^(token|email)/.test(c) && !/_hash$|_hmac/.test(c)).join(","));
  add("QS-09", "token hashes carry a documented purpose label",
    /'zypact\.question_review_invitation\.v1'/.test(RAW) && /'zypact\.question_review_session\.v1'/.test(sql)
      && /comment on function public\._q2p_token_hash/.test(sql));

  add("QS-11", "no PG-9 object is mentioned",
    !/protocol_external_calls|spend_controls|send marker|_spend_/i.test(sql) && !/alter table public\.protocols\b/i.test(sql));
  const paidWrite = PAID_TABLES.filter((p) => new RegExp(`(insert into|update|delete from)\\s+public\\.${p}\\b`, "i").test(sql));
  add("QS-12", "no write to any paid-path or request table", paidWrite.length === 0, paidWrite.join(","));
  add("QS-12", "F4 calls only the existing version-approval function outside Q2′-1",
    !/perform\s+public\.(approve_protocol|enqueue_protocol_execution_job|approve_and_launch_snapshot_baseline)/i.test(sql)
      && !/from public\.(approve_protocol|enqueue_protocol_execution_job|approve_and_launch_snapshot_baseline)\(/i.test(sql));

  const earlier = new Set(
    migrationLedger(MIGRATIONS).filter((m) => m.f !== FILE).flatMap((m) => definedFunctions(strip(m.sql)))
  );
  const redefined = definedFunctions(sql).filter((f) => earlier.has(f));
  add("QS-12b", "redefines no function that exists before Q2′-1 (0069 and PG-9 untouched)", redefined.length === 0, redefined.join(","));
  add("QS-12b", "alters no existing table", !/alter table public\.(?!workspaces|workspace_members|workspace_membership_versions|workspace_projects|question_|approval_records|buyer_question_version_origins|approved_wording_classifications|exception_)/i.test(sql));

  add("QS-16", "F1, F2, F4, F7, F8 are executable by service_role only",
    SERVICE_ROLE_RPCS.every((f) => new RegExp(`revoke all on function public\\.${f}\\([^)]*\\) from public, anon, authenticated;`).test(sql)
      && new RegExp(`grant execute on function public\\.${f}\\([^)]*\\) to service_role;`).test(sql)));
  add("QS-16", "F6 is executable by no role, service_role included",
    /revoke all on function public\.assert_current_account_member\(uuid\) from public, anon, authenticated, service_role;/.test(sql)
      && !/grant execute on function public\.assert_current_account_member/i.test(sql));
  add("QS-16", "nothing is granted to anon or authenticated", !/grant [^;]* to (anon|authenticated)\b/i.test(sql));
  const f4 = functionBody(sql, "approve_buyer_question_set");
  add("QS-16", "F4 takes no account, session or invitation id — only the raw session token",
    /p_session_token text/.test(f4) && !/p_(account|session|invitation|membership)_id/.test(f4.split("returns table")[0] ?? ""));
  add("QS-16", "F4 binds the actor from the hashed token", /_q2p_token_hash\('zypact\.question_review_session\.v1', p_session_token\)/.test(f4));

  const created = [...names, ...definedFunctions(sql)];
  const forbidden = created.filter((n) => /^(_spend_|spend_|intervention_deviations|record_intervention_deviation|bqi_enrollments|enroll_snapshot_request_in_bqi)/.test(n));
  add("QS-17", "the object inventory contains no PG-9, 0082 or Q2′-1b object", forbidden.length === 0, forbidden.join(","));
  add("QS-17", "inventory: 15 tables", names.length === 15, String(names.length));

  add("QS-19", "the migration never mentions the Level 2 fixture", !/level2_fixture/.test(RAW === sql ? sql : sql));
  add("QS-19", "the migration does not reference the auth schema", !/\bauth\.\w+/.test(sql));
  const f6 = functionBody(sql, "assert_current_account_member");
  add("QS-19", "F6 reads request.jwt.claims and requires role authenticated and a UUID subject",
    /current_setting\('request\.jwt\.claims', true\)/.test(f6) && /->> 'role' is distinct from 'authenticated'/.test(f6) && /\[0-9a-f\]\{8\}-/.test(f6));
  add("QS-19", "one active membership per account and workspace (partial unique index)",
    /create unique index workspace_members_one_active\s+on public\.workspace_members \(workspace_id, account_id\) where removed_at is null;/.test(sql));

  const t2a = t.get(T2A) ?? "";
  add("QS-20", "T2a has no actor columns", !/actor_type/.test(t2a));
  add("QS-20", "T2a is excluded from QS-03/QS-04 by name only", withActors.length === names.length - 1 && appendOnly.length === names.length - 1 - SINGLE_TRANSITION.length);
  add("QS-20", "T2a only moves by +1 and cannot be deleted", /new\.version <> old\.version \+ 1/.test(sql) && /q2p_append_only: workspace_membership_versions/.test(sql));
  for (const f of ["add_workspace_member", "remove_workspace_member"]) {
    const body = functionBody(sql, f);
    const v = body.search(/update public\.workspace_membership_versions\s+set version = version \+ 1/);
    const m = body.search(/from public\.workspace_members/);
    add("QS-20", `${f} writes the version row before reading memberships`, v > 0 && m > v, `${v} vs ${m}`);
    add("QS-20", `${f} sets a lock_timeout`, /set lock_timeout = '5s'/.test(body));
  }
  add("QS-20", "F6 holds FOR SHARE and never touches the version row",
    /removed_at is null\s+for share;/.test(f6) && !/workspace_membership_versions/.test(f6) && /set lock_timeout = '5s'/.test(f6));
  const f8 = functionBody(sql, "remove_workspace_member");
  add("QS-20", "F8 refuses the last active owner", /if v_others = 0 then\s+raise exception using errcode = 'P0001', message = 'last_active_owner';/.test(f8));

  return out;
}

/* ═══════════════ 1. the file ═══════════════ */
{
  console.log("\n[1] QS-01 — the migration file");
  assert("QS-01 exactly one Q2′-1 migration file", q2pFiles.length === 1, q2pFiles.join(","));
  const parsed = parseMigrationName(FILE);
  assert("QS-01 it is a valid 14-digit timestamped name", parsed.ok && parsed.kind === "timestamp", FILE);
  assert("QS-01 its version is above production's 0081 row",
    parsed.ok && parsed.version > LAST_PRE_TIMESTAMP_LEDGER_VERSION);
  const order = migrationLedger(MIGRATIONS).map((m) => m.f);
  assert("QS-01 it is last in apply order", order[order.length - 1] === FILE, order.slice(-2).join(" -> "));
  assert("QS-01 its header states it is new-objects-only and forward-recoverable",
    /Every object here is NEW/.test(RAW) && /Recovery: forward-only/.test(RAW));
}

/* ═══════════════ 2. the detectors on the real SQL ═══════════════ */
{
  console.log("\n[2] QS-02..QS-20 on the real migration");
  for (const [id, label, ok, detail] of detectors(SQL)) assert(`${id} ${label}`, ok, detail);
}

/* ═══════════════ 3. QS-15 changed-path scope, QS-19 application code ═══════════════ */
{
  console.log("\n[3] QS-15 — changed paths since B1 rev 3; QS-19 — application code");
  const git = (args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
  const changed = new Set([
    ...git(["diff", "--name-only", B1_BASE]).split("\n"),
    ...git(["ls-files", "--others", "--exclude-standard"]).split("\n"),
  ].filter(Boolean));
  const allowed = (p: string) =>
    /^supabase\/migrations\/\d{14}_q2p1_[a-z0-9_]+\.sql$/.test(p)
    || ["scripts/test-q2p-schema-contract.ts", "scripts/test-snapshot-worker-postgres-level2.sh",
        "scripts/sql/level2-q2p1-fixtures.sql", "package.json", "docs/CURRENT_STATUS.md", "docs/DECISIONS.md"].includes(p);
  const outside = [...changed].filter((p) => !allowed(p));
  assert("QS-15 every changed path is in the Q2′-1 allowed set", outside.length === 0, outside.join(","));
  assert("QS-15 no PG-9 file changed", ![...changed].some((p) => /pg9/i.test(p)));
  assert("QS-15 no existing migration changed",
    ![...changed].some((p) => p.startsWith("supabase/migrations/") && !/_q2p1_/.test(p)));
  const appFiles = git(["ls-files", "lib", "app"]).split("\n").filter((p) => /\.(ts|tsx)$/.test(p));
  const leaks = appFiles.filter((p) => readFileSync(path.join(ROOT, p), "utf8").includes("level2_fixture"));
  assert("QS-19 no application file mentions level2_fixture", leaks.length === 0, leaks.join(","));
}

/* ═══════════════ 4. every detector is proved to bite ═══════════════ */
{
  console.log("\n[4] Negative self-tests");
  const mutations: Array<[string, string, string, string]> = [
    ["dropping RLS on one table", "alter table public.approval_records enable row level security;", "", "every new table enables RLS"],
    ["granting a table to authenticated", "-- ════════════════════════════════════════════════════════════════════════\n-- 9. F6", "grant select on table public.workspaces to authenticated;\n-- 9. F6", "no table privilege is granted"],
    ["adding a policy", "alter table public.workspaces enable row level security;", "alter table public.workspaces enable row level security;\ncreate policy p on public.workspaces using (true);", "no policy is created"],
    ["dropping one actor shape check", "constraint question_sources_actor_shape check (public._q2p_actor_shape_ok(\n    actor_type, actor_account_id, actor_membership_id, actor_invitation_id,\n    actor_session_id, actor_operator_id, rule_id, rule_version))\n);", "constraint question_sources_actor_shape check (true)\n);", "checks the shared actor shape"],
    ["letting an invitation holder carry an account", "and p_account_id is null and p_membership_id is null and p_operator_id is null\n      and p_rule_id is null and p_rule_version is null\n    when 'founder'", "and p_membership_id is null and p_operator_id is null\n      and p_rule_id is null and p_rule_version is null\n    when 'founder'", "invitation_holder forbids account"],
    ["making a table updatable", "create trigger approval_records_append_only before update or delete", "create trigger approval_records_append_only before delete", "refuses update and delete"],
    ["dropping a composite project pin", "constraint approval_records_project_fk foreign key (project_id, workspace_id)\n    references public.workspace_projects(project_id, workspace_id),", "", "pins (project_id, workspace_id)"],
    ["letting founder review record observed", "rule <> 'founder_review' or classification in ('adapted', 'hypothesis')", "true", "founder_review implies"],
    ["dropping the personal-data check", "constraint question_sources_personal_data_removed check (personal_data_removed),", "", "personal data must be removed"],
    ["storing a raw token", "token_hash           text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),\n  expires_at", "token text,\n  token_hash           text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),\n  expires_at", "no column stores a raw token"],
    ["writing to protocols", "insert into public.buyer_questions (project_id)", "insert into public.protocols (project_id) values (null);\n    insert into public.buyer_questions (project_id)", "no write to any paid-path"],
    ["redefining the 0069 launch function", "-- ════════════════════════════════════════════════════════════════════════\n-- 12. Function privileges", "create or replace function public.approve_and_launch_snapshot_baseline(a uuid) returns void language sql as $$ select 1 $$;\n-- 12. Function privileges", "redefines no function that exists"],
    ["granting F6 to service_role", "-- Founder/system and invitation paths: service_role only.", "grant execute on function public.assert_current_account_member(uuid) to service_role;", "F6 is executable by no role"],
    ["granting an RPC to authenticated", "grant execute on function public.approve_buyer_question_set(text, uuid, jsonb, text, text, text, text, text) to service_role;", "grant execute on function public.approve_buyer_question_set(text, uuid, jsonb, text, text, text, text, text) to authenticated;", "executable by service_role only"],
    ["reading auth.uid()", "current_setting('request.jwt.claims', true)", "auth.uid()::text", "does not reference the auth schema"],
    ["dropping FOR SHARE from F6", "and m.removed_at is null\n   for share;", "and m.removed_at is null;", "F6 holds FOR SHARE"],
    ["reading memberships before the version row in F8", "  update public.workspace_membership_versions\n     set version = version + 1, updated_at = now()\n   where workspace_membership_versions.workspace_id = p_workspace_id;\n  if not found then\n    raise exception using errcode = '22023', message = 'q2p_workspace_not_found';\n  end if;\n\n  select m.* into v_target", "  perform 1 from public.workspace_members;\n  update public.workspace_membership_versions\n     set version = version + 1, updated_at = now()\n   where workspace_membership_versions.workspace_id = p_workspace_id;\n  if not found then\n    raise exception using errcode = '22023', message = 'q2p_workspace_not_found';\n  end if;\n\n  select m.* into v_target", "remove_workspace_member writes the version row before"],
    ["dropping the last-owner refusal", "if v_others = 0 then", "if false then", "refuses the last active owner"],
    ["adding an enrolment table (Q2′-1b)", "create table public.question_sources (", "create table public.bqi_enrollments (\n  id uuid\n);\n\ncreate table public.question_sources (", "no PG-9, 0082 or Q2′-1b object"],
  ];
  for (const [label, needle, replacement, detectorFragment] of mutations) {
    const mutated = strip(RAW.replace(needle, replacement));
    assert(`the mutation "${label}" changes the SQL`, RAW.includes(needle) && mutated !== SQL);
    const failing = detectors(mutated).filter(([, l, ok]) => !ok && l.includes(detectorFragment));
    assert(`…and the detector "${detectorFragment}" refuses it`, failing.length > 0);
  }
}

console.log("");
assert("no network access was attempted", fetchCalls === 0);

console.log(
  failures === 0
    ? "\nQ2′-1 schema contract PASSED."
    : `\n${failures} check(s) failed. Q2′-1 schema contract FAILED.`
);
process.exit(failures === 0 ? 0 : 1);
