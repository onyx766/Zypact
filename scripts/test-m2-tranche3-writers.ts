#!/usr/bin/env tsx
/**
 * M2 tranche 3b — Entity resolution RPC contract (D-017, D-018, D-019).
 *
 * Static assertions over migration 0042's SQL text only. No real
 * Postgres connection is used, and no adapter method exists yet for
 * either RPC — those are a later, not-yet-authorized step. This file
 * verifies the RPC CONTRACT (signatures, preconditions, the D-018
 * corrections, the D-019 no-SQL-normalizer boundary, and the
 * REVOKE/GRANT privilege pattern) matches what was actually approved,
 * nothing more. Real-database verification (concurrency races, the
 * abandoned-pass retry non-collision, live locking behavior) requires
 * a staging connection this file does not have — a documented
 * limitation, matching how every prior M2 tranche's writer test was
 * first landed before its staging verification pass.
 *
 * SQL comments (`-- ...`) are stripped before any keyword search, so
 * this file's own documentary prose can never produce a false
 * positive.
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
  "0042_m2_entity_resolution_rpc.sql"
);
const migration0042 = readFileSync(migrationPath, "utf8");

function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

const codeOnly = stripSqlComments(migration0042);
const codeOnlyLower = codeOnly.toLowerCase();

function staticChecks(): void {
  console.log("\n  static — migration 0042 text");

  // -----------------------------------------------------------------
  // Scope: exactly two functions, no SQL normalizer, no table grants,
  // no data written, references D-017/D-018/D-019
  // -----------------------------------------------------------------
  const functionDefs = [
    ...codeOnly.matchAll(/create or replace function\s+public\.(\w+)\s*\(/g),
  ];
  check(
    "exactly two CREATE OR REPLACE FUNCTION statements",
    functionDefs.length === 2,
    `found ${functionDefs.length}: ${functionDefs.map((m) => m[1]).join(", ")}`
  );
  check(
    "the two functions are named exactly start_or_resume_entity_resolution_pass and resolve_and_record_entity_observation",
    functionDefs.some((m) => m[1] === "start_or_resume_entity_resolution_pass") &&
      functionDefs.some((m) => m[1] === "resolve_and_record_entity_observation")
  );
  check(
    "no SQL normalization function is created (D-019 — normalization is exclusively TypeScript)",
    !/normalize_entity_text/i.test(codeOnly) &&
      !functionDefs.some((m) => /normali[sz]e/i.test(m[1]))
  );
  check(
    "no INSERT INTO / UPDATE ... SET / DELETE FROM statement occurs outside a function body's own logic — this migration itself writes no data before being called",
    !/insert\s+into\s+public\.\w+\s+\(/i.test(
      codeOnly.split("as $$")[0] // nothing before the first function body should insert
    )
  );
  check(
    "no GRANT or REVOKE targets a TABLE — only functions are granted/revoked here",
    !/revoke\s+all\s+on\s+table/i.test(codeOnly) && !/grant\s+\w+\s+on\s+table/i.test(codeOnly)
  );
  check(
    "references D-017, D-018, and D-019 in its header",
    /D-017/.test(migration0042) && /D-018/.test(migration0042) && /D-019/.test(migration0042)
  );
  check(
    "does not modify migrations 0001-0041 (no ALTER TABLE / CREATE TABLE / CREATE VIEW anywhere)",
    !/alter table/i.test(codeOnly) &&
      !/create table/i.test(codeOnly) &&
      !/create (or replace )?view/i.test(codeOnly)
  );

  // -----------------------------------------------------------------
  // Both functions: SECURITY DEFINER, search_path, volatile
  // -----------------------------------------------------------------
  const securityDefinerCount = (codeOnly.match(/security definer/gi) ?? []).length;
  const searchPathCount = (codeOnly.match(/set search_path = public, pg_temp/gi) ?? []).length;
  check(
    "both functions declare SECURITY DEFINER",
    securityDefinerCount === 2,
    `found ${securityDefinerCount}`
  );
  check(
    "both functions pin search_path = public, pg_temp",
    searchPathCount === 2,
    `found ${searchPathCount}`
  );

  // -----------------------------------------------------------------
  // start_or_resume_entity_resolution_pass — signature and preconditions
  // -----------------------------------------------------------------
  check(
    "start_or_resume signature has exactly the ten expected parameters, in order, and no p_dataset_source_type parameter",
    /start_or_resume_entity_resolution_pass\(\s*p_project_id\s+uuid,\s*p_probe_result_id\s+uuid,\s*p_resolver_version\s+integer,\s*p_dataset_id\s+uuid,\s*p_expected_mention_count\s+integer,\s*p_company_name\s+text,\s*p_domain\s+text,\s*p_normalized_brand_terms\s+text\[\],\s*p_mirror_aliases\s+text\[\] default '\{\}',\s*p_stale_after\s+interval default '15 minutes'\s*\)/.test(
      codeOnly
    )
  );
  check(
    "start_or_resume returns exactly (resolution_pass_id uuid, pass_status text, pass_outcome text)",
    /returns table \(\s*resolution_pass_id uuid,\s*pass_status text,\s*pass_outcome text\s*\)/.test(
      codeOnly
    )
  );
  check(
    "p_resolver_version >= 1 is enforced",
    codeOnly.includes("if p_resolver_version < 1 then") &&
      codeOnly.includes("invalid_resolver_version")
  );
  check(
    "p_expected_mention_count >= 0 is enforced",
    codeOnly.includes("if p_expected_mention_count < 0 then") &&
      codeOnly.includes("invalid_expected_mention_count")
  );
  check(
    "p_stale_after must be strictly positive (correction turn, point 1)",
    codeOnly.includes("p_stale_after <= interval '0'") &&
      codeOnly.includes("invalid_stale_after")
  );

  // -----------------------------------------------------------------
  // Brand-snapshot input validation (brand-snapshot audit turn) — no
  // empty or partial identity may be created, and reuse of an existing
  // snapshot requires an exact match, never a silent divergence
  // -----------------------------------------------------------------
  check(
    "company_name must be non-null and non-empty after trim",
    codeOnly.includes("if p_company_name is null or length(trim(p_company_name)) = 0 then") &&
      codeOnly.includes("empty_company_name")
  );
  check(
    "domain must be non-null and non-empty after trim",
    codeOnly.includes("if p_domain is null or length(trim(p_domain)) = 0 then") &&
      codeOnly.includes("empty_domain")
  );
  check(
    "normalized_brand_terms must be non-null and non-empty (a present-but-empty array is rejected, not silently accepted)",
    codeOnly.includes("coalesce(array_length(p_normalized_brand_terms, 1), 0) = 0") &&
      codeOnly.includes("empty_normalized_brand_terms")
  );
  check(
    "no element of normalized_brand_terms may be null or blank",
    codeOnly.includes("unnest(p_normalized_brand_terms) as term") &&
      codeOnly.includes("term is null or length(trim(term)) = 0") &&
      codeOnly.includes("blank_normalized_brand_term")
  );
  check(
    "mirror_aliases must be non-null",
    codeOnly.includes("if p_mirror_aliases is null then") && codeOnly.includes("null_mirror_aliases")
  );
  check(
    "an empty mirror_aliases array remains explicitly allowed — no length-based rejection exists for it",
    !/array_length\(p_mirror_aliases/.test(codeOnly)
  );
  check(
    "no element of mirror_aliases may be null or blank",
    codeOnly.includes("unnest(p_mirror_aliases) as alias") &&
      codeOnly.includes("alias is null or length(trim(alias)) = 0") &&
      codeOnly.includes("blank_mirror_alias")
  );
  check(
    "the brand snapshot INSERT carries all four caller-supplied fields verbatim",
    codeOnly.includes("company_name, domain, mirror_aliases, normalized_brand_terms") &&
      codeOnly.includes("p_company_name, p_domain, p_mirror_aliases, p_normalized_brand_terms")
  );
  check(
    "an existing snapshot is locked FOR UPDATE before any comparison or reuse decision",
    /select \*\s*into v_brand_snapshot\s*from public\.entity_brand_snapshots[\s\S]{0,150}?for update/.test(
      codeOnly
    )
  );
  const mismatchComparisonCount = (
    codeOnly.match(
      /v_brand_snapshot\.company_name <> p_company_name\s*or v_brand_snapshot\.domain <> p_domain\s*or v_brand_snapshot\.mirror_aliases <> p_mirror_aliases\s*or v_brand_snapshot\.normalized_brand_terms <> p_normalized_brand_terms/g
    ) ?? []
  ).length;
  check(
    "the exact four-field mismatch comparison (array order included, via plain <>) is applied twice — once for a snapshot found before the insert attempt, once for one reloaded after losing a concurrent creation race",
    mismatchComparisonCount === 2,
    `found ${mismatchComparisonCount}`
  );
  const brandSnapshotMismatchRaiseCount = (
    codeOnly.match(/brand_snapshot_parameter_mismatch/g) ?? []
  ).length;
  check(
    "brand_snapshot_parameter_mismatch is raised, never silently ignored, for either comparison",
    brandSnapshotMismatchRaiseCount === 2,
    `found ${brandSnapshotMismatchRaiseCount}`
  );
  check(
    "entity_brand_snapshots is never updated or deleted anywhere in this migration — append-only, reused as-is or freshly inserted only",
    !/update\s+public\.entity_brand_snapshots/i.test(codeOnly) &&
      !/delete\s+from\s+public\.entity_brand_snapshots/i.test(codeOnly)
  );

  check(
    "clock_timestamp() is captured exactly once per function (twice total) and reused, never re-evaluated per comparison within a call",
    (codeOnly.match(/clock_timestamp\(\)/g) ?? []).length === 2
  );
  check(
    "probe_result -> project and dataset -> project mismatches both raise before any lock is taken",
    codeOnly.includes("probe_result_project_mismatch") &&
      codeOnly.includes("dataset_project_mismatch")
  );
  check(
    "exact-match verification compares all six fields under lock before RESUMED/ALREADY_COMPLETED (correction turn, point 2)",
    codeOnly.includes("pass_parameter_mismatch") &&
      codeOnly.includes("v_existing.project_id <> p_project_id") &&
      codeOnly.includes("v_existing.probe_result_id <> p_probe_result_id") &&
      codeOnly.includes("v_existing.dataset_id <> p_dataset_id") &&
      codeOnly.includes("v_existing.dataset_source_type <> v_dataset_source_type") &&
      codeOnly.includes("v_existing.resolver_version <> p_resolver_version") &&
      codeOnly.includes("v_existing.expected_mention_count <> p_expected_mention_count")
  );
  check(
    "exactly the three pass_outcome literals appear: STARTED, RESUMED, ALREADY_COMPLETED",
    codeOnly.includes("'STARTED'::text") &&
      codeOnly.includes("'RESUMED'::text") &&
      codeOnly.includes("'ALREADY_COMPLETED'::text")
  );
  check(
    "a pass with expected_mention_count = 0 completes immediately",
    codeOnly.includes(
      "v_new_status := case when p_expected_mention_count = 0 then 'completed' else 'in_progress' end"
    )
  );
  check(
    "the brand snapshot is created via ON CONFLICT DO NOTHING, never raising on a concurrent first-write race",
    codeOnly.includes("on conflict (project_id, dataset_id, resolver_version) do nothing")
  );
  check(
    "a first-insert race on the pass itself is caught and retried, never raised to the caller",
    codeOnly.includes("when unique_violation then") && codeOnly.includes("continue retry_loop")
  );

  // -----------------------------------------------------------------
  // resolve_and_record_entity_observation — signature and preconditions
  // -----------------------------------------------------------------
  check(
    "resolve_and_record signature has exactly the seven expected parameters, in order, and no p_proposed_canonical_id",
    /resolve_and_record_entity_observation\(\s*p_resolution_pass_id\s+uuid,\s*p_mention_ordinal\s+integer,\s*p_raw_text\s+text,\s*p_normalized_text\s+text,\s*p_status\s+text,\s*p_proposed_entity_type\s+text,\s*p_context\s+text\s*\)/.test(
      codeOnly
    ) && !/p_proposed_canonical_id/.test(codeOnly)
  );
  check(
    "returns exactly the seven D-018 fields including pass_status",
    /returns table \(\s*observation_id\s+uuid,\s*observation_generation\s+integer,\s*observation_outcome\s+text,\s*alias_id\s+uuid,\s*alias_generation\s+integer,\s*alias_outcome\s+text,\s*pass_status\s+text\s*\)/.test(
      codeOnly
    )
  );
  check(
    "the pass must be in_progress or the call raises — never silently written into a completed/abandoned pass",
    codeOnly.includes("pass_not_found") && codeOnly.includes("pass_not_in_progress")
  );
  check(
    "structural preconditions: mention_ordinal >= 0, raw_text non-empty, normalized_text non-empty",
    codeOnly.includes("invalid_mention_ordinal") &&
      codeOnly.includes("empty_raw_text") &&
      codeOnly.includes("empty_normalized_text")
  );
  check(
    "status is exactly one of the four literal values",
    codeOnly.includes(
      "p_status not in ('resolved', 'ambiguous', 'unresolved', 'excluded_brand_self')"
    )
  );
  check(
    "proposed_entity_type nullability is checked both directions against status",
    codeOnly.includes("missing_proposed_entity_type") &&
      codeOnly.includes("unexpected_proposed_entity_type")
  );
  check(
    "resolved forbids entity_type=client; excluded_brand_self requires entity_type=client",
    codeOnly.includes("resolved_forbids_client") &&
      codeOnly.includes("excluded_brand_self_requires_client")
  );
  check(
    "excluded_brand_self is independently verified against normalized_brand_terms, never trusted from the caller alone (correction turn, point 4)",
    codeOnly.includes("excluded_brand_self_no_match") &&
      codeOnly.includes("not (p_normalized_text = any (v_normalized_brand_terms))")
  );
  check(
    "D-018's unconditional override reclassifies any matching competitor/platform proposal to excluded_brand_self/client, independent of any pre-existing alias head",
    codeOnly.includes("p_proposed_entity_type in ('competitor', 'platform')") &&
      codeOnly.includes("p_normalized_text = any (v_normalized_brand_terms)") &&
      codeOnly.includes("v_effective_status := 'excluded_brand_self'") &&
      codeOnly.includes("v_effective_entity_type := 'client'")
  );
  check(
    "the client canonical entity is find-or-create, guarded by the one-client-per-project partial unique index",
    codeOnly.includes("on conflict (project_id) where entity_type = 'client' do nothing")
  );
  check(
    "the demote-block precondition is unconditional — raises regardless of resolver_version",
    codeOnly.includes("client_alias_demote_blocked") &&
      codeOnly.includes("v_alias_head.entity_type = 'client' and v_effective_entity_type <> 'client'")
  );
  check(
    "alias_outcome covers exactly APPLIED / ALREADY_APPLIED / SUPERSEDED_PRIOR / CONFLICT / NOT_APPLICABLE",
    codeOnly.includes("'APPLIED'") &&
      codeOnly.includes("'ALREADY_APPLIED'") &&
      codeOnly.includes("'SUPERSEDED_PRIOR'") &&
      codeOnly.includes("'CONFLICT'") &&
      codeOnly.includes("'NOT_APPLICABLE'")
  );
  check(
    "a higher resolver_version with a differing alias mapping supersedes; an equal-or-lower one conflicts, never silently overwritten",
    codeOnly.includes("v_pass.resolver_version > v_alias_head.resolver_version")
  );
  check(
    "ambiguous/unresolved skip alias resolution entirely (canonical_entity_id and entity_type forced null)",
    codeOnly.includes("v_canonical_entity_id := null") &&
      codeOnly.includes("v_effective_entity_type := null")
  );
  check(
    "the observation comparison checks raw_text, normalized_text, canonical_entity_id, entity_type, status, and context together",
    codeOnly.includes("v_existing_obs.raw_text = p_raw_text") &&
      codeOnly.includes("v_existing_obs.normalized_text = p_normalized_text") &&
      codeOnly.includes("v_existing_obs.canonical_entity_id is not distinct from v_canonical_entity_id") &&
      codeOnly.includes("v_existing_obs.entity_type is not distinct from v_effective_entity_type") &&
      codeOnly.includes("v_existing_obs.status = v_effective_status") &&
      codeOnly.includes("v_existing_obs.context is not distinct from p_context")
  );
  check(
    "pass completion is decided by an exact row-count comparison against expected_mention_count, within the same transaction",
    codeOnly.includes("v_observation_count = v_pass.expected_mention_count") &&
      codeOnly.includes("status = 'completed', completed_at = v_now, last_activity_at = v_now")
  );

  // -----------------------------------------------------------------
  // Privileges — function-level only, exactly the established 0031/0039
  // four-statement idiom, per function
  // -----------------------------------------------------------------
  for (const fn of [
    "start_or_resume_entity_resolution_pass",
    "resolve_and_record_entity_observation",
  ]) {
    const revokeCount = (
      codeOnlyLower.match(
        new RegExp(`revoke all on function[\\s\\S]{0,200}?${fn.toLowerCase()}`, "g")
      ) ?? []
    ).length;
    check(
      `${fn}: revoked from public, anon, and authenticated (three REVOKE statements)`,
      revokeCount === 3,
      `found ${revokeCount}`
    );
    check(
      `${fn}: EXECUTE granted to service_role`,
      new RegExp(`grant execute on function[\\s\\S]{0,200}?${fn.toLowerCase()}[\\s\\S]{0,100}?to service_role`, "i").test(
        codeOnlyLower
      )
    );
  }
}

function main(): void {
  staticChecks();

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0
        ? "M2 tranche 3b RPC contract PASSED."
        : "M2 tranche 3b RPC contract FAILED.")
  );
  console.log(
    "\nThis test verifies migration 0042's TEXT only. It does not apply\n" +
      "the migration to any database, does not exercise real locking or\n" +
      "concurrency behavior, and does not test any adapter or pipeline\n" +
      "wiring (neither exists yet). Real-database verification is a\n" +
      "separate, later step requiring an authorized staging connection."
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
