#!/usr/bin/env tsx
/**
 * 0057 — static schema contract. No Docker, no database, no network.
 *
 * 0057 has two portability constraints that a flat migration cannot
 * satisfy at once:
 *
 *   - MAINTAIN is a PostgreSQL 17 privilege. On 16 it is not a
 *     recognised privilege type, so it may not appear in any statement
 *     the server parses.
 *   - `alter default privileges for role postgres` fails wherever that
 *     role is absent, as in the Level 2 harness.
 *
 * The shape is therefore two flat table-level revocations plus two
 * guarded DO blocks, carrying eight constant dynamic commands between
 * them. This contract proves that split holds, that the two guards are
 * the only conditions, and that nothing is swallowed or retargeted.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let checks = 0;
const failures: string[] = [];

function assert(label: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (!ok) failures.push(detail ? `${label} — ${detail}` : label);
}

const file = path.join(
  process.cwd(),
  "supabase/migrations/0057_m0_harden_table_privileges.sql",
);
const sql = readFileSync(file, "utf8");

/** Statements only: `--` comments removed. */
const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const doBodies = [...code.matchAll(/do\s+\$\$(.*?)\$\$\s*;/gis)].map((m) => m[1]);
const outsideDo = code.replace(/do\s+\$\$.*?\$\$\s*;/gis, "do $$BODY$$;");

const PORTABLE = ["references", "trigger", "truncate"];
const ROLE_GUARD = "exists (select 1 from pg_roles where rolname = 'postgres')";
const VERSION_GUARD = "current_setting('server_version_num')::int >= 170000";

const INHERITED_18 = [
  "analysis_llm_calls", "canonical_entities", "competitors", "dataset_batches",
  "entity_aliases", "evidence_banks", "fix_briefs", "gap_maps", "gaps",
  "generated_assets", "generated_prompts", "mirror_profiles", "probe_failures",
  "probe_results", "probe_runs", "projects", "qa_reports", "site_pages",
];
const SERVICE_ROLE_UNION = [
  ...INHERITED_18, "snapshot_report_artifacts", "snapshot_requests",
];
const M5_LOCKED = [
  "external_call_requests", "provider_call_receipts", "analysis_call_receipts",
  "protocol_execution_jobs", "protocol_external_calls", "protocol_attempts",
  "protocol_execution_job_alerts", "protocol_execution_job_alert_deliveries",
  "protocol_execution_job_alert_delivery_attempts", "protocol_operator_actions",
  "buyer_questions", "buyer_question_versions", "protocols",
  "entity_brand_snapshots", "entity_observations", "entity_resolution_passes",
];

const tablesOf = (s: string): string[] =>
  [...s.matchAll(/public\.([a-z0-9_]+)/g)].map((m) => m[1]).sort();
const same = (a: string[], b: string[]): boolean =>
  JSON.stringify(a) === JSON.stringify([...b].sort());
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

// ------------------------------------------------ overall shape
assert("exactly four root statements: two flat plus two DO",
  outsideDo.split(";").filter((s) => s.trim()).length === 4,
  `${outsideDo.split(";").filter((s) => s.trim()).length}`);
assert("exactly two DO blocks", doBodies.length === 2, `${doBodies.length}`);

const flatRevokes = [...outsideDo.matchAll(
  /revoke\s+([a-z, ]+?)\s+on table\s+([^;]+?)\s+from\s+([a-z_, ]+);/gis,
)];
assert("exactly two flat statements, both table-level REVOKE",
  flatRevokes.length === 2, `${flatRevokes.length}`);
assert("no ALTER DEFAULT PRIVILEGES left flat",
  !/alter default privileges/i.test(outsideDo));

// ------------------------------------- flat statements: 18 and 20
for (const [i, m] of flatRevokes.entries()) {
  const p = m[1].toLowerCase().split(",").map((s) => s.trim()).sort();
  assert(`flat statement ${i + 1} carries exactly the three portable verbs`,
    JSON.stringify(p) === JSON.stringify([...PORTABLE].sort()), p.join(","));
  assert(`flat statement ${i + 1} names no MAINTAIN`, !/maintain/i.test(m[0]));
}
if (flatRevokes[0]) {
  assert("flat statement 1 names exactly the 18 inherited tables",
    same(tablesOf(flatRevokes[0][2]), INHERITED_18), `${tablesOf(flatRevokes[0][2]).length}`);
  assert("flat statement 1 targets anon and authenticated only",
    JSON.stringify(flatRevokes[0][3].toLowerCase().split(",").map((s) => s.trim()).sort())
      === JSON.stringify(["anon", "authenticated"]), flatRevokes[0][3]);
}
if (flatRevokes[1]) {
  assert("flat statement 2 names exactly the service_role union (20 tables)",
    same(tablesOf(flatRevokes[1][2]), SERVICE_ROLE_UNION), `${tablesOf(flatRevokes[1][2]).length}`);
  assert("flat statement 2 targets service_role only",
    flatRevokes[1][3].trim().toLowerCase() === "service_role", flatRevokes[1][3]);
}
assert("MAINTAIN appears nowhere outside a DO block", !/maintain/i.test(outsideDo));

// --------------------------------------------- guards: exactly two
assert("the role guard is used twice, character for character",
  count(code, /exists \(select 1 from pg_roles where rolname = 'postgres'\)/g) === 2,
  `${count(code, /exists \(select 1 from pg_roles where rolname = 'postgres'\)/g)}`);
assert("the version guard is used once, character for character",
  count(code, /current_setting\('server_version_num'\)::int >= 170000/g) === 1,
  `${count(code, /current_setting\('server_version_num'\)::int >= 170000/g)}`);
assert("three IFs in total, matching the two guard predicates",
  count(code, /(?<!end\s)\bif\b/gi) === 3 && count(code, /\bend\s+if\b/gi) === 3,
  `if=${count(code, /(?<!end\s)\bif\b/gi)} endif=${count(code, /\bend\s+if\b/gi)}`);
assert("every IF condition is one of the two guards",
  [...code.matchAll(/\bif\s+(.*?)\s+then/gis)].every(
    (m) => m[1].trim() === ROLE_GUARD || m[1].trim() === VERSION_GUARD),
  [...code.matchAll(/\bif\s+(.*?)\s+then/gis)].map((m) => m[1].trim().slice(0, 30)).join(" | "));
assert("no ELSE or ELSIF anywhere", !/\belsif\b|\belse\b/i.test(code));
assert("guard compares to 170000 and to no other version number",
  (code.match(/1[0-9]{5}/g) ?? []).join(",") === "170000",
  (code.match(/1[0-9]{5}/g) ?? []).join(","));

// ------------------------------- no swallowed error, no retargeting
assert("no EXCEPTION handler: an authority failure must abort the migration",
  !/\bexception\b/i.test(code));
assert("no early RETURN", !/\breturn\b/i.test(code));
assert("every ALTER DEFAULT PRIVILEGES names `for role postgres`",
  count(code, /alter default privileges/gi)
    === count(code, /alter default privileges for role postgres in schema public/gi),
  `${count(code, /alter default privileges/gi)} vs ${count(code, /alter default privileges for role postgres in schema public/gi)}`);
assert("no current-role targeting", !/alter default privileges in schema/i.test(code));

// -------------------------- eight constant dynamic commands, exact
const portableCmds = [...code.matchAll(/execute\s+\$p\$(.*?)\$p\$\s*;/gis)].map((m) => m[1]);
const maintainCmds = [...code.matchAll(/execute\s+\$m\$(.*?)\$m\$\s*;/gis)].map((m) => m[1]);
assert("three portable dynamic commands", portableCmds.length === 3, `${portableCmds.length}`);
assert("five MAINTAIN dynamic commands", maintainCmds.length === 5, `${maintainCmds.length}`);
assert("eight dynamic commands in total, and no other EXECUTE",
  count(code, /\bexecute\b/gi) === 8, `${count(code, /\bexecute\b/gi)}`);
assert("no dynamic SQL outside the DO blocks", !/\bexecute\b/i.test(outsideDo));
assert("all commands are constant: no concatenation or interpolation",
  !/\|\||format\(|quote_ident|quote_literal|USING\b/i.test(code));

for (const [i, e] of portableCmds.entries()) {
  const p = /revoke\s+([a-z, ]+?)\s+on tables from/i.exec(e)?.[1]
    .toLowerCase().split(",").map((s) => s.trim()).sort() ?? [];
  assert(`portable command ${i + 1} revokes exactly the three portable verbs`,
    JSON.stringify(p) === JSON.stringify([...PORTABLE].sort()), p.join(","));
  assert(`portable command ${i + 1} names no MAINTAIN`, !/maintain/i.test(e));
}
assert("portable commands cover anon, authenticated and service_role",
  JSON.stringify(portableCmds.map((e) =>
    /on tables from\s+([a-z_]+)/i.exec(e)?.[1].toLowerCase() ?? "").sort())
    === JSON.stringify(["anon", "authenticated", "service_role"]));

for (const [i, e] of maintainCmds.entries()) {
  assert(`MAINTAIN command ${i + 1} revokes MAINTAIN and nothing else`,
    /revoke\s+maintain\s+on\s+(table|tables)\b/i.test(e)
      && !/references|trigger|truncate|select|insert|update|delete|grant/i.test(e),
    e.slice(0, 50));
}
if (maintainCmds[0]) {
  assert("MAINTAIN command 1 mirrors flat statement 1: 18 tables, anon + authenticated",
    same(tablesOf(maintainCmds[0]), INHERITED_18)
      && /from\s+anon,\s*authenticated\s*$/i.test(maintainCmds[0].trim()),
    `${tablesOf(maintainCmds[0]).length}`);
}
if (maintainCmds[1]) {
  assert("MAINTAIN command 2 mirrors flat statement 2: 20 tables, service_role",
    same(tablesOf(maintainCmds[1]), SERVICE_ROLE_UNION)
      && /from\s+service_role\s*$/i.test(maintainCmds[1].trim()),
    `${tablesOf(maintainCmds[1]).length}`);
}
assert("MAINTAIN commands 3-5 mirror the three portable default-ACL commands",
  JSON.stringify(maintainCmds.slice(2).map((e) =>
    /on tables from\s+([a-z_]+)/i.exec(e)?.[1].toLowerCase() ?? "").sort())
    === JSON.stringify(["anon", "authenticated", "service_role"]));

// ------------------------------------- placement inside the blocks
const roleBlock = doBodies.find((b) => !/server_version_num/i.test(b)) ?? "";
const versionBlock = doBodies.find((b) => /server_version_num/i.test(b)) ?? "";
assert("the role-guarded block holds exactly the three portable commands",
  count(roleBlock, /\bexecute\b/gi) === 3 && !/maintain/i.test(roleBlock));
assert("the version-guarded block holds exactly the five MAINTAIN commands",
  count(versionBlock, /\bexecute\b/gi) === 5);
// `from service_role$m$` ends both a table revocation and a default-ACL
// one, so anchor on the nested guard's position and count what precedes it.
assert("the two table-level MAINTAIN revocations sit outside the nested role guard",
  count(versionBlock.slice(0, versionBlock.indexOf("if exists")), /\bexecute\b/gi) === 2,
  `${count(versionBlock.slice(0, versionBlock.indexOf("if exists")), /\bexecute\b/gi)} before the guard`);
assert("the three default-ACL MAINTAIN revocations sit inside the nested role guard",
  count(versionBlock.slice(versionBlock.indexOf("if exists")), /\bexecute\b/gi) === 3,
  `${count(versionBlock.slice(versionBlock.indexOf("if exists")), /\bexecute\b/gi)}`);

// ------------------------------- honest documentation of the limit
assert("the comments state the default ACLs are skipped without the postgres role",
  /DOES NOT PROMISE/i.test(sql) && /left alone|deliberately left/i.test(sql));
assert("the comments claim no repair where postgres is absent",
  !/always repairs|guarantees the default|all environments/i.test(sql));

// ------------------------------------------------- forbidden verbs
for (const verb of ["create ", "drop ", "alter table", "grant ", "insert ", "update ", "delete ", "truncate table", "comment on", "enable row level security", "create policy", "alter policy", "drop policy", "owner to", "security definer", "set role"]) {
  assert(`no \`${verb.trim()}\` anywhere in the statements`,
    !new RegExp(`\\b${verb.trim().replace(/ /g, "\\s+")}`, "i").test(code), verb);
}
for (const t of M5_LOCKED) {
  assert(`M5-locked table \`${t}\` untouched`, !new RegExp(`public\\.${t}\\b`).test(code), t);
}
assert("no ALTER DEFAULT PRIVILEGES ... GRANT", !/alter default privileges[^;$]*\bgrant\b/is.test(code));

// ------------------------------------------------------------- report
if (failures.length > 0) {
  console.error(`\n${failures.length} of ${checks} checks FAILED:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`${checks}/${checks} checks passed. 0057 static schema contract PASSED.`);
