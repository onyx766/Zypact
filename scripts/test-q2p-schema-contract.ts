#!/usr/bin/env tsx
/**
 * Static contract for Q2′-1 — the account-first data foundation
 * (supabase/migrations/<14 digits>_q2p1_account_workspace_foundation.sql).
 *
 * Cases QS-01..QS-20 of the Q2′ scope and test plan, as reconciled for Q2′-1,
 * plus QS-21..QS-26 from the remediation rounds (R1–R4, R6, email binding)
 * (F3, F5 and enrolment moved to Q2′-1b; no adapter). Every detector is then
 * proved to refuse a deliberate mutation of the SQL.
 *
 * Text-only, plus `git ls-files` for QS-19. No database, no network. The
 * runtime cases (QR-*) are in the Level 2 harness. Every check here stays
 * true when later migrations are added, so this contract can run on any
 * change. The Q2′-1 change-scope check (QS-15) is the separate
 * scripts/test-q2p1-scope.ts, which needs the base the change is reviewed
 * against.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { classifyApprovedWording } from "@/lib/buyer-questions/classify-wording";
import type { Candidate, CandidateSourceLink, Origin, QuestionSource, ResearchSet, SourceKind } from "@/lib/buyer-questions/types";
import { sha256Utf8Hex } from "@/lib/buyer-questions/validate-source";
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

  // Only migrations applied BEFORE Q2′-1: a later migration may legitimately
  // redefine a Q2′-1 function without making Q2′-1 itself a redefinition.
  const ledger = migrationLedger(MIGRATIONS);
  const fileIndex = ledger.findIndex((m) => m.f === FILE);
  const earlier = new Set(
    ledger.slice(0, fileIndex < 0 ? ledger.length : fileIndex).flatMap((m) => definedFunctions(strip(m.sql)))
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

  // ── Remediation round (R1–R4) ──
  const inv = t.get("question_review_invitations") ?? "";
  add("QS-21", "an exchanged invitation must carry a verified email (an unexchanged one need not)",
    /check \(\s*exchanged_at is null or email_verified_at is not null\)/.test(inv));
  add("QS-21", "a session can only be created for an exchanged, email-verified invitation",
    /i\.exchanged_at is not null and i\.email_verified_at is not null\) then\s+raise exception using errcode = '23514', message = 'q2p_session_needs_exchanged_verified_invitation'/.test(functionBody(sql, "_q2p_session_within_invitation")));
  add("QS-21", "F4 refuses an invitation without a verified email",
    /or v_invitation\.exchanged_at is null\s+or v_invitation\.email_verified_at is null/.test(f4));
  add("QS-22", "every observed classification in F4 is guarded by the source-backed span check",
    (f4.match(/v_class := 'observed'/g) ?? []).length === 2
      && /v_cand\.evidence_grade = 'observed'\s+and public\._q2p_observed_span_ok\(v_cand\.id, v_cand\.primary_source_id, v_texts\[v_i\], v_cand\.verification\) then\s+v_class := 'observed'/.test(f4)
      && /if public\._q2p_observed_span_ok\(v_cand\.id, v_cand\.primary_source_id, v_texts\[v_i\], v_verif\) then\s+v_class := 'observed'/.test(f4));
  add("QS-22", "every adapted classification in F4 is guarded by the basis check",
    (f4.match(/v_class := 'adapted'/g) ?? []).length === 1
      && /v_cand\.evidence_grade = 'adapted'\s+and public\._q2p_adapted_basis_ok\(v_cand\.id, v_cand\.primary_source_id, v_cand\.verification\) then\s+v_class := 'adapted'/.test(f4));
  const spanOk = functionBody(sql, "_q2p_observed_span_ok");
  add("QS-22", "the span check requires a byte-exact verbatim span on a buyer-authored, non-site-copy, same-verification, intact source",
    /l\.relation = 'verbatim'/.test(spanOk) && /l\.quoted_span = p_text/.test(spanOk) && /s\.buyer_authored/.test(spanOk)
      && /s\.source_kind <> 'site_copy'/.test(spanOk) && /s\.verification = p_verification/.test(spanOk)
      && /s\.excerpt_sha256 = public\._q2p_sha256_hex\(s\.excerpt\)/.test(spanOk)
      && /_q2p_span_at_word_boundary\(s\.excerpt, l\.quoted_span\)/.test(spanOk));
  add("QS-23", "the F4 fingerprint is a canonical jsonb, items sorted by prompt hash",
    /v_fp := public\._q2p_sha256_hex\(jsonb_build_object\(/.test(f4) && /order by u\.prompt_hash\)/.test(f4)
      && /'consent_text_version', p_consent_text_version/.test(f4) && /'consent_text_sha256', p_consent_text_sha256/.test(f4)
      && /'research_set_id', v_set\.id/.test(f4) && !/array_to_string/.test(f4));
  add("QS-23", "idempotency keys are scoped to the research set",
    /unique \(research_set_id, idempotency_key\)/.test(ar) && !/idempotency_key\s+text not null unique/.test(ar));
  add("QS-23", "explicit conflict statuses exist and come after authorisation",
    f4.indexOf("IDEMPOTENCY_KEY_CONFLICT") > f4.indexOf("v_invitation.email_verified_at is null")
      && f4.indexOf("SET_ALREADY_APPROVED") > f4.indexOf("v_invitation.email_verified_at is null")
      && f4.indexOf("IDEMPOTENCY_KEY_CONFLICT") > 0);
  add("QS-24", "no Q2′-1 function catches unique_violation (D-021/D-023)", !/when\s+unique_violation/i.test(sql));
  add("QS-24", "no Q2′-1 function swallows serialization failures", !/when\s+(serialization_failure|others)\s+then\s+(return|null)/i.test(sql));
  const f1 = functionBody(sql, "create_workspace_with_owner");
  add("QS-24", "F1 takes the key's advisory lock before its key lookup",
    f1.search(/pg_advisory_xact_lock\(hashtextextended\('zypact\.q2p\.create_workspace:' \|\| p_idempotency_key, 0\)\)/) > 0
      && f1.search(/pg_advisory_xact_lock/) < f1.search(/where w\.idempotency_key = p_idempotency_key/));
  add("QS-24", "F1 reports a key conflict as a status, not by catching", /'IDEMPOTENCY_KEY_CONFLICT'::text/.test(f1));

  // ── R6: invitation lock and decision-point clock ──
  const iSes = f4.search(/from public\.question_review_sessions s\s+where s\.token_hash = [^;]*\s+for update;/);
  const iInv = f4.search(/from public\.question_review_invitations i\s+where i\.id = v_session\.invitation_id\s+for share;/);
  const iSet = f4.search(/from public\.question_research_sets rs\s+where rs\.id = v_session\.research_set_id and rs\.project_id = v_session\.project_id\s+for update;/);
  const iClock = f4.indexOf("v_check_at := clock_timestamp();");
  const iCheck = f4.indexOf("or v_session.absolute_expires_at <= v_check_at");
  add("QS-25", "F4 locks the invitation FOR SHARE", iInv > 0);
  add("QS-25", "lock order is session, then invitation, then research set", iSes > 0 && iSes < iInv && iInv < iSet, `${iSes} ${iInv} ${iSet}`);
  add("QS-25", "one clock_timestamp() is taken after all four locks and before every check",
    iClock > iSet && iCheck > iClock && (f4.match(/clock_timestamp\(\)/g) ?? []).length === 1);
  add("QS-25", "F4 never uses now() (transaction start) for any decision or timestamp", !/\bnow\(\)/.test(f4));
  add("QS-25", "absolute, idle and invitation expiry all use the decision instant",
    /v_session\.absolute_expires_at <= v_check_at/.test(f4) && /v_session\.last_seen_at <= v_check_at - interval '15 minutes'/.test(f4)
      && /v_invitation\.expires_at <= v_check_at/.test(f4));
  add("QS-25", "approved_at and last_seen_at are the decision instant",
    /v_version_ids, v_hashes, v_check_at, 'review_invitation'/.test(f4)
      && (f4.match(/set last_seen_at = greatest\(last_seen_at, v_check_at\)/g) ?? []).length === 3);

  // ── Email binding: the request's persisted address, derived and checked in the database ──
  const iReq = f4.search(/from public\.snapshot_requests r\s+where r\.id = v_session\.snapshot_request_id\s+for share;/);
  const bindFn = functionBody(sql, "_q2p_request_email_binding");
  const bindTrig = functionBody(sql, "_q2p_invitation_bind_request_email");
  const guard = functionBody(sql, "_q2p_invitation_guard");
  add("QS-26", "F4 takes no email argument", !/email/i.test(f4.split("returns table")[0] ?? ""));
  add("QS-26", "F4 locks the snapshot request FOR SHARE", iReq > 0);
  add("QS-26", "lock order is session, invitation, snapshot request, research set; the clock follows all four",
    iSes > 0 && iSes < iInv && iInv < iReq && iReq < iSet && iClock > iSet, `${iSes} ${iInv} ${iReq} ${iSet} ${iClock}`);
  add("QS-26", "F4 authorises the address only through the binding, never a caller value",
    /or v_request_email is null\s+or v_invitation\.request_email_binding is null\s+or public\._q2p_request_email_binding\(v_invitation\.id, v_request_email\)\s+is distinct from v_invitation\.request_email_binding then/.test(f4)
      && !/p_current_email|is distinct from v_invitation\.email_hmac/.test(f4));
  add("QS-26", "the binding is a NOT NULL 64-hex invitation column",
    /\n\s*request_email_binding text not null check \(request_email_binding ~ '\^\[0-9a-f\]\{64\}\$'\)/.test(inv));
  add("QS-26", "the binding is not a single-transition column (immutable once inserted)",
    /v_mutable constant text\[\] := array\['exchanged_at', 'email_verified_at', 'revoked_at', 'superseded_by'\];/.test(guard)
      && !/request_email_binding/.test(guard));
  add("QS-26", "the insert trigger refuses a caller value and derives the binding from the locked request",
    /if new\.request_email_binding is not null then\s+raise exception using errcode = '22023', message = 'request_email_binding_is_derived';/.test(bindTrig)
      && /from public\.snapshot_requests r\s+where r\.id = new\.snapshot_request_id\s+for share;/.test(bindTrig)
      && /new\.request_email_binding := public\._q2p_request_email_binding\(new\.id, v_email\);/.test(bindTrig)
      && /create trigger question_review_invitations_bind_request_email\s+before insert on public\.question_review_invitations\s+for each row execute function public\._q2p_invitation_bind_request_email\(\);/.test(sql));
  add("QS-26", "the binding is domain-separated and per invitation",
    /immutable\s+strict/.test(bindFn)
      && /public\._q2p_sha256_hex\('zypact\.q2p\.invitation_request_email\.v1' \|\| chr\(31\)\s+\|\| p_invitation_id::text \|\| chr\(31\) \|\| p_normalized_email\)/.test(bindFn));
  add("QS-26", "no API role may execute the binding or trigger function",
    /revoke all on function public\._q2p_request_email_binding\(uuid, text\) from public, anon, authenticated, service_role;/.test(sql)
      && /revoke all on function public\._q2p_invitation_bind_request_email\(\) from public, anon, authenticated, service_role;/.test(sql)
      && !/grant [^;]*_q2p_(request_email_binding|invitation_bind_request_email)/i.test(sql));

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
  const at = order.indexOf(FILE);
  const kinds = order.map((f) => { const r = parseMigrationName(f); return r.ok ? r.kind : "invalid"; });
  assert("QS-01 it applies after every four-digit migration", at >= 0 && kinds.lastIndexOf("four_digit") < at,
    order.slice(Math.max(0, at - 1), at + 2).join(" -> "));
  assert("QS-01 it is the first timestamped migration (nothing is back-dated before it)",
    at >= 0 && kinds.indexOf("timestamp") === at, order.filter((_, i) => kinds[i] === "timestamp").slice(0, 2).join(","));
  assert("QS-01 its header states it is new-objects-only and forward-recoverable",
    /Every object here is NEW/.test(RAW) && /Recovery: forward-only/.test(RAW));
}

/* ═══════════════ 2. the detectors on the real SQL ═══════════════ */
{
  console.log("\n[2] QS-02..QS-20 on the real migration");
  for (const [id, label, ok, detail] of detectors(SQL)) assert(`${id} ${label}`, ok, detail);
}

/* ═══════════════ 3. QS-19 application code (QS-15 is scripts/test-q2p1-scope.ts) ═══════════════ */
{
  console.log("\n[3] QS-19 — application code");
  const git = (args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
  const appFiles = git(["ls-files", "lib", "app"]).split("\n").filter((p) => /\.(ts|tsx)$/.test(p));
  const leaks = appFiles.filter((p) => readFileSync(path.join(ROOT, p), "utf8").includes("level2_fixture"));
  assert("QS-19 no application file mentions level2_fixture", leaks.length === 0, leaks.join(","));
}

/* ═══════════════ 3b. Q1 compatibility (shared vectors) ═══════════════ */
{
  console.log("\n[3b] Q1 compatibility — scripts/fixtures/q2p1-wording-vectors.json");
  interface Vector {
    id: string; origin: Origin; grade: Candidate["grade"]; sourceKind: SourceKind; excerpt: string;
    links: Array<{ relation: CandidateSourceLink["relation"]; span: string | null }>;
    candidateText: string; approvedText: string; q1: string; db: string;
  }
  const vectors: Vector[] = JSON.parse(readFileSync(path.join(ROOT, "scripts/fixtures/q2p1-wording-vectors.json"), "utf8")).vectors;
  assert("the vector file has at least 9 vectors", vectors.length >= 9, String(vectors.length));
  for (const v of vectors) {
    const src: QuestionSource = v.sourceKind === "customer_material"
      ? { id: "s", kind: v.sourceKind, buyerAuthored: true, customerReference: "ticket-s", customerAttestedAt: "2026-10-01",
          retrievedAt: "2026-09-30", excerpt: v.excerpt, excerptSha256: sha256Utf8Hex(v.excerpt), personalDataRemoved: true }
      : { id: "s", kind: v.sourceKind, buyerAuthored: v.sourceKind !== "site_copy", url: "https://forum.example.org/s",
          retrievedAt: "2026-10-02", excerpt: v.excerpt, excerptSha256: sha256Utf8Hex(v.excerpt), personalDataRemoved: true };
    const reason = "fits the stated need";
    const cand: Candidate = {
      id: "c", text: v.candidateText, grade: v.grade, kind: "unbranded", buyerStage: "solution",
      adaptationNote: v.grade === "adapted" ? "reworded the complaint as a question" : null,
      ratings: { buyerRelevance: { value: 3, reason }, icpFit: { value: 3, reason }, commercialIntent: { value: 2, reason }, productRelevance: { value: 3, reason } },
      curatorRank: 1, primarySourceId: v.links.length > 0 ? "s" : null,
    };
    const set: ResearchSet = {
      siteContext: { brandNames: [{ name: "Acme" }], productNames: [], siteCopy: "" },
      sources: [src], candidates: [cand],
      links: v.links.map((l) => ({ candidateId: "c", sourceId: "s", relation: l.relation, quotedSpan: l.span })),
    };
    const r = classifyApprovedWording({
      origin: v.origin, approvedText: v.approvedText,
      candidateId: v.origin === "customer_written" ? null : "c", researchSet: set,
    });
    const got = r.classification === null ? "refused" : `${r.classification}/${r.rule ?? ""}/${r.verification ?? ""}`;
    assert(`Q1 ${v.id}: ${v.q1}`, got === v.q1, got);
    const [dbClass, , dbVerif] = v.db.split("/");
    const [q1Class, , q1Verif] = v.q1 === "refused" ? ["refused", "", ""] : v.q1.split("/");
    assert(`compat ${v.id}: the database never records observed unless Q1 does, with the same verification`,
      dbClass !== "observed" || (q1Class === "observed" && dbVerif === q1Verif));
    assert(`compat ${v.id}: the database result is Q1's or pending_review (never a different grade)`,
      v.db === v.q1 || dbClass === "pending_review");
  }
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
    ["granting an RPC to authenticated", "grant execute on function public.approve_buyer_question_set(text, uuid, jsonb, text, text, text) to service_role;", "grant execute on function public.approve_buyer_question_set(text, uuid, jsonb, text, text, text) to authenticated;", "executable by service_role only"],
    ["reading auth.uid()", "current_setting('request.jwt.claims', true)", "auth.uid()::text", "does not reference the auth schema"],
    ["dropping FOR SHARE from F6", "and m.removed_at is null\n   for share;", "and m.removed_at is null;", "F6 holds FOR SHARE"],
    ["reading memberships before the version row in F8", "  update public.workspace_membership_versions\n     set version = version + 1, updated_at = now()\n   where workspace_membership_versions.workspace_id = p_workspace_id;\n  if not found then\n    raise exception using errcode = '22023', message = 'q2p_workspace_not_found';\n  end if;\n\n  select m.* into v_target", "  perform 1 from public.workspace_members;\n  update public.workspace_membership_versions\n     set version = version + 1, updated_at = now()\n   where workspace_membership_versions.workspace_id = p_workspace_id;\n  if not found then\n    raise exception using errcode = '22023', message = 'q2p_workspace_not_found';\n  end if;\n\n  select m.* into v_target", "remove_workspace_member writes the version row before"],
    ["dropping the last-owner refusal", "if v_others = 0 then", "if false then", "refuses the last active owner"],
    ["dropping the exchanged-needs-verified-email check", "constraint question_review_invitations_exchange_needs_verified_email check (\n    exchanged_at is null or email_verified_at is not null),", "", "exchanged invitation must carry a verified email"],
    ["letting a session exist for an unexchanged invitation", "and i.exchanged_at is not null and i.email_verified_at is not null) then", "and true) then", "a session can only be created for an exchanged"],
    ["dropping F4's email-verified condition", "     or v_invitation.email_verified_at is null\n", "", "F4 refuses an invitation without a verified email"],
    ["inheriting observed without the span check", "and public._q2p_observed_span_ok(v_cand.id, v_cand.primary_source_id, v_texts[v_i], v_cand.verification) then", "then", "every observed classification in F4 is guarded"],
    ["inheriting adapted without the basis check", "and public._q2p_adapted_basis_ok(v_cand.id, v_cand.primary_source_id, v_cand.verification) then", "then", "every adapted classification in F4 is guarded"],
    ["accepting site copy in the span check", "          and s.source_kind <> 'site_copy'\n          and s.verification = p_verification\n          and s.excerpt_sha256 = public._q2p_sha256_hex(s.excerpt)\n          and strpos", "          and s.verification = p_verification\n          and s.excerpt_sha256 = public._q2p_sha256_hex(s.excerpt)\n          and strpos", "byte-exact verbatim span"],
    ["an order-dependent fingerprint", "                     order by u.prompt_hash)", "                     )", "canonical jsonb, items sorted"],
    ["dropping consent from the fingerprint", "    'consent_text_sha256', p_consent_text_sha256,\n", "", "canonical jsonb, items sorted"],
    ["a globally unique key again", "  idempotency_key        text not null check (btrim(idempotency_key) <> ''),", "  idempotency_key        text not null unique check (btrim(idempotency_key) <> ''),", "scoped to the research set"],
    ["catching unique_violation in F7", "  returning id into v_member_id;\n\n  return query select 'ADDED'::text, v_member_id;", "  returning id into v_member_id;\n  exception when unique_violation then null;\n\n  return query select 'ADDED'::text, v_member_id;", "catches unique_violation"],
    ["dropping F1's advisory lock", "  perform pg_advisory_xact_lock(hashtextextended('zypact.q2p.create_workspace:' || p_idempotency_key, 0));\n", "", "advisory lock before its key lookup"],
    ["dropping the invitation lock", "where i.id = v_session.invitation_id\n   for share;", "where i.id = v_session.invitation_id;", "F4 locks the invitation FOR SHARE"],
    ["locking the research set before the invitation", "  select i.* into v_invitation from public.question_review_invitations i\n   where i.id = v_session.invitation_id\n   for share;\n", "", "lock order is session, then invitation"],
    ["judging expiry by transaction start", "  v_check_at := clock_timestamp();", "  v_check_at := now();", "one clock_timestamp() is taken after all four locks"],
    ["one expiry check reverting to now()", "or v_invitation.expires_at <= v_check_at", "or v_invitation.expires_at <= now()", "never uses now()"],
    ["approved_at defaulting to transaction start", "v_version_ids, v_hashes, v_check_at, 'review_invitation'", "v_version_ids, v_hashes, now(), 'review_invitation'", "approved_at and last_seen_at are the decision instant"],
    ["accepting a caller email argument in F4", "  p_consent_text_sha256 text\n) returns table", "  p_consent_text_sha256 text,\n  p_current_email_hmac text\n) returns table", "F4 takes no email argument"],
    ["reading the request without a lock in F4", "   where r.id = v_session.snapshot_request_id\n   for share;", "   where r.id = v_session.snapshot_request_id;", "F4 locks the snapshot request FOR SHARE"],
    ["locking the request after the research set", "  select r.normalized_email into v_request_email from public.snapshot_requests r\n   where r.id = v_session.snapshot_request_id\n   for share;\n\n  -- Serialise approvals of this research set (locked before the decision, so\n  -- expiry is judged after every wait).\n  select rs.* into v_set from public.question_research_sets rs\n   where rs.id = v_session.research_set_id and rs.project_id = v_session.project_id\n   for update;\n", "  select rs.* into v_set from public.question_research_sets rs\n   where rs.id = v_session.research_set_id and rs.project_id = v_session.project_id\n   for update;\n  select r.normalized_email into v_request_email from public.snapshot_requests r\n   where r.id = v_session.snapshot_request_id\n   for share;\n", "lock order is session, invitation, snapshot request"],
    ["dropping F4's binding comparison", "\n     or public._q2p_request_email_binding(v_invitation.id, v_request_email)\n          is distinct from v_invitation.request_email_binding then", " then", "F4 authorises the address only through the binding"],
    ["comparing a caller HMAC again", "     or v_request_email is null\n", "     or v_request_email is null\n     or p_current_email_hmac is distinct from v_invitation.email_hmac\n", "F4 authorises the address only through the binding"],
    ["a nullable binding", "request_email_binding text not null check", "request_email_binding text check", "NOT NULL 64-hex invitation column"],
    ["making the binding mutable", "array['exchanged_at', 'email_verified_at', 'revoked_at', 'superseded_by'];", "array['exchanged_at', 'email_verified_at', 'revoked_at', 'superseded_by', 'request_email_binding'];", "not a single-transition column"],
    ["accepting a caller-supplied binding", "  if new.request_email_binding is not null then\n    raise exception using errcode = '22023', message = 'request_email_binding_is_derived';\n  end if;\n", "", "insert trigger refuses a caller value"],
    ["deriving the binding from an unlocked request read", "   where r.id = new.snapshot_request_id\n   for share;", "   where r.id = new.snapshot_request_id;", "insert trigger refuses a caller value"],
    ["an undomained, unsalted binding", "'zypact.q2p.invitation_request_email.v1' || chr(31)\n         || p_invitation_id::text || chr(31) || p_normalized_email", "p_normalized_email", "domain-separated and per invitation"],
    ["granting the binding function to service_role", "revoke all on function public._q2p_request_email_binding(uuid, text) from public, anon, authenticated, service_role;", "grant execute on function public._q2p_request_email_binding(uuid, text) to service_role;", "no API role may execute the binding"],
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
