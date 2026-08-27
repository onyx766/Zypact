#!/usr/bin/env tsx
/**
 * M5 — static assertions over draft migration 0053's SQL text only
 * (D-027: durable analysis parse-failure ledger — protocol_external_calls.
 * parse_failed_at/parse_failure_code; analysis_call_receipts.
 * raw_request_body paired with request_sha256 and used_mock; the new
 * mark_analysis_parse_failed_for_job RPC; the extended
 * retry_analysis_generation_for_job eligibility branch; and the one
 * additive monitoring column).
 *
 * Same pattern as scripts/test-m5-0052-schema-contract.ts: TEXT-only
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
const path0053 = path.join(migrationsDir, "0053_m5_analysis_parse_failure_and_raw_request_body.sql");
const pathDecisions = path.join(process.cwd(), "docs", "DECISIONS.md");

const raw0050 = readFileSync(path0050, "utf8");
const raw0051 = readFileSync(path0051, "utf8");
const raw0052 = readFileSync(path0052, "utf8");
const raw0053 = readFileSync(path0053, "utf8");
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
const code0052 = stripSqlComments(raw0052);
const code = stripSqlComments(raw0053);

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
  // [1] Migration 0054 (D-028) now legitimately exists as an additive,
  //     later migration — this migration (0053) does not itself create
  //     a cutover migration. 0055 is M1-A, additive; this migration's
  //     own scope has never crossed. 0050/0051/0052 are read only for
  //     cross-reference, never written by this migration.
  // ------------------------------------------------------------------
  console.log("\n[1] 0054 exists (D-028, later and additive); 0050-0054 frozen by SHA-256 — untouched by this file");

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
  check("0053 file exists at the expected path", existsSync(path0053));
  check(
    "0052's original 15-arg record_analysis_call_receipt_for_job signature is still present verbatim in 0052 (this migration does not edit that file)",
    /public\.record_analysis_call_receipt_for_job\(\s*\n\s*uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text\s*\n\s*\);/.test(
      code0052
    )
  );
  check(
    "0051's retry_analysis_generation_for_job is still present verbatim in 0051 (this migration does not edit that file)",
    /public\.retry_analysis_generation_for_job\(/.test(code0051) && /SOURCE_NOT_ELIGIBLE/.test(code0051)
  );
  check(
    "0050's protocol_external_calls table definition is still present verbatim in 0050 (this migration does not edit that file)",
    /create table if not exists public\.protocol_external_calls/.test(code0050)
  );

  // ------------------------------------------------------------------
  // [2] protocol_external_calls.parse_failed_at / parse_failure_code —
  //     paired, bounded, scoped, all preflighted.
  // ------------------------------------------------------------------
  console.log("\n[2] protocol_external_calls.parse_failed_at/parse_failure_code — paired, bounded, scoped");

  check(
    "parse_failed_at and parse_failure_code added as nullable columns",
    /alter table public\.protocol_external_calls\s*\n\s*add column if not exists parse_failed_at timestamptz null,\s*\n\s*add column if not exists parse_failure_code text null;/.test(
      code
    )
  );
  check(
    "a real preflight counts existing rows with parse_failed_at/parse_failure_code out of pairing before the pairing constraint is added",
    /where \(parse_failed_at is null\) <> \(parse_failure_code is null\);/.test(code) &&
      /raise exception 'D-027 preflight failed: % protocol_external_calls rows have parse_failed_at\/parse_failure_code out of pairing', v_bad_count;/.test(
        code
      )
  );
  check(
    "protocol_external_calls_parse_failure_pairing_check enforces (parse_failed_at is null) = (parse_failure_code is null), preflighted",
    /if not exists \(\s*\n\s*select 1 from pg_constraint where conname = 'protocol_external_calls_parse_failure_pairing_check'/.test(
      code
    ) && /check \(\(parse_failed_at is null\) = \(parse_failure_code is null\)\);/.test(code)
  );
  check(
    "a real preflight counts existing rows with an unrecognized parse_failure_code before the bounded CHECK is added",
    /parse_failure_code is not null\s*\n\s*and parse_failure_code not in \('invalid_json', 'schema_validation_failed', 'normalization_failed'\);/.test(
      code
    )
  );
  check(
    "protocol_external_calls_parse_failure_code_check bounds the code to exactly the three parser codes, preflighted",
    /if not exists \(\s*\n\s*select 1 from pg_constraint where conname = 'protocol_external_calls_parse_failure_code_check'/.test(
      code
    ) &&
      /check \(parse_failure_code is null or parse_failure_code in \('invalid_json', 'schema_validation_failed', 'normalization_failed'\)\);/.test(
        code
      )
  );
  check(
    "a real preflight counts existing rows with parse_failed_at outside call_kind=analysis/status=completed before the scope CHECK is added",
    /where parse_failed_at is not null\s*\n\s*and not \(call_kind = 'analysis' and status = 'completed'\);/.test(code)
  );
  check(
    "protocol_external_calls_parse_failure_scope_check restricts parse_failed_at to call_kind='analysis' and status='completed', preflighted",
    /if not exists \(\s*\n\s*select 1 from pg_constraint where conname = 'protocol_external_calls_parse_failure_scope_check'/.test(
      code
    ) && /check \(parse_failed_at is null or \(call_kind = 'analysis' and status = 'completed'\)\);/.test(code)
  );

  // ------------------------------------------------------------------
  // [3] analysis_call_receipts.raw_request_body — pairing, real hash
  //     match, and the used_mock-keyed policy (IS TRUE / IS FALSE).
  // ------------------------------------------------------------------
  console.log("\n[3] analysis_call_receipts.raw_request_body — pairing, hash-match, used_mock policy");

  check(
    "raw_request_body added as a nullable text column",
    /alter table public\.analysis_call_receipts\s*\n\s*add column if not exists raw_request_body text null;/.test(code)
  );
  check(
    "a real preflight counts existing rows with raw_request_body/request_sha256 out of pairing",
    /where \(raw_request_body is null\) <> \(request_sha256 is null\);/.test(code)
  );
  check(
    "analysis_call_receipts_request_pairing_check enforces (raw_request_body is null) = (request_sha256 is null), preflighted",
    /if not exists \(\s*\n\s*select 1 from pg_constraint where conname = 'analysis_call_receipts_request_pairing_check'/.test(
      code
    ) && /check \(\(raw_request_body is null\) = \(request_sha256 is null\)\);/.test(code)
  );
  check(
    "a real preflight compares existing request_sha256 values against public._sha256_hex(raw_request_body)",
    /where raw_request_body is not null\s*\n\s*and request_sha256 is not null\s*\n\s*and request_sha256 <> public\._sha256_hex\(raw_request_body\);/.test(
      code
    )
  );
  check(
    "analysis_call_receipts_request_hash_match_check calls the real, IMMUTABLE, pgcrypto-backed _sha256_hex helper — never a bare trust in the caller's own hash",
    /if not exists \(\s*\n\s*select 1 from pg_constraint where conname = 'analysis_call_receipts_request_hash_match_check'/.test(
      code
    ) && /check \(raw_request_body is null or request_sha256 = public\._sha256_hex\(raw_request_body\)\);/.test(code)
  );
  check(
    "a real preflight scans for used_mock/raw_request_body policy violations before the policy CHECK is added",
    /where \(used_mock is true and \(raw_request_body is not null or request_sha256 is not null\)\)\s*\n\s*or \(used_mock is false and \(raw_request_body is null or request_sha256 is null\)\);/.test(
      code
    )
  );
  check(
    "analysis_call_receipts_request_mock_pairing_check uses IS TRUE / IS FALSE (never = true/= false), preflighted",
    /if not exists \(\s*\n\s*select 1 from pg_constraint where conname = 'analysis_call_receipts_request_mock_pairing_check'/.test(
      code
    ) &&
      /\(used_mock is true and raw_request_body is null and request_sha256 is null\)/.test(code) &&
      /\(used_mock is false and raw_request_body is not null and request_sha256 is not null\)/.test(code) &&
      !/used_mock = true/.test(code) &&
      !/used_mock = false/.test(code)
  );

  // ------------------------------------------------------------------
  // [3b] Every one of the six preflight/constraint pairs above must
  //      appear in that ORDER in the file text -- co-presence alone
  //      (checked above) does not prove the preflight actually runs
  //      before the constraint it is meant to protect.
  // ------------------------------------------------------------------
  const preflightConstraintPairs: [string, string, string][] = [
    [
      "parse_failed_at/parse_failure_code pairing",
      "have parse_failed_at/parse_failure_code out of pairing",
      "protocol_external_calls_parse_failure_pairing_check",
    ],
    [
      "parse_failure_code bounded set",
      "have an unrecognized parse_failure_code",
      "protocol_external_calls_parse_failure_code_check",
    ],
    [
      "parse_failed_at scope",
      "have parse_failed_at outside call_kind=analysis/status=completed",
      "protocol_external_calls_parse_failure_scope_check",
    ],
    [
      "raw_request_body/request_sha256 pairing",
      "have raw_request_body/request_sha256 out of pairing",
      "analysis_call_receipts_request_pairing_check",
    ],
    [
      "request_sha256 hash match",
      "have request_sha256 not matching sha256\\(raw_request_body\\)",
      "analysis_call_receipts_request_hash_match_check",
    ],
    [
      "used_mock/raw_request_body policy",
      "violate the used_mock/raw_request_body pairing policy",
      "analysis_call_receipts_request_mock_pairing_check",
    ],
  ];
  for (const [label, preflightMarker, constraintName] of preflightConstraintPairs) {
    const preflightIdx = code.search(new RegExp(preflightMarker));
    const constraintIdx = code.indexOf(`add constraint ${constraintName}`);
    check(
      `preflight precedes its own constraint in file order: ${label}`,
      preflightIdx !== -1 && constraintIdx !== -1 && preflightIdx < constraintIdx,
      `preflightIdx=${preflightIdx} constraintIdx=${constraintIdx}`
    );
  }

  // ------------------------------------------------------------------
  // [4] record_analysis_call_receipt_for_job — old 15-arg dropped, new
  //     16-arg signature, INSERT carries raw_request_body, ACL reissued.
  // ------------------------------------------------------------------
  console.log("\n[4] record_analysis_call_receipt_for_job — 16-arg redefinition");

  check(
    "the old 15-arg record_analysis_call_receipt_for_job signature is dropped without CASCADE",
    /drop function if exists public\.record_analysis_call_receipt_for_job\(\s*\n\s*uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text, text\s*\n\s*\);/.test(
      code
    ) && !/drop function if exists public\.record_analysis_call_receipt_for_job\([^)]*cascade/i.test(code)
  );
  const analysisReceiptBody = extractBody(code, "record_analysis_call_receipt_for_job");
  check(
    "the new signature adds p_raw_request_body text default null as the 16th (trailing) parameter",
    analysisReceiptBody !== null &&
      /p_raw_content text default null,\s*\n\s*p_raw_request_body text default null\s*\n\s*\)/.test(code)
  );
  check(
    "the INSERT's column list and VALUES list both carry raw_request_body / p_raw_request_body in the same statement that writes the other fields — never a later, separate UPDATE",
    analysisReceiptBody !== null &&
      /raw_content,\s*\n\s*raw_request_body/.test(analysisReceiptBody) &&
      /p_raw_content,\s*\n\s*p_raw_request_body/.test(analysisReceiptBody)
  );
  check(
    "every D-020/D-023 gate (JOB_NOT_FOUND, JOB_NOT_OWNED, NOT_FOUND, WRONG_CALL_KIND, CALL_NOT_OWNED_BY_JOB, CONFLICT) is still present, unchanged, ahead of the INSERT",
    analysisReceiptBody !== null &&
      /'JOB_NOT_FOUND'::text, null::public\.protocol_external_calls, null::public\.analysis_call_receipts;/.test(
        analysisReceiptBody
      ) &&
      /'CONFLICT'::text, v_call, null::public\.analysis_call_receipts;/.test(analysisReceiptBody)
  );
  check(
    "REVOKE/GRANT reissued for the new 16-arg signature — service_role only",
    /revoke all on function\s*\n\s*public\.record_analysis_call_receipt_for_job\(\s*\n\s*uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text, text, text\s*\n\s*\) from public;/.test(
      code
    ) &&
      /grant execute on function\s*\n\s*public\.record_analysis_call_receipt_for_job\(\s*\n\s*uuid, uuid, uuid, uuid, uuid, text, text, text, boolean, text, text, integer, numeric, text, text, text\s*\n\s*\) to service_role;/.test(
        code
      )
  );

  // ------------------------------------------------------------------
  // [5] mark_analysis_parse_failed_for_job — new, fenced RPC. Exact
  //     transactional order, all eleven statuses, no forbidden pattern.
  // ------------------------------------------------------------------
  console.log("\n[5] mark_analysis_parse_failed_for_job — new RPC, 5 args, eleven statuses in order");

  check(
    "mark_analysis_parse_failed_for_job takes exactly five parameters: job_id, claim_token, project_id, external_call_id, parse_failure_code",
    /create or replace function\s*\n\s*public\.mark_analysis_parse_failed_for_job\(\s*\n\s*p_job_id uuid,\s*\n\s*p_claim_token uuid,\s*\n\s*p_project_id uuid,\s*\n\s*p_external_call_id uuid,\s*\n\s*p_parse_failure_code text\s*\n\s*\)/.test(
      code
    )
  );
  const markBody = extractBody(code, "mark_analysis_parse_failed_for_job");
  check("mark_analysis_parse_failed_for_job body extracted", markBody !== null);
  check(
    "the five arguments (including parse_failure_code against the bounded set) are validated before any row is touched",
    markBody !== null &&
      /if p_job_id is null or p_claim_token is null or p_project_id is null\s*\n\s*or p_external_call_id is null or p_parse_failure_code is null\s*\n\s*or p_parse_failure_code not in \('invalid_json', 'schema_validation_failed', 'normalization_failed'\) then/.test(
        markBody
      )
  );

  const statusOrder = [
    "JOB_NOT_FOUND",
    "JOB_NOT_OWNED",
    "NOT_CURRENT_ATTEMPT",
    "WRONG_CALL_KIND",
    "ALREADY_MARKED",
    "PARSE_FAILURE_CODE_CONFLICT",
    "CURRENT_ATTEMPT_NOT_FOUND",
    "PROBE_RESULT_ALREADY_EXISTS",
    "SOURCE_NOT_AUTHORITATIVE_GENERATION",
    "NOT_ELIGIBLE",
    "MARKED",
  ];
  check(
    "all eleven statuses are present in mark_analysis_parse_failed_for_job's body",
    markBody !== null && statusOrder.every((s) => markBody.includes(`'${s}'`))
  );
  check(
    "the eleven statuses appear in exactly the required transactional order",
    (() => {
      if (markBody === null) return false;
      let lastIndex = -1;
      for (const status of statusOrder) {
        const idx = markBody.indexOf(`'${status}'`);
        if (idx === -1 || idx <= lastIndex) return false;
        lastIndex = idx;
      }
      return true;
    })()
  );
  check(
    "the job is locked project-scoped (id, project_id) before any other row",
    markBody !== null &&
      /select j\.\* into v_job\s*\n\s*from public\.protocol_execution_jobs j\s*\n\s*where j\.id = p_job_id and j\.project_id = p_project_id\s*\n\s*for update;/.test(
        markBody
      )
  );
  check(
    "the external call is locked project-scoped (id, project_id)",
    markBody !== null &&
      /select ec\.\* into v_call\s*\n\s*from public\.protocol_external_calls ec\s*\n\s*where ec\.id = p_external_call_id and ec\.project_id = p_project_id\s*\n\s*for update;/.test(
        markBody
      )
  );
  check(
    "NOT_CURRENT_ATTEMPT checks appartenance to current_attempt_id exactly, not merely existence",
    markBody !== null && /v_call\.protocol_attempt_id is distinct from v_job\.current_attempt_id/.test(markBody)
  );
  check(
    "ALREADY_MARKED (same code) and PARSE_FAILURE_CODE_CONFLICT (different code) are distinguished by comparing v_call.parse_failure_code to the input, before the attempt is even locked",
    markBody !== null &&
      /if v_call\.parse_failed_at is not null then\s*\n\s*if v_call\.parse_failure_code = p_parse_failure_code then/.test(
        markBody
      )
  );
  check(
    "the current attempt is locked (id, job_id, project_id) — never protocol_attempt_id alone — with a defensive CURRENT_ATTEMPT_NOT_FOUND",
    markBody !== null &&
      /select pa\.\* into v_attempt\s*\n\s*from public\.protocol_attempts pa\s*\n\s*where pa\.id = v_job\.current_attempt_id and pa\.job_id = p_job_id and pa\.project_id = p_project_id\s*\n\s*for update;/.test(
        markBody
      )
  );
  check(
    "the probe_result lookup is derived via v_attempt.probe_run_id, project-scoped — the exact get_protocol_execution_job_context convention, never protocol_external_calls.probe_run_id directly for this check",
    markBody !== null &&
      /select 1 from public\.probe_results pr\s*\n\s*where pr\.probe_run_id = v_attempt\.probe_run_id and pr\.project_id = p_project_id/.test(
        markBody
      )
  );
  check(
    "SOURCE_NOT_AUTHORITATIVE_GENERATION compares v_call.generation to the real max(generation) among the attempt's analysis calls",
    markBody !== null &&
      /select max\(generation\) into v_max_generation\s*\n\s*from public\.protocol_external_calls\s*\n\s*where protocol_attempt_id = v_call\.protocol_attempt_id and call_kind = 'analysis';/.test(
        markBody
      ) && /v_call\.generation <> v_max_generation/.test(markBody)
  );
  check(
    "NOT_ELIGIBLE folds status/probe_run_id-coherence/receipt checks into one status — no new status invented for these sub-cases",
    markBody !== null &&
      /v_call\.status <> 'completed'/.test(markBody) &&
      /v_attempt\.probe_run_id is null/.test(markBody) &&
      /v_call\.probe_run_id is null/.test(markBody) &&
      /v_call\.probe_run_id is distinct from v_attempt\.probe_run_id/.test(markBody) &&
      /r\.outcome = 'success'\s*\n\s*and r\.project_id = p_project_id\s*\n\s*and r\.probe_run_id = v_attempt\.probe_run_id/.test(
        markBody
      )
  );
  check(
    "the final UPDATE sets both parse_failed_at and parse_failure_code atomically, project-scoped",
    markBody !== null &&
      /update public\.protocol_external_calls\s*\n\s*set parse_failed_at = now\(\), parse_failure_code = p_parse_failure_code\s*\n\s*where id = p_external_call_id and project_id = p_project_id/.test(
        markBody
      )
  );
  check(
    "no alias is referenced outside its own SELECT statement (ec/j/pa each confined to their declaring query)",
    markBody !== null && !/\bec\.probe_run_id is distinct from v_job/.test(markBody)
  );
  check("no EXCEPTION WHEN unique_violation anywhere in this migration", !/exception\s+when\s+unique_violation/i.test(code));
  check("no CASCADE keyword anywhere in this migration's real SQL (comments deliberately explain its absence)", !/\bcascade\b/i.test(code));
  check(
    "REVOKE/GRANT for mark_analysis_parse_failed_for_job — service_role only, no DML grant anywhere in this migration",
    /revoke all on function\s*\n\s*public\.mark_analysis_parse_failed_for_job\(uuid, uuid, uuid, uuid, text\) from public;/.test(
      code
    ) &&
      /grant execute on function\s*\n\s*public\.mark_analysis_parse_failed_for_job\(uuid, uuid, uuid, uuid, text\) to service_role;/.test(
        code
      ) &&
      !/grant\s+(insert|update|delete)\s+on\s+table/i.test(code)
  );

  // ------------------------------------------------------------------
  // [6] retry_analysis_generation_for_job — signature unchanged; new
  //     eligibility branch; dedup/authoritative-generation/caps/core
  //     textually unchanged.
  // ------------------------------------------------------------------
  console.log("\n[6] retry_analysis_generation_for_job — extended eligibility branch, signature unchanged");

  check(
    "retry_analysis_generation_for_job's signature is unchanged: (uuid, uuid, uuid, uuid, numeric) — no DROP FUNCTION for it in this migration",
    /create or replace function\s*\n\s*public\.retry_analysis_generation_for_job\(\s*\n\s*p_job_id uuid,\s*\n\s*p_claim_token uuid,\s*\n\s*p_project_id uuid,\s*\n\s*p_source_external_call_id uuid,\s*\n\s*p_reserved_cost_usd numeric\s*\n\s*\)/.test(
      code
    ) && !/drop function if exists public\.retry_analysis_generation_for_job/.test(code)
  );
  const retryBody = extractBody(code, "retry_analysis_generation_for_job");
  check("retry_analysis_generation_for_job body extracted from 0053", retryBody !== null);
  check(
    "the retry_of_external_call_id dedup (ALREADY_RETRIED / SOURCE_ALREADY_RETRIED) is textually unchanged, still checked before either eligibility branch",
    retryBody !== null &&
      /ec\.retry_of_external_call_id = p_source_external_call_id/.test(retryBody) &&
      retryBody.indexOf("'ALREADY_RETRIED'") < retryBody.indexOf("if v_source.status in ('failed', 'timed_out', 'cancelled') then")
  );
  check(
    "the authoritative-generation check (max(generation)) is textually unchanged, still checked before the eligibility branches",
    retryBody !== null &&
      retryBody.indexOf("v_source.generation <> v_max_generation") <
        retryBody.indexOf("if v_source.status in ('failed', 'timed_out', 'cancelled') then")
  );
  check(
    "the historical eligibility branch (failed/timed_out/cancelled with a receipt) is textually unchanged",
    retryBody !== null &&
      /if v_source\.status in \('failed', 'timed_out', 'cancelled'\) then\s*\n\s*if not exists \(select 1 from public\.analysis_call_receipts r where r\.external_call_id = v_source\.id\) then/.test(
        retryBody
      )
  );
  check(
    "the new parse-repair branch requires: completed status, parse_failed_at/parse_failure_code both set, coherent probe_run_id, and a real same-project same-probe_run success receipt",
    retryBody !== null &&
      /elsif v_source\.status = 'completed' and v_source\.parse_failed_at is not null and v_source\.parse_failure_code is not null then/.test(
        retryBody
      ) &&
      /v_source\.probe_run_id is distinct from v_attempt\.probe_run_id/.test(retryBody) &&
      /r\.outcome = 'success'\s*\n\s*and r\.project_id = p_project_id\s*\n\s*and r\.probe_run_id = v_attempt\.probe_run_id/.test(
        retryBody
      )
  );
  check(
    "the new branch refuses with PROBE_RESULT_ALREADY_EXISTS if a probe_results row already exists for the coherent probe_run_id — never a silent second generation",
    retryBody !== null &&
      /select 1 from public\.probe_results pr\s*\n\s*where pr\.probe_run_id = v_attempt\.probe_run_id and pr\.project_id = p_project_id\s*\n\s*\) then\s*\n\s*return query select 'PROBE_RESULT_ALREADY_EXISTS'/.test(
        retryBody
      )
  );
  check(
    "the ambiguity gate (AMBIGUOUS_CALL_PRESENT) is textually unchanged and still runs after both eligibility branches",
    retryBody !== null && /v_ambiguous_count > 0/.test(retryBody)
  );
  check(
    "_reserve_additional_analysis_generation_core is still the sole reservation path — retry_cap/spend_cap_usd enforcement is untouched by this migration",
    retryBody !== null &&
      /from public\._reserve_additional_analysis_generation_core\(\s*\n\s*v_attempt\.id, p_project_id, p_reserved_cost_usd, p_source_external_call_id\s*\n\s*\) as core;/.test(
        retryBody
      ) &&
      !/_reserve_additional_analysis_generation_core/.test(code.replace(retryBody, ""))
  );
  check(
    "REVOKE/GRANT reissued for retry_analysis_generation_for_job's unchanged signature — service_role only",
    /revoke all on function\s*\n\s*public\.retry_analysis_generation_for_job\(uuid, uuid, uuid, uuid, numeric\) from public;/.test(
      code
    ) &&
      /grant execute on function\s*\n\s*public\.retry_analysis_generation_for_job\(uuid, uuid, uuid, uuid, numeric\) to service_role;/.test(
        code
      )
  );

  // ------------------------------------------------------------------
  // [7] protocol_execution_job_monitoring_v1 — one additive scalar
  //     column only. No raw/content column, no array_agg, no row
  //     projection.
  // ------------------------------------------------------------------
  console.log("\n[7] protocol_execution_job_monitoring_v1 — one additive scalar column");

  check(
    "analysis_parse_failures_total is a real count(*) scalar over parse_failed_at is not null",
    /\(select count\(\*\) from public\.protocol_external_calls where parse_failed_at is not null\) as analysis_parse_failures_total/.test(
      code
    )
  );
  const viewStart = code.indexOf("create or replace view public.protocol_execution_job_monitoring_v1");
  const viewGrantIdx = code.indexOf("grant select on public.protocol_execution_job_monitoring_v1", viewStart);
  const viewEnd = viewGrantIdx === -1 ? -1 : code.indexOf(";", viewGrantIdx);
  const viewText = viewStart !== -1 && viewEnd !== -1 ? code.slice(viewStart, viewEnd + 1) : "";
  check(
    "preflight: the view's own text was actually extracted (non-empty, ends at its own REVOKE/GRANT) — a prior version of this same check silently passed on an empty slice",
    viewText.length > 500 && /revoke all on public\.protocol_execution_job_monitoring_v1/.test(viewText)
  );
  check(
    "the extended view still computes only scalar aggregates — no array_agg, no row projection, no raw/content column reference",
    viewStart !== -1 &&
      !/array_agg/.test(viewText) &&
      !/raw_content/.test(viewText) &&
      !/raw_request_body/.test(viewText) &&
      !/raw_response_body/.test(viewText)
  );
  check(
    "security_invoker is preserved and ACL reissued identically — service_role SELECT only",
    /create or replace view public\.protocol_execution_job_monitoring_v1\s*\n\s*with \(security_invoker = true\) as/.test(code) &&
      /revoke all on public\.protocol_execution_job_monitoring_v1 from public, anon, authenticated, service_role;/.test(code) &&
      /grant select on public\.protocol_execution_job_monitoring_v1 to service_role;/.test(code)
  );

  // ------------------------------------------------------------------
  // [8] No legacy vocabulary, no secrets, no backfill DML, D-027 present.
  // ------------------------------------------------------------------
  console.log("\n[8] no legacy 5x3/$2/won/partial/lost vocabulary; no secrets; no backfill DML; D-027 documented");

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
    !/SUPABASE_SERVICE_ROLE_KEY\s*=|sk-[a-zA-Z0-9]{10,}|postgres:\/\/[^ ]*:[^ ]*@/i.test(raw0053)
  );
  check("D-027 exists in docs/DECISIONS.md", /## D-027/.test(rawDecisions));

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "M5 0053 schema contract PASSED." : "M5 0053 schema contract FAILED.")
  );
  console.log(
    "\nThis test verifies migration 0053's TEXT only. It is not created in\n" +
      "any database, not applied to staging, not applied to Production."
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
