import { requireFounderForPage } from "@/lib/auth/founder";
import { INTERNAL_PREVIEW_LABEL, SCOPE_STATEMENT } from "@/lib/site-diagnostic/copy";
import { previewEnabledFromEnv } from "@/lib/site-diagnostic/preview-handler";

import { AdminShell } from "../admin-shell";
import { PreviewClient } from "./preview-client";
import "./diagnostics.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Founder-only preview of the W1 Website Buyer-Readiness Diagnostic.
 *
 * Internal: customers cannot reach this (S1 and G1 gate any customer-facing
 * W1). Nothing is stored; each run is a fresh, bounded crawl of one public
 * site, rendered from the immutable report object.
 */
export default async function SiteDiagnosticsAdminPage() {
  const user = await requireFounderForPage("/admin/site-diagnostics");
  const enabled = previewEnabledFromEnv();

  return (
    <AdminShell
      email={user.email}
      active="diagnostics"
      health={
        enabled
          ? { ok: true, title: "Preview enabled", note: "Runs are not stored." }
          : { ok: false, title: "Preview disabled", note: "Set ZYPACT_W1_PREVIEW_ENABLED=true to run." }
      }
    >
      <div className="w1-page">
        <header className="w1-head">
          <p className="w1-eyebrow">{INTERNAL_PREVIEW_LABEL}</p>
          <h1 className="w1-title">Website Buyer-Readiness Diagnostic</h1>
          <p className="w1-lede">{SCOPE_STATEMENT}</p>
        </header>
        <PreviewClient enabled={enabled} />
      </div>
    </AdminShell>
  );
}
