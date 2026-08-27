#!/usr/bin/env tsx
/**
 * M5 — static assertions over draft migration 0052's SQL text only
 * (D-026: durable call payloads — provider_call_receipts.raw_response_body,
 * analysis_call_receipts.raw_content — pairing/success/hash-match CHECK
 * constraints, probe_results.probe_run_id real uniqueness, and the two
 * receipt RPCs + get_protocol_execution_job_context redefined to carry
 * and expose them; plus the D-026 correction — dataset_batch_id as a
 * durable, NOT NULL, project-scoped, unique attribute of the job itself,
 * created atomically by enqueue_protocol_execution_job and derived
 * exclusively from the job by create_probe_run_and_start_attempt_for_job's
 * reduced 6-arg signature).
 *
 * Same pattern as scripts/test-m5-0051-schema-contract.ts: TEXT-only
 * verification, no database, no staging/Production, no migration
 * applied. Every check() call below operates on comment-stripped SQL
 * text so a matching word inside a `--` comment can never satisfy it.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

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
const path0051 = path.join(migrationsDir, "0051_m5_protocol_worker_resumption_and_retry_safety.sql");
const path0052 = path.join(migrationsDir, "0052_m5_durable_call_payloads_and_probe_result_replay.sql");
const pathDecisions = path.join(process.cwd(), "docs", "DECISIONS.md");

const raw0050 = readFileSync(path0050, "utf8");
const raw0051 = readFileSync(path0051, "utf8");
const raw0052 = readFileSync(path0052, "utf8");
const rawDecisions = readFileSync(pathDecisions, "utf8");

function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

const code0050 = stripSqlComments(raw0050);
const code0051 = stripSqlComments(raw0051);
const code = stripSqlComments(raw0052);

/** Extracts a named function's full body (between its own `as $$` and matching `$$;`), scanning past a given start offset. */
function extractBody(sql: string, functionName: string, fromIndex = 0): string | null {
  const start = sql.indexOf(`public.${functionName}(`, fromIndex);
  if (start === -1) return null;
  const bodyStart = sql.indexOf("as $$", start);
  if (bodyStart === -1) return null;
  const bodyEnd = sql.indexOf("$$;", bodyStart + 5);
  if (bodyEnd === -1) return null;
  return sql.slice(bodyStart, bodyEnd + 3);
}

function main(): void {
  // ------------------------------------------------------------------
  // [1] Migrations 0053 (D-027, B0.2A-2) and 0054 (D-028) now
  //     legitimately exist as additive, later migrations — this
  //     migration (0052) does not itself create a cutover migration.
  //     0055 is M1-A, additive; this migration's own scope has never
  //     crossed. 0050/0051 are read only for cross-reference, never
  //     written by this migration.
  // ------------------------------------------------------------------
  console.log("\n[1] 0053/0054 exist (later and additive); 0050-0054 frozen by SHA-256 — untouched by this file");

  check(
    "a file matching 0053* exists under supabase/migrations (D-027, B0.2A-2 — additive, does not modify 0050/0051/0052)",
    readdirSync(migrationsDir).some((f) => f.startsWith("0053"))
  );
  check(
    "a file matching 0054* exists under supabase/migrations (D-028 — additive, does not modify 0050/0051/0052/0053)",
    readdirSync(migrationsDir).some((f) => f.startsWith("0054"))
  );
  // ------------------------------------------------------------------
  // M1-A boundary ratchet (replaces the former "no 0055 exists" rule).
  //
  // The old rule forbade ANY migration after 0054 and assumed 0055 would
  // necessarily be the M4 raw-RPC cutover. Both parts were wrong as
  // written: a "nothing may follow me" assertion blocks every future
  // tranche by construction, and 0055 has since been assigned to M1-A
  // (exact provider request bodies), ahead of the cutover — which now
  // takes the next free number. That reassignment neither performs nor
  // authorizes the cutover.
  //
  // What this file actually needs to protect is the byte integrity of
  // the M5 migrations it describes. That is now asserted directly, by
  // frozen SHA-256, instead of being inferred from the absence of a
  // successor. Every other assertion in this contract is unchanged.
  // ------------------------------------------------------------------
  const M5_FROZEN: ReadonlyArray<readonly [string, string, string]> = [
    ["0050", "0050_m5_protocol_execution_jobs_and_external_call_ledger.sql", "2059453114b90bb57e91cf00f1855c606f1d45420736dadf89d8f735665d088f"],
    ["0051", "0051_m5_protocol_worker_resumption_and_retry_safety.sql", "629004191dc5458cbacf136d229040995e5f6225fd834cee31dafc5e5ada4071"],
    ["0052", "0052_m5_durable_call_payloads_and_probe_result_replay.sql", "581a3ec1c011887b11690c0c389cc89995c8b5825692f1e9370e87a8047fa7db"],
    ["0053", "0053_m5_analysis_parse_failure_and_raw_request_body.sql", "69f68ca3400229ad3b7e0200feb5fbd76e5c1792e44fe60a6f1baad7276984d3"],
    ["0054", "0054_m5_worker_probe_result_and_alert_outbox.sql", "5fdefb520ce2b7effafc9703b1d1498d79a4ae7e2932dc4649a94410835e670f"],
  ];
  for (const [num, fileName, wantSha] of M5_FROZEN) {
    const p = path.join(migrationsDir, fileName);
    check(
      `migration ${num} is byte-identical to its frozen SHA-256 (this file edits no M5 migration)`,
      existsSync(p) && createHash("sha256").update(readFileSync(p)).digest("hex") === wantSha
    );
  }

  const path0055 = path.join(migrationsDir, "0055_m1_exact_provider_request_body.sql");
  if (existsSync(path0055)) {
    const code0055 = readFileSync(path0055, "utf8");
    check(
      "0055, when present, is the M1-A exact-provider-request-body migration",
      /full_request_body/.test(code0055) && /M1-A/.test(code0055)
    );
    check(
      "0055 performs no M4 cutover: no REVOKE statement, and none of the three raw M4 RPCs is named",
      !/^\s*revoke\s/im.test(code0055) &&
        !/admit_and_reserve_attempt/.test(code0055) &&
        !/\bstart_attempt\b/.test(code0055) &&
        !/reconcile_attempt/.test(code0055)
    );
    check(
      "0055 drops nothing and weakens no constraint",
      !/drop\s+(function|constraint|table|column|policy|index)/i.test(code0055)
    );
  }
  check("0052 file exists at the expected path", existsSync(path0052));
  check(
    "0050's original 12-arg record_provider_call_receipt_for_job signature is still present verbatim in 0050 (this migration does not edit that file)",
    /public\.record_provider_call_receipt_for_job\(\s*\n\s*p_job_id uuid,/.test(code0050)
  );
  check(
    "0051's admit_and_reserve_attempt_for_job / D-025 sections are still present verbatim in 0051 (this migration does not edit that file)",
    /public\.admit_and_reserve_attempt_for_job\(/.test(code0051) && /next_baseline_ordinal/.test(code0051)
  );

  // ------------------------------------------------------------------
  // [2] provider_call_receipts.raw_response_body — column, preflights,
  //     and all three constraints.
  // ------------------------------------------------------------------
  console.log("\n[2] provider_call_receipts.raw_response_body — column, preflights, constraints");

  check(
    "raw_response_body added as a nullable text column",
    /alter table public\.provider_call_receipts\s*\n\s*add column if not exists raw_response_body text null;/.test(code)
  );
  check(
    "a real preflight counts existing rows with body/hash out of pairing before the pairing constraint is added",
    /select count\(\*\) into v_bad_count\s*\n\s*from public\.provider_call_receipts\s*\n\s*where \(raw_response_body is null\) <> \(raw_response_sha256 is null\);/.test(
      code
    ) && /raise exception 'D-026 preflight failed: % provider_call_receipts rows have raw_response_body\/raw_response_sha256 out of pairing', v_bad_count;/.test(code)
  );
  check(
    "provider_call_receipts_content_hash_pairing_check enforces (body is null) = (hash is null), preflighted by existence check",
    /if not exists \(\s*\n\s*select 1 from pg_constraint where conname = 'provider_call_receipts_content_hash_pairing_check'/.test(
      code
    ) && /check \(\(raw_response_body is null\) = \(raw_response_sha256 is null\)\);/.test(code)
  );
  check(
    "a real preflight counts existing outcome=success rows with no body before the success-requires-content constraint is added",
    /select count\(\*\) into v_bad_count\s*\n\s*from public\.provider_call_receipts\s*\n\s*where outcome = 'success' and raw_response_body is null;/.test(
      code
    )
  );
  check(
    "provider_call_receipts_success_requires_content_check rejects outcome=success with no raw_response_body, preflighted",
    /if not exists \(\s*\n\s*select 1 from pg_constraint where conname = 'provider_call_receipts_success_requires_content_check'/.test(
      code
    ) && /check \(outcome <> 'success' or raw_response_body is not null\);/.test(code)
  );
  check(
    "a real preflight compares existing raw_response_sha256 values against public._sha256_hex(raw_response_body) before the hash-match constraint is added",
    /where raw_response_body is not null\s*\n\s*and raw_response_sha256 is not null\s*\n\s*and raw_response_sha256 <> public\._sha256_hex\(raw_response_body\);/.test(
      code
    )
  );
  check(
    "provider_call_receipts_content_hash_match_check calls the real, IMMUTABLE, pgcrypto-backed _sha256_hex helper (0051) — never a bare trust in the caller's own hash",
    /if not exists \(\s*\n\s*select 1 from pg_constraint where conname = 'provider_call_receipts_content_hash_match_check'/.test(
      code
    ) && /check \(raw_response_body is null or raw_response_sha256 = public\._sha256_hex\(raw_response_body\)\);/.test(code)
  );

  // ------------------------------------------------------------------
  // [3] analysis_call_receipts.raw_content — same contract, paired with
  //     response_sha256 only (never request_sha256, out of scope here).
  // ------------------------------------------------------------------
  console.log("\n[3] analysis_call_receipts.raw_content — column, preflights, constraints");

  check(
    "raw_content added as a nullable text column",
    /alter table public\.analysis_call_receipts\s*\n\s*add column if not exists raw_content text null;/.test(code)
  );
  check(
    "a real preflight counts existing rows with raw_content/response_sha256 out of pairing",
    /where \(raw_content is null\) <> \(response_sha256 is null\);/.test(code)
  );
  check(
    "analysis_call_receipts_content_hash_pairing_check enforces (raw_content is null) = (response_sha256 is null), preflighted",
    /if not exists \(\s*\n\s*select 1 from pg_constraint where conname = 'analysis_call_receipts_content_hash_pairing_check'/.test(
      code
    ) && /check \(\(raw_content is null\) = \(response_sha256 is null\)\);/.test(code)
  );
  check(
    "a real preflight counts existing outcome=success rows with no raw_content",
    /where outcome = 'success' and raw_content is null;/.test(code)
  );
  check(
    "analysis_call_receipts_success_requires_content_check rejects outcome=success with no raw_content, preflighted",
    /if not exists \(\s*\n\s*select 1 from pg_constraint where conname = 'analysis_call_receipts_success_requires_content_check'/.test(
      code
    ) && /check \(outcome <> 'success' or raw_content is not null\);/.test(code)
  );
  check(
    "a real preflight compares existing response_sha256 values against public._sha256_hex(raw_content)",
    /where raw_content is not null\s*\n\s*and response_sha256 is not null\s*\n\s*and response_sha256 <> public\._sha256_hex\(raw_content\);/.test(
      code
    )
  );
  check(
    "analysis_call_receipts_content_hash_match_check calls the same real _sha256_hex helper",
    /if not exists \(\s*\n\s*select 1 from pg_constraint where conname = 'analysis_call_receipts_content_hash_match_check'/.test(
      code
    ) && /check \(raw_content is null or response_sha256 = public\._sha256_hex\(raw_content\)\);/.test(code)
  );
  check(
    "no request-side content column or constraint is added for analysis_call_receipts (call-model.ts does not yet expose exact outbound bytes — out of this tranche's scope)",
    !/raw_request/.test(code)
  );

  // ------------------------------------------------------------------
  // [4] probe_results — real UNIQUE(probe_run_id), preflighted against
  //     real historical duplicates (this table predates M5 and may
  //     already hold real data, unlike the M5-only tables above).
  // ------------------------------------------------------------------
  console.log("\n[4] probe_results — real UNIQUE(probe_run_id), preflighted");

  check(
    "a real preflight groups existing probe_results by probe_run_id and counts groups with more than one row",
    /select probe_run_id\s*\n\s*from public\.probe_results\s*\n\s*group by probe_run_id\s*\n\s*having count\(\*\) > 1/.test(
      code
    ) &&
      /raise exception 'D-026 preflight failed: % probe_run_id value\(s\) have more than one probe_results row', v_dupe_count;/.test(
        code
      )
  );
  check(
    "probe_results_probe_run_id_key is a real UNIQUE(probe_run_id) constraint, preflighted by existence check",
    /if not exists \(\s*\n\s*select 1 from pg_constraint where conname = 'probe_results_probe_run_id_key'/.test(code) &&
      /add constraint probe_results_probe_run_id_key unique \(probe_run_id\);/.test(code)
  );

  // ------------------------------------------------------------------
  // [5] record_provider_call_receipt_for_job — old 12-arg dropped, new
  //     13-arg signature, INSERT carries raw_response_body, ACL
  //     reissued service-role-only.
  // ------------------------------------------------------------------
  console.log("\n[5] record_provider_call_receipt_for_job — 13-arg redefinition");

  check(
    "the old 12-arg record_provider_call_receipt_for_job signature is dropped without CASCADE",
    /drop function if exists public\.record_provider_call_receipt_for_job\(\s*\n\s*uuid, uuid, uuid, uuid, uuid, text, integer, text, text, integer, numeric, text\s*\n\s*\);/.test(
      code
    )
  );
  const providerReceiptBody = extractBody(code, "record_provider_call_receipt_for_job");
  check(
    "the new signature adds p_raw_response_body text default null as the 13th (trailing) parameter",
    providerReceiptBody !== null && /p_cost_basis text default null,\s*\n\s*p_raw_response_body text default null\s*\n\s*\)/.test(
      code
    )
  );
  check(
    "the INSERT's column list and VALUES list both carry raw_response_body / p_raw_response_body in the same statement that writes the hash — never a later, separate UPDATE",
    providerReceiptBody !== null &&
      /provider_request_id, raw_response_sha256, latency_ms, raw_response_body/.test(providerReceiptBody) &&
      /p_provider_request_id, p_raw_response_sha256, p_latency_ms, p_raw_response_body/.test(providerReceiptBody)
  );
  check(
    "every D-020/D-021 gate (JOB_NOT_FOUND, JOB_NOT_OWNED, NOT_FOUND, WRONG_CALL_KIND, CALL_NOT_OWNED_BY_JOB, CONFLICT) is still present, unchanged, ahead of the INSERT",
    providerReceiptBody !== null &&
      /'JOB_NOT_FOUND'::text, null::public\.protocol_external_calls, null::public\.provider_call_receipts;/.test(
        providerReceiptBody
      ) &&
      /'CONFLICT'::text, v_call, null::public\.provider_call_receipts;/.test(providerReceiptBody)
  );
  check(
    "REVOKE/GRANT reissued for the new 13-arg signature — service_role only",
    /revoke all on function\s*\n\s*public\.record_provider_call_receipt_for_job\(\s*\n\s*uuid, uuid, uuid, uuid, uuid, text, integer, text, text, integer, numeric, text, text\s*\n\s*\) from public;/.test(
      code
    ) &&
      /grant execute on function\s*\n\s*public\.record_provider_call_receipt_for_job\(\s*\n\s*uuid, uuid, uuid, uuid, uuid, text, integer, text, text, integer, numeric, text, text\s*\n\s*\) to service_role;/.test(
        code
      )
  );

  // ------------------------------------------------------------------
  // [6] record_analysis_call_receipt_for_job — old 14-arg dropped, new
  //     15-arg signature, INSERT carries raw_content, ACL reissued.
  // ------------------------------------------------------------------
  console.log("\n[6] record_analysis_call_receipt_for_job — 15-arg redefinition");

  check(
    "the old 14-arg record_analysis_call_receipt_for_job signature is dropped without CASCADE",
    /drop function if exists public\.record_analysis_call_receipt_for_job\(\s*\n\s*uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text\s*\n\s*\);/.test(
      code
    )
  );
  const analysisReceiptBody = extractBody(code, "record_analysis_call_receipt_for_job");
  check(
    "the new signature adds p_raw_content text default null as the 15th (trailing) parameter",
    analysisReceiptBody !== null &&
      /p_cost_basis text default null,\s*\n\s*p_raw_content text default null\s*\n\s*\)/.test(code)
  );
  check(
    "the INSERT's column list and VALUES list both carry raw_content / p_raw_content in the same statement that writes response_sha256",
    analysisReceiptBody !== null &&
      /request_sha256, response_sha256, latency_ms, raw_content/.test(analysisReceiptBody) &&
      /p_request_sha256, p_response_sha256, p_latency_ms, p_raw_content/.test(analysisReceiptBody)
  );
  check(
    "REVOKE/GRANT reissued for the new 15-arg signature — service_role only",
    /revoke all on function\s*\n\s*public\.record_analysis_call_receipt_for_job\(\s*\n\s*uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text, text\s*\n\s*\) from public;/.test(
      code
    ) &&
      /grant execute on function\s*\n\s*public\.record_analysis_call_receipt_for_job\(\s*\n\s*uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text, text\s*\n\s*\) to service_role;/.test(
        code
      )
  );

  // ------------------------------------------------------------------
  // [7] get_protocol_execution_job_context — probe_result added; the
  //     receipt arrays need no query change (array_agg(r.*) on a table
  //     that just gained a column exposes it automatically).
  // ------------------------------------------------------------------
  console.log("\n[7] get_protocol_execution_job_context — probe_result added");

  check(
    "the old (uuid,uuid,uuid) get_protocol_execution_job_context is dropped before being recreated — required because RETURNS TABLE's column list cannot be changed by CREATE OR REPLACE",
    /drop function if exists public\.get_protocol_execution_job_context\(uuid, uuid, uuid\);/.test(code)
  );
  const contextBody = extractBody(code, "get_protocol_execution_job_context");
  check(
    "probe_result public.probe_results is a new trailing RETURNS TABLE column",
    /completed_baseline_slots integer,\s*\n\s*probe_result\s+public\.probe_results\s*\n\)/.test(code)
  );
  check(
    "every early-return branch (JOB_NOT_FOUND, JOB_NOT_OWNED) supplies null::public.probe_results for the new column, keeping the column count consistent everywhere",
    contextBody !== null &&
      (contextBody.match(/null::public\.probe_results/g) ?? []).length >= 2
  );
  check(
    "the probe_result lookup is scoped by probe_run_id AND project_id, only when the current attempt already has a probe_run_id — never a cross-project read",
    contextBody !== null &&
      /select res\.\* into v_probe_result\s*\n\s*from public\.probe_results res\s*\n\s*where res\.probe_run_id = v_attempt\.probe_run_id and res\.project_id = p_project_id;/.test(
        contextBody
      )
  );
  check(
    "the final return query passes v_probe_result as the trailing column",
    contextBody !== null && /v_probe_result;/.test(contextBody)
  );
  check(
    "REVOKE/GRANT reissued for get_protocol_execution_job_context(uuid,uuid,uuid) after the drop — service_role only, same as before",
    /revoke all on function\s*\n\s*public\.get_protocol_execution_job_context\(uuid, uuid, uuid\) from public;/.test(code) &&
      /grant execute on function\s*\n\s*public\.get_protocol_execution_job_context\(uuid, uuid, uuid\) to service_role;/.test(
        code
      )
  );
  check(
    "the receipt arrays (external_calls/provider_receipts/analysis_receipts) are untouched text-wise in this migration — the new raw content columns reach them automatically via array_agg(r.*) on the underlying tables, requiring no query change",
    contextBody !== null &&
      /array_agg\(r\.\*\)/.test(contextBody) &&
      !/raw_response_body/.test(contextBody) &&
      !/raw_content/.test(contextBody)
  );

  // ------------------------------------------------------------------
  // [8] No raw content ever reaches the monitoring view — this
  //     migration does not touch protocol_execution_job_monitoring_v1
  //     at all (confirmed by its total absence from this file's text),
  //     and the view itself (0051) only ever computes scalar
  //     aggregates (count/sum/avg), never array_agg or row projection,
  //     so a new column on an underlying table cannot silently leak
  //     into it.
  // ------------------------------------------------------------------
  console.log("\n[8] monitoring view untouched; no raw content path into it");

  check(
    "0052 does not define or replace protocol_execution_job_monitoring_v1",
    !/create or replace view/.test(code)
  );
  check(
    "0051's monitoring view computes only scalar aggregates (count/sum/avg) — no array_agg, no row projection that could carry raw content",
    /create or replace view public\.protocol_execution_job_monitoring_v1/.test(code0051) &&
      (() => {
        const viewStart = code0051.indexOf("create or replace view public.protocol_execution_job_monitoring_v1");
        const viewEnd = code0051.indexOf(";", code0051.indexOf("as service_role;", viewStart));
        const viewText = code0051.slice(viewStart, viewEnd === -1 ? undefined : viewEnd);
        return !/array_agg/.test(viewText);
      })()
  );

  // ------------------------------------------------------------------
  // [9] protocol_execution_jobs.dataset_batch_id — durable, NOT NULL,
  //     project-scoped composite FK, UNIQUE (one batch never serves two
  //     jobs). Preflighted to fail closed (no backfill) if any job row
  //     already exists.
  // ------------------------------------------------------------------
  console.log("\n[9] protocol_execution_jobs.dataset_batch_id — durable, NOT NULL, project-scoped, unique");

  check(
    "dataset_batch_id added as a nullable uuid column first (so it can be preflighted before NOT NULL is enforced)",
    /alter table public\.protocol_execution_jobs\s*\n\s*add column if not exists dataset_batch_id uuid null;/.test(code)
  );
  check(
    "a real preflight counts ALL existing protocol_execution_jobs rows (every one is missing a dataset_batch_id the instant the column is added) and fails closed with a clear diagnostic — no silent backfill anywhere",
    /select count\(\*\) into v_existing_count from public\.protocol_execution_jobs;/.test(code) &&
      /raise exception 'D-026 preflight failed: % protocol_execution_jobs row\(s\) already exist with no dataset_batch_id/.test(code)
  );
  check(
    "dataset_batch_id is set NOT NULL only after the preflight -- the ALTER COLUMN SET NOT NULL textually follows the raise exception block",
    (() => {
      const preflightIdx = code.indexOf("D-026 preflight failed: % protocol_execution_jobs row(s) already exist");
      const notNullIdx = code.indexOf("alter column dataset_batch_id set not null;");
      return preflightIdx !== -1 && notNullIdx !== -1 && notNullIdx > preflightIdx;
    })()
  );
  check(
    "protocol_execution_jobs_dataset_batch_project_fk is a composite FK to dataset_batches(id, project_id) — project-scoped, preflighted by existence check",
    /if not exists \(\s*\n\s*select 1 from pg_constraint where conname = 'protocol_execution_jobs_dataset_batch_project_fk'/.test(
      code
    ) &&
      /foreign key \(dataset_batch_id, project_id\)\s*\n\s*references public\.dataset_batches \(id, project_id\);/.test(code)
  );
  check(
    "protocol_execution_jobs_dataset_batch_id_key is a real UNIQUE(dataset_batch_id) constraint — one batch never serves two jobs, preflighted by existence check",
    /if not exists \(\s*\n\s*select 1 from pg_constraint where conname = 'protocol_execution_jobs_dataset_batch_id_key'/.test(
      code
    ) && /add constraint protocol_execution_jobs_dataset_batch_id_key unique \(dataset_batch_id\);/.test(code)
  );

  // ------------------------------------------------------------------
  // [10] enqueue_protocol_execution_job redefined again (0050, D-025 in
  //      0051): creates exactly one dataset_batches row and exactly one
  //      job referencing it, atomically. Signature unchanged — CREATE OR
  //      REPLACE only, no DROP.
  // ------------------------------------------------------------------
  console.log("\n[10] enqueue_protocol_execution_job — atomic dataset batch + job creation");

  check(
    "no DROP FUNCTION for enqueue_protocol_execution_job -- the (uuid, uuid, integer) signature is unchanged, so CREATE OR REPLACE alone is sufficient",
    !/drop function if exists public\.enqueue_protocol_execution_job/.test(code)
  );
  const enqueueBody = extractBody(code, "enqueue_protocol_execution_job");
  check(
    "NO_BASELINE_RUNS_PLANNED still returns before any row of either kind is created — it textually precedes both new INSERTs",
    (() => {
      if (enqueueBody === null) return false;
      const gateIdx = enqueueBody.indexOf("NO_BASELINE_RUNS_PLANNED");
      const datasetInsertIdx = enqueueBody.indexOf("insert into public.dataset_batches");
      const jobInsertIdx = enqueueBody.indexOf("insert into public.protocol_execution_jobs");
      return gateIdx !== -1 && datasetInsertIdx !== -1 && jobInsertIdx !== -1 &&
        gateIdx < datasetInsertIdx && datasetInsertIdx < jobInsertIdx;
    })()
  );
  check(
    "ALREADY_EXISTS still returns before either new INSERT is reached -- a pre-existing job's own dataset_batch_id is returned, never a second batch created",
    (() => {
      if (enqueueBody === null) return false;
      const alreadyExistsIdx = enqueueBody.indexOf("'ALREADY_EXISTS'");
      const datasetInsertIdx = enqueueBody.indexOf("insert into public.dataset_batches");
      return alreadyExistsIdx !== -1 && datasetInsertIdx !== -1 && alreadyExistsIdx < datasetInsertIdx;
    })()
  );
  check(
    "exactly one dataset_batches row is inserted per call, dataset_source_type = 'manual_scan', returning its id into v_dataset_batch_id",
    enqueueBody !== null &&
      /insert into public\.dataset_batches \(project_id, dataset_source_type\)\s*\n\s*values \(p_project_id, 'manual_scan'\)\s*\n\s*returning id into v_dataset_batch_id;/.test(
        enqueueBody
      )
  );
  check(
    "the job INSERT carries dataset_batch_id (v_dataset_batch_id) in the same statement that creates the job -- never a later, separate UPDATE",
    enqueueBody !== null &&
      /project_id, protocol_id, status, max_attempts, dataset_batch_id/.test(enqueueBody) &&
      /p_project_id, p_protocol_id, 'queued', p_max_attempts, v_dataset_batch_id/.test(enqueueBody)
  );

  // ------------------------------------------------------------------
  // [11] create_probe_run_and_start_attempt_for_job (0051) redefined:
  //      old 8-arg signature (with caller-supplied p_dataset_id/
  //      p_dataset_source_type) dropped without CASCADE; new 6-arg
  //      signature derives the dataset exclusively from
  //      job.dataset_batch_id.
  // ------------------------------------------------------------------
  console.log("\n[11] create_probe_run_and_start_attempt_for_job — reduced to 6 args, dataset derived from the job");

  check(
    "the old 8-arg create_probe_run_and_start_attempt_for_job signature (uuid,uuid,uuid,uuid,text,text,uuid,text) is dropped without CASCADE",
    /drop function if exists public\.create_probe_run_and_start_attempt_for_job\(\s*\n\s*uuid, uuid, uuid, uuid, text, text, uuid, text\s*\n\s*\);/.test(
      code
    )
  );
  const startAttemptBody = extractBody(code, "create_probe_run_and_start_attempt_for_job");
  check(
    "the new signature has exactly 6 parameters -- p_dataset_id/p_dataset_source_type are entirely absent, not merely defaulted",
    startAttemptBody !== null &&
      /p_job_id uuid,\s*\n\s*p_claim_token uuid,\s*\n\s*p_project_id uuid,\s*\n\s*p_attempt_id uuid,\s*\n\s*p_platform text,\s*\n\s*p_probe_mode text\s*\n\s*\)/.test(
        code
      ) &&
      !/p_dataset_id/.test(startAttemptBody) &&
      !/p_dataset_source_type/.test(startAttemptBody)
  );
  check(
    "the dataset is looked up from public.dataset_batches by job.dataset_batch_id, project-scoped, never accepted as an argument",
    startAttemptBody !== null &&
      /select db\.dataset_source_type into v_dataset_source_type\s*\n\s*from public\.dataset_batches db\s*\n\s*where db\.id = v_job\.dataset_batch_id and db\.project_id = p_project_id;/.test(
        startAttemptBody
      )
  );
  check(
    "the probe_runs INSERT uses v_job.dataset_batch_id / v_dataset_source_type -- never a caller-supplied value, since none exists on this signature",
    startAttemptBody !== null &&
      /values \(p_project_id, p_platform, 'pending', p_probe_mode, v_job\.dataset_batch_id, v_dataset_source_type\)/.test(
        startAttemptBody
      )
  );
  check(
    "REVOKE/GRANT reissued for the new 6-arg signature only -- service_role only, no ACL left on the old 8-arg signature",
    /revoke all on function\s*\n\s*public\.create_probe_run_and_start_attempt_for_job\(uuid, uuid, uuid, uuid, text, text\) from public;/.test(
      code
    ) &&
      /grant execute on function\s*\n\s*public\.create_probe_run_and_start_attempt_for_job\(uuid, uuid, uuid, uuid, text, text\) to service_role;/.test(
        code
      ) &&
      !/create_probe_run_and_start_attempt_for_job\(uuid, uuid, uuid, uuid, text, text, uuid, text\) to service_role/.test(
        code
      )
  );

  // ------------------------------------------------------------------
  // [12] No legacy vocabulary, no secrets, no backfill DML, no
  //      unrelated migration reference.
  // ------------------------------------------------------------------
  console.log("\n[12] no legacy 5x3/$2/won/partial/lost vocabulary; no secrets; no backfill DML");

  check(
    "no won/partial/lost verdict vocabulary, no 5x3/$2 legacy figures",
    !/\bwon\b|\bpartial\b|\blost\b/i.test(code) && !/\$0\.03|5x3/.test(code)
  );
  check(
    "no top-level INSERT/UPDATE/DELETE of business data outside a function body or a read-only preflight's SELECT COUNT(*)",
    !/^\s*(insert into|update|delete from)\s+public\.(protocol_|analysis_|provider_|probe_)/im.test(
      code.replace(/as \$\$[\s\S]*?\$\$;/g, "")
    )
  );
  check(
    "no API key, service-role key, or connection-string pattern anywhere in this migration",
    !/SUPABASE_SERVICE_ROLE_KEY\s*=|sk-[a-zA-Z0-9]{10,}|postgres:\/\/[^ ]*:[^ ]*@/i.test(raw0052)
  );
  check("D-026 exists in docs/DECISIONS.md", /## D-026/.test(rawDecisions));

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "M5 0052 schema contract PASSED." : "M5 0052 schema contract FAILED.")
  );
  console.log(
    "\nThis test verifies migration 0052's TEXT only. It is not created in\n" +
      "any database, not applied to staging, not applied to Production."
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
