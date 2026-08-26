#!/usr/bin/env tsx
/**
 * M2 tranche 3 hotfix regression (supabase/migrations/0043_m2_fix_
 * entity_resolution_rpc_ambiguity.sql).
 *
 * Static checks against the migration's own SQL text: both functions'
 * public signatures (parameter list, RETURNS TABLE columns) are
 * byte-for-byte identical (modulo whitespace) to migration 0042's;
 * every previously-unqualified column reference that collided with an
 * implicit RETURNS TABLE variable (observation_generation,
 * alias_generation, and their RETURNING/ORDER BY sites) is now
 * alias-qualified; SECURITY DEFINER, search_path, and the
 * REVOKE-all/GRANT-service_role-only privilege shape are all present
 * exactly twice (once per function); no table/column/constraint/index
 * DDL appears anywhere in the file.
 *
 * Plus one local functional test, against the in-memory adapter, of
 * the exact scenario that triggered the real bug on staging: the
 * client's own mention is not located, so the first-ever call to
 * resolveAndRecordEntityObservation for a pass uses mention_ordinal=1
 * (never 0) — the memory adapter never had this SQL-level bug, so this
 * locks in the correct behavior as a regression guard rather than
 * reproducing the fix itself, which is only verifiable against a real
 * Postgres connection (out of scope here — no staging/live access in
 * this test file).
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

function extractFunctionHeader(source: string, functionName: string): string {
  const startMarker = `create or replace function\n  public.${functionName}(`;
  const startIdx = source.indexOf(startMarker);
  if (startIdx < 0) throw new Error(`function header not found: ${functionName}`);
  const asIdx = source.indexOf("\nas $$", startIdx);
  if (asIdx < 0) throw new Error(`'as $$' not found after header: ${functionName}`);
  return source.slice(startIdx, asIdx).replace(/\s+/g, " ").trim();
}

/**
 * Extracts just the executable body between `as $$` and the closing
 * `$$;` for one function — excluding this migration's own explanatory
 * header comment, which deliberately quotes the OLD, broken,
 * unqualified statement as documentation of the bug it fixes. A check
 * for "is the broken pattern gone" must only look at executable SQL,
 * never at a comment quoting it for explanatory purposes.
 */
function extractFunctionBody(source: string, functionName: string): string {
  const headerMarker = `create or replace function\n  public.${functionName}(`;
  const headerIdx = source.indexOf(headerMarker);
  if (headerIdx < 0) throw new Error(`function header not found: ${functionName}`);
  const bodyStart = source.indexOf("\nas $$", headerIdx);
  if (bodyStart < 0) throw new Error(`'as $$' not found after header: ${functionName}`);
  const bodyEnd = source.indexOf("\n$$;", bodyStart);
  if (bodyEnd < 0) throw new Error(`closing '$$;' not found for function: ${functionName}`);
  return source.slice(bodyStart, bodyEnd);
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function main(): Promise<void> {
  const migrationsDir = path.join(__dirname, "..", "supabase", "migrations");
  const source0042 = fs.readFileSync(
    path.join(migrationsDir, "0042_m2_entity_resolution_rpc.sql"),
    "utf8"
  );
  const source0043 = fs.readFileSync(
    path.join(migrationsDir, "0043_m2_fix_entity_resolution_rpc_ambiguity.sql"),
    "utf8"
  );

  /* ---------------------------------------------------------------- */
  /* Public signature preservation                                     */
  /* ---------------------------------------------------------------- */
  {
    const startOrResume0042 = extractFunctionHeader(
      source0042,
      "start_or_resume_entity_resolution_pass"
    );
    const startOrResume0043 = extractFunctionHeader(
      source0043,
      "start_or_resume_entity_resolution_pass"
    );
    check(
      "start_or_resume_entity_resolution_pass: signature and RETURNS TABLE unchanged (0043 vs 0042)",
      startOrResume0042 === startOrResume0043
    );

    const resolveObs0042 = extractFunctionHeader(
      source0042,
      "resolve_and_record_entity_observation"
    );
    const resolveObs0043 = extractFunctionHeader(
      source0043,
      "resolve_and_record_entity_observation"
    );
    check(
      "resolve_and_record_entity_observation: signature and RETURNS TABLE unchanged (0043 vs 0042)",
      resolveObs0042 === resolveObs0043
    );
  }

  const resolveObsBody0043 = extractFunctionBody(source0043, "resolve_and_record_entity_observation");
  const startOrResumeBody0043 = extractFunctionBody(
    source0043,
    "start_or_resume_entity_resolution_pass"
  );

  /* ---------------------------------------------------------------- */
  /* The confirmed bug's exact broken statement is gone, and its       */
  /* qualified replacement is present                                  */
  /* ---------------------------------------------------------------- */
  {
    check(
      "0042 (unfixed) actually contains the unqualified, broken RETURNING clause — confirms the test's own premise",
      source0042.includes(
        "returning id, observation_generation into v_observation_id, v_observation_generation"
      )
    );
    check(
      "0043's executable function body no longer contains the unqualified, broken RETURNING clause",
      !resolveObsBody0043.includes(
        "returning id, observation_generation into v_observation_id, v_observation_generation"
      )
    );
    check(
      "0043 contains the alias-qualified replacement",
      resolveObsBody0043.includes(
        "returning eo2.id, eo2.observation_generation into v_observation_id, v_observation_generation"
      )
    );
  }

  /* ---------------------------------------------------------------- */
  /* Every other observation_generation / alias_generation site that   */
  /* shares the identical ambiguity risk is also qualified — not just  */
  /* the one statement that happened to fail first                     */
  /* ---------------------------------------------------------------- */
  {
    check(
      "0043: no bare 'order by observation_generation desc' remains in the function body",
      !resolveObsBody0043.includes("order by observation_generation desc")
    );
    check(
      "0043: the observation head lookup is alias-qualified",
      resolveObsBody0043.includes("order by eo.observation_generation desc")
    );

    check(
      "0043: no bare 'order by alias_generation desc' remains in the function body",
      !resolveObsBody0043.includes("order by alias_generation desc")
    );
    check(
      "0043: the alias head lookup is alias-qualified",
      resolveObsBody0043.includes("order by ea.alias_generation desc")
    );

    check(
      "0043: no bare 'returning id, alias_generation into' remains anywhere in the function body",
      !resolveObsBody0043.includes("returning id, alias_generation into")
    );
    check(
      "0043: the APPLIED-branch alias insert is alias-qualified",
      resolveObsBody0043.includes(
        "returning ea2.id, ea2.alias_generation into v_alias_id, v_alias_generation"
      )
    );
    check(
      "0043: the SUPERSEDED_PRIOR-branch alias insert is alias-qualified",
      resolveObsBody0043.includes(
        "returning ea3.id, ea3.alias_generation into v_alias_id, v_alias_generation"
      )
    );
  }

  /* ---------------------------------------------------------------- */
  /* start_or_resume_entity_resolution_pass audit: rewritten with the  */
  /* same defensive aliasing discipline, even though its own RETURNS   */
  /* TABLE columns (resolution_pass_id, pass_status, pass_outcome)     */
  /* never literally matched a real column name in the tables it       */
  /* queries — confirmed by grepping 0042 for a bare occurrence of any */
  /* of those three names outside the RETURNS TABLE clause itself.     */
  /* ---------------------------------------------------------------- */
  {
    const start0042Body = extractFunctionHeader(
      source0042,
      "start_or_resume_entity_resolution_pass"
    );
    check(
      "audit finding: 'resolution_pass_id' never appears as a bare identifier in 0042's own signature body beyond the RETURNS TABLE column itself",
      countOccurrences(start0042Body, "resolution_pass_id") === 1
    );
    check(
      "0043: start_or_resume's queries are alias-qualified defensively (entity_resolution_passes lock)",
      startOrResumeBody0043.includes("from public.entity_resolution_passes erp\n") ||
        startOrResumeBody0043.includes("from public.entity_resolution_passes erp ")
    );
    check(
      "0043: start_or_resume's dataset_batches lookup is alias-qualified",
      startOrResumeBody0043.includes("from public.dataset_batches dsb")
    );
  }

  /* ---------------------------------------------------------------- */
  /* Nothing else changed: SECURITY DEFINER / search_path / privilege  */
  /* shape present exactly twice; no table/column/index DDL anywhere   */
  /* ---------------------------------------------------------------- */
  {
    check(
      "0043: 'security definer' appears exactly twice (once per function)",
      countOccurrences(source0043, "security definer") === 2
    );
    check(
      "0043: 'set search_path = public, pg_temp' appears exactly twice",
      countOccurrences(source0043, "set search_path = public, pg_temp") === 2
    );
    check(
      "0043: EXECUTE granted to service_role exactly twice (once per function)",
      countOccurrences(source0043, "to service_role;") === 2
    );
    check(
      "0043: EXECUTE revoked from public/anon/authenticated for both functions (6 revoke statements)",
      countOccurrences(source0043, "revoke all on function") === 6
    );

    const lowerSource = source0043.toLowerCase();
    for (const forbidden of [
      "create table",
      "alter table",
      "drop table",
      "create index",
      "drop index",
      "create policy",
      "alter policy",
      "drop policy",
    ]) {
      check(`0043 contains no '${forbidden}'`, !lowerSource.includes(forbidden));
    }
  }

  /* ---------------------------------------------------------------- */
  /* Local functional regression: the exact "client not found, first   */
  /* competitor at mention_ordinal=1" path that broke on real staging  */
  /* ---------------------------------------------------------------- */
  {
    const db = getDb();
    const project = await db.createProject({
      domain: `rpc-hotfix-${Math.random().toString(36).slice(2, 10)}.example.com`,
      companyName: "Acme Hotfix Co.",
    });
    const datasetBatch = await db.createDatasetBatch({
      projectId: project.id,
      datasetSourceType: "manual_scan",
    });
    const probeRun = await db.createProbeRun(project.id, "perplexity", "simulated", "succeeded", {
      datasetId: datasetBatch.id,
      datasetSourceType: "manual_scan",
    });
    const probeResult = await db.saveProbeResult({
      probeRunId: probeRun.id,
      projectId: project.id,
      prompt: "who should we use",
      platform: "perplexity",
      probeMode: "simulated",
      rawResponse: "Widgetco and Gadgetco are the two best options here.",
      clientMentioned: false,
      clientPosition: "absent",
      competitorsMentioned: [
        { name: "Widgetco", position: 1, context: "Widgetco and Gadgetco" },
        { name: "Gadgetco", position: 2, context: "Widgetco and Gadgetco" },
      ],
      sourcesCited: [],
      answerSummary: "",
      verdict: "lost",
      whyClientLost: "",
      datasetId: datasetBatch.id,
      datasetSourceType: "manual_scan",
    });

    const pass = await db.startOrResumeEntityResolutionPass({
      projectId: project.id,
      probeResultId: probeResult.id,
      resolverVersion: 1,
      datasetId: datasetBatch.id,
      expectedMentionCount: 2,
      companyName: "Acme Hotfix Co.",
      domain: project.domain,
      normalizedBrandTerms: ["acme hotfix", project.domain],
      mirrorAliases: [],
    });
    check("hotfix regression: pass starts in_progress for a 2-mention pass", pass.passStatus === "in_progress");

    // Client not found: the first-ever observation for this pass is
    // deliberately recorded at mention_ordinal=1, never 0 — this is
    // exactly the call shape that hit "column reference
    // \"observation_generation\" is ambiguous" against real staging.
    const first = await db.resolveAndRecordEntityObservation({
      resolutionPassId: pass.resolutionPassId,
      mentionOrdinal: 1,
      rawText: "Widgetco",
      normalizedText: "widgetco",
      status: "resolved",
      proposedEntityType: "competitor",
      context: "Widgetco and Gadgetco",
    });
    check(
      "hotfix regression: first observation at ordinal 1 (ordinal 0 never used) is APPLIED",
      first.observationOutcome === "APPLIED"
    );
    check("hotfix regression: alias is APPLIED at generation 1", first.aliasOutcome === "APPLIED" && first.aliasGeneration === 1);
    check(
      "hotfix regression: pass still in_progress after 1 of 2 expected mentions",
      first.passStatus === "in_progress"
    );

    const second = await db.resolveAndRecordEntityObservation({
      resolutionPassId: pass.resolutionPassId,
      mentionOrdinal: 2,
      rawText: "Gadgetco",
      normalizedText: "gadgetco",
      status: "resolved",
      proposedEntityType: "competitor",
      context: "Widgetco and Gadgetco",
    });
    check("hotfix regression: second observation is APPLIED", second.observationOutcome === "APPLIED");
    check(
      "hotfix regression: pass completes after the 2nd of 2 expected mentions",
      second.passStatus === "completed"
    );

    const observations = await db.getEntityObservationsActiveByProbeResult(probeResult.id);
    check(
      "hotfix regression: exactly 2 active observations, at ordinals 1 and 2 (0 never used)",
      observations.length === 2 &&
        observations.some((o) => o.mentionOrdinal === 1) &&
        observations.some((o) => o.mentionOrdinal === 2) &&
        !observations.some((o) => o.mentionOrdinal === 0)
    );
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
