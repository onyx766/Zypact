import { NextResponse } from "next/server";
import { requireCurrentUser } from "@/lib/auth/current-user";
import { isFounderEmail } from "@/lib/auth/founder";
import { getDb } from "@/lib/db";
import { isProtocolReportPayload } from "@/lib/reports/protocol-report-types";
import { sendProtocolReportEmail } from "@/lib/reports/protocol-report-email";
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

    // Read BEFORE the claim and used only for the link and the quoted
    // question, never for findings. No canonical payload means no email.
    const questionText = isProtocolReportPayload(artifact.reportPayload)
      ? artifact.reportPayload.question.text
      : null;

    return {
      workEmail: snapshotRequest.workEmail,
      companyName: snapshotRequest.companyName ?? "",
      publicToken: artifact.publicToken,
      integrityStatus: artifact.integrityStatus ?? null,
      questionText,
    };
  },

  beginSnapshotReportDelivery: (input) =>
    getDb().beginSnapshotReportDelivery(input),

  async sendReportEmail(input) {
    const apiKey = process.env.RESEND_API_KEY as string;
    const from = process.env.SNAPSHOT_EMAIL_FROM as string;
    const appBaseUrl = publicSiteUrl();

    // The email carries no findings: it says the snapshot is ready and links
    // to the page that states it in full, with its uncertainty. It is built
    // from the canonical payload's question, never from parsed markdown.
    const delivery = await sendProtocolReportEmail(
      {
        to: input.to,
        companyName: input.companyName,
        publicToken: input.publicToken,
        questionText: input.questionText,
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
