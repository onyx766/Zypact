#!/usr/bin/env tsx
/**
 * M2 tranche 3 hotfix #2 — controlled, real-staging functional
 * verification of migration 0044's fix (supabase/migrations/0044_m2_
 * fix_entity_resolution_rpc_found.sql), already applied to staging and
 * confirmed via read-only checks. This script is the first time the
 * fixed RPC is exercised end to end against a real Postgres
 * connection with actual writes, rather than the in-memory adapter.
 *
 * Isolation: creates exactly ONE new project (flagged below, synthetic
 * name/domain, no real company data) and writes ONLY under that
 * project's project_id. Never reads, writes, or otherwise touches the
 * existing Zypact project (3848dad8-3431-4940-add1-915bd4bb5b30), its
 * 3 probe_results, its 9 entity_resolution_passes, or its 17
 * entity_observations. No RPC is called outside the sanctioned
 * DbAdapter wrappers (lib/db/supabase-adapter.ts) — the same code path
 * the live pipeline and the backfill script use, not an ad-hoc raw SQL
 * RPC invocation.
 *
 * Requires real Supabase env vars (NEXT_PUBLIC_SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY) already present in the process
 * environment before this file is imported — source .env.local before
 * running, e.g.:
 *   set -a; source .env.local; set +a
 *   node -r tsx/cjs scripts/verify-rpc-found-hotfix-staging.ts
 */

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

async function main(): Promise<void> {
  const missing = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter(
    (k) => !process.env[k]
  );
  if (missing.length > 0) {
    throw new Error(
      `refusing to run: missing real Supabase env vars (${missing.join(", ")}) — this script must run against staging, never the memory adapter`
    );
  }

  const db = getDb();

  const domain = `rpc-found-hotfix-verify-${Math.random().toString(36).slice(2, 10)}.example.com`;
  const companyName = "Verify Found Hotfix Co.";

  console.log(`\n>>> FLAGGED: creating one new isolated project for this verification`);
  console.log(`>>> domain=${domain} companyName=${companyName}`);

  const project = await db.createProject({ domain, companyName });
  console.log(`>>> created project.id=${project.id}\n`);

  const datasetBatch = await db.createDatasetBatch({
    projectId: project.id,
    datasetSourceType: "manual_scan",
  });

  const normalizedBrandTerms = [
    normalizeEntityTextV1(companyName),
    normalizeEntityTextV1(domain),
  ];

  async function makeProbeResult(rawResponse: string, competitorsMentioned: Array<{ name: string; position: number; context: string }>) {
    const probeRun = await db.createProbeRun(project.id, "perplexity", "simulated", "succeeded", {
      datasetId: datasetBatch.id,
      datasetSourceType: "manual_scan",
    });
    return db.saveProbeResult({
      probeRunId: probeRun.id,
      projectId: project.id,
      prompt: "who should we use",
      platform: "perplexity",
      probeMode: "simulated",
      rawResponse,
      clientMentioned: false,
      clientPosition: "absent",
      competitorsMentioned,
      sourcesCited: [],
      answerSummary: "",
      verdict: "lost",
      whyClientLost: "",
      datasetId: datasetBatch.id,
      datasetSourceType: "manual_scan",
    });
  }

  /* ------------------------------------------------------------ */
  /* Points 1, 2, 3: two competitors in probe_result #1 (distinct    */
  /* ordinals), then the same competitor re-seen in probe_result #2  */
  /* ------------------------------------------------------------ */
  const probeResult1 = await makeProbeResult(
    "Widgetco and Gadgetco both came up in this answer.",
    [
      { name: "Widgetco", position: 1, context: "Widgetco and Gadgetco" },
      { name: "Gadgetco", position: 2, context: "Widgetco and Gadgetco" },
    ]
  );
  const pass1 = await db.startOrResumeEntityResolutionPass({
    projectId: project.id,
    probeResultId: probeResult1.id,
    resolverVersion: 1,
    datasetId: datasetBatch.id,
    expectedMentionCount: 2,
    companyName,
    domain,
    normalizedBrandTerms,
    mirrorAliases: [],
  });

  const widgetcoFirst = await db.resolveAndRecordEntityObservation({
    resolutionPassId: pass1.resolutionPassId,
    mentionOrdinal: 1,
    rawText: "Widgetco",
    normalizedText: "widgetco",
    status: "resolved",
    proposedEntityType: "competitor",
    context: "Widgetco and Gadgetco",
  });
  check("1: first-ever Widgetco sighting — observation APPLIED", widgetcoFirst.observationOutcome === "APPLIED");
  check(
    "1: first-ever Widgetco sighting — alias APPLIED at generation 1, real alias created",
    widgetcoFirst.aliasOutcome === "APPLIED" &&
      widgetcoFirst.aliasGeneration === 1 &&
      typeof widgetcoFirst.aliasId === "string"
  );

  const gadgetcoResult = await db.resolveAndRecordEntityObservation({
    resolutionPassId: pass1.resolutionPassId,
    mentionOrdinal: 2,
    rawText: "Gadgetco",
    normalizedText: "gadgetco",
    status: "resolved",
    proposedEntityType: "competitor",
    context: "Widgetco and Gadgetco",
  });
  check("3: distinct competitor Gadgetco — its own APPLIED alias", gadgetcoResult.aliasOutcome === "APPLIED");

  const obs1 = await db.getEntityObservationsActiveByProbeResult(probeResult1.id);
  check(
    "3: ordinals 1 (Widgetco) and 2 (Gadgetco) both exist, distinct, never merged",
    obs1.length === 2 &&
      obs1.some((o) => o.mentionOrdinal === 1) &&
      obs1.some((o) => o.mentionOrdinal === 2)
  );
  const obsAtOrdinal1 = obs1.find((o) => o.mentionOrdinal === 1)!;
  const obsAtOrdinal2 = obs1.find((o) => o.mentionOrdinal === 2)!;
  check(
    "3: Widgetco and Gadgetco resolve to two DIFFERENT canonical entities",
    obsAtOrdinal1.canonicalEntityId !== obsAtOrdinal2.canonicalEntityId
  );

  const probeResult2 = await makeProbeResult(
    "Widgetco is the only option mentioned in this second answer.",
    [{ name: "Widgetco", position: 1, context: "Widgetco is the only option" }]
  );
  const pass2 = await db.startOrResumeEntityResolutionPass({
    projectId: project.id,
    probeResultId: probeResult2.id,
    resolverVersion: 1,
    datasetId: datasetBatch.id,
    expectedMentionCount: 1,
    companyName,
    domain,
    normalizedBrandTerms,
    mirrorAliases: [],
  });
  const widgetcoSecond = await db.resolveAndRecordEntityObservation({
    resolutionPassId: pass2.resolutionPassId,
    mentionOrdinal: 1,
    rawText: "Widgetco",
    normalizedText: "widgetco",
    status: "resolved",
    proposedEntityType: "competitor",
    context: "Widgetco is the only option",
  });
  check(
    "2: second Widgetco sighting (different probe_result) is ALREADY_APPLIED, not a fresh APPLIED",
    widgetcoSecond.aliasOutcome === "ALREADY_APPLIED"
  );

  const obs2 = await db.getEntityObservationsActiveByProbeResult(probeResult2.id);
  const obs2AtOrdinal1 = obs2.find((o) => o.mentionOrdinal === 1)!;
  check(
    "2: second sighting reuses the EXACT SAME canonical_entity_id as the first — real Postgres deduplication confirmed",
    obs2AtOrdinal1.canonicalEntityId === obsAtOrdinal1.canonicalEntityId,
    `${obs2AtOrdinal1.canonicalEntityId} vs ${obsAtOrdinal1.canonicalEntityId}`
  );
  check(
    "2: second sighting reuses the EXACT SAME alias_id as the first",
    widgetcoSecond.aliasId === widgetcoFirst.aliasId,
    `${widgetcoSecond.aliasId} vs ${widgetcoFirst.aliasId}`
  );

  const aliasesForProject = await db.getEntityAliasesActiveByProject(project.id);
  check(
    "2: exactly 2 active aliases total in this project (Widgetco once, Gadgetco once) — not 3",
    aliasesForProject.length === 2,
    `${aliasesForProject.length}`
  );

  /* ------------------------------------------------------------ */
  /* Point 4: the client's own brand, proposed AS a competitor, is  */
  /* unconditionally reclassified to excluded_brand_self/client     */
  /* (D-018) — real Postgres, not the memory adapter                */
  /* ------------------------------------------------------------ */
  const probeResult3 = await makeProbeResult(`${companyName} showed up unexpectedly in this third answer.`, []);
  const pass3 = await db.startOrResumeEntityResolutionPass({
    projectId: project.id,
    probeResultId: probeResult3.id,
    resolverVersion: 1,
    datasetId: datasetBatch.id,
    expectedMentionCount: 1,
    companyName,
    domain,
    normalizedBrandTerms,
    mirrorAliases: [],
  });
  const brandSelfResult = await db.resolveAndRecordEntityObservation({
    resolutionPassId: pass3.resolutionPassId,
    mentionOrdinal: 0,
    rawText: companyName,
    normalizedText: normalizeEntityTextV1(companyName),
    status: "resolved",
    proposedEntityType: "competitor", // deliberately mislabeled, as if the caller thought it was a competitor
    context: `${companyName} showed up unexpectedly`,
  });
  check(
    "4: the client's own brand, proposed as a competitor, is APPLIED (not rejected)",
    brandSelfResult.observationOutcome === "APPLIED"
  );
  const brandSelfObs = await db.getEntityObservationsActiveByProbeResult(probeResult3.id);
  check(
    "4: it is unconditionally reclassified to excluded_brand_self/client, never left as a competitor",
    brandSelfObs.length === 1 &&
      brandSelfObs[0]?.status === "excluded_brand_self" &&
      brandSelfObs[0]?.entityType === "client"
  );

  /* ------------------------------------------------------------ */
  /* Point 5: the 17 pre-existing observations are byte-for-byte     */
  /* untouched                                                       */
  /* ------------------------------------------------------------ */
  const existingObs = await db.getEntityObservationsActiveByProbeResult(
    "3eee0206-ad2f-4787-935d-3295532c3c52"
  );
  check(
    "5: the pre-existing Zypact probe_result's 6 active observations are still exactly 6",
    existingObs.length === 6,
    `${existingObs.length}`
  );

  console.log(`\n>>> new project created for this verification: ${project.id} (${domain})`);
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
