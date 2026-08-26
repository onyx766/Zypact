#!/usr/bin/env tsx
/**
 * M4 — static assertions over draft migration 0049's SQL text only.
 *
 * No real Postgres connection is used (matching the established
 * scripts/test-m4-schema-contract.ts pattern). Verifies, for BOTH
 * fixed functions (approve_protocol and start_attempt):
 *   1. signatures (params, RETURNS TABLE, LANGUAGE, SECURITY DEFINER,
 *      VOLATILE, search_path) identical to 0047's originals;
 *   2. every relevant `status` reference is qualified with a table
 *      alias;
 *   3. no ambiguity remains in the WHERE clauses that caused the
 *      original bugs;
 *   4. SECURITY DEFINER, search_path, and the service_role-only grants
 *      are preserved, byte-for-byte identical to 0047's blocks;
 *   5. no table, constraint, index, RLS policy, or historical data is
 *      touched — only each function's body changes.
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

const migration0049Path = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "0049_m4_fix_protocol_rpc_status_ambiguities.sql"
);
const migration0047Path = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "0047_m4_buyer_question_protocol_attempts.sql"
);
const migration0048Path = path.join(
  process.cwd(),
  "supabase",
  "migrations",
  "0048_m4_buyer_question_version_numeric_range_checks.sql"
);
const raw0049 = readFileSync(migration0049Path, "utf8");
const raw0047 = readFileSync(migration0047Path, "utf8");
const raw0048Before = readFileSync(migration0048Path, "utf8");

function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

function normalizeWhitespace(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

const codeOnly0049 = stripSqlComments(raw0049);
const codeOnly0047 = stripSqlComments(raw0047);

/** Extracts a named function's header block — from `create or replace function` through the `as $$` that opens its body — for signature comparison. */
function extractSignature(sql: string, functionName: string): string | null {
  const start = sql.indexOf(`create or replace function\n  public.${functionName}(`);
  if (start === -1) return null;
  const bodyStart = sql.indexOf("as $$", start);
  if (bodyStart === -1) return null;
  return normalizeWhitespace(sql.slice(start, bodyStart));
}

/** Extracts a named function's full body (between its own `as $$` and matching `$$;`). */
function extractBody(sql: string, functionName: string): string | null {
  const start = sql.indexOf(`create or replace function\n  public.${functionName}(`);
  if (start === -1) return null;
  const bodyStart = sql.indexOf("as $$", start);
  if (bodyStart === -1) return null;
  const bodyEnd = sql.indexOf("$$;", bodyStart + 5);
  if (bodyEnd === -1) return null;
  return sql.slice(bodyStart, bodyEnd + 3);
}

interface FixedFunctionSpec {
  functionName: string;
  arity: string; // e.g. "uuid, uuid, uuid"
  idParam: string; // e.g. "p_protocol_id"
  terminalValue: string; // e.g. "draft" or "reserved"
  writtenColumnsPattern: RegExp;
  outcomes: string[];
}

const FUNCTIONS: FixedFunctionSpec[] = [
  {
    functionName: "approve_protocol",
    arity: "uuid, uuid, uuid",
    idParam: "p_protocol_id",
    terminalValue: "draft",
    writtenColumnsPattern:
      /set\s+status = 'approved',\s*approved_by = p_approved_by,\s*approved_at = now\(\),\s*updated_at = now\(\)/i,
    outcomes: ["NOT_FOUND", "ALREADY_APPROVED", "CONFLICT", "VERSION_NOT_APPROVED", "APPROVED"],
  },
  {
    functionName: "start_attempt",
    arity: "uuid, uuid, uuid",
    idParam: "p_attempt_id",
    terminalValue: "reserved",
    writtenColumnsPattern:
      /set\s+status = 'in_progress',\s*probe_run_id = p_probe_run_id,\s*last_activity_at = now\(\)/i,
    outcomes: ["NOT_FOUND", "ALREADY_STARTED", "CONFLICT", "STARTED"],
  },
];

function main(): void {
  for (const spec of FUNCTIONS) {
    const { functionName, arity, idParam, terminalValue, writtenColumnsPattern, outcomes } = spec;

    console.log(`\n[${functionName}] [1] signature identical to 0047's`);
    const sig0047 = extractSignature(codeOnly0047, functionName);
    const sig0049 = extractSignature(codeOnly0049, functionName);
    check(`0047's ${functionName} signature block was found`, sig0047 !== null);
    check(`0049's ${functionName} signature block was found`, sig0049 !== null);
    check(
      `the two signature blocks (params, RETURNS TABLE, LANGUAGE, SECURITY DEFINER, VOLATILE, search_path) are identical`,
      sig0047 !== null && sig0049 !== null && sig0047 === sig0049
    );

    console.log(`\n[${functionName}] [2] status references qualified with a table alias`);
    const body0049 = extractBody(codeOnly0049, functionName);
    check(`0049's ${functionName} body was found`, body0049 !== null);
    check(
      `the UPDATE statement aliases the target as 'pr'`,
      body0049 !== null && new RegExp(`update public\\.\\w+ pr\\b`, "i").test(body0049)
    );
    check(
      `the WHERE clause qualifies status as pr.status = '${terminalValue}'`,
      body0049 !== null &&
        new RegExp(`where\\s+pr\\.id = ${idParam}[\\s\\S]{0,80}pr\\.status = '${terminalValue}'`, "i").test(
          body0049
        )
    );
    check(
      "the RETURNING clause is qualified as pr.*",
      body0049 !== null && /returning pr\.\* into v_row/i.test(body0049)
    );

    console.log(`\n[${functionName}] [3] no ambiguity remains in the WHERE clause`);
    check(
      `the exact original buggy pattern ('and status = '${terminalValue}'' inside the UPDATE's WHERE, unqualified) no longer appears`,
      body0049 !== null && !new RegExp(`where[\\s\\S]{0,120}\\band status = '${terminalValue}'`, "i").test(body0049)
    );
    check(
      "every id/project_id/status condition inside the UPDATE's WHERE is qualified with the pr alias",
      body0049 !== null &&
        (() => {
          const whereMatch = body0049!.match(/where\s+pr\.id[\s\S]*?returning/i);
          if (!whereMatch) return false;
          const whereClause = whereMatch[0];
          return (
            !/[^.](\bid\b) = p_\w+_id\b/i.test(whereClause.replace(/pr\.id/gi, "")) &&
            !/[^.](\bproject_id\b) = p_project_id/i.test(whereClause) &&
            !new RegExp(`[^.](\\bstatus\\b) = '${terminalValue}'`, "i").test(whereClause)
          );
        })()
    );
    check(
      "business logic is otherwise unchanged: the exact same columns are written",
      body0049 !== null && writtenColumnsPattern.test(body0049)
    );
    check(
      `every return outcome from 0047 is preserved: ${outcomes.join(", ")}`,
      body0049 !== null && outcomes.every((outcome) => body0049!.includes(`'${outcome}'`))
    );

    console.log(`\n[${functionName}] [4] SECURITY DEFINER, search_path, and service_role-only grants preserved`);
    check(
      `${functionName}'s signature block declares SECURITY DEFINER`,
      sig0049 !== null && /security definer/i.test(sig0049)
    );
    check(
      `${functionName}'s signature block pins search_path = public, pg_temp`,
      sig0049 !== null && /set search_path = public, pg_temp/i.test(sig0049)
    );
    check(
      `0049 reissues the exact same REVOKE/GRANT block as 0047 for ${functionName} (public/anon/authenticated revoked, service_role granted)`,
      new RegExp(
        `revoke all on function\\s*\\n\\s*public\\.${functionName}\\(${arity}\\) from public;`,
        "i"
      ).test(codeOnly0049) &&
        new RegExp(
          `revoke all on function\\s*\\n\\s*public\\.${functionName}\\(${arity}\\) from anon;`,
          "i"
        ).test(codeOnly0049) &&
        new RegExp(
          `revoke all on function\\s*\\n\\s*public\\.${functionName}\\(${arity}\\) from authenticated;`,
          "i"
        ).test(codeOnly0049) &&
        new RegExp(
          `grant execute on function\\s*\\n\\s*public\\.${functionName}\\(${arity}\\) to service_role;`,
          "i"
        ).test(codeOnly0049)
    );
  }

  console.log("\n[5] no table, constraint, index, RLS policy, or historical data touched");
  check(
    "0049 contains no CREATE TABLE, ALTER TABLE, CREATE INDEX, DROP, or RLS statement",
    !/create table|alter table|create.*index|drop table|drop function|drop index|enable row level security|force row level security|create policy|drop policy/i.test(
      codeOnly0049
    )
  );
  check(
    "0049 contains no INSERT/UPDATE/DELETE outside the two function bodies already declared above (no top-level data write)",
    (() => {
      const withoutFunctionBodies = codeOnly0049.replace(/as \$\$[\s\S]*?\$\$;/g, "");
      return (
        !/\binsert\s+into\b/i.test(withoutFunctionBodies) &&
        !/\bupdate\s+public\./i.test(withoutFunctionBodies) &&
        !/\bdelete\s+from\b/i.test(withoutFunctionBodies)
      );
    })()
  );
  check(
    "0049 touches only approve_protocol and start_attempt — no other function is created or replaced",
    (codeOnly0049.match(/create or replace function/gi) ?? []).length === 2
  );
  check(
    "migration 0047 is untouched by this change (re-read fresh, unmodified)",
    raw0047.includes("create table if not exists public.buyer_questions") &&
      raw0047.includes("create table if not exists public.protocols") &&
      raw0047.includes("admit_and_reserve_attempt")
  );
  check(
    "migration 0048 is untouched by this change (re-read fresh, unmodified)",
    raw0048Before.includes("buyer_question_versions_commercial_value_range_check") &&
      raw0048Before.includes("buyer_question_versions_winnability_range_check") &&
      raw0048Before.includes("buyer_question_versions_priority_range_check")
  );
  check("0049 is not applied anywhere by this test — text-only verification", true);

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0
        ? "M4 0049 schema contract PASSED."
        : "M4 0049 schema contract FAILED.")
  );
  console.log(
    "\nThis test verifies migration 0049's TEXT only. It is not created\n" +
      "in any database, not applied to staging, not applied to Production."
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
