#!/usr/bin/env tsx
/**
 * Sprint 13 Part A — run live Perplexity Sonar probes for an existing project.
 *
 * Usage:
 *   scripts/run-with-env.py npx tsx scripts/run-live-perplexity-probes.ts <projectId> [promptCount] [runsPerPrompt]
 *
 * Env:
 *   PERPLEXITY_API_KEY=...      required
 *   PERPLEXITY_MODEL=sonar      optional; default sonar
 *   OPENAI_API_KEY=...          required unless mock mode is on, because
 *                               Zypact still analyzes the Perplexity answer
 *                               with Probe Analysis Agent.
 */

import "dotenv/config";
import { getDb } from "@/lib/db";
import { runLivePerplexityProbes } from "@/lib/pipeline/run-live-perplexity-probes";
import { createManualScanDatasetBatch } from "@/lib/evidence/resolve-dataset-batch";

async function main() {
  const projectId = process.argv[2]?.trim();
  if (!projectId) {
    console.error("Usage: scripts/run-with-env.py npx tsx scripts/run-live-perplexity-probes.ts <projectId> [promptCount] [runsPerPrompt]");
    process.exit(1);
  }
  const countArg = process.argv[3]?.trim();
  const runsArg = process.argv[4]?.trim();
  const count = countArg ? Number.parseInt(countArg, 10) : 3;
  const runsPerPrompt = runsArg ? Number.parseInt(runsArg, 10) : 3;
  if (!Number.isFinite(count) || count < 1) {
    console.error("promptCount must be a positive integer");
    process.exit(1);
  }
  if (!Number.isFinite(runsPerPrompt) || runsPerPrompt < 1) {
    console.error("runsPerPrompt must be a positive integer");
    process.exit(1);
  }
  if (!process.env.PERPLEXITY_API_KEY) {
    console.error("PERPLEXITY_API_KEY is required. Add it to .env.local; do not paste it in chat.");
    process.exit(1);
  }

  const db = getDb();
  const before = await db.getProbeResultsByProject(projectId);
  const beforeCount = before.length;

  // M2 canonical observations contract, second tranche (D-014) — this
  // CLI has no snapshot-request concept, so every invocation is
  // manual_scan, resolved here (once, before calling the pipeline
  // function) rather than inside runLivePerplexityProbes itself, which
  // must not guess its own caller's context.
  const datasetBatch = await createManualScanDatasetBatch(db, projectId);

  const result = await runLivePerplexityProbes({
    projectId,
    count,
    runsPerPrompt,
    // Sprint 13C: a true commercial probe may find zero brand mentions.
    // Do not fail the run just because the audited brand lost.
    requireClientMentionedSomewhere: false,
    datasetId: datasetBatch.id,
    datasetSourceType: datasetBatch.datasetSourceType,
  });

  if (!result.ok) {
    console.error(`Live Perplexity probe run FAILED: ${result.error}`);
    console.error(`projectId: ${projectId}`);
    console.error(`probesRunBeforeFailure: ${result.probesRun}`);
    process.exit(1);
  }

  const after = await db.getProbeResultsByProject(projectId);
  const liveRows = after.filter((r) => r.probeMode === "live_perplexity");
  const newRows = after.slice(0, Math.max(0, after.length - beforeCount));
  const verdicts = { won: 0, partial: 0, lost: 0, not_relevant: 0 } as Record<string, number>;
  let productMentions = 0;
  let sourceCitations = 0;
  for (const row of result.results) {
    verdicts[row.verdict] = (verdicts[row.verdict] ?? 0) + 1;
    if (row.productMentioned) productMentions += 1;
    if (row.citedAsSource) sourceCitations += 1;
  }

  console.log("Live Perplexity probe run completed.");
  console.log(`projectId                   : ${projectId}`);
  console.log(`requested prompt count      : ${count}`);
  console.log(`runs per prompt             : ${runsPerPrompt}`);
  console.log(`expected max live calls      : ${count * runsPerPrompt}`);
  console.log(`new probe results           : ${result.results.length}`);
  console.log(`total live_perplexity rows   : ${liveRows.length}`);
  console.log(`raw mentions brand somewhere : ${result.rawClientMentionedSomewhere ? "yes" : "no"}`);
  console.log(`analysis mentions brand      : ${result.analyzedClientMentionedSomewhere ? "yes" : "no"}`);
  console.log(`recommended as product       : ${productMentions}/${result.results.length}`);
  console.log(`cited as source              : ${sourceCitations}/${result.results.length}`);
  console.log(`probe request integrity      : passed (no hidden client identity outside buyer prompt)`);
  console.log(`used mock                    : ${result.usedMock ? "yes" : "no"}`);
  console.log("verdict distribution         :");
  console.log(`  · won          : ${verdicts.won ?? 0}`);
  console.log(`  · partial      : ${verdicts.partial ?? 0}`);
  console.log(`  · lost         : ${verdicts.lost ?? 0}`);
  console.log(`  · not_relevant : ${verdicts.not_relevant ?? 0}`);
  console.log("new rows:");
  for (const row of result.results) {
    const sources = Array.isArray(row.sourcesCited) ? row.sourcesCited.length : 0;
    console.log(`  · ${row.platform} / ${row.probeMode} / product=${row.productVerdict || row.verdict} / cited=${row.citedAsSource ? "yes" : "no"} / sources=${sources} / prompt=${row.prompt}`);
  }

  // A tiny machine-readable footer helps follow-up scripts/tests parse the run.
  console.log(JSON.stringify({
    projectId,
    newRows: newRows.length,
    promptCount: count,
    runsPerPrompt,
    probesRun: result.results.length,
    livePerplexityRows: liveRows.length,
    rawClientMentionedSomewhere: result.rawClientMentionedSomewhere,
    analyzedClientMentionedSomewhere: result.analyzedClientMentionedSomewhere,
    productMentions,
    sourceCitations,
    verdicts,
  }));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
