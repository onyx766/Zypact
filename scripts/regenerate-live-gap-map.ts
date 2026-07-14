import { discoverCompetitors } from "@/lib/pipeline/discover-competitors";
import { generateGapMap } from "@/lib/pipeline/generate-gap-map";
import { getDb } from "@/lib/db";
import { buildProbeSetSummary } from "@/lib/probe-results/report-selection";

async function main(): Promise<void> {
  const projectId = process.argv[2];
  if (!projectId) {
    console.error("Usage: tsx scripts/regenerate-live-gap-map.ts <projectId>");
    process.exit(1);
  }

  const db = getDb();
  const project = await db.getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const beforeProbes = await db.getProbeResultsByProject(projectId);
  const beforeGapMap = await db.getLatestGapMap(projectId);
  const summary = buildProbeSetSummary(beforeProbes, beforeGapMap);

  console.log("Regenerating competitors + Gap Map from selected probe set");
  console.log(`projectId        : ${projectId}`);
  console.log(`main probe mode  : ${summary.includedMode}`);
  console.log(`main probes      : ${summary.mainProbeResults.length}`);
  console.log(`simulated stored : ${summary.simulated}`);
  console.log(`live stored      : ${summary.livePerplexity}`);
  if (summary.gapMapStale) {
    console.log("gap map status   : stale before regeneration");
  }

  const competitors = await discoverCompetitors({ projectId });
  if (!competitors.ok) throw new Error(`competitor discovery failed: ${competitors.error}`);
  console.log(`competitors      : ${competitors.stored.length}`);

  const gapMap = await generateGapMap({ projectId });
  if (!gapMap.ok) throw new Error(`gap map failed: ${gapMap.error}`);
  console.log(`gapMapId         : ${gapMap.gapMap.id}`);
  console.log(`gaps             : ${gapMap.gaps.length}`);
  console.log(`usedMock         : ${gapMap.usedMock ? "yes" : "no"}`);
  console.log(`usedRetry        : ${gapMap.usedRetry ? "yes" : "no"}`);
  console.log("Regeneration completed.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
