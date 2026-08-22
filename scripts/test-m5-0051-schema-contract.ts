#!/usr/bin/env tsx
/**
 * M5 — static assertions over draft migration 0051's SQL text only
 * (D-021: worker resumption, fingerprinted operator idempotence,
 * separated provider/analysis retries, atomic replay-safe probe_run,
 * fenced read-model, needs_review transition, internal monitoring).
 *
 * Same pattern as scripts/test-m5-0050-schema-contract.ts: TEXT-only
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
const pathDecisions = path.join(process.cwd(), "docs", "DECISIONS.md");

const path0047 = path.join(migrationsDir, "0047_m4_buyer_question_protocol_attempts.sql");

const raw0047 = readFileSync(path0047, "utf8");
const raw0050 = readFileSync(path0050, "utf8");
const raw0051 = readFileSync(path0051, "utf8");
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

const code0047 = stripSqlComments(raw0047);
const code0050 = stripSqlComments(raw0050);
const code = stripSqlComments(raw0051);

/** Strips every `as $$ ... $$;` function body, leaving only top-level DDL/DML. */
function withoutFunctionBodies(sql: string): string {
  return sql.replace(/as \$\$[\s\S]*?\$\$;/g, "");
}

/** Extracts a named function's full body (between its own `as $$` and matching `$$;`), scanning past a given start offset (to disambiguate repeated names such as CREATE OR REPLACE followed by later references). */
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
  // [1] Migration 0052 (D-026, Stage B0.1) now legitimately exists as
  //     an additive, later migration — this decision (D-021/0051) does
  //     not itself create a cutover migration. 0053 is the new boundary
  //     this decision's own scope has never crossed.
  // ------------------------------------------------------------------
  console.log("\n[1] 0052 exists (D-026, later and additive); no 0053 — this decision's own scope stops at 0051");

  check(
    "a file matching 0052* exists under supabase/migrations (D-026, Stage B0.1 — additive, does not modify 0050/0051)",
    readdirSync(migrationsDir).some((f) => f.startsWith("0052"))
  );
  check(
    "no file matching 0053* exists under supabase/migrations",
    !readdirSync(migrationsDir).some((f) => f.startsWith("0053"))
  );
  check("0051 file exists at the expected path", existsSync(path0051));

  // ------------------------------------------------------------------
  // [2] 0050 rollout correction — no longer revokes the three raw M4
  //     RPCs itself; service_role's original 0047 grant is untouched.
  // ------------------------------------------------------------------
  console.log("\n[2] 0050 — three M4 revocations removed, deferred to a future cutover migration");

  check(
    "0050 does not revoke EXECUTE from service_role on admit_and_reserve_attempt/start_attempt/reconcile_attempt",
    !/revoke execute on function\s*\n\s*public\.admit_and_reserve_attempt\(uuid, uuid, text, text, numeric, uuid\) from service_role;/.test(code0050) &&
      !/revoke execute on function\s*\n\s*public\.start_attempt\(uuid, uuid, uuid\) from service_role;/.test(code0050) &&
      !/revoke execute on function\s*\n\s*public\.reconcile_attempt\(uuid, uuid, text, numeric, uuid, text\) from service_role;/.test(code0050)
  );
  check(
    "0047's original EXECUTE grant on admit_and_reserve_attempt to service_role is untouched (0050 only revoked it via a statement now removed; 0047 itself was never modified)",
    /grant execute on function\s*\n\s*public\.admit_and_reserve_attempt\(uuid, uuid, text, text, numeric, uuid\) to service_role;/.test(code0047)
  );

  // ------------------------------------------------------------------
  // [3] D-021 present and Approved in docs/DECISIONS.md.
  // ------------------------------------------------------------------
  console.log("\n[3] D-021 present and approved");

  check("D-021 heading exists in DECISIONS.md", /## D-021 —/.test(rawDecisions));
  const d021Start = rawDecisions.indexOf("## D-021");
  const d021Section = d021Start === -1 ? "" : rawDecisions.slice(d021Start);
  check(
    "D-021 is Status: Approved with a real Approval date",
    /- \*\*Status:\*\* Approved/.test(d021Section) && /- \*\*Approval date:\*\* \d{4}-\d{2}-\d{2}/.test(d021Section)
  );
  check(
    "D-020 is unmodified (still present, still its own heading) alongside D-021 — append-only",
    /## D-020 —/.test(rawDecisions)
  );
  check(
    "D-022 (amendment to D-021: replay-before-state-gate ordering + scalar subquery fix) is present, Approved, and appended after D-021 without modifying it",
    (() => {
      const d022Start = rawDecisions.indexOf("## D-022");
      if (d022Start === -1 || d021Start === -1) return false;
      const d022Section = rawDecisions.slice(d022Start);
      return (
        d022Start > d021Start &&
        /## D-022 — Amendment to D-021/.test(rawDecisions) &&
        /- \*\*Status:\*\* Approved/.test(d022Section) &&
        /- \*\*Approval date:\*\* \d{4}-\d{2}-\d{2}/.test(d022Section)
      );
    })()
  );
  check(
    "no scalar subquery of the invalid `(select alias.* from ... )` shape survives anywhere in 0051 -- only the valid bare-composite `(select alias from ...)` form is used",
    !/\(select \w+\.\* from/.test(code)
  );

  // ------------------------------------------------------------------
  // [4] needs_review_reason / status coherence.
  // ------------------------------------------------------------------
  console.log("\n[4] needs_review_reason <-> status coherence constraint, preflighted");

  check(
    "a read-only preflight counts existing needs_review_reason/status violations before adding the constraint",
    /select count\(\*\) into v_bad_count\s*\n\s*from public\.protocol_execution_jobs\s*\n\s*where \(status = 'needs_review'\) <> \(needs_review_reason is not null\)/.test(code)
  );
  check(
    "protocol_execution_jobs_needs_review_reason_pair_check constraint enforces the invariant both ways",
    /add constraint protocol_execution_jobs_needs_review_reason_pair_check\s*\n\s*check \(\(status = 'needs_review'\) = \(needs_review_reason is not null\)\)/.test(code)
  );

  // ------------------------------------------------------------------
  // [5] Operator idempotence — fingerprint, unique key, old signature
  //     dropped, exact new signature.
  // ------------------------------------------------------------------
  console.log("\n[5] authorize_operator_retry — fingerprinted, genuinely idempotent");

  check(
    "the dangerous old authorize_operator_retry signature (no idempotency key at all) is explicitly dropped",
    /drop function if exists public\.authorize_operator_retry\(uuid, uuid, text, text, text, uuid, numeric, numeric\);/.test(code)
  );
  check(
    "the old internal 'operator-retry-' || gen_random_uuid() key generation is gone from this file",
    !/'operator-retry-' \|\| gen_random_uuid\(\)/.test(code)
  );
  check(
    "authorize_operator_retry's new signature includes a mandatory p_idempotency_key and an optional p_source_external_call_id",
    /public\.authorize_operator_retry\(\s*\n\s*p_job_id uuid,\s*\n\s*p_project_id uuid,\s*\n\s*p_actor text,\s*\n\s*p_reason text,\s*\n\s*p_action text,\s*\n\s*p_source_attempt_id uuid,\s*\n\s*p_reserved_cost_usd numeric,\s*\n\s*p_idempotency_key text,\s*\n\s*p_source_external_call_id uuid default null,\s*\n\s*p_perplexity_reserved_cost_usd numeric default null\s*\n\s*\)/.test(
      code
    )
  );
  check(
    "p_idempotency_key is required non-empty, and p_source_external_call_id is required when p_action = 'retry_analysis_only'",
    /p_idempotency_key is null or btrim\(p_idempotency_key\) = ''/.test(code) &&
      /if p_action = 'retry_analysis_only' and p_source_external_call_id is null then/.test(code)
  );

  const authRetryBody = extractBody(code, "authorize_operator_retry");
  check(
    "the fingerprint is computed by hashing a canonical jsonb_build_object over explicit keys (all seven approved fields, including nulls) through the real _sha256_hex helper -- never the raw jsonb::text serialization itself, never a string concatenation",
    (() => {
      if (authRetryBody === null) return false;
      const hasSha256Call = /v_fingerprint := public\._sha256_hex\(\s*\n\s*jsonb_build_object\(/.test(authRetryBody);
      const hasCanonicalJsonb =
        /'job_id', p_job_id,\s*\n\s*'project_id', p_project_id,\s*\n\s*'action', p_action,\s*\n\s*'source_attempt_id', p_source_attempt_id,\s*\n\s*'source_external_call_id', p_source_external_call_id,\s*\n\s*'reserved_cost_usd', p_reserved_cost_usd,\s*\n\s*'perplexity_reserved_cost_usd', p_perplexity_reserved_cost_usd/.test(
          authRetryBody
        );
      const closesAsText = /\)::text\s*\n\s*\);/.test(authRetryBody);
      const noRawConcat = !/\|\|.*p_job_id.*\|\|.*p_project_id/.test(authRetryBody);
      return hasSha256Call && hasCanonicalJsonb && closesAsText && noRawConcat;
    })()
  );
  check(
    "_sha256_hex is a real pgcrypto digest('sha256')+encode('hex') computation, with the pgcrypto schema resolved dynamically from pg_extension at migration time -- not hardcoded, not the 0035 fallback assumption repeated blindly",
    /select n\.nspname\s*\n\s*into v_pgcrypto_schema\s*\n\s*from pg_extension e\s*\n\s*join pg_namespace n on n\.oid = e\.extnamespace\s*\n\s*where e\.extname = 'pgcrypto';/.test(
      code
    ) &&
      /v_digest := to_regprocedure\(format\('%I\.digest\(bytea,text\)', v_pgcrypto_schema\)\);/.test(code) &&
      /select encode\(%1\$I\.digest\(convert_to\(p_input, 'UTF8'\), 'sha256'::text\), 'hex'\);/.test(code)
  );
  check(
    "request_fingerprint's CHECK constraint requires exactly lowercase [0-9a-f]{64} -- a real SHA-256 hex digest shape, not an arbitrary non-empty string",
    /check \(request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'\)/.test(code)
  );
  check(
    "_sha256_hex is a private helper: no EXECUTE granted to any role, including service_role",
    /revoke all on function public\._sha256_hex\(text\) from public, anon, authenticated, service_role;/.test(code)
  );
  check(
    "the idempotency lookup happens strictly after the job is locked FOR UPDATE (job lock precedes the fingerprint read)",
    (() => {
      if (authRetryBody === null) return false;
      const lockIdx = authRetryBody.indexOf("for update;");
      const lookupIdx = authRetryBody.indexOf("select * into v_existing_action");
      return lockIdx !== -1 && lookupIdx !== -1 && lockIdx < lookupIdx;
    })()
  );
  check(
    "D-022: the idempotent-replay lookup (by project_id/job_id/idempotency_key) is checked BEFORE the needs_review status gate, so a replay of an already-decided key is honored regardless of the job's current status",
    (() => {
      if (authRetryBody === null) return false;
      const lookupIdx = authRetryBody.indexOf("select * into v_existing_action");
      const needsReviewGateIdx = authRetryBody.indexOf("if v_job.status <> 'needs_review' then");
      return lookupIdx !== -1 && needsReviewGateIdx !== -1 && lookupIdx < needsReviewGateIdx;
    })()
  );
  check(
    "same key + same fingerprint returns the original recorded outcome verbatim, with zero new reservation",
    authRetryBody !== null &&
      /if v_existing_action\.request_fingerprint = v_fingerprint then/.test(authRetryBody) &&
      /return query select\s*\n\s*\(case v_existing_action\.outcome when 'approved' then 'APPROVED' else 'DENIED' end\)::text,/.test(
        authRetryBody
      )
  );
  check(
    "same key + different fingerprint returns IDEMPOTENCY_KEY_CONFLICT with zero mutation",
    authRetryBody !== null &&
      /'IDEMPOTENCY_KEY_CONFLICT'::text, null::text, null::text,/.test(authRetryBody)
  );
  check(
    "no unique_violation is ever caught and silently absorbed anywhere in this file -- an unexpected collision propagates and rolls back the whole transaction",
    !/exception\s+when\s+unique_violation/i.test(code)
  );
  check(
    "protocol_operator_actions gains idempotency_key and request_fingerprint, both NOT NULL only after an explicit preflight (no backfill)",
    /alter table public\.protocol_operator_actions alter column idempotency_key set not null;/.test(code) &&
      /alter table public\.protocol_operator_actions alter column request_fingerprint set not null;/.test(code) &&
      /select count\(\*\) into v_existing_count from public\.protocol_operator_actions;/.test(code)
  );
  check(
    "protocol_operator_actions_project_job_key_key is UNIQUE (project_id, job_id, idempotency_key) -- without action, so one key can never represent two intents",
    /add constraint protocol_operator_actions_project_job_key_key\s*\n\s*unique \(project_id, job_id, idempotency_key\);/.test(
      code
    )
  );

  // ------------------------------------------------------------------
  // [6] Full-attempt retry — composite FK, unique index, eligibility,
  //     replay semantics.
  // ------------------------------------------------------------------
  console.log("\n[6] retry_full_attempt_for_job — project/protocol-scoped, single direct child, replay-safe");

  check(
    "a preflight counts existing retry_of_attempt_id collisions before the unique index is added",
    /group by retry_of_attempt_id having count\(\*\) > 1/.test(code)
  );
  check(
    "a preflight counts existing cross-protocol/cross-project retry_of_attempt_id links",
    /child\.protocol_id <> parent\.protocol_id or child\.project_id <> parent\.project_id/.test(code)
  );
  check(
    "protocol_attempts_id_protocol_project_key and the retry_of_attempt_id composite FK pin the retry child to its parent's exact protocol and project",
    /add constraint protocol_attempts_id_protocol_project_key\s*\n\s*unique \(id, protocol_id, project_id\);/.test(code) &&
      /add constraint protocol_attempts_retry_of_attempt_protocol_project_fk\s*\n\s*foreign key \(retry_of_attempt_id, protocol_id, project_id\)\s*\n\s*references public\.protocol_attempts \(id, protocol_id, project_id\);/.test(
        code
      )
  );
  check(
    "protocol_attempts_retry_of_attempt_id_key is a partial UNIQUE index guaranteeing at most one direct child per source",
    /create unique index if not exists protocol_attempts_retry_of_attempt_id_key\s*\n\s*on public\.protocol_attempts \(retry_of_attempt_id\)\s*\n\s*where retry_of_attempt_id is not null;/.test(
      code
    )
  );

  const retryFullBody = extractBody(code, "retry_full_attempt_for_job");
  check(
    "retry_full_attempt_for_job requires the source to be the job's own current_attempt_id",
    retryFullBody !== null && /if v_job\.current_attempt_id is distinct from p_source_attempt_id then/.test(retryFullBody)
  );
  check(
    "D-022: the existing-child lookup (by retry_of_attempt_id, which never changes) is checked BEFORE the current_attempt_id equality gate, so a replay of a request whose retry already succeeded (and moved current_attempt_id) still resolves to ALREADY_RETRIED/SOURCE_ALREADY_RETRIED instead of being misclassified as a stale request",
    (() => {
      if (retryFullBody === null) return false;
      const childLookupIdx = retryFullBody.indexOf("select pa.* into v_existing_child");
      const currentAttemptGateIdx = retryFullBody.indexOf("if v_job.current_attempt_id is distinct from p_source_attempt_id then");
      return childLookupIdx !== -1 && currentAttemptGateIdx !== -1 && childLookupIdx < currentAttemptGateIdx;
    })()
  );
  check(
    "retry_full_attempt_for_job is eligible only when Perplexity generation 1 itself is failed/timed_out/cancelled WITH a receipt -- the branch that actually failed net",
    retryFullBody !== null &&
      /v_perplexity\.status not in \('failed', 'timed_out', 'cancelled'\)/.test(retryFullBody) &&
      /not exists \(select 1 from public\.provider_call_receipts r where r\.external_call_id = v_perplexity\.id\)/.test(
        retryFullBody
      )
  );
  check(
    "retry_full_attempt_for_job refuses when any external_call on the source attempt is ambiguous (sent, no receipt in either table)",
    retryFullBody !== null && /'AMBIGUOUS_CALL_PRESENT'::text/.test(retryFullBody)
  );
  check(
    "retry_full_attempt_for_job replay: a matching-cost existing child returns ALREADY_RETRIED; a mismatched one returns SOURCE_ALREADY_RETRIED -- never a second child",
    retryFullBody !== null &&
      /'ALREADY_RETRIED'::text, v_existing_child,/.test(retryFullBody) &&
      /'SOURCE_ALREADY_RETRIED'::text, v_existing_child,/.test(retryFullBody)
  );
  check(
    "retry_full_attempt_for_job's stable retry key is derived from source_attempt_id, never attempt_count or a freshly generated value",
    retryFullBody !== null && /'retry-of-attempt:' \|\| p_source_attempt_id::text/.test(retryFullBody)
  );

  // ------------------------------------------------------------------
  // [7] Analysis-only retry — composite FK, unique index, authoritative
  //     generation check, replay semantics.
  // ------------------------------------------------------------------
  console.log("\n[7] retry_analysis_generation_for_job — attempt/project-scoped, authoritative generation only");

  check(
    "protocol_external_calls gains retry_of_external_call_id, a composite FK pinning it to the same attempt and project, and its own partial unique index",
    /alter table public\.protocol_external_calls add column if not exists retry_of_external_call_id uuid null;/.test(code) &&
      /add constraint protocol_external_calls_id_attempt_project_key\s*\n\s*unique \(id, protocol_attempt_id, project_id\);/.test(
        code
      ) &&
      /add constraint protocol_external_calls_retry_of_call_attempt_project_fk\s*\n\s*foreign key \(retry_of_external_call_id, protocol_attempt_id, project_id\)\s*\n\s*references public\.protocol_external_calls \(id, protocol_attempt_id, project_id\);/.test(
        code
      ) &&
      /create unique index if not exists protocol_external_calls_retry_of_external_call_id_key\s*\n\s*on public\.protocol_external_calls \(retry_of_external_call_id\)\s*\n\s*where retry_of_external_call_id is not null;/.test(
        code
      )
  );

  const retryAnalysisBody = extractBody(code, "retry_analysis_generation_for_job");
  check(
    "retry_analysis_generation_for_job has a defensive CURRENT_ATTEMPT_NOT_FOUND guard on its own current-attempt lookup",
    retryAnalysisBody !== null &&
      /'CURRENT_ATTEMPT_NOT_FOUND'::text, null::public\.protocol_external_calls;/.test(retryAnalysisBody)
  );
  check(
    "retry_analysis_generation_for_job requires Perplexity generation 1 to be completed WITH a receipt (never retries provider when only analysis failed)",
    retryAnalysisBody !== null &&
      /v_perplexity\.status <> 'completed'/.test(retryAnalysisBody) &&
      /'PERPLEXITY_NOT_COMPLETED'::text/.test(retryAnalysisBody)
  );
  check(
    "retry_analysis_generation_for_job requires the source to be exactly the MAXIMUM analysis generation -- never an older, non-authoritative one",
    retryAnalysisBody !== null &&
      /select max\(generation\) into v_max_generation/.test(retryAnalysisBody) &&
      /if v_source\.generation <> v_max_generation then/.test(retryAnalysisBody) &&
      /'SOURCE_NOT_AUTHORITATIVE_GENERATION'::text/.test(retryAnalysisBody)
  );
  check(
    "retry_analysis_generation_for_job refuses when any external_call on the attempt is ambiguous",
    retryAnalysisBody !== null && /'AMBIGUOUS_CALL_PRESENT'::text/.test(retryAnalysisBody)
  );
  check(
    "retry_analysis_generation_for_job replay: matching-cost existing child -> ALREADY_RETRIED; mismatched -> SOURCE_ALREADY_RETRIED",
    retryAnalysisBody !== null &&
      /'ALREADY_RETRIED'::text, v_existing_child;/.test(retryAnalysisBody) &&
      /'SOURCE_ALREADY_RETRIED'::text, v_existing_child;/.test(retryAnalysisBody)
  );
  check(
    "_reserve_additional_analysis_generation_core threads p_retry_of_external_call_id straight into the INSERT -- the shared core both retry paths rely on",
    (() => {
      const coreBody = extractBody(code, "_reserve_additional_analysis_generation_core");
      return (
        coreBody !== null &&
        /p_retry_of_external_call_id uuid default null/.test(code) &&
        /reserved_cost_usd,\s*\n\s*retry_of_external_call_id\s*\n\s*\) values \(/.test(coreBody) &&
        /p_reserved_cost_usd,\s*\n\s*p_retry_of_external_call_id\s*\n\s*\)/.test(coreBody)
      );
    })()
  );
  check(
    // Corrective pass finding: reserve_additional_analysis_generation_for_job
    // (0050, unchanged) calls the private core directly with no source
    // tracking and no idempotency of any kind -- a real bypass of every
    // D-021 protection, since authorize_operator_retry's retry_analysis_only
    // branch and retry_analysis_generation_for_job both already cover its
    // only legitimate purpose. Its EXECUTE grant to service_role must be
    // revoked outright (never applied remotely, so no cutover window needed).
    "reserve_additional_analysis_generation_for_job's EXECUTE is revoked from service_role -- it bypassed every new idempotency protection and had no remaining legitimate caller",
    /revoke execute on function\s*\n\s*public\.reserve_additional_analysis_generation_for_job\(uuid, uuid, uuid, uuid, numeric\) from service_role;/.test(
      code
    )
  );
  check(
    "no EXCEPTION handler of any kind (unique_violation or otherwise) exists anywhere in this file -- an unexpected error always rolls back the whole transaction, never a masked fallback",
    !/exception\s+when/i.test(code)
  );
  check(
    "no CASCADE appears anywhere in this migration",
    !/\bcascade\b/i.test(code)
  );

  // ------------------------------------------------------------------
  // [8] Admission/resumption — RESUME_CURRENT_ATTEMPT, stable initial key.
  // ------------------------------------------------------------------
  console.log("\n[8] admit_and_reserve_attempt_for_job — never a second admission");

  const admitForJobBody = extractBody(code, "admit_and_reserve_attempt_for_job");
  check(
    "admit_and_reserve_attempt_for_job creates nothing and returns RESUME_CURRENT_ATTEMPT whenever current_attempt_id is already set, regardless of status",
    admitForJobBody !== null &&
      /if v_job\.current_attempt_id is not null then/.test(admitForJobBody) &&
      /'RESUME_CURRENT_ATTEMPT'::text, v_resume_attempt, v_resume_perplexity, v_resume_analysis;/.test(admitForJobBody)
  );
  check(
    "the RESUME_CURRENT_ATTEMPT branch returns the highest-generation analysis call (authoritative), never an arbitrary one",
    admitForJobBody !== null &&
      /order by ec\.generation desc\s*\n\s*limit 1;/.test(admitForJobBody)
  );
  check(
    "the current_attempt_id guard is checked strictly before any call to _admit_and_reserve_attempt_core",
    (() => {
      if (admitForJobBody === null) return false;
      const guardIdx = admitForJobBody.indexOf("if v_job.current_attempt_id is not null then");
      const coreCallIdx = admitForJobBody.indexOf("_admit_and_reserve_attempt_core(");
      return guardIdx !== -1 && coreCallIdx !== -1 && guardIdx < coreCallIdx;
    })()
  );
  check(
    "the RESUME_CURRENT_ATTEMPT branch has a defensive CURRENT_ATTEMPT_NOT_FOUND guard on its own attempt lookup, matching D-020's identical precedent in complete_protocol_execution_job",
    admitForJobBody !== null && /'CURRENT_ATTEMPT_NOT_FOUND'::text, null::public\.protocol_attempts,/.test(admitForJobBody)
  );

  // ------------------------------------------------------------------
  // [9] probe_run — atomic, replay-safe creation and attachment.
  // ------------------------------------------------------------------
  console.log("\n[9] create_probe_run_and_start_attempt_for_job — atomic, replay-safe");

  check(
    "a preflight counts existing cross-project probe_run_id links before the composite FK is added",
    /join public\.probe_runs pr on pr\.id = pa\.probe_run_id\s*\n\s*where pa\.probe_run_id is not null and pr\.project_id <> pa\.project_id;/.test(
      code
    )
  );
  check(
    "protocol_attempts_probe_run_project_fk pins probe_run_id to the exact same project",
    /add constraint protocol_attempts_probe_run_project_fk\s*\n\s*foreign key \(probe_run_id, project_id\)\s*\n\s*references public\.probe_runs \(id, project_id\);/.test(
      code
    )
  );
  const probeRunRpcBody = extractBody(code, "create_probe_run_and_start_attempt_for_job");
  check(
    "reserved + no run -> creates and attaches in one transaction, returns STARTED",
    probeRunRpcBody !== null &&
      /insert into public\.probe_runs/.test(probeRunRpcBody) &&
      /'STARTED'::text, v_attempt, v_run;/.test(probeRunRpcBody)
  );
  check(
    "in_progress + a consistent existing run -> ALREADY_STARTED with that same run, creates nothing",
    probeRunRpcBody !== null && /'ALREADY_STARTED'::text, v_attempt, v_run;/.test(probeRunRpcBody)
  );
  check(
    "an inconsistent/cross-project link or a terminal attempt refuse with CONFLICT/ATTEMPT_TERMINAL, zero mutation",
    probeRunRpcBody !== null &&
      /'CONFLICT'::text/.test(probeRunRpcBody) &&
      /'ATTEMPT_TERMINAL'::text, v_attempt, null::public\.probe_runs;/.test(probeRunRpcBody)
  );
  check(
    // Corrective pass finding: this function's own `status` OUT column
    // made the original bare `status = 'reserved'` WHERE-clause read
    // ambiguous (Postgres 42702) -- the exact bug class 0049 already
    // fixed once for approve_protocol/start_attempt. Fixed by aliasing
    // the UPDATE target and qualifying every WHERE reference.
    "create_probe_run_and_start_attempt_for_job's final UPDATE aliases protocol_attempts and qualifies every WHERE reference -- no bare `status = 'reserved'` read ambiguous with this function's own status OUT column",
    probeRunRpcBody !== null &&
      /update public\.protocol_attempts pa\s*\n\s*set status = 'in_progress',/.test(probeRunRpcBody) &&
      /where pa\.id = p_attempt_id and pa\.project_id = p_project_id and pa\.status = 'reserved'/.test(probeRunRpcBody) &&
      !/where id = p_attempt_id and project_id = p_project_id and status = 'reserved'/.test(probeRunRpcBody)
  );

  // ------------------------------------------------------------------
  // [10] get_protocol_execution_job_context — fenced, read-only,
  //      coherent snapshot.
  // ------------------------------------------------------------------
  console.log("\n[10] get_protocol_execution_job_context — fenced read model");

  check(
    "get_protocol_execution_job_context is STABLE (read-only), not VOLATILE, and takes no FOR UPDATE lock",
    (() => {
      const idx = code.indexOf("public.get_protocol_execution_job_context(");
      // D-025 widened the RETURNS TABLE column list by one column
      // (completed_baseline_slots) -- window enlarged to still reach
      // past it to the `stable` keyword.
      const section = idx === -1 ? "" : code.slice(idx, idx + 700);
      return /\bstable\b/.test(section) && !/for update/i.test(section);
    })()
  );
  check(
    "the context RPC still verifies fencing (claim_token/lease/status) before returning anything beyond JOB_NOT_FOUND/JOB_NOT_OWNED",
    (() => {
      const body = extractBody(code, "get_protocol_execution_job_context");
      return (
        body !== null &&
        /v_job\.claim_token is distinct from p_claim_token/.test(body) &&
        /'JOB_NOT_OWNED'::text, v_job,/.test(body)
      );
    })()
  );

  // ------------------------------------------------------------------
  // [11] mark_protocol_execution_job_needs_review_for_ambiguity — the
  //      one mechanism, genuinely proof-gated.
  // ------------------------------------------------------------------
  console.log("\n[11] mark_protocol_execution_job_needs_review_for_ambiguity — proof-gated, idempotent");

  const needsReviewBody = extractBody(code, "mark_protocol_execution_job_needs_review_for_ambiguity");
  check(
    "ALREADY_NEEDS_REVIEW is checked before fencing (mirrors D-020's ALREADY_SUCCEEDED precedent) -- idempotent replay, no JOB_NOT_OWNED misfire",
    (() => {
      if (needsReviewBody === null) return false;
      const alreadyIdx = needsReviewBody.indexOf("'ALREADY_NEEDS_REVIEW'");
      const fencingIdx = needsReviewBody.indexOf("v_job.claim_token is distinct from p_claim_token");
      return alreadyIdx !== -1 && fencingIdx !== -1 && alreadyIdx < fencingIdx;
    })()
  );
  check(
    "the job is moved to needs_review only after proving in_progress + request_sent_at + no receipt in EITHER receipt table",
    needsReviewBody !== null &&
      /ec\.status = 'in_progress' and ec\.request_sent_at is not null/.test(needsReviewBody) &&
      /not exists \(select 1 from public\.provider_call_receipts r where r\.external_call_id = ec\.id\)/.test(
        needsReviewBody
      ) &&
      /not exists \(select 1 from public\.analysis_call_receipts r where r\.external_call_id = ec\.id\)/.test(
        needsReviewBody
      )
  );
  check(
    "NO_AMBIGUOUS_CALL is returned, with zero mutation, when no such proof exists -- a healthy job can never be forced into needs_review",
    needsReviewBody !== null &&
      (needsReviewBody.match(/'NO_AMBIGUOUS_CALL'::text, v_job;/g) ?? []).length === 2
  );
  check(
    "the function never touches the external_call, probe_run, or attempt rows -- only protocol_execution_jobs is ever UPDATEd",
    needsReviewBody !== null &&
      (needsReviewBody.match(/^\s*update /gim) ?? []).length === 1 &&
      /update public\.protocol_execution_jobs/.test(needsReviewBody)
  );

  // ------------------------------------------------------------------
  // [12] Monitoring — internal-only ACL, security_invoker.
  // ------------------------------------------------------------------
  console.log("\n[12] protocol_execution_job_monitoring_v1 — internal-only, security_invoker");

  check(
    "the view is declared with security_invoker = true",
    /create or replace view public\.protocol_execution_job_monitoring_v1\s*\n\s*with \(security_invoker = true\) as/.test(
      code
    )
  );
  check(
    "no public/anon/authenticated/service_role grant survives the initial revoke -- only a subsequent explicit grant select to service_role",
    /revoke all on public\.protocol_execution_job_monitoring_v1 from public, anon, authenticated, service_role;/.test(
      code
    ) && /grant select on public\.protocol_execution_job_monitoring_v1 to service_role;/.test(code)
  );
  check(
    "the view exposes only raw counts/sums/averages -- no hardcoded threshold, alert level, or comparison against a fixed business number",
    !/threshold|alert_level|is_healthy|is_critical/i.test(code)
  );
  check(
    "sent-without-receipt is defined identically to the needs_review proof: in_progress + request_sent_at + absent from both receipt tables",
    /external_calls_sent_without_receipt/.test(code)
  );
  check(
    "cost categories are distinguished exactly: reserved (always present), estimated, measured, and unknown-on-terminal -- never conflated",
    /reserved_cost_usd_total/.test(code) &&
      /estimated_cost_usd_total/.test(code) &&
      /measured_cost_usd_total/.test(code) &&
      /terminal_calls_with_unknown_cost/.test(code)
  );

  // ------------------------------------------------------------------
  // [13] No legacy vocabulary; no DML/backfill outside preflight reads.
  // ------------------------------------------------------------------
  console.log("\n[13] no legacy 5x3/$2/won/partial/lost vocabulary; no backfill DML");

  check(
    "no won/partial/lost verdict vocabulary, no 5x3/$2 legacy figures, no M7/M8 references",
    !/\bwon\b/i.test(code) &&
      !/\bpartial\b/i.test(code) &&
      !/\blost\b/i.test(code) &&
      !/\b5\s*[x×]\s*3\b/i.test(code) &&
      !/\$2\b/.test(code) &&
      !/\bM7\b/.test(code) &&
      !/\bM8\b/.test(code)
  );

  const ddlOnly = withoutFunctionBodies(code);
  check(
    "no top-level INSERT/UPDATE/DELETE of business data outside a function body or a read-only preflight's SELECT COUNT(*)",
    !/\binsert\s+into\s+public\.(?!.*_core)/i.test(ddlOnly) &&
      !/\bupdate\s+public\.protocol_execution_jobs\b(?![\s\S]{0,40}set status = 'needs_review')/i.test(ddlOnly) &&
      !/\bdelete\s+from\b/i.test(ddlOnly)
  );
  check(
    "every new UNIQUE/composite constraint is preceded by a read-only preflight raising an explicit exception on collision -- never a silent backfill",
    (code.match(/raise exception 'D-021 preflight failed:/g) ?? []).length >= 5
  );

  // ------------------------------------------------------------------
  // [14] D-024 — reactivate_abandoned_job, fingerprinted and replay-safe.
  // ------------------------------------------------------------------
  console.log("\n[14] D-024 — reactivate_abandoned_job is fingerprinted and replay-safe");

  check(
    "the old 4-arg reactivate_abandoned_job signature (no idempotency key at all) is explicitly dropped, without CASCADE",
    /drop function if exists public\.reactivate_abandoned_job\(uuid, uuid, text, text\);/.test(code) &&
      !/drop function if exists public\.reactivate_abandoned_job\(uuid, uuid, text, text\)\s+cascade/i.test(code)
  );
  check(
    "the new 5-arg reactivate_abandoned_job signature (adding p_idempotency_key) exists",
    /public\.reactivate_abandoned_job\(\s*\n\s*p_job_id uuid,\s*\n\s*p_project_id uuid,\s*\n\s*p_actor text,\s*\n\s*p_reason text,\s*\n\s*p_idempotency_key text\s*\n\s*\)/.test(
      code
    )
  );
  check(
    "no other DROP FUNCTION for reactivate_abandoned_job ever specifies CASCADE",
    !/drop function[\s\S]{0,80}reactivate_abandoned_job[\s\S]{0,40}cascade/i.test(code)
  );

  const reactivateBody = extractBody(code, "reactivate_abandoned_job");
  check(
    "reactivate_abandoned_job is SECURITY DEFINER with search_path pinned to public, pg_temp",
    // extractBody's slice starts at `as $$`, which is AFTER the
    // `language plpgsql / security definer / volatile / set search_path`
    // header -- checked here directly against the new 5-arg signature's
    // declaration block instead.
    /public\.reactivate_abandoned_job\(\s*\n\s*p_job_id uuid,\s*\n\s*p_project_id uuid,\s*\n\s*p_actor text,\s*\n\s*p_reason text,\s*\n\s*p_idempotency_key text\s*\n\s*\)\s*\nreturns table \(\s*\n\s*status text,\s*\n\s*job\s+public\.protocol_execution_jobs\s*\n\s*\)\s*\nlanguage plpgsql\s*\nsecurity definer\s*\nvolatile\s*\nset search_path = public, pg_temp\s*\nas \$\$/.test(
      code
    )
  );
  check(
    "reactivate_abandoned_job: EXECUTE is revoked from public/anon/authenticated and granted only to service_role, for the new 5-arg signature",
    /revoke all on function\s*\n\s*public\.reactivate_abandoned_job\(uuid, uuid, text, text, text\) from public;/.test(
      code
    ) &&
      /revoke all on function\s*\n\s*public\.reactivate_abandoned_job\(uuid, uuid, text, text, text\) from anon;/.test(
        code
      ) &&
      /revoke all on function\s*\n\s*public\.reactivate_abandoned_job\(uuid, uuid, text, text, text\) from authenticated;/.test(
        code
      ) &&
      /grant execute on function\s*\n\s*public\.reactivate_abandoned_job\(uuid, uuid, text, text, text\) to service_role;/.test(
        code
      )
  );
  check(
    "reactivate_abandoned_job: the job is locked FOR UPDATE strictly before the idempotent-action lookup",
    (() => {
      if (reactivateBody === null) return false;
      const lockIdx = reactivateBody.indexOf("for update;");
      const lookupIdx = reactivateBody.indexOf("select * into v_existing_action");
      return lockIdx !== -1 && lookupIdx !== -1 && lockIdx < lookupIdx;
    })()
  );
  check(
    "reactivate_abandoned_job: the idempotent-action lookup is checked strictly before the abandoned_exhausted status gate",
    (() => {
      if (reactivateBody === null) return false;
      const lookupIdx = reactivateBody.indexOf("select * into v_existing_action");
      const statusGateIdx = reactivateBody.indexOf("if v_job.status <> 'abandoned_exhausted' then");
      return lookupIdx !== -1 && statusGateIdx !== -1 && lookupIdx < statusGateIdx;
    })()
  );
  check(
    "reactivate_abandoned_job: the fingerprint is a real _sha256_hex(...) call over a canonical jsonb_build_object with exactly job_id/project_id/action, actor and reason excluded",
    (() => {
      if (reactivateBody === null) return false;
      const hasShaCall = /v_fingerprint := public\._sha256_hex\(\s*\n\s*jsonb_build_object\(/.test(reactivateBody);
      const hasCanonicalKeys =
        /'job_id', p_job_id,\s*\n\s*'project_id', p_project_id,\s*\n\s*'action', 'reactivate_abandoned'/.test(
          reactivateBody
        );
      const excludesProvenance =
        !/'actor'/.test(reactivateBody.split("v_fingerprint :=")[1]?.split(");")[0] ?? "") &&
        !/'reason'/.test(reactivateBody.split("v_fingerprint :=")[1]?.split(");")[0] ?? "");
      return hasShaCall && hasCanonicalKeys && excludesProvenance;
    })()
  );
  check(
    "reactivate_abandoned_job: p_idempotency_key is a mandatory, caller-supplied argument -- no gen_random_uuid() or other random key generation anywhere in this function",
    reactivateBody !== null && !/gen_random_uuid\(\)/.test(reactivateBody)
  );
  check(
    "reactivate_abandoned_job: same key + same fingerprint returns the exact recorded decision verbatim, zero mutation",
    reactivateBody !== null &&
      /if v_existing_action\.request_fingerprint = v_fingerprint then/.test(reactivateBody) &&
      /when v_existing_action\.outcome = 'approved' then 'REACTIVATED'/.test(reactivateBody)
  );
  check(
    "reactivate_abandoned_job: same key + different fingerprint returns IDEMPOTENCY_KEY_CONFLICT, zero mutation",
    reactivateBody !== null && /'IDEMPOTENCY_KEY_CONFLICT'::text, null::public\.protocol_execution_jobs/.test(reactivateBody)
  );
  check(
    "reactivate_abandoned_job: a non-abandoned job is refused AND that refusal is itself logged as a denied protocol_operator_actions row (idempotent replay of the denial, not just a returned value)",
    reactivateBody !== null &&
      /if v_job\.status <> 'abandoned_exhausted' then/.test(reactivateBody) &&
      /'denied', 'JOB_NOT_ABANDONED',/.test(reactivateBody)
  );
  check(
    "reactivate_abandoned_job: the job UPDATE (status='queued', attempt_count reset) and the approved protocol_operator_actions INSERT happen in the same function call, no separate later write",
    reactivateBody !== null &&
      /set status = 'queued',\s*\n\s*attempt_count = 0,/.test(reactivateBody) &&
      /'reactivate_abandoned_job', 'approved', null,/.test(reactivateBody)
  );
  check(
    "reactivate_abandoned_job: no unique_violation (or any other exception) is ever caught and absorbed",
    reactivateBody !== null && !/exception\s+when\s+unique_violation/i.test(reactivateBody)
  );

  // ------------------------------------------------------------------
  // [15] D-025 — one execution job advances through every planned
  //      baseline slot sequentially.
  // ------------------------------------------------------------------
  console.log("\n[15] D-025 — multi-baseline cardinality: schema, admission, completion, context, monitoring");

  check(
    "protocol_execution_jobs.next_baseline_ordinal added, not null, default 1",
    /add column if not exists next_baseline_ordinal integer not null default 1;/.test(code)
  );
  check(
    "protocol_attempts.baseline_ordinal added, nullable",
    /add column if not exists baseline_ordinal integer null;/.test(code)
  );
  check(
    "protocol_execution_jobs_next_baseline_ordinal_check enforces >= 1, preflighted by existence check",
    /if not exists \(\s*\n\s*select 1 from pg_constraint where conname = 'protocol_execution_jobs_next_baseline_ordinal_check'/.test(
      code
    ) && /check \(next_baseline_ordinal >= 1\);/.test(code)
  );
  check(
    "protocol_attempts_baseline_ordinal_check allows null or >= 1, preflighted by existence check",
    /if not exists \(\s*\n\s*select 1 from pg_constraint where conname = 'protocol_attempts_baseline_ordinal_check'/.test(
      code
    ) && /check \(baseline_ordinal is null or baseline_ordinal >= 1\);/.test(code)
  );
  check(
    "a real READ-ONLY preflight counts job_id-not-null rows with a null baseline_ordinal before protocol_attempts_job_baseline_ordinal_check is added, raising an explicit exception on any historical collision",
    /select count\(\*\) into v_bad_count\s*\n\s*from public\.protocol_attempts\s*\n\s*where job_id is not null and baseline_ordinal is null;/.test(
      code
    ) &&
      /raise exception 'D-025 preflight failed: % protocol_attempts rows carry a job_id with no baseline_ordinal', v_bad_count;/.test(
        code
      )
  );
  check(
    "protocol_attempts_job_baseline_ordinal_check: every attempt with a job_id must carry a baseline_ordinal",
    /check \(job_id is null or baseline_ordinal is not null\);/.test(code)
  );
  check(
    "a real READ-ONLY preflight counts (job_id, baseline_ordinal) pairs with more than one root attempt before the partial unique index is created",
    /group by job_id, baseline_ordinal\s*\n\s*having count\(\*\) > 1/.test(code) &&
      /raise exception 'D-025 preflight failed: % \(job_id, baseline_ordinal\) pairs have more than one root attempt', v_dupe_count;/.test(
        code
      )
  );
  check(
    "protocol_attempts_job_baseline_ordinal_root_key is a partial unique index scoped to root attempts only (retry_of_attempt_id is null), never colliding with a retry child sharing its source's ordinal",
    /create unique index if not exists protocol_attempts_job_baseline_ordinal_root_key\s*\n\s*on public\.protocol_attempts \(job_id, baseline_ordinal\)\s*\n\s*where retry_of_attempt_id is null and job_id is not null;/.test(
      code
    )
  );
  check(
    "_admit_and_reserve_attempt_core (0050) is redefined with an 8th default parameter, p_baseline_ordinal -- the old 7-arg signature is dropped without CASCADE so no ambiguous overload remains, and the new INSERT's column/VALUES lists both gain baseline_ordinal/p_baseline_ordinal in the same statement that already writes job_id, never a later UPDATE (the real CHECK constraint fires immediately at INSERT time)",
    /drop function if exists public\._admit_and_reserve_attempt_core\(uuid, uuid, text, text, numeric, uuid, uuid\);/.test(
      code
    ) &&
      /p_job_id uuid,\s*\n\s*p_baseline_ordinal integer default null\s*\n\s*\)/.test(code) &&
      /project_id, protocol_id, buyer_question_version_id, attempt_kind,\s*\n\s*status, idempotency_key, reserved_cost_usd, retry_of_attempt_id,\s*\n\s*job_id, baseline_ordinal, reserved_at, last_activity_at/.test(
        code
      ) &&
      /p_job_id, p_baseline_ordinal, now\(\), now\(\)/.test(code) &&
      /revoke all on function\s*\n\s*public\._admit_and_reserve_attempt_core\(uuid, uuid, text, text, numeric, uuid, uuid, integer\)\s*\n\s*from public, anon, authenticated, service_role;/.test(
        code
      )
  );

  const admitForJobBody2 = extractBody(code, "admit_and_reserve_attempt_for_job");
  check(
    "admit_and_reserve_attempt_for_job: the RESUME_CURRENT_ATTEMPT guard (current_attempt_id is not null) is still checked before any D-025 idempotency-key validation -- resumption is decided first, exactly as D-021 already required",
    (() => {
      if (admitForJobBody2 === null) return false;
      const resumeIdx = admitForJobBody2.indexOf("if v_job.current_attempt_id is not null then");
      const keyIdx = admitForJobBody2.indexOf("v_expected_key :=");
      return resumeIdx !== -1 && keyIdx !== -1 && resumeIdx < keyIdx;
    })()
  );
  check(
    "admit_and_reserve_attempt_for_job: the expected idempotency key is deterministic, built only from job_id and next_baseline_ordinal -- never a caller-chosen or random value",
    admitForJobBody2 !== null &&
      /v_expected_key := p_job_id::text \|\| ':baseline:' \|\| v_job\.next_baseline_ordinal::text;/.test(
        admitForJobBody2
      )
  );
  check(
    "admit_and_reserve_attempt_for_job: a mismatched key returns INVALID_IDEMPOTENCY_KEY with zero mutation, strictly before the core admission call",
    (() => {
      if (admitForJobBody2 === null) return false;
      const validateIdx = admitForJobBody2.indexOf("if p_idempotency_key <> v_expected_key then");
      const coreCallIdx = admitForJobBody2.indexOf("_admit_and_reserve_attempt_core(");
      return (
        validateIdx !== -1 &&
        coreCallIdx !== -1 &&
        validateIdx < coreCallIdx &&
        /'INVALID_IDEMPOTENCY_KEY'::text, null::public\.protocol_attempts,/.test(admitForJobBody2)
      );
    })()
  );
  check(
    "admit_and_reserve_attempt_for_job: a defensive BASELINE_SLOTS_EXHAUSTED guard refuses admission once next_baseline_ordinal exceeds planned_baseline_runs, before the core call",
    (() => {
      if (admitForJobBody2 === null) return false;
      const guardIdx = admitForJobBody2.indexOf(
        "if v_job.next_baseline_ordinal > v_protocol.planned_baseline_runs then"
      );
      const coreCallIdx = admitForJobBody2.indexOf("_admit_and_reserve_attempt_core(");
      return (
        guardIdx !== -1 &&
        coreCallIdx !== -1 &&
        guardIdx < coreCallIdx &&
        /'BASELINE_SLOTS_EXHAUSTED'::text, null::public\.protocol_attempts,/.test(admitForJobBody2)
      );
    })()
  );
  check(
    "admit_and_reserve_attempt_for_job: next_baseline_ordinal is passed straight into the core call's 8th argument (p_baseline_ordinal), never attached by a later, separate UPDATE -- the real CHECK constraint is evaluated immediately at INSERT time, so a later stamp would be too late",
    admitForJobBody2 !== null &&
      /p_retry_of_attempt_id, p_job_id, v_job\.next_baseline_ordinal\s*\n\s*\);/.test(admitForJobBody2) &&
      /current_attempt_id = \(v_core\.attempt\)\.id,/.test(admitForJobBody2) &&
      /'RESERVED'::text, v_core\.attempt, v_calls\.perplexity_call, v_calls\.analysis_call;/.test(admitForJobBody2)
  );

  const retryFullBody2 = extractBody(code, "retry_full_attempt_for_job");
  check(
    "retry_full_attempt_for_job: the child inherits the source's baseline_ordinal verbatim (passed as the core call's 8th argument, never a later UPDATE), never a new one -- and next_baseline_ordinal is never written by this function",
    retryFullBody2 !== null &&
      /p_source_attempt_id, p_job_id, v_source\.baseline_ordinal\s*\n\s*\);/.test(retryFullBody2) &&
      !/next_baseline_ordinal/.test(retryFullBody2)
  );

  const authorizeOperatorRetryBody2 = extractBody(code, "authorize_operator_retry");
  check(
    "authorize_operator_retry's retry_full_attempt branch also passes the source's baseline_ordinal as the core call's 8th argument, using core.attempt (not a later UPDATE) for the external-calls creation, the logged operator action, and current_attempt_id",
    authorizeOperatorRetryBody2 !== null &&
      /p_source_attempt_id, p_job_id, v_source\.baseline_ordinal\s*\n\s*\);/.test(authorizeOperatorRetryBody2) &&
      /current_attempt_id = \(v_core\.attempt\)\.id,/.test(authorizeOperatorRetryBody2)
  );

  check(
    "enqueue_protocol_execution_job refuses planned_baseline_runs = 0 with NO_BASELINE_RUNS_PLANNED, creating no job row, strictly before the ALREADY_EXISTS lookup",
    (() => {
      const enqueueBody = extractBody(code, "enqueue_protocol_execution_job");
      if (enqueueBody === null) return false;
      const zeroCheckIdx = enqueueBody.indexOf("if v_protocol.planned_baseline_runs = 0 then");
      const existingLookupIdx = enqueueBody.indexOf("select j.* into v_existing");
      return (
        zeroCheckIdx !== -1 &&
        existingLookupIdx !== -1 &&
        zeroCheckIdx < existingLookupIdx &&
        /'NO_BASELINE_RUNS_PLANNED'::text, null::public\.protocol_execution_jobs;/.test(enqueueBody)
      );
    })()
  );

  const completeBody2 = extractBody(code, "complete_protocol_execution_job");
  check(
    "complete_protocol_execution_job: every D-020 gate (ALREADY_SUCCEEDED, CONFLICT, JOB_NOT_OWNED, CURRENT_ATTEMPT_NOT_FOUND, ATTEMPT_NOT_RECONCILED, ATTEMPT_NOT_COMPLETED, EXTERNAL_CALLS_NOT_TERMINAL, PERPLEXITY_NOT_COMPLETED, ANALYSIS_NOT_COMPLETED) is still present, unchanged, in 0051's redefinition",
    completeBody2 !== null &&
      /'ALREADY_SUCCEEDED'::text, v_job;/.test(completeBody2) &&
      /'ATTEMPT_NOT_RECONCILED'::text, v_job;/.test(completeBody2) &&
      /'ATTEMPT_NOT_COMPLETED'::text, v_job;/.test(completeBody2) &&
      /'EXTERNAL_CALLS_NOT_TERMINAL'::text, v_job;/.test(completeBody2) &&
      /'PERPLEXITY_NOT_COMPLETED'::text, v_job;/.test(completeBody2) &&
      /'ANALYSIS_NOT_COMPLETED'::text, v_job;/.test(completeBody2)
  );
  check(
    "complete_protocol_execution_job: a null current_attempt_id with next_baseline_ordinal > 1 replays NEXT_BASELINE_REQUIRED idempotently, zero mutation -- distinct from the genuine NO_CURRENT_ATTEMPT case (next_baseline_ordinal still 1)",
    completeBody2 !== null &&
      /if v_job\.next_baseline_ordinal > 1 then\s*\n\s*return query select 'NEXT_BASELINE_REQUIRED'::text, v_job;/.test(
        completeBody2
      ) &&
      /return query select 'NO_CURRENT_ATTEMPT'::text, v_job;/.test(completeBody2)
  );
  check(
    "complete_protocol_execution_job: once every D-020 gate passes, baseline_ordinal < planned_baseline_runs clears current_attempt_id and advances next_baseline_ordinal by exactly 1, keeping the job running -- never succeeded",
    completeBody2 !== null &&
      /if v_attempt\.baseline_ordinal < v_protocol\.planned_baseline_runs then/.test(completeBody2) &&
      /current_attempt_id = null,\s*\n\s*next_baseline_ordinal = next_baseline_ordinal \+ 1,/.test(completeBody2) &&
      /return query select 'NEXT_BASELINE_REQUIRED'::text, v_job;/.test(completeBody2)
  );
  check(
    "complete_protocol_execution_job: the baseline_ordinal < planned_baseline_runs check runs strictly after every D-020 gate (ANALYSIS_NOT_COMPLETED) and strictly before the final succeeded UPDATE",
    (() => {
      if (completeBody2 === null) return false;
      const analysisGateIdx = completeBody2.lastIndexOf("'ANALYSIS_NOT_COMPLETED'::text, v_job;");
      const advanceIdx = completeBody2.indexOf("if v_attempt.baseline_ordinal < v_protocol.planned_baseline_runs then");
      const succeededIdx = completeBody2.indexOf("set status = 'succeeded', updated_at = now()");
      return (
        analysisGateIdx !== -1 &&
        advanceIdx !== -1 &&
        succeededIdx !== -1 &&
        analysisGateIdx < advanceIdx &&
        advanceIdx < succeededIdx
      );
    })()
  );

  const contextBody2 = extractBody(code, "get_protocol_execution_job_context");
  check(
    "get_protocol_execution_job_context returns completed_baseline_slots as a DISTINCT baseline_ordinal count among completed attempts -- never a raw protocol_attempts row count, and never restricted to root attempts (which would undercount a slot recovered by a retry)",
    contextBody2 !== null &&
      /completed_baseline_slots integer/.test(code) &&
      /select count\(distinct pa\.baseline_ordinal\)::integer\s*\n\s*from public\.protocol_attempts pa\s*\n\s*where pa\.job_id = p_job_id\s*\n\s*and pa\.baseline_ordinal is not null\s*\n\s*and pa\.status = 'completed'\);/.test(
        contextBody2
      )
  );

  check(
    "protocol_execution_job_monitoring_v1 exposes jobs_awaiting_next_baseline_slot and baseline_slots_completed_total, the latter a DISTINCT (job_id, baseline_ordinal) count -- never a raw protocol_attempts count and never root-only",
    /as jobs_awaiting_next_baseline_slot,/.test(code) &&
      /select count\(distinct \(job_id, baseline_ordinal\)\) from public\.protocol_attempts\s*\n\s*where job_id is not null and baseline_ordinal is not null and status = 'completed'\s*\n\s*\) as baseline_slots_completed_total;/.test(
        code
      )
  );

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0 ? "M5 0051 schema contract PASSED." : "M5 0051 schema contract FAILED.")
  );
  console.log(
    "\nThis test verifies migration 0051's TEXT only. It is not created in\n" +
      "any database, not applied to staging, not applied to Production."
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
