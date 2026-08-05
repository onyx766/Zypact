#!/usr/bin/env tsx
/**
 * Static contract assertions over migration 0032.
 *
 * These read the migration as text. They prove the SQL *says* what the
 * privilege boundary requires — they do not execute PostgreSQL, so they
 * prove nothing about role behavior or whether SECURITY DEFINER RPCs
 * still work after the revocation.
 *
 * No database, network, or migration execution occurs here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION = join(
  process.cwd(),
  "supabase/migrations/0032_revoke_direct_snapshot_dml.sql"
);

const sql = readFileSync(MIGRATION, "utf-8");

/**
 * Comment prose on one logical line. Leading `--` markers are stripped
 * before flattening, so a sentence wrapped across lines matches.
 */
const prose = sql
  .split("\n")
  .map((l) => l.replace(/^\s*--\s?/, ""))
  .join(" ")
  .replace(/\s+/g, " ");

/** Executable statements only — comments carry prose, not privileges. */
const statements = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.replace(/\s+/g, " ").trim().toLowerCase())
  .filter(Boolean);

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const TABLES = [
  "public.snapshot_requests",
  "public.snapshot_report_artifacts",
] as const;

const REVOKED = [
  "insert",
  "update",
  "delete",
  "truncate",
  "references",
  "trigger",
] as const;

console.log("\nStatement inventory");
check(
  "every executable statement is a REVOKE",
  statements.every((s) => s.startsWith("revoke")),
  statements.find((s) => !s.startsWith("revoke")) ?? ""
);
check(
  `exactly ${TABLES.length * REVOKED.length} revoke statements`,
  statements.length === TABLES.length * REVOKED.length,
  `found ${statements.length}`
);

console.log("\n1. Targets exactly the two approved tables");
for (const t of TABLES) {
  check(
    `${t} is targeted`,
    statements.some((s) => s.includes(`on table ${t} `))
  );
}
const referencedTables = new Set(
  statements
    .map((s) => /on table (\S+)/.exec(s)?.[1])
    .filter((x): x is string => Boolean(x))
);
check(
  "no other table is referenced",
  [...referencedTables].every((t) => (TABLES as readonly string[]).includes(t)),
  [...referencedTables].join(", ")
);

console.log("\n2. Targets only service_role");
const referencedRoles = new Set(
  statements
    .map((s) => /from (\S+)$/.exec(s)?.[1])
    .filter((x): x is string => Boolean(x))
);
check(
  "every revoke targets service_role",
  referencedRoles.size === 1 && referencedRoles.has("service_role"),
  [...referencedRoles].join(", ")
);
console.log("\n7. No other role is affected");
for (const role of ["anon", "authenticated", "public", "postgres", "authenticator", "supabase_admin"]) {
  check(
    `${role} privileges untouched`,
    !new RegExp(`\\b(from|to)\\s+${role}\\b`, "i").test(
      statements.join(" ")
    )
  );
}

console.log("\n3. Revokes the six required privileges on both tables");
for (const t of TABLES) {
  for (const p of REVOKED) {
    check(
      `${p.toUpperCase()} revoked on ${t.replace("public.", "")}`,
      statements.includes(`revoke ${p} on table ${t} from service_role`)
    );
  }
}

console.log("\n4. SELECT is preserved");
check(
  "no statement revokes SELECT",
  !statements.some((s) => /^revoke[^)]*\bselect\b/.test(s)),
  statements.find((s) => /\bselect\b/.test(s)) ?? ""
);
check("no ALL PRIVILEGES revoke", !statements.some((s) => /revoke\s+all/.test(s)));

console.log("\n5. Forbidden statement classes are absent");
const forbidden: Array<[string, RegExp]> = [
  ["ALTER DEFAULT PRIVILEGES", /alter\s+default\s+privileges/i],
  ["GRANT of table privileges", /grant\b/i],
  ["CREATE TABLE", /create\s+table/i],
  ["ALTER TABLE", /alter\s+table/i],
  ["DROP TABLE", /drop\s+table/i],
  ["data INSERT", /insert\s+into/i],
  ["data UPDATE", /^update\s+/im],
  ["data DELETE", /delete\s+from/i],
  ["function replacement", /create\s+or\s+replace\s+function/i],
  ["DROP FUNCTION", /drop\s+function/i],
  ["ownership change", /owner\s+to/i],
  ["RLS change", /row\s+level\s+security/i],
  ["policy change", /create\s+policy|drop\s+policy|alter\s+policy/i],
  ["TRUNCATE execution", /^truncate\s/im],
];
const body = statements.join(";\n");
for (const [label, re] of forbidden) {
  check(`no ${label}`, !re.test(body));
}

console.log("\n6. No unrelated application table is mentioned");
const unrelated = [
  "projects",
  "site_pages",
  "mirror_profiles",
  "generated_prompts",
  "probe_runs",
  "probe_results",
  "competitors",
  "gap_maps",
  "gaps",
  "evidence_banks",
  "fix_briefs",
  "generated_assets",
  "qa_reports",
];
for (const t of unrelated) {
  check(
    `${t} not referenced`,
    !new RegExp(`\\bpublic\\.${t}\\b`, "i").test(body)
  );
}

console.log("\n8. Function execute privileges are untouched");
check(
  "no function privilege statement",
  !/on\s+function/i.test(body)
);
check("no EXECUTE privilege mentioned", !/\bexecute\b/i.test(body));

console.log("\n9. Deployment-order warning is present");
check(
  "warns migration must not reach Production before callers migrate",
  /must not be applied to Production before all current artifact writers use the RPC surface/i.test(
    prose
  )
);
check(
  "names the two remaining direct writers",
  /saveSnapshotReportArtifact/.test(sql) &&
    /markSnapshotReportDelivered/.test(sql)
);
check(
  "states future migrations must not re-grant",
  /FUTURE MIGRATIONS MUST NOT re-grant/i.test(prose)
);
check(
  "states SELECT and RPC execution are retained",
  /retains read access and approved RPC execution/i.test(prose)
);

console.log("\n10. Idempotent");
check(
  "REVOKE-only, so re-application is a no-op",
  statements.every((s) => s.startsWith("revoke"))
);
check(
  "no statement depends on prior state existing",
  !/if\s+exists|if\s+not\s+exists|do\s+\$\$/i.test(body)
);

console.log("\n─────────────────────────────────────────────────────────");
console.log(
  "LIMITATION: Static privilege assertions do not prove PostgreSQL role"
);
console.log(
  "behavior or RPC execution after table DML revocation. Whether"
);
console.log(
  "service_role is actually denied, and whether SECURITY DEFINER RPCs still"
);
console.log(
  "mutate these tables, remain unproven until the PostgreSQL Level 2"
);
console.log("harness runs against a real database.");
console.log("─────────────────────────────────────────────────────────");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
