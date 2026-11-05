/**
 * POST /api/internal/site-diagnostics/preview — founder-only W1 preview.
 *
 * Off unless ZYPACT_W1_PREVIEW_ENABLED is exactly "true". Kill switch, then
 * founder guard, then body (lib/site-diagnostic/preview-handler.ts). Runs the
 * offline W1 engine against one public site and returns the report; writes
 * nothing. No model, paid or third-party call.
 */
import { requireFounderForRoute } from "@/lib/auth/founder";
import { runSiteDiagnostic } from "@/lib/site-diagnostic/engine";
import { W1_PREVIEW_ROUTE, handleW1Preview, previewEnabledFromEnv } from "@/lib/site-diagnostic/preview-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Above the crawl's 45 s run deadline (W1_FETCH_POLICY.runDeadlineMs). */
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleW1Preview(request, {
    enabled: previewEnabledFromEnv,
    guard: () => requireFounderForRoute(W1_PREVIEW_ROUTE),
    run: (url, signal) => runSiteDiagnostic(url, { signal }),
  });
}
