#!/usr/bin/env tsx
/**
 * M5 — static assertions over draft migration 0050's SQL text only.
 *
 * No real Postgres connection is used (matching the established
 * scripts/test-m4-schema-contract.ts / test-m4-0049-approve-protocol-fix-
 * schema-contract.ts pattern). Verifies the SCHEMA and RPC contract of
 * the Option B+ design — protocol_execution_jobs, protocol_external_calls,
 * provider_call_receipts, analysis_call_receipts, protocol_operator_actions,
 * protocol_attempts.job_id, the private admission core, every fenced
 * _for_job RPC, the two-branch operator RPC, and the ACL revocations on
 * the raw M4 RPCs — against the final consolidated design.
 *
 * This file is TEXT-only verification. It does not connect to any
 * database, does not apply any migration, and does not touch staging or
 * Production.
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

const migrationsDir = path.join(process.cwd(), "supabase", "migrations");
const path0050 = path.join(migrationsDir, "0050_m5_protocol_execution_jobs_and_external_call_ledger.sql");
const path0047 = path.join(migrationsDir, "0047_m4_buyer_question_protocol_attempts.sql");
const path0048 = path.join(migrationsDir, "0048_m4_buyer_question_version_numeric_range_checks.sql");
const path0049 = path.join(migrationsDir, "0049_m4_fix_protocol_rpc_status_ambiguities.sql");

const raw0050 = readFileSync(path0050, "utf8");
const raw0047 = readFileSync(path0047, "utf8");
const raw0048 = readFileSync(path0048, "utf8");
const raw0049 = readFileSync(path0049, "utf8");

function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

const code = stripSqlComments(raw0050);
const codeLower = code.toLowerCase();

/** Strips every `as $$ ... $$;` function body, leaving only top-level DDL/DML. */
function withoutFunctionBodies(sql: string): string {
  return sql.replace(/as \$\$[\s\S]*?\$\$;/g, "");
}

/** Extracts a named function's full body (between its own `as $$` and matching `$$;`). */
function extractBody(sql: string, functionName: string): string | null {
  const start = sql.indexOf(`public.${functionName}(`);
  if (start === -1) return null;
  const bodyStart = sql.indexOf("as $$", start);
  if (bodyStart === -1) return null;
  const bodyEnd = sql.indexOf("$$;", bodyStart + 5);
  if (bodyEnd === -1) return null;
  return sql.slice(bodyStart, bodyEnd + 3);
}

function main(): void {
  // ------------------------------------------------------------------
  // [1] Exact presence of tables, columns, constraints, indexes.
  // ------------------------------------------------------------------
  console.log("\n[1] tables / columns / constraints / indexes — exact presence");

  const newTables = [
    "protocol_execution_jobs",
    "protocol_external_calls",
    "provider_call_receipts",
    "analysis_call_receipts",
    "protocol_operator_actions",
  ];
  for (const t of newTables) {
    check(`creates table ${t}`, new RegExp(`create table if not exists public\\.${t} \\(`).test(code));
  }

  check(
    "protocol_execution_jobs has every required column",
    [
      "id", "project_id", "protocol_id", "status", "worker_id", "claim_token",
      "lease_expires_at", "attempt_count", "max_attempts", "needs_review_reason",
      "failure_reason", "created_at", "updated_at",
    ].every((col) => new RegExp(`\\b${col}\\b`).test(code.slice(code.indexOf("create table if not exists public.protocol_execution_jobs"), code.indexOf("create table if not exists public.protocol_external_calls"))))
  );

  check(
    "protocol_external_calls has every required column",
    [
      "id", "project_id", "protocol_attempt_id", "call_kind", "generation", "status",
      "reserved_cost_usd", "actual_cost_usd", "cost_basis", "probe_run_id",
      "request_sent_at", "terminalized_at", "created_at",
    ].every((col) => new RegExp(`\\b${col}\\b`).test(code.slice(code.indexOf("create table if not exists public.protocol_external_calls"), code.indexOf("create table if not exists public.provider_call_receipts"))))
  );

  check(
    "provider_call_receipts has every required column",
    [
      "id", "project_id", "external_call_id", "probe_run_id", "outcome", "http_status",
      "provider_request_id", "raw_response_sha256", "latency_ms", "received_at", "created_at",
    ].every((col) => new RegExp(`\\b${col}\\b`).test(code.slice(code.indexOf("create table if not exists public.provider_call_receipts"), code.indexOf("create table if not exists public.analysis_call_receipts"))))
  );

  check(
    "analysis_call_receipts has every required column, including probe_run_id (absent from analysis_llm_calls but required here)",
    [
      "id", "project_id", "external_call_id", "probe_run_id", "outcome", "provider",
      "model", "used_mock", "request_sha256", "response_sha256", "latency_ms",
      "received_at", "created_at",
    ].every((col) => new RegExp(`\\b${col}\\b`).test(code.slice(code.indexOf("create table if not exists public.analysis_call_receipts"), code.indexOf("create table if not exists public.protocol_operator_actions"))))
  );

  check(
    "protocol_operator_actions has every required column",
    [
      "id", "project_id", "job_id", "actor", "reason", "action", "outcome",
      "denial_code", "new_attempt_id", "new_external_call_id", "created_at",
    ].every((col) => new RegExp(`\\b${col}\\b`).test(code.slice(code.indexOf("create table if not exists public.protocol_operator_actions"), code.indexOf("protocol_attempts.job_id"))))
  );

  const expectedConstraints = [
    "probe_runs_id_project_key",
    "protocol_execution_jobs_id_project_key",
    "protocol_execution_jobs_protocol_id_key",
    "protocol_execution_jobs_protocol_project_fk",
    "protocol_execution_jobs_claim_fields_check",
    "protocol_external_calls_id_project_key",
    "protocol_external_calls_attempt_project_fk",
    "protocol_external_calls_attempt_kind_generation_key",
    "protocol_external_calls_perplexity_single_generation_check",
    "protocol_external_calls_cost_basis_pair_check",
    "protocol_external_calls_terminal_pair_check",
    "protocol_external_calls_probe_run_lifecycle_check",
    "provider_call_receipts_external_call_key",
    "provider_call_receipts_external_call_project_fk",
    "provider_call_receipts_probe_run_project_fk",
    "analysis_call_receipts_external_call_key",
    "analysis_call_receipts_external_call_project_fk",
    "analysis_call_receipts_probe_run_project_fk",
    "protocol_operator_actions_job_project_fk",
    "protocol_operator_actions_denial_pair_check",
    "protocol_attempts_job_project_fk",
  ];
  for (const c of expectedConstraints) {
    check(`declares constraint ${c}`, code.includes(c));
  }

  const expectedIndexes = [
    "protocol_execution_jobs_project_idx",
    "protocol_execution_jobs_status_lease_idx",
    "protocol_external_calls_project_idx",
    "provider_call_receipts_project_idx",
    "analysis_call_receipts_project_idx",
    "protocol_operator_actions_project_idx",
    "protocol_operator_actions_job_idx",
    "protocol_attempts_job_idx",
  ];
  for (const i of expectedIndexes) {
    check(`declares index ${i}`, code.includes(i));
  }

  // ------------------------------------------------------------------
  // [2] Backward compatibility: protocol_attempts.job_id nullable, no backfill.
  // ------------------------------------------------------------------
  console.log("\n[2] protocol_attempts.job_id — nullable, no backfill of the 4 real staging rows");

  check(
    "adds job_id as a nullable column (no NOT NULL, no default forcing a value)",
    /alter table public\.protocol_attempts add column if not exists job_id uuid null;/.test(code)
  );
  check(
    "job_id is the ONLY new column added to protocol_attempts",
    (code.match(/alter table public\.protocol_attempts add column/g) ?? []).length === 1
  );
  check(
    "no UPDATE statement ever sets protocol_attempts.job_id (no backfill of the 4 historical staging rows)",
    !/update\s+public\.protocol_attempts[\s\S]{0,400}set[\s\S]{0,200}job_id\s*=/i.test(code)
  );
  check(
    "no new NOT NULL / CHECK constraint is added on protocol_attempts beyond the job_id FK itself",
    !/alter table public\.protocol_attempts[\s\S]{0,20}add constraint[\s\S]{0,80}check\(/i.test(code) &&
      !/alter table public\.protocol_attempts alter column/i.test(code)
  );

  // ------------------------------------------------------------------
  // [3] No top-level DML on existing data.
  // ------------------------------------------------------------------
  console.log("\n[3] no top-level DML on existing data — only RPC-body-internal, guarded writes");

  const ddlOnly = withoutFunctionBodies(code);
  check(
    "no top-level INSERT/UPDATE/DELETE outside a function body",
    !/\binsert\s+into\b/i.test(ddlOnly) &&
      !/\bupdate\s+public\./i.test(ddlOnly) &&
      !/\bdelete\s+from\b/i.test(ddlOnly)
  );
  check(
    "every ALTER TABLE is additive (add column/add constraint) — no DROP COLUMN, DROP CONSTRAINT, or TYPE change",
    !/drop column|drop constraint|alter column .* type/i.test(ddlOnly)
  );

  // ------------------------------------------------------------------
  // [4] Consistent statuses — exact enums, no legacy values leaking in.
  // ------------------------------------------------------------------
  console.log("\n[4] status enums — exact, no drift");

  check(
    "protocol_execution_jobs.status is exactly the 7-value job state machine",
    /check \(status in \(\s*'queued', 'claimed', 'running', 'succeeded',\s*'failed', 'needs_review', 'abandoned_exhausted'\s*\)\)/.test(
      code
    )
  );
  check(
    "protocol_external_calls.status is exactly the 6-value external-call state machine",
    /check \(status in \(\s*'reserved', 'in_progress', 'completed',\s*'failed', 'timed_out', 'cancelled'\s*\)\)/.test(
      code
    )
  );
  check(
    "'excluded' never appears as a protocol_external_calls status value (it remains a protocol_attempts-only, 0047-inherited value)",
    !/protocol_external_calls[\s\S]{0,600}'excluded'/i.test(code)
  );
  check(
    "reconcile_attempt_for_job validates against the unchanged 5-value protocol_attempts status enum from 0047",
    (() => {
      const body = extractBody(code, "reconcile_attempt_for_job");
      return body !== null && /'completed', 'failed', 'timed_out', 'cancelled', 'excluded'/.test(body);
    })()
  );
  check(
    "provider_call_receipts / analysis_call_receipts outcome is exactly success/provider_error/provider_outcome_unknown",
    (code.match(/check \(outcome in \('success', 'provider_error', 'provider_outcome_unknown'\)\)/g) ?? []).length >= 2
  );
  check(
    "provider_outcome_unknown always maps to 'timed_out', never 'excluded' or 'failed', in both receipt RPCs",
    (() => {
      const perplexity = extractBody(code, "record_provider_call_receipt_for_job");
      const analysis = extractBody(code, "record_analysis_call_receipt_for_job");
      const mapsCorrectly = (b: string | null) =>
        b !== null &&
        /when 'success' then 'completed'/.test(b) &&
        /when 'provider_error' then 'failed'/.test(b) &&
        /else 'timed_out'/.test(b);
      return mapsCorrectly(perplexity) && mapsCorrectly(analysis);
    })()
  );

  // ------------------------------------------------------------------
  // [5] Atomic three-row admission.
  // ------------------------------------------------------------------
  console.log("\n[5] admission atomique — 3 lignes (attempt + 2 external_calls), somme des réservations");

  check(
    "_admit_and_reserve_attempt_core's final INSERT includes job_id in the same statement as reserved_cost_usd (no later UPDATE)",
    (() => {
      const body = extractBody(code, "_admit_and_reserve_attempt_core");
      return (
        body !== null &&
        /insert into public\.protocol_attempts \([\s\S]*?job_id[\s\S]*?\)/.test(body) &&
        /reserved_cost_usd/.test(body)
      );
    })()
  );
  check(
    "_create_attempt_external_calls_core inserts exactly 2 rows (perplexity generation 1, analysis generation 1)",
    (() => {
      const body = extractBody(code, "_create_attempt_external_calls_core");
      return (
        body !== null &&
        (body.match(/insert into public\.protocol_external_calls/g) ?? []).length === 2 &&
        /'perplexity', 1, 'reserved'/.test(body) &&
        /'analysis', 1, 'reserved'/.test(body)
      );
    })()
  );
  check(
    "admit_and_reserve_attempt_for_job passes the SUM of the two reservations as the core's estimated cost",
    (() => {
      const body = extractBody(code, "admit_and_reserve_attempt_for_job");
      return body !== null && /p_perplexity_reserved_cost_usd \+ p_analysis_reserved_cost_usd/.test(body);
    })()
  );
  check(
    "admit_and_reserve_attempt_for_job calls the core THEN creates the two external-call rows only on RESERVED (no rows created on a cap refusal)",
    (() => {
      const body = extractBody(code, "admit_and_reserve_attempt_for_job");
      if (body === null) return false;
      const coreIdx = body.indexOf("_admit_and_reserve_attempt_core");
      const guardIdx = body.indexOf("v_core.status <> 'RESERVED'");
      const callsIdx = body.indexOf("_create_attempt_external_calls_core");
      return coreIdx !== -1 && guardIdx !== -1 && callsIdx !== -1 && coreIdx < guardIdx && guardIdx < callsIdx;
    })()
  );
  check(
    "authorize_operator_retry's retry_full_attempt branch performs the identical core → create-external-calls sequence",
    (() => {
      const body = extractBody(code, "authorize_operator_retry");
      return (
        body !== null &&
        /_admit_and_reserve_attempt_core/.test(body) &&
        /_create_attempt_external_calls_core/.test(body)
      );
    })()
  );

  // ------------------------------------------------------------------
  // [6] Cost constraints — reservation never recorded as actual cost.
  // ------------------------------------------------------------------
  console.log("\n[6] contraintes de coût — measured/estimated/unknown, jamais reserved copié en actual");

  check(
    "cost_basis pairing CHECK: actual_cost_usd and cost_basis are always both null or both non-null",
    /\(actual_cost_usd is null and cost_basis is null\)\s*\n\s*or \(actual_cost_usd is not null and cost_basis is not null\)/.test(
      code
    )
  );
  check(
    "cost_basis is restricted to measured/estimated when present",
    /check \(cost_basis is null or cost_basis in \('measured', 'estimated'\)\)/.test(code)
  );
  check(
    "no code path ever assigns actual_cost_usd := reserved_cost_usd (a reservation is never recorded as an actual cost)",
    !/actual_cost_usd\s*:?=\s*.*reserved_cost_usd/i.test(code)
  );
  check(
    "reconcile_attempt_for_job requires ALL of the attempt's external calls to be terminal before reconciling",
    (() => {
      const body = extractBody(code, "reconcile_attempt_for_job");
      return body !== null && /EXTERNAL_CALLS_NOT_TERMINAL/.test(body) && /status in \('reserved', 'in_progress'\)/.test(body);
    })()
  );
  check(
    "reconcile_attempt_for_job sets the attempt's actual_cost_usd to NULL whenever any terminal external call has an unknown cost (bool_or(actual_cost_usd is null))",
    (() => {
      const body = extractBody(code, "reconcile_attempt_for_job");
      return body !== null && /bool_or\(actual_cost_usd is null\)/.test(body) && /v_actual_cost_usd := null/.test(body);
    })()
  );
  check(
    "reconcile_attempt_for_job does NOT call reconcile_attempt (0047) — it implements its own UPDATE, per the non-delegation mandate",
    (() => {
      const body = extractBody(code, "reconcile_attempt_for_job");
      return body !== null && !/public\.reconcile_attempt\(/.test(body);
    })()
  );
  check(
    "spend-cap arithmetic in the additional-analysis-generation core falls back to reserved_cost_usd when actual_cost_usd is unknown (coalesce)",
    (() => {
      const body = extractBody(code, "_reserve_additional_analysis_generation_core");
      return body !== null && /coalesce\(pa2\.actual_cost_usd, pa2\.reserved_cost_usd\)/.test(body);
    })()
  );
  check(
    "each additional analysis generation is bounded by retry_cap + 1",
    (() => {
      const body = extractBody(code, "_reserve_additional_analysis_generation_core");
      return body !== null && /v_next_generation > v_protocol\.retry_cap \+ 1/.test(body);
    })()
  );
  check(
    "Perplexity is structurally bounded to generation 1 only (single-generation CHECK, never a second generation)",
    /call_kind <> 'perplexity' or generation = 1/.test(code)
  );

  // Defensive guard: _reserve_additional_analysis_generation_core must
  // not let any cap comparison run against a NULL v_protocol.
  const reserveGenerationCoreBody = extractBody(code, "_reserve_additional_analysis_generation_core");
  check(
    "_reserve_additional_analysis_generation_core: IF NOT FOUND sits immediately after the protocols SELECT ... FOR UPDATE — only comment/blank lines may separate them, no other statement",
    reserveGenerationCoreBody !== null &&
      /select p\.\* into v_protocol\s*\n\s*from public\.protocols p\s*\n\s*where p\.id = v_attempt\.protocol_id and p\.project_id = p_project_id\s*\n\s*for update;\s*\n(?:\s*--[^\n]*\n)*\s*if not found then/.test(
        reserveGenerationCoreBody
      )
  );
  check(
    "_reserve_additional_analysis_generation_core: the guard returns the exact, deterministic, closed status PROTOCOL_NOT_FOUND",
    reserveGenerationCoreBody !== null &&
      /if not found then\s*\n\s*return query select 'PROTOCOL_NOT_FOUND'::text, null::public\.protocol_external_calls;\s*\n\s*return;\s*\n\s*end if;/.test(
        reserveGenerationCoreBody
      )
  );
  check(
    "_reserve_additional_analysis_generation_core: the guard's `return;` unconditionally exits the function — no cap comparison (retry_cap / spend_cap_usd) or INSERT can execute afterward for this path",
    reserveGenerationCoreBody !== null &&
      (() => {
        const guardIdx = reserveGenerationCoreBody.indexOf("PROTOCOL_NOT_FOUND");
        const retryCapIdx = reserveGenerationCoreBody.indexOf("v_next_generation > v_protocol.retry_cap");
        const spendCapIdx = reserveGenerationCoreBody.indexOf("v_spent + p_reserved_cost_usd > v_protocol.spend_cap_usd");
        const insertIdx = reserveGenerationCoreBody.indexOf("insert into public.protocol_external_calls");
        return (
          guardIdx !== -1 &&
          retryCapIdx !== -1 &&
          spendCapIdx !== -1 &&
          insertIdx !== -1 &&
          guardIdx < retryCapIdx &&
          guardIdx < spendCapIdx &&
          guardIdx < insertIdx
        );
      })()
  );

  // ------------------------------------------------------------------
  // [7] probe_run_id — conditional lifecycle.
  // ------------------------------------------------------------------
  console.log("\n[7] probe_run_id — nullable en reserved, obligatoire dès request_sent_at, obligatoire pour tout reçu");

  check(
    "probe_run_id is nullable on protocol_external_calls",
    /probe_run_id\s+uuid null references public\.probe_runs/.test(code)
  );
  check(
    "table CHECK enforces probe_run_id not null whenever request_sent_at is set",
    /request_sent_at is null or probe_run_id is not null/.test(code)
  );
  check(
    "probe_run_id is NOT NULL on both receipt tables (mandatory for any receipt)",
    (() => {
      const providerTable = code.slice(
        code.indexOf("create table if not exists public.provider_call_receipts"),
        code.indexOf("create table if not exists public.analysis_call_receipts")
      );
      const analysisTable = code.slice(
        code.indexOf("create table if not exists public.analysis_call_receipts"),
        code.indexOf("create table if not exists public.protocol_operator_actions")
      );
      return (
        /probe_run_id\s+uuid not null references public\.probe_runs/.test(providerTable) &&
        /probe_run_id\s+uuid not null references public\.probe_runs/.test(analysisTable)
      );
    })()
  );
  check(
    "the probe_run_id ↔ external-call association happens only inside mark_external_call_sent_for_job (a fenced RPC), never a raw UPDATE elsewhere",
    (() => {
      const body = extractBody(code, "mark_external_call_sent_for_job");
      const outsideBody = code.replace(body ?? "", "");
      return (
        body !== null &&
        /probe_run_id = p_probe_run_id/.test(body) &&
        !/update public\.protocol_external_calls[\s\S]{0,200}probe_run_id = p_probe_run_id/.test(
          outsideBody.replace(/mark_external_call_sent_for_job/g, "")
        )
      );
    })()
  );
  check(
    "mark_external_call_sent_for_job sets probe_run_id and request_sent_at in the SAME UPDATE statement",
    (() => {
      const body = extractBody(code, "mark_external_call_sent_for_job");
      return (
        body !== null &&
        /set\s+status = 'in_progress',\s*probe_run_id = p_probe_run_id,\s*request_sent_at = now\(\)/.test(body)
      );
    })()
  );

  // ------------------------------------------------------------------
  // [8] Total job uniqueness — one baseline job per protocol, ever.
  // ------------------------------------------------------------------
  console.log("\n[8] UNIQUE(protocol_id) totale — jamais partielle, reclaim/reactivate sur la même ligne");

  check(
    "protocol_execution_jobs_protocol_id_key is a TOTAL unique constraint (not a partial/filtered index)",
    /add constraint protocol_execution_jobs_protocol_id_key unique \(protocol_id\);/.test(code)
  );
  check(
    "no partial/filtered unique index exists on protocol_execution_jobs.protocol_id (no WHERE clause narrowing it to active statuses)",
    !/create unique index[\s\S]{0,120}protocol_execution_jobs[\s\S]{0,120}protocol_id\)[\s\S]{0,40}where/i.test(code)
  );
  check(
    "reactivate_abandoned_job reactivates the SAME job row (UPDATE by id, never an INSERT of a new job row)",
    (() => {
      const body = extractBody(code, "reactivate_abandoned_job");
      return body !== null && /update public\.protocol_execution_jobs/.test(body) && !/insert into public\.protocol_execution_jobs/.test(body);
    })()
  );
  check(
    "reactivate_abandoned_job never touches protocol_attempts or protocol_external_calls",
    (() => {
      const body = extractBody(code, "reactivate_abandoned_job");
      return body !== null && !/protocol_attempts/.test(body) && !/protocol_external_calls/.test(body);
    })()
  );
  check(
    "authorize_operator_retry re-queues the SAME job (UPDATE by id) rather than creating a new job row",
    (() => {
      const body = extractBody(code, "authorize_operator_retry");
      return (
        body !== null &&
        /update public\.protocol_execution_jobs\s*\n\s*set status = 'queued'/.test(body) &&
        !/insert into public\.protocol_execution_jobs/.test(body)
      );
    })()
  );

  // ------------------------------------------------------------------
  // [9] Fencing inside every worker-facing RPC.
  // ------------------------------------------------------------------
  console.log("\n[9] fencing — job_id + claim_token exact + lease non expiré + project_id, dans chaque RPC");

  const fencedRpcs = [
    "renew_protocol_execution_job_lease",
    "admit_and_reserve_attempt_for_job",
    "start_attempt_for_job",
    "reserve_additional_analysis_generation_for_job",
    "mark_external_call_sent_for_job",
    "record_provider_call_receipt_for_job",
    "record_analysis_call_receipt_for_job",
    "reconcile_attempt_for_job",
    "complete_protocol_execution_job",
    "fail_protocol_execution_job",
  ];
  for (const fn of fencedRpcs) {
    check(
      `${fn} verifies claim_token + lease_expires_at + status before mutating anything`,
      (() => {
        const body = extractBody(code, fn);
        return (
          body !== null &&
          /claim_token is distinct from p_claim_token/.test(body) &&
          /lease_expires_at is null or v_job\.lease_expires_at <= now\(\)/.test(body) &&
          /status not in \('claimed', 'running'\)/.test(body) &&
          /JOB_NOT_OWNED/.test(body)
        );
      })()
    );
  }
  check(
    "an old worker whose lease already expired cannot even renew its own lease (renew re-checks lease_expires_at <= now() before extending)",
    (() => {
      const body = extractBody(code, "renew_protocol_execution_job_lease");
      return body !== null && /lease_expires_at <= now\(\)/.test(body);
    })()
  );
  check(
    "the claim RPC sweeps expired+exhausted running jobs to abandoned_exhausted BEFORE selecting a claimable candidate, in the same transaction",
    (() => {
      const body = extractBody(code, "claim_protocol_execution_job");
      if (body === null) return false;
      const sweepIdx = body.indexOf("abandoned_exhausted");
      const selectIdx = body.indexOf("for update skip locked");
      return sweepIdx !== -1 && selectIdx !== -1 && sweepIdx < selectIdx;
    })()
  );
  check(
    "needs_review and abandoned_exhausted are structurally excluded from the claim candidate query",
    (() => {
      const body = extractBody(code, "claim_protocol_execution_job");
      return (
        body !== null &&
        /j\.status = 'queued'/.test(body) &&
        /j\.status in \('claimed', 'running'\) and j\.lease_expires_at < now\(\) and j\.attempt_count < j\.max_attempts/.test(body) &&
        !/needs_review/.test(body) &&
        !/abandoned_exhausted' *$/.test(body.split("for update skip locked")[0] ?? "")
      );
    })()
  );

  // ------------------------------------------------------------------
  // [10] Two distinct, atomic, audited operator branches.
  // ------------------------------------------------------------------
  console.log("\n[10] authorize_operator_retry — deux branches (retry_full_attempt / retry_analysis_only)");

  check(
    "authorize_operator_retry accepts exactly the two documented actions",
    /p_action not in \('retry_full_attempt', 'retry_analysis_only'\)/.test(code)
  );
  check(
    "the retry_full_attempt branch creates a brand-new protocol_attempts row (retry_of_attempt_id-linked)",
    (() => {
      const body = extractBody(code, "authorize_operator_retry");
      return body !== null && /if p_action = 'retry_full_attempt' then/.test(body) && /p_source_attempt_id, p_job_id/.test(body);
    })()
  );
  check(
    "the retry_analysis_only branch reserves a new analysis generation under the SAME still-in_progress attempt",
    (() => {
      const body = extractBody(code, "authorize_operator_retry");
      return (
        body !== null &&
        /SOURCE_ATTEMPT_NOT_IN_PROGRESS/.test(body) &&
        /_reserve_additional_analysis_generation_core/.test(body)
      );
    })()
  );
  check(
    "a cap refusal in either branch is recorded with outcome='denied' and a denial_code, and creates NO reservation",
    (() => {
      const body = extractBody(code, "authorize_operator_retry");
      return body !== null && (body.match(/'denied', v_\w+\.status/g) ?? []).length === 2;
    })()
  );
  check(
    "an approved outcome in either branch transitions the job needs_review -> queued (retry_full_attempt's UPDATE also carries the current_attempt_id pointer replacement; retry_analysis_only's stays single-line, unchanged)",
    (() => {
      const body = extractBody(code, "authorize_operator_retry");
      if (body === null) return false;
      const fullAttemptForm =
        /set status = 'queued',\s*\n\s*needs_review_reason = null,\s*\n\s*current_attempt_id = \(v_core\.attempt\)\.id,\s*\n\s*updated_at = now\(\)/.test(
          body
        );
      const analysisOnlyForm = /set status = 'queued', needs_review_reason = null, updated_at = now\(\)/.test(body);
      return fullAttemptForm && analysisOnlyForm;
    })()
  );
  check(
    "authorize_operator_retry requires a non-empty actor and reason before doing anything",
    /p_actor is null or btrim\(p_actor\) = ''[\s\S]{0,80}p_reason is null or btrim\(p_reason\) = ''/.test(code)
  );

  // ------------------------------------------------------------------
  // [11] RLS / ACL / revocations.
  // ------------------------------------------------------------------
  console.log("\n[11] RLS enabled-not-forced, SELECT-only grants, private-function no-grants, M4 EXECUTE revocations");

  for (const t of newTables) {
    check(`${t}: RLS enabled, not forced`, new RegExp(`alter table public\\.${t} enable row level security`).test(code) && new RegExp(`alter table public\\.${t} no force row level security`).test(code));
    check(`${t}: no CREATE POLICY`, !new RegExp(`create policy[\\s\\S]{0,40}${t}`).test(code));
    check(
      `${t}: service_role receives ONLY select — no insert/update/delete grant`,
      new RegExp(`revoke all on table public\\.${t} from public, anon, authenticated, service_role;\\s*\\ngrant select on table public\\.${t} to service_role;`).test(
        code
      )
    );
  }

  const privateFunctions = [
    ["_admit_and_reserve_attempt_core", "uuid, uuid, text, text, numeric, uuid, uuid"],
    ["_create_attempt_external_calls_core", "uuid, uuid, numeric, numeric"],
    ["_reserve_additional_analysis_generation_core", "uuid, uuid, numeric"],
  ] as const;
  for (const [fn, arity] of privateFunctions) {
    check(
      `${fn}: no EXECUTE grant to any role (revoke all from public, anon, authenticated, service_role; no grant statement at all)`,
      new RegExp(`revoke all on function\\s*\\n\\s*public\\.${fn}\\(${arity}\\)\\s*\\n\\s*from public, anon, authenticated, service_role;`).test(
        code
      ) && !new RegExp(`grant execute on function\\s*\\n\\s*public\\.${fn}`).test(code)
    );
  }

  const publicFencedRpcs = [
    ["enqueue_protocol_execution_job", "uuid, uuid, integer"],
    ["claim_protocol_execution_job", "text, integer"],
    ["renew_protocol_execution_job_lease", "uuid, uuid, uuid, integer"],
    ["admit_and_reserve_attempt_for_job", "uuid, uuid, uuid, text, text, numeric, numeric, uuid"],
    ["start_attempt_for_job", "uuid, uuid, uuid, uuid, uuid"],
    ["reserve_additional_analysis_generation_for_job", "uuid, uuid, uuid, uuid, numeric"],
    ["mark_external_call_sent_for_job", "uuid, uuid, uuid, uuid, uuid"],
    ["reconcile_attempt_for_job", "uuid, uuid, uuid, uuid, text, text"],
    ["complete_protocol_execution_job", "uuid, uuid, uuid"],
    ["fail_protocol_execution_job", "uuid, uuid, uuid, text"],
    ["authorize_operator_retry", "uuid, uuid, text, text, text, uuid, numeric, numeric"],
    ["reactivate_abandoned_job", "uuid, uuid, text, text"],
  ] as const;
  for (const [fn, arity] of publicFencedRpcs) {
    check(
      `${fn}: EXECUTE granted to service_role only (public/anon/authenticated revoked)`,
      new RegExp(`revoke all on function\\s*\\n\\s*public\\.${fn}\\(${arity}\\) from public;`).test(code) &&
        new RegExp(`revoke all on function\\s*\\n\\s*public\\.${fn}\\(${arity}\\) from anon;`).test(code) &&
        new RegExp(`revoke all on function\\s*\\n\\s*public\\.${fn}\\(${arity}\\) from authenticated;`).test(code) &&
        new RegExp(`grant execute on function\\s*\\n\\s*public\\.${fn}\\(${arity}\\) to service_role;`).test(code)
    );
  }

  check(
    "EXECUTE is revoked from service_role on all three raw M4 RPCs (admit_and_reserve_attempt, start_attempt, reconcile_attempt)",
    /revoke execute on function\s*\n\s*public\.admit_and_reserve_attempt\(uuid, uuid, text, text, numeric, uuid\) from service_role;/.test(code) &&
      /revoke execute on function\s*\n\s*public\.start_attempt\(uuid, uuid, uuid\) from service_role;/.test(code) &&
      /revoke execute on function\s*\n\s*public\.reconcile_attempt\(uuid, uuid, text, numeric, uuid, text\) from service_role;/.test(code)
  );

  check(
    "no function body contains a bare, unqualified `status` comparison in an UPDATE ... WHERE clause colliding with a RETURNS TABLE `status` OUT column (the exact bug class fixed by 0049)",
    !/where\s+(?:id|status)\s*=\s*p_\w+_id\s+and\s+status\s*=/i.test(code) &&
      !/\bwhere status = 'running'/i.test(code)
  );

  // ------------------------------------------------------------------
  // [12] 0047, 0048, 0049 are untouched; only admit_and_reserve_attempt
  //      is redefined (via CREATE OR REPLACE, matching 0049's technique).
  // ------------------------------------------------------------------
  console.log("\n[12] 0047/0048/0049 restent inchangés — seul admit_and_reserve_attempt est redéfini");

  check(
    "migration 0047 is untouched (re-read fresh, still contains its original tables and RPCs)",
    raw0047.includes("create table if not exists public.buyer_questions") &&
      raw0047.includes("create table if not exists public.protocols") &&
      raw0047.includes("admit_and_reserve_attempt") &&
      raw0047.includes("start_attempt") &&
      raw0047.includes("reconcile_attempt")
  );
  check(
    "migration 0048 is untouched (re-read fresh, still contains its numeric range checks)",
    raw0048.includes("buyer_question_versions_commercial_value_range_check") &&
      raw0048.includes("buyer_question_versions_winnability_range_check") &&
      raw0048.includes("buyer_question_versions_priority_range_check")
  );
  check(
    "migration 0049 is untouched (re-read fresh, still contains its approve_protocol/start_attempt ambiguity fix)",
    raw0049.includes("approve_protocol") && raw0049.includes("start_attempt") && raw0049.includes("pr.status")
  );
  check(
    "0050 redefines admit_and_reserve_attempt (CREATE OR REPLACE, identical external signature to 0047) — the one sanctioned exception",
    /create or replace function\s*\n\s*public\.admit_and_reserve_attempt\(/.test(code)
  );
  check(
    "0050 does NOT redefine approve_buyer_question_version, approve_protocol, start_attempt, or reconcile_attempt (their bodies stay exactly as 0047/0049 left them)",
    !/create or replace function\s*\n\s*public\.approve_buyer_question_version\(/.test(code) &&
      !/create or replace function\s*\n\s*public\.approve_protocol\(/.test(code) &&
      !/create or replace function\s*\n\s*public\.start_attempt\(/.test(code) &&
      !/create or replace function\s*\n\s*public\.reconcile_attempt\(/.test(code)
  );
  check(
    "admit_and_reserve_attempt's redefined body only delegates to the private core with job_id := null — no cap-check logic is duplicated or altered here",
    (() => {
      const body = extractBody(code, "admit_and_reserve_attempt");
      // Match ONLY the short wrapper body, not the private core's (much longer) body which also matches this prefix.
      const wrapperBody = body !== null && body.length < 600 ? body : null;
      return (
        wrapperBody !== null &&
        /_admit_and_reserve_attempt_core/.test(wrapperBody) &&
        /p_estimated_cost_usd, p_retry_of_attempt_id, null/.test(wrapperBody)
      );
    })()
  );

  // ------------------------------------------------------------------
  // [13] No legacy 5x3/$2 or won/partial/lost vocabulary.
  // ------------------------------------------------------------------
  console.log("\n[13] aucune référence au legacy 5×3/$2 ni aux verdicts won/partial/lost");

  check(
    "no won/partial/lost verdict vocabulary anywhere in 0050",
    !/\bwon\b/i.test(code) && !/\bpartial\b/i.test(code) && !/\blost\b/i.test(code)
  );
  check(
    "no WORKER_BUDGET_USD / WORKER_PROMPTS / WORKER_RUNS legacy constants referenced",
    !/WORKER_BUDGET_USD|WORKER_PROMPTS|WORKER_RUNS/.test(code)
  );
  check(
    "no literal 5x3 sampling grid or a bare $2 budget figure",
    !/\b5\s*[x×]\s*3\b/i.test(code) && !/\$2\b/.test(code)
  );

  // ------------------------------------------------------------------
  // [14] Fix verification — regression guards for the two bugs found by
  //      real local execution (never caught by static text checks
  //      alone): the redundant column-definition-list on `AS core(...)`
  //      (Postgres: "a column definition list is redundant for a
  //      function with OUT parameters"), and the claimed-with-expired-
  //      lease job that was neither reclaimed nor ever abandoned.
  // ------------------------------------------------------------------
  console.log("\n[14] correctifs — alias core sans liste redondante ; claim traite 'claimed' comme 'running' pour le bail expiré");

  check(
    "admit_and_reserve_attempt calls the core via the bare `as core` alias — no redundant column-definition list",
    (() => {
      const body = extractBody(code, "admit_and_reserve_attempt");
      const wrapperBody = body !== null && body.length < 600 ? body : null;
      return wrapperBody !== null && /_admit_and_reserve_attempt_core\(/.test(wrapperBody) && /\) as core;/.test(wrapperBody);
    })()
  );
  check(
    "reserve_additional_analysis_generation_for_job calls the core via the bare `as core` alias — no redundant column-definition list",
    (() => {
      const body = extractBody(code, "reserve_additional_analysis_generation_for_job");
      return body !== null && /_reserve_additional_analysis_generation_core\(/.test(body) && /\) as core;/.test(body);
    })()
  );
  check(
    "no `as core(` column-definition-list pattern remains anywhere in 0050 (Postgres rejects it for a function whose RETURNS TABLE already names OUT columns — this is the exact bug found by real execution, not visible from static text alone)",
    !/as core\(/i.test(code)
  );

  const claimBody = extractBody(code, "claim_protocol_execution_job");
  check(
    "claim_protocol_execution_job's exhaustion sweep treats a 'claimed' job exactly like a 'running' job for lease expiry (abandoned_exhausted)",
    claimBody !== null &&
      /where\s+j\.status in \('claimed', 'running'\)\s*\n\s*and j\.lease_expires_at < now\(\)\s*\n\s*and j\.attempt_count >= j\.max_attempts/.test(
        claimBody
      )
  );
  check(
    "claim_protocol_execution_job's candidate query reclaims an expired-lease 'claimed' job exactly like an expired-lease 'running' job",
    claimBody !== null &&
      /j\.status in \('claimed', 'running'\) and j\.lease_expires_at < now\(\) and j\.attempt_count < j\.max_attempts/.test(
        claimBody
      )
  );
  check(
    "a 'claimed' job is NEVER a reclaim candidate on status alone — the lease-expiry condition (lease_expires_at < now()) is structurally required in the same branch, so a still-valid lease cannot be stolen",
    claimBody !== null &&
      !/j\.status = 'claimed'/.test(claimBody) &&
      !/\bor j\.status in \('claimed', 'running'\)\)/.test(claimBody)
  );
  check(
    "the exhaustion (abandon) path and the reclaim (candidate) path both list 'claimed' — the fix is symmetric, not a reclaim-only patch that would leave the abandon path still 'running'-only",
    claimBody !== null &&
      (claimBody.match(/status in \('claimed', 'running'\)/g) ?? []).length >= 2
  );
  check(
    "FOR UPDATE SKIP LOCKED, the fencing claim_token assignment, the single attempt_count increment, and the abandoned_exhausted transition all remain present",
    claimBody !== null &&
      /for update skip locked/i.test(claimBody) &&
      /claim_token = v_token/.test(claimBody) &&
      /attempt_count = attempt_count \+ 1/.test(claimBody) &&
      /'abandoned_exhausted'/.test(claimBody)
  );
  check(
    "'queued' remains an unconditional candidate branch, unchanged by the fix",
    claimBody !== null && /j\.status = 'queued'/.test(claimBody)
  );
  check(
    "claim_protocol_execution_job's signature, SECURITY DEFINER, search_path, and service_role-only EXECUTE grant are unchanged by the fix",
    /public\.claim_protocol_execution_job\(\s*\n\s*p_worker_id text,\s*\n\s*p_lease_seconds integer\s*\n\s*\)/.test(code) &&
      /revoke all on function\s*\n\s*public\.claim_protocol_execution_job\(text, integer\) from public;/.test(code) &&
      /grant execute on function\s*\n\s*public\.claim_protocol_execution_job\(text, integer\) to service_role;/.test(code)
  );
  check(
    "admit_and_reserve_attempt and reserve_additional_analysis_generation_for_job keep their original signatures, SECURITY DEFINER, and search_path after the alias fix",
    /public\.admit_and_reserve_attempt\(\s*\n\s*p_protocol_id uuid,/.test(code) &&
      /public\.reserve_additional_analysis_generation_for_job\(\s*\n\s*p_job_id uuid,/.test(code)
  );
  check(
    "no old MVP 5x3/$2 vocabulary, and no M7/M8 references, introduced by the fix",
    !/\b5\s*[x×]\s*3\b/i.test(code) && !/\$2\b/.test(code) && !/\bM7\b/.test(code) && !/\bM8\b/.test(code)
  );

  // ------------------------------------------------------------------
  // [15] D-020 — completion gate: current_attempt_id pointer, ordered
  //      gate in complete_protocol_execution_job, authoritative
  //      generation, unknown-cost acceptance, deterministic locks.
  // ------------------------------------------------------------------
  console.log("\n[15] D-020 — gate de complétion : current_attempt_id, ordre du gate, génération autoritaire");

  check(
    "protocol_execution_jobs gains a nullable current_attempt_id column",
    /alter table public\.protocol_execution_jobs add column if not exists current_attempt_id uuid null;/.test(code)
  );
  check(
    "current_attempt_id is the only new column added to protocol_execution_jobs by the gate",
    (code.match(/alter table public\.protocol_execution_jobs add column/g) ?? []).length === 1
  );
  check(
    "protocol_attempts gains exactly the composite unique constraint the new FK needs -- and only the pre-existing job_id FK besides it, no redundant business-unique constraint",
    (code.match(/alter table public\.protocol_attempts\s*\n\s*add constraint/g) ?? []).length === 2 &&
      /add constraint protocol_attempts_id_job_project_key unique \(id, job_id, project_id\);/.test(code)
  );
  check(
    "the composite FK ties (current_attempt_id, id, project_id) to protocol_attempts(id, job_id, project_id) -- never a bare (current_attempt_id, project_id) FK, which would allow pointing at another job's attempt in the same project",
    /foreign key \(current_attempt_id, id, project_id\)\s*\n\s*references public\.protocol_attempts \(id, job_id, project_id\);/.test(
      code
    )
  );
  check(
    "protocol_execution_jobs_current_attempt_idx index exists",
    /create index if not exists protocol_execution_jobs_current_attempt_idx\s*\n\s*on public\.protocol_execution_jobs \(current_attempt_id\);/.test(
      code
    )
  );

  check(
    "admit_and_reserve_attempt_for_job sets current_attempt_id unconditionally, in the SAME statement as its status transition -- no later separate write a subsequent failure could leave partially applied",
    (() => {
      const body = extractBody(code, "admit_and_reserve_attempt_for_job");
      return (
        body !== null &&
        /set status = 'running',\s*\n\s*current_attempt_id = \(v_core\.attempt\)\.id,\s*\n\s*updated_at = now\(\)/.test(
          body
        )
      );
    })()
  );
  check(
    "authorize_operator_retry's retry_full_attempt branch replaces current_attempt_id with the new attempt's id, in the SAME statement as its own status transition",
    (() => {
      const body = extractBody(code, "authorize_operator_retry");
      return (
        body !== null &&
        /set status = 'queued',\s*\n\s*needs_review_reason = null,\s*\n\s*current_attempt_id = \(v_core\.attempt\)\.id,\s*\n\s*updated_at = now\(\)/.test(
          body
        )
      );
    })()
  );
  check(
    "authorize_operator_retry's retry_analysis_only branch never touches current_attempt_id -- exactly one assignment of it exists in the whole function",
    (() => {
      const body = extractBody(code, "authorize_operator_retry");
      return body !== null && (body.match(/current_attempt_id = \(v_core\.attempt\)\.id/g) ?? []).length === 1;
    })()
  );

  const completeBody = extractBody(code, "complete_protocol_execution_job");
  // Anchored on the exact `return query select '<STATUS>'::text,` SQL return
  // literal for each status -- not a bare substring of the status name --
  // so a future identifier or comment that merely contains one of these
  // words (e.g. as a substring of a longer status) cannot satisfy the
  // ordering check in its place.
  check(
    "complete_protocol_execution_job checks JOB_NOT_FOUND, then ALREADY_SUCCEEDED, then CONFLICT, then fencing (JOB_NOT_OWNED), in that exact order",
    (() => {
      if (completeBody === null) return false;
      const iNotFound = completeBody.indexOf("return query select 'JOB_NOT_FOUND'::text,");
      const iAlready = completeBody.indexOf("return query select 'ALREADY_SUCCEEDED'::text,");
      const iConflict = completeBody.indexOf("return query select 'CONFLICT'::text,");
      const iOwned = completeBody.indexOf("return query select 'JOB_NOT_OWNED'::text,");
      return (
        iNotFound !== -1 &&
        iAlready !== -1 &&
        iConflict !== -1 &&
        iOwned !== -1 &&
        iNotFound < iAlready &&
        iAlready < iConflict &&
        iConflict < iOwned
      );
    })()
  );
  check(
    "ALREADY_SUCCEEDED and CONFLICT are both returned with no UPDATE anywhere before them -- neither can mutate the job",
    (() => {
      if (completeBody === null) return false;
      const iAlready = completeBody.indexOf("return query select 'ALREADY_SUCCEEDED'::text,");
      const iConflict = completeBody.indexOf("return query select 'CONFLICT'::text,");
      if (iAlready === -1 || iConflict === -1) return false;
      const prefix = completeBody.slice(0, Math.max(iAlready, iConflict));
      return !/update public\.protocol_execution_jobs/i.test(prefix);
    })()
  );
  check(
    "a null current_attempt_id is refused with NO_CURRENT_ATTEMPT, checked after fencing and before any attempt lookup",
    completeBody !== null &&
      /if v_job\.current_attempt_id is null then/.test(completeBody) &&
      /'NO_CURRENT_ATTEMPT'/.test(completeBody)
  );
  check(
    "the current attempt is locked by the EXACT triple (id, job_id, project_id), never by id alone, with a defensive CURRENT_ATTEMPT_NOT_FOUND guard despite the FK",
    completeBody !== null &&
      /where pa\.id = v_job\.current_attempt_id\s*\n\s*and pa\.job_id = p_job_id\s*\n\s*and pa\.project_id = p_project_id/.test(
        completeBody
      ) &&
      /'CURRENT_ATTEMPT_NOT_FOUND'/.test(completeBody)
  );
  check(
    "an unreconciled attempt (terminalized_at is null) is refused with ATTEMPT_NOT_RECONCILED, and a reconciled-but-not-completed attempt with ATTEMPT_NOT_COMPLETED",
    completeBody !== null &&
      /if v_attempt\.terminalized_at is null then/.test(completeBody) &&
      /'ATTEMPT_NOT_RECONCILED'/.test(completeBody) &&
      /if v_attempt\.status <> 'completed' then/.test(completeBody) &&
      /'ATTEMPT_NOT_COMPLETED'/.test(completeBody)
  );
  check(
    "external_calls of the current attempt are locked in a deterministic (call_kind, generation) order -- the same order for every caller, never row-arrival order",
    completeBody !== null && /order by ec\.call_kind, ec\.generation\s*\n\s*for update;/.test(completeBody)
  );
  check(
    "any external_call still reserved/in_progress refuses completion with EXTERNAL_CALLS_NOT_TERMINAL",
    completeBody !== null &&
      /status in \('reserved', 'in_progress'\)/.test(completeBody) &&
      /'EXTERNAL_CALLS_NOT_TERMINAL'/.test(completeBody)
  );
  check(
    "Perplexity generation 1 must be completed AND carry a matching provider_call_receipts row, or PERPLEXITY_NOT_COMPLETED",
    completeBody !== null &&
      /call_kind = 'perplexity'\s*\n\s*and ec\.generation = 1/.test(completeBody) &&
      /select 1 from public\.provider_call_receipts r\s*\n\s*where r\.external_call_id = v_perplexity\.id/.test(
        completeBody
      ) &&
      /'PERPLEXITY_NOT_COMPLETED'/.test(completeBody)
  );
  check(
    "the MAXIMUM analysis generation must be completed AND carry a matching analysis_call_receipts row, or ANALYSIS_NOT_COMPLETED",
    completeBody !== null &&
      /select max\(generation\) into v_max_analysis_generation/.test(completeBody) &&
      /ec\.generation = v_max_analysis_generation/.test(completeBody) &&
      /select 1 from public\.analysis_call_receipts r\s*\n\s*where r\.external_call_id = v_max_analysis\.id/.test(
        completeBody
      ) &&
      /'ANALYSIS_NOT_COMPLETED'/.test(completeBody)
  );
  check(
    "the analysis-authority check filters exclusively by the computed maximum generation, never a literal generation number -- an older successful generation cannot be substituted for a still-active or failed newest one",
    (() => {
      if (completeBody === null) return false;
      const idx = completeBody.indexOf("select max(generation) into v_max_analysis_generation");
      const section = idx === -1 ? "" : completeBody.slice(idx);
      return (
        section.length > 0 &&
        /ec\.generation = v_max_analysis_generation/.test(section) &&
        !/ec\.generation = \d/.test(section)
      );
    })()
  );
  check(
    "no non-null actual_cost_usd requirement is imposed anywhere in the completion gate -- an honestly reconciled unknown cost is never rejected",
    completeBody !== null && !/actual_cost_usd/.test(completeBody)
  );
  check(
    "complete_protocol_execution_job's signature, RETURNS TABLE, SECURITY DEFINER, search_path, and service_role-only grant are unchanged by the gate rewrite",
    /public\.complete_protocol_execution_job\(\s*\n\s*p_job_id uuid,\s*\n\s*p_claim_token uuid,\s*\n\s*p_project_id uuid\s*\n\s*\)\s*\nreturns table \(\s*\n\s*status text,\s*\n\s*job {4}public\.protocol_execution_jobs\s*\n\)\s*\nlanguage plpgsql\s*\nsecurity definer\s*\nvolatile\s*\nset search_path = public, pg_temp/.test(
      code
    ) &&
      /revoke all on function\s*\n\s*public\.complete_protocol_execution_job\(uuid, uuid, uuid\) from public;/.test(
        code
      ) &&
      /grant execute on function\s*\n\s*public\.complete_protocol_execution_job\(uuid, uuid, uuid\) to service_role;/.test(
        code
      )
  );
  check(
    // NOTE: this deliberately checks only the signature/RETURNS TABLE/
    // SECURITY DEFINER/search_path/ACL contract, not the function body --
    // there is no pre-D-020 baseline of fail_protocol_execution_job's body
    // tracked anywhere in Git to diff against, so this test never claims a
    // body comparison it cannot actually perform.
    "fail_protocol_execution_job's signature/security contract is preserved (D-020 does not modify this function's body)",
    /public\.fail_protocol_execution_job\(\s*\n\s*p_job_id uuid,\s*\n\s*p_claim_token uuid,\s*\n\s*p_project_id uuid,\s*\n\s*p_reason text\s*\n\s*\)\s*\nreturns table \(\s*\n\s*status text,\s*\n\s*job {4}public\.protocol_execution_jobs\s*\n\)\s*\nlanguage plpgsql\s*\nsecurity definer\s*\nvolatile\s*\nset search_path = public, pg_temp/.test(
      code
    ) &&
      /revoke all on function\s*\n\s*public\.fail_protocol_execution_job\(uuid, uuid, uuid, text\) from public;/.test(
        code
      ) &&
      /revoke all on function\s*\n\s*public\.fail_protocol_execution_job\(uuid, uuid, uuid, text\) from anon;/.test(
        code
      ) &&
      /revoke all on function\s*\n\s*public\.fail_protocol_execution_job\(uuid, uuid, uuid, text\) from authenticated;/.test(
        code
      ) &&
      /grant execute on function\s*\n\s*public\.fail_protocol_execution_job\(uuid, uuid, uuid, text\) to service_role;/.test(
        code
      )
  );
  check(
    "the two previously-fixed runtime bugs remain fixed after the gate rewrite: no `as core(` redundant column-definition list anywhere, and claim_protocol_execution_job still treats 'claimed' and 'running' identically for lease expiry in both the sweep and the candidate query",
    !/as core\(/i.test(code) &&
      /status in \('claimed', 'running'\)\s*\n\s*and j\.lease_expires_at < now\(\)\s*\n\s*and j\.attempt_count >= j\.max_attempts/.test(
        code
      ) &&
      /j\.status in \('claimed', 'running'\) and j\.lease_expires_at < now\(\) and j\.attempt_count < j\.max_attempts/.test(
        code
      )
  );

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "M5 0050 schema contract PASSED." : "M5 0050 schema contract FAILED.")
  );
  console.log(
    "\nThis test verifies migration 0050's TEXT only. It is not created in\n" +
      "any database, not applied to staging, not applied to Production."
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
