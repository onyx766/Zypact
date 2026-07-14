import { discoverCompetitors } from "@/lib/pipeline/discover-competitors";
import { generateGapMap } from "@/lib/pipeline/generate-gap-map";
import { generateFixBrief } from "@/lib/pipeline/generate-fix-brief";
import { getDb } from "@/lib/db";
import type { FixBriefRowInput } from "@/lib/db/types";
import { buildProbeSetSummary } from "@/lib/probe-results/report-selection";
import { SiteReaderOutputSchema } from "@/lib/schemas/site-reader.schema";

function pickTopCompetitorNames(names: string[], limit = 3): string {
  const unique = Array.from(new Set(names.filter((n) => n.trim().length > 0)));
  return unique.slice(0, limit).join(", ") || "tracked competitors";
}

async function saveConsolidationFixBrief(projectId: string): Promise<string> {
  const db = getDb();
  const project = await db.getProject(projectId);
  const mirrorRow = await db.getMirrorProfile(projectId);
  const bank = await db.getEvidenceBankByProject(projectId);
  const gaps = await db.getGapsByProject(projectId);
  const competitors = await db.getCompetitorsByProject(projectId);
  const probes = await db.getProbeResultsByProject(projectId);

  const mirrorParsed = SiteReaderOutputSchema.safeParse(mirrorRow?.json ?? null);
  const brandName =
    (mirrorParsed.success ? mirrorParsed.data.companyName : null) ||
    project?.companyName ||
    project?.domain ||
    "the brand";
  const summary = buildProbeSetSummary(probes, null, {
    brandTerms: [brandName, project?.domain ?? "", mirrorParsed.success ? mirrorParsed.data.website ?? "" : ""],
  });
  const avgMentionRate =
    summary.scorecardPromptGroups.length > 0
      ? summary.scorecardPromptGroups.reduce((acc, g) => acc + g.mentionRate, 0) /
        summary.scorecardPromptGroups.length
      : 0;
  const lostGroups = summary.scorecardPromptGroups.filter(
    (g) => g.verdict === "lost" || g.verdict === "partial",
  );

  if (lostGroups.length > 0) {
    const targetGap = gaps[0];
    if (!targetGap) return "no-gap-for-lost-groups";
    const generated = await generateFixBrief({ projectId, gapId: targetGap.id });
    if (!generated.ok) return `lost-gap-fix-brief-skipped:${generated.error}`;
    return generated.fixBrief.id;
  }

  const topCompetitors = pickTopCompetitorNames(
    competitors
      .filter((c) => c.name.trim().toLowerCase() !== brandName.trim().toLowerCase())
      .sort((a, b) => b.mentionCount - a.mentionCount)
      .map((c) => c.name),
  );

  const evidenceAvailable = [
    ...(bank?.allowedClaims ?? []).slice(0, 5),
    ...(bank?.proofItems ?? []).slice(0, 3).map((p) => p.detail),
  ].filter((s) => s && s.trim().length > 0);

  const evidenceNeeded = [
    bank?.provenance === "user_reviewed"
      ? null
      : "Human-review the Evidence Bank before publishing generated assets.",
    "Add source-backed third-party citations or review/evaluation sources that AI assistants already trust.",
    "Expand monitoring to additional unbranded prompts and platforms to confirm the current visibility holds beyond this small Perplexity sample.",
  ].filter((s): s is string => Boolean(s));

  const row: FixBriefRowInput = {
    gapId: gaps[0]?.id ?? null,
    probeResultId: summary.scorecardProbeResults[0]?.id ?? null,
    lostPrompt: `Live scorecard consolidation: ${brandName} appears in sampled unbranded prompts`,
    competitorRecommended: topCompetitors,
    rootCause: `${brandName} is already appearing in the selected live scorecard prompt groups. The current opportunity is not basic recovery from absence; it is defending that position with stronger source coverage, reviewed evidence, and broader monitoring.`,
    recommendedFix: `Consolidate the current AI shortlist position: review the Evidence Bank, add source-backed proof blocks, and expand the probe set before creating new comparison assets.`,
    fixType: "proof_block",
    assetsToGenerate: ["proof_block", "faq_block", "json_ld_schema"],
    evidenceNeeded,
    evidenceAvailable,
    priority: 1,
    expectedImpact: `Helps preserve the current ${Math.round(avgMentionRate * 100)}% live mention rate while reducing dependence on volatile single-run answers.`,
    status: evidenceNeeded.length > 0 ? "needs_evidence" : "ready_for_assets",
  };

  const saved = await db.saveFixBrief(projectId, row);
  return saved.id;
}

async function main(): Promise<void> {
  const projectId = process.argv[2];
  if (!projectId) {
    console.error("Usage: tsx scripts/regenerate-live-recommendations.ts <projectId>");
    process.exit(1);
  }

  const db = getDb();
  const project = await db.getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const beforeProbes = await db.getProbeResultsByProject(projectId);
  const beforeGapMap = await db.getLatestGapMap(projectId);
  const beforeSummary = buildProbeSetSummary(beforeProbes, beforeGapMap, {
    brandTerms: [project.companyName ?? "", project.domain],
  });

  console.log("Regenerating live recommendations from scorecard probe set");
  console.log(`projectId          : ${projectId}`);
  console.log(`main probe mode    : ${beforeSummary.includedMode}`);
  console.log(`scorecard prompts  : ${beforeSummary.scorecardPromptGroups.length}`);
  console.log(`scorecard runs     : ${beforeSummary.scorecardProbeResults.length}`);
  console.log(`scorecard won      : ${beforeSummary.scorecardPromptGroups.filter((g) => g.verdict === "won").length}`);
  console.log(`scorecard lost     : ${beforeSummary.scorecardPromptGroups.filter((g) => g.verdict === "lost").length}`);
  if (beforeSummary.gapMapStale) console.log("gap map status     : stale before regeneration");

  const competitors = await discoverCompetitors({ projectId });
  if (!competitors.ok) throw new Error(`competitor discovery failed: ${competitors.error}`);
  console.log(`competitors stored : ${competitors.stored.length}`);

  const gapMap = await generateGapMap({ projectId });
  if (!gapMap.ok) throw new Error(`gap map failed: ${gapMap.error}`);
  console.log(`gapMapId           : ${gapMap.gapMap.id}`);
  console.log(`gaps stored        : ${gapMap.gaps.length}`);
  console.log(`normalized scores  : ${gapMap.normalizedDistances ? "yes" : "no"}`);

  const fixBriefId = await saveConsolidationFixBrief(projectId);
  console.log(`fixBriefId         : ${fixBriefId}`);

  const afterProbes = await db.getProbeResultsByProject(projectId);
  const afterGapMap = await db.getLatestGapMap(projectId);
  const afterSummary = buildProbeSetSummary(afterProbes, afterGapMap, {
    brandTerms: [project.companyName ?? "", project.domain],
  });
  console.log(`gap map fresh      : ${afterSummary.gapMapStale ? "no" : "yes"}`);
  console.log("Regeneration completed.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
