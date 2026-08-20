#!/usr/bin/env tsx
/**
 * M2 tranche 3 — Entity resolution and brand-self exclusion schema
 * contract (D-017, D-018).
 *
 * Static assertions over migration 0041's SQL text only. No real
 * Postgres connection is used, no adapter method exists for these
 * tables yet (adapters are a later, not-yet-authorized step), and no
 * RPC body exists yet (a future migration 0042). This file verifies
 * the SCHEMA — tables, constraints, indexes, views, and privileges —
 * matches the design fixed by D-017/D-018, nothing more.
 *
 * SQL comments (`-- ...`) are stripped before searching for forbidden
 * data-writing statements, so this file's own documentary prose can
 * never produce a false positive.
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
  "0041_m2_entity_resolution_schema.sql"
);
const migration0041 = readFileSync(migrationPath, "utf8");

function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

const codeOnly = stripSqlComments(migration0041);
const codeOnlyLower = codeOnly.toLowerCase();

function staticChecks(): void {
  console.log("\n  static — migration 0041 text");

  // -----------------------------------------------------------------
  // Scope: no RPC body, no data written, migrations 0001-0040 untouched
  // -----------------------------------------------------------------
  check(
    "no CREATE FUNCTION of any kind — RPC bodies belong to a future migration 0042",
    !/create\s+(or\s+replace\s+)?function/i.test(codeOnly)
  );
  check(
    "no INSERT INTO statement — this migration writes no data",
    !/insert\s+into/i.test(codeOnlyLower)
  );
  check(
    "no UPDATE ... SET statement — this migration writes no data",
    !/update\s+\w+(\.\w+)?\s+set\b/i.test(codeOnlyLower)
  );
  check(
    "no DELETE FROM statement — this migration writes no data",
    !/delete\s+from/i.test(codeOnlyLower)
  );
  check(
    "references D-017 and D-018 in its header",
    /D-017/.test(migration0041) && /D-018/.test(migration0041)
  );
  check(
    "does not modify migrations 0036-0040 (documented, not altered)",
    !/alter\s+table\s+public\.probe_(runs|results)\s+alter\s+column/i.test(codeOnly)
  );

  // -----------------------------------------------------------------
  // Companion composite UNIQUE constraints on pre-existing tables
  // -----------------------------------------------------------------
  for (const [conname, table, cols] of [
    ["dataset_batches_id_project_key", "dataset_batches", "(id, project_id)"],
    ["dataset_batches_id_source_type_key", "dataset_batches", "(id, dataset_source_type)"],
    ["probe_results_id_project_key", "probe_results", "(id, project_id)"],
    ["probe_results_id_dataset_key", "probe_results", "(id, dataset_id)"],
    ["probe_results_id_run_key", "probe_results", "(id, probe_run_id)"],
    ["probe_results_id_prompt_key", "probe_results", "(id, generated_prompt_id)"],
  ] as const) {
    check(
      `${table} gets companion UNIQUE ${cols} (${conname})`,
      codeOnly.includes(conname) && codeOnly.includes(`unique ${cols}`)
    );
  }

  // -----------------------------------------------------------------
  // canonical_entities — one client per project
  // -----------------------------------------------------------------
  check(
    "canonical_entities_one_client_per_project is a partial unique index on (project_id) where entity_type = 'client'",
    codeOnly.includes("canonical_entities_one_client_per_project") &&
      codeOnly.includes("on public.canonical_entities (project_id)") &&
      codeOnly.includes("where entity_type = 'client'")
  );

  // -----------------------------------------------------------------
  // entity_aliases — generation model, entity_type dropped from the key
  // -----------------------------------------------------------------
  check(
    "entity_aliases gains alias_generation, NOT NULL DEFAULT 1",
    /add column if not exists alias_generation integer not null default 1/.test(
      codeOnlyLower
    )
  );
  check(
    "alias_generation carries a positivity CHECK (>= 1)",
    codeOnly.includes("entity_aliases_generation_check") &&
      codeOnly.includes("check (alias_generation >= 1)")
  );
  check(
    "the old entity_aliases_normalized_unique constraint is dropped",
    /drop constraint entity_aliases_normalized_unique/.test(codeOnlyLower)
  );
  check(
    "the new entity_aliases_generation_key is exactly (project_id, normalized_text, alias_generation) — entity_type is not part of it",
    codeOnly.includes("entity_aliases_generation_key") &&
      codeOnly.includes("unique (project_id, normalized_text, alias_generation)")
  );
  check(
    "service_role's INSERT on entity_aliases is revoked (RPC-only from this tranche on)",
    /revoke insert on table public\.entity_aliases from service_role/.test(
      codeOnlyLower
    )
  );

  // -----------------------------------------------------------------
  // entity_brand_snapshots
  // -----------------------------------------------------------------
  check(
    "entity_brand_snapshots table is created",
    codeOnly.includes("create table if not exists public.entity_brand_snapshots")
  );
  for (const col of [
    "project_id",
    "dataset_id",
    "resolver_version",
    "company_name",
    "domain",
    "mirror_aliases",
    "normalized_brand_terms",
  ]) {
    check(`entity_brand_snapshots has column ${col}`, codeOnly.includes(col));
  }
  check(
    "entity_brand_snapshots_key is UNIQUE(project_id, dataset_id, resolver_version)",
    codeOnly.includes("entity_brand_snapshots_key") &&
      codeOnly.includes("unique (project_id, dataset_id, resolver_version)")
  );
  check(
    "entity_brand_snapshots_dataset_project_fk locks dataset_id to its true project_id",
    codeOnly.includes("entity_brand_snapshots_dataset_project_fk") &&
      codeOnly.includes(
        "foreign key (dataset_id, project_id) references public.dataset_batches (id, project_id)"
      )
  );

  // -----------------------------------------------------------------
  // entity_resolution_passes
  // -----------------------------------------------------------------
  check(
    "entity_resolution_passes table is created",
    codeOnly.includes("create table if not exists public.entity_resolution_passes")
  );
  check(
    "status is exactly in_progress/completed/abandoned",
    codeOnly.includes("check (status in ('in_progress', 'completed', 'abandoned'))")
  );
  check(
    "dataset_source_type is present and NOT NULL",
    /dataset_source_type\s+text not null/.test(codeOnly)
  );
  check(
    "last_activity_at column exists, NOT NULL default now()",
    /last_activity_at\s+timestamptz not null default now\(\)/.test(codeOnly)
  );
  check(
    "entity_resolution_passes_activity_check enforces last_activity_at >= started_at",
    codeOnly.includes("entity_resolution_passes_activity_check") &&
      codeOnly.includes("check (last_activity_at >= started_at)")
  );
  check(
    "entity_resolution_passes_completion_check ties completed_at to status='completed' both ways",
    codeOnly.includes("entity_resolution_passes_completion_check") &&
      codeOnly.includes("status = 'completed' and completed_at is not null") &&
      codeOnly.includes("status <> 'completed' and completed_at is null")
  );
  check(
    "at most one COMPLETED pass per (probe_result_id, resolver_version)",
    codeOnly.includes("entity_resolution_passes_completed_key") &&
      codeOnly.includes("where status = 'completed'")
  );
  check(
    "at most one IN_PROGRESS pass per (probe_result_id, resolver_version)",
    codeOnly.includes("entity_resolution_passes_in_progress_key") &&
      codeOnly.includes("where status = 'in_progress'")
  );
  for (const conname of [
    "entity_resolution_passes_id_result_key",
    "entity_resolution_passes_id_project_key",
    "entity_resolution_passes_id_dataset_key",
    "entity_resolution_passes_id_source_type_key",
    "entity_resolution_passes_id_version_key",
    "entity_resolution_passes_project_fk",
    "entity_resolution_passes_dataset_fk",
    "entity_resolution_passes_dataset_source_type_fk",
    "entity_resolution_passes_snapshot_fk",
  ]) {
    check(`entity_resolution_passes constraint ${conname} is present`, codeOnly.includes(conname));
  }
  check(
    "entity_resolution_passes_snapshot_fk locks the pass to exactly the one brand snapshot for its project+dataset+version",
    codeOnly.includes(
      "foreign key (project_id, dataset_id, resolver_version, brand_snapshot_id)"
    ) &&
      codeOnly.includes(
        "references public.entity_brand_snapshots (project_id, dataset_id, resolver_version, id)"
      )
  );
  check(
    "entity_resolution_passes gets no write grant to service_role — RPC-only (revoke all, then select only)",
    /revoke all on table public\.entity_resolution_passes from public, anon, authenticated, service_role/.test(
      codeOnlyLower
    ) &&
      /grant select on table public\.entity_resolution_passes to service_role/.test(
        codeOnlyLower
      ) &&
      !/grant\s+(insert|update|delete)\s+.*entity_resolution_passes/i.test(codeOnly)
  );

  // -----------------------------------------------------------------
  // entity_observations
  // -----------------------------------------------------------------
  check(
    "entity_observations table is created",
    codeOnly.includes("create table if not exists public.entity_observations")
  );
  check(
    "status is exactly resolved/ambiguous/unresolved/excluded_brand_self",
    codeOnly.includes(
      "check (status in ('resolved', 'ambiguous', 'unresolved', 'excluded_brand_self'))"
    )
  );
  check(
    "entity_type allows exactly client/competitor/platform when not null",
    codeOnly.includes(
      "check (entity_type is null or entity_type in ('client', 'competitor', 'platform'))"
    )
  );
  check(
    "mention_ordinal, observation_generation, resolver_version all carry positivity CHECKs",
    codeOnly.includes("check (mention_ordinal >= 0)") &&
      codeOnly.includes("check (resolver_version >= 1)") &&
      codeOnly.includes("check (observation_generation >= 1)")
  );
  check(
    "excluded_brand_self REQUIRES entity_type='client' (one direction of the brand-self CHECK)",
    codeOnly.includes(
      "status = 'excluded_brand_self' and entity_type = 'client' and canonical_entity_id is not null"
    )
  );
  check(
    "resolved FORBIDS entity_type='client' — only competitor/platform allowed (the other direction)",
    codeOnly.includes(
      "status = 'resolved' and entity_type in ('competitor', 'platform') and canonical_entity_id is not null"
    )
  );
  check(
    "ambiguous/unresolved forces both canonical_entity_id and entity_type to null",
    codeOnly.includes(
      "status in ('ambiguous', 'unresolved') and entity_type is null and canonical_entity_id is null"
    )
  );
  check(
    "the identity/idempotency key is exactly (resolution_pass_id, mention_ordinal, observation_generation)",
    codeOnly.includes("entity_observations_pass_identity_key") &&
      codeOnly.includes(
        "unique (resolution_pass_id, mention_ordinal, observation_generation)"
      )
  );
  for (const conname of [
    "entity_observations_canonical_entity_fk",
    "entity_observations_dataset_source_type_fk",
    "entity_observations_pass_result_fk",
    "entity_observations_pass_project_fk",
    "entity_observations_pass_dataset_fk",
    "entity_observations_pass_source_type_fk",
    "entity_observations_pass_version_fk",
    "entity_observations_result_run_fk",
    "entity_observations_result_project_fk",
    "entity_observations_result_prompt_fk",
  ]) {
    check(`entity_observations constraint ${conname} is present`, codeOnly.includes(conname));
  }
  check(
    "entity_observations_result_prompt_fk correctly allows generated_prompt_id to be null (composite FK against probe_results, no separate NOT NULL added)",
    codeOnly.includes(
      "foreign key (probe_result_id, generated_prompt_id) references public.probe_results (id, generated_prompt_id)"
    ) && !/generated_prompt_id\s+uuid not null/.test(codeOnly)
  );
  check(
    "entity_observations gets no write grant to service_role — append-only, RPC-only (revoke all, then select only)",
    /revoke all on table public\.entity_observations from public, anon, authenticated, service_role/.test(
      codeOnlyLower
    ) &&
      /grant select on table public\.entity_observations to service_role/.test(
        codeOnlyLower
      ) &&
      !/grant\s+(insert|update|delete)\s+.*entity_observations\b/i.test(codeOnly)
  );

  // -----------------------------------------------------------------
  // RLS on all three new tables
  // -----------------------------------------------------------------
  for (const table of [
    "entity_brand_snapshots",
    "entity_resolution_passes",
    "entity_observations",
  ]) {
    check(
      `${table} has RLS enabled with no FORCE`,
      codeOnly.includes(`alter table public.${table} enable row level security`) &&
        codeOnly.includes(`alter table public.${table} no force row level security`)
    );
  }

  // -----------------------------------------------------------------
  // canonical_entities' pre-existing direct-INSERT grant is untouched
  // -----------------------------------------------------------------
  check(
    "canonical_entities' existing INSERT grant from 0038 is not revoked or altered here (D-017 §3, out of scope)",
    !/revoke\s+.*canonical_entities/i.test(codeOnly) &&
      !/grant\s+.*canonical_entities/i.test(codeOnly)
  );

  // -----------------------------------------------------------------
  // Active-head views
  // -----------------------------------------------------------------
  check(
    "entity_aliases_active is DISTINCT ON (project_id, normalized_text) ordered by alias_generation desc",
    codeOnly.includes("create or replace view public.entity_aliases_active as") &&
      codeOnly.includes("distinct on (ea.project_id, ea.normalized_text)") &&
      codeOnly.includes(
        "order by ea.project_id, ea.normalized_text, ea.alias_generation desc"
      )
  );
  check(
    "entity_observations_active is DISTINCT ON (probe_result_id, mention_ordinal) ordered by observation_generation desc",
    codeOnly.includes("create or replace view public.entity_observations_active as") &&
      codeOnly.includes("distinct on (eo.probe_result_id, eo.mention_ordinal)") &&
      codeOnly.includes(
        "order by eo.probe_result_id, eo.mention_ordinal, eo.observation_generation desc"
      )
  );
  check(
    "entity_observations_active only joins passes with status = 'completed'",
    /join public\.entity_resolution_passes erp\s+on erp\.id = eo\.resolution_pass_id\s+and erp\.status = 'completed'/.test(
      codeOnly
    )
  );
  check(
    "entity_observations_active scopes to the highest COMPLETED resolver_version per probe_result (never a partial/abandoned pass)",
    codeOnly.includes(
      "select max(erp2.resolver_version)"
    ) &&
      codeOnly.includes("erp2.probe_result_id = eo.probe_result_id") &&
      codeOnly.includes("erp2.status = 'completed'")
  );
  check(
    "both views: REVOKE ALL from public/anon/authenticated/service_role, then GRANT SELECT to service_role only",
    /revoke all on public\.entity_aliases_active from public, anon, authenticated, service_role/.test(
      codeOnlyLower
    ) &&
      /revoke all on public\.entity_observations_active from public, anon, authenticated, service_role/.test(
        codeOnlyLower
      ) &&
      /grant select on public\.entity_aliases_active to service_role/.test(codeOnlyLower) &&
      /grant select on public\.entity_observations_active to service_role/.test(
        codeOnlyLower
      )
  );
}

function main(): void {
  staticChecks();

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0
        ? "M2 tranche 3 schema contract PASSED."
        : "M2 tranche 3 schema contract FAILED.")
  );
  console.log(
    "\nThis test verifies migration 0041's TEXT only. It does not apply\n" +
      "the migration to any database, and does not test the future RPC\n" +
      "bodies (migration 0042, not yet created) or any adapter/pipeline\n" +
      "wiring (also not yet created)."
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
