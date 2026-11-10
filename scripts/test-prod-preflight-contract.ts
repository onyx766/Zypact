#!/usr/bin/env tsx
/**
 * Static contract for scripts/sql/prod-preflight.sql (docs/PROD_PREFLIGHT_SPEC.md).
 *
 *   - it is read-only: one READ ONLY transaction, rolled back, and no
 *     statement that writes, locks, grants or changes schema;
 *   - it stays current: every timestamped migration on disk is listed as
 *     "not yet recorded", and every table and public function those
 *     migrations create is checked for absence;
 *   - its 0083 pre-state hash is the one the reserved-version procedure pins.
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
const DIR = "supabase/migrations";
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql"));
const timestamped = files.filter((f) => {
  const r = parseMigrationName(f);
  return r.ok && r.kind === "timestamp";
});
const pending = SQL.match(/version in\s*\(([^)]*)\)/i)?.[1] ?? "";
const missing = timestamped.map((f) => f.slice(0, 14)).filter((v) => !pending.includes(`'${v}'`));
assert("PF-10 every timestamped migration on disk is checked as not yet recorded", missing.length === 0, missing.join(","));
assert("PF-11 the held and reserved four-digit versions are checked as not recorded",
  ["0081", "0082", "0083", "0084", "0085"].every((v) => pending.includes(`'${v}'`)));

const tables = new Set<string>();
const functions = new Set<string>();
for (const f of timestamped) {
  const sql = readFileSync(path.join(DIR, f), "utf8");
  for (const m of sql.matchAll(/^create table (?:if not exists )?public\.([a-z_0-9]+)/gim)) tables.add(m[1]);
  for (const m of sql.matchAll(/create (?:or replace )?function public\.([a-z_0-9]+)/gi)) {
    if (!m[1].startsWith("_")) functions.add(m[1]);
  }
}
const listedTables = SQL.match(/q2p_s1_tables\(name\) as \(values([\s\S]*?)\),\nq2p_s1_functions/)?.[1] ?? "";
const listedFunctions = SQL.match(/q2p_s1_functions\(name\) as \(values([\s\S]*?)\),\nreconcile/)?.[1] ?? "";
const unlistedTables = [...tables].filter((t) => !listedTables.includes(`'${t}'`));
const unlistedFunctions = [...functions].filter((fn) => !listedFunctions.includes(`'${fn}'`));
assert(`PF-12 every table a timestamped migration creates is checked for absence (${tables.size})`, unlistedTables.length === 0, unlistedTables.join(","));
assert(`PF-13 every public function a timestamped migration creates is checked for absence (${functions.size})`, unlistedFunctions.length === 0, unlistedFunctions.join(","));
assert("PF-14 the table count in P4.1's label matches the list", SQL.includes(`none of the ${tables.size} Q2''/S1 tables exists`));
const helperPrefixes = new Set([...timestamped].flatMap((f) =>
  [...readFileSync(path.join(DIR, f), "utf8").matchAll(/create (?:or replace )?function public\.(_[a-z0-9]+_)/gi)].map((m) => m[1])));
const uncovered = [...helperPrefixes].filter((p) => !SQL.includes(`'\\${p.slice(0, -1)}\\_%'`));
assert("PF-15 every helper prefix is checked for absence", uncovered.length === 0, uncovered.join(","));

/* Pinned values --------------------------------------------------------- */
const reserved = readFileSync("scripts/sql/sv1-apply-reserved-migration.sql", "utf8");
const preDef = reserved.match(/'742c0e1d[0-9a-f]+',\s*'([0-9a-f]{32})'/)?.[1];
assert("PF-20 the 0083 pre-state hash equals the reserved procedure's pinned pre_def", Boolean(preDef) && SQL.includes(`= '${preDef}'`), preDef ?? "not found");
assert("PF-21 the expected tail is production's 0081 alias", SQL.includes("= '20260924023646'"));

/* Wiring -------------------------------------------------------------- */
const spec = readFileSync("docs/PROD_PREFLIGHT_SPEC.md", "utf8");
assert("PF-30 the spec names this script and its run command", spec.includes("scripts/sql/prod-preflight.sql") && spec.includes("psql -X -q -v ON_ERROR_STOP=1"));
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
assert("PF-31 test:prod-preflight is registered", pkg.scripts["test:prod-preflight"] === "tsx scripts/test-prod-preflight-contract.ts");

console.log(`\n${total - failures}/${total} checks passed.`);
console.log(failures === 0 ? "Production preflight contract PASSED." : `${failures} check(s) failed. Production preflight contract FAILED.`);
process.exit(failures === 0 ? 0 : 1);
