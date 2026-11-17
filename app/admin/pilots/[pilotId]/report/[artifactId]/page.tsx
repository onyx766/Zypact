import Link from "next/link";
import { notFound } from "next/navigation";

import { PilotReportView } from "@/components/report/pilot-report-view";
import { requireFounderForPage } from "@/lib/auth/founder";
import { loadPilot } from "@/lib/pilots/reads";
import { UUID_PATTERN } from "@/lib/pilots/validate";
import { INTEGRITY_WORDS } from "@/lib/reports/pilot-report-copy";
import { isPilotReportPayload } from "@/lib/reports/pilot-report-types";
import { readPilotReportRevision } from "@/lib/reports/process-pilot-report";
import { getReportServiceClient } from "@/lib/reports/service-client";
import { AdminShell } from "../../../../admin-shell";
import { SharePilotReportButton } from "../../../../pilots/pilot-forms";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * D-055 — the founder's preview of one saved revision of a pilot report.
 *
 * It renders the stored payload with the same view the customer's page uses
 * (components/report/pilot-report-view.tsx), labelled as a preview, so the
 * founder reads exactly what the customer will see. Share is offered only
 * here, only for the newest revision, and never for a blocked one; the
 * database refuses the same cases again (share_pilot_report_artifact).
 */
export default async function PilotReportPreviewPage({
  params,
}: {
  params: Promise<{ pilotId: string; artifactId: string }>;
}) {
  const { pilotId, artifactId } = await params;
  const user = await requireFounderForPage(`/admin/pilots/${pilotId}/report/${artifactId}`);
  if (!UUID_PATTERN.test(pilotId) || !UUID_PATTERN.test(artifactId)) notFound();

  const client = getReportServiceClient();
  const loaded = await loadPilot(client, pilotId);
  if (!loaded) notFound();
  const revision = await readPilotReportRevision(client, pilotId, artifactId);
  if (!revision || !isPilotReportPayload(revision.payload)) notFound();

  const canShare = revision.isLatest && revision.sharedAt === null && revision.integrityStatus !== "blocked";

  return (
    <AdminShell
      email={user.email}
      active="pilots"
      health={
        revision.integrityStatus === "integrity_passed"
          ? { ok: true, title: INTEGRITY_WORDS.integrity_passed, note: `Revision ${revision.revision}` }
          : { ok: false, title: INTEGRITY_WORDS[revision.integrityStatus], note: `Revision ${revision.revision}` }
      }
    >
      <div className="zpa-page-head">
        <div>
          <p className="zpa-eyebrow">
            <Link href={`/admin/pilots/${pilotId}`}>{loaded.pilot.companyName}</Link>
          </p>
          <h1 className="zpa-title">Revision {revision.revision}: read before sharing</h1>
          <p className="zpa-subtitle">
            Built {revision.generatedAt.slice(0, 16).replace("T", " ")} UTC ·{" "}
            {INTEGRITY_WORDS[revision.integrityStatus]}
            {revision.sharedAt ? ` · Shared ${revision.sharedAt.slice(0, 10)}` : " · Not shared"}
          </p>
        </div>
      </div>

      <div className="zpa-card">
        {revision.integrityReasons.length > 0 ? (
          <>
            <p>Reasons this revision needs attention:</p>
            <ul className="zpa-muted">
              {revision.integrityReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </>
        ) : (
          <p className="zpa-muted">This revision passed its checks.</p>
        )}
        {canShare ? (
          <>
            <p className="zpa-muted">
              Read the whole revision below first. Sharing creates the private link and the revision can no longer change.
            </p>
            <SharePilotReportButton
              pilotId={pilotId}
              artifactId={revision.id}
              needsReview={revision.integrityStatus === "needs_review"}
            />
          </>
        ) : (
          <p className="zpa-muted">
            {revision.sharedAt
              ? "This revision has been shared. Its link is on the pilot page."
              : revision.integrityStatus === "blocked"
                ? "This revision failed its checks and can never be shared."
                : "A newer revision exists. Only the newest revision can be shared."}
          </p>
        )}
      </div>

      <PilotReportView
        payload={revision.payload}
        revision={revision.revision}
        sharedAt={revision.sharedAt}
        newerSharedRevision={false}
        preview
      />
    </AdminShell>
  );
}
