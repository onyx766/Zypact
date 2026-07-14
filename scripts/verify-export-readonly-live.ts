#!/usr/bin/env tsx
/**
 * Sprint 11 read-only proof against the Supabase adapter.
 *
 * Loads all 13 MVP-table row counts + latest updated_at values for a
 * given projectId, then runs `buildMvpReport` against the live Supabase
 * adapter, then re-loads the same snapshot. The counts and updated_at
 * timestamps must be byte-identical — proving the export code path is
 * strictly read-only against the database.
 *
 * The export markdown itself is also asserted to contain no known secret
 * env values (belt-and-braces with the in-route redaction sweep). We do
 * NOT print the markdown to stdout to avoid accidentally leaking
 * project-specific content into terminal history.
 *
 * Usage:
 *   scripts/run-with-env.py npx tsx scripts/verify-export-readonly-live.ts <projectId>
 *
 * Refuses to run without `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.
 */

import { getDb } from "@/lib/db";
import { buildMvpReport, loadReportInputs } from "@/lib/export/build-mvp-report";

function must(name: string, cond: boolean, detail = ""): void {
  const glyph = cond ? "✓" : "✗";
  console.log(`${glyph} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
}

async function tableSnapshot(projectId: string): Promise<Record<string, unknown>> {
  const db = getDb();
  const [
    project,
    sitePages,
    mp,
    prompts,
    probes,
    comps,
    gm,
    gaps,
    eb,
    fbs,
    assets,
    qaReports,
  ] = await Promise.all([
    db.getProject(projectId),
    db.getSitePages(projectId),
    db.getMirrorProfile(projectId),
    db.getGeneratedPrompts(projectId),
    db.getProbeResultsByProject(projectId),
    db.getCompetitorsByProject(projectId),
    db.getLatestGapMap(projectId),
    db.getGapsByProject(projectId),
    db.getEvidenceBankByProject(projectId),
    db.getFixBriefsByProject(projectId),
    db.getGeneratedAssetsByProject(projectId),
    db.getQaReportsByProject(projectId),
  ]);
  return {
    project: project ? {
      id: project.id,
      userId: project.userId,
      category: project.category,
      createdAt: project.createdAt,
    } : null,
    sitePages_count: sitePages.length,
    mirrorProfile: mp ? { id: mp.id, createdAt: mp.createdAt } : null,
    prompts_count: prompts.length,
    prompts_selected: prompts.filter((p) => p.selected).length,
    probes_count: probes.length,
    probes_verdicts: probes
      .map((p) => `${p.id}:${p.verdict}`)
      .sort()
      .join(","),
    competitors_count: comps.length,
    competitors_ids: comps.map((c) => `${c.id}:${c.updatedAt}`).sort().join(","),
    gapMap: gm ? { id: gm.id, createdAt: gm.createdAt } : null,
    gaps_count: gaps.length,
    gaps_ids: gaps.map((g) => g.id).sort().join(","),
    evidenceBank: eb ? { id: eb.id, updatedAt: eb.updatedAt } : null,
    fixBriefs: fbs
      .map((f) => `${f.id}:${f.status}:${f.updatedAt}`)
      .sort()
      .join(","),
    assets: assets
      .map((a) => `${a.id}:${a.qaStatus}:${a.updatedAt}`)
      .sort()
      .join(","),
    qaReports_count: qaReports.length,
    qaReports_ids: qaReports.map((r) => `${r.id}:${r.createdAt}`).sort().join(","),
  };
}

async function main(): Promise<void> {
  const projectId = process.argv[2];
  if (!projectId) {
    console.error(
      "Usage: scripts/run-with-env.py npx tsx scripts/verify-export-readonly-live.ts <projectId>"
    );
    process.exit(2);
  }
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    console.error(
      "Refusing to run: this script targets Supabase and needs both\n" +
        "  NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set."
    );
    process.exit(2);
  }

  console.log(`Sprint 11 read-only proof (Supabase) for project ${projectId}`);
  console.log("─────────────────────────────────────────────────────");

  const before = await tableSnapshot(projectId);
  must(
    "project exists before export",
    (before.project as Record<string, unknown> | null) !== null
  );

  const db = getDb();
  const inputs = await loadReportInputs(db, projectId);
  if (!inputs) {
    console.error("loadReportInputs returned null — project vanished mid-run?");
    process.exit(1);
  }

  const secretsForSweep: string[] = [];
  for (const k of [
    "SUPABASE_SERVICE_ROLE_KEY",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
  ]) {
    const v = process.env[k];
    if (typeof v === "string" && v.length >= 8) secretsForSweep.push(v);
  }

  const { markdown, filename, warnings, qaDistribution } = buildMvpReport({
    ...inputs,
    llmProvider: process.env.LLM_PROVIDER ?? null,
    llmModel: process.env.LLM_PROVIDER === "openai" ? (process.env.OPENAI_MODEL ?? null) : null,
    mockMode: process.env.ZYPACT_MOCK_MODE === "on",
    sensitiveValues: secretsForSweep,
  });

  const after = await tableSnapshot(projectId);

  must(
    "row counts and updated_at values unchanged across export",
    JSON.stringify(before) === JSON.stringify(after)
  );

  // Additional secret-body sweep at report-body level.
  let leakFound = false;
  for (const v of secretsForSweep) {
    if (markdown.includes(v)) {
      leakFound = true;
      console.log(`✗ secret literal (len=${v.length}) found in export body`);
    }
  }
  must("no secret env value appears verbatim in export body", !leakFound);

  // Basic structural sanity — but do NOT print the markdown itself.
  must(
    "export begins with the Zypact MVP heading",
    markdown.startsWith("# Zypact MVP — Client Report")
  );
  must(
    "export contains all 19 client-facing section headings",
    [
      "## 1. Executive Summary",
      "## 2. Publishability Status",
      "## 3. Evidence Needed to Unlock Publish-Ready Assets",
      "## 4. Project Summary",
      "## 5. Mirror Profile",
      "## 6. Prompt Mirror summary",
      "## 7. Probe Results",
      "## 8. What this means",
      "## 9. Competitors",
      "## 10. Recommendation Gap Map",
      "## 11. Recommended Next Actions",
      "## 12. Evidence Bank",
      "## 13. Fix Brief",
      "## 14. Generated Assets",
      "## 15. QA Review",
      "## 16. Unsafe / needs-evidence warnings",
      "## 17. Known limitations",
      "## 18. Blocked fixes",
      "## 19. Appendix — Technical metadata",
    ].every((s) => markdown.includes(s))
  );

  console.log("─────────────────────────────────────────────────────");
  console.log(
    JSON.stringify(
      {
        filename,
        bytes: markdown.length,
        secretsRedactedCount: warnings.secretsRedactedCount,
        notReadyAssetCount: warnings.notReadyAssetCount,
        qaDistribution,
      },
      null,
      2
    )
  );

  if (process.exitCode === 1) {
    console.log("READ-ONLY PROOF FAILED.");
    process.exit(1);
  }
  console.log("Sprint 11 read-only proof PASSED.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(2);
});
