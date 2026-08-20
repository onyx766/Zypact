#!/usr/bin/env tsx
/**
 * M2 canonical observations contract, third tranche — pipeline wiring
 * regression (D-017, D-018, D-019).
 *
 * Exercises lib/pipeline/analyze-probe-response.ts's entity-resolution
 * step end to end against the in-memory adapter: locateClientMention
 * finding (or not finding) the client's own mention, mention_ordinal
 * assignment (0 reserved for the client, 1..n for competitors in
 * competitorsMentioned's own order, duplicates preserved), the
 * explicit final completed-pass verification, and the isolation of
 * entity-resolution failures from the already-succeeded evidence
 * write (probe_run/probe_result are never touched by anything in
 * this step).
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ZYPACT_ALLOW_MEMORY_DB;
process.env.ZYPACT_MOCK_MODE = "on";

import { getDb } from "@/lib/db";
import { analyzeProbeResponse } from "@/lib/pipeline/analyze-probe-response";

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
  const db = getDb();

  function freshDomain(label: string): string {
    return `${label}-${Math.random().toString(36).slice(2, 10)}.example.com`;
  }

  /* ------------------------------------------------------------------ */
  /* Scenario A — client mention + one competitor, both resolved        */
  /* ------------------------------------------------------------------ */
  {
    const project = await db.createProject({
      domain: freshDomain("pipe-a"),
      companyName: "Acme Pipeline Co.",
    });
    const datasetBatch = await db.createDatasetBatch({
      projectId: project.id,
      datasetSourceType: "manual_scan",
    });

    const result = await analyzeProbeResponse({
      projectId: project.id,
      prompt: "who should we use for AI visibility diagnostics",
      platform: "perplexity",
      rawResponse:
        "Acme Pipeline Co. is a strong option for this. Widgetco is another option worth considering.",
      knownCompetitors: ["Widgetco"],
      datasetId: datasetBatch.id,
      datasetSourceType: "manual_scan",
    });

    check("A: analyzeProbeResponse returns ok:true", result.ok === true);
    if (result.ok) {
      check(
        "A: no entityResolutionError on a clean two-mention pass",
        result.entityResolutionError === undefined,
        result.entityResolutionError
      );

      const observations = await db.getEntityObservationsActiveByProbeResult(result.result.id);
      check("A: exactly 2 active observations", observations.length === 2, `${observations.length}`);

      const client = observations.find((o) => o.mentionOrdinal === 0);
      check("A: ordinal 0 exists", client !== undefined);
      check(
        "A: ordinal 0 is excluded_brand_self/client",
        client?.status === "excluded_brand_self" && client?.entityType === "client"
      );
      check(
        "A: ordinal 0 rawText is the exact located substring",
        client?.rawText === "Acme Pipeline Co."
      );

      const competitor = observations.find((o) => o.mentionOrdinal === 1);
      check("A: ordinal 1 exists", competitor !== undefined);
      check(
        "A: ordinal 1 is resolved/competitor",
        competitor?.status === "resolved" && competitor?.entityType === "competitor"
      );
      check("A: ordinal 1 rawText is 'Widgetco'", competitor?.rawText === "Widgetco");

      const aliases = await db.getEntityAliasesActiveByProject(project.id);
      check(
        "A: exactly 2 active aliases (client + competitor)",
        aliases.length === 2,
        `${aliases.length}`
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /* Scenario B — zero mentions: pass completes immediately, no error   */
  /* ------------------------------------------------------------------ */
  {
    const project = await db.createProject({
      domain: freshDomain("pipe-b"),
      companyName: "Zephyrion Holdings",
    });
    const datasetBatch = await db.createDatasetBatch({
      projectId: project.id,
      datasetSourceType: "manual_scan",
    });

    const result = await analyzeProbeResponse({
      projectId: project.id,
      prompt: "who should we use for AI visibility diagnostics",
      platform: "perplexity",
      rawResponse: "This is a generic answer that names no particular vendor at all.",
      knownCompetitors: [],
      datasetId: datasetBatch.id,
      datasetSourceType: "manual_scan",
    });

    check("B: analyzeProbeResponse returns ok:true", result.ok === true);
    if (result.ok) {
      check(
        "B: no entityResolutionError on a zero-mention pass",
        result.entityResolutionError === undefined,
        result.entityResolutionError
      );
      const observations = await db.getEntityObservationsActiveByProbeResult(result.result.id);
      check("B: zero active observations", observations.length === 0, `${observations.length}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Scenario C — duplicate competitor mentions preserved as distinct   */
  /* ordinals resolving to the same canonical entity                    */
  /* ------------------------------------------------------------------ */
  {
    const project = await db.createProject({
      domain: freshDomain("pipe-c"),
      companyName: "Acme Pipeline Co.",
    });
    const datasetBatch = await db.createDatasetBatch({
      projectId: project.id,
      datasetSourceType: "manual_scan",
    });

    const result = await analyzeProbeResponse({
      projectId: project.id,
      prompt: "who should we use for AI visibility diagnostics",
      platform: "perplexity",
      rawResponse: "Acme Pipeline Co. and Widgetco Inc. both came up in this answer.",
      // Two distinct surface forms of the same competitor: mergeCompetitors
      // de-duplicates by exact string via a Set, so a literal repeated
      // string (e.g. "Widgetco" twice) can never reach the mock twice —
      // this is the realistic way "doublons" (multiple mentions of the
      // same underlying competitor) actually arise in
      // competitorsMentioned. "Widgetco" word-boundary-matches inside
      // "Widgetco Inc." at the same text position, so the mock produces
      // two Matched entries at the same index, in knownCompetitors order.
      knownCompetitors: ["Widgetco Inc.", "Widgetco"],
      datasetId: datasetBatch.id,
      datasetSourceType: "manual_scan",
    });

    check("C: analyzeProbeResponse returns ok:true", result.ok === true);
    if (result.ok) {
      check(
        "C: no entityResolutionError",
        result.entityResolutionError === undefined,
        result.entityResolutionError
      );
      check(
        "C: test setup sanity — the mock actually reports two distinct competitor mentions",
        result.output.competitorsMentioned.length === 2,
        JSON.stringify(result.output.competitorsMentioned)
      );
      const observations = await db.getEntityObservationsActiveByProbeResult(result.result.id);
      check("C: exactly 3 active observations", observations.length === 3, `${observations.length}`);

      const client = observations.find((o) => o.mentionOrdinal === 0);
      check("C: ordinal 0 is the client", client?.entityType === "client");

      const dup1 = observations.find((o) => o.mentionOrdinal === 1);
      const dup2 = observations.find((o) => o.mentionOrdinal === 2);
      check("C: ordinal 1 exists and is 'Widgetco Inc.'", dup1?.rawText === "Widgetco Inc.");
      check("C: ordinal 2 exists and is 'Widgetco'", dup2?.rawText === "Widgetco");
      check(
        "C: ordinal 1 and ordinal 2 are two distinct observation rows, neither merged nor dropped",
        dup1 !== undefined && dup2 !== undefined && dup1.id !== dup2.id
      );
      check(
        "C: both distinct surface forms resolve to the same canonical entity (normalization strips the legal suffix)",
        dup1 !== undefined &&
          dup2 !== undefined &&
          dup1.status === "resolved" &&
          dup2.status === "resolved" &&
          dup1.canonicalEntityId === dup2.canonicalEntityId
      );

      const aliases = await db.getEntityAliasesActiveByProject(project.id);
      check(
        "C: still only 2 active aliases (client + one competitor identity, not 3)",
        aliases.length === 2,
        `${aliases.length}`
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /* Scenario D — locateClientMention runs unconditionally: the mock's  */
  /* own clientMentioned verdict is false (no word-boundary match), yet */
  /* the raw-text search still finds and records ordinal 0              */
  /* ------------------------------------------------------------------ */
  {
    const project = await db.createProject({
      domain: freshDomain("pipe-d"),
      companyName: "Acme",
    });
    const datasetBatch = await db.createDatasetBatch({
      projectId: project.id,
      datasetSourceType: "manual_scan",
    });

    // "Acmeworks" fails the mock's own word-boundary regex match for
    // "Acme" (an alphanumeric — 'w' — immediately follows), so the
    // mock reports clientMentioned:false. locateClientMention has no
    // such boundary requirement and finds "Acme" as the first four
    // characters of "Acmeworks" regardless.
    const result = await analyzeProbeResponse({
      projectId: project.id,
      prompt: "who should we use for AI visibility diagnostics",
      platform: "perplexity",
      rawResponse: "Acmeworks is one option to consider. No other brands are mentioned.",
      knownCompetitors: [],
      datasetId: datasetBatch.id,
      datasetSourceType: "manual_scan",
    });

    check("D: analyzeProbeResponse returns ok:true", result.ok === true);
    if (result.ok) {
      check(
        "D: the mock analyzer itself reports clientMentioned:false (sanity check on the test's own premise)",
        result.output.clientMentioned === false
      );
      check(
        "D: saved probe_result.clientMentioned is false, unaffected by entity resolution",
        result.result.clientMentioned === false
      );
      check(
        "D: no entityResolutionError even though the mock said not mentioned",
        result.entityResolutionError === undefined,
        result.entityResolutionError
      );
      const observations = await db.getEntityObservationsActiveByProbeResult(result.result.id);
      check(
        "D: exactly 1 active observation despite agent.output.clientMentioned:false",
        observations.length === 1,
        `${observations.length}`
      );
      const client = observations[0];
      check(
        "D: it is ordinal 0, excluded_brand_self/client, rawText 'Acme'",
        client?.mentionOrdinal === 0 &&
          client?.status === "excluded_brand_self" &&
          client?.entityType === "client" &&
          client?.rawText === "Acme"
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /* Scenario E — entity-resolution failure never touches the           */
  /* already-succeeded evidence write (probe_run/probe_result)          */
  /* ------------------------------------------------------------------ */
  {
    const projectA = await db.createProject({
      domain: freshDomain("pipe-e-a"),
      companyName: "Acme Pipeline Co.",
    });
    const projectB = await db.createProject({
      domain: freshDomain("pipe-e-b"),
      companyName: "Other Co.",
    });
    const datasetBatchB = await db.createDatasetBatch({
      projectId: projectB.id,
      datasetSourceType: "manual_scan",
    });

    // datasetId belongs to projectB while projectId is projectA: this
    // is accepted (uncritically) by createProbeRun/saveProbeResult —
    // neither cross-validates dataset ownership — but
    // startOrResumeEntityResolutionPass's own dataset_project_mismatch
    // precondition rejects it. This forces a genuine entity-resolution
    // failure through only the public API surface, no monkey-patching.
    const result = await analyzeProbeResponse({
      projectId: projectA.id,
      prompt: "who should we use for AI visibility diagnostics",
      platform: "perplexity",
      rawResponse: "Acme Pipeline Co. is a strong option for this.",
      knownCompetitors: [],
      datasetId: datasetBatchB.id,
      datasetSourceType: "manual_scan",
    });

    check("E: analyzeProbeResponse still returns ok:true", result.ok === true);
    if (result.ok) {
      check(
        "E: entityResolutionError is set and names the real failure",
        typeof result.entityResolutionError === "string" &&
          result.entityResolutionError.includes("dataset_project_mismatch"),
        result.entityResolutionError
      );
      check(
        "E: the probe_result evidence itself is intact (rawResponse preserved)",
        result.result.rawResponse === "Acme Pipeline Co. is a strong option for this."
      );

      const runs = await db.getProbeRunsByProject(projectA.id);
      const run = runs.find((r) => r.id === result.probeRunId);
      check("E: probe_run still exists", run !== undefined);
      check(
        "E: probe_run status is 'succeeded', never flipped to 'failed' by entity-resolution failure",
        run?.status === "succeeded"
      );

      const observations = await db.getEntityObservationsActiveByProbeResult(result.result.id);
      check(
        "E: zero observations were written (the pass itself never got created)",
        observations.length === 0,
        `${observations.length}`
      );
    }
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
