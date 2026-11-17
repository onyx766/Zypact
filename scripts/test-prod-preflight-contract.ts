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
const code = SQL.replace(/--[^\n]*/g, "");
const lower = code.toLowerCase();

assert("PF-01 opens exactly one READ ONLY transaction", (lower.match(/begin transaction[^;]*read only;/g) ?? []).length === 1 && (lower.match(/\bbegin\b/g) ?? []).length === 1);
assert("PF-02 ends by rolling back", /rollback;\s*$/.test(lower.trim() + "\n") && !/\bcommit\b/.test(lower));
const statements = lower.replace(/'(?:[^']|'')*'/g, "''");
const forbidden = statements.match(/\b(insert|update|delete|merge|create|alter|drop|grant|revoke|truncate|copy|lock|call|vacuum|analyze|reindex|cluster|comment\s+on|security\s+label|refresh)\b|\bdo\s+\$|\\(i|ir|copy|o|w|!)\b/g) ?? [];
assert("PF-03 no statement writes, locks, grants or changes schema", forbidden.length === 0, forbidden.join(","));
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
assert("PF-23 the queue is checked empty (P6.3) as well as nothing claimed or running (P6.1)",
  /status = 'queued'\) = 0/.test(SQL) && /status in \('claimed', 'running'\)\) = 0/.test(SQL));
assert("PF-24 the header says this baseline has never been run against production", /has NEVER been\s*\n?-- run against production/.test(SQL));

/* Wiring -------------------------------------------------------------- */
const spec = readFileSync("docs/PROD_PREFLIGHT_SPEC.md", "utf8");
assert("PF-30 the spec names this script and its run command", spec.includes("scripts/sql/prod-preflight.sql") && spec.includes("psql -X -q -v ON_ERROR_STOP=1"));
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
assert("PF-31 test:prod-preflight is registered", pkg.scripts["test:prod-preflight"] === "tsx scripts/test-prod-preflight-contract.ts");

console.log(`\n${total - failures}/${total} checks passed.`);
console.log(failures === 0 ? "Production preflight contract PASSED." : `${failures} check(s) failed. Production preflight contract FAILED.`);
process.exit(failures === 0 ? 0 : 1);
