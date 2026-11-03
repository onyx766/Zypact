#!/usr/bin/env tsx
/**
 * Static contract for Q2′-2 — workspace domains and site-diagnostic records
 * (supabase/migrations/<14 digits>_q2p2_domains_and_site_diagnostics.sql).
 *
 * QS2-01..QS2-22 encode the constraints of the accepted Revision 2 scope
 * (D-043), as corrected after the first independent review. Every detector is then proved to refuse a deliberate mutation of
 * the SQL. Text-only: no database, no network. The runtime cases (QR2-*) are
 * in the Level 2 harness. Every check here stays true when later migrations
 * are added; the change-scope check is scripts/test-q2p2-scope.ts.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { migrationLedger, parseMigrationName } from "./lib/migration-names";

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
const q2p2Files = readdirSync(MIGRATIONS).filter((f) => /_q2p2_/.test(f));
const FILE = q2p2Files[0] ?? "";
const Q2P1_FILE = readdirSync(MIGRATIONS).find((f) => /^\d{14}_q2p1_/.test(f)) ?? "";
const RAW = FILE ? readFileSync(path.join(MIGRATIONS, FILE), "utf8") : "";
/** Comments removed; a `--` inside a single-quoted string (e.g. 'xn--') is kept. */
function strip(s: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < s.length; i += 1) {
    if (!inString && s.startsWith("--", i)) {
      while (i < s.length && s[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (!inString && s.startsWith("/*", i)) {
      const end = s.indexOf("*/", i + 2);
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (s[i] === "'") inString = !inString;
    out += s[i];
  }
  return out;
}
const SQL = strip(RAW);

const TABLES = [
  "workspace_domains", "workspace_domain_state", "workspace_domain_challenges",
  "workspace_domain_verification_events", "site_diagnostic_runs", "site_diagnostic_pages",
  "site_diagnostic_findings", "diagnostic_rate_limit_events",
];
const WORKSPACE_TABLES = TABLES.filter((t) => t !== "diagnostic_rate_limit_events");
const PROJECT_TABLES = ["site_diagnostic_runs", "site_diagnostic_pages", "site_diagnostic_findings"];
const UNKNOWN_REASONS = [
  "fetch_failed", "timeout", "size_cap", "parse_error", "blocked_by_robots",
  "robots_unavailable", "not_html", "page_cap_reached", "not_applicable",
];
const FORBIDDEN_WRITES = [
  "protocols", "protocol_execution_jobs", "protocol_attempts", "protocol_external_calls",
  "buyer_question_launch_selections", "snapshot_requests", "spend_controls",
  "workspaces", "workspace_members", "workspace_membership_versions", "workspace_projects",
  "question_research_sets", "question_sources", "question_candidates", "question_candidate_sources",
  "question_review_invitations", "question_review_sessions", "approval_records",
  "buyer_question_version_origins", "approved_wording_classifications", "exception_items", "exception_events",
];
/** The exact transition matrix (Revision 2 §1.1), as written in _q2p2_next_status. */
const TRANSITIONS = [
  "when p_event = 'challenge_issued' and p_status in ('none', 'pending', 'unverified', 'revoked') then 'pending'",
  "when p_event = 'challenge_issued' and p_status = 'verified' then 'verified'",
  "when p_event = 'verification_succeeded' and p_status in ('pending', 'verified') then 'verified'",
  "when p_event = 'verification_failed' and p_status in ('pending', 'verified') then p_status",
  "when p_event = 'challenge_expired' and p_status = 'pending' then 'unverified'",
  "when p_event = 'challenge_expired' and p_status = 'verified' then 'verified'",
  "when p_event = 'verification_lost' and p_status = 'verified' then 'unverified'",
  "when p_event = 'revoked' and p_status in ('pending', 'verified', 'unverified') then 'revoked'",
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
const ws = (s: string) => s.replace(/\s+/g, " ").trim();

/** Every detector, over a given SQL text. Each returns [id, label, ok, detail]. */
function detectors(sql: string): Array<[string, string, boolean, string]> {
  const out: Array<[string, string, boolean, string]> = [];
  const add = (id: string, label: string, ok: boolean, detail = "") => out.push([id, label, ok, detail]);
  const t = tables(sql);
  const flat = ws(sql);
  const revokeAll = sql.match(/revoke all on table([\s\S]*?)from public, anon, authenticated, service_role;/i)?.[1] ?? "";

  // QS2-02 closed tables
  add("QS2-02", "exactly the eight Revision 2 tables are created",
    TABLES.every((n) => t.has(n)) && t.size === TABLES.length, [...t.keys()].join(","));
  add("QS2-02", "every new table enables RLS",
    TABLES.every((n) => new RegExp(`alter table public\\.${n} enable row level security;`, "i").test(sql)));
  add("QS2-02", "every new table is revoked from public, anon, authenticated and service_role",
    TABLES.every((n) => new RegExp(`public\\.${n}\\b`).test(revokeAll)));
  add("QS2-02", "no policy is created and no privilege is granted",
    !/create policy/i.test(sql) && !/\bgrant\s/i.test(sql));

  // QS2-03 tenancy
  add("QS2-03", "every table but the rate-limit table carries workspace_id not null",
    WORKSPACE_TABLES.every((n) => /\n\s*workspace_id\s+uuid not null/.test(t.get(n) ?? "")));
  add("QS2-03", "runs are pinned to (project_id, workspace_id) in workspace_projects",
    /foreign key \(project_id, workspace_id\)\s+references public\.workspace_projects\(project_id, workspace_id\)/.test(t.get("site_diagnostic_runs") ?? ""));
  add("QS2-03", "pages and findings are pinned to their run's (id, workspace_id, project_id)",
    ["site_diagnostic_pages", "site_diagnostic_findings"].every((n) =>
      /foreign key \(run_id, workspace_id, project_id\)\s+references public\.site_diagnostic_runs\(id, workspace_id, project_id\)/.test(t.get(n) ?? "")));
  add("QS2-03", "domain children are pinned to (domain, workspace)",
    ["workspace_domain_state", "workspace_domain_challenges", "workspace_domain_verification_events"].every((n) =>
      /foreign key \(domain_id, workspace_id\)\s+references public\.workspace_domains\(id, workspace_id\)/.test(t.get(n) ?? "")));
  add("QS2-03", "invitation holders cannot act on Q2′-2 tables",
    ["workspace_domains", "workspace_domain_challenges", "workspace_domain_verification_events", "site_diagnostic_runs"]
      .every((n) => /check \(actor_type <> 'invitation_holder'\)/.test(t.get(n) ?? "")));

  // QS2-04 no global domain uniqueness
  const domainUniques = [...sql.matchAll(/unique\s*\(([^)]*normalized_domain[^)]*)\)/gi)].map((m) => m[1]);
  add("QS2-04", "every uniqueness on normalized_domain includes workspace_id (no cross-workspace disclosure)",
    domainUniques.length > 0 && domainUniques.every((cols) => /workspace_id/.test(cols)) && !/unique index[^;]*\(normalized_domain\)/i.test(sql),
    domainUniques.join(" | "));

  // QS2-05 deterministic ordering and serialisation
  const apply = functionBody(sql, "_q2p2_apply_verification_event");
  add("QS2-05", "events have a per-domain unique sequence", /unique \(domain_id, seq\)/.test(t.get("workspace_domain_verification_events") ?? ""));
  add("QS2-05", "the event trigger locks the domain state FOR UPDATE before deciding",
    /from public\.workspace_domain_state s where s\.domain_id = new\.domain_id for update;/.test(apply)
      && apply.indexOf("for update") >= 0 && apply.indexOf("for update") < apply.indexOf("v_next := public._q2p2_next_status"));
  add("QS2-05", "an event must carry seq = state.seq + 1, refused as 40001 otherwise",
    /if new\.seq is distinct from st\.seq \+ 1 then\s+raise exception using errcode = '40001', message = 'q2p2_stale_event_sequence';/.test(apply));
  add("QS2-05", "the event trigger runs BEFORE INSERT on the events table",
    /create trigger workspace_domain_verification_events_apply before insert on public\.workspace_domain_verification_events\s+for each row execute function public\._q2p2_apply_verification_event\(\);/.test(sql));

  // QS2-06 exact transition matrix
  const caseBlock = ws(functionBody(sql, "_q2p2_next_status").match(/select case([\s\S]*?)\n\s*end;/)?.[1] ?? "");
  const whens = caseBlock.split(/(?=when )/).map((s) => s.trim()).filter(Boolean);
  add("QS2-06", "the transition matrix is exactly the accepted eight rows",
    whens.length === TRANSITIONS.length && TRANSITIONS.every((x, i) => whens[i] === x), `${whens.length} rows`);
  add("QS2-06", "any other transition is refused", /if v_next is null then\s+raise exception using errcode = '22023', message = 'q2p2_invalid_transition';/.test(apply));
  add("QS2-06", "the event trigger and the state guard use the shared matrix (no private copy)",
    /v_next := public\._q2p2_next_status\(st\.status, new\.event\);/.test(apply)
      && /v_next := public\._q2p2_next_status\(old\.status, ev\.event\);/.test(functionBody(sql, "_q2p2_state_guard"))
      && !/when new\.event = /.test(apply));

  // QS2-07 stale-observation refusals
  add("QS2-07", "success, failure and expiry require the CURRENT challenge", /if st\.current_challenge_id is distinct from new\.challenge_id then\s+raise exception using errcode = '22023', message = 'q2p2_challenge_not_current';/.test(apply));
  add("QS2-07", "a consumed challenge is refused", /message = 'q2p2_challenge_consumed'/.test(apply));
  add("QS2-07", "an observation outside the challenge window is refused",
    /if new\.checked_at < ch\.issued_at or new\.checked_at > ch\.expires_at then/.test(apply));
  add("QS2-07", "an observation older than 10 minutes, or in the future, is refused (success, failure and loss)",
    (apply.match(/if new\.checked_at > v_now or new\.checked_at < v_now - interval '10 minutes' then/g) ?? []).length === 2);
  add("QS2-07", "expiry is recorded only after the challenge has expired", /if v_now <= ch\.expires_at then\s+raise exception using errcode = '22023', message = 'q2p2_challenge_not_expired';/.test(apply));

  // QS2-08 challenges
  const ch = t.get("workspace_domain_challenges") ?? "";
  add("QS2-08", "only a 64-hex challenge hash is stored, unique", /challenge_sha256\s+text not null unique check \(challenge_sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/.test(ch)
    && !/\n\s*challenge\s+text/.test(ch));
  add("QS2-08", "a challenge expires within 48 hours (Q2-R3)", /expires_at > issued_at and expires_at <= issued_at \+ interval '48 hours'/.test(ch));
  add("QS2-08", "a challenge is consumed once, only inside the event trigger",
    /pg_trigger_depth\(\) < 2 or old\.consumed_at is not null or new\.consumed_at is null/.test(functionBody(sql, "_q2p2_challenge_guard")));
  const chg = functionBody(sql, "_q2p2_challenge_guard");
  add("QS2-08", "a challenge is consumed only for the applied success event that cites it (not by trigger depth alone)",
    /join public\.workspace_domain_state s\s+on s\.domain_id = e\.domain_id and s\.verified_event_id = e\.id and s\.seq = e\.seq\s+where e\.challenge_id = old\.id and e\.domain_id = old\.domain_id and e\.event = 'verification_succeeded';\s+if not found then\s+raise exception using errcode = '55000', message = 'q2p2_challenge_consumption_not_derived_from_event';/.test(chg)
      && /new\.consumed_at := ev\.recorded_at;/.test(chg));
  add("QS2-08", "a challenge is issued at most once",
    /create unique index workspace_domain_verification_events_issued_once\s+on public\.workspace_domain_verification_events \(challenge_id\) where event = 'challenge_issued';/.test(sql));

  // QS2-09 state written only by triggers
  const sg = functionBody(sql, "_q2p2_state_guard");
  add("QS2-09", "the state is written only from inside its triggers, advancing seq by one",
    /if pg_trigger_depth\(\) < 2 then/.test(sg) && /new\.seq is distinct from old\.seq \+ 1/.test(sg)
      && /create trigger workspace_domain_state_guard before insert or update or delete on public\.workspace_domain_state/.test(sql));
  add("QS2-09", "a state update may change only seq (status, challenge, verified event and re-check are refused)",
    ["status", "current_challenge_id", "verified_event_id", "recheck_due_at"].every((c) => sg.includes(`or new.${c} is distinct from old.${c}`)));
  add("QS2-09", "the new seq must name an event of this domain and workspace (derived from an existing event, not trigger depth alone)",
    /select e\.\* into ev from public\.workspace_domain_verification_events e\s+where e\.domain_id = new\.domain_id and e\.seq = new\.seq;\s+if not found or ev\.workspace_id is distinct from new\.workspace_id then\s+raise exception using errcode = '55000', message = 'q2p2_state_not_derived_from_event';/.test(sg));
  add("QS2-09", "the state guard derives every column from the event and the shared matrix",
    /new\.status := v_next;/.test(sg) && /new\.current_challenge_id := case\s+when ev\.event = 'challenge_issued' then ev\.challenge_id\s+when ev\.event = 'verification_failed' then old\.current_challenge_id end;/.test(sg)
      && /new\.verified_event_id := case\s+when ev\.event = 'verification_succeeded' then ev\.id\s+when v_next = 'verified' then old\.verified_event_id end;/.test(sg)
      && /new\.updated_at := ev\.recorded_at;/.test(sg));
  add("QS2-09", "the initial state row requires its domain",
    /or not exists \(select 1 from public\.workspace_domains d\s+where d\.id = new\.domain_id and d\.workspace_id = new\.workspace_id\)/.test(sg));
  add("QS2-09", "the event trigger advances the state AFTER INSERT, writing only seq",
    /create trigger workspace_domain_verification_events_advance after insert on public\.workspace_domain_verification_events\s+for each row execute function public\._q2p2_advance_domain_state\(\);/.test(sql)
      && /update public\.workspace_domain_state set seq = new\.seq where domain_id = new\.domain_id;/.test(functionBody(sql, "_q2p2_advance_domain_state"))
      && !/update public\.workspace_domain_state/.test(apply));

  // QS2-10 verified only while current
  const st = t.get("workspace_domain_state") ?? "";
  add("QS2-10", "a successful verification is due for re-check after 30 days (Q2-R1)",
    /when ev\.event = 'verification_succeeded' then ev\.checked_at \+ interval '30 days'/.test(sg));
  add("QS2-10", "recheck_due_at and verified_event_id exist iff verified",
    /check \(\(status = 'verified'\) = \(recheck_due_at is not null\)\)/.test(st) && /check \(\(status = 'verified'\) = \(verified_event_id is not null\)\)/.test(st));
  const helper = functionBody(sql, "_q2p2_domain_verified");
  add("QS2-10", "the decision helper reads the current state FOR SHARE and fails closed past due",
    /from public\.workspace_domain_state s where s\.domain_id = p_domain_id for share;/.test(helper)
      && /v_status = 'verified' and v_due is not null and clock_timestamp\(\) < v_due/.test(helper));

  // QS2-11 runs cite only the CURRENT verification
  const rg = functionBody(sql, "_q2p2_run_guard");
  add("QS2-11", "a run may cite verification only when it is the current verified event, verified now",
    /from public\.workspace_domain_state s where s\.domain_id = new\.domain_id for share;/.test(rg)
      && /st\.verified_event_id is distinct from new\.domain_verification_event_id/.test(rg)
      && /not \(clock_timestamp\(\) < st\.recheck_due_at\)/.test(rg));
  add("QS2-11", "the result cache is workspace-isolated (Q2-D1)",
    /check \(cache_scope_workspace_id = workspace_id\)/.test(t.get("site_diagnostic_runs") ?? ""));

  // QS2-12 URL sanitisation
  const urlFn = functionBody(sql, "_q2p2_url_is_sanitised");
  add("QS2-12", "stored URLs carry no query, fragment, userinfo or '@' (Q2-D3)",
    /p_url ~ '\^https\?:\/\/\[a-z0-9\.-\]\+\(:\[0-9\]\{1,5\}\)\?\(\/\[\^\?#@\[:space:\]\]\*\)\?\$'/.test(urlFn) && /length\(p_url\) <= 2048/.test(urlFn));
  add("QS2-12", "start_url and every page url are checked; query_present is recorded",
    /start_url\s+text not null check \(public\._q2p2_url_is_sanitised\(start_url\)\)/.test(t.get("site_diagnostic_runs") ?? "")
      && /url\s+text not null check \(public\._q2p2_url_is_sanitised\(url\)\)/.test(t.get("site_diagnostic_pages") ?? "")
      && /query_present\s+boolean not null/.test(t.get("site_diagnostic_pages") ?? ""));

  // QS2-13 no bodies, headers, cookies or IP data
  const cols = [...t.values()].flatMap((b) => [...b.matchAll(/\n\s*(\w+)\s+(?:text|uuid|jsonb|boolean|integer|bigint|smallint|timestamptz|inet)/g)].map((m) => m[1]));
  const forbiddenCols = cols.filter((c) => /(^|_)(body|html|headers?|cookies?|ip|ip_hash|request_ip|remote_addr)($|_)/.test(c) && c !== "body_sha256" && c !== "excerpt_body_sha256");
  add("QS2-13", "no body, header, cookie or IP column in any Q2′-2 table", forbiddenCols.length === 0, forbiddenCols.join(","));
  add("QS2-13", "the rate-limit table has no link to runs, workspaces or projects",
    !/references/i.test(t.get("diagnostic_rate_limit_events") ?? "x") && !/(workspace_id|project_id|run_id)/.test(t.get("diagnostic_rate_limit_events") ?? ""));

  // QS2-14 page cap
  add("QS2-14", "runs cap pages at 10 and pages are indexed 0..9",
    /page_cap\s+smallint not null check \(page_cap between 1 and 10\)/.test(t.get("site_diagnostic_runs") ?? "")
      && /page_index\s+smallint not null check \(page_index between 0 and 9\)/.test(t.get("site_diagnostic_pages") ?? ""));
  add("QS2-14", "a page beyond the run's own cap is refused", /if new\.page_index >= v_cap then/.test(functionBody(sql, "_q2p2_run_child_guard")));

  // QS2-15 unknown reasons
  const fd = t.get("site_diagnostic_findings") ?? "";
  const listed = [...(fd.match(/unknown_reason\s+text check \(unknown_reason in \(([\s\S]*?)\)\)/)?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  add("QS2-15", "unknown_reason is exactly the D-040 §6.3 list", listed.length === UNKNOWN_REASONS.length && UNKNOWN_REASONS.every((r) => listed.includes(r)), listed.join(","));
  add("QS2-15", "unknown_reason is present iff the state is unknown", /check \(\(state = 'unknown'\) = \(unknown_reason is not null\)\)/.test(fd));

  // QS2-16 excerpts
  add("QS2-16", "excerpts are at most 300 characters", /excerpt\s+text check \(excerpt is null or length\(excerpt\) between 1 and 300\)/.test(fd));
  add("QS2-16", "an excerpt needs offsets, its page hash and a personal-data screen version",
    /\(excerpt is null\) = \(excerpt_start is null\) and \(excerpt is null\) = \(excerpt_end is null\)\s+and \(excerpt is null\) = \(excerpt_body_sha256 is null\) and \(excerpt is null\) = \(pii_screen_version is null\)/.test(fd)
      && /check \(excerpt is null or page_id is not null\)/.test(fd));
  add("QS2-16", "the excerpt hash must equal its page's body hash", /if v_hash is distinct from new\.excerpt_body_sha256 then/.test(functionBody(sql, "_q2p2_run_child_guard")));

  // QS2-17 frozen runs
  const cg = functionBody(sql, "_q2p2_run_child_guard");
  add("QS2-17", "pages and findings are inserted only into an open run read FOR SHARE",
    /from public\.site_diagnostic_runs r where r\.id = new\.run_id for share;/.test(cg) && /message = 'q2p2_run_frozen'/.test(cg));
  add("QS2-17", "a run completes once and is otherwise immutable",
    /if old\.completed_at is not null or new\.outcome is null/.test(rg) && /\(to_jsonb\(new\) - 'completed_at' - 'outcome'\) is distinct from \(to_jsonb\(old\) - 'completed_at' - 'outcome'\)/.test(rg));

  // QS2-18 rate-limit records
  const rl = t.get("diagnostic_rate_limit_events") ?? "";
  add("QS2-18", "rate-limit rows expire within 48 hours (Q2-R4)", /expires_at > occurred_at and expires_at <= occurred_at \+ interval '48 hours'/.test(rl));
  add("QS2-18", "rate-limit keys are 64-hex digests under the purpose label (Q2-R2)",
    /bucket_key\s+text not null check \(bucket_key ~ '\^\[0-9a-f\]\{64\}\$'\)/.test(rl) && /key_purpose\s+text not null check \(key_purpose = 'zypact\.diag\.rate_limit\.v1'\)/.test(rl));
  const rg2 = functionBody(sql, "_q2p2_rate_limit_guard");
  add("QS2-18", "rate-limit rows cannot be updated, and can be deleted only after expiry",
    /q2p2_rate_limit_events_immutable/.test(rg2) && /if old\.expires_at > clock_timestamp\(\) then/.test(rg2));
  add("QS2-18", "the cleanup deletes only expired rows",
    /delete from public\.diagnostic_rate_limit_events where expires_at <= clock_timestamp\(\);/.test(functionBody(sql, "_q2p2_purge_rate_limit_events")));

  // QS2-19 functions
  const fns = definedFunctions(sql);
  add("QS2-19", "every Q2′-2 function is revoked from public, anon, authenticated and service_role",
    fns.length > 0 && fns.every((f) => new RegExp(`revoke all on function public\\.${f}\\([^)]*\\) from public, anon, authenticated, service_role;`).test(sql)),
    fns.filter((f) => !new RegExp(`revoke all on function public\\.${f}\\(`).test(sql)).join(","));
  add("QS2-19", "every Q2′-2 function fixes its search_path",
    fns.every((f) => /set search_path = (pg_catalog|public), pg_temp/.test(functionBody(sql, f))));
  add("QS2-19", "only the purge function is SECURITY DEFINER",
    (sql.match(/security definer/gi) ?? []).length === 1 && /security definer/i.test(functionBody(sql, "_q2p2_purge_rate_limit_events")));

  // QS2-20 no side effects on existing objects
  const writes = FORBIDDEN_WRITES.filter((p) => new RegExp(`(insert into|update|delete from)\\s+public\\.${p}\\b`, "i").test(sql));
  add("QS2-20", "no write to any paid-path, request or Q2′-1 table", writes.length === 0, writes.join(","));
  add("QS2-20", "alters only Q2′-2 tables", !/alter table public\.(?!workspace_domain|site_diagnostic_|diagnostic_rate_limit_)/i.test(sql));
  add("QS2-20", "creates only Q2′-2 functions (prefix _q2p2_)", fns.every((f) => f.startsWith("_q2p2_")), fns.join(","));
  add("QS2-20", "no PG-9, 0082 or execution object is mentioned",
    !/spend_controls|protocol_external_calls|_spend_|approve_and_launch|enqueue_protocol/i.test(sql));
  add("QS2-20", "flat SQL contains no transaction control (the named-file procedure governs)", !/\b(begin;|commit;|rollback;)/i.test(flat));

  // QS2-21 a finding's detail has an explicit safe schema (Q2-D3)
  const dt = functionBody(sql, "_q2p2_finding_detail_is_safe");
  add("QS2-21", "a finding's detail must pass the safe schema and the size cap",
    /detail\s+jsonb check \(public\._q2p2_finding_detail_is_safe\(detail\)\s+and \(detail is null or pg_column_size\(detail\) <= 4096\)\)/.test(t.get("site_diagnostic_findings") ?? ""));
  add("QS2-21", "detail keys and string values are identifier tokens only (no free text, whitespace or punctuation)",
    /if k !~ '\^\[a-z\]\[a-z0-9_\]\{0,31\}\$' then\s+return false;/.test(dt)
      && /if \(e #>> '\{\}'\) !~ '\^\[a-z\]\[a-z0-9_\]\{0,31\}\$' then\s+return false;/.test(dt));
  add("QS2-21", "detail is a flat object of 1 to 16 keys, arrays of at most 16: no nested object, nested array or null",
    /if jsonb_typeof\(p_detail\) <> 'object' or \(select count\(\*\) from jsonb_object_keys\(p_detail\)\) not between 1 and 16 then\s+return false;/.test(dt)
      && /if jsonb_typeof\(v\) = 'array' and jsonb_array_length\(v\) > 16 then\s+return false;/.test(dt)
      && /when 'boolean' then\s+null;/.test(dt) && /else\s+return false;\s+end case;/.test(dt)
      && (dt.match(/\bwhen '(\w+)' then/g) ?? []).length === 3);
  add("QS2-21", "detail numbers are bounded numbers (below 1e9, at most 4 decimals)",
    /if abs\(\(e #>> '\{\}'\)::numeric\) >= 1000000000 or scale\(\(e #>> '\{\}'\)::numeric\) > 4 then\s+return false;/.test(dt));

  // QS2-22 the stored domain form, exactly as stated
  const dn = functionBody(sql, "_q2p2_domain_is_normalised");
  add("QS2-22", "labels are lowercase LDH of 1 to 63 characters, 4 to 253 in all",
    /length\(p_domain\) between 4 and 253/.test(dn) && dn.includes("p_domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+"));
  add("QS2-22", "an IDNA A-label TLD is accepted (alphabetic or xn-- form)",
    dn.includes("([a-z]{2,63}|xn--[a-z0-9]([a-z0-9-]{0,57}[a-z0-9])?)$'"));
  add("QS2-22", "a reserved '--' label other than the xn-- prefix is refused",
    dn.includes("and p_domain !~ '(^|\\.)(?!xn--)[a-z0-9]{2}--'"));
  return out;
}

/* ═══════════════ 1. the file ═══════════════ */
{
  console.log("\n[1] QS2-01 — the migration file");
  assert("QS2-01 exactly one Q2′-2 migration file", q2p2Files.length === 1, q2p2Files.join(","));
  const parsed = parseMigrationName(FILE);
  assert("QS2-01 it is a valid 14-digit timestamped name", parsed.ok && parsed.kind === "timestamp", FILE);
  const q1 = parseMigrationName(Q2P1_FILE);
  assert("QS2-01 its version is above Q2′-1's", parsed.ok && q1.ok && parsed.version > q1.version, `${FILE} vs ${Q2P1_FILE}`);
  const order = migrationLedger(MIGRATIONS).map((m) => m.f);
  assert("QS2-01 it applies after Q2′-1 and after every four-digit migration",
    order.indexOf(FILE) > order.indexOf(Q2P1_FILE) && order.indexOf(Q2P1_FILE) >= 0
      && order.findIndex((f) => parseMigrationName(f).ok && (parseMigrationName(f) as { kind: string }).kind === "four_digit" && order.indexOf(f) > order.indexOf(FILE)) === -1);
  assert("QS2-01 its header states it is new-objects-only and forward-recoverable",
    /Every object here is NEW/.test(RAW) && /Recovery: forward-only/.test(RAW));
}

/* ═══════════════ 2. the detectors on the real file ═══════════════ */
{
  console.log("\n[2] QS2-02..QS2-20 — constraints");
  for (const [id, label, ok, detail] of detectors(SQL)) assert(`${id} ${label}`, ok, detail);
  const ledger = migrationLedger(MIGRATIONS);
  const at = ledger.findIndex((m) => m.f === FILE);
  const earlier = new Set(ledger.slice(0, at < 0 ? ledger.length : at).flatMap((m) => definedFunctions(strip(m.sql))));
  const redefined = definedFunctions(SQL).filter((f) => earlier.has(f));
  assert("QS2-20 redefines no function that exists before Q2′-2", redefined.length === 0, redefined.join(","));
}

/* ═══════════════ 3. every detector is proved to bite ═══════════════ */
{
  console.log("\n[3] Negative self-tests");
  const mutations: Array<[string, string, string, string]> = [
    ["dropping RLS on one table", "alter table public.site_diagnostic_pages enable row level security;", "", "every new table enables RLS"],
    ["granting a table to authenticated", "-- No API role may execute any Q2′-2 function.", "grant select on public.site_diagnostic_runs to authenticated;", "no policy is created and no privilege is granted"],
    ["adding a policy", "alter table public.workspace_domains enable row level security;", "alter table public.workspace_domains enable row level security;\ncreate policy p on public.workspace_domains using (true);", "no policy is created"],
    ["removing a table from the revoke", "  public.site_diagnostic_pages, public.site_diagnostic_findings, public.diagnostic_rate_limit_events\n  from public", "  public.site_diagnostic_findings, public.diagnostic_rate_limit_events\n  from public", "every new table is revoked"],
    ["dropping the run project pin", "  constraint site_diagnostic_runs_project_fk foreign key (project_id, workspace_id)\n    references public.workspace_projects(project_id, workspace_id),\n", "", "runs are pinned"],
    ["letting an invitation holder act on runs", "  constraint site_diagnostic_runs_no_invitation_actor check (actor_type <> 'invitation_holder'),\n", "", "invitation holders cannot act"],
    ["a global unique domain", "  constraint workspace_domains_workspace_domain_key unique (workspace_id, normalized_domain),", "  constraint workspace_domains_workspace_domain_key unique (normalized_domain),", "every uniqueness on normalized_domain includes workspace_id"],
    ["removing the per-domain sequence uniqueness", "  constraint workspace_domain_verification_events_seq_key unique (domain_id, seq),\n", "", "per-domain unique sequence"],
    ["reading the state without FOR UPDATE", "from public.workspace_domain_state s where s.domain_id = new.domain_id for update;", "from public.workspace_domain_state s where s.domain_id = new.domain_id;", "locks the domain state FOR UPDATE"],
    ["accepting any sequence number", "  if new.seq is distinct from st.seq + 1 then\n    raise exception using errcode = '40001', message = 'q2p2_stale_event_sequence';\n  end if;\n", "", "seq = state.seq + 1"],
    ["allowing verified to be revoked into pending", "    when p_event = 'revoked' and p_status in ('pending', 'verified', 'unverified') then 'revoked'", "    when p_event = 'revoked' and p_status in ('pending', 'verified', 'unverified') then 'pending'", "exactly the accepted eight rows"],
    ["allowing success from unverified", "    when p_event = 'verification_succeeded' and p_status in ('pending', 'verified') then 'verified'", "    when p_event = 'verification_succeeded' and p_status in ('pending', 'verified', 'unverified') then 'verified'", "exactly the accepted eight rows"],
    ["a private transition matrix in the event trigger", "  v_next := public._q2p2_next_status(st.status, new.event);", "  v_next := case when new.event = 'revoked' then 'revoked' end;", "shared matrix"],
    ["accepting a superseded challenge", "    if st.current_challenge_id is distinct from new.challenge_id then\n      raise exception using errcode = '22023', message = 'q2p2_challenge_not_current';\n    end if;\n", "", "require the CURRENT challenge"],
    ["accepting a stale observation", "      if new.checked_at > v_now or new.checked_at < v_now - interval '10 minutes' then\n        raise exception using errcode = '22023', message = 'q2p2_stale_observation';\n      end if;\n    end if;", "    end if;", "older than 10 minutes"],
    ["storing the raw challenge", "  challenge_sha256     text not null unique", "  challenge            text,\n  challenge_sha256     text not null unique", "only a 64-hex challenge hash"],
    ["a 7-day challenge", "expires_at <= issued_at + interval '48 hours'", "expires_at <= issued_at + interval '7 days'", "expires within 48 hours"],
    ["re-issuing a challenge", "create unique index workspace_domain_verification_events_issued_once", "create index workspace_domain_verification_events_issued_once", "issued at most once"],
    ["letting the state be written directly", "  if pg_trigger_depth() < 2 then\n    raise exception using errcode = '55000', message = 'q2p2_state_written_only_by_its_triggers';", "  if false then\n    raise exception using errcode = '55000', message = 'q2p2_state_written_only_by_its_triggers';", "written only from inside its triggers"],
    ["a 90-day re-check", "ev.checked_at + interval '30 days'", "ev.checked_at + interval '90 days'", "re-check after 30 days"],
    ["a state guard that trusts trigger depth alone", "  select e.* into ev from public.workspace_domain_verification_events e\n   where e.domain_id = new.domain_id and e.seq = new.seq;\n  if not found or ev.workspace_id is distinct from new.workspace_id then\n    raise exception using errcode = '55000', message = 'q2p2_state_not_derived_from_event';\n  end if;\n", "", "derived from an existing event"],
    ["a state update that may set the status", "     or new.status is distinct from old.status\n", "", "only seq"],
    ["a state guard that keeps the writer's status", "  new.status := v_next;\n", "", "derives every column"],
    ["an initial state row without its domain", "\n       or not exists (select 1 from public.workspace_domains d\n                       where d.id = new.domain_id and d.workspace_id = new.workspace_id)", "", "requires its domain"],
    ["advancing the state before the event row exists", "create trigger workspace_domain_verification_events_advance after insert", "create trigger workspace_domain_verification_events_advance before insert", "advances the state AFTER INSERT"],
    ["consuming a challenge without its applied event", "  if not found then\n    raise exception using errcode = '55000', message = 'q2p2_challenge_consumption_not_derived_from_event';\n  end if;\n", "", "applied success event"],
    ["detail without the safe-schema check", "  detail               jsonb check (public._q2p2_finding_detail_is_safe(detail)\n                                    and (detail is null or pg_column_size(detail) <= 4096)),", "  detail               jsonb check (detail is null or pg_column_size(detail) <= 4096),", "safe schema"],
    ["free text in a finding's detail", "          if (e #>> '{}') !~ '^[a-z][a-z0-9_]{0,31}$' then", "          if (e #>> '{}') !~ '^[a-zA-Z0-9_ .@:/-]{0,300}$' then", "identifier tokens"],
    ["nested objects in a finding's detail", "        else\n          return false;\n      end case;", "        else\n          null;\n      end case;", "no nested"],
    ["unbounded numbers in a finding's detail", "abs((e #>> '{}')::numeric) >= 1000000000", "abs((e #>> '{}')::numeric) >= 1e18", "bounded numbers"],
    ["an alphabetic-only TLD", "([a-z]{2,63}|xn--[a-z0-9]([a-z0-9-]{0,57}[a-z0-9])?)$'", "[a-z]{2,63}$'", "A-label TLD"],
    ["reserved '--' labels allowed", "\n     and p_domain !~ '(^|\\.)(?!xn--)[a-z0-9]{2}--';", ";", "reserved '--' label"],
    ["a helper that ignores re-check due", "v_status = 'verified' and v_due is not null and clock_timestamp() < v_due", "v_status = 'verified'", "fails closed past due"],
    ["a run citing a historical verification", "st.verified_event_id is distinct from new.domain_verification_event_id", "false", "current verified event"],
    ["a shared cache scope", "  constraint site_diagnostic_runs_cache_is_workspace check (cache_scope_workspace_id = workspace_id),\n", "", "workspace-isolated"],
    ["allowing query strings in stored URLs", "(/[^?#@[:space:]]*)?$'", "(/[^#@[:space:]]*)?$'", "no query, fragment, userinfo"],
    ["adding a page body column", "  robots_allowed  boolean not null,", "  robots_allowed  boolean not null,\n  body            text,", "no body, header, cookie or IP"],
    ["adding a requester IP hash to runs", "  cache_scope_workspace_id      uuid not null,", "  cache_scope_workspace_id      uuid not null,\n  request_ip_hash               text,", "no body, header, cookie or IP"],
    ["linking rate-limit rows to runs", "  key_id       text not null check (btrim(key_id) <> '' and length(key_id) <= 64),", "  key_id       text not null check (btrim(key_id) <> '' and length(key_id) <= 64),\n  run_id       uuid references public.site_diagnostic_runs(id),", "no link to runs"],
    ["a 20-page cap", "page_cap between 1 and 10", "page_cap between 1 and 20", "cap pages at 10"],
    ["ignoring the run's own page cap", "    if new.page_index >= v_cap then", "    if false then", "beyond the run's own cap"],
    ["an extra unknown reason", "'robots_unavailable', 'not_html', 'page_cap_reached', 'not_applicable')),", "'robots_unavailable', 'not_html', 'page_cap_reached', 'not_applicable', 'other')),", "exactly the D-040 §6.3 list"],
    ["dropping the unknown-reason iff", "  constraint site_diagnostic_findings_unknown_reason_iff check ((state = 'unknown') = (unknown_reason is not null)),\n", "", "present iff the state is unknown"],
    ["a 1000-character excerpt", "length(excerpt) between 1 and 300", "length(excerpt) between 1 and 1000", "at most 300 characters"],
    ["an excerpt without a personal-data screen", " and (excerpt is null) = (pii_screen_version is null)", "", "personal-data screen version"],
    ["skipping the excerpt hash match", "    if v_hash is distinct from new.excerpt_body_sha256 then", "    if false then", "must equal its page's body hash"],
    ["writing into a completed run", "  if v_completed is not null then\n    raise exception using errcode = '55000', message = 'q2p2_run_frozen';\n  end if;\n", "", "only into an open run"],
    ["a 7-day rate-limit retention", "expires_at <= occurred_at + interval '48 hours'", "expires_at <= occurred_at + interval '7 days'", "expire within 48 hours"],
    ["dropping the purpose label", "  key_purpose  text not null check (key_purpose = 'zypact.diag.rate_limit.v1'),", "  key_purpose  text not null,", "purpose label"],
    ["deleting unexpired rate-limit rows", "  if old.expires_at > clock_timestamp() then", "  if false then", "deleted only after expiry"],
    ["a purge that deletes everything", "delete from public.diagnostic_rate_limit_events where expires_at <= clock_timestamp();", "delete from public.diagnostic_rate_limit_events;", "deletes only expired rows"],
    ["leaving a function executable", "revoke all on function public._q2p2_domain_verified(uuid) from public, anon, authenticated, service_role;\n", "", "every Q2′-2 function is revoked"],
    ["a second SECURITY DEFINER function", "create or replace function public._q2p2_domain_verified(p_domain_id uuid)\nreturns boolean\nlanguage plpgsql\nvolatile", "create or replace function public._q2p2_domain_verified(p_domain_id uuid)\nreturns boolean\nlanguage plpgsql\nvolatile\nsecurity definer", "only the purge function is SECURITY DEFINER"],
    ["writing to snapshot_requests", "  return new;\nend;\n$$;\ncreate trigger workspace_domains_create_state", "  update public.snapshot_requests set status = status where false;\n  return new;\nend;\n$$;\ncreate trigger workspace_domains_create_state", "no write to any paid-path, request or Q2′-1 table"],
    ["altering an existing table", "alter table public.workspace_domains enable row level security;", "alter table public.workspace_domains enable row level security;\nalter table public.projects add column x int;", "alters only Q2′-2 tables"],
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
console.log(failures === 0 ? "\nQ2′-2 schema contract PASSED." : `\n${failures} check(s) failed. Q2′-2 schema contract FAILED.`);
process.exit(failures === 0 ? 0 : 1);
