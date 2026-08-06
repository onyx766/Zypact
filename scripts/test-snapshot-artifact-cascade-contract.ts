#!/usr/bin/env tsx
/**
 * Static contract assertions over migration 0033.
 *
 * These read the migration as text. They prove the SQL *says* what the
 * deletion boundary requires — they do not execute PostgreSQL, so they
 * prove nothing about whether a project delete is actually refused. That
 * behavior is proven by the PostgreSQL Level 2 harness.
 *
 * No database, network, or migration execution occurs here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION = join(
  process.cwd(),
  "supabase/migrations/0033_restrict_snapshot_artifact_project_delete.sql"
);

const REVOCATION = join(
  process.cwd(),
  "supabase/migrations/0032_revoke_direct_snapshot_dml.sql"
);

const sql = readFileSync(MIGRATION, "utf-8");

/** Comment prose on one logical line, `--` markers stripped. */
const prose = sql
  .split("\n")
  .map((l) => l.replace(/^\s*--\s?/, ""))
  .join(" ")
  .replace(/\s+/g, " ");

/** Executable statements only — comments carry prose, not constraints. */
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

console.log("\nConstraint shape");

check(
  "1. exactly two executable statements",
  statements.length === 2,
  `found ${statements.length}`
);

check(
  "2. first statement drops the existing project foreign key",
  statements[0] ===
    "alter table public.snapshot_report_artifacts drop constraint if exists snapshot_report_artifacts_project_id_fkey"
);

check(
  "3. the drop is idempotent",
  statements[0].includes("if exists")
);

check(
  "4. second statement re-adds the constraint under the same name",
  statements[1].startsWith(
    "alter table public.snapshot_report_artifacts add constraint snapshot_report_artifacts_project_id_fkey"
  )
);

check(
  "5. it references public.projects (id)",
  statements[1].includes("references public.projects (id)")
);

check(
  "6. the delete rule is RESTRICT",
  statements[1].includes("on delete restrict")
);

check(
  "7. the delete rule is no longer CASCADE",
  !statements[1].includes("on delete cascade")
);

console.log("\nScope containment");

check(
  "8. only snapshot_report_artifacts is altered",
  statements.every((s) =>
    s.startsWith("alter table public.snapshot_report_artifacts")
  )
);

check(
  "9. the snapshot_request_id constraint is left alone",
  !statements.some((s) =>
    s.includes("snapshot_report_artifacts_snapshot_request_id_fkey")
  )
);

for (const forbidden of [
  "grant ",
  "revoke ",
  "drop table",
  "truncate",
  "delete from",
  "update public.",
  "insert into",
  "create policy",
  "alter table public.projects",
  "create or replace function",
  "drop function",
]) {
  check(
    `10. no statement performs \`${forbidden.trim()}\``,
    !statements.some((s) => s.includes(forbidden))
  );
}

// Executable statements only. The comment prose necessarily discusses
// grants and revocations when explaining why 0033 is a constraint change
// rather than a privilege change.
check(
  "11. public.projects privileges are untouched",
  !statements.some((s) => s.includes("grant") || s.includes("revoke"))
);

console.log("\nDocumented rationale");

check(
  "12. records that 0032 revoked nothing on public.projects",
  /revoked nothing on `?public\.projects`?/i.test(prose)
);

check(
  "13. records that the stricter rule blocks undelivered artifacts too",
  /not only when that artifact has been delivered/i.test(prose)
);

check(
  "14. records that no application path deletes a project",
  /no application code path deletes a project/i.test(prose)
);

check(
  "15. records the trigger alternative that was not chosen",
  /before delete trigger/i.test(prose)
);

check(
  "16. records that a future deletion flow must decide explicitly",
  /must decide explicitly what/i.test(prose)
);

check(
  "17. records that the snapshot_request_id cascade is retained",
  /stays on delete cascade/i.test(prose)
);

console.log("\nRelationship to migration 0032");

const revocation = readFileSync(REVOCATION, "utf-8").toLowerCase();

check(
  "18. 0032 still revokes nothing on public.projects",
  !revocation.includes("public.projects"),
  "0033 exists because 0032 does not cover projects"
);

check(
  "19. 0033 does not re-grant any direct snapshot privilege",
  !statements.some((s) => s.includes("grant"))
);

console.log("\n─────────────────────────────────────────────────────────");
console.log("These assertions read SQL text only. Whether PostgreSQL actually");
console.log("refuses a project delete, and whether an undelivered-artifact");
console.log("project delete is also refused, remain unproven until the");
console.log("PostgreSQL Level 2 harness runs against a real database.");
console.log("─────────────────────────────────────────────────────────");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
