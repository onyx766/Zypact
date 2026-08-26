#!/usr/bin/env tsx
/**
 * M5 — static assertions over draft migration 0054's SQL text only
 * (D-028: durable probe_result persistence via a fenced, race-safe RPC,
 * plus a durable alert outbox for needs_review/abandoned_exhausted
 * transitions).
 *
 * Same pattern as scripts/test-m5-0053-schema-contract.ts: TEXT-only
 * verification, no database, no staging/Production, no migration
 * applied. Every check() call below operates on comment-stripped SQL
 * text so a matching word inside a `--` comment can never satisfy it.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
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
const path0051 = path.join(migrationsDir, "0051_m5_protocol_worker_resumption_and_retry_safety.sql");
const path0052 = path.join(migrationsDir, "0052_m5_durable_call_payloads_and_probe_result_replay.sql");
const path0053 = path.join(migrationsDir, "0053_m5_analysis_parse_failure_and_raw_request_body.sql");
const path0054 = path.join(migrationsDir, "0054_m5_worker_probe_result_and_alert_outbox.sql");
const pathDecisions = path.join(process.cwd(), "docs", "DECISIONS.md");
const pathTypesTs = path.join(process.cwd(), "lib", "db", "types.ts");
const pathMemoryAdapterTs = path.join(process.cwd(), "lib", "db", "memory-adapter.ts");

const raw0050 = readFileSync(path0050, "utf8");
const raw0051 = readFileSync(path0051, "utf8");
const raw0052 = readFileSync(path0052, "utf8");
const raw0053 = readFileSync(path0053, "utf8");
const raw0054 = readFileSync(path0054, "utf8");
const rawDecisions = readFileSync(pathDecisions, "utf8");
// Read-only: this file only ever READS lib/db/types.ts and
// lib/db/memory-adapter.ts (never modifies them) to mechanically ratchet
// the persist_probe_result_for_job status set across SQL/TypeScript/
// MemoryAdapter -- see section [8] below.
const rawTypesTs = readFileSync(pathTypesTs, "utf8");
const rawMemoryAdapterTs = readFileSync(pathMemoryAdapterTs, "utf8");

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
const code0053 = stripSqlComments(raw0053);
const code = stripSqlComments(raw0054);

function extractBody(sql: string, functionName: string, fromIndex = 0): string | null {
  const start = sql.indexOf(`public.${functionName}(`, fromIndex);
  if (start === -1) return null;
  const bodyStart = sql.indexOf("as $$", start);
  if (bodyStart === -1) return null;
  const bodyEnd = sql.indexOf("$$;", bodyStart + 5);
  if (bodyEnd === -1) return null;
  return sql.slice(bodyStart, bodyEnd + 3);
}

/**
 * Unlike extractBody (which starts at `as $$`, deliberately excluding
 * `language`/`security definer`/`set search_path`), this returns the
 * full definition from the function name through the end of its body —
 * the only correct region to check `search_path` against, since that
 * attribute is declared BEFORE `as $$`.
 */
function extractFullDefinition(sql: string, functionName: string, fromIndex = 0): string | null {
  const start = sql.indexOf(`public.${functionName}(`, fromIndex);
  if (start === -1) return null;
  const bodyStart = sql.indexOf("as $$", start);
  if (bodyStart === -1) return null;
  const bodyEnd = sql.indexOf("$$;", bodyStart + 5);
  if (bodyEnd === -1) return null;
  return sql.slice(start, bodyEnd + 3);
}

function main(): void {
  // ------------------------------------------------------------------
  // [1] No migration 0055 exists locally; 0054 is the last local file.
  //     0050-0053 are read only for cross-reference, never written by
  //     this migration.
  // ------------------------------------------------------------------
  console.log("\n[1] no 0055 — 0054 is the last local migration; 0050-0053 untouched by this file");

  check(
    "no file matching 0055* exists under supabase/migrations",
    !readdirSync(migrationsDir).some((f) => f.startsWith("0055"))
  );
  check("0054 file exists at the expected path", existsSync(path0054));
  check(
    "0053's 16-arg record_analysis_call_receipt_for_job signature is still present verbatim in 0053 (this migration does not edit that file)",
    /public\.record_analysis_call_receipt_for_job\(/.test(code0053) && /p_raw_request_body text default null/.test(code0053)
  );
  check(
    "0051's mark_protocol_execution_job_needs_review_for_ambiguity is still present verbatim in 0051",
    /public\.mark_protocol_execution_job_needs_review_for_ambiguity\(/.test(code0051)
  );
  check(
    "0050's claim_protocol_execution_job sweep is still present verbatim in 0050",
    /status = 'abandoned_exhausted', updated_at = now\(\)/.test(code0050)
  );
  check(
    "0052's record_provider_call_receipt_for_job (13 args) is still present verbatim in 0052",
    /public\.record_provider_call_receipt_for_job\(/.test(code0052) && /p_raw_response_body text default null/.test(code0052)
  );

  // ------------------------------------------------------------------
  // [2] probe_results — canonical_result_sha256, legacy vocabulary
  //     extension (additive only), dataset_source_type extension.
  // ------------------------------------------------------------------
  console.log("\n[2] probe_results — canonical_result_sha256, not_evaluated, protocol_execution_job");

  check(
    "canonical_result_sha256 added as a nullable text column",
    /add column if not exists canonical_result_sha256 text null;/.test(code)
  );
  check(
    "probe_results_canonical_result_sha256_format_check bounds it to 64 lowercase hex",
    /add constraint probe_results_canonical_result_sha256_format_check\s*\n\s*check \(canonical_result_sha256 is null or canonical_result_sha256 ~ '\^\[0-9a-f\]\{64\}\$'\);/.test(
      code
    )
  );
  // probe_results_verdict_check: verified via an unconditional, deterministic
  // drop-then-add (matching product_verdict_check's own pattern below) --
  // never an "add only if this exact name doesn't already exist" guard,
  // which is exactly what let the original 4-value definition survive
  // undetected under this same auto-generated name from migration 0003.
  // Negative self-tests FIRST, on throwaway in-memory copies of `code`
  // (never written to disk), before the real checks below are trusted.
  const OLD_PERMISSIVE_VERDICT_GUARD =
    "if not exists (select 1 from pg_constraint where conname = 'probe_results_verdict_check')";

  function verdictCheckDropIndex(sql: string): number {
    return sql.indexOf("drop constraint if exists probe_results_verdict_check;");
  }
  function verdictCheckAddIndex(sql: string): number {
    return sql.indexOf("add constraint probe_results_verdict_check");
  }
  function extractCheckedValues(sql: string, afterMarker: string): Set<string> | null {
    const idx = sql.indexOf(afterMarker);
    if (idx === -1) return null;
    const closeIdx = sql.indexOf(");", idx);
    if (closeIdx === -1) return null;
    return new Set([...sql.slice(idx, closeIdx).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!));
  }
  function setsEqualStrict(a: Set<string> | null, b: Set<string>): boolean {
    if (!a) return false;
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
  }
  const EXPECTED_FIVE_VALUES = new Set(["won", "partial", "lost", "not_relevant", "not_evaluated"]);

  check(
    "negative self-test: reintroducing the old permissive IF NOT EXISTS guard on a throwaway copy is correctly detected as present",
    (code + `\n  ${OLD_PERMISSIVE_VERDICT_GUARD} then\n`).includes(OLD_PERMISSIVE_VERDICT_GUARD)
  );
  check(
    "negative self-test: removing the DROP statement on a throwaway copy is correctly detected as missing",
    verdictCheckDropIndex(code.replace("drop constraint if exists probe_results_verdict_check;", "")) === -1
  );
  check(
    "negative self-test: a throwaway copy with ADD placed before DROP is correctly detected as wrong order",
    (() => {
      const swapped =
        "alter table public.probe_results\n  add constraint probe_results_verdict_check\n  check (verdict in ('won'));\n" +
        "alter table public.probe_results\n  drop constraint if exists probe_results_verdict_check;\n";
      const d = verdictCheckDropIndex(swapped);
      const a = verdictCheckAddIndex(swapped);
      return !(d !== -1 && a !== -1 && d < a);
    })()
  );
  check(
    "negative self-test: a throwaway copy of the real check clause with 'not_evaluated' removed is correctly detected as UNEQUAL to the expected five values",
    !setsEqualStrict(
      new Set([...(extractCheckedValues(code, "add constraint probe_results_verdict_check") ?? [])].filter((v) => v !== "not_evaluated")),
      EXPECTED_FIVE_VALUES
    )
  );
  check(
    "negative self-test: a throwaway copy of the real check clause with one invented sixth value is correctly detected as UNEQUAL to the expected five values",
    !setsEqualStrict(
      new Set([...(extractCheckedValues(code, "add constraint probe_results_verdict_check") ?? []), "totally_made_up_value"]),
      EXPECTED_FIVE_VALUES
    )
  );

  const verdictDropIdx = verdictCheckDropIndex(code);
  const verdictAddIdx = verdictCheckAddIndex(code);
  const verdictValues = extractCheckedValues(code, "add constraint probe_results_verdict_check");

  check(
    "the old permissive IF NOT EXISTS guard on probe_results_verdict_check no longer exists in the real migration",
    !code.includes(OLD_PERMISSIVE_VERDICT_GUARD)
  );
  check("probe_results_verdict_check: exactly one DROP CONSTRAINT IF EXISTS statement", verdictDropIdx !== -1);
  check("probe_results_verdict_check: exactly one ADD CONSTRAINT statement", verdictAddIdx !== -1);
  check("probe_results_verdict_check: the DROP appears before the ADD", verdictDropIdx !== -1 && verdictAddIdx !== -1 && verdictDropIdx < verdictAddIdx);
  check(
    "probe_results_verdict_check is (re-)added, unconditionally, with exactly the five values won/partial/lost/not_relevant/not_evaluated -- not just additively assumed, mechanically verified as a SET",
    setsEqualStrict(verdictValues, EXPECTED_FIVE_VALUES)
  );
  check(
    "probe_results_product_verdict_check's own deterministic drop-then-add pattern is unchanged (still IF EXISTS...DROP inside a DO block, then an unconditional ADD)",
    /if exists \(select 1 from pg_constraint where conname = 'probe_results_product_verdict_check'\) then\s*\n\s*alter table public\.probe_results drop constraint probe_results_product_verdict_check;\s*\n\s*end if;/.test(
      code
    )
  );
  check(
    "probe_results_product_verdict_check gains 'not_evaluated' additively",
    /add constraint probe_results_product_verdict_check\s*\n\s*check \(product_verdict in \('won', 'partial', 'lost', 'not_relevant', 'not_evaluated'\)\);/.test(
      code
    )
  );
  check(
    "probe_results_dataset_source_type_check gains 'protocol_execution_job' additively, three legacy values preserved",
    /'snapshot_request', 'manual_scan', 'legacy_unresolved', 'protocol_execution_job'/.test(code)
  );
  check(
    "no historical row is ever UPDATEd by this migration (additive-only, no backfill)",
    !/update public\.probe_results\b/.test(code)
  );

  // ------------------------------------------------------------------
  // [3] Three new alert-outbox tables — no UNIQUE(job_id, event_type);
  //     reason_code closed and conditional on event_type; append-only
  //     ACL; delivery_attempts additionally revokes DELETE/TRUNCATE.
  // ------------------------------------------------------------------
  console.log("\n[3] alert outbox tables — reason_code, append-only, no UNIQUE(job_id, event_type)");

  check(
    "protocol_execution_job_alerts has no UNIQUE(job_id, event_type) — a job may revisit needs_review repeatedly",
    !/unique\s*\(\s*job_id\s*,\s*event_type\s*\)/i.test(code)
  );
  check(
    "protocol_execution_job_alerts.reason_code is NOT NULL",
    /reason_code\s+text not null/.test(code)
  );
  check(
    "protocol_execution_job_alerts_reason_code_check closes needs_review to exactly the three known reasons, and abandoned_exhausted to attempts_exhausted",
    /'perplexity_outcome_unknown', 'analysis_outcome_unknown', 'ambiguous_external_call_sent_without_receipt'/.test(
      code
    ) && /reason_code = 'attempts_exhausted'/.test(code)
  );
  check(
    "protocol_execution_job_alerts reuses the existing composite unique keys (0050/0051) for its source FKs — no new unique key added",
    /references public\.protocol_attempts \(id, job_id, project_id\)/.test(code) &&
      /references public\.protocol_external_calls \(id, protocol_attempt_id, project_id\)/.test(code)
  );
  check(
    "protocol_execution_job_alerts is append-only: SELECT+INSERT only, no UPDATE/DELETE/TRUNCATE granted",
    /grant select, insert on table public\.protocol_execution_job_alerts to service_role;/.test(code)
  );
  check(
    "protocol_execution_job_alert_deliveries.status is closed to the six defined values, 'sent' never used",
    /check \(status in \('pending', 'claimed', 'request_sent', 'accepted', 'failed', 'needs_review_delivery'\)\)/.test(
      code
    ) && !/status\s+text[\s\S]{0,80}'sent'/.test(code)
  );
  check(
    "protocol_execution_job_alert_deliveries.attempt_count is capped at 3 by CHECK",
    /check \(attempt_count >= 0 and attempt_count <= 3\)/.test(code)
  );
  check(
    "protocol_execution_job_alert_delivery_attempts.outcome is closed to the five defined values",
    /check \(outcome in \('request_sent', 'accepted', 'http_error', 'ambiguous_under_24h', 'ambiguous_over_24h'\)\)/.test(
      code
    )
  );
  check(
    "protocol_execution_job_alert_delivery_attempts.attempt_seq is bounded 1..3",
    /check \(attempt_seq between 1 and 3\)/.test(code)
  );
  check(
    "protocol_execution_job_alert_delivery_attempts additionally revokes DELETE/TRUNCATE from service_role (monotone, no deletion, one terminal transition -- not strictly append-only, unlike the two other new tables)",
    /revoke delete, truncate on table public\.protocol_execution_job_alert_delivery_attempts from service_role;/.test(
      code
    )
  );
  check(
    "delivery_attempts null-pairing: finished_at present iff outcome is terminal",
    /check \(\s*\n\s*\(outcome = 'request_sent' and finished_at is null\)\s*\n\s*or \(outcome <> 'request_sent' and finished_at is not null\)/.test(
      code
    )
  );
  check(
    "delivery_attempts null-pairing: resend_email_id present iff outcome = 'accepted'",
    /\(outcome = 'accepted' and resend_email_id is not null\)/.test(code)
  );
  check(
    "delivery_attempts null-pairing: error_code present iff outcome = 'http_error'",
    /\(outcome = 'http_error' and error_code is not null\)/.test(code)
  );

  // ------------------------------------------------------------------
  // [4] persist_probe_result_for_job — strict content, race-safe
  //     insert, closed return, search_path pg_catalog/pg_temp.
  // ------------------------------------------------------------------
  console.log("\n[4] persist_probe_result_for_job — strict content, race-safe, closed return");

  const persistBody = extractBody(code, "persist_probe_result_for_job");
  check("persist_probe_result_for_job body extracted", persistBody !== null);
  const persistSig =
    /public\.persist_probe_result_for_job\(\s*\n\s*p_job_id uuid,\s*\n\s*p_claim_token uuid,\s*\n\s*p_project_id uuid,\s*\n\s*p_content jsonb\s*\n\s*\)/;
  check("persist_probe_result_for_job takes exactly (job_id, claim_token, project_id, content jsonb)", persistSig.test(code));
  check(
    "returns exactly status, probe_result_id, canonical_result_sha256 — never the row itself, never a raw body",
    /returns table \(\s*\n\s*status\s+text,\s*\n\s*probe_result_id\s+text,\s*\n\s*canonical_result_sha256\s+text\s*\n\s*\)|returns table \(\s*\n\s*status\s+text,\s*\n\s*probe_result_id\s+uuid,\s*\n\s*canonical_result_sha256\s+text\s*\n\s*\)/.test(
      code
    )
  );
  check(
    "persist_probe_result_for_job uses search_path = pg_catalog, pg_temp (never public)",
    (extractFullDefinition(code, "persist_probe_result_for_job")?.includes("set search_path = pg_catalog, pg_temp") ?? false)
  );
  check(
    "exact key set enforced: no missing, no extra key",
    persistBody !== null && persistBody.includes("k <> all (v_allowed_keys)") && persistBody.includes("not (p_content ? k)")
  );
  check("no JSON null accepted anywhere in p_content", persistBody !== null && persistBody.includes("e.value = 'null'::jsonb"));
  check(
    "nested competitors_mentioned/sources_cited validated object-type FIRST, in a separate pass, before any -/?& operator runs",
    persistBody !== null &&
      /jsonb_typeof\(el\) <> 'object'/.test(persistBody)
  );
  check(
    "cross invariant: product_position vs product_mentioned",
    persistBody !== null && persistBody.includes("v_product_position = 'absent' and v_product_mentioned = false")
  );
  check(
    "cross invariant: negative_claim_detected vs product_position",
    persistBody !== null && persistBody.includes("v_negative_claim_detected <> (v_product_position = 'negative')")
  );
  check(
    "cross invariant: cited_as_source vs client_source_count",
    persistBody !== null && persistBody.includes("v_cited_as_source <> (v_client_source_count > 0)")
  );
  check(
    "cross invariant: every platforms_referenced entry must correspond to a sources_cited entry",
    persistBody !== null && persistBody.includes("jsonb_array_elements_text(v_platforms) plat")
  );
  check(
    "run_position is derived server-side only via the exact same 4-branch mapping as mapProductPositionToRunPosition — never a caller-supplied value",
    persistBody !== null &&
      persistBody.includes("when 'primary' then 'primary_in_run'") &&
      persistBody.includes("when 'listed' then 'listed_in_run'") &&
      persistBody.includes("when 'negative' then 'listed_in_run'") &&
      persistBody.includes("when 'absent' then 'not_observed_in_run'")
  );
  check(
    "verdict/product_verdict are fixed 'not_evaluated' literals in the INSERT, never a computed value",
    persistBody !== null && /'not_evaluated', ''/.test(persistBody)
  );
  check(
    "raw_response_body/raw_response_body_sha256/full_request_body_sha256 are NULL for every M5 row",
    persistBody !== null && /null, null,\s*\n\s*v_job\.dataset_batch_id/.test(persistBody)
  );
  check(
    "canonical hash includes schema_version (its own, independent version number)",
    persistBody !== null && persistBody.includes("'schema_version', 1")
  );
  check(
    "canonical hash is computed via the real, existing _sha256_hex helper, never re-invented",
    persistBody !== null && persistBody.includes("public._sha256_hex(v_canonical::text)")
  );
  check(
    "raw_probe_request_sha256 is recomputed server-side via _sha256_hex, never accepted from the caller",
    persistBody !== null && persistBody.includes("public._sha256_hex(v_buyer_question_version.prompt_text)")
  );
  check(
    "race-safe insert: ON CONFLICT (probe_run_id) DO NOTHING, never a raw UNIQUE-violation exception reaching the caller",
    persistBody !== null && persistBody.includes("on conflict (probe_run_id) do nothing")
  );
  check(
    "ALREADY_PERSISTED only on exact hash match; any mismatch is CONFLICT, never an overwrite",
    persistBody !== null &&
      persistBody.includes("v_existing_hash = v_hash") &&
      persistBody.includes("'ALREADY_PERSISTED'") &&
      persistBody.includes("'CONFLICT'")
  );
  check(
    "persist_probe_result_for_job is service_role-only",
    /revoke all on function\s*\n\s*public\.persist_probe_result_for_job\(uuid, uuid, uuid, jsonb\) from public;/.test(code) &&
      /grant execute on function\s*\n\s*public\.persist_probe_result_for_job\(uuid, uuid, uuid, jsonb\) to service_role;/.test(code)
  );

  // ------------------------------------------------------------------
  // [4b] Corrective review fixes (DEFECT_01/02/03/05).
  // ------------------------------------------------------------------
  console.log("\n[4b] corrective fixes — safe integer casts, defensive lookups, claim index");

  check(
    "DEFECT_01: client_source_count is read as numeric and checked for exact integer-ness and int4 range BEFORE any ::integer cast",
    persistBody !== null &&
      persistBody.includes("v_client_source_count_numeric := (p_content ->> 'client_source_count')::numeric;") &&
      persistBody.includes("v_client_source_count_numeric <> trunc(v_client_source_count_numeric)") &&
      persistBody.includes("v_client_source_count_numeric > 2147483647") &&
      persistBody.includes("v_client_source_count := v_client_source_count_numeric::integer;")
  );
  check(
    "DEFECT_03: competitors_mentioned[].position is checked for exact integer-ness and range 1-500 in a pass strictly separate from the object/key/type pass, never a single flat OR that could reach a numeric cast on a non-numeric value",
    persistBody !== null &&
      persistBody.includes("(el ->> 'position')::numeric <> trunc((el ->> 'position')::numeric)") &&
      persistBody.includes("(el ->> 'position')::numeric > 500")
  );
  check(
    "DEFECT_02: PROTOCOL_NOT_FOUND / BUYER_QUESTION_VERSION_NOT_FOUND / PROBE_RUN_NOT_FOUND are explicit FOUND guards, never a continuation with a NULL record",
    persistBody !== null &&
      persistBody.includes("'PROTOCOL_NOT_FOUND'") &&
      persistBody.includes("'BUYER_QUESTION_VERSION_NOT_FOUND'") &&
      persistBody.includes("'PROBE_RUN_NOT_FOUND'")
  );
  check(
    "DEFECT_05: a dedicated partial index exists for claim_next_pending_alert's own candidate-selection predicate (status='pending' and attempt_count<3), ordered by created_at, distinct from the sweep's (status, lease_expires_at) index",
    /create index if not exists protocol_execution_job_alert_deliveries_pending_claim_idx\s*\n\s*on public\.protocol_execution_job_alert_deliveries \(created_at\)\s*\n\s*where status = 'pending' and attempt_count < 3;/.test(
      code
    )
  );
  check(
    "DEFECT_06: mark_protocol_execution_job_needs_review_for_ambiguity's redefinition restores the pre-existing explanatory comment verbatim, alongside the outbox addition (checked against raw, uncommented-stripped text -- 'code' has all -- comments removed by design)",
    /mark_protocol_execution_job_needs_review_for_ambiguity/.test(code) &&
      raw0054.includes(
        "Vérifié avant le fencing, comme ALREADY_SUCCEEDED dans D-020 : un\n  -- job déjà needs_review n'a plus de propriétaire actif à valider, et\n  -- ce rejeu doit rester idempotent plutôt que de tomber sur JOB_NOT_OWNED."
      )
  );

  // ------------------------------------------------------------------
  // [5] Four redefined RPCs — outbox emission only, in the same
  //     transaction as their existing status-changing UPDATE, via a
  //     CTE consuming its own RETURNING. Business logic unchanged.
  // ------------------------------------------------------------------
  console.log("\n[5] four redefined RPCs — outbox emission via same-statement CTE, no business-logic change");

  const providerBody = extractBody(code, "record_provider_call_receipt_for_job");
  check(
    "record_provider_call_receipt_for_job's needs_review UPDATE is now a CTE whose RETURNING feeds the same-statement outbox INSERT",
    providerBody !== null &&
      providerBody.includes("with transitioned as (") &&
      providerBody.includes("'perplexity_outcome_unknown'") &&
      providerBody.includes("insert into public.protocol_execution_job_alerts")
  );
  check(
    "record_provider_call_receipt_for_job's outbox insert also creates the corresponding delivery row in the same statement",
    providerBody !== null && providerBody.includes("insert into public.protocol_execution_job_alert_deliveries (alert_event_id)")
  );
  check(
    "record_provider_call_receipt_for_job keeps its existing 13-arg signature — no DROP needed",
    !new RegExp("drop function if exists public\\.record_provider_call_receipt_for_job").test(code)
  );

  const analysisBody = extractBody(code, "record_analysis_call_receipt_for_job");
  check(
    "record_analysis_call_receipt_for_job's needs_review UPDATE is now a CTE whose RETURNING feeds the same-statement outbox INSERT",
    analysisBody !== null &&
      analysisBody.includes("with transitioned as (") &&
      analysisBody.includes("'analysis_outcome_unknown'") &&
      analysisBody.includes("insert into public.protocol_execution_job_alerts")
  );
  check(
    "record_analysis_call_receipt_for_job keeps its existing 16-arg signature — no DROP needed",
    !new RegExp("drop function if exists public\\.record_analysis_call_receipt_for_job").test(code)
  );

  const ambiguityBody = extractBody(code, "mark_protocol_execution_job_needs_review_for_ambiguity");
  check(
    "mark_protocol_execution_job_needs_review_for_ambiguity's UPDATE is now a CTE chain (transitioned -> inserted_alert -> deliveries) with a final SELECT restoring v_job",
    ambiguityBody !== null &&
      ambiguityBody.includes("'ambiguous_external_call_sent_without_receipt'") &&
      ambiguityBody.includes("select * into v_job from transitioned")
  );

  const claimBody = extractBody(code, "claim_protocol_execution_job");
  check(
    "claim_protocol_execution_job's abandoned_exhausted sweep is now a CTE chain (abandoned -> inserted_alerts -> deliveries), set-based over every row the sweep touches",
    claimBody !== null &&
      claimBody.includes("with abandoned as (") &&
      claimBody.includes("'attempts_exhausted'") &&
      claimBody.includes("insert into public.protocol_execution_job_alert_deliveries")
  );
  check(
    "claim_protocol_execution_job keeps its existing 2-arg signature — no DROP needed",
    !new RegExp("drop function if exists public\\.claim_protocol_execution_job").test(code)
  );
  check(
    "none of the four redefined functions changes its own search_path from the established public, pg_temp",
    (extractFullDefinition(code, "record_provider_call_receipt_for_job")?.includes("set search_path = public, pg_temp") ?? false) &&
      (extractFullDefinition(code, "record_analysis_call_receipt_for_job")?.includes("set search_path = public, pg_temp") ?? false) &&
      (extractFullDefinition(code, "mark_protocol_execution_job_needs_review_for_ambiguity")?.includes(
        "set search_path = public, pg_temp"
      ) ?? false) &&
      (extractFullDefinition(code, "claim_protocol_execution_job")?.includes("set search_path = public, pg_temp") ?? false)
  );

  // ------------------------------------------------------------------
  // [6] Four alert-lifecycle RPCs — fencing, cap enforcement, stale
  //     reconciliation, closed payload, search_path pg_catalog/pg_temp.
  // ------------------------------------------------------------------
  console.log("\n[6] alert lifecycle RPCs — fencing, cap, stale reconciliation, closed payload");

  const claimAlertBody = extractBody(code, "claim_next_pending_alert");
  check("claim_next_pending_alert body extracted", claimAlertBody !== null);
  check(
    "claim_next_pending_alert reconciles claimed-with-expired-lease-and-no-request_sent back to pending",
    claimAlertBody !== null && claimAlertBody.includes("reset_claimed as")
  );
  check(
    "claim_next_pending_alert reconciles request_sent-with-expired-lease by attempt age (<24h vs >=24h)",
    claimAlertBody !== null && claimAlertBody.includes("is_under_24h") && claimAlertBody.includes("interval '24 hours'")
  );
  check(
    "under-24h reconciliation still respects the 3-attempt cap — >=3 goes to needs_review_delivery, never a 4th attempt",
    claimAlertBody !== null && claimAlertBody.includes("t.is_under_24h and t.attempt_count < 3")
  );
  check(
    "claim_next_pending_alert excludes attempt_count >= 3 from its own candidate selection",
    claimAlertBody !== null && claimAlertBody.includes("d.attempt_count < 3")
  );
  check(
    "claim_next_pending_alert's closed payload carries exactly the required fields plus reconciliation counters — no raw body/prompt/free text",
    /returns table \(\s*\n\s*status\s+text,\s*\n\s*delivery_id\s+uuid,\s*\n\s*alert_event_id\s+uuid,\s*\n\s*claim_token\s+uuid,\s*\n\s*attempt_count\s+integer,\s*\n\s*project_id\s+uuid,\s*\n\s*job_id\s+uuid,\s*\n\s*event_type\s+text,\s*\n\s*reason_code\s+text,\s*\n\s*idempotency_key\s+text,/.test(
      code
    )
  );
  check(
    "idempotency_key is deterministically derived from alert_event_id ('m5-alert:' prefix), never a fresh random value",
    claimAlertBody !== null && claimAlertBody.includes("'m5-alert:' || v_alert.alert_event_id::text")
  );

  const markSentBody = extractBody(code, "mark_alert_request_sent");
  check(
    "mark_alert_request_sent enforces the 3-attempt cap BEFORE creating any row (ALERT_ATTEMPT_CAP_EXCEEDED, no insert)",
    markSentBody !== null &&
      markSentBody.indexOf("ALERT_ATTEMPT_CAP_EXCEEDED") < markSentBody.indexOf("insert into public.protocol_execution_job_alert_delivery_attempts")
  );

  const receiptBody = extractBody(code, "record_alert_delivery_receipt");
  check(
    "record_alert_delivery_receipt gates its terminal UPDATE on delivery_id + attempt_id + outcome='request_sent' all at once — zero rows updated is checked via GET DIAGNOSTICS, never assumed",
    receiptBody !== null && receiptBody.includes("get diagnostics v_updated = row_count") && receiptBody.includes("ATTEMPT_ALREADY_TERMINAL")
  );
  check(
    "record_alert_delivery_receipt's backoff is jittered server-side (+/-20%) via a bounded random() expression, never left to the client",
    receiptBody !== null && receiptBody.includes("0.8 + (random() * 0.4)")
  );
  check(
    "attempt 1 failure backs off 30s, attempt 2 failure backs off 5 minutes (300s), both jittered",
    receiptBody !== null && receiptBody.includes("when 1 then 30 else 300 end")
  );
  check(
    "a permanent 4xx error, or the cap already at 3, goes straight to terminal 'failed' — never scheduled for retry",
    receiptBody !== null && receiptBody.includes("p_error_code = 'http_4xx_permanent' or v_delivery.attempt_count >= 3")
  );
  check(
    "ambiguity >=24h (or under-24h at the cap) always lands on needs_review_delivery, never a fresh HTTP attempt",
    receiptBody !== null && receiptBody.includes("v_next_status := 'needs_review_delivery'")
  );

  for (const [name, sig] of [
    ["claim_next_pending_alert", "public.claim_next_pending_alert(text, integer)"],
    ["renew_alert_lease", "public.renew_alert_lease(uuid, uuid, integer)"],
    ["mark_alert_request_sent", "public.mark_alert_request_sent(uuid, uuid)"],
    ["record_alert_delivery_receipt", "public.record_alert_delivery_receipt(uuid, uuid, uuid, text, integer, text, text)"],
  ] as const) {
    check(
      `${name} is service_role-only (REVOKE public/anon/authenticated, GRANT service_role)`,
      code.includes(`revoke all on function\n  ${sig} from public;`) &&
        code.includes(`grant execute on function\n  ${sig} to service_role;`)
    );
  }
  check(
    "all five new RPCs use search_path = pg_catalog, pg_temp (never public) — every application object explicitly public.-qualified",
    (extractFullDefinition(code, "persist_probe_result_for_job")?.includes("set search_path = pg_catalog, pg_temp") ?? false) &&
      (extractFullDefinition(code, "claim_next_pending_alert")?.includes("set search_path = pg_catalog, pg_temp") ?? false) &&
      (extractFullDefinition(code, "renew_alert_lease")?.includes("set search_path = pg_catalog, pg_temp") ?? false) &&
      (extractFullDefinition(code, "mark_alert_request_sent")?.includes("set search_path = pg_catalog, pg_temp") ?? false) &&
      (extractFullDefinition(code, "record_alert_delivery_receipt")?.includes("set search_path = pg_catalog, pg_temp") ?? false)
  );

  // ------------------------------------------------------------------
  // [7] Hygiene — no direct top-level DML on business tables outside a
  //     function body, no secrets, D-028 documented.
  // ------------------------------------------------------------------
  console.log("\n[7] hygiene — no top-level DML, no secrets, D-028 documented");

  check(
    "no top-level INSERT/UPDATE/DELETE of business data outside a function body or a read-only preflight's SELECT COUNT(*)",
    !/^\s*(insert into|update|delete from)\s+public\.(protocol_|analysis_|provider_|probe_)/im.test(
      code.replace(/as \$\$[\s\S]*?\$\$;/g, "")
    )
  );
  check(
    "no API key, service-role key, or connection-string pattern anywhere in this migration",
    !/SUPABASE_SERVICE_ROLE_KEY\s*=|sk-[a-zA-Z0-9]{10,}|postgres:\/\/[^ ]*:[^ ]*@/i.test(raw0054)
  );
  check("D-028 exists in docs/DECISIONS.md", /## D-028/.test(rawDecisions));

  // ------------------------------------------------------------------
  // [8] Permanent ratchet — persist_probe_result_for_job's status set
  //     must stay identical (as a SET, not merely a count) across the
  //     real SQL RPC body, the TypeScript PersistProbeResultForJobOutcome
  //     union, and MemoryAdapter's own persistProbeResultForJob body.
  //     This is a REGRESSION guard, not a one-off snapshot: a future
  //     19th SQL status added without updating types.ts/MemoryAdapter
  //     (or vice versa) must fail this check, not merely "be true today
  //     by coincidence" -- which is exactly what the negative self-test
  //     immediately below proves this checker actually detects, on a
  //     throwaway in-memory copy, before the real comparison is ever
  //     trusted.
  // ------------------------------------------------------------------
  console.log("\n[8] permanent ratchet — persist_probe_result_for_job status set identical across SQL/TypeScript/MemoryAdapter");

  function extractSqlStatusSet(sql: string, functionName: string): Set<string> {
    const body = extractBody(sql, functionName);
    if (!body) return new Set();
    return new Set([...body.matchAll(/'([A-Z][A-Z0-9_]*)'::text/g)].map((m) => m[1]!));
  }

  function extractTsUnionStatusSet(ts: string, typeName: string): Set<string> {
    const m = ts.match(new RegExp(`export type ${typeName} =([\\s\\S]*?);`));
    if (!m) return new Set();
    return new Set([...m[1]!.matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((mm) => mm[1]!));
  }

  /**
   * MemoryAdapter never writes `outcome: "STATUS"` for most statuses --
   * they flow through a shared `invalid("STATUS")` helper. Both call
   * shapes are matched so neither is silently under-counted.
   */
  function extractMemoryAdapterStatusSet(ts: string, methodName: string): Set<string> {
    const start = ts.indexOf(`async ${methodName}(`);
    if (start === -1) return new Set();
    const rest = ts.slice(start + methodName.length + 7);
    const nextMethodOffset = rest.search(/\n {2}async /);
    const body = nextMethodOffset === -1 ? ts.slice(start) : ts.slice(start, start + methodName.length + 7 + nextMethodOffset);
    const fromInvalidHelper = [...body.matchAll(/invalid\("([A-Z][A-Z0-9_]*)"\)/g)].map((m) => m[1]!);
    const fromOutcomeLiteral = [...body.matchAll(/outcome:\s*"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]!);
    return new Set([...fromInvalidHelper, ...fromOutcomeLiteral]);
  }

  function setsEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
  }

  function formatSet(s: Set<string>): string {
    return `{${[...s].sort().join(", ")}}`;
  }

  // Negative self-test FIRST: prove this checker actually detects a
  // removed status and an added, unexpected status -- on throwaway
  // in-memory copies, never written to disk -- before trusting it on
  // the real files below. A checker that always reports "equal" would
  // otherwise pass silently forever.
  const realSqlSet = extractSqlStatusSet(code, "persist_probe_result_for_job");
  const realTsSet = extractTsUnionStatusSet(rawTypesTs, "PersistProbeResultForJobOutcome");
  const realMemorySet = extractMemoryAdapterStatusSet(rawMemoryAdapterTs, "persistProbeResultForJob");

  check(
    "self-test sanity: the real SQL status set is non-empty (extractor actually found something, not silently vacuous)",
    realSqlSet.size > 0
  );

  const missingOneCopy = new Set(realSqlSet);
  const [anyStatus] = missingOneCopy;
  if (anyStatus) missingOneCopy.delete(anyStatus);
  check(
    "negative self-test: a copy of the real SQL set with one status deliberately removed is correctly detected as UNEQUAL to the real TypeScript set",
    !setsEqual(missingOneCopy, realTsSet)
  );

  const extraOneCopy = new Set(realSqlSet);
  extraOneCopy.add("TOTALLY_MADE_UP_STATUS_NOT_REAL");
  check(
    "negative self-test: a copy of the real SQL set with one unexpected extra status is correctly detected as UNEQUAL to the real TypeScript set",
    !setsEqual(extraOneCopy, realTsSet)
  );

  check(
    "negative self-test: the real, unmodified SQL/TypeScript sets ARE reported equal (checker is not simply always returning 'unequal')",
    setsEqual(realSqlSet, realTsSet)
  );

  // The real, permanent ratchet.
  check(
    `persist_probe_result_for_job: SQL status set (${realSqlSet.size}) exactly equals TypeScript PersistProbeResultForJobOutcome (${realTsSet.size})`,
    setsEqual(realSqlSet, realTsSet),
    setsEqual(realSqlSet, realTsSet) ? undefined : `SQL=${formatSet(realSqlSet)} TS=${formatSet(realTsSet)}`
  );
  check(
    `persist_probe_result_for_job: SQL status set (${realSqlSet.size}) exactly equals MemoryAdapter's own persistProbeResultForJob body (${realMemorySet.size})`,
    setsEqual(realSqlSet, realMemorySet),
    setsEqual(realSqlSet, realMemorySet) ? undefined : `SQL=${formatSet(realSqlSet)} MEMORY=${formatSet(realMemorySet)}`
  );
  check(
    `persist_probe_result_for_job: TypeScript union (${realTsSet.size}) exactly equals MemoryAdapter (${realMemorySet.size})`,
    setsEqual(realTsSet, realMemorySet),
    setsEqual(realTsSet, realMemorySet) ? undefined : `TS=${formatSet(realTsSet)} MEMORY=${formatSet(realMemorySet)}`
  );
  check("all three sets have exactly 18 members", realSqlSet.size === 18 && realTsSet.size === 18 && realMemorySet.size === 18);

  // ------------------------------------------------------------------
  // [9] PL/pgSQL RETURNS TABLE output-column shadowing ratchet (Run 7
  //     forensics, migration 0054). Postgres's default
  //     plpgsql.variable_conflict = 'error' turns every RETURNS TABLE
  //     column into an implicit variable visible for the whole function
  //     body. An unqualified column reference on an unaliased target
  //     relation is ambiguous whenever its name collides with one of
  //     those implicit variables -- exactly what crashed Run 7's B2
  //     replay inside persist_probe_result_for_job. Six such sites were
  //     found across five functions; all six are fixed here by relation
  //     aliasing + qualification only (no signature, ACL, owner,
  //     SECURITY DEFINER, search_path, predicate, value, or ordering
  //     change). Every site below is checked three ways: the qualified
  //     form is present in the real file, the unqualified form is
  //     absent from the real file, and a throwaway mutation that
  //     reintroduces the unqualified form is independently proven
  //     detectable (never trusted vacuously).
  // ------------------------------------------------------------------
  console.log("\n[9] plpgsql RETURNS TABLE output-column shadowing — six sites, five functions, all qualified");

  function extractReturnsTableNames(sql: string, functionName: string, fromIndex = 0): string[] | null {
    const start = sql.indexOf(`public.${functionName}(`, fromIndex);
    if (start === -1) return null;
    const rtIdx = sql.indexOf("returns table (", start);
    if (rtIdx === -1) return null;
    const openIdx = rtIdx + "returns table (".length - 1;
    const closeIdx = sql.indexOf(")", openIdx + 1);
    if (closeIdx === -1) return null;
    const inner = sql.slice(openIdx + 1, closeIdx);
    return inner
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => s.split(/\s+/)[0]!);
  }

  function arraysEqualStrict(a: string[] | null, b: string[]): boolean {
    if (!a) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
  }

  const EXPECTED_RETURNS_TABLE: Record<string, string[]> = {
    persist_probe_result_for_job: ["status", "probe_result_id", "canonical_result_sha256"],
    record_provider_call_receipt_for_job: ["status", "external_call", "receipt"],
    record_analysis_call_receipt_for_job: ["status", "external_call", "receipt"],
    mark_protocol_execution_job_needs_review_for_ambiguity: ["status", "job"],
    claim_protocol_execution_job: ["status", "job", "claim_token"],
    claim_next_pending_alert: [
      "status",
      "delivery_id",
      "alert_event_id",
      "claim_token",
      "attempt_count",
      "project_id",
      "job_id",
      "event_type",
      "reason_code",
      "idempotency_key",
      "reconciled_stale_claimed_count",
      "reconciled_under_24h_count",
      "reconciled_over_24h_count",
    ],
    renew_alert_lease: ["status", "delivery_id"],
    mark_alert_request_sent: ["status", "attempt_id", "attempt_seq", "idempotency_key"],
    record_alert_delivery_receipt: ["status", "delivery_id", "final_delivery_status"],
  };

  check("nine RPC signatures accounted for", Object.keys(EXPECTED_RETURNS_TABLE).length === 9);

  for (const [fn, expected] of Object.entries(EXPECTED_RETURNS_TABLE)) {
    check(
      `${fn}: RETURNS TABLE output column names/order unchanged (${expected.length} columns) -- signature not touched by the shadowing fix`,
      arraysEqualStrict(extractReturnsTableNames(code, fn), expected)
    );
    const fullDef = extractFullDefinition(code, fn) ?? "";
    check(`${fn}: still SECURITY DEFINER`, /security definer/.test(fullDef));
    check(
      `${fn}: search_path unchanged (pg_catalog, pg_temp or public, pg_temp)`,
      /set search_path\s*=\s*(pg_catalog|public),\s*pg_temp/.test(fullDef)
    );
  }

  // --- Site 1: persist_probe_result_for_job ---
  const OLD_SITE_1 =
    "  select id, canonical_result_sha256 into v_existing_id, v_existing_hash\n" +
    "    from public.probe_results where probe_run_id = v_attempt.probe_run_id;";
  const NEW_SITE_1 =
    "  select pr.id, pr.canonical_result_sha256 into v_existing_id, v_existing_hash\n" +
    "    from public.probe_results pr where pr.probe_run_id = v_attempt.probe_run_id;";

  // --- Site 2: claim_next_pending_alert (final claim UPDATE) ---
  const OLD_SITE_2 =
    "  update public.protocol_execution_job_alert_deliveries\n" +
    "     set status = 'claimed', worker_id = p_worker_id, claim_token = v_token,\n" +
    "         lease_expires_at = now() + make_interval(secs => p_lease_seconds)\n" +
    "   where delivery_id = v_delivery.delivery_id\n" +
    "  returning * into v_delivery;";
  const NEW_SITE_2 =
    "  update public.protocol_execution_job_alert_deliveries d\n" +
    "     set status = 'claimed', worker_id = p_worker_id, claim_token = v_token,\n" +
    "         lease_expires_at = now() + make_interval(secs => p_lease_seconds)\n" +
    "   where d.delivery_id = v_delivery.delivery_id\n" +
    "  returning * into v_delivery;";

  // --- Site 3: renew_alert_lease ---
  const OLD_SITE_3 =
    "  update public.protocol_execution_job_alert_deliveries\n" +
    "     set lease_expires_at = now() + make_interval(secs => p_lease_seconds)\n" +
    "   where delivery_id = p_delivery_id;\n\n" +
    "  return query select 'RENEWED'::text, p_delivery_id;";
  const NEW_SITE_3 =
    "  update public.protocol_execution_job_alert_deliveries d\n" +
    "     set lease_expires_at = now() + make_interval(secs => p_lease_seconds)\n" +
    "   where d.delivery_id = p_delivery_id;\n\n" +
    "  return query select 'RENEWED'::text, p_delivery_id;";

  // --- Site 4: mark_alert_request_sent (INSERT ... RETURNING) ---
  const OLD_SITE_4 =
    "  insert into public.protocol_execution_job_alert_delivery_attempts (\n" +
    "    delivery_id, attempt_seq, idempotency_key, outcome, request_sent_at\n" +
    "  ) values (\n" +
    "    p_delivery_id, v_next_seq, v_key, 'request_sent', now()\n" +
    "  )\n" +
    "  returning attempt_id into v_attempt_id;";
  const NEW_SITE_4 =
    "  insert into public.protocol_execution_job_alert_delivery_attempts as a (\n" +
    "    delivery_id, attempt_seq, idempotency_key, outcome, request_sent_at\n" +
    "  ) values (\n" +
    "    p_delivery_id, v_next_seq, v_key, 'request_sent', now()\n" +
    "  )\n" +
    "  returning a.attempt_id into v_attempt_id;";

  // --- Site 5: record_alert_delivery_receipt (attempts UPDATE) ---
  const OLD_SITE_5 =
    "  update public.protocol_execution_job_alert_delivery_attempts\n" +
    "     set outcome = p_outcome,\n" +
    "         finished_at = now(),\n" +
    "         resend_email_id = case when p_outcome = 'accepted' then p_resend_email_id else null end,\n" +
    "         http_status = p_http_status,\n" +
    "         error_code = case when p_outcome = 'http_error' then p_error_code else null end\n" +
    "   where attempt_id = p_attempt_id and delivery_id = p_delivery_id and outcome = 'request_sent';";
  const NEW_SITE_5 =
    "  update public.protocol_execution_job_alert_delivery_attempts att\n" +
    "     set outcome = p_outcome,\n" +
    "         finished_at = now(),\n" +
    "         resend_email_id = case when p_outcome = 'accepted' then p_resend_email_id else null end,\n" +
    "         http_status = p_http_status,\n" +
    "         error_code = case when p_outcome = 'http_error' then p_error_code else null end\n" +
    "   where attempt_id = p_attempt_id and att.delivery_id = p_delivery_id and outcome = 'request_sent';";

  // --- Site 6: record_alert_delivery_receipt (deliveries UPDATE) ---
  const OLD_SITE_6 =
    "  update public.protocol_execution_job_alert_deliveries\n" +
    "     set status = v_next_status, next_attempt_at = v_next_attempt_at,\n" +
    "         worker_id = null, claim_token = null, lease_expires_at = null\n" +
    "   where delivery_id = p_delivery_id;\n\n" +
    "  return query select 'RECEIPT_RECORDED'::text, p_delivery_id, v_next_status;";
  const NEW_SITE_6 =
    "  update public.protocol_execution_job_alert_deliveries d\n" +
    "     set status = v_next_status, next_attempt_at = v_next_attempt_at,\n" +
    "         worker_id = null, claim_token = null, lease_expires_at = null\n" +
    "   where d.delivery_id = p_delivery_id;\n\n" +
    "  return query select 'RECEIPT_RECORDED'::text, p_delivery_id, v_next_status;";

  const SHADOWING_SITES: Array<{ name: string; fn: string; oldText: string; newText: string }> = [
    {
      name: "site 1 (persist_probe_result_for_job: id/canonical_result_sha256/probe_run_id)",
      fn: "persist_probe_result_for_job",
      oldText: OLD_SITE_1,
      newText: NEW_SITE_1,
    },
    {
      name: "site 2 (claim_next_pending_alert: final claim UPDATE, delivery_id)",
      fn: "claim_next_pending_alert",
      oldText: OLD_SITE_2,
      newText: NEW_SITE_2,
    },
    { name: "site 3 (renew_alert_lease: delivery_id)", fn: "renew_alert_lease", oldText: OLD_SITE_3, newText: NEW_SITE_3 },
    {
      name: "site 4 (mark_alert_request_sent: RETURNING attempt_id)",
      fn: "mark_alert_request_sent",
      oldText: OLD_SITE_4,
      newText: NEW_SITE_4,
    },
    {
      name: "site 5 (record_alert_delivery_receipt: attempts UPDATE, delivery_id)",
      fn: "record_alert_delivery_receipt",
      oldText: OLD_SITE_5,
      newText: NEW_SITE_5,
    },
    {
      name: "site 6 (record_alert_delivery_receipt: deliveries UPDATE, delivery_id)",
      fn: "record_alert_delivery_receipt",
      oldText: OLD_SITE_6,
      newText: NEW_SITE_6,
    },
  ];

  let qualifiedSiteCount = 0;
  for (const s of SHADOWING_SITES) {
    const newTextPresent = code.includes(s.newText);
    const mutated = newTextPresent ? code.replace(s.newText, s.oldText) : code;
    check(
      `negative self-test: reintroducing the unqualified form of ${s.name} on a throwaway copy is correctly detected as present`,
      newTextPresent && mutated.includes(s.oldText)
    );
    const isQualified = newTextPresent && !code.includes(s.oldText);
    check(`${s.name}: qualified form present in the real migration, unqualified form absent`, isQualified);
    if (isQualified) qualifiedSiteCount += 1;
  }

  const SHADOWING_FUNCTION_COUNT = new Set(SHADOWING_SITES.map((s) => s.fn)).size;
  const SHADOWING_SITE_COUNT = SHADOWING_SITES.length;
  const QUALIFIED_SITE_COUNT_AFTER = qualifiedSiteCount;
  const REMAINING_PROVEN_SHADOWING_SITE_COUNT = SHADOWING_SITE_COUNT - QUALIFIED_SITE_COUNT_AFTER;

  check("SHADOWING_FUNCTION_COUNT === 5", SHADOWING_FUNCTION_COUNT === 5, `SHADOWING_FUNCTION_COUNT=${SHADOWING_FUNCTION_COUNT}`);
  check("SHADOWING_SITE_COUNT === 6", SHADOWING_SITE_COUNT === 6, `SHADOWING_SITE_COUNT=${SHADOWING_SITE_COUNT}`);
  check(
    "QUALIFIED_SITE_COUNT_AFTER === 6",
    QUALIFIED_SITE_COUNT_AFTER === 6,
    `QUALIFIED_SITE_COUNT_AFTER=${QUALIFIED_SITE_COUNT_AFTER}`
  );
  check(
    "REMAINING_PROVEN_SHADOWING_SITE_COUNT === 0",
    REMAINING_PROVEN_SHADOWING_SITE_COUNT === 0,
    `REMAINING_PROVEN_SHADOWING_SITE_COUNT=${REMAINING_PROVEN_SHADOWING_SITE_COUNT}`
  );

  // --- Global re-audit across all nine 0054 RPCs: a structural scanner,
  //     not just the six known sites, so a NEW unqualified collision
  //     anywhere else in this migration is caught too. A bare occurrence
  //     of an output name is exempt only when it is (a) already
  //     dot-qualified, (b) the LHS of a SET assignment (never resolved
  //     against plpgsql variables), (c) inside an INSERT target column
  //     list, or (d) immediately after `as ` (an alias declaration).
  function findUnqualifiedOutputCollisions(body: string, outputNames: string[]): Array<{ name: string; snippet: string }> {
    const found: Array<{ name: string; snippet: string }> = [];
    // Exempt spans: INSERT target column lists (`insert into ... ( ... )` up to VALUES).
    const insertSpans: Array<[number, number]> = [];
    const insertRe = /insert into public\.\w+(?:\s+as\s+\w+)?\s*\(/g;
    let im: RegExpExecArray | null;
    while ((im = insertRe.exec(body))) {
      const openIdx = im.index + im[0].length - 1;
      let depth = 0;
      let j = openIdx;
      for (; j < body.length; j += 1) {
        if (body[j] === "(") depth += 1;
        else if (body[j] === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      insertSpans.push([openIdx, j]);
    }
    // Exempt spans: SET-clause assignment targets (identifier directly
    // followed by `=`, not `==`/`<=`/`>=`/`<>`, between `set` and the next
    // `where`/`returning`/end of statement).
    const setTargetIdx = new Set<number>();
    const setRe = /\bset\b/g;
    let sm: RegExpExecArray | null;
    while ((sm = setRe.exec(body))) {
      const from = sm.index + sm[0].length;
      const restIdx = body.slice(from).search(/\b(where|returning)\b|;/);
      const to = restIdx === -1 ? body.length : from + restIdx;
      const span = body.slice(from, to);
      const targetRe = /([a-z_][a-z0-9_]*)\s*=(?!=)/g;
      let tm: RegExpExecArray | null;
      while ((tm = targetRe.exec(span))) {
        setTargetIdx.add(from + tm.index);
      }
    }
    for (const name of outputNames) {
      const re = new RegExp(`(?<![\\w.])${name}(?!\\w)`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(body))) {
        const idx = m.index;
        const before2 = body.slice(Math.max(0, idx - 4), idx);
        if (/\bas\s*$/i.test(before2)) continue; // alias declaration
        if (insertSpans.some(([a, b]) => idx > a && idx < b)) continue; // INSERT target column list
        if (setTargetIdx.has(idx)) continue; // SET assignment target
        found.push({ name, snippet: body.slice(Math.max(0, idx - 25), idx + name.length + 15).replace(/\s+/g, " ") });
      }
    }
    return found;
  }

  console.log("\n  --- global re-audit: all nine 0054 RPCs, every RETURNS TABLE output name ---");
  let totalRemaining = 0;
  for (const [fn, outputs] of Object.entries(EXPECTED_RETURNS_TABLE)) {
    const body = extractBody(code, fn) ?? "";
    const collisions = findUnqualifiedOutputCollisions(body, outputs);
    for (const c of collisions) {
      console.log(`  ✗ ${fn} | output=${c.name} | UNQUALIFIED | ${c.snippet}`);
    }
    if (collisions.length === 0) {
      console.log(`  ✓ ${fn} | ${outputs.length} outputs | 0 unqualified collisions`);
    }
    totalRemaining += collisions.length;
  }
  const PLPGSQL_OUTPUT_COLUMN_SHADOWING_REMAINING = totalRemaining;
  check(
    "PLPGSQL_OUTPUT_COLUMN_SHADOWING_REMAINING === 0 (structural re-audit, all nine RPCs)",
    PLPGSQL_OUTPUT_COLUMN_SHADOWING_REMAINING === 0,
    `PLPGSQL_OUTPUT_COLUMN_SHADOWING_REMAINING=${PLPGSQL_OUTPUT_COLUMN_SHADOWING_REMAINING}`
  );

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "M5 0054 schema contract PASSED." : "M5 0054 schema contract FAILED.")
  );
  console.log(
    "\nThis test verifies migration 0054's TEXT only. It is not created in\n" +
      "any database, not applied to staging, not applied to Production."
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
