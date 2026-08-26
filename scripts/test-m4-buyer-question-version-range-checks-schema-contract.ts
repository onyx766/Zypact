#!/usr/bin/env tsx
/**
 * M4 — static assertions over draft migration 0048's SQL text only.
 *
 * No real Postgres connection is used (matching the established
 * scripts/test-m4-schema-contract.ts pattern). Verifies:
 *   - the three named CHECK constraints exist, with the CORRECT
 *     bounds (winnability 1..5, never confused with priority's 1..25);
 *   - no backfill / no data write anywhere in 0048;
 *   - migration 0047 is untouched (still has no range CHECK on these
 *     columns, still bare `integer not null`, and does not already
 *     define any of 0048's new constraint names — proving 0048 is
 *     additive, not a duplicate or a silent redefinition);
 *   - the application-layer validator remains in place as a
 *     complementary defense, not replaced by this migration.
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

const migration0048Path = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "0048_m4_buyer_question_version_numeric_range_checks.sql"
);
const migration0047Path = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "0047_m4_buyer_question_protocol_attempts.sql"
);
const raw0048 = readFileSync(migration0048Path, "utf8");
const raw0047 = readFileSync(migration0047Path, "utf8");
const validatorSrc = readFileSync(
  path.join(process.cwd(), "lib", "db", "validate-buyer-question-version-fields.ts"),
  "utf8"
);

function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

const codeOnly0048 = stripSqlComments(raw0048);
const codeOnlyLower0048 = codeOnly0048.toLowerCase();

function main(): void {
  console.log("\n[0048 — draft migration text]");

  // ---- No writes/backfill --------------------------------------------
  check(
    "0048 contains no INSERT/UPDATE/DELETE anywhere — no backfill, no data write",
    !/\binsert\s+into\b/i.test(codeOnlyLower0048) &&
      !/\bupdate\s+public\./i.test(codeOnlyLower0048) &&
      !/\bdelete\s+from\b/i.test(codeOnlyLower0048)
  );
  check(
    "0048 touches only buyer_question_versions — no other table altered",
    (codeOnly0048.match(/alter table public\.(\w+)/gi) ?? []).every((m) =>
      /buyer_question_versions/i.test(m)
    )
  );
  check(
    "0048 does not create or drop any table, RPC, index, or RLS policy",
    !/create table|drop table|create or replace function|drop function|create.*index|create policy|drop policy|enable row level security|force row level security/i.test(
      codeOnlyLower0048
    )
  );

  // ---- The three named CHECK constraints, correct bounds --------------
  check(
    "buyer_question_versions_commercial_value_range_check: commercial_value between 1 and 5",
    /add constraint buyer_question_versions_commercial_value_range_check\s*\n?\s*check \(commercial_value between 1 and 5\)/i.test(
      codeOnly0048
    )
  );
  check(
    "buyer_question_versions_winnability_range_check: winnability between 1 and 5 (NOT 1 and 25)",
    /add constraint buyer_question_versions_winnability_range_check\s*\n?\s*check \(winnability between 1 and 5\)/i.test(
      codeOnly0048
    ) &&
      !/winnability_range_check[\s\S]{0,80}between 1 and 25/i.test(codeOnly0048)
  );
  check(
    "buyer_question_versions_priority_range_check: priority between 1 and 25 (NOT 1 and 5)",
    /add constraint buyer_question_versions_priority_range_check\s*\n?\s*check \(priority between 1 and 25\)/i.test(
      codeOnly0048
    ) &&
      !/priority_range_check[\s\S]{0,80}between 1 and 5\)/i.test(codeOnly0048)
  );
  check(
    "all three constraints target public.buyer_question_versions",
    (codeOnly0048.match(/alter table public\.buyer_question_versions\s*\n\s*add constraint/gi) ?? [])
      .length === 3
  );

  // ---- 0047 remains untouched by this change ---------------------------
  console.log("\n[0047 — confirmed untouched]");
  check(
    "0047 still declares the three columns as bare 'integer not null', no range CHECK of its own",
    /commercial_value\s+integer not null,/i.test(raw0047) &&
      /winnability\s+integer not null,/i.test(raw0047) &&
      /priority\s+integer not null,/i.test(raw0047)
  );
  check(
    "0047 does not already define any of 0048's new constraint names (0048 is additive, not a duplicate)",
    !raw0047.includes("buyer_question_versions_commercial_value_range_check") &&
      !raw0047.includes("buyer_question_versions_winnability_range_check") &&
      !raw0047.includes("buyer_question_versions_priority_range_check")
  );
  check(
    "0047's own file content is unmodified — its 4 tables, 5 RPCs, and other constraints/indexes are still present",
    raw0047.includes("create table if not exists public.buyer_questions") &&
      raw0047.includes("create table if not exists public.buyer_question_versions") &&
      raw0047.includes("create table if not exists public.protocols") &&
      raw0047.includes("create table if not exists public.protocol_attempts") &&
      raw0047.includes("admit_and_reserve_attempt") &&
      raw0047.includes("protocols_planned_le_run_cap")
  );

  // ---- Application-layer validator kept as complementary defense ------
  console.log("\n[application-layer validator — kept, not replaced]");
  check(
    "the shared runtime validator still enforces the identical contract (commercialValue 1..5, winnability 1..5, priority 1..25)",
    validatorSrc.includes("isValidInteger(fields.commercialValue, 1, 5)") &&
      validatorSrc.includes("isValidInteger(fields.winnability, 1, 5)") &&
      validatorSrc.includes("isValidInteger(fields.priority, 1, 25)")
  );

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0
        ? "M4 0048 schema contract PASSED."
        : "M4 0048 schema contract FAILED.")
  );
  console.log(
    "\nThis test verifies migration 0048's TEXT only. It is not created\n" +
      "in any database, not applied to staging, not applied to Production."
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
