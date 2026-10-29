import { requireFounderForRoute } from "@/lib/auth/founder";
import { handleProjectCostReport } from "@/lib/costs/project-cost-report";
import { getReportServiceClient } from "@/lib/reports/service-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Founder-only, read-only reconciliation of reserved versus actual cost for
 * one project. See lib/costs/project-cost-report.ts.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  return handleProjectCostReport(projectId, {
    guard: () => requireFounderForRoute("costs/project"),
    client: getReportServiceClient,
  });
}
