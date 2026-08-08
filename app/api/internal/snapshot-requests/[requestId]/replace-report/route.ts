import { getDb } from "@/lib/db";
import { isFounderEmail } from "@/lib/auth/founder";
import { requireCurrentUser } from "@/lib/auth/current-user";
import { createReplaceReportHandler } from "@/lib/snapshot-requests/replace-report-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Production wiring only. The control flow — and every security decision in
// it — lives in the handler factory so tests exercise the same implementation.
export const POST = createReplaceReportHandler({
  requireCurrentUser,
  isFounderEmail,
  getSnapshotReportArtifact: (requestId) =>
    getDb().getSnapshotReportArtifact(requestId),
  replaceUndeliveredSnapshotReportArtifact: (input) =>
    getDb().replaceUndeliveredSnapshotReportArtifact(input),
});
