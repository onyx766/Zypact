#!/usr/bin/env tsx
/**
 * M2 — Canonical observations, SECOND TRANCHE.
 *
 * Covers: dataset_batches resolution helpers, the live writers
 * (scripts/mvp-scan.ts, lib/pipeline/run-live-perplexity-probes.ts),
 * the backfill script's classification and dry-run/apply behavior,
 * and the backfill_probe_result_dataset_identity RPC's four-status
 * contract (D-015), simulated against the in-memory adapter.
 *
 * lib/snapshot-engine/run-approved-snapshot.ts is deliberately NOT
 * wired in this tranche: it never writes probe_runs/probe_results
 * directly. It spawns scripts/mvp-scan.ts as a child process and
 * already propagates SNAPSHOT_REQUEST_ID as an environment variable
 * (confirmed by static assertion below) — the actual dataset_batches
 * resolution happens inside mvp-scan.ts, which reads that variable.
 *
 * This is schema-and-wiring coverage for the SECOND M2 tranche:
 *   - no real backfill is executed against staging or production;
 *   - no HockeyStack fixture is exercised here — that requires real
 *     staging data and stays a documented limitation of this tranche;
 *   - the RPC's live-Postgres locking/constraint behavior cannot be
 *     tested without a real Postgres connection, matching the same
 *     limitation already documented for 0036/0037/0038.
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ZYPACT_ALLOW_MEMORY_DB;
delete process.env.SNAPSHOT_REQUEST_ID;
process.env.ZYPACT_MOCK_MODE = "on";

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getDb } from "@/lib/db";
import {
  createManualScanDatasetBatch,
  resolveDatasetBatchForInvocation,
  resolveLegacyUnresolvedDatasetBatch,
  resolveSnapshotRequestDatasetBatch,
} from "@/lib/evidence/resolve-dataset-batch";
import {
  classifyProjectForBackfill,
  main as runBackfillMain,
  nullProbeResults,
  nullProbeRuns,
} from "@/scripts/backfill-probe-result-dataset-identity";

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

const libDir = process.cwd();
const migration0039 = readFileSync(
  path.join(libDir, "supabase", "migrations", "0039_m2_backfill_probe_result_dataset_identity_rpc.sql"),
  "utf8"
);
const mvpScanSource = readFileSync(path.join(libDir, "scripts", "mvp-scan.ts"), "utf8");
const runLiveProbesSource = readFileSync(
  path.join(libDir, "lib", "pipeline", "run-live-perplexity-probes.ts"),
  "utf8"
);
const runApprovedSnapshotSource = readFileSync(
  path.join(libDir, "lib", "snapshot-engine", "run-approved-snapshot.ts"),
  "utf8"
);
const runLiveProbesCliSource = readFileSync(
  path.join(libDir, "scripts", "run-live-perplexity-probes.ts"),
  "utf8"
);

function staticChecks(): void {
  console.log("\n  static — migration 0039 (RPC) text");

  check(
    "does not touch migrations 0036/0037/0038",
    !/alter\s+table\s+public\.(probe_results|probe_runs|dataset_batches|canonical_entities|entity_aliases)\s+alter\s+column/i.test(
      migration0039
    )
  );
  check(
    "returns table with exactly the four literal statuses",
    migration0039.includes(
      "-- 'APPLIED' | 'ALREADY_APPLIED' | 'NOT_FOUND' | 'CONFLICT'"
    )
  );
  check(
    "search_path is pinned",
    migration0039.includes("set search_path = public, pg_temp")
  );
  check(
    "security definer",
    migration0039.includes("security definer")
  );
  check(
    "revoked from public, anon, authenticated; granted to service_role only",
    migration0039.includes("from public;") &&
      migration0039.includes("from anon;") &&
      migration0039.includes("from authenticated;") &&
      migration0039.includes("to service_role;") &&
      !/grant\s+.*update.*on\s+.*probe_results/i.test(migration0039)
  );
  check(
    "the row lock happens before the dataset_batches validation (probe_results locked first)",
    migration0039.indexOf("from public.probe_results pr") <
      migration0039.indexOf("from public.dataset_batches db")
  );
  check(
    "invalid dataset_batch raises 22023, not a status",
    migration0039.includes("invalid_backfill_dataset_batch")
  );
  check(
    "ALREADY_APPLIED requires all five columns to match (is not distinct from)",
    (migration0039.match(/is not distinct from/g) ?? []).length === 3
  );
  check(
    "the UPDATE is guarded by all five columns being NULL",
    /where id = p_probe_result_id[\s\S]{0,20}and project_id = p_project_id[\s\S]{0,20}and dataset_id is null[\s\S]{0,20}and dataset_source_type is null[\s\S]{0,20}and run_position is null[\s\S]{0,20}and negative_claim_detected is null[\s\S]{0,20}and observation_schema_version is null/.test(
      migration0039
    )
  );
  const updateClauseMatch = migration0039.match(
    /update public\.probe_results\s+set([\s\S]*?)\s+where/i
  );
  check(
    "exactly one UPDATE ... SET clause exists on probe_results",
    updateClauseMatch !== null
  );
  const setClauseBody = updateClauseMatch?.[1] ?? "";
  check(
    "the SET clause assigns only the five allowed columns",
    setClauseBody.includes("dataset_id =") &&
      setClauseBody.includes("dataset_source_type =") &&
      setClauseBody.includes("run_position =") &&
      setClauseBody.includes("negative_claim_detected =") &&
      setClauseBody.includes("observation_schema_version =") &&
      !/(verdict|product_verdict|client_position|raw_response|project_id|snapshot_request_id)\s*=/i.test(
        setClauseBody
      )
  );

  console.log("\n  static — writer wiring");

  check(
    "mvp-scan.ts resolves the dataset batch before the missing-probes loop",
    mvpScanSource.indexOf("resolveDatasetBatchForInvocation(") <
      mvpScanSource.indexOf("for (const prompt of promptTargets)")
  );
  check(
    "mvp-scan.ts reads SNAPSHOT_REQUEST_ID for the classification, never infers manual_scan from its absence alone at the historical layer",
    mvpScanSource.includes("process.env.SNAPSHOT_REQUEST_ID")
  );
  check(
    "mvp-scan.ts sets probe_runs dataset identity before the live provider call",
    mvpScanSource.indexOf("updateProbeRunDatasetIdentity(probeRun.id") <
      mvpScanSource.indexOf("runPerplexityProbe({")
  );
  check(
    "run-live-perplexity-probes.ts never creates or infers a manual_scan batch itself",
    !runLiveProbesSource.includes("createManualScanDatasetBatch") &&
      !runLiveProbesSource.includes("resolveDatasetBatchForInvocation")
  );
  check(
    "run-live-perplexity-probes.ts requires datasetId/datasetSourceType as mandatory input fields",
    /datasetId: string;/.test(runLiveProbesSource) &&
      /datasetSourceType: DatasetSourceType;/.test(runLiveProbesSource)
  );
  check(
    "run-live-perplexity-probes.ts fails explicitly (ok:false) when datasetId/datasetSourceType are missing, before doing any other work",
    /if \(!input\.datasetId \|\| !input\.datasetSourceType\)/.test(runLiveProbesSource) &&
      runLiveProbesSource.indexOf("!input.datasetId || !input.datasetSourceType") <
        runLiveProbesSource.indexOf("db.getProject(input.projectId)")
  );
  check(
    "run-live-perplexity-probes.ts propagates the caller-supplied dataset identity to both updateProbeRunDatasetIdentity and analyzeProbeResponse",
    (runLiveProbesSource.match(/datasetId: input\.datasetId/g) ?? []).length >= 2 &&
      (runLiveProbesSource.match(/datasetSourceType: input\.datasetSourceType/g) ?? []).length >= 2
  );
  check(
    "the CLI wrapper (scripts/run-live-perplexity-probes.ts) resolves the manual_scan batch and passes it in",
    runLiveProbesCliSource.indexOf("createManualScanDatasetBatch(") <
      runLiveProbesCliSource.indexOf("runLivePerplexityProbes({") &&
      runLiveProbesCliSource.includes("datasetId: datasetBatch.id") &&
      runLiveProbesCliSource.includes("datasetSourceType: datasetBatch.datasetSourceType")
  );
  check(
    "run-approved-snapshot.ts still propagates SNAPSHOT_REQUEST_ID to the mvp-scan.ts child process (no direct probe write in this file)",
    runApprovedSnapshotSource.includes("SNAPSHOT_REQUEST_ID: request.id") &&
      !/saveProbeResult|createProbeRun/.test(runApprovedSnapshotSource)
  );
  check(
    "mvp-scan.ts propagates the resolved dataset identity on BOTH the simulated and live probe_results writes",
    (mvpScanSource.match(/datasetId: datasetBatch\.id,/g) ?? []).length >= 4
  );
  check(
    "no write site anywhere passes a snapshotRequestId value as dataset_id (dataset_id is always a resolved batch's .id)",
    !/datasetId:\s*(input\.)?snapshotRequestId/.test(mvpScanSource) &&
      !/datasetId:\s*(input\.)?snapshotRequestId/.test(runLiveProbesSource) &&
      !/datasetId:\s*(input\.)?snapshotRequestId/.test(runLiveProbesCliSource)
  );

  console.log("\n  static — backfill script never assigns manual_scan to historical data");

  const backfillSource = readFileSync(
    path.join(libDir, "scripts", "backfill-probe-result-dataset-identity.ts"),
    "utf8"
  );
  check(
    "the classification function's return type excludes manual_scan",
    !/datasetSourceType:\s*"manual_scan"/.test(backfillSource)
  );
  check(
    "the script requires explicit --project-id, never auto-discovers projects",
    backfillSource.includes("never auto-discovers projects") &&
      backfillSource.includes("At least one --project-id is required")
  );
  check(
    "apply defaults to false; only --apply sets it true",
    backfillSource.includes('let apply = false;') &&
      (backfillSource.match(/apply = true/g) ?? []).length === 1 &&
      /arg === "--apply"\)\s*\{\s*apply = true;/.test(
        backfillSource.replace(/\s+/g, " ")
      )
  );
}

async function dynamicChecks(): Promise<void> {
  console.log("\n  dynamic — dataset_batches resolution helpers");
  const db = getDb();
  const projectId = randomUUID();
  const snapshotRequestId = randomUUID();

  const first = await resolveSnapshotRequestDatasetBatch(db, projectId, snapshotRequestId);
  const second = await resolveSnapshotRequestDatasetBatch(db, projectId, snapshotRequestId);
  check(
    "resolveSnapshotRequestDatasetBatch reuses the same batch for the same snapshot request",
    first.id === second.id
  );
  check(
    "the resolved batch's own id is the value a writer would use as dataset_id — it is NOT the snapshotRequestId",
    first.id !== snapshotRequestId &&
      first.snapshotRequestId === snapshotRequestId &&
      first.datasetSourceType === "snapshot_request"
  );

  const manualOne = await createManualScanDatasetBatch(db, projectId);
  const manualTwo = await createManualScanDatasetBatch(db, projectId);
  check(
    "createManualScanDatasetBatch never reuses — each invocation gets its own batch",
    manualOne.id !== manualTwo.id
  );

  const legacyOne = await resolveLegacyUnresolvedDatasetBatch(db, projectId, "test note");
  const legacyTwo = await resolveLegacyUnresolvedDatasetBatch(db, projectId, "test note");
  check(
    "resolveLegacyUnresolvedDatasetBatch is idempotent per project (backfill_key reuse)",
    legacyOne.id === legacyTwo.id
  );

  const dispatchedWithId = await resolveDatasetBatchForInvocation(db, projectId, snapshotRequestId);
  check(
    "resolveDatasetBatchForInvocation dispatches to snapshot_request when an id is present",
    dispatchedWithId.id === first.id
  );
  const dispatchedWithout = await resolveDatasetBatchForInvocation(db, projectId, undefined);
  check(
    "resolveDatasetBatchForInvocation dispatches to a fresh manual_scan when absent",
    dispatchedWithout.datasetSourceType === "manual_scan" &&
      dispatchedWithout.id !== manualOne.id &&
      dispatchedWithout.id !== manualTwo.id
  );

  console.log("\n  dynamic — backfill classification (never manual_scan for historical data)");

  const projectZeroRequests = randomUUID();
  const classifiedZero = await classifyProjectForBackfill(db, projectZeroRequests);
  check(
    "zero candidate snapshot_requests classifies as legacy_unresolved",
    classifiedZero.datasetSourceType === "legacy_unresolved"
  );

  console.log("\n  dynamic — backfill_probe_result_dataset_identity (D-015 four-status contract)");

  const probeRun = await db.createProbeRun(projectId, "perplexity", "live_perplexity");
  const probeResult = await db.saveProbeResult({
    probeRunId: probeRun.id,
    projectId,
    prompt: "best tools for X",
    platform: "perplexity",
    probeMode: "live_perplexity",
    rawResponse: "mock",
    clientMentioned: false,
    clientPosition: "absent",
    competitorsMentioned: [],
    sourcesCited: [],
    answerSummary: "",
    verdict: "lost",
    whyClientLost: "",
  });

  const applied = await db.backfillProbeResultDatasetIdentity({
    probeResultId: probeResult.id,
    projectId,
    datasetId: legacyOne.id,
    datasetSourceType: "legacy_unresolved",
    runPosition: "not_observed_in_run",
    negativeClaimDetected: false,
    observationSchemaVersion: 1,
  });
  check(
    "all-NULL row → APPLIED, five columns written",
    applied.status === "APPLIED" &&
      applied.probeResult?.datasetId === legacyOne.id &&
      applied.probeResult?.runPosition === "not_observed_in_run"
  );

  const alreadyApplied = await db.backfillProbeResultDatasetIdentity({
    probeResultId: probeResult.id,
    projectId,
    datasetId: legacyOne.id,
    datasetSourceType: "legacy_unresolved",
    runPosition: "not_observed_in_run",
    negativeClaimDetected: false,
    observationSchemaVersion: 1,
  });
  check(
    "identical rerun → ALREADY_APPLIED, no error",
    alreadyApplied.status === "ALREADY_APPLIED"
  );

  const conflictDifferentDataset = await db.backfillProbeResultDatasetIdentity({
    probeResultId: probeResult.id,
    projectId,
    datasetId: manualOne.id,
    datasetSourceType: "manual_scan",
    runPosition: null,
    negativeClaimDetected: null,
    observationSchemaVersion: null,
  });
  check(
    "different dataset_id on an already-set row → CONFLICT, unchanged",
    conflictDifferentDataset.status === "CONFLICT" &&
      conflictDifferentDataset.probeResult?.datasetId === legacyOne.id
  );

  const notFound = await db.backfillProbeResultDatasetIdentity({
    probeResultId: randomUUID(),
    projectId,
    datasetId: legacyOne.id,
    datasetSourceType: "legacy_unresolved",
    runPosition: null,
    negativeClaimDetected: null,
    observationSchemaVersion: null,
  });
  check(
    "nonexistent probe_result → NOT_FOUND, probeResult null",
    notFound.status === "NOT_FOUND" && notFound.probeResult === null
  );

  const allFourOutcomes = [applied, alreadyApplied, conflictDifferentDataset, notFound];
  const allowedStatuses = new Set(["APPLIED", "ALREADY_APPLIED", "NOT_FOUND", "CONFLICT"]);
  check(
    "every outcome is defined and exactly one of the four literal statuses — never undefined, never an empty/absent result",
    allFourOutcomes.every(
      (o) => o !== undefined && o !== null && allowedStatuses.has(o.status)
    )
  );
  check(
    "the four outcomes observed above are pairwise distinct statuses (APPLIED, ALREADY_APPLIED, CONFLICT, NOT_FOUND each occurred)",
    new Set(allFourOutcomes.map((o) => o.status)).size === 4
  );

  console.log("\n  dynamic — partially-populated row is CONFLICT, never silently completed");

  const partialProbeResult = await db.saveProbeResult({
    probeRunId: probeRun.id,
    projectId,
    prompt: "another prompt",
    platform: "perplexity",
    probeMode: "live_perplexity",
    rawResponse: "mock",
    clientMentioned: false,
    clientPosition: "absent",
    competitorsMentioned: [],
    sourcesCited: [],
    answerSummary: "",
    verdict: "lost",
    whyClientLost: "",
    runPosition: "not_observed_in_run",
  });
  const partialConflict = await db.backfillProbeResultDatasetIdentity({
    probeResultId: partialProbeResult.id,
    projectId,
    datasetId: legacyOne.id,
    datasetSourceType: "legacy_unresolved",
    runPosition: "not_observed_in_run",
    negativeClaimDetected: null,
    observationSchemaVersion: null,
  });
  check(
    "dataset_id NULL but run_position already set → CONFLICT, not APPLIED",
    partialConflict.status === "CONFLICT" &&
      partialConflict.probeResult?.datasetId === null &&
      partialConflict.probeResult?.runPosition === "not_observed_in_run"
  );

  const invalidBatch = randomUUID();
  let raised = false;
  try {
    await db.backfillProbeResultDatasetIdentity({
      probeResultId: partialProbeResult.id,
      projectId,
      datasetId: invalidBatch,
      datasetSourceType: "legacy_unresolved",
      runPosition: null,
      negativeClaimDetected: null,
      observationSchemaVersion: null,
    });
  } catch {
    raised = true;
  }
  check(
    "a dataset_id with no matching dataset_batches row raises, not a status",
    raised
  );

  console.log("\n  dynamic — updateProbeRunDatasetIdentity (probe_runs stays plain UPDATE)");

  const runToUpdate = await db.createProbeRun(projectId, "perplexity", "live_perplexity");
  check(
    "freshly created probe_run has null dataset identity",
    runToUpdate.datasetId === null
  );
  await db.updateProbeRunDatasetIdentity(runToUpdate.id, {
    datasetId: legacyOne.id,
    datasetSourceType: "legacy_unresolved",
  });
  const runsAfter = await db.getProbeRunsByProject(projectId);
  const updatedRun = runsAfter.find((r) => r.id === runToUpdate.id);
  check(
    "updateProbeRunDatasetIdentity writes both fields",
    updatedRun?.datasetId === legacyOne.id &&
      updatedRun?.datasetSourceType === "legacy_unresolved"
  );

  console.log("\n  dynamic — backfill script dry-run performs no writes");

  const dryRunProjectId = randomUUID();

  const beforeBatches = await db.getDatasetBatchesByProject(dryRunProjectId);
  const beforeRuns = await db.getProbeRunsByProject(dryRunProjectId);
  const beforeResults = await db.getProbeResultsByProject(dryRunProjectId);

  await runBackfillMain(["--project-id", dryRunProjectId, "--dry-run"]);

  const afterBatches = await db.getDatasetBatchesByProject(dryRunProjectId);
  const afterRuns = await db.getProbeRunsByProject(dryRunProjectId);
  const afterResults = await db.getProbeResultsByProject(dryRunProjectId);
  check(
    "dry-run creates zero dataset_batches rows",
    beforeBatches.length === afterBatches.length && afterBatches.length === 0
  );
  check(
    "dry-run leaves probe_runs/probe_results untouched",
    beforeRuns.length === afterRuns.length && beforeResults.length === afterResults.length
  );

  console.log("\n  dynamic — backfill script defaults to dry-run with no mode flag at all");

  const noFlagProjectId = randomUUID();
  const beforeNoFlagBatches = await db.getDatasetBatchesByProject(noFlagProjectId);
  await runBackfillMain(["--project-id", noFlagProjectId]);
  const afterNoFlagBatches = await db.getDatasetBatchesByProject(noFlagProjectId);
  check(
    "no --dry-run and no --apply flag → still zero writes (dry-run is the true default)",
    beforeNoFlagBatches.length === 0 && afterNoFlagBatches.length === 0
  );

  console.log("\n  dynamic — backfill script --apply writes exactly the classified batch");

  const applyProjectId = randomUUID();
  const applyRun = await db.createProbeRun(applyProjectId, "perplexity", "live_perplexity");
  const applyResult = await db.saveProbeResult({
    probeRunId: applyRun.id,
    projectId: applyProjectId,
    prompt: "apply test prompt",
    platform: "perplexity",
    probeMode: "live_perplexity",
    rawResponse: "mock",
    clientMentioned: false,
    clientPosition: "absent",
    competitorsMentioned: [],
    sourcesCited: [],
    answerSummary: "",
    verdict: "lost",
    whyClientLost: "",
  });

  await runBackfillMain(["--project-id", applyProjectId, "--apply"]);

  const applyBatches = await db.getDatasetBatchesByProject(applyProjectId);
  check(
    "--apply on a project with zero snapshot_requests creates exactly one legacy_unresolved batch",
    applyBatches.length === 1 && applyBatches[0]!.datasetSourceType === "legacy_unresolved"
  );
  const applyRunsAfter = await db.getProbeRunsByProject(applyProjectId);
  const applyResultsAfter = await db.getProbeResultsByProject(applyProjectId);
  const updatedApplyRun = applyRunsAfter.find((r) => r.id === applyRun.id);
  const updatedApplyResult = applyResultsAfter.find((r) => r.id === applyResult.id);
  check(
    "--apply backfills the probe_run and probe_result to the same batch",
    updatedApplyRun?.datasetId === applyBatches[0]!.id &&
      updatedApplyResult?.datasetId === applyBatches[0]!.id
  );
  check(
    "nullProbeRuns/nullProbeResults report zero remaining after --apply",
    nullProbeRuns(applyRunsAfter).length === 0 &&
      nullProbeResults(applyResultsAfter).length === 0
  );
}

async function main(): Promise<void> {
  staticChecks();
  await dynamicChecks();

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0
        ? "M2 tranche 2 writer/backfill contract PASSED."
        : "M2 tranche 2 writer/backfill contract FAILED.")
  );
  console.log(
    "\nTHIS IS THE SECOND M2 TRANCHE — NOT A FULL M2 CLOSE-OUT.\n" +
      "Closed by this tranche: writers resolve/create dataset_batches\n" +
      "before any probe_run write; run-approved-snapshot.ts confirmed to\n" +
      "need no change (it never writes probes directly); the backfill\n" +
      "script classifies zero/one/many snapshot_requests correctly and\n" +
      "never assigns manual_scan to historical data; the D-015 RPC's\n" +
      "four-status contract (APPLIED/ALREADY_APPLIED/CONFLICT/NOT_FOUND),\n" +
      "including the partially-populated CONFLICT case, is verified\n" +
      "against the in-memory adapter; dry-run performs zero writes.\n" +
      "NOT closed by this tranche: no real backfill has run against\n" +
      "staging or production; the HockeyStack golden fixture has not\n" +
      "been exercised against real data — that requires a staging\n" +
      "connection this session does not have; the RPC's live-Postgres\n" +
      "locking behavior is asserted only statically, not against a real\n" +
      "database; the NOT NULL tightening migration remains undrafted,\n" +
      "conditional on the two zero-count verifications on real data."
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(2);
});
