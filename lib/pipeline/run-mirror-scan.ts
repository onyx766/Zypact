import { crawlSite, type CrawledPage } from "@/lib/crawler/crawl-site";
import { runSiteReaderAgent } from "@/lib/agents/site-reader";
import { getDb } from "@/lib/db";
import type { Project, MirrorProfileRow } from "@/lib/db/types";
import { getPagesCrawlLimit, type PlanId, DEFAULT_PLAN } from "@/lib/pricing/pricing-config";
import type { SiteReaderOutput } from "@/lib/schemas/site-reader.schema";
import { withPipelineStep } from "./save-pipeline-step";

/**
 * End-to-end Mirror Scan.
 *
 * 1. Create project
 * 2. Crawl the site (bounded by plan limits)
 * 3. Save site pages
 * 4. Run Site Reader Agent
 * 5. Save Mirror Profile
 * 6. Back-fill project.category
 *
 * Shared between the API route and the CLI test script so the pipeline has
 * exactly one implementation.
 */

export interface RunMirrorScanInput {
  websiteUrl: string;
  companyName?: string;
  planId?: PlanId;
  /**
   * Owner of the newly-created project. Passed by the API route from the
   * authenticated user (Sprint 10.5). May be `null` only for internal CLI
   * scripts (`scripts/test-*.ts`) that intentionally create legacy/test
   * rows outside the auth surface — protected UI/API routes reject those
   * rows via `requireProjectOwner`.
   */
  userId?: string | null;
}

export type RunMirrorScanResult =
  | {
      ok: true;
      project: Project;
      pages: CrawledPage[];
      mirrorProfileRow: MirrorProfileRow;
      mirrorProfile: SiteReaderOutput;
      usedMock: boolean;
      usedRetry: boolean;
    }
  | { ok: false; error: string; project?: Project };

export async function runMirrorScan(
  input: RunMirrorScanInput
): Promise<RunMirrorScanResult> {
  const planId = input.planId ?? DEFAULT_PLAN;
  const maxPages = getPagesCrawlLimit(planId);
  const db = getDb();

  let hostname: string;
  try {
    hostname = new URL(input.websiteUrl).hostname;
  } catch {
    return { ok: false, error: "Invalid website URL" };
  }

  const project = await db.createProject({
    domain: hostname,
    companyName: input.companyName ?? null,
    userId: input.userId ?? null,
  });

  try {
    const crawl = await withPipelineStep(
      { projectId: project.id, agent: "crawler" },
      () => crawlSite({ websiteUrl: input.websiteUrl, maxPages })
    );
    if (!crawl.ok) {
      return { ok: false, error: `Crawl failed: ${crawl.error}`, project };
    }

    await db.saveSitePages(
      project.id,
      crawl.pages.map((p) => ({
        url: p.url,
        title: p.title,
        content: p.text,
        pageType: p.pageType,
      }))
    );

    const reader = await withPipelineStep(
      { projectId: project.id, agent: "site-reader" },
      () =>
        runSiteReaderAgent({
          pages: crawl.pages,
          websiteUrl: input.websiteUrl,
          companyNameHint: input.companyName,
        })
    );

    const mirrorProfileRow = await db.saveMirrorProfile(project.id, reader.output);

    if (reader.output.detectedCategory) {
      await db.updateProjectCategory(project.id, reader.output.detectedCategory);
    }

    return {
      ok: true,
      project: { ...project, category: reader.output.detectedCategory || null },
      pages: crawl.pages,
      mirrorProfileRow,
      mirrorProfile: reader.output,
      usedMock: reader.usedMock,
      usedRetry: reader.usedRetry,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg, project };
  }
}
