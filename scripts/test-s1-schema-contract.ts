#!/usr/bin/env tsx
/**
 * S1 static schema contract: account sessions and account rate limits
 * (20261109120000_s1_account_sessions.sql, D-045).
 *
 * Static checks over the SQL text. The behaviour (expiry, revocation,
 * isolation, concurrency) is proven in the Level 2 harness against a real
 * PostgreSQL. Every detector is also run against a mutated copy of the
 * migration that must make it fail, so a detector that cannot fail is caught.
 *
 * No database, no network.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { orderedMigrations, parseMigrationName } from "./lib/migration-names";

let failures = 0;
let total = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  total += 1;
  if (ok) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
globalThis.fetch = (() => {
  throw new Error("network access attempted in a static contract");
}) as unknown as typeof fetch;

const DIR = "supabase/migrations";
const FILE = "20261109120000_s1_account_sessions.sql";
const Q2P1 = "20261102132000_q2p1_account_workspace_foundation.sql";
const Q2P2 = "20261103173000_q2p2_domains_and_site_diagnostics.sql";
const SQL = readFileSync(path.join(DIR, FILE), "utf8");

const TABLES = ["account_sessions", "account_rate_limit_events"];
const PUBLIC_FUNCTIONS: Record<string, string> = {
  open_account_session: "uuid, text, integer, integer",
  check_account_session: "text, uuid",
  record_account_step_up: "text, uuid",
  revoke_account_session: "text, text",
  revoke_account_sessions_for_account: "uuid, text",
  take_account_rate_limit: "text, text, text, text, integer, integer",
};
const HELPERS: Record<string, string> = {
  _s1_account_sessions_guard: "",
  _s1_no_truncate: "",
  _s1_rate_limit_events_guard: "",
  _s1_session_token_hash: "text",
  _s1_purge_account_rate_limit_events: "",
};

const stripComments = (s: string) => s.replace(/--[^\n]*/g, "");
const ws = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function definedFunctions(sql: string): string[] {
  return [...sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(\w+)\s*\(/gi)].map((m) => m[1].toLowerCase());
}

/** The body of one `create ... function name(` up to its closing `$$;`. */
function functionBlock(sql: string, name: string): string {
  const start = sql.search(new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${name}\\s*\\(`, "i"));
  if (start < 0) return "";
  const end = sql.indexOf("$$;", sql.indexOf("$$", sql.indexOf("as $$", start) + 5));
  return end < 0 ? "" : sql.slice(start, end + 3);
}

function detectors(raw: string): Array<[string, string, boolean, string]> {
  const out: Array<[string, string, boolean, string]> = [];
  const add = (id: string, label: string, ok: boolean, detail = "") => out.push([id, label, ok, detail]);
  const sql = stripComments(raw);
  const flat = ws(sql);

  const created = [...sql.matchAll(/create\s+table\s+public\.(\w+)/gi)].map((m) => m[1]);
  add("S1C-01", "creates exactly the two S1 tables", created.sort().join(",") === [...TABLES].sort().join(","), created.join(","));
  add("S1C-02", "RLS is enabled on both tables", TABLES.every((t) => flat.includes(`alter table public.${t} enable row level security;`)));
  add("S1C-03", "no policy is created", !/create\s+policy/i.test(sql));
  add(
    "S1C-04",
    "both tables are revoked from public, anon, authenticated and service_role",
    flat.includes("revoke all on table public.account_sessions, public.account_rate_limit_events from public, anon, authenticated, service_role;")
  );
  add("S1C-05", "no table privilege is granted to any role", !/grant\s+[a-z, ]+\s+on\s+table/i.test(sql));
  // Supabase's default privileges grant every new sequence to the API roles,
  // and an identity column owns one; Q2′-2 closes its own the same way.
  add("S1C-05b", "the identity sequence is revoked from public, anon, authenticated and service_role",
    flat.includes("revoke all on sequence public.account_rate_limit_events_id_seq from public, anon, authenticated, service_role;") &&
      !/grant[^;]*on\s+sequence/i.test(sql));

  const defined = definedFunctions(sql);
  const expected = [...Object.keys(PUBLIC_FUNCTIONS), ...Object.keys(HELPERS)].sort();
  add("S1C-06", "defines exactly the expected functions", [...defined].sort().join(",") === expected.join(","), defined.join(","));

  for (const name of [...Object.keys(PUBLIC_FUNCTIONS), "_s1_purge_account_rate_limit_events"]) {
    const block = ws(functionBlock(sql, name));
    add(`S1C-07 ${name}`, `${name} is SECURITY DEFINER with a fixed search_path and a 5s lock_timeout`,
      block.includes("security definer") && block.includes("set search_path = public, pg_temp") && block.includes("set lock_timeout = '5s'"));
  }
  for (const name of ["_s1_account_sessions_guard", "_s1_no_truncate", "_s1_rate_limit_events_guard"]) {
    const block = ws(functionBlock(sql, name));
    add(`S1C-08 ${name}`, `${name} is not SECURITY DEFINER and pins search_path`,
      !block.includes("security definer") && block.includes("set search_path = pg_catalog, pg_temp"));
  }

  for (const [name, args] of Object.entries(PUBLIC_FUNCTIONS)) {
    add(`S1C-09 ${name}`, `${name}: revoked from public, anon, authenticated; executable by service_role`,
      flat.includes(`revoke all on function public.${name}(${args}) from public, anon, authenticated;`) &&
        flat.includes(`grant execute on function public.${name}(${args}) to service_role;`));
  }
  for (const [name, args] of Object.entries(HELPERS)) {
    add(`S1C-10 ${name}`, `${name}: no role may execute it`,
      flat.includes(`revoke all on function public.${name}(${args}) from public, anon, authenticated, service_role;`) &&
        !flat.includes(`grant execute on function public.${name}(`));
  }
  add("S1C-11", "nothing is granted to anon or authenticated", !/grant[^;]*\bto\s+(anon|authenticated)\b/i.test(sql));

  add("S1C-12", "session tokens are hashed under their own purpose label",
    flat.includes("public._q2p_token_hash('zypact.account_session.v1', p_token)"));
  add("S1C-13", "no invitation-session table or token purpose is read",
    !/question_review_(sessions|invitations)|zypact\.question_review_(session|invitation)/i.test(sql));
  add("S1C-14", "sessions are bound to the membership by a composite foreign key",
    flat.includes("foreign key (membership_id, account_id, workspace_id) references public.workspace_members (id, account_id, workspace_id)"));
  add("S1C-15", "a check re-reads the membership and revokes on removal",
    ws(functionBlock(sql, "check_account_session")).includes("revoked_reason = 'membership_removed'"));
  add("S1C-16", "absolute and idle expiry are both decided",
    /v_now >= v_s\.absolute_expires_at/.test(sql) && /last_seen_at \+ make_interval\(secs => v_s\.idle_timeout_seconds\)/.test(sql));
  add("S1C-17", "an open session needs exactly one active membership",
    /'NO_MEMBERSHIP'/.test(sql) && /'AMBIGUOUS_MEMBERSHIP'/.test(sql));
  add("S1C-18", "the session lifetime is capped at 7 days", flat.includes("absolute_expires_at <= created_at + interval '7 days'"));
  add("S1C-19", "rate-limit rows expire within 48 hours", flat.includes("expires_at <= occurred_at + interval '48 hours'"));
  add("S1C-20", "the rate limit is serialised per bucket by an advisory lock", /pg_advisory_xact_lock\(hashtextextended\(\s*'zypact\.s1\.rate_limit:/.test(sql));
  add("S1C-21", "a rate-limit row may be deleted only once expired", /old\.expires_at > clock_timestamp\(\)/.test(sql));
  add("S1C-22", "no error is swallowed (R4)", !/exception\s+when/i.test(sql));
  add("S1C-23", "no drop, no alter of an existing table, no truncate", !/\bdrop\s+(table|function|trigger|index|policy)\b/i.test(sql) && !/alter\s+table\s+public\.(?!account_sessions\b|account_rate_limit_events\b)/i.test(sql) && !/\btruncate\s+(table\s+)?public\./i.test(sql));
  add("S1C-24", "no paid, protocol or provider object is touched", !/protocol|probe_|provider_call|external_call|snapshot_request/i.test(sql));
  return out;
}

console.log("S1 schema contract");

/* Placement ---------------------------------------------------------- */
const name = parseMigrationName(FILE);
assert("S1C-00 the filename passes the shared migration-name rules", name.ok);
const ordered = orderedMigrations(readdirSync(DIR));
const idx = (f: string) => ordered.findIndex((m) => m.f === f);
assert("S1C-00 it applies after Q2′-1 and Q2′-2", idx(FILE) > idx(Q2P1) && idx(FILE) > idx(Q2P2) && idx(Q2P2) >= 0);
const earlier = new Set(
  ordered.slice(0, idx(FILE)).flatMap((m) => definedFunctions(stripComments(readFileSync(path.join(DIR, m.f), "utf8"))))
);
const redefined = definedFunctions(stripComments(SQL)).filter((f) => earlier.has(f));
assert("S1C-00 redefines no function that exists before S1", redefined.length === 0, redefined.join(","));

/* Detectors on the real migration ------------------------------------ */
for (const [id, label, ok, detail] of detectors(SQL)) assert(`${id} ${label}`, ok, detail);

/* Every detector must be able to fail -------------------------------- */
const MUTATIONS: Array<[string, string, string, string]> = [
  ["S1C-02", "RLS dropped", "alter table public.account_sessions enable row level security;", ""],
  ["S1C-03", "a policy added", "-- 6. Function privileges", "create policy p on public.account_sessions for select using (true);\n-- 6. Function privileges"],
  ["S1C-05b", "sequence left open", "revoke all on sequence public.account_rate_limit_events_id_seq from public, anon, authenticated, service_role;", ""],
  ["S1C-05", "a table grant added", "-- 6. Function privileges", "grant select on table public.account_sessions to service_role;\n-- 6. Function privileges"],
  ["S1C-07 check_account_session", "SECURITY DEFINER removed", "step_up_at timestamptz, absolute_expires_at timestamptz)\nlanguage plpgsql\nsecurity definer", "step_up_at timestamptz, absolute_expires_at timestamptz)\nlanguage plpgsql"],
  ["S1C-11", "granted to authenticated", "grant execute on function public.check_account_session(text, uuid) to service_role;", "grant execute on function public.check_account_session(text, uuid) to service_role;\ngrant execute on function public.check_account_session(text, uuid) to authenticated;"],
  ["S1C-10 _s1_session_token_hash", "helper granted", "-- 6. Function privileges", "grant execute on function public._s1_session_token_hash(text) to service_role;\n-- 6. Function privileges"],
  ["S1C-12", "shared purpose label", "public._q2p_token_hash('zypact.account_session.v1', p_token)", "public._q2p_token_hash('zypact.question_review_session.v1', p_token)"],
  ["S1C-15", "no revocation on removal", "set revoked_at = v_now, revoked_reason = 'membership_removed'", "set last_seen_at = v_now"],
  ["S1C-16", "no idle expiry", "     or v_now >= v_s.last_seen_at + make_interval(secs => v_s.idle_timeout_seconds) then", " then"],
  ["S1C-18", "30-day sessions", "interval '7 days'", "interval '30 days'"],
  ["S1C-20", "no advisory lock", "perform pg_advisory_xact_lock(hashtextextended(", "perform (hashtextextended("],
  ["S1C-21", "deletable before expiry", "if old.expires_at > clock_timestamp() then", "if false then"],
  ["S1C-22", "a swallowed error", "  return query select 'OPENED'::text", "  begin perform 1; exception when others then null; end;\n  return query select 'OPENED'::text"],
  ["S1C-23", "an existing table altered", "-- 6. Function privileges", "alter table public.workspaces add column x int;\n-- 6. Function privileges"],
];
for (const [id, label, from, to] of MUTATIONS) {
  const mutated = SQL.replace(from, to);
  const applied = mutated !== SQL;
  const hit = detectors(mutated).find(([d]) => d === id);
  assert(`mutation "${label}" is caught by ${id}`, applied && hit !== undefined && !hit[2], applied ? "" : "mutation did not apply");
}

/* Wiring ------------------------------------------------------------- */
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
assert("S1C-30 test:s1-schema is registered", pkg.scripts["test:s1-schema"] === "tsx scripts/test-s1-schema-contract.ts");
const wf = readFileSync(".github/workflows/q2p-schema-contract.yml", "utf8");
assert("S1C-31 CI runs this contract when a migration changes", wf.includes("npm run test:s1-schema") && wf.includes("scripts/test-s1-schema-contract.ts"));
const level2 = readFileSync("scripts/test-snapshot-worker-postgres-level2.sh", "utf8");
assert("S1C-32 the Level 2 harness runs the S1 cases", level2.includes("scripts/sql/level2-s1-fixtures.sql"));

console.log(`\n${total - failures}/${total} checks passed.`);
console.log(failures === 0 ? "S1 schema contract PASSED." : `${failures} check(s) failed. S1 schema contract FAILED.`);
process.exit(failures === 0 ? 0 : 1);
