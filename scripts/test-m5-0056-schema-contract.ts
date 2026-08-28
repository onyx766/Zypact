#!/usr/bin/env tsx
/**
 * 0056 — static schema contract. No Docker, no database, no network.
 *
 * Reads the migration text and asserts the properties that make the
 * request evidence trustworthy: append-only by privilege, hash verified
 * server-side, and a marking RPC that reads the evidence before it
 * decides anything.
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

const SQL = readFileSync(
  path.join(process.cwd(), "supabase/migrations/0056_m5_external_call_request_evidence.sql"),
  "utf8"
);

function main(): void {
  console.log("[1] external_call_requests — append-only request evidence");
  check("the table is created", /create table if not exists public\.external_call_requests/.test(SQL));
  check(
    "one row per external call",
    /external_call_id\s+uuid not null unique/.test(SQL)
  );
  check("call_kind is a closed set", /call_kind\s+text not null check \(call_kind in \('perplexity', 'analysis'\)\)/.test(SQL));
  check("the body is not nullable", /request_body\s+text not null/.test(SQL));
  check(
    "the hash is verified against the body, server-side",
    /check \(request_body_sha256 = public\._sha256_hex\(request_body\)\)/.test(SQL)
  );
  check("the hash has a format check", /request_body_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/.test(SQL));
  check("tenant isolation via a composite FK", /foreign key \(external_call_id, project_id\)/.test(SQL));
  check("row level security is enabled", /alter table public\.external_call_requests enable row level security/.test(SQL));

  console.log("\n[2] Privileges — append-only, exactly like the receipt ledgers");
  check(
    "REVOKE ALL from every role, INSERT included",
    /revoke all on table public\.external_call_requests from public, anon, authenticated, service_role;/.test(SQL)
  );
  check(
    "service_role receives SELECT and nothing else",
    /grant select on table public\.external_call_requests to service_role;/.test(SQL) &&
      !/grant (insert|update|delete|all)[^;]*external_call_requests/i.test(SQL)
  );

  console.log("\n[3] mark_external_call_sent_for_job — eight arguments, evidence first");
  check(
    "the five-argument form is dropped, not overloaded",
    /drop function if exists public\.mark_external_call_sent_for_job\(uuid, uuid, uuid, uuid, uuid\);/.test(SQL)
  );
  const markStart = SQL.indexOf("public.mark_external_call_sent_for_job(\n");
const markBody = SQL.slice(markStart, SQL.indexOf("\n$$;", markStart));
  check("it takes the call kind", /p_call_kind text/.test(markBody));
  check("it takes the body", /p_request_body text/.test(markBody));
  check("it takes the hash", /p_request_body_sha256 text/.test(markBody));
  check(
    "the declared hash must cover the declared body",
    /p_request_body_sha256 <> public\._sha256_hex\(p_request_body\)/.test(markBody)
  );
  check("SENT is returned", /'SENT'::text/.test(markBody));
  check("ALREADY_SENT_SAME_EVIDENCE is returned", /'ALREADY_SENT_SAME_EVIDENCE'::text/.test(markBody));
  check("REQUEST_EVIDENCE_CONFLICT is returned", /'REQUEST_EVIDENCE_CONFLICT'::text/.test(markBody));

  const insertIdx = markBody.indexOf("insert into public.external_call_requests");
  const updateIdx = markBody.indexOf("set status = 'in_progress'");
  check(
    "the evidence insert precedes the status transition",
    insertIdx > 0 && updateIdx > 0 && insertIdx < updateIdx,
    `insert@${insertIdx} < update@${updateIdx}`
  );

  console.log("\n[4] Lock order — jobs, then calls, then evidence");
  // Every function body in this migration, so the check covers all of them.
  const bodies = SQL.split("language plpgsql").slice(1);
  const order = [...markBody.matchAll(/from public\.(protocol_execution_jobs|protocol_external_calls|external_call_requests)[\s\S]{0,120}?for update/g)]
    .map((m) => m[1]);
  check(
    "the marking RPC locks jobs, then the call, then the evidence",
    order.join(">") === "protocol_execution_jobs>protocol_external_calls>external_call_requests",
    order.join(">")
  );
  check(
    "every cancellation is table-qualified, so `status` can never be ambiguous (42702)",
    !/\n\s+and status = 'reserved'/.test(SQL)
  );
  check(
    "no function in this migration ever locks a call before its job",
    bodies.every((b) => {
      const seq = [...b.matchAll(/from public\.(protocol_execution_jobs|protocol_external_calls|protocol_attempts|external_call_requests)[\s\S]{0,120}?for update/g)].map((m) => m[1]);
      const first = seq[0];
      return first === undefined || first === "protocol_execution_jobs";
    })
  );

  console.log("\n[5] Receipt identity — every evidentiary field");
  for (const field of [
    "outcome", "http_status", "provider_request_id", "raw_response_sha256",
    "raw_response_body", "latency_ms",
  ]) {
    check(`provider identity compares ${field}`, new RegExp(`v_existing\\.${field} is not distinct from`).test(SQL));
  }
  check("provider identity compares actual_cost_usd", /v_call\.actual_cost_usd is not distinct from p_actual_cost_usd/.test(SQL));
  check("provider identity compares cost_basis", /v_call\.cost_basis is not distinct from p_cost_basis/.test(SQL));
  for (const field of [
    "provider", "model", "used_mock", "request_sha256", "raw_request_body",
    "response_sha256", "raw_content",
  ]) {
    check(`analysis identity compares ${field}`, new RegExp(`v_existing\\.${field} is not distinct from`).test(SQL));
  }
  check(
    "the existing durable receipt is returned for replay",
    (SQL.match(/'ALREADY_RECEIPTED_IDENTICAL'::text, v_call, v_existing/g) ?? []).length === 2
  );
  check(
    "a divergent receipt is returned too, for diagnosis",
    (SQL.match(/'RECEIPT_EVIDENCE_CONFLICT'::text, v_call, v_existing/g) ?? []).length === 2
  );
  check(
    "the analysis receipt cross-checks the request evidence",
    /v_evidence\.request_body is distinct from p_raw_request_body/.test(SQL)
  );
  check(
    "…except for a mock call, where D-027 mandates null request fields",
    /coalesce\(p_used_mock, false\) = false/.test(SQL)
  );

  console.log("\n[6] T1 — one transaction, inside the receipt RPC");
  check("the helper exists", /create or replace function public\._close_unknown_outcome_core/.test(SQL));
  check("it cancels unsent legs", /set status = 'cancelled'[\s\S]{0,300}(?:ec\.)?status = 'reserved'/.test(SQL));
  check("it terminalises the attempt", /update public\.protocol_attempts[\s\S]{0,200}terminalized_at = now\(\)/.test(SQL));
  check("it moves the job and emits the outbox", /perform public\._move_job_to_needs_review/.test(SQL));
  check(
    "both receipt RPCs call it rather than expecting a second application call",
    (SQL.match(/perform public\._close_unknown_outcome_core\(/g) ?? []).length === 2
  );
  check(
    "the helpers are private — no role may execute them",
    /revoke all on function public\._close_unknown_outcome_core[\s\S]{0,80}from public, anon, authenticated, service_role/.test(SQL) &&
      /revoke all on function public\._move_job_to_needs_review[\s\S]{0,80}from public, anon, authenticated, service_role/.test(SQL)
  );

  console.log("\n[7] T2 / T3 — closed destinations and real idempotence");
  check("T2 exists", /create or replace function\s+public\.fail_job_without_attempt_for_job/.test(SQL));
  check(
    "T2 derives the status from the reason, server-side",
    /p_reason in \('run_cap_exceeded', 'spend_cap_exceeded', 'retry_cap_exceeded'\)[\s\S]{0,80}v_target := 'failed'/.test(SQL) &&
      /p_reason in \('throttled_retries_exhausted', 'slot_budget_exhausted'\)[\s\S]{0,80}v_target := 'needs_review'/.test(SQL)
  );
  check("T2 refuses an unknown reason", /message = 'invalid_fail_job_without_attempt_for_job_args'/.test(SQL));
  check("T2 refuses while an attempt is open", /'ATTEMPT_STILL_OPEN'::text/.test(SQL));
  check("T3 exists", /create or replace function\s+public\.abort_attempt_and_fail_job_for_job/.test(SQL));
  check("T3 refuses while a call is in flight", /'CALL_STILL_IN_PROGRESS'::text/.test(SQL));
  check("T3 cancels only unsent legs", /status = 'cancelled'[\s\S]{0,300}and (?:ec\.)?status = 'reserved'/.test(SQL));

  const t3 = SQL.slice(SQL.indexOf("public.abort_attempt_and_fail_job_for_job("));
  const alreadyIdx = t3.indexOf("'ALREADY_ABORTED'::text");
  const fenceIdx = t3.indexOf("v_job.claim_token is distinct from p_claim_token");
  check(
    "T3 checks idempotence BEFORE fencing, so a replay after a lost commit still reports ALREADY_ABORTED",
    alreadyIdx > 0 && fenceIdx > 0 && alreadyIdx < fenceIdx,
    `already@${alreadyIdx} < fence@${fenceIdx}`
  );
  check("a partial state is surfaced, never completed", /'STATE_CONFLICT'::text/.test(t3));

  console.log("\n[7b] Parse-failure closure keeps the durable mark");
  const t4 = SQL.slice(SQL.indexOf("public.close_attempt_for_parse_failure_for_job("));
  check("the transition exists", /create or replace function\s+public\.close_attempt_for_parse_failure_for_job/.test(SQL));
  check(
    "it refuses unless the parse failure is already marked",
    /v_call\.parse_failed_at is null or v_call\.parse_failure_code is null/.test(t4) &&
      /'PARSE_NOT_MARKED'::text/.test(t4)
  );
  check(
    "it never clears the mark it closes around",
    !/parse_failed_at\s*=\s*null/.test(t4) && !/parse_failure_code\s*=\s*null/.test(t4)
  );
  check("it cancels only unsent legs", /status = 'cancelled'[\s\S]{0,300}(?:ec\.)?status = 'reserved'/.test(t4));
  check("it refuses while a leg is in flight", /'CALL_STILL_IN_PROGRESS'::text/.test(t4));
  check(
    "the attempt keeps the parse code as its termination reason",
    /termination_reason = v_call\.parse_failure_code/.test(t4)
  );
  check("the job moves to needs_review with an outbox row", /_move_job_to_needs_review\([\s\S]{0,80}'analysis_parse_failed'/.test(t4));
  {
    const a = t4.indexOf("'ALREADY_CLOSED'::text");
    const f = t4.indexOf("v_job.claim_token is distinct from p_claim_token");
    check("idempotence is checked before fencing", a > 0 && f > 0 && a < f, `already@${a} < fence@${f}`);
    check("a partial state is surfaced", /'STATE_CONFLICT'::text/.test(t4));
  }

  console.log("\n[8] Outbox reason codes");
  for (const code of [
    "request_evidence_conflict", "receipt_evidence_conflict",
    "throttled_retries_exhausted", "slot_budget_exhausted", "analysis_parse_failed",
  ]) {
    check(`the closed set gains '${code}'`, new RegExp(`'${code}'`).test(SQL));
  }
  check(
    "the constraint is replaced, not duplicated",
    /drop constraint protocol_execution_job_alerts_reason_code_check/.test(SQL)
  );

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "0056 schema contract PASSED." : "0056 schema contract FAILED.")
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
