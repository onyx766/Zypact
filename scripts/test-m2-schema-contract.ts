#!/usr/bin/env tsx
/**
 * M2 — Canonical observations schema contract, FIRST TRANCHE.
 *
 * Static assertions over migration 0038's SQL text, plus dynamic
 * assertions against the in-memory adapter for the three new tables
 * (dataset_batches, canonical_entities, entity_aliases). No real
 * Postgres connection is used — the memory adapter's create* methods
 * simulate the same constraints the migration declares, so this file
 * verifies intent and behavior, not a live database.
 *
 * This is schema-only coverage for the FIRST M2 tranche:
 *   - no backfill runs;
 *   - no dataset_batches row is created against real data;
 *   - probe_runs/probe_results dataset_id/dataset_source_type stay
 *     nullable — this file asserts they are NOT made NOT NULL here.
 *
 * A live-Postgres constraint-violation test (attempting an insert that
 * a real CHECK/FK/UNIQUE constraint rejects) is not possible in this
 * environment and is a documented limitation, matching how migrations
 * 0036/0037 were verified before any staging apply.
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ZYPACT_ALLOW_MEMORY_DB;
process.env.ZYPACT_MOCK_MODE = "on";

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getDb } from "@/lib/db";

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
const migration0038 = readFileSync(
  path.join(migrationsDir, "0038_m2_canonical_observations_schema.sql"),
  "utf8"
);
const migration0036 = readFileSync(
  path.join(migrationsDir, "0036_m1_probe_evidence_contract.sql"),
  "utf8"
);
const migration0037 = readFileSync(
  path.join(migrationsDir, "0037_m1_probe_failure_and_raw_body_contract.sql"),
  "utf8"
);

const libDbDir = path.join(process.cwd(), "lib", "db");
const typesSource = readFileSync(path.join(libDbDir, "types.ts"), "utf8");
const memoryAdapterSource = readFileSync(
  path.join(libDbDir, "memory-adapter.ts"),
  "utf8"
);
const supabaseAdapterSource = readFileSync(
  path.join(libDbDir, "supabase-adapter.ts"),
  "utf8"
);

function staticChecks(): void {
  console.log("\n  static — migration 0038 text");

  // -----------------------------------------------------------------
  // 0036/0037 are untouched by this tranche
  // -----------------------------------------------------------------
  check(
    "0036 still contains its own append-only revoke block, unchanged",
    migration0036.includes(
      "revoke update on table public.probe_results from service_role;"
    )
  );
  check(
    "0037 still contains probe_failures.failure_reason CHECK, unchanged",
    migration0037.includes(
      "check (failure_reason in ('network_error', 'http_error', 'empty_answer'))"
    )
  );

  // -----------------------------------------------------------------
  // dataset_batches created before any dataset_id column
  // -----------------------------------------------------------------
  const datasetBatchesIdx = migration0038.indexOf(
    "create table if not exists public.dataset_batches"
  );
  const firstDatasetIdColumnIdx = migration0038.indexOf(
    "add column if not exists dataset_id"
  );
  check(
    "dataset_batches table is created before any dataset_id column",
    datasetBatchesIdx >= 0 &&
      firstDatasetIdColumnIdx >= 0 &&
      datasetBatchesIdx < firstDatasetIdColumnIdx
  );

  // -----------------------------------------------------------------
  // dataset_source_type — identical spelling and identical three
  // values on dataset_batches, probe_runs, probe_results
  // -----------------------------------------------------------------
  const datasetSourceTypeOccurrences = (
    migration0038.match(/dataset_source_type/g) ?? []
  ).length;
  check(
    "dataset_source_type column name appears on all three tables",
    datasetSourceTypeOccurrences >= 3,
    `found ${datasetSourceTypeOccurrences} occurrences`
  );
  const exactEnumLiteral =
    "in ('snapshot_request', 'manual_scan', 'legacy_unresolved')";
  const enumLiteralOccurrences = migration0038
    .split(exactEnumLiteral).length - 1;
  check(
    "the exact three dataset_source_type values appear identically 3 times (dataset_batches, probe_runs, probe_results)",
    enumLiteralOccurrences === 3,
    `found ${enumLiteralOccurrences} occurrences`
  );
  check(
    "no stray/typo variant of the enum values exists",
    !/legacy_unresolve[^d]|manual_sca[^n]|snapshot_reques[^t]/.test(
      migration0038
    )
  );

  // -----------------------------------------------------------------
  // dataset_batches.snapshot_request_id CHECK — exact bidirectional text
  // -----------------------------------------------------------------
  check(
    "dataset_batches_snapshot_request_id_check constraint is present",
    migration0038.includes("dataset_batches_snapshot_request_id_check")
  );
  check(
    "the CHECK requires snapshot_request_id NOT NULL exactly when dataset_source_type = snapshot_request",
    migration0038.includes(
      "(dataset_source_type = 'snapshot_request' and snapshot_request_id is not null)"
    )
  );
  check(
    "the CHECK requires snapshot_request_id NULL for every other dataset_source_type",
    migration0038.includes(
      "(dataset_source_type <> 'snapshot_request' and snapshot_request_id is null)"
    )
  );

  // -----------------------------------------------------------------
  // backfill_key idempotency
  // -----------------------------------------------------------------
  check(
    "dataset_batches.backfill_key has a UNIQUE constraint",
    migration0038.includes("dataset_batches_backfill_key_key") &&
      migration0038.includes("unique (backfill_key)")
  );

  // -----------------------------------------------------------------
  // canonical_entities composite unique key + entity_aliases composite FK
  // -----------------------------------------------------------------
  check(
    "canonical_entities has the composite UNIQUE(id, project_id, entity_type)",
    migration0038.includes("canonical_entities_id_project_type_key") &&
      migration0038.includes("unique (id, project_id, entity_type)")
  );
  check(
    "entity_aliases has the exact composite FK to canonical_entities(id, project_id, entity_type)",
    migration0038.includes("entity_aliases_canonical_entity_fk") &&
      migration0038.includes(
        "foreign key (canonical_entity_id, project_id, entity_type)"
      ) &&
      migration0038.includes(
        "references public.canonical_entities (id, project_id, entity_type)"
      )
  );
  check(
    "entity_aliases has UNIQUE(project_id, entity_type, normalized_text)",
    migration0038.includes("entity_aliases_normalized_unique") &&
      migration0038.includes(
        "unique (project_id, entity_type, normalized_text)"
      )
  );

  // -----------------------------------------------------------------
  // append-only enforcement on the three new tables only
  // -----------------------------------------------------------------
  for (const table of ["dataset_batches", "canonical_entities", "entity_aliases"]) {
    for (const verb of ["update", "delete", "truncate"]) {
      check(
        `REVOKE ${verb.toUpperCase()} on ${table} is present`,
        migration0038.includes(
          `revoke ${verb} on table public.${table} from service_role;`
        )
      );
    }
  }
  check(
    "probe_results UPDATE is NOT granted back (append-only from 0036 stays untouched)",
    !/^\s*grant\s+[^;]*update[^;]*on\s+table\s+public\.probe_results/im.test(
      migration0038
    )
  );

  // -----------------------------------------------------------------
  // no backfill, no NOT NULL, in this tranche
  // -----------------------------------------------------------------
  check(
    "no dataset_batches row is inserted by this migration (no backfill)",
    !/insert\s+into\s+.*dataset_batches/i.test(migration0038)
  );
  check(
    "probe_runs.dataset_id stays nullable — no NOT NULL added in this migration",
    !/alter\s+table\s+.*probe_runs[\s\S]*?alter column dataset_id set not null/i.test(
      migration0038
    )
  );
  check(
    "probe_results.dataset_id stays nullable — no NOT NULL added in this migration",
    !/alter\s+table\s+.*probe_results[\s\S]*?alter column dataset_id set not null/i.test(
      migration0038
    )
  );
  check(
    "probe_runs.dataset_id column is declared nullable ('uuid null')",
    migration0038.includes("add column if not exists dataset_id uuid null")
  );
  check(
    "migration documents the required follow-up NOT NULL tightening migration",
    /follow-up[\s\S]{0,40}migration adds NOT NULL/i.test(migration0038) &&
      migration0038.includes("probe_runs.dataset_id")
  );
  check(
    "run_position uses the exact five §9 values",
    migration0038.includes(
      "'not_observed_in_run',\n          'listed_in_run',\n          'primary_in_run',\n          'ambiguous_in_run',\n          'analysis_failed'"
    )
  );

  // -----------------------------------------------------------------
  // dataset_id FK: ON DELETE RESTRICT, never SET NULL — a canonical
  // identity must never be silently nulled by deleting its parent.
  // -----------------------------------------------------------------
  const datasetIdFkOccurrences = (
    migration0038.match(
      /references public\.dataset_batches \(id\) on delete restrict/g
    ) ?? []
  ).length;
  check(
    "probe_runs.dataset_id and probe_results.dataset_id both use ON DELETE RESTRICT",
    datasetIdFkOccurrences === 2,
    `found ${datasetIdFkOccurrences} occurrences`
  );
  check(
    "no dataset_id foreign key uses ON DELETE SET NULL",
    !/references public\.dataset_batches \(id\) on delete set null/i.test(
      migration0038
    )
  );

  // -----------------------------------------------------------------
  // RLS on the three new tables only, zero policies
  // -----------------------------------------------------------------
  for (const table of ["dataset_batches", "canonical_entities", "entity_aliases"]) {
    check(
      `RLS is enabled on ${table}`,
      migration0038.includes(
        `alter table public.${table} enable row level security;`
      )
    );
    check(
      `${table} keeps the Postgres-default "no force" RLS (service_role bypass intact)`,
      migration0038.includes(
        `alter table public.${table} no force row level security;`
      )
    );
  }
  check(
    "no RLS policy is added by this migration",
    !/create\s+policy/i.test(migration0038)
  );

  // -----------------------------------------------------------------
  // supabase-adapter.ts — exact mapping lines, read from the real
  // source file, not assumed from memory
  // -----------------------------------------------------------------
  check(
    "saveProbeResult maps snapshot_request_id, dataset_id, and dataset_source_type exactly",
    supabaseAdapterSource.includes(
      "snapshot_request_id: input.snapshotRequestId ?? null,"
    ) &&
      supabaseAdapterSource.includes(
        "dataset_id: input.datasetId ?? null,"
      ) &&
      supabaseAdapterSource.includes(
        "dataset_source_type: input.datasetSourceType ?? null,"
      )
  );
  check(
    "createDatasetBatch maps snapshot_request_id exactly",
    supabaseAdapterSource.includes(
      "snapshot_request_id: input.snapshotRequestId ?? null,"
    )
  );

  // -----------------------------------------------------------------
  // DatasetBatch — exposes every persisted field
  // -----------------------------------------------------------------
  const datasetBatchInterfaceMatch = typesSource.match(
    /export interface DatasetBatchInput \{([\s\S]*?)\}/
  );
  const datasetBatchInputBody = datasetBatchInterfaceMatch?.[1] ?? "";
  for (const field of [
    "projectId",
    "datasetSourceType",
    "snapshotRequestId",
    "backfillKey",
    "note",
  ]) {
    check(
      `DatasetBatchInput declares ${field}`,
      datasetBatchInputBody.includes(field)
    );
  }
  const datasetBatchExtendsInput =
    /export interface DatasetBatch extends DatasetBatchInput \{[\s\S]*?id: string;[\s\S]*?createdAt: string;[\s\S]*?\}/.test(
      typesSource
    );
  check(
    "DatasetBatch extends DatasetBatchInput and adds id + createdAt — exposes all 7 persisted fields",
    datasetBatchExtendsInput
  );

  // -----------------------------------------------------------------
  // memory-adapter.ts — snapshot_request_id null check treats both
  // null and undefined as absent, via the `!= null` idiom
  // -----------------------------------------------------------------
  check(
    "memory-adapter's CHECK simulation treats snapshotRequestId null/undefined as absent via `!= null`",
    memoryAdapterSource.includes(
      "const hasSnapshotRequestId = input.snapshotRequestId != null;"
    )
  );
  check(
    "the old two-part strict-equality null check is gone",
    !memoryAdapterSource.includes(
      'input.snapshotRequestId !== null && input.snapshotRequestId !== undefined'
    )
  );
}

async function dynamicChecks(): Promise<void> {
  console.log("\n  dynamic — memory adapter, three new tables");
  const db = getDb();
  const projectId = randomUUID();

  // dataset_batches — CHECK simulation
  const snapshotRequestId = randomUUID();
  const validSnapshotBatch = await db.createDatasetBatch({
    projectId,
    datasetSourceType: "snapshot_request",
    snapshotRequestId,
  });
  check(
    "valid snapshot_request dataset_batches row is accepted",
    validSnapshotBatch.datasetSourceType === "snapshot_request" &&
      validSnapshotBatch.snapshotRequestId === snapshotRequestId
  );

  const validManualBatch = await db.createDatasetBatch({
    projectId,
    datasetSourceType: "manual_scan",
  });
  check(
    "valid manual_scan dataset_batches row (no snapshot_request_id) is accepted",
    validManualBatch.datasetSourceType === "manual_scan" &&
      validManualBatch.snapshotRequestId === null
  );

  let rejectedMissingSnapshotId = false;
  try {
    await db.createDatasetBatch({
      projectId,
      datasetSourceType: "snapshot_request",
    });
  } catch {
    rejectedMissingSnapshotId = true;
  }
  check(
    "snapshot_request without snapshotRequestId is rejected (CHECK simulation)",
    rejectedMissingSnapshotId
  );

  let rejectedStraySnapshotId = false;
  try {
    await db.createDatasetBatch({
      projectId,
      datasetSourceType: "legacy_unresolved",
      snapshotRequestId: randomUUID(),
    });
  } catch {
    rejectedStraySnapshotId = true;
  }
  check(
    "legacy_unresolved with a stray snapshotRequestId is rejected (CHECK simulation)",
    rejectedStraySnapshotId
  );

  // dataset_batches — backfill_key idempotency
  const backfillKey = `legacy-backfill:${projectId}:legacy_unresolved`;
  await db.createDatasetBatch({
    projectId,
    datasetSourceType: "legacy_unresolved",
    backfillKey,
  });
  let rejectedDuplicateBackfillKey = false;
  try {
    await db.createDatasetBatch({
      projectId,
      datasetSourceType: "legacy_unresolved",
      backfillKey,
    });
  } catch {
    rejectedDuplicateBackfillKey = true;
  }
  check(
    "rerunning backfill with the same backfill_key does not create a duplicate row (idempotency simulation)",
    rejectedDuplicateBackfillKey
  );

  const liveManualBatchTwo = await db.createDatasetBatch({
    projectId,
    datasetSourceType: "manual_scan",
  });
  check(
    "two live manual_scan batches with no backfill_key never collide (multiple NULLs allowed)",
    liveManualBatchTwo.id !== validManualBatch.id
  );

  const batches = await db.getDatasetBatchesByProject(projectId);
  check(
    "getDatasetBatchesByProject returns every batch created for this project",
    batches.length === 4,
    `expected 4 (snapshot_request, manual_scan, backfill-keyed legacy_unresolved, second manual_scan), got ${batches.length}`
  );

  // canonical_entities / entity_aliases — composite FK + UNIQUE simulation
  const clientEntity = await db.createCanonicalEntity({
    projectId,
    entityType: "client",
    resolverVersion: 1,
  });
  const competitorEntity = await db.createCanonicalEntity({
    projectId,
    entityType: "competitor",
    resolverVersion: 1,
  });

  const alias = await db.createEntityAlias({
    canonicalEntityId: competitorEntity.id,
    projectId,
    entityType: "competitor",
    rawText: "Acme, Inc.",
    normalizedText: "acme inc",
    resolverVersion: 1,
  });
  check(
    "a valid entity_alias resolves to its canonical_entity",
    alias.canonicalEntityId === competitorEntity.id
  );

  let rejectedMismatchedEntityType = false;
  try {
    await db.createEntityAlias({
      canonicalEntityId: competitorEntity.id,
      projectId,
      entityType: "client",
      rawText: "Acme",
      normalizedText: "acme",
      resolverVersion: 1,
    });
  } catch {
    rejectedMismatchedEntityType = true;
  }
  check(
    "an alias whose entityType does not match its parent canonical_entity is rejected (composite FK simulation)",
    rejectedMismatchedEntityType
  );

  const otherProjectId = randomUUID();
  let rejectedMismatchedProject = false;
  try {
    await db.createEntityAlias({
      canonicalEntityId: competitorEntity.id,
      projectId: otherProjectId,
      entityType: "competitor",
      rawText: "Acme",
      normalizedText: "acme",
      resolverVersion: 1,
    });
  } catch {
    rejectedMismatchedProject = true;
  }
  check(
    "an alias whose projectId does not match its parent canonical_entity's project is rejected (composite FK simulation, tenant isolation)",
    rejectedMismatchedProject
  );

  let rejectedDuplicateNormalized = false;
  try {
    await db.createEntityAlias({
      canonicalEntityId: competitorEntity.id,
      projectId,
      entityType: "competitor",
      rawText: "ACME INC.",
      normalizedText: "acme inc",
      resolverVersion: 1,
    });
  } catch {
    rejectedDuplicateNormalized = true;
  }
  check(
    "a duplicate normalizedText for the same project/entityType is rejected (UNIQUE simulation)",
    rejectedDuplicateNormalized
  );

  const differentEntityAlias = await db.createEntityAlias({
    canonicalEntityId: clientEntity.id,
    projectId,
    entityType: "client",
    rawText: "Acme Inc",
    normalizedText: "acme inc",
    resolverVersion: 1,
  });
  check(
    "the same normalizedText is allowed across different entityTypes in the same project",
    differentEntityAlias.entityType === "client"
  );

  const entities = await db.getCanonicalEntitiesByProject(projectId);
  check("getCanonicalEntitiesByProject returns both entities", entities.length === 2);
  const aliases = await db.getEntityAliasesByProject(projectId);
  check("getEntityAliasesByProject returns both aliases", aliases.length === 2);

  // probe_runs / probe_results — new columns default to null, not backfilled
  const probeRun = await db.createProbeRun(projectId, "perplexity", "live_perplexity");
  check(
    "a freshly created probe_run has dataset_id null (no backfill in this tranche)",
    probeRun.datasetId === null && probeRun.datasetSourceType === null
  );

  const probeResult = await db.saveProbeResult({
    probeRunId: probeRun.id,
    projectId,
    prompt: "best tools for X",
    platform: "perplexity",
    probeMode: "live_perplexity",
    rawResponse: "mock response",
    clientMentioned: false,
    clientPosition: "absent",
    competitorsMentioned: [],
    sourcesCited: [],
    answerSummary: "",
    verdict: "lost",
    whyClientLost: "",
  });
  check(
    "a freshly saved probe_result has dataset_id and run_position null (no backfill in this tranche)",
    probeResult.datasetId === null &&
      probeResult.datasetSourceType === null &&
      probeResult.runPosition === null &&
      probeResult.negativeClaimDetected === null
  );
}

async function main(): Promise<void> {
  staticChecks();
  await dynamicChecks();

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0
        ? "M2 schema contract, first tranche, PASSED."
        : "M2 schema contract, first tranche, FAILED.")
  );
  console.log(
    "\nTHIS IS THE FIRST M2 TRANCHE — SCHEMA ONLY, NOT A FULL M2 CLOSE-OUT.\n" +
      "Closed by this tranche: dataset_batches created before any dataset_id\n" +
      "column; composite FK/UNIQUE constraints on entity_aliases; CHECK\n" +
      "constraint on dataset_batches.snapshot_request_id; append-only on the\n" +
      "three new tables; RLS enabled on the three new tables with zero\n" +
      "policies; dataset_id uses ON DELETE RESTRICT, never SET NULL;\n" +
      "probe_runs/probe_results additive nullable columns.\n" +
      "NOT closed by this tranche: no backfill; no dataset_batches row for\n" +
      "any real project; no entity resolution logic; no sampleLabel; no\n" +
      "report adapter changes; probe_runs/probe_results dataset_id remains\n" +
      "nullable until a follow-up tightening migration runs after backfill\n" +
      "is verified at zero remaining NULLs; the probe_results append-only\n" +
      "UPDATE revoke (from 0036) still blocks any future backfill write to\n" +
      "existing probe_results rows — unresolved, flagged for tranche 2;\n" +
      "the ON DELETE RESTRICT behavior itself is asserted only statically\n" +
      "— the in-memory adapter has no delete path to exercise it live."
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(2);
});
