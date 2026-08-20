#!/usr/bin/env tsx
/**
 * M2 canonical observations contract, third tranche — historical
 * reprocessing regression (D-017, D-018, D-019).
 *
 * Exercises scripts/backfill-entity-observations.ts's
 * runEntityObservationBackfill against the in-memory adapter: the
 * --dry-run default performs zero writes, --project-id/--probe-result-id
 * scope the batch correctly, repeated --apply runs are idempotent, and
 * probe_run/probe_result evidence is never touched either way.
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ZYPACT_ALLOW_MEMORY_DB;
process.env.ZYPACT_MOCK_MODE = "on";

import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/db";
import type { DbAdapter, ProbeResult } from "@/lib/db/types";
import {
  runEntityObservationBackfill,
  serializeUnknownError,
} from "@/scripts/backfill-entity-observations";

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

function freshDomain(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 10)}.example.com`;
}

/**
 * Directly persists a probe_result the way analyze-probe-response.ts
 * would have, but WITHOUT calling it — this test's whole point is
 * historical rows that predate (or otherwise never received) the
 * entity-resolution wiring. No agent, no LLM, no mock analyzer: the
 * raw evidence fields are hand-specified exactly as they would already
 * sit in the database.
 */
async function seedHistoricalProbeResult(
  db: DbAdapter,
  projectId: string,
  datasetId: string,
  fields: {
    rawResponse: string;
    competitorsMentioned: Array<{ name?: string; position?: number; context?: string }>;
  }
): Promise<ProbeResult> {
  const probeRun = await db.createProbeRun(projectId, "perplexity", "simulated", "succeeded", {
    datasetId,
    datasetSourceType: "manual_scan",
  });
  return db.saveProbeResult({
    probeRunId: probeRun.id,
    projectId,
    prompt: "who should we use for AI visibility diagnostics",
    platform: "perplexity",
    probeMode: "simulated",
    rawResponse: fields.rawResponse,
    clientMentioned: false,
    clientPosition: "absent",
    competitorsMentioned: fields.competitorsMentioned,
    sourcesCited: [],
    answerSummary: "",
    verdict: "lost",
    whyClientLost: "",
    datasetId,
    datasetSourceType: "manual_scan",
  });
}

function snapshotEvidence(r: ProbeResult) {
  return JSON.stringify(r);
}

async function main(): Promise<void> {
  const db = getDb();

  /* -------------------------------------------------------------- */
  /* Scenario 1 — --dry-run is the default and performs zero writes  */
  /* -------------------------------------------------------------- */
  {
    const project = await db.createProject({
      domain: freshDomain("reproc-dry"),
      companyName: "Acme Reprocess Co.",
    });
    const datasetBatch = await db.createDatasetBatch({
      projectId: project.id,
      datasetSourceType: "manual_scan",
    });
    const probeResult = await seedHistoricalProbeResult(db, project.id, datasetBatch.id, {
      rawResponse: "Acme Reprocess Co. is a strong option. Widgetco is another one.",
      competitorsMentioned: [{ name: "Widgetco", position: 1, context: "Widgetco is another one." }],
    });

    const beforeObservations = await db.getEntityObservationsActiveByProbeResult(probeResult.id);
    const beforeAliases = await db.getEntityAliasesActiveByProject(project.id);

    const report = await runEntityObservationBackfill(db, {
      projectId: project.id,
      apply: false, // default mode
    });

    check("1: report is scoped to the one seeded probe_result", report.outcomes.length === 1);
    check(
      "1: outcome is would_process (a real gap exists to report)",
      report.outcomes[0]?.action === "would_process",
      JSON.stringify(report.outcomes[0])
    );

    const afterObservations = await db.getEntityObservationsActiveByProbeResult(probeResult.id);
    const afterAliases = await db.getEntityAliasesActiveByProject(project.id);
    check(
      "1: zero observations written by --dry-run",
      beforeObservations.length === 0 && afterObservations.length === 0
    );
    check("1: zero aliases written by --dry-run", beforeAliases.length === 0 && afterAliases.length === 0);
  }

  /* -------------------------------------------------------------- */
  /* Scenario 2 — --project-id scopes the batch: an untargeted       */
  /* project's probe_results are never touched by --apply             */
  /* -------------------------------------------------------------- */
  {
    const projectA = await db.createProject({
      domain: freshDomain("reproc-proj-a"),
      companyName: "Acme Reprocess Co.",
    });
    const datasetA = await db.createDatasetBatch({ projectId: projectA.id, datasetSourceType: "manual_scan" });
    const resultA = await seedHistoricalProbeResult(db, projectA.id, datasetA.id, {
      rawResponse: "Acme Reprocess Co. is the top pick here.",
      competitorsMentioned: [],
    });

    const projectB = await db.createProject({
      domain: freshDomain("reproc-proj-b"),
      companyName: "Zephyrion Holdings",
    });
    const datasetB = await db.createDatasetBatch({ projectId: projectB.id, datasetSourceType: "manual_scan" });
    const resultB = await seedHistoricalProbeResult(db, projectB.id, datasetB.id, {
      rawResponse: "Zephyrion Holdings also came up in this answer.",
      competitorsMentioned: [],
    });

    await runEntityObservationBackfill(db, { projectId: projectA.id, apply: true });

    const obsA = await db.getEntityObservationsActiveByProbeResult(resultA.id);
    const obsB = await db.getEntityObservationsActiveByProbeResult(resultB.id);
    check("2: targeted project A's probe_result got its observation", obsA.length === 1, `${obsA.length}`);
    check(
      "2: untargeted project B's probe_result is completely untouched",
      obsB.length === 0,
      `${obsB.length}`
    );
  }

  /* -------------------------------------------------------------- */
  /* Scenario 3 — --probe-result-id narrows to one row within a      */
  /* project that has more than one probe_result                     */
  /* -------------------------------------------------------------- */
  {
    const project = await db.createProject({
      domain: freshDomain("reproc-prid"),
      companyName: "Acme Reprocess Co.",
    });
    const datasetBatch = await db.createDatasetBatch({
      projectId: project.id,
      datasetSourceType: "manual_scan",
    });
    const targeted = await seedHistoricalProbeResult(db, project.id, datasetBatch.id, {
      rawResponse: "Acme Reprocess Co. is a strong option here.",
      competitorsMentioned: [],
    });
    const sibling = await seedHistoricalProbeResult(db, project.id, datasetBatch.id, {
      rawResponse: "Acme Reprocess Co. shows up in this one too.",
      competitorsMentioned: [],
    });

    const report = await runEntityObservationBackfill(db, {
      projectId: project.id,
      probeResultId: targeted.id,
      apply: true,
    });

    check("3: exactly one outcome, for the targeted probe_result only", report.outcomes.length === 1);
    check(
      "3: the outcome's id matches the targeted probe_result",
      report.outcomes[0]?.probeResultId === targeted.id
    );

    const obsTargeted = await db.getEntityObservationsActiveByProbeResult(targeted.id);
    const obsSibling = await db.getEntityObservationsActiveByProbeResult(sibling.id);
    check("3: targeted probe_result got its observation", obsTargeted.length === 1, `${obsTargeted.length}`);
    check(
      "3: sibling probe_result in the same project is untouched",
      obsSibling.length === 0,
      `${obsSibling.length}`
    );
  }

  /* -------------------------------------------------------------- */
  /* Scenario 4 — idempotence: a second --apply run makes zero        */
  /* additional writes                                                */
  /* -------------------------------------------------------------- */
  {
    const project = await db.createProject({
      domain: freshDomain("reproc-idem"),
      companyName: "Acme Reprocess Co.",
    });
    const datasetBatch = await db.createDatasetBatch({
      projectId: project.id,
      datasetSourceType: "manual_scan",
    });
    const probeResult = await seedHistoricalProbeResult(db, project.id, datasetBatch.id, {
      rawResponse: "Acme Reprocess Co. and Widgetco both came up here.",
      competitorsMentioned: [{ name: "Widgetco", position: 1, context: "Widgetco both came up here." }],
    });

    const firstReport = await runEntityObservationBackfill(db, { projectId: project.id, apply: true });
    check(
      "4: first --apply run actually processes the row",
      firstReport.outcomes[0]?.action === "processed",
      JSON.stringify(firstReport.outcomes[0])
    );

    const afterFirst = await db.getEntityObservationsActiveByProbeResult(probeResult.id);
    const aliasesAfterFirst = await db.getEntityAliasesActiveByProject(project.id);

    const secondReport = await runEntityObservationBackfill(db, { projectId: project.id, apply: true });
    check(
      "4: second --apply run reports skipped_already_completed, not processed",
      secondReport.outcomes[0]?.action === "skipped_already_completed",
      JSON.stringify(secondReport.outcomes[0])
    );

    const afterSecond = await db.getEntityObservationsActiveByProbeResult(probeResult.id);
    const aliasesAfterSecond = await db.getEntityAliasesActiveByProject(project.id);

    check(
      "4: observation count is unchanged by the second run",
      afterFirst.length === afterSecond.length && afterFirst.length === 2,
      `${afterFirst.length} vs ${afterSecond.length}`
    );
    check(
      "4: observation ids are exactly the same rows, not new duplicates",
      afterFirst.map((o) => o.id).sort().join(",") === afterSecond.map((o) => o.id).sort().join(","),
    );
    check(
      "4: alias count is unchanged by the second run",
      aliasesAfterFirst.length === aliasesAfterSecond.length && aliasesAfterFirst.length === 2,
      `${aliasesAfterFirst.length} vs ${aliasesAfterSecond.length}`
    );
  }

  /* -------------------------------------------------------------- */
  /* Scenario 5 — probe_result/probe_run evidence is preserved         */
  /* byte-for-byte across a --dry-run and a subsequent --apply         */
  /* -------------------------------------------------------------- */
  {
    const project = await db.createProject({
      domain: freshDomain("reproc-preserve"),
      companyName: "Acme Reprocess Co.",
    });
    const datasetBatch = await db.createDatasetBatch({
      projectId: project.id,
      datasetSourceType: "manual_scan",
    });
    const probeResult = await seedHistoricalProbeResult(db, project.id, datasetBatch.id, {
      rawResponse: "Acme Reprocess Co. is a strong option. Widgetco is another one.",
      competitorsMentioned: [{ name: "Widgetco", position: 1, context: "Widgetco is another one." }],
    });
    const runsBefore = await db.getProbeRunsByProject(project.id);
    const runBefore = runsBefore.find((r) => r.id === probeResult.probeRunId)!;
    const resultsBefore = await db.getProbeResultsByProject(project.id);
    const before = resultsBefore.find((r) => r.id === probeResult.id)!;
    const beforeSnapshot = snapshotEvidence(before);

    await runEntityObservationBackfill(db, { projectId: project.id, apply: false });
    await runEntityObservationBackfill(db, { projectId: project.id, apply: true });

    const runsAfter = await db.getProbeRunsByProject(project.id);
    const runAfter = runsAfter.find((r) => r.id === probeResult.probeRunId)!;
    const resultsAfter = await db.getProbeResultsByProject(project.id);
    const after = resultsAfter.find((r) => r.id === probeResult.id)!;
    const afterSnapshot = snapshotEvidence(after);

    check("5: probe_result row is byte-for-byte identical after dry-run + apply", beforeSnapshot === afterSnapshot);
    check("5: probe_run status is unchanged", runBefore.status === runAfter.status);
    check(
      "5: probe_run row is otherwise unchanged",
      JSON.stringify(runBefore) === JSON.stringify(runAfter)
    );
  }

  /* -------------------------------------------------------------- */
  /* Scenario 6 — static source assertions: buildClientIdentity has   */
  /* exactly one definition (lib/evidence/build-client-identity.ts),  */
  /* neither the live pipeline nor the backfill script keeps its own  */
  /* local copy, both import that same module, and both construct    */
  /* the brandTerms array in the identical name/domain/aliases order  */
  /* -------------------------------------------------------------- */
  {
    const pipelineSource = fs.readFileSync(
      path.join(__dirname, "..", "lib", "pipeline", "analyze-probe-response.ts"),
      "utf8"
    );
    const backfillSource = fs.readFileSync(
      path.join(__dirname, "backfill-entity-observations.ts"),
      "utf8"
    );

    const localDefinitionPattern = /function\s+buildClientIdentity\s*\(/;
    check(
      "6: analyze-probe-response.ts keeps no local buildClientIdentity copy",
      !localDefinitionPattern.test(pipelineSource)
    );
    check(
      "6: backfill-entity-observations.ts keeps no local buildClientIdentity copy",
      !localDefinitionPattern.test(backfillSource)
    );

    const sharedImportPattern =
      /import\s*\{\s*buildClientIdentity\s*\}\s*from\s*["']@\/lib\/evidence\/build-client-identity["']/;
    check(
      "6: analyze-probe-response.ts imports buildClientIdentity from the shared module",
      sharedImportPattern.test(pipelineSource)
    );
    check(
      "6: backfill-entity-observations.ts imports buildClientIdentity from the shared module",
      sharedImportPattern.test(backfillSource)
    );

    // Both call sites must build brandTerms in the exact same order —
    // clientName.name, then clientName.domain (falling back to ""),
    // then the aliases spread — regardless of each file's own line
    // wrapping/formatting. mention_ordinal 0's candidate matching in
    // locateClientMention depends on this order (D-017 §6).
    const brandTermsOrderPattern =
      /\[\s*clientName\.name\s*,\s*clientName\.domain\s*\?\?\s*""\s*,\s*\.\.\.\(clientName\.aliases\s*\?\?\s*\[\]\)\s*,?\s*\]/;
    check(
      "6: analyze-probe-response.ts builds brandTerms as [name, domain, ...aliases]",
      brandTermsOrderPattern.test(pipelineSource)
    );
    check(
      "6: backfill-entity-observations.ts builds brandTerms as [name, domain, ...aliases]",
      brandTermsOrderPattern.test(backfillSource)
    );

    const sharedModuleSource = fs.readFileSync(
      path.join(__dirname, "..", "lib", "evidence", "build-client-identity.ts"),
      "utf8"
    );
    check(
      "6: the shared module exports exactly one buildClientIdentity function",
      (sharedModuleSource.match(/function\s+buildClientIdentity\s*\(/g) ?? []).length === 1
    );
  }

  /* -------------------------------------------------------------- */
  /* Scenario 7 — serializeUnknownError: a non-Error, PostgREST-      */
  /* shaped plain object (exactly what supabase-js throws for an RPC  */
  /* error — lib/db/supabase-adapter.ts's `if (error) throw error;`)  */
  /* must have message/code/details/hint preserved, never collapse    */
  /* to the useless literal "[object Object]" that masked the real   */
  /* cause of the live staging backfill failure this fixes.           */
  /* -------------------------------------------------------------- */
  {
    const postgrestError = {
      message: "duplicate key value violates unique constraint",
      code: "23505",
      details: 'Key (project_id, normalized_text, alias_generation)=(...) already exists.',
      hint: "Retry the operation.",
    };
    check(
      "7: test setup sanity — the PostgREST-shaped fixture is NOT instanceof Error",
      !(postgrestError instanceof Error)
    );
    const serialized = serializeUnknownError(postgrestError);
    check("7: message is preserved", serialized.includes("duplicate key value violates unique constraint"));
    check("7: code is preserved", serialized.includes("code=23505"));
    check(
      "7: details is preserved",
      serialized.includes("details=Key (project_id, normalized_text, alias_generation)=(...) already exists.")
    );
    check("7: hint is preserved", serialized.includes("hint=Retry the operation."));
    check(
      "7: never collapses to the useless literal '[object Object]'",
      !serialized.includes("[object Object]")
    );

    const messageOnly = { message: "pass_not_found", code: null, details: null, hint: null };
    const messageOnlySerialized = serializeUnknownError(messageOnly);
    check(
      "7: a null code/details/hint is omitted, not printed as 'code=null' etc.",
      messageOnlySerialized === "pass_not_found"
    );

    const realError = new Error("a genuine JS Error");
    check(
      "7: a real Error instance still returns err.message directly, unchanged behavior",
      serializeUnknownError(realError) === "a genuine JS Error"
    );

    const noRecognizedFields = { foo: "bar", nested: { baz: 1 } };
    const fallbackSerialized = serializeUnknownError(noRecognizedFields);
    check(
      "7: an object with none of message/code/details/hint falls back to valid JSON, not '[object Object]'",
      fallbackSerialized === JSON.stringify(noRecognizedFields) && !fallbackSerialized.includes("[object Object]")
    );

    check(
      "7: a raw thrown string still round-trips via String(err)",
      serializeUnknownError("plain string throw") === "plain string throw"
    );
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
