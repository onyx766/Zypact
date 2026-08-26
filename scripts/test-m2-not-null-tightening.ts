#!/usr/bin/env tsx
/**
 * M2 — NOT NULL tightening migration contract.
 *
 * Static assertions over migration 0040's SQL text only. This
 * migration is not applied by this test — it only verifies the file's
 * content matches the exact, narrow scope authorized: four
 * `ALTER COLUMN ... SET NOT NULL` statements, nothing else.
 *
 * SQL comments (`-- ...`) are stripped before searching for forbidden
 * DDL/DML keywords, so this file's own documentary prose (including
 * legitimate references to migrations 0036-0039) can never produce a
 * false positive.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  checks += 1;
  if (cond) console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const migrationPath = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "0040_m2_probe_dataset_not_null.sql"
);
const migration0040 = readFileSync(migrationPath, "utf8");

/**
 * Strips SQL line comments (`-- ...` to end of line) from each line.
 * This file contains no block comments and no `--` inside a string
 * literal, so a simple per-line truncation at the first `--` is exact
 * for this migration.
 */
function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

const codeOnly = stripSqlComments(migration0040);

function staticChecks(): void {
  console.log("\n  static — migration 0040 text");

  // -----------------------------------------------------------------
  // Exactly four complete ALTER COLUMN ... SET NOT NULL statements
  // -----------------------------------------------------------------
  const alterColumnPattern =
    /alter table public\.(\w+)\s+alter column (\w+) set not null;/g;
  const matches = [...codeOnly.matchAll(alterColumnPattern)];
  check(
    "exactly four complete ALTER COLUMN ... SET NOT NULL statements are present",
    matches.length === 4,
    `found ${matches.length}`
  );

  const found = matches.map((m) => `${m[1]}.${m[2]}`).sort();
  const expected = [
    "probe_results.dataset_id",
    "probe_results.dataset_source_type",
    "probe_runs.dataset_id",
    "probe_runs.dataset_source_type",
  ];
  check(
    "the four statements target exactly the four allowed columns, no others",
    JSON.stringify(found) === JSON.stringify(expected),
    found.join(", ")
  );

  // -----------------------------------------------------------------
  // Exactly four `alter column` occurrences in total — no fifth,
  // unlisted column is touched anywhere in the file.
  // -----------------------------------------------------------------
  const allAlterColumn = codeOnly.match(/alter column/g) ?? [];
  check(
    "no other `alter column` statement exists beyond the four allowed ones",
    allAlterColumn.length === 4,
    `found ${allAlterColumn.length} total`
  );

  // -----------------------------------------------------------------
  // No DDL/DML beyond the four SET NOT NULL statements. Comments are
  // stripped first, so documentary mentions of CREATE, DROP, etc. in
  // prose (including legitimate references to 0036-0039) never count.
  // -----------------------------------------------------------------
  const forbiddenKeywords = [
    "create",
    "drop",
    "insert",
    "update",
    "delete",
    "revoke",
  ];
  for (const keyword of forbiddenKeywords) {
    const pattern = new RegExp(`\\b${keyword}\\b`, "i");
    check(
      `no "${keyword.toUpperCase()}" statement outside comments`,
      !pattern.test(codeOnly)
    );
  }

  // -----------------------------------------------------------------
  // Documentary references to prior migrations are explicitly
  // permitted in comments — this test must never forbid them.
  // -----------------------------------------------------------------
  check(
    "the migration documents its relationship to 0036-0039 in comments (not forbidden)",
    /0036/.test(migration0040) &&
      /0037/.test(migration0040) &&
      /0038/.test(migration0040) &&
      /0039/.test(migration0040)
  );

  // -----------------------------------------------------------------
  // No RLS, no GRANT, no table/index/constraint creation, no data
  // touched — confirmed via the same comment-stripped text.
  // -----------------------------------------------------------------
  check(
    "no RLS statement (ENABLE/DISABLE ROW LEVEL SECURITY) outside comments",
    !/row level security/i.test(codeOnly)
  );
  check(
    "no GRANT statement outside comments",
    !/\bgrant\b/i.test(codeOnly)
  );
  check(
    "no CREATE/ALTER of any table, index, or constraint outside the four SET NOT NULL statements",
    !/create\s+(table|index)/i.test(codeOnly) &&
      !/add constraint/i.test(codeOnly)
  );

  // -----------------------------------------------------------------
  // Exactly two tables touched: probe_runs and probe_results.
  // -----------------------------------------------------------------
  const tablesTouched = new Set(matches.map((m) => m[1]));
  check(
    "exactly two tables are touched: probe_runs and probe_results",
    tablesTouched.size === 2 &&
      tablesTouched.has("probe_runs") &&
      tablesTouched.has("probe_results")
  );
}

function main(): void {
  staticChecks();

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0
        ? "M2 NOT NULL tightening migration contract PASSED."
        : "M2 NOT NULL tightening migration contract FAILED.")
  );
  console.log(
    "\nThis test verifies migration 0040's TEXT only. It does not apply\n" +
      "the migration to any database. Applying it to staging or\n" +
      "production remains a separate, explicitly authorized action."
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
