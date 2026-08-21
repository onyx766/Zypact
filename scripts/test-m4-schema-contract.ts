#!/usr/bin/env tsx
/**
 * M4 — static assertions over migration 0047's SQL text only.
 *
 * No real Postgres connection is used, matching the established
 * pattern (scripts/test-m2-tranche3-schema-contract.ts). This verifies
 * the SCHEMA — tables, constraints, indexes, RLS, and RPC privileges —
 * matches the approved M4 architecture, and that it never touches
 * M1/M2/M3 tables, RPCs, or migrations 0041-0046.
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
  "0047_m4_buyer_question_protocol_attempts.sql"
);
const raw = readFileSync(migrationPath, "utf8");

function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

const codeOnly = stripSqlComments(raw);
const codeOnlyLower = codeOnly.toLowerCase();

function staticChecks(): void {
  console.log("\n[static — migration 0047 text]");

  // ---- Scope: no data written, M1/M2/M3 untouched ----------------------
  check(
    "no INSERT INTO statement outside a function body — this migration seeds no data itself (RPC bodies' own controlled ledger writes are expected and covered by the RPC-specific checks below)",
    (() => {
      const withoutFunctionBodies = codeOnly.replace(/as \$\$[\s\S]*?\$\$;/g, "");
      return !/insert\s+into/i.test(withoutFunctionBodies);
    })()
  );
  check(
    "no bare UPDATE ... SET outside a function body (RPC bodies contain their own controlled UPDATEs)",
    (() => {
      // Strip every function body ($$ ... $$) before checking for a
      // top-level UPDATE — the RPCs' own guarded UPDATEs are expected
      // and covered by the RPC-specific checks below.
      const withoutFunctionBodies = codeOnly.replace(/as \$\$[\s\S]*?\$\$;/g, "");
      return !/update\s+public\.\w+\s+set\b/i.test(withoutFunctionBodies);
    })()
  );
  check(
    "does not touch entity_observations, entity_aliases, or canonical_entities",
    !/\bentity_observations\b/i.test(codeOnly) &&
      !/\bentity_aliases\b/i.test(codeOnly) &&
      !/\bcanonical_entities\b/i.test(codeOnly)
  );
  check(
    "does not touch generated_prompts, probe_runs (except a plain FK reference), or probe_results",
    !/alter table public\.generated_prompts/i.test(codeOnlyLower) &&
      !/alter table public\.probe_runs/i.test(codeOnlyLower) &&
      !/alter table public\.probe_results/i.test(codeOnlyLower)
  );
  check(
    "references probe_runs only as a plain foreign key target for protocol_attempts.probe_run_id, nullable",
    /probe_run_id\s+uuid null references public\.probe_runs \(id\)/i.test(
      codeOnlyLower
    )
  );

  // ---- 1. buyer_questions -------------------------------------------
  check(
    "buyer_questions table created with project_id FK to projects",
    codeOnly.includes("create table if not exists public.buyer_questions") &&
      /project_id\s+uuid not null references public\.projects/i.test(codeOnly)
  );
  check(
    "buyer_questions RLS enabled with no FORCE",
    codeOnly.includes("alter table public.buyer_questions enable row level security") &&
      codeOnly.includes("alter table public.buyer_questions no force row level security")
  );

  // ---- 2. buyer_question_versions ------------------------------------
  check(
    "buyer_question_versions table created",
    codeOnly.includes("create table if not exists public.buyer_question_versions")
  );
  check(
    "prompt_text and prompt_hash are both required non-empty",
    /prompt_text\s+text not null check \(btrim\(prompt_text\) <> ''\)/i.test(codeOnlyLower) &&
      /prompt_hash\s+text not null check \(btrim\(prompt_hash\) <> ''\)/i.test(codeOnlyLower)
  );
  check(
    "provenance is constrained to exactly the five approved values",
    /provenance in \(\s*'customer_supplied', 'crm_evidence', 'founder_supplied',\s*'model_assisted_reviewed', 'public_benchmark'\s*\)/i.test(
      codeOnly.replace(/\n\s*/g, " ")
    )
  );
  check(
    "version_number is unique per buyer_question_id — a text change is always a new row",
    codeOnly.includes("buyer_question_versions_number_key") &&
      codeOnly.includes("unique (buyer_question_id, version_number)")
  );
  check(
    "approval columns travel together (both null or both set)",
    codeOnly.includes("buyer_question_versions_approval_pair_check")
  );
  check(
    "buyer_question_versions gets INSERT but the approval RPC is the only path to approved_by/approved_at — no UPDATE grant at all",
    /grant select, insert on table public\.buyer_question_versions to service_role/i.test(
      codeOnlyLower
    ) &&
      !/grant\s+update\s+.*buyer_question_versions/i.test(codeOnly)
  );

  // ---- 3. protocols ----------------------------------------------------
  check(
    "protocols table created",
    codeOnly.includes("create table if not exists public.protocols")
  );
  check(
    "Rule 4: run_cap can never be smaller than planned_baseline_runs + planned_retest_runs",
    codeOnly.includes("protocols_planned_le_run_cap") &&
      codeOnly.includes("run_cap >= planned_baseline_runs + planned_retest_runs")
  );
  check(
    "no universal default exists for planned_baseline_runs/planned_retest_runs/run_cap/spend_cap_usd — every one is a bare NOT NULL, no DEFAULT clause",
    !/planned_baseline_runs\s+integer not null default/i.test(codeOnlyLower) &&
      !/planned_retest_runs\s+integer not null default/i.test(codeOnlyLower) &&
      !/run_cap\s+integer not null default/i.test(codeOnlyLower) &&
      !/spend_cap_usd\s+numeric not null default/i.test(codeOnlyLower)
  );
  check(
    "status is exactly draft/approved/active/completed/abandoned",
    codeOnly.includes(
      "check (status in ('draft', 'approved', 'active', 'completed', 'abandoned'))"
    )
  );
  check(
    "one live (approved/active) protocol per buyer_question_version — the 1:1 product rule",
    codeOnly.includes("protocols_one_active_per_version") &&
      codeOnly.includes("on public.protocols (buyer_question_version_id)") &&
      codeOnly.includes("where status in ('approved', 'active')")
  );
  check(
    "protocols gets INSERT but status transitions are RPC-only — no UPDATE grant at all",
    /grant select, insert on table public\.protocols to service_role/i.test(codeOnlyLower) &&
      !/grant\s+update\s+.*protocols\b/i.test(codeOnly)
  );
  check(
    "paraphrase_plan defaults to an empty jsonb array — Rule 2's declared-variant list, never auto-populated",
    /paraphrase_plan\s+jsonb not null default '\[\]'::jsonb/i.test(codeOnlyLower)
  );

  // ---- 4. protocol_attempts — RPC-only in every direction -------------
  check(
    "protocol_attempts table created",
    codeOnly.includes("create table if not exists public.protocol_attempts")
  );
  check(
    "status is exactly the seven canonical attempt states — no won/partial/lost anywhere in this table",
    codeOnly.includes(
      "check (status in (\n                                 'reserved', 'in_progress', 'completed', 'failed',\n                                 'timed_out', 'cancelled', 'excluded'\n                               ))"
    ) ||
      (codeOnly.includes("'reserved', 'in_progress', 'completed', 'failed'") &&
        codeOnly.includes("'timed_out', 'cancelled', 'excluded'"))
  );
  check(
    "no legacy verdict vocabulary anywhere in this migration",
    !/\bwon\b/i.test(codeOnly) &&
      !/\bpartial\b/i.test(codeOnly) &&
      !/\blost\b/i.test(codeOnly)
  );
  check(
    "Rule 11: at most one non-terminal (reserved/in_progress) attempt per (protocol_id, idempotency_key)",
    codeOnly.includes("protocol_attempts_active_idempotency_key") &&
      codeOnly.includes("on public.protocol_attempts (protocol_id, idempotency_key)") &&
      codeOnly.includes("where status in ('reserved', 'in_progress')")
  );
  check(
    "protocol_attempts is RPC-only in every direction — no INSERT/UPDATE grant at all, SELECT only",
    /revoke all on table public\.protocol_attempts from public, anon, authenticated, service_role/i.test(
      codeOnlyLower
    ) &&
      /grant select on table public\.protocol_attempts to service_role/i.test(codeOnlyLower) &&
      !/grant\s+(insert|update)\s+.*protocol_attempts/i.test(codeOnly)
  );
  check(
    "terminal-state pairing: terminalized_at/actual_cost_usd null iff status is reserved/in_progress",
    codeOnly.includes("protocol_attempts_terminal_pair_check")
  );

  // ---- 5. RPCs — SECURITY DEFINER, search_path pinned, service_role-only
  const rpcNames = [
    "approve_buyer_question_version",
    "approve_protocol",
    "admit_and_reserve_attempt",
    "start_attempt",
    "reconcile_attempt",
  ];
  for (const name of rpcNames) {
    const fnMatch = codeOnly.match(
      new RegExp(`create or replace function\\s+public\\.${name}\\(`, "i")
    );
    check(`${name}: function is created`, Boolean(fnMatch));

    const start = codeOnly.search(
      new RegExp(`create or replace function\\s+public\\.${name}\\(`, "i")
    );
    const nextFnIdx = codeOnly
      .slice(start + 1)
      .search(/create or replace function/i);
    const body =
      start === -1
        ? ""
        : nextFnIdx === -1
          ? codeOnly.slice(start)
          : codeOnly.slice(start, start + 1 + nextFnIdx);

    check(
      `${name}: SECURITY DEFINER with search_path pinned`,
      /security definer/i.test(body) &&
        /set search_path = public, pg_temp/i.test(body)
    );
    check(
      `${name}: EXECUTE revoked from public/anon/authenticated, granted to service_role only`,
      new RegExp(
        `revoke all on function\\s+public\\.${name}\\([^)]*\\) from public`,
        "i"
      ).test(codeOnly) &&
        new RegExp(
          `revoke all on function\\s+public\\.${name}\\([^)]*\\) from anon`,
          "i"
        ).test(codeOnly) &&
        new RegExp(
          `revoke all on function\\s+public\\.${name}\\([^)]*\\) from authenticated`,
          "i"
        ).test(codeOnly) &&
        new RegExp(
          `grant execute on function\\s+public\\.${name}\\([^)]*\\) to service_role`,
          "i"
        ).test(codeOnly)
    );
  }

  check(
    "admit_and_reserve_attempt locks the protocol row FOR UPDATE before any check — Rule 9",
    (() => {
      const start = codeOnly.search(
        /create or replace function\s+public\.admit_and_reserve_attempt\(/i
      );
      const body = codeOnly.slice(start, start + 2000);
      const lockIdx = body.search(/for update/i);
      const firstCheckIdx = body.search(/protocol_not_approved|already_reserved/i);
      return lockIdx !== -1 && (firstCheckIdx === -1 || lockIdx < firstCheckIdx);
    })()
  );
  check(
    "admit_and_reserve_attempt checks idempotency before every cap — Rule 11 takes priority over cap rejection",
    (() => {
      const start = codeOnly.search(
        /create or replace function\s+public\.admit_and_reserve_attempt\(/i
      );
      const body = codeOnly.slice(start, start + 4000);
      const idempIdx = body.search(/already_reserved/i);
      const capIdx = body.search(/run_cap_exceeded/i);
      return idempIdx !== -1 && capIdx !== -1 && idempIdx < capIdx;
    })()
  );
  check(
    "reconcile_attempt requires a non-null actual_cost_usd — Rule 13, real cost always reconciled",
    (() => {
      const start = codeOnly.search(
        /create or replace function\s+public\.reconcile_attempt\(/i
      );
      const body = codeOnly.slice(start, start + 1500);
      return /p_actual_cost_usd is null/i.test(body);
    })()
  );
  check(
    "start_attempt only transitions from 'reserved' — never from any other status",
    (() => {
      const start = codeOnly.search(
        /create or replace function\s+public\.start_attempt\(/i
      );
      const body = codeOnly.slice(start, start + 1500);
      return /status = 'reserved'/i.test(body);
    })()
  );
}

function main(): void {
  staticChecks();
  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0
        ? "M4 schema contract PASSED."
        : "M4 schema contract FAILED.")
  );
  console.log(
    "\nThis test verifies migration 0047's TEXT only. It is not created\n" +
      "in any database, not applied to staging, not applied to Production."
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
