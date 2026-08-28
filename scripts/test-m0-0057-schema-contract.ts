#!/usr/bin/env tsx
/**
 * 0057 — static schema contract. No Docker, no database, no network.
 *
 * Reads the migration text and asserts the properties that make the
 * privilege hardening safe to apply: it revokes exactly four verbs from
 * exactly the tables that carry them, it repairs the default privileges
 * so the residue cannot regrow, and it touches nothing else.
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

/** Statements only: dollar-quoted bodies and `--` comments removed. */
const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const DANGEROUS = ["references", "trigger", "truncate", "maintain"];

/** The 18 tables that inherit the residue for anon and authenticated. */
const INHERITED_18 = [
  "analysis_llm_calls", "canonical_entities", "competitors", "dataset_batches",
  "entity_aliases", "evidence_banks", "fix_briefs", "gap_maps", "gaps",
  "generated_assets", "generated_prompts", "mirror_profiles", "probe_failures",
  "probe_results", "probe_runs", "projects", "qa_reports", "site_pages",
];

/**
 * The union of every table where the four verbs survive for service_role
 * in either environment: the 18 inherited tables (a freshly migrated
 * database gives service_role arwdDxtm on 12 of them) plus the two
 * snapshot tables that carry MAINTAIN on staging.
 */
const SERVICE_ROLE_UNION = [
  ...INHERITED_18, "snapshot_report_artifacts", "snapshot_requests",
];

/**
 * The M5-era tables already locked down by their own migrations. 0057 must
 * not name a single one: touching them would be scope creep at best and a
 * silent privilege change at worst.
 */
const M5_LOCKED = [
  "external_call_requests", "provider_call_receipts", "analysis_call_receipts",
  "protocol_execution_jobs", "protocol_external_calls", "protocol_attempts",
  "protocol_execution_job_alerts", "protocol_execution_job_alert_deliveries",
  "protocol_execution_job_alert_delivery_attempts", "protocol_operator_actions",
  "buyer_questions", "buyer_question_versions", "protocols",
  "entity_brand_snapshots", "entity_observations", "entity_resolution_passes",
];

// ---------------------------------------------------------------- shape
const revokes = [...code.matchAll(/revoke\s+([a-z, ]+?)\s+on table\s+([^;]+?)\s+from\s+([a-z_, ]+);/gis)];
assert("exactly two table-level REVOKE statements", revokes.length === 2, `found ${revokes.length}`);

const defaults = [...code.matchAll(
  /alter default privileges for role postgres in schema public\s+revoke\s+([a-z, ]+?)\s+on tables from\s+([a-z_]+);/gis,
)];
assert("exactly three ALTER DEFAULT PRIVILEGES REVOKE statements", defaults.length === 3, `found ${defaults.length}`);

assert("no other statement kind present",
  code.split(";").filter((s) => s.trim()).length === 5,
  `${code.split(";").filter((s) => s.trim()).length} statements`);

// -------------------------------------------------- forbidden verbs
for (const verb of ["create ", "drop ", "alter table", "grant ", "insert ", "update ", "delete ", "truncate table", "comment on", "enable row level security", "create policy", "alter policy", "drop policy"]) {
  assert(`no \`${verb.trim()}\` in statements`, !new RegExp(`\\b${verb.replace(/ /g, "\\s+")}`, "i").test(code), verb);
}

// ------------------------------------------------- block 1: anon/auth
if (revokes[0]) {
  const [, privs, tables, roles] = revokes[0];
  const p = privs.toLowerCase().split(",").map((s) => s.trim()).sort();
  assert("block 1 revokes exactly the four dangerous verbs",
    JSON.stringify(p) === JSON.stringify([...DANGEROUS].sort()), p.join(","));
  const t = [...tables.matchAll(/public\.([a-z0-9_]+)/g)].map((m) => m[1]).sort();
  assert("block 1 names exactly the 18 inherited tables",
    JSON.stringify(t) === JSON.stringify([...INHERITED_18].sort()), `${t.length} tables`);
  const r = roles.toLowerCase().split(",").map((s) => s.trim()).sort();
  assert("block 1 targets anon and authenticated only",
    JSON.stringify(r) === JSON.stringify(["anon", "authenticated"]), r.join(","));
}

// ---------------------------------------------- block 2: service_role
if (revokes[1]) {
  const [, privs, tables, roles] = revokes[1];
  const p = privs.toLowerCase().split(",").map((s) => s.trim()).sort();
  assert("block 2 revokes exactly the four dangerous verbs",
    JSON.stringify(p) === JSON.stringify([...DANGEROUS].sort()), p.join(","));
  const t = [...tables.matchAll(/public\.([a-z0-9_]+)/g)].map((m) => m[1]).sort();
  assert("block 2 names exactly the service_role union (20 tables)",
    JSON.stringify(t) === JSON.stringify([...SERVICE_ROLE_UNION].sort()), `${t.length} tables`);
  assert("block 2 targets service_role only", roles.trim().toLowerCase() === "service_role", roles);
}

// -------------------------------------------------- default privileges
{
  const roles = defaults.map((d) => d[2].toLowerCase()).sort();
  assert("default privileges repaired for the three roles",
    JSON.stringify(roles) === JSON.stringify(["anon", "authenticated", "service_role"]), roles.join(","));
  for (const d of defaults) {
    const p = d[1].toLowerCase().split(",").map((s) => s.trim()).sort();
    assert(`default revoke for ${d[2]} lists exactly the four verbs`,
      JSON.stringify(p) === JSON.stringify([...DANGEROUS].sort()), p.join(","));
  }
}

// ------------------------------------------------------- scope guards
for (const t of M5_LOCKED) {
  assert(`M5-locked table \`${t}\` untouched`, !new RegExp(`public\\.${t}\\b`).test(code), t);
}
assert("no ALTER DEFAULT PRIVILEGES ... GRANT", !/alter default privileges[^;]*\bgrant\b/is.test(code));
assert("no role other than anon/authenticated/service_role named",
  !/\b(postgres|public|supabase_admin|authenticator|dashboard_user)\b/i.test(
    code.replace(/for role postgres/gi, "").replace(/in schema public/gi, "").replace(/public\.[a-z0-9_]+/gi, ""),
  ));

// ------------------------------------------------------------- report
if (failures.length > 0) {
  console.error(`\n${failures.length} of ${checks} checks FAILED:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`${checks}/${checks} checks passed. 0057 static schema contract PASSED.`);
