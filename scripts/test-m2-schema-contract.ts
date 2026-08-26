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
 *
 * `createEntityAlias` was retired in the M2 third tranche (D-017,
 * D-018, D-019) — entity_aliases is now written exclusively through
 * `resolveAndRecordEntityObservation`. The dynamic checks below were
 * rewritten accordingly: composite-consistency and tenant-isolation,
 * which the old direct-write method tested by attempting a rejected
 * insert, are now verified positively (the RPC-mediated path makes
 * those specific violations structurally unreachable, by
 * construction, rather than merely rejected). The old "same
 * normalizedText allowed across different entityTypes in one project"
 * assertion was actively FALSE once migration 0041 dropped entity_type
 * from entity_aliases' uniqueness key — that assertion is corrected
 * here, not merely reframed, to demonstrate the real invariant:
 * exactly one entityType is ever active for a given normalizedText in
 * a project, enforced via generation-based supersession.
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
import { normalizeEntityTextV1 } from "@/lib/evidence/normalize-entity-text";

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
  check(
    "createEntityAlias no longer exists — no direct .from(\"entity_aliases\").insert( call site remains in the Supabase adapter",
    !supabaseAdapterSource.includes('.from("entity_aliases")\n      .insert(') &&
      !/createEntityAlias/.test(supabaseAdapterSource)
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

  // canonical_entities / entity_aliases — composite consistency,
  // tenant isolation, idempotency, and generation-based exclusivity,
  // exercised through the sanctioned RPC-backed path (createEntityAlias
  // was retired; direct createCanonicalEntity remains, D-017 §3).
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

  const widgetcoNormalized = normalizeEntityTextV1("Widgetco Inc.");

  const aliasFlowDatasetBatch = await db.createDatasetBatch({
    projectId,
    datasetSourceType: "manual_scan",
  });
  const aliasFlowProbeRunA = await db.createProbeRun(
    projectId,
    "perplexity",
    "simulated",
    "pending",
    { datasetId: aliasFlowDatasetBatch.id, datasetSourceType: "manual_scan" }
  );
  const aliasFlowProbeResultA = await db.saveProbeResult({
    probeRunId: aliasFlowProbeRunA.id,
    projectId,
    prompt: "who should we use",
    platform: "perplexity",
    probeMode: "simulated",
    rawResponse: "Widgetco was mentioned as an alternative.",
    clientMentioned: false,
    clientPosition: "absent",
    competitorsMentioned: [],
    sourcesCited: [],
    answerSummary: "",
    verdict: "lost",
    whyClientLost: "",
  });

  // expectedMentionCount is deliberately higher than the single ordinal
  // used below — this pass must stay in_progress across both the
  // original submission and its resubmission (idempotency check).
  const passA = await db.startOrResumeEntityResolutionPass({
    projectId,
    probeResultId: aliasFlowProbeResultA.id,
    resolverVersion: 1,
    datasetId: aliasFlowDatasetBatch.id,
    expectedMentionCount: 5,
    companyName: "Acme Inc.",
    domain: "acme.example",
    normalizedBrandTerms: [normalizeEntityTextV1("Acme Inc.")],
  });

  const firstResolve = await db.resolveAndRecordEntityObservation({
    resolutionPassId: passA.resolutionPassId,
    mentionOrdinal: 0,
    rawText: "Widgetco Inc.",
    normalizedText: widgetcoNormalized,
    status: "resolved",
    proposedEntityType: "competitor",
  });
  check(
    "a first-ever competitor mention creates a fresh canonical_entity and a generation-1 alias that references it (composite consistency, by construction, replacing the old composite-FK rejection test)",
    firstResolve.observationOutcome === "APPLIED" &&
      firstResolve.aliasOutcome === "APPLIED" &&
      firstResolve.aliasGeneration === 1
  );

  const entitiesAfterFirst = await db.getCanonicalEntitiesByProject(projectId);
  check(
    "both directly-created canonical_entities (client, competitor) are still present alongside the one the alias flow created",
    entitiesAfterFirst.some((e) => e.id === clientEntity.id) &&
      entitiesAfterFirst.some((e) => e.id === competitorEntity.id)
  );
  const aliasesAfterFirst = await db.getEntityAliasesByProject(projectId);
  const firstAliasRow = aliasesAfterFirst.find((a) => a.id === firstResolve.aliasId);
  check(
    "the alias's canonicalEntityId references an existing canonical_entities row of the SAME entityType and project",
    firstAliasRow !== undefined &&
      entitiesAfterFirst.some(
        (e) =>
          e.id === firstAliasRow.canonicalEntityId &&
          e.entityType === "competitor" &&
          e.projectId === projectId
      )
  );

  const resubmitted = await db.resolveAndRecordEntityObservation({
    resolutionPassId: passA.resolutionPassId,
    mentionOrdinal: 0,
    rawText: "Widgetco Inc.",
    normalizedText: widgetcoNormalized,
    status: "resolved",
    proposedEntityType: "competitor",
  });
  check(
    "resubmitting the identical mention is idempotent — ALREADY_APPLIED, same aliasId/generation, never a duplicate row (replaces the old UNIQUE-rejection test, corrected for migration 0041's actual key)",
    resubmitted.observationOutcome === "ALREADY_APPLIED" &&
      resubmitted.aliasOutcome === "ALREADY_APPLIED" &&
      resubmitted.aliasId === firstResolve.aliasId &&
      resubmitted.aliasGeneration === firstResolve.aliasGeneration
  );
  const aliasesAfterResubmit = await db.getEntityAliasesByProject(projectId);
  check(
    "no duplicate alias row was created by the resubmission",
    aliasesAfterResubmit.filter((a) => a.normalizedText === widgetcoNormalized).length === 1
  );

  // Tenant isolation — the identical rawText/normalizedText resolved in
  // a DIFFERENT project must never reuse this project's canonical
  // entity or alias (replaces the old mismatched-projectId rejection
  // test, positively verified instead of attempted-and-rejected, since
  // the RPC never accepts an externally-supplied canonicalEntityId or
  // projectId in the first place — the violation is structurally
  // unreachable, not merely rejected).
  const otherProjectId = randomUUID();
  const otherDatasetBatch = await db.createDatasetBatch({
    projectId: otherProjectId,
    datasetSourceType: "manual_scan",
  });
  const otherProbeRun = await db.createProbeRun(
    otherProjectId,
    "perplexity",
    "simulated",
    "pending",
    { datasetId: otherDatasetBatch.id, datasetSourceType: "manual_scan" }
  );
  const otherProbeResult = await db.saveProbeResult({
    probeRunId: otherProbeRun.id,
    projectId: otherProjectId,
    prompt: "who should we use",
    platform: "perplexity",
    probeMode: "simulated",
    rawResponse: "Widgetco was mentioned here too.",
    clientMentioned: false,
    clientPosition: "absent",
    competitorsMentioned: [],
    sourcesCited: [],
    answerSummary: "",
    verdict: "lost",
    whyClientLost: "",
  });
  const otherPass = await db.startOrResumeEntityResolutionPass({
    projectId: otherProjectId,
    probeResultId: otherProbeResult.id,
    resolverVersion: 1,
    datasetId: otherDatasetBatch.id,
    expectedMentionCount: 1,
    companyName: "Zephyr Corp",
    domain: "zephyr.example",
    normalizedBrandTerms: [normalizeEntityTextV1("Zephyr Corp")],
  });
  const otherResolve = await db.resolveAndRecordEntityObservation({
    resolutionPassId: otherPass.resolutionPassId,
    mentionOrdinal: 0,
    rawText: "Widgetco Inc.",
    normalizedText: widgetcoNormalized,
    status: "resolved",
    proposedEntityType: "competitor",
  });
  check(
    "the identical normalizedText resolved in a different project creates its OWN alias and canonical_entity — no cross-project reuse (tenant isolation)",
    otherResolve.aliasOutcome === "APPLIED" &&
      otherResolve.aliasId !== firstResolve.aliasId
  );
  const entitiesOtherProject = await db.getCanonicalEntitiesByProject(otherProjectId);
  check(
    "the two projects' canonical_entities lists are fully disjoint",
    entitiesOtherProject.every(
      (e) => !entitiesAfterFirst.some((mine) => mine.id === e.id)
    )
  );

  // Exclusivity across entityTypes, corrected — migration 0041 dropped
  // entity_type from entity_aliases' uniqueness key specifically so
  // that only ONE entityType is ever active for a given normalizedText
  // in a project. The old test asserted the opposite (coexistence),
  // which is no longer true; this demonstrates the real mechanism —
  // generation-based supersession at a higher resolverVersion, here
  // simulating a brand snapshot updated to recognize "Widgetco" as the
  // client's own brand (e.g. an acquisition).
  const passC = await db.startOrResumeEntityResolutionPass({
    projectId,
    probeResultId: aliasFlowProbeResultA.id,
    resolverVersion: 2,
    datasetId: aliasFlowDatasetBatch.id,
    expectedMentionCount: 1,
    companyName: "Acme Inc.",
    domain: "acme.example",
    normalizedBrandTerms: [normalizeEntityTextV1("Acme Inc."), widgetcoNormalized],
  });
  const supersedingResolve = await db.resolveAndRecordEntityObservation({
    resolutionPassId: passC.resolutionPassId,
    mentionOrdinal: 0,
    rawText: "Widgetco Inc.",
    normalizedText: widgetcoNormalized,
    status: "excluded_brand_self",
    proposedEntityType: "client",
  });
  check(
    "a higher resolverVersion recognizing the same normalizedText as the client supersedes the prior competitor mapping — SUPERSEDED_PRIOR, generation 2 (this is the allowed promotion direction, never the blocked demotion)",
    supersedingResolve.aliasOutcome === "SUPERSEDED_PRIOR" &&
      supersedingResolve.aliasGeneration === (firstResolve.aliasGeneration ?? 0) + 1
  );

  const activeAliasesAfterSupersede = await db.getEntityAliasesActiveByProject(projectId);
  const activeWidgetco = activeAliasesAfterSupersede.find(
    (a) => a.normalizedText === widgetcoNormalized
  );
  check(
    "the active-head view now shows exactly one entry for this normalizedText, entityType='client' — the superseded competitor generation is no longer active",
    activeWidgetco !== undefined && activeWidgetco.entityType === "client"
  );
  const rawAliasesAfterSupersede = await db.getEntityAliasesByProject(projectId);
  check(
    "the historical competitor generation still exists in the raw listing — supersession never deletes a prior row",
    rawAliasesAfterSupersede.some(
      (a) => a.normalizedText === widgetcoNormalized && a.entityType === "competitor"
    ) &&
      rawAliasesAfterSupersede.filter((a) => a.normalizedText === widgetcoNormalized).length === 2
  );

  const entities = await db.getCanonicalEntitiesByProject(projectId);
  check(
    "getCanonicalEntitiesByProject returns exactly the two directly-created entities plus the one fresh competitor entity created by the alias flow",
    entities.length === 3
  );
  const aliases = await db.getEntityAliasesByProject(projectId);
  check(
    "getEntityAliasesByProject returns exactly two raw rows for this project — the competitor generation and the superseding client generation",
    aliases.length === 2
  );

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
      "any real project; entity resolution's actual RPC-backed business\n" +
      "logic (brand-self exclusion, the demote-block, D-018's override) is\n" +
      "a later tranche's scope, exercised here only enough to preserve this\n" +
      "file's own composite/tenant-isolation/generation coverage now that\n" +
      "createEntityAlias is retired; no sampleLabel; no\n" +
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
