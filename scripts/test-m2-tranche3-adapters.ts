#!/usr/bin/env tsx
/**
 * M2 tranche 3 — entity resolution adapter contract (D-017, D-018,
 * D-019), exercised dynamically against the in-memory adapter.
 *
 * This tests the memory adapter's reimplementation of migration
 * 0042's business logic (start_or_resume_entity_resolution_pass,
 * resolve_and_record_entity_observation) and the two active-view
 * readers. It does not touch the Supabase adapter or any real
 * database — that RPC/view behavior is covered by
 * scripts/test-m2-tranche3-writers.ts's static assertions and remains
 * pending a real staging connection for genuine concurrency.
 *
 * Every normalizedText/normalizedBrandTerms value used here is
 * produced by the real, authoritative lib/evidence/normalize-entity-text.ts
 * — never a hand-typed stand-in — so this test also exercises the
 * D-019 discipline that the adapter never recomputes it.
 */

delete process.env.VERCEL_ENV;
Object.assign(process.env, { NODE_ENV: "test" });
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.ZYPACT_ALLOW_MEMORY_DB;
process.env.ZYPACT_MOCK_MODE = "on";

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

async function expectThrows(
  name: string,
  fn: () => Promise<unknown>,
  messageIncludes: string
): Promise<void> {
  try {
    await fn();
    check(name, false, "did not throw");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    check(name, message.includes(messageIncludes), message);
  }
}

async function main(): Promise<void> {
  const db = getDb();

  const project = await db.createProject({
    domain: `entity-adapter-${Math.random().toString(36).slice(2, 8)}.example.com`,
    companyName: "Acme Inc.",
  });

  const datasetBatch = await db.createDatasetBatch({
    projectId: project.id,
    datasetSourceType: "manual_scan",
  });

  const companyName = "Acme Inc.";
  const domain = "acme.com";
  const normalizedBrandTerms = [
    normalizeEntityTextV1(companyName),
    normalizeEntityTextV1(domain),
  ];
  const acmeNormalized = normalizeEntityTextV1("Acme");
  const widgetcoNormalized = normalizeEntityTextV1("Widgetco");

  check(
    "test setup: normalizeEntityTextV1('Acme Inc.') and normalizeEntityTextV1('Acme') agree (suffix stripped)",
    normalizedBrandTerms[0] === acmeNormalized
  );

  async function makeProbeResult() {
    const probeRun = await db.createProbeRun(project.id, "perplexity", "simulated", "pending", {
      datasetId: datasetBatch.id,
      datasetSourceType: "manual_scan",
    });
    return db.saveProbeResult({
      probeRunId: probeRun.id,
      projectId: project.id,
      prompt: "who should we use",
      platform: "perplexity",
      probeMode: "simulated",
      rawResponse: "Acme and Widgetco were both mentioned.",
      clientMentioned: true,
      clientPosition: "listed",
      competitorsMentioned: [],
      sourcesCited: [],
      answerSummary: "test fixture",
      verdict: "partial",
      whyClientLost: "",
    });
  }

  // ------------------------------ zero-mention pass ------------------------------
  {
    const probeResult = await makeProbeResult();
    const started = await db.startOrResumeEntityResolutionPass({
      projectId: project.id,
      probeResultId: probeResult.id,
      resolverVersion: 1,
      datasetId: datasetBatch.id,
      expectedMentionCount: 0,
      companyName,
      domain,
      normalizedBrandTerms,
    });
    check(
      "zero-mention pass: STARTED and immediately completed",
      started.passOutcome === "STARTED" && started.passStatus === "completed"
    );

    const observations = await db.getEntityObservationsActiveByProbeResult(probeResult.id);
    check("zero-mention pass: zero observations, no error", observations.length === 0);
  }

  // ------------------------------ multi-mention pass, full lifecycle ------------------------------
  let multiProbeResultId = "";
  {
    const probeResult = await makeProbeResult();
    multiProbeResultId = probeResult.id;

    const started = await db.startOrResumeEntityResolutionPass({
      projectId: project.id,
      probeResultId: probeResult.id,
      resolverVersion: 1,
      datasetId: datasetBatch.id,
      expectedMentionCount: 3,
      companyName,
      domain,
      normalizedBrandTerms,
    });
    check("multi-mention pass: STARTED, in_progress", started.passOutcome === "STARTED" && started.passStatus === "in_progress");
    const passId = started.resolutionPassId;

    const m0 = await db.resolveAndRecordEntityObservation({
      resolutionPassId: passId,
      mentionOrdinal: 0,
      rawText: "Acme",
      normalizedText: acmeNormalized,
      status: "excluded_brand_self",
      proposedEntityType: "client",
    });
    check(
      "mention 0 (client, brand-self): APPLIED/APPLIED, pass still in_progress (1/3)",
      m0.observationOutcome === "APPLIED" &&
        m0.aliasOutcome === "APPLIED" &&
        m0.aliasGeneration === 1 &&
        m0.passStatus === "in_progress"
    );

    const m0Again = await db.resolveAndRecordEntityObservation({
      resolutionPassId: passId,
      mentionOrdinal: 0,
      rawText: "Acme",
      normalizedText: acmeNormalized,
      status: "excluded_brand_self",
      proposedEntityType: "client",
    });
    check(
      "mention 0 resubmitted identically: ALREADY_APPLIED/ALREADY_APPLIED",
      m0Again.observationOutcome === "ALREADY_APPLIED" && m0Again.aliasOutcome === "ALREADY_APPLIED"
    );

    const m0Conflict = await db.resolveAndRecordEntityObservation({
      resolutionPassId: passId,
      mentionOrdinal: 0,
      rawText: "Acme",
      normalizedText: acmeNormalized,
      status: "excluded_brand_self",
      proposedEntityType: "client",
      context: "a different context than before",
    });
    check(
      "mention 0 resubmitted with different context: observation CONFLICT, pass still in_progress",
      m0Conflict.observationOutcome === "CONFLICT" && m0Conflict.passStatus === "in_progress"
    );

    const m1 = await db.resolveAndRecordEntityObservation({
      resolutionPassId: passId,
      mentionOrdinal: 1,
      rawText: "Widgetco",
      normalizedText: widgetcoNormalized,
      status: "resolved",
      proposedEntityType: "competitor",
    });
    check(
      "mention 1 (competitor, first sighting): APPLIED/APPLIED, in_progress (2/3)",
      m1.observationOutcome === "APPLIED" &&
        m1.aliasOutcome === "APPLIED" &&
        m1.passStatus === "in_progress"
    );

    const m2 = await db.resolveAndRecordEntityObservation({
      resolutionPassId: passId,
      mentionOrdinal: 2,
      rawText: "Widgetco",
      normalizedText: widgetcoNormalized,
      status: "resolved",
      proposedEntityType: "competitor",
    });
    check(
      "mention 2 (same competitor mentioned twice): new observation APPLIED, alias reused ALREADY_APPLIED, pass now completed (3/3)",
      m2.observationOutcome === "APPLIED" &&
        m2.aliasOutcome === "ALREADY_APPLIED" &&
        m2.aliasId === m1.aliasId &&
        m2.passStatus === "completed"
    );

    const activeAliases = await db.getEntityAliasesActiveByProject(project.id);
    check(
      "active aliases: exactly acme(client) and widgetco(competitor), both generation 1",
      activeAliases.length === 2 &&
        activeAliases.every((a) => a.aliasGeneration === 1) &&
        activeAliases.some((a) => a.normalizedText === acmeNormalized && a.entityType === "client") &&
        activeAliases.some((a) => a.normalizedText === widgetcoNormalized && a.entityType === "competitor")
    );
    check(
      "active aliases carry exactly the normalizedText produced by normalizeEntityTextV1 — never recomputed by the adapter",
      activeAliases.find((a) => a.entityType === "client")!.normalizedText === acmeNormalized
    );

    const activeObservations = await db.getEntityObservationsActiveByProbeResult(probeResult.id);
    check(
      "active observations: exactly 3, ordinals 0/1/2, the CONFLICT attempt never surfaces",
      activeObservations.length === 3 &&
        activeObservations.map((o) => o.mentionOrdinal).join(",") === "0,1,2" &&
        activeObservations[0]!.context !== "a different context than before"
    );
  }

  // ------------------------------ resume / already-completed ------------------------------
  {
    const probeResult = await makeProbeResult();
    const startInput = {
      projectId: project.id,
      probeResultId: probeResult.id,
      resolverVersion: 1,
      datasetId: datasetBatch.id,
      expectedMentionCount: 1,
      companyName,
      domain,
      normalizedBrandTerms,
    };
    const first = await db.startOrResumeEntityResolutionPass(startInput);
    check("resume: first call STARTED", first.passOutcome === "STARTED");

    const second = await db.startOrResumeEntityResolutionPass(startInput);
    check(
      "resume: second call on the same fresh in_progress pass returns RESUMED with the same id",
      second.passOutcome === "RESUMED" && second.resolutionPassId === first.resolutionPassId
    );

    await db.resolveAndRecordEntityObservation({
      resolutionPassId: first.resolutionPassId,
      mentionOrdinal: 0,
      rawText: "Acme",
      normalizedText: acmeNormalized,
      status: "excluded_brand_self",
      proposedEntityType: "client",
    });

    const third = await db.startOrResumeEntityResolutionPass(startInput);
    check(
      "resume: call after completion returns ALREADY_COMPLETED with the same id",
      third.passOutcome === "ALREADY_COMPLETED" &&
        third.passStatus === "completed" &&
        third.resolutionPassId === first.resolutionPassId
    );
  }

  // ------------------------------ pass_parameter_mismatch ------------------------------
  {
    const probeResult = await makeProbeResult();
    await db.startOrResumeEntityResolutionPass({
      projectId: project.id,
      probeResultId: probeResult.id,
      resolverVersion: 1,
      datasetId: datasetBatch.id,
      expectedMentionCount: 5,
      companyName,
      domain,
      normalizedBrandTerms,
    });

    await expectThrows(
      "a differing expectedMentionCount for the same (probeResult, resolverVersion) raises pass_parameter_mismatch",
      () =>
        db.startOrResumeEntityResolutionPass({
          projectId: project.id,
          probeResultId: probeResult.id,
          resolverVersion: 1,
          datasetId: datasetBatch.id,
          expectedMentionCount: 6,
          companyName,
          domain,
          normalizedBrandTerms,
        }),
      "pass_parameter_mismatch"
    );
  }

  // ------------------------------ client demote-block ------------------------------
  {
    // A brand snapshot deliberately NOT listing "acme" — the D-018
    // override cannot fire, isolating the demote-block itself.
    const probeResult = await makeProbeResult();
    const started = await db.startOrResumeEntityResolutionPass({
      projectId: project.id,
      probeResultId: probeResult.id,
      resolverVersion: 2, // fresh resolverVersion -> fresh brand snapshot
      datasetId: datasetBatch.id,
      expectedMentionCount: 1,
      companyName: "Zephyr Corp", // different brand terms, "acme" not among them
      domain: "zephyr.example",
      normalizedBrandTerms: [normalizeEntityTextV1("Zephyr Corp")],
    });

    await expectThrows(
      "proposing 'acme' as a competitor, when it is already an established client alias, raises client_alias_demote_blocked",
      () =>
        db.resolveAndRecordEntityObservation({
          resolutionPassId: started.resolutionPassId,
          mentionOrdinal: 0,
          rawText: "Acme",
          normalizedText: acmeNormalized,
          status: "resolved",
          proposedEntityType: "competitor",
        }),
      "client_alias_demote_blocked"
    );
  }

  // ------------------------------ brand_snapshot_parameter_mismatch ------------------------------
  {
    const probeResult = await makeProbeResult();
    await expectThrows(
      "reusing (project, dataset, resolverVersion=1) with a different companyName raises brand_snapshot_parameter_mismatch",
      () =>
        db.startOrResumeEntityResolutionPass({
          projectId: project.id,
          probeResultId: probeResult.id,
          resolverVersion: 1,
          datasetId: datasetBatch.id,
          expectedMentionCount: 1,
          companyName: "A Totally Different Company",
          domain,
          normalizedBrandTerms,
        }),
      "brand_snapshot_parameter_mismatch"
    );
  }

  console.log(
    `\n${checks - failures}/${checks} checks passed. ` +
      (failures === 0
        ? "M2 tranche 3 adapter contract PASSED."
        : "M2 tranche 3 adapter contract FAILED.")
  );
  console.log(
    "\nThis test exercises the in-memory adapter only. Genuine\n" +
      "concurrency (row locks, the SQL retry loop) is not simulated —\n" +
      "that remains a real-Postgres-only concern pending an authorized\n" +
      "staging connection."
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(2);
});
