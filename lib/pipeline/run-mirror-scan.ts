import { crawlSite, type CrawledPage } from "@/lib/crawler/crawl-site";
import { runSiteReaderAgent } from "@/lib/agents/site-reader";
import { getDb } from "@/lib/db";
import type { DbAdapter, Project, MirrorProfileRow } from "@/lib/db/types";
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
  projectId?: string;
  /**
   * Owner of the newly-created project. Passed by the API route from the
   * authenticated user (Sprint 10.5). May be `null` only for internal CLI
   * scripts (`scripts/test-*.ts`) that intentionally create legacy/test
   * rows outside the auth surface — protected UI/API routes reject those
   * rows via `requireProjectOwner`.
   */
  userId?: string | null;
}

export type ResolveMirrorScanProjectResult =
  | {
      ok: true;
      project: Project;
      created: boolean;
    }
  | {
      ok: false;
      error: string;
    };

function normalizeProjectDomain(value: string): string {
  const raw = value.trim();
  const url =
    /^https?:\/\//i.test(raw)
      ? raw
      : `https://${raw}`;

  return new URL(url)
    .hostname
    .toLowerCase()
    .replace(/^www\./, "");
}

export async function resolveMirrorScanProject(
  input: RunMirrorScanInput,
  db: DbAdapter
): Promise<ResolveMirrorScanProjectResult> {
  let requestedDomain: string;

  try {
    requestedDomain =
      normalizeProjectDomain(input.websiteUrl);
  } catch {
    return {
      ok: false,
      error: "Invalid website URL",
    };
  }

  if (input.projectId) {
    const existing =
      await db.getProject(input.projectId);

    if (!existing) {
      return {
        ok: false,
        error:
          "Reserved project was not found",
      };
    }

    let existingDomain: string;

    try {
      existingDomain =
        normalizeProjectDomain(existing.domain);
    } catch {
      return {
        ok: false,
        error:
          "Reserved project has an invalid domain",
      };
    }

    if (existingDomain !== requestedDomain) {
      return {
        ok: false,
        error:
          "Reserved project domain does not match the requested website",
      };
    }

    return {
      ok: true,
      project: existing,
      created: false,
    };
  }

  const project = await db.createProject({
    domain: requestedDomain,
    companyName:
      input.companyName ?? null,
    userId: input.userId ?? null,
  });

  return {
    ok: true,
    project,
    created: true,
  };
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

  const resolvedProject =
    await resolveMirrorScanProject(
      input,
      db
    );

  if (!resolvedProject.ok) {
    return {
      ok: false,
      error: resolvedProject.error,
    };
  }

  const project =
    resolvedProject.project;

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
