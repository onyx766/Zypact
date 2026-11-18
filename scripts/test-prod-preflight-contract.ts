#!/usr/bin/env tsx
/**
 * Static contract for scripts/sql/prod-preflight.sql (docs/PROD_PREFLIGHT_SPEC.md).
 *
 *   - it is read-only: one READ ONLY transaction, rolled back, and no
 *     statement that writes, locks, grants or changes schema;
 *   - it stays current: the migrations production holds (0083, Q2'-1, Q2'-2,
 *     S1) are checked present with their tables and functions, and every
 *     other migration on disk is listed as "not yet recorded", with every
 *     table and public function it creates checked for absence;
 *   - its 0083 hash is the post_def the reserved-version procedure pins.
 *
 * No database, no network.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { parseMigrationName } from "./lib/migration-names";

let total = 0;
let failures = 0;
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

const SQL = readFileSync("scripts/sql/prod-preflight.sql", "utf8");

/*
 * The one raise-only DO block the preflight may contain (2026-11-17, D-058):
 * on a FAIL it makes psql exit non-zero under ON_ERROR_STOP. It is matched
 * exactly and removed before every read-only check; any other DO is refused.
 */
const ALLOWED_DO =
  "do $preflight$ begin raise exception 'PREFLIGHT: FAIL - a must-pass check failed; see the verdict line above'; end $preflight$;";

/** The read-only violations in a preflight text: empty means read-only. */
export function readOnlyViolations(sqlText: string): string[] {
  const out: string[] = [];
  const doCount = sqlText.split(ALLOWED_DO).length - 1;
  if (doCount > 1) out.push("the raise-only DO block appears more than once");
  const code = sqlText.split(ALLOWED_DO).join("").replace(/--[^\n]*/g, "");
  const lower = code.toLowerCase();
  if ((lower.match(/begin transaction[^;]*read only;/g) ?? []).length !== 1 || (lower.match(/\bbegin\b/g) ?? []).length !== 1) {
    out.push("not exactly one READ ONLY transaction");
  }
  if (!/rollback;\s*$/.test(lower.trim() + "\n") || /\bcommit\b/.test(lower)) out.push("does not end by rolling back");
  // String literals are blanked so a label can say anything.
  const statements = lower.replace(/'(?:[^']|'')*'/g, "''");
  const keywords = statements.match(
    /\b(insert|update|delete|merge|create|alter|drop|grant|revoke|truncate|copy|lock|call|vacuum|analyze|reindex|cluster|notify|listen|unlisten|do|discard|prepare|execute|checkpoint|refresh|import|load|reassign|security\s+label|comment\s+on)\b/g
  ) ?? [];
  out.push(...keywords.map((k) => `keyword:${k}`));
  if (/\\(i|ir|include|include_relative|copy|o|out|w|write|gexec|setenv|cd|lo_\w+)\b/.test(statements) || /\\!/.test(statements)) out.push("psql meta-command that reads, writes or executes");
  for (const fn of statements.match(/\b(pg_(?:try_)?advisory\w*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_create_\w+|pg_drop_\w+|pg_promote|pg_log_backend_memory_contexts|nextval|setval|lo_\w+|dblink\w*|txid_current|pg_current_xact_id)\s*\(/g) ?? []) {
    out.push(`function:${fn.replace(/\s*\($/, "")}`);
  }
  if (/\bset\s+(?:local\s+)?(?:role|session)\b/.test(statements) || /\breset\s+(?:role|session)\b/.test(statements)) out.push("set role / set session");
  if (/\bset\s+(?!local\b)[a-z_]+/.test(statements.replace(/\\set\b/g, "\\setvar"))) out.push("a SET that is not SET LOCAL");
  // set_config is allowed only transaction-local (third argument true).
  for (const m of statements.matchAll(/\bset_config\s*\(/g)) {
    let depth = 1, i = (m.index ?? 0) + m[0].length;
    const start = i;
    while (i < statements.length && depth > 0) {
      if (statements[i] === "(") depth += 1;
      else if (statements[i] === ")") depth -= 1;
      i += 1;
    }
    const args = statements.slice(start, i - 1);
    const parts: string[] = [];
    let d = 0, cur = "";
    for (const ch of args) {
      if (ch === "(") d += 1;
      if (ch === ")") d -= 1;
      if (ch === "," && d === 0) { parts.push(cur); cur = ""; } else cur += ch;
    }
    parts.push(cur);
    if (parts.length !== 3 || parts[2].trim() !== "true") out.push("set_config that is not transaction-local");
  }
  return out;
}

const code = SQL.split(ALLOWED_DO).join("").replace(/--[^\n]*/g, "");
const lower = code.toLowerCase();

assert("PF-01 opens exactly one READ ONLY transaction", (lower.match(/begin transaction[^;]*read only;/g) ?? []).length === 1 && (lower.match(/\bbegin\b/g) ?? []).length === 1);
assert("PF-02 ends by rolling back", /rollback;\s*$/.test(lower.trim() + "\n") && !/\bcommit\b/.test(lower));
const violations = readOnlyViolations(SQL);
assert("PF-03 no statement writes, locks, grants, changes schema, role or session, or calls a function with side effects", violations.length === 0, violations.join(","));
assert("PF-03a the raise-only DO block appears exactly once, guarded by the FAIL verdict",
  SQL.split(ALLOWED_DO).length - 1 === 1 && SQL.includes(`\\if :pf_failed\n${ALLOWED_DO}\n\\endif\nrollback;`));

/* Mutation checks: each forbidden pattern, inserted before the rollback, is caught. */
const MUTATIONS: Array<[string, string]> = [
  ["advisory lock", "select pg_advisory_lock(42);"],
  ["advisory xact lock", "select pg_advisory_xact_lock(42);"],
  ["try advisory lock", "select pg_try_advisory_lock(42);"],
  ["session set_config", "select set_config('search_path', 'x', false);"],
  ["set_config without its third argument", "select set_config('search_path', 'x');"],
  ["terminate backend", "select pg_terminate_backend(0);"],
  ["cancel backend", "select pg_cancel_backend(0);"],
  ["set role", "set role service_role;"],
  ["set local role", "set local role service_role;"],
  ["set session authorization", "set session authorization service_role;"],
  ["plain session set", "set search_path = x;"],
  ["nextval", "select nextval('public.some_seq');"],
  ["setval", "select setval('public.some_seq', 1);"],
  ["insert", "insert into public.pilots default values;"],
  ["update", "update public.pilots set status = 'closed';"],
  ["delete", "delete from public.pilots;"],
  ["alter", "alter table public.pilots add column x int;"],
  ["drop", "drop table public.pilots;"],
  ["create", "create temp table x(a int);"],
  ["grant", "grant select on public.pilots to anon;"],
  ["revoke", "revoke select on public.pilots from service_role;"],
  ["truncate", "truncate public.pilots;"],
  ["copy", "copy public.pilots to stdout;"],
  ["lock table", "lock table public.pilots in exclusive mode;"],
  ["vacuum", "vacuum public.pilots;"],
  ["notify", "notify zypact;"],
  ["listen", "listen zypact;"],
  ["call", "call public.some_procedure();"],
  ["a second DO block", "do $x$ begin perform 1; end $x$;"],
  ["a duplicate of the allowed DO block", ALLOWED_DO],
  ["commit", "commit;"],
  ["psql include", "\\i other.sql"],
  ["psql shell escape", "\\! touch x"],
  ["psql gexec", "select 'select 1' \\gexec"],
];
for (const [name, line] of MUTATIONS) {
  const mutated = SQL.replace(/\nrollback;\s*$/, `\n${line}\nrollback;\n`);
  assert(`PF-03m mutation caught: ${name}`, mutated !== SQL && readOnlyViolations(mutated).length > 0);
}
assert("PF-03n a transaction-local set_config(..., true) is allowed",
  readOnlyViolations(SQL.replace(/\nrollback;\s*$/, "\nselect set_config('search_path', 'x', true);\nrollback;\n")).length === 0);

assert("PF-04 statement and lock timeouts are set", lower.includes("set local statement_timeout = '30s'") && lower.includes("set local lock_timeout = '2s'"));
assert("PF-05 it reads no customer column (no email, token, prompt, response or evidence field)",
  !/\b(email|token|prompt|raw_response|answer|work_email|company_name|website_url|claim_token)\b/.test(lower.replace(/'[^']*'/g, "")));

/* Current with the migrations on disk -------------------------------- */
// D-058 (proposed) re-baseline, 2026-11-17: production holds 0083, Q2'-1,
// Q2'-2 and S1 (CURRENT_STATUS §25). The preflight lists those as applied
// (present) and every other migration on disk as pending (absent).
const DIR = "supabase/migrations";
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql"));
const timestamped = files.filter((f) => {
  const r = parseMigrationName(f);
  return r.ok && r.kind === "timestamp";
}).sort();
const appliedList = SQL.match(/applied_versions\(version\) as \(values([\s\S]*?)\),\napplied_tables/)?.[1] ?? "";
const appliedVersions = [...appliedList.matchAll(/'([0-9]+)'/g)].map((m) => m[1]);
const appliedTimestamped = appliedVersions.filter((v) => v.length === 14).sort();
const pending = SQL.match(/version in\s*\(([^)]*)\)/i)?.[1] ?? "";
assert("PF-09 the applied versions are 0083 plus a prefix of the timestamped migrations on disk (production applies in numeric order)",
  appliedVersions.includes("0083") && appliedTimestamped.length > 0
    && appliedTimestamped.every((v, i) => timestamped[i]?.startsWith(v)),
  appliedVersions.join(","));
const appliedFiles = timestamped.filter((f) => appliedTimestamped.includes(f.slice(0, 14)));
const pendingFiles = timestamped.filter((f) => !appliedTimestamped.includes(f.slice(0, 14)));
const missing = pendingFiles.map((f) => f.slice(0, 14)).filter((v) => !pending.includes(`'${v}'`));
assert("PF-10 every pending timestamped migration on disk is checked as not yet recorded", missing.length === 0, missing.join(","));
assert("PF-11 the held four-digit versions are checked as not recorded, and no applied version is",
  ["0081", "0082", "0084", "0085"].every((v) => pending.includes(`'${v}'`))
    && appliedVersions.every((v) => !pending.includes(`'${v}'`)));

// A definition may span lines ("create or replace function\n  public.x("),
// so whitespace between the words is matched, not a single space.
const FUNCTION_DEF = /create\s+(?:or\s+replace\s+)?function\s+public\.([a-z_0-9]+)/gi;
// A function that exists in production (a four-digit migration or an applied
// timestamped one defines it) and that a pending migration redefines is
// checked by a pinned pre-state, never by absence.
const existingFunctions = new Set<string>();
for (const f of [...files.filter((name) => /^\d{4}_/.test(name)), ...appliedFiles]) {
  for (const m of readFileSync(path.join(DIR, f), "utf8").matchAll(FUNCTION_DEF)) existingFunctions.add(m[1]);
}
function objectsOf(list: string[]) {
  const tables = new Set<string>();
  const functions = new Set<string>();
  const redefined = new Set<string>();
  const prefixes = new Set<string>();
  for (const f of list) {
    const sql = readFileSync(path.join(DIR, f), "utf8");
    for (const m of sql.matchAll(/^create table (?:if not exists )?public\.([a-z_0-9]+)/gim)) tables.add(m[1]);
    for (const m of sql.matchAll(FUNCTION_DEF)) {
      if (m[1].startsWith("_")) continue;
      if (existingFunctions.has(m[1]) && !list.every((x) => appliedFiles.includes(x))) redefined.add(m[1]);
      else functions.add(m[1]);
    }
    for (const m of sql.matchAll(/create (?:or replace )?function public\.(_[a-z0-9]+_)/gi)) prefixes.add(m[1]);
  }
  return { tables, functions, redefined, prefixes };
}
const applied = objectsOf(appliedFiles);
const pend = objectsOf(pendingFiles);
const section = (name: string, next: string) => SQL.match(new RegExp(`${name}\\(name\\) as \\(values([\\s\\S]*?)\\),\\n${next}`))?.[1] ?? "";
const listedAppliedTables = section("applied_tables", "applied_functions");
const listedAppliedFunctions = section("applied_functions", "pending_tables");
const listedPendingTables = section("pending_tables", "pending_functions");
const listedPendingFunctions = section("pending_functions", "reconcile");
const unlisted = (set: Set<string>, listed: string) => [...set].filter((x) => !listed.includes(`'${x}'`));
assert(`PF-12 every table a pending migration creates is checked for absence (${pend.tables.size})`,
  listedPendingTables.length > 0 && unlisted(pend.tables, listedPendingTables).length === 0, unlisted(pend.tables, listedPendingTables).join(","));
assert(`PF-13 every public function a pending migration creates is checked for absence (${pend.functions.size})`,
  listedPendingFunctions.length > 0 && unlisted(pend.functions, listedPendingFunctions).length === 0, unlisted(pend.functions, listedPendingFunctions).join(","));
assert(`PF-12a every table an applied migration created is checked for presence (${applied.tables.size})`,
  listedAppliedTables.length > 0 && unlisted(applied.tables, listedAppliedTables).length === 0, unlisted(applied.tables, listedAppliedTables).join(","));
assert(`PF-13a every public function an applied migration created is checked for presence (${applied.functions.size})`,
  listedAppliedFunctions.length > 0 && unlisted(applied.functions, listedAppliedFunctions).length === 0, unlisted(applied.functions, listedAppliedFunctions).join(","));
assert("PF-13b no applied object is listed as pending, nor a pending one as applied",
  [...applied.tables].every((t) => !listedPendingTables.includes(`'${t}'`)) && [...pend.tables].every((t) => !listedAppliedTables.includes(`'${t}'`))
    && [...applied.functions].every((f) => !listedPendingFunctions.includes(`'${f}'`)) && [...pend.functions].every((f) => !listedAppliedFunctions.includes(`'${f}'`)));
assert("PF-14 the counts in P4.1, P4.2, P4.4 and P4.5 match the lists",
  SQL.includes(`none of the ${pend.tables.size} pending tables exists`) && SQL.includes(`none of the ${pend.functions.size} pending public functions exists`)
    && SQL.includes(`all ${applied.tables.size} applied tables exist`) && SQL.includes(`= ${applied.tables.size},`)
    && SQL.includes(`all ${applied.functions.size} applied public functions exist`) && SQL.includes(`= ${applied.functions.size},`));
const unpinned = [...pend.redefined].filter((fn) =>
  !new RegExp(`to_regprocedure\\('public\\.${fn}\\(`).test(SQL) || !new RegExp(`'[^']*${fn}[^']*md5[^']*'`).test(SQL));
assert(`PF-16 every existing function a pending migration redefines has a pinned md5 pre-state (${pend.redefined.size})`,
  unpinned.length === 0, unpinned.join(","));
assert("PF-17 no redefined function is listed for absence, which would fail on production",
  [...pend.redefined].every((fn) => !listedPendingFunctions.includes(`'${fn}'`)));
const uncovered = [...pend.prefixes].filter((p) => !applied.prefixes.has(p) && !SQL.includes(`'\\${p.slice(0, -1)}\\_%'`));
const appliedAsAbsent = [...applied.prefixes].filter((p) => {
  const absence = SQL.match(/P4\.2'[\s\S]*?union all/)?.[0] ?? "";
  return absence.includes(`'\\${p.slice(0, -1)}\\_%'`);
});
assert("PF-15 every pending helper prefix is checked for absence, and no applied one is",
  uncovered.length === 0 && appliedAsAbsent.length === 0, [...uncovered, ...appliedAsAbsent].join(","));

/* Pinned values --------------------------------------------------------- */
const reserved = readFileSync("scripts/sql/sv1-apply-reserved-migration.sql", "utf8");
const postDef = reserved.match(/'742c0e1d[0-9a-f]+',\s*'[0-9a-f]{32}',\s*'([0-9a-f]{32})'/)?.[1];
assert("PF-20 P3.1 pins reconcile_attempt_for_job as 0083 left it: the reserved procedure's post_def", Boolean(postDef) && SQL.includes(`= '${postDef}'`), postDef ?? "not found");
const tail = appliedTimestamped[appliedTimestamped.length - 1];
assert("PF-21 the expected tail is the last applied version, and the row count is 80 + the 0081 alias + the applied versions",
  Boolean(tail) && SQL.includes(`(select max(version) from ledger) = '${tail}'`) && SQL.includes("= '20260924023646'")
    && SQL.includes(`(select count(*) from ledger) = ${80 + 1 + appliedVersions.length}`));
assert("PF-22 the 0069 pre-state of approve_and_launch_snapshot_baseline is pinned (computed on a disposable stack with every migration before 20261109130000)",
  SQL.includes("= '710dfb5cb84ce09a94040ebb84086025'"));
assert("PF-22b the 0054 pre-state of persist_probe_result_for_job, which 20261109180000 (D-061) redefines, is pinned (computed on a disposable stack at the recorded state)",
  /'persist_probe_result_for_job is exactly as 0054 left it \(md5 of its definition\)',\s*\(select coalesce\(md5\(pg_get_functiondef\(oid\)\), 'missing'\) from persist\) = 'd812b7f4c606e03ea171113f9fbc9762',/.test(SQL));
assert("PF-23 the queue is checked empty (P6.3) as well as nothing claimed or running (P6.1)",
  /status = 'queued'\) = 0/.test(SQL) && /status in \('claimed', 'running'\)\) = 0/.test(SQL));
assert("PF-24 the header says this baseline has never been run against production", /has NEVER been\s*\n?-- run against production/.test(SQL));

/* Target, verdict and fail-closed rules (2026-11-17, review of PR #129) --- */
assert("PF-25 P1.1 must pass: the system identifier equals -v expected_sysid, and a missing value cannot pass",
  /select 'P1\.1', '[^']*',\s*case when has_function_privilege\('pg_control_system\(\)', 'execute'\)\s*then \(select system_identifier::text from pg_control_system\(\)\) = :'expected_sysid'\s*else false end,/.test(SQL)
    && SQL.includes("\\if :{?expected_sysid}") && SQL.includes("\\set expected_sysid 'not given'")
    && SQL.includes("-v expected_sysid=<from your private record>"));
assert("PF-25a no system identifier is written into the repository (no 15-20 digit number in the script)", !/\b\d{15,20}\b/.test(SQL));
assert("PF-26 the check set is built once and one statement yields the lines, the verdict and the FAIL flag",
  (SQL.match(/\bfrom checks\b/g) ?? []).length === 1 && SQL.includes("from checks c left join informational i on i.id = c.id \\gset pf_")
    && /\\echo :pf_lines\n\\echo :pf_verdict\n\\if :pf_failed\n/.test(SQL)
    && SQL.includes("'PREFLIGHT: PASS'") && SQL.includes("'PREFLIGHT: FAIL (' ||"));
assert("PF-26a a must-pass check that is false or null counts as a FAIL (only the informational ids are exempt)",
  (SQL.match(/count\(\*\) filter \(where i\.id is null and c\.pass is not true\)/g) ?? []).length === 3);
const literalNullIds = [...SQL.matchAll(/select '(P\d\.\d)', '(?:[^']|'')*',\s*null(?:::boolean)?\s*,/g)].map((m) => m[1]).sort();
const infoIds = [...(SQL.match(/informational\(id\) as \(values([^\n]*)\)/)?.[1] ?? "").matchAll(/'(P\d\.\d)'/g)].map((m) => m[1]).sort();
assert("PF-26b the informational ids are exactly the checks whose pass is a literal null",
  infoIds.length > 0 && JSON.stringify(infoIds) === JSON.stringify(literalNullIds), `info ${infoIds.join(",")} vs null ${literalNullIds.join(",")}`);
assert("PF-27 row security is off, so a role without BYPASSRLS errors instead of reading 0", /set local row_security = off;/.test(SQL));
const HELPER_DEF = /create\s+(?:or\s+replace\s+)?function\s+public\.(_q2p_[a-z0-9_]+|_q2p2_[a-z0-9_]+|_s1_[a-z0-9_]+)/gi;
const appliedHelpers = new Set<string>();
for (const f of appliedFiles) for (const m of readFileSync(path.join(DIR, f), "utf8").matchAll(HELPER_DEF)) appliedHelpers.add(m[1]);
assert(`PF-28 P4.6 must pass with exactly the ${appliedHelpers.size} helpers the applied migrations define`,
  appliedHelpers.size > 0 && SQL.includes(`all ${appliedHelpers.size} applied helpers exist`)
    && new RegExp(`'\\\\_s1\\\\_%'\\)\\) = ${appliedHelpers.size},`).test(SQL), String(appliedHelpers.size));

/* The named-file apply procedure (scripts/sql/sv1-apply-named-migration.sql) */
const APPLY = readFileSync("scripts/sql/sv1-apply-named-migration.sql", "utf8");
const bodyStart = APPLY.search(/^-- Named-file migration apply\./m);
const body = bodyStart >= 0 ? APPLY.slice(bodyStart) : "";
const bodySha = createHash("sha256").update(body).digest("hex");
assert("PF-40 the apply script's header records its body's sha256 (the production copy is that body, unchanged)",
  bodyStart > 0 && APPLY.slice(0, bodyStart).includes(bodySha), bodySha);
assert("PF-41 the apply guard refuses a version that is not later than expected_prev, and both must be 14 digits",
  body.includes(":'expected_prev' ~ '^[0-9]{14}$' and :'new_version' > :'expected_prev' as order_ok")
    && body.includes("\\if :order_ok\n\\else\n  do $g$ begin raise exception 'named-migration guard: version is not later than the expected predecessor'; end $g$;\n\\endif"));
assert("PF-42 the apply guard refuses a different system identifier when -v target_sysid is given, before the ledger lock",
  /\\if :\{\?target_sysid\}\nselect \(select system_identifier::text from pg_control_system\(\)\) = :'target_sysid' as sysid_ok \\gset\n\\if :sysid_ok\n\\else\n  do \$g\$ begin raise exception 'named-migration guard: this database is not the target \(system identifier differs\)'; end \$g\$;\n\\endif\n\\endif\nlock table/.test(body));
assert("PF-43 the earlier guards are unchanged (predecessor, 14 digits, not yet recorded)",
  body.includes("select coalesce(max(version), '') = :'expected_prev' as prev_ok,")
    && body.includes("'named-migration guard: version is not 14 digits'")
    && body.includes("'named-migration guard: latest ledger version is not the expected predecessor'")
    && body.includes("'named-migration guard: version already recorded'"));

/* Wiring -------------------------------------------------------------- */
const spec = readFileSync("docs/PROD_PREFLIGHT_SPEC.md", "utf8");
assert("PF-30 the spec names this script and its run command", spec.includes("scripts/sql/prod-preflight.sql") && spec.includes("psql -X -q -v ON_ERROR_STOP=1"));
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
assert("PF-31 test:prod-preflight is registered", pkg.scripts["test:prod-preflight"] === "tsx scripts/test-prod-preflight-contract.ts");

console.log(`\n${total - failures}/${total} checks passed.`);
console.log(failures === 0 ? "Production preflight contract PASSED." : `${failures} check(s) failed. Production preflight contract FAILED.`);
process.exit(failures === 0 ? 0 : 1);
