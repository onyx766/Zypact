import { NextResponse } from "next/server";
import { requireCurrentUser } from "@/lib/auth/current-user";
import { isFounderEmail } from "@/lib/auth/founder";
import { getDb } from "@/lib/db";
import { parsePublicSnapshotReport } from "@/lib/snapshot-requests/parse-public-report";
import { sendClientSnapshotReport } from "@/lib/snapshot-requests/client-report-delivery";
import { createSendReportHandler } from "@/lib/snapshot-requests/send-report-handler";
import { publicSiteUrl } from "@/lib/seo/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Production wiring only. The orchestration — and every fencing decision in
 * it — lives in the handler factory so tests exercise the same control flow.
 *
 * `releaseSnapshotReportDeliveryClaim` is wired, but the orchestrator reaches
 * it only where non-delivery is proven — never on an ambiguous outcome. It is
 * exposed as an injected dependency rather than
 * present-and-unused.
 */
export const POST = createSendReportHandler({
  requireCurrentUser,
  isFounderEmail,

  async loadRequestContext(requestId) {
    // Everything fallible that can precede the claim does. Provider
    // configuration is validated here so a misconfiguration cannot strand a
    // held claim.
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.SNAPSHOT_EMAIL_FROM;
    if (!apiKey || !from) return null;

    const [snapshotRequest, artifact] = await Promise.all([
      getDb().getSnapshotRequest(requestId),
      getDb().getSnapshotReportArtifact(requestId),
    ]);
    if (!snapshotRequest?.workEmail || !artifact) return null;

    // Read BEFORE the claim and used only for the link, never for content.
    return {
      workEmail: snapshotRequest.workEmail,
      companyName: snapshotRequest.companyName ?? "",
      publicToken: artifact.publicToken,
      integrityStatus: artifact.integrityStatus ?? null,
    };
  },

  beginSnapshotReportDelivery: (input) =>
    getDb().beginSnapshotReportDelivery(input),

  async sendReportEmail(input) {
    const apiKey = process.env.RESEND_API_KEY as string;
    const from = process.env.SNAPSHOT_EMAIL_FROM as string;
    const appBaseUrl = publicSiteUrl();

    // Parsed from the CLAIMED markdown the handler passed in. The artifact is
    // never re-read here: a replacement landing between the claim and this
    // call must not change what the customer receives.
    const report = parsePublicSnapshotReport(input.shortReportMarkdown);

    const delivery = await sendClientSnapshotReport(
      {
        requestId: input.requestId,
        to: input.to,
        companyName: input.companyName,
        publicToken: input.publicToken,
        visibilitySummary: report.visibility || "See the private report",
        brandedReputation:
          report.brandedReputation || "See the private report",
        firstPriorityAction:
          report.firstFixHeading ||
          "Review the first priority action in your private report.",
        deliveryIdempotencyKey: input.deliveryIdempotencyKey,
      },
      { apiKey, from, replyTo: null, appBaseUrl }
    );

    return { messageId: delivery.messageId };
  },

  releaseSnapshotReportDeliveryClaim: (input) =>
    getDb().releaseSnapshotReportDeliveryClaim(input),

  finalizeSnapshotReportDelivery: (input) =>
    getDb().finalizeSnapshotReportDelivery(input),
});
